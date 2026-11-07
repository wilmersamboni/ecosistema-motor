// Escenarios de punta a punta del ecosistema MotorRed. Actúa como la aplicación del cliente: lleva el
// carro al taller, aprueba una opción y paga. Comprueba que el dinero, los estados y las reglas cuadren
// en los cuatro servicios.   node pruebas/escenarios.mjs        (inicia los simuladores que falten)
import { randomUUID } from 'node:crypto';
import { Liquidacion, Orden, Venta } from '../contrato/esquemas.mjs';
import { FIRMA, PARAMETROS, URLS } from '../lib/config.mjs';
import { ivaLinea, totales } from '../lib/dinero.mjs';
import { firmarEvento } from '../lib/firma.mjs';
import { asegurarEcosistema, bitacoraDe, bloque, clienteDe, cobro, esperar, intentar, pagar, prueba, resumen, sandbox } from './comun.mjs';

await asegurarEcosistema();
// Los escenarios se pueden repetir: antes de empezar, el inventario de los proveedores vuelve al del
// catálogo (ruta de laboratorio /sandbox/reabastecer).
for (const p of ['tienda', 'concesionario']) {
  const r = await sandbox(p, 'reabastecer').catch(() => ({ status: 0 }));
  if (r.status !== 200) console.log(`(aviso: ${p} no aceptó /sandbox/reabastecer, HTTP ${r.status}; con poco stock los escenarios pueden fallar)`);
}
const compartido = {};
const taller = clienteDe('app', 'taller', ['taller.recepcion']);
const ventas = clienteDe('app', 'ventas', ['ventas.consultar']);
const clave = () => randomUUID();
const esquemaOk = (esquema, datos) => esquema.safeParse(datos).success;

async function llevarAlTaller(nombre, datos) {
  const o = await taller.llamar('registrar_ingreso', { clave_idempotencia: clave(), ...datos });
  await taller.llamar('diagnosticar', { orden_id: o.orden_id });
  return taller.llamar('cotizar', { orden_id: o.orden_id });
}
const orden = (id) => taller.llamar('consultar_orden', { orden_id: id });
const venta = (o, v) => ventas.llamar('consultar_venta', { traza_id: o.traza_id, venta_id: v.venta_id });
const estadoOrden = (id, estado) => esperar(async () => ((await orden(id)).estado === estado ? true : null));
const estadoVenta = (o, v, estado) => esperar(async () => ((await venta(o, v)).estado === estado ? true : null));
const sumaVentas = (ventasDeOrden) => ventasDeOrden.reduce((s, v) => s + v.total_a_pagar, 0);

async function revisarLiquidacion(grupo, o, v) {
  const liq = await ventas.llamar('consultar_liquidacion', { traza_id: o.traza_id, venta_id: v.venta_id });
  prueba(grupo, `${v.venta_id}: la liquidación cumple el contrato`, true, esquemaOk(Liquidacion, liq));
  prueba(grupo, `${v.venta_id}: débitos = créditos y dispersión + comisión = recaudado`, true, liq.cuadra);
  const debitos = liq.asientos.reduce((s, a) => s + a.debito, 0), creditos = liq.asientos.reduce((s, a) => s + a.credito, 0);
  prueba(grupo, `${v.venta_id}: comprobación independiente de la partida doble`, debitos, creditos);
  prueba(grupo, `${v.venta_id}: todas las dispersiones quedaron transferidas`, true, liq.dispersiones.every((d) => d.estado === 'transferida'));
  return liq;
}

const ANA = { documento: '1083456789', nombre: 'Ana Rojas', tipo: 'persona_natural', retenedor: false, correo: 'ana@correo.com' };
const SPARK = { placa: 'ABC123', vin: '9GAMM6105GB000045', marca: 'Chevrolet', linea: 'Spark GT', modelo_anio: 2016, motor: '1.2L gasolina', kilometraje: 128400 };

