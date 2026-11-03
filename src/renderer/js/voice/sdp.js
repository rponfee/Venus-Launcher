// Ajustes de Opus en el SDP: FEC (recupera paquetes perdidos), DTX (no gasta datos en silencio), mono, bitrate y
// duracion de paquete. Son parametros estandar (RFC 7587): quien no los conoce los ignora, asi que los clientes 2.x
// siguen entrando a la misma sala. Solo agrega o cambia esos parametros; el resto del SDP queda igual.
//
// Se usa en los dos sentidos porque cada encoder obedece lo que dice el SDP del otro lado:
//   - lo que mandamos le pide al otro que codifique asi (tambien a un cliente 2.x, que no sabe nada de esto);
//   - lo que recibimos se ajusta antes de aplicarlo, para que nuestro encoder use FEC y DTX aunque el otro no los pida.
export const OPUS_PTIME = 20; // ms: el punto justo entre demora y datos, y el que mejor funciona con FEC
const MIN_AVERAGE_BITRATE = 6000; // limites de RFC 7587
const MAX_AVERAGE_BITRATE = 510000;

function splitSdp(sdp) {
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
  const lines = sdp.split(eol);
  const trailing = lines[lines.length - 1] === '';
  if (trailing) lines.pop();
  return { lines, eol, trailing };
}

function joinSdp({ lines, eol, trailing }) {
  return lines.join(eol) + (trailing ? eol : '');
}

// Secciones de audio como rangos [inicio, fin) de lineas
function audioSections(lines) {
  const out = [];
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('m=')) continue;
    if (start >= 0) out.push([start, i]);
    start = lines[i].startsWith('m=audio') ? i : -1;
  }
  if (start >= 0) out.push([start, lines.length]);
  return out;
}

function opusPayloads(lines, from, to) {
  const pts = [];
  for (let i = from; i < to; i++) {
    const m = /^a=rtpmap:(\d+)\s+opus\/48000(?:\/\d+)?\s*$/i.exec(lines[i]);
    if (m) pts.push({ pt: m[1], at: i });
  }
  return pts;
}

function parseFmtp(text) {
  const params = new Map();
  for (const part of text.split(';')) {
    const cut = part.indexOf('=');
    const key = (cut < 0 ? part : part.slice(0, cut)).trim();
    if (key) params.set(key, cut < 0 ? '' : part.slice(cut + 1).trim());
  }
  return params;
}

function formatFmtp(params) {
  return [...params].map(([k, v]) => (v === '' ? k : `${k}=${v}`)).join(';');
}

function wantedParams({ fec = true, dtx = true, mono = true, maxAverageBitrate = null }) {
  const out = [];
  if (fec) out.push(['useinbandfec', '1']);
  if (dtx) out.push(['usedtx', '1']);
  if (mono) out.push(['stereo', '0'], ['sprop-stereo', '0']);
  const bps = Number(maxAverageBitrate);
  if (Number.isFinite(bps) && bps > 0) out.push(['maxaveragebitrate', String(Math.round(Math.min(MAX_AVERAGE_BITRATE, Math.max(MIN_AVERAGE_BITRATE, bps))))]);
  return out;
}

// Devuelve el SDP con Opus configurado para voz. opts: { fec, dtx, mono, maxAverageBitrate, ptime }.
// Nunca falla: un SDP sin Opus (o que no es texto) vuelve tal cual, y aplicarlo dos veces da lo mismo.
export function tuneOpusSdp(sdp, opts = {}) {
  if (typeof sdp !== 'string' || !sdp) return sdp;
  const parts = splitSdp(sdp);
  const { lines } = parts;
  const ptime = opts.ptime === undefined ? OPUS_PTIME : opts.ptime;
  const wanted = wantedParams(opts);
  const sections = audioSections(lines);
  // De atras para adelante: agregar lineas no corre los rangos que faltan
  for (let s = sections.length - 1; s >= 0; s--) {
    const [from, to] = sections[s];
    const opus = opusPayloads(lines, from, to);
    if (!opus.length) continue;
    let end = to;
    for (let p = opus.length - 1; p >= 0; p--) {
      const { pt, at } = opus[p];
      const prefix = `a=fmtp:${pt} `;
      const idx = lines.slice(from, end).findIndex((l) => l.startsWith(prefix));
      if (idx >= 0) {
        const params = parseFmtp(lines[from + idx].slice(prefix.length));
        for (const [k, v] of wanted) params.set(k, v);
        lines[from + idx] = prefix + formatFmtp(params);
      } else if (wanted.length) {
        lines.splice(at + 1, 0, prefix + formatFmtp(new Map(wanted)));
        end++;
      }
    }
    if (ptime) {
      const idx = lines.slice(from, end).findIndex((l) => l.startsWith('a=ptime:'));
      if (idx >= 0) lines[from + idx] = `a=ptime:${ptime}`;
      else lines.splice(end, 0, `a=ptime:${ptime}`);
    }
  }
  return joinSdp(parts);
}

// Parametros de Opus de un SDP: { pt, params: { useinbandfec: '1', ... }, ptime } o null si no hay Opus
export function readOpusParams(sdp) {
  if (typeof sdp !== 'string' || !sdp) return null;
  const { lines } = splitSdp(sdp);
  for (const [from, to] of audioSections(lines)) {
    const [first] = opusPayloads(lines, from, to);
    if (!first) continue;
    const prefix = `a=fmtp:${first.pt} `;
    const section = lines.slice(from, to);
    const fmtp = section.find((l) => l.startsWith(prefix));
    const ptime = section.find((l) => l.startsWith('a=ptime:'));
    return { pt: first.pt, params: fmtp ? Object.fromEntries(parseFmtp(fmtp.slice(prefix.length))) : {}, ptime: ptime ? Number(ptime.slice(8)) : null };
  }
  return null;
}
