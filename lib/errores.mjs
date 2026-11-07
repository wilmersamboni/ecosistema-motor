// Error de negocio con un código del contrato. reintentable = el cliente puede repetir la llamada más tarde.
export class ErrorNegocio extends Error {
  constructor(codigo, mensaje, reintentable = false) {
    super(mensaje);
    this.codigo = codigo;
    this.reintentable = reintentable;
  }
}
export const falla = (codigo, mensaje, reintentable = false) => new ErrorNegocio(codigo, mensaje, reintentable);
