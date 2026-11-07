// Evaluación de la RECUPERACIÓN del RAG (sin modelo de lenguaje): ¿la nota correcta sale arriba?
//   node pruebas/evaluar-rag.mjs                 colecciones taller y garantia, los tres modos
//   node pruebas/evaluar-rag.mjs --modo=hibrido   solo un modo
// Métricas por modo (vector, texto, híbrido):
//   acierto@1  la primera nota es una de las esperadas
//   acierto@3  una de las esperadas está entre las tres primeras notas distintas
//   MRR        promedio de 1/posición de la primera nota esperada (1 = siempre primera, 0 = nunca sale)
// Requiere haber indexado: node rag/indexar.mjs   y   node rag/indexar.mjs --boveda=conocimiento/garantia --coleccion=garantia
import '../lib/config.mjs'; // carga .env
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { consultaDeOrden, filtroDeOrden } from '../agentes/diagnostico.mjs';
import { buscar, configDesdeEntorno, crearPool } from '../lib/rag.mjs';

const RAIZ = join(import.meta.dirname, '..');
// --casos=ruta/archivo.json evalúa otro archivo de casos (por ejemplo, los de la colección de un grupo).
const casosArg = process.argv.find((a) => a.startsWith('--casos='))?.slice(8);
const casosRag = JSON.parse(readFileSync(casosArg ? join(RAIZ, casosArg) : join(RAIZ, 'datos', 'casos-rag.json'), 'utf8'));
const sufijoCasos = casosArg ? '-' + casosArg.split(/[\\/]/).pop().replace(/\.json$/, '') : '';
const { casos: casosDiag } = JSON.parse(readFileSync(join(RAIZ, 'datos', 'casos-diagnostico.json'), 'utf8'));
const modoArg = process.argv.find((a) => a.startsWith('--modo='))?.slice(7);
const modos = modoArg ? [modoArg] : ['vector', 'texto', 'hibrido'];
const { db, emb } = configDesdeEntorno();
const pool = crearPool(db);
console.log(`Evaluación de la recuperación con ${emb.modelo} (${emb.url})`);

const preguntas = [];
for (const [coleccion, lista] of Object.entries(casosRag)) {
  if (!Array.isArray(lista)) continue;
  for (const c of lista) {
    // Los casos de diagnóstico se consultan igual que lo hace el agente: con su consulta y su filtro.
    const orden = c.caso ? casosDiag.find((x) => x.id === c.caso) : null;
    preguntas.push({ id: c.caso ?? c.id, coleccion, consulta: orden ? consultaDeOrden(orden) : c.consulta, filtro: orden ? filtroDeOrden(orden) : {}, esperadas: c.esperadas });
  }
}

const filas = [];
const resumen = {};
let fallo = null;
try {
  for (const modo of modos) {
    let a1 = 0, a3 = 0, rr = 0;
    const lat = [];
    for (const p of preguntas) {
      const inicio = Date.now();
      const r = await buscar(pool, emb, p.consulta, { coleccion: p.coleccion, k: 8, modo, porNota: 1, filtro: p.filtro });
      lat.push(Date.now() - inicio);
      const notas = r.map((x) => x.titulo);
      const pos = notas.findIndex((t) => p.esperadas.includes(t)) + 1;
      if (pos === 1) a1++;
      if (pos >= 1 && pos <= 3) a3++;
      if (pos) rr += 1 / pos;
      filas.push({ modo, id: p.id, coleccion: p.coleccion, posicion: pos || '-', primera: notas[0] ?? '(nada)', esperadas: p.esperadas.join(' / ') });
    }
    const n = preguntas.length;
    lat.sort((x, y) => x - y);
    resumen[modo] = { a1: a1 / n, a3: a3 / n, mrr: rr / n, p50: lat[Math.floor(n / 2)] };
  }
} catch (e) {
  fallo = e;
} finally {
  await pool.end();
}
if (fallo) {
  console.error(`ERROR ${fallo.codigo ?? ''}: ${fallo.message}`);
  process.exit(1);
}

const pct = (x) => `${Math.round(100 * x)}%`.padStart(5);
console.log(`\n${'Caso'.padEnd(5)} ${'Colección'.padEnd(9)} ${modos.map((m) => m.padEnd(8)).join(' ')}  Esperada`);
for (const p of preguntas) {
  const pos = modos.map((m) => String(filas.find((f) => f.modo === m && f.id === p.id && f.coleccion === p.coleccion).posicion).padEnd(8));
  console.log(`${p.id.padEnd(5)} ${p.coleccion.padEnd(9)} ${pos.join(' ')}  ${p.esperadas[0]}`);
}
console.log('\n(la tabla muestra en qué posición salió la primera nota esperada; "-" = no salió entre las 8 primeras)\n');
console.log(`Modo      acierto@1  acierto@3   MRR    p50 ms   (${preguntas.length} consultas)`);
for (const [m, r] of Object.entries(resumen)) console.log(`${m.padEnd(9)} ${pct(r.a1)}      ${pct(r.a3)}     ${r.mrr.toFixed(2)}   ${String(r.p50).padStart(5)}`);
mkdirSync(join(RAIZ, 'resultados'), { recursive: true });
const nombre = `evaluacion-rag-${emb.modelo.replace(/[^\w.-]/g, '_')}${sufijoCasos}.csv`;
writeFileSync(join(RAIZ, 'resultados', nombre), 'modo;caso;coleccion;posicion;primera;esperadas\n' + filas.map((f) => [f.modo, f.id, f.coleccion, f.posicion, f.primera, f.esperadas].join(';')).join('\n') + '\n');
console.log(`\nDetalle en resultados/${nombre}`);
