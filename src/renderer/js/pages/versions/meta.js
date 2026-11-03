// Favoritos, etiquetas, caratulas, tareas pendientes y accesos directos de las instancias: los metadatos de
// venus-instance.json (cover, coverAt, tags, favorite, notes; los valida el proceso principal en
// instances.update) y los canales instancemeta:setCover/removeCover y shortcuts:create. Dialogos de etiquetas
// y de caratula. Lo usan Mis instancias (tarjetas, filas, biblioteca) y la pagina de la instancia.
import { h, icon, mount, modal, ok, fail, toast, registerIcons, emptyState, fmtDate, setBusy } from '../../ui.js';
import { store, api } from '../../store.js';
import { t, locale } from '../../i18n.js';
import { tagsOf, isFavorite, pendingTaskCount, collectTags, instanceLoaderKind } from './catalog.js';
import { fileUrl, loaderMeta, iconButton } from './common.js';

registerIcons({
  vsLibrary: '<path d="m16 6 4 14"/><path d="M12 6v14"/><path d="M8 8v12"/><path d="M4 4v16"/>',
  vsCompare: '<path d="M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h5"/><path d="M14 3h5a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-5"/><path d="M12 2v20"/><path d="m7 9 3 3-3 3"/><path d="m17 9-3 3 3 3"/>',
  vsShortcut: '<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/><path d="m9 10 3-3 3 3"/><path d="M12 7v7"/>',
  vsTasks: '<path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>',
});

export const TAG_MAX = 10;
export const TAG_LEN = 24;
const COVER_EXT = ['png', 'jpg', 'jpeg', 'webp'];
const SHOTS_MAX = 24;

// Filtros de Mis instancias que duran la sesion (el modo de vista si se guarda en los ajustes).
export const listFilters = { favorites: false, tag: null };

export function shortcutsSupported() {
  return store.info?.platform === 'win32';
}

// Error del proceso principal con err.code -> texto propio (versions.<prefix>_<code>); sin codigo, el mensaje tal cual.
export function metaError(err, prefix) {
  const code = typeof err?.code === 'string' ? err.code : '';
  const key = `versions.${prefix}_${code}`;
  const text = code ? t(key) : '';
  return text && text !== key ? text : err?.message || String(err);
}

// ---------- Caratula ----------

export function coverUrl(inst) {
  return inst?.cover && inst?.dir ? fileUrl(`${inst.dir}/${inst.cover}`, inst.coverAt || 0) : null;
}

// Caratula de la instancia: la imagen elegida o la generada (color del loader, letra y, si hay, el icono del modpack).
export function coverEl(inst, cls = '') {
  const meta = loaderMeta(instanceLoaderKind(inst));
  const letter = (inst?.name || meta.letter).trim().charAt(0).toUpperCase() || meta.letter;
  const generated = () => {
    const el = h('div', { class: ['vs-cover', 'vs-cover-gen', cls], 'aria-hidden': 'true', style: { '--c': meta.color } }, h('span', { class: 'vs-cover-letter' }, letter));
    if (inst?.icon && /^https?:\/\//.test(inst.icon)) {
      const img = h('img', { class: 'vs-cover-icon', src: inst.icon, alt: '', loading: 'lazy', decoding: 'async' });
      img.addEventListener('error', () => img.remove(), { once: true });
      el.append(img);
    }
    return el;
  };
  const url = coverUrl(inst);
  if (!url) return generated();
  const img = h('img', { src: url, alt: '', loading: 'lazy', decoding: 'async' });
  const box = h('div', { class: ['vs-cover', cls], 'aria-hidden': 'true' }, img);
  img.addEventListener('error', () => box.replaceWith(generated()), { once: true });
  return box;
}

// ---------- Favoritos ----------

export async function toggleFavorite(inst) {
  const next = !isFavorite(inst);
  try {
    const updated = await api.instances.update(inst.id, { favorite: next });
    await store.refreshInstances();
    return updated;
  } catch (err) {
    fail(t('versions.favoriteFailed'), err);
    return null;
  }
}

