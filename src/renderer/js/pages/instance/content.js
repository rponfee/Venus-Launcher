// Contenido de la instancia: mods, resource packs, shaders y data packs (por mundo).
// Buscar, filtrar activos/desactivados, activar/desactivar, borrar (a la papelera), abrir carpeta,
// agregar archivos (boton o arrastrando), "Agregar contenido" (Modrinth) y "Buscar actualizaciones"
// (modulo compat). Titulo e icono: Modrinth (proceso principal), CurseForge (inst.curseforge.projects)
// o la identificacion por hash de Modrinth.
import { h, icon, mount, modal, ok, fail, confirmDialog, emptyState, skeleton, fmtBytes, debounce, switchEl, selectEl } from '../../ui.js';
import { api } from '../../store.js';
import { t } from '../../i18n.js';
import { navigate } from '../../app.js';
import { iconButton, runFeature, supportsMods, supportsShaders, dropZone, openFolder } from '../versions/common.js';
import { curseforgeRecords, curseforgeUrl } from './records.js';

export const CONTENT_KINDS = ['mods', 'resourcepacks', 'shaderpacks', 'datapacks'];
const MODRINTH_TYPE = { mods: 'mod', resourcepacks: 'resourcepack', shaderpacks: 'shader', datapacks: 'datapack' };
const ICONS = { mods: 'puzzle', resourcepacks: 'palette', shaderpacks: 'sun', datapacks: 'box' };
const FILTERS = { mods: [{ name: 'Mods', extensions: ['jar'] }], datapacks: [{ name: 'Data packs', extensions: ['zip'] }] };
const identifyCache = new Map(); // "<id>|<carpeta>" -> { archivo: datos de Modrinth }

async function addOptifine(inst, done) {
  const list = await api.loaders.versions('optifine', inst.mcVersion).catch(() => []);
  if (!list.length) return fail(t('instance.optifineNone'), t('instance.optifineNoneText', { version: inst.mcVersion }));
  let pick = list[0].version;
  const sel = selectEl(
    list.map((l) => ({ value: l.version, label: l.forge && l.forge !== 'N/A' ? t('instance.optifineEditionForge', { edition: l.label, forge: l.forge }) : l.label })),
    pick,
    (v) => (pick = v),
  );
  sel.id = 'ih-of-edition';
  const m = modal({
    title: t('instance.optifineTitle'),
    body: h('div', { class: 'stack' }, h('div', { class: 'field' }, h('label', { for: 'ih-of-edition' }, t('instance.optifineEdition')), sel), h('div', { class: 'small muted' }, t('instance.optifineWarning'))),
    footer: [
      h('button', { class: 'btn ghost', type: 'button', onclick: () => m.close() }, t('instance.cancel')),
      h(
        'button',
        {
          class: 'btn primary',
          type: 'button',
          onclick: async () => {
            m.close();
            try {
              await api.instances.addOptifine(inst.id, pick);
              ok(t('instance.optifineAdded'));
              done();
            } catch (err) {
              fail(t('instance.optifineFailed'), err);
            }
          },
        },
        t('instance.add'),
      ),
    ],
  });
  return undefined;
}

