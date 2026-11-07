// Evaluación del agente de diagnóstico contra casos con respuesta conocida.
//   node pruebas/evaluar-diagnostico.mjs            usa el modelo del .env (LLM_URL, LLM_MODELO)
//   node pruebas/evaluar-diagnostico.mjs --reglas   línea base: solo reglas, sin modelo
//   --limite=90   segundos máximos por caso (por defecto 120); al vencer, el agente usa el plan B
//   --rag         recupera con RAG (pgvector, colección taller) y el modelo escribe el diagnóstico
//   --rag-guiado  recupera con RAG, el modelo solo elige la nota y el código arma el diagnóstico
// Mide: acierto exacto de categorías, revisión humana, latencia. La revisión se califica así:
//   bien    pidió revisión cuando debía, o no la pidió y acertó
//   de más  acertó pero pidió revisión (cuesta tiempo de un técnico, no es peligroso)
//   FALTÓ   se equivocó y no pidió revisión (peligroso: el error llega al cliente)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { diagnosticarConIA } from '../agentes/diagnostico.mjs';
import { modeloDesdeEntorno } from '../lib/agente.mjs';
import { diagnosticarPorReglas } from '../simuladores/taller.mjs';

const { casos } = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'datos', 'casos-diagnostico.json'), 'utf8'));
const soloReglas = process.argv.includes('--reglas');
const url = process.argv.find((a) => a.startsWith('--url='))?.slice(6);
const modelo = { ...modeloDesdeEntorno(), ...(url ? { url } : {}) };
const guiado = process.argv.includes('--rag-guiado');
const conRag = guiado || process.argv.includes('--rag');
const recuperador = conRag ? (await import('../lib/rag.mjs')).crearRecuperador({ coleccion: 'taller' }) : null;
const limiteMs = 1000 * Number(process.argv.find((a) => a.startsWith('--limite='))?.slice(9) || 120);
console.log(soloReglas ? 'Línea base: reglas del taller' : `Modelo ${modelo.modelo} en ${modelo.url}${conRag ? ` | recuperación con RAG ${guiado ? 'guiado' : 'libre'} (${process.env.EMB_MODELO || 'nomic-embed-text'})` : ' | recuperación por palabras clave'}`);
const filas = [];
const nombre = soloReglas ? 'evaluacion-diagnostico-reglas.csv' : `evaluacion-diagnostico-${modelo.modelo.replace(/[^\w.-]/g, '_')}${guiado ? '-rag-guiado' : conRag ? '-rag' : ''}.csv`;
// Se guarda después de cada caso: si el proceso se interrumpe, quedan los resultados parciales.
function guardar() {
  mkdirSync(join(import.meta.dirname, '..', 'resultados'), { recursive: true });
  writeFileSync(join(import.meta.dirname, '..', 'resultados', nombre), 'caso;acierto;revision;ms;fuente;obtenido;esperado;alertas\n' + filas.map((f) => [f.id, f.acierto, f.revision, f.ms, f.fuente, f.obtenido, f.esperado, f.alertas].join(';')).join('\n') + '\n');
}
for (const c of casos) {
  const inicio = Date.now();
  const r = soloReglas ? { diagnostico: diagnosticarPorReglas(c), fuente: 'reglas', alertas: [] } : await diagnosticarConIA(c, { modelo, limiteMs, recuperador, estrategia: guiado ? 'guiada' : 'libre' });
  const ms = Date.now() - inicio;
  const obtenido = [...new Set(r.diagnostico.requerimientos.map((q) => q.categoria))].sort();
  const acierto = obtenido.join() === [...c.esperado].sort().join();
  const pidio = r.diagnostico.requiere_revision_humana;
  const revision = (acierto && pidio === c.revision) || (!acierto && pidio) ? 'bien' : acierto && pidio ? 'de más' : 'FALTÓ';
  const plan = r.fuente !== 'ia' && !soloReglas ? `  (plan B: ${/no respondió|tiempo/.test(r.alertas.join()) ? 'tiempo agotado' : r.fuente === 'rag' ? 'nota más parecida' : 'reglas'})` : '';
  filas.push({ id: c.id, acierto, revision, ms, fuente: r.fuente, obtenido: obtenido.join(' '), esperado: c.esperado.join(' '), pidio, alertas: r.alertas.join(' | ') });
  console.log(`${c.id} ${acierto ? 'ACIERTO' : 'ERROR  '} revisión ${revision.padEnd(6)} ${String(ms).padStart(6)} ms  [${obtenido.join(', ')}]  esperado [${c.esperado.join(', ')}]${plan}`);
  guardar();
  if (conRag && r.fuentes?.length) console.log(`    fuentes: ${[...new Set(r.fuentes.map((f) => f.split(' > ')[0]))].join(', ')}`);
  if (r.alertas.length && !soloReglas) console.log(`    alertas: ${r.alertas.join(' | ').slice(0, 220)}`);
}
const n = filas.length;
const pct = (x) => `${Math.round((100 * x) / n)}%`;
const lat = filas.map((f) => f.ms).sort((a, b) => a - b);
const cuenta = (f) => filas.filter(f).length;
console.log(`\nAcierto de categorías: ${pct(cuenta((f) => f.acierto))} (${cuenta((f) => f.acierto)} de ${n}) | Revisión: ${cuenta((f) => f.revision === 'bien')} bien, ${cuenta((f) => f.revision === 'de más')} de más, ${cuenta((f) => f.revision === 'FALTÓ')} FALTÓ (peligrosos) | Plan B: ${cuenta((f) => f.fuente !== 'ia' && !soloReglas)} | Latencia p50 ${lat[Math.floor(n / 2)]} ms, máxima ${lat.at(-1)} ms`);
console.log(`Detalle en resultados/${nombre}`);
await recuperador?.cerrar();
