// Panel de Discord Rich Presence (Ajustes > Privacidad): activar, privacidad, botones, estado de la conexión,
// prueba y vista previa. Permite configurar el Application ID público cuando no está incluido.
// Contrato: discordPanel() -> Element. Canales: discord:status/configure/reconnect/test.
import { h, icon, mount, ok, fail, ensureCss, loading, switchEl, setBusy } from '../ui.js';
import { store, api } from '../store.js';
import { t, loadNs } from '../i18n.js';

const NS = 'discord';
const DEFAULTS = { clientId: '', enabled: false, showIdle: true, showInstance: true, showWorld: true, showServer: true, buttons: [] };
const APP_NAME = 'Venus Launcher'; // nombre de la aplicación de Discord del launcher (antes de leerlo de Discord)
let readyPromise = null;
let panelSeq = 0;

function prepare() {
  ensureCss('features/discord');
  if (!readyPromise) readyPromise = loadNs(NS).catch((err) => console.warn('[discord] textos', err));
  return readyPromise;
}

const isMissing = (err) => /No handler registered/i.test(err?.message || '');

function readCfg() {
  const raw = store.settings?.discord || {};
  return { ...DEFAULTS, ...raw, buttons: Array.isArray(raw.buttons) ? raw.buttons.slice(0, 2) : [] };
}

function validUrl(url) {
  try {
    const u = new URL(url);
    return (u.protocol === 'https:' || u.protocol === 'http:') && Boolean(u.hostname) && !u.username && !u.password && url.length <= 512;
  } catch {
    return false;
  }
}

function validButton(b) {
  const label = String(b?.label || '').trim();
  return label.length > 0 && label.length <= 32 && validUrl(String(b?.url || '').trim());
}

