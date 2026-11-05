// Overlay dentro del juego (lado de la interfaz).
//   startup()       -> empuja al overlay el Voice Chat (como mucho 5 veces por segundo y solo si cambio algo), los
//                      mensajes entrantes, invitaciones y solicitudes de amistad y el color de acento. Idempotente.
//                      Solo empuja mientras el overlay esta activo (overlay:state). Las capturas y la musica las
//                      avisan capture.js y nowplaying.js desde el proceso principal (respetan sus propios ajustes).
//   overlayPanel()  -> Element con .destroy(): tarjeta de Ajustes (activar, estado, cada widget con su vista previa en vivo:
//                      se arrastra, se elige, se apaga, se achica; "Restablecer" por widget y de todos; "Editar posiciones
//                      en el juego", atajos que no pisan a Minecraft ni a las capturas y "Probar overlay").
// Canales: overlay:push/status/edit/test/reset/setShortcut/setPanelShortcut/accent y eventos overlay:state y overlay:config
// (src/main/modules/overlay.js). La pagina del overlay y la vista previa comparten js/overlay/widgets.js.
import { h, icon, mount, ok, fail, ensureCss, loading, switchEl, setBusy, reducedMotion, avatarUrl, confirmDialog } from '../ui.js';
import { store, api } from '../store.js';
import { t, loadNs } from '../i18n.js';
import { OverlayView, WIDGETS } from '../overlay/widgets.js';
import { ANCHORS } from '../overlay/layout.js';
import { createLimiter, createChangeGate, voiceSnapshot, accelFromKey, accelParts } from '../overlay/logic.js';

const NS = 'overlay';
const STAGE = { width: 960, height: 540 }; // tamano virtual del juego en la vista previa
const WIDGET_ICON = { voice: 'mic', messages: 'message', alerts: 'bell', captures: 'camera', music: 'music', perf: 'activity', counters: 'target' };
const DURATIONS = [3, 4, 5, 6, 8, 10, 12, 15, 20, 30];
const PERF_METRICS = ['fps', 'ram', 'cpu', 'ping', 'session']; // widget de rendimiento (3.1), overlay/config.js
const COUNTER_METRICS = ['deaths', 'mined', 'session']; // contadores en pantalla, overlay/config.js
const PANELS = ['recipes', 'assistant']; // paneles del modo interactivo, overlay/config.js
let readyPromise = null;
let panelSeq = 0;

const isMissing = (err) => /No handler registered/i.test(err?.message || '');

// Por que no se pudo guardar un atajo, en palabras (codigos de overlay:setShortcut y overlay:setPanelShortcut)
function shortcutError(r) {
  switch (r?.code) {
    case 'invalid':
      return t('overlay.shortcutInvalid');
    case 'minecraft':
      return t('overlay.shortcutMinecraft');
    case 'system':
      return t('overlay.shortcutSystem');
    case 'altgr':
      return t('overlay.shortcutAltgr');
    case 'venus':
      return t('overlay.shortcutVenus', { who: t(`overlay.shortcutWho_${['voice', 'capture', 'music', 'overlay'].includes(r.who) ? r.who : 'overlay'}`) });
    default:
      return t('overlay.shortcutTaken');
  }
}

function prepare() {
  ensureCss('overlay');
  ensureCss('features/overlay');
  if (!readyPromise) readyPromise = loadNs(NS).catch((err) => console.warn('[overlay] textos', err));
  return readyPromise;
}

async function accent() {
  try {
    return (await import('../appearance.js')).accentColor();
  } catch {
    return '#f29a2e';
  }
}

// =====================================================================
// Arranque: lo que la interfaz sabe y el proceso principal no (voz, mensajes)
// =====================================================================
let started = false;
let missing = false;
let active = false;
let voiceLimiter = null;
const voiceGate = createChangeGate();

function push(ev) {
  if (missing) return;
  api.invoke('overlay:push', ev).catch((err) => {
    if (isMissing(err)) missing = true;
    else console.warn('[overlay] push', err?.message || err);
  });
}

function setActive(next) {
  const was = active;
  active = Boolean(next);
  // Al activarse (se abrio el juego, una prueba o el modo edicion) se manda enseguida el estado actual.
  if (active && !was) {
    voiceGate.reset();
    voiceLimiter?.mark();
  }
}

export function startup() {
  if (started) return;
  started = true;
  // Solo los textos (los avisos que arma la interfaz); el CSS se carga al abrir la tarjeta de Ajustes.
  if (!readyPromise) readyPromise = loadNs(NS).catch((err) => console.warn('[overlay] textos', err));
  api.on('overlay:state', (s) => setActive(s?.active));
  api
    .invoke('overlay:status')
    .then((s) => setActive(s?.active))
    .catch((err) => {
      if (isMissing(err)) missing = true;
    });
  hookVoice();
  hookSocial();
  hookAccent();
}

// Avatar de la sala o de un perfil -> URL (sin las cabezas de Minecraft activadas, la inicial del nombre).
function headUrl(id) {
  if (!id) return null;
  const url = avatarUrl(id, 32);
  return url && !url.startsWith('assets/') ? url : null;
}

