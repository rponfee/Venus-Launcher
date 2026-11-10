// Clips y capturas en toda la interfaz: avisos al guardar (con "Ver"), logros first_screenshot / first_clip, la
// señal 'media-share' de un amigo (aviso con "Ver") y el panel de Ajustes: atajos, repeticion instantanea (30 s a 30
// minutos, para todos), clips automaticos, calidad (presets Liviano / Equilibrado / Maximo o manual: resolucion, fps
// y calidad de imagen, con lo que ocupa en disco), largo maximo de una grabacion, audio, avisos y carpeta.
// Las cuentas (bitrate, disco, presets, que se graba de verdad) las hace el proceso principal (capture/logic.js) y
// llegan en capture:status: aca solo se muestran.
// Contrato: startup() (idempotente), capturePanel() -> Element (con .destroy()), fmtLength(segundos) -> "5 min".
// Canales: capture:status, capture:testShortcut, capture:openFolder, perf:system; eventos capture:saved,
// capture:state y capture:notice.
import { h, icon, mount, ok, fail, toast, ensureCss, loading, switchEl, setBusy, fmtBytes, modal } from '../ui.js';
import { store, api } from '../store.js';
import { t, loadNs } from '../i18n.js';
import { navigate } from '../app.js';
import { cloud } from '../cloud.js';

const NS = 'capture';
const ACTIONS = ['replay', 'record', 'screenshot'];
const QUALITIES = ['720p', '1080p', '1440p', '2160p', 'native']; // si capture:status no trae la lista
const FPS_LIST = [30, 45, 60, 80, 120];
const LEVELS = ['low', 'medium', 'high'];
const REPLAY_LENGTHS = [30, 60, 120, 300, 600, 900, 1800];
const RECORD_LIMITS = [0, 15, 30, 60, 120, 240];
const PRESETS = ['light', 'balanced', 'max'];
const CODEC_NAME = { av1: 'AV1', h264: 'H.264', vp9: 'VP9', vp8: 'VP8' };
const AUTO_TYPES = ['death', 'advancement', 'boss'];
const AUTO_COOLDOWNS = [15, 30, 60, 120, 300];
const AUTO_LIMITS = [5, 10, 20, 50];
const AUTO_LENGTHS = [30, 60, 120, 300];
let readyPromise = null;
let started = false;
const achieved = new Set(); // logros ya avisados en esta sesion
const shareSeen = new Map(); // remitente -> ultima vez (un aviso cada 8 s como mucho)

function prepare() {
  ensureCss('features/capture');
  if (!readyPromise) readyPromise = loadNs(NS).catch((err) => console.warn('[capture] textos', err));
  return readyPromise;
}

const isMissing = (err) => /No handler registered/i.test(err?.message || '');

function achievement(id) {
  if (achieved.has(id)) return;
  achieved.add(id);
  window.dispatchEvent(new CustomEvent('venus:achievement', { detail: { id } }));
}

// ---------- Avisos al guardar ----------

function tabFor(type) {
  return type === 'screenshot' ? 'screenshots' : type === 'recording' ? 'recordings' : 'clips';
}

function viewButton(route) {
  return h('button', { class: 'btn sm cap-toast-btn', type: 'button', onclick: () => navigate(route) }, icon('eye'), t('capture.view'));
}

function onSaved(evt) {
  if (!evt || typeof evt !== 'object') return;
  if (evt.type === 'screenshot') achievement('first_screenshot');
  else if (evt.type === 'clip' || evt.type === 'recording') achievement('first_clip');
  if (store.settings?.capture?.notify === false) return;
  const auto = AUTO_TYPES.includes(evt.reason) ? t('capture.savedAuto', { reason: t(`capture.reason_${evt.reason}`) }) : null;
  const title = evt.type === 'screenshot' ? t('capture.savedShot') : evt.type === 'recording' ? t('capture.savedRecording') : auto || t('capture.savedClip');
  const name = String(evt.path || '').split(/[\\/]/).pop();
  const msg = h('div', { class: 'cap-toast' }, h('span', { class: 'cap-toast-name', title: name }, name), viewButton(`clips/${tabFor(evt.type)}`));
  toast('good', title, msg, 6000);
}

