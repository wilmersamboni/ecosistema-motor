// Prueba de conformidad: ¿el servicio de un grupo cumple el contrato MotorRed?
//   node pruebas/conformidad.mjs tienda            (usa URL_TIENDA del .env; por defecto el simulador)
//   node pruebas/conformidad.mjs ventas --url http://localhost:3000
// Revisa credenciales y alcances, la lista de herramientas, los esquemas de entrada y de salida,
// los códigos de error, la idempotencia y las reglas de negocio con los datos de prueba del contrato.
import { randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { DecisionGarantia, Garantia, Liquidacion, Oferta, Orden, Reserva, Venta, VERSION_CONTRATO } from '../contrato/esquemas.mjs';
import { HERRAMIENTAS, PERMISOS } from '../contrato/herramientas.mjs';
import { FIRMA, URLS, credencial } from '../lib/config.mjs';
import { ivaLinea } from '../lib/dinero.mjs';
import { firmarEvento } from '../lib/firma.mjs';
import { asegurarEcosistema, clienteDe, esperar, intentar, pagar, prueba, resultados, resumen, sandbox } from './comun.mjs';

const grupo = process.argv[2];
if (!PERMISOS[grupo]) {
  console.error('Uso: node pruebas/conformidad.mjs <taller|tienda|concesionario|ventas> [--url http://host:puerto]');
  process.exit(1);
}
const i = process.argv.indexOf('--url');
if (i > 0) URLS[grupo] = process.argv[i + 1].replace(/\/$/, '');
console.log(`Conformidad del grupo ${grupo} en ${URLS[grupo]} con el contrato ${VERSION_CONTRATO}\n`);
await asegurarEcosistema();
// El inventario de los proveedores vuelve al del catálogo (ruta de laboratorio del contrato).
for (const p of ['tienda', 'concesionario']) await sandbox(p, 'reabastecer').catch(() => {});

const G = 'general';
const ok = (esquema, datos) => {
  const r = esquema.safeParse(datos);
  return r.success ? true : r.error.issues.slice(0, 2).map((x) => `${x.path.join('.')}: ${x.message}`).join('; ');
};
const traza = randomUUID();
const clave = () => randomUUID();

// ---------- 1. Salud, credenciales y alcances ----------
const salud = await fetch(`${URLS[grupo]}/salud`).then((r) => r.json()).catch(() => ({}));
prueba(G, 'GET /salud responde con la versión del contrato', VERSION_CONTRATO, salud.contrato);
const pedirToken = (cuerpo) => fetch(`${URLS[grupo]}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grant_type: 'client_credentials', ...cuerpo }) });
const [cliente1] = Object.keys(PERMISOS[grupo]);
prueba(G, 'POST /oauth/token con un secreto equivocado', 401, (await pedirToken({ client_id: cliente1, client_secret: 'equivocado' })).status);
prueba(G, 'POST /oauth/token pidiendo un alcance no permitido', 400, (await pedirToken({ client_id: cliente1, client_secret: credencial(cliente1, grupo), scope: 'superusuario' })).status);
const bueno = await (await pedirToken({ client_id: cliente1, client_secret: credencial(cliente1, grupo) })).json();
prueba(G, 'POST /oauth/token entrega un token Bearer con vencimiento', 'Bearer true', `${bueno.token_type} ${bueno.expires_in > 0}`);
const sin = await fetch(`${URLS[grupo]}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
prueba(G, '/mcp sin token responde 401 con WWW-Authenticate: Bearer', '401 Bearer', `${sin.status} ${sin.headers.get('www-authenticate')}`);
const partes = bueno.access_token.split('.');
const alterado = `${partes[0]}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(partes[1], 'base64url')), scope: 'todo' })).toString('base64url')}.${partes[2]}`;
const conAlterado = await fetch(`${URLS[grupo]}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${alterado}` }, body: '{}' });
prueba(G, '/mcp con la carga del token alterada responde 401', 401, conAlterado.status);

