// Cliente de servicio: obtiene un token con sus credenciales, se conecta por MCP a otro grupo y llama
// herramientas. Convierte los errores del contrato en ErrorNegocio y reintenta los reintentables.
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { ErrorNegocio } from './errores.mjs';

const pausa = (ms) => new Promise((r) => setTimeout(r, ms));

export class ClienteServicio {
  constructor({ destino, url, clientId, clientSecret, alcances }) {
    Object.assign(this, { destino, url: url.replace(/\/$/, ''), clientId, clientSecret, alcances });
    this.mcp = null;
    this.vence = 0;
  }

  async token() {
    const r = await fetch(`${this.url}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'client_credentials', client_id: this.clientId, client_secret: this.clientSecret, scope: this.alcances?.join(' ') }),
      signal: AbortSignal.timeout(10_000),
    });
    const datos = await r.json().catch(() => ({}));
    if (!r.ok) throw new ErrorNegocio('NO_AUTORIZADO', `${this.destino} rechazó las credenciales: ${datos.error ?? r.status}`);
    this.vence = Date.now() + (datos.expires_in - 60) * 1000;
    return datos.access_token;
  }

  async conectar() {
    if (this.mcp && Date.now() < this.vence) return this.mcp;
    await this.mcp?.close().catch(() => {});
    const token = await this.token();
    const transporte = new StreamableHTTPClientTransport(new URL(`${this.url}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    const mcp = new Client({ name: `cliente-${this.clientId}`, version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
    await mcp.connect(transporte);
    this.mcp = mcp;
    return mcp;
  }

  async herramientas() {
    return (await (await this.conectar()).listTools()).tools;
  }

  // Devuelve el resultado estructurado o lanza ErrorNegocio con el código del contrato.
  async llamar(nombre, args, { reintentos = 2, esperaMs = 20_000 } = {}) {
    for (let intento = 0; ; intento++) {
      let r;
      try {
        const mcp = await this.conectar();
        r = await Promise.race([
          mcp.callTool({ name: nombre, arguments: args }),
          pausa(esperaMs).then(() => { throw new Error('tiempo de espera agotado'); }),
        ]);
      } catch (e) {
        this.mcp = null;
        if (e instanceof ErrorNegocio) throw e;
        const sinHerramienta = /not found/i.test(e.message);
        const error = sinHerramienta
          ? new ErrorNegocio('NO_AUTORIZADO', `${this.destino} no publica ${nombre} para este cliente`)
          : new ErrorNegocio('PROVEEDOR_NO_DISPONIBLE', `${this.destino} no respondió: ${e.message}`, true);
        if (!error.reintentable || intento >= reintentos) throw error;
        await pausa(200 * 2 ** intento);
        continue;
      }
      if (!r.isError) return r.structuredContent ?? JSON.parse(r.content?.[0]?.text ?? '{}');
      let detalle;
      try { detalle = JSON.parse(r.content?.[0]?.text ?? '').error; } catch { detalle = null; }
      const error = detalle
        ? new ErrorNegocio(detalle.codigo, detalle.mensaje, detalle.reintentable)
        : new ErrorNegocio('DATOS_INVALIDOS', r.content?.[0]?.text ?? 'Error sin detalle');
      if (!error.reintentable || intento >= reintentos) throw error;
      await pausa(200 * 2 ** intento);
    }
  }

  async cerrar() {
    await this.mcp?.close().catch(() => {});
    this.mcp = null;
  }
}