async function hookVoice() {
  let voice;
  try {
    ({ voice } = await import('../voice.js'));
  } catch {
    return;
  }
  voiceLimiter = createLimiter({
    interval: 200,
    flush: () => {
      if (!active || missing) return;
      const snap = voiceSnapshot({ room: voice.room, members: voice.members, state: voice.state }, { avatarUrl: headUrl });
      if (voiceGate.changed(snap)) push(snap);
    },
  });
  for (const evt of ['room', 'members', 'state', 'levels']) voice.on(evt, () => voiceLimiter.mark());
  voice.on('invite', (inv) => {
    if (!active || !inv?.name) return;
    push({ kind: 'alert', icon: 'party', title: t('overlay.voiceInviteTitle', { name: inv.name }), body: inv.room ? t('overlay.voiceInviteBody', { room: inv.room }) : null });
  });
}

async function hookSocial() {
  let social;
  let headId = null;
  try {
    ({ social } = await import('../social.js'));
  } catch {
    return;
  }
  try {
    ({ headId } = await import('../social/cosmetics.js'));
  } catch {
    headId = null;
  }
  const avatarOf = (userId) => {
    try {
      const p = social.profileOf?.(userId);
      return p && headId ? headUrl(headId(p)) : null;
    } catch {
      return null;
    }
  };
  social.on('message', (m) => {
    if (!active || !m?.text) return;
    // Si justo esta leyendo esa conversacion en el launcher, no hace falta avisar.
    if (document.hasFocus() && social.activeChat && social.activeChat === m.chatId) return;
    push({ kind: 'message', from: m.from, fromId: m.fromId || null, avatar: avatarOf(m.fromId), text: m.text, chatId: m.chatId || null });
  });
  let known = new Set((social.requests?.incoming || []).map((r) => r.friendshipId));
  social.on('requests', (r) => {
    const incoming = r?.incoming || [];
    const fresh = incoming.filter((x) => !known.has(x.friendshipId));
    known = new Set(incoming.map((x) => x.friendshipId));
    if (!active) return;
    for (const req of fresh.slice(0, 3)) push({ kind: 'alert', icon: 'friend', title: t('overlay.friendRequestTitle'), body: t('overlay.friendRequestBody', { name: req.name }) });
  });
}

async function hookAccent() {
  const send = async () => {
    if (missing) return;
    api.invoke('overlay:accent', await accent()).catch(() => {});
  };
  send();
  try {
    (await import('../appearance.js')).onAppearanceChange(() => send());
  } catch {
    /* sin apariencia: se queda el naranja de Venus */
  }
}

// =====================================================================
// Panel de Ajustes
// =====================================================================

// Eventos de ejemplo para "Probar overlay".
function sampleEvents() {
  return [
    { kind: 'alert', icon: 'achievement', title: t('overlay.testAlertTitle'), body: t('overlay.testAlertBody') },
    { kind: 'alert', icon: 'friend', title: t('overlay.testFriendTitle'), body: t('overlay.testFriendBody') },
    { kind: 'message', from: t('overlay.sampleFriend1'), text: t('overlay.testMessage') },
    {
      kind: 'voice',
      room: { name: t('overlay.sampleRoom'), code: 'VENUS' },
      self: { muted: false, deafened: false },
      members: [
        { id: 'test-me', name: t('overlay.sampleMe'), speaking: true, muted: false, deafened: false, self: true },
        { id: 'test-1', name: t('overlay.sampleFriend1'), speaking: false, muted: true, deafened: false },
        { id: 'test-2', name: t('overlay.sampleFriend2'), speaking: true, muted: false, deafened: false },
      ],
    },
    { kind: 'capture', type: 'screenshot' },
    { kind: 'music', state: { title: t('overlay.sampleSong'), artist: t('overlay.sampleArtist'), album: null, art: null, playing: true, position: 61000, duration: 215000, source: 'test', appName: 'Spotify' } },
    { kind: 'perf', fps: 144, ram: 2048, cpu: 23, ping: 48, session: 2694 },
    { kind: 'counters', deaths: 2, mined: 347, session: 2694 },
  ];
}

const deepClone = (o) => JSON.parse(JSON.stringify(o));
function merge(target, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object') merge(target[k], v);
    else target[k] = v;
  }
  return target;
}

/**
 * Tarjeta del overlay para Ajustes. Se limpia sola cuando sale del documento (o con el.destroy()).
 */
export function overlayPanel() {
  const root = h('section', { class: 'card ovp-panel', 'aria-busy': 'true' }, loading());
  const offs = [];
  let disposed = false;
  let seen = false;
  const born = Date.now();
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearInterval(watch);
    offs.splice(0).forEach((off) => {
      try {
        off();
      } catch {
        /* ya suelto */
      }
    });
  };
  const watch = setInterval(() => {
    if (root.isConnected) seen = true;
    else if (seen || Date.now() - born > 60000) dispose();
  }, 2000);
  root.destroy = dispose;
  prepare()
    .then(() => build(root, offs, () => disposed))
    .catch((err) => {
      if (disposed) return;
      console.error('[overlay]', err);
      mount(root, h('div', { class: 'notice bad' }, icon('alert'), h('div', {}, t('overlay.unavailable'))));
    })
    .finally(() => {
      if (!disposed) root.removeAttribute('aria-busy');
    });
  return root;
}

