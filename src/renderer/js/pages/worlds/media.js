// Capturas y clips: miniaturas a pedido (solo las visibles), grilla agrupada por mes, visor a pantalla
// completa con acciones (abrir, mostrar en carpeta, copiar imagen, compartir, borrar) y compartir en la
// nube (Supabase Storage, bucket privado + link firmado por un anio, ver supabase/migrations/0005_media.sql).
import { h, icon, mount, modal, ok, fail, confirmDialog, copyText, emptyState, fmtBytes, fmtDate, reducedMotion, setBusy } from '../../ui.js';
import { api } from '../../store.js';
import { t, locale } from '../../i18n.js';
import { navigate } from '../../app.js';
import { cloud } from '../../cloud.js';
import { DATE_TIME, iconBtn, worldRoute, bone, skelGroup } from './common.js';

const LINK_SECONDS = 365 * 24 * 3600;
const LIMITS = { screenshot: 15 * 1024 * 1024, clip: 50 * 1024 * 1024 };
const EXIT_MS = 180; // --dur de main.css

// ---------- Miniaturas (pedidas en tandas al proceso principal) ----------
const thumbCache = new Map(); // ruta -> url | null
const waiting = new Map(); // ruta -> [resolve]
let thumbTimer = null;

function flushThumbs() {
  thumbTimer = null;
  const batch = [...waiting.keys()].slice(0, 16);
  if (!batch.length) return;
  const resolvers = batch.map((p) => [p, waiting.get(p)]);
  batch.forEach((p) => waiting.delete(p));
  api
    .invoke('worlds:thumbs', batch)
    .catch(() => ({}))
    .then((map) => {
      for (const [p, list] of resolvers) {
        const url = map?.[p] || null;
        thumbCache.set(p, url);
        list.forEach((r) => r(url));
      }
      if (waiting.size) thumbTimer = setTimeout(flushThumbs, 10);
    });
}

export function requestThumb(path) {
  if (thumbCache.has(path)) return Promise.resolve(thumbCache.get(path));
  return new Promise((resolve) => {
    if (!waiting.has(path)) waiting.set(path, []);
    waiting.get(path).push(resolve);
    if (!thumbTimer) thumbTimer = setTimeout(flushThumbs, 40);
  });
}

// Carga perezosa: cuando la tarjeta entra en pantalla
let observer = null;
const onVisible = new WeakMap();
function observe(el, fn) {
  if (!('IntersectionObserver' in window)) return fn();
  if (!observer) {
    observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          observer.unobserve(e.target);
          const cb = onVisible.get(e.target);
          onVisible.delete(e.target);
          cb?.();
        }
      },
      { rootMargin: '300px 0px' },
    );
  }
  onVisible.set(el, fn);
  observer.observe(el);
  return undefined;
}

// Imagen de una captura: miniatura si hay, si no la original (aparece con un fundido al cargar)
function shotImage(item, cls) {
  const img = h('img', { class: cls, alt: '', decoding: 'async', draggable: 'false' });
  img.addEventListener('load', () => img.classList.add('loaded'));
  img.addEventListener('error', () => {
    if (img.dataset.fallback !== '1' && item.url) {
      img.dataset.fallback = '1';
      img.src = item.url;
    } else img.classList.add('broken');
  });
  if (item.thumb) img.src = item.thumb;
  else
    observe(img, async () => {
      const url = await requestThumb(item.path);
      img.src = url || item.url;
    });
  return img;
}

function clipPreview(item, cls) {
  const video = h('video', { class: cls, muted: true, preload: 'none', playsinline: true, disablepictureinpicture: true, tabindex: '-1', 'aria-hidden': 'true' });
  video.muted = true;
  const shown = () => video.classList.add('loaded');
  video.addEventListener('loadeddata', shown);
  video.addEventListener('seeked', shown);
  observe(video, () => {
    video.preload = 'metadata';
    video.src = `${item.url}#t=0.6`;
  });
  return video;
}

export function mediaLabel(item) {
  const date = fmtDate(item.date, DATE_TIME);
  if (item.kind === 'clip') return item.world ? t('worlds.clipOf', { world: item.world, date }) : t('worlds.clipAt', { date });
  return item.world ? t('worlds.shotOf', { world: item.world, date }) : t('worlds.shotAt', { date });
}