// =============== E1. Spark con falla de encendido: flujo normal ===============
await bloque('E1 normal', async () => {
  const g = 'E1 normal';
  const datos = { cliente: ANA, vehiculo: SPARK, sintomas: 'El carro tiembla en ralentí y a veces se apaga', codigos_dtc: ['P0302'] };
  const k = clave();
  const o1 = await taller.llamar('registrar_ingreso', { clave_idempotencia: k, ...datos });
  const o1b = await taller.llamar('registrar_ingreso', { clave_idempotencia: k, ...datos });
  prueba(g, 'Registrar dos veces con la misma clave devuelve la misma orden', o1.orden_id, o1b.orden_id);
  const conflicto = await intentar(taller, 'registrar_ingreso', { clave_idempotencia: k, ...datos, sintomas: 'Otro síntoma distinto' });
  prueba(g, 'La misma clave con otros datos es un conflicto', 'IDEMPOTENCIA_CONFLICTO', conflicto.codigo);
  const antes = await intentar(taller, 'aprobar_opcion', { orden_id: o1.orden_id, opcion_id: 'X', clave_idempotencia: clave() });
  prueba(g, 'Aprobar antes de cotizar no se permite', 'ESTADO_INVALIDO', antes.codigo);
  const d = await taller.llamar('diagnosticar', { orden_id: o1.orden_id });
  prueba(g, 'Diagnóstico: 4 bujías y 1 bobina', '4 bujia, 1 bobina_encendido', d.diagnostico.requerimientos.map((r) => `${r.cantidad} ${r.categoria}`).join(', '));
  const o = await taller.llamar('cotizar', { orden_id: o1.orden_id });
  prueba(g, 'La orden cumple el contrato', true, esquemaOk(Orden, o));
  prueba(g, 'Garantía consultada al concesionario: vencida', false, o.garantia?.cubre);
  prueba(g, 'Opciones distintas (la rápida coincide con la económica y se descarta)', 'economica,original', o.opciones.map((x) => x.nombre).join(','));
  const eco = o.opciones.find((x) => x.nombre === 'economica');
  const recalculado = totales([...eco.items, { cantidad: 1, precio_unitario: eco.mano_obra.subtotal, iva_porcentaje: 19 }]);
  prueba(g, 'Total de la opción económica recalculado línea a línea', recalculado.total, eco.total);
  prueba(g, 'Económica: repuestos de la tienda', 'tienda', [...new Set(eco.items.map((i) => i.proveedor))].join());
  prueba(g, 'Recomienda la económica (la original cuesta más del 15% adicional)', eco.opcion_id, o.recomendacion.opcion_id);
  const kA = clave();
  const a = await taller.llamar('aprobar_opcion', { orden_id: o.orden_id, opcion_id: eco.opcion_id, clave_idempotencia: kA });
  const a2 = await taller.llamar('aprobar_opcion', { orden_id: o.orden_id, opcion_id: eco.opcion_id, clave_idempotencia: kA });
  prueba(g, 'Aprobar dos veces con la misma clave no duplica ventas', 1, a2.ventas.length);
  prueba(g, 'Una venta, a cargo del cliente, por el total de la opción', `1 ${eco.total}`, `${a.ventas.length} ${sumaVentas(a.ventas)}`);
  const v = a.ventas[0];
  const vv = await venta(o, v);
  prueba(g, 'La venta cumple el contrato', true, esquemaOk(Venta, vv));
  prueba(g, 'Cliente persona natural: sin retenciones', 0, vv.retenciones);
  prueba(g, 'Pago aprobado en la pasarela', 200, await pagar(v.url_pago, 'aprobado'));
  prueba(g, 'La orden pasa a en_reparacion cuando se liquida la venta', true, await estadoOrden(o.orden_id, 'en_reparacion'));
  const liq = await revisarLiquidacion(g, o, v);
  prueba(g, 'Se dispersó a taller y tienda', 'taller,tienda', liq.dispersiones.map((x) => x.beneficiario).sort().join());
  const ti = liq.dispersiones.find((x) => x.beneficiario === 'tienda');
  const baseTienda = eco.items.reduce((s, i) => s + i.cantidad * i.precio_unitario, 0);
  prueba(g, 'Comisión de la tienda = 3% de su base', Math.round(baseTienda * PARAMETROS.comision_porcentaje / 100), ti.comision);
  const bitVentas = await bitacoraDe('ventas', o.traza_id);
  const duplicados = bitVentas.filter((l) => l.evento === 'webhook_duplicado_ignorado').length;
  prueba(g, 'El webhook repetido por la pasarela se ignoró (idempotencia)', true, duplicados >= 1);
  const liquidaciones = bitVentas.filter((l) => l.evento === 'venta_liquidada' && l.venta_id === v.venta_id).length;
  prueba(g, 'La venta se liquidó una sola vez', 1, liquidaciones);
  let trazas = 0;
  for (const s of ['taller', 'tienda', 'concesionario', 'ventas']) if ((await bitacoraDe(s, o.traza_id)).length) trazas++;
  prueba(g, 'La traza de la orden aparece en las bitácoras de los cuatro servicios (GET /bitacora)', 4, trazas);
  Object.assign(compartido, { traza: o.traza_id, venta: v.venta_id, reserva: vv.lineas.find((l) => l.reserva_id).reserva_id });
});

