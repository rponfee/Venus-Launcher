// Bitrate adaptativo y estado de calidad de la conexion.
// node --test "src/renderer/js/voice/test/*.test.js"
import test from 'node:test';
import assert from 'node:assert/strict';
import { VOICE_QUALITIES, MIN_BITRATE, qualityBitrate, bitrateCap, newBitrateState, nextBitrate, readAudioStats, lossSample, worstLoss, classifyQuality, newQualityState, nextQuality } from '../net.js';

const CAP = VOICE_QUALITIES.normal.bitrate;

test('la calidad mayor gasta mas y una desconocida usa la normal', () => {
  assert.ok(VOICE_QUALITIES.low.bitrate < VOICE_QUALITIES.normal.bitrate);
  assert.ok(VOICE_QUALITIES.normal.bitrate < VOICE_QUALITIES.high.bitrate);
  assert.equal(qualityBitrate('nada'), VOICE_QUALITIES.normal.bitrate);
  assert.equal(qualityBitrate(undefined), VOICE_QUALITIES.normal.bitrate);
});

test('el tope baja recien en salas grandes y nunca debajo del minimo', () => {
  assert.equal(bitrateCap('normal', 1), CAP);
  assert.equal(bitrateCap('normal', 5), CAP);
  assert.ok(bitrateCap('normal', 7) < CAP);
  assert.ok(bitrateCap('normal', 7) >= MIN_BITRATE);
  assert.equal(bitrateCap('normal', 0), CAP);
  assert.ok(bitrateCap('low', 500) === MIN_BITRATE);
});

test('la perdida baja el bitrate, mas si es grave', () => {
  const start = newBitrateState(CAP);
  const severe = nextBitrate(start, { lossPct: 25, cap: CAP });
  const high = nextBitrate(start, { lossPct: 8, cap: CAP });
  assert.ok(severe.bps < high.bps);
  assert.ok(high.bps < CAP);
});

test('nunca baja del minimo ni se pasa del tope', () => {
  let st = newBitrateState(CAP);
  for (let i = 0; i < 30; i++) st = nextBitrate(st, { lossPct: 50, cap: CAP });
  assert.equal(st.bps, MIN_BITRATE);
  st = newBitrateState(CAP);
  for (let i = 0; i < 60; i++) st = nextBitrate(st, { lossPct: 0, cap: CAP });
  assert.equal(st.bps, CAP);
  assert.equal(nextBitrate({ bps: CAP, clean: 0 }, { lossPct: null, cap: 30000 }).bps, 30000, 'si baja el tope, baja enseguida');
});

test('sube despacio y solo con varias muestras limpias seguidas', () => {
  let st = { bps: 40000, clean: 0 };
  for (let i = 0; i < 2; i++) {
    st = nextBitrate(st, { lossPct: 0, cap: CAP });
    assert.equal(st.bps, 40000);
  }
  st = nextBitrate(st, { lossPct: 0, cap: CAP });
  assert.ok(st.bps > 40000 && st.bps < CAP);
  // Una muestra regular reinicia la cuenta
  st = { bps: 40000, clean: 2 };
  st = nextBitrate(st, { lossPct: 3, cap: CAP });
  assert.equal(st.clean, 0);
  assert.equal(st.bps, 40000, 'perdida leve: se mantiene (la FEC la tapa)');
});

test('sin datos (silencio con DTX) no cambia nada', () => {
  const st = { bps: 50000, clean: 3 };
  assert.deepEqual(nextBitrate(st, { lossPct: null, cap: CAP }), st);
  assert.deepEqual(nextBitrate(st, { lossPct: undefined, cap: CAP }), st);
});

const report = (over = {}) => [
  { type: 'outbound-rtp', kind: 'audio', packetsSent: 500 },
  { type: 'remote-inbound-rtp', kind: 'audio', fractionLost: 0.1, roundTripTime: 0.05, timestamp: 1000, ...over.remote },
  { type: 'inbound-rtp', kind: 'audio', packetsReceived: 400, packetsLost: 10, jitter: 0.02, concealedSamples: 960, silentConcealedSamples: 0, totalSamplesReceived: 48000, ...over.inbound },
  // La pantalla compartida no cuenta
  { type: 'inbound-rtp', kind: 'video', packetsReceived: 9000, packetsLost: 900, jitter: 3 },
  { type: 'candidate-pair', state: 'succeeded' },
];

test('lee solo el audio de las estadisticas', () => {
  const r = readAudioStats(report());
  assert.equal(r.received, 400);
  assert.equal(r.lost, 10);
  assert.equal(r.upFraction, 0.1);
  assert.equal(r.rttMs, 50);
  assert.equal(r.jitterMs, 20);
  assert.equal(readAudioStats([]).hasInbound, false);
  assert.equal(readAudioStats([]).upFraction, null);
});

test('la perdida sale de la diferencia entre dos lecturas', () => {
  const a = readAudioStats(report());
  const b = readAudioStats(report({ inbound: { packetsReceived: 480, packetsLost: 30 }, remote: { timestamp: 2000, fractionLost: 0.2 } }));
  const s = lossSample(a, b);
  assert.equal(s.downLossPct, 20);
  assert.ok(Math.abs(s.upLossPct - 20) < 1e-9);
  assert.equal(worstLoss(s), 20);
});

test('un informe repetido del otro no es un dato nuevo', () => {
  const a = readAudioStats(report());
  const s = lossSample(a, readAudioStats(report()));
  assert.equal(s.upLossPct, null);
  assert.equal(s.downLossPct, null, 'sin paquetes nuevos tampoco hay perdida');
  assert.equal(worstLoss(s), null);
  assert.equal(lossSample(null, a).upLossPct, 10, 'primera lectura: el informe si es nuevo');
  assert.equal(lossSample(null, a).downLossPct, null);
});

test('pocos paquetes (DTX) no sirven para medir perdida de bajada', () => {
  const a = readAudioStats(report());
  const b = readAudioStats(report({ inbound: { packetsReceived: 403, packetsLost: 12 } }));
  assert.equal(lossSample(a, b).downLossPct, null);
});

test('un contador que retrocede no da perdida negativa', () => {
  const a = readAudioStats(report());
  const b = readAudioStats(report({ inbound: { packetsReceived: 480, packetsLost: 5 } }));
  assert.equal(lossSample(a, b).downLossPct, 0);
});

test('clasifica la calidad', () => {
  assert.equal(classifyQuality({ upLossPct: 0, rttMs: 40 }), 'good');
  assert.equal(classifyQuality({ upLossPct: 4 }), 'fair');
  assert.equal(classifyQuality({ downLossPct: 12 }), 'bad');
  assert.equal(classifyQuality({ rttMs: 700 }), 'bad');
  assert.equal(classifyQuality({ jitterMs: 60 }), 'fair');
  assert.equal(classifyQuality({ concealPct: 25 }), 'bad');
  assert.equal(classifyQuality({}), 'good');
});

test('el estado no parpadea: empeora con 2 muestras y mejora con 3', () => {
  const bad = { upLossPct: 30 };
  const good = { upLossPct: 0 };
  let st = newQualityState();
  st = nextQuality(st, bad);
  assert.equal(st.level, 'good', 'un pico suelto no alcanza');
  st = nextQuality(st, good);
  st = nextQuality(st, bad);
  assert.equal(st.level, 'good', 'interrumpido, vuelve a contar');
  st = nextQuality(st, bad);
  assert.equal(st.level, 'bad');
  st = nextQuality(st, good);
  st = nextQuality(st, good);
  assert.equal(st.level, 'bad');
  st = nextQuality(st, good);
  assert.equal(st.level, 'good');
});
