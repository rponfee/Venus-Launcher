// Resumen de la instancia: tiempo jugado, partidas, espacio en disco, instalacion, contenido,
// herramientas (contratos de otros modulos) y accesos a mundos y capturas recientes.
import { h, icon, mount, fmtAgo, fmtBytes, fmtDate, fmtDuration, fmtNumber, sectionTitle } from '../../ui.js';
import { api } from '../../store.js';
import { t } from '../../i18n.js';
import { versionKind } from '../versions/catalog.js';
import { instanceBadge, kindLabel, supportsMods, runFeature, mirrorServer, repairInstance, openFolder, fileUrl, playInstance, skeletonBlocks } from '../versions/common.js';
import { openViewer } from './screenshots.js';

const OVERVIEW_TTL = 60 * 1000;
const overviewCache = new Map(); // id -> { at, promise }
let manifestPromise = null;

// Resumen del proceso principal (tamanio y conteos) con una cache corta para no recorrer el disco en cada pestania.
export function getOverview(id) {
  const c = overviewCache.get(id);
  if (c && Date.now() - c.at < OVERVIEW_TTL) return c.promise;
  const promise = api.instances.content(id, '@overview');
  overviewCache.set(id, { at: Date.now(), promise });
  promise.catch(() => overviewCache.delete(id));
  return promise;
}

export function invalidateOverview(id) {
  overviewCache.delete(id);
}

function manifestEntry(id) {
  if (!manifestPromise) {
    manifestPromise = api.versions.manifest(false).catch((err) => {
      manifestPromise = null;
      throw err;
    });
  }
  return manifestPromise.then((m) => (m?.versions || []).find((v) => v.id === id) || null);
}

function kpi(iconName, label, value, foot) {
  return h(
    'div',
    { class: 'card kpi ih-kpi' },
    h('div', { class: 'kpi-label' }, icon(iconName), label),
    h('div', { class: 'kpi-value ellipsis', title: typeof value === 'string' ? value : null }, value),
    h('div', { class: 'kpi-foot ellipsis', title: foot || null }, foot || ' '),
  );
}

function infoRow(label, value) {
  return [h('dt', {}, label), h('dd', {}, value)];
}

// Herramientas de la instancia (cada una abre el dialogo de su modulo). group las ordena en el resumen.
export function toolList(inst) {
  const mods = supportsMods(inst);
  return [
    { icon: 'history', key: 'snapshots', group: 'backup', run: () => runFeature('snapshots', 'openSnapshots', inst.id) },
    { icon: 'upload', key: 'export', group: 'backup', run: () => runFeature('packs', 'openExport', inst.id) },
    inst.pack || inst.modrinth?.pack ? { icon: 'upCircle', key: 'modpackUpdate', group: 'backup', run: () => runFeature('packs', 'openModpackUpdate', inst.id) } : null,
    { icon: 'share', key: 'share', group: 'backup', run: () => runFeature('share', 'openShareDialog', inst.id) },
    { icon: 'cloud', key: 'cloudSync', group: 'backup', run: () => runFeature('cloudsync', 'openCloudSync', inst.id) },
    { icon: 'users', key: 'worldToFriends', group: 'friends', run: () => runFeature('netplay', 'openWorldToFriends', inst.id) },
    { icon: 'vsServerCopy', key: 'mirror', group: 'friends', run: () => mirrorServer(inst) },
    mods ? { icon: 'refresh', key: 'modUpdates', group: 'mods', run: () => runFeature('compat', 'openModUpdates', inst.id) } : null,
    { icon: 'shieldCheck', key: 'security', group: 'mods', run: () => runFeature('analysis', 'openSecurityScan', inst.id) },
    mods ? { icon: 'diff', key: 'mixins', group: 'mods', run: () => runFeature('analysis', 'openMixinReport', inst.id) } : null,
    mods ? { icon: 'languages', key: 'translate', group: 'mods', run: () => runFeature('modtranslate', 'openModTranslate', inst.id) } : null,
    { icon: 'gauge', key: 'optimize', group: 'care', run: () => runFeature('perf', 'openOptimize', inst.id) },
    { icon: 'bug', key: 'crash', group: 'care', run: () => runFeature('crash', 'openCrashTools', inst.id) },
    { icon: 'wrench', key: 'repair', group: 'care', run: () => repairInstance(inst) },
  ].filter(Boolean);
}

const TOOL_GROUPS = ['backup', 'friends', 'mods', 'care'];

