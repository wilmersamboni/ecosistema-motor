import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PERMISOS } from './contrato/herramientas.js';

// Lee el .env de esta carpeta. Los valores por defecto coinciden con los del kit del ecosistema.
export const RAIZ = join(import.meta.dirname, '..');
if (existsSync(join(RAIZ, '.env'))) process.loadEnvFile(join(RAIZ, '.env'));
const v = (nombre: string, porDefecto: string) => process.env[nombre] || porDefecto;

export const GRUPO = v('GRUPO', 'tienda');
if (!PERMISOS[GRUPO])
  throw new Error(
    `GRUPO debe ser taller, tienda, concesionario o ventas (llegó ${GRUPO})`,
  );
export const PUERTO = Number(v('PUERTO', '3000'));
export const SECRETO_JWT = v(
  `SECRETO_JWT_${GRUPO.toUpperCase()}`,
  `lab-jwt-${GRUPO}-cambie-esto`,
);

// Clientes de servicio que acepta este grupo: CLIENTE_<CLIENTE>_EN_<GRUPO>=secreto
export const CLIENTES: Record<string, { secreto: string; alcances: string[] }> =
  Object.fromEntries(
    Object.entries(PERMISOS[GRUPO]).map(([cliente, alcances]) => [
      cliente,
      {
        secreto: v(
          `CLIENTE_${cliente.toUpperCase()}_EN_${GRUPO.toUpperCase()}`,
          `lab-${cliente}-en-${GRUPO}`,
        ),
        alcances,
      },
    ]),
  );
export const FIRMA_EVENTOS_VENTAS = v(
  'FIRMA_EVENTOS_VENTAS',
  'lab-firma-ventas-cambie-esto',
);
export const FIRMA_EVENTOS_PASARELA = v(
  'FIRMA_EVENTOS_PASARELA',
  'lab-firma-pasarela-cambie-esto',
);
