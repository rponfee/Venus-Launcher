// Competir: lógica pura (sin DOM ni imports) que comparten la página, features/compete.js y la pestaña de administración.
// Se prueba con Node: node --test "src/renderer/js/pages/compete/test/*.test.js". Reglas del servidor: 0031_competencia.sql.
const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const METRICS = ['hours', 'diamonds', 'mobs', 'blocks', 'deaths'];
export const DURATIONS = [24, 72, 168];
export const REMINDER_LEAD_MS = 15 * MINUTE;
// Lo máximo que acepta el servidor por semana (hours en minutos): el objetivo de un desafío tampoco puede pasarlo.
export const METRIC_CAPS = { hours: 10080, diamonds: 5000, mobs: 100000, blocks: 1000000, deaths: 5000 };
export const CHALLENGE_RULES = { prize: 25, weekCap: 3, minMinutes: 10, pendingHours: 48 };

// ---------- Semanas (de lunes a domingo, UTC, como private.compete_week) ----------
export function weekStartMs(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - ((d.getUTCDay() + 6) % 7) * DAY;
}

/** 'AAAA-MM-DD' del lunes de esa semana. */
export function weekKey(ms) {
  return new Date(weekStartMs(ms)).toISOString().slice(0, 10);
}

export function shiftWeek(key, weeks) {
  return new Date(Date.parse(`${key}T00:00:00Z`) + weeks * 7 * DAY).toISOString().slice(0, 10);
}

/** Lunes y domingo de una semana, en ms UTC (para mostrar "del 2 al 8 de noviembre" con timeZone: 'UTC'). */
export function weekBounds(key) {
  const from = Date.parse(`${key}T00:00:00Z`);
  return { from, to: from + 6 * DAY };
}

// ---------- Métricas ----------
/** El número que se muestra: hours llega en minutos y se ve en horas con un decimal. */
export function metricNumber(metric, raw) {
  const v = Math.max(0, Number(raw) || 0);
  return metric === 'hours' ? Math.round(v / 6) / 10 : Math.floor(v);
}

/** Objetivo escrito por el usuario -> lo que guarda el servidor (hours: minutos). null si no sirve. */
export function goalToTarget(metric, input) {
  const v = Number(String(input ?? '').trim().replace(',', '.'));
  if (!Number.isFinite(v) || v <= 0 || !(metric in METRIC_CAPS)) return null;
  const target = metric === 'hours' ? Math.round(v * 60) : Math.floor(v);
  return target >= 1 && target <= METRIC_CAPS[metric] && (metric === 'hours' || Number.isInteger(v)) ? target : null;
}

/** Ranking del servidor con el largo de cada barra (el primero, 100). */
export function rankingView(raw) {
  const rows = (Array.isArray(raw?.rows) ? raw.rows : [])
    .filter((r) => r && typeof r.userId === 'string')
    .map((r) => ({ ...r, value: Math.max(0, Number(r.value) || 0), rank: Math.max(1, Number(r.rank) || 1), me: r.me === true }));
  const max = rows.reduce((m, r) => Math.max(m, r.value), 0);
  return {
    week: typeof raw?.week === 'string' ? raw.week : null,
    metric: raw?.metric,
    share: raw?.share === true,
    mine: raw?.mine && typeof raw.mine === 'object' ? raw.mine : null,
    rows: rows.map((r) => ({ ...r, pct: max > 0 ? Math.round((r.value / max) * 100) : 0 })),
  };
}

// ---------- Desafíos ----------
const OPEN = new Set(['pending', 'active']);

