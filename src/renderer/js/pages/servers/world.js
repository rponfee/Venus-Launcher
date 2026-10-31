// Mundo del servidor: informacion, importar desde una instancia, copias de seguridad (crear, restaurar,
// borrar), regenerar y data packs.
import { h, icon, mount, modal, fail, ok, confirmDialog, loading, emptyState, switchEl, selectEl, copyText, fmtBytes, fmtAgo, fmtDate, fmtTime, instanceIcon, skeleton, setBusy } from '../../ui.js';
import { store, api } from '../../store.js';
import { t } from '../../i18n.js';
import { levelTypeOptions } from './create.js';
import { failUnlessTask } from './common.js';

const cardSkeleton = (lines = 3) => h('div', { class: 'card' }, skeleton('card', { lines }));

export function worldTab(container, ctx) {
  const srv = ctx.srv;
  const infoBox = h('div');
  const backupsBox = h('div');
  const packsBox = h('div');
  let info = null;
  const offline = () => ctx.state() === 'offline';

  const kv = (k, v, extra) => h('div', { class: 'sv-kv' }, h('span', { class: 'sv-kv-k' }, k), v instanceof Node ? v : h('span', { class: 'sv-kv-v selectable' }, v ?? '—'), extra || null);

  function drawInfo() {
    const busyTip = offline() ? null : t('server.stopFirstHint');
    const exists = Boolean(info?.exists);
    const canBackup = exists && ['offline', 'online'].includes(ctx.state());
    // Sin mundo todavia, la unica accion es importar uno (copia y regenerar no aplican).
    // Con mundo: Hacer copia es la principal y Regenerar (peligro) queda separado a la derecha.
    const actions = h(
      'div',
      { class: 'sv-world-actions' },
      exists ? h('button', { class: canBackup ? 'btn primary' : 'btn', disabled: !canBackup, onclick: backupNow }, icon('archive'), t('server.backupNow')) : null,
      h('button', { class: exists ? 'btn' : 'btn primary', disabled: !offline(), title: busyTip, onclick: importDialog }, icon('download'), t('server.importWorld')),
      exists ? h('button', { class: 'btn danger sv-push', disabled: !offline(), title: busyTip, onclick: regenerateDialog }, icon('refresh'), t('server.regenerate')) : null,
    );
    if (!info) {
      mount(infoBox, cardSkeleton(4));
      return;
    }
    mount(
      infoBox,
      h(
        'div',
        { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', { class: 'card-title' }, icon('globe'), t('server.worldTitle', { name: info.levelName })), h('button', { class: 'icon-btn sm', title: t('common.openFolder'), 'aria-label': t('common.openFolder'), onclick: () => api.invoke('servers:openPath', srv.id, 'world').catch((e) => fail(t('common.error'), e)) }, icon('folderOpen'))),
        info.exists
          ? h(
              'div',
              { class: 'sv-kvs' },
              kv(t('server.worldSeed'), info.seed, info.seed ? h('button', { class: 'icon-btn sm', title: t('common.copy'), 'aria-label': `${t('common.copy')}: ${t('server.worldSeed')}`, onclick: () => copyText(info.seed) }, icon('copy')) : null),
              kv(t('server.worldVersion'), info.version),
              kv(t('server.worldSize'), fmtBytes(info.size)),
              kv(t('server.worldPlayed'), info.lastPlayed ? fmtAgo(info.lastPlayed) : null),
              kv(t('server.worldDims'), h('span', { class: 'sv-kv-badges' }, ['overworld', 'nether', 'end'].map((d) => h('span', { class: ['badge', info.dims.includes(d) ? 'good' : ''], title: info.dims.includes(d) ? null : t('server.dimMissing') }, info.dims.includes(d) ? icon('check') : icon('x'), t(`server.dim_${d}`))))),
            )
          : h('div', { class: 'sv-mini-empty' }, icon('mountain'), h('span', {}, t('server.worldNotYet'))),
        ctx.state() !== 'offline' ? h('div', { class: 'sv-hint' }, icon('info'), t('server.worldRunningHint')) : null,
        actions,
      ),
    );
  }

  async function backupNow(e) {
    const done = setBusy(e.currentTarget);
    try {
      const b = await api.invoke('servers:backupWorld', srv.id);
      ok(t('server.backupDone'), `${b.name} · ${fmtBytes(b.size)}`);
      loadBackups();
    } catch (err) {
      failUnlessTask(store, t('server.errBackup'), err);
    } finally {
      done();
    }
  }

  async function importDialog() {
    const insts = store.instances.length ? store.instances : await store.refreshInstances().catch(() => []);
    let pickInst = null;
    let worlds = [];
    let pickWorld = null;
    const bodyEl = h('div', { class: 'stack' });
    const goBtn = h('button', { class: 'btn primary', disabled: true }, icon('download'), t('server.importDo'));
    const drawBody = async () => {
      if (!pickInst) {
        mount(
          bodyEl,
          h('p', { class: 'text-2 sv-dialog-text' }, t('server.importIntro')),
          insts.length
            ? h(
                'div',
                { class: 'sv-inst-grid' },
                insts.map((inst) =>
                  h(
                    'button',
                    {
                      class: 'sv-inst',
                      onclick: async () => {
                        pickInst = inst;
                        mount(bodyEl, loading());
                        worlds = await api.instances.content(inst.id, 'saves').catch(() => []);
                        drawBody();
                      },
                    },
                    instanceIcon(inst),
                    h('span', { class: 'sv-inst-main' }, h('span', { class: 'sv-inst-name ellipsis', title: inst.name }, inst.name), h('span', { class: 'sv-inst-sub' }, `${inst.loader} · ${inst.mcVersion}`)),
                    icon('chevronRight'),
                  ),
                ),
              )
            : emptyState('layers', t('server.importNoInstances')),
        );
        return;
      }
      mount(
        bodyEl,
        h('div', { class: 'row sv-import-back' }, h('button', { class: 'btn sm ghost', onclick: () => ((pickInst = null), (pickWorld = null), (goBtn.disabled = true), drawBody()) }, icon('chevronLeft'), t('common.back')), h('strong', { class: 'ellipsis', title: pickInst.name }, pickInst.name)),
        pickInst.mcVersion !== srv.mcVersion ? h('div', { class: 'notice' }, icon('alert'), t('server.importVersionWarn', { a: pickInst.mcVersion, b: srv.mcVersion })) : null,
        worlds.length
          ? h(
              'div',
              { class: 'list sv-world-pick', role: 'radiogroup' },
              worlds.map((w) =>
                h(
                  'button',
                  {
                    class: ['list-item', pickWorld === w.name && 'active'],
                    role: 'radio',
                    'aria-checked': pickWorld === w.name ? 'true' : 'false',
                    onclick: () => {
                      pickWorld = w.name;
                      goBtn.disabled = false;
                      drawBody();
                    },
                  },
                  h('div', { class: 'li-icon' }, w.icon ? h('img', { src: encodeURI(`file:///${w.icon.replace(/\\/g, '/')}`).replace(/#/g, '%23'), alt: '' }) : icon('globe')),
                  h('div', { class: 'li-main' }, h('div', { class: 'li-title' }, w.name), h('div', { class: 'li-sub' }, t('server.playedAgo', { when: fmtAgo(w.lastPlayed) }))),
                  pickWorld === w.name ? icon('check') : null,
                ),
              ),
            )
          : emptyState('globe', t('server.importNoWorlds')),
        info?.exists ? h('div', { class: 'notice' }, icon('alert'), t('server.importReplaceWarn')) : null,
      );
    };
    goBtn.addEventListener('click', async () => {
      if (!pickInst || !pickWorld) return;
      if (info?.exists && !(await confirmDialog(t('server.importWorld'), t('server.importReplaceConfirm', { name: info.levelName }), { danger: true, okText: t('server.importDo') }))) return;
      const release = setBusy(goBtn);
      try {
        info = await api.invoke('servers:importWorld', srv.id, pickInst.id, pickWorld, { replace: true });
        m.close();
        ok(t('server.importDone'), pickWorld);
        drawInfo();
        loadPacks();
      } catch (err) {
        release();
        failUnlessTask(store, t('server.errImport'), err);
      }
    });
    const m = modal({ title: t('server.importWorld'), body: bodyEl, footer: [h('button', { class: 'btn ghost', onclick: () => m.close() }, t('common.cancel')), goBtn] });
    m.el.classList.add('sv-modal');
    drawBody();
  }

  async function regenerateDialog() {
    let props = {};
    try {
      props = await api.servers.properties(srv.id);
    } catch {
      props = {};
    }
    const seed = h('input', { class: 'input', id: 'sv-regen-seed', value: '', placeholder: t('server.regenSeedPlaceholder'), 'aria-describedby': 'sv-regen-seed-help' });
    let levelType = props['level-type'] || '';
    let backupFirst = true;
    const goBtn = h('button', { class: 'btn danger' }, icon('refresh'), t('server.regenDo'));
    const typeSel = selectEl([...levelTypeOptions(srv.mcVersion), ...(levelType && !levelTypeOptions(srv.mcVersion).some((o) => o.value === levelType) ? [{ value: levelType, label: levelType }] : [])], levelType || levelTypeOptions(srv.mcVersion)[0].value, (v) => (levelType = v));
    typeSel.id = 'sv-regen-type';
    const m = modal({
      title: t('server.regenerate'),
      body: h(
        'div',
        { class: 'stack' },
        h('div', { class: 'notice bad' }, icon('alert'), t('server.regenWarn', { name: info.levelName })),
        h('div', { class: 'field' }, h('label', { for: 'sv-regen-seed' }, t('server.regenSeed')), seed, h('div', { class: 'field-help', id: 'sv-regen-seed-help' }, t('server.regenSeedHint'))),
        h('div', { class: 'field' }, h('label', { for: 'sv-regen-type' }, t('servers.wzLevelType')), typeSel),
        h('div', { class: 'toggle-row' }, h('div', { class: 'tr-text' }, h('div', { class: 'tr-title' }, t('server.regenBackup')), h('div', { class: 'tr-sub' }, t('server.regenBackupHint'))), switchEl(backupFirst, (v) => (backupFirst = v), t('server.regenBackup'))),
      ),
      footer: [h('button', { class: 'btn ghost', onclick: () => m.close() }, t('common.cancel')), goBtn],
    });
    m.el.classList.add('sv-modal');
    goBtn.addEventListener('click', async () => {
      const release = setBusy(goBtn);
      try {
        if (backupFirst) await api.invoke('servers:backupWorld', srv.id);
        info = await api.invoke('servers:regenerateWorld', srv.id, { seed: seed.value, levelType });
        m.close();
        ok(t('server.regenDone'), t('server.regenDoneText'));
        drawInfo();
        loadBackups();
        loadPacks();
      } catch (err) {
        release();
        fail(t('server.errRegen'), err);
      }
    });
  }

  async function loadBackups() {
    let list = [];
    try {
      list = await api.invoke('servers:backups', srv.id);
    } catch (err) {
      mount(backupsBox, h('div', { class: 'card' }, h('div', { class: 'notice bad sv-error' }, icon('alert'), h('div', {}, h('strong', {}, t('server.loadError')), h('div', {}, err.message)), h('button', { class: 'btn sm', onclick: () => (mount(backupsBox, cardSkeleton()), loadBackups()) }, icon('refresh'), t('common.retry')))));
      return;
    }
    const total = list.reduce((a, b) => a + b.size, 0);
    mount(
      backupsBox,
      h(
        'div',
        { class: 'card' },
        h(
          'div',
          { class: 'card-head' },
          h('h2', { class: 'card-title' }, icon('archive'), t('server.backupsTitle'), h('span', { class: 'badge' }, String(list.length))),
          h('div', { class: 'row' }, list.length ? h('span', { class: 'tiny muted' }, fmtBytes(total)) : null, h('button', { class: 'icon-btn sm', title: t('common.openFolder'), 'aria-label': t('common.openFolder'), onclick: () => api.invoke('servers:openPath', srv.id, 'backups').catch((e) => fail(t('common.error'), e)) }, icon('folderOpen'))),
        ),
        list.length
          ? h(
              'div',
              { class: 'list sv-entries' },
              list.map((b) =>
                h(
                  'div',
                  { class: 'list-item' },
                  h('div', { class: 'li-icon' }, icon(b.auto ? 'clock' : 'archive')),
                  h('div', { class: 'li-main' }, h('div', { class: 'li-title' }, `${fmtDate(b.time)} · ${fmtTime(b.time)}`, b.auto ? h('span', { class: 'badge' }, t('server.backupAuto')) : null), h('div', { class: 'li-sub', title: b.name }, `${fmtBytes(b.size)} · ${b.name}`)),
                  h(
                    'button',
                    {
                      class: 'btn sm',
                      disabled: !offline(),
                      title: offline() ? t('server.restore') : t('server.stopFirstHint'),
                      onclick: async (e) => {
                        const btn = e.currentTarget;
                        if (!(await confirmDialog(t('server.restore'), t('server.restoreConfirm', { date: `${fmtDate(b.time)} ${fmtTime(b.time)}` }), { danger: true, okText: t('server.restore') }))) return;
                        const release = setBusy(btn);
                        try {
                          info = await api.invoke('servers:restoreBackup', srv.id, b.name);
                          ok(t('server.restoreDone'));
                          drawInfo();
                          loadPacks();
                        } catch (err) {
                          failUnlessTask(store, t('server.errRestore'), err);
                        } finally {
                          release();
                        }
                      },
                    },
                    icon('undo'),
                    t('server.restore'),
                  ),
                  h(
                    'button',
                    {
                      class: 'icon-btn sm danger',
                      title: t('common.delete'),
                      'aria-label': t('common.delete'),
                      onclick: async () => {
                        if (!(await confirmDialog(t('server.deleteBackup'), t('server.deleteBackupConfirm', { name: b.name }), { danger: true, okText: t('common.delete') }))) return;
                        await api.invoke('servers:deleteBackup', srv.id, b.name).catch((e) => fail(t('common.error'), e));
                        loadBackups();
                      },
                    },
                    icon('trash'),
                  ),
                ),
              ),
            )
          : h('div', { class: 'sv-mini-empty' }, icon('archive'), h('span', {}, t('server.noBackups'))),
        h('div', { class: 'sv-hint' }, t('server.backupsHint')),
      ),
    );
  }

  async function loadPacks() {
    let packs = [];
    try {
      packs = await api.invoke('servers:datapacks', srv.id);
    } catch (err) {
      packs = [];
    }
    const add = async () => {
      const files = await api.app.selectFiles({ multi: true, filters: [{ name: 'Data packs', extensions: ['zip'] }] }).catch(() => []);
      if (!files?.length) return;
      try {
        const added = await api.invoke('servers:addDatapacks', srv.id, files);
        ok(t('server.packsAdded', { count: added.length }));
        loadPacks();
      } catch (err) {
        fail(t('server.errPacks'), err);
      }
    };
    mount(
      packsBox,
      h(
        'div',
        { class: 'card' },
        h(
          'div',
          { class: 'card-head' },
          h('h2', { class: 'card-title' }, icon('package'), t('server.packsTitle'), h('span', { class: 'badge' }, String(packs.length))),
          h('div', { class: 'row' }, h('button', { class: 'btn sm', disabled: !info?.exists, onclick: add }, icon('plus'), t('server.packsAdd')), h('button', { class: 'icon-btn sm', title: t('common.openFolder'), 'aria-label': t('common.openFolder'), disabled: !info?.exists, onclick: () => api.invoke('servers:openPath', srv.id, 'datapacks').catch((e) => fail(t('common.error'), e)) }, icon('folderOpen'))),
        ),
        packs.length
          ? h(
              'div',
              { class: 'list sv-entries' },
              packs.map((p) =>
                h(
                  'div',
                  { class: ['list-item', !p.enabled && 'disabled'] },
                  h('div', { class: 'li-icon' }, icon(p.isDir ? 'folder' : 'package')),
                  h('div', { class: 'li-main' }, h('div', { class: 'li-title' }, p.name), h('div', { class: 'li-sub', title: p.description }, [p.description, fmtBytes(p.size)].filter(Boolean).join(' · '))),
                  switchEl(p.enabled, async (v) => {
                    try {
                      await api.invoke('servers:toggleDatapack', srv.id, p.name, v);
                      loadPacks();
                    } catch (err) {
                      fail(t('server.errPacks'), err);
                    }
                  }, t('server.packToggle', { name: p.name })),
                  h(
                    'button',
                    {
                      class: 'icon-btn sm danger',
                      title: t('common.delete'),
                      'aria-label': t('common.delete'),
                      onclick: async () => {
                        if (!(await confirmDialog(t('server.packDelete'), t('server.packDeleteConfirm', { name: p.name }), { danger: true, okText: t('common.delete') }))) return;
                        await api.invoke('servers:removeDatapack', srv.id, p.name).catch((e) => fail(t('common.error'), e));
                        loadPacks();
                      },
                    },
                    icon('trash'),
                  ),
                ),
              ),
            )
          : h('div', { class: 'sv-mini-empty' }, icon('package'), h('span', {}, info?.exists ? t('server.noPacks') : t('server.packsNoWorld'))),
        h('div', { class: 'sv-hint' }, ctx.state() === 'offline' ? t('server.packsHintOff') : t('server.packsHintOn')),
      ),
    );
  }

  async function loadInfo() {
    try {
      info = await api.invoke('servers:worldInfo', srv.id);
    } catch (err) {
      mount(infoBox, h('div', { class: 'card' }, h('div', { class: 'notice bad sv-error' }, icon('alert'), h('div', {}, h('strong', {}, t('server.loadError')), h('div', {}, err.message)), h('button', { class: 'btn sm', onclick: () => (mount(infoBox, cardSkeleton(4)), loadInfo()) }, icon('refresh'), t('common.retry')))));
      return;
    }
    drawInfo();
    loadPacks();
  }

  mount(container, h('div', { class: 'stack' }, h('div', { class: 'sv-two-col' }, infoBox, backupsBox), packsBox));
  mount(backupsBox, cardSkeleton());
  mount(packsBox, cardSkeleton(2));
  drawInfo();
  loadInfo();
  loadBackups();
  let last = ctx.state();
  const offState = ctx.on('state', () => {
    const now = ctx.state();
    if (now !== last) {
      last = now;
      loadInfo();
      loadBackups();
    }
  });
  return () => offState();
}
