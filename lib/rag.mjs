// RAG (generación aumentada por recuperación) con PostgreSQL + pgvector sobre una bóveda de Obsidian.
//
//   Bóveda (.md)  ->  trocear por secciones  ->  embeddings  ->  PostgreSQL (vector + texto)  ->  buscar
//
// - Embeddings con cualquier API compatible con OpenAI (/embeddings): Ollama local o un proveedor.
// - Búsqueda híbrida: similitud de vectores (pgvector, distancia coseno) + búsqueda de texto completo
//   en español (tsvector), fusionadas con Reciprocal Rank Fusion (RRF). Los códigos OBD-II y las
//   palabras exactas los encuentra mejor el texto; las paráfrasis, los vectores.
// - Indexación incremental: cada nota guarda un hash; solo se recalcula lo que cambió y se borra lo
//   que ya no existe en la bóveda. Un candado (advisory lock) evita dos indexaciones a la vez.
// - Cada colección queda atada al modelo de embeddings con que se creó: mezclar vectores de modelos
//   distintos da resultados sin sentido, así que se rechaza.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import pg from 'pg';

export const VERSION_TROCEO = 2; // si cambia la forma de trocear, se reindexa todo
const MAX_FRAGMENTO = 1200; // caracteres por fragmento (sin el encabezado)

export function configDesdeEntorno() {
  const modelo = process.env.EMB_MODELO || 'nomic-embed-text';
  // nomic-embed-text rinde mejor con prefijos de tarea; otros modelos no los necesitan.
  const nomic = /nomic/i.test(modelo);
  return {
    db: process.env.RAG_DB_URL || 'postgres://rag:rag@localhost:5434/rag',
    emb: {
      url: (process.env.EMB_URL || process.env.LLM_URL || 'http://localhost:11434/v1').replace(/\/$/, ''),
      llave: process.env.EMB_LLAVE || process.env.LLM_LLAVE || 'ollama',
      modelo,
      prefijoDocumento: process.env.EMB_PREFIJO_DOCUMENTO ?? (nomic ? 'search_document: ' : ''),
      prefijoConsulta: process.env.EMB_PREFIJO_CONSULTA ?? (nomic ? 'search_query: ' : ''),
    },
  };
}

export class ErrorRag extends Error {
  constructor(codigo, mensaje) { super(mensaje); this.codigo = codigo; }
}

