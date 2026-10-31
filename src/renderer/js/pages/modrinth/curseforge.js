// CurseForge dentro del catalogo: aviso cuando esta version del launcher no trae CurseForge (la API key viene
// incluida en core/app-config.js; los usuarios no cargan claves) y detalle de un proyecto
// (#/modrinth/curseforge/<id>) con descripcion, galeria y archivos.
import { h, icon, mount, emptyState, skeleton, fmtNumber, fmtAgo, fmtDate, fmtBytes, selectEl } from '../../ui.js';
import { store, api } from '../../store.js';
import { navigate } from '../../app.js';
import { t } from '../../i18n.js';
import { typeLabelOne, typeIcon, loaderName, loaderChip, versionSummary, projectIcon, fmtInt, channelPill, cfInstalledIn, extLink, keepFocus } from './shared.js';
import { renderHtml } from './markdown.js';
import { openLightbox } from './lightbox.js';
import { backLink, detailSkeleton, detailError, detailTabs, galleryGrid, asideCard, linkRow, heroStats, factRow } from './detail.js';
import { openInstallDialog } from '../../features/install.js';

// CurseForge no disponible en esta version (sin API key en core/app-config.js). onBack: volver a Modrinth.
export function cfUnavailableCard({ onBack } = {}) {
  return h(
    'div',
    { class: 'card mx-cf-setup' },
    h('div', { class: 'mx-cf-art', 'aria-hidden': 'true' }, icon('flame')),
    h(
      'div',
      { class: 'mx-cf-main' },
      h('h2', { class: 'mx-cf-title' }, t('modrinth.cfOffTitle')),
      h('p', { class: 'mx-cf-text' }, t('modrinth.cfOffText')),
      onBack ? h('div', { class: 'mx-cf-actions' }, h('button', { type: 'button', class: 'btn modrinth soft', onclick: onBack }, icon('package'), t('modrinth.cfOffBack'))) : null,
    ),
  );
}

// ---------- Detalle ----------