async function build(root, offs, isDisposed) {
  let status;
  try {
    status = await api.invoke('overlay:status');
  } catch (err) {
    if (isDisposed()) return;
    if (!isMissing(err)) console.warn('[overlay] estado', err);
    mount(root, h('div', { class: 'notice bad' }, icon('alert'), h('div', {}, t('overlay.unavailable'))));
    return;
  }
  if (isDisposed()) return;
  const uid = `ovp-${++panelSeq}`;
  let cfg = deepClone(status.config);
  const accentNow = await accent();

  // Guarda un parche en settings.overlay (el proceso principal lo normaliza y lo aplica al momento).
  let saving = Promise.resolve();
  const save = (patch) => {
    merge(cfg, deepClone(patch));
    refreshPreview();
    saving = saving
      .then(() => store.setSettings({ overlay: patch }))
      .catch((err) => {
        if (isDisposed()) return;
        fail(t('overlay.saveFailed'), err);
        resync();
      });
    return saving;
  };

  // ---------- Cabecera ----------
  const enable = switchEl(cfg.enabled, (v) => {
    save({ enabled: v });
    syncAll();
  }, t('overlay.enableAria'));
  const head = h(
    'div',
    { class: 'ovp-head' },
    h('div', { class: 'ovp-logo', 'aria-hidden': 'true' }, icon('layers')),
    h('div', { class: 'ovp-head-text' }, h('h3', { class: 'card-title' }, t('overlay.title')), h('p', { class: 'card-sub' }, t('overlay.subtitle'))),
    enable,
  );

  // ---------- Estado y acciones ----------
  const pill = h('span', { class: 'pill' });
  const statusText = h('span', { class: 'ovp-status-text' });
  const editBtn = h('button', { type: 'button', class: 'btn tonal sm', 'data-overlay-action': 'edit' }, icon('maximize'), h('span', {}, t('overlay.editInGame')));
  // Si guardar falla, lo que se ve en la tarjeta no es lo que quedo: se vuelve a leer del proceso principal
  const resync = async () => {
    try {
      const fresh = await api.invoke('overlay:status');
      if (isDisposed() || !fresh?.config) return;
      status = { ...status, ...fresh };
      cfg = deepClone(fresh.config);
      refreshPreview();
      syncAll();
    } catch {
      /* sin el proceso principal no hay nada que releer */
    }
  };
  const testBtn = h('button', { type: 'button', class: 'btn sm', 'data-overlay-action': 'test', title: t('overlay.testHint') }, icon('sparkles'), t('overlay.test'));
  const statusRow = h('div', { class: 'ovp-status' }, h('div', { class: 'ovp-status-main', role: 'status', 'aria-live': 'polite' }, pill, statusText), h('div', { class: 'ovp-actions' }, editBtn, testBtn));
  const fsNotice = h('div', { class: 'notice ovp-fs', hidden: true }, icon('alert'), h('div', {}, t('overlay.fullscreenNow')));
  const tip = h('p', { class: 'ovp-tip' }, icon('info'), h('span', {}, t('overlay.fullscreenTip')));

  editBtn.addEventListener('click', async () => {
    const done = setBusy(editBtn);
    try {
      status = await api.invoke('overlay:edit', !status.editing);
      drawStatus();
    } catch (err) {
      fail(t('overlay.editFailed'), err);
    } finally {
      done();
    }
  });
  testBtn.addEventListener('click', async () => {
    const done = setBusy(testBtn);
    try {
      status = await api.invoke('overlay:test', sampleEvents());
      drawStatus();
      ok(t('overlay.testStarted'), status.running ? t('overlay.testStartedGame') : t('overlay.testStartedScreen'));
    } catch (err) {
      fail(t('overlay.testFailed'), err);
    } finally {
      done();
    }
  });

  function drawStatus() {
    let kind = '';
    let text;
    let pillText = null;
    if (!status.supported) text = t('overlay.statusUnsupported');
    else if (status.editing) {
      kind = 'info';
      text = t('overlay.statusEditing');
    } else if (!status.enabled) text = t('overlay.statusOff');
    else if (status.pageFailed) {
      kind = 'bad';
      pillText = t('overlay.pillError');
      text = t('overlay.statusPageFailed');
    } else if (!status.running) text = t('overlay.statusWaiting');
    else if (status.tracker === 'failed') {
      kind = 'bad';
      pillText = t('overlay.pillError');
      text = t('overlay.statusTrackerFailed');
    } else if (!status.found) {
      kind = 'warn';
      pillText = t('overlay.pillSearching');
      text = t('overlay.statusSearching');
    } else if (status.hidden) {
      kind = 'warn';
      text = t('overlay.statusHidden', { shortcut: accelParts(status.shortcut).join('+') });
    } else if (status.minimized) text = t('overlay.statusMinimized');
    else if (!status.visible) text = t('overlay.statusBackground');
    else {
      kind = 'good';
      text = t('overlay.statusActive');
    }
    pill.className = `pill ${kind}`.trim();
    pill.textContent = pillText || (kind === 'good' ? t('overlay.pillOn') : kind === 'info' ? t('overlay.pillEditing') : status.enabled ? t('overlay.pillReady') : t('overlay.pillOff'));
    statusText.textContent = text;
    editBtn.querySelector('span').textContent = status.editing ? t('overlay.editStop') : t('overlay.editInGame');
    editBtn.classList.toggle('active', Boolean(status.editing));
    editBtn.setAttribute('aria-pressed', String(Boolean(status.editing)));
    fsNotice.hidden = !(status.running && status.fullscreen);
    shortcutWarn.hidden = status.shortcutOk !== false;
    shortcutRisk.hidden = !status.shortcutIssue;
    if (status.shortcutIssue) shortcutRisk.querySelector('span').textContent = shortcutError({ code: status.shortcutIssue });
    panelRows.forEach((r) => {
      r.warn(status.panelShortcutsOk?.[r.id] === false);
      r.risk(status.panelShortcutIssues?.[r.id] ? shortcutError({ code: status.panelShortcutIssues[r.id] }) : '');
    });
  }

  // ---------- Vista previa ----------
  const viewRoot = h('div', { class: 'ovp-stage-view' });
  const screen = h(
    'div',
    { class: 'ovp-screen' },
    h('div', { class: 'ovp-fake', 'aria-hidden': 'true' }, h('span', { class: 'ovp-fake-cross' }), h('span', { class: 'ovp-fake-bar' }, Array.from({ length: 9 }, (_, i) => h('i', { class: i === 0 ? 'on' : '' })))),
    viewRoot,
  );
  const previewBox = h('div', { class: 'ovp-preview', role: 'group', 'aria-label': t('overlay.previewTitle') }, screen);
  const view = new OverlayView(viewRoot, {
    tr: (k, v) => t(`overlay.${k}`, v),
    preview: true,
    isReduced: reducedMotion,
    onMove: (id, pos) => {
      save({ widgets: { [id]: pos } });
      blocks[id]?.sync();
    },
    // Teclas sobre un widget de la vista previa: + y -, [ y ], Supr
    onTweak: (id, patch) => {
      save({ widgets: { [id]: patch } });
      blocks[id]?.sync();
    },
    // Tocar un widget en la vista previa abre sus opciones
    onSelect: (id) => blocks[id]?.reveal(),
  });
  offs.push(() => view.destroy());
  function refreshPreview() {
    view.setLayout({ widgets: cfg.widgets, accent: accentNow, motion: 'auto', editing: false, mode: 'game' });
  }
  // La vista previa es el juego de 960x540 achicado para entrar en el ancho de la tarjeta.
  const fit = () => {
    const w = previewBox.clientWidth;
    if (!w) return;
    const s = w / STAGE.width;
    screen.style.setProperty('--ovp-scale', String(s));
    previewBox.style.height = `${Math.round(STAGE.height * s)}px`;
  };
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(fit);
    ro.observe(previewBox);
    offs.push(() => ro.disconnect());
  }
  const resetBtn = h('button', { type: 'button', class: 'btn ghost sm', 'data-overlay-action': 'reset', title: t('overlay.resetPositionsHint') }, icon('undo'), t('overlay.resetPositions'));
  resetBtn.addEventListener('click', async () => {
    const done = setBusy(resetBtn);
    try {
      status = await api.invoke('overlay:reset');
      if (status?.config) cfg = deepClone(status.config);
      refreshPreview();
      syncAll();
    } catch (err) {
      fail(t('overlay.saveFailed'), err);
    } finally {
      done();
    }
  });
  const previewCol = h(
    'div',
    { class: 'ovp-preview-col' },
    h('div', { class: 'ovp-sec-head' }, h('div', { class: 'ovp-sec-title' }, t('overlay.previewTitle')), resetBtn),
    previewBox,
    h('p', { class: 'ovp-help' }, t('overlay.previewHint')),
    h('p', { class: 'ovp-help ovp-keys-help' }, icon('keyboard'), h('span', {}, t('overlay.previewKeys'))),
  );

  // ---------- Atajo ----------
  const keys = h('span', { class: 'ovp-keys' });
  const shortcutMsg = h('div', { class: 'ovp-help', id: `${uid}-sc-help`, role: 'status', 'aria-live': 'polite' }, t('overlay.shortcutHint'));
  const shortcutWarn = h('div', { class: 'field-error', hidden: true }, icon('alert'), h('span', {}, t('overlay.shortcutTakenNow')));
  // Un atajo que ya estaba guardado y le saca teclas a Minecraft o a Windows (de antes de estos controles): se avisa
  const shortcutRisk = h('div', { class: 'field-error', hidden: true }, icon('alert'), h('span', {}));
  const changeBtn = h('button', { type: 'button', class: 'btn sm', 'data-overlay-action': 'shortcut', 'aria-describedby': `${uid}-sc-help` }, icon('keyboard'), h('span', {}, t('overlay.shortcutChange')));
  const removeBtn = h('button', { type: 'button', class: 'btn ghost sm', 'data-overlay-action': 'shortcut-remove' }, icon('x'), t('overlay.shortcutRemove'));
  let capturing = false;
  const drawKeys = () => {
    const parts = accelParts(cfg.shortcut);
    mount(keys, parts.length ? parts.map((p) => h('span', { class: 'kbd' }, p)) : h('span', { class: 'muted' }, t('overlay.shortcutNone')));
    removeBtn.hidden = !parts.length;
  };
  const stopCapture = () => {
    capturing = false;
    changeBtn.classList.remove('active');
    changeBtn.querySelector('span').textContent = t('overlay.shortcutChange');
  };
  const applyShortcut = async (accel) => {
    try {
      const r = await api.invoke('overlay:setShortcut', accel);
      if (r?.ok) {
        cfg.shortcut = r.shortcut;
        shortcutMsg.textContent = r.shortcut ? t('overlay.shortcutSaved', { shortcut: accelParts(r.shortcut).join('+') }) : t('overlay.shortcutRemoved');
        status = { ...status, shortcut: r.shortcut, shortcutOk: true };
        drawStatus();
      } else shortcutMsg.textContent = shortcutError(r);
    } catch (err) {
      fail(t('overlay.saveFailed'), err);
    }
    drawKeys();
  };
  changeBtn.addEventListener('click', () => {
    if (capturing) {
      stopCapture();
      shortcutMsg.textContent = t('overlay.shortcutHint');
      return;
    }
    capturing = true;
    changeBtn.classList.add('active');
    changeBtn.querySelector('span').textContent = t('overlay.shortcutPress');
    shortcutMsg.textContent = t('overlay.shortcutPressHint');
  });
  changeBtn.addEventListener('keydown', (e) => {
    if (!capturing) return;
    if (e.key === 'Tab') return stopCapture();
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      stopCapture();
      shortcutMsg.textContent = t('overlay.shortcutHint');
      return;
    }
    if (['Control', 'Alt', 'Shift', 'Meta', 'AltGraph'].includes(e.key)) return;
    const accel = accelFromKey(e);
    if (!accel) {
      shortcutMsg.textContent = t('overlay.shortcutInvalid');
      return;
    }
    stopCapture();
    applyShortcut(accel);
  });
  changeBtn.addEventListener('blur', () => capturing && stopCapture());
  removeBtn.addEventListener('click', () => applyShortcut(''));
  // Atajos de los paneles (recetas y asistente): se prueban igual que el de arriba, con su propio canal.
  const panelRows = PANELS.map((id) => panelShortcutRow(id, { uid, get: () => cfg.panelShortcuts?.[id] || '', put: (v) => { cfg.panelShortcuts = { ...cfg.panelShortcuts, [id]: v }; } }));
  const shortcutCol = h(
    'div',
    { class: 'ovp-shortcut' },
    h('div', { class: 'ovp-sec-title' }, t('overlay.shortcutTitle')),
    h('div', { class: 'ovp-keys-row' }, keys, changeBtn, removeBtn),
    shortcutMsg,
    shortcutWarn,
    shortcutRisk,
    h('div', { class: 'ovp-sec-title ovp-mt' }, t('overlay.panelsTitle')),
    h('p', { class: 'ovp-help' }, t('overlay.panelsHint')),
    panelRows.map((r) => r.el),
    h('div', { class: 'ovp-sec-title ovp-mt' }, t('overlay.editTitleCard')),
    h('p', { class: 'ovp-help' }, t('overlay.editInGameHint')),
  );

  // ---------- Widgets ----------
  const blocks = {};
  const list = h('div', { class: 'ovp-widgets' });
  // Lo de fabrica de cada widget sale del proceso principal (status.defaults); apagar o prender no se toca al restablecer
  const factory = (id) => {
    const d = deepClone(status.defaults?.widgets?.[id] || {});
    delete d.enabled;
    return d;
  };
  for (const id of WIDGETS) {
    blocks[id] = widgetBlock(id, {
      uid,
      cfg: () => cfg,
      save,
      preview: () => refreshPreview(),
      factory,
      onOpen: (open) => view.select(open ? id : null),
      onReveal: () => {
        for (const other of WIDGETS) if (other !== id) blocks[other].close();
      },
    });
    list.append(blocks[id].el);
  }
  const resetAllBtn = h('button', { type: 'button', class: 'btn ghost sm', 'data-overlay-action': 'reset-all', title: t('overlay.resetAllHint') }, icon('undo'), t('overlay.resetAll'));
  resetAllBtn.addEventListener('click', async () => {
    if (!(await confirmDialog(t('overlay.resetAllTitle'), t('overlay.resetAllText'), { okText: t('overlay.resetAllOk'), danger: true }))) return;
    await save({ widgets: Object.fromEntries(WIDGETS.map((id) => [id, factory(id)])) });
    syncAll();
    ok(t('overlay.resetAllDone'));
  });

  function syncAll() {
    enable.querySelector('input').checked = cfg.enabled;
    root.classList.toggle('ovp-off', !cfg.enabled);
    WIDGETS.forEach((id) => blocks[id].sync());
    drawKeys();
    panelRows.forEach((r) => r.sync());
  }

  mount(
    root,
    head,
    statusRow,
    fsNotice,
    h('div', { class: 'ovp-grid' }, previewCol, shortcutCol),
    h('div', { class: 'ovp-sec-head ovp-mt' }, h('div', { class: 'ovp-sec-title' }, t('overlay.widgetsTitle')), resetAllBtn),
    list,
    tip,
  );
  fit();
  refreshPreview();
  syncAll();
  drawStatus();

  offs.push(
    api.on('overlay:state', (s) => {
      if (isDisposed() || !s) return;
      status = { ...status, ...s };
      drawStatus();
    }),
  );
  // Cambios que vienen de otro lado (modo edicion en el juego, otra ventana de Ajustes).
  offs.push(
    api.on('overlay:config', (next) => {
      if (isDisposed() || !next || JSON.stringify(next) === JSON.stringify(cfg)) return;
      cfg = deepClone(next);
      refreshPreview();
      syncAll();
    }),
  );
}