// ---------- Largos ----------

// "30 s", "5 min", "1 h", "1 h 30 min" (largo de la repeticion, de un clip o limite de una grabacion)
export function fmtLength(seconds) {
  const sec = Math.max(0, Math.round(Number(seconds) || 0));
  if (sec < 60) return t('capture.lenSeconds', { n: sec });
  const min = Math.round(sec / 60);
  if (min < 60) return t('capture.lenMinutes', { n: min });
  const hours = Math.floor(min / 60);
  return min % 60 ? `${t('capture.lenHours', { n: hours })} ${t('capture.lenMinutes', { n: min % 60 })}` : t('capture.lenHours', { n: hours });
}

// "1:05" de lo que hay en el buffer
function clockOf(seconds) {
  const sec = Math.max(0, Math.round(Number(seconds) || 0));
  const m = Math.floor(sec / 60);
  return `${m}:${String(sec % 60).padStart(2, '0')}`;
}

const qualityLabel = (q) => t(`capture.quality_${q}`);
const mbps = (bps) => (Math.round((Number(bps) || 0) / 1e5) / 10).toLocaleString();

// ---------- Señal 'media-share' de un amigo ----------

// Solo links firmados del Storage del proyecto del launcher (capturas y clips compartidos)
function safeShareUrl(raw) {
  try {
    const u = new URL(String(raw || ''));
    const base = new URL(cloud.config?.url || '');
    if (u.protocol !== 'https:' || u.host !== base.host || u.username || u.password) return null;
    if (!/^\/storage\/v1\/object\/sign\/(screenshots|clips)\//.test(u.pathname)) return null;
    return u.href.length <= 2000 ? u.href : null;
  } catch {
    return null;
  }
}

function cleanText(s, max) {
  return String(s ?? '')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim()
    .slice(0, max);
}

export function openSharedMedia({ url, kind, name, from }) {
  const isClip = kind === 'clip';
  const media = isClip
    ? h('video', { class: 'cap-share-media', src: url, controls: true, autoplay: true, preload: 'metadata', 'aria-label': name })
    : h('img', { class: 'cap-share-media', src: url, alt: name });
  const errBox = h('div', { class: 'notice bad', hidden: true }, icon('alert'), h('div', {}, t('capture.shareLoadFailed')));
  media.addEventListener('error', () => {
    media.hidden = true;
    errBox.hidden = false;
  });
  const m = modal({
    title: isClip ? t('capture.shareClipTitle', { name: from }) : t('capture.shareShotTitle', { name: from }),
    subtitle: name,
    icon: isClip ? 'play' : 'image',
    size: 'wide',
    onClose: () => media.pause?.(),
    body: h('div', { class: 'cap-share-view' }, media, errBox),
    footer: [
      h('button', { class: 'btn', type: 'button', onclick: () => api.app.openExternal(url).catch((err) => fail(t('capture.openFailed'), err)) }, icon('external'), t('capture.openInBrowser')),
      h('button', { class: 'btn ghost', type: 'button', onclick: () => m.close() }, t('capture.close')),
    ],
  });
}

function onMediaShare(evt) {
  const p = evt?.payload || {};
  const url = safeShareUrl(p.url);
  if (!url) return;
  const sender = typeof evt?.fromId === 'string' ? evt.fromId : '?';
  const last = shareSeen.get(sender) || 0;
  if (Date.now() - last < 8000) return;
  shareSeen.set(sender, Date.now());
  const kind = p.kind === 'clip' ? 'clip' : 'screenshot';
  const name = cleanText(p.name, 120) || (kind === 'clip' ? t('capture.aClip') : t('capture.aScreenshot'));
  const from = cleanText(evt.from, 40) || t('capture.someone');
  const btn = h('button', { class: 'btn sm cap-toast-btn', type: 'button', onclick: () => openSharedMedia({ url, kind, name, from }) }, icon('eye'), t('capture.view'));
  const msg = h('div', { class: 'cap-toast' }, h('span', { class: 'cap-toast-name', title: name }, name), btn);
  toast('info', kind === 'clip' ? t('capture.friendSentClip', { name: from }) : t('capture.friendSentShot', { name: from }), msg, 12000);
}

async function listenShares() {
  try {
    const { social } = await import('../social.js');
    if (typeof social?.onSignal === 'function') social.onSignal('media-share', (evt) => prepare().then(() => onMediaShare(evt)));
  } catch (err) {
    console.warn('[capture] señales:', err?.message || err);
  }
}

// ---------- Arranque ----------

export async function startup() {
  if (started) return;
  started = true;
  await prepare();
  api.on('capture:saved', (evt) => prepare().then(() => onSaved(evt)));
  api.on('capture:notice', (n) => {
    if (n?.message) toast(n.level === 'error' ? 'bad' : 'info', t('capture.noticeTitle'), String(n.message), n.level === 'error' ? 7000 : 4500);
  });
  listenShares();
}

// ---------- Panel de Ajustes ----------

const MOD_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta', 'AltGraph', 'OS']);
const CODE_KEYS = {
  Space: 'Space',
  Tab: 'Tab',
  Enter: 'Enter',
  NumpadEnter: 'Enter',
  Insert: 'Insert',
  Delete: 'Delete',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  PrintScreen: 'PrintScreen',
  NumpadAdd: 'numadd',
  NumpadSubtract: 'numsub',
  NumpadMultiply: 'nummult',
  NumpadDivide: 'numdiv',
  NumpadDecimal: 'numdec',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backquote: '`',
};

// Acelerador de Electron a partir de una tecla apretada (por la posicion fisica: igual en cualquier distribucion)
export function accelFromEvent(e) {
  if (MOD_KEYS.has(e.key)) return null;
  const code = String(e.code || '');
  let key = null;
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit\d$/.test(code)) key = code.slice(5);
  else if (/^Numpad\d$/.test(code)) key = `num${code.slice(6)}`;
  else if (/^F([1-9]|1\d|2[0-4])$/.test(code)) key = code;
  else key = CODE_KEYS[code] || null;
  if (!key) return null;
  const mods = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Super');
  return [...mods, key].join('+');
}

