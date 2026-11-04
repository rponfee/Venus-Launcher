// Galeria publica de clips (#/clips/gallery): los clips que los usuarios publicaron a proposito, por recientes o por likes de
// la semana, con like, denunciar y despublicar. Todo por las RPC de 0032_galeria_clips.sql; los titulos y nombres ajenos van
// siempre como texto y en modo streamer se difuminan (.priv). Publicar es un acto explicito: el clip tiene que estar
// compartido, se avisa que lo ve cualquiera con sesion y no alarga el vencimiento del link.
//   galleryPanel() -> Element (con .destroy()) · openPublish(item, { onDone })
import { h, icon, mount, modal, ok, fail, setBusy, emptyState, skeleton, fmtAgo, fmtDate, confirmDialog, avatarImg, selectEl } from '../../ui.js';
import { api } from '../../store.js';
import { t } from '../../i18n.js';
import { navigate } from '../../app.js';
import { cloud } from '../../cloud.js';
import { ensureLink } from './share.js';
import { LIMITS } from '../worlds/media.js';
import '../../features/clipstudio/icons.js';
import { VIEWS, PAGE_SIZE, TITLE_MAX, THUMB_MAX, REPORT_REASONS, cleanTitle, visibleClips, ownClips, ownState, expiresSoon, toggledLike, errorCode } from './gallery-logic.js';

const C = (key, vars) => t(`clipstudio.${key}`, vars);
const DATE_LONG = { day: 'numeric', month: 'long', year: 'numeric' };

// Las RPC pasan por aca: el modo de capturas (VENUS_DEVSHOT, sin empaquetar) puede poner datos de ejemplo
let backend = null;
export function setGalleryBackend(fn) {
  backend = fn;
}

async function rpc(name, args) {
  if (backend) return backend(name, args);
  const { data, error } = await cloud.client.rpc(name, args);
  if (error) throw error;
  return data;
}

const projectUrl = () => (backend ? 'https://example.supabase.co' : cloud.config?.url || '');
const signedIn = () => Boolean(backend) || (cloud.isConfigured() && cloud.isSignedIn());

function errText(err) {
  const code = errorCode(err);
  if (code === 'unavailable') console.warn('[clipstudio] galeria:', err?.code || '', err?.message || err);
  return C(`gallery_err_${code}`);
}

// ---------- Publicar ----------

// Miniatura chica del clip local (JPEG en data:), para que la grilla no tenga que bajar un video por tarjeta
function makeThumb(url) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    v.playsInline = true;
    let finished = false;
    const end = (value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      v.removeAttribute('src');
      v.load();
      resolve(value);
    };
    const timer = setTimeout(() => end(null), 8000);
    v.addEventListener('error', () => end(null), { once: true });
    v.addEventListener(
      'seeked',
      () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = 320;
          canvas.height = Math.max(2, Math.round((v.videoHeight / Math.max(1, v.videoWidth)) * 320));
          canvas.getContext('2d').drawImage(v, 0, 0, canvas.width, canvas.height);
          for (const q of [0.6, 0.45, 0.3]) {
            const out = canvas.toDataURL('image/jpeg', q);
            if (out.length <= THUMB_MAX) return end(out);
          }
        } catch (err) {
          console.warn('[clipstudio] miniatura:', err?.message || err);
        }
        return end(null);
      },
      { once: true },
    );
    v.addEventListener('loadedmetadata', () => {
      v.currentTime = Math.min(1, (Number.isFinite(v.duration) ? v.duration : 2) / 2);
    }, { once: true });
    v.src = url;
  });
}

