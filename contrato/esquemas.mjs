// CONTRATO DEL ECOSISTEMA MOTORRED - versión 1.0
// Esquemas de datos que comparten los cuatro grupos. Para NestJS use la versión de contrato/ts/,
// que se genera con npm run contrato (agrega los tipos que TypeScript necesita).
// Una regla: si cambia algo aquí, lo cambian los cuatro grupos a la vez (nueva versión del contrato).
import { z } from 'zod';

export const VERSION_CONTRATO = '1.0';

// ---------- tipos básicos ----------
// Todo valor en dinero es un entero en pesos colombianos (COP). Nunca decimales ni flotantes.
export const Pesos = z.number().int().min(0).max(1_000_000_000);
export const Porcentaje = z.number().min(0).max(100);
// Identificador de la orden de trabajo en todo el ecosistema: viaja en cada llamada para seguir el rastro.
export const TrazaId = z.uuid().describe('Identificador de trazabilidad de la orden de trabajo');
export const ClaveIdempotencia = z
  .string()
  .min(8)
  .max(120)
  .describe('Misma clave = misma operación. Repetir la llamada no duplica el efecto');
export const FechaIso = z.iso.datetime({ offset: true });

export const GRUPOS = ['taller', 'tienda', 'concesionario', 'ventas'];
export const Proveedor = z.enum(['tienda', 'concesionario']);
export const Beneficiario = z.enum(['taller', 'tienda', 'concesionario']);

// Categorías normalizadas de repuestos: el taller pide por categoría, cada proveedor traduce a su SKU.
export const CATEGORIAS = [
  'bujia',
  'bobina_encendido',
  'pastillas_freno',
  'disco_freno',
  'filtro_aceite',
  'aceite_motor_litro',
  'filtro_aire',
  'bateria',
  'sensor_oxigeno',
  'bomba_agua',
  'kit_embrague',
];
export const Categoria = z.enum(CATEGORIAS);

export const Vehiculo = z.object({
  placa: z.string().regex(/^[A-Z]{3}[0-9]{3}$/, 'Placa de carro: tres letras y tres números'),
  vin: z
    .string()
    .regex(/^[A-HJ-NPR-Z0-9]{17}$/, 'El VIN tiene 17 caracteres, sin I, O ni Q')
    .optional(),
  marca: z.string().min(2).max(40),
  linea: z.string().min(1).max(40),
  modelo_anio: z.number().int().min(1990).max(2027),
  motor: z.string().min(2).max(40).describe('Ejemplo: 1.6L gasolina'),
  kilometraje: z.number().int().min(0).max(2_000_000),
});

export const Cliente = z.object({
  documento: z.string().regex(/^[0-9]{5,12}(-[0-9])?$/, 'Cédula o NIT, con dígito de verificación opcional'),
  nombre: z.string().min(2).max(120),
  tipo: z.enum(['persona_natural', 'empresa']),
  // Si es agente de retención, practica retención en la fuente al pagar.
  retenedor: z.boolean(),
  correo: z.email(),
});

// ---------- errores ----------
// Toda herramienta que falla devuelve isError: true y, en content[0].text, el JSON de ErrorContrato.
export const CODIGOS_ERROR = [
  'DATOS_INVALIDOS', // la entrada no cumple el esquema o una regla
  'NO_ENCONTRADO', // el recurso no existe o el cliente no lo puede ver
  'NO_AUTORIZADO', // el token no tiene el alcance (scope) necesario
  'STOCK_INSUFICIENTE',
  'OFERTA_VENCIDA',
  'RESERVA_VENCIDA',
  'ESTADO_INVALIDO', // la transición de estado no está permitida
  'PRECIO_NO_COINCIDE', // el precio enviado no es el de la reserva del proveedor
  'IDEMPOTENCIA_CONFLICTO', // misma clave con datos distintos
  'PROVEEDOR_NO_DISPONIBLE', // otro servicio no respondió
  'INTERNO',
];
export const ErrorContrato = z.object({
  error: z.object({
    codigo: z.enum(CODIGOS_ERROR),
    mensaje: z.string(),
    reintentable: z.boolean(),
  }),
});

