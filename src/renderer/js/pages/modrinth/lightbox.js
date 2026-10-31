// Visor de imagenes a pantalla completa para galerias, descripciones y comparaciones.
// Teclado: flechas para moverse, Escape para cerrar (no cierra el modal que esta debajo).
import { h, icon, mount } from '../../ui.js';
import { t } from '../../i18n.js';

// images: [{ url, raw?, title?, description? }]
export function openLightbox(images, start = 0) {
  const list = (images || []).filter((x) => x && (x.url || x.raw));
  if (!list.length) return null;
  let index = Math.max(0, Math.min(list.length - 1, Number(start) || 0));
  const prevFocus = document.activeElement;

  const img = h('img', { class: 'mx-lb-img', alt: '', referrerpolicy: 'no-referrer', draggable: 'false' });
  const caption = h('div', { class: 'mx-lb-caption' });
  const counter = h('div', { class: 'mx-lb-counter', 'aria-live': 'polite' });
  const btn = (cls, ic, label, fn) => h('button', { class: `mx-lb-btn ${cls}`, type: 'button', title: label, 'aria-label': label, onclick: (e) => (e.stopPropagation(), fn()) }, icon(ic));
  const prevBtn = btn('mx-lb-prev', 'chevronLeft', t('modrinth.lbPrev'), () => show(index - 1));
  const nextBtn = btn('mx-lb-next', 'chevronRight', t('modrinth.lbNext'), () => show(index + 1));
  const openBtn = btn('mx-lb-open', 'external', t('modrinth.lbOpen'), () => {
    const item = list[index];
    window.venus.app.openExternal(item.raw || item.url).catch(() => {});
  });
  const closeBtn = btn('mx-lb-close', 'x', t('modrinth.lbClose'), () => close());
  const stage = h('div', { class: 'mx-lb-stage' }, h('div', { class: 'spinner lg mx-lb-spin' }), img, h('div', { class: 'mx-lb-error' }, icon('image'), t('modrinth.lbError')));
  const root = h(
    'div',
    { class: 'mx-lb', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('modrinth.lbTitle') },
    h('div', { class: 'mx-lb-top' }, counter, h('span', { class: 'spacer' }), openBtn, closeBtn),
    stage,
    caption,
    prevBtn,
    nextBtn,
  );

  function show(i) {
    index = (i + list.length) % list.length;
    const item = list[index];
    root.classList.add('loading');
    root.classList.remove('error');
    img.onload = () => root.classList.remove('loading');
    img.onerror = () => {
      root.classList.remove('loading');
      root.classList.add('error');
    };
    img.src = item.raw || item.url;
    img.alt = item.title || '';
    mount(caption, item.title ? h('div', { class: 'mx-lb-title' }, item.title) : null, item.description ? h('div', { class: 'mx-lb-desc' }, item.description) : null);
    counter.textContent = list.length > 1 ? t('modrinth.lbCounter', { n: index + 1, total: list.length }) : '';
    prevBtn.hidden = nextBtn.hidden = list.length < 2;
    for (const d of [1, -1]) {
      const n = list[(index + d + list.length) % list.length];
      if (n !== item) new Image().src = n.raw || n.url;
    }
  }

  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      close();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      e.stopImmediatePropagation();
      show(index + (e.key === 'ArrowLeft' ? -1 : 1));
    } else if (e.key === 'Tab') {
      const focusable = [...root.querySelectorAll('button')].filter((b) => !b.hidden);
      const pos = focusable.indexOf(document.activeElement);
      e.preventDefault();
      e.stopImmediatePropagation();
      focusable[(pos + (e.shiftKey ? -1 : 1) + focusable.length) % focusable.length]?.focus();
    }
  };

  function close() {
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('hashchange', close);
    root.remove();
    if (prevFocus && typeof prevFocus.focus === 'function' && prevFocus.isConnected) prevFocus.focus();
  }

  root.addEventListener('mousedown', (e) => {
    if (e.target === root || e.target === stage) close();
  });
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('hashchange', close);
  document.body.append(root);
  show(index);
  closeBtn.focus();
  return { close, show };
}
