// Cuentas del editor de clips (sin DOM, se prueban con node:test): recorte vertical 9:16, tamanio de salida,
// bitrate de la exportacion y limites del recorte de inicio y fin.

export const VERTICAL = 9 / 16;
export const MIN_CLIP = 0.5; // segundos

const even = (n) => Math.max(2, Math.floor(n / 2) * 2);
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));

/**
 * Recorte de un video de w x h a la proporcion `aspect` (ancho/alto). pos (0 a 1) elige donde: 0 = borde
 * izquierdo (o de arriba), 0,5 = centrado, 1 = borde derecho. Devuelve { sx, sy, sw, sh } en pixeles enteros.
 */
export function verticalCrop(w, h, pos = 0.5, aspect = VERTICAL) {
  const W = Math.max(1, Math.round(Number(w) || 0));
  const H = Math.max(1, Math.round(Number(h) || 0));
  const p = clamp(Number.isFinite(Number(pos)) ? Number(pos) : 0.5, 0, 1);
  if (W / H > aspect) {
    // Mas ancho que lo pedido: se recorta a los costados
    const sw = Math.min(W, Math.max(1, Math.round(H * aspect)));
    return { sx: Math.round((W - sw) * p), sy: 0, sw, sh: H };
  }
  // Mas alto (o igual): se recorta arriba y abajo
  const sh = Math.min(H, Math.max(1, Math.round(W / aspect)));
  return { sx: 0, sy: Math.round((H - sh) * p), sw: W, sh };
}

/**
 * Tamanio del video exportado. vertical: 1080 x 1920 como mucho (sin agrandar mas que el recorte);
 * horizontal: el recorte entero con tope de 1920 x 1080. Lados pares (lo pide el codec).
 */
export function outputSize(crop, mode) {
  const box = mode === 'vertical' ? { w: 1080, h: 1920 } : { w: 1920, h: 1080 };
  const k = Math.min(1, box.w / crop.sw, box.h / crop.sh);
  return { width: even(crop.sw * k), height: even(crop.sh * k) };
}

// Bitrate de video de la exportacion (como el de la grabacion: ~0,11 bits por pixel a 30 fps)
export function exportBitrate(width, height, fps = 30) {
  const rate = fps >= 60 ? 45 : 30;
  return Math.round(clamp(width * height * rate * 0.11, 2e6, 16e6));
}

// Inicio y fin validos dentro de la duracion, con al menos MIN_CLIP segundos entre los dos
export function clampTrim(start, end, duration) {
  const d = Math.max(0, Number(duration) || 0);
  if (d <= MIN_CLIP) return { start: 0, end: d };
  let s = clamp(Number(start) || 0, 0, d - MIN_CLIP);
  let e = clamp(Number.isFinite(Number(end)) ? Number(end) : d, MIN_CLIP, d);
  if (e - s < MIN_CLIP) {
    if (s + MIN_CLIP <= d) e = s + MIN_CLIP;
    else s = e - MIN_CLIP;
  }
  return { start: Math.round(s * 100) / 100, end: Math.round(e * 100) / 100 };
}

// "1:05.3" para mostrar tiempos del editor
export function fmtClock(sec, decimals = 1) {
  const s = Math.max(0, Number(sec) || 0);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  const txt = rest.toFixed(decimals).padStart(decimals ? 3 + decimals : 2, '0');
  return `${m}:${txt}`;
}
