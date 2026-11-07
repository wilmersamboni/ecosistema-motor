// Reconstruye la historia de una orden en todo el ecosistema, consultando la bitácora de cada servicio
// por HTTP (GET /bitacora con el cliente "auditor"). Funciona aunque los servicios estén en otros equipos.
//   node pruebas/traza.mjs <traza_id>        (sin argumento: la última orden registrada en el taller)
import { PASARELA_LLAVE, URLS } from '../lib/config.mjs';
import { bitacoraDe } from './comun.mjs';

let traza = process.argv[2];
if (!traza) {
  const todo = await bitacoraDe('taller');
  traza = todo.filter((l) => l.herramienta === 'registrar_ingreso' && l.traza_id).at(-1)?.traza_id;
  if (!traza) { console.error('El taller no tiene órdenes registradas todavía.'); process.exit(1); }
}
const registros = [];
for (const servicio of ['taller', 'tienda', 'concesionario', 'ventas']) {
  try { registros.push(...(await bitacoraDe(servicio, traza))); } catch (e) { console.error(`(${servicio}: ${e.message})`); }
}
const ventas = [...new Set(registros.filter((l) => l.venta_id).map((l) => l.venta_id))];
if (ventas.length) {
  const r = await fetch(`${URLS.pasarela}/api/bitacora?referencias=${ventas.join(',')}`, { headers: { Authorization: `Bearer ${PASARELA_LLAVE}` } }).catch(() => null);
  if (r?.ok) registros.push(...(await r.json()).registros);
}
registros.sort((a, b) => a.ts.localeCompare(b.ts));
console.log(`Traza ${traza}: ${registros.length} registros en ${new Set(registros.map((l) => l.servicio)).size} servicios\n`);
for (const l of registros) {
  const quien = l.cliente ?? l.agente ?? '';
  const que = l.herramienta ? `${quien} → ${l.herramienta}${l.ok ? '' : ` ✗ ${l.error}`}` : l.evento ?? l.tipo;
  const extra = l.ms !== undefined ? ` (${l.ms} ms)` : l.monto ? ` $${l.monto.toLocaleString('es-CO')}` : '';
  console.log(`${l.ts.slice(11, 23)}  ${l.servicio.padEnd(14)} ${que}${extra}`);
}
