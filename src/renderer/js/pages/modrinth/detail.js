// Detalle de un proyecto de Modrinth (#/modrinth/project/<id-o-slug>): encabezado con estadisticas,
// descripcion (Markdown seguro), galeria con visor, versiones con filtros y changelogs, dependencias,
// equipo y links. Tambien exporta piezas que usa el detalle de CurseForge.
import { h, icon, mount, emptyState, skeleton, fmtNumber, fmtAgo, fmtDate, fmtBytes, selectEl, copyText } from '../../ui.js';
import { store, api } from '../../store.js';
import { navigate } from '../../app.js';
import { t } from '../../i18n.js';
import {
  session,
  typeLabelOne,
  typeIcon,
  categoryLabel,
  loaderName,
  loaderChip,
  envLabel,
  versionSummary,
  projectUrl,
  projectIcon,
  fmtInt,
  sortVersions,
  channelPill,
  installedIn,
  installedInServers,
  colorOf,
  isReleaseVersion,
  MODRINTH_URL,
  extLink,
  routeLink,
  keepFocus,
  tabKeys,
  licenseLabel,
} from './shared.js';
import { renderMarkdown } from './markdown.js';
import { openLightbox } from './lightbox.js';
import { openInstallDialog } from '../../features/install.js';

const VERSIONS_STEP = 25;

// ---------- Piezas compartidas ----------

export function backLink() {
  return h(
    'a',
    {
      class: 'back-link mx-back',
      href: `#/${session.lastRoute || 'modrinth'}`,
      onclick: (e) => {
        e.preventDefault();
        navigate(session.lastRoute || 'modrinth');
      },
    },
    icon('chevronLeft'),
    t('modrinth.backToResults'),
  );
}

// Esqueleto del detalle con la forma real: heroe (icono, titulo, texto, cifras), pestañas, panel y columna lateral
export function detailSkeleton() {
  const bone = (cls, style) => h('span', { class: `skeleton ${cls}`, style: style || null });
  const line = (w, cls = '') => bone(`skeleton-line ${cls}`, { width: w });
  return h(
    'div',
    { class: 'mx-dskel skeleton-group', role: 'status', 'aria-busy': 'true' },
    h('span', { class: 'sr-only' }, t('modrinth.loadingProject')),
    h(
      'div',
      { 'aria-hidden': 'true' },
      h(
        'div',
        { class: 'mx-hero mx-skel' },
        h(
          'div',
          { class: 'mx-hero-top' },
          bone('mx-hero-icon'),
          h('div', { class: 'mx-hero-main mx-sk-stack' }, h('div', { class: 'mx-sk-row' }, bone('mx-sk-badge'), bone('mx-sk-badge')), line('42%', 'mx-sk-h1'), line('24%'), line('88%'), line('64%')),
          h('div', { class: 'mx-hero-side' }, bone('mx-sk-cta')),
        ),
        h('div', { class: 'mx-hstats' }, Array.from({ length: 5 }, () => h('div', { class: 'mx-hstat' }, bone('mx-sk-ico'), h('div', { class: 'mx-sk-stack' }, line('56px'), line('72px'))))),
      ),
      h(
        'div',
        { class: 'mx-dgrid' },
        h('div', { class: 'mx-dmain' }, bone('mx-sk-tabs'), h('div', { class: 'card mx-desc mx-sk-stack' }, line('70%'), line('96%'), line('90%'), line('80%'), bone('skeleton-block', { height: '160px' }))),
        h('div', { class: 'mx-aside' }, [3, 4].map((n) => h('div', { class: 'card mx-acard mx-sk-stack' }, line('46%'), Array.from({ length: n }, (_, i) => line(`${88 - i * 9}%`))))),
      ),
    ),
  );
}

export function detailError(err, onRetry) {
  const notFound = /no existe|not exist|not found|no encontr/i.test(err?.message || '');
  return h(
    'div',
    { class: 'card mx-derror', role: 'alert' },
    emptyState(
      notFound ? 'search' : 'alert',
      notFound ? t('modrinth.projectNotFound') : t('modrinth.projectLoadFailed'),
      err?.message || String(err),
      h(
        'div',
        { class: 'row wrap mx-derror-actions' },
        onRetry && !notFound ? h('button', { class: 'btn sm', type: 'button', onclick: onRetry }, icon('refresh'), t('modrinth.retry')) : null,
        // si no hay Reintentar, volver es la accion principal del estado
        h('button', { class: ['btn sm', onRetry && !notFound && 'ghost'], type: 'button', onclick: () => navigate(session.lastRoute || 'modrinth') }, icon('arrowLeft'), t('modrinth.backToResults')),
      ),
    ),
  );
}

