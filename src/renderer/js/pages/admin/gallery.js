// Panel de administracion: galeria publica de clips. Lista lo denunciado, lo oculto o todo, y permite ocultar, volver a
// mostrar, borrar la publicacion y cerrar denuncias, todo con registro (admin_log). RPC de 0032_galeria_clips.sql. Lo enchufa
// pages/admin.js. Los titulos y textos ajenos van como texto. Borrar saca la publicacion: el archivo sigue en el bucket del
// dueño hasta que deje de compartirlo (desde SQL no se puede borrar un objeto del Storage).
import { h, icon, mount, ok, fail, setBusy, skeleton, emptyState, fmtAgo, fmtDate, ensureCss, confirmDialog, promptDialog } from '../../ui.js';
import { t, loadNs } from '../../i18n.js';
import { cloud } from '../../cloud.js';
import { normalizeClip, cleanTitle, errorCode } from '../clips/gallery-logic.js';
import '../../features/clipstudio/icons.js';

const C = (key, vars) => t(`clipstudio.${key}`, vars);
const FILTERS = ['reported', 'hidden', 'all'];

let backend = null;
export function setAdminGalleryBackend(fn) {
  backend = fn;
}

async function rpc(name, args) {
  if (backend) return backend(name, args);
  const { data, error } = await cloud.client.rpc(name, args);
  if (error) throw error;
  return data;
}

function errText(err) {
  const code = errorCode(err);
  if (code === 'unavailable') console.warn('[admin] galeria:', err?.code || '', err?.message || err);
  return C(`gallery_err_${code}`);
}

