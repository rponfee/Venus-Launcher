// Música: cliente compartido del estado (una sola suscripción a nowplaying:update para la página, el mini
// reproductor y Ajustes), mini reproductor de la barra lateral, tarjeta de Ajustes (fuente, overlay y atajos) y
// comandos de la paleta Ctrl+K.
// Contrato: startup(), miniPlayer() -> Element (con .destroy()), nowPlayingPanel() -> Element (con .destroy()).
// Mientras alguien está suscripto y la ventana se ve, pide el estado cada 15 s: así el proceso principal sabe que
// la interfaz lo necesita (si la ventana está minimizada deja de pedirlo y el ayudante se cierra solo).
// Canales: nowplaying:state/control/setVolume/sources/openSpotify · evento nowplaying:update.
import { h, icon, mount, registerIcons, ensureCss, switchEl, fail, ok } from '../ui.js';
import { store, api } from '../store.js';
import { t, loadNs } from '../i18n.js';
import { acceleratorFromEvent } from '../voice/keys.js';

const NS = 'nowplaying';
const PING_MS = 15000;
const ART_RE = /^data:image\/(jpeg|png);base64,[A-Za-z0-9+/]+={0,2}$/;
const SHORTCUT_ACTIONS = ['playPause', 'next', 'prev', 'volumeUp', 'volumeDown'];

// Íconos propios (estilo Lucide)
export const NP_ICONS = {
  npSkipBack: '<polygon points="19 20 9 12 19 4 19 20"/><line x1="5" x2="5" y1="19" y2="5"/>',
  npBack: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  npForward: '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>',
  npVolumeLow: '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>',
};
registerIcons(NP_ICONS);

let readyPromise = null;
export function prepare() {
  ensureCss('features/nowplaying');
  if (!readyPromise) readyPromise = loadNs(NS).catch((err) => console.warn('[nowplaying] textos', err?.message || err));
  return readyPromise;
}

const isMissing = (err) => /No handler registered/i.test(err?.message || '');

// ---------- Formatos y ayudas ----------
export function fmtClock(ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}

// Posición actual: el proceso principal manda la posición en positionAt; si está sonando, sigue avanzando
export function positionNow(state, now = Date.now()) {
  if (!state) return 0;
  let p = Number(state.position) || 0;
  if (state.playing && state.positionAt) p += Math.max(0, now - state.positionAt);
  return state.duration > 0 ? Math.min(p, state.duration) : p;
}

export const safeArt = (art) => (typeof art === 'string' && art.length <= 20480 && ART_RE.test(art) ? art : null);

// Portada (o el ícono de música si no hay); se reemplaza solo si cambió
export function paintArt(slot, art) {
  const src = safeArt(art);
  if (slot.dataset.art === (src || '')) return;
  slot.dataset.art = src || '';
  mount(slot, src ? h('img', { src, alt: '', draggable: 'false' }) : icon('music'));
}

export const appLabel = (state) => state?.appName || 'Windows';
export const titleOf = (state) => state?.title || t('nowplaying.untitled');

// ---------- Cliente compartido ----------
let view = null;
const subs = new Set();
let offUpdate = null;
let pingTimer = null;

function emit() {
  for (const fn of [...subs]) {
    try {
      fn(view);
    } catch (err) {
      console.error('[nowplaying]', err);
    }
  }
}

function setView(v) {
  if (!v || typeof v !== 'object') return view;
  view = v;
  emit();
  return view;
}

const visible = () => document.visibilityState !== 'hidden';

async function refresh(opts) {
  try {
    return setView(await api.invoke('nowplaying:state', opts));
  } catch (err) {
    if (isMissing(err)) return setView({ available: false, reason: 'missing', state: null });
    console.warn('[nowplaying] estado', err?.message || err);
    return view;
  }
}

function schedulePing() {
  clearInterval(pingTimer);
  pingTimer = null;
  if (subs.size && visible()) pingTimer = setInterval(() => (visible() ? refresh() : schedulePing()), PING_MS);
}

const onVisibility = () => {
  if (!subs.size) return;
  if (visible()) refresh();
  schedulePing();
};

function subscribe(fn) {
  subs.add(fn);
  if (subs.size === 1) {
    try {
      offUpdate = api.on('nowplaying:update', setView);
    } catch (err) {
      console.warn('[nowplaying]', err?.message || err);
    }
    document.addEventListener('visibilitychange', onVisibility);
    refresh();
    schedulePing();
  } else if (view) {
    try {
      fn(view);
    } catch (err) {
      console.error('[nowplaying]', err);
    }
  }
  return () => {
    if (!subs.delete(fn) || subs.size) return;
    offUpdate?.();
    offUpdate = null;
    document.removeEventListener('visibilitychange', onVisibility);
    clearInterval(pingTimer);
    pingTimer = null;
  };
}

