// Simulador del grupo Falla: el taller. Es el ORQUESTADOR DEL SERVICIO: recibe el vehículo,
// diagnostica, consulta garantía y proveedores, arma opciones, reserva y entrega la venta al
// orquestador comercial (ventas). Las decisiones aquí son reglas fijas; en el proyecto las toman
// agentes con un modelo de lenguaje, con estas mismas reglas como barandas.   node simuladores/taller.mjs
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClienteServicio } from '../lib/cliente.mjs';
import { FIRMA, PARAMETROS, PUERTOS, URLS, clientesDe, credencial, secretoJwt } from '../lib/config.mjs';
import { ivaLinea, sinTildes, totales } from '../lib/dinero.mjs';
import { ErrorNegocio, falla } from '../lib/errores.mjs';
import { verificarFirma } from '../lib/firma.mjs';
import { crearServicio, responder } from '../lib/servicio.mjs';

const BASE = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'datos', 'base-fallas.json'), 'utf8'));
const MARCAS_CONCESIONARIO = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'datos', 'catalogo-concesionario.json'), 'utf8')).marcas;
const huella = (obj) => createHash('sha256').update(JSON.stringify(obj)).digest('hex');
const ahora = () => new Date().toISOString();

// Diagnóstico por reglas: primero los códigos de falla, después las palabras de los síntomas.
export function diagnosticarPorReglas(orden) {
  const sintomas = sinTildes(orden.sintomas);
  const motor = sinTildes(orden.vehiculo.motor);
  const reglas = BASE.reglas.filter((r) =>
    (!r.motor || motor.includes(r.motor)) &&
    (orden.codigos_dtc.some((c) => r.dtc.includes(c)) || r.palabras.some((p) => sintomas.includes(p))));
  if (!reglas.length) {
    return { hallazgos: ['No hay una regla para estos síntomas: requiere inspección del técnico'], requerimientos: [], mano_obra_horas: 1, confianza: 0.2, requiere_revision_humana: true };
  }
  const regla = reglas[0];
  const hallazgo = orden.codigos_dtc.length ? `${regla.hallazgo} (códigos ${orden.codigos_dtc.join(', ')})` : regla.hallazgo;
  return { hallazgos: [hallazgo], requerimientos: regla.requerimientos, mano_obra_horas: regla.horas, confianza: regla.confianza, requiere_revision_humana: regla.confianza < 0.7 };
}

