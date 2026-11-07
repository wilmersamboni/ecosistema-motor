// Prueba de los agentes de referencia con el modelo SIMULADO (sin modelo real): salida estructurada con
// reintento, barandas, ciclo de herramientas MCP y confirmación humana.   node pruebas/agentes.mjs
import { randomUUID } from 'node:crypto';
import { Diagnostico } from '../contrato/esquemas.mjs';
import { crearAsesor } from '../agentes/asesor.mjs';
import { AsesorGuiado } from '../agentes/asesor-guiado.mjs';
import { diagnosticarConIA } from '../agentes/diagnostico.mjs';
import { asegurarEcosistema, prueba, resumen } from './comun.mjs';
import { crearModeloSimulado } from './modelo-simulado.mjs';

await asegurarEcosistema();
const simulado = crearModeloSimulado({ diagnosticoInvalidoPrimero: true });
await new Promise((r) => simulado.servidor.listen(4180, r));
const modelo = { url: 'http://localhost:4180/v1', llave: 'x', modelo: 'simulado' };
const G = 'agentes';
const spark = { marca: 'Chevrolet', linea: 'Spark GT', modelo_anio: 2016, motor: '1.2L gasolina', kilometraje: 128400 };

const d1 = await diagnosticarConIA({ sintomas: 'tiembla y se apaga', codigos_dtc: ['P0302'], vehiculo: spark }, { modelo });
prueba(G, 'Diagnóstico con IA: JSON inválido la 1.ª vez, corregido en el reintento', 'ia true', `${d1.fuente} ${Diagnostico.safeParse(d1.diagnostico).success}`);
prueba(G, 'Coincide con las reglas: no pide revisión humana', false, d1.diagnostico.requiere_revision_humana);
const reintento = simulado.peticiones.filter((p) => p.response_format).length;
prueba(G, 'Hubo exactamente un reintento con los errores de validación', 2, reintento);
const d2 = await diagnosticarConIA({ sintomas: 'chillido al frenar', codigos_dtc: [], vehiculo: { ...spark, marca: 'Mazda', linea: '2', motor: '1.5L gasolina' } }, { modelo });
prueba(G, 'Si el modelo y las reglas no coinciden, se pide revisión humana', 'true true', `${d2.diagnostico.requiere_revision_humana} ${d2.alertas.length > 0}`);
const caido = await diagnosticarConIA({ sintomas: 'tiembla', codigos_dtc: ['P0301'], vehiculo: spark }, { modelo: { ...modelo, url: 'http://localhost:4189/v1' } });
prueba(G, 'Sin modelo disponible, plan B: reglas del taller con revisión humana', 'reglas true', `${caido.fuente} ${caido.diagnostico.requiere_revision_humana}`);

const datos = {
  clave_idempotencia: randomUUID(),
  cliente: { documento: '1083456789', nombre: 'Ana Rojas', tipo: 'persona_natural', retenedor: false, correo: 'ana@correo.com' },
  vehiculo: { placa: 'ABC123', ...spark }, sintomas: 'Tiembla y se apaga', codigos_dtc: ['P0302'],
};
const guion = [
  { tool_calls: [{ name: 'taller__registrar_ingreso', arguments: datos }] },
  { tool_calls: [{ name: 'taller__diagnosticar', arguments: { orden_id: '{{orden_id}}' } }] },
  { tool_calls: [{ name: 'taller__cotizar', arguments: { orden_id: '{{orden_id}}' } }] },
  { content: 'Le recomiendo la opción {{opcion_id}}. ¿La aprueba?' },
  { tool_calls: [{ name: 'taller__aprobar_opcion', arguments: { orden_id: '{{orden_id}}', opcion_id: '{{opcion_id}}', clave_idempotencia: `aprobacion-${randomUUID()}` } }] },
  { content: 'Resultado: {{error}} {{url_pago}}' },
];
let preguntas = 0;
simulado.reiniciar(guion);
let asesor = crearAsesor({ modelo, confirmar: async () => { preguntas++; return false; } });
let t1 = await asesor.turno([], 'Hola, traigo mi Spark, tiembla y se apaga');
prueba(G, 'Turno 1: el agente encadena registrar, diagnosticar y cotizar', 'taller__registrar_ingreso,taller__diagnosticar,taller__cotizar', t1.pasos.map((p) => p.herramienta).join());
let t2 = await asesor.turno(t1.historial, 'Sí, apruebo');
prueba(G, 'Sin confirmación humana, aprobar_opcion NO se ejecuta', 'NO_AUTORIZADO 1', `${t2.pasos[0].resultado.error?.codigo} ${preguntas}`);
simulado.reiniciar(guion);
asesor = crearAsesor({ modelo, confirmar: async () => true });
t1 = await asesor.turno([], 'Hola');
t2 = await asesor.turno(t1.historial, 'Sí, apruebo');
prueba(G, 'Con confirmación, la orden queda pendiente de pago con su enlace', 'pendiente_pago true', `${t2.pasos[0].resultado.estado} ${/checkout/.test(t2.respuesta)}`);
simulado.reiniciar([{ tool_calls: [{ name: 'ventas__crear_venta', arguments: {} }] }, { content: 'ok' }]);
const t3 = await asesor.turno([], 'intenta algo raro');
prueba(G, 'Una herramienta fuera de la lista blanca se rechaza', 'NO_AUTORIZADO', t3.pasos[0].resultado.error?.codigo);
simulado.reiniciar(Array(12).fill({ tool_calls: [{ name: 'taller__consultar_orden', arguments: { orden_id: 'OT-000001' } }] }));
const t4 = await asesor.turno([], 'repite');
prueba(G, 'Llamadas repetidas y límite de pasos: el agente se detiene', 'true true', `${t4.agotado} ${t4.pasos.some((p) => /dos veces/.test(p.resultado.error?.mensaje ?? ''))}`);