export function favoriteButton(inst, { cls = '', onChange } = {}) {
  const on = isFavorite(inst);
  const label = on ? t('versions.unfavoriteOf', { name: inst.name }) : t('versions.favoriteOf', { name: inst.name });
  const btn = iconButton(
    'star',
    label,
    async (e) => {
      e.stopPropagation();
      const free = setBusy(btn);
      const updated = await toggleFavorite(inst);
      free();
      if (updated && onChange) onChange(updated);
    },
    `vs-star ${on ? 'on' : ''} ${cls}`,
  );
  btn.setAttribute('aria-pressed', String(on));
  btn.dataset.fk = `fav:${inst.id}`;
  return btn;
}

// ---------- Etiquetas ----------

// Chips de etiquetas (hasta `max`, el resto como "+N"). onPick(tag): filtrar por esa etiqueta; editable: boton "+".
export function tagChips(inst, { max = 3, onPick, editable = false, onChange } = {}) {
  const tags = tagsOf(inst);
  if (!tags.length && !editable) return null;
  const shown = tags.slice(0, max);
  const rest = tags.length - shown.length;
  return h(
    'div',
    { class: 'vs-tags', role: onPick ? 'group' : null, 'aria-label': t('versions.tags') },
    shown.map((tag) =>
      onPick
        ? h(
            'button',
            {
              type: 'button',
              class: 'vs-tag',
              title: t('versions.tagFilterBy', { tag }),
              onclick: (e) => {
                e.stopPropagation();
                onPick(tag);
              },
            },
            icon('tag'),
            tag,
          )
        : h('span', { class: 'vs-tag', title: tag }, icon('tag'), tag),
    ),
    rest > 0 ? h('span', { class: 'vs-tag vs-tag-more', title: tags.slice(max).join(', ') }, t('versions.moreTags', { count: rest })) : null,
    editable
      ? h(
          'button',
          {
            type: 'button',
            class: 'vs-tag vs-tag-add',
            title: t('versions.editTags'),
            'aria-label': t('versions.editTags'),
            onclick: (e) => {
              e.stopPropagation();
              openTagsDialog(inst, { onSaved: onChange });
            },
          },
          icon(tags.length ? 'edit' : 'plus'),
          tags.length ? null : t('versions.tags'),
        )
      : null,
  );
}

function cleanTag(raw) {
  return String(raw || '')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function openTagsDialog(inst, { onSaved } = {}) {
  let tags = [...tagsOf(inst)];
  const has = (tag) => tags.some((x) => x.toLowerCase() === tag.toLowerCase());
  const chipsBox = h('div', { class: 'chips vs-tagedit-chips', 'aria-label': t('versions.tags') });
  const suggestBox = h('div', { class: 'vs-tagedit-suggest' });
  const counter = h('span', { class: 'tiny muted num' });
  const input = h('input', { class: 'input', type: 'text', maxlength: String(TAG_LEN), placeholder: t('versions.tagPlaceholder'), 'aria-label': t('versions.tagPlaceholder'), autocomplete: 'off', spellcheck: 'false' });
  const addBtn = h('button', { class: 'btn sm', type: 'button', onclick: () => add(input.value) }, icon('plus'), t('versions.tagAdd'));
  const suggestions = collectTags(store.instances, locale()).map((x) => x.tag);

  function add(raw) {
    const parts = String(raw || '')
      .split(',')
      .map(cleanTag)
      .filter(Boolean);
    let full = false;
    for (const tag of parts) {
      if (Array.from(tag).length > TAG_LEN || has(tag)) continue;
      if (tags.length >= TAG_MAX) {
        full = true;
        break;
      }
      tags.push(tag);
    }
    input.value = '';
    if (full) toast('info', t('versions.tagsFull'), null, 3000);
    draw();
    input.focus();
  }

  function remove(tag) {
    tags = tags.filter((x) => x !== tag);
    draw();
    input.focus();
  }

  function draw() {
    const full = tags.length >= TAG_MAX;
    mount(
      chipsBox,
      tags.length
        ? tags.map((tag) =>
            h(
              'span',
              { class: 'chip active vs-tagedit-chip' },
              icon('tag'),
              h('span', { class: 'ellipsis' }, tag),
              h('button', { type: 'button', class: 'vs-tagedit-x', title: t('versions.tagRemove', { tag }), 'aria-label': t('versions.tagRemove', { tag }), onclick: () => remove(tag) }, icon('x')),
            ),
          )
        : h('span', { class: 'small muted' }, t('versions.tagsNone')),
    );
    mount(counter, t('versions.tagsCount', { count: tags.length, max: TAG_MAX }));
    input.disabled = full;
    addBtn.disabled = full;
    const free = suggestions.filter((tag) => !has(tag));
    mount(
      suggestBox,
      free.length && !full
        ? [h('span', { class: 'tiny muted' }, t('versions.tagsSuggest')), h('div', { class: 'chips' }, free.slice(0, 12).map((tag) => h('button', { type: 'button', class: 'chip', onclick: () => add(tag) }, icon('plus'), tag)))]
        : null,
    );
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      add(input.value);
    } else if (e.key === 'Backspace' && !input.value && tags.length) {
      e.preventDefault();
      remove(tags[tags.length - 1]);
    }
  });

  const saveBtn = h(
    'button',
    {
      class: 'btn primary',
      type: 'button',
      onclick: async () => {
        if (input.value.trim()) add(input.value);
        const free = setBusy(saveBtn);
        try {
          const next = await api.instances.update(inst.id, { tags });
          await store.refreshInstances();
          ok(t('versions.tagsSaved'), next.tags?.length ? next.tags.join(', ') : null);
          m.close();
          if (onSaved) onSaved(next);
        } catch (err) {
          fail(t('versions.tagsFailed'), err);
        } finally {
          free();
        }
      },
    },
    icon('check'),
    t('instance.save'),
  );
  const m = modal({
    title: t('versions.tagsTitle'),
    subtitle: inst.name,
    icon: 'tag',
    body: h(
      'div',
      { class: 'stack vs-tagedit' },
      chipsBox,
      h('div', { class: 'row vs-tagedit-row' }, input, addBtn),
      h('div', { class: 'row between' }, h('span', { class: 'hint field-help' }, t('versions.tagsHint')), counter),
      suggestBox,
    ),
    footer: [h('button', { class: 'btn ghost', type: 'button', onclick: () => m.close() }, t('common.cancel')), saveBtn],
  });
  draw();
  setTimeout(() => input.focus(), 30);
  return m;
}

