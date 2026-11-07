// Agente de referencia: un modelo de lenguaje que usa herramientas MCP de uno o varios servicios.
// Funciona con cualquier API compatible con OpenAI (Ollama en el equipo o un proveedor en la nube).
// Barandas incluidas: lista blanca de herramientas, confirmación humana para las que mueven dinero o
// compromisos, límite de pasos, detección de llamadas repetidas, resultados recortados, salida
// estructurada validada con zod y bitácora de cada decisión.
// Barandas para modelos pequeños (por ejemplo llama3.2 de 3B en Ollama), observadas en la práctica:
//  - escriben la llamada a la herramienta como texto JSON en vez de usar tool_calls: se convierte;
//  - mandan objetos o listas como cadenas con JSON adentro: se convierten según el inputSchema;
//  - omiten argumentos obligatorios o los mandan en null: se responde el error sin llamar al servicio;
//  - inventan precios: si la respuesta trae cifras en pesos que no salieron de una herramienta (ni del
//    cliente), se le pide corregir una vez y, si insiste, se reemplaza por un mensaje seguro.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const pausa = (ms) => new Promise((r) => setTimeout(r, ms));

export function modeloDesdeEntorno() {
  return {
    url: (process.env.LLM_URL || 'http://localhost:11434/v1').replace(/\/$/, ''),
    llave: process.env.LLM_LLAVE || 'ollama',
    modelo: process.env.LLM_MODELO || 'llama3.2',
  };
}