// Barandas para modelos pequeños, con fallas reales observadas con llama3.2 (3B) en Ollama.
const comoTexto = JSON.stringify({ name: 'taller__registrar_ingreso', parameters: {
  ...datos, clave_idempotencia: randomUUID(), cliente: JSON.stringify(datos.cliente), vehiculo: JSON.stringify(datos.vehiculo), codigos_dtc: JSON.stringify(datos.codigos_dtc) } });
simulado.reiniciar([{ content: comoTexto }, { content: 'Listo, quedó registrada la orden {{orden_id}}.' }]);
const t5 = await asesor.turno([], 'Traigo mi Spark');
prueba(G, 'Llamada escrita como texto JSON y objetos como cadenas: se convierte y se ejecuta', 'taller__registrar_ingreso true', `${t5.pasos[0]?.herramienta} ${/^OT-/.test(t5.pasos[0]?.resultado?.orden_id ?? '')}`);
// Respuesta textual de llama3.2 en Ollama (verificación en Windows, oct. 2026): además de usar texto,
// abre la cadena de "sintomas" con \" por fuera de una cadena, lo que no es JSON válido.
const REAL_LLAMA = String.raw`{"name": "taller__registrar_ingreso", "parameters": {"clave_idempotencia": "CLAVE", "cliente": "{\"documento\": \"DNI\", \"nombre\": \"Ana Rojas\", \"tipo\": \"persona_natural\", \"retenedor\": false, \"correo\": \"ana@correo.com\"}", "vehiculo": "{\"placa\": \"ABC123\", \"vin\": \"9GAMM6105GB000045\", \"marca\": \"Chevrolet\", \"linea\": \"Spark GT\", \"modelo_anio\": 2016, \"motor\": \"1.2L gasolina\", \"kilometraje\": 128400}", "sintomas": \"El carro tiembla en ralent\u00ed y a veces se apaga; el esc\u00e1ner marc\u00f3 el c\u00f3digo P0302\", "codigos_dtc": "[\"P0302\"]"}}`;
simulado.reiniciar([{ content: REAL_LLAMA.replace('CLAVE', randomUUID()) }, { content: 'Listo, orden {{orden_id}}.' }]);
const t5b = await asesor.turno([], 'Traigo mi Spark');
prueba(G, 'Llamada real de llama3.2 (texto con comillas mal escapadas): se repara; la cédula inventada la rechaza el servicio', 'taller__registrar_ingreso DATOS_INVALIDOS', `${t5b.pasos[0]?.herramienta} ${t5b.pasos[0]?.resultado?.error?.codigo}`);
simulado.reiniciar([{ tool_calls: [{ name: 'taller__aprobar_opcion', arguments: { orden_id: null, opcion_id: 'X', clave_idempotencia: 'k' } }] }, { content: 'No pude.' }]);
let llamadasConfirmar = 0;
const asesor2 = crearAsesor({ modelo, confirmar: async () => { llamadasConfirmar++; return true; } });
const t6 = await asesor2.turno([], 'apruebo');
prueba(G, 'Argumento obligatorio en null: se rechaza sin llamar al servicio ni pedir confirmación', 'DATOS_INVALIDOS 0', `${t6.pasos[0]?.resultado?.error?.codigo} ${llamadasConfirmar}`);
simulado.reiniciar([{ content: 'Le recomiendo la Revisión Completa por $2.500.000 COP.' }, { content: 'Le recomiendo la Revisión Completa por $2.500.000 COP.' }]);
const t7 = await asesor.turno([], 'cuánto cuesta?');
prueba(G, 'Precio inventado (no salió de una herramienta): se pide corregir y luego se bloquea', 'true false', `${t7.bloqueada === true} ${t7.respuesta.includes('2.500.000')}`);
simulado.reiniciar([{ content: 'Cuesta $2.500.000.' }, { content: 'Primero debo registrar y cotizar su vehículo; ¿me confirma la placa?' }]);
const t8 = await asesor.turno([], 'cuánto cuesta?');
prueba(G, 'Tras la corrección, el historial no conserva la respuesta inventada', 'false false', `${JSON.stringify(t8.historial).includes('2.500.000')} ${t8.bloqueada === true}`);
simulado.reiniciar([{ content: 'Pague aquí: https://pago.motorred.com/orden/123' }, { content: 'Pague aquí: https://pago.motorred.com/orden/123' }]);
const t9 = await asesor.turno([], 'mándeme el enlace de pago');
prueba(G, 'Enlace de pago inventado: se bloquea', 'true false', `${t9.bloqueada === true} ${t9.respuesta.includes('motorred.com')}`);
simulado.reiniciar([{ tool_calls: [{ name: 'taller__aprobar_opcion', arguments: { orden_id: 'null', opcion_id: 'X', clave_idempotencia: 'k' } }] }, { content: 'No pude.' }]);
const t10 = await asesor2.turno([], 'apruebo');
prueba(G, 'orden_id escrito como el texto "null": se trata como faltante', 'DATOS_INVALIDOS', t10.pasos[0]?.resultado?.error?.codigo);

