// Umbral de voz (puerta de ruido): decide cuando se transmite segun el nivel del microfono. Es logica pura: la usa
// el AudioWorklet en cada bloque y, si el worklet no pudo cargar, el bucle del hilo principal.
export const FLOOR_DB = -100;

const HOLD_MS = 320; // sigue abierta este tiempo despues de la ultima voz: no corta los finales de palabra
const HYSTERESIS_DB = 4; // abierta, recien se considera silencio este tanto debajo del umbral (no tartamudea en la marca)
const FLOOR_STEP_MS = 40;
// Con RNNoise tambien hay probabilidad de voz: un golpe de teclado o un ruido corto no abren la puerta...
const VOICE_PROB_MIN = 0.2;
const LOUD_OVER_DB = 18; // ...salvo que sea muy fuerte (mejor pasar un ruido que comerse un grito)

export function powerDb(power) {
  return power > 0 ? Math.max(FLOOR_DB, 10 * Math.log10(power)) : FLOOR_DB;
}

export function rmsDb(buf) {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return powerDb(sum / buf.length);
}

// Sensibilidad automatica: un poco por encima del ruido de fondo, dentro de limites razonables
export function autoThreshold(floor) {
  return Math.min(-28, Math.max(-62, floor + 13));
}

export class VoiceGate {
  constructor({ holdMs = HOLD_MS, hysteresisDb = HYSTERESIS_DB } = {}) {
    this.holdMs = holdMs;
    this.hysteresisDb = hysteresisDb;
    this.floor = -62;
    this.floorAt = -Infinity;
    this.holdUntil = 0;
    this.active = false;
    this.result = { threshold: 0, voiced: false, open: false, speaking: false };
  }

  // Piso de ruido: baja rapido y sube muy lento (para la sensibilidad automatica)
  trackFloor(db, now) {
    if (now - this.floorAt < FLOOR_STEP_MS) return;
    this.floorAt = now;
    if (db > FLOOR_DB + 1) this.floor += (db - this.floor) * (db < this.floor ? 0.25 : 0.004);
  }

  // db: nivel actual. p: { vad (false = pulsar para hablar), auto, threshold, transmit, voiceProb (0 a 1 o null) }
  // Devuelve siempre el mismo objeto: corre en el hilo de audio y no conviene generar basura.
  update(db, now, p) {
    this.trackFloor(db, now);
    const threshold = p.vad && p.auto ? autoThreshold(this.floor) : p.threshold;
    let above = db > (this.active ? threshold - this.hysteresisDb : threshold);
    if (above && !this.active && p.voiceProb !== null && p.voiceProb !== undefined && p.voiceProb < VOICE_PROB_MIN && db < threshold + LOUD_OVER_DB) above = false;
    if (above) this.holdUntil = now + this.holdMs;
    const voiced = above || now < this.holdUntil;
    this.active = voiced;
    const r = this.result;
    r.threshold = threshold;
    r.voiced = voiced;
    r.open = Boolean(p.transmit && (p.vad ? voiced : true));
    r.speaking = Boolean(p.transmit && voiced && db > FLOOR_DB + 1);
    return r;
  }
}

// Sigue la potencia de la señal bloque a bloque: sube casi al instante y baja suave, para no comerse el comienzo
// de una palabra. dtMs es lo que dura un bloque.
export class LevelFollower {
  constructor(dtMs, attackMs = 3, releaseMs = 25) {
    this.attack = 1 - Math.exp(-dtMs / attackMs);
    this.release = 1 - Math.exp(-dtMs / releaseMs);
    this.power = 0;
  }

  update(blockPower) {
    this.power += (blockPower - this.power) * (blockPower > this.power ? this.attack : this.release);
    return powerDb(this.power);
  }
}
