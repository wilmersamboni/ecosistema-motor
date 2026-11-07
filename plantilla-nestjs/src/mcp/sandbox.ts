import { HttpException } from '@nestjs/common';

// Rutas de laboratorio (/sandbox/...): solo con SANDBOX=1 y la cabecera X-Sandbox-Llave correcta.
// Los proveedores (tienda y concesionario) deben publicar POST /sandbox/vencer/:reserva_id y
// POST /sandbox/reabastecer (ver contrato/REGLAS.md). Llame esta función al comienzo de cada una.
export function exigirSandbox(llave: string | undefined) {
  const activo = (process.env.SANDBOX ?? '1') === '1';
  if (!activo || llave !== (process.env.SANDBOX_LLAVE || 'lab-sandbox')) {
    throw new HttpException({ error: 'Sandbox deshabilitado o llave inválida' }, 403);
  }
}
