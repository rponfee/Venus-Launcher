// Marco de una extensión: el iframe sandbox y su puente. Modelo: el código de adentro es hostil.
//  - <iframe sandbox="allow-scripts"> de origen opaco y sin permisos (allow vacío), servido por venus-ext:// con una
//    URL de un solo uso. Si el documento vuelve a cargar, algo navegó: se corta.
//  - El borde y la franja con el nombre y "Extensión de la comunidad" los dibuja el launcher por fuera del iframe:
//    la extensión no los puede tapar ni imitar un diálogo, porque no dibuja fuera de su rectángulo.
//  - Solo se atiende a event.source === el iframe. Cualquier otro origen de mensajes se ignora sin leer su contenido.
//  - Foco: entra al iframe solo si la persona hace clic o llega con Tab. Si se lo lleva solo, se le saca: el marco corre
//    en otro proceso y el launcher no recibe ningún evento en el iframe, así que se revisa cada tanto y al perder el foco.
import { h, icon, mount, toast, confirmDialog } from '../../ui.js';
import { api, store } from '../../store.js';
import { t, getLanguage } from '../../i18n.js';
import { navigate, launchInstance } from '../../app.js';
import { createBridge, gameStateView, BRIDGE_VERSION } from './bridge-core.js';

const SLOW_READ_MS = 150; // leer un mensaje no debería tardar: si tarda, es enorme
const HUGE_READ_MS = 1000; // con una sola de estas alcanza
const SLOW_STRIKES = 2;
const MAX_DECLINES = 3;
const FOCUS_CHECK_MS = 250;
const TAB_GRACE_MS = 800;

const sessions = new Map(); // WindowProxy del iframe -> sesión
let listening = false;
let lastTab = 0;
let focusTimer = null;

function guardFocus() {
  for (const session of sessions.values()) {
    const { iframe } = session;
    if (document.activeElement !== iframe) {
      session.focusOk = false;
    } else if (!session.focusOk) {
      if (iframe.matches(':hover') || Date.now() - lastTab < TAB_GRACE_MS) session.focusOk = true;
      else iframe.blur();
    }
  }
}

function syncFocusTimer() {
  if (sessions.size && !focusTimer) focusTimer = setInterval(guardFocus, FOCUS_CHECK_MS);
  else if (!sessions.size && focusTimer) {
    clearInterval(focusTimer);
    focusTimer = null;
  }
}

function onMessage(event) {
  const session = sessions.get(event.source);
  if (session) session.receive(event);
}

function ensureListening() {
  if (listening) return;
  listening = true;
  window.addEventListener('message', onMessage);
  window.addEventListener('blur', guardFocus);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') lastTab = Date.now();
  });
}

// La confirmación del launcher: la extensión nunca lanza sola y no puede apilar diálogos.
function launchHandler(ext) {
  let pending = false;
  let declines = 0;
  return async (instanceId) => {
    if (pending) throw Object.assign(new Error('busy'), { code: 'busy' });
    if (declines >= MAX_DECLINES) throw Object.assign(new Error('declined'), { code: 'declined' });
    const inst = store.instances.find((i) => i.id === instanceId);
    if (!inst) throw Object.assign(new Error('not_found'), { code: 'not_found' });
    pending = true;
    try {
      const yes = await confirmDialog(t('extensions.launchTitle'), t('extensions.launchText', { extension: ext.name, instance: inst.name }), { okText: t('extensions.launchOk'), cancelText: t('extensions.launchCancel') });
      if (!yes) {
        declines += 1;
        throw Object.assign(new Error('declined'), { code: 'declined' });
      }
      return { launched: await launchInstance(inst.id) };
    } finally {
      pending = false;
    }
  };
}

function ensureActive(iframe) {
  guardFocus(); // un foco robado no cuenta
  if (document.activeElement !== iframe) throw Object.assign(new Error('not_allowed'), { code: 'not_allowed' });
}

/**
 * extensionFrame(ext, 'page' | 'card') -> { el, start(), destroy() }. ext es la vista de extensions:list.
 * start() se llama con el elemento ya en la página (el iframe necesita estar conectado).
 */
