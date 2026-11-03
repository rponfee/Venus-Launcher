// Calidad de la red en una llamada: bitrate de voz segun la perdida de paquetes y estado que ve el usuario.
// Es logica pura: se alimenta con los numeros de getStats() y se prueba sin WebRTC.
export const VOICE_QUALITIES = {
  low: { bitrate: 40000 }, // conexiones lentas
  normal: { bitrate: 80000 },
  high: { bitrate: 128000 },
};
export const DEFAULT_QUALITY = 'normal';
export const MIN_BITRATE = 24000; // por debajo de esto, Opus con FEC ya pierde mucha calidad
const FULL_RATE_PEERS = 5; // en malla se manda una copia por persona: en salas mas grandes baja el tope

// Perdida (%) que dispara cada reaccion. Hasta ~5 % la FEC la tapa bien; hay que bajar cuando es congestion.
const LOSS_SEVERE = 15;
const LOSS_HIGH = 5;
const LOSS_CLEAN = 2;
const CLEAN_RUNS_TO_RAISE = 3; // informes limpios seguidos antes de volver a subir (el otro informa cada pocos segundos)
const MIN_PACKETS = 10; // con menos paquetes que esto (silencio con DTX) la perdida no dice nada

export function qualityBitrate(quality) {
  return (VOICE_QUALITIES[quality] || VOICE_QUALITIES[DEFAULT_QUALITY]).bitrate;
}

// Tope por conexion segun la calidad elegida y cuantas conexiones hay
export function bitrateCap(quality, peers) {
  const n = Math.max(1, Number(peers) || 1);
  return Math.round(Math.max(MIN_BITRATE, qualityBitrate(quality) * Math.min(1, FULL_RATE_PEERS / n)));
}

export function newBitrateState(cap) {
  return { bps: cap, clean: 0 };
}

// Un paso del bitrate adaptativo: lossPct es la perdida de lo que mandamos (null = sin datos nuevos, no cambia nada)
export function nextBitrate(state, { lossPct, cap }) {
  let { bps, clean } = state;
  if (lossPct === null || lossPct === undefined) return { bps: Math.max(MIN_BITRATE, Math.min(bps, cap)), clean };
  if (lossPct >= LOSS_SEVERE) {
    bps *= 0.6;
    clean = 0;
  } else if (lossPct >= LOSS_HIGH) {
    bps *= 0.8;
    clean = 0;
  } else if (lossPct >= LOSS_CLEAN) {
    clean = 0;
  } else if (++clean >= CLEAN_RUNS_TO_RAISE) {
    bps += Math.max(4000, cap * 0.1);
    clean = 0;
  }
  return { bps: Math.round(Math.max(MIN_BITRATE, Math.min(bps, cap))), clean };
}

// Junta lo que interesa de los reportes de getStats() (cualquier iterable de objetos de estadisticas)
export function readAudioStats(reports) {
  const out = { rttMs: null, upFraction: null, upAt: null, received: 0, lost: 0, jitterMs: null, concealed: 0, silentConcealed: 0, samples: 0, hasInbound: false };
  for (const r of reports) {
    if ((r.kind || r.mediaType) !== 'audio') continue;
    if (r.type === 'remote-inbound-rtp') {
      if (typeof r.fractionLost === 'number') out.upFraction = r.fractionLost;
      if (typeof r.roundTripTime === 'number') out.rttMs = Math.round(r.roundTripTime * 1000);
      out.upAt = r.timestamp ?? null;
    } else if (r.type === 'inbound-rtp') {
      out.hasInbound = true;
      out.received += r.packetsReceived || 0;
      out.lost += r.packetsLost || 0;
      out.concealed += r.concealedSamples || 0;
      out.silentConcealed += r.silentConcealedSamples || 0;
      out.samples += r.totalSamplesReceived || 0;
      if (typeof r.jitter === 'number') out.jitterMs = Math.round(r.jitter * 1000);
    }
  }
  return out;
}

// Compara dos lecturas seguidas: perdida de subida (segun el informe del otro) y de bajada, en %; null si no hay datos
export function lossSample(prev, cur) {
  // El informe del otro llega cada varios segundos: si es el mismo de la vuelta anterior, no es un dato nuevo
  const upLossPct = cur.upFraction !== null && cur.upAt !== prev?.upAt ? Math.min(100, cur.upFraction * 100) : null;
  let downLossPct = null;
  let concealPct = null;
  if (prev && cur.hasInbound) {
    const received = Math.max(0, cur.received - prev.received);
    const lost = Math.max(0, cur.lost - prev.lost);
    if (received + lost >= MIN_PACKETS) downLossPct = Math.min(100, (lost * 100) / (received + lost));
    const samples = cur.samples - prev.samples;
    if (samples > 0) {
      const concealed = Math.max(0, cur.concealed - cur.silentConcealed - (prev.concealed - prev.silentConcealed));
      concealPct = Math.min(100, (concealed * 100) / samples);
    }
  }
  return { upLossPct, downLossPct, concealPct, rttMs: cur.rttMs, jitterMs: cur.jitterMs };
}

// La peor perdida entre ida y vuelta (null si no hay ningun dato)
export function worstLoss(sample) {
  const list = [sample.upLossPct, sample.downLossPct].filter((x) => x !== null && x !== undefined);
  return list.length ? Math.max(...list) : null;
}

const RANK = { good: 0, fair: 1, bad: 2 };

export function classifyQuality(sample) {
  const loss = worstLoss(sample) ?? 0;
  const rtt = sample.rttMs ?? 0;
  const jitter = sample.jitterMs ?? 0;
  const conceal = sample.concealPct ?? 0;
  if (loss >= 10 || rtt >= 600 || jitter >= 100 || conceal >= 20) return 'bad';
  if (loss >= 3 || rtt >= 300 || jitter >= 50 || conceal >= 8) return 'fair';
  return 'good';
}

export function newQualityState() {
  return { level: 'good', pending: null, streak: 0 };
}

// Estado que ve el usuario: empeora con 2 muestras seguidas y mejora con 3, para no parpadear por un pico suelto
export function nextQuality(state, sample) {
  const raw = classifyQuality(sample);
  if (raw === state.level) return { level: state.level, pending: null, streak: 0 };
  const streak = raw === state.pending ? state.streak + 1 : 1;
  const needed = RANK[raw] > RANK[state.level] ? 2 : 3;
  if (streak >= needed) return { level: raw, pending: null, streak: 0 };
  return { level: state.level, pending: raw, streak };
}
