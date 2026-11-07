import { Injectable } from '@nestjs/common';
import { GRUPO } from '../config.js';
import { ErrorNegocio } from './errores.js';

export interface Contexto {
  cliente: string; // client_id de quien llama (taller, ventas, app)
  alcances: string[]; // alcances del token
}

// AQUÍ VA EL TRABAJO DEL GRUPO: un caso por cada herramienta de su grupo.
// Llame a sus servicios de NestJS (TypeORM y PostgreSQL, como en espiga-pro) y
// devuelva un objeto que cumpla el esquema de salida del contrato.
// El controlador MCP valida las entradas y las salidas.
@Injectable()
export class HerramientasService {
  async ejecutar(
    nombre: string,
    args: Record<string, unknown>,
    ctx: Contexto,
  ): Promise<unknown> {
    switch (nombre) {
      // case 'buscar_repuestos':
      //   return this.catalogo.buscar(args, ctx);
      default:
        throw new ErrorNegocio(
          'INTERNO',
          `${GRUPO}: falta implementar ${nombre} (cliente ${ctx.cliente})`,
        );
    }
  }
}
