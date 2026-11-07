// Pruebas automáticas del RAG: base, troceo, indexación incremental, búsqueda, errores, concurrencia,
// seguridad e integración con el agente de diagnóstico. Usa embeddings SIMULADOS y un modelo de lenguaje
// SIMULADO (no necesita Ollama) y trabaja en su propio esquema de PostgreSQL ("rag_pruebas"), que borra
// al final: no toca las colecciones que usted haya indexado.
//   node pruebas/rag.mjs            (con la base arriba: docker compose -f rag/docker-compose.yml up -d)
import '../lib/config.mjs'; // carga .env
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diagnosticarConIA } from '../agentes/diagnostico.mjs';
import { buscar, configDesdeEntorno, crearPool, crearRecuperador, indexar, leerBoveda, migrar, trocear } from '../lib/rag.mjs';
import { prueba, resumen } from './comun.mjs';
import { crearEmbeddingsSimulados, vectorSimulado } from './embeddings-simulados.mjs';
import { crearModeloSimulado } from './modelo-simulado.mjs';

const G = 'rag';
const ESQUEMA = 'rag_pruebas';
const RAIZ = join(import.meta.dirname, '..');
const { db } = configDesdeEntorno();
// Cuántas notas tiene la bóveda (sin .obsidian ni _plantillas): así las pruebas no se rompen al agregar notas.
const N = readdirSync(join(RAIZ, 'conocimiento', 'taller'), { recursive: true })
  .filter((r) => r.endsWith('.md') && !r.split(/[\\/]/).some((p) => p.startsWith('.') || p.startsWith('_'))).length;
const emb = { url: 'http://localhost:4186/v1', llave: 'x', modelo: 'simulado-256', prefijoDocumento: '', prefijoConsulta: '' };
const intentar = async (fn) => { try { return { ok: true, valor: await fn() } } catch (e) { return { ok: false, codigo: e.codigo ?? 'EXCEPCION', mensaje: e.message }; } };

// ---------- preparación
const admin = crearPool(db);
const conexion = await intentar(() => admin.query('SELECT 1'));
if (!conexion.ok) {
  console.error(`No hay conexión con la base del RAG (${db.replace(/\/\/([^:]+):[^@]+@/, '//$1:***@')}): ${conexion.mensaje}\n` +
    'Levántela con:  docker compose -f rag/docker-compose.yml up -d   y revise RAG_DB_URL en .env');
  process.exit(1);
}
await admin.query(`DROP SCHEMA IF EXISTS ${ESQUEMA} CASCADE`);
await admin.query(`CREATE SCHEMA ${ESQUEMA}`);
const simulados = crearEmbeddingsSimulados();
await new Promise((r) => simulados.servidor.listen(4186, r));
const llm = crearModeloSimulado();
await new Promise((r) => llm.servidor.listen(4187, r));
const pool = crearPool(db, { esquema: ESQUEMA });
const temporal = mkdtempSync(join(tmpdir(), 'boveda-'));