// Pestañas del detalle (patron de pestañas: flechas, Inicio y Fin; solo la activa entra en el orden de Tab)
export function detailTabs(tabs, active, onSelect) {
  return h(
    'div',
    { class: 'tabs mx-dtabs', role: 'tablist', 'aria-label': t('modrinth.details'), onkeydown: tabKeys },
    tabs.map((tab) =>
      h(
        'button',
        {
          type: 'button',
          role: 'tab',
          id: `mx-tab-${tab.id}`,
          'aria-selected': active === tab.id ? 'true' : 'false',
          'aria-controls': 'mx-tabpanel',
          tabindex: active === tab.id ? 0 : -1,
          class: ['tab', active === tab.id && 'active'],
          dataset: { fk: `tab-${tab.id}` },
          onclick: () => onSelect(tab.id),
        },
        icon(tab.icon),
        tab.label,
        tab.count !== undefined && tab.count !== null ? h('span', { class: 'count' }, String(tab.count)) : null,
      ),
    ),
  );
}

// images: [{ url (miniatura), raw, title, description }]
export function galleryGrid(images) {
  if (!images.length) return emptyState('image', t('modrinth.noGallery'), t('modrinth.noGalleryText'));
  return h(
    'div',
    { class: 'mx-gallery' },
    images.map((img, i) => {
      const el = h('img', { src: img.url, alt: img.title || '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' });
      el.addEventListener('error', () => el.replaceWith(h('div', { class: 'mx-gallery-ph' }, icon('image'))), { once: true });
      return h(
        'figure',
        { class: 'mx-gitem' },
        h('button', { type: 'button', class: 'mx-gthumb', title: t('modrinth.openImage'), 'aria-label': img.title ? t('modrinth.openImageOf', { title: img.title }) : t('modrinth.openImage'), onclick: () => openLightbox(images, i) }, el, h('span', { class: 'mx-gzoom' }, icon('zoomIn'))),
        img.title || img.description ? h('figcaption', {}, img.title ? h('div', { class: 'mx-gtitle ellipsis' }, img.title) : null, img.description ? h('div', { class: 'mx-gdesc' }, img.description) : null) : null,
      );
    }),
  );
}

export function asideCard(titleText, iconName, ...children) {
  return h('section', { class: 'card mx-acard' }, h('h2', { class: 'card-title mx-atitle' }, icon(iconName), titleText), ...children);
}

export function linkRow(iconName, label, url) {
  return h('button', { type: 'button', class: 'mx-link', title: url, onclick: () => window.venus.app.openExternal(url).catch(() => {}) }, icon(iconName), h('span', { class: 'ellipsis spacer' }, label), icon('external', 'mx-link-ext'));
}

export function heroStats(list) {
  return h(
    'div',
    { class: 'mx-hstats' },
    list.filter(Boolean).map(([iconName, value, label, title]) => h('div', { class: 'mx-hstat', title: title || null }, icon(iconName), h('div', { class: 'mx-hstat-text' }, h('div', { class: 'mx-hstat-v num' }, value), h('div', { class: 'mx-hstat-l' }, label)))),
  );
}

export function factRow(label, value) {
  return h('div', { class: 'mx-fact' }, h('span', { class: 'mx-fact-l' }, label), h('span', { class: 'mx-fact-v' }, value));
}

function sortedGallery(p) {
  return [...(p.gallery || [])].sort((a, b) => Number(b.featured) - Number(a.featured) || (a.ordering ?? 0) - (b.ordering ?? 0));
}