// Atajo de un panel: las teclas, Cambiar y Quitar. Lo guarda el proceso principal si se puede registrar.
function panelShortcutRow(id, { uid, get, put }) {
  const name = t(`overlay.panelName_${id}`);
  const keys = h('span', { class: 'ovp-keys' });
  const helpId = `${uid}-psc-${id}`;
  const msg = h('div', { class: 'ovp-help', id: helpId, role: 'status', 'aria-live': 'polite' });
  const label = h('span', {}, t('overlay.shortcutChange'));
  const change = h('button', { type: 'button', class: 'btn sm', 'aria-label': t('overlay.panelChangeAria', { name }), 'aria-describedby': helpId, dataset: { overlayAction: `panel-shortcut-${id}` } }, icon('keyboard'), label);
  const remove = h('button', { type: 'button', class: 'btn ghost sm', 'aria-label': t('overlay.panelRemoveAria', { name }) }, icon('x'), t('overlay.shortcutRemove'));
  let capturing = false;
  const sync = () => {
    const parts = accelParts(get());
    mount(keys, parts.length ? parts.map((p) => h('span', { class: 'kbd' }, p)) : h('span', { class: 'muted' }, t('overlay.shortcutNone')));
    remove.hidden = !parts.length;
  };
  const stop = () => {
    capturing = false;
    change.classList.remove('active');
    label.textContent = t('overlay.shortcutChange');
  };
  const apply = async (accel) => {
    try {
      const r = await api.invoke('overlay:setPanelShortcut', id, accel);
      if (r?.ok) {
        put(r.shortcut);
        msg.textContent = r.shortcut ? t('overlay.shortcutSaved', { shortcut: accelParts(r.shortcut).join('+') }) : t('overlay.shortcutRemoved');
      } else msg.textContent = shortcutError(r);
    } catch (err) {
      fail(t('overlay.saveFailed'), err);
    }
    sync();
  };
  change.addEventListener('click', () => {
    if (capturing) {
      stop();
      msg.textContent = '';
      return;
    }
    capturing = true;
    change.classList.add('active');
    label.textContent = t('overlay.shortcutPress');
    msg.textContent = t('overlay.shortcutPressHint');
  });
  change.addEventListener('keydown', (e) => {
    if (!capturing) return;
    if (e.key === 'Tab') return stop();
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      stop();
      msg.textContent = '';
      return;
    }
    if (['Control', 'Alt', 'Shift', 'Meta', 'AltGraph'].includes(e.key)) return;
    const accel = accelFromKey(e);
    if (!accel) {
      msg.textContent = t('overlay.shortcutInvalid');
      return;
    }
    stop();
    apply(accel);
  });
  change.addEventListener('blur', () => capturing && stop());
  remove.addEventListener('click', () => apply(''));
  // El juego no pudo tomar el atajo (lo tiene otra aplicacion): se avisa aparte del mensaje de la ultima vez que se cambio
  const warnLine = h('div', { class: 'field-error', hidden: true }, icon('alert'), h('span', {}, t('overlay.panelShortcutTakenNow', { name })));
  const riskLine = h('div', { class: 'field-error', hidden: true }, icon('alert'), h('span', {}));
  sync();
  return {
    id,
    el: h('div', { class: 'ovp-panel-key' }, h('div', { class: 'ovp-keys-row' }, h('span', { class: 'ovp-panel-name' }, name), keys, change, remove), msg, warnLine, riskLine),
    sync,
    warn: (on) => {
      warnLine.hidden = !on;
    },
    risk: (text) => {
      riskLine.hidden = !text;
      riskLine.querySelector('span').textContent = text;
    },
  };
}