function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${String(mm).padStart(2, '0')}:${ss}`;
}

function toggleRow(title, sub, checked, onChange) {
  return h('div', { class: 'toggle-row dc-toggle' }, h('div', { class: 'tr-text' }, h('div', { class: 'tr-title' }, title), h('div', { class: 'tr-sub' }, sub)), switchEl(checked, onChange, title));
}

/**
 * Panel completo de Rich Presence. Se limpia solo cuando sale del documento (o con el.destroy()).
 */
export function discordPanel() {
  const root = h('section', { class: 'card dc-panel', 'aria-busy': 'true' }, loading());
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
  // El contrato no trae limpieza: se suelta cuando el elemento deja de estar en el documento
  const watch = setInterval(() => {
    if (root.isConnected) seen = true;
    else if (seen || Date.now() - born > 60000) dispose();
  }, 2000);
  root.destroy = dispose;
  prepare()
    .then(() => build(root, offs, () => disposed))
    .catch((err) => {
      if (disposed) return;
      console.error('[discord]', err);
      mount(root, h('div', { class: 'notice bad' }, icon('alert'), h('div', {}, err.message)));
    })
    .finally(() => { if (!disposed) root.removeAttribute('aria-busy'); });
  return root;
}

async function build(root, offs, isDisposed) {
  let status = null;
  // Los ajustes pudieron cambiar desde otro lado (asistente, bienvenida): leer los actuales
  await store.refreshSettings().catch(() => {});
  try {
    status = await api.invoke('discord:status');
  } catch (err) {
    if (isDisposed()) return;
    if (isMissing(err)) {
      mount(root, h('div', { class: 'notice bad' }, icon('alert'), h('div', {}, t('discord.unavailable'))));
      return;
    }
    console.warn('[discord] estado', err);
  }
  if (isDisposed()) return;
  let cfg = readCfg();
  let appInfo = status?.app?.valid ? status.app : null;

  const save = async (patch) => {
    try {
      await store.setSettings({ discord: patch });
      cfg = readCfg();
      if (!isDisposed()) drawAll();
      return true;
    } catch (err) {
      if (!isDisposed()) fail(t('discord.saveFailed'), err);
      return false;
    }
  };

  // ---------- Cabecera + estado ----------
  const statusPill = h('span', { class: 'pill dc-pill' });
  const statusText = h('div', { class: 'dc-status-text' });
  const statusAvatar = h('div', { class: 'dc-avatar', 'aria-hidden': 'true' });
  const testBtn = h('button', { class: 'btn sm', type: 'button', 'data-discord-action': 'test', title: t('discord.testTitle'), onclick: () => runTest() }, icon('zap'), t('discord.test'));
  const reconnectBtn = h('button', { class: 'btn sm ghost', type: 'button', 'data-discord-action': 'reconnect', onclick: runReconnect }, icon('refresh'), t('discord.reconnect'));
  const uid = `dc-${++panelSeq}`;
  const activityNote = h('div', { class: 'dc-activity-note' });
  const enableSwitch = switchEl(cfg.enabled, async (v) => {
    await save({ enabled: v });
    drawAll();
  }, t('discord.enableAria'));
  enableSwitch.dataset.discordAction = 'enable';

  const head = h(
    'div',
    { class: 'dc-head' },
    h('div', { class: 'dc-logo', 'aria-hidden': 'true' }, icon('gamepad')),
    h('div', { class: 'dc-head-text' }, h('div', { class: 'card-title' }, t('discord.title')), h('div', { class: 'dc-sub' }, t('discord.subtitle'))),
    enableSwitch,
  );
  const statusRow = h('div', { class: 'dc-status', role: 'status', 'aria-live': 'polite' }, statusAvatar, h('div', { class: 'dc-status-main' }, statusPill, statusText), h('div', { class: 'dc-connection-actions' }, reconnectBtn, testBtn));

  // ---------- Application ID público ----------
  const appInput = h('input', { class: 'input', type: 'text', inputmode: 'numeric', maxlength: 21,
    'aria-label': t('discord.applicationId'), 'aria-describedby': `${uid}-app-help`, 'data-discord-field': 'clientId',
    value: cfg.clientId || '', autocomplete: 'off', spellcheck: 'false' });
  const appError = h('div', { class: 'field-error', role: 'alert', hidden: true, 'data-discord-error': '' });
  const appHint = h('p', { class: 'small muted', id: `${uid}-app-help` }, t('discord.applicationIdHelp'));
  const appSource = h('p', { class: 'small muted', 'data-discord-field': 'source' });
  const logoNote = h('div', { class: 'notice info', 'data-discord-field': 'logoNote' });
  const applyApp = h('button', { class: 'btn primary sm', type: 'submit', 'data-discord-action': 'save-id' }, icon('check'), t('discord.saveId'));
  const appForm = h('form', { class: 'dc-app-form' },
    h('label', { class: 'dc-app-field' }, h('span', { class: 'label' }, t('discord.applicationId')), appInput), applyApp, appError);
  let savingId = false;
  appForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (savingId || isDisposed()) return;
    const clientId = appInput.value.trim();
    if (clientId && !/^[1-9]\d{16,20}$/.test(clientId)) {
      appError.textContent = t('discord.applicationIdInvalid'); appError.hidden = false; appInput.setAttribute('aria-invalid', 'true'); return;
    }
    savingId = true; appError.hidden = true; appInput.removeAttribute('aria-invalid'); appInput.disabled = true; applyApp.disabled = true;
    try {
      const next = await api.invoke('discord:configure', { clientId });
      await store.refreshSettings();
      if (isDisposed()) return;
      status = next; cfg = readCfg(); appInfo = next?.app?.valid ? next.app : null; appInput.value = cfg.clientId || '';
      drawAll(); ok(t('discord.idSaved'));
    } catch (err) {
      if (!isDisposed()) { appError.textContent = err.message; appError.hidden = false; }
    } finally { savingId = false; if (!isDisposed()) { appInput.disabled = false; applyApp.disabled = false; } }
  });
  const application = h('div', { class: 'dc-section dc-application' },
    h('div', { class: 'dc-section-title' }, icon('settings'), t('discord.applicationTitle')),
    appHint, appForm, appSource,
    h('details', { class: 'dc-setup' }, h('summary', {}, t('discord.setupTitle')),
      h('ol', {}, h('li', {}, t('discord.setupStep1')), h('li', {}, t('discord.setupStep2')), h('li', {}, t('discord.setupStep3'))),
      h('button', { class: 'btn sm ghost', type: 'button', 'data-discord-action': 'developer-portal', onclick: () => api.app.openExternal('https://discord.com/developers/applications').catch(err => fail(t('discord.openFailed'), err)) }, icon('external'), t('discord.openPortal'))),
    logoNote);
  function drawApplication() {
    appSource.textContent = status?.clientIdSource === 'bundled' ? t('discord.sourceBundled') : status?.clientIdSource === 'user' ? t('discord.sourceUser') : t('discord.sourceNone');
    const missingLogo = appInfo?.valid && !appInfo.hasAsset;
    logoNote.hidden = !missingLogo;
    logoNote.textContent = missingLogo ? t('discord.logoMissing') : '';
  }

  // ---------- Privacidad ----------
  const privacy = h(
    'div',
    { class: 'dc-section' },
    h('div', { class: 'dc-section-title', role: 'heading', 'aria-level': '3' }, icon('eye'), t('discord.privacyTitle')),
    toggleRow(t('discord.showIdle'), t('discord.showIdleSub'), cfg.showIdle, (v) => save({ showIdle: v })),
    toggleRow(t('discord.showInstance'), t('discord.showInstanceSub'), cfg.showInstance, (v) => save({ showInstance: v })),
    toggleRow(t('discord.showWorld'), t('discord.showWorldSub'), cfg.showWorld, (v) => save({ showWorld: v })),
    toggleRow(t('discord.showServer'), t('discord.showServerSub'), cfg.showServer, (v) => save({ showServer: v })),
  );

  // ---------- Botones ----------
  let rows = cfg.buttons.map((b) => ({ label: b.label || '', url: b.url || '' }));
  const buttonsBox = h('div', { class: 'dc-buttons' });
  let saveButtonsTimer = null;
  const saveButtons = () => {
    clearTimeout(saveButtonsTimer);
    saveButtonsTimer = setTimeout(() => save({ buttons: rows.filter(validButton).map((b) => ({ label: b.label.trim(), url: b.url.trim() })) }), 450);
  };
  const drawButtons = () => {
    mount(
      buttonsBox,
      rows.map((row, i) => {
        const hintId = `${uid}-btn-${i}`;
        const label = h('input', { class: 'input', maxlength: 32, placeholder: t('discord.buttonLabel'), 'aria-label': t('discord.buttonLabel'), 'aria-describedby': hintId, value: row.label });
        const url = h('input', { class: 'input', type: 'url', placeholder: t('discord.buttonUrl'), 'aria-label': t('discord.buttonUrl'), 'aria-describedby': hintId, value: row.url, spellcheck: 'false' });
        const setInvalid = (el, bad) => {
          el.classList.toggle('invalid', bad);
          if (bad) el.setAttribute('aria-invalid', 'true');
          else el.removeAttribute('aria-invalid');
        };
        const mark = () => {
          const touched = row.label || row.url;
          const bad = touched && !validButton(row);
          setInvalid(label, Boolean(bad && !(row.label.trim() && row.label.trim().length <= 32)));
          setInvalid(url, Boolean(bad && !validUrl(row.url.trim())));
          hint.hidden = !bad;
        };
        // Mientras se escribe solo se sacan los errores ya corregidos; se marcan al salir del campo
        const markSoft = () => {
          if (!hint.hidden && (validButton(row) || !(row.label || row.url))) mark();
        };
        const hint = h('div', { class: 'field-error dc-btn-hint', id: hintId, hidden: true }, icon('alert'), h('span', {}, t('discord.buttonInvalid')));
        label.addEventListener('input', () => {
          row.label = label.value;
          markSoft();
          saveButtons();
        });
        url.addEventListener('input', () => {
          row.url = url.value;
          markSoft();
          saveButtons();
        });
        label.addEventListener('blur', mark);
        url.addEventListener('blur', mark);
        const el = h(
          'div',
          { class: 'dc-btn-row' },
          h('div', { class: 'dc-btn-fields' }, label, url),
          h(
            'button',
            {
              class: 'icon-btn sm danger',
              type: 'button',
              title: t('discord.removeButton'),
              'aria-label': t('discord.removeButton'),
              onclick: () => {
                rows.splice(i, 1);
                drawButtons();
                saveButtons();
              },
            },
            icon('trash'),
          ),
          hint,
        );
        queueMicrotask(mark);
        return el;
      }),
      rows.length < 2
        ? h(
            'button',
            {
              class: 'btn sm ghost dc-add',
              type: 'button',
              onclick: () => {
                rows.push({ label: '', url: '' });
                drawButtons();
                buttonsBox.querySelector('.dc-btn-row:last-of-type input')?.focus();
              },
            },
            icon('plus'),
            t('discord.addButton'),
          )
        : null,
    );
  };
  const officialButtons = h('button', { class: 'btn sm ghost', type: 'button', 'data-discord-action': 'venus-links', onclick: async () => {
    const next = [{ label: t('discord.releaseLink'), url: 'https://github.com/rponfee/Venus-Launcher/releases/latest' }, { label: 'GitHub', url: 'https://github.com/rponfee/Venus-Launcher' }];
    if (await save({ buttons: next })) { rows = next.map(item => ({ ...item })); drawButtons(); }
  } }, icon('github'), t('discord.addVenusLinks'));
  const buttons = h('div', { class: 'dc-section' }, h('div', { class: 'dc-section-title', role: 'heading', 'aria-level': '3' }, icon('link'), t('discord.buttonsTitle')), h('div', { class: 'dc-section-sub' }, t('discord.buttonsSub')), buttonsBox, officialButtons);

  // ---------- Vista previa ----------
  const previewBox = h('div', { class: 'dc-preview' });
  let elapsedEl = null;
  let elapsedStart = 0;
  function drawPreview() {
    const p = status?.preview || null;
    const info = appInfo;
    const appName = info?.name || t('discord.previewAppUnknown');
    const appTitle = appName;
    const live = cfg.enabled && status?.state === 'connected' && status?.activitySynced === true;
    elapsedEl = null;
    const title = (extra) => h('div', { class: 'dc-section-title', role: 'heading', 'aria-level': '3' }, icon('monitor'), h('span', {}, t('discord.previewTitle')), extra || null);
    if (!p) {
      mount(previewBox, title(), h('div', { class: 'dc-pv-empty' }, icon('eyeOff'), h('span', {}, t('discord.previewNothing'))));
      return;
    }
    const large = p.assets?.large_image;
    const largeSrc = large ? (/^https:\/\//.test(large) ? large : info?.assetUrl || null) : null;
    const small = p.assets?.small_image ? info?.assetUrl || 'assets/logo-64.png' : null;
    elapsedStart = p.timestamps?.start || 0;
    elapsedEl = elapsedStart ? h('div', { class: 'dc-pv-line dc-pv-elapsed' }, t('discord.elapsed', { time: fmtElapsed(Date.now() - elapsedStart) })) : null;
    mount(
      previewBox,
      title(live ? h('span', { class: 'dc-live' }, h('i', { 'aria-hidden': 'true' }), t('discord.live')) : null),
      h(
        'div',
        { class: 'dc-pv-card' },
        h('div', { class: 'dc-pv-head' }, t('discord.previewPlaying', { app: appName })),
        h(
          'div',
          { class: 'dc-pv-body' },
          largeSrc ? h(
            'div',
            { class: 'dc-pv-images' },
            h('img', { class: 'dc-pv-large', src: largeSrc, alt: '', title: p.assets?.large_text || '' }),
            small ? h('img', { class: 'dc-pv-small', src: small, alt: '', title: p.assets?.small_text || '' }) : null,
          ) : null,
          h(
            'div',
            { class: 'dc-pv-text' },
            h('div', { class: 'dc-pv-name ellipsis', title: appTitle }, appTitle),
            p.details ? h('div', { class: 'dc-pv-line ellipsis', title: p.details }, p.details) : null,
            p.state ? h('div', { class: 'dc-pv-line ellipsis', title: p.state }, p.state) : null,
            elapsedEl,
          ),
        ),
        p.buttons?.length ? h('div', { class: 'dc-pv-buttons' }, p.buttons.map((b) => h('div', { class: 'dc-pv-btn ellipsis', title: b.url }, b.label))) : null,
      ),
      h('div', { class: 'dc-pv-foot' }, live ? t('discord.previewLive') : t('discord.previewOff')),
    );
  }
  const tick = setInterval(() => {
    if (elapsedEl && elapsedStart) elapsedEl.textContent = t('discord.elapsed', { time: fmtElapsed(Date.now() - elapsedStart) });
  }, 1000);
  offs.push(() => clearInterval(tick));

  // ---------- Estado ----------
  function drawStatus() {
    const st = status || { state: cfg.enabled ? 'connecting' : 'off' };
    const key = st.testing ? 'testing' : st.state || 'off';
    const cls = { connected: 'good', testing: 'good', waiting: 'warn', connecting: 'warn', unconfigured: 'warn', error: 'bad' }[key] || '';
    statusPill.className = `pill dc-pill ${cls}`;
    mount(statusPill, key === 'connecting' ? h('span', { class: 'spinner dc-spin' }) : h('span', { class: ['dc-dot', cls] }), t(`discord.state_${key}`));
    let text;
    if (key === 'error') text = st.error || t('discord.state_error');
    else if (key === 'connected') text = t('discord.text_connected', { name: st.user?.globalName || st.user?.username || 'Discord' });
    else text = t(`discord.text_${key}`);
    statusText.textContent = text;
    if (key === 'connected' && st.user?.avatarUrl) mount(statusAvatar, h('img', { src: st.user.avatarUrl, alt: '' }));
    else mount(statusAvatar, icon(key === 'error' ? 'alert' : key === 'off' ? 'power' : key === 'waiting' ? 'clock' : 'radio'));
    statusAvatar.className = `dc-avatar ${cls}`;
    root.dataset.discordState = key;
    testBtn.disabled = !cfg.enabled || !status?.available || testing;
    reconnectBtn.disabled = !cfg.enabled || !status?.available || reconnecting;
    mount(activityNote, st.activityError ? h('div', { class: 'notice bad dc-note' }, icon('alert'), h('div', {}, h('strong', {}, t('discord.activityError')), ' ', st.activityError)) : null);
    root.classList.toggle('dc-disabled', !cfg.enabled);
  }

  let testing = false;
  let reconnecting = false;
  async function runReconnect() {
    if (reconnecting || isDisposed()) return;
    reconnecting = true; drawStatus();
    try {
      const next = await api.invoke('discord:reconnect');
      if (!isDisposed()) { status = next; drawAll(); }
    } catch (err) { if (!isDisposed()) fail(t('discord.reconnectFailed'), err); }
    finally { reconnecting = false; if (!isDisposed()) drawStatus(); }
  }

  async function runTest() {
    if (testing || isDisposed()) return;
    testing = true;
    const done = setBusy(testBtn);
    try {
      const next = await api.invoke('discord:test');
      if (isDisposed()) return;
      status = next;
      ok(t('discord.testOk'), t('discord.testOkText'));
    } catch (err) {
      if (!isDisposed()) fail(t('discord.testFailed'), err);
    } finally {
      testing = false; done();
      if (!isDisposed()) drawAll();
    }
  }

  function drawAll() {
    if (isDisposed()) return;
    drawApplication();
    drawStatus();
    drawPreview();
  }

  mount(
    root,
    head,
    statusRow,
    activityNote,
    application,
    h('div', { class: 'dc-body' }, h('div', { class: 'dc-col' }, privacy, buttons), h('div', { class: 'dc-col dc-side' }, previewBox)),
  );
  drawButtons();
  drawAll();

  offs.push(() => clearTimeout(saveButtonsTimer));
  offs.push(
    api.on('discord:statusChanged', (st) => {
      status = st;
      appInfo = st?.app?.valid ? st.app : null;
      if (!isDisposed()) {
        drawAll();
      }
    }),
  );
  offs.push(
    store.on('settings', () => {
      const next = readCfg();
      const enabledChanged = next.enabled !== cfg.enabled;
      cfg = next;
      if (enabledChanged) enableSwitch.querySelector('input').checked = cfg.enabled;
    }),
  );
}
