// Error de negocio con un código del contrato. Lánzelo desde los servicios; el controlador MCP lo
// convierte en un resultado con isError: true y { error: { codigo, mensaje, reintentable } }.
export class ErrorNegocio extends Error {
  constructor(
    readonly codigo: string,
    mensaje: string,
    readonly reintentable = false,
  ) {
    super(mensaje);
  }
}