// =============== E2. Logan en garantía: dos pagadores ===============
await bloque('E2 garantia', async () => {
  const g = 'E2 garantia';
  const o = await llevarAlTaller(g, {
    cliente: { ...ANA, documento: '52987654', nombre: 'Luis Pérez', correo: 'luis@correo.com' },
    vehiculo: { placa: 'KLM456', vin: '9FBLSRALBSM000123', marca: 'Renault', linea: 'Logan', modelo_anio: 2025, motor: '1.6L gasolina', kilometraje: 18250 },
    sintomas: 'Se prendió la luz del motor y el carro jalonea', codigos_dtc: ['P0301'],
  });
  prueba(g, 'La garantía cubre la bobina y la mano de obra, no las bujías', 'true bobina_encendido true', `${o.garantia.cubre} ${o.garantia.categorias_cubiertas.join()} ${o.garantia.cubre_mano_obra}`);
  const rec = o.opciones.find((x) => x.opcion_id === o.recomendacion.opcion_id);
  const bobina = rec.items.find((i) => i.categoria === 'bobina_encendido');
  prueba(g, 'La bobina sale del concesionario, original y sin costo', 'concesionario original 0 concesionario', `${bobina.proveedor} ${bobina.tipo} ${bobina.precio_unitario} ${bobina.pagador}`);
  const a = await taller.llamar('aprobar_opcion', { orden_id: o.orden_id, opcion_id: rec.opcion_id, clave_idempotencia: clave() });
  prueba(g, 'Dos ventas: cliente y concesionario', 'cliente,concesionario', a.ventas.map((v) => v.pagador).sort().join());
  const vc = a.ventas.find((v) => v.pagador === 'concesionario');
  const vCon = await venta(o, vc);
  prueba(g, 'Mano de obra en garantía: la mitad (1 de 2 categorías cubiertas)', Math.round(rec.mano_obra.subtotal / 2), rec.mano_obra.subtotal_garantia);
  prueba(g, 'La venta del concesionario lleva su autorización de garantía', o.garantia.autorizacion, vCon.pagador.autorizacion);
  const mo = rec.mano_obra.subtotal_garantia;
  prueba(g, `Base de ${mo} por debajo de 2 UVT: el concesionario no retiene`, 0, vCon.retenciones);
  prueba(g, 'El concesionario paga su parte de la mano de obra con IVA', mo + ivaLinea({ cantidad: 1, precio_unitario: mo, iva_porcentaje: 19 }), vCon.total_a_pagar);
  const vCli = await venta(o, a.ventas.find((v) => v.pagador === 'cliente'));
  prueba(g, 'El cliente paga las bujías y la otra mitad de la mano de obra', 'repuesto,servicio', vCli.lineas.map((l) => l.concepto).sort().join());
  for (const v of a.ventas) await pagar(v.url_pago, 'aprobado');
  prueba(g, 'Pagadas las dos ventas, la orden pasa a en_reparacion', true, await estadoOrden(o.orden_id, 'en_reparacion'));
  const liq = await revisarLiquidacion(g, o, vc);
  prueba(g, 'En la venta de garantía solo se dispersa al taller', 'taller', liq.dispersiones.map((x) => x.beneficiario).join());
});

