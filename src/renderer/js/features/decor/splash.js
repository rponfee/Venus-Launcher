// Pantalla de inicio propia: una capa a pantalla completa (deja libre la barra de título, como la de carga)
// con el logo de la marca o un texto, 1,2 s y fundido. Nunca bloquea: se va sola, con un clic o una tecla, y
// un seguro la saca aunque algo falle. Contrato: showSplash(view, { hold, onDone }) -> quitar().
import { h, reducedMotion } from '../../ui.js';

export const SPLASH_HOLD_MS = 1200;
const FADE_MS = 420;
const FAILSAFE_MS = 4000;

let current = null;

// view: { style: 'logo' | 'text' | 'minimal', text, logoSrc, name, sub, pixel }
export function showSplash(view, { hold = SPLASH_HOLD_MS, onDone } = {}) {
  hideSplash();
  const style = ['text', 'minimal'].includes(view?.style) ? view.style : 'logo';
  const text = String(view?.text || '').trim() || view?.name || 'VENUS';
  const children = [];
  if (style === 'text') children.push(h('div', { class: 'dc-splash-text' }, text));
  else {
    children.push(h('img', { class: ['dc-splash-logo', view?.pixel && 'ap-logo-pixel'], src: view?.logoSrc || 'assets/logo-256.png', alt: '', draggable: 'false' }));
    children.push(h('div', { class: 'dc-splash-name' }, view?.name || 'VENUS'));
    if (style === 'logo' && view?.sub) children.push(h('div', { class: 'dc-splash-sub' }, view.sub));
  }
  const el = h('div', { class: ['dc-splash', `is-${style}`], role: 'presentation', 'aria-hidden': 'true' }, ...children);
  document.body.append(el);
  const instant = reducedMotion();
  let gone = false;
  let fadeTimer = 0;
  const onKey = () => remove();
  const remove = () => {
    if (gone) return;
    gone = true;
    clearTimeout(timer);
    clearTimeout(failsafe);
    window.removeEventListener('keydown', onKey, true);
    if (instant) el.remove();
    else {
      el.classList.add('out');
      fadeTimer = setTimeout(() => el.remove(), FADE_MS);
    }
    if (current?.el === el) current = null;
    try {
      onDone?.();
    } catch (err) {
      console.warn('[decor] splash', err?.message || err);
    }
  };
  const timer = setTimeout(remove, hold);
  const failsafe = setTimeout(() => {
    clearTimeout(fadeTimer);
    el.remove();
  }, hold + FAILSAFE_MS);
  el.addEventListener('pointerdown', remove);
  window.addEventListener('keydown', onKey, true);
  current = { el, remove };
  return remove;
}

export function hideSplash() {
  if (!current) return;
  const c = current;
  current = null;
  c.remove();
  c.el.remove();
}

export function splashShown() {
  return Boolean(current?.el?.isConnected);
}
