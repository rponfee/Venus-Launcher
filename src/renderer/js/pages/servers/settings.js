// Ajustes del servidor: nombre e icono, recursos (RAM, flags de Aikar, Java), automatizacion
// (iniciar con el launcher, reinicio automatico, reinicios y copias programadas), software,
// archivos de configuracion y zona de peligro.
import { h, icon, mount, modal, fail, ok, confirmDialog, switchEl, selectEl, fmtBytes, fmtAgo, debounce, skeleton, setBusy } from '../../ui.js';
import { store, api } from '../../store.js';
import { t } from '../../i18n.js';
import { navigate } from '../../app.js';
import { typeMeta, typeBadge, serverTile, tryInvoke, failUnlessTask } from './common.js';
import { ramSlider } from './create.js';

const AUTO_DEFAULTS = { autoRestart: false, autostart: false, restart: { mode: 'off', hours: 6, time: '05:00', warn: true }, backup: { mode: 'off', hours: 6, time: '04:00', keep: 5 } };

function merge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] ? merge(base[k], v) : v;
  return out;
}

function toggleRow(title, sub, checked, onChange) {
  return h('div', { class: 'toggle-row' }, h('div', { class: 'tr-text' }, h('div', { class: 'tr-title' }, title), sub ? h('div', { class: 'tr-sub' }, sub) : null), switchEl(checked, onChange, title));
}

// Editor de texto para archivos de configuracion (yml, toml, json, properties...).
export async function openFileEditor(srv, rel) {
  let file;
  try {
    file = await api.invoke('servers:readFile', srv.id, rel);
  } catch (err) {
    fail(t('server.errFile'), err);
    return;
  }
  const area = h('textarea', { class: 'textarea sv-editor', spellcheck: 'false', 'aria-label': rel });
  area.value = file.text;
  const status = h('span', { class: 'tiny muted spacer', role: 'status' }, t('server.fileSavedState'));
  let dirty = false;
  area.addEventListener('input', () => {
    dirty = true;
    status.textContent = t('server.fileDirty');
  });
  area.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      area.setRangeText('  ', area.selectionStart, area.selectionEnd, 'end');
    } else if (e.key.toLowerCase() === 's' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      save();
    }
  });
  const save = async () => {
    try {
      await api.invoke('servers:writeFile', srv.id, rel, area.value);
      dirty = false;
      status.textContent = t('server.fileSaved');
      ok(t('server.fileSaved'), rel);
    } catch (err) {
      fail(t('server.errFile'), err);
    }
  };
  // Escape, la X y el fondo piden confirmacion si hay cambios sin guardar.
  const onKeyCapture = (e) => {
    if (e.key !== 'Escape' || !dirty) return;
    e.preventDefault();
    e.stopPropagation();
    if (asking) {
      // Escape en la confirmacion = "seguir editando"
      const all = document.querySelectorAll('.modal-backdrop');
      all[all.length - 1]?.querySelector('.modal-foot .btn.ghost')?.click();
    } else close();
  };
  const m = modal({
    title: rel,
    size: 'xwide',
    body: h('div', { class: 'stack' }, h('div', { class: 'tiny muted' }, t('server.fileHint')), area),
    footer: [status, h('button', { class: 'btn ghost', onclick: () => close() }, t('common.close')), h('button', { class: 'btn primary', onclick: save }, icon('save'), t('common.save'))],
    onClose: () => document.removeEventListener('keydown', onKeyCapture, true),
  });
  m.el.classList.add('sv-modal');
  document.addEventListener('keydown', onKeyCapture, true);
  const guard = (e) => {
    if (!dirty) return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  m.el.querySelector('.modal-head .icon-btn')?.addEventListener('click', guard, true);
  m.el.parentElement?.addEventListener('mousedown', (e) => e.target === m.el.parentElement && guard(e), true);
  let asking = false;
  async function close() {
    if (asking) return;
    if (dirty) {
      asking = true;
      const discard = await confirmDialog(t('server.fileDiscardTitle'), t('server.fileDiscardText'), { okText: t('server.discard'), danger: true });
      asking = false;
      if (!discard) return;
    }
    dirty = false;
    m.close();
  }
  setTimeout(() => area.focus(), 50);
}

