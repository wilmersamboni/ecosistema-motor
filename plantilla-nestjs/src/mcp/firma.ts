import { createHmac, timingSafeEqual } from 'node:crypto';

// Verifica X-Firma / X-Pasarela-Firma: "t=<segundos>,v1=<hmac_sha256(secreto, t.cuerpo)>".
// Use el cuerpo CRUDO (req.rawBody), no el JSON ya interpretado: un espacio de diferencia cambia la firma.
export function verificarFirma(
  cuerpo: string,
  cabecera: string | undefined,
  secreto: string,
  tolerancia = 300,
): boolean {
  const partes = Object.fromEntries(
    String(cabecera ?? '')
      .split(',')
      .map((p) => p.split('=')),
  );
  const t = Number(partes.t);
  if (!t || !partes.v1 || Math.abs(Date.now() / 1000 - t) > tolerancia) return false;
  const esperada = Buffer.from(
    createHmac('sha256', secreto).update(`${t}.${cuerpo}`).digest('hex'),
  );
  const recibida = Buffer.from(String(partes.v1));
  return esperada.length === recibida.length && timingSafeEqual(esperada, recibida);
}
