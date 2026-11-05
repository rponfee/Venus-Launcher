// Capturas de Soporte: elegir, pegar o arrastrar imágenes (se reescriben achicadas y sin metadatos antes de salir de la
// PC), mostrar las que ya tiene una consulta y verlas en grande. La subida y la descarga las hace el proceso principal.
import { h, icon, mount, modal, loading, fail } from '../../ui.js';
import { api } from '../../store.js';
import { S, uid, fmtSize, errMsg } from './common.js';
import { ATTACH, validateAttachment, fitSize } from './logic.js';

const toBlob = (canvas, type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality));

// Dibuja la imagen en un lienzo (lado mayor hasta 1600 px) y la vuelve a codificar: así se van el EXIF con ubicación y los
// textos incrustados. Si no entra en 4 MB se achica de a poco.
export async function prepareImage(file) {
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement('canvas');
    let scale = 1;
    for (let attempt = 0; attempt < 4; attempt++) {
      const { width, height } = fitSize(bitmap.width * scale, bitmap.height * scale, ATTACH.maxSide);
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
      const tries = attempt === 0 && file.type === 'image/png' ? [['image/png'], ['image/webp', 0.92]] : [[file.type === 'image/jpeg' ? 'image/jpeg' : 'image/webp', 0.9]];
      for (const [type, quality] of tries) {
        const blob = await toBlob(canvas, type, quality);
        if (blob && blob.type === type && blob.size <= ATTACH.maxBytes) return { blob, width, height };
      }
      scale *= 0.75;
    }
  } finally {
    bitmap.close?.();
  }
  throw Object.assign(new Error('big'), { code: 'attach_big' });
}

