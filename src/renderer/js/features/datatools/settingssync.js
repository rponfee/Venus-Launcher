// Sincronizar ajustes y temas entre PCs, lado de la interfaz: interruptor en Ajustes → Cuenta y nube (apagado por defecto y
// con la cuenta de Venus), debounce al guardar y el diálogo de la primera vez. La lógica está en sync-logic.js y la nube son
// las RPC settings_sync_* de la migración 0028. Solo corre con el interruptor prendido: es la conexión opcional de esta función.
//   settings.settingsSync = { enabled, decided, userId, version, entries: [[clave, { h, at }]], lastAt, trimmed }
import { h, icon, mount, modal, toast, fail, ok, fmtAgo, setBusy, confirmDialog } from '../../ui.js';
import { store } from '../../store.js';
import { t } from '../../i18n.js';
import { cloud } from '../../cloud.js';
import { navigate } from '../../app.js';
import { card, toggleRow, note } from '../../pages/settings/shared.js';
import { createSyncEngine } from './sync-logic.js';

const T = (key, vars) => t(`datatools.${key}`, vars);
const DEBOUNCE_MS = 5000;
const PULL_EVERY_MS = 15 * 60 * 1000;
const FOCUS_THROTTLE_MS = 5 * 60 * 1000;

let started = false;
let engine = null;
let timer = null;
let applying = false;
let lastPull = 0;
let asking = null;
let lastError = null;
const listeners = new Set();
const changed = () => listeners.forEach((fn) => fn());

const saved = () => store.settings?.settingsSync || {};
const isOn = () => saved().enabled === true;
// Las listas se reemplazan al guardar (settings.set mezcla los objetos): así una clave vieja no vuelve a aparecer
const loadState = () => {
  const s = saved();
  return { ...s, keys: Object.fromEntries(Array.isArray(s.entries) ? s.entries : []) };
};
const saveState = (state) => {
  const { keys, ...rest } = state;
  return store.setSettings({ settingsSync: { ...rest, enabled: isOn(), entries: Object.entries(keys || {}) } });
};

async function rpc(name, args) {
  const { data, error } = await cloud.client.rpc(name, args);
  if (error) throw error;
  return data;
}

// La primera vez en esta PC con esta cuenta, si la nube ya tiene algo. Cerrar sin elegir apaga el interruptor.
function askFirstTime() {
  if (asking) return asking;
  asking = new Promise((resolve) => {
    let answered = false;
    const answer = (v) => {
      if (answered) return;
      answered = true;
      asking = null;
      resolve(v);
      m.close();
    };
    const m = modal({
      title: T('syncFirstTitle'),
      icon: 'cloud',
      body: h('div', { class: 'dt-stack' }, h('p', { class: 'text-2' }, T('syncFirstText'))),
      footer: [
        h('button', { class: 'btn', type: 'button', onclick: () => answer('push') }, icon('cloudUpload'), T('syncFirstPush')),
        h('button', { class: 'btn primary', type: 'button', onclick: () => answer('pull') }, icon('cloudDownload'), T('syncFirstPull')),
      ],
      onClose: () => {
        if (answered) return;
        answered = true;
        asking = null;
        store.setSettings({ settingsSync: { enabled: false } }).then(changed).catch(() => {});
        resolve(null);
      },
    });
  });
  return asking;
}

function getEngine() {
  if (!engine) {
    engine = createSyncEngine({
      rpc,
      userId: () => cloud.user?.id || null,
      getSettings: () => store.settings,
      applyPatch: async (patch) => {
        applying = true;
        try {
          return await store.setSettings(patch);
        } finally {
          applying = false;
        }
      },
      loadState,
      saveState,
      ask: askFirstTime,
    });
  }
  return engine;
}

// Sin sesión, apagado o en modo sin conexión: nada de red.
const canRun = () => isOn() && cloud.isConfigured?.() && cloud.isSignedIn?.() && store.settings?.downloads?.offline !== true;

