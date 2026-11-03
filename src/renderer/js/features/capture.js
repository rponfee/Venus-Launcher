// Clips y capturas en toda la interfaz: avisos al guardar (con "Ver"), logros first_screenshot / first_clip, el
// plan (Venus Premium = repeticion de 5 minutos), la señal 'media-share' de un amigo (aviso con "Ver") y el panel de
// Ajustes: atajos, repeticion instantanea, clips automaticos, calidad, fps, audio, avisos y carpeta.
// Contrato: startup() (idempotente), capturePanel() -> Element (con .destroy()).
// Canales: capture:status, capture:setPremium, capture:testShortcut, capture:openFolder; eventos capture:saved,
// capture:state y capture:notice.
import { h, icon, mount, ok, fail, toast, ensureCss, loading, switchEl, setBusy, fmtBytes, modal } from '../ui.js';
import { store, api } from '../store.js';
import { t, loadNs } from '../i18n.js';
import { navigate } from '../app.js';
import { cloud } from '../cloud.js';

const NS = 'capture';
const ACTIONS = ['replay', 'record', 'screenshot'];
const QUALITIES = ['720p', '1080p', 'native'];
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

// ---------- Plan (repeticion de 5 minutos con Venus Premium) ----------

async function syncPremium() {
  let premium = null;
  try {
    premium = await import('./premium.js');
  } catch {
    premium = null; // todavia no existe: la repeticion queda en 60 s
  }
  const push = (v) => api.invoke('capture:setPremium', v === true).catch(() => {});
  if (typeof premium?.isPremium !== 'function') return;
  try {
    push(await premium.isPremium());
  } catch {
    push(false);
  }
  if (typeof premium.onPremiumChange === 'function') premium.onPremiumChange((v) => push(v));
}

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
  syncPremium();
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
    if (st.recording?.active) {
      text = t('capture.statusRecording');
      cls = 'bad';
    } else if (st.game && st.replay?.error) {
      text = t('capture.statusReplayNoDisk');
      cls = 'warn';
    } else if (st.game) text = st.replay?.active ? t('capture.statusReplayDisk', { seconds: st.replay.buffered, max: st.replaySeconds, disk: fmtBytes(st.replay.disk || 0) }) : t('capture.statusGame');
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
      h('div', { class: 'cap-sc-label' }, h('div', { class: 'tr-title' }, t(`capture.action_${action}`)), h('div', { class: 'tr-sub' }, t(`capture.action_${action}Sub`, { seconds: st?.replaySeconds || 60 }))),
      keys,
      h('div', { class: 'cap-sc-actions' }, change, clear),
      warn,
      err,
    );
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
      rows.push(
        h('div', { class: 'cap-field' }, h('span', { class: 'cap-label' }, t('capture.autoLength')), segmented(t('capture.autoLength'), AUTO_LENGTHS.filter((s) => s <= maxSeconds).map((s) => ({ value: s, label: seconds(s) })), Math.min(a.seconds || 60, maxSeconds), (v) => save({ auto: { seconds: Number(v) } }))),
        h('div', { class: 'cap-field' }, h('span', { class: 'cap-label' }, t('capture.autoCooldown')), segmented(t('capture.autoCooldown'), AUTO_COOLDOWNS.map((s) => ({ value: s, label: seconds(s) })), a.cooldown, (v) => save({ auto: { cooldown: Number(v) } }))),
        h('div', { class: 'cap-field' }, h('span', { class: 'cap-label' }, t('capture.autoLimit')), segmented(t('capture.autoLimit'), AUTO_LIMITS.map((n) => ({ value: n, label: String(n) })), a.maxPerSession, (v) => save({ auto: { maxPerSession: Number(v) } }))),
        h('p', { class: 'cap-help' }, t('capture.autoHelp')),
      );
    }
    return h('div', { class: 'cap-section' }, h('div', { class: 'cap-section-title', role: 'heading', 'aria-level': '3' }, icon('sparkles'), t('capture.autoTitle')), master, rows);
  }

  function draw() {
    if (isDisposed()) return;
    // El foco vuelve al mismo control despues de redibujar
    const focusId = root.contains(document.activeElement) ? document.activeElement.dataset?.capId : null;
    capturing?.off();
    capturing = null;
    const c = cfg();
    const seconds = st?.replaySeconds || 60;
    const premiumNote = st?.premium
      ? h('p', { class: 'cap-note good' }, icon('crown'), h('span', {}, t('capture.premiumOnLong')))
      : h('p', { class: 'cap-note' }, icon('crown'), h('span', {}, t('capture.premiumOffLong')), h('button', { class: 'btn sm ghost', type: 'button', onclick: () => navigate('settings/plan') }, t('capture.seePlans')));
    const replay = h(
      'div',
      { class: 'cap-section' },
      h('div', { class: 'cap-section-title', role: 'heading', 'aria-level': '3' }, icon('history'), t('capture.replayTitle')),
      toggleRow('replay', t('capture.replayEnable'), t('capture.replayDiskSub', { seconds, disk: fmtBytes(st?.diskEstimate || 0) }), Boolean(c.replay), (v) => save({ replay: v })),
      premiumNote,
    );
    const auto = autoSection(c, seconds);
    const quality = h(
      'div',
      { class: 'cap-section' },
      h('div', { class: 'cap-section-title', role: 'heading', 'aria-level': '3' }, icon('monitor'), t('capture.qualityTitle')),
      h('div', { class: 'cap-field' }, h('span', { class: 'cap-label' }, t('capture.resolution')), segmented(t('capture.resolution'), QUALITIES.map((q) => ({ value: q, label: t(`capture.quality_${q}`) })), c.quality, (v) => save({ quality: v }))),
      h('div', { class: 'cap-field' }, h('span', { class: 'cap-label' }, t('capture.fps')), segmented(t('capture.fps'), [30, 60].map((f) => ({ value: f, label: t('capture.fpsValue', { fps: f }) })), c.fps, (v) => save({ fps: Number(v) }))),
      h('p', { class: 'cap-help' }, t('capture.qualityHelp')),
      toggleRow('audio', t('capture.audio'), t('capture.audioSub'), c.audio !== false, (v) => save({ audio: v })),
    );
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
      const shape = (s) => JSON.stringify([s?.settings, s?.premium, s?.shortcuts, s?.replaySeconds]);
      const redraw = shape(next) !== shape(st);
      st = next;
      if (isDisposed()) return;
      if (redraw && !capturing) draw();
      else drawStatus();
    }),
  );
}