export function normalizeChallenge(raw) {
  if (!raw || typeof raw.id !== 'string' || !METRICS.includes(raw.metric)) return null;
  const num = (v) => Math.max(0, Number(v) || 0);
  return {
    id: raw.id,
    mine: raw.mine === true,
    metric: raw.metric,
    target: raw.target == null ? null : num(raw.target),
    hours: num(raw.hours),
    status: String(raw.status || ''),
    createdAt: Date.parse(raw.createdAt) || 0,
    startsAt: Date.parse(raw.startsAt) || null,
    endsAt: Date.parse(raw.endsAt) || null,
    settledAt: Date.parse(raw.settledAt) || null,
    expiresAt: Date.parse(raw.expiresAt) || null,
    outcome: raw.outcome || null,
    won: raw.won === true,
    prize: num(raw.prize),
    prizeNote: raw.prizeNote || null,
    friend: raw.friend && typeof raw.friend === 'object' ? raw.friend : { id: null, username: '?' },
    myValue: num(raw.myValue),
    theirValue: num(raw.theirValue),
    myMinutes: num(raw.myMinutes),
    theirMinutes: num(raw.theirMinutes),
  };
}

/** La lista de challenges_me separada como la muestra la página. */
export function groupChallenges(list) {
  const items = (Array.isArray(list) ? list : []).map(normalizeChallenge).filter(Boolean);
  return {
    incoming: items.filter((c) => c.status === 'pending' && !c.mine),
    active: items.filter((c) => c.status === 'active').sort((a, b) => (a.endsAt || 0) - (b.endsAt || 0)),
    outgoing: items.filter((c) => c.status === 'pending' && c.mine),
    closed: items.filter((c) => !OPEN.has(c.status)).sort((a, b) => (b.settledAt || 0) - (a.settledAt || 0)),
  };
}

/** Porcentaje de una barra de progreso: contra el objetivo, o contra el mayor de los dos en "el que más haga". */
export function challengeBars(c) {
  const base = c.target || Math.max(c.myValue, c.theirValue, 1);
  const pct = (v) => Math.min(100, Math.round((v / base) * 100));
  return { me: pct(c.myValue), them: pct(c.theirValue) };
}

const seenKey = (c) => `${c.id}:${c.status}`;

/**
 * Qué avisar comparando la lista con lo ya visto. seen: ['id:estado'] guardado en settings.compete.seen[usuario], o null la
 * primera vez (lo que ya pasó antes de usar esta versión no se avisa, salvo lo que todavía hay que responder). Devuelve
 * { notices: [{ type: 'received' | 'accepted' | 'declined' | 'expired' | 'finished', challenge }], seen: ['id:estado'] }.
 * No avisa lo que hizo uno mismo: responder, retirar o el vencimiento de un desafío que recibió.
 */
export function challengeNotices(seen, list) {
  const items = (Array.isArray(list) ? list : []).map(normalizeChallenge).filter(Boolean);
  const known = Array.isArray(seen) ? new Set(seen) : null;
  const notices = [];
  for (const c of items) {
    if (known?.has(seenKey(c))) continue;
    if (c.status === 'pending' && !c.mine) notices.push({ type: 'received', challenge: c });
    if (!known) continue;
    if (c.status === 'active' && c.mine) notices.push({ type: 'accepted', challenge: c });
    else if (c.status === 'declined' && c.mine) notices.push({ type: 'declined', challenge: c });
    else if (c.status === 'expired' && c.mine) notices.push({ type: 'expired', challenge: c });
    else if (c.status === 'finished') notices.push({ type: 'finished', challenge: c });
  }
  return { notices, seen: items.map(seenKey) };
}

/** Cuándo volver a preguntar: al terminar el plazo más próximo. null si no hay ninguno. */
export function nextSettleAt(list) {
  const ends = (Array.isArray(list) ? list : []).filter((c) => c?.status === 'active' && c.endsAt).map((c) => c.endsAt);
  return ends.length ? Math.min(...ends) : null;
}

export function validateChallengeForm({ friend, metric, hours, mode, goal } = {}) {
  if (!friend) return { ok: false, error: 'friend' };
  if (!METRICS.includes(metric)) return { ok: false, error: 'metric' };
  if (!DURATIONS.includes(Number(hours))) return { ok: false, error: 'hours' };
  if (mode !== 'target') return { ok: true, payload: { p_friend: friend, p_metric: metric, p_hours: Number(hours), p_target: null } };
  const target = goalToTarget(metric, goal);
  if (target === null) return { ok: false, error: 'goal' };
  return { ok: true, payload: { p_friend: friend, p_metric: metric, p_hours: Number(hours), p_target: target } };
}

