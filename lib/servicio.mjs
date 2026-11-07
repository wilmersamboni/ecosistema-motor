// Servidor HTTP de un grupo del ecosistema: credenciales de servicio (OAuth 2.0 client credentials),
// servidor MCP con herramientas filtradas por alcance, rutas propias (webhooks) y bitácora.
import { createServer } from 'node:http';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { herramientasDe } from '../contrato/herramientas.mjs';
import { VERSION_CONTRATO } from '../contrato/esquemas.mjs';
import { emitirToken, verificarToken } from './jwt.mjs';
import { ErrorNegocio } from './errores.mjs';

const RAIZ = join(import.meta.dirname, '..');

export function leerCuerpo(req, limite = 1_000_000) {
  return new Promise((resolver, rechazar) => {
    let texto = '';
    req.setEncoding('utf8');
    req.on('data', (parte) => {
      texto += parte;
      if (texto.length > limite) rechazar(new Error('Cuerpo demasiado grande'));
    });
    req.on('end', () => resolver(texto));
    req.on('error', rechazar);
  });
}

export function responder(res, estado, datos, cabeceras = {}) {
  res.writeHead(estado, { 'Content-Type': 'application/json; charset=utf-8', ...cabeceras });
  res.end(JSON.stringify(datos));
}

// La bitácora se guarda en memoria (para GET /bitacora) y en bitacora/<grupo>.jsonl. Escribir el archivo
// es de mejor esfuerzo: si no se puede, se avisa una vez y el servicio sigue.
export function crearBitacora(grupo) {
  const carpeta = join(RAIZ, 'bitacora');
  const archivo = join(carpeta, `${grupo}.jsonl`);
  const memoria = [];
  let avisado = false;
  const registrar = (registro) => {
    const linea = { ts: new Date().toISOString(), servicio: grupo, ...registro };
    memoria.push(linea);
    if (memoria.length > 50_000) memoria.splice(0, 10_000);
    try {
      mkdirSync(carpeta, { recursive: true });
      appendFileSync(archivo, JSON.stringify(linea) + '\n');
    } catch (e) {
      if (!avisado) console.error(`[${grupo}] no se pudo escribir la bitácora: ${e.message}`);
      avisado = true;
    }
  };
  registrar.consultar = (traza_id) => memoria.filter((l) => !traza_id || l.traza_id === traza_id);
  return registrar;
}

// Rutas de laboratorio: solo con SANDBOX=1 y la cabecera X-Sandbox-Llave correcta.
export const sandboxPermitido = (req) =>
  (process.env.SANDBOX ?? '1') === '1' && req.headers['x-sandbox-llave'] === (process.env.SANDBOX_LLAVE || 'lab-sandbox');

const alcancesDe = (h) => (Array.isArray(h.alcance) ? h.alcance : [h.alcance]);