export function renderCurseForgeDetail(root, id) {
  let alive = true;
  const offs = [];
  const container = h('div', { class: 'mx-detail mx-cfdetail' }, detailSkeleton());
  mount(root, backLink(), container);
  root.scrollTop = 0;

  async function load() {
    mount(container, detailSkeleton());
    let status;
    try {
      status = await api.invoke('curseforge:status');
    } catch (err) {
      status = { configured: false, unavailable: /no handler/i.test(err?.message || '') };
    }
    if (!alive) return;
    if (!status.configured) {
      mount(container, cfUnavailableCard({ onBack: () => navigate('modrinth') }));
      return;
    }
    let project;
    try {
      project = await api.invoke('curseforge:project', Number(id));
    } catch (err) {
      if (alive) mount(container, detailError(err, load));
      return;
    }
    if (alive) build(project);
  }

  function build(p) {
    const install = (opts = {}) => openInstallDialog({ ...p, source: 'curseforge' }, { type: p.project_type, ...opts }).then((r) => r && alive && drawInstalled());
    const installedSlot = h('div', { class: 'mx-installed-note' });
    const site = p.links?.website;
    const hero = h(
      'section',
      { class: 'mx-hero cf', style: { '--c': '#f16436' } },
      h(
        'div',
        { class: 'mx-hero-top' },
        projectIcon(p.icon_url, 'mx-hero-icon', p.title),
        h(
          'div',
          { class: 'mx-hero-main' },
          h('div', { class: 'mx-hero-kicker' }, h('span', { class: 'badge mx-cfbadge' }, 'CurseForge'), h('span', { class: 'badge' }, icon(typeIcon(p.project_type)), typeLabelOne(p.project_type)), p.allowDistribution ? null : h('span', { class: 'badge warn', title: t('modrinth.cfNoDistributionText') }, icon('alert'), t('modrinth.cfNoDistribution'))),
          h('h1', { class: 'mx-hero-title' }, p.title),
          p.authors?.length
            ? h('div', { class: 'mx-hero-author' }, t('modrinth.byPrefix'), ' ', p.authors.slice(0, 3).map((a, i) => [i ? ', ' : '', a.url && /^https:\/\//i.test(a.url) ? extLink(a.url, a.name) : a.name]))
            : null,
          h('p', { class: 'mx-hero-desc selectable' }, p.description),
          h('div', { class: 'mx-hero-tags' }, (p.categories || []).slice(0, 6).map((c) => h('span', { class: 'mx-tag' }, c.name)), (p.loaders || []).map((l) => loaderChip(l))),
        ),
        h(
          'div',
          { class: 'mx-hero-side' },
          h('button', { type: 'button', class: 'btn primary lg mx-hero-install', onclick: () => install() }, icon('download'), p.project_type === 'modpack' ? t('modrinth.installModpack') : t('modrinth.install')),
          installedSlot,
          site ? h('div', { class: 'mx-hero-actions' }, h('button', { type: 'button', class: 'btn sm ghost', title: site, onclick: () => window.venus.app.openExternal(site).catch(() => {}) }, icon('external'), 'curseforge.com')) : null,
        ),
      ),
      heroStats([
        ['download', fmtNumber(p.downloads), t('modrinth.statDownloads'), fmtInt(p.downloads)],
        p.thumbsUp ? ['star', fmtNumber(p.thumbsUp), t('modrinth.statLikes'), fmtInt(p.thumbsUp)] : null,
        ['refresh', fmtAgo(Date.parse(p.date_modified)), t('modrinth.statUpdated'), fmtDate(p.date_modified)],
        ['calendar', fmtDate(p.date_created), t('modrinth.statPublished')],
      ]),
    );

    function drawInstalled() {
      const list = cfInstalledIn(p.id);
      mount(
        installedSlot,
        list.length
          ? h(
              'div',
              { class: 'mx-inst-list' },
              h('span', { class: 'mx-inst-label' }, t('modrinth.installedInLabel')),
              list.slice(0, 4).map((x) => h('button', { type: 'button', class: 'mx-inst-chip cf', title: x.name, onclick: () => navigate(`instance/${encodeURIComponent(x.id)}`) }, icon('layers'), h('span', { class: 'ellipsis' }, x.name))),
              list.length > 4 ? h('span', { class: 'mx-inst-label' }, t('modrinth.andMore', { count: list.length - 4 })) : null,
            )
          : null,
      );
    }
    drawInstalled();
    offs.push(store.on('instances', () => alive && drawInstalled()));

    const gallery = (p.screenshots || []).map((s) => ({ url: s.thumb || s.url, raw: s.url, title: s.title, description: s.description }));
    let tab = 'description';
    const tabsBox = h('div', { class: 'mx-dtabs-wrap' });
    const panel = h('div', { class: 'mx-dpanel', role: 'tabpanel', id: 'mx-tabpanel' });
    let descEl = null;
    const tabs = () => [{ id: 'description', icon: 'fileText', label: t('modrinth.tabDescription') }, gallery.length ? { id: 'gallery', icon: 'image', label: t('modrinth.tabGallery'), count: gallery.length } : null, { id: 'files', icon: 'layers', label: t('modrinth.tabFiles') }].filter(Boolean);
    const drawTabs = () => keepFocus(tabsBox, () => mount(tabsBox, detailTabs(tabs(), tab, (x) => ((tab = x), drawTabs(), drawPanel()))));
    function drawPanel() {
      panel.setAttribute('aria-labelledby', `mx-tab-${tab}`);
      if (tab === 'description') {
        descEl = descEl || (p.body?.trim() ? renderHtml(p.body, { onImage: (imgs, i) => openLightbox(imgs, i) }) : emptyState('fileText', t('modrinth.noDescription')));
        mount(panel, h('div', { class: 'card mx-desc' }, descEl));
      } else if (tab === 'gallery') mount(panel, galleryGrid(gallery));
      else filesPanel(panel, p, install);
    }
    drawTabs();
    drawPanel();

    const links = [];
    if (site) links.push(linkRow('globe', t('modrinth.linkCurseForge'), site));
    if (p.links?.wiki) links.push(linkRow('fileText', t('modrinth.linkWiki'), p.links.wiki));
    if (p.links?.issues) links.push(linkRow('bug', t('modrinth.linkIssues'), p.links.issues));
    if (p.links?.source) links.push(linkRow('code', t('modrinth.linkSource'), p.links.source));
    const recent = [...(p.gameVersions || [])].sort((a, b) => b.localeCompare(a, 'en', { numeric: true })).slice(0, 8);
    const aside = h(
      'aside',
      { class: 'mx-aside' },
      asideCard(
        t('modrinth.compatibility'),
        'check',
        factRow(t('modrinth.minecraft'), versionSummary([...(p.gameVersions || [])].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })), 2) || '—'),
        recent.length ? h('div', { class: 'mx-vchips' }, recent.map((v) => h('span', { class: 'mx-vchip' }, v))) : null,
        p.loaders?.length ? factRow(t('modrinth.loaders'), h('span', { class: 'mx-chiprow' }, p.loaders.map((l) => loaderChip(l)))) : null,
      ),
      links.length ? asideCard(t('modrinth.links'), 'link', h('div', { class: 'mx-links' }, links)) : null,
      asideCard(
        t('modrinth.details'),
        'info',
        factRow(t('modrinth.published'), fmtDate(p.date_created)),
        factRow(t('modrinth.updated'), fmtDate(p.date_modified)),
        factRow(t('modrinth.projectId'), h('span', { class: 'mono' }, String(p.id))),
        factRow(t('modrinth.cfDistribution'), p.allowDistribution ? t('modrinth.cfDistributionYes') : t('modrinth.cfDistributionNo')),
      ),
    );
    mount(container, hero, h('div', { class: 'mx-dgrid' }, h('div', { class: 'mx-dmain' }, tabsBox, panel), aside));
  }

  load();
  return () => {
    alive = false;
    offs.forEach((off) => off());
  };
}