export function extensionFrame(ext, surface = 'page') {
  ensureListening();
  const body = h('div', { class: 'xt-body' });
  const reloadBtn = h('button', { class: 'icon-btn sm', type: 'button', title: t('extensions.frameReload'), 'aria-label': t('extensions.frameReload'), onclick: () => start() }, icon('refresh'));
  const bar = h(
    'div',
    { class: 'xt-bar' },
    icon('puzzle'),
    h('strong', { class: 'xt-name ellipsis', title: ext.name }, ext.name),
    h('span', { class: 'xt-tag' }, t('extensions.communityTag')),
    h('span', { class: 'spacer' }),
    surface === 'page' ? h('span', { class: 'xt-author muted small ellipsis', title: ext.author }, t('extensions.byAuthor', { author: ext.author })) : null,
    reloadBtn,
  );
  const el = h('section', { class: ['xt-frame', `xt-${surface}`], 'aria-label': t('extensions.frameLabel', { name: ext.name }) }, bar, body);

  let session = null;
  let destroyed = false;
  let attempts = 0;

  function teardown() {
    if (!session) return;
    sessions.delete(session.win);
    syncFocusTimer();
    session.iframe.remove();
    session = null;
  }

  function stop(reasonKey) {
    teardown();
    mount(body, h('div', { class: 'notice bad xt-stopped' }, icon('alert'), h('div', {}, t(`extensions.stopped_${reasonKey}`))));
  }

  function makeHandlers(iframe) {
    return {
      storage: (op, key, value) => api.invoke('extensions:storage', ext.id, op, key, value),
      notify: (title, text) => {
        toast('info', t('extensions.toastTitle', { name: ext.name, title }), text);
        return true;
      },
      instances: () => store.instances,
      gameState: () => gameStateView(store.running),
      // Abrir otra página saca a la persona de donde está: tiene que estar usando la extensión.
      openPage: (route) => {
        ensureActive(iframe);
        navigate(route);
        return true;
      },
      launchInstance: launchHandler(ext),
    };
  }

  async function start() {
    if (destroyed) return;
    const attempt = ++attempts; // dos clics seguidos en recargar: gana el último
    teardown();
    mount(body, h('div', { class: 'spinner xt-spin' }));
    let url;
    try {
      ({ url } = await api.invoke('extensions:openSession', ext.id, surface));
    } catch (err) {
      console.warn('[extensions] no se pudo abrir', ext.id, err?.message || err);
      if (!destroyed && attempt === attempts) stop('unavailable');
      return;
    }
    if (destroyed || attempt !== attempts || !el.isConnected) return;
    const iframe = h('iframe', { class: 'xt-iframe', title: t('extensions.frameLabel', { name: ext.name }), sandbox: 'allow-scripts', allow: '', referrerpolicy: 'no-referrer', tabindex: '0' });
    iframe.src = url;
    mount(body, iframe);
    const bridge = createBridge({ permissions: ext.permissions, handlers: makeHandlers(iframe) });
    let loads = 0;
    let slowReads = 0;
    let dropped = false;
    const current = {
      iframe,
      win: iframe.contentWindow,
      focusOk: false,
      receive(event) {
        const verdict = bridge.admit();
        if (verdict === 'flood') return stop('flood');
        if (verdict === 'drop') {
          if (!dropped) {
            dropped = true;
            console.warn('[extensions] demasiados mensajes de', ext.id);
          }
          return undefined;
        }
        dropped = false;
        const before = performance.now();
        const data = event.data; // recién acá se deserializa
        const took = performance.now() - before;
        if (took > HUGE_READ_MS) return stop('flood');
        if (took > SLOW_READ_MS) {
          slowReads += 1;
          if (slowReads >= SLOW_STRIKES) return stop('flood');
        }
        return bridge.handle(data).then(
          (reply) => {
            if (reply && session === current) current.win.postMessage(reply, '*');
          },
          (err) => console.warn('[extensions] puente', ext.id, err?.message || err),
        );
      },
    };
    session = current;
    sessions.set(current.win, current);
    syncFocusTimer();
    iframe.addEventListener('load', () => {
      if (session !== current) return;
      loads += 1;
      // La URL es de un solo uso: una segunda carga quiere decir que el marco navegó.
      if (loads > 1) return stop('navigated');
      current.win.postMessage({ venus: BRIDGE_VERSION, type: 'hello', extension: { id: ext.id, name: ext.name, version: ext.version }, permissions: [...ext.permissions], surface, locale: getLanguage() }, '*');
      return undefined;
    });
  }

  function destroy() {
    destroyed = true;
    teardown();
  }

  return { el, start, destroy };
}
