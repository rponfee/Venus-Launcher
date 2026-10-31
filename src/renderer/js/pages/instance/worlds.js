// Mundos de la instancia: datos del level.dat (nombre, modo, version), Jugar directo (Quick Play),
// Mapa (visor de mundos), data packs, abrir carpeta, borrar (a la papelera), importar (.zip o carpeta)
// y "Nube" (sincronizacion de mundos y ajustes del modulo cloudsync).
import { h, icon, mount, ok, fail, confirmDialog, emptyState, skeleton, fmtAgo, fmtDate, debounce } from '../../ui.js';
import { store, api } from '../../store.js';
import { t } from '../../i18n.js';
import { iconButton, runFeature, dropZone, fileUrl, popMenu, playInstance, openFolder } from '../versions/common.js';

const DATE_FMT = { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' };

export function worldsTab(container, ctx) {
  const inst = ctx.inst;
  let alive = true;
  let worlds = [];
  let query = '';
  const grid = h('div', { class: 'ih-worlds' });
  const countBox = h('span', { class: 'small muted num' });

  const search = h('input', { class: 'input', type: 'search', placeholder: t('instance.searchWorlds'), 'aria-label': t('instance.searchWorlds'), autocomplete: 'off', spellcheck: 'false' });
  search.addEventListener('input', debounce(() => ((query = search.value.toLowerCase().trim()), draw()), 120));
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && search.value) {
      e.stopPropagation();
      clearSearch();
    }
  });

  function clearSearch() {
    search.value = '';
    query = '';
    draw();
    search.focus();
  }

  async function load({ quiet = false } = {}) {
    if (!quiet) {
      mount(countBox);
      mount(grid, h('div', { class: 'ih-span' }, skeleton('grid', { items: 4, min: 340, lines: 2 })));
    }
    try {
      worlds = await api.instances.content(inst.id, 'saves');
    } catch (err) {
      if (alive) {
        mount(
          grid,
          h(
            'div',
            { class: 'notice bad ih-span ih-error', role: 'alert' },
            icon('alert'),
            h('div', {}, h('strong', {}, t('instance.loadFailed')), h('div', { class: 'small' }, err.message)),
            h('button', { class: 'btn sm', type: 'button', onclick: () => load() }, icon('refresh'), t('common.retry')),
          ),
        );
      }
      return;
    }
    if (alive) draw();
  }

  async function remove(w) {
    if (store.running[inst.id]) return fail(t('instance.deleteWorldTitle'), t('instance.deleteWorldRunning'));
    if (!(await confirmDialog(t('instance.deleteWorldTitle'), t('instance.deleteWorldText', { name: w.displayName }), { okText: t('instance.delete'), danger: true }))) return undefined;
    try {
      await api.instances.deleteFile(inst.id, 'saves', w.folder);
      ok(t('instance.worldDeleted'), w.displayName);
    } catch (err) {
      fail(t('instance.deleteWorldFailed'), err);
    }
    await load({ quiet: true });
    ctx.refreshCounts();
    return undefined;
  }

  async function importWorlds(paths) {
    try {
      const added = await api.instances.addFiles(inst.id, 'saves', paths);
      if (added?.length) ok(t('instance.worldsImported', { count: added.length }), added.join(', '));
    } catch (err) {
      fail(t('instance.importWorldFailed'), err);
    }
    await load({ quiet: true });
    ctx.refreshCounts();
  }

  async function pickZip() {
    const paths = await api.app.selectFiles({ title: t('instance.importWorldPick'), multi: true, filters: [{ name: t('instance.worldZipFilter'), extensions: ['zip'] }] });
    if (paths.length) importWorlds(paths);
  }

  function card(w) {
    const meta = [
      w.gameMode ? h('span', { class: 'badge' }, t(`instance.mode_${w.gameMode}`)) : null,
      w.hardcore ? h('span', { class: 'badge bad' }, icon('skull'), t('instance.hardcore')) : null,
      w.cheats ? h('span', { class: 'badge' }, icon('wand'), t('instance.cheats')) : null,
      w.version ? h('span', { class: 'badge' }, w.version) : null,
      w.datapacks ? h('span', { class: 'badge' }, icon('box'), t('instance.datapacksCount', { count: w.datapacks })) : null,
    ];
    const more = iconButton('more', t('instance.worldMore', { name: w.displayName }), (e) => {
      e.stopPropagation();
      popMenu(more, [
        { icon: 'box', label: t('instance.tab_datapacks'), run: () => ctx.goTab('datapacks', w.folder) },
        { icon: 'folder', label: t('instance.openFolder'), run: () => openFolder(inst, `saves/${w.folder}`) },
        '-',
        { icon: 'trash', label: t('instance.deleteWorld'), danger: true, run: () => remove(w) },
      ]);
    });
    more.setAttribute('aria-haspopup', 'menu');
    const played = w.displayName !== w.folder ? t('instance.worldFolderPlayed', { folder: w.folder, ago: fmtAgo(w.lastPlayed) }) : t('instance.worldPlayed', { ago: fmtAgo(w.lastPlayed) });
    return h(
      'article',
      { class: 'ih-world', 'aria-label': w.displayName },
      h('div', { class: 'ih-world-icon' }, w.icon ? h('img', { src: fileUrl(w.icon, w.iconTime), alt: '' }) : icon('globe')),
      h(
        'div',
        { class: 'ih-world-main' },
        h('h2', { class: 'ih-world-name ellipsis', title: w.displayName }, w.displayName),
        h('div', { class: 'small muted ellipsis', title: fmtDate(w.lastPlayed, DATE_FMT) }, played),
        h('div', { class: 'row wrap ih-world-badges' }, meta),
      ),
      h(
        'div',
        { class: 'ih-world-actions' },
        h('button', { class: 'btn sm tonal', type: 'button', title: t('instance.playWorld', { name: w.displayName }), 'aria-label': t('instance.playWorld', { name: w.displayName }), onclick: () => playInstance(inst, { quickPlay: { world: w.folder } }) }, icon('play'), t('instance.play')),
        h('button', { class: 'btn sm', type: 'button', title: t('instance.worldMapOf', { name: w.displayName }), 'aria-label': t('instance.worldMapOf', { name: w.displayName }), onclick: () => runFeature('worldmap', 'openWorldMap', inst.id, w.folder) }, icon('map'), t('instance.worldMap')),
        more,
      ),
    );
  }

  function draw() {
    mount(countBox, worlds.length ? t('instance.worldsCount', { count: worlds.length }) : '');
    if (!worlds.length) {
      mount(
        grid,
        h(
          'div',
          { class: 'card flat ih-span' },
          emptyState('globe', t('instance.noWorlds'), t('instance.noWorldsText'), h('button', { class: 'btn sm', type: 'button', onclick: pickZip }, icon('upload'), t('instance.importWorld'))),
        ),
      );
      return;
    }
    const shown = worlds.filter((w) => !query || `${w.displayName} ${w.folder}`.toLowerCase().includes(query));
    if (!shown.length) {
      mount(
        grid,
        h('div', { class: 'card flat ih-span' }, emptyState('search', t('instance.noMatch'), t('instance.noMatchQuery', { query }), h('button', { class: 'btn sm', type: 'button', onclick: clearSearch }, icon('x'), t('versions.clearSearch')))),
      );
      return;
    }
    mount(grid, shown.map(card));
  }

  mount(
    container,
    h(
      'div',
      { class: 'stack' },
      h(
        'div',
        { class: 'ih-toolbar' },
        h('div', { class: 'input-icon ih-search' }, icon('search'), search),
        h(
          'div',
          { class: 'ih-actions-row' },
          h('button', { class: 'btn sm', type: 'button', onclick: () => runFeature('netplay', 'openWorldToFriends', inst.id) }, icon('users'), t('instance.tool_worldToFriends')),
          h('button', { class: 'btn sm', type: 'button', title: t('instance.tool_cloudSync'), onclick: () => runFeature('cloudsync', 'openCloudSync', inst.id) }, icon('cloud'), t('instance.worldsCloud')),
          h('button', { class: 'btn sm', type: 'button', onclick: pickZip }, icon('upload'), t('instance.importWorld')),
          iconButton('folder', t('instance.openSavesFolder'), () => openFolder(inst, 'saves')),
        ),
      ),
      h('div', { class: 'ih-subbar' }, countBox, h('span', { class: 'spacer' }), h('span', { class: 'tiny muted' }, icon('info'), t('instance.quickPlayHint'))),
      grid,
    ),
  );

  const offDrop = dropZone(container.closest('.page') || container, { label: t('instance.dropWorldsTitle'), hint: t('instance.dropWorldsHint'), onFiles: importWorlds });
  load();
  return () => {
    alive = false;
    offDrop();
  };
}
