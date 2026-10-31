// Ajustes: piezas compartidas por las secciones (encabezados, tarjetas, campos con ayuda y error,
// claves secretas, avisos, estados vacios y de error, botones ocupados y paneles de otros modulos).
import { h, icon, mount, switchEl, skeleton, setBusy, reducedMotion } from '../../ui.js';
import { api } from '../../store.js';
import { t, loadNs } from '../../i18n.js';

// El canal de otro modulo todavia no existe (los modulos se construyen por separado).
export function isMissing(err) {
  return /no handler registered/i.test(String(err?.message || err || ''));
}

export function errMsg(err) {
  const text = String(err?.message || err || '').trim();
  return text || t('settings.errUnknown');
}

export function reduceMotion() {
  return reducedMotion();
}

// Encabezado de una seccion: icono, titulo y descripcion.
export function sectionHead(id, iconName) {
  return h(
    'header',
    { class: 'cfg-head' },
    h('div', { class: 'cfg-head-icon', 'aria-hidden': 'true' }, icon(iconName)),
    h('div', { class: 'cfg-head-text' }, h('h2', { class: 'cfg-title', id: `cfg-title-${id}` }, t(`settings.nav_${id}`)), h('p', { class: 'cfg-desc' }, t(`settings.desc_${id}`))),
  );
}

// Tarjeta con titulo opcional, accion a la derecha (extra) y ancla para los enlaces directos.
export function card({ title, iconName, sub, anchor, extra, cls } = {}, ...children) {
  return h(
    'section',
    { class: ['card cfg-card', cls], dataset: anchor ? { anchor } : undefined },
    title || extra
      ? h('div', { class: 'cfg-card-head' }, title ? h('h3', { class: 'card-title' }, iconName ? icon(iconName) : null, h('span', {}, title)) : h('span'), extra || null)
      : null,
    sub ? h('p', { class: 'card-sub cfg-card-sub' }, sub) : null,
    ...children,
  );
}

// El campo enfocable de un control (el propio input o el que tiene ese id adentro de un contenedor).
function controlOf(control, id) {
  if (!(control instanceof Element)) return null;
  if (id && control.id === id) return control;
  return (id && control.querySelector(`#${CSS.escape(id)}`)) || (control.matches('input, select, textarea') ? control : control.querySelector('input, select, textarea'));
}

function describedBy(el, add, remove) {
  const ids = new Set(String(el.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean));
  if (remove) ids.delete(remove);
  if (add) ids.add(add);
  if (ids.size) el.setAttribute('aria-describedby', [...ids].join(' '));
  else el.removeAttribute('aria-describedby');
}

// Campo con etiqueta visible arriba y ayuda persistente abajo (enlazada con aria-describedby).
export function field(label, control, { id, hint, cls } = {}) {
  const help = hint ? h('div', { class: 'field-help', id: id ? `${id}-help` : null }, hint) : null;
  const target = controlOf(control, id);
  if (help && id && target) describedBy(target, help.id);
  return h('div', { class: ['field', cls] }, h('label', id ? { for: id } : {}, label), control, help);
}

// Error de un campo debajo de el (aria-invalid + aria-describedby). Se borra solo al volver a escribir.
// fieldError(input, null) lo saca a mano. Con focus: true lleva el foco al campo.
export function fieldError(input, text, { focus = false } = {}) {
  if (!input) return;
  const box = input.closest('.field');
  const errId = `${input.id || 'cfg-field'}-err`;
  let err = box?.querySelector(':scope > .field-error');
  if (!text) {
    err?.remove();
    input.removeAttribute('aria-invalid');
    describedBy(input, null, errId);
    return;
  }
  if (!err) {
    err = h('div', { class: 'field-error', id: errId, role: 'alert' });
    if (box) box.append(err);
    else input.insertAdjacentElement('afterend', err);
  }
  mount(err, icon('alert'), h('span', {}, text));
  input.setAttribute('aria-invalid', 'true');
  describedBy(input, errId);
  if (!input.dataset.cfgErrWatch) {
    input.dataset.cfgErrWatch = '1';
    input.addEventListener('input', () => {
      if (input.getAttribute('aria-invalid') === 'true') fieldError(input, null);
    });
  }
  if (focus) input.focus();
}