// -> { el, items(), count(), add(files), clear(), setDisabled(bool), onPaste(event) }
export function createAttachPicker({ max = ATTACH.perSend, onChange = () => {} } = {}) {
  const items = [];
  let disabled = false;
  let working = 0;
  const hintId = uid('sp-att');
  const input = h('input', { type: 'file', accept: ATTACH.mime.join(','), multiple: true, class: 'sr-only', tabindex: '-1', 'aria-hidden': 'true' });
  const button = h('button', { type: 'button', class: 'btn sm', 'aria-describedby': hintId, onclick: () => input.click() }, icon('spPaperclip'), S('attachAdd'));
  const hint = h('div', { class: 'sp-hint', id: hintId }, S('attachHint', { max, size: 4 }));
  const errors = h('div', { class: 'sp-error', role: 'alert' });
  const list = h('ul', { class: 'sp-chips', 'aria-label': S('attachListLabel') });
  const el = h('div', { class: 'sp-attach' }, h('div', { class: 'sp-attach-row' }, button, hint, input), errors, list);

  function draw() {
    mount(list, items.map((item) => h('li', { class: ['sp-chip', item.busy && 'busy'] },
      item.url ? h('img', { src: item.url, alt: '', class: 'sp-chip-img' }) : h('span', { class: 'sp-chip-img ph' }, icon('image')),
      h('span', { class: 'sp-chip-text' }, h('strong', {}, item.name), h('span', { class: 'muted small' }, item.busy ? S('attachPreparing') : fmtSize(item.size))),
      h('button', { type: 'button', class: 'icon-btn sm', 'aria-label': S('attachRemove', { name: item.name }), title: S('attachRemoveShort'), onclick: () => remove(item.id) }, icon('x')))));
    button.disabled = disabled || items.length + working >= max;
    onChange(items.filter((x) => !x.busy));
  }
  function remove(id) {
    const i = items.findIndex((x) => x.id === id);
    if (i < 0) return;
    if (items[i].url) URL.revokeObjectURL(items[i].url);
    items.splice(i, 1);
    errors.textContent = '';
    draw();
    (list.querySelector('.icon-btn') || button).focus();
  }
  async function add(fileList) {
    errors.textContent = '';
    for (const file of [...(fileList || [])]) {
      const problem = validateAttachment({ type: file.type, size: file.size, name: file.name }, items.length + working);
      if (problem) { errors.textContent = S(`attachErr_${problem}`, { max }); if (problem === 'tooMany') break; continue; }
      const item = { id: uid('att'), name: (file.name || S('attachDefaultName')).slice(0, 80), busy: true, size: file.size };
      items.push(item);
      working++;
      draw();
      try {
        const done = await prepareImage(file);
        Object.assign(item, { blob: done.blob, mime: done.blob.type, size: done.blob.size, url: URL.createObjectURL(done.blob), busy: false });
      } catch (err) {
        items.splice(items.indexOf(item), 1);
        errors.textContent = err?.code === 'attach_big' ? S('attachErr_big') : S('attachErr_read', { name: item.name });
      } finally {
        working--;
        draw();
      }
    }
  }
  input.addEventListener('change', () => { add(input.files); input.value = ''; });
  el.addEventListener('dragover', (event) => { if (!disabled && event.dataTransfer?.types?.includes('Files')) { event.preventDefault(); el.classList.add('drop'); } });
  el.addEventListener('dragleave', () => el.classList.remove('drop'));
  el.addEventListener('drop', (event) => { event.preventDefault(); el.classList.remove('drop'); if (!disabled) add(event.dataTransfer?.files); });
  draw();
  return {
    el,
    items: () => items.filter((x) => !x.busy && x.blob),
    count: () => items.length,
    add,
    clear() { for (const x of items) if (x.url) URL.revokeObjectURL(x.url); items.length = 0; errors.textContent = ''; draw(); },
    setDisabled(value) { disabled = value; draw(); },
    // Ctrl+V sobre un campo de texto: si el portapapeles trae imágenes, se agregan.
    onPaste(event) {
      const files = [...(event.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
      if (!files.length || disabled) return;
      event.preventDefault();
      add(files);
    },
  };
}

// Sube las capturas elegidas a una consulta y las registra en el mensaje. Devuelve cuántas quedaron sin subir.
export async function uploadAll(ticketId, messageId, picked, call) {
  const done = [];
  let failed = 0;
  let lastError = null;
  for (const item of picked) {
    try {
      const bytes = new Uint8Array(await item.blob.arrayBuffer());
      const up = await api.invoke('support:upload', { ticketId, bytes, name: item.name });
      done.push({ path: up.path, name: up.name || item.name });
    } catch (err) { failed++; lastError = err; }
  }
  if (done.length) {
    try { await call('attach', { ticketId, messageId, files: done }); } catch (err) { failed += done.length; lastError = err; }
  }
  return { failed, error: lastError };
}

// ---------- Ver capturas de una consulta ----------
const cache = new Map();
let chain = Promise.resolve();
// De a una por vez: una consulta con muchas capturas no satura el canal con el proceso principal.
function fetchOne(att) {
  if (cache.has(att.id)) return cache.get(att.id);
  const job = chain.then(() => api.invoke('support:attachment', { attachmentId: att.id }));
  chain = job.catch(() => {});
  const p = job.then((r) => r.dataUrl);
  p.catch(() => cache.delete(att.id));
  cache.set(att.id, p);
  return p;
}

export function openLightbox(att) {
  const body = h('div', { class: 'sp-lightbox' }, loading(S('attachLoading')));
  modal({ title: att.name, icon: 'image', body, size: 'lg' });
  fetchOne(att).then((url) => mount(body, h('img', { src: url, alt: att.name, class: 'sp-lightbox-img' })))
    .catch((err) => mount(body, h('div', { class: 'notice bad', role: 'alert' }, icon('alert'), errMsg(err))));
}

// Miniaturas de las capturas de un mensaje: se cargan solas (las primeras) y se abren en grande con un clic.
export function gallery(attachments, { auto = true, isAlive = () => true } = {}) {
  if (!attachments?.length) return null;
  return h('ul', { class: 'sp-gallery', 'aria-label': S('attachListLabel') }, attachments.map((att, i) => {
    const img = h('img', { alt: '', class: 'sp-thumb-img', hidden: true });
    const placeholder = h('span', { class: 'sp-thumb-ph' }, icon('image'), h('span', { class: 'small' }, S('attachView')));
    const button = h('button', { type: 'button', class: 'sp-thumb', 'aria-label': S('attachOpen', { name: att.name, size: fmtSize(att.size) }), onclick: () => openLightbox(att) }, placeholder, img);
    const load = () => fetchOne(att).then((url) => {
      if (!isAlive()) return;
      img.src = url;
      img.hidden = false;
      placeholder.hidden = true;
    }).catch(() => { if (isAlive()) placeholder.lastChild.textContent = S('attachFailed'); });
    if (auto && i < 6) load();
    else button.addEventListener('click', load, { once: true });
    return h('li', {}, button, h('span', { class: 'sp-thumb-name muted small' }, att.name));
  }));
}

export const warnUpload = (failed, error) => fail(S('attachSomeFailed', { count: failed }), error ? errMsg(error) : '');