// clientes: { client_id: { secreto, alcances: [] } }
// implementacion: { nombre_herramienta: async (args, contexto) => resultado }
// rutas: { 'POST /webhooks/pasarela': async ({ req, res, cuerpo }) => {...} }
export function crearServicio({ grupo, puerto, secreto, clientes, implementacion, rutas = {}, instrucciones = '' }) {
  const bitacora = crearBitacora(grupo);
  const herramientas = herramientasDe(grupo);
  const faltan = herramientas.filter((h) => !implementacion[h.nombre]).map((h) => h.nombre);
  if (faltan.length) throw new Error(`${grupo}: falta implementar ${faltan.join(', ')}`);

  const fabrica = ({ authInfo }) => {
    const cliente = authInfo?.extra?.cliente;
    const servidor = new McpServer(
      { name: `motorred-${grupo}`, version: VERSION_CONTRATO },
      { instructions: `Servicio ${grupo} del ecosistema MotorRed (contrato ${VERSION_CONTRATO}). ${instrucciones}` },
    );
    for (const h of herramientas) {
      if (!alcancesDe(h).some((a) => cliente.alcances.includes(a))) continue;
      servidor.registerTool(
        h.nombre,
        { title: h.nombre, description: h.descripcion, inputSchema: h.entrada, outputSchema: h.salida, annotations: h.anotaciones },
        async (args) => {
          const inicio = Date.now();
          try {
            const resultado = await implementacion[h.nombre](args, { cliente: cliente.id, alcances: cliente.alcances });
            bitacora({ traza_id: args.traza_id ?? resultado?.traza_id ?? null, cliente: cliente.id, herramienta: h.nombre, ok: true, ms: Date.now() - inicio });
            return { content: [{ type: 'text', text: JSON.stringify(resultado) }], structuredContent: resultado };
          } catch (e) {
            const negocio = e instanceof ErrorNegocio;
            const error = { codigo: negocio ? e.codigo : 'INTERNO', mensaje: e.message, reintentable: negocio ? e.reintentable : true };
            bitacora({ traza_id: args.traza_id ?? null, cliente: cliente.id, herramienta: h.nombre, ok: false, error: error.codigo, mensaje: e.message, ms: Date.now() - inicio });
            if (!negocio) console.error(`[${grupo}] ${h.nombre}:`, e);
            return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error }) }] };
          }
        },
      );
    }
    return servidor;
  };
  const atender = toNodeHandler(createMcpHandler(fabrica));

  async function emitir(cuerpo) {
    let datos;
    try {
      datos = cuerpo.trim().startsWith('{') ? JSON.parse(cuerpo) : Object.fromEntries(new URLSearchParams(cuerpo));
    } catch {
      return [400, { error: 'invalid_request' }];
    }
    if (datos.grant_type !== 'client_credentials') return [400, { error: 'unsupported_grant_type' }];
    const c = clientes[datos.client_id];
    if (!c || c.secreto !== datos.client_secret) return [401, { error: 'invalid_client' }];
    const pedidos = datos.scope ? String(datos.scope).split(' ') : c.alcances;
    if (pedidos.some((a) => !c.alcances.includes(a))) return [400, { error: 'invalid_scope' }];
    const token = emitirToken({ iss: grupo, aud: 'mcp', sub: datos.client_id, scope: pedidos.join(' ') }, secreto, 3600);
    bitacora({ cliente: datos.client_id, evento: 'token_emitido', alcances: pedidos });
    return [200, { access_token: token, token_type: 'Bearer', expires_in: 3600, scope: pedidos.join(' ') }];
  }

  const servidor = createServer(async (req, res) => {
    try {
      const ruta = new URL(req.url, 'http://x').pathname;
      if (req.method === 'GET' && ruta === '/salud') return responder(res, 200, { servicio: grupo, contrato: VERSION_CONTRATO, estado: 'ok' });
      if (req.method === 'POST' && ruta === '/oauth/token') {
        const [estado, datos] = await emitir(await leerCuerpo(req));
        return responder(res, estado, datos, { 'Cache-Control': 'no-store' });
      }
      if (req.method === 'GET' && ruta === '/bitacora') {
        const [tipo, token] = String(req.headers.authorization ?? '').split(' ');
        const carga = tipo === 'Bearer' ? verificarToken(token, secreto, { iss: grupo, aud: 'mcp' }) : null;
        if (!carga) return responder(res, 401, { error: 'Token ausente, inválido o vencido' }, { 'WWW-Authenticate': 'Bearer' });
        if (!carga.scope.split(' ').includes('auditoria')) return responder(res, 403, { error: 'Se requiere el alcance auditoria' });
        const traza = new URL(req.url, 'http://x').searchParams.get('traza_id');
        return responder(res, 200, { servicio: grupo, registros: bitacora.consultar(traza) });
      }
      if (ruta === '/mcp') {
        const [tipo, token] = String(req.headers.authorization ?? '').split(' ');
        const carga = tipo === 'Bearer' ? verificarToken(token, secreto, { iss: grupo, aud: 'mcp' }) : null;
        if (!carga) return responder(res, 401, { error: 'Token ausente, inválido o vencido' }, { 'WWW-Authenticate': 'Bearer' });
        const cuerpo = req.method === 'POST' ? await leerCuerpo(req) : '';
        let json;
        try { json = cuerpo ? JSON.parse(cuerpo) : undefined; } catch { return responder(res, 400, { error: 'JSON inválido' }); }
        req.auth = { token, clientId: carga.sub, scopes: carga.scope.split(' '), extra: { cliente: { id: carga.sub, alcances: carga.scope.split(' ') } } };
        return await atender(req, res, json);
      }
      const propia = rutas[`${req.method} ${ruta}`] ?? Object.entries(rutas).find(([k]) => {
        const [m, patron] = k.split(' ');
        return m === req.method && patron.includes(':') && new RegExp('^' + patron.replace(/:\w+/g, '[^/]+') + '$').test(ruta);
      })?.[1];
      if (propia) return await propia({ req, res, ruta, cuerpo: req.method === 'GET' ? '' : await leerCuerpo(req) });
      responder(res, 404, { error: 'No existe la ruta' });
    } catch (e) {
      console.error(`[${grupo}]`, e);
      if (!res.headersSent) responder(res, 500, { error: 'Error interno' });
    }
  });
  return new Promise((resolver) => servidor.listen(puerto, () => resolver({ servidor, bitacora })));
}
