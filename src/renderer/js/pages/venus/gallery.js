// Venus > Fondos: la galeria de venus-launcher-fondos.netlify.app dentro del launcher. Los fondos vienen con el
// launcher (wallpapers.js), asi que se ven sin internet y se aplican con un clic como fondo del launcher.
import { h, icon, mount, modal, ok, debounce } from '../../ui.js';
import { t } from '../../i18n.js';
import { WALLPAPERS } from '../../wallpapers.js';
import { currentWallpaperId, useWallpaper, useStars, onAppearanceChange } from '../../appearance.js';
import { openLink, WALLPAPERS_PAGE } from '../../community.js';

const FILTERS = ['all', 'live', 'still'];

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function preview(wp) {
  const media = wp.video
    ? h('video', { class: 'vn-wp-media', src: wp.src, poster: wp.thumb, autoplay: true, muted: true, loop: true, playsInline: true, 'aria-label': wp.name })
    : h('img', { class: 'vn-wp-media', src: wp.src, alt: wp.name, decoding: 'async' });
  if (wp.video) media.muted = true; // el atributo solo no alcanza para que el video arranque sin interaccion
  const status = h('p', { class: 'vn-wp-status', 'aria-live': 'polite' });
  const useBtn = h('button', { type: 'button', class: 'btn primary' }, icon('image'), h('span'));
  const starsBtn = h('button', { type: 'button', class: 'btn ghost' }, icon('sparkles'), h('span', {}, t('venus.wpStars')));
  const draw = () => {
    const current = currentWallpaperId() === wp.id;
    useBtn.disabled = current;
    useBtn.lastChild.textContent = current ? t('venus.wpInUse') : t('venus.wpUse');
    starsBtn.hidden = !current;
    status.textContent = current ? t('venus.wpInUseText') : '';
  };
  let dialog = null;
  useBtn.onclick = () => {
    if (useWallpaper(wp.id)) ok(t('venus.wpApplied', { name: wp.name }));
    draw();
  };
  starsBtn.onclick = () => {
    useStars();
    draw();
    dialog?.close();
  };
  const off = onAppearanceChange(draw);
  draw();
  dialog = modal({
    title: wp.name,
    subtitle: wp.video ? t('venus.wpLiveBadge') : t('venus.wpStillBadge'),
    icon: 'image',
    size: 'wide',
    body: h('div', { class: 'vn-wp-preview' }, media, status),
    footer: [
      h('button', { type: 'button', class: 'btn ghost vn-wp-web', onclick: () => openLink(`${WALLPAPERS_PAGE}#${encodeURIComponent(wp.id)}`) }, icon('download'), h('span', {}, t('venus.wpDownload')), icon('external')),
      starsBtn,
      useBtn,
    ],
    onClose: () => {
      off();
      if (wp.video) media.pause();
    },
  });
  return dialog;
}

export function galleryView() {
  let filter = 'all';
  let query = '';
  let dialog = null; // vista previa abierta (se cierra si se sale de la pagina)
  const live = WALLPAPERS.filter((w) => w.video).length;
  const grid = h('div', { class: 'vn-wp-grid', role: 'list' });
  const empty = h('p', { class: 'vn-empty', hidden: true }, icon('search'), h('span', {}, t('venus.wpEmpty')));
  const count = h('span', { class: 'vn-wp-count', 'aria-live': 'polite' });

  const cards = WALLPAPERS.map((wp) =>
    h(
      'button',
      {
        type: 'button',
        class: 'vn-wp-card',
        role: 'listitem',
        dataset: { id: wp.id },
        title: wp.name,
        'aria-label': wp.video ? `${wp.name}, ${t('venus.wpLiveBadge')}` : wp.name,
        onclick: () => {
          dialog = preview(wp);
        },
      },
      h('img', { src: wp.thumb, alt: '', loading: 'lazy', decoding: 'async', width: 320, height: 180 }),
      wp.video ? h('span', { class: 'vn-wp-live', 'aria-hidden': 'true' }, icon('play'), t('venus.wpLiveBadge')) : null,
      h('span', { class: 'vn-wp-current', 'aria-hidden': 'true' }, icon('check'), t('venus.wpCurrent')),
      h('span', { class: 'vn-wp-name', 'aria-hidden': 'true' }, wp.name),
    ),
  );
  mount(grid, cards);

  const chips = FILTERS.map((f) =>
    h(
      'button',
      { type: 'button', class: 'chip', role: 'radio', dataset: { filter: f }, onclick: () => { filter = f; apply(); } },
      t(`venus.wp_${f}`),
    ),
  );

  function apply() {
    const q = norm(query.trim());
    const cur = currentWallpaperId();
    let shown = 0;
    WALLPAPERS.forEach((wp, i) => {
      const okFilter = filter === 'all' || (filter === 'live' ? wp.video : !wp.video);
      const visible = okFilter && (!q || norm(wp.name).includes(q));
      cards[i].hidden = !visible;
      cards[i].classList.toggle('current', wp.id === cur);
      if (visible) shown++;
    });
    chips.forEach((c) => {
      const on = c.dataset.filter === filter;
      c.setAttribute('aria-checked', String(on));
      c.classList.toggle('active', on);
      c.tabIndex = on ? 0 : -1;
    });
    empty.hidden = shown > 0;
    count.textContent = t('venus.wpShown', { shown, total: WALLPAPERS.length });
  }

  const search = h('input', {
    type: 'search',
    class: 'input vn-wp-search',
    maxlength: '60',
    spellcheck: 'false',
    placeholder: t('venus.wpSearch'),
    'aria-label': t('venus.wpSearch'),
    oninput: debounce((e) => { query = e.target.value; apply(); }, 120),
  });

  const view = h(
    'section',
    { class: 'vn-section vn-wallpapers', 'aria-labelledby': 'vn-wp-title' },
    h(
      'div',
      { class: 'vn-section-head' },
      h('div', { class: 'vn-section-text' },
        h('h2', { id: 'vn-wp-title' }, t('venus.wpTitle')),
        h('p', {}, t('venus.wpSub', { count: WALLPAPERS.length, live }))),
      h('button', { type: 'button', class: 'btn ghost', onclick: () => openLink(WALLPAPERS_PAGE) }, icon('globe'), h('span', {}, t('venus.wpWeb')), icon('external')),
    ),
    h('div', { class: 'vn-wp-tools' }, h('div', { class: 'chips', role: 'radiogroup', 'aria-label': t('venus.wpFilter') }, chips), search, count),
    grid,
    empty,
  );
  const off = onAppearanceChange(apply);
  apply();
  view.destroy = () => {
    off();
    dialog?.close();
  };
  return view;
}
