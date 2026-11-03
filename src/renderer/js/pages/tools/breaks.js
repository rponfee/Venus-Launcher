// Contadores del recordatorio de descansos y del tope de horas por dia (features/tools/breaks.js). Sin DOM ni
// imports: lo prueban las pruebas de pages/tools/test/. El tiempo se mide con game:state (hay un juego abierto o
// no) y un reloj que se pasa desde afuera, asi las pruebas lo adelantan a mano.
//   settings.play.breaks = { enabled: false, everyMin: 60, dailyLimitMin: 0 (0 = sin tope) }
//   settings.play.today  = { day: 'AAAA-MM-DD', minutes }

export const BREAKS_DEFAULTS = Object.freeze({ enabled: false, everyMin: 60, dailyLimitMin: 0 });
export const EVERY_OPTIONS = Object.freeze([30, 45, 60, 90, 120]);
export const LIMIT_OPTIONS = Object.freeze([0, 60, 120, 180, 240, 300, 360, 480]);
export const LIMIT_REPEAT_MS = 10 * 60 * 1000; // al llegar al tope, se repite el aviso cada 10 minutos
export const MAX_GAP_MS = 5 * 60 * 1000; // si la PC durmio, un salto de reloj mas largo no cuenta como juego

const num = (v, def) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};

// settings.play.breaks (cualquier cosa) -> configuracion valida.
export function normalizeBreaks(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: r.enabled === true,
    everyMin: Math.min(600, Math.max(5, Math.round(num(r.everyMin, BREAKS_DEFAULTS.everyMin)))),
    dailyLimitMin: Math.min(1440, Math.max(0, Math.round(num(r.dailyLimitMin, BREAKS_DEFAULTS.dailyLimitMin)))),
  };
}

// Clave del dia local: 'AAAA-MM-DD'.
export function dayKey(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Estado inicial a partir de lo guardado (settings.play.today) y el dia de hoy.
export function createBreakState(today, day) {
  const saved = today && typeof today === 'object' && today.day === day ? Math.max(0, num(today.minutes, 0)) : 0;
  return {
    day,
    todayMs: Math.round(saved * 60000),
    continuousMs: 0,
    lastTick: null, // ultima vez que se conto tiempo (null = no estaba jugando)
    nextBreakMin: null, // proximo aviso de descanso, en minutos seguidos
    lastLimitAt: 0, // ultimo aviso del tope diario
  };
}

export const todayMinutes = (state) => Math.floor(state.todayMs / 60000);
export const continuousMinutes = (state) => Math.floor(state.continuousMs / 60000);

/**
 * Avanza los contadores. cfg: normalizeBreaks(...); now: ms; playing: hay un juego abierto (no quiet); day: dayKey().
 * Devuelve los avisos que corresponden ahora: [{ type: 'break', minutes }] (minutos seguidos) y/o
 * [{ type: 'limit', minutes, limit }] (minutos de hoy). Nunca mas de un aviso de cada tipo por tick.
 */
export function tick(state, cfg, { now, playing, day }) {
  const events = [];
  if (day !== state.day) {
    state.day = day;
    state.todayMs = 0;
    state.lastLimitAt = 0;
  }
  if (!playing) {
    state.lastTick = null;
    state.continuousMs = 0;
    state.nextBreakMin = null;
    return events;
  }
  if (state.lastTick !== null) {
    const delta = now - state.lastTick;
    if (delta > 0 && delta <= MAX_GAP_MS) {
      state.todayMs += delta;
      state.continuousMs += delta;
    } else if (delta > MAX_GAP_MS) {
      // La PC durmio o el reloj salto: el rato seguido se corta, el dia no suma ese hueco.
      state.continuousMs = 0;
      state.nextBreakMin = null;
    }
  }
  state.lastTick = now;
  if (!cfg.enabled) return events;
  if (cfg.everyMin > 0) {
    if (state.nextBreakMin === null) state.nextBreakMin = cfg.everyMin;
    const mins = continuousMinutes(state);
    if (mins >= state.nextBreakMin) {
      events.push({ type: 'break', minutes: mins });
      // Siguiente multiplo por encima de lo jugado (si el intervalo se acorto, no avisa varias veces seguidas).
      state.nextBreakMin = (Math.floor(mins / cfg.everyMin) + 1) * cfg.everyMin;
    }
  }
  if (cfg.dailyLimitMin > 0) {
    const mins = todayMinutes(state);
    if (mins >= cfg.dailyLimitMin && now - state.lastLimitAt >= LIMIT_REPEAT_MS) {
      events.push({ type: 'limit', minutes: mins, limit: cfg.dailyLimitMin });
      state.lastLimitAt = now;
    }
  }
  return events;
}

// Lo que se guarda en settings.play.today.
export function todayPatch(state) {
  return { day: state.day, minutes: todayMinutes(state) };
}
