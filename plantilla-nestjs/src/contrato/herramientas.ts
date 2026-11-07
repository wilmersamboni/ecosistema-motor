// CONTRATO DEL ECOSISTEMA MOTORRED - herramientas MCP que cada grupo debe publicar.
// Nombre, alcance (scope) que la habilita, esquema de entrada y de salida. Válido como JS y como TS.
// Los nombres, los campos y los códigos de error son obligatorios; la descripción la puede mejorar
// cada grupo, porque es lo que leen los agentes.
import { z } from 'zod';
import {
  Categoria, Cliente, ClaveIdempotencia, DecisionGarantia, Diagnostico, Garantia, LineaVenta,
  Liquidacion, Oferta, Opcion, Orden, Pagador, Reserva, TrazaId, Vehiculo, Venta,
} from './esquemas.js';

const soloLectura = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const escribe = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const destructiva = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

// ---------- herramientas comunes de los dos proveedores ----------
const proveedor = (grupo: string) => [
  {
    nombre: 'buscar_repuestos',
    alcance: 'proveedor.cotizar',
    descripcion:
      'Busca repuestos compatibles con un vehículo para una categoría y una cantidad. ' +
      'Devuelve ofertas con precio sin IVA, stock, tiempo de entrega y garantía. No reserva nada.',
    entrada: z.object({
      traza_id: TrazaId,
      vehiculo: Vehiculo,
      categoria: Categoria,
      cantidad: z.number().int().min(1).max(50),
    }),
    salida: z.object({ ofertas: z.array(Oferta) }),
    anotaciones: soloLectura,
  },
  {
    nombre: 'reservar_repuestos',
    alcance: 'proveedor.reservar',
    descripcion:
      'Aparta unidades de una o varias ofertas durante un tiempo. El precio queda congelado en la ' +
      'reserva. Es idempotente: la misma clave devuelve la misma reserva.',
    entrada: z.object({
      traza_id: TrazaId,
      clave_idempotencia: ClaveIdempotencia,
      items: z.array(z.object({ oferta_id: z.string(), cantidad: z.number().int().min(1).max(50) })).min(1).max(20),
      minutos_vigencia: z.number().int().min(1).max(1440),
    }),
    salida: Reserva,
    anotaciones: escribe,
  },
  {
    nombre: 'consultar_reserva',
    alcance: ['proveedor.reservar', 'proveedor.confirmar'],
    descripcion: 'Devuelve una reserva con su estado, sus ítems y sus precios.',
    entrada: z.object({ traza_id: TrazaId, reserva_id: z.string() }),
    salida: Reserva,
    anotaciones: soloLectura,
  },
  {
    nombre: 'confirmar_reserva',
    alcance: 'proveedor.confirmar',
    descripcion:
      'Convierte una reserva activa en una venta en firme y programa el despacho. Solo la usa el ' +
      'servicio de ventas después de recibir el pago. Repetirla con la misma venta no tiene efecto.',
    entrada: z.object({ traza_id: TrazaId, reserva_id: z.string(), venta_id: z.string() }),
    salida: Reserva,
    anotaciones: escribe,
  },
  {
    nombre: 'liberar_reserva',
    alcance: ['proveedor.reservar', 'proveedor.confirmar'],
    descripcion:
      'Devuelve al inventario las unidades de una reserva activa o confirmada y aún no despachada. ' +
      'Es la compensación cuando la venta no se completa.',
    entrada: z.object({ traza_id: TrazaId, reserva_id: z.string(), motivo: z.string().min(3).max(200) }),
    salida: Reserva,
    anotaciones: destructiva,
  },
].map((h) => ({ ...h, grupo }));