const bitSin = await fetch(`${URLS[grupo]}/bitacora`, { headers: { Authorization: `Bearer ${bueno.access_token}` } });
prueba(G, `GET /bitacora con un token sin alcance auditoria (${cliente1})`, 403, bitSin.status);
const aud = await (await pedirToken({ client_id: 'auditor', client_secret: credencial('auditor', grupo) })).json();
const bitAud = await fetch(`${URLS[grupo]}/bitacora`, { headers: { Authorization: `Bearer ${aud.access_token}` } });
const bitDatos = await bitAud.json().catch(() => ({}));
prueba(G, 'GET /bitacora con el auditor devuelve sus registros', '200 true', `${bitAud.status} ${Array.isArray(bitDatos.registros)}`);

// ---------- 2. Herramientas visibles para cada cliente y sus esquemas ----------
const alcances = (h) => (Array.isArray(h.alcance) ? h.alcance : [h.alcance]);
for (const [cliente, permitidos] of Object.entries(PERMISOS[grupo])) {
  const esperadas = HERRAMIENTAS.filter((h) => h.grupo === grupo && alcances(h).some((a) => permitidos.includes(a)));
  const c = clienteDe(cliente, grupo, permitidos);
  const publicadas = await c.herramientas();
  prueba('herramientas', `Cliente ${cliente}: ve exactamente sus herramientas`, esperadas.map((h) => h.nombre).sort().join(','), publicadas.map((t) => t.name).sort().join(','));
  for (const h of esperadas) {
    const t = publicadas.find((x) => x.name === h.nombre);
    if (!t) continue;
    const contrato = z.toJSONSchema(h.entrada);
    const camposOk = Object.keys(contrato.properties).sort().join() === Object.keys(t.inputSchema.properties ?? {}).sort().join()
      && (contrato.required ?? []).sort().join() === (t.inputSchema.required ?? []).sort().join();
    prueba('herramientas', `${h.nombre}: campos de entrada y obligatorios del contrato`, true, camposOk, Object.keys(t.inputSchema.properties ?? {}).join(','));
    prueba('herramientas', `${h.nombre}: publica esquema de salida`, true, Boolean(t.outputSchema?.properties));
    prueba('herramientas', `${h.nombre}: anotación readOnlyHint del contrato`, h.anotaciones.readOnlyHint, Boolean(t.annotations?.readOnlyHint));
  }
  await c.cerrar();
}

// ---------- 3. Reglas de negocio con los datos de prueba del contrato ----------
const SPARK = { placa: 'ABC123', vin: '9GAMM6105GB000045', marca: 'Chevrolet', linea: 'Spark GT', modelo_anio: 2016, motor: '1.2L gasolina', kilometraje: 128400 };
const LOGAN = { placa: 'KLM456', vin: '9FBLSRALBSM000123', marca: 'Renault', linea: 'Logan', modelo_anio: 2025, motor: '1.6L gasolina', kilometraje: 18250 };
const MAZDA = { placa: 'MZD219', marca: 'Mazda', linea: '2', modelo_anio: 2019, motor: '1.5L gasolina', kilometraje: 74300 };

