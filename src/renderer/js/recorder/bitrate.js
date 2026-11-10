// Bitrate de video de la grabadora (sin DOM: lo prueba capture/test/logic.test.js contra capture/logic.js). El
// modelo (bits por pixel, curva de los fps, factor de cada codec, cuanto gasta de mas un codificador por hardware y
// topes) lo decide el proceso principal (logic.bitrateModel) y llega con la orden de empezar: aca solo se aplica al
// tamanio real de la ventana y al codec que se eligio.

export const DEFAULT_MODEL = Object.freeze({ bpp: 0.1, fpsExp: 0.7, min: 1500000, max: 100000000, factors: Object.freeze({ vp9: 1 }), hw: Object.freeze({ k: 2.5, exp: 0.75 }) });

/**
 * Bits por segundo para pedirle a MediaRecorder: w x h a `fps` cuadros con ese codec. Los fps no cuestan lineal:
 * 30 * (fps / 30) ^ fpsExp "cuadros equivalentes". Por hardware se pide menos (la GPU gasta hw.k * (fps/60)^hw.exp
 * veces lo pedido), asi el archivo pesa lo mismo que con los otros codecs.
 */
export function bitrateFor(width, height, fps, model = DEFAULT_MODEL, codec = 'vp9', hardware = false) {
  const m = model && typeof model === 'object' ? model : DEFAULT_MODEL;
  const min = Number(m.min) || DEFAULT_MODEL.min;
  const pixels = Math.max(1, Number(width) || 0) * Math.max(1, Number(height) || 0);
  const f = Math.max(1, Number(fps) || 30);
  const eff = 30 * Math.pow(f / 30, Number(m.fpsExp) || DEFAULT_MODEL.fpsExp);
  const factor = Number(m.factors?.[codec]) || 1;
  const raw = pixels * eff * (Number(m.bpp) || DEFAULT_MODEL.bpp) * factor;
  const target = Math.round(Math.min(Number(m.max) || DEFAULT_MODEL.max, Math.max(min, raw)));
  if (!hardware) return target;
  const hw = m.hw || DEFAULT_MODEL.hw;
  const over = (Number(hw.k) || DEFAULT_MODEL.hw.k) * Math.pow(f / 60, Number(hw.exp) || DEFAULT_MODEL.hw.exp);
  return Math.max(Math.round(min / 2), Math.round(target / over));
}