export async function render(root) {
  ensureCss('features/clipstudio');
  await loadNs('clipstudio');
  let filter = 'reported';
  let rows = [];
  let more = false;
  let token = 0;
  let loading = false;
  const list = h('div', { class: 'stack cs-ad-list' });
  const moreHost = h('div', { class: 'cs-gl-more' });
  const reload = h('button', { class: 'btn sm', type: 'button', onclick: () => load() }, icon('refresh'), C('refresh'));
  const chips = h('div', { class: 'chips', role: 'group', 'aria-label': C('adminGalleryFilter') });
  mount(root, h('div', { class: 'page-head' }, h('div', { class: 'ph-text' }, h('h2', { class: 'page-title' }, C('adminGalleryTitle')), h('p', { class: 'page-sub' }, C('adminGallerySub'))), h('div', { class: 'page-actions' }, reload)), chips, list, moreHost);

  function drawChips() {
    mount(
      chips,
      FILTERS.map((f) =>
        h(
          'button',
          {
            type: 'button',
            class: ['chip', filter === f && 'active'],
            'aria-pressed': String(filter === f),
            onclick: () => {
              filter = f;
              drawChips();
              load();
            },
          },
          C(`adminGalleryFilter_${f}`),
        ),
      ),
    );
  }

  const action = (btn, run, done) => async () => {
    const release = setBusy(btn);
    try {
      await run();
      ok(done);
      load();
    } catch (err) {
      fail(C('adminGalleryFailed'), errText(err));
    } finally {
      release();
    }
  };

  async function askReason(title) {
    return promptDialog(title, C('adminGalleryReason'), { okText: t('common.ok') });
  }

  function row(raw) {
    const clip = normalizeClip(raw, cloud.config?.url || 'https://example.supabase.co');
    if (!clip) return null;
    const reports = Array.isArray(raw.reports) ? raw.reports : [];
    const hideBtn = h('button', { class: 'btn sm', type: 'button' }, icon(clip.hidden ? 'eye' : 'eyeOff'), clip.hidden ? C('adminGalleryShow') : C('adminGalleryHide'));
    hideBtn.addEventListener('click', async () => {
      const reason = clip.hidden ? null : await askReason(C('adminGalleryHideTitle'));
      if (!clip.hidden && reason === null) return;
      action(hideBtn, () => rpc('admin_gallery_hide', { p_id: clip.id, p_hidden: !clip.hidden, p_reason: reason || null }), clip.hidden ? C('adminGalleryShown') : C('adminGalleryHidden'))();
    });
    const delBtn = h('button', { class: 'btn sm danger', type: 'button' }, icon('trash'), C('adminGalleryDelete'));
    delBtn.addEventListener('click', async () => {
      if (!(await confirmDialog(C('adminGalleryDeleteTitle'), C('adminGalleryDeleteText'), { okText: C('adminGalleryDelete'), danger: true }))) return;
      action(delBtn, () => rpc('admin_gallery_delete', { p_id: clip.id, p_reason: null }), C('adminGalleryDeleted'))();
    });
    const closeBtn = reports.length ? h('button', { class: 'btn sm', type: 'button' }, icon('check'), C('adminGalleryClose')) : null;
    closeBtn?.addEventListener('click', action(closeBtn, () => rpc('admin_gallery_reports_close', { p_id: clip.id }), C('adminGalleryClosed')));
    const video = clip.url ? h('video', { class: 'cs-ad-video', controls: true, preload: 'none', 'aria-label': clip.title, poster: clip.thumb || undefined, src: clip.url }) : h('div', { class: 'cs-ad-video none' }, icon('csFilm'));
    return h(
      'article',
      { class: ['card', 'cs-ad-row', clip.hidden && 'off'] },
      video,
      h(
        'div',
        { class: 'cs-ad-main' },
        h('div', { class: 'row wrap' }, clip.hidden ? h('span', { class: 'pill warn' }, C('adminGalleryIsHidden')) : null, clip.expired ? h('span', { class: 'pill' }, C('adminGalleryIsExpired')) : null, reports.length ? h('span', { class: 'pill bad' }, C('adminGalleryReports', { count: reports.length })) : null),
        h('h3', { class: 'cs-gl-title' }, clip.title),
        h('div', { class: 'cs-mt-sub' }, h('span', {}, C('adminGalleryBy', { name: clip.author.name || '?' })), h('span', {}, clip.at ? fmtAgo(clip.at) : ''), h('span', { class: 'num' }, C('adminGalleryLikes', { count: clip.likes })), clip.expiresAt ? h('span', {}, C('adminGalleryExpires', { date: fmtDate(clip.expiresAt) })) : null),
        clip.hiddenReason ? h('p', { class: 'cs-help' }, C('galleryHiddenReason', { reason: clip.hiddenReason })) : null,
        reports.map((r) => {
          const who = r?.reporter?.displayName || r?.reporter?.username || '?';
          return h('div', { class: 'cs-ad-report' }, h('span', { class: 'badge' }, C(`galleryReport_${['offensive', 'spam', 'stolen', 'other'].includes(r?.reason) ? r.reason : 'other'}`)), h('span', { class: 'muted' }, C('adminGalleryReportBy', { name: cleanTitle(who) })), r?.text ? h('p', { class: 'selectable' }, String(r.text).slice(0, 300)) : null);
        }),
        h('div', { class: 'row wrap' }, hideBtn, closeBtn, delBtn),
      ),
    );
  }

  function draw() {
    if (!rows.length) mount(list, emptyState('shield', C('adminGalleryEmpty'), ''));
    else mount(list, rows.map(row).filter(Boolean));
    if (more) mount(moreHost, h('button', { class: 'btn', type: 'button', onclick: () => loadMore() }, icon('chevronDown'), C('showMore')));
    else mount(moreHost);
  }

  async function load() {
    const my = ++token;
    loading = true;
    mount(list, skeleton('list', { rows: 4, label: C('galleryLoading') }));
    mount(moreHost);
    try {
      const data = await rpc('admin_gallery_list', { p_filter: filter, p_offset: 0 });
      if (my !== token) return;
      rows = Array.isArray(data?.items) ? data.items : [];
      more = data?.more === true;
      draw();
    } catch (err) {
      if (my !== token) return;
      console.warn('[admin] galeria:', err?.message || err);
      mount(list, emptyState('alert', C('galleryLoadFailed'), errText(err)));
    } finally {
      if (my === token) loading = false;
    }
  }

  async function loadMore() {
    if (loading || !more) return;
    loading = true;
    const my = token;
    try {
      const data = await rpc('admin_gallery_list', { p_filter: filter, p_offset: rows.length });
      if (my !== token) return;
      rows = rows.concat(Array.isArray(data?.items) ? data.items : []);
      more = data?.more === true;
      draw();
    } catch (err) {
      if (my === token) fail(C('galleryLoadFailed'), errText(err));
    } finally {
      if (my === token) loading = false;
    }
  }

  drawChips();
  load();
}
