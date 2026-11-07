// Indexa una bóveda de Obsidian en PostgreSQL + pgvector.
//   node rag/indexar.mjs                                   bóveda conocimiento/taller, colección taller
//   node rag/indexar.mjs --boveda=conocimiento/garantia --coleccion=garantia
//   node rag/indexar.mjs --reiniciar                       borra la colección y la vuelve a crear
//   node rag/indexar.mjs --reiniciar-todo                  borra las tablas del RAG (cambio de modelo)
// Configuración (.env): RAG_DB_URL, EMB_URL, EMB_LLAVE, EMB_MODELO.
import { resolve } from 'node:path';
import '../lib/config.mjs'; // carga .env
import { configDesdeEntorno, crearPool, indexar, reiniciarTodo } from '../lib/rag.mjs';

const arg = (n, d) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;
const carpeta = resolve(arg('boveda', 'conocimiento/taller'));
const coleccion = arg('coleccion', 'taller');
const { db, emb } = configDesdeEntorno();
const pool = crearPool(db);
const inicio = Date.now();
try {
  if (process.argv.includes('--reiniciar-todo')) { await reiniciarTodo(pool); console.log('Tablas del RAG borradas.'); }
  console.log(`Indexando ${carpeta} en la colección "${coleccion}" con ${emb.modelo} (${emb.url})`);
  const r = await indexar(pool, emb, {
    carpeta, coleccion, reiniciar: process.argv.includes('--reiniciar'),
    alProgresar: (p) => console.log(`  ${p.accion.padEnd(11)} ${p.nota}${p.fragmentos ? ` (${p.fragmentos} fragmentos)` : ''}`),
  });
  console.log(`\nNotas: ${r.notas} | nuevas ${r.nuevas}, actualizadas ${r.actualizadas}, sin cambios ${r.sin_cambios}, eliminadas ${r.eliminadas} | ` +
    `fragmentos en la colección: ${r.total_fragmentos} | vectores de ${r.dimension} dimensiones | ${((Date.now() - inicio) / 1000).toFixed(1)} s`);
} catch (e) {
  console.error(`ERROR ${e.codigo ?? ''}: ${e.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
