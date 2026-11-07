// Utilidades de las pruebas: registro de resultados, clientes de la "app" y del laboratorio, pagos.
import { ClienteServicio } from '../lib/cliente.mjs';
import { ErrorNegocio } from '../lib/errores.mjs';
import { PASARELA_LLAVE, PUERTOS, URLS, credencial } from '../lib/config.mjs';

// Rutas de laboratorio de los proveedores (requieren SANDBOX=1 en el servicio).
export const SANDBOX_LLAVE = process.env.SANDBOX_LLAVE || 'lab-sandbox';
export const sandbox = (proveedor, ruta, cuerpo) =>
  fetch(`${URLS[proveedor]}/sandbox/${ruta}`, { method: 'POST', headers: { 'X-Sandbox-Llave': SANDBOX_LLAVE, 'Content-Type': 'application/json' }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });

// Bitácora de un servicio por HTTP, con el cliente "auditor" (alcance auditoria).
const tokens = {};
export async function bitacoraDe(servicio, traza_id) {
  if (!tokens[servicio] || tokens[servicio].vence < Date.now()) {
    const r = await fetch(`${URLS[servicio]}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'client_credentials', client_id: 'auditor', client_secret: credencial('auditor', servicio) }) });
    if (!r.ok) throw new Error(`${servicio} no entregó token de auditoría (HTTP ${r.status})`);
    tokens[servicio] = { token: (await r.json()).access_token, vence: Date.now() + 50 * 60_000 };
  }
  const r = await fetch(`${URLS[servicio]}/bitacora${traza_id ? `?traza_id=${traza_id}` : ''}`, { headers: { Authorization: `Bearer ${tokens[servicio].token}` } });
  if (!r.ok) throw new Error(`${servicio} no entregó la bitácora (HTTP ${r.status})`);
  return (await r.json()).registros;
}

export const resultados = [];
// Corre un bloque de pruebas; si lanza una excepción, la registra como FALLA y sigue con el siguiente.
export async function bloque(grupo, fn) {
  try {
    await fn();
  } catch (e) {
    prueba(grupo, 'El escenario se completa sin errores inesperados', 'completo', `detenido: ${e.codigo ?? ''} ${e.message}`.slice(0, 160));
  }
}
export function prueba(grupo, nombre, esperado, obtenido, detalle = '') {
  const ok = String(esperado) === String(obtenido);
  resultados.push({ grupo, nombre, esperado, obtenido, ok, detalle });
  console.log(`${ok ? 'OK   ' : 'FALLA'} ${grupo.padEnd(12)} ${nombre.padEnd(70)} esperado ${String(esperado).padEnd(8)} obtenido ${obtenido}${ok || !detalle ? '' : '  ' + detalle}`);
  return ok;
}
export const pausa = (ms) => new Promise((r) => setTimeout(r, ms));

// Cliente con las credenciales de <cliente> en el servidor <destino>, según el contrato.
export const clienteDe = (cliente, destino, alcances) =>
  new ClienteServicio({ destino, url: URLS[destino], clientId: cliente, clientSecret: credencial(cliente, destino), alcances });

// Llama y devuelve { ok, datos } o { ok: false, codigo, mensaje } sin lanzar.
export async function intentar(c, herramienta, args) {
  try {
    return { ok: true, datos: await c.llamar(herramienta, args, { reintentos: 0 }) };
  } catch (e) {
    return { ok: false, codigo: e instanceof ErrorNegocio ? e.codigo : 'EXCEPCION', mensaje: e.message };
  }
}

export async function pagar(url_pago, resultado) {
  const cobro = url_pago.split('/').pop();
  const r = await fetch(`${URLS.pasarela}/api/cobros/${cobro}/simular`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${PASARELA_LLAVE}` }, body: JSON.stringify({ resultado }),
  });
  return r.status;
}

export async function cobro(url_pago) {
  const r = await fetch(`${URLS.pasarela}/api/cobros/${url_pago.split('/').pop()}`, { headers: { Authorization: `Bearer ${PASARELA_LLAVE}` } });
  return r.json();
}

export async function esperar(fn, ms = 8000) {
  const fin = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > fin) return v;
    await pausa(150);
  }
}

// Si los servicios no están corriendo, inicia los simuladores que falten en este mismo proceso.
export async function asegurarEcosistema() {
  for (const nombre of ['pasarela', 'tienda', 'concesionario', 'ventas', 'taller']) {
    const vivo = await fetch(`${URLS[nombre]}/salud`, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok).catch(() => false);
    if (vivo) continue;
    if (!URLS[nombre].endsWith(`:${PUERTOS[nombre]}`) || !URLS[nombre].includes('localhost')) throw new Error(`${nombre} no responde en ${URLS[nombre]}`);
    const { iniciar } = await import(`../simuladores/${nombre}.mjs`);
    await iniciar(PUERTOS[nombre]);
    console.log(`(simulador de ${nombre} iniciado en ${URLS[nombre]})`);
  }
}

export function resumen(titulo) {
  const bien = resultados.filter((r) => r.ok).length;
  console.log(`\n${titulo}: ${bien} de ${resultados.length} pruebas correctas`);
  for (const r of resultados.filter((x) => !x.ok)) console.log(`  FALLA ${r.grupo} - ${r.nombre}: esperado ${r.esperado}, obtenido ${r.obtenido} ${r.detalle}`);
  return bien === resultados.length;
}