// Valida un campo al salir de el (no en cada tecla). check(valor) devuelve el texto del error o nada.
// Los campos vacios no se marcan aca: eso lo avisa el envio del formulario.
export function validateOnBlur(input, check) {
  input.addEventListener('blur', () => {
    const v = input.value.trim();
    if (!v) return;
    const problem = check(v);
    if (problem) fieldError(input, problem);
  });
  return input;
}

export function toggleRow({ title, sub, checked, onChange, disabled = false }) {
  const sw = switchEl(Boolean(checked), onChange, title);
  const input = sw.querySelector('input');
  if (disabled && input) input.disabled = true;
  return h('div', { class: ['toggle-row cfg-toggle', disabled && 'is-disabled'] }, h('div', { class: 'tr-text' }, h('div', { class: 'tr-title' }, title), sub ? h('div', { class: 'tr-sub' }, sub) : null), sw);
}

// Campo de texto secreto (API keys, contrasenias) con boton para mostrar u ocultar.
export function secretField({ id, placeholder = '', autocomplete = 'off', value = '', mono = true, maxlength } = {}) {
  const input = h('input', {
    class: ['input cfg-secret-input', mono && 'mono'],
    type: 'password',
    id,
    placeholder,
    autocomplete,
    spellcheck: 'false',
    autocapitalize: 'off',
    value,
    maxlength,
  });
  const eye = h('button', { type: 'button', class: 'icon-btn sm cfg-eye', 'aria-pressed': 'false', 'aria-controls': id || null });
  const label = (shown) => {
    const text = shown ? t('settings.hideSecret') : t('settings.showSecret');
    eye.title = text;
    eye.setAttribute('aria-label', text);
    mount(eye, icon(shown ? 'eyeOff' : 'eye'));
  };
  label(false);
  eye.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    eye.setAttribute('aria-pressed', String(show));
    label(show);
  });
  return { input, el: h('div', { class: 'cfg-secret' }, input, eye) };
}

export function note(kind, iconName, ...content) {
  return h('div', { class: ['notice', kind, 'cfg-note'], role: kind === 'bad' ? 'alert' : null }, icon(iconName), h('div', { class: 'cfg-note-body' }, ...content));
}

// Error de una carga con la causa y el boton Reintentar (lo deja ocupado mientras vuelve a probar).
export function errorNote(text, onRetry, title) {
  const retry = onRetry
    ? h(
        'button',
        { type: 'button', class: 'btn sm cfg-note-btn', onclick: (e) => withBusy(e.currentTarget, onRetry) },
        icon('refresh'),
        t('settings.retry'),
      )
    : null;
  return note('bad', 'alert', title ? h('div', { class: 'cfg-note-title' }, title) : null, h('div', {}, text), retry);
}

// Fila de estado vacio dentro de una tarjeta: icono, que pasa, como seguir y una accion opcional.
export function emptyRow(iconName, title, sub, action) {
  return h(
    'div',
    { class: 'cfg-empty-row' },
    h('span', { class: 'cfg-empty-icon', 'aria-hidden': 'true' }, icon(iconName)),
    h('div', { class: 'cfg-empty-text' }, h('div', { class: 'cfg-empty-title' }, title), sub ? h('div', { class: 'cfg-empty-sub' }, sub) : null),
    action || null,
  );
}

// Caja de mensajes de un formulario (se anuncia a lectores de pantalla).
export function msgBox() {
  const box = h('div', { class: 'cfg-msg', 'aria-live': 'polite' });
  return {
    el: box,
    set(kind, text, iconName) {
      if (!text) return mount(box);
      const ic = iconName || (kind === 'good' ? 'check' : kind === 'bad' ? 'alert' : 'info');
      return mount(box, note(kind, ic, text));
    },
    clear() {
      mount(box);
    },
  };
}

// Corre fn con el boton ocupado: los .btn usan setBusy() (spinner en lugar del icono, deshabilitado y
// aria-busy); los botones de icono cambian su icono por un spinner.
export async function withBusy(btn, fn) {
  if (!btn || btn.disabled) return undefined;
  if (btn.classList.contains('btn')) {
    const done = setBusy(btn);
    try {
      return await fn();
    } finally {
      done();
    }
  }
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  const ic = btn.querySelector('svg');
  const spin = h('span', { class: 'spinner cfg-btn-spin', 'aria-hidden': 'true' });
  if (ic) ic.replaceWith(spin);
  else btn.prepend(spin);
  try {
    return await fn();
  } finally {
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
    if (ic) spin.replaceWith(ic);
    else spin.remove();
  }
}

