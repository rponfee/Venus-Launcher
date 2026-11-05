// Descargas programadas (3.1, lado de la interfaz). El proceso principal (modules/downloadschedule.js) pausa y
// reanuda las descargas segun la franja de settings.downloads.schedule; aca va:
//   schedulePanel() -> Element con .destroy(): tarjeta de Ajustes > Descargas y almacenamiento (activar, desde,
//                      hasta, estado y "Bajar ahora")
//   startup()       -> aviso en el panel de tareas mientras hay tareas esperando por la franja, con "Bajar ahora"
// Canales: downloads:scheduleStatus/scheduleNow/scheduleReset y el evento downloads:schedule.
import { h, icon, mount, fail, switchEl, setBusy, ensureCss, fmtTime } from '../../ui.js';
import { store, api } from '../../store.js';
import { t, loadNs } from '../../i18n.js';

const T = (key, vars) => t(`playcare.${key}`, vars);
const DEFAULTS = { enabled: false, from: '02:00', to: '08:00' };
const isMissing = (err) => /No handler registered/i.test(err?.message || '');

let started = false;
let status = null;
let missing = false;
const listeners = new Set();

function setStatus(s) {
  if (!s || typeof s !== 'object') return;
  status = s;
  for (const fn of [...listeners]) {
    try {
      fn(status);
    } catch (err) {
      console.error(err);
    }
  }
}

async function refresh() {
  if (missing) return null;
  try {
    setStatus(await api.invoke('downloads:scheduleStatus'));
  } catch (err) {
    if (isMissing(err)) missing = true;
  }
  return status;
}

const clockOf = (s) => (typeof s === 'string' && /^\d{2}:\d{2}$/.test(s) ? s : null);

function statusText(s) {
  if (!s) return '';
  if (!s.enabled) return T('schedStatusOff');
  if (s.override && s.overrideUntil) return T('schedStatusOverride', { until: fmtTime(s.overrideUntil) });
  if (s.inWindow) return s.paused && !s.pausedBySchedule ? T('schedStatusManualPause') : T('schedStatusIn', { to: s.to });
  return T('schedStatusOut', { from: s.from });
}

// ---------- Aviso en el panel de tareas ----------
const runningTasks = () => [...(store.tasks?.values?.() || [])].filter((x) => x?.state === 'running').length;

function syncNotice() {
  const dock = document.getElementById('tasks');
  if (!dock) return;
  let el = dock.querySelector('.pc-sched-task');
  const show = Boolean(status?.enabled && status.pausedBySchedule && !status.allowed && runningTasks() > 0);
  if (!show) {
    el?.remove();
    return;
  }
  const text = T('schedNoticeText', { from: status.from });
  if (el) {
    el.querySelector('.task-detail').textContent = text;
    return;
  }
  const now = h('button', { type: 'button', class: 'btn sm primary' }, icon('play'), T('schedNow'));
  now.addEventListener('click', async () => {
    const done = setBusy(now);
    try {
      setStatus(await api.invoke('downloads:scheduleNow'));
    } catch (err) {
      fail(T('schedSaveError'), err);
    } finally {
      done();
    }
  });
  el = h(
    'div',
    { class: 'task pc-sched-task', role: 'status' },
    h('div', { class: 'task-top' }, icon('pause'), h('div', { class: 'task-title' }, T('schedNoticeTitle'))),
    h('div', { class: 'task-detail' }, text),
    h('div', { class: 'pc-sched-task-actions' }, now),
  );
  dock.prepend(el);
}

export function startup() {
  if (started) return;
  started = true;
  ensureCss('features/playcare');
  loadNs('playcare').catch(() => {});
  api.on('downloads:schedule', (s) => {
    setStatus(s);
    syncNotice();
  });
  api.on('task:update', () => setTimeout(syncNotice, 50));
  refresh().then(syncNotice);
}

// ---------- Tarjeta de Ajustes ----------
export function schedulePanel() {
  ensureCss('features/playcare');
  const root = h('section', { class: 'card tsch-panel', 'aria-busy': 'true' });
  const offs = [];
  let disposed = false;
  root.destroy = () => {
    disposed = true;
    offs.splice(0).forEach((off) => off());
  };
  loadNs('playcare')
    .then(() => build(root, offs, () => disposed))
    .catch((err) => {
      console.warn('[playcare] descargas programadas', err);
      mount(root, h('div', { class: 'notice bad' }, icon('alert'), h('div', {}, T('schedUnavailable'))));
    })
    .finally(() => root.removeAttribute('aria-busy'));
  return root;
}