try {
  // ---------- 1. base y migración
  const ext = await pool.query("SELECT extversion FROM pg_extension WHERE extname = 'vector'");
  const extension = ext.rows[0]?.extversion ?? (await intentar(() => pool.query('CREATE EXTENSION IF NOT EXISTS vector'))).ok;
  prueba(G, 'La base tiene la extensión pgvector', true, Boolean(extension));
  const m1 = await intentar(() => migrar(pool, 256));
  const m2 = await intentar(() => migrar(pool, 256));
  prueba(G, 'La migración crea las tablas y se puede repetir', 'true true', `${m1.ok} ${m2.ok}`);
  const indices = (await pool.query(`SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = 'rag_fragmentos'`, [ESQUEMA])).rows.map((r) => r.indexdef).join(' ');
  prueba(G, 'Índices HNSW (coseno) para vectores y GIN para texto', 'true true', `${/hnsw.*vector_cosine_ops/.test(indices)} ${/gin/.test(indices)}`);

  // ---------- 2. lectura de la bóveda y troceo
  const notas = leerBoveda(join(RAIZ, 'conocimiento', 'taller'));
  prueba(G, 'Lee las notas de la bóveda y omite la carpeta _plantillas', `${N} false`, `${notas.length} ${notas.some((n) => n.ruta.startsWith('_'))}`);
  const encendido = notas.find((n) => n.titulo === 'Falla de encendido');
  prueba(G, 'Lee las propiedades de la nota (códigos, categorías, horas)', 'P0302 bobina_encendido 1.5',
    `${encendido.propiedades.codigos_dtc.includes('P0302') ? 'P0302' : '-'} ${encendido.propiedades.categorias.at(-1)} ${encendido.propiedades.horas}`);
  const fr = notas.flatMap(trocear);
  prueba(G, 'Ningún fragmento conserva la sintaxis [[enlace]] de Obsidian', 0, fr.filter((f) => f.contenido.includes('[[')).length);
  prueba(G, 'Cada fragmento lleva encabezado "Nota > Sección" y no pasa de 1.200 caracteres de texto', true,
    fr.every((f) => / > /.test(f.contenido.split('\n')[0]) && f.contenido.split('\n').filter((l, i) => i > 0 && !/^(Sistema|Códigos|Repuestos):/.test(l)).join('\n').length <= 1200));
  const larga = { titulo: 'Larga', propiedades: {}, cuerpo: `## Sección\n${Array.from({ length: 30 }, (_, i) => `Párrafo ${i} ${'texto de relleno '.repeat(8)}`).join('\n\n')}` };
  const partes = trocear(larga);
  prueba(G, 'Una sección larga se parte en varios fragmentos con solapamiento', 'true true',
    `${partes.length > 1} ${partes[1]?.contenido.split('\n')[1] === partes[0]?.contenido.split('\n').at(-1)}`);

  // ---------- 3. indexación incremental
  cpSync(join(RAIZ, 'conocimiento', 'taller'), temporal, { recursive: true });
  const r1 = await indexar(pool, emb, { carpeta: temporal, coleccion: 'taller' });
  prueba(G, `Primera indexación: ${N} notas nuevas`, `${N} 0`, `${r1.nuevas} ${r1.sin_cambios}`);
  const antes = simulados.peticiones();
  const r2 = await indexar(pool, emb, { carpeta: temporal, coleccion: 'taller' });
  prueba(G, 'Reindexar sin cambios no recalcula embeddings', `0 ${N} 1`, `${r2.nuevas + r2.actualizadas} ${r2.sin_cambios} ${simulados.peticiones() - antes}`);
  const ruta = join(temporal, 'Fallas', 'Embrague.md');
  writeFileSync(ruta, readFileSync(ruta, 'utf8').replace('5 horas.', '6 horas, por el volante bimasa.'));
  unlinkSync(join(temporal, 'Fallas', 'Alternador.md'));
  writeFileSync(join(temporal, 'Fallas', 'Radiador.md'), '---\ntipo: falla\nsistema: refrigeración\nmotor: todos\ncategorias: []\n---\n# Radiador\n\n## Síntomas\nEl radiador tiene fugas por el panal oxidado y el ventilador no prende.\n');
  const r3 = await indexar(pool, emb, { carpeta: temporal, coleccion: 'taller' });
  prueba(G, 'Una nota cambiada, una borrada y una nueva: solo eso se procesa', `1 1 1 ${N - 2}`, `${r3.actualizadas} ${r3.eliminadas} ${r3.nuevas} ${r3.sin_cambios}`);
  const radiador = await buscar(pool, emb, 'fugas en el panal del radiador', { coleccion: 'taller', k: 1 });
  prueba(G, 'La nota nueva se encuentra de inmediato', 'Radiador', radiador[0]?.titulo);
  const alternador = await pool.query("SELECT count(*) FROM rag_documentos WHERE titulo = 'Alternador'");
  prueba(G, 'La nota borrada ya no está en la base (ni sus fragmentos)', 0, Number(alternador.rows[0].count));

  // ---------- 4. búsqueda
  const p0420 = await buscar(pool, emb, 'P0420', { coleccion: 'taller', modo: 'texto', k: 1 });
  prueba(G, 'Búsqueda de texto: el código P0420 lleva a Catalizador', 'Catalizador', p0420[0]?.titulo);
  const c01 = await buscar(pool, emb, 'Tiembla en ralentí y a veces se apaga. Códigos: P0302', { coleccion: 'taller', k: 1 });
  prueba(G, 'Búsqueda híbrida: síntomas de C01 llevan a Falla de encendido', 'Falla de encendido', c01[0]?.titulo);
  prueba(G, 'El resultado trae puntaje, similitud y posición en cada lista', 'true true true', `${c01[0]?.puntaje > 0} ${c01[0]?.similitud !== null} ${c01[0]?.pos_texto !== null}`);
  const politicas = await buscar(pool, emb, 'garantía de la mano de obra', { coleccion: 'taller', filtro: { tipo: ['politica'] } });
  prueba(G, 'Filtro por propiedades: tipo=politica solo trae políticas', 'true', String(politicas.length > 0 && politicas.every((x) => x.propiedades.tipo === 'politica')));
  const varios = await buscar(pool, emb, 'falla de encendido bobina bujías cilindro', { coleccion: 'taller', k: 6, porNota: 2 });
  const porNota = Math.max(...Object.values(varios.reduce((a, x) => ({ ...a, [x.titulo]: (a[x.titulo] ?? 0) + 1 }), {})));
  prueba(G, 'Máximo dos fragmentos por nota en los resultados', true, porNota <= 2);
  const inexistente = await intentar(() => buscar(pool, emb, 'hola', { coleccion: 'no_existe' }));
  prueba(G, 'Colección que no existe: error claro', 'COLECCION_NO_EXISTE', inexistente.codigo);
  const vacia = await intentar(() => buscar(pool, emb, '   ', { coleccion: 'taller' }));
  prueba(G, 'Consulta vacía: error claro', 'CONSULTA_VACIA', vacia.codigo);

  // ---------- 5. modelos de embeddings
  const otroModelo = await intentar(() => indexar(pool, { ...emb, modelo: 'simulado-b-256' }, { carpeta: temporal, coleccion: 'taller' }));
  prueba(G, 'Indexar con otro modelo de la misma dimensión: se rechaza', 'MODELO_DISTINTO', otroModelo.codigo);
  const otraDim = await intentar(() => indexar(pool, { ...emb, modelo: 'simulado-128' }, { carpeta: temporal, coleccion: 'taller' }));
  prueba(G, 'Indexar con un modelo de otra dimensión: se rechaza', 'DIMENSION_DISTINTA', otraDim.codigo);
  const buscaOtro = await intentar(() => buscar(pool, { ...emb, modelo: 'simulado-b-256' }, 'frenos', { coleccion: 'taller' }));
  prueba(G, 'Buscar con un modelo distinto al de la colección: se rechaza', 'MODELO_DISTINTO', buscaOtro.codigo);
  const sinModelo = await intentar(() => indexar(pool, { ...emb, modelo: 'nomic-embed-text' }, { carpeta: temporal, coleccion: 'otra' }));
  prueba(G, 'Modelo no descargado: el error dice cómo descargarlo', 'EMBEDDINGS_ERROR true', `${sinModelo.codigo} ${/ollama pull/.test(sinModelo.mensaje)}`);
  writeFileSync(ruta, readFileSync(ruta, 'utf8').replace('6 horas', '7 horas'));
  // Un modelo que responde la primera petición y después falla: la falla ocurre a mitad de la indexación.
  let llamadas = 0;
  const inestable = createServer((req, res) => {
    let b = '';
    req.on('data', (x) => (b += x));
    req.on('end', () => {
      if (llamadas++ > 0) { res.writeHead(500); return res.end('{"error":"modelo caído"}'); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [JSON.parse(b).input].flat().map((t, index) => ({ index, embedding: vectorSimulado(t, 256) })) }));
    });
  });
  await new Promise((r) => inestable.listen(4188, r));
  const caido = await intentar(() => indexar(pool, { ...emb, url: 'http://localhost:4188/v1' }, { carpeta: temporal, coleccion: 'taller' }));
  inestable.close();
  const manoObra = async () => (await pool.query("SELECT contenido FROM rag_fragmentos f JOIN rag_documentos d ON d.id = f.documento_id WHERE d.titulo = 'Embrague' AND f.seccion = 'Mano de obra'")).rows[0]?.contenido ?? '';
  prueba(G, 'Si el modelo de embeddings falla, la base queda como estaba (versión anterior de la nota)', 'EMBEDDINGS_ERROR true', `${caido.codigo} ${/6 horas/.test(await manoObra())}`);
  const reintento = await indexar(pool, emb, { carpeta: temporal, coleccion: 'taller' });
  prueba(G, 'Al volver el modelo, se indexa lo pendiente', '1 true', `${reintento.actualizadas} ${/7 horas/.test(await manoObra())}`);

  // ---------- 6. seguridad y concurrencia
  const inyeccion = await intentar(() => buscar(pool, emb, "'; DROP TABLE rag_fragmentos; --", { coleccion: 'taller' }));
  const sigue = await pool.query('SELECT count(*) FROM rag_fragmentos');
  prueba(G, 'Inyección SQL en la consulta: no pasa nada (consultas parametrizadas)', 'true true', `${inyeccion.ok} ${Number(sigue.rows[0].count) > 0}`);
  const filtroMalo = await intentar(() => buscar(pool, emb, 'frenos', { coleccion: 'taller', filtro: { 'tipo) OR (1=1': ['x'] } }));
  prueba(G, 'Filtro con un nombre de propiedad inválido: se rechaza', 'FILTRO_INVALIDO', filtroMalo.codigo);
  const [x1, x2] = await Promise.all([1, 2].map(() => intentar(() => indexar(pool, emb, { carpeta: join(RAIZ, 'conocimiento', 'garantia'), coleccion: 'garantia' }))));
  const dobles = await pool.query("SELECT count(*) AS n, count(DISTINCT (documento_id, orden)) AS distintos FROM rag_fragmentos WHERE coleccion = 'garantia'");
  prueba(G, 'Dos indexaciones a la vez de la misma colección: sin duplicados', 'true true true',
    `${x1.ok} ${x2.ok} ${dobles.rows[0].n === dobles.rows[0].distintos && Number(dobles.rows[0].n) > 0}`);

  // ---------- 7. agente de diagnóstico con RAG (modelo de lenguaje simulado)
  const modelo = { url: 'http://localhost:4187/v1', llave: 'x', modelo: 'simulado' };
  const recuperador = crearRecuperador({ db, emb, coleccion: 'taller', esquema: ESQUEMA });
  const spark = { marca: 'Chevrolet', linea: 'Spark GT', modelo_anio: 2016, motor: '1.2L gasolina', kilometraje: 128400 };
  const d1 = await diagnosticarConIA({ sintomas: 'Tiembla en ralentí y se apaga', codigos_dtc: ['P0302'], vehiculo: spark }, { modelo, recuperador });
  prueba(G, 'Diagnóstico con RAG: cita como fuente la nota Falla de encendido', 'rag true', `${d1.recuperacion} ${d1.fuentes.some((f) => f.startsWith('Falla de encendido'))}`);
  const contexto = llm.peticiones.at(-1).messages[0].content;
  prueba(G, 'Los fragmentos llegan al modelo delimitados y marcados como datos, no instrucciones', 'true true', `${/<fragmento n="1" nota=/.test(contexto)} ${/no instrucciones/.test(contexto)}`);
  const d2 = await diagnosticarConIA({ sintomas: 'Mantenimiento de 60.000 km', codigos_dtc: [], vehiculo: { ...spark, motor: '2.4L diesel' } }, { modelo, recuperador });
  prueba(G, 'Motor diésel: no recupera notas de motores de gasolina', false, d2.fuentes.some((f) => f.startsWith('Mantenimiento motor gasolina')));
  llm.fijarJson({ diagnostico: { hallazgos: ['Pastillas gastadas'], requerimientos: [{ categoria: 'pastillas_freno', cantidad: 1, justificacion: 'x' }, { categoria: 'filtro_aceite', cantidad: 1, justificacion: 'x' }], mano_obra_horas: 2, confianza: 0.9, requiere_revision_humana: false } });
  const d3 = await diagnosticarConIA({ sintomas: 'Al pisar el freno se escucha metal contra metal', codigos_dtc: [], vehiculo: spark }, { modelo, recuperador });
  prueba(G, 'Un repuesto sin respaldo en las notas recuperadas pide revisión humana', 'true true',
    `${d3.diagnostico.requiere_revision_humana} ${d3.alertas.some((a) => /sin respaldo.*filtro_aceite/.test(a))}`);
  // Estrategia guiada: el modelo solo elige la nota; los repuestos y las horas salen de la nota.
  llm.fijarJson({ eleccion: { nota: 'Falla de encendido', confianza: 0.9, justificacion: 'Código P0302 y tiembla en ralentí' } });
  const g1 = await diagnosticarConIA({ sintomas: 'Tiembla en ralentí y se apaga', codigos_dtc: ['P0302'], vehiculo: spark }, { modelo, recuperador, estrategia: 'guiada' });
  const rq = g1.diagnostico.requerimientos.map((q) => `${q.cantidad} ${q.categoria}`).sort().join(', ');
  prueba(G, 'Guiado: los repuestos y las horas salen de la nota elegida', '1 bobina_encendido, 4 bujia 1.5 false ia', `${rq} ${g1.diagnostico.mano_obra_horas} ${g1.diagnostico.requiere_revision_humana} ${g1.fuente}`);
  const mensajeEleccion = llm.peticiones.at(-1);
  prueba(G, 'Guiado: la respuesta del modelo está restringida a los títulos de las notas candidatas', true,
    JSON.stringify(mensajeEleccion.response_format.json_schema.schema.properties.nota.enum).includes('Falla de encendido'));
  llm.fijarJson({ eleccion: { nota: 'Una nota inventada', confianza: 1, justificacion: 'x' } });
  const g2 = await diagnosticarConIA({ sintomas: 'Al pisar el freno se escucha metal contra metal', codigos_dtc: [], vehiculo: spark }, { modelo, recuperador, estrategia: 'guiada' });
  prueba(G, 'Guiado: si el modelo nombra una nota que no está entre las candidatas, plan B con revisión', 'rag true', `${g2.fuente} ${g2.diagnostico.requiere_revision_humana}`);
  llm.fijarJson({ eleccion: { nota: 'Catalizador', confianza: 0.95, justificacion: 'P0420' } });
  const g3 = await diagnosticarConIA({ sintomas: 'Huele a huevo podrido', codigos_dtc: ['P0420'], vehiculo: spark }, { modelo, recuperador, estrategia: 'guiada' });
  prueba(G, 'Guiado: una nota sin repuestos del catálogo pide revisión del jefe de taller', '0 true', `${g3.diagnostico.requerimientos.length} ${g3.diagnostico.requiere_revision_humana}`);
  llm.fijarJson({});
  await recuperador.cerrar();
  const roto = crearRecuperador({ db: 'postgres://rag:rag@localhost:1/rag', emb, coleccion: 'taller' });
  const d4 = await diagnosticarConIA({ sintomas: 'Tiembla y se apaga', codigos_dtc: ['P0301'], vehiculo: spark }, { modelo, recuperador: roto });
  prueba(G, 'Si la base del RAG no responde, el agente sigue con palabras clave y lo avisa', 'palabras true', `${d4.recuperacion} ${d4.alertas.some((a) => /RAG no disponible/.test(a))}`);
  await roto.cerrar();
} catch (e) {
  prueba(G, 'Las pruebas del RAG se completan sin errores inesperados', 'completas', `detenidas: ${e.codigo ?? ''} ${e.message}`.slice(0, 200));
} finally {
  await pool.end();
  await admin.query(`DROP SCHEMA IF EXISTS ${ESQUEMA} CASCADE`).catch(() => {});
  await admin.end();
  simulados.servidor.close();
  llm.servidor.close();
  rmSync(temporal, { recursive: true, force: true });
}
const ok = resumen('RESUMEN DEL RAG');
process.exit(ok ? 0 : 1);