// =============== E3. Mazda: pago rechazado y nuevo cobro ===============
await bloque('E3 rechazo', async () => {
  const g = 'E3 rechazo';
  const o = await llevarAlTaller(g, {
    cliente: { ...ANA, documento: '1075222333', nombre: 'Marta Gil', correo: 'marta@correo.com' },
    vehiculo: { placa: 'MZD219', marca: 'Mazda', linea: '2', modelo_anio: 2019, motor: '1.5L gasolina', kilometraje: 74300 },
    sintomas: 'Chillido y vibra al frenar', codigos_dtc: [],
  });
  prueba(g, 'Sin VIN ni marca del concesionario: no se consulta garantía', null, o.garantia);
  prueba(g, 'Solo opción económica: sin originales para Mazda y el disco genérico no tiene 2 unidades', 'economica', o.opciones.map((x) => x.nombre).join());
  const a = await taller.llamar('aprobar_opcion', { orden_id: o.orden_id, opcion_id: o.recomendacion.opcion_id, clave_idempotencia: clave() });
  const v = a.ventas[0];
  await pagar(v.url_pago, 'rechazado');
  prueba(g, 'Pago rechazado: la venta queda pago_rechazado', true, await estadoVenta(o, v, 'pago_rechazado'));
  prueba(g, 'El cobro rechazado no se puede volver a usar', 409, await pagar(v.url_pago, 'aprobado'));
  const nueva = await ventas.llamar('generar_cobro', { traza_id: o.traza_id, venta_id: v.venta_id });
  prueba(g, 'Nuevo cobro con el mismo valor y otro enlace', `${v.total_a_pagar} true`, `${nueva.total_a_pagar} ${nueva.url_pago !== v.url_pago}`);
  await pagar(nueva.url_pago, 'aprobado');
  prueba(g, 'Con el segundo pago la venta se liquida', true, await estadoVenta(o, v, 'liquidada'));
  await revisarLiquidacion(g, o, v);
});

// =============== E4. Reserva vencida antes del pago: compensación ===============
await bloque('E4 compensa', async () => {
  const g = 'E4 compensa';
  const o = await llevarAlTaller(g, {
    cliente: { ...ANA, documento: '36111222', nombre: 'Pedro Ruiz', correo: 'pedro@correo.com' },
    vehiculo: { ...SPARK, placa: 'XYZ987', vin: undefined, kilometraje: 98000 },
    sintomas: 'Tiembla y se apaga', codigos_dtc: ['P0304'],
  });
  const a = await taller.llamar('aprobar_opcion', { orden_id: o.orden_id, opcion_id: o.recomendacion.opcion_id, clave_idempotencia: clave() });
  const v = a.ventas[0];
  const vv = await venta(o, v);
  const reserva = vv.lineas.find((l) => l.reserva_id).reserva_id;
  prueba(g, 'El sandbox vence la reserva en la tienda', 200, (await sandbox('tienda', `vencer/${reserva}`)).status);
  await pagar(v.url_pago, 'aprobado');
  prueba(g, 'La reserva venció: ventas compensa y la venta queda reembolsada', true, await estadoVenta(o, v, 'reembolsada'));
  prueba(g, 'La pasarela registró el reembolso', 'reembolsado', (await cobro(v.url_pago)).estado);
  prueba(g, 'La orden pide una nueva cotización', true, await estadoOrden(o.orden_id, 'requiere_nueva_cotizacion'));
  const sinLiq = await intentar(ventas, 'consultar_liquidacion', { traza_id: o.traza_id, venta_id: v.venta_id });
  prueba(g, 'Una venta reembolsada no tiene liquidación', 'ESTADO_INVALIDO', sinLiq.codigo);
  const o2 = await taller.llamar('cotizar', { orden_id: o.orden_id });
  const a2 = await taller.llamar('aprobar_opcion', { orden_id: o.orden_id, opcion_id: o2.recomendacion.opcion_id, clave_idempotencia: clave() });
  await pagar(a2.ventas[0].url_pago, 'aprobado');
  prueba(g, 'Con la nueva cotización la orden se completa', true, await estadoOrden(o.orden_id, 'en_reparacion'));
});

