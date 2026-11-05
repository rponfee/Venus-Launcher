// Texto que se firma en cada mensaje del Voice Chat. Es el mismo por el camino principal (Realtime) y por el de
// respaldo (voice/backup.js): la firma de un mensaje vale igual venga por donde venga.

// Sobre de un mensaje: { f: usuario, fs: sesion, to, tos, ts, n: nonce, d: datos en JSON, sig }
export function envelopeText(event, roomId, e) {
  return `${event}|${roomId}|${e.f}|${e.fs}|${e.to || ''}|${e.tos || ''}|${e.ts}|${e.n}|${e.d}`;
}

// Sobre de un mensaje del chat (a toda la sala) con su firma original, para reenviarlo tal cual en el historial
export function chatEnvelope(e) {
  return e && typeof e === 'object' && !e.to && !e.tos ? { f: e.f, fs: e.fs, ts: e.ts, n: e.n, d: e.d, sig: e.sig } : null;
}

export function presenceText(roomId, userId, st) {
  return `p|${roomId}|${userId}|${st.s}|${st.j}|${st.m ? 1 : 0}${st.d ? 1 : 0}${st.sp ? 1 : 0}${st.sh ? 1 : 0}`;
}

// Un sobre bien formado (lo minimo para firmarlo o verificarlo); los limites de tamaño son los del motor
export function validEnvelope(env) {
  return Boolean(env) && typeof env === 'object' && typeof env.f === 'string' && typeof env.fs === 'string' && typeof env.n === 'string' && typeof env.d === 'string' && typeof env.sig === 'string' && Number.isFinite(env.ts) && env.n.length <= 40 && env.d.length <= 120000;
}
