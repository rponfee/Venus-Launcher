// Sets de mods de la instancia (pestaña Contenido, tipo Mods): conjuntos con nombre que recuerdan qué mods quedan
// prendidos. Plantillas "PvP", "Shaders" y "Liviano" que arrancan con los mods de ese estilo y el usuario completa.
// Aplicar renombra .jar y .jar.disabled, con una instantánea antes para poder deshacer, y avisa si el set deja
// afuera una dependencia que otro mod pide. Canales modsets:* (modules/modsets.js).
import { h, icon, mount, modal, ok, fail, toast, confirmDialog, emptyState, skeleton, setBusy, fmtAgo, ensureCss, debounce } from '../../ui.js';
import { store, api } from '../../store.js';
import { t, loadNs, has } from '../../i18n.js';

const TEMPLATES = [
  { id: 'pvp', icon: 'swords' },
  { id: 'shaders', icon: 'sun' },
  { id: 'lite', icon: 'zap' },
];

function errorText(err) {
  const key = `instancetools.setsErr_${err?.code}`;
  return err?.code && has(key) ? t(key, { file: err.message }) : err?.message || String(err);
}

// Editor de un set: nombre y qué mods quedan prendidos, con el aviso de dependencias al momento.
function openEditor(inst, files, { set = null, template = null, entries = [], name = '', onSaved }) {
  const on = new Set(entries.filter((e) => e.on).map((e) => e.file));
  const known = new Map(entries.map((e) => [e.file, e.on]));
  // Un mod que el set no conocía arranca como está ahora (no cambiaría al aplicar).
  for (const f of files) if (!known.has(f.name) && f.enabled && set) on.add(f.name);
  const input = h('input', { class: 'input', id: 'it-set-name', value: name, maxlength: 40, placeholder: t('instancetools.setsNamePlaceholder'), autocomplete: 'off' });
  const search = h('input', { class: 'input', type: 'search', placeholder: t('instancetools.setsSearch'), 'aria-label': t('instancetools.setsSearch'), autocomplete: 'off', spellcheck: 'false' });
  const list = h('div', { class: 'it-set-mods' });
  const warnBox = h('div', { class: 'it-set-warn' });
  const count = h('span', { class: 'small muted num' });
  let checkRun = 0;

  const entriesNow = () => files.map((f) => ({ file: f.name, project: f.project, on: on.has(f.name) }));

  const refreshCount = () => {
    count.textContent = t('instancetools.setsCount', { on: on.size, total: files.length });
  };

  async function check() {
    const run = ++checkRun;
    const issues = await api.invoke('modsets:check', inst.id, entriesNow()).catch(() => []);
    if (run !== checkRun) return;
    mount(warnBox, issues.length ? dependencyNotice(issues, (provider) => (on.add(provider), draw(), check())) : null);
  }
  const checkSoon = debounce(check, 350);

  function draw() {
    const q = search.value.toLowerCase().trim();
    const shown = files.filter((f) => !q || `${f.name} ${f.title || ''}`.toLowerCase().includes(q));
    mount(
      list,
      shown.length
        ? shown.map((f) => {
            const box = h('input', { type: 'checkbox', checked: on.has(f.name) });
            box.addEventListener('change', () => {
              if (box.checked) on.add(f.name);
              else on.delete(f.name);
              refreshCount();
              checkSoon();
            });
            return h('label', { class: 'it-set-mod' }, box, h('span', { class: 'ellipsis', title: f.name }, f.title || f.name.replace(/\.(jar|zip|litemod)$/i, '')));
          })
        : h('div', { class: 'small muted' }, t('instance.noMatch')),
    );
    refreshCount();
  }
  search.addEventListener('input', debounce(draw, 120));

  const setAll = (value) => {
    if (value) files.forEach((f) => on.add(f.name));
    else on.clear();
    draw();
    checkSoon();
  };

  const saveBtn = h('button', { class: 'btn primary', type: 'button' }, t('common.save'));
  saveBtn.addEventListener('click', async () => {
    const release = setBusy(saveBtn);
    try {
      await api.invoke('modsets:save', inst.id, { id: set?.id, name: input.value, template: template || set?.template || null, entries: entriesNow() });
      m.close();
      onSaved?.();
    } catch (err) {
      release();
      fail(t('instancetools.setsSaveFailed'), errorText(err));
    }
  });
  const m = modal({
    title: set ? t('instancetools.setsEditTitle') : t('instancetools.setsNewTitle'),
    subtitle: inst.name,
    icon: 'layers',
    size: 'wide',
    body: h(
      'div',
      { class: 'stack it-set-editor' },
      template ? h('div', { class: 'notice info' }, icon('info'), h('div', {}, t('instancetools.setsTemplateHint'))) : null,
      h('div', { class: 'field' }, h('label', { for: 'it-set-name' }, t('instancetools.setsName')), input),
      h(
        'div',
        { class: 'row wrap it-set-tools' },
        h('div', { class: 'input-icon spacer' }, icon('search'), search),
        h('button', { class: 'btn ghost sm', type: 'button', onclick: () => setAll(true) }, t('instancetools.setsAll')),
        h('button', { class: 'btn ghost sm', type: 'button', onclick: () => setAll(false) }, t('instancetools.setsNone')),
        count,
      ),
      list,
      warnBox,
    ),
    footer: [h('button', { class: 'btn ghost', type: 'button', onclick: () => m.close() }, t('common.cancel')), saveBtn],
  });
  draw();
  check();
}