async function build(root, offs, isDisposed) {
  const saved = store.settings?.downloads?.schedule;
  const cfg = { ...DEFAULTS, ...(saved && typeof saved === 'object' ? saved : {}) };
  cfg.enabled = cfg.enabled === true;
  cfg.from = clockOf(cfg.from) || DEFAULTS.from;
  cfg.to = clockOf(cfg.to) || DEFAULTS.to;

  const save = async (patch) => {
    Object.assign(cfg, patch);
    sync();
    try {
      await store.setSettings({ downloads: { schedule: { enabled: cfg.enabled, from: cfg.from, to: cfg.to } } });
    } catch (err) {
      fail(T('schedSaveError'), err);
    }
  };

  const enable = switchEl(cfg.enabled, (v) => save({ enabled: v }), T('schedEnable'));
  const from = h('input', { type: 'time', class: 'input tsch-time', value: cfg.from, 'aria-label': T('schedFrom') });
  const to = h('input', { type: 'time', class: 'input tsch-time', value: cfg.to, 'aria-label': T('schedTo') });
  from.addEventListener('change', () => clockOf(from.value) && save({ from: from.value }));
  to.addEventListener('change', () => clockOf(to.value) && save({ to: to.value }));
  const crosses = h('span', { class: 'small muted tsch-crosses' }, T('schedCrosses'));
  const pill = h('span', { class: 'pill' });
  const text = h('span', { class: 'tsch-status-text' });
  const nowBtn = h('button', { type: 'button', class: 'btn sm primary', title: T('schedNowHint') }, icon('play'), T('schedNow'));
  const resetBtn = h('button', { type: 'button', class: 'btn sm ghost' }, icon('undo'), T('schedReset'));
  const action = async (btn, channel) => {
    const done = setBusy(btn);
    try {
      setStatus(await api.invoke(channel));
    } catch (err) {
      fail(T('schedSaveError'), err);
    } finally {
      done();
    }
  };
  nowBtn.addEventListener('click', () => action(nowBtn, 'downloads:scheduleNow'));
  resetBtn.addEventListener('click', () => action(resetBtn, 'downloads:scheduleReset'));

  function sync() {
    enable.querySelector('input').checked = cfg.enabled;
    root.classList.toggle('tsch-off', !cfg.enabled);
    from.disabled = !cfg.enabled;
    to.disabled = !cfg.enabled;
    crosses.hidden = !(cfg.enabled && cfg.to < cfg.from);
    const s = status;
    const kind = !s || !s.enabled ? '' : s.allowed ? 'good' : 'warn';
    pill.className = `pill ${kind}`.trim();
    pill.textContent = !s || !s.enabled ? T('schedStatusOff').split(':')[0] : s.override ? T('schedNow') : s.allowed ? T('schedStatusIn').split(':')[0] : T('schedStatusOut').split(':')[0];
    text.textContent = statusText(s);
    nowBtn.hidden = !(s?.enabled && !s.allowed);
    resetBtn.hidden = !(s?.enabled && s.override);
  }

  mount(
    root,
    h('div', { class: 'tsch-head' }, h('div', { class: 'tsch-head-text' }, h('h3', { class: 'card-title' }, icon('clock'), h('span', {}, T('schedTitle'))), h('p', { class: 'card-sub' }, T('schedSub'))), enable),
    h('div', { class: 'tsch-row' }, h('label', { class: 'tsch-field' }, h('span', {}, T('schedFrom')), from), h('label', { class: 'tsch-field' }, h('span', {}, T('schedTo')), to), crosses),
    h('div', { class: 'tsch-status', role: 'status', 'aria-live': 'polite' }, pill, text, h('span', { class: 'spacer' }), nowBtn, resetBtn),
  );
  sync();
  if (!status) await refresh();
  if (isDisposed()) return;
  sync();
  const onStatus = () => !isDisposed() && sync();
  listeners.add(onStatus);
  offs.push(() => listeners.delete(onStatus));
  offs.push(
    store.on('settings', (s) => {
      if (isDisposed()) return;
      const next = s?.downloads?.schedule;
      if (!next || typeof next !== 'object') return;
      cfg.enabled = next.enabled === true;
      cfg.from = clockOf(next.from) || cfg.from;
      cfg.to = clockOf(next.to) || cfg.to;
      from.value = cfg.from;
      to.value = cfg.to;
      sync();
    }),
  );
}
