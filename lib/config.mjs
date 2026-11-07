// Configuración del ecosistema. Lee .env (si existe) y completa con valores de laboratorio.
// En producción cada grupo guarda SOLO sus secretos; aquí están todos porque los simuladores corren juntos.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PERMISOS } from '../contrato/herramientas.mjs';

const RAIZ = join(import.meta.dirname, '..');
if (existsSync(join(RAIZ, '.env'))) process.loadEnvFile(join(RAIZ, '.env'));
const v = (nombre, porDefecto) => process.env[nombre] || porDefecto;

export const PUERTOS = {
  taller: Number(v('PUERTO_TALLER', 4101)),
  tienda: Number(v('PUERTO_TIENDA', 4102)),
  concesionario: Number(v('PUERTO_CONCESIONARIO', 4103)),
  ventas: Number(v('PUERTO_VENTAS', 4104)),
  pasarela: Number(v('PUERTO_PASARELA', 4199)),
};
// La dirección de cada grupo. Para conectar el servicio real de un grupo, cambie su URL_ en .env.
export const URLS = Object.fromEntries(
  Object.entries(PUERTOS).map(([g, p]) => [g, v(`URL_${g.toUpperCase()}`, `http://localhost:${p}`)]),
);

// Secreto con que cada servicio firma sus propios tokens.
export const secretoJwt = (grupo) => v(`SECRETO_JWT_${grupo.toUpperCase()}`, `lab-jwt-${grupo}-cambie-esto`);
// Clave del cliente <cliente> en el servidor <servidor>: CLIENTE_TALLER_EN_TIENDA, etc.
export const credencial = (cliente, servidor) =>
  v(`CLIENTE_${cliente.toUpperCase()}_EN_${servidor.toUpperCase()}`, `lab-${cliente}-en-${servidor}`);

// Clientes que acepta un servidor, con los alcances que el contrato les permite.
export function clientesDe(servidor) {
  return Object.fromEntries(
    Object.entries(PERMISOS[servidor] ?? {}).map(([cliente, alcances]) => [cliente, { secreto: credencial(cliente, servidor), alcances }]),
  );
}

export const FIRMA = {
  ventas: v('FIRMA_EVENTOS_VENTAS', 'lab-firma-ventas-cambie-esto'),
  pasarela: v('FIRMA_EVENTOS_PASARELA', 'lab-firma-pasarela-cambie-esto'),
};
// Dirección de la pasarela que ve el navegador del cliente (en Docker, distinta de la interna).
export const PASARELA_URL_PUBLICA = v('PASARELA_URL_PUBLICA', URLS.pasarela);
export const PASARELA_LLAVE = v('PASARELA_LLAVE', 'lab-llave-pasarela');
export const PASARELA_DUPLICAR = v('PASARELA_DUPLICAR', '1') === '1';

// Parámetros comerciales y tributarios. VALORES DE PRÁCTICA: confírmelos con un contador,
// porque las tarifas y las bases cambian por decreto (ver el instructivo).
export const PARAMETROS = {
  valor_hora_taller: Number(v('VALOR_HORA_TALLER', 95000)),
  iva_porcentaje: Number(v('IVA_PORCENTAJE', 19)),
  comision_porcentaje: Number(v('COMISION_PORCENTAJE', 3)),
  uvt: Number(v('UVT', 52374)),
  retefuente: {
    servicio: { tarifa: Number(v('RETEFUENTE_SERVICIOS', 4)), base_uvt: Number(v('RETEFUENTE_SERVICIOS_BASE_UVT', 2)) },
    repuesto: { tarifa: Number(v('RETEFUENTE_COMPRAS', 2.5)), base_uvt: Number(v('RETEFUENTE_COMPRAS_BASE_UVT', 10)) },
  },
};