// ---------- Tareas pendientes ----------

export function pendingBadge(inst) {
  const n = pendingTaskCount(inst);
  if (!n) return null;
  const label = t('versions.pendingTasks', { count: n });
  return h('span', { class: 'badge vs-todo', title: label, 'aria-label': label }, icon('vsTasks'), String(n));
}

// ---------- Caratula: dialogo ----------

// Una imagen WebP la decodifica la interfaz (nativeImage no lee WebP): el proceso principal manda los bytes
// como data: y aca se pasa a PNG de hasta 1280 px de ancho; el recorte y la reduccion final los hace el principal.
async function decodeToPng(file) {
  const { dataUrl } = await api.invoke('instancemeta:readImage', file);
  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = () => reject(Object.assign(new Error('badImage'), { code: 'badImage' }));
    img.src = dataUrl;
  });
  const scale = Math.min(1, 1280 / Math.max(1, img.naturalWidth));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png');
}

export async function pickCoverFile(inst) {
  const files = await api.app.selectFiles({ title: t('versions.coverPickTitle'), filters: [{ name: t('versions.coverFilter'), extensions: COVER_EXT }] });
  const file = files?.[0];
  if (!file) return null;
  if (/\.webp$/i.test(file)) return applyCover(inst, { dataUrl: await decodeToPng(file) });
  return applyCover(inst, { file });
}

export async function applyCover(inst, opts) {
  try {
    const next = await api.invoke('instancemeta:setCover', inst.id, opts);
    ok(t('versions.coverSet'), inst.name);
    await store.refreshInstances();
    return next;
  } catch (err) {
    fail(t('versions.coverFailed'), metaError(err, 'coverErr'));
    return null;
  }
}

export async function removeCover(inst) {
  try {
    const next = await api.invoke('instancemeta:removeCover', inst.id);
    ok(t('versions.coverRemoved'), inst.name);
    await store.refreshInstances();
    return next;
  } catch (err) {
    fail(t('versions.coverFailed'), metaError(err, 'coverErr'));
    return null;
  }
}

// Miniaturas de capturas (modulo worlds); si el canal no esta, el archivo entero.
async function thumbsFor(shots) {
  let map = {};
  try {
    map = (await api.invoke('worlds:thumbs', shots.map((s) => s.path))) || {};
  } catch {
    map = {};
  }
  return shots.map((s) => map[s.path] || fileUrl(s.path, Math.round(s.mtime || 0)));
}

