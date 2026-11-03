// Nivelacion de las voces de los demas: una ganancia lenta lleva a cada persona a un mismo volumen y un compresor
// contiene los picos (un grito, un golpe al micro). Logica pura; los nodos de audio estan en voice.js.
export const LEVEL_TARGET_DB = -23; // nivel de voz (RMS) al que se lleva a cada uno
const MAX_BOOST_DB = 12;
const MAX_CUT_DB = -9;
const SPEECH_MIN_DB = -52; // mas bajo que esto no se considera voz: el silencio no mueve la ganancia
const SPEECH_NEAR_DB = 20; // tampoco los finales de palabra, muy por debajo del nivel de esa persona
const FAST_MS = 1500; // al principio aprende rapido; despues, despacio para no bombear
const FAST_TAU_MS = 300;
const SLOW_TAU_MS = 3500;

export const VOICE_COMPRESSOR = { threshold: -20, knee: 10, ratio: 4, attack: 0.005, release: 0.18 };
export const MIX_LIMITER = { threshold: -3, knee: 0, ratio: 20, attack: 0.002, release: 0.12 };

export class VoiceLeveler {
  constructor() {
    this.estimate = null;
    this.speechMs = 0;
  }

  // db: nivel de la voz en esta muestra; dtMs: tiempo desde la anterior. Devuelve la ganancia a aplicar (lineal).
  update(db, dtMs) {
    const isSpeech = db > SPEECH_MIN_DB && (this.estimate === null || db > this.estimate - SPEECH_NEAR_DB);
    if (isSpeech) {
      if (this.estimate === null) this.estimate = db;
      else {
        const tau = this.speechMs < FAST_MS ? FAST_TAU_MS : SLOW_TAU_MS;
        this.estimate += (db - this.estimate) * (1 - Math.exp(-dtMs / tau));
      }
      this.speechMs += dtMs;
    }
    return this.gain;
  }

  get gainDb() {
    if (this.estimate === null) return 0;
    return Math.min(MAX_BOOST_DB, Math.max(MAX_CUT_DB, LEVEL_TARGET_DB - this.estimate));
  }

  get gain() {
    return 10 ** (this.gainDb / 20);
  }
}

// El DynamicsCompressorNode sube todo con una ganancia automatica ("makeup") que depende de sus parametros: sin
// descontarla, una voz por debajo del umbral saldria mas fuerte de lo que entro. Es la misma cuenta que hace Chromium
// (DynamicsCompressorKernel); devuelve cuantos dB agrega el nodo.
export function compressorMakeupDb({ threshold, knee, ratio }) {
  const toLin = (db) => 10 ** (db / 20);
  const toDb = (x) => 20 * Math.log10(x);
  const thrLin = toLin(threshold);
  const kneeCurve = (x, k) => (x < thrLin ? x : thrLin + (1 - Math.exp(-k * (x - thrLin))) / k);
  const slopeAt = (x, k) => {
    if (x < thrLin) return 1;
    const x2 = x * 1.001;
    return (toDb(kneeCurve(x2, k)) - toDb(kneeCurve(x, k))) / (toDb(x2) - toDb(x));
  };
  const kneeEnd = toLin(threshold + knee);
  let minK = 0.1;
  let maxK = 10000;
  let k = 5;
  for (let i = 0; i < 15; i++) {
    if (slopeAt(kneeEnd, k) < 1 / ratio) maxK = k;
    else minK = k;
    k = Math.sqrt(minK * maxK);
  }
  const yKneeDb = toDb(kneeCurve(kneeEnd, k));
  const fullRange = toLin(yKneeDb + (0 - (threshold + knee)) / ratio);
  return 0.6 * toDb(1 / fullRange);
}
