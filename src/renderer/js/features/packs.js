// Modpacks: ver qué cambia antes de actualizar un modpack de Modrinth (con avisos de lo que puede romper la
// partida y actualización con instantánea previa), exportar instancias (.mrpack o .zip de Prism/MultiMC) e
// importar packs (.mrpack, CurseForge, Prism/MultiMC).
import { h, icon, mount, modal, toast, ensureCss, registerIcons, fmtBytes, fmtDate, emptyState, instanceIcon, loaderBadge, instanceLoaderKey, LOADERS, debounce, skeleton, setBusy } from '../ui.js';
import { store, api } from '../store.js';
import { t, has, loadNs } from '../i18n.js';
import { navigate } from '../app.js';

registerIcons({
  pkMinus: '<path d="M5 12h14"/>',
  pkArrowUp: '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
  pkArrowDown: '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
});

const TYPE_ICON = { mod: 'puzzle', resourcepack: 'palette', shader: 'sun', datapack: 'database', file: 'file' };
const LEVEL_CLASS = { high: 'bad', medium: '', info: 'info' };
const LEVEL_ICON = { high: 'shieldAlert', medium: 'alert', info: 'info' };
const FORMAT_ICON = { mrpack: 'package', curseforge: 'flame', multimc: 'box' };
const ITEMS_SHOWN = 6;

async function ready() {
  ensureCss('features/packs');
  try {
    await loadNs('packs');
  } catch {
    /* sin textos se ven las claves, pero no se rompe nada */
  }
}

const isMissing = (err) => /No handler registered/i.test(err?.message || '');
const errText = (err) => err?.message || String(err);
// Texto de un aviso por su codigo (las claves con {count} solo existen como _one/_other).
const hasKey = (key) => has(key) || has(`${key}_other`);
const codeText = (prefix, w) => (hasKey(`${prefix}${w.code}`) ? t(`${prefix}${w.code}`, w.vars || {}) : w.code);

async function getInstance(id) {
  return store.instances.find((i) => i.id === id) || (await api.instances.get(id).catch(() => null));
}

function loaderName(key) {
  return LOADERS[key]?.name || (key ? key.charAt(0).toUpperCase() + key.slice(1) : '');
}