// Enlace que se abre en el navegador del sistema.
export function extLink(url, label) {
  return h(
    'a',
    {
      href: url,
      class: 'cfg-link',
      title: url,
      onclick: (e) => {
        e.preventDefault();
        api.app.openExternal(url).catch(() => {});
      },
    },
    label,
    icon('external'),
  );
}

// Frase traducida completa con elementos (enlaces, codigo) en el lugar de sus {variables}:
// richText('ns.clave', { link: extLink(...) }) con 'Entrá a {link}.' -> ['Entrá a ', <a>, '.']
export function richText(key, nodes = {}) {
  return t(key)
    .split(/(\{\w+\})/g)
    .filter((part) => part !== '')
    .map((part) => {
      const m = part.match(/^\{(\w+)\}$/);
      return m && nodes[m[1]] !== undefined ? nodes[m[1]] : part;
    });
}

// Lista con iconos para textos explicativos.
export function iconList(items, cls) {
  return h(
    'ul',
    { class: ['cfg-ilist', cls] },
    items.filter(Boolean).map(([ic, text, sub]) => h('li', {}, h('span', { class: 'cfg-ilist-icon', 'aria-hidden': 'true' }, icon(ic)), h('span', { class: 'cfg-ilist-text' }, h('span', {}, text), sub ? h('span', { class: 'cfg-ilist-sub' }, sub) : null))),
  );
}

// Movimiento con flechas entre opciones de un grupo (sin seleccionar: Enter o Espacio eligen).
export function arrowFocus(container, selector = '[role="radio"]') {
  container.addEventListener('keydown', (e) => {
    if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const items = [...container.querySelectorAll(selector)].filter((el) => !el.disabled);
    const i = items.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    let n = i;
    if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = items.length - 1;
    else n = (i + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[n]?.focus();
  });
  return container;
}

// Clases genericas de main.css: no indican que el panel tenga diseño propio.
const GENERIC_CLASSES = new Set(['loading-box', 'form-grid', 'toggle-row', 'list-item', 'card-title', 'card-sub', 'card-head', 'input-icon', 'section-title', 'page-head', 'text-2']);

// Un panel con clase propia de su modulo (stg-panel, ax-panel, card dc-panel...) ya trae su diseño.
function selfStyled(el) {
  if (!(el instanceof Element)) return false;
  return [...el.classList].some((c) => c === 'card' || (/^[a-z0-9]+-[\w-]+$/i.test(c) && !GENERIC_CLASSES.has(c)));
}

// Panel de otro modulo (contrato de la seccion 6 de docs/arquitectura.md). Mientras carga se ve un
// skeleton; si el modulo no esta o falla, un aviso con la causa y Reintentar en lugar de romper la
// pagina. Si el panel trae su propio diseño se muestra tal cual; si no (por ejemplo, un texto suelto),
// se envuelve en una tarjeta.
export function embedPanel(host, { load, fn, ns = [], label, iconName }, ctx) {
  const run = async () => {
    mount(host, h('div', { class: 'cfg-embed-wait' }, skeleton('card', { lines: 4 })));
    let el = null;
    try {
      const mod = await load();
      await loadNs(...ns).catch(() => {});
      if (typeof mod?.[fn] !== 'function') throw new Error(t('settings.panelMissing'));
      el = mod[fn]();
      if (el && typeof el.then === 'function') el = await el;
      if (!(el instanceof Node)) throw new Error(t('settings.panelMissing'));
    } catch (err) {
      console.warn(`[settings] ${fn}`, err);
      if (ctx.alive()) mount(host, errorNote(t('settings.panelErrorText', { error: errMsg(err) }), run, t('settings.panelErrorTitle')));
      return;
    }
    const destroy = () => {
      try {
        if (typeof el?.destroy === 'function') el.destroy();
      } catch (err) {
        console.warn(`[settings] ${fn}.destroy`, err);
      }
    };
    if (!ctx.alive()) {
      destroy();
      return;
    }
    ctx.onCleanup(destroy);
    mount(
      host,
      h(
        'div',
        { class: ['cfg-embed', selfStyled(el) && 'cfg-embed-bare'] },
        label ? h('h3', { class: 'cfg-embed-label' }, iconName ? icon(iconName) : null, h('span', {}, label)) : null,
        h('div', { class: 'cfg-embed-body' }, el),
      ),
    );
  };
  run();
}