// =============== E5. Flota de una empresa retenedora ===============
await bloque('E5 retencion', async () => {
  const g = 'E5 retencion';
  const o = await llevarAlTaller(g, {
    cliente: { documento: '900111222-3', nombre: 'Transportes del Sur S.A.S.', tipo: 'empresa', retenedor: true, correo: 'flota@transsur.co' },
    vehiculo: { placa: 'TSX481', marca: 'Toyota', linea: 'Hilux', modelo_anio: 2021, motor: '2.4L diesel', kilometraje: 65000 },
    sintomas: 'Mantenimiento de 65.000 km', codigos_dtc: [],
  });
  const op = o.opciones.find((x) => x.opcion_id === o.recomendacion.opcion_id);
  const a = await taller.llamar('aprobar_opcion', { orden_id: o.orden_id, opcion_id: op.opcion_id, clave_idempotencia: clave() });
  const vv = await venta(o, a.ventas[0]);
  const baseRep = op.items.reduce((s, i) => s + i.cantidad * i.precio_unitario, 0);
  const uvt = PARAMETROS.uvt;
  const retServ = op.mano_obra.subtotal >= 2 * uvt ? Math.round(op.mano_obra.subtotal * 0.04) : 0;
  const retRep = baseRep >= 10 * uvt ? Math.round(baseRep * 0.025) : 0;
  prueba(g, `Servicio ${op.mano_obra.subtotal} >= 2 UVT: retención 4%`, retServ > 0, true);
  prueba(g, `Repuestos ${baseRep} < 10 UVT: sin retención`, 0, retRep);
  prueba(g, 'Retenciones de la venta', retServ + retRep, vv.retenciones);
  prueba(g, 'Total a pagar = total - retenciones', vv.total - vv.retenciones, vv.total_a_pagar);
  await pagar(vv.url_pago, 'aprobado');
  await estadoOrden(o.orden_id, 'en_reparacion');
  const liq = await revisarLiquidacion(g, o, vv);
  prueba(g, 'La retención se descuenta solo al taller', `${retServ} 0`, `${liq.dispersiones.find((x) => x.beneficiario === 'taller').retencion} ${liq.dispersiones.find((x) => x.beneficiario === 'tienda').retencion}`);
});

