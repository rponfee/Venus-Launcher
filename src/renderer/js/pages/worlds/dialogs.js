// Dialogos de la pagina de Mundos: copiar a otra instancia o a un servidor, renombrar, mandar a la
// papelera (con copia previa opcional) y panel de copias de seguridad (crear, restaurar, borrar).
import { h, icon, mount, modal, ok, fail, confirmDialog, promptDialog, emptyState, fmtBytes, fmtDate, fmtAgo, instanceIcon, setBusy } from '../../ui.js';
import { store, api } from '../../store.js';
import { t } from '../../i18n.js';
import { navigate } from '../../app.js';
import { compareVersions, iconBtn, popMenu, worldRoute, errorBox, bone, skelGroup, DATE_TIME } from './common.js';

// Fecha corta para las filas de copias ("26 oct 2026, 18:45"); la larga queda en el tooltip
const DATE_ROW = { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' };

// Filas vacias mientras se lee una lista
function rowsSkeleton(label, n = 3) {
  return skelGroup(label, h('div', { class: 'wo-skel-rows' }, Array.from({ length: n }, () => bone())));
}

// ---------- Copiar a... ----------
export async function openCopyDialog(w, { onDone } = {}) {
  let targets = null;
  let mode = 'instance';
  let pick = null; // { kind, id }
  let replace = false;
  let player = true;
  const body = h('div', { class: 'stack wo-copy' });
  const copyBtn = h('button', { class: 'btn primary', type: 'button', disabled: true }, icon('copy'), t('worlds.copyAction'));
  const m = modal({
    title: t('worlds.copyTitle', { name: w.name }),
    size: 'wide',
    body,
    footer: [h('button', { class: 'btn ghost', type: 'button', onclick: () => m.close() }, t('worlds.cancel')), copyBtn],
  });
  mount(body, rowsSkeleton(t('worlds.loadingTargets')));
  try {
    targets = await api.invoke('worlds:copyTargets', w.instanceId, w.folder);
  } catch (err) {
    mount(body, errorBox(err));
    return;
  }

  const seg = (id, ic, label) =>
    h(
      'button',
      {
        type: 'button',
        class: mode === id ? 'active' : '',
        'aria-pressed': String(mode === id),
        onclick: () => {
          mode = id;
          pick = null;
          replace = false;
          draw();
        },
      },
      icon(ic),
      label,
    );

  function versionWarn(target) {
    const c = compareVersions(w.version, target);
    if (c === null || c <= 0) return null;
    return h('span', { class: 'wo-pick-warn', title: t('worlds.newerWorldHint', { world: w.version, target }) }, icon('alert'), t('worlds.newerWorld'));
  }

  function row({ kind, id, iconEl, title, sub, extra, disabled, reason }) {
    const selected = pick?.kind === kind && pick.id === id;
    return h(
      'button',
      {
        type: 'button',
        role: 'radio',
        'aria-checked': String(selected),
        class: ['wo-pick', selected && 'active', disabled && 'disabled'],
        disabled,
        title: reason || null,
        dataset: { kind, id },
        onclick: () => choose(kind, id),
      },
      iconEl,
      h('span', { class: 'wo-pick-main' }, h('span', { class: 'wo-pick-title', title }, title), h('span', { class: 'wo-pick-sub' }, sub)),
      extra || null,
      disabled && reason ? h('span', { class: 'badge' }, reason) : selected ? h('span', { class: 'wo-pick-check', 'aria-hidden': 'true' }, icon('check')) : null,
    );
  }

  function choose(kind, id, focus = true) {
    pick = { kind, id };
    replace = false;
    draw();
    if (focus) body.querySelector(`.wo-pick[data-kind="${kind}"][data-id="${CSS.escape(id)}"]`)?.focus();
  }

  // Grupo de opciones: una sola parada de Tab y las flechas cambian la eleccion (patron de radio)
  function rovingKeys(group) {
    const radios = [...group.querySelectorAll('.wo-pick:not(:disabled)')];
    if (!radios.length) return;
    const current = radios.find((r) => r.getAttribute('aria-checked') === 'true') || radios[0];
    radios.forEach((r) => r.setAttribute('tabindex', r === current ? '0' : '-1'));
    group.addEventListener('keydown', (e) => {
      const i = radios.indexOf(document.activeElement);
      if (i < 0) return;
      let next = null;
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = radios[(i + 1) % radios.length];
      else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = radios[(i - 1 + radios.length) % radios.length];
      else if (e.key === 'Home') next = radios[0];
      else if (e.key === 'End') next = radios.at(-1);
      if (!next) return;
      e.preventDefault();
      choose(next.dataset.kind, next.dataset.id);
    });
  }

  function draw() {
    let list;
    if (mode === 'instance') {
      list = targets.instances.length
        ? targets.instances.map((i) =>
            row({
              kind: 'instance',
              id: i.id,
              iconEl: instanceIcon(store.instances.find((x) => x.id === i.id) || i, 'wo-pick-icon'),
              title: i.name,
              sub: i.same ? t('worlds.sameInstance', { version: i.mcVersion }) : t('worlds.minecraftVersion', { version: i.mcVersion }),
              extra: versionWarn(i.mcVersion),
            }),
          )
        : [emptyState('layers', t('worlds.noOtherInstances'), t('worlds.noOtherInstancesText'), h('button', { class: 'btn', type: 'button', onclick: () => (m.close(), navigate('versions/new')) }, icon('plus'), t('worlds.createInstance')))];
    } else {
      list = targets.servers.length
        ? targets.servers.map((s) =>
            row({
              kind: 'server',
              id: s.id,
              iconEl: h('span', { class: 'wo-pick-icon wo-srv-icon' }, icon('server')),
              title: s.name,
              sub: s.hasWorld ? t('worlds.serverHasWorld', { version: s.mcVersion || '?', level: s.level }) : t('worlds.serverEmpty', { version: s.mcVersion || '?' }),
              extra: versionWarn(s.mcVersion),
              disabled: s.proxy || s.state !== 'offline',
              reason: s.proxy ? t('worlds.serverProxy') : s.state !== 'offline' ? t('worlds.serverRunning') : null,
            }),
          )
        : [emptyState('server', t('worlds.noServers'), t('worlds.noServersText'), h('button', { class: 'btn', type: 'button', onclick: () => (m.close(), navigate('servers')) }, icon('plus'), t('worlds.createServer')))];
    }
    const server = pick?.kind === 'server' ? targets.servers.find((s) => s.id === pick.id) : null;
    const inst = pick?.kind === 'instance' ? targets.instances.find((i) => i.id === pick.id) : null;
    const options = [];
    if (server?.hasWorld) {
      const cb = h('input', { type: 'checkbox', checked: replace });
      cb.addEventListener('change', () => {
        replace = cb.checked;
        updateBtn();
      });
      options.push(h('label', { class: 'wo-check bad' }, cb, h('span', {}, t('worlds.replaceServerWorld', { level: server.level }))));
    }
    if (server) {
      const cb = h('input', { type: 'checkbox', checked: player });
      cb.addEventListener('change', () => (player = cb.checked));
      const acc = store.selectedAccount();
      options.push(h('label', { class: 'wo-check' }, cb, h('span', {}, acc ? t('worlds.copyPlayerData', { name: acc.name }) : t('worlds.copyPlayerDataNoAccount'))));
    }
    if (inst?.running) options.push(h('div', { class: 'notice info' }, icon('info'), h('span', {}, t('worlds.targetRunning'))));
    const group = h('div', { class: 'wo-picks', role: 'radiogroup', 'aria-label': mode === 'instance' ? t('worlds.toInstance') : t('worlds.toServer') }, list);
    mount(
      body,
      h('div', { class: 'segmented wo-seg', role: 'group', 'aria-label': t('worlds.copyKind') }, seg('instance', 'layers', t('worlds.toInstance')), seg('server', 'server', t('worlds.toServer'))),
      group,
      options.length ? h('div', { class: 'stack wo-copy-opts' }, options) : null,
      h('p', { class: 'wo-note' }, mode === 'instance' ? t('worlds.copyInstanceHint') : t('worlds.copyServerHint')),
    );
    rovingKeys(group);
    updateBtn();
  }

  function updateBtn() {
    const server = pick?.kind === 'server' ? targets.servers.find((s) => s.id === pick.id) : null;
    copyBtn.disabled = !pick || (server && server.hasWorld && !replace);
  }

  copyBtn.addEventListener('click', async () => {
    if (!pick) return;
    const done = setBusy(copyBtn);
    try {
      const res = await api.invoke('worlds:copy', w.instanceId, w.folder, pick.kind === 'instance' ? { instanceId: pick.id } : { serverId: pick.id, replace, player });
      m.close();
      if (res.kind === 'instance') {
        ok(t('worlds.copiedTo', { target: res.instanceName }), res.skipped ? t('worlds.copySkipped', { count: res.skipped }) : res.folder);
      } else {
        ok(t('worlds.copiedTo', { target: res.serverName }), res.player ? t('worlds.copiedPlayer') : null);
      }
      onDone?.(res);
    } catch (err) {
      done();
      updateBtn();
      if (!/cancel/i.test(err.message)) fail(t('worlds.copyFailed'), err);
    }
  });
  draw();
}

// ---------- Renombrar ----------
export async function renameWorld(w) {
  if (w.playing || w.open) return fail(t('worlds.renameFailed'), t('worlds.worldOpenHint'));
  const name = await promptDialog(t('worlds.renameTitle'), t('worlds.renameLabel'), { value: w.name, okText: t('worlds.rename'), hint: t('worlds.renameHint') });
  if (name === null || name === undefined || name === w.name) return null;
  if (!name.trim()) return fail(t('worlds.renameFailed'), t('worlds.renameEmpty'));
  try {
    const res = await api.invoke('worlds:rename', w.instanceId, w.folder, name);
    ok(t('worlds.renamed'), res.name);
    return res.name;
  } catch (err) {
    fail(t('worlds.renameFailed'), err);
    return null;
  }
}

// ---------- Mandar a la papelera ----------
export function deleteWorld(w) {
  return new Promise((resolve) => {
    if (w.playing || w.open) {
      fail(t('worlds.deleteFailed'), t('worlds.worldOpenHint'));
      resolve(false);
      return;
    }
    let done = false;
    const cb = h('input', { type: 'checkbox', checked: true });
    const confirmBtn = h('button', { class: 'btn danger', type: 'button' }, icon('trash'), t('worlds.moveToTrash'));
    const finish = (v) => {
      if (done) return;
      done = true;
      m.close();
      resolve(v);
    };
    const m = modal({
      title: t('worlds.deleteTitle'),
      size: 'sm',
      body: h('div', { class: 'stack' }, h('p', { class: 'wo-text' }, t('worlds.deleteText', { name: w.name, instance: w.instanceName })), h('label', { class: 'wo-check' }, cb, h('span', {}, t('worlds.deleteBackupFirst')))),
      footer: [h('button', { class: 'btn ghost', type: 'button', onclick: () => finish(false) }, t('worlds.cancel')), confirmBtn],
      onClose: () => finish(false),
    });
    confirmBtn.addEventListener('click', async () => {
      const release = setBusy(confirmBtn);
      cb.disabled = true;
      try {
        if (cb.checked) await api.invoke('worlds:backup', w.instanceId, w.folder);
        await api.invoke('worlds:delete', w.instanceId, w.folder);
        ok(t('worlds.deleted'), cb.checked ? t('worlds.deletedWithBackup') : t('worlds.deletedText'));
        finish(true);
      } catch (err) {
        fail(t('worlds.deleteFailed'), err);
        cb.disabled = false;
        release();
      }
    });
  });
}

// ---------- Copias de seguridad ----------
export function backupsPanel(w, { isAlive = () => true, onRestored } = {}) {
  const listBox = h('div', { class: 'wo-backups' });
  const createBtn = h('button', { class: 'btn sm', type: 'button' }, icon('archive'), t('worlds.backupNow'));
  const totalBox = h('span', { class: 'card-sub' });
  let busy = false;

  async function load() {
    let list;
    try {
      list = await api.invoke('worlds:backups', w.instanceId, w.folder);
    } catch (err) {
      if (isAlive()) mount(listBox, errorBox(err, load));
      return;
    }
    if (!isAlive()) return;
    mount(totalBox, list.length ? t('worlds.backupsTotal', { count: list.length, size: fmtBytes(list.reduce((a, b) => a + b.size, 0)) }) : '');
    if (!list.length) {
      mount(listBox, emptyState('archive', t('worlds.noBackups'), t('worlds.noBackupsText')));
      return;
    }
    mount(
      listBox,
      h(
        'ul',
        { class: 'wo-backup-list' },
        list.map((b, i) => {
          const restoreBtn = h('button', { class: 'btn sm', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, icon('undo'), t('worlds.restore'), icon('chevronDown'));
          restoreBtn.addEventListener('click', () =>
            popMenu(restoreBtn, [
              { icon: 'copy', label: t('worlds.restoreAsCopy'), run: () => restore(b, 'copy') },
              { icon: 'refresh', label: t('worlds.restoreReplace'), danger: true, run: () => restore(b, 'replace') },
            ]),
          );
          return h(
            'li',
            { class: 'wo-backup' },
            h('span', { class: 'wo-backup-icon', 'aria-hidden': 'true' }, icon('archive')),
            h(
              'div',
              { class: 'wo-backup-main' },
              h('div', { class: 'wo-backup-title' }, h('span', { class: 'ellipsis', title: fmtDate(b.time, DATE_TIME) }, fmtDate(b.time, DATE_ROW)), i === 0 ? h('span', { class: 'badge accent' }, t('worlds.latest')) : null),
              h('div', { class: 'wo-backup-sub' }, `${fmtBytes(b.size)} · ${fmtAgo(b.time)}`),
            ),
            restoreBtn,
            iconBtn('folderOpen', t('worlds.showInFolder'), () => api.invoke('worlds:showBackup', b.path).catch((err) => fail(t('worlds.openFailed'), err))),
            iconBtn(
              'trash',
              t('worlds.deleteBackup'),
              async () => {
                if (!(await confirmDialog(t('worlds.deleteBackupTitle'), t('worlds.deleteBackupText', { date: fmtDate(b.time, DATE_TIME) }), { okText: t('worlds.moveToTrash'), danger: true }))) return;
                try {
                  await api.invoke('worlds:deleteBackup', b.path);
                  ok(t('worlds.backupDeleted'));
                } catch (err) {
                  fail(t('worlds.deleteBackupFailed'), err);
                }
                load();
              },
              'danger',
            ),
          );
        }),
      ),
    );
  }

  async function restore(b, mode) {
    if (mode === 'replace') {
      if (w.playing || w.open) return fail(t('worlds.restoreFailed'), t('worlds.worldOpenHint'));
      const yes = await confirmDialog(t('worlds.restoreReplaceTitle'), t('worlds.restoreReplaceText', { name: w.name, date: fmtDate(b.time, DATE_TIME) }), { okText: t('worlds.restore'), danger: true });
      if (!yes) return undefined;
    }
    try {
      const res = await api.invoke('worlds:restoreBackup', w.instanceId, w.folder, b.path, { mode });
      ok(t('worlds.restored'), mode === 'replace' ? t('worlds.restoredReplace') : t('worlds.restoredCopy', { folder: res.folder }));
      onRestored?.(res, mode);
      if (mode !== 'replace') navigate(worldRoute(w.instanceId, res.folder));
    } catch (err) {
      if (!/cancel/i.test(err.message)) fail(t('worlds.restoreFailed'), err);
    }
    return undefined;
  }

  createBtn.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    const done = setBusy(createBtn);
    try {
      const res = await api.invoke('worlds:backup', w.instanceId, w.folder);
      ok(t('worlds.backupDone'), res.skipped ? t('worlds.backupSkipped', { count: res.skipped }) : res.name);
    } catch (err) {
      if (!/cancel/i.test(err.message)) fail(t('worlds.backupFailed'), err);
    } finally {
      busy = false;
      done();
      if (isAlive()) load();
    }
  });

  mount(listBox, rowsSkeleton(t('worlds.loadingBackups')));
  load();
  return {
    el: h(
      'section',
      { class: 'card wo-card-pad' },
      h(
        'div',
        { class: 'card-head' },
        h('div', {}, h('h3', { class: 'card-title' }, icon('archive'), t('worlds.backupsTitle')), totalBox),
        h('div', { class: 'row' }, iconBtn('folderOpen', t('worlds.openBackupsFolder'), () => api.invoke('worlds:openBackups', w.instanceId).catch((err) => fail(t('worlds.openFailed'), err))), createBtn),
      ),
      h('p', { class: 'small muted wo-none' }, t('worlds.backupsHint')),
      listBox,
    ),
    reload: load,
  };
}