async function proveedor() {
  const P = 'reglas';
  const taller = clienteDe('taller', grupo, PERMISOS[grupo].taller);
  const ventas = clienteDe('ventas', grupo, PERMISOS[grupo].ventas);
  const vehiculo = grupo === 'tienda' ? SPARK : LOGAN;
  const buscar = async () => (await taller.llamar('buscar_repuestos', { traza_id: traza, vehiculo, categoria: 'bujia', cantidad: 4 })).ofertas;
  const ofertas = await buscar();
  prueba(P, `buscar_repuestos: ofertas de bujía para ${vehiculo.marca} ${vehiculo.linea}`, true, ofertas.length > 0);
  prueba(P, 'Cada oferta cumple el contrato', true, ofertas.map((o) => ok(Oferta, o)).find((x) => x !== true) ?? true);
  prueba(P, 'Las ofertas son del proveedor que responde', grupo, [...new Set(ofertas.map((o) => o.proveedor))].join());
  const ajeno = await taller.llamar('buscar_repuestos', { traza_id: traza, vehiculo: { ...MAZDA, marca: 'Ferrari', linea: 'Roma' }, categoria: 'bujia', cantidad: 1 });
  prueba(P, 'Vehículo incompatible: ninguna oferta', 0, ajeno.ofertas.length);
  const of = ofertas[0];
  const k = clave();
  const r1 = await taller.llamar('reservar_repuestos', { traza_id: traza, clave_idempotencia: k, items: [{ oferta_id: of.oferta_id, cantidad: 2 }], minutos_vigencia: 10 });
  const r2 = await taller.llamar('reservar_repuestos', { traza_id: traza, clave_idempotencia: k, items: [{ oferta_id: of.oferta_id, cantidad: 2 }], minutos_vigencia: 10 });
  prueba(P, 'reservar_repuestos cumple el contrato', true, ok(Reserva, r1));
  prueba(P, 'Reservar dos veces con la misma clave devuelve la misma reserva', r1.reserva_id, r2.reserva_id);
  prueba(P, 'La reserva congela el precio de la oferta', of.precio_unitario, r1.items[0].precio_unitario);
  prueba(P, 'Total de la reserva = subtotal + IVA por línea', r1.subtotal + ivaLinea(r1.items[0]), r1.total);
  const stock = (await buscar()).find((o) => o.sku === of.sku).stock_disponible;
  prueba(P, 'El stock baja en las unidades reservadas', of.stock_disponible - 2, stock);
  prueba(P, 'Misma clave con otra cantidad', 'IDEMPOTENCIA_CONFLICTO', (await intentar(taller, 'reservar_repuestos', { traza_id: traza, clave_idempotencia: k, items: [{ oferta_id: of.oferta_id, cantidad: 3 }], minutos_vigencia: 10 })).codigo);
  // Dos líneas del mismo SKU que juntas superan el stock (cada una por separado sí cabe).
  const libre = (await buscar()).find((o) => o.sku === of.sku);
  const total = libre.stock_disponible + 1;
  if (total <= 100) {
    const mitad = Math.ceil(total / 2);
    const lineas = [{ oferta_id: libre.oferta_id, cantidad: mitad }, { oferta_id: libre.oferta_id, cantidad: total - mitad }];
    prueba(P, 'Dos líneas del mismo SKU que juntas superan el stock', 'STOCK_INSUFICIENTE', (await intentar(taller, 'reservar_repuestos', { traza_id: traza, clave_idempotencia: clave(), items: lineas, minutos_vigencia: 10 })).codigo);
  } else {
    prueba(P, 'Dos líneas del mismo SKU que juntas superan el stock (stock demasiado alto para probarlo)', 'omitida', 'omitida');
  }
  const kSim = clave();
  const simultaneas = await Promise.all([1, 2, 3, 4, 5].map(() => intentar(taller, 'reservar_repuestos', { traza_id: traza, clave_idempotencia: kSim, items: [{ oferta_id: of.oferta_id, cantidad: 1 }], minutos_vigencia: 10 })));
  prueba(P, 'Cinco reservas simultáneas con la misma clave: una sola reserva', 1, new Set(simultaneas.map((x) => x.datos?.reserva_id)).size);
  if (simultaneas[0].ok) await taller.llamar('liberar_reserva', { traza_id: traza, reserva_id: simultaneas[0].datos.reserva_id, motivo: 'prueba de concurrencia' });
  prueba(P, 'Reservar con una oferta inventada', 'NO_ENCONTRADO', (await intentar(taller, 'reservar_repuestos', { traza_id: traza, clave_idempotencia: clave(), items: [{ oferta_id: `OF-${of.sku}-99999999999`, cantidad: 1 }], minutos_vigencia: 10 })).codigo);
  prueba(P, 'Consultar una reserva con la traza de otra orden', 'NO_ENCONTRADO', (await intentar(taller, 'consultar_reserva', { traza_id: randomUUID(), reserva_id: r1.reserva_id })).codigo);
  prueba(P, 'Reservar una oferta que no existe', 'NO_ENCONTRADO', (await intentar(taller, 'reservar_repuestos', { traza_id: traza, clave_idempotencia: clave(), items: [{ oferta_id: 'OF-NO-EXISTE-1', cantidad: 1 }], minutos_vigencia: 10 })).codigo);
  const confirmada = await ventas.llamar('confirmar_reserva', { traza_id: traza, reserva_id: r1.reserva_id, venta_id: 'V-CONF-1' });
  prueba(P, 'Ventas confirma la reserva y se programa el despacho', 'confirmada true', `${confirmada.estado} ${Boolean(confirmada.despacho?.guia)}`);
  const otraVez = await ventas.llamar('confirmar_reserva', { traza_id: traza, reserva_id: r1.reserva_id, venta_id: 'V-CONF-1' });
  prueba(P, 'Confirmar otra vez con la misma venta no cambia nada', confirmada.despacho.guia, otraVez.despacho.guia);
  prueba(P, 'El taller no puede liberar una reserva ya confirmada (vendida)', 'ESTADO_INVALIDO', (await intentar(taller, 'liberar_reserva', { traza_id: traza, reserva_id: r1.reserva_id, motivo: 'intento indebido' })).codigo);
  const antesDeLiberar = (await buscar()).find((o) => o.sku === of.sku).stock_disponible;
  const r3 = await taller.llamar('reservar_repuestos', { traza_id: traza, clave_idempotencia: clave(), items: [{ oferta_id: of.oferta_id, cantidad: 1 }], minutos_vigencia: 10 });
  const lib = await taller.llamar('liberar_reserva', { traza_id: traza, reserva_id: r3.reserva_id, motivo: 'prueba de conformidad' });
  prueba(P, 'liberar_reserva deja la reserva liberada', 'liberada', lib.estado);
  prueba(P, 'Al liberar, el stock vuelve a ser el de antes', antesDeLiberar, (await buscar()).find((o) => o.sku === of.sku).stock_disponible);
  const r4 = await taller.llamar('reservar_repuestos', { traza_id: traza, clave_idempotencia: clave(), items: [{ oferta_id: of.oferta_id, cantidad: 1 }], minutos_vigencia: 1 });
  const vencer = await sandbox(grupo, `vencer/${r4.reserva_id}`);
  prueba(P, 'POST /sandbox/vencer (ruta de laboratorio del contrato)', 200, vencer.status);
  prueba(P, 'Confirmar una reserva vencida', 'RESERVA_VENCIDA', (await intentar(ventas, 'confirmar_reserva', { traza_id: traza, reserva_id: r4.reserva_id, venta_id: 'V-CONF-3' })).codigo);
  prueba(P, 'Confirmar una reserva liberada', 'ESTADO_INVALIDO', (await intentar(ventas, 'confirmar_reserva', { traza_id: traza, reserva_id: r3.reserva_id, venta_id: 'V-CONF-2' })).codigo);
  prueba(P, 'Consultar una reserva que no existe', 'NO_ENCONTRADO', (await intentar(taller, 'consultar_reserva', { traza_id: traza, reserva_id: 'NO-EXISTE' })).codigo);
  await ventas.llamar('liberar_reserva', { traza_id: traza, reserva_id: r1.reserva_id, motivo: 'fin de la prueba de conformidad' });
  if (grupo === 'concesionario') {
    const g1 = await taller.llamar('consultar_vehiculo', { traza_id: traza, vin: LOGAN.vin });
    prueba(P, 'consultar_vehiculo cumple el contrato', true, ok(Garantia, g1));
    prueba(P, 'Logan 2025 vendido en junio de 2025: garantía vigente', true, g1.garantia.vigente);
    const g2 = await taller.llamar('consultar_vehiculo', { traza_id: traza, vin: SPARK.vin });
    prueba(P, 'Spark 2016: garantía vencida y una campaña pendiente', 'false 1', `${g2.garantia.vigente} ${g2.campanas.length}`);
    prueba(P, 'VIN desconocido', 'NO_ENCONTRADO', (await intentar(taller, 'consultar_vehiculo', { traza_id: traza, vin: '1HGCM82633A004352' })).codigo);
    const d = await taller.llamar('evaluar_garantia', { traza_id: traza, vin: LOGAN.vin, kilometraje: 18250, categorias: ['bujia', 'bobina_encendido'], descripcion_falla: 'Falla de encendido en el cilindro 1' });
    prueba(P, 'evaluar_garantia cumple el contrato', true, ok(DecisionGarantia, d));
    prueba(P, 'Cubre la bobina y no las bujías (desgaste)', 'true bobina_encendido', `${d.cubre} ${d.categorias_cubiertas.join()}`);
    const d2 = await taller.llamar('evaluar_garantia', { traza_id: traza, vin: LOGAN.vin, kilometraje: 150000, categorias: ['bobina_encendido'], descripcion_falla: 'Falla de encendido en el cilindro 1' });
    prueba(P, 'Con 150.000 km la garantía ya no cubre', false, d2.cubre);
  }
  await taller.cerrar(); await ventas.cerrar();
}

