// Llevar todo a otra PC: tarjeta de Ajustes → Datos con Exportar todo e Importar. Qué entra y qué no lo decide el proceso
// principal (modules/portability.js). Los diálogos muestran el progreso de la tarea y dejan cancelar.
import { h, icon, mount, modal, fail, toast, fmtBytes, fmtDate, setBusy, confirmDialog } from '../../ui.js';
import { store, api } from '../../store.js';
import { t } from '../../i18n.js';
import { card, note } from '../../pages/settings/shared.js';

const T = (key, vars) => t(`datatools.${key}`, vars);
const CATEGORIES = [
  { id: 'instances', icon: 'layers' },
  { id: 'worlds', icon: 'globe' },
  { id: 'servers', icon: 'server' },
  { id: 'settings', icon: 'palette' },
  { id: 'media', icon: 'camera' },
];
const isCancel = (err) => /cancel/i.test(String(err?.message || ''));

// Barra con la tarea de exportar o importar, con su botón de cancelar
function progressPanel() {
  const label = h('div', { class: 'small text-2' }, T('taskStarting'));
  const bar = h('i', { style: { width: '0%' } });
  const barBox = h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': T('progressAria') }, bar);
  const cancel = h('button', { class: 'btn sm ghost', type: 'button', disabled: true }, icon('x'), T('cancel'));
  let taskId = null;
  cancel.addEventListener('click', () => taskId && api.invoke('tasks:cancel', taskId).catch(() => {}));
  const off = api.on('task:update', (task) => {
    if (task?.meta?.kind !== 'portability') return;
    taskId = task.id;
    cancel.disabled = task.state !== 'running';
    if (task.detail) label.textContent = task.detail;
    if (task.progress !== null && task.progress !== undefined) {
      bar.style.width = `${Math.round(task.progress * 100)}%`;
      barBox.setAttribute('aria-valuenow', String(Math.round(task.progress * 100)));
    }
  });
  return { el: h('div', { class: 'dt-stack' }, label, barBox, h('div', { class: 'dt-actions' }, cancel)), destroy: off };
}

function checkRow({ id, iconName, title, sub, checked, disabled, onChange }) {
  const input = h('input', { type: 'checkbox', checked, disabled, id: `dt-cat-${id}` });
  input.addEventListener('change', () => onChange(input.checked));
  return h('label', { class: ['dt-cat', disabled && 'is-disabled'], for: `dt-cat-${id}` }, input, h('span', { class: 'dt-cat-icon' }, icon(iconName)), h('span', { class: 'dt-cat-text' }, h('span', { class: 'dt-cat-title' }, title), sub ? h('span', { class: 'dt-cat-sub' }, sub) : null));
}

// ---------- Exportar ----------
async function openExport() {
  const chosen = { instances: true, worlds: true, servers: true, settings: true, media: true };
  const body = h('div', { class: 'dt-stack' });
  const list = h('div', { class: 'dt-cats' });
  const totals = h('div', { class: 'dt-totals', 'aria-live': 'polite' }, T('exportMeasuring'));
  const warn = h('div', {});
  const go = h('button', { class: 'btn primary', type: 'button', disabled: true }, icon('upload'), T('exportOk'));
  const cancelBtn = h('button', { class: 'btn ghost', type: 'button', onclick: () => m.close() }, T('cancel'));
  const m = modal({ title: T('exportTitle'), icon: 'upload', size: 'wide', body, footer: [cancelBtn, go] });
  let estimate = null;
  let token = 0;

  function drawList() {
    mount(
      list,
      CATEGORIES.map((c) =>
        checkRow({
          id: c.id,
          iconName: c.icon,
          title: T(`cat_${c.id}`),
          sub: [T(`cat_${c.id}Sub`), estimate ? fmtBytes(estimate.sizes[c.id] || 0) : null].filter(Boolean).join(' · '),
          checked: chosen[c.id],
          onChange: (v) => {
            chosen[c.id] = v;
            measure();
          },
        }),
      ),
    );
  }

  async function measure() {
    const my = ++token;
    go.disabled = true;
    totals.textContent = T('exportMeasuring');
    // Se mide todo una sola vez por categoría; el total sale de lo que está tildado
    try {
      if (!estimate) estimate = await api.invoke('portability:estimate', { instances: true, worlds: true, servers: true, settings: true, media: true });
    } catch (err) {
      if (my === token) mount(warn, note('bad', 'alert', err.message));
      return;
    }
    if (my !== token) return;
    drawList();
    const total = CATEGORIES.reduce((a, c) => a + (chosen[c.id] ? estimate.sizes[c.id] || 0 : 0), 0);
    const any = CATEGORIES.some((c) => chosen[c.id]);
    totals.textContent = estimate.free !== null ? T('exportTotal', { size: fmtBytes(total), free: fmtBytes(estimate.free) }) : T('exportTotalNoFree', { size: fmtBytes(total) });
    mount(warn, estimate.running?.length ? note('warn', 'alert', T('exportRunning', { names: estimate.running.slice(0, 3).join(', ') })) : null);
    go.disabled = !any || Boolean(estimate.running?.length);
  }

  mount(body, h('p', { class: 'text-2' }, T('exportIntro')), list, totals, warn, note('info', 'shieldCheck', T('exportPrivacy')));
  drawList();
  measure();

  go.addEventListener('click', async () => {
    const prog = progressPanel();
    mount(body, h('p', { class: 'text-2' }, T('exportWorking')), prog.el);
    go.disabled = true;
    cancelBtn.disabled = true;
    let res = null;
    try {
      res = await api.invoke('portability:export', { ...chosen });
    } catch (err) {
      prog.destroy();
      m.close();
      if (isCancel(err)) toast('info', T('exportCancelled'), null, 3500);
      else fail(T('exportFailed'), err);
      return;
    }
    prog.destroy();
    m.close();
    if (!res || res.cancelled) return;
    showExported(res);
  });
}