function avatar(url, name) {
  if (url && /^https:\/\//i.test(url)) {
    const img = h('img', { class: 'mx-avatar', src: url, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
    img.addEventListener('error', () => img.replaceWith(h('div', { class: 'mx-avatar ph' }, (name || '?').charAt(0).toUpperCase())), { once: true });
    return img;
  }
  return h('div', { class: 'mx-avatar ph' }, (name || '?').charAt(0).toUpperCase());
}

const DONATION_ICONS = { patreon: 'heart', 'ko-fi': 'coffee', bmac: 'coffee', paypal: 'heart', github: 'github', other: 'heart' };

// ---------- Pagina ----------

export function renderDetail(root, idOrSlug) {
  let alive = true;
  const offs = [];
  const container = h('div', { class: 'mx-detail' }, detailSkeleton());
  mount(root, backLink(), container);
  root.scrollTop = 0;

  async function load() {
    mount(container, detailSkeleton());
    let project;
    try {
      project = await api.modrinth.project(idOrSlug);
    } catch (err) {
      if (alive) mount(container, detailError(err, load));
      return;
    }
    if (!alive) return;
    const versionsP = api.modrinth.versions(project.id, { includeChangelog: false }).then(sortVersions);
    const teamP = api.invoke('modrinth:team', project.id).catch(() => null);
    build(project, versionsP, teamP);
  }

  function build(project, versionsP, teamP) {
    const type = project.project_type;
    const env = envLabel(project);
    const gallery = sortedGallery(project).map((g) => ({ url: g.url, raw: g.raw_url, title: g.title || '', description: g.description || '' }));
    const authorSlot = h('div', { class: 'mx-hero-author' }, h('span', { class: 'skeleton skeleton-line mx-sk-author-line', 'aria-hidden': 'true' }));
    const installedSlot = h('div', { class: 'mx-installed-note' });
    const install = (opts = {}) => openInstallDialog(project, { type, ...opts }).then((r) => r && alive && drawInstalled());

    const categories = [...(project.categories || []), ...(project.additional_categories || [])].filter((c) => !(project.loaders || []).includes(c));
    const shownLoaders = (project.loaders || []).filter((l) => l !== 'minecraft');
    const versionsStat = h('span', {}, fmtInt(project.versions?.length || 0));
    const hero = h(
      'section',
      { class: 'mx-hero', style: { '--c': colorOf(project) || 'var(--modrinth)' } },
      h(
        'div',
        { class: 'mx-hero-top' },
        projectIcon(project.icon_url, 'mx-hero-icon', project.title),
        h(
          'div',
          { class: 'mx-hero-main' },
          h(
            'div',
            { class: 'mx-hero-kicker' },
            h('span', { class: 'badge modrinth' }, icon(typeIcon(type)), typeLabelOne(type)),
            env ? h('span', { class: 'badge' }, icon('monitor'), env) : null,
            project.status && project.status !== 'approved' ? h('span', { class: 'badge warn' }, t('modrinth.statusNotApproved')) : null,
          ),
          h('h1', { class: 'mx-hero-title' }, project.title),
          authorSlot,
          h('p', { class: 'mx-hero-desc selectable' }, project.description),
          h('div', { class: 'mx-hero-tags' }, categories.slice(0, 8).map((c) => h('span', { class: 'mx-tag' }, categoryLabel(c))), shownLoaders.slice(0, 6).map((l) => loaderChip(l))),
        ),
        h(
          'div',
          { class: 'mx-hero-side' },
          h('button', { type: 'button', class: 'btn modrinth lg mx-hero-install', onclick: () => install() }, icon('download'), type === 'modpack' ? t('modrinth.installModpack') : t('modrinth.install')),
          installedSlot,
          h(
            'div',
            { class: 'mx-hero-actions' },
            h('button', { type: 'button', class: 'btn sm ghost', title: projectUrl(project), onclick: () => window.venus.app.openExternal(projectUrl(project)).catch(() => {}) }, icon('external'), 'modrinth.com'),
            h('button', { type: 'button', class: 'icon-btn sm', title: t('modrinth.copyLink'), 'aria-label': t('modrinth.copyLink'), onclick: () => copyText(projectUrl(project), t('modrinth.linkCopied')) }, icon('link')),
          ),
        ),
      ),
      heroStats([
        ['download', fmtNumber(project.downloads), t('modrinth.statDownloads'), fmtInt(project.downloads)],
        ['heart', fmtNumber(project.followers), t('modrinth.statFollowers'), fmtInt(project.followers)],
        ['layers', versionsStat, t('modrinth.statVersions')],
        ['refresh', fmtAgo(Date.parse(project.updated)), t('modrinth.statUpdated'), fmtDate(project.updated)],
        ['calendar', fmtDate(project.published), t('modrinth.statPublished')],
      ]),
    );

    function drawInstalled() {
      const list = [...installedIn(project.id), ...installedInServers(project.id)];
      mount(
        installedSlot,
        list.length
          ? h(
              'div',
              { class: 'mx-inst-list' },
              h('span', { class: 'mx-inst-label' }, t('modrinth.installedInLabel')),
              list.slice(0, 4).map((x) =>
                h(
                  'button',
                  {
                    type: 'button',
                    class: 'mx-inst-chip',
                    title: x.version ? `${x.name} · ${t('modrinth.installedVersion', { version: x.version })}` : x.name,
                    onclick: () => navigate(x.kind === 'server' ? `server/${encodeURIComponent(x.id)}` : `instance/${encodeURIComponent(x.id)}`),
                  },
                  icon(x.kind === 'server' ? 'server' : 'layers'),
                  h('span', { class: 'ellipsis' }, x.name),
                ),
              ),
              list.length > 4 ? h('span', { class: 'mx-inst-label' }, t('modrinth.andMore', { count: list.length - 4 })) : null,
            )
          : null,
      );
    }
    drawInstalled();
    offs.push(store.on('instances', () => alive && drawInstalled()));

    // pestañas
    let versions = null;
    let versionsError = null;
    let tab = 'description';
    const panel = h('div', { class: 'mx-dpanel', role: 'tabpanel', id: 'mx-tabpanel' });
    const tabsBox = h('div', { class: 'mx-dtabs-wrap' });
    const tabsList = () => [
      { id: 'description', icon: 'fileText', label: t('modrinth.tabDescription') },
      gallery.length ? { id: 'gallery', icon: 'image', label: t('modrinth.tabGallery'), count: gallery.length } : null,
      { id: 'versions', icon: 'layers', label: t('modrinth.tabVersions'), count: versions ? versions.length : project.versions?.length },
      type !== 'modpack' ? { id: 'dependencies', icon: 'package', label: t('modrinth.tabDependencies') } : null,
    ].filter(Boolean);
    // al redibujar (cambio de pestaña o llegada de las versiones) el foco sigue en la pestaña equivalente
    const drawTabs = () => keepFocus(tabsBox, () => mount(tabsBox, detailTabs(tabsList(), tab, (id) => ((tab = id), drawTabs(), drawPanel()))));

    const versionsLoading = () => skeleton('list', { rows: 6, label: t('modrinth.loadingVersions') });
    const versionsFailed = () =>
      h(
        'div',
        { class: 'notice bad mx-err', role: 'alert' },
        icon('alert'),
        h('div', { class: 'spacer' }, h('strong', {}, t('modrinth.versionsFailed')), h('div', { class: 'mx-err-text' }, versionsError)),
        h('button', { class: 'btn sm', type: 'button', onclick: () => loadVersions(api.modrinth.versions(project.id, { includeChangelog: false }).then(sortVersions)) }, icon('refresh'), t('modrinth.retry')),
      );

    let descEl = null;
    function drawPanel() {
      panel.setAttribute('aria-labelledby', `mx-tab-${tab}`);
      if (tab === 'description') {
        descEl =
          descEl ||
          (project.body?.trim()
            ? renderMarkdown(project.body, { onImage: (imgs, i) => openLightbox(imgs, i), onProject: (slug) => navigate(`modrinth/project/${encodeURIComponent(slug)}`) })
            : emptyState('fileText', t('modrinth.noDescription')));
        mount(panel, h('div', { class: 'card mx-desc' }, descEl));
      } else if (tab === 'gallery') mount(panel, galleryGrid(gallery));
      else if (tab === 'versions') {
        if (versionsError) mount(panel, versionsFailed());
        else if (!versions) mount(panel, versionsLoading());
        else versionsPanel(panel, project, versions, install);
      } else if (tab === 'dependencies') {
        if (versionsError) mount(panel, versionsFailed());
        else if (!versions) mount(panel, versionsLoading());
        else dependenciesPanel(panel, versions);
      }
    }
    drawTabs();
    drawPanel();

    function loadVersions(promise) {
      versions = null;
      versionsError = null;
      if (tab === 'versions' || tab === 'dependencies') drawPanel();
      promise
        .then((list) => {
          if (!alive) return;
          versions = list;
          versionsStat.textContent = fmtInt(list.length);
          drawTabs();
          if (tab !== 'description' && tab !== 'gallery') drawPanel();
          drawCompat();
        })
        .catch((err) => {
          if (!alive) return;
          versionsError = err?.message || String(err);
          if (tab === 'versions' || tab === 'dependencies') drawPanel();
        });
    }
    loadVersions(versionsP);

    // columna lateral
    const compatBox = h('div');
    function drawCompat() {
      const releases = (project.game_versions || []).filter(isReleaseVersion);
      const recent = [...releases].reverse().slice(0, 8);
      mount(
        compatBox,
        factRow(t('modrinth.minecraft'), versionSummary(project.game_versions, 2) || '—'),
        recent.length ? h('div', { class: 'mx-vchips' }, recent.map((v) => h('span', { class: 'mx-vchip' }, v)), releases.length > recent.length ? h('span', { class: 'mx-vchip more', title: releases.join(', '), tabindex: 0 }, `+${releases.length - recent.length}`) : null) : null,
        shownLoaders.length ? factRow(t('modrinth.loaders'), h('span', { class: 'mx-chiprow' }, shownLoaders.map((l) => loaderChip(l)))) : null,
        env ? factRow(t('modrinth.environment'), env) : null,
      );
    }
    drawCompat();

    const links = [];
    if (project.issues_url) links.push(linkRow('bug', t('modrinth.linkIssues'), project.issues_url));
    if (project.source_url) links.push(linkRow('code', t('modrinth.linkSource'), project.source_url));
    if (project.wiki_url) links.push(linkRow('fileText', t('modrinth.linkWiki'), project.wiki_url));
    if (project.discord_url) links.push(linkRow('message', t('modrinth.linkDiscord'), project.discord_url));
    for (const d of project.donation_urls || []) {
      if (!/^https?:\/\//i.test(d.url || '')) continue;
      const label = d.id === 'other' || !d.platform ? t('modrinth.linkDonateOther') : t('modrinth.linkDonate', { platform: d.platform });
      links.push(linkRow(DONATION_ICONS[d.id] || 'heart', label, d.url));
    }
    links.push(linkRow('globe', t('modrinth.linkModrinth'), projectUrl(project)));

    const teamBox = h('div', { class: 'mx-team' }, skeleton('list', { rows: 2, label: t('modrinth.creators') }));
    const license = project.license || {};
    const licenseName = licenseLabel(license) || '—';
    const aside = h(
      'aside',
      { class: 'mx-aside' },
      asideCard(t('modrinth.compatibility'), 'check', compatBox),
      asideCard(t('modrinth.links'), 'link', h('div', { class: 'mx-links' }, links)),
      asideCard(t('modrinth.creators'), 'users', teamBox),
      asideCard(
        t('modrinth.details'),
        'info',
        factRow(t('modrinth.license'), license.url ? extLink(license.url, licenseName) : licenseName),
        factRow(t('modrinth.published'), fmtDate(project.published)),
        factRow(t('modrinth.updated'), fmtDate(project.updated)),
        factRow(t('modrinth.projectId'), h('button', { type: 'button', class: 'mx-copy', title: t('modrinth.copyId'), 'aria-label': `${t('modrinth.copyId')}: ${project.id}`, onclick: () => copyText(project.id) }, h('span', { class: 'mono' }, project.id), icon('copy'))),
      ),
    );

    teamP.then((team) => {
      if (!alive) return;
      const org = team?.organization;
      const members = team?.members || [];
      const owner = org ? { name: org.name, url: `${MODRINTH_URL}/organization/${org.slug || org.id}` } : members[0] ? { name: members[0].username, url: `${MODRINTH_URL}/user/${members[0].username}` } : null;
      mount(authorSlot, owner ? h('span', {}, t('modrinth.byPrefix'), ' ', extLink(owner.url, owner.name)) : null);
      const rows = [];
      if (org) rows.push(memberRow(org.icon_url, org.name, t('modrinth.organization'), `${MODRINTH_URL}/organization/${org.slug || org.id}`));
      const list = members.length ? members : org?.members || [];
      for (const mem of list.slice(0, 12)) rows.push(memberRow(mem.avatar_url, mem.username, mem.role || t('modrinth.member'), `${MODRINTH_URL}/user/${mem.username}`));
      mount(teamBox, rows.length ? rows : h('div', { class: 'mx-pnone' }, t('modrinth.noTeam')));
    });

    mount(container, hero, h('div', { class: 'mx-dgrid' }, h('div', { class: 'mx-dmain' }, tabsBox, panel), aside));
  }

  load();
  return () => {
    alive = false;
    offs.forEach((off) => off());
  };
}

function memberRow(avatarUrl, name, role, url) {
  return h('button', { type: 'button', class: 'mx-member', title: url, onclick: () => window.venus.app.openExternal(url).catch(() => {}) }, avatar(avatarUrl, name), h('div', { class: 'mx-member-main' }, h('div', { class: 'ellipsis mx-member-name' }, name), h('div', { class: 'ellipsis small muted' }, role)));
}

// ---------- Versiones ----------

function versionsPanel(panel, project, versions, install) {
  const st = { gv: '', loader: '', channels: new Set(['release', 'beta', 'alpha']), shown: VERSIONS_STEP, open: new Set() };
  const list = h('div', { class: 'mx-vlist' });
  const countEl = h('span', { class: 'mx-vcount num', 'aria-live': 'polite' });
  const gvs = [...new Set(versions.flatMap((v) => v.game_versions))];
  const gvSorted = [...(project.game_versions || gvs)].reverse().filter((v) => gvs.includes(v));
  const loaders = [...new Set(versions.flatMap((v) => v.loaders))];
  const gvSel = selectEl([{ value: '', label: t('modrinth.allGameVersions') }, ...gvSorted.map((v) => ({ value: v, label: v }))], '', (v) => ((st.gv = v), (st.shown = VERSIONS_STEP), draw()));
  gvSel.setAttribute('aria-label', t('modrinth.gameVersion'));
  const loaderSel = loaders.length > 1 ? selectEl([{ value: '', label: t('modrinth.allLoaders') }, ...loaders.map((l) => ({ value: l, label: loaderName(l) }))], '', (v) => ((st.loader = v), (st.shown = VERSIONS_STEP), draw())) : null;
  loaderSel?.setAttribute('aria-label', t('modrinth.loaders'));
  const channels = h(
    'div',
    { class: 'chips', role: 'group', 'aria-label': t('modrinth.channels') },
    ['release', 'beta', 'alpha'].map((c) => {
      const b = h('button', { type: 'button', class: ['chip', 'active'], 'aria-pressed': 'true' }, t(`modrinth.channel_${c}`));
      b.addEventListener('click', () => {
        if (st.channels.has(c) && st.channels.size === 1) return;
        if (st.channels.has(c)) st.channels.delete(c);
        else st.channels.add(c);
        b.classList.toggle('active', st.channels.has(c));
        b.setAttribute('aria-pressed', st.channels.has(c) ? 'true' : 'false');
        st.shown = VERSIONS_STEP;
        draw();
      });
      return b;
    }),
  );

  function filtered() {
    return versions.filter((v) => st.channels.has(v.version_type) && (!st.gv || v.game_versions.includes(st.gv)) && (!st.loader || v.loaders.includes(st.loader)));
  }

  function row(v) {
    const open = st.open.has(v.id);
    const details = h('div', { class: 'mx-vdetails' });
    const toggle = () => {
      if (st.open.has(v.id)) st.open.delete(v.id);
      else st.open.add(v.id);
      draw();
    };
    const detailsId = `mx-vd-${v.id}`;
    details.id = detailsId;
    const el = h(
      'div',
      { class: ['mx-ver', open && 'open'] },
      h(
        'div',
        { class: 'mx-ver-row' },
        h(
          'button',
          {
            type: 'button',
            class: 'mx-ver-toggle',
            'aria-expanded': open ? 'true' : 'false',
            'aria-controls': open ? detailsId : null,
            title: open ? t('modrinth.hideDetails') : t('modrinth.showDetails'),
            dataset: { fk: `ver-${v.id}` },
            onclick: toggle,
          },
          h('span', { class: ['mx-vcaret', open && 'open'], 'aria-hidden': 'true' }, icon('chevronRight')),
          channelPill(v.version_type),
          h('span', { class: 'mx-ver-name' }, h('span', { class: 'ellipsis mx-ver-title', title: v.name || v.version_number }, v.name || v.version_number), h('span', { class: 'ellipsis mx-ver-sub num' }, t('modrinth.versionLine', { number: v.version_number, date: fmtDate(v.date_published) }))),
        ),
        h('div', { class: 'mx-ver-meta' }, h('span', { class: 'mx-chiprow' }, v.loaders.slice(0, 3).map((l) => loaderChip(l))), h('span', { class: 'ellipsis mx-ver-gv', title: v.game_versions.join(', ') }, versionSummary(v.game_versions, 3))),
        h('span', { class: 'mx-ver-dl num', title: t('modrinth.downloadsTitle', { n: fmtInt(v.downloads) }) }, icon('download'), fmtNumber(v.downloads)),
        h('button', { type: 'button', class: 'btn sm mx-soft mx-ver-install', title: t('modrinth.installVersion', { version: v.version_number }), 'aria-label': t('modrinth.installVersion', { version: v.version_number }), onclick: () => install({ versionId: v.id }) }, icon('download')),
      ),
      open ? details : null,
    );
    if (open) fillDetails(details, v);
    return el;
  }

  function draw() {
    const all = filtered();
    countEl.textContent = t('modrinth.versionsShown', { shown: Math.min(all.length, st.shown), count: all.length });
    if (!all.length) {
      mount(list, h('div', { class: 'mx-empty' }, emptyState('layers', t('modrinth.noVersionsMatch'), t('modrinth.noVersionsMatchText'))));
      return;
    }
    // al abrir o cerrar una version, el foco se queda en su fila
    keepFocus(list, () =>
      mount(
        list,
        all.slice(0, st.shown).map(row),
        all.length > st.shown
          ? h(
              'button',
              {
                type: 'button',
                class: 'btn sm mx-vmore',
                onclick: () => {
                  const first = st.shown;
                  st.shown += VERSIONS_STEP * 2;
                  draw();
                  // el foco pasa a la primera version nueva
                  list.querySelectorAll('.mx-ver-toggle')[first]?.focus({ preventScroll: true });
                },
              },
              icon('chevronDown'),
              t('modrinth.showMoreVersions', { count: all.length - st.shown }),
            )
          : null,
      ),
    );
  }

  mount(panel, h('div', { class: 'mx-vfilters' }, gvSel, loaderSel, channels, h('span', { class: 'spacer' }), countEl), list);
  draw();
}

async function fillDetails(box, v) {
  mount(box, h('div', { class: 'mx-vsection' }, skeleton(4, { label: t('modrinth.loadingChangelog') })));
  let full = v;
  try {
    full = await api.invoke('modrinth:version', v.id);
  } catch {
    full = v;
  }
  if (!box.isConnected) return;
  const files = (full.files || []).map((f) =>
    h(
      'div',
      { class: 'mx-file' },
      icon('file'),
      h('span', { class: 'ellipsis spacer mono mx-file-name', title: f.filename }, f.filename),
      f.primary ? h('span', { class: 'badge modrinth' }, t('modrinth.primaryFile')) : null,
      h('span', { class: 'mx-file-size num' }, fmtBytes(f.size)),
      h('button', { type: 'button', class: 'icon-btn sm', title: t('modrinth.copyLink'), 'aria-label': t('modrinth.copyFileLink', { file: f.filename }), onclick: () => copyText(f.url, t('modrinth.linkCopied')) }, icon('link')),
      h('button', { type: 'button', class: 'icon-btn sm', title: t('modrinth.downloadInBrowser'), 'aria-label': t('modrinth.downloadInBrowser'), onclick: () => window.venus.app.openExternal(f.url).catch(() => {}) }, icon('external')),
    ),
  );
  const deps = full.dependencies || [];
  const depsBox = h('div', { class: 'mx-vdeps' });
  mount(
    box,
    h('div', { class: 'mx-vsection' }, h('div', { class: 'mx-flabel' }, t('modrinth.changelog')), full.changelog?.trim() ? renderMarkdown(full.changelog, { onImage: (imgs, i) => openLightbox(imgs, i), onProject: (slug) => navigate(`modrinth/project/${encodeURIComponent(slug)}`) }) : h('div', { class: 'mx-pnone' }, t('modrinth.noChangelog'))),
    h('div', { class: 'mx-vsection' }, h('div', { class: 'mx-flabel' }, t('modrinth.files')), files.length ? files : h('div', { class: 'mx-pnone' }, '—')),
    deps.length ? h('div', { class: 'mx-vsection' }, h('div', { class: 'mx-flabel' }, t('modrinth.tabDependencies')), depsBox) : null,
    h('div', { class: 'mx-vsection mx-vgv' }, t('modrinth.versionGameVersions', { list: full.game_versions.join(', ') })),
  );
  if (deps.length) {
    const projects = await depProjects(deps);
    if (!depsBox.isConnected) return;
    mount(
      depsBox,
      deps.map((d) => {
        const p = projects.get(d.project_id);
        return h(
          'div',
          { class: 'mx-vdep' },
          h('span', { class: `pill ${d.dependency_type === 'required' ? 'warn' : d.dependency_type === 'incompatible' ? 'bad' : ''}` }, t(`modrinth.dep_${d.dependency_type}`)),
          p ? routeLink(`modrinth/project/${encodeURIComponent(p.slug || p.id)}`, p.title, 'ellipsis') : h('span', { class: 'mono mx-file-name ellipsis' }, d.file_name || d.project_id || d.version_id || '?'),
        );
      }),
    );
  }
}

async function depProjects(deps) {
  const ids = new Set(deps.map((d) => d.project_id).filter(Boolean));
  const versionOnly = deps.filter((d) => !d.project_id && d.version_id).map((d) => d.version_id);
  const map = new Map();
  try {
    if (versionOnly.length) {
      const vs = await api.invoke('modrinth:versionsByIds', versionOnly);
      for (const v of vs || []) {
        ids.add(v.project_id);
        for (const d of deps) if (d.version_id === v.id && !d.project_id) d.project_id = v.project_id;
      }
    }
    if (ids.size) for (const p of (await api.invoke('modrinth:projects', [...ids])) || []) map.set(p.id, p);
  } catch {
    /* sin nombres: se muestran los ids */
  }
  return map;
}

// ---------- Dependencias ----------

function dependenciesPanel(panel, versions) {
  if (!versions.length) {
    mount(panel, emptyState('package', t('modrinth.noVersions')));
    return;
  }
  const latest = versions.find((v) => v.version_type === 'release') || versions[0];
  let current = latest;
  const sel = selectEl(
    versions.slice(0, 200).map((v) => ({ value: v.id, label: `${v.version_number} · ${versionSummary(v.game_versions, 2)} · ${v.loaders.map(loaderName).join('/')}` })),
    latest.id,
    (id) => {
      current = versions.find((v) => v.id === id) || latest;
      draw();
    },
  );
  sel.setAttribute('aria-label', t('modrinth.depsOfVersion'));
  sel.classList.add('mx-depsel');
  sel.id = 'mx-depsel';
  const box = h('div', { class: 'mx-deps', 'aria-live': 'polite' });
  mount(panel, h('div', { class: 'mx-vfilters' }, h('label', { class: 'mx-vlabel', for: 'mx-depsel' }, t('modrinth.depsOfVersion')), sel), box);

  async function draw() {
    const v = current;
    const deps = v.dependencies || [];
    if (!deps.length) {
      mount(box, h('div', { class: 'mx-empty' }, emptyState('check', t('modrinth.noDependencies'), t('modrinth.noDependenciesText'))));
      return;
    }
    mount(box, skeleton('grid', { items: Math.min(4, deps.length), min: 280, lines: 1 }));
    const projects = await depProjects(deps);
    if (v !== current || !box.isConnected) return;
    const groups = ['required', 'optional', 'incompatible', 'embedded'];
    mount(
      box,
      groups.map((g) => {
        const list = deps.filter((d) => d.dependency_type === g);
        if (!list.length) return null;
        return h(
          'div',
          { class: 'mx-depgroup' },
          h('div', { class: 'mx-flabel' }, t(`modrinth.depGroup_${g}`, { count: list.length })),
          h(
            'div',
            { class: 'mx-deplist' },
            list.map((d) => {
              const p = projects.get(d.project_id);
              const name = d.file_name || d.project_id || d.version_id || '?';
              if (!p) return h('div', { class: 'mx-dep' }, h('div', { class: 'mx-icon mx-icon-ph sm' }, icon('file')), h('div', { class: 'mx-dep-main' }, h('div', { class: 'mono mx-file-name ellipsis', title: name }, name), h('div', { class: 'mx-dep-sub' }, t('modrinth.depExternal'))));
              return h(
                'div',
                { class: 'mx-dep' },
                projectIcon(p.icon_url, 'mx-icon sm'),
                h('div', { class: 'mx-dep-main' }, routeLink(`modrinth/project/${encodeURIComponent(p.slug || p.id)}`, p.title, 'mx-dep-title ellipsis'), h('div', { class: 'mx-dep-sub ellipsis', title: p.description || null }, p.description)),
                g === 'optional' || g === 'required'
                  ? h('button', { type: 'button', class: 'btn sm mx-soft', title: t('modrinth.installTitle', { title: p.title }), 'aria-label': t('modrinth.installTitle', { title: p.title }), onclick: () => openInstallDialog(p, {}) }, icon('download'), t('modrinth.install'))
                  : null,
              );
            }),
          ),
        );
      }),
      h('div', { class: 'mx-dep-note' }, icon('info'), t('modrinth.depsAutoNote')),
    );
  }
  draw();
}
