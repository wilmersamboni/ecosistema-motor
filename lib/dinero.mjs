// Cálculos de dinero en pesos enteros. Regla del ecosistema: el IVA se calcula por línea y se redondea
// al peso; las sumas se hacen con enteros. Así todos los grupos obtienen exactamente los mismos totales.
export const redondear = (valor) => Math.round(valor);
export const baseLinea = (l) => l.cantidad * l.precio_unitario;
export const ivaLinea = (l) => redondear((baseLinea(l) * l.iva_porcentaje) / 100);

export function totales(lineas) {
  const subtotal = lineas.reduce((s, l) => s + baseLinea(l), 0);
  const iva = lineas.reduce((s, l) => s + ivaLinea(l), 0);
  return { subtotal, iva, total: subtotal + iva };
}

// Retención en la fuente que practica un pagador agente de retención, por beneficiario y concepto.
export function retenciones(lineas, pagador, parametros) {
  const porBeneficiario = {};
  if (!pagador.retenedor) return porBeneficiario;
  const grupos = {};
  for (const l of lineas.filter((x) => x.concepto !== 'garantia')) {
    const clave = `${l.beneficiario}|${l.concepto}`;
    grupos[clave] = (grupos[clave] ?? 0) + baseLinea(l);
  }
  for (const [clave, base] of Object.entries(grupos)) {
    const [beneficiario, concepto] = clave.split('|');
    const regla = parametros.retefuente[concepto];
    const valor = base >= regla.base_uvt * parametros.uvt ? redondear((base * regla.tarifa) / 100) : 0;
    porBeneficiario[beneficiario] = (porBeneficiario[beneficiario] ?? 0) + valor;
  }
  return porBeneficiario;
}

// Liquidación de una venta pagada: cuánto recibe cada beneficiario, cuánto queda para la plataforma
// y los asientos contables (partida doble). Códigos del PUC ilustrativos: valídelos con un contador.
export function liquidar(venta, parametros) {
  const ret = retenciones(venta.lineas, venta.pagador, parametros);
  const conValor = venta.lineas.filter((l) => l.concepto !== 'garantia');
  const beneficiarios = [...new Set(conValor.map((l) => l.beneficiario))];
  const dispersiones = beneficiarios.map((b) => {
    const propias = conValor.filter((l) => l.beneficiario === b);
    const { subtotal: base, iva } = totales(propias);
    const retencion = ret[b] ?? 0;
    const comision = redondear((base * parametros.comision_porcentaje) / 100);
    const iva_comision = redondear((comision * parametros.iva_porcentaje) / 100);
    return { beneficiario: b, base, iva, retencion, comision, iva_comision, neto: base + iva - retencion - comision - iva_comision };
  });
  const recaudado = venta.total_a_pagar;
  const ingreso = dispersiones.reduce((s, d) => s + d.comision + d.iva_comision, 0);
  const asientos = [{ cuenta: '111005', nombre_cuenta: 'Bancos - cuenta de recaudo', tercero: 'MotorRed', debito: recaudado, credito: 0 }];
  for (const d of dispersiones) {
    asientos.push({ cuenta: '281505', nombre_cuenta: 'Ingresos recibidos para terceros', tercero: d.beneficiario, debito: 0, credito: d.base + d.iva - d.retencion });
  }
  for (const d of dispersiones) {
    asientos.push({ cuenta: '281505', nombre_cuenta: 'Ingresos recibidos para terceros', tercero: d.beneficiario, debito: d.comision + d.iva_comision, credito: 0 });
    asientos.push({ cuenta: '415595', nombre_cuenta: 'Comisiones de la plataforma', tercero: d.beneficiario, debito: 0, credito: d.comision });
    asientos.push({ cuenta: '240810', nombre_cuenta: 'IVA generado sobre la comisión', tercero: 'DIAN', debito: 0, credito: d.iva_comision });
  }
  for (const d of dispersiones) {
    asientos.push({ cuenta: '281505', nombre_cuenta: 'Ingresos recibidos para terceros', tercero: d.beneficiario, debito: d.neto, credito: 0 });
    asientos.push({ cuenta: '111005', nombre_cuenta: 'Bancos - dispersión', tercero: d.beneficiario, debito: 0, credito: d.neto });
  }
  const debitos = asientos.reduce((s, a) => s + a.debito, 0);
  const creditos = asientos.reduce((s, a) => s + a.credito, 0);
  const cuadra = debitos === creditos && dispersiones.reduce((s, d) => s + d.neto, 0) + ingreso === recaudado && dispersiones.every((d) => d.neto >= 0);
  return { recaudado, dispersiones, ingreso_plataforma: ingreso, asientos, cuadra };
}

export const sinTildes = (t) => String(t).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