/** Días, horas y minutos que quedan. */
export function timeLeft(until, now) {
  const ms = Math.max(0, (Number(until) || 0) - now);
  return { ms, days: Math.floor(ms / DAY), hours: Math.floor((ms % DAY) / HOUR), minutes: Math.floor((ms % HOUR) / MINUTE) };
}

// ---------- Eventos ----------
export function normalizeEvent(raw) {
  const startsAt = Date.parse(raw?.startsAt);
  const endsAt = Date.parse(raw?.endsAt);
  if (!raw || typeof raw.id !== 'string' || !Number.isFinite(startsAt) || !Number.isFinite(endsAt)) return null;
  const capacity = raw.capacity == null ? null : Math.max(0, Number(raw.capacity) || 0);
  const signups = Math.max(0, Number(raw.signups) || 0);
  return {
    id: raw.id,
    title: String(raw.title ?? ''),
    description: String(raw.description ?? ''),
    kind: raw.kind === 'tournament' ? 'tournament' : 'event',
    startsAt,
    endsAt,
    capacity,
    signups,
    joined: raw.joined === true,
    full: capacity !== null && signups >= capacity,
    server: raw.server || null,
    link: safeLink(raw.link),
  };
}

/** Solo enlaces https, y nada que el navegador interprete como otra cosa. */
export function safeLink(url) {
  const s = String(url ?? '').trim();
  if (!/^https:\/\/[^\s<>"]{1,300}$/i.test(s)) return null;
  try {
    return new URL(s).protocol === 'https:' ? s : null;
  } catch {
    return null;
  }
}

/** Fecha local 'AAAA-MM-DD' (en la zona horaria de la PC). */
export function dayKey(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function shiftMonth({ year, month }, n) {
  const d = new Date(year, month + n, 1);
  return { year: d.getFullYear(), month: d.getMonth() };
}

/** Primer instante y fin del rango que muestra un mes (semanas completas de lunes a domingo, hora local). */
export function monthRange({ year, month }) {
  const first = new Date(year, month, 1);
  const from = new Date(year, month, 1 - ((first.getDay() + 6) % 7));
  const last = new Date(year, month + 1, 0);
  const to = new Date(year, month + 1, ((7 - last.getDay()) % 7) + 1);
  return { from: from.getTime(), to: to.getTime() };
}

/**
 * Vista de mes: semanas de lunes a domingo con { key, day, inMonth, today, events }, en la zona horaria de la PC. Un evento
 * aparece en cada día local que toca (un evento que termina justo a las 00:00 no toca ese día).
 */
export function monthGrid({ year, month }, events, now) {
  const { from, to } = monthRange({ year, month });
  const list = (Array.isArray(events) ? events : []).filter((e) => e && e.endsAt > from && e.startsAt < to);
  const todayKey = dayKey(now);
  const weeks = [];
  let week = [];
  // Con new Date(a, m, d) cada celda es la medianoche local aunque cambie el horario de verano.
  const first = new Date(from);
  for (let i = 0; ; i++) {
    const d = new Date(first.getFullYear(), first.getMonth(), first.getDate() + i);
    const start = d.getTime();
    if (start >= to) break;
    const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
    week.push({
      key: dayKey(start),
      day: d.getDate(),
      inMonth: d.getMonth() === month,
      today: dayKey(start) === todayKey,
      events: list.filter((e) => e.startsAt < end && e.endsAt > start).sort((a, b) => a.startsAt - b.startsAt),
    });
    if (week.length === 7) {
      weeks.push(week);
      week = [];
    }
  }
  return weeks;
}

/** Lo que sigue: lo que todavía no terminó, del más próximo al más lejano. */
export function upcomingEvents(events, now, limit = 20) {
  return (Array.isArray(events) ? events : []).filter((e) => e && e.endsAt > now).sort((a, b) => a.startsAt - b.startsAt).slice(0, limit);
}

export function eventsOnDay(events, key) {
  const [y, m, d] = String(key).split('-').map(Number);
  const start = new Date(y, m - 1, d).getTime();
  const end = new Date(y, m - 1, d + 1).getTime();
  return (Array.isArray(events) ? events : []).filter((e) => e && e.startsAt < end && e.endsAt > start).sort((a, b) => a.startsAt - b.startsAt);
}

/** 'upcoming', 'live' o 'ended'. */
export function eventState(ev, now) {
  if (now >= ev.endsAt) return 'ended';
  return now >= ev.startsAt ? 'live' : 'upcoming';
}

/** Qué se puede hacer: 'leave', 'join', 'full' (sin lugar) o 'closed' (como en event_join). */
export function eventAction(ev, now) {
  if (now >= ev.endsAt) return 'closed';
  if (ev.joined) return 'leave';
  if (ev.kind === 'tournament' && now >= ev.startsAt) return 'closed';
  return ev.full ? 'full' : 'join';
}

// ---------- Recordatorios ----------
/** Clave del aviso: si el evento cambia de horario, se vuelve a avisar. */
export const reminderKey = (ev) => `${ev.id}:${ev.startsAt}`;

/** Lo anotado que empieza dentro de los próximos 15 minutos y todavía no se avisó. */
export function dueReminders(events, reminded, now, lead = REMINDER_LEAD_MS) {
  const done = new Set(Array.isArray(reminded) ? reminded : []);
  return (Array.isArray(events) ? events : []).filter((e) => e && e.joined && now < e.startsAt && now >= e.startsAt - lead && !done.has(reminderKey(e)));
}

/** Lo avisado que vale la pena recordar: lo que todavía no empezó (para que settings no crezca sin fin). */
export function pruneReminded(reminded, events, now) {
  const keep = new Set((Array.isArray(events) ? events : []).filter((e) => e && e.endsAt > now).map(reminderKey));
  return (Array.isArray(reminded) ? reminded : []).filter((k) => keep.has(k)).slice(-50);
}

// ---------- Formulario de administración ----------
/** ISO -> valor de un <input type="datetime-local"> en la hora de la PC. */
export function toLocalInput(iso) {
  const ms = typeof iso === 'number' ? iso : Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Valida el formulario de un evento. Devuelve { ok: true, payload } (lo que espera admin_event_save) o { ok: false, error }
 * con el campo: 'title', 'description', 'dates', 'capacity', 'server' o 'link'.
 */
export function validateEventForm(form = {}) {
  const title = String(form.title ?? '').trim();
  if (!title || title.length > 80) return { ok: false, error: 'title' };
  const description = String(form.description ?? '').trim();
  if (description.length > 2000) return { ok: false, error: 'description' };
  const kind = form.kind === 'tournament' ? 'tournament' : 'event';
  const starts = new Date(form.startsAt).getTime();
  const ends = new Date(form.endsAt).getTime();
  if (!Number.isFinite(starts) || !Number.isFinite(ends) || ends <= starts) return { ok: false, error: 'dates' };
  const rawCap = String(form.capacity ?? '').trim();
  const capacity = rawCap === '' ? null : Number(rawCap);
  if (capacity !== null && (!Number.isInteger(capacity) || capacity < 1 || capacity > 100000)) return { ok: false, error: 'capacity' };
  if (kind === 'tournament' && capacity === null) return { ok: false, error: 'capacity' };
  const server = String(form.server ?? '').trim();
  if (server && !/^[A-Za-z0-9._-]{1,120}(:[0-9]{1,5})?$/.test(server)) return { ok: false, error: 'server' };
  const rawLink = String(form.link ?? '').trim();
  const link = rawLink ? safeLink(rawLink) : null;
  if (rawLink && !link) return { ok: false, error: 'link' };
  return {
    ok: true,
    payload: { ...(form.id ? { id: form.id } : {}), title, description, kind, startsAt: new Date(starts).toISOString(), endsAt: new Date(ends).toISOString(), capacity, server: server || null, link },
  };
}
