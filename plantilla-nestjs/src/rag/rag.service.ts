import { Injectable, OnModuleDestroy } from '@nestjs/common';
import pg from 'pg';

// Búsqueda en la base de conocimiento del grupo (RAG con PostgreSQL + pgvector). Es la misma consulta
// híbrida de ecosistema-motor/lib/rag.mjs: vectores (coseno) + texto en español, fusionados con RRF.
// La indexación de la bóveda de Obsidian se hace con el kit:
//   node rag/indexar.mjs --boveda=<su bóveda> --coleccion=<su colección>     (con RAG_DB_URL de su base)
// Uso en un servicio:  constructor(private readonly rag: RagService) {}
//                      const fragmentos = await this.rag.buscar('chillido al frenar', { coleccion: 'taller' });

export interface Fragmento {
  titulo: string;
  seccion: string;
  contenido: string;
  propiedades: Record<string, unknown>;
  puntaje: number;
  similitud: number | null;
}

export interface OpcionesBusqueda {
  coleccion: string;
  k?: number;
  modo?: 'hibrido' | 'vector' | 'texto';
  filtro?: Record<string, string[]>;
  porNota?: number;
}

const v = (nombre: string, porDefecto: string) => process.env[nombre] || porDefecto;
const sinTildes = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

@Injectable()
export class RagService implements OnModuleDestroy {
  private pool: pg.Pool | null = null;
  private readonly emb = {
    url: v('EMB_URL', v('LLM_URL', 'http://localhost:11434/v1')).replace(/\/$/, ''),
    llave: v('EMB_LLAVE', v('LLM_LLAVE', 'ollama')),
    modelo: v('EMB_MODELO', 'nomic-embed-text'),
  };
  private readonly prefijo =
    process.env.EMB_PREFIJO_CONSULTA ??
    (/nomic/i.test(this.emb.modelo) ? 'search_query: ' : '');

  // La conexión se abre en la primera búsqueda: el servicio arranca aunque la base del RAG no esté.
  private conexion(): pg.Pool {
    this.pool ??= new pg.Pool({
      connectionString: v('RAG_DB_URL', 'postgres://rag:rag@localhost:5434/rag'),
      max: 4,
    });
    return this.pool;
  }

  async onModuleDestroy() {
    await this.pool?.end();
  }

  private async embeber(texto: string): Promise<number[]> {
    const r = await fetch(`${this.emb.url}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.emb.llave}`,
      },
      body: JSON.stringify({ model: this.emb.modelo, input: [this.prefijo + texto] }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!r.ok) throw new Error(`El modelo de embeddings respondió HTTP ${r.status}`);
    const d = (await r.json()) as { data: { embedding: number[] }[] };
    const e = d.data[0].embedding;
    const n = Math.hypot(...e) || 1;
    return e.map((x) => x / n);
  }

  async buscar(
    consulta: string,
    {
      coleccion,
      k = 4,
      modo = 'hibrido',
      filtro = {},
      porNota = 2,
    }: OpcionesBusqueda,
  ): Promise<Fragmento[]> {
    if (!consulta.trim()) throw new Error('La consulta está vacía');
    const pool = this.conexion();
    const col = (
      await pool.query('SELECT modelo FROM rag_colecciones WHERE nombre = $1', [
        coleccion,
      ])
    ).rows[0];
    if (!col)
      throw new Error(`La colección "${coleccion}" no existe: indéxela con el kit`);
    if (col.modelo !== this.emb.modelo)
      throw new Error(
        `La colección se indexó con ${col.modelo} y este servicio usa ${this.emb.modelo}`,
      );
    const params: unknown[] = [coleccion];
    const condiciones: string[] = [];
    for (const [clave, valores] of Object.entries(filtro)) {
      if (!/^\w+$/.test(clave)) throw new Error(`Propiedad inválida: ${clave}`);
      params.push(clave, JSON.stringify(valores.map(String)));
      condiciones.push(
        `d.propiedades ->> $${params.length - 1} IN (SELECT jsonb_array_elements_text($${params.length}::jsonb))`,
      );
    }
    const donde = ['f.coleccion = $1', ...condiciones].join(' AND ');
    const vector =
      modo === 'texto' ? null : `[${(await this.embeber(consulta)).join(',')}]`;
    const iVec = params.push(vector);
    const iTxt = params.push(sinTildes(consulta));
    const iK = params.push(k * 4);
    const puntaje = {
      vector: 'coalesce(1.0 / (60 + v.pos), 0)',
      texto: 'coalesce(1.0 / (60 + t.pos), 0)',
      hibrido: 'coalesce(1.0 / (60 + v.pos), 0) + coalesce(1.0 / (60 + t.pos), 0)',
    }[modo];
    const sql = `
      WITH v AS (
        SELECT id, 1 - distancia AS similitud, row_number() OVER (ORDER BY distancia, id) AS pos FROM (
          SELECT f.id, f.embedding <=> $${iVec}::vector AS distancia
          FROM rag_fragmentos f JOIN rag_documentos d ON d.id = f.documento_id
          WHERE ${donde} AND $${iVec}::text IS NOT NULL
          ORDER BY distancia LIMIT 20) x
      ), t AS (
        SELECT id, rango, row_number() OVER (ORDER BY rango DESC, id) AS pos FROM (
          SELECT f.id, ts_rank_cd(f.busqueda, cq.q) AS rango
          FROM rag_fragmentos f JOIN rag_documentos d ON d.id = f.documento_id,
            (SELECT array_to_string(array(SELECT quote_literal(x) FROM unnest(tsvector_to_array(to_tsvector('spanish', $${iTxt}))) x), ' | ')::tsquery AS q) AS cq
          WHERE ${donde} AND numnode(cq.q) > 0 AND f.busqueda @@ cq.q
          ORDER BY rango DESC, f.id LIMIT 20) y
      ), fusion AS (
        SELECT coalesce(v.id, t.id) AS id, v.similitud, ${puntaje} AS puntaje
        FROM v FULL OUTER JOIN t ON v.id = t.id
      )
      SELECT fu.puntaje, fu.similitud, f.seccion, f.contenido, d.titulo, d.ruta, d.propiedades
      FROM fusion fu JOIN rag_fragmentos f ON f.id = fu.id JOIN rag_documentos d ON d.id = f.documento_id
      WHERE fu.puntaje > 0
      ORDER BY fu.puntaje DESC, fu.similitud DESC NULLS LAST LIMIT $${iK}`;
    const { rows } = await pool.query(sql, params);
    const cuenta = new Map<string, number>();
    return rows
      .filter((r) => {
        const n = (cuenta.get(r.ruta) ?? 0) + 1;
        cuenta.set(r.ruta, n);
        return n <= porNota;
      })
      .slice(0, k)
      .map((r) => ({
        titulo: r.titulo,
        seccion: r.seccion,
        contenido: r.contenido,
        propiedades: r.propiedades,
        puntaje: Number(r.puntaje),
        similitud: r.similitud === null ? null : Number(r.similitud),
      }));
  }
}