export const HERRAMIENTAS = [
  // ---------------- TIENDA DE REPUESTOS (grupo José) ----------------
  ...proveedor('tienda'),

  // ---------------- CONCESIONARIO (grupo Emerson) ----------------
  ...proveedor('concesionario'),
  {
    grupo: 'concesionario',
    nombre: 'consultar_vehiculo',
    alcance: 'garantia.consultar',
    descripcion:
      'Busca un vehículo vendido por la red del concesionario por su VIN y devuelve la garantía ' +
      'y las campañas de seguridad pendientes.',
    entrada: z.object({ traza_id: TrazaId, vin: z.string().length(17) }),
    salida: Garantia,
    anotaciones: soloLectura,
  },
  {
    grupo: 'concesionario',
    nombre: 'evaluar_garantia',
    alcance: 'garantia.consultar',
    descripcion:
      'Decide qué categorías de repuestos cubre la garantía de fábrica para una falla. Los ' +
      'elementos de desgaste (bujías, frenos, filtros, aceite) no se cubren.',
    entrada: z.object({
      traza_id: TrazaId,
      vin: z.string().length(17),
      kilometraje: z.number().int().min(0),
      categorias: z.array(Categoria).min(1),
      descripcion_falla: z.string().min(5).max(500),
    }),
    salida: DecisionGarantia,
    anotaciones: soloLectura,
  },

  // ---------------- VENTAS Y CONTABILIDAD (grupo Zaidy) ----------------
  {
    grupo: 'ventas',
    nombre: 'crear_venta',
    alcance: 'ventas.crear',
    descripcion:
      'Crea una venta con sus líneas y su pagador, verifica los precios contra las reservas de los ' +
      'proveedores, calcula IVA y retenciones y devuelve el enlace de pago. Idempotente.',
    entrada: z.object({
      traza_id: TrazaId,
      clave_idempotencia: ClaveIdempotencia,
      orden_id: z.string(),
      pagador: Pagador,
      lineas: z.array(LineaVenta).min(1).max(40),
      url_notificacion: z.url().describe('Dirección donde ventas enviará los eventos firmados'),
    }),
    salida: Venta,
    anotaciones: escribe,
  },
  {
    grupo: 'ventas',
    nombre: 'consultar_venta',
    alcance: ['ventas.crear', 'ventas.consultar'],
    descripcion: 'Devuelve una venta con su estado y sus valores.',
    entrada: z.object({ traza_id: TrazaId, venta_id: z.string() }),
    salida: Venta,
    anotaciones: soloLectura,
  },
  {
    grupo: 'ventas',
    nombre: 'generar_cobro',
    alcance: ['ventas.crear', 'ventas.consultar'],
    descripcion:
      'Genera un nuevo enlace de pago para una venta cuyo pago fue rechazado. No cambia los valores.',
    entrada: z.object({ traza_id: TrazaId, venta_id: z.string() }),
    salida: Venta,
    anotaciones: escribe,
  },
  {
    grupo: 'ventas',
    nombre: 'anular_venta',
    alcance: 'ventas.crear',
    descripcion: 'Anula una venta que no ha sido pagada y libera sus reservas en los proveedores.',
    entrada: z.object({ traza_id: TrazaId, venta_id: z.string(), motivo: z.string().min(3).max(200) }),
    salida: Venta,
    anotaciones: destructiva,
  },
  {
    grupo: 'ventas',
    nombre: 'consultar_liquidacion',
    alcance: ['ventas.crear', 'ventas.consultar'],
    descripcion:
      'Devuelve cómo se repartió el dinero de una venta pagada: dispersión a cada beneficiario, ' +
      'comisión de la plataforma y asientos contables.',
    entrada: z.object({ traza_id: TrazaId, venta_id: z.string() }),
    salida: Liquidacion,
    anotaciones: soloLectura,
  },

  // ---------------- TALLER (grupo Falla) ----------------
  {
    grupo: 'taller',
    nombre: 'registrar_ingreso',
    alcance: 'taller.recepcion',
    descripcion:
      'Abre una orden de trabajo cuando un vehículo llega al taller. Devuelve la orden con su ' +
      'traza_id, que identifica el caso en todo el ecosistema. Idempotente.',
    entrada: z.object({
      clave_idempotencia: ClaveIdempotencia,
      cliente: Cliente,
      vehiculo: Vehiculo,
      sintomas: z.string().min(5).max(1000),
      codigos_dtc: z.array(z.string().regex(/^[PBCU][0-9A-F]{4}$/)).max(20),
    }),
    salida: Orden,
    anotaciones: escribe,
  },
  {
    grupo: 'taller',
    nombre: 'diagnosticar',
    alcance: 'taller.recepcion',
    descripcion:
      'Analiza los síntomas y los códigos de falla de una orden y propone hallazgos, repuestos ' +
      'por categoría y horas de mano de obra.',
    entrada: z.object({ orden_id: z.string() }),
    salida: Orden,
    anotaciones: escribe,
  },
  {
    grupo: 'taller',
    nombre: 'cotizar',
    alcance: 'taller.recepcion',
    descripcion:
      'Consulta a la tienda y al concesionario, revisa la garantía y arma hasta tres opciones ' +
      '(económica, original, rápida) con una recomendación justificada.',
    entrada: z.object({ orden_id: z.string() }),
    salida: Orden,
    anotaciones: escribe,
  },
  {
    grupo: 'taller',
    nombre: 'aprobar_opcion',
    alcance: 'taller.recepcion',
    descripcion:
      'Registra la opción que el cliente aprobó: reserva los repuestos y crea las ventas. Solo se ' +
      'usa con la aprobación expresa del cliente. Idempotente.',
    entrada: z.object({ orden_id: z.string(), opcion_id: z.string(), clave_idempotencia: ClaveIdempotencia }),
    salida: Orden,
    anotaciones: escribe,
  },
  {
    grupo: 'taller',
    nombre: 'consultar_orden',
    alcance: ['taller.recepcion', 'taller.consultar'],
    descripcion: 'Devuelve una orden de trabajo con su diagnóstico, sus opciones, sus ventas y su historial.',
    entrada: z.object({ orden_id: z.string() }),
    salida: Orden,
    anotaciones: soloLectura,
  },
];