async function control(action, value) {
  return setView(await api.invoke('nowplaying:control', action, value));
}

async function setVolume(level) {
  return setView(await api.invoke('nowplaying:setVolume', level));
}

async function sources() {
  try {
    return await api.invoke('nowplaying:sources');
  } catch (err) {
    if (!isMissing(err)) console.warn('[nowplaying] fuentes', err?.message || err);
    return { choice: 'auto', loaded: false, list: [] };
  }
}

async function openSpotify() {
  return api.invoke('nowplaying:openSpotify');
}

export const nowPlaying = {
  subscribe,
  refresh,
  control,
  setVolume,
  sources,
  openSpotify,
  get view() {
    return view;
  },
};

// Acción con aviso de error (los botones de reproducción no muestran spinner: responden en milisegundos)
export async function runAction(action, value) {
  try {
    return await control(action, value);
  } catch (err) {
    fail(t('nowplaying.actionFailed'), err);
    return null;
  }
}

async function navigateMusic() {
  try {
    (await import('../app.js')).navigate('music');
  } catch (err) {
    console.warn('[nowplaying]', err?.message || err);
  }
}

// Elemento que se desuscribe solo cuando sale del documento (o con el.destroy())
function autoDispose(root, dispose) {
  let seen = false;
  const born = Date.now();
  const watch = setInterval(() => {
    if (root.isConnected) seen = true;
    else if (seen || Date.now() - born > 60000) root.destroy();
  }, 2000);
  let done = false;
  root.destroy = () => {
    if (done) return;
    done = true;
    clearInterval(watch);
    dispose();
  };
}

// ---------- Mini reproductor (barra lateral) ----------
/**
 * Mini reproductor para la barra lateral: portada, canción, reproducir/pausar y siguiente. Se oculta cuando no
 * hay nada que mostrar. Al tocar la canción abre #/music. Se limpia solo al salir del documento o con .destroy().
 */
export function miniPlayer() {
  const art = h('span', { class: 'np-mini-art', 'aria-hidden': 'true' });
  const title = h('span', { class: 'np-mini-title' });
  const artist = h('span', { class: 'np-mini-artist' });
  const open = h('button', { class: 'np-mini-open', type: 'button', onclick: navigateMusic }, art, h('span', { class: 'np-mini-text' }, title, artist));
  const playBtn = h('button', { class: 'icon-btn sm np-mini-btn', type: 'button', onclick: () => runAction('toggle') });
  const nextBtn = h('button', { class: 'icon-btn sm np-mini-btn', type: 'button', onclick: () => runAction('next') }, icon('skipForward'));
  const fill = h('i');
  const bar = h('span', { class: 'np-mini-bar', 'aria-hidden': 'true' }, fill);
  const root = h('div', { class: 'np-mini', role: 'group', hidden: true }, open, playBtn, nextBtn, bar);
  let current = null;
  let playIcon = '';
  let ready = false;

  function paintProgress() {
    const st = current?.state;
    const pct = st && st.duration > 0 ? positionNow(st) / st.duration : 0;
    fill.style.transform = `scaleX(${Math.min(1, Math.max(0, pct)).toFixed(4)})`;
  }

  function draw(v) {
    current = v;
    if (!ready) return;
    const st = v?.available ? v.state : null;
    root.hidden = !st;
    if (!st) return;
    paintArt(art, st.art);
    const name = titleOf(st);
    title.textContent = name;
    artist.textContent = st.artist || appLabel(st);
    open.title = t('nowplaying.miniOpen', { title: st.artist ? `${name} · ${st.artist}` : name });
    open.setAttribute('aria-label', open.title);
    const next = st.playing ? 'pause' : 'play';
    if (playIcon !== next) {
      playIcon = next;
      mount(playBtn, icon(next));
    }
    playBtn.title = t(st.playing ? 'nowplaying.pause' : 'nowplaying.play');
    playBtn.setAttribute('aria-label', playBtn.title);
    playBtn.disabled = !v.can?.toggle;
    nextBtn.disabled = !v.can?.next;
    paintProgress();
  }

  const tick = setInterval(() => {
    if (!root.hidden && current?.state?.playing) paintProgress();
  }, 1000);
  let off = null;
  prepare().then(() => {
    if (root.dataset.disposed) return;
    ready = true;
    root.setAttribute('aria-label', t('nowplaying.miniLabel'));
    nextBtn.title = t('nowplaying.next');
    nextBtn.setAttribute('aria-label', nextBtn.title);
    off = subscribe(draw);
    if (current) draw(current);
  });
  autoDispose(root, () => {
    root.dataset.disposed = '1';
    clearInterval(tick);
    off?.();
  });
  return root;
}

