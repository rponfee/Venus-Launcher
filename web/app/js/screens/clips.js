// Clips y capturas: lo que te mandaron, lo que compartiste y la galería pública (si el servidor la tiene).
// La lista no descarga nada: el archivo se pide recién al tocarlo.
import { emptyState, h, icon, mount, notice, spinner, toast, confirmBox } from '../dom.js';
import { errorKey, formatBytes, isMissing, normalizeGallery, normalizeMine, normalizeReceived, shortStamp } from '../logic.js';

const TABS = ['received', 'mine', 'gallery'];

export function openViewer(ctx, item, url) {
  const { tr } = ctx;
  const isClip = item.kind === 'clip';
  const stage = h('div', { class: 'viewer-stage' });
  const showError = () => mount(stage, notice('warn', isClip ? tr('clip_cant_play') : tr('clip_cant_show')));
  const mediaEl = isClip
    ? h('video', { class: 'viewer-media', src: url, controls: true, playsinline: true, preload: 'metadata', 'aria-label': item.name })
    : h('img', { class: 'viewer-media', src: url, alt: item.name, referrerpolicy: 'no-referrer' });
  mediaEl.addEventListener('error', showError);
  stage.append(mediaEl);
  const close = () => {
    if (isClip) {
      // Corta la descarga: el video no sigue bajando con el visor cerrado
      mediaEl.pause();
      mediaEl.removeAttribute('src');
      mediaEl.load();
    }
    dlg.close();
    dlg.remove();
  };
  const dlg = h(
    'dialog',
    { class: 'viewer', 'aria-label': item.name },
    h(
      'header',
      { class: 'viewer-head' },
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': tr('close'), onclick: close }, icon('x')),
      h('div', { class: 'viewer-title' }, h('div', { class: 'row-title' }, item.name), item.from ? h('div', { class: 'small muted' }, tr('clip_from', { name: item.from })) : null),
      h('a', { class: 'icon-btn', href: url, target: '_blank', rel: 'noopener noreferrer', 'aria-label': tr('clip_open') }, icon('external')),
    ),
    stage,
  );
  dlg.addEventListener('cancel', (e) => {
    e.preventDefault();
    close();
  });
  document.body.append(dlg);
  dlg.showModal();
}