function dependencyNotice(issues, onAdd) {
  const shown = issues.slice(0, 6);
  return h(
    'div',
    { class: 'notice', role: 'status' },
    icon('alert'),
    h(
      'div',
      { class: 'spacer stack it-set-deps' },
      h('strong', {}, t('instancetools.setsDepsTitle')),
      shown.map((x) =>
        h(
          'div',
          { class: 'row wrap' },
          h('span', { class: 'small spacer' }, t('instancetools.setsDepsLine', { mod: x.title, dep: x.providerTitle })),
          onAdd ? h('button', { class: 'btn sm', type: 'button', onclick: () => onAdd(x.provider) }, icon('plus'), t('instancetools.setsDepsAdd')) : null,
        ),
      ),
      issues.length > shown.length ? h('div', { class: 'small muted' }, t('instancetools.setsDepsMore', { count: issues.length - shown.length })) : null,
    ),
  );
}

// Promise<'apply' | 'add' | null>
function askDependencies(issues, name) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      m.close();
      resolve(v);
    };
    const m = modal({
      title: t('instancetools.setsDepsAskTitle'),
      subtitle: name,
      icon: 'alert',
      size: 'sm',
      body: dependencyNotice(issues),
      footer: [
        h('button', { class: 'btn ghost', type: 'button', onclick: () => finish(null) }, t('common.cancel')),
        h('button', { class: 'btn', type: 'button', onclick: () => finish('apply') }, t('instancetools.setsDepsApply')),
        h('button', { class: 'btn primary', type: 'button', onclick: () => finish('add') }, t('instancetools.setsDepsAddAll')),
      ],
      onClose: () => finish(null),
    });
  });
}