// ---------- Atajos: etiquetas ----------
const MOD_LABEL = { CommandOrControl: 'Ctrl', CmdOrCtrl: 'Ctrl', Control: 'Ctrl', Ctrl: 'Ctrl', Alt: 'Alt', AltGr: 'Alt Gr', Shift: 'Shift', Super: 'Win', Meta: 'Win' };
const KEY_LABEL = { Up: '↑', Down: '↓', Left: '←', Right: '→', Return: 'Enter', Escape: 'Esc' };
export function accelParts(accel) {
  if (!accel) return [];
  return String(accel)
    .split('+')
    .filter(Boolean)
    .map((p) => MOD_LABEL[p] || KEY_LABEL[p] || (p === 'Space' ? t('nowplaying.keySpace') : p.replace(/^num/, 'Num ')));
}
const kbdKeys = (parts) => h('span', { class: 'np-keys' }, parts.map((p) => h('kbd', { class: 'kbd' }, p)));

const PILL = { ok: 'good', inUse: 'warn', reserved: 'warn', duplicate: 'warn', invalid: 'bad' };

// ---------- Tarjeta de Ajustes ----------
/**
 * Tarjeta de Música para Ajustes: reproductor que se controla, mostrar la canción en el juego y atajos de teclado
 * globales (desactivados por defecto). Guarda en settings.nowplaying. Con .destroy().
 */
export function nowPlayingPanel() {
  const root = h('section', { class: 'card np-panel', 'aria-busy': 'true' });
  let off = null;
  let disposed = false;
  let recording = null;
  autoDispose(root, () => {
    disposed = true;
    recording?.stop();
    off?.();
  });
  prepare()
    .then(() => {
      if (disposed) return;
      root.removeAttribute('aria-busy');
      off = buildPanel(root, () => disposed, (r) => (recording = r));
    })
    .catch((err) => {
      console.error('[nowplaying]', err);
      root.removeAttribute('aria-busy');
    });
  return root;
}

function cfgNow() {
  const raw = store.settings?.nowplaying || {};
  return { source: typeof raw.source === 'string' && raw.source ? raw.source : 'auto', overlay: raw.overlay !== false, shortcuts: raw.shortcuts || {} };
}

async function saveCfg(patch) {
  try {
    await store.setSettings({ nowplaying: patch });
    return true;
  } catch (err) {
    fail(t('nowplaying.saveFailed'), err);
    return false;
  }
}

