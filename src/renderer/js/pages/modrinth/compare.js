// Comparacion lado a lado de 2 a 4 shaders o resource packs: galerias que se recorren juntas
// (o de a una), y una grilla con los datos clave alineados por fila.
import { h, icon, mount, modal, fmtNumber, fmtAgo } from '../../ui.js';
import { api } from '../../store.js';
import { navigate } from '../../app.js';
import { t } from '../../i18n.js';
import { categoryLabel, loaderChip, versionSummary, projectIcon, fmtInt, envLabel, routeLink, licenseLabel } from './shared.js';
import { openLightbox } from './lightbox.js';
import { openInstallDialog } from '../../features/install.js';

// Orden natural del impacto en el rendimiento (de PC modesta a capturas)
const PERF_ORDER = ['potato', 'low', 'medium', 'high', 'screenshot'];

function sortedGallery(p) {
  return [...(p.gallery || [])].sort((a, b) => Number(b.featured) - Number(a.featured) || (a.ordering ?? 0) - (b.ordering ?? 0));
}

// Esqueleto con una columna por proyecto: encabezado, galeria y filas de datos
function compareSkeleton(n) {
  const bone = (cls, w) => h('span', { class: `skeleton ${cls}`, style: w ? { width: w } : null });
  return h(
    'div',
    { class: 'skeleton-group', role: 'status', 'aria-busy': 'true' },
    h('span', { class: 'sr-only' }, t('modrinth.compareLoading')),
    h(
      'div',
      { class: 'mx-cmp-skel', style: { '--n': String(n) }, 'aria-hidden': 'true' },
      Array.from({ length: n }, (_, i) =>
        h(
          'div',
          { class: 'mx-cmp-skcol' },
          h('div', { class: 'mx-cmp-head' }, bone('mx-cmp-icon'), h('div', { class: 'mx-sk-stack' }, bone('skeleton-line', `${60 + ((i * 13) % 30)}%`), bone('skeleton-line', '40%'))),
          bone('mx-cmp-stage'),
          bone('skeleton-line', '80%'),
          bone('skeleton-line', '65%'),
          bone('skeleton-line', '72%'),
        ),
      ),
    ),
  );
}