// Reintenta si no hay conexión o el proveedor responde 429. Si el modelo no termina a tiempo NO
// reintenta: un modelo local atascado (por ejemplo, generando espacios sin fin en modo JSON) se
// atascaría otra vez, y quien llama decide el plan B.
async function completar(modelo, cuerpo, { timeoutMs = 180_000 } = {}) {
  for (let intento = 0; ; intento++) {
    let r;
    try {
      r = await fetch(`${modelo.url}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${modelo.llave}` },
        body: JSON.stringify({ model: modelo.modelo, temperature: 0, ...cuerpo }),
        signal: AbortSignal.timeout(Math.max(1000, timeoutMs)),
      });
    } catch (e) {
      if (e.name === 'TimeoutError') throw new Error(`El modelo no respondió en ${Math.round(timeoutMs / 1000)} s`);
      if (intento >= 2) throw new Error(`No hay conexión con el modelo en ${modelo.url}: ${e.cause?.code ?? e.message}`);
      await pausa(1000 * 2 ** intento);
      continue;
    }
    if (r.status === 429 && intento < 3) { await pausa(2000 * 2 ** intento); continue; }
    if (!r.ok) throw new Error(`El modelo respondió HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
    try {
      return await r.json();
    } catch (e) {
      if (e.name === 'TimeoutError') throw new Error(`El modelo no respondió en ${Math.round(timeoutMs / 1000)} s`);
      throw e;
    }
  }
}

// Pide al modelo una respuesta que cumpla un esquema zod. Si no lo cumple, le devuelve los errores
// una vez para que corrija. Si vuelve a fallar, lanza el error: quien llama decide el plan B.
// limiteMs es el tiempo total para todos los intentos; maxTokens corta respuestas que no terminan.
export async function decidir(modelo, esquema, mensajes, { nombre = 'respuesta', intentos = 2, limiteMs = 180_000, maxTokens = 1200 } = {}) {
  const schema = z.toJSONSchema(esquema, { target: 'draft-7' });
  const historial = [...mensajes];
  const fin = Date.now() + limiteMs;
  let ultimo = '';
  for (let i = 0; i < intentos; i++) {
    if (Date.now() >= fin) break;
    const r = await completar(modelo, {
      messages: historial,
      max_tokens: maxTokens,
      response_format: { type: 'json_schema', json_schema: { name: nombre, strict: false, schema } },
    }, { timeoutMs: fin - Date.now() });
    const texto = limpiarContenido(r.choices?.[0]?.message?.content);
    const datos = parsearJSON(texto);
    const v = esquema.safeParse(datos);
    if (v.success) return { datos: v.data, uso: r.usage ?? null };
    ultimo = v.error.issues.slice(0, 5).map((x) => `${x.path.join('.') || '(raíz)'}: ${x.message}`).join('; ');
    historial.push({ role: 'assistant', content: texto }, { role: 'user', content: `Tu respuesta no cumple el esquema: ${ultimo}. Responde solo el JSON corregido.` });
  }
  throw new Error(ultimo ? `El modelo no produjo un JSON válido: ${ultimo}` : 'Se acabó el tiempo para decidir');
}

// Quita el razonamiento visible de modelos como qwen3 o deepseek-r1 y las cercas de código.
export function limpiarContenido(texto) {
  return String(texto ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

// Repara un error típico de modelos pequeños: una cadena abierta con \" fuera de otra cadena
// ("sintomas": \"texto\", ...). Fuera de una cadena una barra nunca es válida en JSON.
function repararComillas(t) {
  let r = '', dentro = false, conBarra = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i], sig = t[i + 1];
    if (!dentro) {
      if (c === '\\' && sig === '"') { r += '"'; dentro = true; conBarra = true; i++; continue; }
      if (c === '"') { dentro = true; conBarra = false; }
      r += c; continue;
    }
    if (c === '\\') {
      if (conBarra && sig === '"' && /^\s*[,}\]:]/.test(t.slice(i + 2))) { r += '"'; dentro = false; i++; continue; }
      r += c + (sig ?? ''); i++; continue;
    }
    if (c === '"') dentro = false;
    r += c;
  }
  return r;
}

function parsearJSON(texto) {
  const t = texto.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  for (const candidato of [t, t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1), t.slice(t.indexOf('['), t.lastIndexOf(']') + 1)]) {
    if (!candidato) continue;
    try { return JSON.parse(candidato); } catch { /* sigue */ }
    try { return JSON.parse(repararComillas(candidato)); } catch { /* sigue */ }
  }
  return undefined;
}

// Reconoce una llamada a herramienta escrita como texto: {"name": "...", "parameters": {...}},
// {"function": {"name", "arguments"}}, {"tool_calls": [...]} o una lista de ellas.
export function llamadasEnTexto(texto, nombres) {
  const datos = parsearJSON(texto);
  if (!datos || typeof datos !== 'object') return [];
  const lista = Array.isArray(datos) ? datos : Array.isArray(datos.tool_calls) ? datos.tool_calls : [datos];
  const resolver = (n) => {
    if (typeof n !== 'string') return null;
    if (nombres.includes(n)) return n;
    const sufijo = nombres.filter((x) => x.endsWith(`__${n}`));
    return sufijo.length === 1 ? sufijo[0] : n;
  };
  const llamadas = [];
  for (const x of lista) {
    const f = x?.function ?? x;
    const nombre = resolver(f?.name);
    if (!nombre) return [];
    const args = f.arguments ?? f.parameters ?? f.args ?? {};
    llamadas.push({ id: `texto-${randomUUID().slice(0, 8)}`, type: 'function', function: { name: nombre, arguments: typeof args === 'string' ? args : JSON.stringify(args) } });
  }
  return llamadas;
}

// Convierte cadenas con JSON adentro cuando el esquema espera objeto, lista, número o booleano.
export function normalizarArgumentos(valor, esquema = {}) {
  const tipos = [esquema.type, ...(esquema.anyOf ?? esquema.oneOf ?? []).map((x) => x.type)].flat().filter(Boolean);
  if (typeof valor === 'string' && tipos.length && !tipos.includes('string')) {
    const t = valor.trim();
    if (tipos.includes('object') || tipos.includes('array')) { const d = parsearJSON(t); if (d !== undefined) valor = d; }
    else if (tipos.includes('integer') || tipos.includes('number')) { if (/^-?\d+(\.\d+)?$/.test(t)) valor = Number(t); }
    else if (tipos.includes('boolean')) { if (t === 'true' || t === 'false') valor = t === 'true'; }
  }
  if (Array.isArray(valor) && esquema.items) return valor.map((v) => normalizarArgumentos(v, esquema.items));
  if (valor && typeof valor === 'object' && !Array.isArray(valor)) {
    const props = esquema.properties ?? (esquema.anyOf ?? []).find((x) => x.properties)?.properties ?? {};
    return Object.fromEntries(Object.entries(valor).map(([k, v]) => [k, props[k] ? normalizarArgumentos(v, props[k]) : v]));
  }
  return valor;
}

// Cifras en pesos de una respuesta (desde $1.000) que no aparecen en ningún resultado de herramienta ni
// en lo que dijo el cliente. Acepta 1.234.567, 1,234,567, $1234567 y $ 1.234.567.
export function cifrasNoRespaldadas(texto, mensajes) {
  const respaldo = new Set();
  for (const m of mensajes) {
    if (m.role !== 'tool' && m.role !== 'user') continue;
    if (String(m.content ?? '').startsWith('[Control automático')) continue;
    for (const n of String(m.content ?? '').match(/\d[\d.,]*/g) ?? []) respaldo.add(Number(n.replace(/\D/g, '')));
  }
  const cifras = (texto.match(/\$\s?\d[\d.,]*|\b\d{1,3}(?:[.,]\d{3})+\b|\b\d+(?:[.,]\d+)?\s?(?:pesos|COP)\b/gi) ?? [])
    .map((c) => ({ texto: c.trim(), valor: Number(c.replace(/[.,]\d{1,2}(?!\d)\s?(?:pesos|COP)?$/i, '').replace(/\D/g, '')) }))
    .filter((c) => c.valor >= 1000 && !respaldo.has(c.valor));
  return [...new Map(cifras.map((c) => [c.valor, c])).values()].map((c) => c.texto);
}

// Enlaces de la respuesta que no aparecen en ningún resultado de herramienta ni en lo que dijo el cliente
// (un enlace de pago inventado es tan grave como un precio inventado).
export function enlacesNoRespaldados(texto, mensajes) {
  const fuentes = mensajes.filter((m) => (m.role === 'tool' || m.role === 'user') && !String(m.content ?? '').startsWith('[Control automático')).map((m) => String(m.content ?? '')).join('\n');
  return [...new Set((texto.match(/https?:\/\/[^\s)<>"\]]+/g) ?? []).map((u) => u.replace(/[.,;:!?]+$/, '')))].filter((u) => !fuentes.includes(u));
}

const RESPUESTA_SEGURA = 'No tengo todavía una cotización ni un enlace de pago confirmados por el sistema. Permítame completar el registro y el diagnóstico, o un asesor humano lo contactará.';

export class Agente {
  // conexiones: [{ cliente: ClienteServicio, permitidas: ['cotizar', ...] }]
  // requierenConfirmacion: nombres de herramientas que solo se ejecutan si confirmar() devuelve true
  // verificarCifras: bloquea respuestas con valores en pesos que no salieron de una herramienta.
  constructor({ nombre, instrucciones, modelo = modeloDesdeEntorno(), conexiones, requierenConfirmacion = [], confirmar = async () => false, maxPasos = 10, bitacora = () => {}, verificarCifras = true, timeoutMs = 180_000 }) {
    Object.assign(this, { nombre, instrucciones, modelo, conexiones, requierenConfirmacion, confirmar, maxPasos, bitacora, verificarCifras, timeoutMs });
    this.mapa = null;
  }

  async herramientas() {
    if (this.mapa) return this.mapa;
    this.mapa = new Map();
    for (const { cliente, permitidas } of this.conexiones) {
      for (const t of await cliente.herramientas()) {
        if (!permitidas.includes(t.name)) continue;
        this.mapa.set(`${cliente.destino}__${t.name}`, { cliente, nombre: t.name, definicion: t });
      }
    }
    return this.mapa;
  }

  // Ejecuta un turno: el modelo puede llamar herramientas varias veces antes de responder.
  async turno(historial, mensaje) {
    const mapa = await this.herramientas();
    const tools = [...mapa.entries()].map(([id, h]) => ({
      type: 'function',
      function: { name: id, description: h.definicion.description, parameters: h.definicion.inputSchema },
    }));
    const mensajes = [{ role: 'system', content: this.instrucciones }, ...historial, { role: 'user', content: mensaje }];
    const pasos = [];
    const vistas = new Map();
    const correcciones = [];
    for (let paso = 0; paso < this.maxPasos; paso++) {
      const inicio = Date.now();
      const r = await completar(this.modelo, { messages: mensajes, tools, tool_choice: 'auto' }, { timeoutMs: this.timeoutMs });
      const m = r.choices?.[0]?.message ?? {};
      let llamadas = m.tool_calls ?? [];
      let contenido = limpiarContenido(m.content);
      if (!llamadas.length && /[{[]/.test(contenido)) {
        llamadas = llamadasEnTexto(contenido, [...mapa.keys()]);
        if (llamadas.length) {
          this.bitacora({ agente: this.nombre, tipo: 'llamada_en_texto', paso, herramientas: llamadas.map((c) => c.function.name) });
          contenido = '';
        } else if ([...mapa.keys()].some((n) => contenido.includes(n)) && !correcciones.length) {
          // Intentó llamar una herramienta con texto que no se puede leer: se le pide repetirla bien.
          this.bitacora({ agente: this.nombre, tipo: 'llamada_ilegible', paso });
          correcciones.push(mensajes.length);
          mensajes.push({ role: 'assistant', content: contenido }, { role: 'user', content: '[Control automático, no es el cliente] Escribiste una llamada a herramienta como texto y no es JSON válido. Usa la función de herramientas (tool_calls) con argumentos JSON correctos.' });
          continue;
        }
      }
      this.bitacora({ agente: this.nombre, tipo: 'modelo', paso, ms: Date.now() - inicio, herramientas: llamadas.map((c) => c.function?.name), tokens: r.usage?.total_tokens ?? null });
      if (!llamadas.length) {
        const inventadas = this.verificarCifras ? [...cifrasNoRespaldadas(contenido, mensajes), ...enlacesNoRespaldados(contenido, mensajes)] : [];
        if (inventadas.length && !correcciones.length) {
          this.bitacora({ agente: this.nombre, tipo: 'cifras_sin_respaldo', paso, cifras: inventadas });
          correcciones.push(mensajes.length);
          mensajes.push({ role: 'assistant', content: contenido }, { role: 'user', content: `[Control automático, no es el cliente] Tu respuesta menciona valores o enlaces que no salieron de ninguna herramienta: ${inventadas.join(', ')}. No inventes precios ni enlaces: usa las herramientas (registrar, diagnosticar, cotizar, aprobar) o responde sin ellos.` });
          continue;
        }
        if (inventadas.length) {
          this.bitacora({ agente: this.nombre, tipo: 'cifras_bloqueadas', paso, cifras: inventadas });
          contenido = RESPUESTA_SEGURA;
        }
        // La respuesta corregida reemplaza a la inventada en el historial.
        for (const i of correcciones.reverse()) mensajes.splice(i, 2);
        mensajes.push({ role: 'assistant', content: contenido });
        return { respuesta: contenido, pasos, historial: mensajes.slice(1), ...(inventadas.length ? { bloqueada: true } : {}) };
      }
      mensajes.push({ role: 'assistant', content: contenido, tool_calls: llamadas });
      for (const c of llamadas) {
        const resultado = await this.ejecutar(c, mapa, vistas);
        pasos.push({ herramienta: c.function.name, argumentos: c.function.arguments, resultado });
        mensajes.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(resultado).slice(0, 8000) });
      }
    }
    const respuesta = 'No logré completar la tarea en el número de pasos permitido. Un asesor humano revisará el caso.';
    this.bitacora({ agente: this.nombre, tipo: 'limite_pasos', pasos: pasos.length });
    return { respuesta, pasos, historial: mensajes.slice(1), agotado: true };
  }

  async ejecutar(c, mapa, vistas) {
    const h = mapa.get(c.function?.name);
    if (!h) return { error: { codigo: 'NO_AUTORIZADO', mensaje: `La herramienta ${c.function?.name} no está permitida para este agente` } };
    let args;
    try { args = typeof c.function.arguments === 'string' ? JSON.parse(c.function.arguments || '{}') : (c.function.arguments ?? {}); } catch {
      return { error: { codigo: 'DATOS_INVALIDOS', mensaje: 'Los argumentos no son JSON válido' } };
    }
    const esquema = h.definicion.inputSchema ?? {};
    args = normalizarArgumentos(args, esquema);
    // Los modelos pequeños a veces escriben "null" o "undefined" como texto: también cuenta como faltante.
    const vacio = (v) => v === undefined || v === null || (typeof v === 'string' && /^(|null|undefined|none|n\/a)$/i.test(v.trim()));
    const faltan = (esquema.required ?? []).filter((k) => vacio(args[k]));
    if (faltan.length) {
      this.bitacora({ agente: this.nombre, tipo: 'argumentos_faltantes', herramienta: c.function.name, faltan });
      return { error: { codigo: 'DATOS_INVALIDOS', mensaje: `Faltan argumentos obligatorios: ${faltan.join(', ')}. Tómalos de lo que dijo el cliente o de los resultados de herramientas anteriores (por ejemplo, orden_id sale de registrar_ingreso); si de verdad no los tienes, pregúntalos. No los inventes.` } };
    }
    const firma = `${c.function.name}:${JSON.stringify(args)}`;
    vistas.set(firma, (vistas.get(firma) ?? 0) + 1);
    if (vistas.get(firma) > 2) return { error: { codigo: 'DATOS_INVALIDOS', mensaje: 'Ya hiciste esta misma llamada dos veces; cambia de estrategia o responde al usuario' } };
    if (this.requierenConfirmacion.includes(h.nombre) && !(await this.confirmar(h.nombre, args))) {
      this.bitacora({ agente: this.nombre, tipo: 'confirmacion_negada', herramienta: h.nombre });
      return { error: { codigo: 'NO_AUTORIZADO', mensaje: 'La persona no confirmó esta acción. No la repitas sin su aprobación expresa.' } };
    }
    const inicio = Date.now();
    try {
      const datos = await h.cliente.llamar(h.nombre, args);
      this.bitacora({ agente: this.nombre, tipo: 'herramienta', herramienta: c.function.name, ok: true, ms: Date.now() - inicio, traza_id: datos?.traza_id ?? args.traza_id ?? null });
      return datos;
    } catch (e) {
      this.bitacora({ agente: this.nombre, tipo: 'herramienta', herramienta: c.function.name, ok: false, error: e.codigo ?? e.message, ms: Date.now() - inicio });
      return { error: { codigo: e.codigo ?? 'INTERNO', mensaje: e.message } };
    }
  }
}
