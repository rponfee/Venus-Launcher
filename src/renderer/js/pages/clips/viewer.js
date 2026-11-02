// Visor grande de Clips: imagen o video a pantalla completa con teclado (flechas, Inicio/Fin, Supr, E, Escape) y
// las acciones de cada archivo: compartir link, mandar a un amigo, destacar en el perfil, editar, copiar, abrir,
// mostrar en la carpeta y mandar a la papelera. Las acciones de archivo van por los canales worlds:*.
import { h, icon, mount, ok, fail, confirmDialog, fmtBytes, fmtDate, reducedMotion, setBusy } from '../../ui.js';
import { api } from '../../store.js';
import { t } from '../../i18n.js';
import { shareMedia } from '../worlds/media.js';
import { sendToFriend, featureOnProfile } from './share.js';
import { tabOf } from './model.js';
import { iconBtn } from './common.js';

const EXIT_MS = 180;
const DATE_TIME = { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' };
let current = null;

export function closeViewer() {
  current?.close();
}

export function itemLabel(item) {
  const date = fmtDate(item.date, DATE_TIME);
  const tab = tabOf(item);
  if (tab === 'screenshots') return item.world ? t('clips.shotOf', { world: item.world, date }) : t('clips.shotAt', { date });
  if (tab === 'recordings') return item.world ? t('clips.recOf', { world: item.world, date }) : t('clips.recAt', { date });
  return item.world ? t('clips.clipOf', { world: item.world, date }) : t('clips.clipAt', { date });
}

/**
 * opts: { onDeleted(item), onShared(item), onEdit(item), describe(item) -> descripcion hecha con IA o '' }
 */
export function openViewer(list, index, opts = {}) {
  closeViewer();
  const items = list.slice();
  if (!items.length) return;
  let i = Math.max(0, Math.min(index, items.length - 1));
  let token = 0;
  const stage = h('div', { class: 'cl-vw-stage' });
  const title = h('div', { class: 'cl-vw-title' });
  const sub = h('div', { class: 'cl-vw-sub' });
  const aiLine = h('div', { class: 'cl-vw-ai', hidden: true });
  const counter = h('span', { class: 'cl-vw-count' });
  const prev = h('button', { class: 'icon-btn cl-vw-nav prev', type: 'button', title: t('clips.prev'), 'aria-label': t('clips.prev'), onclick: () => show(i - 1) }, icon('chevronLeft'));
  const next = h('button', { class: 'icon-btn cl-vw-nav next', type: 'button', title: t('clips.next'), 'aria-label': t('clips.next'), onclick: () => show(i + 1) }, icon('chevronRight'));

  const shareBtn = h('button', { class: 'btn sm', type: 'button', onclick: () => busy(shareBtn, async () => (await shareMedia(items[i])) && opts.onShared?.(items[i])) }, icon('link'), t('clips.shareLink'));
  const friendBtn = h('button', { class: 'btn sm', type: 'button', onclick: () => busy(friendBtn, () => sendToFriend(items[i])) }, icon('send'), t('clips.sendFriend'));
  const featureBtn = h('button', { class: 'btn sm', type: 'button', onclick: () => busy(featureBtn, () => featureOnProfile(items[i])) }, icon('star'), t('clips.feature'));
  const editBtn = h('button', { class: 'btn sm tonal', type: 'button', onclick: () => edit() }, icon('clScissors'), t('clips.edit'));
  const copyBtn = iconBtn('copy', t('clips.copyImage'), () => copyImage());
  const openFile = () => api.invoke('worlds:openMedia', items[i].path).catch((err) => fail(t('clips.openFailed'), err));
  const openBtn = iconBtn('external', t('clips.openFile'), openFile);
  const folderBtn = iconBtn('folderOpen', t('clips.showInFolder'), () => api.invoke('worlds:showMedia', items[i].path).catch((err) => fail(t('clips.openFailed'), err)));
  const delBtn = iconBtn('trash', t('clips.delete'), () => remove(), 'danger');
  const closeBtn = h('button', { class: 'icon-btn', type: 'button', title: t('clips.close'), 'aria-label': t('clips.close'), onclick: () => close() }, icon('x'));
  const sep = () => h('span', { class: 'cl-vw-sep', 'aria-hidden': 'true' });
  const box = h(
    'div',
    { class: 'cl-vw', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('clips.viewerLabel') },
    h('div', { class: 'cl-vw-main', onclick: (e) => e.target === e.currentTarget && close() }, prev, stage, next),
    h(
      'div',
      { class: 'cl-vw-bar' },
      h('div', { class: 'cl-vw-info', 'aria-live': 'polite' }, title, sub, aiLine),
      counter,
      h('div', { class: 'cl-vw-actions', role: 'group', 'aria-label': t('clips.viewerActions') }, editBtn, shareBtn, friendBtn, featureBtn, sep(), copyBtn, openBtn, folderBtn, sep(), delBtn, sep(), closeBtn),
    ),
  );

  async function busy(btn, fn) {
    const done = setBusy(btn);
    try {
      await fn();
    } finally {
      done();
    }
  }

  function failed(it) {
    stage.classList.remove('loading');
    const video = it.kind === 'clip';
    mount(
      stage,
      h(
        'div',
        { class: 'cl-vw-error' },
        icon(video ? 'woFilm' : 'image'),
        h('strong', {}, video ? t('clips.videoUnsupported') : t('clips.loadFailed')),
        h('span', {}, video ? t('clips.videoUnsupportedText') : t('clips.loadFailedText')),
        h('button', { class: 'btn sm', type: 'button', onclick: openFile }, icon('external'), t('clips.openFile')),
      ),
    );
  }

  function show(n) {
    if (!items.length) return close();
    i = (n + items.length) % items.length;
    const my = ++token;
    const it = items[i];
    const label = itemLabel(it);
    const spin = h('div', { class: 'cl-vw-spin', 'aria-hidden': 'true' }, h('div', { class: 'spinner lg' }));
    stage.classList.add('loading');
    const ready = (el) => {
      if (my !== token) return;
      stage.classList.remove('loading');
      el.classList.add('in');
    };
    if (it.kind === 'clip') {
      const v = h('video', { class: 'cl-vw-media', src: it.url, controls: true, autoplay: true, preload: 'metadata', 'aria-label': label });
      v.addEventListener('loadeddata', () => ready(v), { once: true });
      v.addEventListener('error', () => my === token && failed(it), { once: true });
      mount(stage, v, spin);
    } else {
      const img = h('img', { class: 'cl-vw-media', alt: label, draggable: 'false' });
      img.addEventListener('load', () => ready(img), { once: true });
      img.addEventListener('error', () => my === token && failed(it), { once: true });
      img.src = it.url;
      mount(stage, img, spin);
    }
    mount(title, it.world || it.instanceName || it.file);
    title.title = it.file || '';
    mount(sub, it.world ? h('span', {}, it.instanceName) : null, h('span', {}, fmtDate(it.date, DATE_TIME)), h('span', {}, fmtBytes(it.size)), h('span', { class: 'ellipsis cl-vw-file', title: it.file }, it.file));
    const desc = typeof opts.describe === 'function' ? opts.describe(it) : '';
    aiLine.hidden = !desc;
    mount(aiLine, desc ? [icon('sparkles'), h('span', { class: 'ellipsis', title: desc }, desc)] : []);
    counter.textContent = t('clips.counter', { index: i + 1, total: items.length });
    prev.hidden = next.hidden = items.length < 2;
    const shot = it.kind === 'screenshot';
    copyBtn.hidden = !shot;
    featureBtn.hidden = !shot;
    editBtn.hidden = shot || typeof opts.onEdit !== 'function';
  }

  async function copyImage() {
    try {
      await api.invoke('worlds:copyImage', items[i].path);
      ok(t('clips.imageCopied'));
    } catch (err) {
      fail(t('clips.copyFailed'), err);
    }
  }

  function edit() {
    const it = items[i];
    close();
    opts.onEdit?.(it);
  }

  async function remove() {
    const it = items[i];
    const shot = it.kind === 'screenshot';
    if (!(await confirmDialog(shot ? t('clips.deleteShotTitle') : t('clips.deleteVideoTitle'), t('clips.deleteText', { name: it.file }), { okText: t('clips.moveToTrash'), danger: true }))) return;
    try {
      await api.invoke('worlds:deleteMedia', it.path);
      ok(t('clips.deleted'), it.file);
      items.splice(i, 1);
      opts.onDeleted?.(it);
      if (!items.length) return close();
      show(Math.min(i, items.length - 1));
    } catch (err) {
      fail(t('clips.deleteFailed'), err);
    }
  }

  const prevFocus = document.activeElement;
  const typing = (e) => e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA';
  const onKey = (e) => {
    if (document.querySelector('.modal-backdrop')) return; // hay un dialogo encima
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.target.tagName === 'VIDEO' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      /* el video usa las flechas para adelantar */
    } else if (e.key === 'ArrowLeft') show(i - 1);
    else if (e.key === 'ArrowRight') show(i + 1);
    else if (e.key === 'Home') {
      e.preventDefault();
      show(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      show(items.length - 1);
    } else if (e.key === 'Delete' && !typing(e)) {
      e.preventDefault();
      remove();
    } else if ((e.key === 'e' || e.key === 'E') && !e.ctrlKey && !e.altKey && !e.metaKey && !typing(e) && !editBtn.hidden) {
      e.preventDefault();
      edit();
    } else if (e.key === 'Tab') {
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
