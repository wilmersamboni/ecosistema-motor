// Prueba de carga ligera: N órdenes completas (ingreso → diagnóstico → cotización → aprobación → pago →
// liquidación) con varias en paralelo. Mide latencias por paso, errores y órdenes por minuto.
//   node pruebas/carga.mjs [ordenes=20] [paralelo=5]
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { URLS } from '../lib/config.mjs';
import { asegurarEcosistema, clienteDe, esperar, pagar, sandbox } from './comun.mjs';

const [N = 20, PARALELO = 5] = process.argv.slice(2).map(Number);
await asegurarEcosistema();
for (const p of ['tienda', 'concesionario']) {
  const r = await sandbox(p, 'reabastecer', { minimo: 1000 }).catch(() => ({ status: 0 }));
  if (r.status !== 200) console.log(`(aviso: ${p} no aceptó /sandbox/reabastecer; con poco stock habrá órdenes con STOCK_INSUFICIENTE)`);
}
const CASOS = [
  { vehiculo: { placa: 'CAR001', marca: 'Chevrolet', linea: 'Spark GT', modelo_anio: 2016, motor: '1.2L gasolina', kilometraje: 120000 }, sintomas: 'Tiembla y se apaga', codigos_dtc: ['P0302'] },
  { vehiculo: { placa: 'CAR002', marca: 'Mazda', linea: '2', modelo_anio: 2019, motor: '1.5L gasolina', kilometraje: 74000 }, sintomas: 'Chillido al frenar', codigos_dtc: [] },
  { vehiculo: { placa: 'CAR003', marca: 'Toyota', linea: 'Hilux', modelo_anio: 2021, motor: '2.4L diesel', kilometraje: 65000 }, sintomas: 'Mantenimiento de 65.000 km', codigos_dtc: [] },
];
const tiempos = {};
const medir = async (paso, fn) => {
  const t = performance.now();
  try { return await fn(); } finally { (tiempos[paso] ??= []).push(performance.now() - t); }
};
let completas = 0;
const errores = [];
async function unaOrden(i) {
  const taller = clienteDe('app', 'taller', ['taller.recepcion']);
  try {
    const caso = CASOS[i % CASOS.length];
    const o = await medir('registrar_ingreso', () => taller.llamar('registrar_ingreso', { clave_idempotencia: randomUUID(), cliente: { documento: String(10_000_000 + i), nombre: `Cliente ${i}`, tipo: 'persona_natural', retenedor: false, correo: `c${i}@correo.com` }, ...caso }));
    await medir('diagnosticar', () => taller.llamar('diagnosticar', { orden_id: o.orden_id }));
    const c = await medir('cotizar', () => taller.llamar('cotizar', { orden_id: o.orden_id }));
    const a = await medir('aprobar_opcion', () => taller.llamar('aprobar_opcion', { orden_id: o.orden_id, opcion_id: c.recomendacion.opcion_id, clave_idempotencia: randomUUID() }));
    await medir('pago_hasta_liquidacion', async () => {
      for (const v of a.ventas) await pagar(v.url_pago, 'aprobado');
      if (!(await esperar(async () => ((await taller.llamar('consultar_orden', { orden_id: o.orden_id })).estado === 'en_reparacion' ? true : null), 20_000))) throw new Error(`${o.orden_id} no llegó a en_reparacion`);
    });
    completas++;
  } catch (e) {
    errores.push(`${i}: ${e.codigo ?? ''} ${e.message}`);
  } finally {
    await taller.cerrar();
  }
}
const inicio = performance.now();
let siguiente = 0;
await Promise.all(Array.from({ length: PARALELO }, async () => { while (siguiente < N) await unaOrden(siguiente++); }));
const total = (performance.now() - inicio) / 1000;
const pct = (arr, p) => Math.round([...arr].sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * p))]);
console.log(`\n${N} órdenes, ${PARALELO} en paralelo: ${completas} completas, ${errores.length} con error, ${total.toFixed(1)} s, ${(completas / total * 60).toFixed(0)} órdenes por minuto\n`);
console.log('Paso'.padEnd(26) + 'p50 ms'.padStart(8) + 'p95 ms'.padStart(8) + 'máx ms'.padStart(8));
const filas = Object.entries(tiempos).map(([paso, t]) => [paso, pct(t, 0.5), pct(t, 0.95), Math.round(Math.max(...t))]);
for (const f of filas) console.log(f[0].padEnd(26) + String(f[1]).padStart(8) + String(f[2]).padStart(8) + String(f[3]).padStart(8));
for (const e of errores.slice(0, 5)) console.log('ERROR', e);
mkdirSync(join(import.meta.dirname, '..', 'resultados'), { recursive: true });
writeFileSync(join(import.meta.dirname, '..', 'resultados', 'carga.csv'), 'paso;p50_ms;p95_ms;max_ms\n' + filas.map((f) => f.join(';')).join('\n') + `\n\nordenes;${N}\nparalelo;${PARALELO}\ncompletas;${completas}\nerrores;${errores.length}\nsegundos;${total.toFixed(1)}\n`);
process.exit(errores.length ? 1 : 0);