function toolRow(tool) {
  const title = t(`instance.tool_${tool.key}`);
  return h(
    'button',
    { class: 'ih-tool', type: 'button', onclick: tool.run },
    h('span', { class: 'ih-tool-icon', 'aria-hidden': 'true' }, icon(tool.icon)),
    h('span', { class: 'ih-tool-text' }, h('span', { class: 'ih-tool-title', title }, title), h('span', { class: 'ih-tool-sub' }, t(`instance.tool_${tool.key}_sub`))),
    icon('chevronRight', 'ih-tool-chev'),
  );
}

function toolGroups(inst) {
  const tools = toolList(inst);
  return h(
    'div',
    { class: 'ih-toolgroups' },
    TOOL_GROUPS.map((g) => {
      const items = tools.filter((x) => x.group === g);
      if (!items.length) return null;
      const titleId = `ih-tg-${g}`;
      return h('section', { class: 'card ih-toolgroup', 'aria-labelledby': titleId }, h('h3', { class: 'ih-toolgroup-title', id: titleId }, t(`instance.toolGroup_${g}`)), h('div', { class: 'ih-toolgroup-list' }, items.map(toolRow)));
    }),
  );
}

// Uso del disco: categorias con colores del tema (clases ih-u-*).
const USAGE = ['saves', 'mods', 'packs', 'screenshots', 'other'];

function usageBar(ov) {
  const s = ov.sizes || {};
  const parts = { saves: s.saves || 0, mods: s.mods || 0, packs: (s.resourcepacks || 0) + (s.shaderpacks || 0), screenshots: s.screenshots || 0, other: s.other || 0 };
  const total = Object.values(parts).reduce((a, b) => a + b, 0);
  if (!total) return h('div', { class: 'small muted' }, t('instance.diskEmpty'));
  const used = USAGE.filter((k) => parts[k] > 0);
  const entries = used.map((k) => t('instance.usageEntry', { label: t(`instance.usage_${k}`), size: fmtBytes(parts[k]) }));
  return h(
    'div',
    { class: 'ih-usage' },
    h(
      'div',
      { class: 'ih-usage-bar', role: 'img', 'aria-label': t('instance.diskUsageAria', { list: entries.join(', ') }) },
      used.map((k, i) => h('i', { class: `ih-u-${k}`, style: { flexGrow: String(parts[k]) }, title: entries[i] })),
    ),
    h(
      'div',
      { class: 'legend', 'aria-hidden': 'true' },
      used.map((k) => h('span', { class: 'lg-item' }, h('span', { class: `sw ih-u-${k}` }), t(`instance.usage_${k}`), h('span', { class: 'muted' }, fmtBytes(parts[k])))),
    ),
  );
}