// Un widget: encabezado con interruptor y, al abrirlo, posicion, tamano, opacidad, tema y lo propio de cada uno.
function widgetBlock(id, { uid, cfg, save, preview, factory, onOpen, onReveal }) {
  const w = () => cfg().widgets[id];
  const set = (patch) => save({ widgets: { [id]: patch } });
  const name = t(`overlay.w_${id}`);
  const bodyId = `${uid}-${id}`;
  const summary = h('span', { class: 'ovp-w-sub' });
  const sw = switchEl(w().enabled, (v) => {
    set({ enabled: v });
    sync();
  }, t('overlay.widgetEnableAria', { name }));
  const expand = h('button', { type: 'button', class: 'icon-btn sm ovp-expand', 'aria-expanded': 'false', 'aria-controls': bodyId, title: t('overlay.customize', { name }), 'aria-label': t('overlay.customize', { name }) }, icon('chevronDown'));
  const body = h('div', { class: 'ovp-w-body', id: bodyId, hidden: true });
  const el = h('div', { class: 'ovp-w', dataset: { widget: id } }, h('div', { class: 'ovp-w-head' }, h('span', { class: 'ovp-w-icon' }, icon(WIDGET_ICON[id])), h('div', { class: 'ovp-w-text' }, h('div', { class: 'ovp-w-name' }, name), summary), sw, expand), body);
  const setOpen = (open) => {
    body.hidden = !open;
    expand.setAttribute('aria-expanded', String(open));
    el.classList.toggle('open', open);
  };
  expand.addEventListener('click', () => {
    const open = body.hidden;
    setOpen(open);
    onOpen?.(open);
  });
  // Restablecer este widget: posicion, tamano, opacidad, tema y opciones; si esta prendido o apagado no se toca
  const resetBtn = h('button', { type: 'button', class: 'btn ghost sm', 'data-overlay-action': `reset-${id}`, title: t('overlay.resetWidgetHint') }, icon('undo'), t('overlay.resetWidget'));
  resetBtn.addEventListener('click', async () => {
    await save({ widgets: { [id]: factory(id) } });
    sync();
  });

  // Posicion: grilla de 3x3 (radiogroup con flechas). Si quedo en una posicion libre, ninguna celda marcada.
  const cells = ANCHORS.map((a) =>
    h('button', { type: 'button', class: 'ovp-cell', role: 'radio', 'aria-label': t(`overlay.anchor_${a}`), title: t(`overlay.anchor_${a}`), dataset: { anchor: a }, onclick: () => pickAnchor(a) }, h('span', {})),
  );
  const grid = h('div', { class: 'ovp-anchor-grid', role: 'radiogroup', 'aria-label': t('overlay.position') }, cells);
  grid.addEventListener('keydown', (e) => {
    const i = cells.indexOf(document.activeElement);
    if (i < 0) return;
    const move = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -3, ArrowDown: 3 }[e.key];
    if (move === undefined) return;
    e.preventDefault();
    const j = Math.min(8, Math.max(0, i + move));
    cells[j].focus();
    pickAnchor(ANCHORS[j]);
  });
  const freeNote = h('span', { class: 'ovp-free-note' });
  function pickAnchor(a) {
    set({ anchor: a });
    sync();
  }

  const range = (label, min, max, step, get, put, fmt) => {
    const out = h('output', { class: 'ovp-range-val' });
    const input = h('input', { type: 'range', class: 'range', min, max, step, 'aria-label': label });
    input.addEventListener('input', () => {
      out.textContent = fmt(Number(input.value));
      put(Number(input.value), false);
    });
    input.addEventListener('change', () => put(Number(input.value), true));
    return { el: h('label', { class: 'ovp-field' }, h('span', { class: 'ovp-label' }, label), h('span', { class: 'ovp-range' }, input, out)), sync: () => { input.value = get(); out.textContent = fmt(get()); } };
  };
  // Mientras se arrastra el deslizador solo cambia la vista previa; al soltarlo se guarda.
  const live = (key, toCfg) => (v, final) => {
    if (final) set({ [key]: toCfg(v) });
    else {
      w()[key] = toCfg(v);
      preview();
    }
  };
  const scale = range(t('overlay.scale'), 60, 160, 5, () => Math.round(w().scale * 100), live('scale', (v) => v / 100), (v) => `${v} %`);
  const opacity = range(t('overlay.opacity'), 30, 100, 5, () => Math.round(w().opacity * 100), live('opacity', (v) => v / 100), (v) => `${v} %`);

  const segmented = (label, options, get, put) => {
    const buttons = options.map(([value, text]) => h('button', { type: 'button', dataset: { value }, onclick: () => { put(value); sync(); } }, text));
    return { el: h('div', { class: 'ovp-field' }, h('span', { class: 'ovp-label' }, label), h('div', { class: 'segmented', role: 'group', 'aria-label': label }, buttons)), sync: () => buttons.forEach((b) => { const on = b.dataset.value === get(); b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on)); }) };
  };
  const theme = segmented(t('overlay.theme'), [['dark', t('overlay.themeDark')], ['light', t('overlay.themeLight')], ['accent', t('overlay.themeAccent')]], () => w().theme, (v) => set({ theme: v }));

  const extras = [];
  if (id === 'voice') extras.push(segmented(t('overlay.voiceShow'), [['all', t('overlay.voiceShowAll')], ['speaking', t('overlay.voiceShowSpeaking')]], () => w().show, (v) => set({ show: v })));
  if (id === 'music') extras.push(segmented(t('overlay.musicShow'), [['always', t('overlay.musicAlways')], ['change', t('overlay.musicChange')]], () => w().show, (v) => set({ show: v })));
  if ('duration' in w()) {
    const sel = h('select', { class: 'select', 'aria-label': t('overlay.duration') }, DURATIONS.map((s) => h('option', { value: s }, t('overlay.seconds', { count: s }))));
    sel.addEventListener('change', () => set({ duration: Number(sel.value) }));
    extras.push({ el: h('label', { class: 'ovp-field' }, h('span', { class: 'ovp-label' }, t('overlay.duration')), sel), sync: () => { sel.value = String(w().duration); } });
  }
  const toggles = [];
  const toggle = (title, sub, get, put) => {
    const s = switchEl(get(), (v) => put(v), title);
    toggles.push({ el: h('div', { class: 'toggle-row ovp-toggle' }, h('div', { class: 'tr-text' }, h('div', { class: 'tr-title' }, title), sub ? h('div', { class: 'tr-sub' }, sub) : null), s), sync: () => { s.querySelector('input').checked = get(); } });
  };
  if (id === 'messages') toggle(t('overlay.msgHide'), t('overlay.msgHideSub'), () => w().hideContent, (v) => set({ hideContent: v }));
  if (id === 'alerts') {
    for (const g of ['launcher', 'friends', 'servers', 'rewards']) {
      const key = `alert${g.charAt(0).toUpperCase()}${g.slice(1)}`;
      toggle(t(`overlay.${key}`), t(`overlay.${key}Sub`), () => w().filter[g], (v) => set({ filter: { [g]: v } }));
    }
  }
  // Rendimiento (3.1) y contadores: que medidas mostrar. Los FPS solo se saben con el mod Venus Badge.
  if (id === 'perf' || id === 'counters') {
    const prefix = id === 'perf' ? 'perfShow' : 'countersShow';
    for (const m of id === 'perf' ? PERF_METRICS : COUNTER_METRICS) {
      const key = `${prefix}${m.charAt(0).toUpperCase()}${m.slice(1)}`;
      toggle(t(`overlay.${key}`), t(`overlay.${key}Sub`), () => w().show?.[m] !== false, (v) => set({ show: { [m]: v } }));
    }
  }
  const togglesLabel = id === 'alerts' ? t('overlay.alertsFilter') : id === 'perf' || id === 'counters' ? t('overlay.perfShow') : null;

  mount(
    body,
    h('div', { class: 'ovp-w-grid' }, h('div', { class: 'ovp-field' }, h('span', { class: 'ovp-label' }, t('overlay.position')), h('div', { class: 'ovp-anchor-row' }, grid, freeNote)), h('div', { class: 'ovp-w-controls' }, scale.el, opacity.el, theme.el, ...extras.map((x) => x.el))),
    toggles.length ? h('div', { class: 'ovp-toggles' }, togglesLabel ? h('div', { class: 'ovp-label' }, togglesLabel) : null, toggles.map((x) => x.el)) : null,
    id === 'perf' ? h('p', { class: 'ovp-tip', title: t('overlay.perfNoFps') }, icon('info'), h('span', {}, t('overlay.perfNoFps'))) : null,
    id === 'counters' ? h('p', { class: 'ovp-tip' }, icon('info'), h('span', {}, t('overlay.countersHint'))) : null,
    id === 'counters' ? h('p', { class: 'ovp-tip' }, icon('info'), h('span', {}, t('overlay.countersHintMp'))) : null,
    h('div', { class: 'ovp-w-foot' }, resetBtn),
  );

  function sync() {
    const c = w();
    sw.querySelector('input').checked = c.enabled;
    el.classList.toggle('disabled', !c.enabled);
    const where = c.anchor === 'free' ? t('overlay.anchor_free') : t(`overlay.anchor_${c.anchor}`);
    summary.textContent = c.enabled ? t('overlay.widgetSummary', { position: where, scale: Math.round(c.scale * 100), opacity: Math.round(c.opacity * 100) }) : t('overlay.widgetOff');
    for (const b of cells) {
      const on = b.dataset.anchor === c.anchor;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on || (c.anchor === 'free' && b.dataset.anchor === 'tl') ? 0 : -1;
      b.classList.toggle('active', on);
    }
    freeNote.textContent = c.anchor === 'free' ? t('overlay.positionFree') : '';
    [scale, opacity, theme, ...extras, ...toggles].forEach((x) => x.sync());
  }
  return {
    el,
    sync,
    close: () => setOpen(false),
    // Se toco el widget en la vista previa: se abren sus opciones (y se cierran las de los demas) y se lo trae a la vista
    reveal: () => {
      onReveal?.();
      setOpen(true);
      el.scrollIntoView?.({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
    },
  };
}