function keysView(accel) {
  if (!accel) return h('span', { class: 'cap-none' }, t('capture.noShortcut'));
  return h('span', { class: 'cap-keys' }, accel.split('+').map((k) => h('span', { class: 'kbd' }, k)));
}

function toggleRow(id, title, sub, checked, onChange) {
  const sw = switchEl(checked, onChange, title);
  const input = sw.querySelector('input');
  if (input) input.dataset.capId = id;
  return h('div', { class: 'toggle-row cap-toggle' }, h('div', { class: 'tr-text' }, h('div', { class: 'tr-title' }, title), h('div', { class: 'tr-sub' }, sub)), sw);
}

/**
 * Panel de Ajustes de clips y capturas. Se limpia solo cuando sale del documento (o con el.destroy()).
 */
export function capturePanel() {
  const root = h('section', { class: 'card cap-panel', 'aria-busy': 'true' }, loading());
  const offs = [];
  let disposed = false;
  let seen = false;
  const born = Date.now();
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearInterval(watch);
    offs.splice(0).forEach((off) => off());
  };
  const watch = setInterval(() => {
    if (root.isConnected) seen = true;
    else if (seen || Date.now() - born > 60000) dispose();
  }, 2000);
  root.destroy = dispose;
  prepare()
    .then(() => buildPanel(root, offs, () => disposed))
    .catch((err) => {
      if (disposed) return;
      console.error('[capture]', err);
      mount(root, h('div', { class: 'notice bad' }, icon('alert'), h('div', {}, err.message)));
    })
    .finally(() => {
      if (!disposed) root.removeAttribute('aria-busy');
    });
  return root;
}

