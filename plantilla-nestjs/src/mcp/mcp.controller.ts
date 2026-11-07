import { All, Controller, Req, Res } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import type { Request, Response } from 'express';
import { GRUPO } from '../config.js';
import { VERSION_CONTRATO } from '../contrato/esquemas.js';
import { herramientasDe } from '../contrato/herramientas.js';
import { ErrorNegocio } from '../negocio/errores.js';
import { HerramientasService } from '../negocio/herramientas.service.js';
import { BitacoraService } from './bitacora.service.js';

interface Cliente {
  id: string;
  alcances: string[];
}

// Servidor MCP del grupo. Cada petición crea un servidor con SOLO las herramientas que permiten los
// alcances del token: una herramienta que no se publica no se puede llamar.
@Controller('mcp')
export class McpController {
  private readonly atender;

  constructor(
    private readonly jwt: JwtService,
    herramientas: HerramientasService,
    bitacora: BitacoraService,
  ) {
    const fabrica = ({
      authInfo,
    }: {
      authInfo?: { extra?: Record<string, unknown> };
    }) => {
      const cliente = authInfo?.extra?.cliente as Cliente;
      const servidor = new McpServer({
        name: `motorred-${GRUPO}`,
        version: VERSION_CONTRATO,
      });
      for (const h of herramientasDe(GRUPO)) {
        const alcances = Array.isArray(h.alcance) ? h.alcance : [h.alcance];
        if (!alcances.some((a) => cliente.alcances.includes(a))) continue;
        servidor.registerTool(
          h.nombre,
          {
            title: h.nombre,
            description: h.descripcion,
            inputSchema: h.entrada,
            outputSchema: h.salida,
            annotations: h.anotaciones,
          },
          async (args: Record<string, unknown>) => {
            const inicio = Date.now();
            const traza = (args.traza_id as string | undefined) ?? null;
            try {
              const ctx = { cliente: cliente.id, alcances: cliente.alcances };
              const resultado = (await herramientas.ejecutar(
                h.nombre,
                args,
                ctx,
              )) as Record<string, unknown>;
              const traza_id =
                traza ?? (resultado?.traza_id as string | undefined) ?? null;
              bitacora.registrar({
                traza_id,
                cliente: cliente.id,
                herramienta: h.nombre,
                ok: true,
                ms: Date.now() - inicio,
              });
              return {
                content: [{ type: 'text' as const, text: JSON.stringify(resultado) }],
                structuredContent: resultado,
              };
            } catch (e) {
              const negocio = e instanceof ErrorNegocio;
              const error = {
                codigo: negocio ? e.codigo : 'INTERNO',
                mensaje: (e as Error).message,
                reintentable: negocio ? e.reintentable : true,
              };
              bitacora.registrar({
                traza_id: traza,
                cliente: cliente.id,
                herramienta: h.nombre,
                ok: false,
                error: error.codigo,
                ms: Date.now() - inicio,
              });
              return {
                isError: true,
                content: [{ type: 'text' as const, text: JSON.stringify({ error }) }],
              };
            }
          },
        );
      }
      return servidor;
    };
    this.atender = toNodeHandler(createMcpHandler(fabrica as never));
  }

  @All()
  async manejar(@Req() req: Request & { auth?: unknown }, @Res() res: Response) {
    const [tipo, token] = String(req.headers.authorization ?? '').split(' ');
    let carga: { sub: string; scope: string };
    try {
      if (tipo !== 'Bearer') throw new Error();
      carga = await this.jwt.verifyAsync(token, { issuer: GRUPO, audience: 'mcp' });
    } catch {
      res.setHeader('WWW-Authenticate', 'Bearer');
      res.status(401).json({ error: 'Token ausente, inválido o vencido' });
      return;
    }
    const cliente: Cliente = { id: carga.sub, alcances: carga.scope.split(' ') };
    req.auth = {
      token,
      clientId: cliente.id,
      scopes: cliente.alcances,
      extra: { cliente },
    };
    await this.atender(req as never, res, req.body);
  }
}