export function contentTab(container, ctx, kind, sub = []) {
  const inst = ctx.inst;
  let alive = true;
  const state = { files: [], ids: {}, cf: {}, query: '', filter: 'all', worlds: null, world: kind === 'datapacks' ? sub[0] || null : null, loading: true, error: null };
  const listBox = h('div', { class: 'list ih-files' });
  const chipsBox = h('div', { class: 'chips', role: 'group', 'aria-label': t('instance.filterLabel') });
  const countBox = h('span', { class: 'small muted num' });
  const subbar = h('div', { class: 'ih-subbar' }, chipsBox, h('span', { class: 'spacer' }), countBox);
  const worldBox = h('div', { class: 'ih-world-pick' });
  const modsNoticeText = kind === 'mods' && !supportsMods(inst) ? (inst.loader === 'optifine' ? t('instance.noticeOptifineMods') : t('instance.noticeVanillaMods')) : null;
  const modsNotice = modsNoticeText ? h('div', { class: 'notice info' }, icon('info'), h('div', {}, modsNoticeText)) : null;

  const folder = () => (kind === 'datapacks' ? (state.world ? `saves/${state.world}/datapacks` : null) : kind);
  const label = t(`instance.tab_${kind}`);

  const search = h('input', { class: 'input', type: 'search', placeholder: t('instance.searchIn', { what: label }), 'aria-label': t('instance.searchIn', { what: label }), autocomplete: 'off', spellcheck: 'false' });
  search.addEventListener('input', debounce(() => ((state.query = search.value.toLowerCase().trim()), draw()), 120));
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && search.value) {
      e.stopPropagation();
      clearSearch();
    }
  });

  function clearSearch() {
    search.value = '';
    state.query = '';
    draw();
    search.focus();
  }

  // Datos de CurseForge del archivo (los de Modrinth llegan en f.title/f.icon desde el proceso principal)
  const cfOf = (f) => state.cf[f.file.replace(/\.disabled$/, '')] || null;

  const matches = (f) => {
    if (state.filter === 'on' && !f.enabled) return false;
    if (state.filter === 'off' && f.enabled) return false;
    if (!state.query) return true;
    const id = state.ids[f.file] || {};
    return `${f.file} ${f.title || ''} ${cfOf(f)?.title || ''} ${id.title || ''}`.toLowerCase().includes(state.query);
  };

  function drawChips() {
    const on = state.files.filter((f) => f.enabled).length;
    const off = state.files.length - on;
    mount(
      chipsBox,
      [
        ['all', t('instance.filterAll'), state.files.length],
        ['on', t('instance.filterEnabled'), on],
        ['off', t('instance.filterDisabled'), off],
      ].map(([v, text, n]) =>
        h(
          'button',
          { type: 'button', class: ['chip', state.filter === v && 'active'], 'aria-pressed': String(state.filter === v), onclick: () => ((state.filter = v), draw()) },
          text,
          h('span', { class: 'vs-chip-count' }, String(n)),
        ),
      ),
    );
  }

  async function toggle(f) {
    try {
      await api.instances.toggleFile(inst.id, folder(), f.file);
      await load({ quiet: true });
    } catch (err) {
      fail(t('instance.toggleFailed'), err);
      draw();
    }
  }

  async function remove(f, title) {
    if (!(await confirmDialog(t('instance.deleteFileTitle'), t('instance.deleteFileText', { name: title }), { okText: t('instance.delete'), danger: true }))) return;
    try {
      await api.instances.deleteFile(inst.id, folder(), f.file);
      ok(t('instance.fileDeleted'), title);
    } catch (err) {
      fail(t('instance.deleteFileFailed'), err);
    }
    await load({ quiet: true });
    ctx.refreshCounts();
  }

  function item(f) {
    const id = state.ids[f.file] || {};
    const cf = cfOf(f) || {};
    const known = f.title || cf.title || id.title;
    // Sin datos del proyecto, el titulo es el nombre del archivo sin la extension (el archivo completo queda en el title)
    const fileName = f.file.replace(/\.disabled$/, '');
    const title = known || (f.isDir ? fileName : fileName.replace(/\.(jar|zip|litemod)$/i, ''));
    const img = f.icon || cf.icon || id.icon;
    const version = f.versionNumber || cf.versionNumber || id.versionNumber;
    const cfUrl = !f.title && cf.modId ? curseforgeUrl(cf.modId) : null;
    const iconBox = h('div', { class: 'li-icon' }, img ? h('img', { src: img, alt: '', loading: 'lazy' }) : icon(ICONS[kind]));
    if (img) iconBox.firstChild.addEventListener('error', () => mount(iconBox, icon(ICONS[kind])), { once: true });
    return h(
      'div',
      { class: ['list-item', 'ih-file', !f.enabled && 'disabled'] },
      iconBox,
      h(
        'div',
        { class: 'li-main' },
        h('div', { class: 'li-title', title: known ? title : f.file }, title),
        // "v1.2.3" solo si es un numero de version (CurseForge guarda el nombre del archivo publicado)
        h(
          'div',
          { class: 'li-sub vs-dots num' },
          known ? h('span', { class: 'ellipsis', title: f.file }, f.file) : null,
          version ? h('span', { class: 'ellipsis ih-ver', title: version }, /^\d/.test(version) ? t('instance.versionShort', { version }) : version) : null,
          f.isDir ? h('span', {}, t('instance.folderItem')) : f.size ? h('span', {}, fmtBytes(f.size)) : null,
        ),
      ),
      !f.enabled ? h('span', { class: 'badge ih-off' }, t('instance.disabledBadge')) : null,
      cfUrl
        ? iconButton('external', t('instance.viewOnCurseforge'), () => api.app.openExternal(cfUrl))
        : id.slug
          ? iconButton('external', t('instance.viewOnModrinth'), () => api.app.openExternal(`https://modrinth.com/project/${encodeURIComponent(id.slug)}`))
          : null,
      f.isDir ? h('span', { class: 'ih-switch-gap', title: t('instance.folderCantToggle') }) : switchEl(f.enabled, () => toggle(f), f.enabled ? t('instance.disableItem', { name: title }) : t('instance.enableItem', { name: title })),
      iconButton('trash', t('instance.deleteItem', { name: title }), () => remove(f, title), 'danger'),
    );
  }

  // Accion del estado vacio: sin loader de mods, crear una instancia que los cargue; si no, elegir archivos.
  function emptyAction() {
    if (kind === 'mods' && !supportsMods(inst)) {
      const target = inst.loader === 'optifine' ? 'forge' : 'fabric';
      return h(
        'button',
        { class: 'btn sm', type: 'button', onclick: () => navigate(`versions/new/${target}/${encodeURIComponent(inst.mcVersion)}`) },
        icon('plus'),
        t('instance.createWithLoader', { loader: target === 'forge' ? 'Forge' : 'Fabric' }),
      );
    }
    return h('button', { class: 'btn sm', type: 'button', onclick: pickFiles }, icon('upload'), t('instance.addFiles'));
  }

  function draw() {
    drawChips();
    const ready = !state.loading && !state.error;
    subbar.classList.toggle('hidden', !ready || !state.files.length);
    // Sin mods y sin loader que los cargue, la explicacion va en el estado vacio (no se repite arriba)
    if (modsNotice) modsNotice.classList.toggle('hidden', ready && !state.files.length);
    if (kind === 'datapacks' && !state.world) return;
    if (state.loading) {
      mount(countBox);
      mount(listBox, skeleton('list', { rows: 5 }));
      return;
    }
    if (state.error) {
      mount(countBox);
      mount(
        listBox,
        h(
          'div',
          { class: 'notice bad ih-error', role: 'alert' },
          icon('alert'),
          h('div', {}, h('strong', {}, t('instance.loadFailed')), h('div', { class: 'small' }, state.error)),
          h('button', { class: 'btn sm', type: 'button', onclick: () => load() }, icon('refresh'), t('common.retry')),
        ),
      );
      return;
    }
    const shown = state.files.filter(matches);
    mount(countBox, state.files.length ? t('instance.itemsCount', { count: state.files.length }) : '');
    if (!state.files.length) {
      mount(listBox, emptyState(ICONS[kind], t(`instance.empty_${kind}`), modsNotice ? modsNoticeText : t('instance.emptyContentText'), emptyAction()));
      return;
    }
    if (!shown.length) {
      mount(
        listBox,
        emptyState(
          'search',
          t('instance.noMatch'),
          state.query ? t('instance.noMatchQuery', { query: state.query }) : null,
          state.query
            ? h('button', { class: 'btn sm', type: 'button', onclick: clearSearch }, icon('x'), t('versions.clearSearch'))
            : h('button', { class: 'btn sm', type: 'button', onclick: () => ((state.filter = 'all'), draw()) }, t('instance.showAll')),
        ),
      );
      return;
    }
    mount(listBox, shown.map(item));
  }

  async function load({ quiet = false } = {}) {
    const f = folder();
    if (!f) return;
    if (!quiet) {
      state.loading = true;
      draw();
    }
    try {
      state.files = await api.instances.content(inst.id, f);
      state.error = null;
    } catch (err) {
      state.error = err.message;
      state.files = [];
    }
    state.loading = false;
    if (!alive) return;
    const key = `${inst.id}|${f}`;
    state.ids = identifyCache.get(key) || {};
    // ctx.inst se actualiza cuando cambia la instancia (por ejemplo, despues de instalar desde CurseForge)
    state.cf = curseforgeRecords(ctx.inst, f);
    draw();
    const unknown = state.files.some((x) => !x.title && !x.isDir && !state.ids[x.file] && !cfOf(x));
    if (unknown) {
      api.modrinth
        .identify(inst.id, f)
        .then((r) => {
          identifyCache.set(key, { ...(identifyCache.get(key) || {}), ...(r || {}) });
          if (!alive || folder() !== f) return;
          state.ids = identifyCache.get(key);
          draw();
        })
        .catch(() => {});
    }
  }

  async function addFiles(paths) {
    const f = folder();
    if (!f) return;
    try {
      const added = await api.instances.addFiles(inst.id, f, paths);
      if (added?.length) ok(t('instance.filesAdded', { count: added.length }));
    } catch (err) {
      fail(t('instance.addFilesFailed'), err);
    }
    await load({ quiet: true });
    ctx.refreshCounts();
  }

  async function pickFiles() {
    const paths = await api.app.selectFiles({ title: t('instance.pickFiles', { what: label }), multi: true, filters: FILTERS[kind] || [{ name: 'Packs', extensions: ['zip'] }] });
    if (paths.length) addFiles(paths);
  }

  // ---------- Data packs: selector de mundo ----------
  async function loadWorlds() {
    try {
      state.worlds = await api.instances.content(inst.id, 'saves');
    } catch {
      state.worlds = [];
    }
    if (!alive) return;
    if (!state.worlds.length) {
      mount(body, h('div', { class: 'card flat' }, emptyState('globe', t('instance.datapacksNoWorlds'), t('instance.datapacksNoWorldsText'), h('button', { class: 'btn sm', type: 'button', onclick: () => ctx.goTab('worlds') }, icon('globe'), t('instance.tab_worlds')))));
      return;
    }
    if (!state.world || !state.worlds.some((w) => w.folder === state.world)) state.world = state.worlds[0].folder;
    const sel = selectEl(
      state.worlds.map((w) => ({ value: w.folder, label: w.displayName === w.folder ? w.folder : t('instance.worldOption', { name: w.displayName, folder: w.folder }) })),
      state.world,
      (v) => {
        state.world = v;
        ctx.setRoute('datapacks', v);
        load();
      },
    );
    sel.setAttribute('aria-label', t('instance.datapacksWorld'));
    sel.title = t('instance.datapacksWorld');
    mount(worldBox, icon('globe'), sel);
    load();
  }

  // ---------- Avisos y barra ----------
  const notices = [];
  if (modsNotice) notices.push(modsNotice);
  if (kind === 'shaderpacks' && !supportsShaders(inst)) {
    notices.push(h('div', { class: 'notice info' }, icon('info'), h('div', {}, t('instance.noticeShaders'))));
  }
  if (kind === 'datapacks') notices.push(h('div', { class: 'notice info' }, icon('info'), h('div', {}, t('instance.noticeDatapacks'))));

  const actions = h(
    'div',
    { class: 'ih-actions-row' },
    h('button', { class: 'btn modrinth soft sm', type: 'button', onclick: () => navigate(`modrinth/${encodeURIComponent(inst.id)}/${MODRINTH_TYPE[kind]}`) }, icon('package'), t('instance.addContent')),
    kind === 'mods' && supportsMods(inst)
      ? h(
          'button',
          {
            class: 'btn sm',
            type: 'button',
            onclick: async () => {
              await runFeature('compat', 'openModUpdates', inst.id);
              if (alive) load({ quiet: true });
            },
          },
          icon('refresh'),
          t('instance.checkUpdates'),
        )
      : null,
    kind === 'mods' && inst.loader === 'forge' ? h('button', { class: 'btn sm', type: 'button', onclick: () => addOptifine(inst, () => load({ quiet: true })) }, icon('zap'), t('instance.addOptifine')) : null,
    iconButton('upload', t('instance.addFiles'), pickFiles),
    iconButton('folder', t('instance.openFolder'), () => {
      const f = folder();
      openFolder(inst, f || 'saves');
    }),
  );

  const body = h('div', { class: 'stack ih-content' });
  mount(
    container,
    h(
      'div',
      { class: 'stack' },
      notices,
      h('div', { class: 'ih-toolbar' }, kind === 'datapacks' ? worldBox : null, h('div', { class: 'input-icon ih-search' }, icon('search'), search), actions),
      subbar,
      body,
    ),
  );
  mount(body, h('div', { class: 'card flat ih-listcard' }, listBox));

  const offDrop = dropZone(container.closest('.page') || container, {
    label: t('instance.dropTitle', { what: label }),
    hint: kind === 'mods' ? t('instance.dropHintMods') : kind === 'datapacks' ? t('instance.dropHintDatapacks') : t('instance.dropHintPacks'),
    enabled: () => Boolean(folder()),
    onFiles: addFiles,
  });

  if (kind === 'datapacks') {
    draw();
    mount(listBox, skeleton('list', { rows: 3 }));
    loadWorlds();
  } else load();

  return () => {
    alive = false;
    offDrop();
  };
}