// Alcances que puede pedir cada cliente de servicio, por grupo dueño del servidor.
// Ejemplo: el taller (cliente) puede cotizar y reservar en la tienda, pero no confirmar.
// El cliente "auditor" (pruebas y trazas) solo tiene el alcance "auditoria": no ve herramientas, pero
// puede leer la bitácora con GET /bitacora?traza_id=...
export const PERMISOS: Record<string, Record<string, string[]>> = {
  tienda: { taller: ['proveedor.cotizar', 'proveedor.reservar'], ventas: ['proveedor.confirmar'], auditor: ['auditoria'] },
  concesionario: {
    taller: ['proveedor.cotizar', 'proveedor.reservar', 'garantia.consultar'],
    ventas: ['proveedor.confirmar'],
    auditor: ['auditoria'],
  },
  ventas: { taller: ['ventas.crear'], app: ['ventas.consultar'], auditor: ['auditoria'] },
  taller: { app: ['taller.recepcion'], ventas: ['taller.consultar'], auditor: ['auditoria'] },
};

// Rutas HTTP que no son herramientas MCP y que también hacen parte del contrato.
export const RUTAS_HTTP = [
  { grupo: 'todos', ruta: 'GET /salud', descripcion: '{ servicio, contrato, estado: "ok" }. Sin token.' },
  { grupo: 'todos', ruta: 'POST /oauth/token', descripcion: 'Credenciales de servicio (grant_type=client_credentials). Devuelve un token Bearer de 1 hora con sus alcances.' },
  { grupo: 'todos', ruta: 'POST y GET /mcp', descripcion: 'Servidor MCP. Token Bearer obligatorio; publica solo las herramientas de sus alcances.' },
  { grupo: 'todos', ruta: 'GET /bitacora?traza_id=<uuid>', descripcion: 'Token con alcance auditoria. { servicio, registros: [{ ts, servicio, traza_id, cliente, herramienta o evento, ok, ms, ... }] }.' },
  { grupo: 'taller', ruta: 'POST /eventos', descripcion: 'Eventos de ventas firmados (X-Firma). Idempotente por evento_id; solo transiciones hacia adelante.' },
  { grupo: 'ventas', ruta: 'POST /webhooks/pasarela', descripcion: 'Eventos de la pasarela firmados (X-Pasarela-Firma). Idempotente por evento_id.' },
  { grupo: 'tienda y concesionario', ruta: 'POST /sandbox/vencer/:reserva_id', descripcion: 'Solo laboratorio (SANDBOX=1 y cabecera X-Sandbox-Llave): vence una reserva activa.' },
  { grupo: 'tienda y concesionario', ruta: 'POST /sandbox/reabastecer', descripcion: 'Solo laboratorio: deja cada producto con al menos el stock del catálogo; con { minimo: N } lo sube al menos a N.' },
];

// Eventos mínimos que cada servicio escribe en su bitácora (además de una línea por herramienta).
export const EVENTOS_BITACORA = {
  ventas: ['webhook cobro.aprobado', 'webhook cobro.rechazado', 'webhook_duplicado_ignorado', 'webhook_rechazado', 'saga_compensacion', 'venta_liquidada'],
  pasarela: ['cobro creado', 'cobro aprobado', 'cobro rechazado', 'cobro reembolsado'],
};

export const herramientasDe = (grupo: string) => HERRAMIENTAS.filter((h) => h.grupo === grupo);
