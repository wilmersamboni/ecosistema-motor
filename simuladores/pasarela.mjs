// Pasarela de pagos SIMULADA (no mueve dinero real). Imita a una pasarela comercial: cobros con
// enlace de pago, página de pago de prueba, reembolsos y webhooks firmados con reintentos.
// Con PASARELA_DUPLICAR=1 envía cada evento dos veces, como hacen las pasarelas reales a veces:
// el receptor debe ser idempotente.   node simuladores/pasarela.mjs
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { FIRMA, PASARELA_DUPLICAR, PASARELA_LLAVE, PASARELA_URL_PUBLICA, PUERTOS } from '../lib/config.mjs';
import { enviarEvento } from '../lib/eventos.mjs';
import { crearBitacora, leerCuerpo, responder } from '../lib/servicio.mjs';

const pesos = (v) => '$' + v.toLocaleString('es-CO');
const escapar = (t) => String(t).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export async function iniciar(puerto = PUERTOS.pasarela) {
  const cobros = new Map();
  const bitacora = crearBitacora('pasarela');
  let n = 0;

  async function notificar(cobro, tipo) {
    const evento = { evento_id: `EVP-${randomUUID()}`, tipo, cobro_id: cobro.cobro_id, referencia: cobro.referencia, monto: cobro.monto, fecha: new Date().toISOString() };
    const veces = PASARELA_DUPLICAR ? 2 : 1;
    for (let i = 0; i < veces; i++) await enviarEvento(cobro.url_webhook, evento, FIRMA.pasarela, { cabecera: 'X-Pasarela-Firma', bitacora });
  }

  async function resolver(cobro, resultado) {
    if (cobro.estado !== 'pendiente') return false;
    cobro.estado = resultado === 'aprobado' ? 'aprobado' : 'rechazado';
    cobro.resuelto_en = new Date().toISOString();
    bitacora({ evento: `cobro ${cobro.estado}`, cobro_id: cobro.cobro_id, referencia: cobro.referencia, monto: cobro.monto });
    await notificar(cobro, cobro.estado === 'aprobado' ? 'cobro.aprobado' : 'cobro.rechazado');
    return true;
  }

  const autorizado = (req) => req.headers.authorization === `Bearer ${PASARELA_LLAVE}`;
  const pagina = (cobro, mensaje = '') => `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pasarela de prueba</title><style>body{font-family:system-ui,Arial;background:#f3f4f1;margin:0;padding:24px}main{max-width:420px;margin:auto;background:#fff;border:1px solid #ddd;border-radius:8px;padding:20px}
.monto{font-size:2rem;font-weight:700;margin:8px 0}button{width:100%;padding:12px;margin-top:10px;border:0;border-radius:6px;font-size:1rem;cursor:pointer}.si{background:#39a900;color:#fff}.no{background:#e5e5e5}
.aviso{background:#fff4d6;padding:8px;border-radius:6px;font-size:.85rem}</style></head><body><main>
<p class="aviso">Pasarela SIMULADA para clase. No ingrese datos de tarjetas reales.</p>
<h1>Pago de ${escapar(cobro.descripcion)}</h1><p>Referencia ${escapar(cobro.referencia)}</p><p class="monto">${pesos(cobro.monto)}</p>
<p>Estado: <strong>${cobro.estado}</strong></p>${mensaje ? `<p>${escapar(mensaje)}</p>` : ''}
${cobro.estado === 'pendiente' ? `<form method="post"><button class="si" name="resultado" value="aprobado">Pagar (aprobar)</button><button class="no" name="resultado" value="rechazado">Simular rechazo</button></form>` : ''}
</main></body></html>`;

  const servidor = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const partes = url.pathname.split('/').filter(Boolean);
      if (req.method === 'GET' && url.pathname === '/salud') return responder(res, 200, { servicio: 'pasarela', estado: 'ok' });
      if (req.method === 'POST' && url.pathname === '/api/cobros') {
        if (!autorizado(req)) return responder(res, 401, { error: 'Llave de API inválida' });
        const d = JSON.parse(await leerCuerpo(req));
        if (!Number.isInteger(d.monto) || d.monto <= 0 || !d.referencia || !d.url_webhook) return responder(res, 400, { error: 'monto, referencia y url_webhook son obligatorios' });
        const cobro = { cobro_id: `CB-${String(++n).padStart(6, '0')}`, referencia: d.referencia, monto: d.monto, descripcion: d.descripcion ?? d.referencia, url_webhook: d.url_webhook, estado: 'pendiente', creado_en: new Date().toISOString() };
        cobro.url_checkout = `${PASARELA_URL_PUBLICA}/checkout/${cobro.cobro_id}`;
        cobros.set(cobro.cobro_id, cobro);
        bitacora({ evento: 'cobro creado', cobro_id: cobro.cobro_id, referencia: cobro.referencia, monto: cobro.monto });
        return responder(res, 201, cobro);
      }
      if (req.method === 'GET' && url.pathname === '/api/bitacora') {
        if (!autorizado(req)) return responder(res, 401, { error: 'Llave de API inválida' });
        const referencias = (url.searchParams.get('referencias') ?? '').split(',').filter(Boolean);
        return responder(res, 200, { servicio: 'pasarela', registros: bitacora.consultar().filter((l) => !referencias.length || referencias.includes(l.referencia)) });
      }
      if (partes[0] === 'api' && partes[1] === 'cobros' && partes[2]) {
        if (!autorizado(req)) return responder(res, 401, { error: 'Llave de API inválida' });
        const cobro = cobros.get(partes[2]);
        if (!cobro) return responder(res, 404, { error: 'No existe el cobro' });
        if (req.method === 'GET' && !partes[3]) return responder(res, 200, cobro);
        if (req.method === 'POST' && partes[3] === 'simular') {
          const { resultado } = JSON.parse(await leerCuerpo(req));
          if (!(await resolver(cobro, resultado))) return responder(res, 409, { error: `El cobro ya está ${cobro.estado}` });
          return responder(res, 200, cobro);
        }
        if (req.method === 'POST' && partes[3] === 'reembolso') {
          if (cobro.estado !== 'aprobado') return responder(res, 409, { error: `No se puede reembolsar un cobro ${cobro.estado}` });
          cobro.estado = 'reembolsado';
          bitacora({ evento: 'cobro reembolsado', cobro_id: cobro.cobro_id, referencia: cobro.referencia, monto: cobro.monto });
          notificar(cobro, 'cobro.reembolsado');
          return responder(res, 200, cobro);
        }
      }
      if (partes[0] === 'checkout' && partes[1]) {
        const cobro = cobros.get(partes[1]);
        if (!cobro) return responder(res, 404, { error: 'No existe el cobro' });
        let mensaje = '';
        if (req.method === 'POST') {
          const resultado = new URLSearchParams(await leerCuerpo(req)).get('resultado');
          mensaje = (await resolver(cobro, resultado)) ? 'Gracias. El comercio ya fue notificado.' : 'Este cobro ya fue procesado.';
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'" });
        return res.end(pagina(cobro, mensaje));
      }
      responder(res, 404, { error: 'No existe la ruta' });
    } catch (e) {
      console.error('[pasarela]', e);
      if (!res.headersSent) responder(res, 500, { error: 'Error interno' });
    }
  });
  await new Promise((r) => servidor.listen(puerto, r));
  return puerto;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(`pasarela en el puerto ${await iniciar()}`);