export async function iniciar(puerto = PUERTOS.taller) {
  const ordenes = new Map();
  const idempotencia = new Map();
  const eventosProcesados = new Set();
  let consecutivo = 0;
  let bitacora = () => {};

  const cliente = (destino, alcances) => new ClienteServicio({ destino, url: URLS[destino], clientId: 'taller', clientSecret: credencial('taller', destino), alcances });
  const tienda = cliente('tienda', ['proveedor.cotizar', 'proveedor.reservar']);
  const concesionario = cliente('concesionario', ['proveedor.cotizar', 'proveedor.reservar', 'garantia.consultar']);
  const ventas = cliente('ventas', ['ventas.crear']);
  const proveedores = { tienda, concesionario };

  const buscar = (id) => {
    const o = ordenes.get(id);
    if (!o) throw falla('NO_ENCONTRADO', `No existe la orden ${id}`);
    return o;
  };
  const evento = (o, tipo, detalle) => o.eventos.push({ fecha: ahora(), tipo, detalle });
  const exigir = (o, ...estados) => {
    if (!estados.includes(o.estado)) throw falla('ESTADO_INVALIDO', `La orden ${o.orden_id} está ${o.estado}; se esperaba ${estados.join(' o ')}`);
  };

  // Consulta los dos proveedores en paralelo. Si uno no responde, se cotiza con el otro y se anota.
  async function ofertasPara(o, req) {
    const consultas = Object.entries(proveedores).map(async ([nombre, c]) => {
      try {
        const r = await c.llamar('buscar_repuestos', { traza_id: o.traza_id, vehiculo: o.vehiculo, categoria: req.categoria, cantidad: req.cantidad });
        return r.ofertas;
      } catch (e) {
        evento(o, 'proveedor_no_disponible', `${nombre}: ${e.message}`);
        return [];
      }
    });
    return (await Promise.all(consultas)).flat().filter((of) => of.stock_disponible >= req.cantidad);
  }

  function armarOpcion(o, nombre, elegidas, garantia) {
    // Un repuesto cubierto por garantía no se le cobra a nadie: el concesionario lo entrega con precio 0.
    const items = elegidas.map(({ req, oferta }) => {
      const cubierto = Boolean(garantia?.categorias_cubiertas.includes(req.categoria));
      return {
        oferta_id: oferta.oferta_id, proveedor: oferta.proveedor, sku: oferta.sku, categoria: oferta.categoria, descripcion: oferta.descripcion,
        tipo: oferta.tipo, cantidad: req.cantidad, precio_unitario: cubierto ? 0 : oferta.precio_unitario, iva_porcentaje: oferta.iva_porcentaje,
        pagador: cubierto ? 'concesionario' : 'cliente',
      };
    });
    const horas = o.diagnostico.mano_obra_horas;
    const subtotal = Math.round(horas * PARAMETROS.valor_hora_taller);
    const categorias = new Set(o.diagnostico.requerimientos.map((r) => r.categoria));
    const cubiertas = garantia?.cubre_mano_obra ? garantia.categorias_cubiertas.filter((c) => categorias.has(c)).length : 0;
    const mano = { horas, valor_hora: PARAMETROS.valor_hora_taller, subtotal, subtotal_garantia: Math.round((subtotal * cubiertas) / categorias.size) };
    const lineasMano = [
      { cantidad: 1, precio_unitario: mano.subtotal - mano.subtotal_garantia, iva_porcentaje: PARAMETROS.iva_porcentaje, pagador: 'cliente' },
      { cantidad: 1, precio_unitario: mano.subtotal_garantia, iva_porcentaje: PARAMETROS.iva_porcentaje, pagador: 'concesionario' },
    ].filter((l) => l.precio_unitario > 0);
    const todas = [...items, ...lineasMano];
    const t = totales(todas);
    const delCliente = todas.filter((l) => l.pagador === 'cliente');
    return {
      opcion_id: `${o.orden_id}-C${o.cotizacion}-${nombre.toUpperCase()}`, nombre, items, mano_obra: mano,
      subtotal: t.subtotal, iva: t.iva, total: t.total,
      total_cliente: delCliente.reduce((s, l) => s + l.cantidad * l.precio_unitario + ivaLinea(l), 0),
      tiempo_entrega_horas: Math.max(0, ...items.map((i) => elegidas.find((e) => e.oferta.oferta_id === i.oferta_id).oferta.tiempo_entrega_horas)),
      garantia_meses_minima: items.length ? Math.min(...elegidas.map((e) => e.oferta.garantia_meses)) : 0,
    };
  }

  const implementacion = {
    async registrar_ingreso(args, { cliente: quien }) {
      const clave = `${quien}|${args.clave_idempotencia}`;
      const h = huella(args);
      const previa = idempotencia.get(clave);
      if (previa) {
        if (previa.huella !== h) throw falla('IDEMPOTENCIA_CONFLICTO', 'Esa clave de idempotencia ya se usó con otros datos');
        return buscar(previa.id);
      }
      const o = {
        orden_id: `OT-${String(++consecutivo).padStart(6, '0')}`, traza_id: randomUUID(), estado: 'recibida',
        cliente: args.cliente, vehiculo: args.vehiculo, sintomas: args.sintomas, codigos_dtc: args.codigos_dtc,
        diagnostico: null, garantia: null, cotizacion: 0, opciones: [], recomendacion: null, opcion_aprobada: null, ventas: [], eventos: [],
      };
      evento(o, 'recibida', `${o.vehiculo.marca} ${o.vehiculo.linea} ${o.vehiculo.placa}, ${o.vehiculo.kilometraje} km`);
      ordenes.set(o.orden_id, o);
      idempotencia.set(clave, { huella: h, id: o.orden_id });
      return o;
    },

    async diagnosticar({ orden_id }) {
      const o = buscar(orden_id);
      exigir(o, 'recibida', 'diagnosticada');
      o.diagnostico = diagnosticarPorReglas(o);
      o.estado = 'diagnosticada';
      evento(o, 'diagnosticada', o.diagnostico.hallazgos.join('; '));
      return o;
    },

    async cotizar({ orden_id }) {
      const o = buscar(orden_id);
      exigir(o, 'diagnosticada', 'cotizada', 'requiere_nueva_cotizacion');
      if (o.ventas.length) {
        // Antes de cotizar de nuevo, se anulan las ventas sin pagar de la cotización anterior (y con
        // ellas sus reservas y sus enlaces de pago). Si alguna ya recibió dinero, decide una persona.
        if (o.ventas.some((v) => ['pagada', 'liquidada', 'en_revision'].includes(v.estado))) {
          throw falla('ESTADO_INVALIDO', 'La cotización anterior tiene dinero recibido: requiere revisión humana');
        }
        for (const v of o.ventas.filter((x) => ['pendiente_pago', 'pago_rechazado'].includes(x.estado))) {
          await ventas.llamar('anular_venta', { traza_id: o.traza_id, venta_id: v.venta_id, motivo: 'Nueva cotización de la orden' });
          v.estado = 'anulada';
        }
        evento(o, 'ventas_archivadas', o.ventas.map((v) => `${v.venta_id} ${v.estado}`).join(', '));
        o.ventas = [];
        o.opcion_aprobada = null;
      }
      if (!o.diagnostico.requerimientos.length) throw falla('ESTADO_INVALIDO', 'El diagnóstico no pide repuestos: requiere revisión del técnico');
      // 1. Garantía: solo si el vehículo tiene VIN y es de una marca del concesionario.
      o.garantia = null;
      if (o.vehiculo.vin && MARCAS_CONCESIONARIO.includes(sinTildes(o.vehiculo.marca))) {
        try {
          const g = await concesionario.llamar('evaluar_garantia', {
            traza_id: o.traza_id, vin: o.vehiculo.vin, kilometraje: o.vehiculo.kilometraje,
            categorias: o.diagnostico.requerimientos.map((r) => r.categoria), descripcion_falla: o.diagnostico.hallazgos.join('; '),
          });
          o.garantia = g;
          evento(o, 'garantia', g.motivo);
        } catch (e) {
          if (!(e instanceof ErrorNegocio && e.codigo === 'NO_ENCONTRADO')) evento(o, 'garantia_no_consultada', e.message);
        }
      }
      // Cada cotización tiene número propio: las claves de idempotencia de reservas y ventas lo incluyen.
      o.cotizacion += 1;
      const cubiertas = o.garantia?.cubre ? o.garantia.categorias_cubiertas : [];
      // 2. Ofertas de los dos proveedores por cada requerimiento.
      const porReq = [];
      for (const req of o.diagnostico.requerimientos) {
        let ofertas = await ofertasPara(o, req);
        if (cubiertas.includes(req.categoria)) ofertas = ofertas.filter((of) => of.proveedor === 'concesionario' && of.tipo === 'original');
        if (!ofertas.length) throw falla('STOCK_INSUFICIENTE', `Ningún proveedor tiene ${req.cantidad} unidades de ${req.categoria} para este vehículo`);
        porReq.push({ req, ofertas });
      }
      // 3. Tres estrategias; se descartan las repetidas.
      const elegir = (criterio) => porReq.map(({ req, ofertas }) => ({ req, oferta: [...ofertas].sort(criterio)[0] }));
      const porPrecio = (a, b) => a.precio_unitario - b.precio_unitario;
      const candidatas = [['economica', elegir(porPrecio)], ['rapida', elegir((a, b) => a.tiempo_entrega_horas - b.tiempo_entrega_horas || porPrecio(a, b))]];
      if (porReq.every(({ ofertas }) => ofertas.some((of) => of.tipo === 'original'))) {
        candidatas.push(['original', porReq.map(({ req, ofertas }) => ({ req, oferta: ofertas.filter((of) => of.tipo === 'original').sort(porPrecio)[0] }))]);
      }
      const vistas = new Set();
      o.opciones = [];
      for (const [nombre, elegidas] of candidatas) {
        const firma = elegidas.map((e) => e.oferta.oferta_id).join(',');
        if (vistas.has(firma)) continue;
        vistas.add(firma);
        o.opciones.push(armarOpcion(o, nombre, elegidas, o.garantia?.cubre ? o.garantia : null));
      }
      // 4. Recomendación: la original si cuesta máximo 15% más que la económica; si no, la económica.
      const eco = o.opciones.find((x) => x.nombre === 'economica');
      const ori = o.opciones.find((x) => x.nombre === 'original');
      const elegida = ori && ori.total_cliente <= eco.total_cliente * 1.15 ? ori : eco;
      o.recomendacion = {
        opcion_id: elegida.opcion_id,
        justificacion: elegida === ori
          ? `Los repuestos originales cuestan solo ${Math.round((ori.total_cliente / Math.max(eco.total_cliente, 1) - 1) * 100)}% más y dan ${ori.garantia_meses_minima} meses de garantía.`
          : `Es la de menor valor para el cliente${ori ? `: la original cuesta ${Math.round((ori.total_cliente / eco.total_cliente - 1) * 100)}% más` : ''}.`,
      };
      o.estado = 'cotizada';
      evento(o, 'cotizada', `${o.opciones.length} opciones; recomendada ${elegida.nombre}`);
      return o;
    },

    async aprobar_opcion({ orden_id, opcion_id, clave_idempotencia }, { cliente: quien }) {
      const o = buscar(orden_id);
      const clave = `${quien}|${clave_idempotencia}`;
      const previa = idempotencia.get(clave);
      if (previa) {
        if (previa.huella !== huella({ orden_id, opcion_id })) throw falla('IDEMPOTENCIA_CONFLICTO', 'Esa clave ya se usó para aprobar otra opción');
        await previa.promesa;
        return o;
      }
      exigir(o, 'cotizada');
      if (o.aprobando) throw falla('ESTADO_INVALIDO', `La orden ${orden_id} ya tiene una aprobación en curso`, true);
      // Sin await entre la revisión y esta marca: una segunda aprobación simultánea se rechaza.
      o.aprobando = true;
      const promesa = aprobar(o, opcion_id).finally(() => { o.aprobando = false; });
      idempotencia.set(clave, { huella: huella({ orden_id, opcion_id }), id: orden_id, promesa });
      promesa.catch(() => idempotencia.delete(clave));
      await promesa;
      return o;
    },

    async consultar_orden({ orden_id }) {
      return buscar(orden_id);
    },
  };

  async function aprobar(o, opcion_id) {
      const orden_id = o.orden_id;
      const opcion = o.opciones.find((x) => x.opcion_id === opcion_id);
      if (!opcion) throw falla('NO_ENCONTRADO', `La orden ${orden_id} no tiene la opción ${opcion_id}`);
      // 1. Reservas por proveedor; si una falla, se liberan las anteriores (compensación).
      const reservas = [];
      try {
        for (const prov of ['tienda', 'concesionario']) {
          const items = opcion.items.filter((i) => i.proveedor === prov);
          if (!items.length) continue;
          const r = await proveedores[prov].llamar('reservar_repuestos', {
            traza_id: o.traza_id, clave_idempotencia: `${orden_id}:${opcion_id}:${prov}`,
            items: items.map((i) => ({ oferta_id: i.oferta_id, cantidad: i.cantidad })), minutos_vigencia: 30,
          });
          reservas.push(r);
        }
      } catch (e) {
        for (const r of reservas) await proveedores[r.proveedor].llamar('liberar_reserva', { traza_id: o.traza_id, reserva_id: r.reserva_id, motivo: 'La reserva de otro proveedor falló' }).catch(() => {});
        evento(o, 'reserva_fallida', e.message);
        throw e;
      }
      // 2. Una venta por pagador (cliente y, si hay garantía, concesionario).
      const lineasDe = (pagador) => [
        ...opcion.items.filter((i) => i.pagador === pagador).map((i) => ({
          beneficiario: i.proveedor, concepto: pagador === 'concesionario' ? 'garantia' : 'repuesto', referencia: i.sku,
          descripcion: pagador === 'concesionario' ? `${i.descripcion} (garantía ${o.garantia.autorizacion})` : i.descripcion,
          cantidad: i.cantidad, precio_unitario: i.precio_unitario, iva_porcentaje: i.iva_porcentaje,
          reserva_id: reservas.find((r) => r.proveedor === i.proveedor).reserva_id,
        })),
        ...[{ pagador: 'cliente', valor: opcion.mano_obra.subtotal - opcion.mano_obra.subtotal_garantia },
          { pagador: 'concesionario', valor: opcion.mano_obra.subtotal_garantia }]
          .filter((m) => m.pagador === pagador && m.valor > 0)
          .map((m) => ({
            beneficiario: 'taller', concepto: 'servicio', referencia: `MO-${orden_id}`,
            descripcion: `Mano de obra: ${opcion.mano_obra.horas} h${pagador === 'concesionario' ? ' (parte en garantía)' : ''}`,
            cantidad: 1, precio_unitario: m.valor, iva_porcentaje: PARAMETROS.iva_porcentaje, reserva_id: null,
          })),
      ];
      const pagadores = {
        cliente: { tipo: 'cliente', documento: o.cliente.documento, nombre: o.cliente.nombre, retenedor: o.cliente.retenedor, autorizacion: null },
        concesionario: { tipo: 'concesionario', documento: '900765432-5', nombre: 'Sur Motor S.A.S. (garantía)', retenedor: true, autorizacion: o.garantia?.autorizacion ?? null },
      };
      try {
        for (const pagador of ['cliente', 'concesionario']) {
          const lineas = lineasDe(pagador);
          if (!lineas.length) continue;
          const v = await ventas.llamar('crear_venta', {
            traza_id: o.traza_id, clave_idempotencia: `${orden_id}:${opcion_id}:${pagador}`, orden_id,
            pagador: pagadores[pagador], lineas, url_notificacion: `${URLS.taller}/eventos`,
          });
          o.ventas.push({ venta_id: v.venta_id, pagador, total_a_pagar: v.total_a_pagar, url_pago: v.url_pago, estado: v.estado });
        }
      } catch (e) {
        evento(o, 'venta_fallida', e.message);
        throw e;
      }
      o.opcion_aprobada = opcion_id;
      o.estado = 'pendiente_pago';
      evento(o, 'aprobada', `${opcion.nombre}: ${o.ventas.map((v) => `${v.venta_id} (${v.pagador}) $${v.total_a_pagar}`).join(', ')}`);
  }

  const rutas = {
    // Eventos que envía ventas, firmados. Idempotente: un evento repetido no cambia nada.
    'POST /eventos': async ({ req, res, cuerpo }) => {
      if (!verificarFirma(cuerpo, req.headers['x-firma'], FIRMA.ventas)) return responder(res, 401, { error: 'Firma inválida' });
      const e = JSON.parse(cuerpo);
      if (eventosProcesados.has(e.evento_id)) return responder(res, 200, { recibido: true, duplicado: true });
      eventosProcesados.add(e.evento_id);
      const o = ordenes.get(e.datos.orden_id);
      const v = o?.ventas.find((x) => x.venta_id === e.datos.venta_id);
      if (!v) return responder(res, 200, { recibido: true, ignorado: true });
      // Solo se avanza: si "pagada" llega después de "liquidada", no hace retroceder la venta.
      const RANGO = { pendiente_pago: 0, pago_rechazado: 1, pagada: 2, en_revision: 3, liquidada: 3, reembolsada: 3, anulada: 3 };
      if ((RANGO[e.datos.estado] ?? 0) > (RANGO[v.estado] ?? 0) || (v.estado === 'pago_rechazado' && e.datos.estado === 'pendiente_pago')) v.estado = e.datos.estado;
      evento(o, e.tipo, `${v.venta_id}${e.datos.motivo ? ': ' + e.datos.motivo : ''}`);
      if (o.ventas.every((x) => x.estado === 'liquidada')) o.estado = 'en_reparacion';
      if (e.tipo === 'venta.reembolsada') {
        if (o.ventas.some((x) => ['pagada', 'liquidada'].includes(x.estado))) {
          o.estado = 'en_revision'; // una parte se cobró y la otra se devolvió: decide una persona
        } else {
          o.estado = 'requiere_nueva_cotizacion';
        }
      }
      responder(res, 200, { recibido: true });
    },
  };

  ({ bitacora } = await crearServicio({
    grupo: 'taller', puerto, secreto: secretoJwt('taller'), clientes: clientesDe('taller'), implementacion, rutas,
    instrucciones: 'Orquestador del servicio: órdenes de trabajo, diagnóstico, cotización y aprobación del cliente.',
  }));
  return puerto;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(`taller en el puerto ${await iniciar()}`);
