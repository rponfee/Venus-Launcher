// Cuentas del Montaje de la semana y del Timelapse, sin DOM (se prueban con node:test): que clips proponer, cuanto dura
// cada tramo para llegar a la duracion elegida y cuantos cuadros salen de las imagenes.

export const MONTAGE_DAYS = 7;
export const MONTAGE_TARGETS = [30, 60, 120, 300, 0]; // segundos; 0 = sin tope
export const MONTAGE_DEFAULT_TARGET = 60;
export const MONTAGE_MAX_CLIPS = 12;
export const MIN_SEGMENT = 3; // un tramo mas corto no se entiende
export const TITLE_SECONDS = 2.5;
export const TITLE_MAX = 60;
const DAY = 86400000;

// Lo que ya es un montaje o un timelapse no vuelve a entrar. Solo WebM: es lo que se puede unir.
const isOwnVideo = (file) => /_(montage|timelapse)(-\d+)?\.webm$/i.test(String(file || ''));

function reasonOf(item) {
  const m = /_auto-(death|advancement|boss)(?=[_.-])/.exec(String(item?.file || ''));
  return m ? m[1] : null;
}

// Clip de la galeria que se puede usar: de clips/ (no las grabaciones largas ni otros videos sueltos) y en WebM
export function isCandidate(item) {
  const rel = String(item?.rel || '').replace(/\\/g, '/');
  return item?.kind === 'clip' && rel.startsWith('clips/') && /\.webm$/i.test(String(item?.file || '')) && !isOwnVideo(item?.file);
}

/**
 * Cuanto vale un clip para proponerlo. shared = compartido con un link; featured = destacado en el perfil.
 * 0 = no se propone solo (se puede agregar a mano).
 */
export function scoreOf(item, { shared = false, featured = false } = {}) {
  const reason = reasonOf(item);
  if (featured) return 6;
  if (reason === 'boss') return 5;
  if (shared) return 4;
  if (reason === 'advancement') return 3;
  if (reason === 'death') return 2;
  return 0;
}

const byDate = (a, b) => (a.date || 0) - (b.date || 0);

/**
 * Propuesta inicial: automaticos y destacados de los ultimos 7 dias, los mejores si son muchos, en el orden en que
 * pasaron. Si no hay ninguno, los ultimos clips guardados a mano (asi el boton nunca arranca vacio).
 * opts = { now, days, limit, sharedMap (clave -> info), featuredIds: Set de ids de shared_media }
 */
export function proposeClips(items, opts = {}) {
  const now = opts.now ?? Date.now();
  const from = now - (opts.days ?? MONTAGE_DAYS) * DAY;
  const limit = opts.limit ?? MONTAGE_MAX_CLIPS;
  const recent = (Array.isArray(items) ? items : []).filter((it) => isCandidate(it) && (it.date || 0) >= from && (it.date || 0) <= now + DAY);
  const scored = recent.map((item) => {
    const info = opts.sharedMap?.[item.sharedKey];
    return { item, score: scoreOf(item, { shared: Boolean(info), featured: Boolean(info?.id && opts.featuredIds?.has(info.id)) }) };
  });
  const good = scored.filter((s) => s.score > 0);
  if (good.length) {
    // Si hay de mas, se quedan los que mas valen y, entre esos, los mas nuevos
    good.sort((a, b) => b.score - a.score || (b.item.date || 0) - (a.item.date || 0));
    return good
      .slice(0, limit)
      .map((s) => s.item)
      .sort(byDate);
  }
  return recent
    .slice()
    .sort((a, b) => (b.date || 0) - (a.date || 0))
    .slice(0, limit)
    .sort(byDate);
}

// Los que se pueden agregar a mano: los candidatos de los ultimos 7 dias que no estan elegidos, los mas nuevos primero
export function addableClips(items, chosen, opts = {}) {
  const now = opts.now ?? Date.now();
  const from = now - (opts.days ?? MONTAGE_DAYS) * DAY;
  const taken = new Set((chosen || []).map((c) => c.path));
  return (Array.isArray(items) ? items : []).filter((it) => isCandidate(it) && (it.date || 0) >= from && !taken.has(it.path)).sort((a, b) => (b.date || 0) - (a.date || 0));
}

export function moveItem(list, from, to) {
  const out = list.slice();
  if (from < 0 || from >= out.length || to < 0 || to >= out.length) return out;
  out.splice(to, 0, out.splice(from, 1)[0]);
  return out;
}

/**
 * Cuanto de cada clip entra en la duracion elegida. list = [{ path, duration }] en orden; target en segundos (0 = todo).
 * Se reparte parejo y lo que no usa un clip corto les queda a los otros (cada clip se usa hasta donde alcanza). Se queda
 * con el FINAL de cada clip: en un clip automatico y en una repeticion, lo que importa acaba de pasar.
 * Si no entran todos con MIN_SEGMENT, quedan los primeros y dropped dice cuantos sobraron.
 * Devuelve { segments: [{ path, start, length, duration, trimmed }], total, dropped }.
 */
