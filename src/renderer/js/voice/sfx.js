// Sonidos sintetizados en vivo con WebAudio (sin archivos ni material con derechos de autor):
// soundboard de la sala y avisos cortos (alguien entra, sale, mensaje, micro on/off).

// Botones del soundboard: id -> icono de ui.js (el texto sale de t('voice.sfx_<id>'))
export const SOUNDS = [
  { id: 'ding', icon: 'bell' },
  { id: 'coin', icon: 'coins' },
  { id: 'levelup', icon: 'upCircle' },
  { id: 'drum', icon: 'drum' },
  { id: 'horn', icon: 'megaphone' },
  { id: 'fail', icon: 'trendingDown' },
  { id: 'boom', icon: 'bomb' },
  { id: 'crickets', icon: 'bug' },
  { id: 'applause', icon: 'hand' },
];

export const SOUND_IDS = new Set(SOUNDS.map((s) => s.id));

const noiseCache = new WeakMap();

function noiseBuffer(ctx) {
  let buf = noiseCache.get(ctx);
  if (!buf) {
    buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    noiseCache.set(ctx, buf);
  }
  return buf;
}

// Envolvente percusiva: sube rapido y cae exponencialmente
function percussive(param, t0, peak, attack, dur) {
  param.setValueAtTime(0.0001, t0);
  param.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + attack);
  param.exponentialRampToValueAtTime(0.0001, t0 + dur);
}

// Envolvente sostenida: sube, se mantiene y se apaga
function sustained(param, t0, peak, attack, dur, release = 0.06) {
  param.setValueAtTime(0, t0);
  param.linearRampToValueAtTime(peak, t0 + attack);
  param.setValueAtTime(peak, t0 + Math.max(attack, dur - release));
  param.linearRampToValueAtTime(0, t0 + dur);
}

function tone(ctx, out, { type = 'sine', freq, freqEnd, t0, dur, gain = 0.2, attack = 0.005, shape = 'perc', detune = 0, vibrato = 0 }) {
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (freqEnd) osc.frequency.exponentialRampToValueAtTime(freqEnd, t0 + dur);
  osc.detune.value = detune;
  const g = ctx.createGain();
  if (shape === 'sus') sustained(g.gain, t0, gain, attack, dur);
  else percussive(g.gain, t0, gain, attack, dur);
  let lfo = null;
  if (vibrato) {
    lfo = ctx.createOscillator();
    const depth = ctx.createGain();
    lfo.frequency.value = 6;
    depth.gain.value = vibrato;
    lfo.connect(depth).connect(osc.frequency);
    lfo.start(t0);
    lfo.stop(t0 + dur + 0.05);
  }
  osc.connect(g).connect(out);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
}

function noise(ctx, out, { t0, dur, gain = 0.2, filter = 'bandpass', freq = 1000, freqEnd, q = 0.8, attack = 0.003 }) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx);
  const f = ctx.createBiquadFilter();
  f.type = filter;
  f.frequency.setValueAtTime(freq, t0);
  if (freqEnd) f.frequency.exponentialRampToValueAtTime(freqEnd, t0 + dur);
  f.Q.value = q;
  const g = ctx.createGain();
  percussive(g.gain, t0, gain, attack, dur);
  src.connect(f).connect(g).connect(out);
  src.start(t0, Math.random() * 1.5);
  src.stop(t0 + dur + 0.05);
}

function brass(ctx, out, { freqs, t0, dur, gain, cutoff = 2400, vibrato = 0 }) {
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = cutoff;
  lp.connect(out);
  for (const f of freqs) tone(ctx, lp, { type: 'sawtooth', freq: f, t0, dur, gain, attack: 0.03, shape: 'sus', vibrato });
}