// ---------- proveedores de repuestos (tienda y concesionario) ----------
export const Oferta = z.object({
  oferta_id: z.string(),
  proveedor: Proveedor,
  sku: z.string(),
  categoria: Categoria,
  descripcion: z.string(),
  fabricante: z.string(),
  tipo: z.enum(['original', 'homologado', 'generico']),
  precio_unitario: Pesos.describe('Sin IVA'),
  iva_porcentaje: Porcentaje,
  stock_disponible: z.number().int().min(0),
  tiempo_entrega_horas: z.number().int().min(0),
  garantia_meses: z.number().int().min(0),
  vigente_hasta: FechaIso,
});

export const ItemReservado = z.object({
  sku: z.string(),
  categoria: Categoria,
  descripcion: z.string(),
  cantidad: z.number().int().min(1),
  precio_unitario: Pesos,
  iva_porcentaje: Porcentaje,
});

export const Reserva = z.object({
  reserva_id: z.string(),
  proveedor: Proveedor,
  estado: z.enum(['activa', 'confirmada', 'liberada', 'vencida']),
  vence_en: FechaIso,
  items: z.array(ItemReservado),
  subtotal: Pesos,
  iva: Pesos,
  total: Pesos,
  venta_id: z.string().nullable(),
  despacho: z.object({ guia: z.string(), eta: FechaIso }).nullable(),
});

export const Garantia = z.object({
  vin: z.string(),
  marca: z.string(),
  linea: z.string(),
  modelo_anio: z.number().int(),
  fecha_venta: z.iso.date(),
  garantia: z.object({ vigente: z.boolean(), hasta_fecha: z.iso.date(), hasta_km: z.number().int() }),
  campanas: z.array(z.object({ codigo: z.string(), descripcion: z.string() })),
});

export const DecisionGarantia = z.object({
  cubre: z.boolean(),
  categorias_cubiertas: z.array(Categoria),
  cubre_mano_obra: z.boolean(),
  autorizacion: z.string().nullable(),
  motivo: z.string(),
});

// ---------- ventas ----------
export const Pagador = z.object({
  tipo: z.enum(['cliente', 'concesionario']),
  documento: z.string(),
  nombre: z.string(),
  retenedor: z.boolean(),
  // Obligatoria si paga el concesionario: el número de autorización de garantía (GAR-...).
  autorizacion: z.string().nullable(),
});

export const LineaVenta = z.object({
  beneficiario: Beneficiario,
  // garantia = repuesto que el concesionario entrega sin costo por garantía de fábrica (precio 0).
  concepto: z.enum(['servicio', 'repuesto', 'garantia']),
  referencia: z.string().describe('SKU del repuesto o código del servicio'),
  descripcion: z.string(),
  cantidad: z.number().int().min(1),
  precio_unitario: Pesos,
  iva_porcentaje: Porcentaje,
  reserva_id: z.string().nullable().describe('Obligatoria para repuestos y garantías'),
});

export const Dispersion = z.object({
  beneficiario: Beneficiario,
  base: Pesos,
  iva: Pesos,
  retencion: Pesos,
  comision: Pesos,
  iva_comision: Pesos,
  neto: Pesos,
  estado: z.enum(['pendiente', 'transferida']),
  referencia: z.string().nullable(),
});

export const Asiento = z.object({
  cuenta: z.string(),
  nombre_cuenta: z.string(),
  tercero: z.string(),
  debito: Pesos,
  credito: Pesos,
});

// en_revision: algo no cuadró (monto, liquidación o reembolso) y una persona debe revisar antes de seguir.
export const ESTADOS_VENTA = ['pendiente_pago', 'pago_rechazado', 'pagada', 'liquidada', 'reembolsada', 'anulada', 'en_revision'];
export const Venta = z.object({
  venta_id: z.string(),
  orden_id: z.string(),
  traza_id: TrazaId,
  estado: z.enum(ESTADOS_VENTA),
  pagador: Pagador,
  lineas: z.array(LineaVenta),
  subtotal: Pesos,
  iva: Pesos,
  retenciones: Pesos,
  total: Pesos,
  total_a_pagar: Pesos,
  url_pago: z.string().nullable(),
  creada_en: FechaIso,
});

