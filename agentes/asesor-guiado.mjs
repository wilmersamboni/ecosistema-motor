// Asesor GUIADO del taller (referencia para el grupo Falla). Mismo trabajo que agentes/asesor.mjs, pero
// el flujo lo controla el código y el modelo solo hace lo que hace bien un modelo pequeño:
//   1. Extraer datos del cliente y del vehículo de lo que escribió (salida estructurada con esquema).
//   2. Entender la intención de la respuesta del cliente (aprobar, preguntar o no aprobar).
// El código decide qué herramienta llamar y con qué datos, valida todo con los esquemas del contrato y
// arma las respuestas con los precios que devuelve el taller: el modelo nunca escribe una cifra ni un
// enlace. Funciona con llama3.2 (3B), con el que el asesor libre no logra cerrar una orden.
//   node agentes/asesor-guiado.mjs      (con el ecosistema corriendo: npm run ecosistema)
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { Cliente, Vehiculo } from '../contrato/esquemas.mjs';
import { ClienteServicio } from '../lib/cliente.mjs';
import { URLS, credencial } from '../lib/config.mjs';
import { decidir, modeloDesdeEntorno } from '../lib/agente.mjs';
import { crearBitacora } from '../lib/servicio.mjs';

// Lo que el modelo debe extraer. Todo es opcional: lo que el cliente no dijo va en null. El esquema es
// tolerante a propósito (un número puede llegar como texto): un error de formato en un campo no debe
// tumbar toda la extracción. Después, el código normaliza y valida con los esquemas del contrato.
const texto = z.union([z.string(), z.number()]).nullable();
const Extraccion = z.object({
  nombre: texto,
  documento: texto.describe('Número de cédula o NIT tal como lo dijo el cliente'),
  correo: texto,
  tipo: texto.describe('persona_natural o empresa'),
  retenedor: z.union([z.boolean(), z.string()]).nullable().describe('true si dijo que es agente de retención'),
  placa: texto,
  vin: texto,
  marca: texto,
  linea: texto,
  modelo_anio: texto,
  motor: texto,
  kilometraje: texto,
  sintomas: texto.describe('Lo que le pasa al vehículo, con las palabras del cliente'),
});

const Intencion = z.object({
  accion: z.enum(['aprobar', 'preguntar', 'no_aprobar']),
  opcion: z.enum(['recomendada', 'economica', 'rapida', 'original', 'ninguna']),
});

const NOMBRES_CAMPO = {
  nombre: 'su nombre', documento: 'su número de cédula o NIT', correo: 'su correo', tipo: 'si es persona natural o empresa',
  retenedor: 'si es agente de retención', placa: 'la placa', marca: 'la marca', linea: 'la línea', modelo_anio: 'el año del modelo',
  motor: 'el motor (por ejemplo, 1.2L gasolina)', kilometraje: 'el kilometraje', sintomas: 'qué le pasa al vehículo',
};
const NOMBRE_OPCION = { economica: 'Económica', rapida: 'Rápida', original: 'Original' };
const pesos = (n) => `$${Math.round(n).toLocaleString('es-CO')}`;

// Lo que se puede sacar del texto con certeza no se le pide al modelo: se toma con expresiones regulares.
function extraerConReglas(texto) {
  const t = texto.toUpperCase();
  return {
    codigos_dtc: [...new Set(t.match(/\b[PBCU][0-9][0-9A-F]{3}\b/g) ?? [])],
    vin: t.match(/\b[A-HJ-NPR-Z0-9]{17}\b/)?.[0] ?? null,
    placa: (t.match(/PLACA\s*:?\s*([A-Z]{3})[\s-]?([0-9]{3})\b/) ?? t.match(/\b([A-Z]{3})[\s-]?([0-9]{3})\b/))?.slice(1, 3).join('') ?? null,
    kilometraje: (() => { const m = t.match(/(\d{1,3}(?:[.,]\d{3})+|\d+)\s*(?:KM|KIL[OÓ]METROS)\b/); return m ? Number(m[1].replace(/\D/g, '')) : null; })(),
    correo: texto.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/)?.[0] ?? null,
    documento: t.match(/(?:C[EÉ]DULA|NIT|DOCUMENTO|C\.?\s?C\.?)\D{0,15}?(\d[\d.]{4,14}(?:-\d)?)/)?.[1].replace(/\./g, '') ?? null,
    retenedor: /NO\s+(SOY|SOMOS)\s+(AGENTES?\s+)?(DE\s+)?RETEN/.test(t) ? false : /(SOY|SOMOS)\s+(AGENTES?\s+)?(DE\s+)?RETEN/.test(t) ? true : null,
    tipo: /PERSONA\s+NATURAL/.test(t) ? 'persona_natural' : /\b(EMPRESA|S\.?A\.?S\.?|LTDA)\b/.test(t) ? 'empresa' : null,
  };
}

