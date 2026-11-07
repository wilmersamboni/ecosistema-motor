// Modelo de embeddings SIMULADO, compatible con la API de OpenAI (POST /v1/embeddings), para probar el
// RAG sin descargar un modelo. NO entiende significado: arma el vector con raíces de palabras y trigramas
// de letras (un "hashing trick"), así que solo encuentra textos que comparten palabras. Sirve para
// probar la tubería (troceo, base, índices, búsqueda); la calidad se mide con un modelo real.
// La dimensión sale del nombre del modelo: "simulado-256" (por defecto) o "simulado-128";
// "simulado-b-256" es otro modelo con la misma dimensión.
//   node pruebas/embeddings-simulados.mjs [puerto]
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const sinTildes = (t) => String(t).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const VACIAS = new Set('de la el en y a los las del se un una por con que es al lo su o para como mas sin si no le sus ya cuando'.split(' '));

export function vectorSimulado(texto, dimension = 256, semilla = '') {
  const v = new Float64Array(dimension);
  const sumar = (rasgo, peso) => {
    const h = createHash('md5').update(semilla + rasgo).digest();
    const i = h.readUInt32LE(0) % dimension;
    v[i] += h[4] & 1 ? peso : -peso;
  };
  const palabras = sinTildes(texto).replace(/^search_(query|document): /, '').match(/[a-z0-9]+/g) ?? [];
  for (const p of palabras) {
    if (VACIAS.has(p)) continue;
    sumar(`w:${p.slice(0, 5)}`, 1);
    for (let i = 0; i + 3 <= p.length; i++) sumar(`c:${p.slice(i, i + 3)}`, 0.3);
  }
  const n = Math.hypot(...v) || 1;
  return [...v].map((x) => Number((x / n).toFixed(6)));
}

export function crearEmbeddingsSimulados() {
  let peticiones = 0;
  const servidor = createServer((req, res) => {
    let cuerpo = '';
    req.on('data', (x) => (cuerpo += x));
    req.on('end', () => {
      const responder = (s, d) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(d)); };
      if (req.url.endsWith('/models')) return responder(200, { data: [{ id: 'simulado-256' }, { id: 'simulado-128' }] });
      if (!req.url.endsWith('/embeddings')) return responder(404, { error: 'ruta' });
      peticiones++;
      const b = JSON.parse(cuerpo || '{}');
      // "simulado-b-256" tiene la misma dimensión pero otros vectores: sirve para probar el cambio de modelo.
      const m = String(b.model ?? '').match(/^simulado-(b-)?(\d+)$/);
      if (!m) return responder(404, { error: { message: `model "${b.model}" not found, try pulling it first` } });
      const entradas = [b.input].flat();
      responder(200, { object: 'list', model: b.model, data: entradas.map((t, index) => ({ object: 'embedding', index, embedding: vectorSimulado(t, Number(m[2]), m[1] ?? '') })) });
    });
  });
  return { servidor, peticiones: () => peticiones };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const puerto = Number(process.argv[2] ?? 4185);
  crearEmbeddingsSimulados().servidor.listen(puerto, () => console.log(`embeddings simulados en http://localhost:${puerto}/v1 (modelo simulado-256)`));
}