export async function openCompare(items) {
  const ids = (items || []).map((x) => x.project_id || x.id).filter(Boolean).slice(0, 4);
  const type = items?.[0]?.project_type || 'shader';
  const body = h('div', { class: 'mx-cmp' }, compareSkeleton(Math.max(2, ids.length)));
  let onKey = null;
  const onRoute = () => m.close();
  const m = modal({
    title: t('modrinth.compareTitle', { count: ids.length }),
    body,
    size: 'xwide',
    onClose: () => {
      window.removeEventListener('hashchange', onRoute);
      if (onKey) document.removeEventListener('keydown', onKey);
    },
  });
  m.el.classList.add('mx-cmp-modal');
  window.addEventListener('hashchange', onRoute);

  let projects;
  let headers = {};
  // Si falla la carga: que paso + Reintentar (vuelve a pedir los proyectos sin cerrar el dialogo)
  for (;;) {
    try {
      const [list, facets] = await Promise.all([api.invoke('modrinth:projects', ids), api.invoke('modrinth:facets', type).catch(() => null)]);
      projects = ids.map((id) => (list || []).find((p) => p.id === id)).filter(Boolean);
      headers = {};
      for (const g of facets?.categories || []) for (const name of g.names) headers[name] = g.header;
      break;
    } catch (err) {
      if (!m.el.isConnected) return;
      const retry = await new Promise((resolve) => {
        const btn = h('button', { class: 'btn sm', type: 'button', onclick: () => resolve(true) }, icon('refresh'), t('modrinth.retry'));
        mount(body, h('div', { class: 'notice bad mx-err', role: 'alert' }, icon('alert'), h('div', { class: 'spacer' }, h('strong', {}, t('modrinth.compareFailed')), h('div', { class: 'mx-err-text' }, err?.message || String(err))), btn));
        btn.focus({ preventScroll: true });
      });
      if (!retry || !m.el.isConnected) return;
      mount(body, compareSkeleton(Math.max(2, ids.length)));
    }
  }
  if (!m.el.isConnected) return;
  if (projects.length < 2) {
    mount(body, h('div', { class: 'notice info' }, icon('info'), h('div', {}, t('modrinth.compareNeedTwo'))));
    return;
  }

  const cols = projects.map((p) => ({ p, gallery: sortedGallery(p), i: 0, stage: null, caption: null, counter: null }));
  const n = cols.length;

  function drawStage(c) {
    const g = c.gallery;
    if (!g.length) {
      mount(c.stage, h('div', { class: 'mx-cmp-noimg' }, icon('image'), t('modrinth.noGallery')));
      mount(c.caption);
      c.counter.textContent = '';
      return;
    }
    const item = g[((c.i % g.length) + g.length) % g.length];
    const img = h('img', { src: item.url, alt: item.title || c.p.title, loading: 'lazy', referrerpolicy: 'no-referrer' });
    img.addEventListener('error', () => img.replaceWith(h('div', { class: 'mx-cmp-noimg' }, icon('image'), t('modrinth.lbError'))), { once: true });
    mount(
      c.stage,
      h(
        'button',
        {
          type: 'button',
          class: 'mx-cmp-imgbtn',
          title: t('modrinth.openImage'),
          'aria-label': t('modrinth.openImageOf', { title: c.p.title }),
          onclick: () => openLightbox(g.map((x) => ({ url: x.url, raw: x.raw_url, title: x.title, description: x.description })), ((c.i % g.length) + g.length) % g.length),
        },
        img,
      ),
    );
    mount(c.caption, item.title || '');
    c.caption.title = item.title || '';
    c.counter.textContent = t('modrinth.lbCounter', { n: (((c.i % g.length) + g.length) % g.length) + 1, total: g.length });
  }

  const move = (delta, only) => {
    for (const c of only ? [only] : cols) {
      c.i += delta;
      drawStage(c);
    }
  };

  const label = (text, cls) => h('div', { class: ['mx-cmp-label', cls] }, text);
  const cell = (content, cls) => h('div', { class: ['mx-cmp-cell', cls] }, content);
  const catsBy = (p, header) => [...(p.categories || []), ...(p.additional_categories || [])].filter((c) => (headers[c] || 'categories') === header);
  const byPerf = (list) => [...list].sort((a, b) => (PERF_ORDER.indexOf(a) + 1 || 99) - (PERF_ORDER.indexOf(b) + 1 || 99));
  const none = () => h('span', { class: 'mx-cmp-none' }, '—');
  const chips = (list) => (list.length ? h('div', { class: 'mx-cmp-chips' }, list.map((c) => h('span', { class: 'mx-tag' }, categoryLabel(c)))) : none());

  // encabezados: una grilla aparte que queda fija arriba al desplazar la comparacion
  const headRow = [label('', 'head')];
  const rows = [];
  for (const c of cols) {
    headRow.push(
      cell(
        h(
          'div',
          { class: 'mx-cmp-head' },
          projectIcon(c.p.icon_url, 'mx-cmp-icon'),
          h(
            'div',
            { class: 'mx-cmp-hmain' },
            h('div', { class: 'mx-cmp-title-wrap', title: c.p.title }, routeLink(`modrinth/project/${encodeURIComponent(c.p.slug || c.p.id)}`, c.p.title, 'mx-cmp-title', () => m.close())),
            h('div', { class: 'mx-cmp-sub num', title: fmtInt(c.p.downloads) }, t('modrinth.downloadsShort', { n: fmtNumber(c.p.downloads) })),
          ),
        ),
        'head',
      ),
    );
  }
  // galerias
  rows.push(label(t('modrinth.gallery')));
  for (const c of cols) {
    c.stage = h('div', { class: 'mx-cmp-stage' });
    c.caption = h('div', { class: 'mx-cmp-caption ellipsis' });
    c.counter = h('span', { class: 'mx-cmp-counter num', 'aria-live': 'polite' });
    const many = c.gallery.length > 1;
    rows.push(
      cell(
        h(
          'div',
          { class: 'mx-cmp-gallery' },
          c.stage,
          h(
            'div',
            { class: 'mx-cmp-gnav' },
            many ? h('button', { type: 'button', class: 'icon-btn sm', title: t('modrinth.lbPrev'), 'aria-label': t('modrinth.lbPrevOf', { title: c.p.title }), onclick: () => move(-1, c) }, icon('chevronLeft')) : null,
            h('div', { class: 'mx-cmp-gtext' }, c.caption, c.counter),
            many ? h('button', { type: 'button', class: 'icon-btn sm', title: t('modrinth.lbNext'), 'aria-label': t('modrinth.lbNextOf', { title: c.p.title }), onclick: () => move(1, c) }, icon('chevronRight')) : null,
          ),
        ),
        'gallery',
      ),
    );
  }
  // datos
  const facts = [
    [t('modrinth.cmpStyle'), (p) => chips(catsBy(p, 'categories'))],
    type === 'shader' ? [t('modrinth.cmpPerformance'), (p) => chips(byPerf(catsBy(p, 'performance impact')))] : [t('modrinth.cmpResolution'), (p) => chips(catsBy(p, 'resolutions'))],
    [t('modrinth.cmpFeatures'), (p) => chips(catsBy(p, 'features'))],
    [t('modrinth.loaders'), (p) => ((p.loaders || []).length ? h('div', { class: 'mx-cmp-chips' }, p.loaders.map((l) => loaderChip(l))) : none())],
    [t('modrinth.cmpVersions'), (p) => h('span', { class: 'num' }, versionSummary(p.game_versions, 2) || '—')],
    [t('modrinth.environment'), (p) => h('span', {}, envLabel(p) || '—')],
    [t('modrinth.cmpDownloads'), (p) => h('span', { class: 'num', title: fmtInt(p.downloads) }, fmtNumber(p.downloads))],
    [t('modrinth.cmpFollowers'), (p) => h('span', { class: 'num', title: fmtInt(p.followers) }, fmtNumber(p.followers))],
    [t('modrinth.cmpUpdated'), (p) => h('span', {}, fmtAgo(Date.parse(p.updated)))],
    [t('modrinth.license'), (p) => h('div', { class: 'ellipsis', title: licenseLabel(p.license) || null }, licenseLabel(p.license) || '—')],
  ];
  for (const [name, fn] of facts) {
    rows.push(label(name));
    for (const c of cols) rows.push(cell(fn(c.p)));
  }
  rows.push(label('', 'foot'));
  for (const c of cols) {
    rows.push(
      cell(
        h(
          'div',
          { class: 'mx-cmp-actions' },
          h('button', { type: 'button', class: 'btn sm mx-soft', 'aria-label': t('modrinth.installTitle', { title: c.p.title }), onclick: () => openInstallDialog(c.p, { type }) }, icon('download'), t('modrinth.install')),
          h('button', { type: 'button', class: 'btn sm ghost', onclick: () => (m.close(), navigate(`modrinth/project/${encodeURIComponent(c.p.slug || c.p.id)}`)) }, t('modrinth.details'), icon('chevronRight')),
        ),
        'actions',
      ),
    );
  }

  const maxImages = Math.max(...cols.map((c) => c.gallery.length));
  mount(
    body,
    maxImages > 1
      ? h(
          'div',
          { class: 'mx-cmp-bar' },
          h('button', { type: 'button', class: 'btn sm', onclick: () => move(-1) }, icon('chevronLeft'), t('modrinth.cmpPrevAll')),
          h('span', { class: 'mx-cmp-hint-text' }, t('modrinth.cmpKeysHint')),
          h('button', { type: 'button', class: 'btn sm', onclick: () => move(1) }, t('modrinth.cmpNextAll'), icon('chevronRight')),
        )
      : null,
    h('div', { class: 'mx-cmp-table', style: { '--n': String(n) } }, h('div', { class: 'mx-cmp-grid mx-cmp-headrow' }, headRow), h('div', { class: 'mx-cmp-grid' }, rows)),
  );
  cols.forEach(drawStage);

  onKey = (e) => {
    if (!m.el.isConnected || document.querySelector('.mx-lb')) return;
    if (e.target.closest?.('input, select, textarea')) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      move(e.key === 'ArrowLeft' ? -1 : 1);
    }
  };
  document.addEventListener('keydown', onKey);
}