/** Publica un clip local. Primero se asegura de que este compartido (ese flujo pide su propia confirmacion). */
export async function openPublish(item, { onDone } = {}) {
  await Promise.resolve(cloud.ready()).catch(() => {});
  if (!signedIn()) {
    const m = modal({
      title: C('galleryPublishTitle'),
      size: 'sm',
      body: h('p', { class: 'cl-modal-text' }, C('gallerySignIn')),
      footer: [
        h('button', { class: 'btn ghost', type: 'button', onclick: () => m.close() }, t('common.cancel')),
        h('button', { class: 'btn primary', type: 'button', onclick: () => (m.close(), navigate('settings/cloud')) }, icon('settings'), C('goToAccount')),
      ],
    });
    return;
  }
  if (item.size > LIMITS.clip) {
    fail(C('galleryPublishTitle'), C('galleryTooBig', { size: '50 MB' }));
    return;
  }
  const url = await ensureLink(item);
  if (!url) return;
  const map = await api.invoke('worlds:shared').catch(() => ({}));
  const info = map?.[item.sharedKey];
  if (!info?.id) {
    fail(C('galleryPublishTitle'), C('gallery_err_not_shared'));
    return;
  }
  const titleIn = h('input', { class: 'input', type: 'text', maxlength: TITLE_MAX, value: cleanTitle(item.world || item.instanceName || ''), 'aria-label': C('galleryClipTitle') });
  const counter = h('span', { class: 'cs-count num' });
  const syncCount = () => {
    counter.textContent = `${titleIn.value.length}/${TITLE_MAX}`;
  };
  titleIn.addEventListener('input', syncCount);
  syncCount();
  const expires = info.expiresAt ? fmtDate(info.expiresAt, DATE_LONG) : '';
  const publishBtn = h('button', { class: 'btn primary', type: 'button' }, icon('globe'), C('galleryPublishOk'));
  const m = modal({
    title: C('galleryPublishTitle'),
    subtitle: item.file,
    icon: 'globe',
    body: h(
      'div',
      { class: 'stack' },
      h('div', { class: 'cs-field' }, h('label', { class: 'cs-label' }, C('galleryClipTitle')), titleIn, counter),
      h('div', { class: 'notice warn' }, icon('eye'), h('div', {}, h('strong', {}, C('galleryPublicNotice')), ' ', C('galleryPublicNoticeText'))),
      expires ? h('p', { class: 'cs-help' }, C('galleryExpiryNotice', { date: expires })) : null,
    ),
    footer: [h('button', { class: 'btn ghost', type: 'button', onclick: () => m.close() }, t('common.cancel')), publishBtn],
  });
  titleIn.focus();
  titleIn.select();
  publishBtn.addEventListener('click', async () => {
    const title = cleanTitle(titleIn.value);
    if (!title) {
      titleIn.focus();
      fail(C('galleryPublishTitle'), C('gallery_err_bad_title'));
      return;
    }
    const done = setBusy(publishBtn);
    try {
      const thumb = await makeThumb(item.url);
      await rpc('gallery_publish', { p_media: info.id, p_title: title, p_thumb: thumb });
      ok(C('galleryPublished'));
      m.close();
      onDone?.();
    } catch (err) {
      fail(C('galleryPublishFailed'), errText(err));
    } finally {
      done();
    }
  });
}

// ---------- Ver un clip ----------

function openClip(clip) {
  const video = h('video', { class: 'cap-share-media', controls: true, autoplay: true, preload: 'metadata', 'aria-label': clip.title });
  const errBox = h('div', { class: 'notice bad', hidden: true }, icon('alert'), h('div', {}, C('galleryClipGone')));
  video.addEventListener('error', () => {
    video.hidden = true;
    errBox.hidden = false;
  });
  // La URL ya paso por safeClipUrl: solo links firmados del Storage del launcher
  video.src = clip.url;
  const m = modal({
    title: clip.title,
    subtitle: clip.author?.name || '',
    icon: 'play',
    size: 'wide',
    onClose: () => video.pause(),
    body: h('div', { class: 'cap-share-view' }, video, errBox),
    footer: [h('button', { class: 'btn ghost', type: 'button', onclick: () => m.close() }, C('close'))],
  });
  // El titulo y el nombre son de otro usuario: en modo streamer se difuminan
  m.el.querySelector('.modal-head-text h3')?.classList.add('priv');
  m.el.querySelector('.modal-sub')?.classList.add('priv');
}

// ---------- Denunciar ----------

function openReport(clip) {
  const textIn = h('textarea', { class: 'input cs-textarea', rows: 3, maxlength: 300, placeholder: C('galleryReportPlaceholder'), 'aria-label': C('galleryReportDetail') });
  let reason = REPORT_REASONS[0];
  const reasonSel = selectEl(
    REPORT_REASONS.map((r) => ({ value: r, label: C(`galleryReport_${r}`) })),
    reason,
    (v) => {
      reason = v;
    },
  );
  reasonSel.setAttribute('aria-label', C('galleryReportReason'));
  const send = h('button', { class: 'btn danger', type: 'button' }, icon('csFlag'), C('galleryReportOk'));
  const m = modal({
    title: C('galleryReportTitle'),
    icon: 'csFlag',
    size: 'sm',
    body: h('div', { class: 'stack' }, h('p', { class: 'cl-modal-text priv' }, clip.title), h('div', { class: 'cs-field' }, h('label', { class: 'cs-label' }, C('galleryReportReason')), reasonSel), h('div', { class: 'cs-field' }, h('label', { class: 'cs-label' }, C('galleryReportDetail')), textIn)),
    footer: [h('button', { class: 'btn ghost', type: 'button', onclick: () => m.close() }, t('common.cancel')), send],
  });
  send.addEventListener('click', async () => {
    const done = setBusy(send);
    try {
      await rpc('gallery_report', { p_id: clip.id, p_reason: reason, p_text: textIn.value.trim() || null });
      ok(C('galleryReported'));
      m.close();
    } catch (err) {
      fail(C('galleryReportFailed'), errText(err));
    } finally {
      done();
    }
  });
}

