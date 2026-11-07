// Genera, a partir del contrato: docs/contrato.md (tabla de herramientas por grupo) y
// contrato/ts/*.ts (las mismas definiciones con tipos, para copiar a un proyecto NestJS).
//   npm run contrato
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { CODIGOS_ERROR, VERSION_CONTRATO } from './esquemas.mjs';
import { EVENTOS_BITACORA, HERRAMIENTAS, PERMISOS, RUTAS_HTTP } from './herramientas.mjs';

const AQUI = import.meta.dirname;
const RAIZ = join(AQUI, '..');
const NOMBRES = { taller: 'Taller (grupo Falla)', tienda: 'Tienda de repuestos (grupo José)', concesionario: 'Concesionario (grupo Emerson)', ventas: 'Ventas y contabilidad (grupo Zaidy)' };
const campos = (esquema) => {
  const j = z.toJSONSchema(esquema, { unrepresentable: 'any' });
  return Object.keys(j.properties ?? {}).map((k) => ((j.required ?? []).includes(k) ? k : `${k}?`)).join(', ');
};
let md = `# Contrato MotorRed ${VERSION_CONTRATO}\n\nGenerado con \`npm run contrato\` a partir de \`contrato/\`. No lo edite a mano.\nLas reglas de comportamiento están en \`contrato/REGLAS.md\`.\n\n`;
md += '## Rutas HTTP comunes\n\n| Grupo | Ruta | Descripción |\n|---|---|---|\n' + RUTAS_HTTP.map((r) => `| ${r.grupo} | \`${r.ruta}\` | ${r.descripcion} |`).join('\n') + '\n\n';
md += '## Eventos mínimos de bitácora\n\n' + Object.entries(EVENTOS_BITACORA).map(([g, e]) => `- ${g}: ${e.map((x) => `\`${x}\``).join(', ')}`).join('\n') + '\n\n';
for (const grupo of ['taller', 'tienda', 'concesionario', 'ventas']) {
  md += `## ${NOMBRES[grupo]}\n\nClientes que acepta: ${Object.entries(PERMISOS[grupo]).map(([c, a]) => `**${c}** (${a.join(', ')})`).join('; ')}.\n\n`;
  md += '| Herramienta | Alcance | Entrada | Tipo |\n|---|---|---|---|\n';
  for (const h of HERRAMIENTAS.filter((x) => x.grupo === grupo)) {
    md += `| \`${h.nombre}\` | ${[h.alcance].flat().join(' o ')} | ${campos(h.entrada)} | ${h.anotaciones.readOnlyHint ? 'consulta' : h.anotaciones.destructiveHint ? 'destructiva' : 'escribe'} |\n`;
  }
  md += '\n';
}
md += `## Códigos de error\n\n${CODIGOS_ERROR.map((c) => `- \`${c}\``).join('\n')}\n`;
mkdirSync(join(RAIZ, 'docs'), { recursive: true });
writeFileSync(join(RAIZ, 'docs', 'contrato.md'), md);

// Versión TypeScript: listas con "as const", parámetros con tipo e importaciones .js.
mkdirSync(join(AQUI, 'ts'), { recursive: true });
const ts = (texto) => texto
  .replace(/(export const (?:GRUPOS|CATEGORIAS|CODIGOS_ERROR|ESTADOS_VENTA|ESTADOS_ORDEN|TIPOS_EVENTO) = \[[\s\S]*?\]);/g, '$1 as const;')
  .replace(/\(grupo\) =>/g, '(grupo: string) =>')
  .replace(/from '\.\/esquemas\.mjs'/g, "from './esquemas.js'")
  .replace(/export const PERMISOS = \{/, 'export const PERMISOS: Record<string, Record<string, string[]>> = {');
for (const archivo of ['esquemas', 'herramientas']) {
  writeFileSync(join(AQUI, 'ts', `${archivo}.ts`), ts(readFileSync(join(AQUI, `${archivo}.mjs`), 'utf8')));
}
console.log('Generados docs/contrato.md, contrato/ts/esquemas.ts y contrato/ts/herramientas.ts');
