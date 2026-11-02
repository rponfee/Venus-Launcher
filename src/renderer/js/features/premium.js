// Venus Premium = tener un plan de Venus vigente (RPC venus_is_premium de 0020; los planes y el pago están en
// features/plans.js). Lo usan otras partes para habilitar lo premium (puntos x2, insignia dorada, banners animados,
// efectos de nombre, repetición instantánea de 120 s...). El servidor lo vuelve a comprobar en cada acción: esto
// solo decide qué se muestra.
//   isPremium({ force }) -> Promise<boolean>   caché de 5 minutos por cuenta; sin sesión o sin servicio, false
//   onPremiumChange(fn) -> off                 fn(premium) cuando cambia el valor conocido (también la primera vez
//                                              que se conoce); se revisa al cambiar la sesión y con billing:changed
//   perksPanel() -> Element (con .destroy())   beneficios de Premium con el botón a los planes (openPlans)
import { h, icon, mount, ensureCss, skeleton } from '../ui.js';
import { api } from '../store.js';
import { t, loadNs } from '../i18n.js';
import { backend } from '../pages/rewards/backend.js';

const TTL = 5 * 60 * 1000;
const ERROR_TTL = 60 * 1000; // si el servicio falla, se vuelve a preguntar antes
const P = (key, vars) => t(`premium.${key}`, vars);

let cache = null; // { user, value, at, ttl }
let pending = null; // { user, promise }
let known; // último valor avisado (undefined hasta conocerlo)
let knownUser;
let watching = false;
let lastUser;
const listeners = new Set();

function emit(user, value) {
  if (value === known && user === knownUser) return;
  const changed = value !== known;
  known = value;
  knownUser = user;
  if (!changed) return;
  for (const fn of [...listeners]) {
    try {
      fn(value);
    } catch (err) {
      console.error(err);
    }
  }
}

function watch() {
  if (watching) return;
  watching = true;
  backend()
    .then((b) => {
      lastUser = b.userId();
      b.onAuth(() => {
        const id = b.userId();
        if (id === lastUser) return; // renovar el token no cambia nada
        lastUser = id;
        cache = null;
        pending = null;
        isPremium({ force: true });
      });
    })
    .catch(() => {});
  api.on('billing:changed', () => isPremium({ force: true }));
}

export async function isPremium({ force = false } = {}) {
  watch();
  let b;
  try {
    b = await backend();
  } catch {
    return false;
  }
  const user = b.signedIn() ? b.userId() : null;
  if (!user) {
    cache = null;
    emit(null, false);
    return false;
  }
  if (!force && cache && cache.user === user && Date.now() - cache.at < cache.ttl) return cache.value;
  if (!force && pending && pending.user === user) return pending.promise;
  const promise = (async () => {
    let value;
    let ttl = TTL;
    try {
      value = (await b.rpc('venus_is_premium', { p_user: user })) === true;
    } catch (err) {
      if (err?.code !== 'noSession') console.warn('[premium] no se pudo saber si la cuenta es premium:', err?.code || err?.message || err);
      value = cache?.user === user ? cache.value : false;
      ttl = ERROR_TTL;
    }
    if (b.userId() !== user) return false; // cambió la sesión mientras tanto: lo resuelve el pedido nuevo
    cache = { user, value, at: Date.now(), ttl };
    emit(user, value);
    return value;
  })().finally(() => {
    if (pending?.promise === promise) pending = null;
  });
  pending = { user, promise };
  return promise;
}

export function onPremiumChange(fn) {
  if (typeof fn !== 'function') return () => {};
  listeners.add(fn);
  watch();
  return () => listeners.delete(fn);
}

// ---------- Beneficios ----------
const PERKS = [
  { id: 'points', icon: 'zap' },
  { id: 'badge', icon: 'star' },
  { id: 'banner', icon: 'image' },
  { id: 'effects', icon: 'sparkles' },
  { id: 'frame', icon: 'crown' },
  { id: 'replay', icon: 'camera' },
  { id: 'ai', icon: 'wand' },
];

function openPlansDialog() {
  import('./plans.js')
    .then((m) => m.openPlans())
    .catch((err) => console.warn('[premium] planes', err));
}

export function perksPanel() {
  ensureCss('features/premium');
  const root = h('section', { class: 'pm-panel', 'aria-busy': 'true' });
  let alive = true;
  let off = () => {};

  function render(premium) {
    if (!alive) return;
    root.classList.toggle('active', premium === true);
    root.removeAttribute('aria-busy');
    const titleId = `pm-title-${Math.random().toString(36).slice(2, 8)}`;
    root.setAttribute('aria-labelledby', titleId);
    mount(
      root,
      h(
        'div',
        { class: 'pm-head' },
        h('div', { class: 'pm-mark', 'aria-hidden': 'true' }, icon('crown')),
        h(
          'div',
          { class: 'pm-head-main' },
          h('h3', { class: 'pm-title', id: titleId }, P('title'), premium ? h('span', { class: 'pill good' }, icon('check'), P('active')) : null),
          h('p', { class: 'pm-sub' }, P(premium ? 'activeText' : 'subtitle')),
        ),
      ),
      h(
        'ul',
        { class: 'pm-list' },
        PERKS.map((p) =>
          h(
            'li',
            { class: 'pm-perk' },
            h('span', { class: 'pm-perk-icon', 'aria-hidden': 'true' }, icon(p.icon)),
            h('span', { class: 'pm-perk-main' }, h('span', { class: 'pm-perk-title' }, P(`perk_${p.id}`)), h('span', { class: 'pm-perk-text' }, P(`perk_${p.id}Text`))),
          ),
        ),
      ),
      h(
        'div',
        { class: 'pm-foot' },
        h('p', { class: 'pm-note' }, P('note')),
        h('button', { type: 'button', class: premium ? 'btn tonal' : 'btn primary', onclick: openPlansDialog }, icon('crown'), P(premium ? 'managePlan' : 'seePlans')),
      ),
    );
  }

  loadNs('premium')
    .then(() => {
      if (!alive) return;
      mount(root, skeleton('list', { rows: 3 }));
      off = onPremiumChange(render);
      return isPremium().then(render);
    })
    .catch((err) => console.warn('[premium]', err));

  root.destroy = () => {
    alive = false;
    off();
  };
  return root;
}