function normalizar(d) {
  const limpio = (v) => (typeof v === 'string' && /^(null|none|n\/a|no aplica|desconocido)?$/i.test(v.trim()) ? null : v);
  const x = Object.fromEntries(Object.entries(d).map(([k, v]) => [k, limpio(v)]));
  const entero = (v) => (v === null || v === undefined ? null : Number(String(v).replace(/[^\d]/g, '')) || null);
  if (x.documento) x.documento = String(x.documento).replace(/[^\d-]/g, '') || null;
  if (x.modelo_anio !== undefined) x.modelo_anio = entero(x.modelo_anio);
  if (x.kilometraje !== undefined) x.kilometraje = entero(x.kilometraje);
  if (typeof x.retenedor === 'string') x.retenedor = /^(true|s[ií])$/i.test(x.retenedor) ? true : /^(false|no)$/i.test(x.retenedor) ? false : null;
  if (x.tipo) x.tipo = /empresa/i.test(x.tipo) ? 'empresa' : /natural|persona/i.test(x.tipo) ? 'persona_natural' : null;
  for (const k of ['nombre', 'correo', 'placa', 'vin', 'marca', 'linea', 'motor', 'sintomas']) if (typeof x[k] === 'number') x[k] = String(x[k]);
  if (x.placa) x.placa = String(x.placa).toUpperCase().replace(/[\s-]/g, '');
  if (x.vin) x.vin = String(x.vin).toUpperCase();
  return x;
}

export class AsesorGuiado {
  constructor({ modelo = modeloDesdeEntorno(), confirmar = async () => false, bitacora = () => {}, taller } = {}) {
    this.modelo = modelo;
    this.confirmar = confirmar;
    this.bitacora = bitacora;
    this.taller = taller ?? new ClienteServicio({ destino: 'taller', url: URLS.taller, clientId: 'app', clientSecret: credencial('app', 'taller'), alcances: ['taller.recepcion'] });
    this.datos = {};
    this.orden = null;
    this.clave = randomUUID();
  }

  async llamar(pasos, herramienta, args) {
    try {
      const resultado = await this.taller.llamar(herramienta, args);
      pasos.push({ herramienta: `taller__${herramienta}`, argumentos: JSON.stringify(args), resultado });
      return resultado;
    } catch (e) {
      const resultado = { error: { codigo: e.codigo ?? 'INTERNO', mensaje: e.message } };
      pasos.push({ herramienta: `taller__${herramienta}`, argumentos: JSON.stringify(args), resultado });
      throw e;
    }
  }

  // Misma forma que Agente.turno: { respuesta, pasos, historial }.
  async turno(historial, mensaje) {
    const conversacion = [...historial, { role: 'user', content: mensaje }];
    const pasos = [];
    let respuesta;
    try {
      respuesta = this.orden ? await this.despuesDeCotizar(conversacion, mensaje, pasos) : await this.recibir(conversacion, pasos);
    } catch (e) {
      this.bitacora({ agente: 'asesor-guiado', tipo: 'error', error: e.codigo ?? e.message });
      respuesta = `No pude completar el trámite (${e.codigo ?? 'error'}: ${e.message.slice(0, 160)}). Un asesor del taller lo atenderá.`;
    }
    conversacion.push({ role: 'assistant', content: respuesta });
    return { respuesta, pasos, historial: conversacion };
  }

