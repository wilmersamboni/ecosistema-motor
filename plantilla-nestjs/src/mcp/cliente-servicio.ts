import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { ErrorNegocio } from '../negocio/errores.js';

const pausa = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Cliente para llamar herramientas de OTRO grupo: pide un token con sus credenciales de servicio,
// se conecta por MCP, convierte los errores del contrato en ErrorNegocio y reintenta los reintentables.
// Ejemplo (taller → tienda):
//   const tienda = new ClienteServicio({ destino: 'tienda', url: process.env.URL_TIENDA!, clientId: 'taller',
//     clientSecret: process.env.CLIENTE_TALLER_EN_TIENDA!, alcances: ['proveedor.cotizar', 'proveedor.reservar'] });
//   const { ofertas } = await tienda.llamar<{ ofertas: unknown[] }>('buscar_repuestos', { ... });
export class ClienteServicio {
  private mcp: Client | null = null;
  private vence = 0;

  constructor(
    private readonly opciones: {
      destino: string;
      url: string;
      clientId: string;
      clientSecret: string;
      alcances: string[];
    },
  ) {}

  private async token(): Promise<string> {
    const { url, clientId, clientSecret, alcances, destino } = this.opciones;
    const r = await fetch(`${url}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
        scope: alcances.join(' '),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const datos = (await r.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
    };
    if (!r.ok || !datos.access_token)
      throw new ErrorNegocio(
        'NO_AUTORIZADO',
        `${destino} rechazó las credenciales: ${datos.error ?? r.status}`,
      );
    this.vence = Date.now() + ((datos.expires_in ?? 3600) - 60) * 1000;
    return datos.access_token;
  }

  private async conectar(): Promise<Client> {
    if (this.mcp && Date.now() < this.vence) return this.mcp;
    await this.mcp?.close().catch(() => {});
    const transporte = new StreamableHTTPClientTransport(
      new URL(`${this.opciones.url}/mcp`),
      {
        requestInit: { headers: { Authorization: `Bearer ${await this.token()}` } },
      },
    );
    const mcp = new Client(
      { name: `cliente-${this.opciones.clientId}`, version: '1.0.0' },
      { versionNegotiation: { mode: 'auto' } } as never,
    );
    await mcp.connect(transporte);
    this.mcp = mcp;
    return mcp;
  }

  async llamar<T = Record<string, unknown>>(
    nombre: string,
    args: Record<string, unknown>,
    reintentos = 2,
  ): Promise<T> {
    for (let intento = 0; ; intento++) {
      let r: { isError?: boolean; structuredContent?: unknown; content?: unknown };
      try {
        r = (await (
          await this.conectar()
        ).callTool({ name: nombre, arguments: args })) as typeof r;
      } catch (e) {
        this.mcp = null;
        if (e instanceof ErrorNegocio) throw e;
        const error = /not found/i.test((e as Error).message)
          ? new ErrorNegocio(
              'NO_AUTORIZADO',
              `${this.opciones.destino} no publica ${nombre} para este cliente`,
            )
          : new ErrorNegocio(
              'PROVEEDOR_NO_DISPONIBLE',
              `${this.opciones.destino} no respondió: ${(e as Error).message}`,
              true,
            );
        if (!error.reintentable || intento >= reintentos) throw error;
        await pausa(200 * 2 ** intento);
        continue;
      }
      const texto = (r.content as { text?: string }[] | undefined)?.[0]?.text ?? '{}';
      if (!r.isError) return (r.structuredContent ?? JSON.parse(texto)) as T;
      let detalle:
        | { codigo: string; mensaje: string; reintentable: boolean }
        | undefined;
      try {
        detalle = JSON.parse(texto).error;
      } catch {
        detalle = undefined;
      }
      const error = detalle
        ? new ErrorNegocio(detalle.codigo, detalle.mensaje, detalle.reintentable)
        : new ErrorNegocio('DATOS_INVALIDOS', texto);
      if (!error.reintentable || intento >= reintentos) throw error;
      await pausa(200 * 2 ** intento);
    }
  }
}