// ---------- Panel ----------

const memo = { view: 'recent' };

export function galleryPanel() {
  let rows = [];
  let more = false;
  let offset = 0;
  let loading = false;
  let token = 0;
  let alive = true;
  const chips = h('div', { class: 'chips', role: 'group', 'aria-label': C('gallerySort') });
  const grid = h('div', { class: 'cs-gl-host' });
  const moreHost = h('div', { class: 'cs-gl-more' });
  const refreshBtn = h('button', { class: 'icon-btn', type: 'button', title: C('refresh'), 'aria-label': C('refresh'), onclick: () => load(true) }, icon('refresh'));
  const root = h('div', { class: 'cs-gl' }, h('div', { class: 'cs-gl-bar' }, chips, h('span', { class: 'spacer' }), refreshBtn), grid, moreHost);

  function drawChips() {
    mount(
      chips,
      VIEWS.map((v) =>
        h(
          'button',
          {
            type: 'button',
            class: ['chip', memo.view === v && 'active'],
            'aria-pressed': String(memo.view === v),
            onclick: () => {
              if (memo.view === v) return;
              memo.view = v;
              drawChips();
              load(true);
            },
          },
          C(`galleryView_${v}`),
        ),
      ),
    );
  }

  async function toggleLike(clip, card) {
    const next = toggledLike(clip);
    card = replace(clip, next, card, true);
    try {
      const res = await rpc('gallery_like', { p_id: clip.id, p_like: next.liked });
      replace(next, { ...next, liked: res?.liked === true, likes: Number(res?.likes) || 0, likesWeek: Number(res?.likesWeek) || 0 }, card);
    } catch (err) {
      replace(next, clip, card);
      fail(C('galleryLikeFailed'), errText(err));
    }
  }

  function replace(from, to, card, pending = false) {
    const i = rows.indexOf(from);
    if (i < 0) return;
    rows[i] = to;
    const nextCard = clipCard(to);
    const button = nextCard.querySelector('.cs-gl-like');
    if (button) button.disabled = pending;
    if (card?.isConnected) card.replaceWith(nextCard);
    return nextCard;
  }

  async function unpublish(clip) {
    if (!(await confirmDialog(C('galleryUnpublishTitle'), C('galleryUnpublishText'), { okText: C('galleryUnpublishOk') }))) return;
    try {
      await rpc('gallery_unpublish', { p_id: clip.id });
      ok(C('galleryUnpublished'));
      load(true);
    } catch (err) {
      fail(C('galleryUnpublishFailed'), errText(err));
    }
  }

  function thumbOf(clip) {
    const box = h('button', { class: 'cs-gl-thumb', type: 'button', disabled: !clip.url, title: clip.url ? C('galleryPlay') : '', 'aria-label': clip.url ? C('galleryPlayName', { name: clip.title }) : clip.title, onclick: () => openClip(clip) });
    if (clip.thumb) box.append(h('img', { src: clip.thumb, alt: '', draggable: 'false' }));
    box.append(h('span', { class: 'cs-gl-play', 'aria-hidden': 'true' }, icon('play')));
    return box;
  }

  function clipCard(clip) {
    const mineView = memo.view === 'mine';
    const state = mineView ? ownState(clip) : 'live';
    const own = clip.mine || mineView;
    const weekly = C('galleryLikesWeek', { count: clip.likesWeek });
    const card = h('article', { class: ['cs-gl-card', state !== 'live' && 'off'] });
    // Lo propio no se puede votar: muestra la cuenta sola
    const likes = own
      ? h('span', { class: 'cs-gl-likes num', title: weekly }, icon('heart'), String(clip.likes))
      : h('button', { class: ['btn sm ghost cs-gl-like', clip.liked && 'on'], type: 'button', 'aria-pressed': String(clip.liked), title: `${clip.liked ? C('galleryUnlike') : C('galleryLike')} · ${weekly}`, 'aria-label': clip.liked ? C('galleryUnlikeName', { name: clip.title }) : C('galleryLikeName', { name: clip.title }), onclick: () => toggleLike(clip, card) }, icon('heart'), h('span', { class: 'num' }, String(clip.likes)));
    const reportBtn = !own ? h('button', { class: 'icon-btn sm', type: 'button', title: C('galleryReport'), 'aria-label': C('galleryReportName', { name: clip.title }), onclick: () => openReport(clip) }, icon('csFlag')) : null;
    const removeBtn = mineView && state !== 'hidden' ? h('button', { class: 'btn sm ghost', type: 'button', onclick: () => unpublish(clip) }, icon('x'), C('galleryUnpublishOk')) : null;
    const title = h('h3', { class: ['cs-gl-title', 'ellipsis', !mineView && !clip.mine && 'priv'], title: clip.title }, clip.title);
    const who = clip.author?.name ? h('div', { class: 'cs-gl-who' }, avatarImg(clip.author.mc || clip.author.name, 32, 'cs-gl-av'), h('span', { class: ['ellipsis', !clip.mine && 'priv'] }, clip.author.name)) : null;
    let note = null;
    if (mineView && state === 'hidden') note = h('div', { class: 'cs-gl-note bad' }, icon('alert'), h('span', {}, clip.hiddenReason ? C('galleryHiddenReason', { reason: clip.hiddenReason }) : C('galleryHidden')));
    else if (mineView && state === 'expired') note = h('div', { class: 'cs-gl-note warn' }, icon('clock'), h('span', {}, C('galleryExpired')));
    else if (expiresSoon(clip)) note = h('div', { class: 'cs-gl-note warn' }, icon('clock'), h('span', {}, C('galleryExpiresSoon', { date: fmtDate(clip.expiresAt, DATE_LONG) })));
    mount(card, thumbOf(clip), h('div', { class: 'cs-gl-body' }, title, who, note, h('div', { class: 'cs-gl-foot' }, h('span', { class: 'cs-gl-when' }, clip.at ? fmtAgo(clip.at) : ''), h('span', { class: 'spacer' }), likes, reportBtn, removeBtn)));
    return card;
  }

  function drawRows() {
    if (!rows.length) {
      const mine = memo.view === 'mine';
      mount(grid, h('div', { class: 'card flat' }, emptyState('globe', mine ? C('galleryMineEmpty') : C('galleryEmpty'), mine ? C('galleryMineEmptyText') : C('galleryEmptyText'))));
    } else mount(grid, h('div', { class: 'cs-gl-grid' }, rows.map(clipCard)));
    if (more) mount(moreHost, h('button', { class: 'btn', type: 'button', onclick: (e) => loadMore(e.currentTarget) }, icon('chevronDown'), C('showMore')));
    else mount(moreHost);
  }

  function showError(err) {
    const code = errorCode(err);
    if (code === 'not_authenticated') return showSignIn();
    mount(grid, h('div', { class: 'card flat' }, emptyState('alert', C('galleryLoadFailed'), errText(err), h('button', { class: 'btn', type: 'button', onclick: () => load(true) }, icon('refresh'), C('retry')))));
    mount(moreHost);
    return null;
  }

  function showSignIn() {
    mount(grid, h('div', { class: 'card flat' }, emptyState('globe', C('galleryTitle'), C('gallerySignIn'), h('button', { class: 'btn', type: 'button', onclick: () => navigate('settings/cloud') }, icon('logIn'), C('goToAccount')))));
    mount(moreHost);
  }

  async function fetchPage(offset) {
    const url = projectUrl();
    if (memo.view === 'mine') return { list: ownClips(await rpc('gallery_mine'), url), more: false, nextOffset: 0 };
    const data = await rpc('gallery_list', { p_sort: memo.view === 'week' ? 'week' : 'recent', p_offset: offset, p_limit: PAGE_SIZE });
    return { list: visibleClips(data?.items, url), more: data?.more === true, nextOffset: offset + (Array.isArray(data?.items) ? data.items.length : 0) };
  }

  async function load(force = false) {
    if (loading && !force) return;
    loading = true;
    const my = ++token;
    await Promise.resolve(cloud.ready()).catch(() => {});
    if (!alive || my !== token) return;
    if (!signedIn()) {
      loading = false;
      showSignIn();
      return;
    }
    mount(grid, skeleton('grid', { items: 6, min: 240, label: C('galleryLoading') }));
    mount(moreHost);
    try {
      const page = await fetchPage(0);
      if (!alive || my !== token) return;
      rows = page.list;
      offset = page.nextOffset;
      more = page.more;
      drawRows();
    } catch (err) {
      if (alive && my === token) showError(err);
    } finally {
      if (my === token) loading = false;
    }
  }

  async function loadMore(btn) {
    if (loading || !more) return;
    loading = true;
    const my = token;
    const done = setBusy(btn);
    try {
      const page = await fetchPage(offset);
      if (!alive || my !== token) return;
      rows = rows.concat(page.list);
      offset = page.nextOffset;
      more = page.more;
      drawRows();
    } catch (err) {
      if (alive && my === token) fail(C('galleryLoadFailed'), errText(err));
    } finally {
      if (my === token) loading = false;
      done();
    }
  }

  const offAuth = cloud.on?.('auth', () => load(true));
  drawChips();
  load();
  root.reload = () => load(true);
  root.destroy = () => {
    alive = false;
    offAuth?.();
  };
  return root;
}
