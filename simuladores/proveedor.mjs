// Simulador de un proveedor de repuestos (tienda o concesionario): catálogo con compatibilidad, ofertas
// con vigencia, reservas con vencimiento, idempotencia, confirmación y liberación (compensación).
// Las reglas que aquí se aplican están escritas en contrato/REGLAS.md.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { falla } from '../lib/errores.mjs';
import { sinTildes, totales } from '../lib/dinero.mjs';
import { responder, sandboxPermitido } from '../lib/servicio.mjs';

export const VIGENCIA_OFERTA_MIN = 120;
const huella = (obj) => createHash('sha256').update(JSON.stringify(obj)).digest('hex');
const enMinutos = (m) => new Date(Date.now() + m * 60_000).toISOString();

// Compatibilidad: marca y línea iguales (o "*"); la línea del vehículo puede tener más palabras
// ("Spark GT" es "spark"); el motor del vehículo contiene el del producto ("1.2L gasolina" contiene "1.2");
// el año está en el rango. Todo sin tildes ni mayúsculas.
export function compatible(producto, vehiculo) {
  const marca = sinTildes(vehiculo.marca), linea = sinTildes(vehiculo.linea), motor = sinTildes(vehiculo.motor);
  return producto.aplica.some((a) =>
    (a.marca === '*' || a.marca === marca) &&
    (a.linea === '*' || linea === a.linea || linea.startsWith(a.linea + ' ')) &&
    motor.includes(a.motor) &&
    vehiculo.modelo_anio >= a.desde && vehiculo.modelo_anio <= a.hasta);
}