// Pestania "Contenido": selector de tipo (con cantidades) + lista del tipo elegido.
export function contentHub(container, ctx, kind, sub = []) {
  let current = CONTENT_KINDS.includes(kind) ? kind : 'mods';
  let cleanup = null;
  const nav = h('div', { class: 'segmented ih-kinds', role: 'tablist', 'aria-label': t('instance.tab_content') });
  const area = h('div');

  const drawNav = () => {
    const c = ctx.counts || {};
    mount(
      nav,
      CONTENT_KINDS.map((k) =>
        h(
          'button',
          {
            type: 'button',
            role: 'tab',
            class: current === k ? 'active' : '',
            'aria-selected': String(current === k),
            dataset: { kind: k },
            onclick: () => select(k),
          },
          icon(ICONS[k]),
          t(`instance.tab_${k}`),
          c[k] ? h('span', { class: 'vs-chip-count' }, String(c[k])) : null,
        ),
      ),
    );
  };

  function select(k, s = []) {
    if (cleanup) cleanup();
    current = k;
    ctx.setRoute(k, ...s);
    drawNav();
    cleanup = contentTab(area, ctx, k, s);
  }

  nav.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const i = CONTENT_KINDS.indexOf(current);
    const n = CONTENT_KINDS[(i + (e.key === 'ArrowRight' ? 1 : -1) + CONTENT_KINDS.length) % CONTENT_KINDS.length];
    select(n);
    nav.querySelector(`[data-kind="${n}"]`)?.focus();
  });

  mount(container, h('div', { class: 'stack ih-hub' }, nav, area));
  drawNav();
  cleanup = contentTab(area, ctx, current, sub);
  const offCounts = ctx.onCounts(drawNav);
  return () => {
    offCounts();
    if (cleanup) cleanup();
  };
}
