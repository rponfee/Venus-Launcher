import { h, icon, mount } from '../../ui.js';
import { api } from '../../store.js';
import { t } from '../../i18n.js';
import { card } from './shared.js';

const IDS = ['desktop', 'startMenu'];

// This panel only reports verified shortcut state; it does not inspect Windows Search.
export function appendWindowsIntegration(body, ctx) {
  const info = ctx.info || {};
  if ((info.platform && info.platform !== 'win32') || info.packaged === false) return;
  const knownWindowsInstall = info.platform === 'win32' && info.packaged === true;
  let confirmedWindowsInstall = knownWindowsInstall;
  let alive = true;
  let request = 0;
  let state = null;
  let busy = false;
  let repairing = false;
  let failure = '';
  const active = () => alive && ctx.alive();

  const rows = new Map(IDS.map((id) => {
    const result = h('dd', { class: 'windows-shortcut-result', dataset: { shortcutState: 'unknown' } });
    return [id, { result, row: h('div', { class: 'windows-shortcut-row', dataset: { windowsShortcut: id } },
      h('dt', {}, icon(id === 'desktop' ? 'monitor' : 'layers'), t(id === 'desktop' ? 'updates.windowsDesktop' : 'updates.windowsStartMenu')), result) }];
  }));
  const list = h('dl', { class: 'windows-shortcuts' }, IDS.map((id) => rows.get(id).row));
  const summary = h('p', { class: 'cfg-text windows-shortcut-summary', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const alert = h('p', { class: 'updates-error', role: 'alert', hidden: true });
  const repair = h('button', { type: 'button', class: 'btn', dataset: { windowsAction: 'repair' }, onclick: () => run(true) }, icon('refresh'), t('updates.windowsRepair'));
  const retry = h('button', { type: 'button', class: 'btn', dataset: { windowsAction: 'retry' }, hidden: true, onclick: () => run(false) }, icon('refresh'), t('updates.retry'));
  const notes = h('div', { class: 'windows-shortcut-notes' },
    h('p', {}, t('updates.windowsSearchHint')), h('p', {}, t('updates.windowsPinnedHint')));
  const panel = card({ title: t('updates.windowsTitle'), iconName: 'monitor', sub: t('updates.windowsDescription'), cls: 'windows-integration-panel' },
    list, summary, alert, h('div', { class: 'updates-actions' }, repair, retry), notes);
  panel.dataset.windowsIntegration = '';
  panel.hidden = !knownWindowsInstall;
  body.append(panel);
  ctx.onCleanup(() => { alive = false; request++; });

  function validSnapshot(value, requireResults) {
    if (!value || typeof value.supported !== 'boolean') return false;
    if (!value.supported) return ['platform', 'development', 'portable', 'unavailable'].includes(value.reason);
    return IDS.every((id) => {
      const shortcut = value.shortcuts?.[id];
      const result = value.results?.[id];
      return typeof shortcut?.exists === 'boolean' && typeof shortcut?.valid === 'boolean'
        && (!shortcut.valid || shortcut.exists)
        && (!requireResults || typeof result?.ok === 'boolean');
    });
  }

  function rowState(id) {
    const shortcut = state?.shortcuts?.[id];
    const result = state?.results?.[id];
    if (!shortcut) return ['unknown', 'windowsUnknown'];
    if (result) return result.ok && shortcut.valid && !shortcut.error
      ? ['repaired', 'windowsRepaired'] : ['error', 'windowsRepairFailed'];
    if (shortcut.error) return ['error', 'windowsReadError'];
    if (shortcut.valid) return ['valid', 'windowsReady'];
    return shortcut.exists ? ['invalid', 'windowsOutdated'] : ['missing', 'windowsMissing'];
  }

  function draw() {
    if (!active()) return;
    const unsupported = state?.supported === false;
    const portable = unsupported && state.reason === 'portable';
    const hiddenReason = unsupported && ['platform', 'development'].includes(state.reason);
    panel.hidden = hiddenReason || (!state && !confirmedWindowsInstall) || (unsupported && !portable && !confirmedWindowsInstall);
    panel.dataset.windowsStatus = busy ? (repairing ? 'repairing' : 'loading') : failure ? 'error' : unsupported ? 'unsupported' : 'ready';
    panel.setAttribute('aria-busy', String(busy));
    list.hidden = unsupported;
    for (const id of IDS) {
      const { result } = rows.get(id);
      const [status, key] = rowState(id);
      result.dataset.shortcutState = status;
      mount(result, icon(status === 'valid' || status === 'repaired' ? 'check' : status === 'unknown' ? 'info' : 'alert'), t(`updates.${key}`));
    }
    let message = '';
    if (busy) message = t(repairing ? 'updates.windowsRepairing' : 'updates.windowsChecking');
    else if (unsupported) message = t(portable ? 'updates.windowsPortable' : 'updates.windowsUnavailable');
    else if (state?.results) {
      const complete = IDS.every((id) => rowState(id)[0] === 'repaired');
      message = t(complete ? 'updates.windowsRepairComplete' : 'updates.windowsRepairPartial');
    }
    summary.textContent = message;
    summary.hidden = !message;
    alert.textContent = failure;
    alert.hidden = !failure;
    repair.hidden = unsupported || !state;
    repair.disabled = busy || state?.supported !== true;
    retry.hidden = !failure && !(unsupported && state.reason === 'unavailable');
    retry.disabled = busy;
    notes.hidden = unsupported;
  }

  async function run(isRepair) {
    if (!active() || busy || (isRepair && state?.supported !== true)) return;
    const token = ++request;
    busy = true;
    repairing = isRepair;
    failure = '';
    draw();
    try {
      const next = await api.invoke(isRepair ? 'windowsIntegration:repair' : 'windowsIntegration:status');
      if (!active() || token !== request) return;
      if (!validSnapshot(next, isRepair)) throw new Error('Invalid Windows integration snapshot');
      state = next;
      if (next.supported) confirmedWindowsInstall = true;
    } catch {
      if (!active() || token !== request) return;
      // A failed IPC response cannot confirm which changes, if any, were applied.
      state = null;
      failure = t(isRepair ? 'updates.windowsOperationError' : 'updates.windowsStatusError');
    } finally {
      if (active() && token === request) { busy = false; repairing = false; draw(); }
    }
  }

  if (info.portable === true) {
    state = { supported: false, reason: 'portable' };
    draw();
  } else run(false);
}