  async recibir(conversacion, pasos) {
    const textoCliente = conversacion.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
    let extraido = {};
    try {
      ({ datos: extraido } = await decidir(this.modelo, Extraccion, [
        { role: 'system', content: 'Extraes datos de lo que escribió un cliente de un taller en Colombia. Copia los datos tal como los dijo; si no dijo un dato, ponlo en null. No inventes nada.' },
        { role: 'user', content: textoCliente },
      ], { nombre: 'ingreso', limiteMs: 120_000 }));
    } catch (e) {
      this.bitacora({ agente: 'asesor-guiado', tipo: 'plan_b', motivo: e.message });
    }
    const reglas = extraerConReglas(textoCliente);
    // Las reglas mandan sobre el modelo en lo que pueden leer con certeza; lo ya conocido no se pierde.
    const nuevos = normalizar({ ...extraido, ...Object.fromEntries(Object.entries(reglas).filter(([k, v]) => k !== 'codigos_dtc' && v !== null)) });
    for (const [k, v] of Object.entries(nuevos)) if (v !== null && v !== undefined) this.datos[k] = v;
    this.datos.codigos_dtc = reglas.codigos_dtc;

    const d = this.datos;
    const cliente = { documento: d.documento, nombre: d.nombre, tipo: d.tipo, retenedor: d.retenedor, correo: d.correo };
    const vehiculo = { placa: d.placa, ...(d.vin ? { vin: d.vin } : {}), marca: d.marca, linea: d.linea, modelo_anio: d.modelo_anio, motor: d.motor, kilometraje: d.kilometraje };
    const errores = [...(Cliente.safeParse(cliente).error?.issues ?? []), ...(Vehiculo.safeParse(vehiculo).error?.issues ?? [])].map((i) => i.path[0]);
    if (!d.sintomas || String(d.sintomas).length < 5) errores.push('sintomas');
    const faltan = [...new Set(errores)];
    this.bitacora({ agente: 'asesor-guiado', tipo: 'extraccion', faltan });
    if (faltan.length) {
      for (const k of faltan) if (k !== 'sintomas') delete this.datos[k]; // un dato inválido se vuelve a pedir
      return `Para registrar su vehículo me falta: ${faltan.map((k) => NOMBRES_CAMPO[k] ?? k).join(', ')}. ¿Me lo indica, por favor?`;
    }

    // Flujo fijo, en código: registrar, diagnosticar y cotizar.
    let orden = await this.llamar(pasos, 'registrar_ingreso', { clave_idempotencia: this.clave, cliente, vehiculo, sintomas: d.sintomas, codigos_dtc: d.codigos_dtc });
    orden = await this.llamar(pasos, 'diagnosticar', { orden_id: orden.orden_id });
    orden = await this.llamar(pasos, 'cotizar', { orden_id: orden.orden_id });
    this.orden = orden;
    return this.presentar(orden);
  }

  presentar(o) {
    const lineas = [`Registré la orden ${o.orden_id} para el ${o.vehiculo.marca} ${o.vehiculo.linea} de placa ${o.vehiculo.placa}.`];
    if (o.diagnostico?.hallazgos?.length) lineas.push(`Diagnóstico: ${o.diagnostico.hallazgos.join('; ')}.`);
    if (o.diagnostico?.requiere_revision_humana) lineas.push('Un técnico revisará este diagnóstico antes de iniciar el trabajo.');
    if (o.garantia?.cubre) lineas.push(`La garantía de fábrica cubre: ${o.garantia.categorias_cubiertas.join(', ')}.`);
    lineas.push('Opciones (total con IVA que paga usted):');
    for (const op of o.opciones) {
      const marca = op.opcion_id === o.recomendacion?.opcion_id ? ' (recomendada)' : '';
      lineas.push(`- ${NOMBRE_OPCION[op.nombre] ?? op.nombre}${marca}: ${pesos(op.total_cliente)}, listo en ${op.tiempo_entrega_horas} horas, garantía de ${op.garantia_meses_minima} ${op.garantia_meses_minima === 1 ? "mes" : "meses"}.`);
    }
    if (o.recomendacion) lineas.push(`Le recomiendo la opción ${NOMBRE_OPCION[o.opciones.find((x) => x.opcion_id === o.recomendacion.opcion_id)?.nombre] ?? ''}: ${o.recomendacion.justificacion}`);
    lineas.push('¿Cuál opción aprueba?');
    return lineas.join('\n');
  }