async function syncNow({ manual = false } = {}) {
  if (!canRun()) return null;
  clearTimeout(timer);
  timer = null;
  lastPull = Date.now();
  try {
    const res = await getEngine().sync();
    lastError = null;
    if (res?.status === 'pulled' || res?.status === 'merged') toast('good', T('syncApplied'), null, 3000);
    if (res?.trimmed) toast('info', T('syncTrimmed', { count: res.trimmed }), null, 8000);
    changed();
    return res;
  } catch (err) {
    // Sin detalles técnicos para el usuario: el motivo va a la consola
    console.warn('[settingssync]', err?.code || '', err?.message || err);
    lastError = err?.code === 'too_big' ? T('syncTooBig') : T('syncUnavailable');
    if (manual) fail(T('syncFailed'), lastError);
    changed();
    return null;
  }
}

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(() => syncNow(), DEBOUNCE_MS);
}

export function startSettingsSync() {
  if (started) return;
  started = true;
  // Se compara el contenido con lo último visto: lo que aplica la sincronización no cuenta como un cambio del usuario.
  store.on('settings', () => {
    if (applying || !canRun()) return;
    if (getEngine().hasLocalChanges()) schedule();
  });
  const start = () => canRun() && syncNow();
  Promise.resolve(cloud.ready?.())
    .catch(() => {})
    .then(() => setTimeout(start, 8000));
  cloud.on?.('auth', () => {
    changed();
    setTimeout(start, 1500);
  });
  setInterval(() => canRun() && !document.hidden && syncNow(), PULL_EVERY_MS);
  window.addEventListener('focus', () => {
    if (canRun() && Date.now() - lastPull > FOCUS_THROTTLE_MS) syncNow();
  });
}

// ---------- Tarjeta ----------
export function syncCard(ctx) {
  const body = h('div', { class: 'dt-stack' });

  function draw() {
    const on = isOn();
    const signedIn = cloud.isConfigured?.() && cloud.isSignedIn?.();
    const s = saved();
    const syncBtn = h('button', { class: 'btn sm', type: 'button' }, icon('refresh'), T('syncNow'));
    syncBtn.addEventListener('click', async () => {
      const done = setBusy(syncBtn);
      const res = await syncNow({ manual: true });
      done();
      if (res) ok(T('syncDone'));
    });
    const wipeBtn = h('button', { class: 'btn sm ghost', type: 'button' }, icon('trash'), T('syncDelete'));
    wipeBtn.addEventListener('click', async () => {
      if (!(await confirmDialog(T('syncDeleteTitle'), T('syncDeleteText'), { okText: T('syncDelete'), danger: true }))) return;
      const done = setBusy(wipeBtn);
      try {
        await getEngine().removeRemote();
        await store.setSettings({ settingsSync: { enabled: false } });
        ok(T('syncDeleted'));
      } catch (err) {
        console.warn('[settingssync]', err?.message || err);
        fail(T('syncFailed'), T('syncUnavailable'));
      } finally {
        done();
        draw();
      }
    });
    mount(
      body,
      toggleRow({
        title: T('syncEnable'),
        sub: T('syncEnableSub'),
        checked: on,
        disabled: !signedIn && !on,
        onChange: async (v) => {
          try {
            await store.setSettings({ settingsSync: { enabled: v } });
            draw();
            if (v) syncNow({ manual: true });
          } catch (err) {
            fail(T('saveError'), err);
          }
        },
      }),
      !signedIn ? h('div', { class: 'dt-actions' }, h('span', { class: 'small muted' }, T('syncNeedAccount')), h('button', { class: 'btn sm', type: 'button', onclick: () => navigate('settings/cloud/venus') }, icon('logIn'), T('syncSignIn'))) : null,
      on && signedIn
        ? [
            lastError ? note('bad', 'alert', lastError) : s.lastAt ? h('div', { class: 'small muted' }, T('syncLast', { ago: fmtAgo(s.lastAt) })) : null,
            h('div', { class: 'dt-actions' }, syncBtn, wipeBtn),
          ]
        : null,
      h('p', { class: 'small muted' }, T('syncWhat')),
    );
  }
  draw();
  listeners.add(draw);
  ctx?.onCleanup?.(() => listeners.delete(draw));
  return card({ title: T('syncTitle'), iconName: 'cloud', sub: T('syncSub'), anchor: 'settingssync-card' }, body);
}