export function overviewTab(container, ctx) {
  const inst = ctx.inst;
  let alive = true;
  let viewer = null;
  const sizeValue = h('span', { class: 'ellipsis' }, h('span', { class: 'skeleton', 'aria-hidden': 'true' }), h('span', { class: 'sr-only' }, t('instance.calculating')));
  const sizeFoot = h('span', {}, t('instance.calculating'));
  const tilesBox = h('div', { class: 'ih-tiles' }, skeletonBlocks(5, { cls: 'ih-tiles' }));
  const usageBox = h('div', { class: 'ih-usage-wrap' }, h('span', { class: 'skeleton ih-usage-skel', 'aria-hidden': 'true' }));
  const quickRow = h('dd', {}, h('span', { class: 'skeleton skeleton-line ih-quick-skel', 'aria-hidden': 'true' }));
  const mcRow = h('dd', {}, h('span', { class: 'ih-mc' }, inst.mcVersion));
  const worldsBox = h('div', { class: 'list ih-recent-worlds' });
  const shotsBox = h('div', { class: 'ih-recent-shots' });
  const recentWrap = h('div', { class: 'grid cols-2 ih-recent hidden' });

  const avg = inst.launches ? inst.playtime / inst.launches : 0;
  const kpis = h(
    'div',
    { class: 'grid cols-4 ih-kpis' },
    kpi('clock', t('instance.kpiPlaytime'), inst.playtime ? fmtDuration(inst.playtime) : '—', avg ? t('instance.kpiAverage', { time: fmtDuration(avg) }) : t('instance.neverPlayed')),
    kpi('gamepad', t('instance.kpiLaunches'), fmtNumber(inst.launches || 0), t('instance.createdOn', { date: fmtDate(inst.created) })),
    kpi('calendar', t('instance.kpiLastPlayed'), inst.lastPlayed ? fmtAgo(inst.lastPlayed) : t('instance.never'), inst.lastPlayed ? fmtDate(inst.lastPlayed, { day: 'numeric', month: 'long', year: 'numeric' }) : t('instance.neverPlayedYet')),
    h('div', { class: 'card kpi ih-kpi' }, h('div', { class: 'kpi-label' }, icon('drive'), t('instance.kpiDisk')), h('div', { class: 'kpi-value' }, sizeValue), h('div', { class: 'kpi-foot ellipsis' }, sizeFoot)),
  );

  const pack = inst.pack && typeof inst.pack === 'object' ? inst.pack : inst.modrinth?.pack;
  const install = h(
    'div',
    { class: 'card ih-install' },
    h('div', { class: 'card-head' }, h('h2', { class: 'card-title' }, icon('layers'), t('instance.installation'))),
    h(
      'dl',
      { class: 'sysinfo ih-dl' },
      h('dt', {}, 'Minecraft'),
      mcRow,
      infoRow(t('instance.loader'), instanceBadge(inst)),
      infoRow(t('instance.installedVersion'), inst.versionId ? h('span', { class: 'mono ih-mono ellipsis', title: inst.versionId }, inst.versionId) : h('span', { class: 'muted' }, t('instance.installedOnFirstPlay'))),
      infoRow('Java', inst.java?.path ? h('span', { class: 'mono ih-mono ellipsis', title: inst.java.path }, inst.java.path) : h('span', {}, t('instance.javaAuto'))),
      h('dt', {}, t('instance.quickStart')),
      quickRow,
      pack ? infoRow(t('instance.modpack'), h('span', { class: 'ellipsis' }, pack.version ? t('instance.modpackVersion', { name: pack.name || '?', version: pack.version }) : pack.name || '?')) : null,
    ),
    h(
      'div',
      { class: 'row wrap ih-card-actions' },
      h('button', { class: 'btn sm', type: 'button', onclick: () => repairInstance(inst) }, icon('wrench'), t('instance.repair')),
      h('button', { class: 'btn sm', type: 'button', onclick: () => openFolder(inst) }, icon('folder'), t('instance.openFolder')),
    ),
  );

  const contentCard = h(
    'div',
    { class: 'card ih-contentcard' },
    h('div', { class: 'card-head' }, h('h2', { class: 'card-title' }, icon('package'), t('instance.content'))),
    tilesBox,
    h('div', { class: 'divider' }),
    usageBox,
  );

  mount(
    container,
    h('div', { class: 'ih-overview' }, kpis, h('div', { class: 'grid ih-two' }, install, contentCard), sectionTitle(t('instance.tools')), toolGroups(inst), recentWrap),
  );

  manifestEntry(inst.mcVersion)
    .then((v) => {
      if (!alive || !v) return;
      mount(mcRow, h('span', { class: 'ih-mc' }, inst.mcVersion), h('span', { class: 'badge' }, kindLabel(versionKind(v))), h('span', { class: 'muted small' }, fmtDate(v.releaseTime)));
    })
    .catch(() => {});

  const tile = (tab, ic, label, count, sub) =>
    h(
      'button',
      { class: 'ih-tile', type: 'button', title: label, onclick: () => ctx.goTab(tab) },
      h('span', { class: 'ih-tile-icon', 'aria-hidden': 'true' }, icon(ic)),
      h('span', { class: 'ih-tile-count' }, fmtNumber(count || 0)),
      h('span', { class: 'ih-tile-label' }, label),
      sub ? h('span', { class: 'ih-tile-sub', title: sub }, sub) : null,
    );

  const loadOverview = () =>
    getOverview(ctx.id)
      .then((ov) => {
        if (!alive) return;
        const c = ov.counts || {};
        mount(sizeValue, fmtBytes(ov.size || 0));
        sizeValue.title = fmtBytes(ov.size || 0);
        mount(sizeFoot, ov.sizes?.saves ? t('instance.worldsSize', { size: fmtBytes(ov.sizes.saves) }) : t('instance.noWorldsYet'));
        mount(
          tilesBox,
          // Los mods solo se muestran si el loader los carga (o si igual hay archivos en la carpeta)
          supportsMods(inst) || c.mods ? tile('mods', 'puzzle', t('instance.tab_mods'), c.mods, c.modsDisabled ? t('instance.disabledCount', { count: c.modsDisabled }) : null) : null,
          tile('resourcepacks', 'palette', t('instance.tab_resourcepacks'), c.resourcepacks),
          tile('shaderpacks', 'sun', t('instance.tab_shaderpacks'), c.shaderpacks),
          tile('worlds', 'globe', t('instance.tab_worlds'), c.worlds),
          tile('screenshots', 'image', t('instance.tab_screenshots'), c.screenshots),
        );
        mount(usageBox, usageBar(ov));
        const p = ov.prepared;
        mount(quickRow, p?.fresh ? h('span', { class: 'pill good' }, icon('zap'), t('instance.quickReady', { ago: fmtAgo(p.verifiedAt) })) : h('span', { class: 'muted' }, t('instance.quickPending')));
      })
      .catch((err) => {
        if (!alive) return;
        mount(sizeValue, '—');
        mount(sizeFoot, t('instance.loadFailed'));
        sizeFoot.parentElement?.setAttribute('title', err.message || '');
        mount(
          tilesBox,
          h(
            'div',
            { class: 'notice bad ih-span ih-error', role: 'alert' },
            icon('alert'),
            h('div', {}, h('strong', {}, t('instance.loadFailed')), h('div', { class: 'small' }, err.message)),
            h(
              'button',
              {
                class: 'btn sm',
                type: 'button',
                onclick: () => {
                  invalidateOverview(ctx.id);
                  mount(tilesBox, skeletonBlocks(5, { cls: 'ih-tiles' }));
                  loadOverview();
                },
              },
              icon('refresh'),
              t('common.retry'),
            ),
          ),
        );
        mount(usageBox);
        mount(quickRow, '—');
      });
  loadOverview();

  // Mundos y capturas recientes
  Promise.all([api.instances.content(ctx.id, 'saves').catch(() => []), api.instances.content(ctx.id, 'screenshots').catch(() => [])]).then(([worlds, shots]) => {
    if (!alive || (!worlds.length && !shots.length)) return;
    recentWrap.classList.remove('hidden');
    if (worlds.length) {
      mount(
        worldsBox,
        worlds.slice(0, 3).map((w) =>
          h(
            'div',
            { class: 'list-item ih-wrow' },
            h('div', { class: 'li-icon' }, w.icon ? h('img', { src: fileUrl(w.icon, w.iconTime), alt: '' }) : icon('globe')),
            h('div', { class: 'li-main' }, h('div', { class: 'li-title', title: w.displayName }, w.displayName), h('div', { class: 'li-sub' }, t('instance.worldPlayed', { ago: fmtAgo(w.lastPlayed) }))),
            h(
              'button',
              { class: 'btn sm tonal', type: 'button', title: t('instance.playWorld', { name: w.displayName }), 'aria-label': t('instance.playWorld', { name: w.displayName }), onclick: () => playInstance(inst, { quickPlay: { world: w.folder } }) },
              icon('play'),
              t('instance.play'),
            ),
            h('button', { class: 'icon-btn sm', type: 'button', title: t('instance.worldMapOf', { name: w.displayName }), 'aria-label': t('instance.worldMapOf', { name: w.displayName }), onclick: () => runFeature('worldmap', 'openWorldMap', inst.id, w.folder) }, icon('map')),
          ),
        ),
      );
    }
    if (shots.length) {
      mount(
        shotsBox,
        shots.slice(0, 6).map((s, i) =>
          h(
            'button',
            {
              class: 'ih-shot-mini',
              type: 'button',
              title: fmtDate(s.mtime, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
              'aria-label': t('instance.openScreenshotDate', { date: fmtDate(s.mtime, { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }) }),
              onclick: () => {
                viewer = openViewer(ctx, shots, i, () => ctx.refreshCounts());
              },
            },
            h('img', { src: fileUrl(s.path, Math.round(s.mtime)), alt: '', loading: 'lazy', decoding: 'async' }),
          ),
        ),
      );
    }
    const seeAll = (tab, label) => h('button', { class: 'btn sm ghost', type: 'button', 'aria-label': label, onclick: () => ctx.goTab(tab) }, t('instance.seeAll'), icon('chevronRight'));
    mount(
      recentWrap,
      worlds.length
        ? h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', { class: 'card-title' }, icon('globe'), t('instance.recentWorlds')), seeAll('worlds', t('instance.tab_worlds'))), worldsBox)
        : null,
      shots.length
        ? h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', { class: 'card-title' }, icon('camera'), t('instance.recentScreenshots')), seeAll('screenshots', t('instance.tab_screenshots'))), shotsBox)
        : null,
    );
    if (!worlds.length || !shots.length) recentWrap.classList.remove('cols-2');
  });

  return () => {
    alive = false;
    if (viewer?.el?.isConnected) viewer.close();
  };
}
