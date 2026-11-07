# Reglas de negocio del contrato MotorRed 1.0

Los esquemas (`esquemas.mjs`) dicen la forma de los datos. Este documento dice el comportamiento. Las
pruebas de conformidad y los escenarios comprueban estas reglas.

## Reglas para todos los servicios

- **Dinero.** Pesos enteros. El IVA se calcula por línea (`round(cantidad × precio × iva / 100)`) y se suma.
- **Credenciales.** `POST /oauth/token` con `grant_type=client_credentials`.
  - Un secreto errado responde 401 `invalid_client`.
  - Un alcance no permitido responde 400 `invalid_scope`.
  - El token dura 3600 s.
  - El emisor (`iss`) es el grupo y la audiencia (`aud`) es `mcp`.
- **MCP.**
  - Sin token, o con un token inválido, la respuesta es 401 con `WWW-Authenticate: Bearer`.
  - Cada cliente ve solo las herramientas de sus alcances.
- **Errores.** Se devuelven con `isError: true` y el JSON `{ error: { codigo, mensaje, reintentable } }` en `content[0].text`.
- **Propiedad por orden.**
  - Una reserva o una venta se consulta con su `traza_id`.
  - Con otra traza, la respuesta es `NO_ENCONTRADO`, no 403: así no se revela que existe.
- **Idempotencia.**
  - La clave pertenece al cliente que llama.
  - La misma clave con los mismos datos devuelve lo mismo.
  - La misma clave con otros datos responde `IDEMPOTENCIA_CONFLICTO`.
  - Llamadas simultáneas con la misma clave producen un solo efecto.
- **Bitácora.**
  - Cada servicio registra una línea por herramienta: `ts`, `servicio`, `traza_id`, `cliente`, `herramienta`, `ok`, `ms` y, si falla, `error`.
  - También registra los eventos de negocio de `EVENTOS_BITACORA`.
  - La bitácora se publica en `GET /bitacora?traza_id=` para el cliente `auditor`.

## Tienda y concesionario (proveedores)

- **Compatibilidad.** Se compara sin tildes ni mayúsculas:
  - La marca y la línea deben ser iguales, o `*`. La línea del vehículo puede tener más palabras: "Spark GT" es compatible con "spark".
  - El motor del vehículo debe contener el del producto: "1.2L gasolina" contiene "1.2".
  - El año del vehículo debe estar dentro del rango.
- **`buscar_repuestos`.**
  - Devuelve todas las ofertas compatibles con su `stock_disponible`, sin filtrar por la cantidad pedida. El taller decide.
  - Una oferta vale 120 minutos.
  - El `oferta_id` es aleatorio y el proveedor lo guarda: una oferta inventada responde `NO_ENCONTRADO`.
  - Una oferta vencida responde `OFERTA_VENCIDA`.
- **`reservar_repuestos`.**
  - El precio y el IVA quedan congelados con los de la oferta.
  - Las cantidades del mismo SKU se suman antes de revisar el stock (`STOCK_INSUFICIENTE`).
  - El stock se descuenta en la misma operación, sin que otra reserva pueda colarse en medio. En PostgreSQL esto se logra con una transacción y bloqueo de filas.
  - Al vencer, la reserva queda `vencida` y las unidades vuelven al inventario.
- **`confirmar_reserva`** (solo ventas).
  - Pasa una reserva `activa` a `confirmada` con su `venta_id` y la guía de despacho.
  - Si se repite con la misma venta, no cambia nada.
  - Si la reserva está vencida, responde `RESERVA_VENCIDA`. Si está en otro estado, `ESTADO_INVALIDO`.
- **`liberar_reserva`.**
  - Una reserva activa la libera el taller o ventas.
  - Una confirmada solo la libera ventas: el taller recibe `ESTADO_INVALIDO`.
  - Las unidades vuelven al inventario.