export function planSegments(list, target = 0, { title = false } = {}) {
  const clips = (Array.isArray(list) ? list : []).filter((c) => Number(c?.duration) > 0);
  const room = target > 0 ? Math.max(MIN_SEGMENT, target - (title ? TITLE_SECONDS : 0)) : 0;
  const maxClips = room ? Math.max(1, Math.floor(room / MIN_SEGMENT)) : clips.length;
  const used = clips.slice(0, maxClips);
  const lengths = used.map((c) => c.duration);
  if (room) {
    let left = room;
    const open = new Set(used.map((_, i) => i));
    lengths.fill(0);
    // Reparto parejo: el que necesita menos que la parte se lleva lo suyo y el resto se vuelve a repartir
    while (open.size && left > 0.001) {
      const part = left / open.size;
      const small = [...open].filter((i) => used[i].duration <= part);
      if (!small.length) {
        for (const i of open) lengths[i] = part;
        break;
      }
      for (const i of small) {
        lengths[i] = used[i].duration;
        left -= used[i].duration;
        open.delete(i);
      }
    }
  }
  const segments = used.map((c, i) => {
    const length = Math.round(Math.min(c.duration, lengths[i]) * 100) / 100;
    const trimmed = length < c.duration - 0.05;
    return { path: c.path, duration: c.duration, length, start: trimmed ? Math.round((c.duration - length) * 100) / 100 : 0, trimmed };
  });
  const total = segments.reduce((n, s) => n + s.length, 0) + (title ? TITLE_SECONDS : 0);
  return { segments, total: Math.round(total * 100) / 100, dropped: clips.length - used.length };
}

// De donde sale el instanceId del resultado: la instancia con mas clips elegidos (la primera si empatan)
export function targetInstance(list) {
  const counts = new Map();
  for (const c of list || []) counts.set(c.instanceId, (counts.get(c.instanceId) || 0) + 1);
  let best = null;
  let most = 0;
  for (const [id, n] of counts) {
    if (n > most) {
      best = id;
      most = n;
    }
  }
  return best;
}

// ---------- Video ----------

// Rectangulo donde va un cuadro de w x h dentro de W x H, con franjas negras si no tiene la misma forma
export function fitBox(w, h, W, H) {
  const k = Math.min(W / Math.max(1, w), H / Math.max(1, h));
  const dw = Math.round(w * k);
  const dh = Math.round(h * k);
  return { dx: Math.round((W - dw) / 2), dy: Math.round((H - dh) / 2), dw, dh };
}

// Tamanio de salida: sin agrandar, sin pasarse de 1080p y con lados pares
export function outputBox(w, h, maxW = 1920, maxH = 1080) {
  const k = Math.min(1, maxW / Math.max(1, w), maxH / Math.max(1, h));
  const even = (n) => Math.max(2, Math.floor(n / 2) * 2);
  return { width: even(w * k), height: even(h * k) };
}

export function videoBitrate(w, h, fps = 30) {
  const rate = Math.min(60, Math.max(15, Number(fps) || 30));
  return Math.round(Math.min(16e6, Math.max(1.5e6, w * h * rate * 0.1)));
}

// ---------- Timelapse ----------

// Velocidades del video: cuadros por segundo con las imagenes guardadas
export const TIMELAPSE_SPEEDS = [
  { id: 'slow', fps: 10 },
  { id: 'normal', fps: 24 },
  { id: 'fast', fps: 30 },
  { id: 'turbo', fps: 60 },
];
export const TIMELAPSE_DEFAULT_SPEED = 'normal';
export const TIMELAPSE_MAX_FRAMES = 36000;

/**
 * Cuanto dura el video. count = imagenes; fps = cuadros por segundo; every = segundos entre imagenes.
 * { frames, fps, duration (s), factor (cuantas veces mas rapido que el juego), frameMs }
 */
export function planTimelapse(count, fps, every = 30) {
  const n = Math.max(0, Math.min(TIMELAPSE_MAX_FRAMES, Math.floor(Number(count) || 0)));
  const f = Math.max(1, Number(fps) || 24);
  return { frames: n, fps: f, duration: n / f, factor: Math.round((Number(every) || 30) * f), frameMs: 1000 / f };
}

// Tiempo de cada cuadro en microsegundos (los que pide VideoFrame), sin arrastrar el error de redondeo
export const frameTimestamp = (i, fps) => Math.round((i * 1e6) / fps);

// Un cuadro clave cada 2 s como mucho, para poder adelantar
export const keyInterval = (fps) => Math.max(1, Math.round(fps * 2));

// De "2026-11-03_18.03.09.jpg" a fecha local en ms (0 si no se entiende)
export function frameDate(name) {
  const m = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})\.(\d{2})\.(\d{2})/.exec(String(name || ''));
  if (!m) return 0;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  return d.getTime() || 0;
}