export async function openModSets(inst, { onChanged } = {}) {
  ensureCss('features/instancetools');
  await loadNs('instancetools');
  let state = null;
  const body = h('div', { class: 'stack it-sets' });
  const running = () => Boolean(store.running[inst.id]);
  const offRunning = store.on('running', () => draw());
  const m = modal({
    title: t('instancetools.setsTitle'),
    subtitle: inst.name,
    icon: 'layers',
    size: 'wide',
    body,
    footer: [h('button', { class: 'btn ghost', type: 'button', onclick: () => m.close() }, t('common.close'))],
    onClose: () => offRunning(),
  });

  async function load() {
    try {
      state = await api.invoke('modsets:list', inst.id);
      draw();
    } catch (err) {
      mount(body, h('div', { class: 'notice bad', role: 'alert' }, icon('alert'), h('div', {}, errorText(err))));
    }
  }

  const reloadAll = () => {
    load();
    onChanged?.();
  };

  async function applySet(set, btn) {
    const release = setBusy(btn);
    try {
      const issues = await api.invoke('modsets:check', inst.id, set.entries).catch(() => []);
      if (issues.length) {
        const choice = await askDependencies(issues, set.name);
        if (!choice) return release();
        if (choice === 'add') {
          const extra = new Set(issues.map((x) => x.provider));
          const entries = state.files.map((f) => {
            const prev = set.entries.find((e) => e.file === f.name);
            return { file: f.name, project: f.project, on: extra.has(f.name) || (prev ? prev.on : f.enabled) };
          });
          await api.invoke('modsets:save', inst.id, { ...set, entries });
        }
      }
      const res = await api.invoke('modsets:apply', inst.id, set.id, { reason: t('instancetools.setsSnapshotReason', { name: set.name }) });
      if (res.enabled.length || res.disabled.length) ok(t('instancetools.setsApplied', { name: res.name }), t('instancetools.setsAppliedText', { on: res.enabled.length, off: res.disabled.length }));
      else toast('info', t('instancetools.setsNoChange', { name: res.name }));
      if (res.unknown.length) toast('info', t('instancetools.setsUnknownTitle'), t('instancetools.setsUnknown', { count: res.unknown.length }), 7000);
      if (res.missing.length) toast('info', t('instancetools.setsMissingTitle'), res.missing.slice(0, 5).join(', '), 7000);
      if (res.conflicts.length) toast('bad', t('instancetools.setsConflictsTitle'), res.conflicts.slice(0, 5).join(', '), 9000);
      reloadAll();
      return undefined;
    } catch (err) {
      release();
      fail(t('instancetools.setsApplyFailed'), errorText(err));
      load();
      return undefined;
    }
  }

  async function removeSet(set) {
    if (!(await confirmDialog(t('instancetools.setsDeleteTitle'), t('instancetools.setsDeleteText', { name: set.name }), { okText: t('instance.delete'), danger: true }))) return;
    try {
      await api.invoke('modsets:remove', inst.id, set.id);
      load();
    } catch (err) {
      fail(t('instancetools.setsSaveFailed'), errorText(err));
    }
  }

  async function undo(btn) {
    const yes = await confirmDialog(t('instancetools.setsUndoTitle'), t('instancetools.setsUndoText', { name: state.lastApply.name }), { okText: t('instancetools.setsUndo') });
    if (!yes) return;
    const release = setBusy(btn);
    try {
      await api.invoke('modsets:undo', inst.id);
      ok(t('instancetools.setsUndone'));
      reloadAll();
    } catch (err) {
      release();
      fail(t('instancetools.setsUndoFailed'), errorText(err));
    }
  }

  const fromTemplate = async (id) => {
    const entries = await api.invoke('modsets:template', inst.id, id);
    openEditor(inst, state.files, { template: id, entries, name: t(`instancetools.setsTpl_${id}`), onSaved: load });
  };

  const fromCurrent = () => openEditor(inst, state.files, { entries: state.files.map((f) => ({ file: f.name, on: f.enabled })), onSaved: load });

  function setRow(set) {
    const on = set.entries.filter((e) => e.on).length;
    const applyBtn = h('button', { class: 'btn tonal sm', type: 'button', disabled: running(), title: running() ? t('instancetools.setsRunning') : null, onclick: () => applySet(set, applyBtn) }, icon('check'), t('instancetools.setsApply'));
    return h(
      'div',
      { class: 'list-item it-set-row' },
      h('div', { class: 'li-icon' }, icon(TEMPLATES.find((x) => x.id === set.template)?.icon || 'layers')),
      h('div', { class: 'li-main' }, h('div', { class: 'li-title', title: set.name }, set.name), h('div', { class: 'li-sub num' }, t('instancetools.setsCount', { on, total: set.entries.length }))),
      applyBtn,
      h('button', { class: 'icon-btn sm', type: 'button', title: t('instancetools.setsEdit'), 'aria-label': t('instancetools.setsEditItem', { name: set.name }), onclick: () => openEditor(inst, state.files, { set, entries: set.entries, name: set.name, onSaved: load }) }, icon('edit')),
      h('button', { class: 'icon-btn sm danger', type: 'button', title: t('instance.delete'), 'aria-label': t('instancetools.setsDeleteItem', { name: set.name }), onclick: () => removeSet(set) }, icon('trash')),
    );
  }

  function draw() {
    if (!state) {
      mount(body, skeleton('list', { rows: 3 }));
      return;
    }
    const isRunning = running();
    const templates = h(
      'div',
      { class: 'row wrap it-set-new' },
      h('button', { class: 'btn sm', type: 'button', onclick: fromCurrent }, icon('save'), t('instancetools.setsFromCurrent')),
      TEMPLATES.map((tpl) => h('button', { class: 'btn ghost sm', type: 'button', onclick: () => fromTemplate(tpl.id) }, icon(tpl.icon), t(`instancetools.setsTpl_${tpl.id}`))),
    );
    const last = state.lastApply;
    const undoBtn = last ? h('button', { class: 'btn sm', type: 'button', disabled: isRunning, onclick: () => undo(undoBtn) }, icon('undo'), t('instancetools.setsUndo')) : null;
    mount(
      body,
      h('p', { class: 'small muted it-sets-lead' }, t('instancetools.setsLead')),
      isRunning ? h('div', { class: 'notice info' }, icon('info'), h('div', {}, t('instancetools.setsRunning'))) : null,
      last ? h('div', { class: 'notice info' }, icon('history'), h('div', { class: 'spacer' }, t('instancetools.setsLast', { name: last.name, when: fmtAgo(last.at) })), undoBtn) : null,
      state.sets.length ? h('div', { class: 'list it-set-list' }, state.sets.map(setRow)) : h('div', { class: 'card flat' }, emptyState('layers', t('instancetools.setsEmpty'), t('instancetools.setsEmptyText'))),
      h('div', { class: 'label' }, t('instancetools.setsNew')),
      templates,
    );
  }

  draw();
  load();
  return m;
}