export function openCoverDialog(inst, { onChanged } = {}) {
  let current = inst;
  let alive = true;
  const preview = h('div', { class: 'vs-coverdlg-preview' });
  const status = h('div', { class: 'small muted' });
  const shotsBox = h('div', { class: 'vs-coverdlg-shots' });
  const removeBtn = h('button', { class: 'btn sm', type: 'button' }, icon('x'), t('versions.coverRemove'));
  const pickBtn = h('button', { class: 'btn sm primary', type: 'button' }, icon('upload'), t('versions.coverPick'));

  const changed = async (next) => {
    if (!next) return;
    current = next;
    if (onChanged) onChanged(next);
    drawPreview();
  };
  const busy = async (btn, fn) => {
    const free = setBusy(btn);
    try {
      await changed(await fn());
    } finally {
      free();
    }
  };
  pickBtn.addEventListener('click', () => busy(pickBtn, () => pickCoverFile(current)));
  removeBtn.addEventListener('click', () => busy(removeBtn, () => removeCover(current)));

  function drawPreview() {
    mount(preview, coverEl(current, 'vs-coverdlg-img'));
    mount(status, current.cover ? t('versions.coverCurrent') : t('versions.coverGenerated'));
    removeBtn.hidden = !current.cover;
  }

  async function loadShots() {
    mount(shotsBox, h('div', { class: 'skeleton-group', role: 'status', 'aria-live': 'polite', 'aria-busy': 'true' }, h('span', { class: 'sr-only' }, t('common.loading')), h('div', { class: 'skeleton-shapes vs-coverdlg-shots', 'aria-hidden': 'true' }, Array.from({ length: 6 }, () => h('span', { class: 'skeleton' })))));
    let shots = [];
    try {
      shots = (await api.instances.content(inst.id, 'screenshots')).slice(0, SHOTS_MAX);
    } catch {
      shots = [];
    }
    if (!alive) return;
    if (!shots.length) {
      mount(shotsBox, h('div', { class: 'vs-coverdlg-empty' }, emptyState('camera', t('versions.coverNoShots'), t('instance.screenshotHint'))));
      return;
    }
    const urls = await thumbsFor(shots);
    if (!alive) return;
    mount(
      shotsBox,
      shots.map((s, i) => {
        const date = fmtDate(s.mtime, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
        const btn = h(
          'button',
          { class: 'vs-coverdlg-shot', type: 'button', title: t('versions.coverUseShot', { date }), 'aria-label': t('versions.coverUseShot', { date }) },
          h('img', { src: urls[i], alt: '', loading: 'lazy', decoding: 'async' }),
          h('span', { class: 'vs-coverdlg-shot-date' }, date),
        );
        btn.addEventListener('click', () => busy(btn, () => applyCover(current, { screenshot: s.path })));
        return btn;
      }),
    );
  }

  const m = modal({
    title: t('versions.coverTitle'),
    subtitle: inst.name,
    icon: 'image',
    size: 'wide',
    body: h(
      'div',
      { class: 'vs-coverdlg' },
      h('div', { class: 'vs-coverdlg-side' }, preview, status, h('div', { class: 'row wrap' }, pickBtn, removeBtn), h('div', { class: 'hint field-help' }, t('versions.coverHint'))),
      h('div', { class: 'vs-coverdlg-main' }, h('div', { class: 'label' }, t('versions.coverShots')), shotsBox),
    ),
    footer: [h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, t('common.close'))],
    onClose: () => {
      alive = false;
    },
  });
  drawPreview();
  loadShots();
  return m;
}

// ---------- Acceso directo en el escritorio ----------

export async function createShortcut(inst) {
  if (!shortcutsSupported()) {
    toast('info', t('versions.shortcutFailed'), t('versions.shortcutErr_unsupported'), 6000);
    return null;
  }
  try {
    const r = await api.invoke('shortcuts:create', inst.id);
    ok(t('versions.shortcutCreated'), t('versions.shortcutCreatedText', { name: r?.name || inst.name }));
    return r;
  } catch (err) {
    fail(t('versions.shortcutFailed'), metaError(err, 'shortcutErr'));
    return null;
  }
}
