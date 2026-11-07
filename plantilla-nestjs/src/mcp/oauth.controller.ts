import {
  Body,
  Controller,
  Header,
  HttpCode,
  HttpException,
  Post,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { CLIENTES, GRUPO } from '../config.js';

// OAuth 2.0, concesión client_credentials (RFC 6749, sección 4.4): un servicio se identifica con su
// client_id y su secreto, y recibe un token de una hora con los alcances que el contrato le permite.
@Controller('oauth')
export class OauthController {
  constructor(private readonly jwt: JwtService) {}

  @Post('token')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async token(@Body() datos: Record<string, string>) {
    if (datos?.grant_type !== 'client_credentials')
      throw new HttpException({ error: 'unsupported_grant_type' }, 400);
    const cliente = CLIENTES[datos.client_id];
    if (!cliente || cliente.secreto !== datos.client_secret)
      throw new HttpException({ error: 'invalid_client' }, 401);
    const pedidos = datos.scope ? datos.scope.split(' ') : cliente.alcances;
    if (pedidos.some((a) => !cliente.alcances.includes(a)))
      throw new HttpException({ error: 'invalid_scope' }, 400);
    const access_token = await this.jwt.signAsync(
      { sub: datos.client_id, scope: pedidos.join(' ') },
      { issuer: GRUPO, audience: 'mcp', expiresIn: 3600 },
    );
    return {
      access_token,
      token_type: 'Bearer',
      expires_in: 3600,
      scope: pedidos.join(' '),
    };
  }
}