const RECIPES = {
  ding(ctx, out, t0) {
    tone(ctx, out, { freq: 1318.5, t0, dur: 1.5, gain: 0.32 });
    tone(ctx, out, { freq: 2637, t0, dur: 0.9, gain: 0.08 });
    tone(ctx, out, { freq: 3951, t0, dur: 0.45, gain: 0.04 });
    return 1.5;
  },
  coin(ctx, out, t0) {
    tone(ctx, out, { type: 'square', freq: 987.77, t0, dur: 0.09, gain: 0.13, attack: 0.002 });
    tone(ctx, out, { type: 'square', freq: 1318.5, t0: t0 + 0.085, dur: 0.5, gain: 0.13, attack: 0.002 });
    return 0.6;
  },
  levelup(ctx, out, t0) {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(ctx, out, { type: 'triangle', freq: f, t0: t0 + i * 0.09, dur: i === 3 ? 0.6 : 0.18, gain: 0.26 }));
    tone(ctx, out, { freq: 2093, t0: t0 + 0.36, dur: 0.5, gain: 0.06 });
    return 1;
  },
  drum(ctx, out, t0) {
    tone(ctx, out, { freq: 220, freqEnd: 110, t0, dur: 0.25, gain: 0.7, attack: 0.003 });
    tone(ctx, out, { freq: 160, freqEnd: 75, t0: t0 + 0.17, dur: 0.3, gain: 0.8, attack: 0.003 });
    noise(ctx, out, { t0: t0 + 0.17, dur: 0.12, gain: 0.25, freq: 1800, q: 0.7 });
    noise(ctx, out, { t0: t0 + 0.4, dur: 1.1, gain: 0.32, filter: 'highpass', freq: 6500, q: 0.5 });
    return 1.5;
  },
  horn(ctx, out, t0) {
    const blast = (t, dur) => brass(ctx, out, { freqs: [466, 469, 932], t0: t, dur, gain: 0.12, cutoff: 2600 });
    blast(t0, 0.16);
    blast(t0 + 0.2, 0.16);
    blast(t0 + 0.4, 0.75);
    return 1.2;
  },
  fail(ctx, out, t0) {
    [392, 370, 349.2].forEach((f, i) => brass(ctx, out, { freqs: [f, f * 1.003], t0: t0 + i * 0.42, dur: 0.38, gain: 0.13, cutoff: 1300 }));
    brass(ctx, out, { freqs: [329.6, 330.6], t0: t0 + 1.26, dur: 1.1, gain: 0.13, cutoff: 1300, vibrato: 7 });
    return 2.4;
  },
  boom(ctx, out, t0) {
    noise(ctx, out, { t0, dur: 1.7, gain: 0.9, filter: 'lowpass', freq: 2200, freqEnd: 60, q: 0.4, attack: 0.004 });
    tone(ctx, out, { freq: 75, freqEnd: 32, t0, dur: 0.9, gain: 0.85, attack: 0.004 });
    return 1.8;
  },
  crickets(ctx, out, t0) {
    for (let group = 0; group < 3; group++) {
      for (let i = 0; i < 4; i++) {
        tone(ctx, out, { freq: 4400, t0: t0 + group * 0.62 + i * 0.055, dur: 0.04, gain: 0.07, attack: 0.004 });
        tone(ctx, out, { freq: 4750, t0: t0 + group * 0.62 + 0.3 + i * 0.05, dur: 0.035, gain: 0.04, attack: 0.004 });
      }
    }
    return 1.9;
  },
  applause(ctx, out, t0) {
    for (let i = 0; i < 110; i++) {
      const at = t0 + Math.pow(Math.random(), 1.3) * 2.1;
      noise(ctx, out, { t0: at, dur: 0.05 + Math.random() * 0.04, gain: 0.08 + Math.random() * 0.18, freq: 900 + Math.random() * 1800, q: 1.1 });
    }
    noise(ctx, out, { t0, dur: 2.4, gain: 0.08, freq: 1400, q: 0.5, attack: 0.25 });
    return 2.5;
  },
};

const CHIMES = {
  join(ctx, out, t0) {
    tone(ctx, out, { freq: 659.25, t0, dur: 0.16, gain: 0.16 });
    tone(ctx, out, { freq: 987.77, t0: t0 + 0.08, dur: 0.26, gain: 0.16 });
  },
  leave(ctx, out, t0) {
    tone(ctx, out, { freq: 987.77, t0, dur: 0.16, gain: 0.14 });
    tone(ctx, out, { freq: 659.25, t0: t0 + 0.08, dur: 0.26, gain: 0.14 });
  },
  mute(ctx, out, t0) {
    tone(ctx, out, { type: 'triangle', freq: 440, t0, dur: 0.09, gain: 0.14 });
    tone(ctx, out, { type: 'triangle', freq: 330, t0: t0 + 0.07, dur: 0.14, gain: 0.14 });
  },
  unmute(ctx, out, t0) {
    tone(ctx, out, { type: 'triangle', freq: 330, t0, dur: 0.09, gain: 0.14 });
    tone(ctx, out, { type: 'triangle', freq: 494, t0: t0 + 0.07, dur: 0.14, gain: 0.14 });
  },
  message(ctx, out, t0) {
    tone(ctx, out, { type: 'triangle', freq: 1174.7, t0, dur: 0.12, gain: 0.09 });
  },
};

function master(ctx, dest, volume) {
  const g = ctx.createGain();
  g.gain.value = Math.max(0, Math.min(1.5, volume));
  g.connect(dest || ctx.destination);
  return g;
}

// Reproduce un sonido del soundboard. Devuelve la duracion aproximada en segundos.
export function playSound(ctx, id, { volume = 0.8, dest } = {}) {
  const recipe = RECIPES[id];
  if (!ctx || !recipe) return 0;
  const out = master(ctx, dest, volume);
  const dur = recipe(ctx, out, ctx.currentTime + 0.02);
  setTimeout(() => out.disconnect(), (dur + 0.5) * 1000);
  return dur;
}

export function playChime(ctx, kind, { volume = 0.6, dest } = {}) {
  const recipe = CHIMES[kind];
  if (!ctx || !recipe) return;
  const out = master(ctx, dest, volume);
  recipe(ctx, out, ctx.currentTime + 0.01);
  setTimeout(() => out.disconnect(), 1200);
}
