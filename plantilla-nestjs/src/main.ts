import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { GRUPO, PUERTO } from './config.js';

// rawBody: true guarda el cuerpo original de cada petición en req.rawBody, necesario para verificar
// la firma de los webhooks.
const app = await NestFactory.create<NestExpressApplication>(AppModule, {
  rawBody: true,
});
app.useBodyParser('urlencoded', { extended: false });
await app.listen(PUERTO);
console.log(`Servicio ${GRUPO} de MotorRed en http://localhost:${PUERTO}`);
