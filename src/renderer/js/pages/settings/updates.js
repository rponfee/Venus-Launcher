import { h, icon, mount } from '../../ui.js';
import { api } from '../../store.js';
import { t, locale } from '../../i18n.js';
import { card } from './shared.js';
import { appendWindowsIntegration } from './windows-integration.js';

const DISABLED_KEYS = {
  development: 'disabledDevelopment',
  portable: 'disabledPortable',
  platform: 'disabledPlatform',
  unconfigured: 'disabledUnconfigured',
  unavailable: 'disabledUnavailable',
};
const STATES = new Set(['idle', 'checking', 'current', 'downloading', 'ready', 'installing', 'error', 'disabled']);
const LOCKED = new Set(['disabled', 'checking', 'downloading', 'installing']);

// Shared by the dedicated page and Settings. A mounted panel owns one IPC subscription.
export function appendUpdates(body, ctx) {
  let current = null;
  let busy = false;
  let opening = false;
  let actionError = '';
  let statusFailed = false;
  let revision = 0;
  let statusRequest = 0;

  const field = (name) => h('div', { class: 'updates-fact' },
    h('dt', {}, t(`updates.${name}`)),
    h('dd', { dataset: { updateField: name } }));
  const installed = field('installedVersion');
  const available = field('availableVersion');
  const lastChecked = field('lastChecked');
  const statusIcon = h('span', { class: 'updates-status-icon', 'aria-hidden': 'true' });
  const statusText = h('p', { class: 'updates-status-text', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' }, t('updates.loading'));
  const progress = h('progress', { class: 'updates-progress', max: 100, value: 0, 'aria-label': t('updates.progressLabel'), hidden: true });
  const error = h('p', { class: 'updates-error', role: 'alert', hidden: true });
  const hint = h('p', { class: 'cfg-text updates-install-hint', hidden: true }, t('updates.installHint'));
  const check = h('button', { type: 'button', class: 'btn primary', dataset: { updateAction: 'check' }, hidden: true, onclick: () => run('check') }, icon('refresh'), t('updates.check'));
  const install = h('button', { type: 'button', class: 'btn primary', dataset: { updateAction: 'install' }, hidden: true, onclick: () => run('install') }, icon('download'), t('updates.install'));
  const retry = h('button', { type: 'button', class: 'btn', dataset: { updateAction: 'retry' }, hidden: true, onclick: readStatus }, icon('refresh'), t('updates.retry'));
  const releases = h('button', { type: 'button', class: 'btn ghost', dataset: { updateAction: 'releases' }, hidden: true, onclick: openReleases }, icon('external'), t('updates.releases'));
  const automatic = h('div', { class: 'updates-automatic', hidden: true },
    icon('refresh'), h('div', {}, h('strong', {}, t('updates.automaticTitle')), h('p', {}, t('updates.automaticDescription'))));
  const panel = card({ title: t('updates.panelTitle'), iconName: 'download', anchor: 'updates', cls: 'updates-panel' },
    h('dl', { class: 'updates-facts' }, installed, available, lastChecked),
    h('div', { class: 'updates-status' }, statusIcon, statusText), progress, error, hint,
    h('div', { class: 'updates-actions' }, check, install, retry, releases), automatic);
  body.append(panel);

  function draw() {
    if (!ctx.alive()) return;
    const state = current;
    const name = state?.status || (statusFailed ? 'error' : 'loading');
    panel.dataset.updaterStatus = name;
    panel.setAttribute('aria-busy', String(!state && !statusFailed));
    const version = state?.currentVersion || ctx.info?.version || t('updates.unknownVersion');
    installed.querySelector('dd').textContent = version;
    available.hidden = !state?.version || state.version === state.currentVersion;
    available.querySelector('dd').textContent = state?.version || t('updates.unknownVersion');
    const date = state?.lastChecked ? new Date(state.lastChecked) : null;
    lastChecked.querySelector('dd').textContent = date && !Number.isNaN(date.getTime())
      ? new Intl.DateTimeFormat(locale(), { dateStyle: 'medium', timeStyle: 'short' }).format(date)
      : t('updates.notChecked');
    const percent = Number.isFinite(state?.percent) ? Math.max(0, Math.min(100, state.percent)) : 0;
    const key = name === 'disabled' ? DISABLED_KEYS[state.disabledReason] || 'disabled' : name;
    statusText.textContent = statusFailed && !state ? t('updates.statusError') : t(`updates.${key}`, { version: state?.version || '', percent: Math.round(percent) });
    const statusIconName = name === 'current' || name === 'ready' ? 'check' : name === 'error' ? 'alert' : name === 'disabled' ? 'info' : name === 'downloading' ? 'download' : 'refresh';
    if (statusIcon.dataset.icon !== statusIconName) {
      statusIcon.dataset.icon = statusIconName;
      mount(statusIcon, icon(statusIconName));
    }
    progress.hidden = name !== 'downloading';
    progress.value = percent;
    error.hidden = !actionError;
    error.textContent = actionError;
    hint.hidden = name !== 'ready';
    check.hidden = !state || name === 'ready' || name === 'installing';
    check.disabled = busy || LOCKED.has(name);
    install.hidden = name !== 'ready' && name !== 'installing';
    install.disabled = busy || name === 'installing';
    retry.hidden = !!state || !statusFailed;
    releases.hidden = !state?.releasesUrl;
    releases.disabled = opening;
    automatic.hidden = !state || name === 'disabled';
  }

  function accept(state) {
    if (!ctx.alive() || !state || !STATES.has(state.status)) return false;
    revision++;
    current = state;
    statusFailed = false;
    draw();
    return true;
  }

  async function readStatus() {
    const request = ++statusRequest;
    const before = revision;
    statusFailed = false;
    actionError = '';
    draw();
    try {
      const state = await api.invoke('updater:status');
      if (request === statusRequest && before === revision && ctx.alive() && !accept(state)) {
        statusFailed = true;
        draw();
      }
    } catch {
      if (request === statusRequest && before === revision && ctx.alive()) {
        statusFailed = true;
        draw();
      }
    }
  }

  async function run(action) {
    if (!ctx.alive() || !current || busy || LOCKED.has(current.status)) return;
    if (action === 'install' && current.status !== 'ready') return;
    if (action === 'check' && current.status === 'ready') return;
    const before = revision;
    busy = true;
    actionError = '';
    draw();
    try {
      const state = await api.invoke(action === 'install' ? 'updater:install' : 'updater:check');
      // Progress events can be newer than the request's response.
      if (before === revision) accept(state);
    } catch {
      if (ctx.alive() && before === revision) actionError = t(action === 'install' ? 'updates.installError' : 'updates.error');
    } finally {
      busy = false;
      draw();
    }
  }

  async function openReleases() {
    if (!ctx.alive() || !current?.releasesUrl || opening) return;
    opening = true;
    actionError = '';
    draw();
    try { await api.app.openExternal(current.releasesUrl); }
    catch { if (ctx.alive()) actionError = t('updates.openError'); }
    finally { opening = false; draw(); }
  }

  ctx.onCleanup(api.on('updater:state', accept));
  draw();
  readStatus();
  appendWindowsIntegration(body, ctx);
}