// =============== E6. Seguridad del ecosistema ===============
await bloque('E6 seguridad', async () => {
  const g = 'E6 seguridad';
  const herramientasApp = (await ventas.herramientas()).map((h) => h.name);
  prueba(g, 'La app (solo consulta) no ve crear_venta en ventas', false, herramientasApp.includes('crear_venta'));
  const r1 = await fetch(`${URLS.tienda}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grant_type: 'client_credentials', client_id: 'taller', client_secret: 'adivinada' }) });
  prueba(g, 'Credencial de servicio equivocada', 401, r1.status);
  const r2 = await fetch(`${URLS.tienda}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grant_type: 'client_credentials', client_id: 'taller', client_secret: (await import('../lib/config.mjs')).credencial('taller', 'tienda'), scope: 'proveedor.confirmar' }) });
  prueba(g, 'El taller pide un alcance que no le corresponde (confirmar)', 400, r2.status);
  const sinToken = await fetch(`${URLS.ventas}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  prueba(g, 'MCP sin token', `401 ${'Bearer'}`, `${sinToken.status} ${sinToken.headers.get('www-authenticate')}`);
  const evento = JSON.stringify({ evento_id: 'EVP-falso', tipo: 'cobro.aprobado', cobro_id: 'CB-000001', referencia: 'V-000001', monto: 1, fecha: new Date().toISOString() });
  const f1 = await fetch(`${URLS.ventas}/webhooks/pasarela`, { method: 'POST', headers: { 'X-Pasarela-Firma': firmarEvento(evento, 'secreto-adivinado') }, body: evento });
  prueba(g, 'Webhook de pago con firma falsa', 401, f1.status);
  const viejo = Math.floor(Date.now() / 1000) - 600;
  const f2 = await fetch(`${URLS.ventas}/webhooks/pasarela`, { method: 'POST', headers: { 'X-Pasarela-Firma': firmarEvento(evento, FIRMA.pasarela, viejo) }, body: evento });
  prueba(g, 'Webhook con firma válida pero de hace 10 minutos (reenvío)', 401, f2.status);
  // Un taller con errores (o comprometido) intenta cobrar un precio distinto al reservado.
  const tallerTienda = clienteDe('taller', 'tienda', ['proveedor.cotizar', 'proveedor.reservar']);
  const tallerVentas = clienteDe('taller', 'ventas', ['ventas.crear']);
  const traza = randomUUID();
  const { ofertas } = await tallerTienda.llamar('buscar_repuestos', { traza_id: traza, vehiculo: SPARK, categoria: 'bujia', cantidad: 4 });
  const of = ofertas.sort((x, y) => x.precio_unitario - y.precio_unitario)[0];
  const res = await tallerTienda.llamar('reservar_repuestos', { traza_id: traza, clave_idempotencia: clave(), items: [{ oferta_id: of.oferta_id, cantidad: 4 }], minutos_vigencia: 5 });
  const truco = await intentar(tallerVentas, 'crear_venta', {
    traza_id: traza, clave_idempotencia: clave(), orden_id: 'OT-PRUEBA', url_notificacion: `${URLS.taller}/eventos`,
    pagador: { tipo: 'cliente', documento: '1083456789', nombre: 'Ana Rojas', retenedor: false, autorizacion: null },
    lineas: [{ beneficiario: 'tienda', concepto: 'repuesto', referencia: of.sku, descripcion: of.descripcion, cantidad: 4, precio_unitario: of.precio_unitario + 5000, iva_porcentaje: 19, reserva_id: res.reserva_id }],
  });
  prueba(g, 'Cobrar un precio distinto al de la reserva del proveedor', 'PRECIO_NO_COINCIDE', truco.codigo);
  const garantiaFalsa = await intentar(tallerVentas, 'crear_venta', {
    traza_id: traza, clave_idempotencia: clave(), orden_id: 'OT-PRUEBA', url_notificacion: `${URLS.taller}/eventos`,
    pagador: { tipo: 'cliente', documento: '1083456789', nombre: 'Ana Rojas', retenedor: false, autorizacion: null },
    lineas: [{ beneficiario: 'tienda', concepto: 'garantia', referencia: of.sku, descripcion: 'regalo', cantidad: 4, precio_unitario: 0, iva_porcentaje: 19, reserva_id: res.reserva_id }],
  });
  prueba(g, 'Hacer pasar un repuesto de la tienda como garantía gratis', 'DATOS_INVALIDOS', garantiaFalsa.codigo);
  const kRep = clave();
  const conflicto = await intentar(tallerTienda, 'reservar_repuestos', { traza_id: traza, clave_idempotencia: kRep, items: [{ oferta_id: of.oferta_id, cantidad: 1 }], minutos_vigencia: 5 });
  const conflicto2 = await intentar(tallerTienda, 'reservar_repuestos', { traza_id: traza, clave_idempotencia: kRep, items: [{ oferta_id: of.oferta_id, cantidad: 2 }], minutos_vigencia: 5 });
  prueba(g, 'Reutilizar una clave de idempotencia con otra cantidad', 'true IDEMPOTENCIA_CONFLICTO', `${conflicto.ok} ${conflicto2.codigo}`);
  const base = {
    traza_id: traza, orden_id: 'OT-PRUEBA', url_notificacion: `${URLS.taller}/eventos`,
    pagador: { tipo: 'cliente', documento: '1083456789', nombre: 'Ana Rojas', retenedor: false, autorizacion: null },
    lineas: [{ beneficiario: 'tienda', concepto: 'repuesto', referencia: of.sku, descripcion: of.descripcion, cantidad: 4, precio_unitario: of.precio_unitario, iva_porcentaje: 19, reserva_id: res.reserva_id }],
  };
  const externa = await intentar(tallerVentas, 'crear_venta', { ...base, clave_idempotencia: clave(), url_notificacion: 'http://169.254.169.254/latest' });
  prueba(g, 'Notificar a una dirección que no es del ecosistema (SSRF)', 'DATOS_INVALIDOS', externa.codigo);
  const kCarrera = clave();
  const carrera = await Promise.all([1, 2, 3, 4].map(() => intentar(tallerVentas, 'crear_venta', { ...base, clave_idempotencia: kCarrera })));
  const aceptadas = carrera.filter((x) => x.ok);
  const rechazo = carrera.find((x) => !x.ok);
  prueba(g, 'Cuatro crear_venta simultáneas con la misma clave: todas responden la misma venta', '4 aceptadas, 1 venta',
    `${aceptadas.length} aceptadas, ${new Set(aceptadas.map((x) => x.datos.venta_id)).size} venta${rechazo ? ` (rechazo: ${rechazo.codigo} ${rechazo.mensaje})` : ''}`);
  const otraVenta = await intentar(tallerVentas, 'crear_venta', { ...base, clave_idempotencia: clave() });
  prueba(g, 'Usar en otra venta una reserva que ya tiene dueña', 'ESTADO_INVALIDO', otraVenta.codigo);
  const ajena = await intentar(ventas, 'consultar_venta', { traza_id: randomUUID(), venta_id: aceptadas[0]?.datos.venta_id ?? 'V-X' });
  prueba(g, 'Consultar una venta con la traza de otra orden', 'NO_ENCONTRADO', ajena.codigo);
  const fabricada = await intentar(tallerTienda, 'reservar_repuestos', { traza_id: traza, clave_idempotencia: clave(), items: [{ oferta_id: `OF-${of.sku}-99999999999`, cantidad: 1 }], minutos_vigencia: 5 });
  prueba(g, 'Reservar con una oferta inventada', 'NO_ENCONTRADO', fabricada.codigo);
  if (compartido.reserva) {
    const liberarAjena = await intentar(tallerTienda, 'liberar_reserva', { traza_id: compartido.traza, reserva_id: compartido.reserva, motivo: 'intento indebido' });
    prueba(g, 'El taller intenta liberar una reserva ya pagada y confirmada', 'ESTADO_INVALIDO', liberarAjena.codigo);
  }
  const ventaCarrera = aceptadas[0]?.datos.venta_id;
  if (ventaCarrera) await clienteDe('taller', 'ventas', ['ventas.crear']).llamar('anular_venta', { traza_id: traza, venta_id: ventaCarrera, motivo: 'fin de la prueba' });
  if (conflicto.ok) await tallerTienda.llamar('liberar_reserva', { traza_id: traza, reserva_id: conflicto.datos.reserva_id, motivo: 'fin de la prueba' });
  for (const c of [tallerTienda, tallerVentas]) await c.cerrar();
});

for (const c of [taller, ventas]) await c.cerrar();
const ok = resumen('RESUMEN DE ESCENARIOS');
process.exit(ok ? 0 : 1);
