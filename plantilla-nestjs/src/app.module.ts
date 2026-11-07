import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { SECRETO_JWT } from './config.js';
import { BitacoraController, BitacoraService } from './mcp/bitacora.service.js';
import { McpController } from './mcp/mcp.controller.js';
import { OauthController } from './mcp/oauth.controller.js';
import { HerramientasService } from './negocio/herramientas.service.js';
import { RagService } from './rag/rag.service.js';
import { SaludController } from './salud.controller.js';

@Module({
  imports: [JwtModule.register({ secret: SECRETO_JWT })],
  controllers: [SaludController, OauthController, McpController, BitacoraController],
  providers: [HerramientasService, BitacoraService, RagService],
})
export class AppModule {}
