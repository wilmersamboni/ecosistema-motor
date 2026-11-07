// Simulador del grupo José: tienda de repuestos.   node simuladores/tienda.mjs
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PARAMETROS, PUERTOS, clientesDe, secretoJwt } from '../lib/config.mjs';
import { crearServicio } from '../lib/servicio.mjs';
import { crearProveedor } from './proveedor.mjs';

export async function iniciar(puerto = PUERTOS.tienda) {
  const catalogo = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'datos', 'catalogo-tienda.json'), 'utf8'));
  const { implementacion, rutas } = crearProveedor('tienda', catalogo, PARAMETROS);
  await crearServicio({
    grupo: 'tienda', puerto, secreto: secretoJwt('tienda'), clientes: clientesDe('tienda'), implementacion, rutas,
    instrucciones: 'Tienda de repuestos homologados y genéricos con entrega en el día.',
  });
  return puerto;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(`tienda en el puerto ${await iniciar()}`);