let panelSeq = 0;
function buildPanel(root, isDisposed, setRecording) {
  const uid = `np-${++panelSeq}`;
  const notice = h('div', { class: 'notice info np-panel-notice', hidden: true }, icon('info'), h('div', {}, t('nowplaying.panelUnavailable')));

  // Reproductor que se controla
  const select = h('select', { class: 'select', id: `${uid}-source`, 'aria-describedby': `${uid}-source-help` });
  const sourceHelp = h('div', { class: 'field-help', id: `${uid}-source-help` });
  const sourceField = h('div', { class: 'field np-field' }, h('label', { for: `${uid}-source` }, t('nowplaying.sourceLabel')), select, sourceHelp);
  let list = [];
  let srcKey = '';
  select.addEventListener('change', async () => {
    await saveCfg({ source: select.value });
    drawSources();
    nowPlaying.refresh();
  });

  function drawSources() {
    const choice = cfgNow().source;
    const opts = [
      { value: 'auto', label: t('nowplaying.sourceAuto') },
      { value: 'system', label: t('nowplaying.sourceSystem') },
    ];
    const seen = new Set();
    for (const s of list) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      opts.push({ value: s.id, label: s.title ? t('nowplaying.sourceApp', { app: s.appName, title: s.title }) : t('nowplaying.sourceAppIdle', { app: s.appName }), appName: s.appName });
    }
    const missing = choice !== 'auto' && choice !== 'system' && !seen.has(choice);
    if (missing) opts.push({ value: choice, label: t('nowplaying.sourceMissingOption', { app: appNameOf(choice) }) });
    const key = JSON.stringify([choice, opts]);
    if (key !== srcKey) {
      srcKey = key;
      mount(select, opts.map((o) => h('option', { value: o.value, selected: o.value === choice }, o.label)));
    }
    const pinned = opts.find((o) => o.value === choice);
    sourceHelp.textContent =
      choice === 'auto' ? t('nowplaying.sourceHelpAuto')
        : choice === 'system' ? t('nowplaying.sourceHelpSystem')
          : missing ? t('nowplaying.sourceHelpMissing', { app: appNameOf(choice) })
            : t('nowplaying.sourceHelpApp', { app: pinned?.appName || appNameOf(choice) });
  }

  // Nombre de una app guardada que hoy no está abierta (sin la lista del proceso principal)
  function appNameOf(id) {
    const s = String(id || '').replace(/#\d+$/, '');
    if (/spotify/i.test(s)) return 'Spotify';
    const base = s.split('!')[0].split(/[\\/]/).pop().replace(/_[a-z0-9]{13}$/i, '').replace(/\.exe$/i, '');
    return base.includes('.') ? base.split('.').pop() : base || s;
  }

  async function loadSources() {
    const r = await nowPlaying.sources();
    if (isDisposed()) return;
    list = Array.isArray(r?.list) ? r.list : [];
    drawSources();
  }

  // Canción en el juego (overlay)
  const overlaySwitch = switchEl(cfgNow().overlay, (v) => saveCfg({ overlay: v }), t('nowplaying.overlayTitle'));
  const overlayRow = h('div', { class: 'toggle-row np-toggle' }, h('div', { class: 'tr-text' }, h('div', { class: 'tr-title' }, t('nowplaying.overlayTitle')), h('div', { class: 'tr-sub' }, t('nowplaying.overlaySub'))), overlaySwitch);

  // Atajos
  const scEnable = switchEl(cfgNow().shortcuts.enabled === true, (v) => saveCfg({ shortcuts: { enabled: v } }), t('nowplaying.shortcutsEnable'));
  const scHead = h('div', { class: 'toggle-row np-toggle' }, h('div', { class: 'tr-text' }, h('div', { class: 'tr-title' }, t('nowplaying.shortcutsTitle')), h('div', { class: 'tr-sub' }, t('nowplaying.shortcutsSub'))), scEnable);
  const scMsg = h('p', { class: 'field-help np-sc-msg', role: 'status', 'aria-live': 'polite' });
  const scList = h('div', { class: 'np-sc-list', role: 'list' });
  const rows = new Map();
  for (const action of SHORTCUT_ACTIONS) {
    const keys = h('span', { class: 'np-sc-keys' });
    const pill = h('span', { class: 'pill np-sc-pill', hidden: true });
    const change = h('button', { class: 'btn sm', type: 'button', 'aria-label': t('nowplaying.scChangeAria', { action: t(`nowplaying.sc_${action}`) }), onclick: () => record(action) }, icon('keyboard'), t('nowplaying.scChange'));
    const clearBtn = h('button', { class: 'icon-btn sm', type: 'button', title: t('nowplaying.scClear', { action: t(`nowplaying.sc_${action}`) }), 'aria-label': t('nowplaying.scClear', { action: t(`nowplaying.sc_${action}`) }), onclick: () => saveShortcut(action, '') }, icon('x'));
    const row = h('div', { class: 'np-sc-row', role: 'listitem' }, h('span', { class: 'np-sc-label' }, t(`nowplaying.sc_${action}`)), keys, pill, h('span', { class: 'np-sc-actions' }, change, clearBtn));
    rows.set(action, { row, keys, pill, change, clearBtn });
    scList.append(row);
  }
  scMsg.textContent = t('nowplaying.scHint');

  async function saveShortcut(action, accel) {
    if (await saveCfg({ shortcuts: { [action]: accel } })) {
      if (accel) ok(t('nowplaying.scSaved'), accelParts(accel).join(' + '));
      drawShortcuts(nowPlaying.view);
    }
  }

  let active = null; // grabación en curso
  function record(action) {
    active?.stop();
    const r = rows.get(action);
    mount(r.keys, h('span', { class: 'np-sc-recording' }, t('nowplaying.scPress')));
    r.row.classList.add('recording');
    const onKey = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') return stop();
      const res = acceleratorFromEvent(e);
      if (!res) {
        const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift'].filter(Boolean);
        mount(r.keys, mods.length ? kbdKeys(mods) : h('span', { class: 'np-sc-recording' }, t('nowplaying.scPress')));
        return;
      }
      if (res.error) {
        scMsg.textContent = t(res.error === 'needsModifier' ? 'nowplaying.scNeedsModifier' : 'nowplaying.scUnsupported');
        return;
      }
      stop();
      saveShortcut(action, res.accel);
    };
    const onBlur = () => stop();
    function stop() {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onBlur);
      r.row.classList.remove('recording');
      active = null;
      setRecording(null);
      scMsg.textContent = t('nowplaying.scHint');
      drawShortcuts(nowPlaying.view);
      if (!isDisposed()) r.change.focus({ preventScroll: true });
    }
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onBlur);
    active = { stop };
    setRecording(active);
  }

  function drawShortcuts(v) {
    const cfg = cfgNow().shortcuts;
    const items = new Map((v?.shortcuts?.items || []).map((i) => [i.action, i]));
    const enabled = v?.shortcuts?.enabled ?? cfg.enabled === true;
    scList.classList.toggle('off', !enabled);
    for (const action of SHORTCUT_ACTIONS) {
      const r = rows.get(action);
      if (r.row.classList.contains('recording')) continue;
      const item = items.get(action);
      const accel = item ? item.accel : typeof cfg[action] === 'string' ? cfg[action] : '';
      const parts = accelParts(accel);
      mount(r.keys, parts.length ? kbdKeys(parts) : h('span', { class: 'muted small' }, t('nowplaying.scNone')));
      r.clearBtn.hidden = !parts.length;
      const state = item?.state;
      const cls = enabled && state ? PILL[state] : null;
      r.pill.hidden = !cls;
      if (cls) {
        r.pill.className = `pill ${cls} np-sc-pill`;
        r.pill.textContent = t(`nowplaying.scState_${state}`);
      }
    }
  }

  const body = h('div', { class: 'np-panel-body' }, sourceField, overlayRow, scHead, scList, scMsg);
  mount(
    root,
    h('div', { class: 'card-head' }, h('div', {}, h('div', { class: 'card-title' }, icon('music'), t('nowplaying.panelTitle')), h('div', { class: 'card-sub' }, t('nowplaying.panelSub')))),
    notice,
    body,
  );

  let lastSessions = -1;
  let lastSource = null;
  const draw = (v) => {
    if (isDisposed()) return;
    const unavailable = Boolean(v) && v.available === false;
    notice.hidden = !unavailable;
    body.hidden = unavailable;
    if (unavailable) return;
    // La lista de reproductores se vuelve a pedir cuando cambia cuántos hay o cuál se controla
    const srcId = v?.source?.id || null;
    if (v && (v.sessions !== lastSessions || srcId !== lastSource)) {
      lastSessions = v.sessions;
      lastSource = srcId;
      loadSources();
    }
    const cfg = cfgNow();
    overlaySwitch.querySelector('input').checked = cfg.overlay;
    scEnable.querySelector('input').checked = v?.shortcuts?.enabled ?? cfg.shortcuts.enabled === true;
    drawShortcuts(v);
  };
  drawSources();
  drawShortcuts(nowPlaying.view);
  return subscribe(draw);
}

