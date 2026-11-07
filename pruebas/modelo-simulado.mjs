// Modelo de lenguaje SIMULADO, compatible con la API de OpenAI, para probar los agentes sin un modelo real.
// - Con response_format json_schema "diagnostico": arma un diagnóstico a partir de los códigos y síntomas.
// - Con herramientas: sigue un guion (lista de respuestas) y reemplaza {{campo}} con datos de los
//   resultados de herramientas anteriores (orden_id, opcion_id recomendada, url de pago).
//   node pruebas/modelo-simulado.mjs [puerto]
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

// json: respuestas para otros esquemas con nombre (por ejemplo { ingreso: (mensajes) => ({...}) }).
export function crearModeloSimulado({ guion = [], diagnosticoInvalidoPrimero = false, json = {} } = {}) {
  let paso = 0, invalidos = diagnosticoInvalidoPrimero ? 1 : 0;
  const peticiones = [];
  const valorDe = (mensajes, campo) => {
    for (const m of [...mensajes].reverse()) {
      if (m.role !== 'tool') continue;
      let d; try { d = JSON.parse(m.content); } catch { continue; }
      if (campo === 'orden_id' && d.orden_id) return d.orden_id;
      if (campo === 'opcion_id' && d.recomendacion?.opcion_id) return d.recomendacion.opcion_id;
      if (campo === 'url_pago' && d.ventas?.[0]?.url_pago) return d.ventas[0].url_pago;
      if (campo === 'error' && d.error) return d.error.codigo;
    }
    return `{{${campo}}}`;
  };
  const rellenar = (obj, mensajes) => JSON.parse(JSON.stringify(obj).replace(/\{\{(\w+)\}\}/g, (_, c) => valorDe(mensajes, c)));
  const servidor = createServer((req, res) => {
    let cuerpo = '';
    req.on('data', (x) => (cuerpo += x));
    req.on('end', () => {
      const responder = (d) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(d)); };
      if (req.url.endsWith('/models')) return responder({ data: [{ id: 'simulado' }] });
      const b = JSON.parse(cuerpo);
      peticiones.push(b);
      const uso = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };
      const esquema = b.response_format?.json_schema?.name;
      if (esquema && json[esquema]) {
        const d = typeof json[esquema] === 'function' ? json[esquema](b.messages) : json[esquema];
        return responder({ choices: [{ message: { role: 'assistant', content: JSON.stringify(d) } }], usage: uso });
      }
      if (esquema === 'diagnostico') {
        if (invalidos-- > 0) return responder({ choices: [{ message: { role: 'assistant', content: '{"hallazgos": "no es una lista"}' } }], usage: uso });
        const u = (b.messages.find((x) => x.role === 'user')?.content ?? '').toLowerCase();
        const d = /p030\d/.test(u)
          ? { hallazgos: ['Falla de encendido por bujías desgastadas y bobina débil'], requerimientos: [{ categoria: 'bujia', cantidad: 4, justificacion: 'Juego completo' }, { categoria: 'bobina_encendido', cantidad: 1, justificacion: 'Chispa débil' }], mano_obra_horas: 1.5, confianza: 0.82, requiere_revision_humana: false }
          : { hallazgos: ['No hay información suficiente'], requerimientos: [], mano_obra_horas: 1, confianza: 0.3, requiere_revision_humana: true };
        return responder({ choices: [{ message: { role: 'assistant', content: JSON.stringify(d) } }], usage: uso });
      }
      const siguiente = guion[paso++] ?? { content: 'Fin del guion.' };
      const m = rellenar(siguiente, b.messages);
      const mensaje = m.tool_calls
        ? { role: 'assistant', content: '', tool_calls: m.tool_calls.map((c, i) => ({ id: `llamada-${paso}-${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) }
        : { role: 'assistant', content: m.content };
      responder({ choices: [{ message: mensaje, finish_reason: m.tool_calls ? 'tool_calls' : 'stop' }], usage: uso });
    });
  });
  return { servidor, peticiones, reiniciar: (g) => { guion = g; paso = 0; }, fijarJson: (j) => { json = j; } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const puerto = Number(process.argv[2] ?? 4180);
  crearModeloSimulado().servidor.listen(puerto, () => console.log(`modelo simulado en http://localhost:${puerto}/v1`));
}