async function buildPanel(root, offs, isDisposed) {
  await store.refreshSettings().catch(() => {});
  // Datos de la PC (perf): en una PC modesta o con el modo liviano se avisa si la calidad elegida es pesada
  let tier = null;
  api
    .invoke('perf:system')
    .then((sys) => {
      tier = sys?.tier || null;
      if (!isDisposed() && (tier === 'low' || tier === 'mid')) draw();
    })
    .catch(() => {});
  let st = null;
  try {
    st = await api.invoke('capture:status');
  } catch (err) {
    if (isDisposed()) return;
    if (isMissing(err)) {
      mount(root, h('div', { class: 'notice bad' }, icon('alert'), h('div', {}, t('capture.unavailable'))));
      return;
    }
    console.warn('[capture] estado', err);
  }
  if (isDisposed()) return;
  const cfg = () => st?.settings || {};
  const save = async (patch) => {
    try {
      await store.setSettings({ capture: patch });
      st = await api.invoke('capture:status').catch(() => st);
      if (!isDisposed()) draw();
      return true;
    } catch (err) {
      if (!isDisposed()) fail(t('capture.saveFailed'), err);
      return false;
    }
  };

  const statusLine = h('div', { class: 'cap-status', role: 'status', 'aria-live': 'polite' });
  const body = h('div', { class: 'cap-body' });
  mount(
    root,
    h(
      'div',
      { class: 'cap-head' },
      h('div', { class: 'cap-logo', 'aria-hidden': 'true' }, icon('camera')),
      h('div', { class: 'cap-head-text' }, h('div', { class: 'card-title' }, t('capture.title')), h('div', { class: 'cap-sub' }, t('capture.subtitle'))),
      h('button', { class: 'btn sm ghost', type: 'button', onclick: () => navigate('clips') }, icon('image'), t('capture.openGallery')),
    ),
    statusLine,
    body,
  );

  function drawStatus() {
    if (!st) return mount(statusLine);
    let text;
    let cls = '';
    if (st.available === false) {
      text = t('capture.platformUnavailable');
      cls = 'warn';
    } else if (st.recording?.active) {
      text = t('capture.statusRecording');
      cls = 'bad';
    } else if (st.game && st.replay?.error) {
      text = t('capture.statusReplayNoDisk');
      cls = 'warn';
    } else if (st.game) text = st.replay?.active ? t('capture.statusReplayBuffer', { buffered: clockOf(st.replay.buffered), length: fmtLength(st.replaySeconds), disk: fmtBytes(st.replay.disk || 0) }) : t('capture.statusGame');
    else text = t('capture.statusIdle');
    if (st.game || st.recording?.active) cls = cls || 'good';
    mount(statusLine, h('span', { class: ['pill', cls] }, h('span', { class: 'cap-dot', 'aria-hidden': 'true' }), text));
  }

  // ---------- Atajos ----------
  let capturing = null; // { action, off }
  function shortcutRow(action) {
    const accel = cfg().shortcuts?.[action] || '';
    const sc = st?.shortcuts?.[action];
    const err = h('div', { class: 'field-error cap-err', hidden: true, role: 'alert' });
    const keys = h('div', { class: 'cap-keys-box', 'aria-live': 'polite' }, keysView(accel));
    const change = h('button', { class: 'btn sm', type: 'button', 'data-cap-id': `change-${action}` }, icon('keyboard'), t('capture.change'));
    const clear = h('button', { class: 'icon-btn sm', type: 'button', 'data-cap-id': `clear-${action}`, title: t('capture.clearShortcut'), 'aria-label': t('capture.clearShortcutFor', { action: t(`capture.action_${action}`) }), disabled: !accel }, icon('x'));
    const showErr = (msg) => {
      err.hidden = !msg;
      mount(err, msg ? [icon('alert'), h('span', {}, msg)] : []);
    };
    const stop = () => {
      capturing?.off();
      capturing = null;
      change.classList.remove('active');
      mount(change, icon('keyboard'), t('capture.change'));
      mount(keys, keysView(cfg().shortcuts?.[action] || ''));
    };
    change.addEventListener('click', () => {
      if (capturing?.action === action) return stop();
      if (capturing) capturing.off();
      showErr('');
      change.classList.add('active');
      mount(change, icon('x'), t('capture.cancelCapture'));
      mount(keys, h('span', { class: 'cap-listening' }, t('capture.pressKeys')));
      const onKey = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === 'Escape') return stop();
        const acc = accelFromEvent(e);
        if (!acc) return;
        stop();
        let res;
        try {
          res = await api.invoke('capture:testShortcut', acc, action);
        } catch (er) {
          showErr(er.message);
          return;
        }
        if (!res?.ok) {
          const reason = res?.reason === 'duplicate' ? t('capture.errDuplicate', { action: t(`capture.action_${res.other}`) }) : res?.reason === 'inUse' ? t('capture.errInUse', { key: res.accel }) : t('capture.errInvalid');
          showErr(reason);
          return;
        }
        if (await save({ shortcuts: { [action]: res.accel } })) ok(t('capture.shortcutSaved'), res.accel);
      };
      document.addEventListener('keydown', onKey, true);
      capturing = { action, off: () => document.removeEventListener('keydown', onKey, true) };
    });
    clear.addEventListener('click', () => save({ shortcuts: { [action]: '' } }));
    const warn = accel && sc?.active && !sc?.registered ? h('div', { class: 'field-error cap-err' }, icon('alert'), h('span', {}, t('capture.errNotRegistered'))) : null;
    return h(
      'div',
      { class: 'cap-sc-row' },
      h('div', { class: 'cap-sc-label' }, h('div', { class: 'tr-title' }, t(`capture.action_${action}`)), h('div', { class: 'tr-sub' }, actionSub(action))),
      keys,
      h('div', { class: 'cap-sc-actions' }, change, clear),
      warn,
      err,
    );
  }

  function actionSub(action) {
    if (action === 'replay') return t('capture.action_replayLenSub', { length: fmtLength(st?.replaySeconds || 60) });
    if (action === 'record' && cfg().recordLimit) return t('capture.action_recordLimitSub', { length: fmtLength(cfg().recordLimit * 60) });
    return t(`capture.action_${action}Sub`);
  }

  // ---------- Dibujo ----------
  function segmented(label, options, value, onPick) {
    return h(
      'div',
      { class: 'segmented cap-seg', role: 'group', 'aria-label': label },
      options.map((o) => h('button', { type: 'button', 'data-cap-id': `${label}-${o.value}`, class: String(o.value) === String(value) ? 'active' : '', 'aria-pressed': String(String(o.value) === String(value)), onclick: () => onPick(o.value) }, o.label)),
    );
  }

  // ---------- Clips automaticos ----------
  function autoSection(c, maxSeconds) {
    const a = c.auto || {};
    const replayOn = Boolean(c.replay);
    const master = toggleRow('auto', t('capture.autoEnable'), t('capture.autoEnableSub'), Boolean(a.enabled), (v) => save({ auto: { enabled: v } }));
    if (!replayOn) master.querySelector('input')?.setAttribute('disabled', '');
    const rows = [];
    if (!replayOn) rows.push(h('p', { class: 'cap-help' }, t('capture.autoNeedsReplay')));
    else if (a.enabled) {
      for (const type of AUTO_TYPES) rows.push(toggleRow(`auto-${type}`, t(`capture.auto_${type}`), t(`capture.auto_${type}Sub`), a[type] !== false, (v) => save({ auto: { [type]: v } })));
      const seconds = (s) => (s < 60 ? t('capture.autoSecondsValue', { seconds: s }) : t('capture.autoMinutesValue', { minutes: s / 60 }));
      // Un clip no puede durar mas que lo que guarda la repeticion
      const lengths = AUTO_LENGTHS.filter((s) => s <= maxSeconds);
      rows.push(
        h('div', { class: 'cap-field' }, h('span', { class: 'cap-label' }, t('capture.autoLength')), segmented(t('capture.autoLength'), (lengths.length ? lengths : [maxSeconds]).map((s) => ({ value: s, label: seconds(s) })), Math.min(a.seconds || 60, maxSeconds), (v) => save({ auto: { seconds: Number(v) } }))),
        h('div', { class: 'cap-field' }, h('span', { class: 'cap-label' }, t('capture.autoCooldown')), segmented(t('capture.autoCooldown'), AUTO_COOLDOWNS.map((s) => ({ value: s, label: seconds(s) })), a.cooldown, (v) => save({ auto: { cooldown: Number(v) } }))),
        h('div', { class: 'cap-field' }, h('span', { class: 'cap-label' }, t('capture.autoLimit')), segmented(t('capture.autoLimit'), AUTO_LIMITS.map((n) => ({ value: n, label: String(n) })), a.maxPerSession, (v) => save({ auto: { maxPerSession: Number(v) } }))),
        h('p', { class: 'cap-help' }, t('capture.autoHelp')),
      );
    }
    return h('div', { class: 'cap-section' }, h('div', { class: 'cap-section-title', role: 'heading', 'aria-level': '3' }, icon('sparkles'), t('capture.autoTitle')), master, rows);
  }

  // Lo que ocupa la repeticion con lo elegido, y si no entra en el disco
  function diskNote() {
    const disk = fmtBytes(st?.diskEstimate || 0);
    const known = Number.isFinite(st?.diskFree) && st.diskFree !== null;
    if (known && st.diskOk === false) return h('div', { class: 'notice bad cap-disk', role: 'alert' }, icon('alert'), h('div', {}, t('capture.replayNoRoom', { disk, free: fmtBytes(st.diskFree) })));
    // El buffer entra, pero guardar el tramo entero necesita otro tanto en el mismo disco
    if (known && st.diskSaveOk === false) return h('div', { class: 'notice cap-disk' }, icon('alert'), h('div', {}, t('capture.replaySaveTight', { disk, free: fmtBytes(st.diskFree) })));
    return h('p', { class: 'cap-help cap-disk' }, icon('drive'), h('span', {}, known ? t('capture.replayDiskLine', { disk, free: fmtBytes(st.diskFree) }) : t('capture.replayDiskLineNoFree', { disk })));
  }

  // Presets de un clic + manual: resolucion, fps y calidad de imagen
  function qualitySection(c, opts) {
    const active = st?.preset || 'custom';
    const presets = st?.presets || [];
    const presetBtn = (id) => {
      const p = presets.find((x) => x.id === id);
      const on = active === id;
      return h(
        'button',
        { type: 'button', class: ['cap-preset', on ? 'active' : ''], 'data-cap-id': `preset-${id}`, 'aria-pressed': String(on), onclick: () => p && save({ quality: p.quality, fps: p.fps, level: p.level }) },
        h('span', { class: 'cap-preset-name' }, t(`capture.preset_${id}`)),
        p ? h('span', { class: 'cap-preset-sub' }, t('capture.presetSub', { quality: qualityLabel(p.quality), fps: p.fps })) : null,
        p ? h('span', { class: 'cap-preset-disk' }, t('capture.presetDisk', { disk: fmtBytes(p.disk || 0), length: fmtLength(seconds()) })) : null,
      );
    };
    const seconds = () => st?.replaySeconds || 60;
    const plan = st?.plan || null;
    const live = st?.live || null;
    const notes = [];
    if (st?.degraded) notes.push(h('div', { class: 'notice warn' }, icon('alert'), h('div', {}, t('capture.degradedNote', { quality: qualityLabel(st.degraded.quality), fps: st.degraded.fps }))));
    const lite = document.documentElement.hasAttribute('data-ui-lite');
    if (st?.heavy && (tier === 'low' || tier === 'mid' || lite)) notes.push(h('div', { class: 'notice warn' }, icon('alert'), h('div', {}, t('capture.heavyWarn'))));
    if (plan?.notes?.includes('window')) notes.push(h('p', { class: 'cap-help' }, icon('info'), h('span', {}, t('capture.noteWindow', { quality: qualityLabel(c.quality), width: plan.width, height: plan.height }))));
    if (plan?.notes?.includes('monitor') && st?.display?.hz) notes.push(h('p', { class: 'cap-help' }, icon('info'), h('span', {}, t('capture.noteMonitor', { hz: st.display.hz }))));
    // Por la GPU no se baja nada: si salen menos cuadros, es el juego (o su VSync) o la pantalla
    if (live?.hardware && Number.isFinite(live.fps) && live.fps !== null && live.fps < (plan?.fps || 0) * 0.85) notes.push(h('p', { class: 'cap-help' }, icon('info'), h('span', {}, t('capture.noteSource', { fps: Math.round(live.fps) }))));
    const planLine = live
      ? t('capture.planLive', { width: live.width, height: live.height, fps: Number.isFinite(live.fps) && live.fps !== null ? Math.round(live.fps) : plan?.fps || c.fps, codec: t(live.hardware ? 'capture.codecHw' : 'capture.codecSw', { codec: CODEC_NAME[live.codec] || live.codec || '?' }), mbps: mbps(live.bitrate) })
      : plan
        ? t('capture.planLine', { width: plan.width, height: plan.height, fps: plan.fps, mbps: mbps(plan.expected) })
        : null;
    return h(
      'div',
      { class: 'cap-section' },
      h('div', { class: 'cap-section-title', role: 'heading', 'aria-level': '3' }, icon('monitor'), t('capture.qualityTitle')),
      h('div', { class: 'cap-presets', role: 'group', 'aria-label': t('capture.presetsLabel') }, PRESETS.map(presetBtn)),
      h('p', { class: 'cap-help' }, active === 'custom' ? t('capture.presetCustom') : t('capture.presetHelp')),
      h('div', { class: 'cap-field' }, h('span', { class: 'cap-label' }, t('capture.resolution')), segmented(t('capture.resolution'), (opts.qualities || QUALITIES).map((q) => ({ value: q, label: qualityLabel(q) })), c.quality, (v) => save({ quality: v }))),
      h('div', { class: 'cap-field' }, h('span', { class: 'cap-label' }, t('capture.fps')), segmented(t('capture.fps'), (opts.fps || FPS_LIST).map((f) => ({ value: f, label: t('capture.fpsValue', { fps: f }) })), c.fps, (v) => save({ fps: Number(v) }))),
      h('div', { class: 'cap-field' }, h('span', { class: 'cap-label' }, t('capture.level')), segmented(t('capture.level'), (opts.levels || LEVELS).map((l) => ({ value: l, label: t(`capture.level_${l}`) })), c.level || 'medium', (v) => save({ level: v }))),
      planLine ? h('p', { class: 'cap-plan', role: 'status' }, icon('gauge'), h('span', {}, planLine)) : null,
      h('p', { class: 'cap-help' }, t('capture.qualityHelp')),
      notes,
      h('div', { class: 'cap-field' }, h('span', { class: 'cap-label' }, t('capture.recordLimit')), segmented(t('capture.recordLimit'), (opts.recordLimits || RECORD_LIMITS).map((m) => ({ value: m, label: m ? fmtLength(m * 60) : t('capture.recordLimitNone') })), c.recordLimit || 0, (v) => save({ recordLimit: Number(v) }))),
      h('p', { class: 'cap-help' }, t('capture.recordHelp', { disk: fmtBytes(st?.recordPerMinute || 0) })),
      st?.audioAvailable === false ? null : toggleRow('audio', t('capture.audio'), t('capture.audioSub'), c.audio !== false, (v) => save({ audio: v })),
    );
  }

  function draw() {
    if (isDisposed()) return;
    // El foco vuelve al mismo control despues de redibujar
    const focusId = root.contains(document.activeElement) ? document.activeElement.dataset?.capId : null;
    capturing?.off();
    capturing = null;
    const c = cfg();
    const seconds = st?.replaySeconds || 60;
    const opts = st?.options || {};
    const replay = h(
      'div',
      { class: 'cap-section' },
      h('div', { class: 'cap-section-title', role: 'heading', 'aria-level': '3' }, icon('history'), t('capture.replayTitle')),
      toggleRow('replay', t('capture.replayEnable'), t('capture.replayEnableSub', { length: fmtLength(seconds) }), Boolean(c.replay), (v) => save({ replay: v })),
      h('div', { class: 'cap-field' }, h('span', { class: 'cap-label' }, t('capture.replayLength')), segmented(t('capture.replayLength'), (opts.replayLengths || REPLAY_LENGTHS).map((n) => ({ value: n, label: fmtLength(n) })), seconds, (v) => save({ replaySeconds: Number(v) }))),
      diskNote(),
    );
    const auto = autoSection(c, seconds);
    const quality = qualitySection(c, opts);
    const shortcuts = h(
      'div',
      { class: 'cap-section' },
      h('div', { class: 'cap-section-title', role: 'heading', 'aria-level': '3' }, icon('keyboard'), t('capture.shortcutsTitle')),
      h('p', { class: 'cap-help' }, t('capture.shortcutsHelp')),
      ACTIONS.map(shortcutRow),
    );
    const copyBtn = h('button', { class: 'btn sm', type: 'button' }, icon('folder'), c.copyTo ? t('capture.changeFolder') : t('capture.chooseFolder'));
    copyBtn.addEventListener('click', async () => {
      const done = setBusy(copyBtn);
      try {
        const dir = await api.app.selectFolder({ title: t('capture.chooseFolder') });
        if (dir) await save({ copyTo: dir });
      } catch (err) {
        fail(t('capture.saveFailed'), err);
      } finally {
        done();
      }
    });
    const folder = h(
      'div',
      { class: 'cap-section' },
      h('div', { class: 'cap-section-title', role: 'heading', 'aria-level': '3' }, icon('folderOpen'), t('capture.folderTitle')),
      h('p', { class: 'cap-help' }, t('capture.folderHelp')),
      h('div', { class: 'row wrap' }, h('button', { class: 'btn sm', type: 'button', onclick: () => api.invoke('capture:openFolder', { kind: 'clip' }).catch((err) => fail(t('capture.openFailed'), err)) }, icon('folderOpen'), t('capture.openFolder'))),
      h(
        'div',
        { class: 'cap-copy' },
        h('div', { class: 'cap-copy-text' }, h('div', { class: 'tr-title' }, t('capture.copyTitle')), h('div', { class: 'tr-sub wrap-anywhere' }, c.copyTo || t('capture.copyNone'))),
        h('div', { class: 'row' }, copyBtn, c.copyTo ? h('button', { class: 'icon-btn sm', type: 'button', title: t('capture.copyRemove'), 'aria-label': t('capture.copyRemove'), onclick: () => save({ copyTo: '' }) }, icon('x')) : null),
      ),
      toggleRow('notify', t('capture.notify'), t('capture.notifySub'), c.notify !== false, (v) => save({ notify: v })),
    );
    mount(body, h('div', { class: 'cap-cols' }, h('div', { class: 'cap-col' }, replay, auto, quality), h('div', { class: 'cap-col' }, shortcuts, folder)));
    drawStatus();
    if (focusId) [...root.querySelectorAll('[data-cap-id]')].find((el) => el.dataset.capId === focusId)?.focus();
  }

  draw();
  offs.push(() => capturing?.off());
  offs.push(
    api.on('capture:state', (next) => {
      // Se redibuja si cambia algo que se ve en el panel (no el buffer, que va en la linea de estado)
      const shape = (s) => JSON.stringify([s?.settings, s?.shortcuts, s?.replaySeconds, s?.diskEstimate, s?.diskOk, s?.diskSaveOk, s?.plan, s?.degraded, s?.preset, s?.live && [s.live.width, s.live.height, s.live.codec, Math.round((s.live.fps || 0) / 5), Math.round((s.live.delivered || 0) / 5)]]);
      const redraw = shape(next) !== shape(st);
      st = next;
      if (isDisposed()) return;
      if (redraw && !capturing) draw();
      else drawStatus();
    }),
  );
}