  async despuesDeCotizar(conversacion, mensaje, pasos) {
    const o = this.orden;
    if (o.opcion_aprobada) {
      const actual = await this.llamar(pasos, 'consultar_orden', { orden_id: o.orden_id });
      this.orden = actual;
      return this.estadoPago(actual);
    }
    let intencion = { accion: 'preguntar', opcion: 'ninguna' };
    try {
      ({ datos: intencion } = await decidir(this.modelo, Intencion, [
        { role: 'system', content: 'Clasifica la respuesta de un cliente de taller ante opciones de reparación (economica, rapida, original). accion: aprobar si acepta una opción; preguntar si pide información; no_aprobar si no acepta. opcion: la que eligió, "recomendada" si acepta la recomendación sin nombrarla, "ninguna" si no eligió.' },
        { role: 'user', content: mensaje },
      ], { nombre: 'intencion', limiteMs: 60_000 }));
    } catch (e) {
      this.bitacora({ agente: 'asesor-guiado', tipo: 'plan_b', motivo: e.message });
    }
    this.bitacora({ agente: 'asesor-guiado', tipo: 'intencion', ...intencion });
    if (intencion.accion === 'no_aprobar') return 'Entendido, no apruebo ninguna opción. La cotización queda guardada por si cambia de opinión.';
    const elegida = intencion.opcion === 'recomendada' ? o.opciones.find((x) => x.opcion_id === o.recomendacion?.opcion_id) : o.opciones.find((x) => x.nombre === intencion.opcion);
    if (intencion.accion !== 'aprobar' || !elegida) return `${this.presentar(o)}\n(Dígame, por ejemplo: «apruebo la económica» o «apruebo la recomendada».)`;
    const args = { orden_id: o.orden_id, opcion_id: elegida.opcion_id, clave_idempotencia: `${o.orden_id}-${elegida.opcion_id}` };
    if (!(await this.confirmar('aprobar_opcion', args))) {
      this.bitacora({ agente: 'asesor-guiado', tipo: 'confirmacion_negada', herramienta: 'aprobar_opcion' });
      return 'La aprobación no fue confirmada, así que no reservé repuestos ni generé cobros.';
    }
    this.orden = await this.llamar(pasos, 'aprobar_opcion', args);
    return this.estadoPago(this.orden);
  }

  estadoPago(o) {
    const cobros = o.ventas.filter((v) => v.pagador === 'cliente' && v.url_pago);
    if (o.estado !== 'pendiente_pago' || !cobros.length) return `La orden ${o.orden_id} está en estado ${o.estado}.`;
    return [`Listo. La orden ${o.orden_id} quedó pendiente de pago.`, ...cobros.map((v) => `Pague ${pesos(v.total_a_pagar)} en: ${v.url_pago}`), 'El pago se confirma automáticamente y el taller empieza el trabajo.'].join('\n');
  }
}

export const crearAsesorGuiado = (opciones) => new AsesorGuiado({ bitacora: crearBitacora('agente-asesor-guiado'), ...opciones });

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const confirmar = async (herramienta, args) => (await rl.question(`\n[CONFIRMACIÓN] Ejecutar ${herramienta} con ${JSON.stringify(args)}. ¿Aprueba? (s/n) `)).trim().toLowerCase() === 's';
  const asesor = crearAsesorGuiado({ confirmar });
  console.log(`Asesor guiado del taller con el modelo ${asesor.modelo.modelo}. Escriba "salir" para terminar.\n`);
  let historial = [];
  for (;;) {
    const texto = await rl.question('Usted: ');
    if (!texto.trim() || texto.trim() === 'salir') break;
    const r = await asesor.turno(historial, texto);
    historial = r.historial;
    for (const p of r.pasos) console.log(`  · ${p.herramienta}${p.resultado?.error ? ' → ERROR ' + p.resultado.error.codigo : ''}`);
    console.log(`\nAsesor: ${r.respuesta}\n`);
  }
  rl.close();
  process.exit(0);
}