// ---------- Paleta de comandos ----------
let started = false;
export function startup() {
  if (started) return;
  started = true;
  (async () => {
    await prepare();
    const { registerCommands } = await import('../a11y.js');
    registerCommands(() => {
      const v = nowPlaying.view;
      const cmds = [{ id: 'nowplaying.open', title: t('nowplaying.cmdOpen'), group: 'pages', icon: 'music', keywords: t('nowplaying.cmdKeywords'), run: navigateMusic }];
      if (v?.available !== false) {
        cmds.push(
          { id: 'nowplaying.toggle', title: t('nowplaying.cmdToggle'), sub: v?.state ? `${titleOf(v.state)} · ${appLabel(v.state)}` : undefined, group: 'actions', icon: v?.state?.playing ? 'pause' : 'play', keywords: t('nowplaying.cmdKeywords'), run: () => runAction('toggle') },
          { id: 'nowplaying.next', title: t('nowplaying.cmdNext'), group: 'actions', icon: 'skipForward', keywords: t('nowplaying.cmdKeywords'), run: () => runAction('next') },
          { id: 'nowplaying.prev', title: t('nowplaying.cmdPrev'), group: 'actions', icon: 'npSkipBack', keywords: t('nowplaying.cmdKeywords'), run: () => runAction('prev') },
        );
      }
      return cmds;
    });
  })().catch((err) => console.warn('[nowplaying] paleta', err?.message || err));
}