// Tarjeta de una captura o clip
export function mediaTile(item, { onOpen, shared, compact = false } = {}) {
  const isClip = item.kind === 'clip';
  const dur = h('span', { class: 'wo-shot-dur', hidden: true });
  const preview = isClip ? clipPreview(item, 'wo-shot-img') : shotImage(item, 'wo-shot-img');
  if (isClip) {
    preview.addEventListener('loadedmetadata', () => {
      if (Number.isFinite(preview.duration) && preview.duration > 0) {
        const s = Math.round(preview.duration);
        dur.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
        dur.hidden = false;
      }
    });
    preview.addEventListener('error', () => preview.classList.add('broken'));
  }
  return h(
    'button',
    { class: ['wo-shot', isClip && 'clip', compact && 'compact'], type: 'button', 'aria-label': mediaLabel(item), title: mediaLabel(item), onclick: onOpen },
    h('span', { class: 'wo-shot-ph', 'aria-hidden': 'true' }, icon(isClip ? 'woFilm' : 'image')),
    preview,
    isClip ? h('span', { class: 'wo-shot-play', 'aria-hidden': 'true' }, icon('play')) : null,
    isClip ? dur : null,
    shared ? h('span', { class: 'wo-shot-shared', title: t('worlds.sharedBadge'), 'aria-label': t('worlds.sharedBadge'), role: 'img' }, icon('link')) : null,
    compact ? null : h('span', { class: 'wo-shot-cap', 'aria-hidden': 'true' }, h('b', {}, item.world || item.instanceName), h('span', {}, fmtDate(item.date, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))),
  );
}

// Esqueleto de la galeria (miniaturas 16:9 con el brillo de carga)
export function mediaSkeleton(n = 8, label) {
  return skelGroup(label || t('worlds.loadingMedia'), bone('skeleton-line title wo-skel-w30'), h('div', { class: 'wo-shots' }, Array.from({ length: n }, () => bone('wo-shot-skel'))));
}