export const sinTildes = (t) => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// ---------------------------------------------------------------- embeddings
export async function embeber(emb, textos, { lote = 16, timeoutMs = 120_000 } = {}) {
  const vectores = [];
  for (let i = 0; i < textos.length; i += lote) {
    const parte = textos.slice(i, i + lote);
    let r;
    try {
      r = await fetch(`${emb.url}/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${emb.llave}` },
        body: JSON.stringify({ model: emb.modelo, input: parte }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new ErrorRag('EMBEDDINGS_NO_DISPONIBLE', `No hay conexión con el modelo de embeddings en ${emb.url}: ${e.cause?.code ?? e.message}`);
    }
    if (!r.ok) {
      const t = (await r.text()).slice(0, 300);
      const pista = r.status === 404 ? ` (¿descargó el modelo? ollama pull ${emb.modelo})` : '';
      throw new ErrorRag('EMBEDDINGS_ERROR', `El modelo de embeddings respondió HTTP ${r.status}${pista}: ${t}`);
    }
    const d = await r.json();
    const datos = [...(d.data ?? [])].sort((a, b) => a.index - b.index);
    if (datos.length !== parte.length) throw new ErrorRag('EMBEDDINGS_ERROR', `Se pidieron ${parte.length} vectores y llegaron ${datos.length}`);
    for (const x of datos) vectores.push(normalizar(x.embedding));
  }
  return vectores;
}

function normalizar(v) {
  const n = Math.hypot(...v);
  return n ? v.map((x) => x / n) : v;
}
const comoVector = (v) => `[${v.join(',')}]`;

// ---------------------------------------------------------------- lectura de la bóveda
// Propiedades de Obsidian (frontmatter YAML sencillo): clave: valor, listas [a, b] o en líneas "- a".
export function leerPropiedades(texto) {
  const m = texto.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { propiedades: {}, cuerpo: texto };
  const propiedades = {};
  let lista = null;
  for (const linea of m[1].split(/\r?\n/)) {
    const item = linea.match(/^\s*-\s+(.*)$/);
    if (item && lista) { (propiedades[lista] ??= []).push(valor(item[1])); continue; }
    const kv = linea.match(/^([\wÀ-ſ-]+):\s*(.*)$/);
    if (!kv) continue;
    const [, k, v] = kv;
    // "clave:" sin valor: puede quedar vacía o ser el comienzo de una lista en líneas "- a".
    if (v.trim() === '') { propiedades[k] = null; lista = k; continue; }
    lista = null;
    propiedades[k] = /^\[.*\]$/.test(v.trim()) ? v.trim().slice(1, -1).split(',').map((x) => valor(x)).filter((x) => x !== '') : valor(v);
  }
  return { propiedades, cuerpo: texto.slice(m[0].length) };
}

function valor(v) {
  const t = String(v).trim().replace(/^["']|["']$/g, '');
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return t;
}

// Quita la sintaxis propia de Obsidian que no aporta significado al texto.
export function limpiarObsidian(texto) {
  return texto
    .replace(/%%[\s\S]*?%%/g, '') // comentarios
    .replace(/!\[\[[^\]]*\]\]/g, '') // archivos incrustados
    .replace(/\[\[([^\]|#]+)(#[^\]|]*)?\|([^\]]+)\]\]/g, '$3') // [[Nota|alias]] -> alias
    .replace(/\[\[([^\]|#]+)(#[^\]]*)?\]\]/g, '$1') // [[Nota]] -> Nota
    .replace(/^>\s*\[!(\w+)\][+-]?\s*/gm, '> ') // callouts
    .replace(/(^|\s)#([\p{L}\w/-]+)/gu, '$1$2') // #etiquetas -> etiquetas
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function leerBoveda(carpeta) {
  const notas = [];
  const recorrer = (dir) => {
    for (const nombre of readdirSync(dir).sort()) {
      if (nombre.startsWith('.') || nombre.startsWith('_')) continue; // .obsidian, .trash, _plantillas
      const ruta = join(dir, nombre);
      if (statSync(ruta).isDirectory()) recorrer(ruta);
      else if (nombre.endsWith('.md')) {
        const crudo = readFileSync(ruta, 'utf8');
        const { propiedades, cuerpo } = leerPropiedades(crudo);
        notas.push({ ruta: relative(carpeta, ruta).split(sep).join('/'), titulo: nombre.slice(0, -3), propiedades, cuerpo, crudo });
      }
    }
  };
  recorrer(carpeta);
  return notas;
}

// ---------------------------------------------------------------- troceo
// Un fragmento por sección (## o ###). Las secciones largas se parten por párrafos con un párrafo de
// solapamiento. Cada fragmento lleva un encabezado con la nota, la sección y los metadatos útiles para
// buscar (códigos y categorías): así el fragmento se entiende solo, fuera de su nota.
export function trocear(nota) {
  const p = nota.propiedades;
  const meta = [
    p.sistema && `Sistema: ${p.sistema}`,
    Array.isArray(p.codigos_dtc) && p.codigos_dtc.length && `Códigos: ${p.codigos_dtc.join(', ')}`,
    Array.isArray(p.categorias) && p.categorias.length && `Repuestos: ${p.categorias.join(', ')}`,
  ].filter(Boolean).join(' | ');
  const cuerpo = limpiarObsidian(nota.cuerpo).replace(/^#\s+.*\n?/, ''); // el título ya va en el encabezado
  const secciones = [];
  let actual = { seccion: 'Resumen', lineas: [] };
  for (const linea of cuerpo.split('\n')) {
    const h = linea.match(/^#{2,3}\s+(.*)$/);
    if (h) { secciones.push(actual); actual = { seccion: h[1].trim(), lineas: [] }; } else actual.lineas.push(linea);
  }
  secciones.push(actual);
  const fragmentos = [];
  for (const s of secciones) {
    const texto = s.lineas.join('\n').trim();
    if (!texto) continue;
    for (const parte of partir(texto)) {
      const encabezado = `${nota.titulo} > ${s.seccion}${meta ? `\n${meta}` : ''}`;
      fragmentos.push({ orden: fragmentos.length, seccion: s.seccion, contenido: `${encabezado}\n${parte}` });
    }
  }
  return fragmentos;
}

function partir(texto) {
  if (texto.length <= MAX_FRAGMENTO) return [texto];
  // Unidades: párrafos o ítems de lista; si una unidad es muy larga, oraciones; si aún lo es, cortes fijos.
  const unidades = texto.split(/\n\s*\n|\n(?=[-*]\s|\d+\.\s)/)
    .flatMap((p) => (p.length <= MAX_FRAGMENTO ? [p] : (p.match(/[^.!?]+[.!?]*\s*/g) ?? [p]).map((o) => o.trim())))
    .flatMap((u) => (u.length <= MAX_FRAGMENTO ? [u] : u.match(new RegExp(`[\\s\\S]{1,${MAX_FRAGMENTO}}`, 'g'))))
    .filter((u) => u.trim());
  const largo = (a) => a.join('\n').length;
  const partes = [];
  let actual = [];
  for (const u of unidades) {
    if (actual.length && largo([...actual, u]) > MAX_FRAGMENTO) {
      partes.push(actual.join('\n'));
      // Solapamiento: la última unidad se repite al comienzo del fragmento siguiente, si cabe.
      const ultima = actual.at(-1);
      actual = largo([ultima, u]) <= MAX_FRAGMENTO ? [ultima] : [];
    }
    actual.push(u);
  }
  if (actual.length) partes.push(actual.join('\n'));
  return partes;
}

// ---------------------------------------------------------------- base de datos
// esquema: para aislar datos (las pruebas automáticas usan su propio esquema y no tocan los suyos).
export function crearPool(db = configDesdeEntorno().db, { esquema } = {}) {
  if (esquema && !/^[a-z_][a-z0-9_]*$/.test(esquema)) throw new ErrorRag('ESQUEMA_INVALIDO', `Nombre de esquema inválido: ${esquema}`);
  return new pg.Pool({ connectionString: db, max: 4, ...(esquema ? { options: `-c search_path=${esquema},public` } : {}) });
}

export async function migrar(pool, dimension) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(7203001)'); // dos migraciones a la vez no chocan
    await c.query('CREATE EXTENSION IF NOT EXISTS vector');
    await c.query(`CREATE TABLE IF NOT EXISTS rag_colecciones (
      nombre text PRIMARY KEY,
      modelo text NOT NULL,
      dimension int NOT NULL CHECK (dimension > 0),
      version_troceo int NOT NULL,
      creada timestamptz NOT NULL DEFAULT now())`);
    await c.query(`CREATE TABLE IF NOT EXISTS rag_documentos (
      id bigserial PRIMARY KEY,
      coleccion text NOT NULL REFERENCES rag_colecciones(nombre) ON DELETE CASCADE,
      ruta text NOT NULL,
      titulo text NOT NULL,
      propiedades jsonb NOT NULL DEFAULT '{}',
      hash text NOT NULL,
      indexado timestamptz NOT NULL DEFAULT now(),
      UNIQUE (coleccion, ruta))`);
    const existe = await c.query(`SELECT format_type(atttypid, atttypmod) AS tipo FROM pg_attribute
      WHERE attrelid = to_regclass(quote_ident(current_schema()) || '.rag_fragmentos') AND attname = 'embedding'`);
    if (existe.rows.length && existe.rows[0].tipo !== `vector(${dimension})`) {
      throw new ErrorRag('DIMENSION_DISTINTA', `La tabla rag_fragmentos guarda vectores ${existe.rows[0].tipo} y el modelo actual produce vector(${dimension}). ` +
        'Use el mismo modelo de embeddings o reinicie la base con: node rag/indexar.mjs --reiniciar-todo');
    }
    // La columna de vectores lleva dimensión fija: así puede tener índice HNSW.
    await c.query(`CREATE TABLE IF NOT EXISTS rag_fragmentos (
      id bigserial PRIMARY KEY,
      documento_id bigint NOT NULL REFERENCES rag_documentos(id) ON DELETE CASCADE,
      coleccion text NOT NULL,
      orden int NOT NULL,
      seccion text NOT NULL,
      contenido text NOT NULL,
      busqueda tsvector NOT NULL,
      embedding vector(${dimension}) NOT NULL)`);
    await c.query('CREATE INDEX IF NOT EXISTS rag_fragmentos_embedding ON rag_fragmentos USING hnsw (embedding vector_cosine_ops)');
    await c.query('CREATE INDEX IF NOT EXISTS rag_fragmentos_busqueda ON rag_fragmentos USING gin (busqueda)');
    await c.query('CREATE INDEX IF NOT EXISTS rag_fragmentos_coleccion ON rag_fragmentos (coleccion)');
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

export async function reiniciarTodo(pool) {
  await pool.query('DROP TABLE IF EXISTS rag_fragmentos, rag_documentos, rag_colecciones CASCADE');
}

const hashDe = (nota, emb) => createHash('sha256').update(`${VERSION_TROCEO}|${emb.modelo}|${emb.prefijoDocumento}|${nota.crudo}`).digest('hex');

// Indexa una bóveda en una colección. Devuelve un resumen de lo que hizo.
export async function indexar(pool, emb, { carpeta, coleccion, reiniciar = false, alProgresar = () => {} }) {
  const notas = leerBoveda(carpeta);
  if (!notas.length) throw new ErrorRag('BOVEDA_VACIA', `No hay notas .md en ${carpeta}`);
  const [muestra] = await embeber(emb, ['prueba de dimensión']);
  await migrar(pool, muestra.length);
  const c = await pool.connect();
  const resumen = { coleccion, modelo: emb.modelo, dimension: muestra.length, notas: notas.length, nuevas: 0, actualizadas: 0, sin_cambios: 0, eliminadas: 0, fragmentos: 0 };
  try {
    // Candado por colección: si otro proceso está indexando la misma colección, este espera.
    await c.query('SELECT pg_advisory_lock(7203002, hashtext($1))', [coleccion]);
    if (reiniciar) await c.query('DELETE FROM rag_colecciones WHERE nombre = $1', [coleccion]);
    const col = (await c.query('SELECT modelo, dimension FROM rag_colecciones WHERE nombre = $1', [coleccion])).rows[0];
    if (col && (col.modelo !== emb.modelo || col.dimension !== muestra.length)) {
      throw new ErrorRag('MODELO_DISTINTO', `La colección "${coleccion}" se creó con ${col.modelo} (${col.dimension} dimensiones) y ahora se usa ${emb.modelo} (${muestra.length}). ` +
        `Los vectores de modelos distintos no se pueden comparar. Reindexe todo con --reiniciar.`);
    }
    if (!col) await c.query('INSERT INTO rag_colecciones (nombre, modelo, dimension, version_troceo) VALUES ($1, $2, $3, $4)', [coleccion, emb.modelo, muestra.length, VERSION_TROCEO]);
    const previos = new Map((await c.query('SELECT id, ruta, hash FROM rag_documentos WHERE coleccion = $1', [coleccion])).rows.map((r) => [r.ruta, r]));
    for (const nota of notas) {
      const hash = hashDe(nota, emb);
      const previo = previos.get(nota.ruta);
      previos.delete(nota.ruta);
      if (previo?.hash === hash) { resumen.sin_cambios++; continue; }
      const fragmentos = trocear(nota);
      // Los embeddings se calculan ANTES de abrir la transacción: si el modelo falla, la base no queda a medias.
      const vectores = await embeber(emb, fragmentos.map((f) => emb.prefijoDocumento + f.contenido));
      await c.query('BEGIN');
      try {
        if (previo) await c.query('DELETE FROM rag_documentos WHERE id = $1', [previo.id]);
        const { rows: [doc] } = await c.query(
          'INSERT INTO rag_documentos (coleccion, ruta, titulo, propiedades, hash) VALUES ($1, $2, $3, $4, $5) RETURNING id',
          [coleccion, nota.ruta, nota.titulo, JSON.stringify(nota.propiedades), hash]);
        for (const [i, f] of fragmentos.entries()) {
          await c.query(
            `INSERT INTO rag_fragmentos (documento_id, coleccion, orden, seccion, contenido, busqueda, embedding)
             VALUES ($1, $2, $3, $4, $5, to_tsvector('spanish', $6), $7)`,
            [doc.id, coleccion, f.orden, f.seccion, f.contenido, sinTildes(f.contenido), comoVector(vectores[i])]);
        }
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK').catch(() => {});
        throw e;
      }
      resumen[previo ? 'actualizadas' : 'nuevas']++;
      resumen.fragmentos += fragmentos.length;
      alProgresar({ nota: nota.ruta, fragmentos: fragmentos.length, accion: previo ? 'actualizada' : 'nueva' });
    }
    for (const [ruta, previo] of previos) {
      await c.query('DELETE FROM rag_documentos WHERE id = $1', [previo.id]);
      resumen.eliminadas++;
      alProgresar({ nota: ruta, accion: 'eliminada' });
    }
    resumen.total_fragmentos = Number((await c.query('SELECT count(*) FROM rag_fragmentos WHERE coleccion = $1', [coleccion])).rows[0].count);
    return resumen;
  } finally {
    await c.query('SELECT pg_advisory_unlock(7203002, hashtext($1))', [coleccion]).catch(() => {});
    c.release();
  }
}

// ---------------------------------------------------------------- búsqueda
// modo: 'hibrido' (por defecto), 'vector' o 'texto'.
// filtro: propiedades de la nota que deben coincidir, por ejemplo { tipo: ['falla', 'mantenimiento'] }.
// porNota: máximo de fragmentos de una misma nota, para que el contexto no se llene con una sola nota.
export async function buscar(pool, emb, consulta, { coleccion, k = 4, modo = 'hibrido', filtro = {}, candidatos = 20, porNota = 2 } = {}) {
  if (!String(consulta ?? '').trim()) throw new ErrorRag('CONSULTA_VACIA', 'La consulta está vacía');
  const col = (await pool.query('SELECT modelo, dimension FROM rag_colecciones WHERE nombre = $1', [coleccion])).rows[0];
  if (!col) throw new ErrorRag('COLECCION_NO_EXISTE', `La colección "${coleccion}" no existe. Indexe primero: node rag/indexar.mjs`);
  if (col.modelo !== emb.modelo) throw new ErrorRag('MODELO_DISTINTO', `La colección "${coleccion}" se indexó con ${col.modelo} y la consulta usa ${emb.modelo}`);
  // Filtro por propiedades: cada clave es una lista de valores aceptados. Va como JSON parametrizado.
  const condiciones = [];
  const params = [coleccion];
  for (const [clave, valores] of Object.entries(filtro)) {
    if (!/^[\w]+$/.test(clave)) throw new ErrorRag('FILTRO_INVALIDO', `Propiedad inválida: ${clave}`);
    params.push(clave, JSON.stringify([valores].flat().map(String)));
    condiciones.push(`d.propiedades ->> $${params.length - 1} IN (SELECT jsonb_array_elements_text($${params.length}::jsonb))`);
  }
  const donde = ['f.coleccion = $1', ...condiciones].join(' AND ');
  let vector = null;
  if (modo !== 'texto') [vector] = await embeber(emb, [emb.prefijoConsulta + consulta]);
  const iVec = params.push(vector ? comoVector(vector) : null);
  const iTxt = params.push(sinTildes(consulta));
  const iCand = params.push(candidatos);
  const iK = params.push(k * 4);
  // Texto: los lexemas de la consulta unidos con O (|), para que no se exijan todas las palabras.
  const consultaTexto = `(SELECT array_to_string(array(SELECT quote_literal(x) FROM unnest(tsvector_to_array(to_tsvector('spanish', $${iTxt}))) x), ' | ')::tsquery AS q)`;
  const puntaje = { vector: 'coalesce(1.0 / (60 + v.pos), 0)', texto: 'coalesce(1.0 / (60 + t.pos), 0)', hibrido: 'coalesce(1.0 / (60 + v.pos), 0) + coalesce(1.0 / (60 + t.pos), 0)' }[modo];
  if (!puntaje) throw new ErrorRag('MODO_INVALIDO', `Modo de búsqueda inválido: ${modo}`);
  // Cada búsqueda trae sus mejores candidatos (ORDER BY ... LIMIT, que usa los índices) y después se
  // numeran; la fusión RRF suma 1/(60 + posición) de cada lista.
  const sql = `
    WITH v AS (
      SELECT id, 1 - distancia AS similitud, row_number() OVER (ORDER BY distancia, id) AS pos FROM (
        SELECT f.id, f.embedding <=> $${iVec}::vector AS distancia
        FROM rag_fragmentos f JOIN rag_documentos d ON d.id = f.documento_id
        WHERE ${donde} AND $${iVec}::text IS NOT NULL
        ORDER BY distancia LIMIT $${iCand}) x
    ), t AS (
      SELECT id, rango, row_number() OVER (ORDER BY rango DESC, id) AS pos FROM (
        SELECT f.id, ts_rank_cd(f.busqueda, cq.q) AS rango
        FROM rag_fragmentos f JOIN rag_documentos d ON d.id = f.documento_id, ${consultaTexto} AS cq
        WHERE ${donde} AND numnode(cq.q) > 0 AND f.busqueda @@ cq.q
        ORDER BY rango DESC, f.id LIMIT $${iCand}) y
    ), fusion AS (
      SELECT coalesce(v.id, t.id) AS id, v.similitud, t.rango, v.pos AS pos_vector, t.pos AS pos_texto, ${puntaje} AS puntaje
      FROM v FULL OUTER JOIN t ON v.id = t.id
    )
    SELECT fu.puntaje, fu.similitud, fu.rango, fu.pos_vector, fu.pos_texto, f.seccion, f.contenido, d.titulo, d.ruta, d.propiedades
    FROM fusion fu JOIN rag_fragmentos f ON f.id = fu.id JOIN rag_documentos d ON d.id = f.documento_id
    WHERE fu.puntaje > 0
    ORDER BY fu.puntaje DESC, fu.similitud DESC NULLS LAST LIMIT $${iK}`;
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL hnsw.ef_search = 100'); // más candidatos del índice antes de filtrar
    const { rows } = await c.query(sql, params);
    await c.query('COMMIT');
    const cuenta = new Map();
    const elegidos = rows.filter((r) => {
      const n = (cuenta.get(r.ruta) ?? 0) + 1;
      cuenta.set(r.ruta, n);
      return n <= porNota;
    }).slice(0, k);
    return elegidos.map((r) => ({
      titulo: r.titulo, ruta: r.ruta, seccion: r.seccion, contenido: r.contenido, propiedades: r.propiedades,
      puntaje: Number(r.puntaje), similitud: r.similitud === null ? null : Number(r.similitud), rango_texto: r.rango === null ? null : Number(r.rango),
      pos_vector: r.pos_vector === null ? null : Number(r.pos_vector), pos_texto: r.pos_texto === null ? null : Number(r.pos_texto),
    }));
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

// Las notas completas (todas sus secciones, en orden) de una colección, por ruta. Sirve para que el
// código lea datos estructurados de la nota elegida (por ejemplo, su sección de repuestos).
export async function obtenerNotas(pool, coleccion, rutas) {
  const { rows } = await pool.query(
    `SELECT d.ruta, d.titulo, d.propiedades, string_agg(f.contenido, E'\n' ORDER BY f.orden) AS texto
     FROM rag_documentos d JOIN rag_fragmentos f ON f.documento_id = d.id
     WHERE d.coleccion = $1 AND d.ruta = ANY($2::text[]) GROUP BY d.id`, [coleccion, rutas]);
  return rutas.map((r) => rows.find((x) => x.ruta === r)).filter(Boolean);
}

// Un recuperador listo para los agentes: guarda el pool y la configuración.
export function crearRecuperador({ db, emb, coleccion = 'taller', filtro = {}, k = 4, esquema } = {}) {
  const config = configDesdeEntorno();
  const pool = crearPool(db ?? config.db, { esquema });
  const e = emb ?? config.emb;
  return {
    coleccion,
    buscar: (consulta, opciones = {}) => buscar(pool, e, consulta, { coleccion, filtro, k, ...opciones }),
    notas: (rutas) => obtenerNotas(pool, coleccion, rutas),
    cerrar: () => pool.end(),
  };
}