// ---------- Todas las copias (tambien las de mundos borrados) ----------
export function openAllBackups({ onRestored } = {}) {
  const body = h('div', { class: 'wo-allbk' });
  const m = modal({
    title: t('worlds.allBackupsTitle'),
    size: 'wide',
    body,
    footer: [
      h('button', { class: 'btn', type: 'button', onclick: () => api.invoke('worlds:openBackups').catch((err) => fail(t('worlds.openFailed'), err)) }, icon('folderOpen'), t('worlds.openBackupsFolder')),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn ghost', type: 'button', onclick: () => m.close() }, t('worlds.close')),
    ],
  });

  async function load() {
    mount(body, rowsSkeleton(t('worlds.loadingBackups'), 4));
    let list;
    try {
      list = await api.invoke('worlds:allBackups');
    } catch (err) {
      mount(body, errorBox(err, load));
      return;
    }
    if (!body.isConnected) return;
    if (!list.length) {
      mount(body, emptyState('archive', t('worlds.noBackups'), t('worlds.allBackupsEmptyText')));
      return;
    }
    const groups = new Map();
    for (const b of list) {
      if (!groups.has(b.instanceId)) groups.set(b.instanceId, []);
      groups.get(b.instanceId).push(b);
    }
    mount(
      body,
      h('p', { class: 'small muted wo-none' }, t('worlds.allBackupsHint')),
      [...groups].map(([instanceId, items]) => {
        const first = items[0];
        return h(
          'section',
          { class: 'wo-allbk-group' },
          h('h4', { class: 'wo-allbk-head' }, icon('layers'), h('span', { class: 'ellipsis', title: first.instanceName || instanceId }, first.instanceName || instanceId), first.instanceExists ? null : h('span', { class: 'badge warn' }, t('worlds.instanceGone'))),
          h(
            'ul',
            { class: 'wo-backup-list' },
            items.map((b) => {
              const folder = b.folder || b.name.replace(/\.zip$/i, '');
              const restoreBtn = h(
                'button',
                {
                  class: 'btn sm',
                  type: 'button',
                  disabled: !b.instanceExists,
                  title: b.instanceExists ? (b.worldExists ? t('worlds.restoreAsCopyHint') : t('worlds.restoreDeletedHint')) : t('worlds.instanceGoneHint'),
                  onclick: async () => {
                    const done = setBusy(restoreBtn);
                    try {
                      const res = await api.invoke('worlds:restoreBackup', b.instanceId, folder, b.path, { mode: 'copy' });
                      ok(t('worlds.restored'), t('worlds.restoredCopy', { folder: res.folder }));
                      m.close();
                      onRestored?.(res);
                      navigate(worldRoute(b.instanceId, res.folder));
                    } catch (err) {
                      done();
                      if (!/cancel/i.test(err.message)) fail(t('worlds.restoreFailed'), err);
                    }
                  },
                },
                icon('undo'),
                t('worlds.restore'),
              );
              return h(
                'li',
                { class: 'wo-backup' },
                h('span', { class: 'wo-backup-icon', 'aria-hidden': 'true' }, icon('archive')),
                h(
                  'div',
                  { class: 'wo-backup-main' },
                  h('div', { class: 'wo-backup-title' }, h('span', { class: 'ellipsis', title: folder }, folder), b.worldExists ? null : h('span', { class: 'badge' }, t('worlds.worldDeleted'))),
                  h('div', { class: 'wo-backup-sub', title: fmtDate(b.time, DATE_TIME) }, `${fmtDate(b.time, DATE_ROW)} · ${fmtBytes(b.size)}`),
                ),
                restoreBtn,
                iconBtn('folderOpen', t('worlds.showInFolder'), () => api.invoke('worlds:showBackup', b.path).catch((err) => fail(t('worlds.openFailed'), err))),
                iconBtn(
                  'trash',
                  t('worlds.deleteBackup'),
                  async () => {
                    if (!(await confirmDialog(t('worlds.deleteBackupTitle'), t('worlds.deleteBackupText', { date: fmtDate(b.time, DATE_TIME) }), { okText: t('worlds.moveToTrash'), danger: true }))) return;
                    try {
                      await api.invoke('worlds:deleteBackup', b.path);
                      ok(t('worlds.backupDeleted'));
                    } catch (err) {
                      fail(t('worlds.deleteBackupFailed'), err);
                    }
                    load();
                  },
                  'danger',
                ),
              );
            }),
          ),
        );
      }),
    );
  }
  load();
}
