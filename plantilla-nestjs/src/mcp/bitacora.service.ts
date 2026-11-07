import {
  Controller,
  Get,
  Headers,
  HttpException,
  Injectable,
  Query,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { GRUPO } from '../config.js';

export interface Registro {
  ts: string;
  servicio: string;
  traza_id: string | null;
  [campo: string]: unknown;
}

// Bitácora del servicio. El controlador MCP registra cada llamada; registre aquí también los eventos
// de negocio (por ejemplo, ventas: "venta_liquidada", "webhook_duplicado_ignorado").
// En producción, guárdela en una tabla de PostgreSQL; aquí vive en memoria.
@Injectable()
export class BitacoraService {
  private readonly registros: Registro[] = [];

  registrar(datos: { traza_id: string | null } & Record<string, unknown>) {
    this.registros.push({ ...datos, ts: new Date().toISOString(), servicio: GRUPO });
    if (this.registros.length > 50_000) this.registros.splice(0, 10_000);
  }

  consultar(traza_id?: string) {
    return this.registros.filter((r) => !traza_id || r.traza_id === traza_id);
  }
}

// GET /bitacora?traza_id=... para el cliente "auditor" (alcance auditoria). La usan las pruebas y la traza.
@Controller('bitacora')
export class BitacoraController {
  constructor(
    private readonly jwt: JwtService,
    private readonly bitacora: BitacoraService,
  ) {}

  @Get()
  async leer(
    @Headers('authorization') autorizacion: string | undefined,
    @Query('traza_id') traza_id?: string,
  ) {
    const [tipo, token] = String(autorizacion ?? '').split(' ');
    let carga: { scope: string };
    try {
      if (tipo !== 'Bearer') throw new Error();
      carga = await this.jwt.verifyAsync(token, { issuer: GRUPO, audience: 'mcp' });
    } catch {
      throw new HttpException({ error: 'Token ausente, inválido o vencido' }, 401);
    }
    if (!carga.scope.split(' ').includes('auditoria'))
      throw new HttpException({ error: 'Se requiere el alcance auditoria' }, 403);
    return { servicio: GRUPO, registros: this.bitacora.consultar(traza_id) };
  }
}