function showExported(res) {
  const m = modal({
    title: T('exportDone'),
    icon: 'check',
    size: 'sm',
    body: h('div', { class: 'dt-stack' }, h('p', { class: 'text-2' }, T('exportDoneText', { size: fmtBytes(res.size), count: res.files })), h('div', { class: 'dt-path selectable' }, res.path), res.skipped ? note('warn', 'alert', T('exportSkipped', { count: res.skipped })) : null),
    footer: [h('button', { class: 'btn', type: 'button', onclick: () => api.invoke('portability:reveal', res.path).catch(() => {}) }, icon('folderOpen'), T('showInFolder')), h('button', { class: 'btn primary', type: 'button', onclick: () => m.close() }, T('close'))],
  });
}

// ---------- Importar ----------
async function pickImport(btn) {
  const done = setBusy(btn);
  let info;
  try {
    info = await api.invoke('portability:pickImport');
  } catch (err) {
    fail(T('importFailed'), err);
    return;
  } finally {
    done();
  }
  if (!info || info.cancelled) return;
  openImport(info);
}

const worldsBytes = (i) => i.worlds.reduce((a, w) => a + w.bytes, 0);

function openImport(info) {
  const sizes = {
    instances: info.instances.reduce((a, i) => a + i.content.bytes, 0),
    worlds: info.instances.reduce((a, i) => a + worldsBytes(i), 0),
    servers: info.servers.reduce((a, s) => a + s.content.bytes, 0),
    media: info.instances.reduce((a, i) => a + i.media.bytes, 0),
    settings: 0,
  };
  const present = {
    instances: info.instances.some((i) => i.content.files > 0),
    worlds: info.instances.some((i) => i.worlds.length > 0),
    servers: info.servers.length > 0,
    media: info.instances.some((i) => i.media.files > 0),
    settings: info.settings,
  };
  // Los ajustes pisan los de esta PC: hay que pedirlos a propósito
  const chosen = { instances: present.instances, worlds: present.worlds, servers: present.servers, media: present.media, settings: false };
  const body = h('div', { class: 'dt-stack' });
  const need = h('div', { class: 'dt-totals', 'aria-live': 'polite' });
  const go = h('button', { class: 'btn primary', type: 'button' }, icon('download'), T('importOk'));
  const cancelBtn = h('button', { class: 'btn ghost', type: 'button', onclick: () => m.close() }, T('cancel'));
  const m = modal({ title: T('importTitle'), icon: 'download', size: 'wide', body, footer: [cancelBtn, go] });

  const neededNow = () => CATEGORIES.reduce((a, c) => a + (chosen[c.id] ? sizes[c.id] : 0), 0);
  const refresh = () => {
    const needed = neededNow();
    const short = info.free !== null && needed * 1.02 > info.free;
    mount(need, short ? h('span', { class: 'dt-short' }, icon('alert'), T('importNoSpace', { size: fmtBytes(needed), free: fmtBytes(info.free) })) : info.free !== null ? T('importSpace', { size: fmtBytes(needed), free: fmtBytes(info.free) }) : T('exportTotalNoFree', { size: fmtBytes(needed) }));
    go.disabled = short || !CATEGORIES.some((c) => chosen[c.id] && present[c.id]);
    const renames = [...(chosen.instances ? info.instances : []), ...(chosen.servers ? info.servers : [])].filter((x) => x.renamed);
    mount(renameBox, renames.length ? note('info', 'info', T('importRenames', { names: renames.slice(0, 4).map((x) => `${x.name} → ${x.finalName}`).join(' · ') })) : null);
  };

  const renameBox = h('div', {});
  mount(
    body,
    h('p', { class: 'text-2' }, T('importFrom', { date: fmtDate(info.createdAt), version: info.appVersion || '?' })),
    h(
      'div',
      { class: 'dt-cats' },
      CATEGORIES.filter((c) => present[c.id]).map((c) =>
        checkRow({
          id: `imp-${c.id}`,
          iconName: c.icon,
          title: T(`cat_${c.id}`),
          sub: c.id === 'settings' ? T('importSettingsSub') : [T(`importCount_${c.id}`, { count: c.id === 'instances' ? info.instances.length : c.id === 'worlds' ? info.instances.reduce((a, i) => a + i.worlds.length, 0) : c.id === 'servers' ? info.servers.length : info.instances.reduce((a, i) => a + i.media.files, 0) }), fmtBytes(sizes[c.id])].join(' · '),
          checked: chosen[c.id],
          onChange: (v) => {
            chosen[c.id] = v;
            refresh();
          },
        }),
      ),
    ),
    need,
    renameBox,
    info.dropped ? note('warn', 'alert', T('importDropped', { count: info.dropped })) : null,
    note('info', 'shieldCheck', T('importSafety')),
    present.instances || present.servers ? note('warn', 'alert', T('importTrust')) : null,
  );
  refresh();

  go.addEventListener('click', async () => {
    if (chosen.settings && !(await confirmDialog(T('importSettingsTitle'), T('importSettingsText'), { okText: T('importSettingsOk'), danger: true }))) return;
    const prog = progressPanel();
    mount(body, h('p', { class: 'text-2' }, T('importWorking')), prog.el);
    go.disabled = true;
    cancelBtn.disabled = true;
    let res;
    try {
      res = await api.invoke('portability:import', info.token, { ...chosen });
    } catch (err) {
      prog.destroy();
      m.close();
      if (isCancel(err)) toast('info', T('importCancelled'), T('importCancelledText'), 5000);
      else fail(T('importFailed'), err);
      return;
    }
    prog.destroy();
    m.close();
    if (res.settings) store.refreshSettings().catch(() => {});
    store.refreshInstances().catch(() => {});
    showImported(res);
  });
}