export function clipsScreen(ctx, route) {
  const { store, tr, lang, media, config } = ctx;
  let tab = route.tab;
  const data = { received: null, mine: null, gallery: null };
  const errors = {};
  const unavailable = { received: !store.inboxAvailable, gallery: true };
  let galleryChecked = false;
  let destroyed = false;

  const tabsEl = h('div', { class: 'tabs', role: 'tablist' });
  const listEl = h('div', { class: 'section-list' });

  function drawTabs() {
    const shown = TABS.filter((id) => (id === 'gallery' ? !unavailable.gallery : true));
    mount(
      tabsEl,
      shown.map((id) =>
        h(
          'button',
          { class: `tab ${tab === id ? 'active' : ''}`, type: 'button', role: 'tab', 'aria-selected': String(tab === id), onclick: () => selectTab(id) },
          tr(`clips_tab_${id}`),
          id === 'received' && store.inbox.clips.length ? h('span', { class: 'badge' }, String(store.inbox.clips.length)) : null,
        ),
      ),
    );
  }

  function selectTab(id) {
    if (id === tab) return;
    tab = id;
    // Cambia la dirección sin volver a armar la pantalla: lo ya cargado se conserva
    history.replaceState(null, '', `#/clips/${id}`);
    drawTabs();
    load();
  }

  function metaLine(item) {
    return [item.from ? tr('clip_from', { name: item.from }) : '', item.place, formatBytes(item.size), item.at ? shortStamp(item.at, lang) : ''].filter(Boolean).join(' · ');
  }

  async function open(item) {
    let url = null;
    try {
      if (tab === 'mine') {
        url = !item.expired ? media.signedMedia(item.url, config.url) : null;
        if (!url && item.bucket && item.path) url = media.signedMedia(await store.backend.signOwn(item.bucket, item.path), config.url);
      } else if (tab === 'received') {
        url = media.signedMedia(item.url, config.url);
        if (!item.seen) {
          item.seen = true;
          store.backend.seenMedia([item.id]).then(() => store.refreshInbox()).catch(() => {});
          draw();
        }
      } else {
        url = media.signedMedia(item.url, config.url);
      }
    } catch (err) {
      toast(tr(errorKey(err)), 'bad');
      return;
    }
    if (!url) {
      toast(tr('clip_gone'), 'bad');
      return;
    }
    openViewer(ctx, item, url);
  }

  async function removeReceived(item) {
    const go = await confirmBox({ title: tr('clip_remove_title'), text: tr('clip_remove_text'), ok: tr('clip_remove'), cancel: tr('cancel'), danger: true });
    if (!go) return;
    try {
      await store.backend.removeReceived(item.id);
      data.received = data.received.filter((x) => x.id !== item.id);
      draw();
      store.refreshInbox();
    } catch (err) {
      toast(tr(errorKey(err)), 'bad');
    }
  }

  const rowEl = (item) =>
    h(
      'div',
      { class: `row media-row ${tab === 'received' && !item.seen ? 'unread' : ''}` },
      h(
        'button',
        { class: 'media-open', type: 'button', onclick: () => open(item), 'aria-label': `${tr(item.kind === 'clip' ? 'clip_kind_clip' : 'clip_kind_shot')}: ${item.name}` },
        h('span', { class: `media-ico ${item.kind}` }, icon(item.kind === 'clip' ? 'play' : 'image', 22)),
        h('span', { class: 'row-main' }, h('span', { class: 'row-title' }, item.name), h('span', { class: 'row-sub muted' }, metaLine(item))),
      ),
      tab === 'received' ? h('button', { class: 'icon-btn', type: 'button', 'aria-label': tr('clip_remove_name', { name: item.name }), onclick: () => removeReceived(item) }, icon('trash', 20)) : null,
    );

  function draw() {
    if (destroyed) return;
    const emptyKey = { received: unavailable.received ? 'clips_unavailable' : 'clips_empty_received', mine: 'clips_empty_mine', gallery: 'clips_empty_gallery' }[tab];
    if (errors[tab]) return mount(listEl, notice('bad', tr(errorKey(errors[tab])), h('button', { class: 'btn ghost sm', type: 'button', onclick: load }, tr('retry'))));
    if (!data[tab]) return mount(listEl, spinner(tr('loading')));
    if (!data[tab].length) return mount(listEl, emptyState(tab === 'mine' ? 'film' : 'image', tr(emptyKey), tab === 'mine' ? tr('clips_empty_mine_text') : tab === 'received' ? tr('clips_empty_received_text') : null));
    mount(listEl, data[tab].map(rowEl));
  }

  async function fetchTab(id) {
    if (id === 'received') {
      if (unavailable.received) return [];
      return ((await store.backend.receivedMedia()) || []).map(normalizeReceived);
    }
    if (id === 'mine') return (await store.backend.myMedia()).map(normalizeMine);
    const raw = await store.backend.gallery();
    if (raw === undefined) {
      unavailable.gallery = true;
      return [];
    }
    return normalizeGallery(raw);
  }

  async function load() {
    const id = tab;
    errors[id] = null;
    draw();
    try {
      const rows = await fetchTab(id);
      if (destroyed) return;
      data[id] = rows;
    } catch (err) {
      if (destroyed) return;
      if (id === 'received' && isMissing(err)) {
        unavailable.received = true;
        data.received = [];
      } else {
        console.warn('[app] clips', err?.message || err);
        errors[id] = err;
      }
    }
    if (id === 'gallery' && unavailable.gallery) {
      tab = 'received';
      drawTabs();
      return load();
    }
    draw();
  }

  // La pestaña de la galería aparece solo si la función existe en el servidor
  async function checkGallery() {
    if (galleryChecked) return;
    galleryChecked = true;
    try {
      const raw = await store.backend.gallery();
      if (destroyed) return;
      unavailable.gallery = raw === undefined;
      if (raw !== undefined) data.gallery = normalizeGallery(raw);
    } catch {
      unavailable.gallery = true;
    }
    drawTabs();
  }

  const offs = [
    store.on('media', () => {
      if (tab === 'received') load();
    }),
    store.on('inbox', drawTabs),
    store.on('state', (state) => {
      if (state === 'ready') {
        load();
        checkGallery();
      }
    }),
  ];

  drawTabs();
  if (store.state === 'ready') {
    if (tab === 'gallery') unavailable.gallery = false;
    drawTabs();
    load();
    checkGallery();
  } else {
    draw();
  }

  return { title: tr('nav_clips'), el: h('div', { class: 'screen' }, tabsEl, listEl), destroy: () => {
    destroyed = true;
    offs.forEach((off) => off());
  } };
}
