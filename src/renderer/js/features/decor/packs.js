// Paquetes de sonidos de la interfaz, sintetizados (nunca archivos). Cada sonido es una lista de voces:
//   { wave, freq, to?, at?, dur, gain, attack?, lowpass? }
//   wave: tipo de oscilador · freq: Hz al empezar · to: Hz al terminar (deslizamiento) · at: segundos desde el inicio
//   dur: segundos de la voz · gain: 0-1 relativo al volumen · attack: ataque en segundos · lowpass: filtro en Hz
// Sin DOM: lo toca sounds.js con AudioContext. Se prueba con Node puro (test/packs.test.js).

export const SOUND_IDS = ['click', 'open', 'success', 'error'];
export const UI_SOUND_IDS = ['click', 'whoosh', 'bell']; // window 'venus:ui-sound' (botón Jugar)
export const WAVES = ['sine', 'square', 'triangle', 'sawtooth'];
export const FREQ_RANGE = [40, 8000]; // Hz
export const DUR_RANGE = [0.01, 1]; // segundos por voz
export const MAX_LENGTH = 1.2; // segundos de un sonido completo

// Notas: C5 523.25 · E5 659.25 · G5 783.99 · C6 1046.5 · A4 440 · A5 880
export const PACKS = {
  // Redondeado y bajo: senos y triángulos con deslizamientos cortos.
  soft: {
    click: [{ wave: 'triangle', freq: 640, to: 480, dur: 0.05, gain: 0.5 }],
    open: [
      { wave: 'sine', freq: 392, to: 587.33, dur: 0.16, gain: 0.45 },
      { wave: 'sine', freq: 783.99, at: 0.06, dur: 0.14, gain: 0.2 },
    ],
    success: [
      { wave: 'sine', freq: 523.25, dur: 0.12, gain: 0.45 },
      { wave: 'sine', freq: 783.99, at: 0.1, dur: 0.22, gain: 0.45 },
    ],
    error: [
      { wave: 'triangle', freq: 220, to: 170, dur: 0.18, gain: 0.5 },
      { wave: 'triangle', freq: 165, to: 130, at: 0.16, dur: 0.22, gain: 0.45 },
    ],
  },
  // Chiptune: ondas cuadradas, notas cortas y arpegios.
  pixel: {
    click: [{ wave: 'square', freq: 880, dur: 0.03, gain: 0.25 }],
    open: [
      { wave: 'square', freq: 440, dur: 0.05, gain: 0.25 },
      { wave: 'square', freq: 880, at: 0.05, dur: 0.07, gain: 0.25 },
    ],
    success: [
      { wave: 'square', freq: 523.25, dur: 0.06, gain: 0.25 },
      { wave: 'square', freq: 659.25, at: 0.06, dur: 0.06, gain: 0.25 },
      { wave: 'square', freq: 783.99, at: 0.12, dur: 0.06, gain: 0.25 },
      { wave: 'square', freq: 1046.5, at: 0.18, dur: 0.12, gain: 0.25 },
    ],
    error: [
      { wave: 'square', freq: 196, dur: 0.09, gain: 0.3 },
      { wave: 'square', freq: 146.83, at: 0.1, dur: 0.16, gain: 0.3 },
    ],
  },
  // Espacial: barridos largos con filtro y acordes abiertos.
  space: {
    click: [{ wave: 'sine', freq: 1400, to: 700, dur: 0.07, gain: 0.4, lowpass: 2400 }],
    open: [
      { wave: 'sawtooth', freq: 110, to: 440, dur: 0.28, gain: 0.3, lowpass: 900 },
      { wave: 'sine', freq: 880, at: 0.12, dur: 0.25, gain: 0.15 },
    ],
    success: [
      { wave: 'sine', freq: 440, dur: 0.35, gain: 0.3 },
      { wave: 'sine', freq: 659.25, at: 0.02, dur: 0.35, gain: 0.25 },
      { wave: 'triangle', freq: 1318.5, at: 0.08, dur: 0.3, gain: 0.12 },
    ],
    error: [{ wave: 'sawtooth', freq: 160, to: 60, dur: 0.32, gain: 0.3, lowpass: 700 }],
  },
};

// Sonidos del botón Jugar (window 'venus:ui-sound'): iguales en todos los packs; 'click' usa el del pack.
export const EXTRA = {
  whoosh: [
    { wave: 'triangle', freq: 180, to: 1400, dur: 0.22, gain: 0.3, lowpass: 1800 },
    { wave: 'sine', freq: 1400, to: 300, at: 0.18, dur: 0.22, gain: 0.25 },
  ],
  bell: [
    { wave: 'sine', freq: 880, dur: 0.6, gain: 0.4 },
    { wave: 'sine', freq: 1760, dur: 0.45, gain: 0.15 },
    { wave: 'sine', freq: 2640, dur: 0.3, gain: 0.07 },
  ],
};

const copy = (voices) => voices.map((v) => ({ ...v }));

// Voces de un sonido de la interfaz (click, open, success, error) del pack; null si no existe.
export function soundSpec(pack, id) {
  const p = PACKS[pack] || PACKS.soft;
  const voices = p[id];
  return Array.isArray(voices) ? copy(voices) : null;
}

// Voces de un sonido pedido por 'venus:ui-sound' (click, whoosh, bell); null si el id no existe.
export function uiSoundSpec(pack, id) {
  if (id === 'click') return soundSpec(pack, 'click');
  const voices = EXTRA[id];
  return Array.isArray(voices) ? copy(voices) : null;
}

// Duración total de un sonido (segundos): la voz que termina más tarde.
export function soundLength(voices) {
  let end = 0;
  for (const v of voices || []) end = Math.max(end, (v.at || 0) + (v.dur || 0));
  return end;
}

// Volumen 0-100 -> ganancia del nodo maestro. Curva suave y tope bajo: los sonidos de la interfaz acompañan,
// no molestan.
export function volumeGain(volume) {
  const v = Math.min(100, Math.max(0, Number(volume) || 0));
  return Math.pow(v / 100, 1.6) * 0.6;
}