async function ventasConformidad() {
  const P = 'reglas';
  const tienda = clienteDe('taller', 'tienda', ['proveedor.cotizar', 'proveedor.reservar']);
  const ventas = clienteDe('taller', 'ventas', ['ventas.crear']);
  const reservar = async (cantidad) => {
    const { ofertas } = await tienda.llamar('buscar_repuestos', { traza_id: traza, vehiculo: SPARK, categoria: 'bujia', cantidad });
    const of = ofertas.sort((a, b) => a.precio_unitario - b.precio_unitario)[0];
    return { of, r: await tienda.llamar('reservar_repuestos', { traza_id: traza, clave_idempotencia: clave(), items: [{ oferta_id: of.oferta_id, cantidad }], minutos_vigencia: 10 }) };
  };
  const pagador = { tipo: 'cliente', documento: '1083456789', nombre: 'Ana Rojas', retenedor: false, autorizacion: null };
  const lineas = (of, r, precio = of.precio_unitario) => [
    { beneficiario: 'tienda', concepto: 'repuesto', referencia: of.sku, descripcion: of.descripcion, cantidad: 4, precio_unitario: precio, iva_porcentaje: 19, reserva_id: r.reserva_id },
    { beneficiario: 'taller', concepto: 'servicio', referencia: 'MO-CONF', descripcion: 'Mano de obra 1.5 h', cantidad: 1, precio_unitario: 142500, iva_porcentaje: 19, reserva_id: null },
  ];
  const { of, r } = await reservar(4);
  const k = clave();
  const datos = { traza_id: traza, clave_idempotencia: k, orden_id: 'OT-CONF', pagador, lineas: lineas(of, r), url_notificacion: `${URLS.taller}/eventos` };
  const v = await ventas.llamar('crear_venta', datos);
  prueba(P, 'crear_venta cumple el contrato', true, ok(Venta, v));
  const esperado = lineas(of, r).reduce((s, l) => s + l.cantidad * l.precio_unitario + ivaLinea(l), 0);
  prueba(P, 'Total = suma de bases + IVA calculado por línea', esperado, v.total);
  prueba(P, 'Queda pendiente de pago con enlace de pago', 'pendiente_pago true', `${v.estado} ${Boolean(v.url_pago)}`);
  prueba(P, 'Crear otra vez con la misma clave devuelve la misma venta', v.venta_id, (await ventas.llamar('crear_venta', datos)).venta_id);
  prueba(P, 'Misma clave con otra venta', 'IDEMPOTENCIA_CONFLICTO', (await intentar(ventas, 'crear_venta', { ...datos, orden_id: 'OT-OTRA' })).codigo);
  const nueva = await reservar(4);
  const kSim = clave();
  const datosNueva = { ...datos, clave_idempotencia: kSim, lineas: lineas(nueva.of, nueva.r) };
  const simultaneas = await Promise.all([1, 2, 3, 4].map(() => intentar(ventas, 'crear_venta', datosNueva)));
  prueba(P, 'Cuatro crear_venta simultáneas con la misma clave: una sola venta', `true 1`, `${simultaneas.every((x) => x.ok)} ${new Set(simultaneas.map((x) => x.datos?.venta_id)).size}`);
  prueba(P, 'Una reserva que ya pertenece a otra venta no se puede volver a vender', 'ESTADO_INVALIDO', (await intentar(ventas, 'crear_venta', { ...datosNueva, clave_idempotencia: clave() })).codigo);
  if (simultaneas[0].ok) await ventas.llamar('anular_venta', { traza_id: traza, venta_id: simultaneas[0].datos.venta_id, motivo: 'prueba de concurrencia' });
  prueba(P, 'Consultar una venta con la traza de otra orden', 'NO_ENCONTRADO', (await intentar(ventas, 'consultar_venta', { traza_id: randomUUID(), venta_id: v.venta_id })).codigo);
  prueba(P, 'url_notificacion fuera del ecosistema', 'DATOS_INVALIDOS', (await intentar(ventas, 'crear_venta', { ...datos, clave_idempotencia: clave(), url_notificacion: 'http://169.254.169.254/x' })).codigo);
  const garantiaSinAut = { ...datos, clave_idempotencia: clave(), pagador: { tipo: 'concesionario', documento: '900765432-5', nombre: 'Sur Motor', retenedor: true, autorizacion: null }, lineas: [lineas(of, r)[1]] };
  prueba(P, 'Venta pagada por el concesionario sin autorización de garantía', 'DATOS_INVALIDOS', (await intentar(ventas, 'crear_venta', garantiaSinAut)).codigo);
  const otro = await reservar(4);
  prueba(P, 'Precio distinto al de la reserva', 'PRECIO_NO_COINCIDE', (await intentar(ventas, 'crear_venta', { ...datos, clave_idempotencia: clave(), lineas: lineas(otro.of, otro.r, otro.of.precio_unitario - 1) })).codigo);
  const lineaSinReserva = { ...lineas(of, r)[0], reserva_id: null };
  prueba(P, 'Repuesto sin reserva', 'DATOS_INVALIDOS', (await intentar(ventas, 'crear_venta', { ...datos, clave_idempotencia: clave(), lineas: [lineaSinReserva] })).codigo);
  prueba(P, 'Liquidación antes del pago', 'ESTADO_INVALIDO', (await intentar(ventas, 'consultar_liquidacion', { traza_id: traza, venta_id: v.venta_id })).codigo);
  await pagar(v.url_pago, 'aprobado');
  const liquidada = await esperar(async () => ((await ventas.llamar('consultar_venta', { traza_id: traza, venta_id: v.venta_id })).estado === 'liquidada' ? true : null));
  prueba(P, 'Después del pago aprobado la venta queda liquidada', true, liquidada);
  const confirmada = await tienda.llamar('consultar_reserva', { traza_id: traza, reserva_id: r.reserva_id });
  prueba(P, 'Ventas confirmó la reserva en la tienda', `confirmada ${v.venta_id}`, `${confirmada.estado} ${confirmada.venta_id}`);
  const liq = await ventas.llamar('consultar_liquidacion', { traza_id: traza, venta_id: v.venta_id });
  prueba(P, 'consultar_liquidacion cumple el contrato', true, ok(Liquidacion, liq));
  const deb = liq.asientos.reduce((s, a) => s + a.debito, 0), cre = liq.asientos.reduce((s, a) => s + a.credito, 0);
  prueba(P, 'Partida doble: débitos = créditos', deb, cre);
  prueba(P, 'Dispersiones + ingreso de la plataforma = recaudado', liq.recaudado, liq.dispersiones.reduce((s, d) => s + d.neto, 0) + liq.ingreso_plataforma);
  prueba(P, 'Recaudado = total a pagar de la venta', v.total_a_pagar, liq.recaudado);
  prueba(P, 'Generar cobro de una venta ya liquidada', 'ESTADO_INVALIDO', (await intentar(ventas, 'generar_cobro', { traza_id: traza, venta_id: v.venta_id })).codigo);
  const v2 = await ventas.llamar('crear_venta', { ...datos, clave_idempotencia: clave(), lineas: lineas(otro.of, otro.r) });
  const anulada = await ventas.llamar('anular_venta', { traza_id: traza, venta_id: v2.venta_id, motivo: 'el cliente desistió' });
  const liberada = await tienda.llamar('consultar_reserva', { traza_id: traza, reserva_id: otro.r.reserva_id });
  prueba(P, 'anular_venta anula y libera la reserva', 'anulada liberada', `${anulada.estado} ${liberada.estado}`);
  prueba(P, 'Consultar una venta que no existe', 'NO_ENCONTRADO', (await intentar(ventas, 'consultar_venta', { traza_id: traza, venta_id: 'V-NO-EXISTE' })).codigo);
  const evento = JSON.stringify({ evento_id: 'EVP-falso', tipo: 'cobro.aprobado', cobro_id: 'CB-X', referencia: v2.venta_id, monto: 1, fecha: new Date().toISOString() });
  const f = await fetch(`${URLS.ventas}/webhooks/pasarela`, { method: 'POST', headers: { 'X-Pasarela-Firma': firmarEvento(evento, 'otro-secreto') }, body: evento });
  prueba(P, 'Webhook de la pasarela con firma inválida', 401, f.status);
  await tienda.cerrar(); await ventas.cerrar();
}