export const Liquidacion = z.object({
  venta_id: z.string(),
  estado: z.enum(ESTADOS_VENTA),
  recaudado: Pesos,
  dispersiones: z.array(Dispersion),
  ingreso_plataforma: Pesos.describe('Comisiones más su IVA: lo que retiene la plataforma'),
  asientos: z.array(Asiento),
  cuadra: z.boolean().describe('Débitos = créditos y dispersiones + plataforma = recaudado'),
});

// ---------- taller ----------
export const ESTADOS_ORDEN = [
  'recibida',
  'diagnosticada',
  'cotizada',
  'pendiente_pago',
  'en_reparacion',
  'requiere_nueva_cotizacion',
  'en_revision', // hay dinero recibido en una venta y la otra se reembolsó: decide una persona
  'cancelada',
];

export const Requerimiento = z.object({
  categoria: Categoria,
  cantidad: z.number().int().min(1),
  justificacion: z.string(),
});

export const Diagnostico = z.object({
  hallazgos: z.array(z.string()).min(1),
  requerimientos: z.array(Requerimiento),
  mano_obra_horas: z.number().min(0).max(80),
  confianza: z.number().min(0).max(1),
  requiere_revision_humana: z.boolean(),
});

export const ItemOpcion = z.object({
  oferta_id: z.string(),
  proveedor: Proveedor,
  sku: z.string(),
  categoria: Categoria,
  descripcion: z.string(),
  tipo: z.enum(['original', 'homologado', 'generico']),
  cantidad: z.number().int().min(1),
  precio_unitario: Pesos,
  iva_porcentaje: Porcentaje,
  pagador: z.enum(['cliente', 'concesionario']),
});

export const Opcion = z.object({
  opcion_id: z.string(),
  nombre: z.enum(['economica', 'original', 'rapida']),
  items: z.array(ItemOpcion),
  // Con garantía parcial, la mano de obra se reparte: la parte de las categorías cubiertas la paga el
  // concesionario (subtotal_garantia) y el resto el cliente. Regla de práctica: en proporción al número
  // de categorías cubiertas.
  mano_obra: z.object({
    horas: z.number(),
    valor_hora: Pesos,
    subtotal: Pesos,
    subtotal_garantia: Pesos,
  }),
  subtotal: Pesos,
  iva: Pesos,
  total: Pesos,
  total_cliente: Pesos.describe('Lo que paga el cliente, antes de retenciones'),
  tiempo_entrega_horas: z.number().int(),
  garantia_meses_minima: z.number().int(),
});

export const Orden = z.object({
  orden_id: z.string(),
  traza_id: TrazaId,
  estado: z.enum(ESTADOS_ORDEN),
  cliente: Cliente,
  vehiculo: Vehiculo,
  sintomas: z.string(),
  codigos_dtc: z.array(z.string()),
  diagnostico: Diagnostico.nullable(),
  garantia: DecisionGarantia.nullable(),
  cotizacion: z.number().int().min(0).describe('Número de la cotización vigente; sube cada vez que se cotiza'),
  opciones: z.array(Opcion),
  recomendacion: z.object({ opcion_id: z.string(), justificacion: z.string() }).nullable(),
  opcion_aprobada: z.string().nullable(),
  ventas: z.array(z.object({ venta_id: z.string(), pagador: z.string(), total_a_pagar: Pesos, url_pago: z.string().nullable(), estado: z.string() })),
  eventos: z.array(z.object({ fecha: FechaIso, tipo: z.string(), detalle: z.string() })),
});

// ---------- eventos entre servicios (webhooks firmados) ----------
export const TIPOS_EVENTO = ['venta.pagada', 'venta.liquidada', 'venta.pago_rechazado', 'venta.reembolsada'];
export const Evento = z.object({
  evento_id: z.string(),
  tipo: z.enum(TIPOS_EVENTO),
  fecha: FechaIso,
  traza_id: TrazaId,
  datos: z.record(z.string(), z.unknown()),
});
