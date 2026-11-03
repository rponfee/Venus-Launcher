// Nombres y descripciones de los logros y misiones (textos del namespace "achievements"). Los logros de una escalera se
// llaman como su familia con un numero romano ("Minero III"); la descripcion lleva el objetivo de ese paso.
import { t, has, locale } from '../../i18n.js';
import { ACHIEVEMENT_BY_ID, roman } from './catalog.js';

const A = (key, vars) => t(`achievements.${key}`, vars);

function fmt(n) {
  try {
    return new Intl.NumberFormat(locale(), { maximumFractionDigits: 0 }).format(n);
  } catch {
    return String(n);
  }
}

// Nombre de un id que el catalogo de esta version no conoce (por ejemplo, de una version mas nueva)
const humanize = (id) => String(id).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

export function familyName(fam) {
  const id = typeof fam === 'string' ? fam : fam.id;
  return has(`achievements.fam_${id}`) ? A(`fam_${id}`) : humanize(id);
}

export function achievementName(id) {
  const a = ACHIEVEMENT_BY_ID.get(id);
  if (!a) return humanize(id);
  const base = familyName(a.family);
  return a.single ? base : `${base} ${roman(a.step)}`;
}

export function achievementDesc(id) {
  const a = ACHIEVEMENT_BY_ID.get(id);
  if (!a) return '';
  const key = `famDesc_${a.family}`;
  return has(`achievements.${key}`) ? A(key, { count: a.target, n: fmt(a.target) }) : '';
}

export const tierLabel = (tier) => (has(`achievements.tier_${tier}`) ? A(`tier_${tier}`) : tier);

// Todo lo que hace falta para dibujar un logro (nombre, descripcion, icono y nivel)
export function achievementInfo(id) {
  const a = ACHIEVEMENT_BY_ID.get(id);
  const tier = a?.tier || 'bronze';
  return { id, name: achievementName(id), desc: achievementDesc(id), icon: a?.icon || 'trophy', tier, tierLabel: tierLabel(tier), points: a?.points ?? 0, kind: a?.kind || 'client' };
}

export function missionText(metric, target) {
  const key = `mis_${metric}`;
  return has(`achievements.${key}`) ? A(key, { count: target, n: fmt(target) }) : metric;
}
