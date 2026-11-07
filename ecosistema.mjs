// Inicia los simuladores del ecosistema MotorRed en un solo proceso.
//   node ecosistema.mjs                     los cinco servicios
//   node ecosistema.mjs --sin tienda        todos menos la tienda (para conectar el servicio real del grupo;
//                                           ponga su dirección en URL_TIENDA del archivo .env)
import { PUERTOS, URLS } from './lib/config.mjs';

// Acepta --sin tienda,ventas   --sin "tienda,ventas"   y también --sin tienda ventas (como lo pasa PowerShell).
const i = process.argv.indexOf('--sin');
const sin = i < 0 ? [] : process.argv.slice(i + 1).filter((a) => !a.startsWith('--')).flatMap((a) => a.split(',')).map((a) => a.trim()).filter(Boolean);
const orden = ['pasarela', 'tienda', 'concesionario', 'ventas', 'taller'];
for (const nombre of orden) {
  if (sin.includes(nombre)) {
    console.log(`- ${nombre.padEnd(14)} NO se inicia: se usará ${URLS[nombre]}`);
    continue;
  }
  const { iniciar } = await import(`./simuladores/${nombre}.mjs`);
  await iniciar(PUERTOS[nombre]);
  console.log(`- ${nombre.padEnd(14)} ${URLS[nombre]}`);
}
console.log('Ecosistema MotorRed listo. Detenga con Ctrl+C. Bitácoras en la carpeta bitacora/.');
