// Simulador del grupo Zaidy: ventas y contabilidad. Es el ORQUESTADOR COMERCIAL del ecosistema:
// verifica precios contra las reservas, cobra con la pasarela, confirma a los proveedores, liquida
// (dispersión y asientos) y, si algo falla después del pago, compensa con reembolso.
// Cuando algo no cuadra, NO decide solo: deja la venta en_revision para una persona.
//   node simuladores/ventas.mjs
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ClienteServicio } from '../lib/cliente.mjs';
import { FIRMA, PARAMETROS, PASARELA_LLAVE, PUERTOS, URLS, clientesDe, credencial, secretoJwt } from '../lib/config.mjs';
import { liquidar, retenciones, totales } from '../lib/dinero.mjs';
import { falla } from '../lib/errores.mjs';
import { enviarEvento } from '../lib/eventos.mjs';
import { verificarFirma } from '../lib/firma.mjs';
import { crearServicio, responder } from '../lib/servicio.mjs';

const huella = (obj) => createHash('sha256').update(JSON.stringify(obj)).digest('hex');
// Solo se envían eventos a direcciones conocidas (evita que alguien use ventas para llamar a otros sitios).
const DESTINOS_PERMITIDOS = (process.env.NOTIFICACIONES_PERMITIDAS || URLS.taller).split(',').map((u) => new URL(u).origin);