- **IVA de los repuestos.** 19%, salvo que el catálogo diga otra cosa para un producto.
- **Rutas de laboratorio.** Solo con `SANDBOX=1` y la cabecera `X-Sandbox-Llave`.
  - `POST /sandbox/vencer/:reserva_id` vence una reserva.
  - `POST /sandbox/reabastecer` deja cada producto con al menos el stock del catálogo, aunque haya reservas activas de pruebas anteriores.
  - Con el cuerpo `{ "minimo": N }`, `reabastecer` sube cada producto al menos a N unidades.

## Concesionario (además)

- **Garantía de fábrica.** Dura 3 años desde la fecha de venta o 100.000 km, lo que ocurra primero.
- **Lo que no cubre** (desgaste): bujías, frenos, filtros, aceite, batería y embrague.
- **Lo que cubre:** bobina de encendido, sensor de oxígeno y bomba de agua.
- **Autorización.** Cada decisión que cubre algo lleva un número de autorización `GAR-…`.

## Ventas

- **Verificaciones.** Cada línea de repuesto se verifica contra la reserva del proveedor:
  - La reserva debe estar activa y ser de la misma traza.
  - El SKU, el precio, el IVA y la cantidad deben coincidir con la reserva.
  - La reserva no puede pertenecer a otra venta.
- **Servicios.** Solo los factura el taller, y sin reserva.
- **Garantía.**
  - Los repuestos en garantía van con concepto `garantia` y precio 0, y los entrega el concesionario.
  - Van en la venta cuyo pagador es el concesionario.
  - Esa venta lleva `pagador.autorizacion` con el número `GAR-…`.
- **Notificaciones.** `url_notificacion` solo puede apuntar a servicios del ecosistema (`NOTIFICACIONES_PERMITIDAS`).
- **Retención en la fuente.**
  - Solo si el pagador es agente de retención.
  - Se agrupa por beneficiario y concepto, con la tarifa y la base mínima vigentes (parámetros).
  - El valor retenido se descuenta del total a pagar.
- **Comisión.** 3% sobre la base de cada beneficiario, más su IVA.
- **Neto de cada beneficiario.** Base + IVA − retención − comisión − IVA de la comisión.
- **Webhook de la pasarela.**
  - Se rechaza si la firma es inválida o tiene más de 5 minutos.
  - Es idempotente por `evento_id`. Un evento solo queda procesado cuando terminó bien; si falla, la pasarela lo reintenta.
- **Saga después del pago.**
  - Se confirma cada reserva.
  - Si una falla, se liberan las reservas de esta venta, se reembolsa y la venta queda `reembolsada`.
  - Si el reembolso falla, la venta queda `en_revision`.
- **Pasa a `en_revision`, sin dispersar, cuando:**
  - el monto de la pasarela es distinto al de la venta;
  - la liquidación no cuadra.
- **Eventos al taller.** Se envían en orden por venta: `venta.pagada` antes que `venta.liquidada`.

## Taller

- **Estados.** `recibida → diagnosticada → cotizada → pendiente_pago → en_reparacion`.
  - Si la saga reembolsó, la orden queda en `requiere_nueva_cotizacion`.
  - Si una venta se cobró y otra se devolvió, queda en `en_revision`.
- **Cotización.**
  - Cada cotización sube `cotizacion`.
  - Las claves de idempotencia de reservas y ventas incluyen el número de cotización.
  - Antes de cotizar de nuevo se anulan las ventas sin pagar. Si alguna recibió dinero, la cotización se rechaza (`ESTADO_INVALIDO`) y decide una persona.
- **Opciones.** Económica (menor precio), rápida (menor tiempo de entrega) y original (solo repuestos originales). Las repetidas se descartan.
- **Recomendación.** La original, si cuesta como máximo 15% más que la económica para el cliente; si no, la económica.
- **Mano de obra en garantía.** Se reparte en proporción a las categorías cubiertas (regla de práctica).
- **Aprobación.**
  - Solo con aprobación del cliente.
  - Una segunda aprobación simultánea responde `ESTADO_INVALIDO`.
  - Si una reserva falla, se liberan las demás.
- **Eventos de ventas.** Con firma, idempotentes, y solo hacen avanzar el estado de una venta.
