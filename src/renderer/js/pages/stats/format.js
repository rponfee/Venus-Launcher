// Formatos de la pagina de Estadisticas (numeros, distancias, fechas) segun el idioma elegido.
import { t, locale, has } from '../../i18n.js';
import { fmtDuration } from '../../ui.js';

const nfCache = new Map();
function nf(opts = {}) {
  const key = `${locale()}|${JSON.stringify(opts)}`;
  if (!nfCache.has(key)) nfCache.set(key, new Intl.NumberFormat(locale(), opts));
  return nfCache.get(key);
}

export const fmtInt = (n) => nf({ maximumFractionDigits: 0 }).format(Math.round(Number(n) || 0));
export const fmtDec = (n, digits = 1) => nf({ maximumFractionDigits: digits }).format(Number(n) || 0);
export const fmtPct = (x, digits = 0) => nf({ style: 'percent', maximumFractionDigits: digits }).format(Number(x) || 0);
// Numeros grandes compactos (12,3 mil / 12.3K) solo desde 10.000
export const fmtCompact = (n) => (Math.abs(n) >= 10000 ? nf({ notation: 'compact', maximumFractionDigits: 1 }).format(n) : fmtInt(n));

export function fmtDistance(cm) {
  const m = (Number(cm) || 0) / 100;
  if (m < 1000) return t('stats.unitM', { value: fmtInt(m) });
  return t('stats.unitKm', { value: fmtDec(m / 1000, m >= 100000 ? 0 : 1) });
}

export const fmtHearts = (h) => t('stats.hearts', { count: Math.round(Number(h) || 0), value: fmtInt(h) });
export const fmtTicks = (ticks) => fmtDuration((Number(ticks) || 0) * 50);
export const fmtDur = (ms) => fmtDuration(ms, { short: ms >= 100 * 3600000 });

// Escala de minutos para los ejes: pasos redondos en minutos u horas
export function timeScale(maxMin) {
  const steps = [5, 10, 15, 30, 60, 120, 180, 240, 360, 480, 720, 1440, 2880, 6000, 12000];
  const step = steps.find((st) => maxMin / st <= 4) || Math.ceil(maxMin / 4 / 6000) * 6000 || 5;
  return [Math.max(step, Math.ceil(maxMin / step) * step), step];
}
// Escala para conteos: 1, 2, 5, 10, 20, 50...
export function countScale(max) {
  if (max <= 4) return [4, 1];
  const pow = 10 ** Math.floor(Math.log10(max / 4));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((st) => max / st <= 4) || pow * 10;
  return [Math.ceil(max / step) * step, step];
}
export const fmtAxisMin = (m) => (!m ? '0' : m >= 60 ? t('stats.axisHours', { value: fmtDec(m / 60, m % 60 ? 1 : 0) }) : t('stats.axisMinutes', { value: Math.round(m) }));

// ---------- Fechas ----------
const pad = (n) => String(n).padStart(2, '0');
export const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export function keyDate(key) {
  const [y, m, d] = String(key).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}
export function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}
export function startOfDay(ts = Date.now()) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d;
}
export const fmtDayKey = (key, opts = { day: 'numeric', month: 'short', year: 'numeric' }) => keyDate(key).toLocaleDateString(locale(), opts);
export const fmtLongDay = (key) => fmtDayKey(key, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

// Nombres de los dias indexados como Date.getDay() (0 = domingo)
export function weekdayNames(style = 'short') {
  const base = new Date(2024, 0, 7); // domingo
  return Array.from({ length: 7 }, (_, i) => addDays(base, i).toLocaleDateString(locale(), { weekday: style }).replace('.', ''));
}

// Primer dia de la semana segun el idioma (0 = domingo, 1 = lunes)
export function firstDayOfWeek() {
  try {
    const loc = new Intl.Locale(locale());
    const info = typeof loc.getWeekInfo === 'function' ? loc.getWeekInfo() : loc.weekInfo;
    return (info?.firstDay ?? 1) % 7;
  } catch {
    return 1;
  }
}

// Etiqueta traducida si existe; si no, el nombre que manda el proceso principal
export function labelOr(key, fallback) {
  return has(key) ? t(key) : fallback;
}