export async function iniciar(puerto = PUERTOS.ventas) {
  const ventas = new Map();
  const idempotencia = new Map(); // clave → { huella, promesa }   (la promesa se guarda ANTES del primer await)
  const reservasUsadas = new Map(); // reserva_id → venta_id
  const eventosProcesados = new Set();
  let consecutivo = 0;
  let bitacora = () => {};

  const proveedores = Object.fromEntries(['tienda', 'concesionario'].map((g) => [g, new ClienteServicio({
    destino: g, url: URLS[g], clientId: 'ventas', clientSecret: credencial('ventas', g), alcances: ['proveedor.confirmar'],
  })]));

  // Cada venta pertenece a una orden: con otra traza_id, para quien pregunta no existe.
  const buscar = (id, traza_id) => {
    const v = ventas.get(id);
    if (!v || v.traza_id !== traza_id) throw falla('NO_ENCONTRADO', `No existe la venta ${id}`);
    return v;
  };
  const publica = ({ cobro_id, url_notificacion, liquidacion, cola, motivo, ...v }) => v;

  async function cobrar(v) {
    const r = await fetch(`${URLS.pasarela}/api/cobros`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${PASARELA_LLAVE}` },
      body: JSON.stringify({ referencia: v.venta_id, monto: v.total_a_pagar, descripcion: `Orden ${v.orden_id}`, url_webhook: `${URLS.ventas}/webhooks/pasarela` }),
      signal: AbortSignal.timeout(10_000),
    }).catch((e) => ({ ok: false, status: 0, json: async () => ({ error: e.message }) }));
    const datos = await r.json();
    if (!r.ok) throw falla('PROVEEDOR_NO_DISPONIBLE', `La pasarela no creó el cobro: ${datos.error ?? r.status}`, true);
    v.cobro_id = datos.cobro_id;
    v.url_pago = datos.url_checkout;
  }

  // Los eventos de una venta salen en orden (pagada antes que liquidada) por una cola propia.
  function notificar(v, tipo, datos = {}) {
    const evento = { evento_id: `EVV-${randomUUID()}`, tipo, fecha: new Date().toISOString(), traza_id: v.traza_id, datos: { venta_id: v.venta_id, orden_id: v.orden_id, estado: v.estado, ...datos } };
    v.cola = (v.cola ?? Promise.resolve()).then(() => enviarEvento(v.url_notificacion, evento, FIRMA.ventas, { bitacora }));
  }

  // Verifica cada línea contra la reserva real del proveedor: nadie puede cobrar otro precio ni usar
  // una reserva de otra orden o que ya pertenece a otra venta.
  async function verificarLineas(traza_id, lineas, pagador, venta_id = null) {
    if (pagador.tipo === 'concesionario') {
      if (!/^GAR-/.test(pagador.autorizacion ?? '')) throw falla('DATOS_INVALIDOS', 'Si paga el concesionario, la venta necesita la autorización de garantía (GAR-...)');
      if (lineas.some((l) => l.concepto === 'repuesto')) throw falla('DATOS_INVALIDOS', 'En una venta de garantía los repuestos van como concepto garantia, con precio 0');
    }
    const consultadas = new Map();
    for (const l of lineas) {
      if (l.concepto === 'servicio') {
        if (l.beneficiario !== 'taller' || l.reserva_id) throw falla('DATOS_INVALIDOS', 'Solo el taller factura servicios, y sin reserva');
        continue;
      }
      if (!l.reserva_id) throw falla('DATOS_INVALIDOS', `La línea ${l.referencia} es un repuesto y necesita reserva_id`);
      if (l.beneficiario === 'taller') throw falla('DATOS_INVALIDOS', 'Los repuestos los factura su proveedor, no el taller');
      if (l.concepto === 'garantia' && (l.beneficiario !== 'concesionario' || l.precio_unitario !== 0 || pagador.tipo !== 'concesionario')) {
        throw falla('DATOS_INVALIDOS', `${l.referencia}: un repuesto en garantía lo entrega el concesionario con precio 0, en la venta que paga el concesionario`);
      }
      const duena = reservasUsadas.get(l.reserva_id);
      if (duena && duena !== venta_id) throw falla('ESTADO_INVALIDO', `La reserva ${l.reserva_id} ya pertenece a la venta ${duena}`);
      if (!consultadas.has(l.reserva_id)) {
        consultadas.set(l.reserva_id, await proveedores[l.beneficiario].llamar('consultar_reserva', { traza_id, reserva_id: l.reserva_id }));
      }
      const reserva = consultadas.get(l.reserva_id);
      if (reserva.estado !== 'activa') throw falla('RESERVA_VENCIDA', `La reserva ${l.reserva_id} está ${reserva.estado}`);
      const item = reserva.items.find((i) => i.sku === l.referencia);
      if (!item) throw falla('DATOS_INVALIDOS', `La reserva ${l.reserva_id} no incluye ${l.referencia}`);
      if (l.concepto === 'repuesto' && (item.precio_unitario !== l.precio_unitario || item.iva_porcentaje !== l.iva_porcentaje)) {
        throw falla('PRECIO_NO_COINCIDE', `${l.referencia}: la reserva dice ${item.precio_unitario} + IVA ${item.iva_porcentaje}%, la venta dice ${l.precio_unitario} + IVA ${l.iva_porcentaje}%`);
      }
      const pedidas = lineas.filter((x) => x.reserva_id === l.reserva_id && x.referencia === l.referencia).reduce((s, x) => s + x.cantidad, 0);
      if (pedidas > item.cantidad) throw falla('DATOS_INVALIDOS', `${l.referencia}: se reservaron ${item.cantidad} unidades y la venta pide ${pedidas}`);
    }
  }

  const reservasDe = (v) => [...new Map(v.lineas.filter((l) => l.reserva_id).map((l) => [l.reserva_id, l.beneficiario])).entries()];

  // Compensación: libera solo las reservas de esta venta (o todavía activas), nunca las de otra venta.
  async function liberarTodo(v, motivo) {
    for (const [reserva_id, proveedor] of reservasDe(v)) {
      try {
        const r = await proveedores[proveedor].llamar('consultar_reserva', { traza_id: v.traza_id, reserva_id });
        if (r.estado === 'activa' || (r.estado === 'confirmada' && r.venta_id === v.venta_id)) {
          await proveedores[proveedor].llamar('liberar_reserva', { traza_id: v.traza_id, reserva_id, motivo });
        }
      } catch (e) {
        bitacora({ traza_id: v.traza_id, evento: 'compensacion_fallida', reserva_id, error: e.message });
      }
    }
  }

  const aRevision = (v, motivo) => {
    v.estado = 'en_revision';
    v.motivo = motivo;
    bitacora({ traza_id: v.traza_id, evento: 'venta_en_revision', venta_id: v.venta_id, motivo });
  };

  // SAGA posterior al pago: confirmar a cada proveedor; si uno falla, compensar (liberar + reembolsar).
  async function alAprobarse(v) {
    v.estado = 'pagada';
    notificar(v, 'venta.pagada');
    try {
      for (const [reserva_id, proveedor] of reservasDe(v)) {
        await proveedores[proveedor].llamar('confirmar_reserva', { traza_id: v.traza_id, reserva_id, venta_id: v.venta_id });
      }
    } catch (e) {
      bitacora({ traza_id: v.traza_id, evento: 'saga_compensacion', venta_id: v.venta_id, motivo: e.message });
      await liberarTodo(v, `Compensación de ${v.venta_id}: ${e.message}`);
      if (v.cobro_id) {
        const r = await fetch(`${URLS.pasarela}/api/cobros/${v.cobro_id}/reembolso`, { method: 'POST', headers: { Authorization: `Bearer ${PASARELA_LLAVE}` }, signal: AbortSignal.timeout(10_000) }).catch(() => ({ ok: false, status: 0 }));
        if (!r.ok) return aRevision(v, `El reembolso falló (HTTP ${r.status}) después de: ${e.message}`);
      }
      v.estado = 'reembolsada';
      v.motivo = e.message;
      notificar(v, 'venta.reembolsada', { motivo: e.message });
      return;
    }
    const liquidacion = liquidar(v, PARAMETROS);
    if (!liquidacion.cuadra) return aRevision(v, 'La liquidación no cuadra: no se dispersa dinero');
    liquidacion.dispersiones = liquidacion.dispersiones.map((d) => ({ ...d, estado: 'transferida', referencia: `TR-${v.venta_id}-${d.beneficiario.toUpperCase()}` }));
    v.liquidacion = liquidacion;
    v.estado = 'liquidada';
    bitacora({ traza_id: v.traza_id, evento: 'venta_liquidada', venta_id: v.venta_id, recaudado: liquidacion.recaudado, cuadra: liquidacion.cuadra });
    notificar(v, 'venta.liquidada', { dispersiones: liquidacion.dispersiones.map(({ beneficiario, neto }) => ({ beneficiario, neto })) });
  }

  async function crear(args) {
    const { traza_id, orden_id, pagador, lineas, url_notificacion } = args;
    if (!DESTINOS_PERMITIDOS.includes(new URL(url_notificacion).origin)) throw falla('DATOS_INVALIDOS', 'url_notificacion no está entre los destinos permitidos');
    await verificarLineas(traza_id, lineas, pagador);
    // Después del await se revisa otra vez: otra venta pudo tomar la reserva mientras tanto.
    for (const l of lineas.filter((x) => x.reserva_id)) {
      if (reservasUsadas.has(l.reserva_id)) throw falla('ESTADO_INVALIDO', `La reserva ${l.reserva_id} ya pertenece a la venta ${reservasUsadas.get(l.reserva_id)}`);
    }
    const t = totales(lineas);
    const ret = Object.values(retenciones(lineas, pagador, PARAMETROS)).reduce((s, x) => s + x, 0);
    const v = {
      venta_id: `V-${String(++consecutivo).padStart(6, '0')}`, orden_id, traza_id, estado: 'pendiente_pago', pagador, lineas,
      subtotal: t.subtotal, iva: t.iva, retenciones: ret, total: t.total, total_a_pagar: t.total - ret,
      url_pago: null, creada_en: new Date().toISOString(), url_notificacion,
    };
    for (const l of lineas.filter((x) => x.reserva_id)) reservasUsadas.set(l.reserva_id, v.venta_id);
    ventas.set(v.venta_id, v);
    try {
      if (v.total_a_pagar > 0) await cobrar(v);
      else setImmediate(() => alAprobarse(v)); // nada que cobrar: se confirma y se liquida de una vez
    } catch (e) {
      ventas.delete(v.venta_id);
      for (const l of lineas.filter((x) => x.reserva_id)) reservasUsadas.delete(l.reserva_id);
      throw e;
    }
    return v;
  }

  const implementacion = {
    async crear_venta(args, { cliente }) {
      const clave = `${cliente}|${args.clave_idempotencia}`;
      const h = huella({ traza_id: args.traza_id, orden_id: args.orden_id, pagador: args.pagador, lineas: args.lineas });
      let entrada = idempotencia.get(clave);
      if (entrada && entrada.huella !== h) throw falla('IDEMPOTENCIA_CONFLICTO', 'Esa clave de idempotencia ya se usó con otra venta');
      if (!entrada) {
        // La promesa queda registrada antes del primer await: una llamada simultánea con la misma clave la reutiliza.
        entrada = { huella: h, promesa: crear(args) };
        idempotencia.set(clave, entrada);
        entrada.promesa.catch(() => idempotencia.delete(clave));
      }
      return publica(await entrada.promesa);
    },

    async consultar_venta({ traza_id, venta_id }) {
      return publica(buscar(venta_id, traza_id));
    },

    async generar_cobro({ traza_id, venta_id }) {
      const v = buscar(venta_id, traza_id);
      if (v.estado === 'pendiente_pago') return publica(v); // idempotente: el cobro vigente
      if (v.estado !== 'pago_rechazado') throw falla('ESTADO_INVALIDO', `La venta ${venta_id} está ${v.estado}; solo se genera un cobro nuevo si el pago fue rechazado`);
      await verificarLineas(v.traza_id, v.lineas, v.pagador, v.venta_id); // las reservas deben seguir activas
      if (v.estado !== 'pago_rechazado') return publica(v);
      v.estado = 'pendiente_pago';
      try {
        await cobrar(v);
      } catch (e) {
        v.estado = 'pago_rechazado';
        throw e;
      }
      return publica(v);
    },

    async anular_venta({ traza_id, venta_id, motivo }) {
      const v = buscar(venta_id, traza_id);
      if (v.estado === 'anulada') return publica(v);
      if (!['pendiente_pago', 'pago_rechazado'].includes(v.estado)) throw falla('ESTADO_INVALIDO', `No se puede anular una venta ${v.estado}`);
      v.estado = 'anulada';
      await liberarTodo(v, `Anulación: ${motivo}`);
      for (const [reserva_id] of reservasDe(v)) reservasUsadas.delete(reserva_id);
      return publica(v);
    },

    async consultar_liquidacion({ traza_id, venta_id }) {
      const v = buscar(venta_id, traza_id);
      if (!v.liquidacion) throw falla('ESTADO_INVALIDO', `La venta ${venta_id} está ${v.estado} y todavía no tiene liquidación`);
      return { venta_id, estado: v.estado, ...v.liquidacion };
    },
  };

  const enCurso = new Set();
  const rutas = {
    // Webhook de la pasarela: firma, vigencia de la firma, idempotencia y monto antes de tocar nada.
    'POST /webhooks/pasarela': async ({ req, res, cuerpo }) => {
      if (!verificarFirma(cuerpo, req.headers['x-pasarela-firma'], FIRMA.pasarela)) {
        bitacora({ evento: 'webhook_rechazado', motivo: 'firma inválida' });
        return responder(res, 401, { error: 'Firma inválida' });
      }
      const e = JSON.parse(cuerpo);
      if (eventosProcesados.has(e.evento_id) || enCurso.has(e.evento_id)) {
        bitacora({ traza_id: ventas.get(e.referencia)?.traza_id ?? null, evento: 'webhook_duplicado_ignorado', evento_id: e.evento_id });
        return responder(res, 200, { recibido: true, duplicado: true });
      }
      const v = ventas.get(e.referencia);
      if (!v || v.cobro_id !== e.cobro_id) {
        eventosProcesados.add(e.evento_id);
        return responder(res, 200, { recibido: true, ignorado: 'cobro desconocido o reemplazado' });
      }
      enCurso.add(e.evento_id);
      try {
        bitacora({ traza_id: v.traza_id, evento: `webhook ${e.tipo}`, venta_id: v.venta_id, monto: e.monto });
        if (e.tipo === 'cobro.aprobado' && v.estado === 'pendiente_pago') {
          if (e.monto !== v.total_a_pagar) aRevision(v, `La pasarela reporta ${e.monto} y la venta vale ${v.total_a_pagar}`);
          else await alAprobarse(v);
        } else if (e.tipo === 'cobro.rechazado' && v.estado === 'pendiente_pago') {
          v.estado = 'pago_rechazado';
          notificar(v, 'venta.pago_rechazado');
        }
        eventosProcesados.add(e.evento_id); // solo cuando terminó bien; si falla, la pasarela reintenta
        responder(res, 200, { recibido: true });
      } catch (error) {
        bitacora({ traza_id: v.traza_id, evento: 'webhook_fallido', evento_id: e.evento_id, error: error.message });
        responder(res, 500, { error: 'No se pudo procesar; reintente' });
      } finally {
        enCurso.delete(e.evento_id);
      }
    },
  };

  ({ bitacora } = await crearServicio({
    grupo: 'ventas', puerto, secreto: secretoJwt('ventas'), clientes: clientesDe('ventas'), implementacion, rutas,
    instrucciones: 'Orquestador comercial: crea ventas, cobra, liquida y dispersa el dinero a cada beneficiario.',
  }));
  return puerto;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(`ventas en el puerto ${await iniciar()}`);
