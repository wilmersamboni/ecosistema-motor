// Firma de webhooks: X-Firma: t=<segundos>,v1=<hmac_sha256(secreto, "t.cuerpo")>.
// El receptor rechaza firmas inválidas y las de más de 5 minutos (evita que se reenvíe un evento viejo).
import { createHmac, timingSafeEqual } from 'node:crypto';

export function firmarEvento(cuerpo, secreto, t = Math.floor(Date.now() / 1000)) {
  const v1 = createHmac('sha256', secreto).update(`${t}.${cuerpo}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

export function verificarFirma(cuerpo, cabecera, secreto, toleranciaSegundos = 300) {
  const partes = Object.fromEntries(String(cabecera ?? '').split(',').map((p) => p.split('=')));
  const t = Number(partes.t);
  if (!t || !partes.v1 || Math.abs(Date.now() / 1000 - t) > toleranciaSegundos) return false;
  const esperada = Buffer.from(createHmac('sha256', secreto).update(`${t}.${cuerpo}`).digest('hex'));
  const recibida = Buffer.from(partes.v1);
  return esperada.length === recibida.length && timingSafeEqual(esperada, recibida);
}
