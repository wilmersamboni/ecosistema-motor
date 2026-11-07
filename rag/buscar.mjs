// Busca en la base de conocimiento y muestra de dónde sale cada resultado.
//   node rag/buscar.mjs "el carro cojea y pierde fuerza"
//   node rag/buscar.mjs "P0420" --modo=texto        (también --modo=vector o --modo=hibrido)
//   node rag/buscar.mjs "garantía de la bobina" --coleccion=garantia --k=3
//   node rag/buscar.mjs "chillido" --tipo=falla     (filtra por la propiedad "tipo" de la nota)
import '../lib/config.mjs'; // carga .env
import { buscar, configDesdeEntorno, crearPool } from '../lib/rag.mjs';

const arg = (n, d) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;
const consulta = process.argv.slice(2).filter((a) => !a.startsWith('--')).join(' ');
if (!consulta) { console.log('Uso: node rag/buscar.mjs "consulta" [--modo=hibrido|vector|texto] [--coleccion=taller] [--k=4] [--tipo=falla]'); process.exit(1); }
const { db, emb } = configDesdeEntorno();
const pool = crearPool(db);
try {
  const filtro = arg('tipo') ? { tipo: arg('tipo').split(',') } : {};
  const modo = arg('modo', 'hibrido');
  const inicio = Date.now();
  const r = await buscar(pool, emb, consulta, { coleccion: arg('coleccion', 'taller'), k: Number(arg('k', 4)), modo, filtro });
  console.log(`Consulta: "${consulta}" | modo ${modo} | ${r.length} resultados en ${Date.now() - inicio} ms\n`);
  for (const [i, x] of r.entries()) {
    const sim = x.similitud === null ? '   -  ' : x.similitud.toFixed(3);
    console.log(`${i + 1}. ${x.titulo} > ${x.seccion}   puntaje ${x.puntaje.toFixed(4)} | similitud ${sim} | posición vector ${x.pos_vector ?? '-'}, texto ${x.pos_texto ?? '-'}`);
    console.log(`   ${x.contenido.split('\n').slice(1).join(' ').slice(0, 160)}…\n`);
  }
} catch (e) {
  console.error(`ERROR ${e.codigo ?? ''}: ${e.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
