// Simulador del grupo Emerson: concesionario autorizado (repuestos originales y garantías).
//   node simuladores/concesionario.mjs
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PARAMETROS, PUERTOS, clientesDe, secretoJwt } from '../lib/config.mjs';
import { falla } from '../lib/errores.mjs';
import { crearServicio } from '../lib/servicio.mjs';
import { crearProveedor } from './proveedor.mjs';

export function garantiaDe(v, hoy = new Date()) {
  const hasta = new Date(v.fecha_venta);
  hasta.setFullYear(hasta.getFullYear() + v.garantia_anios);
  return { hasta_fecha: hasta.toISOString().slice(0, 10), hasta_km: v.garantia_km, vigente_por_fecha: hoy <= hasta };
}

export async function iniciar(puerto = PUERTOS.concesionario) {
  const catalogo = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'datos', 'catalogo-concesionario.json'), 'utf8'));
  const { implementacion, rutas } = crearProveedor('concesionario', catalogo, PARAMETROS);
  const vehiculo = (vin) => {
    const v = catalogo.vehiculos.find((x) => x.vin === vin.toUpperCase());
    if (!v) throw falla('NO_ENCONTRADO', `El VIN ${vin} no fue vendido por la red del concesionario`);
    return v;
  };

  implementacion.consultar_vehiculo = async ({ vin }) => {
    const v = vehiculo(vin);
    const g = garantiaDe(v);
    return {
      vin: v.vin, marca: v.marca, linea: v.linea, modelo_anio: v.modelo_anio, fecha_venta: v.fecha_venta,
      garantia: { vigente: g.vigente_por_fecha, hasta_fecha: g.hasta_fecha, hasta_km: g.hasta_km }, campanas: v.campanas,
    };
  };

  implementacion.evaluar_garantia = async ({ vin, kilometraje, categorias }) => {
    const v = vehiculo(vin);
    const g = garantiaDe(v);
    if (!g.vigente_por_fecha) return { cubre: false, categorias_cubiertas: [], cubre_mano_obra: false, autorizacion: null, motivo: `La garantía venció el ${g.hasta_fecha}` };
    if (kilometraje > g.hasta_km) return { cubre: false, categorias_cubiertas: [], cubre_mano_obra: false, autorizacion: null, motivo: `El vehículo superó los ${g.hasta_km} km de garantía` };
    const cubiertas = categorias.filter((c) => catalogo.garantia.cubiertas.includes(c));
    const excluidas = categorias.filter((c) => !cubiertas.includes(c));
    if (!cubiertas.length) return { cubre: false, categorias_cubiertas: [], cubre_mano_obra: false, autorizacion: null, motivo: `Elementos de desgaste, sin cobertura: ${excluidas.join(', ')}` };
    return {
      cubre: true, categorias_cubiertas: cubiertas, cubre_mano_obra: true,
      autorizacion: `GAR-${v.vin.slice(-6)}-${Date.now().toString(36).toUpperCase()}`,
      motivo: `Garantía vigente hasta ${g.hasta_fecha} o ${g.hasta_km} km. Cubre: ${cubiertas.join(', ')}.` + (excluidas.length ? ` No cubre (desgaste): ${excluidas.join(', ')}.` : ''),
    };
  };

  await crearServicio({
    grupo: 'concesionario', puerto, secreto: secretoJwt('concesionario'), clientes: clientesDe('concesionario'), implementacion, rutas,
    instrucciones: `Concesionario autorizado de ${catalogo.marcas.join(' y ')}: repuestos originales, garantías y campañas.`,
  });
  return puerto;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(`concesionario en el puerto ${await iniciar()}`);