// Teclado en grupos de opciones (pestanas o radios): flechas, Inicio y Fin mueven la seleccion y el foco.
// Cada opcion lleva data-key; onPick vuelve a dibujar, asi que el foco se busca despues.
function arrowKeys(list, selector, onPick) {
  list.addEventListener('keydown', (e) => {
    const opts = [...list.querySelectorAll(selector)];
    const i = opts.indexOf(document.activeElement);
    if (i < 0) return;
    const next = { ArrowRight: (i + 1) % opts.length, ArrowDown: (i + 1) % opts.length, ArrowLeft: (i - 1 + opts.length) % opts.length, ArrowUp: (i - 1 + opts.length) % opts.length, Home: 0, End: opts.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    const key = opts[next].dataset.key;
    onPick(key);
    list.querySelector(`[data-key="${CSS.escape(key)}"]`)?.focus();
  });
}

// Ventana con vistas: una sola ventana (Escape la cierra entera) cuyo cuerpo y pie se reemplazan.
// cls va en el cuerpo y en el dialogo (pk-update y pk-export tienen alto estable: no saltan al cambiar de vista).
function shell(title, onClose, cls, { icon: iconName, subtitle } = {}) {
  const body = h('div', { class: ['pk', cls] });
  // Encabezado comun de las herramientas de una instancia: icono + titulo (+ contexto debajo)
  const m = modal({ title, subtitle, icon: iconName, body, size: `wide pk-modal ${cls || ''}`.trim(), footer: [h('span', { class: 'pk-foot-spacer' })], onClose });
  const foot = m.el.querySelector('.modal-foot');
  const bodyBox = m.el.querySelector('.modal-body');
  return {
    m,
    body,
    show(parts, footer, { keepScroll = false } = {}) {
      mount(body, ...parts);
      mount(foot, ...(footer || []).filter(Boolean));
      foot.classList.toggle('hidden', !footer || !footer.filter(Boolean).length);
      if (!keepScroll && bodyBox) bodyBox.scrollTop = 0;
      // Al cambiar de vista el foco no se pierde: va al primer control de la vista (o al boton de cerrar).
      if (!m.el.contains(document.activeElement)) {
        const target = m.el.querySelector('.modal-body button:not(:disabled), .modal-body input:not(:disabled), .modal-body select:not(:disabled)') || m.el.querySelector('.modal-head button');
        target?.focus({ preventScroll: true });
      }
    },
  };
}

function progressView(title, sub) {
  const bar = h('i', { style: { width: '0%' } });
  const progress = h('div', { class: 'progress indeterminate', role: 'progressbar', 'aria-label': title }, bar);
  const detail = h('div', { class: 'pk-progress-detail', 'aria-live': 'polite' }, sub || ' ');
  const titleEl = h('div', { class: 'pk-progress-title' }, title);
  return {
    el: h('div', { class: 'pk-progress', role: 'status' }, h('div', { class: 'spinner lg', 'aria-hidden': 'true' }), titleEl, progress, detail),
    update(task) {
      if (task.title) titleEl.textContent = task.title;
      if (task.detail) detail.textContent = task.detail;
      if (typeof task.progress === 'number') {
        const pct = Math.round(task.progress * 100);
        progress.classList.remove('indeterminate');
        progress.setAttribute('aria-valuenow', String(pct));
        bar.style.width = `${pct}%`;
      } else {
        progress.classList.add('indeterminate');
        progress.removeAttribute('aria-valuenow');
      }
    },
  };
}

function followTask(match, fn) {
  return store.on('task', (task) => {
    if (task && match(task.meta || {})) fn(task);
  });
}

function doneView(iconName, title, ...rest) {
  return h('div', { class: 'pk-done' }, h('div', { class: 'pk-done-art', 'aria-hidden': 'true' }, icon(iconName)), h('div', { class: 'pk-done-title' }, title), ...rest);
}

function thumb(src, fallback, cls = 'pk-thumb') {
  const box = h('div', { class: cls, 'aria-hidden': 'true' });
  if (typeof src === 'string' && /^https:\/\//i.test(src)) {
    const img = h('img', { src, alt: '', loading: 'lazy' });
    img.addEventListener('error', () => mount(box, icon(fallback)), { once: true });
    box.append(img);
  } else box.append(icon(fallback));
  return box;
}

function check(checked, onChange, attrs = {}) {
  const input = h('input', { type: 'checkbox', checked, ...attrs });
  input.addEventListener('change', () => onChange(input.checked));
  return input;
}

// ===================================================================
// Actualizar modpack: comparación de versiones
// ===================================================================

export async function openModpackUpdate(instanceId) {
  await ready();
  let inst = await getInstance(instanceId);
  if (!inst) {
    toast('bad', t('packs.updateTitle'), t('packs.errNoInstance'));
    return;
  }
  const pack = inst.modrinth?.pack || null;
  const offs = [];
  // Alto estable solo si hay comparacion (si no es un modpack, la ventana se ajusta al aviso)
  const ui = shell(t('packs.updateTitle'), () => offs.forEach((off) => off()), pack?.projectId ? 'pk-update' : 'pk-notpack', { icon: 'upCircle', subtitle: inst.name });
  const state = { diff: null, error: null, versionId: null, filter: 'all', expanded: new Set(), snapshot: true, worlds: null, busy: false, view: 'diff', token: 0 };
  const running = () => Boolean(store.running[instanceId]);
  offs.push(
    store.on('running', () => {
      if (state.view === 'diff' && state.diff) render();
    }),
  );

  if (!pack?.projectId) {
    ui.show(
      [
        emptyState('package', t('packs.notPack'), t('packs.notPackText')),
        inst.curseforge?.pack ? h('div', { class: 'notice info' }, icon('info'), h('div', {}, t('packs.cfPack'))) : null,
      ],
      [h('button', { type: 'button', class: 'btn primary', onclick: () => ui.m.close() }, t('packs.close'))],
    );
    return;
  }

  async function load() {
    const token = ++state.token;
    state.view = 'diff';
    state.error = null;
    renderLoading();
    try {
      const d = await api.invoke('packs:diff', instanceId, state.versionId);
      if (token !== state.token) return;
      state.diff = d;
      state.versionId = d.target.versionId;
      state.expanded.clear();
      state.worlds = Boolean(d.warnings?.some((w) => w.level === 'high'));
      render();
    } catch (err) {
      if (token !== state.token) return;
      state.error = isMissing(err) ? t('packs.unavailable') : errText(err);
      render();
    }
  }

  function headCard() {
    const d = state.diff;
    const title = d?.pack?.title || pack.name || inst.name;
    const versions = d?.versions || [];
    let picker = null;
    if (versions.length) {
      const sel = h(
        'select',
        { class: 'select pk-version-select', 'aria-label': t('packs.targetLabel'), disabled: state.busy },
        versions.slice(0, 80).map((v) => {
          const vars = { number: v.number, mc: (v.mc || []).join(', '), date: fmtDate(Date.parse(v.date)) };
          const key = v.installed ? 'packs.versionOptionInstalled' : v.type && v.type !== 'release' ? `packs.versionOption_${v.type}` : 'packs.versionOption';
          return h('option', { value: v.id, selected: v.id === state.versionId }, has(key) ? t(key, vars) : t('packs.versionOption', vars));
        }),
      );
      sel.addEventListener('change', () => {
        state.versionId = sel.value;
        load();
      });
      picker = h('label', { class: 'pk-target' }, h('span', { class: 'pk-target-label' }, t('packs.targetLabel')), sel);
    }
    const installed = d?.installed?.number || pack.version || '?';
    return h(
      'div',
      { class: 'pk-head' },
      thumb(d?.pack?.icon || inst.icon, 'package', 'pk-head-icon'),
      h(
        'div',
        { class: 'pk-head-text' },
        h('div', { class: 'pk-head-title ellipsis', title }, title),
        h('div', { class: 'pk-head-sub' }, h('span', { class: 'pk-installed' }, t('packs.installedLabel'), ' ', h('strong', {}, installed)), h('span', { class: 'badge' }, icon('box'), inst.mcVersion), loaderBadge(instanceLoaderKey(inst))),
      ),
      picker,
    );
  }

  // Comparando: la forma de lo que viene (versiones, resumen y lista) con una linea de estado arriba
  function renderLoading() {
    const bone = (w, hgt) => h('span', { class: 'skeleton', style: { width: w, height: hgt } });
    ui.show(
      [
        headCard(),
        h('div', { class: 'pk-loading', role: 'status' }, h('div', { class: 'spinner', 'aria-hidden': 'true' }), h('div', {}, h('div', { class: 'pk-loading-title' }, t('packs.comparing')), h('div', { class: 'pk-loading-sub' }, t('packs.comparingText')))),
        h(
          'div',
          { class: 'pk-skel', 'aria-hidden': 'true' },
          h('div', { class: 'pk-skel-row' }, bone('190px', '28px'), bone('150px', '28px')),
          h('div', { class: 'pk-skel-row' }, bone('96px', '30px'), bone('96px', '30px'), bone('150px', '30px'), bone('120px', '30px')),
          bone('100%', '64px'),
          skeleton('list', { rows: 4 }),
        ),
      ],
      [h('button', { type: 'button', class: 'btn ghost', onclick: () => ui.m.close() }, t('packs.cancel')), h('button', { type: 'button', class: 'btn primary', disabled: true }, icon('download'), t('packs.update'))],
    );
  }

  function chips(d) {
    const s = d.summary;
    const mod = s.byType?.mod || { added: 0, removed: 0, updated: 0 };
    const other = { added: s.added - mod.added, removed: s.removed - mod.removed, updated: s.updated - mod.updated };
    const ov = d.changes.overrides.counts;
    const cfg = ov.added + ov.changed + ov.removed;
    const chip = (cls, ic, text, title) => h('span', { class: ['pk-chip', cls], title: title || text }, icon(ic), text);
    return h(
      'div',
      { class: 'pk-chips' },
      mod.added ? chip('add', 'plus', t('packs.chipModsAdded', { count: mod.added })) : null,
      mod.removed ? chip('remove', 'pkMinus', t('packs.chipModsRemoved', { count: mod.removed })) : null,
      mod.updated ? chip('update', 'pkArrowUp', t('packs.chipModsUpdated', { count: mod.updated })) : null,
      other.added ? chip('add', 'plus', t('packs.chipOtherAdded', { count: other.added })) : null,
      other.removed ? chip('remove', 'pkMinus', t('packs.chipOtherRemoved', { count: other.removed })) : null,
      other.updated ? chip('update', 'pkArrowUp', t('packs.chipOtherUpdated', { count: other.updated })) : null,
      cfg ? chip('config', 'sliders', t('packs.chipConfig', { count: cfg })) : null,
      s.unchanged ? chip('same', 'check', t('packs.chipUnchanged', { count: s.unchanged })) : null,
      d.download.bytes ? chip('size', 'download', t('packs.chipDownload', { size: fmtBytes(d.download.bytes) })) : null,
    );
  }

  function versionStrip(d) {
    const mc = d.deps.minecraft;
    const l = d.deps.loader;
    const mcEl = mc.changed
      ? h('span', { class: 'pk-vchange hot' }, icon('layers'), t('packs.mcLine', { from: mc.from, to: mc.to }))
      : h('span', { class: 'pk-vchange' }, icon('layers'), t('packs.mcSame', { version: mc.to }));
    let lEl = null;
    if (l.to.loader !== 'vanilla' || l.kindChanged) {
      lEl = l.kindChanged
        ? h('span', { class: 'pk-vchange hot' }, icon('box'), t('packs.loaderKind', { from: loaderName(l.from.loader), to: loaderName(l.to.loader) }))
        : l.versionChanged
          ? h('span', { class: 'pk-vchange' }, icon('box'), t('packs.loaderLine', { loader: loaderName(l.to.loader), from: l.from.version || '?', to: l.to.version || '?' }))
          : h('span', { class: 'pk-vchange' }, icon('box'), t('packs.loaderSame', { loader: loaderName(l.to.loader), version: l.to.version || '' }));
    }
    return h('div', { class: 'pk-vstrip' }, mcEl, lEl, h('span', { class: 'pk-vstrip-to' }, icon('arrowRight'), t('packs.targetVersion', { version: d.target.number })));
  }

  function warningBlock(w) {
    const vars = { ...(w.vars || {}) };
    if (typeof vars.count === 'number') vars.count = Number(vars.count);
    const items = w.items || [];
    const itemEls = items.slice(0, ITEMS_SHOWN).map((it) => {
      if (w.code === 'changelogRisk') {
        return h('li', { class: 'pk-witem' }, h('span', { class: 'pk-witem-title' }, it.from && it.to ? t('packs.itemVersion', { title: it.title, from: it.from, to: it.to }) : it.title), h('ul', { class: 'pk-wlines' }, (it.lines || []).map((line) => h('li', {}, h('q', {}, line)))));
      }
      if (it.from && it.to) return h('li', { class: 'pk-witem' }, t('packs.itemVersion', { title: it.title, from: it.from, to: it.to }), it.content ? h('span', { class: 'pk-wtag' }, t('packs.contentTag')) : null);
      if (it.extra) return h('li', { class: 'pk-witem' }, t('packs.itemDuplicate', { file: it.title, title: it.extra }));
      return h('li', { class: 'pk-witem' }, it.title);
    });
    if (items.length > ITEMS_SHOWN) itemEls.push(h('li', { class: 'pk-witem muted' }, t('packs.moreItems', { count: items.length - ITEMS_SHOWN })));
    const key = `packs.w_${w.code}`;
    return h(
      'div',
      { class: ['notice', 'pk-warning', LEVEL_CLASS[w.level], `lvl-${w.level}`], role: w.level === 'high' ? 'alert' : null },
      icon(LEVEL_ICON[w.level] || 'info'),
      h('div', { class: 'pk-warning-body' }, h('div', { class: 'pk-warning-text' }, hasKey(key) ? t(key, vars) : w.code), itemEls.length ? h('ul', { class: 'pk-witems' }, itemEls) : null),
    );
  }

  function changeRow(kind, d) {
    const label = { add: t('packs.rowAdded'), remove: t('packs.rowRemoved'), update: t('packs.rowUpdated') }[kind];
    const markIcon = { add: 'plus', remove: 'pkMinus', update: d.bump === 'downgrade' ? 'pkArrowDown' : 'pkArrowUp' }[kind];
    const id = `${kind}:${d.path}`;
    const canExpand = kind === 'update' && (d.changelog || d.lines?.length);
    const open = state.expanded.has(id);
    const ver = kind === 'update' ? h('span', { class: 'pk-ver', title: `${d.from || d.oldFile} → ${d.to || d.file}` }, h('span', { class: 'pk-ver-from' }, d.from || d.oldFile), icon('arrowRight'), h('span', { class: 'pk-ver-to' }, d.to || d.file)) : d.versionNumber ? h('span', { class: 'pk-ver', title: d.versionNumber }, h('span', { class: 'pk-ver-to' }, d.versionNumber)) : null;
    const badges = [
      d.bump === 'major' ? h('span', { class: ['badge', d.content ? 'bad' : 'warn'], title: t('packs.badgeMajorTitle') }, t('packs.badgeMajor')) : null,
      d.bump === 'downgrade' ? h('span', { class: 'badge warn', title: t('packs.badgeDowngradeTitle') }, t('packs.badgeDowngrade')) : null,
      d.content && (kind === 'remove' || d.bump === 'major') ? h('span', { class: 'badge', title: t('packs.badgeContentTitle') }, icon('box'), t('packs.badgeContent')) : null,
      d.lines?.length ? h('span', { class: 'badge warn', title: t('packs.badgeRiskTitle') }, icon('alert'), t('packs.badgeRisk')) : null,
    ].filter(Boolean);
    const toggle = canExpand
      ? h(
          'button',
          {
            type: 'button',
            class: ['icon-btn sm pk-expand', open && 'open'],
            title: open ? t('packs.hideChangelog') : t('packs.showChangelog'),
            'aria-label': open ? t('packs.hideChangelog') : t('packs.showChangelog'),
            'aria-expanded': String(open),
            onclick: () => {
              if (state.expanded.has(id)) state.expanded.delete(id);
              else state.expanded.add(id);
              render({ keepScroll: true });
            },
          },
          icon('chevronDown'),
        )
      : // Mismo ancho que el boton: las versiones y etiquetas quedan alineadas en columna
        h('span', { class: 'pk-expand-spacer', 'aria-hidden': 'true' });
    return h(
      'li',
      { class: ['pk-row', kind, open && 'open'] },
      h('div', { class: 'pk-row-main' }, h('span', { class: `pk-mark ${kind}`, title: label }, icon(markIcon), h('span', { class: 'sr-only' }, label)), thumb(d.icon, TYPE_ICON[d.type] || 'file'), h('div', { class: 'pk-row-text' }, h('div', { class: 'pk-row-title ellipsis', title: d.title }, d.title), h('div', { class: 'pk-row-path ellipsis', title: d.path }, d.path)), ver, badges.length ? h('div', { class: 'pk-row-badges' }, badges) : null, toggle),
      open
        ? h(
            'div',
            { class: 'pk-row-detail' },
            d.lines?.length ? h('ul', { class: 'pk-wlines' }, d.lines.map((line) => h('li', {}, h('q', {}, line)))) : null,
            d.changelog ? h('div', { class: 'pk-changelog selectable' }, d.changelog) : h('div', { class: 'muted small' }, t('packs.noChangelog')),
          )
        : null,
    );
  }

  function configRows(ov) {
    const mine = new Set(ov.userModified || []);
    const row = (kind, rel) =>
      h(
        'li',
        { class: ['pk-row', 'cfg', kind] },
        h(
          'div',
          { class: 'pk-row-main' },
          h('span', { class: `pk-mark ${kind}`, 'aria-hidden': 'true' }, icon(kind === 'add' ? 'plus' : kind === 'remove' ? 'pkMinus' : 'refresh')),
          h('div', { class: 'pk-row-text' }, h('div', { class: 'pk-row-path mono ellipsis', title: rel }, rel)),
          h('span', { class: 'pk-cfg-tag' }, t(kind === 'add' ? 'packs.cfgAdded' : kind === 'remove' ? 'packs.cfgRemoved' : 'packs.cfgChanged')),
          mine.has(rel) ? h('span', { class: 'badge warn', title: t('packs.cfgYoursTitle') }, t('packs.cfgYours')) : null,
        ),
      );
    return [...ov.added.map((r) => row('add', r)), ...ov.changed.map((r) => row('update', r)), ...ov.removed.map((r) => row('remove', r))];
  }

  function render({ keepScroll = false } = {}) {
    state.view = 'diff';
    const d = state.diff;
    const footCancel = h('button', { type: 'button', class: 'btn ghost', onclick: () => ui.m.close() }, t('packs.cancel'));
    if (state.error) {
      ui.show([headCard(), h('div', { class: 'notice bad', role: 'alert' }, icon('alert'), h('div', { class: 'pk-notice-body' }, h('div', {}, t('packs.diffError', { error: state.error })), h('button', { type: 'button', class: 'btn sm', onclick: load }, icon('refresh'), t('packs.retry'))))], [footCancel]);
      return;
    }
    if (!d) return renderLoading();
    if (d.upToDate) {
      ui.show([headCard(), h('div', { class: 'pk-uptodate', role: 'status' }, h('div', { class: 'pk-done-art small', 'aria-hidden': 'true' }, icon('check')), h('div', {}, h('div', { class: 'pk-uptodate-title' }, t('packs.upToDate')), h('div', { class: 'pk-uptodate-text' }, t('packs.upToDateText'))))], [h('button', { type: 'button', class: 'btn primary', onclick: () => ui.m.close() }, t('packs.close'))]);
      return;
    }
    const c = d.changes;
    const ov = c.overrides;
    const cfgCount = ov.counts.added + ov.counts.changed + ov.counts.removed;
    const tabs = [
      ['all', t('packs.filterAll'), d.summary.added + d.summary.removed + d.summary.updated],
      ['added', t('packs.filterAdded'), d.summary.added],
      ['removed', t('packs.filterRemoved'), d.summary.removed],
      ['updated', t('packs.filterUpdated'), d.summary.updated],
      ['config', t('packs.filterConfig'), cfgCount],
    ];
    const pickFilter = (key) => {
      state.filter = key;
      render({ keepScroll: true });
    };
    const seg = h(
      'div',
      { class: 'segmented pk-filter', role: 'tablist', 'aria-label': t('packs.filterAria') },
      tabs.map(([key, label, n]) =>
        h(
          'button',
          {
            type: 'button',
            role: 'tab',
            tabindex: state.filter === key ? 0 : -1,
            dataset: { key },
            'aria-controls': 'pk-changes-list',
            class: state.filter === key ? 'active' : null,
            'aria-selected': String(state.filter === key),
            onclick: () => pickFilter(key),
          },
          label,
          h('span', { class: ['pk-count', !n && 'zero'] }, String(n)),
        ),
      ),
    );
    arrowKeys(seg, '[role="tab"]', pickFilter);
    let rows = [];
    if (state.filter === 'config') rows = configRows(ov);
    else {
      if (state.filter === 'all' || state.filter === 'added') rows.push(...c.added.map((x) => changeRow('add', x)));
      if (state.filter === 'all' || state.filter === 'removed') rows.push(...c.removed.map((x) => changeRow('remove', x)));
      if (state.filter === 'all' || state.filter === 'updated') rows.push(...c.updated.map((x) => changeRow('update', x)));
    }
    const listEl = rows.length ? h('ul', { class: 'pk-rows', id: 'pk-changes-list', role: 'tabpanel', 'aria-label': t('packs.changesTitle') }, rows) : h('div', { class: 'pk-norows', id: 'pk-changes-list', role: 'tabpanel' }, icon('check'), h('span', {}, t('packs.noRows')));
    const notes = [];
    if (state.filter === 'config') notes.push(h('div', { class: 'notice info pk-note' }, icon('info'), h('div', {}, ov.known ? t('packs.cfgKeep') : t('packs.cfgUnknown'))));
    if (c.userFiles && state.filter !== 'config') notes.push(h('div', { class: 'pk-userfiles' }, icon('shieldCheck'), t('packs.userFiles', { count: c.userFiles })));

    const changelogs = d.packChangelogs?.length
      ? h(
          'details',
          { class: 'pk-packlog' },
          h('summary', {}, icon('fileText'), h('span', {}, t('packs.packChangelog')), h('span', { class: 'pk-count' }, String(d.packChangelogs.length)), icon('chevronDown', 'pk-packlog-caret')),
          d.packChangelogs.map((v) => h('div', { class: 'pk-packlog-item' }, h('div', { class: 'pk-packlog-head' }, h('strong', {}, v.number), h('span', { class: 'muted small' }, fmtDate(Date.parse(v.date)))), v.changelog ? h('div', { class: 'pk-changelog selectable' }, v.changelog) : h('div', { class: 'muted small' }, t('packs.noChangelog')))),
        )
      : null;

    // Pie: instantánea antes (recomendado) y mundos
    const snapCb = check(state.snapshot, (v) => {
      state.snapshot = v;
      worldsCb.disabled = !v;
      worldsLabel.classList.toggle('disabled', !v);
    });
    const worldsCb = check(Boolean(state.worlds), (v) => (state.worlds = v), { disabled: !state.snapshot });
    const worldsLabel = h('label', { class: ['pk-foot-check', !state.snapshot && 'disabled'], title: t('packs.snapshotWorldsHint') }, worldsCb, t('packs.snapshotWorlds'));
    const updateBtn = h('button', { type: 'button', class: 'btn primary', disabled: running() || state.busy, title: running() ? t('packs.runningNotice') : null, onclick: () => doUpdate() }, icon('download'), t('packs.updateTo', { version: d.target.number }));

    ui.show(
      [
        headCard(),
        running() ? h('div', { class: 'notice' }, icon('alert'), h('div', {}, t('packs.runningNotice'))) : null,
        versionStrip(d),
        chips(d),
        d.warnings.length ? h('div', { class: 'pk-warnings' }, d.warnings.map(warningBlock)) : h('div', { class: 'notice good pk-safe' }, icon('shieldCheck'), h('div', {}, t('packs.noWarnings'))),
        h('div', { class: 'pk-list-head' }, h('div', { class: 'pk-section-title', role: 'heading', 'aria-level': '4' }, icon('diff'), t('packs.changesTitle')), seg),
        ...notes,
        listEl,
        changelogs,
      ],
      [
        h('div', { class: 'pk-foot-opts' }, h('label', { class: 'pk-foot-check' }, snapCb, t('packs.snapshotFirst')), worldsLabel),
        footCancel,
        updateBtn,
      ],
      { keepScroll },
    );
  }

  async function doUpdate() {
    const d = state.diff;
    if (!d || state.busy) return;
    state.busy = true;
    state.view = 'progress';
    const pv = progressView(t('packs.updating'), t('packs.updatingText'));
    ui.show([headCard(), pv.el], []);
    const off = followTask((meta) => meta.kind === 'packs:update' && meta.instanceId === instanceId, (task) => pv.update(task));
    try {
      const r = await api.invoke('packs:update', instanceId, d.target.versionId, { snapshot: state.snapshot, worlds: state.snapshot && state.worlds ? 'all' : 'none' });
      state.busy = false;
      store.refreshInstances().catch(() => {});
      showUpdated(r);
    } catch (err) {
      state.busy = false;
      state.view = 'error';
      ui.show(
        [headCard(), h('div', { class: 'notice bad', role: 'alert' }, icon('alert'), h('div', { class: 'pk-notice-body' }, h('strong', {}, t('packs.updateFailed')), h('div', {}, errText(err))))],
        [h('button', { type: 'button', class: 'btn ghost', onclick: () => ui.m.close() }, t('packs.close')), h('button', { type: 'button', class: 'btn primary', onclick: () => ((state.diff = null), load()) }, icon('refresh'), t('packs.retry'))],
      );
    } finally {
      off();
    }
  }

  function showUpdated(r) {
    state.view = 'done';
    const d = state.diff;
    const openSnaps = async () => {
      ui.m.close();
      try {
        const m = await import('./snapshots.js');
        await m.openSnapshots(instanceId);
      } catch (err) {
        toast('bad', t('packs.updateTitle'), errText(err));
      }
    };
    ui.show(
      [
        doneView(
          'check',
          t('packs.updatedTitle', { name: d?.pack?.title || inst.name, version: r.versionNumber }),
          h('p', { class: 'pk-done-text' }, t('packs.updatedText', { count: r.downloaded || 0 })),
          r.snapshotId ? h('div', { class: 'notice info pk-done-note' }, icon('history'), h('div', {}, t('packs.updatedSnapshot'))) : null,
          r.disabledDuplicates?.length ? h('div', { class: 'notice pk-done-note' }, icon('info'), h('div', {}, t('packs.disabledDupes', { count: r.disabledDuplicates.length, files: r.disabledDuplicates.map((f) => f.split('/').pop()).join(', ') }))) : null,
          r.blocked?.length ? h('div', { class: 'notice bad pk-done-note' }, icon('alert'), h('div', {}, t('packs.blockedAfter', { count: r.blocked.length }))) : null,
          r.prepareError ? h('div', { class: 'notice pk-done-note' }, icon('alert'), h('div', {}, t('packs.prepareWarn', { error: r.prepareError }))) : null,
        ),
      ],
      [r.snapshotId ? h('button', { type: 'button', class: 'btn ghost', onclick: openSnaps }, icon('history'), t('packs.openSnapshots')) : null, h('button', { type: 'button', class: 'btn primary', onclick: () => ui.m.close() }, t('packs.close'))],
    );
  }

  renderLoading();
  load();
}

// ===================================================================
// Exportar
// ===================================================================

const INCLUDES = [
  { key: 'mods', icon: 'puzzle' },
  { key: 'configs', icon: 'sliders', hint: true },
  { key: 'resourcepacks', icon: 'palette' },
  { key: 'shaderpacks', icon: 'sun' },
  { key: 'options', icon: 'settings', hint: true },
  { key: 'disabled', icon: 'ban' },
];

export async function openExport(instanceId) {
  await ready();
  const inst = await getInstance(instanceId);
  if (!inst) {
    toast('bad', t('packs.exportTitle', { name: '' }), t('packs.errNoInstance'));
    return;
  }
  const offs = [];
  // El titulo dice que se hace; la tarjeta de arriba dice que instancia (sin repetir el nombre)
  const ui = shell(t('packs.exportHeading'), () => offs.forEach((off) => off()), 'pk-export', { icon: 'upload' });
  const state = {
    format: 'mrpack',
    include: { mods: true, configs: true, resourcepacks: true, shaderpacks: true, options: true, disabled: false },
    worlds: new Set(),
    worldList: null,
    name: '',
    version: '',
    summary: '',
    preview: null,
    previewError: null,
    token: 0,
    view: 'form',
  };

  const nameInput = h('input', { class: 'input', id: 'pk-exp-name', maxlength: 60, value: inst.name, required: true });
  const versionInput = h('input', { class: 'input', id: 'pk-exp-version', maxlength: 40, value: '1.0.0' });
  const summaryInput = h('input', { class: 'input', id: 'pk-exp-summary', maxlength: 300, placeholder: t('packs.summaryPlaceholder') });
  // El nombre es obligatorio: el error se muestra debajo del campo (al salir de el o al exportar)
  const nameError = h('div', { class: 'field-error', id: 'pk-exp-name-error', hidden: true }, icon('alert'), h('span', {}, t('packs.nameRequired')));
  const checkName = () => {
    const bad = !nameInput.value.trim();
    nameInput.setAttribute('aria-invalid', String(bad));
    if (bad) nameInput.setAttribute('aria-describedby', nameError.id);
    else nameInput.removeAttribute('aria-describedby');
    nameError.hidden = !bad;
    return !bad;
  };
  nameInput.addEventListener('blur', checkName);
  nameInput.addEventListener('input', () => nameInput.getAttribute('aria-invalid') === 'true' && checkName());
  let touchedVersion = false;
  versionInput.addEventListener('input', () => (touchedVersion = true));
  const formatBox = h('div', { class: 'pk-formats', role: 'radiogroup', 'aria-label': t('packs.formatAria') });
  const includeBox = h('div', { class: 'pk-includes' });
  const worldsBox = h('div', { class: 'pk-exp-worlds' });
  const previewBox = h('div', { class: 'pk-preview', 'aria-live': 'polite' });
  // Resumen corto en el pie: siempre visible aunque el detalle quede abajo.
  const footSummary = h('div', { class: 'pk-foot-opts pk-foot-summary' });
  const exportBtn = h('button', { type: 'button', class: 'btn primary' }, icon('upload'), t('packs.exportBtn'));
  const summaryField = h('div', { class: 'field full' }, h('label', { for: 'pk-exp-summary' }, t('packs.summaryField')), summaryInput);

  const opts = () => ({ format: state.format, include: { ...state.include }, worlds: [...state.worlds], name: nameInput.value.trim(), version: versionInput.value.trim(), summary: summaryInput.value.trim() });

  const pickFormat = (f) => {
    if (state.format === f) return;
    state.format = f;
    drawFormats();
    summaryField.classList.toggle('hidden', f !== 'mrpack');
    refresh();
  };
  // Radios con teclado: Tab entra al elegido y las flechas cambian de formato
  arrowKeys(formatBox, '[role="radio"]', pickFormat);
  function drawFormats() {
    mount(
      formatBox,
      ['mrpack', 'zip'].map((f) =>
        h(
          'button',
          {
            type: 'button',
            role: 'radio',
            tabindex: state.format === f ? 0 : -1,
            dataset: { key: f },
            'aria-checked': String(state.format === f),
            class: ['pk-format', state.format === f && 'active'],
            onclick: () => pickFormat(f),
          },
          h('span', { class: 'pk-format-icon', 'aria-hidden': 'true' }, icon(f === 'mrpack' ? 'package' : 'archive')),
          h('span', { class: 'pk-format-text' }, h('span', { class: 'pk-format-name' }, t(f === 'mrpack' ? 'packs.formatMrpack' : 'packs.formatZip')), h('span', { class: 'pk-format-hint' }, t(f === 'mrpack' ? 'packs.formatMrpackHint' : 'packs.formatZipHint'))),
          h('span', { class: 'pk-format-radio', 'aria-hidden': 'true' }),
        ),
      ),
    );
  }

  function drawIncludes() {
    const g = state.preview?.groups || {};
    mount(
      includeBox,
      INCLUDES.map((it) => {
        const info = it.key === 'disabled' ? null : g[it.key];
        const input = check(state.include[it.key], (v) => {
          state.include[it.key] = v;
          card.classList.toggle('on', v);
          refresh();
        });
        const sub = it.key === 'disabled' ? t('packs.inc_disabledHint') : info ? (info.files ? t('packs.incCount', { count: info.files, size: fmtBytes(info.bytes) }) : t('packs.incEmpty')) : t('packs.previewing');
        const card = h('label', { class: ['pk-include', state.include[it.key] && 'on', !info && it.key !== 'disabled' && 'pending'] }, input, h('span', { class: 'pk-include-icon', 'aria-hidden': 'true' }, icon(it.icon)), h('span', { class: 'pk-include-text' }, h('span', { class: 'pk-include-name' }, t(`packs.inc_${it.key}`)), h('span', { class: 'pk-include-sub ellipsis', title: it.hint ? `${t(`packs.inc_${it.key}Hint`)} · ${sub}` : sub }, sub)));
        return card;
      }),
    );
  }

  function drawWorlds() {
    const list = state.worldList;
    if (!list) {
      mount(worldsBox, skeleton(3, { label: t('packs.worldsLoading') }));
      return;
    }
    if (!list.length) {
      mount(worldsBox, h('div', { class: 'pk-empty-line' }, icon('globe'), h('span', {}, t('packs.worldsNone'))));
      return;
    }
    mount(
      worldsBox,
      list.map((w) => {
        const input = check(state.worlds.has(w.folder), (v) => {
          if (v) state.worlds.add(w.folder);
          else state.worlds.delete(w.folder);
          row.classList.toggle('on', v);
          refresh();
        });
        const row = h('label', { class: ['pk-world', state.worlds.has(w.folder) && 'on'] }, input, icon('globe'), h('span', { class: 'pk-world-name ellipsis', title: w.name }, w.name), w.size !== undefined ? h('span', { class: 'pk-world-size' }, fmtBytes(w.size)) : null);
        return row;
      }),
    );
  }

  function drawPreview() {
    const p = state.preview;
    if (state.previewError) {
      mount(previewBox, h('div', { class: 'notice bad', role: 'alert' }, icon('alert'), h('div', { class: 'pk-notice-body' }, h('div', {}, state.previewError), state.missing ? null : h('button', { type: 'button', class: 'btn sm', onclick: () => refresh() }, icon('refresh'), t('packs.retry')))));
      mount(footSummary);
      exportBtn.disabled = Boolean(state.missing);
      return;
    }
    if (!p) {
      mount(previewBox, skeleton(2, { label: t('packs.previewing') }));
      mount(footSummary, h('div', { class: 'spinner', 'aria-hidden': 'true' }), h('span', {}, t('packs.previewing')));
      return;
    }
    const lines = [];
    if (p.format === 'mrpack' && p.mrpack) {
      lines.push(h('div', { class: 'pk-preview-line' }, icon('cloudDownload'), t('packs.previewMrpackIndexed', { count: p.mrpack.indexed, size: fmtBytes(p.mrpack.indexedBytes) })));
      lines.push(h('div', { class: 'pk-preview-line' }, icon('archive'), t('packs.previewMrpackInside', { count: p.mrpack.overrides, size: fmtBytes(p.mrpack.overridesBytes) })));
      if (p.mrpack.foreignMods?.length) lines.push(h('div', { class: 'notice pk-note' }, icon('alert'), h('div', {}, t('packs.foreignMods', { count: p.mrpack.foreignMods.length, files: p.mrpack.foreignMods.slice(0, 6).join(', ') }))));
    } else {
      lines.push(h('div', { class: 'pk-preview-line' }, icon('archive'), t('packs.previewZip', { count: p.total.files, size: fmtBytes(p.total.bytes) })));
    }
    for (const w of p.warnings || []) lines.push(h('div', { class: 'notice pk-note' }, icon('alert'), h('div', {}, codeText('packs.w_', w))));
    mount(previewBox, ...lines);
    const footText = p.format === 'mrpack' && p.mrpack ? t('packs.footMrpack', { indexed: p.mrpack.indexed, inside: p.mrpack.overrides, size: fmtBytes(p.mrpack.overridesBytes) }) : t('packs.footZip', { count: p.total.files, size: fmtBytes(p.total.bytes) });
    mount(footSummary, icon(p.format === 'mrpack' ? 'package' : 'archive'), h('span', { class: 'ellipsis', title: footText }, footText));
    exportBtn.disabled = !p.total.files || state.missing;
  }

  const refresh = debounce(async () => {
    const token = ++state.token;
    state.preview = null;
    state.previewError = null;
    drawPreview();
    try {
      const p = await api.invoke('packs:exportPreview', instanceId, opts());
      if (token !== state.token) return;
      state.preview = p;
      if (!touchedVersion && p.defaults?.version && versionInput.value === '1.0.0') versionInput.value = p.defaults.version;
    } catch (err) {
      if (token !== state.token) return;
      state.previewError = isMissing(err) ? t('packs.unavailable') : t('packs.previewError', { error: errText(err) });
      if (isMissing(err)) state.missing = true;
    }
    if (state.view === 'form') {
      drawIncludes();
      drawPreview();
    }
  }, 300);

  async function doExport() {
    const o = opts();
    if (!checkName()) {
      nameInput.focus();
      return;
    }
    // Mientras se elige donde guardar (y hasta que empieza la tarea) el boton queda ocupado
    const release = setBusy(exportBtn);
    let pv = null;
    const off = followTask(
      (meta) => meta.kind === 'packs:export' && meta.instanceId === instanceId,
      (task) => {
        if (!pv) {
          state.view = 'progress';
          pv = progressView(t('packs.exporting'));
          ui.show([pv.el], []);
        }
        pv.update(task);
      },
    );
    try {
      const r = await api.invoke('packs:export', instanceId, o);
      release();
      if (!r) {
        if (state.view !== 'form') showForm();
        return;
      }
      showDone(r);
    } catch (err) {
      release();
      toast('bad', t('packs.exportFailed'), errText(err), 8000);
      showForm();
    } finally {
      off();
    }
  }
  exportBtn.addEventListener('click', doExport);

  function showDone(r) {
    state.view = 'done';
    const fileName = r.file.split(/[\\/]/).pop();
    ui.show(
      [
        doneView(
          'check',
          t('packs.exportedTitle'),
          h('p', { class: 'pk-done-file mono', title: r.file }, fileName),
          h('p', { class: 'pk-done-text' }, r.format === 'mrpack' ? t('packs.exportedMrpack', { size: fmtBytes(r.size), indexed: r.indexed, inside: r.overrides }) : t('packs.exportedZip', { size: fmtBytes(r.size), count: r.overrides })),
        ),
      ],
      [
        h(
          'button',
          {
            type: 'button',
            class: 'btn ghost',
            onclick: () => api.invoke('packs:reveal', r.file).catch((err) => toast('bad', t('packs.exportFailed'), errText(err))),
          },
          icon('folderOpen'),
          t('packs.showInFolder'),
        ),
        h('button', { type: 'button', class: 'btn primary', onclick: () => ui.m.close() }, t('packs.close')),
      ],
    );
  }

  function showForm() {
    state.view = 'form';
    exportBtn.disabled = false;
    summaryField.classList.toggle('hidden', state.format !== 'mrpack');
    ui.show(
      [
        h('div', { class: 'pk-head pk-exp-head' }, instanceIcon(inst, 'pk-exp-icon'), h('div', { class: 'pk-head-text' }, h('div', { class: 'pk-head-title ellipsis', title: inst.name }, inst.name), h('div', { class: 'pk-head-sub' }, h('span', { class: 'badge' }, icon('box'), inst.mcVersion), loaderBadge(instanceLoaderKey(inst))))),
        formatBox,
        h('div', { class: 'form-grid pk-exp-form' }, h('div', { class: 'field' }, h('label', { for: 'pk-exp-name' }, t('packs.nameField')), nameInput, nameError), h('div', { class: 'field' }, h('label', { for: 'pk-exp-version' }, t('packs.versionField')), versionInput), summaryField),
        h('div', { class: 'pk-section-title', role: 'heading', 'aria-level': '4' }, icon('layers'), t('packs.includeTitle')),
        includeBox,
        h('div', { class: 'pk-section-title', role: 'heading', 'aria-level': '4' }, icon('globe'), h('span', {}, t('packs.worldsExportTitle')), h('span', { class: 'pk-section-hint' }, t('packs.worldsExportHint'))),
        worldsBox,
        previewBox,
      ],
      [footSummary, h('button', { type: 'button', class: 'btn ghost', onclick: () => ui.m.close() }, t('packs.cancel')), exportBtn],
    );
    drawFormats();
    drawIncludes();
    drawWorlds();
    drawPreview();
  }

  showForm();
  refresh();
  try {
    const list = await api.invoke('snapshots:worlds', instanceId);
    state.worldList = list.map((w) => ({ folder: w.folder, name: w.name, size: w.size }));
  } catch {
    const list = await api.instances.content(instanceId, 'saves').catch(() => []);
    state.worldList = (list || []).map((w) => ({ folder: w.folder, name: w.displayName || w.folder }));
  }
  if (state.view === 'form') drawWorlds();
}

// ===================================================================
// Importar
// ===================================================================

// filePath (opcional): ruta de un archivo ya elegido (por ejemplo, arrastrado a otra pantalla).
export async function openImportPack(filePath) {
  await ready();
  const offs = [];
  const ui = shell(t('packs.importTitle'), () => offs.forEach((off) => off()), 'pk-import', { icon: 'download' });
  const state = { file: null, info: null, view: 'pick', busy: false };

  function showPick(errorText) {
    state.view = 'pick';
    // Un solo control enfocable: el boton (la zona entera responde al clic y al arrastre, sin anidar controles)
    const pickBtn = h('button', { type: 'button', class: 'btn primary', title: t('packs.dropAria') }, icon('folderOpen'), t('packs.pickFile'));
    const drop = h(
      'div',
      { class: 'pk-drop' },
      h('div', { class: 'pk-drop-art', 'aria-hidden': 'true' }, icon('package')),
      h('div', { class: 'pk-drop-title' }, t('packs.dropTitle')),
      h('div', { class: 'pk-drop-text' }, t('packs.dropText')),
      pickBtn,
    );
    let picking = false;
    const pick = async () => {
      if (picking) return;
      picking = true;
      const release = setBusy(pickBtn);
      try {
        const file = await api.invoke('packs:pickFile');
        release();
        if (file) inspect(file);
      } catch (err) {
        release();
        showPick(isMissing(err) ? t('packs.unavailable') : errText(err));
      } finally {
        picking = false;
      }
    };
    pickBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      pick();
    });
    drop.addEventListener('click', pick);
    let depth = 0;
    drop.addEventListener('dragenter', (e) => {
      e.preventDefault();
      depth++;
      drop.classList.add('over');
    });
    drop.addEventListener('dragover', (e) => {
      e.preventDefault();
      drop.classList.add('over');
    });
    // Salir de un hijo no apaga el resaltado: solo al salir de la zona entera
    drop.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (!depth) drop.classList.remove('over');
    });
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      depth = 0;
      drop.classList.remove('over');
      const f = e.dataTransfer?.files?.[0];
      const p = f ? api.app.pathForFile(f) : '';
      if (p) inspect(p);
      else showPick(t('packs.dropFailed'));
    });
    ui.show(
      [
        errorText ? h('div', { class: 'notice bad', role: 'alert' }, icon('alert'), h('div', {}, errorText)) : null,
        drop,
        h(
          'div',
          { class: 'pk-formats-list' },
          h('span', { class: 'pk-formats-label' }, t('packs.supported')),
          ['mrpack', 'curseforge', 'multimc'].map((k) => h('span', { class: `pk-fmt-chip ${k}` }, icon(FORMAT_ICON[k]), t(`packs.fmt_${k}`))),
        ),
      ],
      [h('button', { type: 'button', class: 'btn ghost', onclick: () => ui.m.close() }, t('packs.cancel'))],
    );
  }

  async function inspect(file) {
    state.file = file;
    state.view = 'inspect';
    // Leyendo el archivo: la forma de la tarjeta que va a aparecer
    const fileName = String(file).split(/[\\/]/).pop();
    ui.show(
      [
        h(
          'div',
          { class: 'pk-imp-card pk-imp-loading' },
          h('span', { class: 'skeleton pk-head-icon', 'aria-hidden': 'true' }),
          h('div', { class: 'pk-imp-main' }, h('div', { class: 'pk-loading-title' }, t('packs.inspecting')), h('div', { class: 'pk-imp-file', title: file }, icon('file'), h('span', { class: 'ellipsis' }, fileName)), skeleton(3, { label: t('packs.inspecting') })),
        ),
      ],
      [h('button', { type: 'button', class: 'btn ghost', onclick: () => ui.m.close() }, t('packs.cancel'))],
    );
    try {
      const info = await api.invoke('packs:inspect', file);
      if (!info) return showPick();
      state.info = info;
      showInfo();
    } catch (err) {
      showPick(isMissing(err) ? t('packs.unavailable') : t('packs.inspectError', { error: errText(err) }));
    }
  }

  function showInfo() {
    state.view = 'info';
    const i = state.info;
    const nameInput = h('input', { class: 'input pk-imp-name', id: 'pk-imp-name', maxlength: 60, value: i.name || '' });
    const blockedCf = i.type === 'curseforge' && (!i.cfModule || i.needsKey);
    // Sin CurseForge en esta version (sin modulo o sin la API key del launcher) no se puede importar
    const importBtn = h('button', { type: 'button', class: ['btn', !blockedCf && 'primary'], disabled: blockedCf }, icon('download'), t('packs.importBtn'));
    const stats = [];
    if (i.type === 'multimc') {
      stats.push(h('span', {}, icon('file'), t('packs.importGameFiles', { count: i.files, size: fmtBytes(i.gameBytes || 0) })));
      if (i.worlds) stats.push(h('span', {}, icon('globe'), t('packs.importWorlds', { count: i.worlds })));
    } else {
      stats.push(h('span', {}, icon('cloudDownload'), i.downloadBytes ? t('packs.importDownload', { count: i.files, size: fmtBytes(i.downloadBytes) }) : t('packs.importFiles', { count: i.files })));
      if (i.overrides) stats.push(h('span', {}, icon('sliders'), t('packs.importOverrides', { count: i.overrides })));
    }
    stats.push(h('span', {}, icon('archive'), fmtBytes(i.size)));
    const loaderKey = i.loader || 'vanilla';
    const notes = [];
    if (i.modrinth?.projectId) notes.push(h('div', { class: 'notice good' }, icon('upCircle'), h('div', {}, i.modrinth.title ? t('packs.identified', { title: i.modrinth.title }) : t('packs.identifiedManaged'))));
    if (i.type === 'curseforge') {
      if (!i.cfModule || i.needsKey) notes.push(h('div', { class: 'notice' }, icon('info'), h('div', {}, t('packs.cfUnavailable'))));
      else notes.push(h('div', { class: 'notice info' }, icon('info'), h('div', {}, t('packs.cfManualNote'))));
    }
    for (const w of i.warnings || []) notes.push(h('div', { class: 'notice' }, icon('alert'), h('div', {}, codeText('packs.wi_', w))));
    const doImport = async () => {
      const name = nameInput.value.trim();
      state.busy = true;
      state.view = 'progress';
      const pv = progressView(t('packs.importing'));
      ui.show([pv.el], []);
      const off = followTask((meta) => meta.kind === 'packs:import', (task) => pv.update(task));
      try {
        const r = await api.invoke('packs:import', state.file, { name });
        state.busy = false;
        store.refreshInstances().catch(() => {});
        if (r) showImported(r);
        else showPick();
      } catch (err) {
        state.busy = false;
        store.refreshInstances().catch(() => {});
        showInfo();
        toast('bad', t('packs.importFailed'), errText(err), 9000);
      } finally {
        off();
      }
    };
    importBtn.addEventListener('click', doImport);
    nameInput.addEventListener('keydown', (e) => e.key === 'Enter' && !importBtn.disabled && doImport());
    ui.show(
      [
        h(
          'div',
          { class: 'pk-imp-card' },
          thumb(i.modrinth?.icon, FORMAT_ICON[i.type] || 'package', 'pk-head-icon'),
          h(
            'div',
            { class: 'pk-imp-main' },
            h('div', { class: 'pk-imp-kicker' }, h('span', { class: `pk-fmt-chip ${i.type}` }, icon(FORMAT_ICON[i.type] || 'package'), t(`packs.type_${i.type}`)), i.version ? h('span', { class: 'badge' }, t('packs.packVersion', { version: i.version })) : null, h('span', { class: 'badge' }, i.mcVersion), loaderBadge(loaderKey, i.loaderVersion && loaderKey !== 'vanilla' ? i.loaderVersion : null)),
            h('div', { class: 'field' }, h('label', { for: 'pk-imp-name' }, t('packs.importName')), nameInput),
            h('div', { class: 'pk-imp-stats' }, stats),
            h('div', { class: 'pk-imp-file', title: i.file }, icon('file'), h('span', { class: 'ellipsis' }, i.fileName)),
          ),
        ),
        ...notes,
      ],
      [h('button', { type: 'button', class: 'btn ghost', onclick: () => showPick() }, icon('folderOpen'), t('packs.chooseOther')), importBtn],
    );
    if (!blockedCf) setTimeout(() => nameInput.focus(), 40);
  }

  function showImported(r) {
    state.view = 'done';
    const manual = r.manual || [];
    ui.show(
      [
        doneView(
          'check',
          t('packs.importedTitle', { name: r.instance.name }),
          h('p', { class: 'pk-done-text' }, r.updatable ? t('packs.importedUpdatable') : t('packs.importedText')),
          r.prepareError ? h('div', { class: 'notice pk-done-note' }, icon('alert'), h('div', {}, t('packs.prepareLater', { error: r.prepareError }))) : null,
          (r.warnings || []).map((w) => h('div', { class: 'notice pk-done-note' }, icon('alert'), h('div', {}, codeText('packs.wi_', w)))),
          manual.length
            ? h(
                'div',
                { class: 'pk-manual' },
                h('div', { class: 'pk-manual-title' }, icon('alert'), t('packs.manualTitle', { count: manual.length })),
                h('p', { class: 'small muted' }, t('packs.manualText')),
                h(
                  'ul',
                  { class: 'pk-manual-list' },
                  manual.map((x) =>
                    h(
                      'li',
                      {},
                      h('div', { class: 'pk-manual-name ellipsis', title: [x.title, x.file, x.folder ? `${x.folder}/` : null].filter(Boolean).join(' · ') }, x.title, x.file ? h('span', { class: 'pk-manual-meta' }, ` · ${x.file}`) : null, x.folder ? h('span', { class: 'pk-manual-meta' }, ` → ${x.folder}/`) : null),
                      x.url ? h('button', { type: 'button', class: 'btn sm', onclick: () => api.app.openExternal(x.url).catch(() => {}) }, icon('external'), t('packs.openPage')) : null,
                    ),
                  ),
                ),
              )
            : null,
        ),
      ],
      [
        h('button', { type: 'button', class: 'btn ghost', onclick: () => ui.m.close() }, t('packs.close')),
        h(
          'button',
          {
            type: 'button',
            class: 'btn primary',
            onclick: () => {
              ui.m.close();
              navigate(`instance/${encodeURIComponent(r.instance.id)}`);
            },
          },
          icon('arrowRight'),
          t('packs.openInstance'),
        ),
      ],
    );
  }

  if (typeof filePath === 'string' && filePath) inspect(filePath);
  else showPick();
}
