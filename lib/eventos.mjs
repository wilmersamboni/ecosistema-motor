// Envío de eventos firmados (webhooks) con reintentos y espera creciente. No bloquea a quien lo llama.
import { firmarEvento } from './firma.mjs';

const pausa = (ms) => new Promise((r) => setTimeout(r, ms));

export async function enviarEvento(url, evento, secreto, { intentos = 4, cabecera = 'X-Firma', bitacora } = {}) {
  const cuerpo = JSON.stringify(evento);
  for (let i = 0; i < intentos; i++) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [cabecera]: firmarEvento(cuerpo, secreto) },
        body: cuerpo,
        signal: AbortSignal.timeout(10_000),
      });
      bitacora?.({ traza_id: evento.traza_id ?? null, evento: `enviado ${evento.tipo}`, destino: url, http: r.status, intento: i + 1 });
      if (r.ok) return true;
    } catch (e) {
      bitacora?.({ traza_id: evento.traza_id ?? null, evento: `fallo envío ${evento.tipo}`, destino: url, error: e.message, intento: i + 1 });
    }
    await pausa(300 * 2 ** i);
  }
  return false;
}
