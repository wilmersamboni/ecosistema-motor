// Tokens JWT firmados con HMAC-SHA256 (HS256), sin dependencias. Cada servicio firma con su propio secreto.
import { createHmac, timingSafeEqual } from 'node:crypto';

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const firmar = (datos, secreto) => createHmac('sha256', secreto).update(datos).digest('base64url');

export function emitirToken(carga, secreto, segundos = 3600) {
  const ahora = Math.floor(Date.now() / 1000);
  const cuerpo = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ ...carga, iat: ahora, exp: ahora + segundos })}`;
  return `${cuerpo}.${firmar(cuerpo, secreto)}`;
}

// Devuelve la carga si la firma, el emisor, la audiencia y el vencimiento son válidos; si no, null.
export function verificarToken(token, secreto, { iss, aud }) {
  const partes = String(token ?? '').split('.');
  if (partes.length !== 3) return null;
  const esperada = Buffer.from(firmar(`${partes[0]}.${partes[1]}`, secreto));
  const recibida = Buffer.from(partes[2]);
  if (esperada.length !== recibida.length || !timingSafeEqual(esperada, recibida)) return null;
  let carga;
  try {
    const cabecera = JSON.parse(Buffer.from(partes[0], 'base64url'));
    if (cabecera.alg !== 'HS256') return null;
    carga = JSON.parse(Buffer.from(partes[1], 'base64url'));
  } catch {
    return null;
  }
  if (carga.iss !== iss || carga.aud !== aud || !(carga.exp > Date.now() / 1000)) return null;
  return carga;
}