// Asesor guiado: el código controla el flujo y el modelo solo extrae datos e intención.
const ANA = { nombre: 'Ana Rojas', documento: '1083456789', correo: 'ana@correo.com', tipo: 'persona_natural', retenedor: false, placa: 'abc 123', vin: null,
  marca: 'Chevrolet', linea: 'Spark GT', modelo_anio: 2016, motor: '1.2L gasolina', kilometraje: null, sintomas: 'Tiembla en ralentí y se apaga' };
simulado.fijarJson({ ingreso: { ...ANA }, intencion: { accion: 'aprobar', opcion: 'recomendada' } });
let confirmaciones = 0;
const guiado = new AsesorGuiado({ modelo, confirmar: async () => ++confirmaciones > 1 });
let g1 = await guiado.turno([], 'Soy Ana Rojas, cédula 1083456789, traigo mi Spark GT 2016 placa ABC-123, tiembla y se apaga, código P0302');
prueba(G, 'Guiado: si falta un dato (kilometraje) lo pide y no llama herramientas', 'true 0', `${/kilometraje/.test(g1.respuesta)} ${g1.pasos.length}`);
g1 = await guiado.turno(g1.historial, 'Tiene 128.400 km');
const cot = g1.pasos.at(-1)?.resultado;
prueba(G, 'Guiado: con los datos completos registra, diagnostica y cotiza (DTC y km leídos por reglas)', 'taller__registrar_ingreso,taller__diagnosticar,taller__cotizar P0302 128400',
  `${g1.pasos.map((p) => p.herramienta).join()} ${cot?.codigos_dtc?.join()} ${cot?.vehiculo?.kilometraje}`);
const totales = (cot?.opciones ?? []).map((o) => `$${o.total_cliente.toLocaleString('es-CO')}`);
prueba(G, 'Guiado: los precios de la respuesta son los de la cotización', true, totales.length > 0 && totales.every((t) => g1.respuesta.includes(t)));
let g2 = await guiado.turno(g1.historial, 'Apruebo la que me recomienda');
prueba(G, 'Guiado: sin confirmación humana no aprueba', 'true 0', `${/no fue confirmada/.test(g2.respuesta)} ${g2.pasos.length}`);
g2 = await guiado.turno(g2.historial, 'Sí, apruebo la recomendada');
prueba(G, 'Guiado: con confirmación, la orden queda pendiente de pago con el enlace real', 'pendiente_pago true',
  `${g2.pasos.at(-1)?.resultado?.estado} ${g2.pasos.at(-1)?.resultado?.ventas?.some((v) => v.url_pago && g2.respuesta.includes(v.url_pago))}`);

simulado.servidor.close();
const ok = resumen('RESUMEN DE AGENTES');
process.exit(ok ? 0 : 1);
