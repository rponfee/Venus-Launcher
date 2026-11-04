// Competir: textos armados con los datos (métricas, plazos, objetivos y fechas). Lo usan la página y features/compete.js.
import { fmtDate, fmtTime } from '../../ui.js';
import { t, locale } from '../../i18n.js';
import { metricNumber } from './logic.js';

const C = (key, vars) => t(`compete.${key}`, vars);

export const METRIC_ICONS = { hours: 'clock', diamonds: 'cpDiamond', mobs: 'swords', blocks: 'pickaxe', deaths: 'skull' };

export const metricName = (metric) => C(`metric_${metric}`);

export function fmtInt(n) {
  try {
    return new Intl.NumberFormat(locale(), { maximumFractionDigits: 1 }).format(Number(n) || 0);
  } catch {
    return String(n ?? 0);
  }
}

/** Valor de una métrica para mostrar: "12,5 h" o "1.250". */
export function metricText(metric, raw) {
  const n = fmtInt(metricNumber(metric, raw));
  return metric === 'hours' ? C('unit_hours', { n }) : n;
}

export const durationName = (hours) => C(`duration_${hours}`);

export const friendName = (f) => f?.displayName || f?.username || '?';

/** "Objetivo: 200" o "El que más haga". */
export function goalText(c) {
  return c.target ? C('goalTarget', { value: metricText(c.metric, c.target) }) : C('modeMost');
}

/** "2 d 3 h", "3 h 10 min" o "5 min". */
export function leftText({ days, hours, minutes }) {
  if (days) return C('leftDays', { d: days, h: hours });
  if (hours) return C('leftHours', { h: hours, m: minutes });
  return C('leftMinutes', { m: Math.max(1, minutes) });
}

/** Fecha y hora en la zona horaria de la PC. */
export const fmtWhen = (ms) => fmtDate(ms, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** Del inicio al fin de un evento: si termina el mismo día, solo la hora. */
export function eventRange(ev) {
  const a = new Date(ev.startsAt);
  const b = new Date(ev.endsAt);
  const sameDay = a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  return `${fmtWhen(ev.startsAt)} – ${sameDay ? fmtTime(ev.endsAt) : fmtWhen(ev.endsAt)}`;
}

/** Zona horaria de la PC, para decirle al usuario en qué hora está viendo todo. */
export function timeZoneName() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    return '';
  }
}

/** "3 de 16", "3 anotados" (sin cupo). */
export function signupsText(ev) {
  return ev.capacity === null ? C('signupsOpen', { count: ev.signups, n: fmtInt(ev.signups) }) : C('signupsOf', { n: fmtInt(ev.signups), capacity: fmtInt(ev.capacity) });
}
