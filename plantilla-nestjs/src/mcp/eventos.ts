import { createHmac } from 'node:crypto';

// Envía un evento firmado (webhook) con reintentos. Úselo, por ejemplo, desde ventas hacia el taller.
export async function enviarEvento(
  url: string,
  evento: Record<string, unknown>,
  secreto: string,
  intentos = 4,
): Promise<boolean> {
  const cuerpo = JSON.stringify(evento);
  for (let i = 0; i < intentos; i++) {
    const t = Math.floor(Date.now() / 1000);
    const firma = `t=${t},v1=${createHmac('sha256', secreto).update(`${t}.${cuerpo}`).digest('hex')}`;
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Firma': firma },
        body: cuerpo,
        signal: AbortSignal.timeout(10_000),
      });
      if (r.ok) return true;
    } catch {
      // se reintenta
    }
    await new Promise((r) => setTimeout(r, 300 * 2 ** i));
  }
  return false;
}