export function crearProveedor(grupo, catalogo, parametros) {
  const productos = new Map(catalogo.productos.map((p) => [p.sku, { iva: parametros.iva_porcentaje, ...p }]));
  const inicial = new Map(catalogo.productos.map((p) => [p.sku, p.stock]));
  const ofertas = new Map(); // oferta_id aleatorio → { sku, precio, iva, vence }
  const reservas = new Map();
  const idempotencia = new Map(); // clave → { huella, reserva_id }
  let consecutivo = 0;

  const crearOferta = (p) => {
    const oferta_id = `OF-${randomBytes(9).toString('base64url')}`;
    const vence = Date.now() + VIGENCIA_OFERTA_MIN * 60_000;
    ofertas.set(oferta_id, { sku: p.sku, precio: p.precio, iva: p.iva, vence });
    return {
      oferta_id, proveedor: grupo, sku: p.sku, categoria: p.categoria, descripcion: p.descripcion, fabricante: p.fabricante,
      tipo: p.tipo, precio_unitario: p.precio, iva_porcentaje: p.iva, stock_disponible: Math.max(0, p.stock),
      tiempo_entrega_horas: p.entrega_horas, garantia_meses: p.garantia_meses, vigente_hasta: new Date(vence).toISOString(),
    };
  };
  const leerOferta = (oferta_id) => {
    const of = ofertas.get(oferta_id);
    if (!of) throw falla('NO_ENCONTRADO', `No existe la oferta ${oferta_id} en ${grupo}`);
    if (of.vence < Date.now()) throw falla('OFERTA_VENCIDA', `La oferta ${oferta_id} venció; cotice de nuevo`);
    return of;
  };

  // Una reserva activa vencida devuelve sus unidades al inventario la próxima vez que se toca.
  const revisar = (r) => {
    if (r.estado === 'activa' && Date.parse(r.vence_en) < Date.now()) {
      for (const i of r.items) productos.get(i.sku).stock += i.cantidad;
      r.estado = 'vencida';
    }
    return r;
  };
  // Cada reserva pertenece a una orden: con otra traza_id, para el que pregunta no existe.
  const buscarReserva = (id, traza_id) => {
    const r = reservas.get(id);
    if (!r || r.traza_id !== traza_id) throw falla('NO_ENCONTRADO', `No existe la reserva ${id} en ${grupo}`);
    return revisar(r);
  };
  const publica = ({ traza_id, ...r }) => r;
  setInterval(() => {
    for (const r of reservas.values()) revisar(r);
    for (const [id, of] of ofertas) if (of.vence < Date.now()) ofertas.delete(id);
  }, 30_000).unref();

  const implementacion = {
    async buscar_repuestos({ vehiculo, categoria }) {
      return { ofertas: [...productos.values()].filter((p) => p.categoria === categoria && compatible(p, vehiculo)).map(crearOferta) };
    },

    async reservar_repuestos({ traza_id, clave_idempotencia, items, minutos_vigencia }, { cliente }) {
      const clave = `${cliente}|${clave_idempotencia}`;
      const h = huella({ traza_id, items, minutos_vigencia });
      const previa = idempotencia.get(clave);
      if (previa) {
        if (previa.huella !== h) throw falla('IDEMPOTENCIA_CONFLICTO', 'Esa clave de idempotencia ya se usó con otros datos');
        return publica(revisar(reservas.get(previa.reserva_id)));
      }
      // Se suman las cantidades por SKU antes de revisar el stock: dos líneas del mismo SKU cuentan juntas.
      const porSku = new Map();
      for (const i of items) {
        const of = leerOferta(i.oferta_id);
        const actual = porSku.get(of.sku) ?? { of, cantidad: 0 };
        actual.cantidad += i.cantidad;
        porSku.set(of.sku, actual);
      }
      for (const { of, cantidad } of porSku.values()) {
        const p = productos.get(of.sku);
        if (p.stock < cantidad) throw falla('STOCK_INSUFICIENTE', `Solo hay ${Math.max(0, p.stock)} unidades de ${p.sku}`);
      }
      // Sin "await" entre la revisión y el descuento: en este proceso nadie más toca el stock en medio.
      // En PostgreSQL, lo mismo se logra con una transacción y bloqueo de filas.
      for (const { of, cantidad } of porSku.values()) productos.get(of.sku).stock -= cantidad;
      const detalle = [...porSku.values()].map(({ of, cantidad }) => {
        const p = productos.get(of.sku);
        return { sku: p.sku, categoria: p.categoria, descripcion: p.descripcion, cantidad, precio_unitario: of.precio, iva_porcentaje: of.iva };
      });
      const { subtotal, iva, total } = totales(detalle);
      const reserva = {
        reserva_id: `${grupo === 'tienda' ? 'RT' : 'RC'}-${String(++consecutivo).padStart(6, '0')}`,
        proveedor: grupo, estado: 'activa', vence_en: enMinutos(minutos_vigencia), items: detalle,
        subtotal, iva, total, venta_id: null, despacho: null, traza_id,
      };
      reservas.set(reserva.reserva_id, reserva);
      idempotencia.set(clave, { huella: h, reserva_id: reserva.reserva_id });
      return publica(reserva);
    },

    async consultar_reserva({ traza_id, reserva_id }) {
      return publica(buscarReserva(reserva_id, traza_id));
    },

    async confirmar_reserva({ traza_id, reserva_id, venta_id }) {
      const r = buscarReserva(reserva_id, traza_id);
      if (r.estado === 'confirmada' && r.venta_id === venta_id) return publica(r);
      if (r.estado === 'vencida') throw falla('RESERVA_VENCIDA', `La reserva ${reserva_id} venció antes de confirmarse`);
      if (r.estado !== 'activa') throw falla('ESTADO_INVALIDO', `La reserva ${reserva_id} está ${r.estado}${r.venta_id ? ` para la venta ${r.venta_id}` : ''}`);
      const horas = Math.max(...r.items.map((i) => productos.get(i.sku).entrega_horas));
      Object.assign(r, { estado: 'confirmada', venta_id, despacho: { guia: `GU-${randomUUID().slice(0, 8).toUpperCase()}`, eta: enMinutos(horas * 60) } });
      return publica(r);
    },

    // Una reserva activa la puede liberar quien la creó (taller) o ventas. Una confirmada (ya vendida)
    // solo la libera ventas, que es quien cobró y quien debe compensar.
    async liberar_reserva({ traza_id, reserva_id }, { alcances }) {
      const r = buscarReserva(reserva_id, traza_id);
      if (r.estado === 'liberada' || r.estado === 'vencida') return publica(r);
      if (r.estado === 'confirmada' && !alcances.includes('proveedor.confirmar')) {
        throw falla('ESTADO_INVALIDO', `La reserva ${reserva_id} ya está confirmada para la venta ${r.venta_id}: solo ventas puede liberarla`);
      }
      for (const i of r.items) productos.get(i.sku).stock += i.cantidad;
      r.estado = 'liberada';
      return publica(r);
    },
  };

  // Solo laboratorio (SANDBOX=1 y cabecera X-Sandbox-Llave): vencer una reserva y reabastecer.
  const rutas = {
    'POST /sandbox/vencer/:id': async ({ req, res, ruta }) => {
      if (!sandboxPermitido(req)) return responder(res, 403, { error: 'Sandbox deshabilitado o llave inválida' });
      const r = reservas.get(ruta.split('/').pop());
      if (!r) return responder(res, 404, { error: 'No existe' });
      r.vence_en = new Date(Date.now() - 1000).toISOString();
      revisar(r);
      responder(res, 200, { reserva_id: r.reserva_id, estado: r.estado });
    },
    // Sin cuerpo: deja el inventario disponible como en el catálogo, aunque haya reservas activas de
    // pruebas anteriores (es un laboratorio: así las pruebas se pueden repetir sin reiniciar).
    // Con { "minimo": N }: sube cada producto al menos a N unidades (pruebas de carga).
    'POST /sandbox/reabastecer': async ({ req, res, cuerpo }) => {
      if (!sandboxPermitido(req)) return responder(res, 403, { error: 'Sandbox deshabilitado o llave inválida' });
      let minimo = null;
      try { minimo = cuerpo ? Number(JSON.parse(cuerpo).minimo) || null : null; } catch {}
      for (const p of productos.values()) {
        p.stock = minimo ? Math.max(p.stock, minimo) : Math.max(p.stock, inicial.get(p.sku));
      }
      responder(res, 200, { productos: productos.size });
    },
  };
  return { implementacion, rutas, productos, reservas };
}
