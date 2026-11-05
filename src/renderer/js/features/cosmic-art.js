// Arte local generado para los tickets y los niveles. Las cifras siempre vienen del estado real.
import { h } from '../ui.js';
import { normalizeAppearance } from './cosmic-art/logic.js';
const TICKET = new URL('../../assets/venus/points-ticket.png', import.meta.url).href;
const PLANET_ART = Object.fromEntries(['venus', 'mars', 'neptune'].map((id) => [id, new URL(`../../assets/venus/planet-${id}.png`, import.meta.url).href]));

export function pointsTicket(amount, { label = 'Venus Points', compact = false } = {}) {
  return h('div', { class: ['va-ticket', compact && 'is-compact'] },
    h('img', { class: 'va-ticket-art', src: TICKET, alt: '', 'aria-hidden': 'true', draggable: 'false' }),
    h('div', { class: 'va-ticket-copy' }, h('strong', { class: 'va-ticket-amount num' }, amount), h('span', { class: 'va-ticket-label' }, label)));
}

export function levelBadge(level, appearance, { label = '', compact = false } = {}) {
  const v = normalizeAppearance(appearance);
  return h('div', { class: ['va-level', `is-${v.frame}`, compact && 'is-compact'], style: { '--level-accent': v.accent, '--level-number': v.number } },
    h('img', { class: 'va-level-planet', src: PLANET_ART[v.planet], alt: '', 'aria-hidden': 'true', draggable: 'false' }),
    h('span', { class: 'va-level-frame', 'aria-hidden': 'true' }),
    h('div', { class: 'va-level-copy' }, label ? h('span', { class: 'va-level-label' }, label) : null, h('strong', { class: 'va-level-number num' }, String(level))));
}