// Grilla agrupada por mes
export function mediaGrid(items, { onOpen, sharedMap = {}, emptyIcon = 'camera', emptyTitle, emptyText, emptyAction = null, pageSize = 60 } = {}) {
  const host = h('div', { class: 'wo-media' });
  if (!items.length) {
    mount(host, h('div', { class: 'card flat' }, emptyState(emptyIcon, emptyTitle || t('worlds.noMedia'), emptyText || t('worlds.noMediaText'), emptyAction)));
    return host;
  }
  let shown = 0;
  const monthFmt = new Intl.DateTimeFormat(locale(), { month: 'long', year: 'numeric' });
  let lastKey = null;
  let lastGrid = null;
  const more = h('button', { class: 'btn wo-more', type: 'button', onclick: () => draw(true) }, icon('chevronDown'), t('worlds.showMore'));
  // Cantidad por mes (para el titulo de cada grupo)
  const monthKey = (ts) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${d.getMonth()}`;
  };
  const perMonth = new Map();
  for (const it of items) perMonth.set(monthKey(it.date), (perMonth.get(monthKey(it.date)) || 0) + 1);
  function draw(fromButton = false) {
    const end = Math.min(items.length, shown + pageSize);
    let firstNew = null;
    for (let index = shown; index < end; index++) {
      const it = items[index];
      const key = monthKey(it.date);
      if (key !== lastKey) {
        lastKey = key;
        const label = monthFmt.format(new Date(it.date));
        host.insertBefore(h('h3', { class: 'wo-month' }, h('span', {}, label.charAt(0).toUpperCase() + label.slice(1)), h('span', { class: 'wo-month-count' }, String(perMonth.get(key) || 0))), more);
        lastGrid = h('div', { class: 'wo-shots' });
        host.insertBefore(lastGrid, more);
      }
      const tile = mediaTile(it, { onOpen: () => onOpen(index), shared: Boolean(sharedMap[it.sharedKey]) });
      if (!firstNew) firstNew = tile;
      lastGrid.append(tile);
    }
    shown = end;
    more.hidden = shown >= items.length;
    if (!more.hidden) mount(more, icon('chevronDown'), t('worlds.showMoreCount', { count: items.length - shown }));
    // Con el teclado, el foco sigue en la primera captura nueva (el boton puede haber desaparecido)
    if (fromButton && firstNew) firstNew.focus({ preventScroll: false });
  }
  host.append(more);
  draw();
  return host;
}

// ---------- Visor ----------
let current = null;

export function closeLightbox() {
  current?.close();
}

/**
 * Visor a pantalla completa. opts: { onDeleted(item), onShared(), showWorldLink }
 */
export function openLightbox(list, index, opts = {}) {
  closeLightbox();
  const items = list.slice();
  if (!items.length) return;
  let i = Math.max(0, Math.min(index, items.length - 1));
  let shownToken = 0;
  const stage = h('div', { class: 'wo-lb-stage' });
  const title = h('div', { class: 'wo-lb-title' });
  const sub = h('div', { class: 'wo-lb-sub' });
  const counter = h('span', { class: 'wo-lb-count' });
  const prev = h('button', { class: 'icon-btn wo-lb-nav prev', type: 'button', title: t('worlds.prev'), 'aria-label': t('worlds.prev'), onclick: () => show(i - 1) }, icon('chevronLeft'));
  const next = h('button', { class: 'icon-btn wo-lb-nav next', type: 'button', title: t('worlds.next'), 'aria-label': t('worlds.next'), onclick: () => show(i + 1) }, icon('chevronRight'));
  const shareBtn = h('button', { class: 'btn sm', type: 'button', onclick: () => share() }, icon('share'), t('worlds.share'));
  const copyBtn = iconBtn('copy', t('worlds.copyImage'), () => copyImage());
  const openFile = () => api.invoke('worlds:openMedia', items[i].path).catch((err) => fail(t('worlds.openFailed'), err));
  const openBtn = iconBtn('external', t('worlds.openFile'), openFile);
  const folderBtn = iconBtn('folderOpen', t('worlds.showInFolder'), () => api.invoke('worlds:showMedia', items[i].path).catch((err) => fail(t('worlds.openFailed'), err)));
  const worldBtn = iconBtn('globe', t('worlds.goToWorld'), () => {
    const it = items[i];
    close();
    navigate(worldRoute(it.instanceId, it.worldFolder));
  });
  const delBtn = iconBtn('trash', t('worlds.deleteMedia'), () => remove(), 'danger');
  const closeBtn = iconBtn('x', t('worlds.close'), () => close());
  closeBtn.classList.remove('sm');
  const sep = () => h('span', { class: 'wo-lb-sep', 'aria-hidden': 'true' });
  const box = h(
    'div',
    { class: 'wo-lb', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('worlds.viewerLabel') },
    h('div', { class: 'wo-lb-main', onclick: (e) => e.target === e.currentTarget && close() }, prev, stage, next),
    h(
      'div',
      { class: 'wo-lb-bar' },
      h('div', { class: 'wo-lb-info', 'aria-live': 'polite' }, title, sub),
      counter,
      h('div', { class: 'wo-lb-actions', role: 'group', 'aria-label': t('worlds.viewerActions') }, shareBtn, copyBtn, openBtn, folderBtn, worldBtn, sep(), delBtn, sep(), closeBtn),
    ),
  );

  // Archivo que no se puede mostrar: que paso y como seguir
  function failed(it) {
    stage.classList.remove('loading');
    mount(
      stage,
      h(
        'div',
        { class: 'wo-lb-error' },
        icon(it.kind === 'clip' ? 'woFilm' : 'image'),
        h('strong', {}, it.kind === 'clip' ? t('worlds.clipUnsupported') : t('worlds.mediaLoadFailed')),
        h('span', {}, it.kind === 'clip' ? t('worlds.clipUnsupportedText') : t('worlds.mediaLoadFailedText')),
        h('button', { class: 'btn sm', type: 'button', onclick: openFile }, icon('external'), it.kind === 'clip' ? t('worlds.openWithPlayer') : t('worlds.openFile')),
      ),
    );
  }

  function show(n) {
    if (!items.length) return close();
    i = (n + items.length) % items.length;
    const token = ++shownToken;
    const it = items[i];
    const label = mediaLabel(it);
    const spin = h('div', { class: 'wo-lb-spin', 'aria-hidden': 'true' }, h('div', { class: 'spinner lg' }));
    stage.classList.add('loading');
    const ready = (el) => {
      if (token !== shownToken) return;
      stage.classList.remove('loading');
      el.classList.add('in');
    };
    if (it.kind === 'clip') {
      const v = h('video', { class: 'wo-lb-media', src: it.url, controls: true, autoplay: true, preload: 'metadata', 'aria-label': label });
      v.addEventListener('loadeddata', () => ready(v), { once: true });
      v.addEventListener('error', () => token === shownToken && failed(it), { once: true });
      mount(stage, v, spin);
    } else {
      const img = h('img', { class: 'wo-lb-media', alt: label, draggable: 'false' });
      img.addEventListener('load', () => ready(img), { once: true });
      img.addEventListener('error', () => token === shownToken && failed(it), { once: true });
      img.src = it.url;
      mount(stage, img, spin);
    }
    mount(title, it.world || it.instanceName || it.file);
    title.title = it.file || '';
    mount(
      sub,
      it.world ? h('span', {}, it.instanceName) : null,
      h('span', {}, fmtDate(it.date, DATE_TIME)),
      h('span', {}, fmtBytes(it.size)),
      it.how === 'guess' ? h('span', { class: 'wo-lb-guess', title: t('worlds.guessHint') }, icon('info'), t('worlds.guessed')) : null,
    );
    counter.textContent = t('worlds.counter', { index: i + 1, total: items.length });
    prev.hidden = next.hidden = items.length < 2;
    copyBtn.hidden = it.kind === 'clip';
    worldBtn.hidden = !opts.showWorldLink || !it.worldFolder;
  }

  async function copyImage() {
    try {
      await api.invoke('worlds:copyImage', items[i].path);
      ok(t('worlds.imageCopied'));
    } catch (err) {
      fail(t('worlds.copyImageFailed'), err);
    }
  }

  async function share() {
    const it = items[i];
    const done = setBusy(shareBtn);
    let changed = false;
    try {
      changed = await shareMedia(it);
    } finally {
      done();
    }
    if (changed) opts.onShared?.(it);
  }

  async function remove() {
    const it = items[i];
    const ask = it.kind === 'clip' ? t('worlds.deleteClipText', { name: it.file }) : t('worlds.deleteShotText', { name: it.file });
    if (!(await confirmDialog(it.kind === 'clip' ? t('worlds.deleteClipTitle') : t('worlds.deleteShotTitle'), ask, { okText: t('worlds.moveToTrash'), danger: true }))) return;
    try {
      await api.invoke('worlds:deleteMedia', it.path);
      ok(t('worlds.mediaDeleted'), it.file);
      items.splice(i, 1);
      opts.onDeleted?.(it);
      if (!items.length) return close();
      show(Math.min(i, items.length - 1));
    } catch (err) {
      fail(t('worlds.deleteMediaFailed'), err);
    }
  }

  const prevFocus = document.activeElement;
  const onKey = (e) => {
    if (document.querySelector('.modal-backdrop')) return; // hay un dialogo encima
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'ArrowLeft' && e.target.tagName !== 'VIDEO') show(i - 1);
    else if (e.key === 'ArrowRight' && e.target.tagName !== 'VIDEO') show(i + 1);
    else if (e.key === 'Tab') {
      const focusables = [...box.querySelectorAll('button, video')].filter((b) => !b.hidden && b.offsetParent !== null);
      const at = focusables.indexOf(document.activeElement);
      if (e.shiftKey && at <= 0) {
        e.preventDefault();
        focusables.at(-1)?.focus();
      } else if (!e.shiftKey && at === focusables.length - 1) {
        e.preventDefault();
        focusables[0]?.focus();
      }
    }
  };
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    box.querySelectorAll('video').forEach((v) => v.pause());
    if (current?.box === box) current = null;
    // Salida con fundido (el visor queda inerte mientras tanto); con movimiento reducido se saca al instante
    if (reducedMotion() || !box.isConnected) box.remove();
    else {
      box.inert = true;
      box.classList.add('closing');
      setTimeout(() => box.remove(), EXIT_MS);
    }
    if (prevFocus && prevFocus.isConnected) prevFocus.focus({ preventScroll: true });
  }
  document.addEventListener('keydown', onKey, true);
  document.body.append(box);
  show(i);
  closeBtn.focus();
  current = { close, box };
}

// ---------- Compartir en la nube ----------

function cloudNotice(kind) {
  const m = modal({
    title: t('worlds.shareTitle'),
    body: h(
      'div',
      { class: 'stack' },
      h('div', { class: 'wo-share-hero' }, icon('cloud'), h('div', {}, h('strong', {}, kind === 'config' ? t('worlds.cloudNotConfigured') : t('worlds.cloudSignIn')), h('p', { class: 'small muted' }, kind === 'config' ? t('worlds.cloudNotConfiguredText') : t('worlds.cloudSignInText')))),
    ),
    footer: [
      h('button', { class: 'btn ghost', type: 'button', onclick: () => m.close() }, t('worlds.cancel')),
      h(
        'button',
        {
          class: 'btn primary',
          type: 'button',
          onclick: () => {
            m.close();
            closeLightbox();
            navigate('settings/cloud');
          },
        },
        icon('settings'),
        t('worlds.goToCloudSettings'),
      ),
    ],
  });
}

function extOf(file) {
  const m = /\.([a-z0-9]+)$/i.exec(file || '');
  return m ? m[1].toLowerCase() : 'bin';
}

function linkModal(item, info, { onUnshared, onClose } = {}) {
  const input = h('input', { class: 'input wo-link-input selectable', value: info.url, readonly: true, 'aria-label': t('worlds.shareLink') });
  input.addEventListener('focus', () => input.select());
  const expires = info.expiresAt ? fmtDate(info.expiresAt, { day: 'numeric', month: 'long', year: 'numeric' }) : '';
  const unshareBtn = h('button', { class: 'btn danger', type: 'button' }, icon('trash'), t('worlds.unshare'));
  const m = modal({
    title: item.kind === 'clip' ? t('worlds.sharedClipTitle') : t('worlds.sharedShotTitle'),
    onClose,
    body: h(
      'div',
      { class: 'stack' },
      h('div', { class: 'wo-share-hero good' }, icon('check'), h('div', {}, h('strong', {}, t('worlds.shareReady')), h('p', { class: 'small muted' }, expires ? t('worlds.shareExpires', { date: expires }) : t('worlds.shareReadyText')))),
      h('div', { class: 'wo-link-row' }, input, h('button', { class: 'btn primary', type: 'button', onclick: () => copyText(info.url, t('worlds.linkCopied')) }, icon('copy'), t('worlds.copyLink'))),
      h('p', { class: 'wo-note' }, t('worlds.sharePrivacy')),
    ),
    footer: [unshareBtn, h('span', { class: 'spacer' }), h('button', { class: 'btn', type: 'button', onclick: () => api.app.openExternal(info.url).catch((err) => fail(t('worlds.openFailed'), err)) }, icon('external'), t('worlds.openLink')), h('button', { class: 'btn ghost', type: 'button', onclick: () => m.close() }, t('worlds.close'))],
  });
  unshareBtn.addEventListener('click', async () => {
    if (!(await confirmDialog(t('worlds.unshareTitle'), t('worlds.unshareText'), { okText: t('worlds.unshare'), danger: true }))) return;
    const done = setBusy(unshareBtn);
    try {
      await unshare(item, info);
      onUnshared?.();
      m.close();
      ok(t('worlds.unshared'));
    } catch (err) {
      done();
      fail(t('worlds.unshareFailed'), err);
    }
  });
}

async function unshare(item, info) {
  const client = cloud.client;
  if (client && cloud.isSignedIn()) {
    const { error } = await client.storage.from(info.bucket).remove([info.path]);
    if (error && !/not.?found/i.test(error.message || '')) throw error;
    await client.from('shared_media').delete().eq('id', info.id);
  }
  await api.invoke('worlds:setShared', item.sharedKey, null);
}

async function renew(item, info) {
  const { data, error } = await cloud.client.storage.from(info.bucket).createSignedUrl(info.path, LINK_SECONDS);
  if (error) throw error;
  const next = { ...info, url: data.signedUrl, expiresAt: Date.now() + LINK_SECONDS * 1000 };
  await cloud.client.from('shared_media').update({ url: next.url, expires_at: new Date(next.expiresAt).toISOString() }).eq('id', info.id);
  await api.invoke('worlds:setShared', item.sharedKey, next);
  return next;
}

function friendlyCloudError(err) {
  const msg = String(err?.message || err || '');
  if (/bucket not found|relation .*shared_media|does not exist|schema cache/i.test(msg)) {
    // Falta la migracion 0005_media.sql en el servidor: el detalle queda en el log
    console.warn('[worlds] falta el esquema de capturas compartidas (0005_media.sql):', msg);
    return new Error(t('worlds.cloudMissingSchema'));
  }
  if (/exceeded the maximum|too large|payload too large|413/i.test(msg)) return new Error(t('worlds.cloudTooLarge'));
  if (/row-level security|unauthorized|jwt/i.test(msg)) return new Error(t('worlds.cloudDenied'));
  return err instanceof Error ? err : new Error(msg);
}

/**
 * Sube una captura o clip a la nube de Venus y devuelve true si cambio su estado de compartido.
 */
export async function shareMedia(item) {
  await cloud.ready();
  if (!cloud.isConfigured()) {
    cloudNotice('config');
    return false;
  }
  if (!cloud.isSignedIn()) {
    cloudNotice('signin');
    return false;
  }
  const map = await api.invoke('worlds:shared').catch(() => ({}));
  let info = map?.[item.sharedKey];
  if (info?.url) {
    let changed = false;
    if (info.expiresAt && info.expiresAt < Date.now() + 86400000) {
      try {
        info = await renew(item, info);
        changed = true;
      } catch (err) {
        fail(t('worlds.shareFailed'), friendlyCloudError(err));
        return false;
      }
    }
    return new Promise((resolve) => {
      let unshared = false;
      linkModal(item, info, { onUnshared: () => (unshared = true), onClose: () => resolve(changed || unshared) });
    });
  }
  const limit = LIMITS[item.kind] || LIMITS.screenshot;
  if (item.size > limit) {
    fail(t('worlds.shareFailed'), t('worlds.shareTooBig', { size: fmtBytes(limit) }));
    return false;
  }
  const go = await confirmDialog(item.kind === 'clip' ? t('worlds.shareClipTitle') : t('worlds.shareShotTitle'), t('worlds.shareConfirm'), { okText: t('worlds.shareUpload') });
  if (!go) return false;
  const progress = modal({
    title: item.kind === 'clip' ? t('worlds.shareClipTitle') : t('worlds.shareShotTitle'),
    size: 'sm',
    closable: false,
    body: h(
      'div',
      { class: 'wo-upload', role: 'status', 'aria-live': 'polite' },
      h('div', { class: 'wo-upload-head' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), t('worlds.uploading')),
      h('div', { class: 'small muted ellipsis', title: item.file }, item.file),
      h('div', { class: 'progress indeterminate', 'aria-hidden': 'true' }, h('i')),
    ),
  });
  try {
    const user = cloud.requireSession();
    const file = await api.invoke('worlds:readMedia', item.path);
    const id = crypto.randomUUID();
    const bucket = item.kind === 'clip' ? 'clips' : 'screenshots';
    const objectPath = `${user.id}/${id}.${extOf(item.file)}`;
    const blob = new Blob([file.data], { type: file.mime });
    const up = await cloud.client.storage.from(bucket).upload(objectPath, blob, { contentType: file.mime, upsert: false, cacheControl: '31536000' });
    if (up.error) throw up.error;
    const signed = await cloud.client.storage.from(bucket).createSignedUrl(objectPath, LINK_SECONDS);
    if (signed.error) throw signed.error;
    const expiresAt = Date.now() + LINK_SECONDS * 1000;
    const row = {
      id,
      owner: user.id,
      kind: item.kind,
      bucket,
      path: objectPath,
      file_name: String(item.file).slice(0, 200),
      world: item.world ? String(item.world).slice(0, 120) : null,
      instance_name: item.instanceName ? String(item.instanceName).slice(0, 120) : null,
      size_bytes: file.size,
      width: file.width,
      height: file.height,
      taken_at: new Date(item.date).toISOString(),
      expires_at: new Date(expiresAt).toISOString(),
      url: signed.data.signedUrl,
    };
    const ins = await cloud.client.from('shared_media').insert(row);
    if (ins.error) {
      await cloud.client.storage.from(bucket).remove([objectPath]).catch(() => {});
      throw ins.error;
    }
    const saved = { id, bucket, path: objectPath, url: signed.data.signedUrl, expiresAt, sharedAt: Date.now() };
    await api.invoke('worlds:setShared', item.sharedKey, saved);
    progress.close();
    await copyText(saved.url, t('worlds.linkCopied'));
    linkModal(item, saved);
    return true;
  } catch (err) {
    progress.close();
    fail(t('worlds.shareFailed'), friendlyCloudError(err));
    return false;
  }
}