async function tallerConformidad() {
  const P = 'reglas';
  const app = clienteDe('app', 'taller', ['taller.recepcion']);
  const k = clave();
  const ingreso = { clave_idempotencia: k, cliente: { documento: '1083456789', nombre: 'Ana Rojas', tipo: 'persona_natural', retenedor: false, correo: 'ana@correo.com' }, vehiculo: SPARK, sintomas: 'El carro tiembla y se apaga', codigos_dtc: ['P0302'] };
  const o = await app.llamar('registrar_ingreso', ingreso);
  prueba(P, 'registrar_ingreso cumple el contrato y queda recibida', 'true recibida', `${ok(Orden, o)} ${o.estado}`);
  prueba(P, 'La orden trae un traza_id UUID', true, z.uuid().safeParse(o.traza_id).success);
  prueba(P, 'Registrar otra vez con la misma clave devuelve la misma orden', o.orden_id, (await app.llamar('registrar_ingreso', ingreso)).orden_id);
  prueba(P, 'Cotizar sin diagnóstico', 'ESTADO_INVALIDO', (await intentar(app, 'cotizar', { orden_id: o.orden_id })).codigo);
  const d = await app.llamar('diagnosticar', { orden_id: o.orden_id });
  const cats = d.diagnostico.requerimientos.map((x) => x.categoria);
  prueba(P, 'P0302 en un Spark pide bujías y bobina', true, cats.includes('bujia') && cats.includes('bobina_encendido'));
  const c = await app.llamar('cotizar', { orden_id: o.orden_id });
  prueba(P, 'cotizar devuelve opciones y una recomendación entre ellas', true, c.opciones.length > 0 && c.opciones.some((x) => x.opcion_id === c.recomendacion?.opcion_id));
  for (const op of c.opciones) {
    const lineas = [...op.items, { cantidad: 1, precio_unitario: op.mano_obra.subtotal, iva_porcentaje: 19 }];
    const sub = lineas.reduce((s, l) => s + l.cantidad * l.precio_unitario, 0), iva = lineas.reduce((s, l) => s + ivaLinea(l), 0);
    prueba(P, `Opción ${op.nombre}: subtotal, IVA por línea y total`, `${sub} ${iva} ${sub + iva}`, `${op.subtotal} ${op.iva} ${op.total}`);
    prueba(P, `Opción ${op.nombre}: cubre todas las categorías del diagnóstico`, cats.sort().join(), op.items.map((x) => x.categoria).sort().join());
  }
  const rec = c.opciones.find((x) => x.opcion_id === c.recomendacion.opcion_id);
  const a = await app.llamar('aprobar_opcion', { orden_id: o.orden_id, opcion_id: rec.opcion_id, clave_idempotencia: clave() });
  prueba(P, 'aprobar_opcion deja la orden pendiente de pago con su venta', 'pendiente_pago true', `${a.estado} ${a.ventas.length > 0}`);
  prueba(P, 'La venta del cliente vale lo que dice la opción', rec.total, a.ventas.reduce((s, v) => s + v.total_a_pagar, 0));
  prueba(P, 'Aprobar otra opción con otra clave cuando ya está aprobada', 'ESTADO_INVALIDO', (await intentar(app, 'aprobar_opcion', { orden_id: o.orden_id, opcion_id: rec.opcion_id, clave_idempotencia: clave() })).codigo);
  for (const v of a.ventas) await pagar(v.url_pago, 'aprobado');
  const lista = await esperar(async () => ((await app.llamar('consultar_orden', { orden_id: o.orden_id })).estado === 'en_reparacion' ? true : null));
  prueba(P, 'Al recibir el evento venta.liquidada la orden pasa a en_reparacion', true, lista);
  const o2 = await app.llamar('registrar_ingreso', { ...ingreso, clave_idempotencia: clave() });
  await app.llamar('diagnosticar', { orden_id: o2.orden_id });
  const c2 = await app.llamar('cotizar', { orden_id: o2.orden_id });
  const tres = await Promise.all([1, 2, 3].map(() => intentar(app, 'aprobar_opcion', { orden_id: o2.orden_id, opcion_id: c2.recomendacion.opcion_id, clave_idempotencia: clave() })));
  const final2 = await app.llamar('consultar_orden', { orden_id: o2.orden_id });
  prueba(P, 'Tres aprobaciones simultáneas con claves distintas: una sola pasa', `1 ${final2.ventas.length === 1}`, `${tres.filter((x) => x.ok).length} true`);
  prueba(P, 'Consultar una orden que no existe', 'NO_ENCONTRADO', (await intentar(app, 'consultar_orden', { orden_id: 'OT-NO-EXISTE' })).codigo);
  const evento = JSON.stringify({ evento_id: 'EVV-falso', tipo: 'venta.liquidada', fecha: new Date().toISOString(), traza_id: o.traza_id, datos: {} });
  const f = await fetch(`${URLS.taller}/eventos`, { method: 'POST', headers: { 'X-Firma': firmarEvento(evento, 'otro-secreto') }, body: evento });
  prueba(P, 'Evento de ventas con firma inválida', 401, f.status);
  const f2 = await fetch(`${URLS.taller}/eventos`, { method: 'POST', headers: { 'X-Firma': firmarEvento(evento, FIRMA.ventas) }, body: evento });
  prueba(P, 'Evento de ventas con firma válida', 200, f2.status);
  await app.cerrar();
}

const reglas = { tienda: proveedor, concesionario: proveedor, ventas: ventasConformidad, taller: tallerConformidad }[grupo];
try {
  await reglas();
} catch (e) {
  prueba('reglas', 'Las pruebas de reglas de negocio se completan sin errores inesperados', 'completas', `detenidas: ${e.codigo ?? ''} ${e.message}`.slice(0, 160));
}

const todoBien = resumen(`CONFORMIDAD DE ${grupo.toUpperCase()}`);
mkdirSync(join(import.meta.dirname, '..', 'resultados'), { recursive: true });
const archivo = join(import.meta.dirname, '..', 'resultados', `conformidad-${grupo}.csv`);
writeFileSync(archivo, 'grupo;prueba;esperado;obtenido;resultado\n' + resultados.map((r) => [r.grupo, r.nombre, r.esperado, r.obtenido, r.ok ? 'OK' : 'FALLA'].map((x) => `"${String(x).replace(/"/g, "'")}"`).join(';')).join('\n') + '\n');
console.log(`Detalle en resultados/conformidad-${grupo}.csv`);
process.exit(todoBien ? 0 : 1);
