import { Controller, Get } from '@nestjs/common';
import { GRUPO } from './config.js';
import { VERSION_CONTRATO } from './contrato/esquemas.js';

@Controller('salud')
export class SaludController {
  @Get()
  salud() {
    return { servicio: GRUPO, contrato: VERSION_CONTRATO, estado: 'ok' };
  }
}