function filesPanel(panel, p, install) {
  const st = { gv: '', loader: '', index: 0, files: [], total: 0, loading: false, error: null };
  const list = h('div', { class: 'mx-vlist mx-cffiles' });
  const more = h('div');
  const versions = [...(p.gameVersions || [])].sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
  const gvSel = selectEl([{ value: '', label: t('modrinth.allGameVersions') }, ...versions.map((v) => ({ value: v, label: v }))], '', (v) => ((st.gv = v), reset()));
  gvSel.setAttribute('aria-label', t('modrinth.gameVersion'));
  const loaderSel = p.project_type === 'mod' || p.project_type === 'modpack' ? selectEl([{ value: '', label: t('modrinth.allLoaders') }, ...['forge', 'fabric', 'neoforge', 'quilt'].map((l) => ({ value: l, label: loaderName(l) }))], '', (v) => ((st.loader = v), reset())) : null;
  loaderSel?.setAttribute('aria-label', t('modrinth.loaders'));
  const countEl = h('span', { class: 'mx-vcount num', 'aria-live': 'polite' });
  mount(panel, h('div', { class: 'mx-vfilters' }, gvSel, loaderSel, h('span', { class: 'spacer' }), countEl), list, more);

  function reset() {
    st.index = 0;
    st.files = [];
    st.total = 0;
    st.error = null;
    mount(list, skeleton('list', { rows: 6, label: t('modrinth.loadingFiles') }));
    load();
  }

  async function load() {
    if (st.loading) return;
    st.loading = true;
    drawMore();
    try {
      const res = await api.invoke('curseforge:files', p.id, { gameVersion: st.gv || undefined, loader: st.loader || undefined, index: st.index, pageSize: 50 });
      st.files.push(...(res.files || []));
      st.total = res.total || st.files.length;
      st.index += 50;
    } catch (err) {
      st.error = err?.message || String(err);
    }
    st.loading = false;
    draw();
  }

  function row(f) {
    return h(
      'div',
      { class: 'mx-ver' },
      h(
        'div',
        { class: 'mx-ver-row' },
        h('div', { class: 'mx-ver-toggle static' }, channelPill(f.releaseType), h('span', { class: 'mx-ver-name' }, h('span', { class: 'ellipsis mx-ver-title', title: f.displayName }, f.displayName), h('span', { class: 'ellipsis mx-ver-sub num' }, t('modrinth.fileLine', { date: fmtDate(f.date), size: fmtBytes(f.size) })))),
        h('div', { class: 'mx-ver-meta' }, h('span', { class: 'mx-chiprow' }, f.loaders.slice(0, 3).map((l) => loaderChip(l))), h('span', { class: 'ellipsis mx-ver-gv', title: f.gameVersions.join(', ') }, versionSummary(f.gameVersions, 3))),
        h('span', { class: 'mx-ver-dl num', title: t('modrinth.downloadsTitle', { n: fmtInt(f.downloads) }) }, icon('download'), fmtNumber(f.downloads)),
        f.downloadUrl
          ? h('button', { type: 'button', class: 'btn sm mx-soft cf mx-ver-install', title: t('modrinth.installVersion', { version: f.displayName }), 'aria-label': t('modrinth.installVersion', { version: f.displayName }), onclick: () => install({ fileId: f.id }) }, icon('download'))
          : h('button', { type: 'button', class: 'btn sm', title: t('modrinth.cfManualTitle'), onclick: () => window.venus.app.openExternal(`${(p.links?.website || '').replace(/\/+$/, '')}/files/${f.id}`).catch(() => {}) }, icon('external'), t('modrinth.cfManual')),
      ),
    );
  }

  function draw() {
    countEl.textContent = st.total ? t('modrinth.filesShown', { shown: st.files.length, count: st.total }) : '';
    if (st.error && !st.files.length) {
      mount(
        list,
        h(
          'div',
          { class: 'notice bad mx-err', role: 'alert' },
          icon('alert'),
          h('div', { class: 'spacer' }, h('strong', {}, t('modrinth.filesFailed')), h('div', { class: 'mx-err-text' }, st.error)),
          h('button', { class: 'btn sm', type: 'button', onclick: reset }, icon('refresh'), t('modrinth.retry')),
        ),
      );
    } else if (!st.files.length) mount(list, h('div', { class: 'mx-empty' }, emptyState('layers', t('modrinth.noFilesMatch'), t('modrinth.noVersionsMatchText'))));
    else mount(list, st.files.map(row));
    drawMore();
  }

  function drawMore() {
    if (st.loading && st.files.length) return mount(more, h('div', { class: 'mx-more', role: 'status' }, h('div', { class: 'spinner', 'aria-hidden': 'true' }), t('modrinth.loadingMore')));
    if (st.error && st.files.length) {
      return mount(more, h('div', { class: 'notice bad mx-err', role: 'alert' }, icon('alert'), h('div', { class: 'spacer' }, h('strong', {}, t('modrinth.filesFailed')), h('div', { class: 'mx-err-text' }, st.error)), h('button', { class: 'btn sm', type: 'button', onclick: () => ((st.error = null), load()) }, icon('refresh'), t('modrinth.retry'))));
    }
    if (st.files.length && st.files.length < st.total) return mount(more, h('button', { type: 'button', class: 'btn sm mx-vmore', onclick: load }, icon('chevronDown'), t('modrinth.showMoreFiles')));
    mount(more);
  }

  reset();
}
