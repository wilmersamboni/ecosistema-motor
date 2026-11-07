# Contrato MotorRed 1.0

Generado con `npm run contrato` a partir de `contrato/`. No lo edite a mano.
Las reglas de comportamiento están en `contrato/REGLAS.md`.

## Rutas HTTP comunes

| Grupo | Ruta | Descripción |
|---|---|---|
| todos | `GET /salud` | { servicio, contrato, estado: "ok" }. Sin token. |
| todos | `POST /oauth/token` | Credenciales de servicio (grant_type=client_credentials). Devuelve un token Bearer de 1 hora con sus alcances. |
| todos | `POST y GET /mcp` | Servidor MCP. Token Bearer obligatorio; publica solo las herramientas de sus alcances. |
| todos | `GET /bitacora?traza_id=<uuid>` | Token con alcance auditoria. { servicio, registros: [{ ts, servicio, traza_id, cliente, herramienta o evento, ok, ms, ... }] }. |
| taller | `POST /eventos` | Eventos de ventas firmados (X-Firma). Idempotente por evento_id; solo transiciones hacia adelante. |
| ventas | `POST /webhooks/pasarela` | Eventos de la pasarela firmados (X-Pasarela-Firma). Idempotente por evento_id. |
| tienda y concesionario | `POST /sandbox/vencer/:reserva_id` | Solo laboratorio (SANDBOX=1 y cabecera X-Sandbox-Llave): vence una reserva activa. |
| tienda y concesionario | `POST /sandbox/reabastecer` | Solo laboratorio: deja cada producto con al menos el stock del catálogo; con { minimo: N } lo sube al menos a N. |

## Eventos mínimos de bitácora

- ventas: `webhook cobro.aprobado`, `webhook cobro.rechazado`, `webhook_duplicado_ignorado`, `webhook_rechazado`, `saga_compensacion`, `venta_liquidada`
- pasarela: `cobro creado`, `cobro aprobado`, `cobro rechazado`, `cobro reembolsado`

## Taller (grupo Falla)

Clientes que acepta: **app** (taller.recepcion); **ventas** (taller.consultar); **auditor** (auditoria).

| Herramienta | Alcance | Entrada | Tipo |
|---|---|---|---|
| `registrar_ingreso` | taller.recepcion | clave_idempotencia, cliente, vehiculo, sintomas, codigos_dtc | escribe |
| `diagnosticar` | taller.recepcion | orden_id | escribe |
| `cotizar` | taller.recepcion | orden_id | escribe |
| `aprobar_opcion` | taller.recepcion | orden_id, opcion_id, clave_idempotencia | escribe |
| `consultar_orden` | taller.recepcion o taller.consultar | orden_id | consulta |

## Tienda de repuestos (grupo José)

Clientes que acepta: **taller** (proveedor.cotizar, proveedor.reservar); **ventas** (proveedor.confirmar); **auditor** (auditoria).

| Herramienta | Alcance | Entrada | Tipo |
|---|---|---|---|
| `buscar_repuestos` | proveedor.cotizar | traza_id, vehiculo, categoria, cantidad | consulta |
| `reservar_repuestos` | proveedor.reservar | traza_id, clave_idempotencia, items, minutos_vigencia | escribe |
| `consultar_reserva` | proveedor.reservar o proveedor.confirmar | traza_id, reserva_id | consulta |
| `confirmar_reserva` | proveedor.confirmar | traza_id, reserva_id, venta_id | escribe |
| `liberar_reserva` | proveedor.reservar o proveedor.confirmar | traza_id, reserva_id, motivo | destructiva |

## Concesionario (grupo Emerson)

Clientes que acepta: **taller** (proveedor.cotizar, proveedor.reservar, garantia.consultar); **ventas** (proveedor.confirmar); **auditor** (auditoria).

| Herramienta | Alcance | Entrada | Tipo |
|---|---|---|---|
| `buscar_repuestos` | proveedor.cotizar | traza_id, vehiculo, categoria, cantidad | consulta |
| `reservar_repuestos` | proveedor.reservar | traza_id, clave_idempotencia, items, minutos_vigencia | escribe |
| `consultar_reserva` | proveedor.reservar o proveedor.confirmar | traza_id, reserva_id | consulta |
| `confirmar_reserva` | proveedor.confirmar | traza_id, reserva_id, venta_id | escribe |
| `liberar_reserva` | proveedor.reservar o proveedor.confirmar | traza_id, reserva_id, motivo | destructiva |
| `consultar_vehiculo` | garantia.consultar | traza_id, vin | consulta |
| `evaluar_garantia` | garantia.consultar | traza_id, vin, kilometraje, categorias, descripcion_falla | consulta |

## Ventas y contabilidad (grupo Zaidy)

Clientes que acepta: **taller** (ventas.crear); **app** (ventas.consultar); **auditor** (auditoria).

| Herramienta | Alcance | Entrada | Tipo |
|---|---|---|---|
| `crear_venta` | ventas.crear | traza_id, clave_idempotencia, orden_id, pagador, lineas, url_notificacion | escribe |
| `consultar_venta` | ventas.crear o ventas.consultar | traza_id, venta_id | consulta |
| `generar_cobro` | ventas.crear o ventas.consultar | traza_id, venta_id | escribe |
| `anular_venta` | ventas.crear | traza_id, venta_id, motivo | destructiva |
| `consultar_liquidacion` | ventas.crear o ventas.consultar | traza_id, venta_id | consulta |

## Códigos de error

- `DATOS_INVALIDOS`
- `NO_ENCONTRADO`
- `NO_AUTORIZADO`
- `STOCK_INSUFICIENTE`
- `OFERTA_VENCIDA`
- `RESERVA_VENCIDA`
- `ESTADO_INVALIDO`
- `PRECIO_NO_COINCIDE`
- `IDEMPOTENCIA_CONFLICTO`
- `PROVEEDOR_NO_DISPONIBLE`
- `INTERNO`