export function settingsTab(container, ctx) {
  let srv = ctx.srv;
  const m = typeMeta(srv.type);
  const proxy = m.kind === 'proxy';
  const identity = h('div');
  const resources = h('div');
  const automation = h('div');
  const software = h('div');
  const filesBox = h('div');
  const danger = h('div');
  let totalMb = 8192;

  const save = async (patch, msg) => {
    try {
      srv = await api.servers.update(srv.id, patch);
      ctx.refresh();
      if (msg) ok(msg);
      return true;
    } catch (err) {
      fail(t('server.errSave'), err);
      return false;
    }
  };

  async function drawIdentity() {
    const iconData = await tryInvoke('servers:icon', [srv.id], null).catch(() => null);
    const name = h('input', { class: 'input', id: 'sv-set-name', value: srv.name, maxlength: 60 });
    const commitName = async () => {
      const v = name.value.trim();
      if (v && v !== srv.name) await save({ name: v }, t('server.renamed'));
    };
    name.addEventListener('keydown', (e) => e.key === 'Enter' && name.blur());
    name.addEventListener('change', commitName);
    const pickIcon = async () => {
      const files = await api.app.selectFiles({ filters: [{ name: 'PNG / JPG', extensions: ['png', 'jpg', 'jpeg'] }] }).catch(() => []);
      if (!files?.length) return;
      try {
        await api.invoke('servers:setIcon', srv.id, files[0]);
        ok(t('server.iconSaved'));
        drawIdentity();
        ctx.refresh();
      } catch (err) {
        fail(t('server.errIcon'), err);
      }
    };
    mount(
      identity,
      h(
        'div',
        { class: 'card' },
        h('h2', { class: 'card-title' }, icon('edit'), t('server.identityTitle')),
        h(
          'div',
          { class: 'sv-identity' },
          h('button', { class: 'sv-icon-pick', title: t('server.changeIcon'), 'aria-label': t('server.changeIcon'), onclick: pickIcon }, serverTile(srv, iconData, 64), h('span', { class: 'sv-icon-edit' }, icon('image'))),
          h(
            'div',
            { class: 'stack spacer' },
            h('div', { class: 'field' }, h('label', { for: 'sv-set-name' }, t('server.serverName')), name),
            proxy
              ? null
              : h(
                  'div',
                  { class: 'row wrap' },
                  h('button', { class: 'btn sm', onclick: pickIcon }, icon('image'), iconData ? t('server.changeIcon') : t('server.setIcon')),
                  iconData
                    ? h('button', { class: 'btn sm ghost', onclick: async () => { await api.invoke('servers:removeIcon', srv.id).catch((e) => fail(t('common.error'), e)); drawIdentity(); ctx.refresh(); } }, icon('trash'), t('server.removeIcon'))
                    : null,
                  h('span', { class: 'tiny muted' }, t('server.iconHint')),
                ),
          ),
        ),
      ),
    );
  }

  function drawResources() {
    const ram = ramSlider(srv.memory?.max || 2048, totalMb, debounce((v) => save({ memory: { max: v, min: Math.min(srv.memory?.min || 1024, v) } }), 500));
    ram.input.id = 'sv-set-ram';
    const javaArgs = h('input', { class: 'input mono', id: 'sv-set-java-args', value: srv.java?.args || '', placeholder: '-XX:+UseZGC', spellcheck: 'false', 'aria-describedby': 'sv-set-java-args-help' });
    javaArgs.addEventListener('change', () => save({ java: { args: javaArgs.value.trim() } }, t('server.saved')));
    const javaPath = srv.java?.path || '';
    const pickJava = async () => {
      const files = await api.app.selectFiles({ filters: [{ name: 'Java', extensions: ['exe', ''] }] }).catch(() => []);
      if (!files?.length) return;
      const info = await api.java.test(files[0]).catch(() => null);
      if (!info) {
        fail(t('server.errJava'));
        return;
      }
      await save({ java: { path: files[0] } }, t('server.javaSet', { version: info.version }));
      drawResources();
    };
    mount(
      resources,
      h(
        'div',
        { class: 'card' },
        h('h2', { class: 'card-title' }, icon('memory'), t('server.resourcesTitle')),
        h('div', { class: 'sv-ram sv-section' }, h('div', { class: 'row' }, h('label', { class: 'label spacer', for: 'sv-set-ram' }, t('servers.wzRam')), ram.label), ram.input, ram.marks, h('div', { class: 'field-help' }, proxy ? t('servers.wzRamProxyHint') : t('server.ramHint'))),
        toggleRow(proxy ? t('server.proxyFlags') : t('server.aikarFlags'), proxy ? t('server.proxyFlagsHint') : t('server.aikarFlagsHint'), srv.flags !== 'none', (v) => save({ flags: v ? 'aikar' : 'none' })),
        h('div', { class: 'field sv-section' }, h('label', { for: 'sv-set-java-args' }, t('server.javaArgs')), javaArgs, h('div', { class: 'field-help', id: 'sv-set-java-args-help' }, t('server.javaArgsHint'))),
        h(
          'div',
          { class: 'field sv-section' },
          h('div', { class: 'label' }, t('server.javaRuntime')),
          h(
            'div',
            { class: 'row sv-java-row' },
            h('span', { class: 'kbd ellipsis spacer', title: javaPath || t('server.javaAuto', { major: srv.javaMajor || '?' }) }, javaPath || t('server.javaAuto', { major: srv.javaMajor || '?' })),
            h('button', { class: 'btn sm', onclick: pickJava }, icon('folder'), t('server.javaPick')),
            javaPath ? h('button', { class: 'btn sm ghost', onclick: async () => { await save({ java: { path: '' } }, t('server.saved')); drawResources(); } }, t('server.javaUseAuto')) : null,
          ),
        ),
      ),
    );
  }

  function scheduleRow(kind, cfg) {
    const c = cfg[kind];
    const hours = h('input', { class: 'input sv-prop-num', type: 'number', min: 1, max: 168, value: c.hours, 'aria-label': t('server.everyHours') });
    hours.addEventListener('change', () => Number(hours.value) >= 1 && save({ automation: { [kind]: { hours: Math.min(168, Math.round(Number(hours.value))) } } }, t('server.saved')));
    const time = h('input', { class: 'input sv-time', type: 'time', value: c.time, 'aria-label': t('server.atTime') });
    time.addEventListener('change', () => /^\d{2}:\d{2}$/.test(time.value) && save({ automation: { [kind]: { time: time.value } } }, t('server.saved')));
    const keep = kind === 'backup' ? h('input', { class: 'input sv-prop-num', type: 'number', min: 1, max: 100, value: c.keep, 'aria-label': t('server.keepBackups') }) : null;
    keep?.addEventListener('change', () => Number(keep.value) >= 1 && save({ automation: { backup: { keep: Math.min(100, Math.round(Number(keep.value))) } } }, t('server.saved')));
    return h(
      'div',
      { class: 'sv-schedule', dataset: { kind } },
      h('div', { class: 'tr-text' }, h('div', { class: 'tr-title' }, t(`server.schedule_${kind}`)), h('div', { class: 'tr-sub' }, t(`server.schedule_${kind}_hint`))),
      h(
        'div',
        { class: 'row wrap sv-schedule-ctl' },
        h(
          'div',
          { class: 'segmented', role: 'radiogroup', 'aria-label': t(`server.schedule_${kind}`), onkeydown: (e) => scheduleKeys(e, kind, c.mode) },
          ['off', 'interval', 'daily'].map((mode) =>
            h('button', { class: c.mode === mode ? 'active' : '', role: 'radio', tabindex: c.mode === mode ? 0 : -1, 'aria-checked': c.mode === mode ? 'true' : 'false', dataset: { mode }, onclick: () => setMode(kind, mode) }, t(`server.mode_${mode}`)),
          ),
        ),
        c.mode === 'interval' ? h('label', { class: 'row small text-2' }, t('server.every'), hours, t('server.hours')) : null,
        c.mode === 'daily' ? h('label', { class: 'row small text-2' }, t('server.at'), time) : null,
        keep && c.mode !== 'off' ? h('label', { class: 'row small text-2' }, t('server.keep'), keep) : null,
      ),
    );
  }

  // Cambia el modo de una programacion y deja el foco en el boton elegido
  async function setMode(kind, mode, focus = false) {
    if (await save({ automation: { [kind]: { mode } } })) drawAutomation();
    if (focus) automation.querySelector(`.sv-schedule[data-kind="${kind}"] [data-mode="${mode}"]`)?.focus();
  }
  function scheduleKeys(e, kind, current) {
    const modes = ['off', 'interval', 'daily'];
    const move = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!move) return;
    e.preventDefault();
    setMode(kind, modes[(modes.indexOf(current) + move + modes.length) % modes.length], true);
  }

  function drawAutomation() {
    const cfg = merge(AUTO_DEFAULTS, srv.automation || {});
    mount(
      automation,
      h(
        'div',
        { class: 'card' },
        h('h2', { class: 'card-title' }, icon('clock'), t('server.automationTitle')),
        h('div', { class: 'card-sub' }, t('server.automationSub')),
        toggleRow(t('server.autostart'), t('server.autostartHint'), cfg.autostart, (v) => save({ automation: { autostart: v } }, t('server.saved'))),
        toggleRow(t('server.autoRestart'), t('server.autoRestartHint'), cfg.autoRestart, (v) => save({ automation: { autoRestart: v } }, t('server.saved'))),
        scheduleRow('restart', cfg),
        cfg.restart.mode !== 'off' ? toggleRow(t('server.warnPlayers'), t('server.warnPlayersHint'), cfg.restart.warn !== false, (v) => save({ automation: { restart: { warn: v } } })) : null,
        proxy ? null : scheduleRow('backup', cfg),
        srv.lastBackupAt ? h('div', { class: 'tiny muted' }, t('server.lastBackup', { when: fmtAgo(srv.lastBackupAt) })) : null,
      ),
    );
  }

  async function drawSoftware() {
    const build = srv.build ? t('server.build', { build: srv.build }) : null;
    const updateBox = h('div', { class: 'row wrap sv-update-row' });
    mount(
      software,
      h(
        'div',
        { class: 'card' },
        h('h2', { class: 'card-title' }, icon('package'), t('server.softwareTitle')),
        h('div', { class: 'sv-kvs sv-section' },
          h('div', { class: 'sv-kv' }, h('span', { class: 'sv-kv-k' }, t('server.softwareType')), h('span', { class: 'sv-kv-v' }, typeBadge(srv.type, build))),
          h('div', { class: 'sv-kv' }, h('span', { class: 'sv-kv-k' }, proxy ? t('server.proxyVersion') : t('server.mcVersion')), h('span', { class: 'sv-kv-v' }, srv.mcVersion)),
          m.loaderVersions && srv.loaderVersion ? h('div', { class: 'sv-kv' }, h('span', { class: 'sv-kv-k' }, t('server.loaderVersion')), h('span', { class: 'sv-kv-v selectable' }, srv.loaderVersion)) : null,
          srv.installedAt ? h('div', { class: 'sv-kv' }, h('span', { class: 'sv-kv-k' }, t('server.installedAt')), h('span', { class: 'sv-kv-v' }, fmtAgo(srv.installedAt))) : null,
        ),
        updateBox,
      ),
    );
    const reinstall = async (e, title) => {
      if (ctx.state() !== 'offline') return fail(t('server.stopFirstHint'));
      const done = setBusy(e.currentTarget);
      try {
        await api.servers.reinstall(srv.id);
        ok(t('server.updated'));
        ctx.refresh();
        drawSoftware();
      } catch (err) {
        failUnlessTask(store, title, err);
      } finally {
        done();
      }
    };
    mount(updateBox, h('div', { class: 'row small muted' }, h('div', { class: 'spinner' }), t('server.checkingUpdates')));
    let upd = null;
    if (srv.build) upd = await tryInvoke('servers:checkUpdate', [srv.id], null).catch(() => null);
    mount(
      updateBox,
      upd?.available ? h('div', { class: 'notice good' }, icon('upCircle'), t('server.updateAvailable', { name: m.name, build: upd.latest })) : srv.build && upd?.latest ? h('div', { class: 'sv-uptodate' }, icon('check'), h('span', {}, t('server.upToDate'))) : null,
      h('button', { class: upd?.available ? 'btn primary' : 'btn', disabled: ctx.state() !== 'offline', title: ctx.state() !== 'offline' ? t('server.stopFirstHint') : null, onclick: (e) => reinstall(e, t('server.errUpdate')) }, icon(upd?.available ? 'upCircle' : 'refresh'), upd?.available ? t('server.updateNow') : t('server.reinstall')),
      h('button', { class: 'btn ghost', onclick: () => api.servers.openFolder(srv.id).catch((e) => fail(t('common.error'), e)) }, icon('folder'), t('common.openFolder')),
    );
  }

  async function drawFiles() {
    mount(filesBox, h('div', { class: 'card' }, h('h2', { class: 'card-title' }, icon('fileText'), t('server.filesTitle')), skeleton('list', { rows: 3 })));
    let list = [];
    try {
      list = await api.invoke('servers:files', srv.id);
    } catch (err) {
      list = [];
    }
    let q = '';
    const listEl = h('div', { class: 'list sv-files' });
    const drawList = () =>
      mount(
        listEl,
        list
          .filter((f) => !q || f.path.toLowerCase().includes(q))
          .slice(0, 150)
          .map((f) => h('button', { class: 'list-item sv-file', title: f.path, onclick: () => openFileEditor(srv, f.path) }, h('div', { class: 'li-icon' }, icon('fileText')), h('div', { class: 'li-main' }, h('div', { class: 'li-title mono' }, f.path), h('div', { class: 'li-sub' }, `${fmtBytes(f.size)} · ${fmtAgo(f.mtime)}`)), icon('edit'))),
      );
    const search = h('input', { class: 'input', type: 'search', placeholder: t('server.filesSearch'), 'aria-label': t('server.filesSearch') });
    search.addEventListener('input', debounce(() => ((q = search.value.trim().toLowerCase()), drawList()), 120));
    mount(
      filesBox,
      h(
        'div',
        { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', { class: 'card-title' }, icon('fileText'), t('server.filesTitle'), h('span', { class: 'badge' }, String(list.length))), h('button', { class: 'icon-btn sm', title: t('common.refresh'), 'aria-label': t('common.refresh'), onclick: drawFiles }, icon('refresh'))),
        h('div', { class: 'card-sub' }, t('server.filesSub')),
        list.length ? h('div', { class: 'input-icon sv-files-search' }, icon('search'), search) : null,
        list.length ? listEl : h('div', { class: 'sv-mini-empty' }, icon('fileText'), h('span', {}, t('server.filesEmpty'))),
      ),
    );
    drawList();
  }

  function drawDanger() {
    mount(
      danger,
      h(
        'div',
        { class: 'card sv-danger' },
        h('h2', { class: 'card-title' }, icon('alert'), t('server.dangerTitle')),
        h(
          'div',
          { class: 'row wrap sv-danger-row' },
          h('div', { class: 'spacer small text-2' }, t('server.deleteHint')),
          h(
            'button',
            {
              class: 'btn danger',
              onclick: async () => {
                if (ctx.state() !== 'offline') return fail(t('server.stopFirstHint'));
                if (!(await confirmDialog(t('server.deleteServer'), t('server.deleteConfirm', { name: srv.name }), { danger: true, okText: t('server.deleteServer') }))) return;
                try {
                  await api.servers.remove(srv.id);
                  ok(t('server.deleted'), srv.name);
                  navigate('servers');
                } catch (err) {
                  fail(t('server.errDelete'), err);
                }
              },
            },
            icon('trash'),
            t('server.deleteServer'),
          ),
        ),
      ),
    );
  }

  mount(container, h('div', { class: 'sv-settings' }, h('div', { class: 'stack' }, identity, resources, software), h('div', { class: 'stack' }, automation, filesBox, danger)));
  (async () => {
    try {
      totalMb = Math.floor((await api.system.info()).totalMem / 1048576);
    } catch {
      /* sin informacion del sistema */
    }
    drawIdentity();
    drawResources();
    drawAutomation();
    drawSoftware();
    drawFiles();
    drawDanger();
  })();
  return null;
}