function showImported(res) {
  const line = (ic, text) => h('div', { class: 'dt-line' }, icon(ic), h('span', {}, text));
  const renamed = [...res.instances, ...res.servers].filter((x) => x.renamedFrom).length + res.worlds.filter((w) => w.renamedFrom).length;
  const m = modal({
    title: T('importDone'),
    icon: 'check',
    size: 'sm',
    body: h(
      'div',
      { class: 'dt-stack' },
      h(
        'div',
        { class: 'dt-lines' },
        res.instances.length ? line('layers', T('importCount_instances', { count: res.instances.length })) : null,
        res.worlds.length ? line('globe', T('importCount_worlds', { count: res.worlds.length })) : null,
        res.servers.length ? line('server', T('importCount_servers', { count: res.servers.length })) : null,
        res.media ? line('camera', T('importCount_media', { count: res.media })) : null,
        res.settings ? line('palette', T('importSettingsApplied')) : null,
      ),
      renamed ? note('info', 'info', T('importRenamedDone', { count: renamed })) : null,
      res.skipped.length ? note('warn', 'alert', T('importSkipped', { names: res.skipped.slice(0, 3).map((x) => x.name).join(', ') })) : null,
      res.servers.length ? h('p', { class: 'small muted' }, T('importServerNote')) : null,
    ),
    footer: [h('button', { class: 'btn primary', type: 'button', onclick: () => m.close() }, T('close'))],
  });
}

export function portabilityCard() {
  const importBtn = h('button', { class: 'btn', type: 'button' }, icon('download'), T('importBtn'));
  importBtn.addEventListener('click', () => pickImport(importBtn));
  return card(
    { title: T('portTitle'), iconName: 'package', sub: T('portSub'), anchor: 'portability-card' },
    h('div', { class: 'dt-actions' }, h('button', { class: 'btn', type: 'button', onclick: () => openExport() }, icon('upload'), T('exportBtn')), importBtn),
    h('p', { class: 'small muted' }, T('portNote')),
  );
}
