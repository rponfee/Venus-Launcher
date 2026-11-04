// Diálogo "Aspecto de la instancia": color del launcher (planeta o propio), fondo (galería o imagen propia) y música.
// Cada cambio se ve al momento como vista previa; se guarda en venus-instance.json (campo look) solo con Guardar.
// Lo que queda "Como el launcher" sigue a los ajustes globales. Los fondos usan las clases de Apariencia (a11y.css).
import { h, icon, mount, modal, fail, ok, switchEl, selectEl, ensureCss } from '../../ui.js';
import { store, api } from '../../store.js';
import { t, loadNs } from '../../i18n.js';
import { PRESETS, isHex } from '../../a11y/appearance-logic.js';
import { WALLPAPERS } from '../../wallpapers.js';
import { savedLooks, fileUrl } from '../../appearance.js';
import { previewLook, endPreview } from '../instancelook.js';
import { normalizeLook, lookFromSaved } from './logic.js';

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp', 'mp4', 'webm', 'm4v', 'ogv'];
const AUDIO_EXT = ['mp3', 'ogg', 'oga', 'opus', 'wav', 'flac', 'm4a', 'aac', 'weba'];

const baseName = (p) => String(p || '').split(/[\\/]/).pop();

function segmented(label, options, value, onPick) {
  return h(
    'div',
    { class: 'segmented it-seg', role: 'group', 'aria-label': label },
    options.map((o) =>
      h(
        'button',
        { type: 'button', class: value === o.value ? 'active' : '', 'aria-pressed': String(value === o.value), onclick: () => onPick(o.value) },
        o.icon ? icon(o.icon) : null,
        o.label,
      ),
    ),
  );
}

function slider(label, { min, max, value, format, onInput }) {
  const out = h('span', { class: 'kbd num' }, format(value));
  const input = h('input', { type: 'range', class: 'range', min, max, value, 'aria-label': label, 'aria-valuetext': format(value) });
  input.addEventListener('input', () => {
    out.textContent = format(+input.value);
    input.setAttribute('aria-valuetext', format(+input.value));
    onInput(+input.value);
  });
  return h('div', { class: 'stack it-slider' }, h('div', { class: 'row' }, h('span', { class: 'label spacer' }, label), out), input);
}

export async function openLookDialog(inst, { onSaved } = {}) {
  ensureCss('a11y');
  ensureCss('features/instancetools');
  await loadNs('instancetools', 'appearance');
  // Lo que se está editando: null = como el launcher en cada parte.
  const draft = { color: null, background: null, music: null, ...(normalizeLook(inst.look) || {}) };
  const had = Boolean(normalizeLook(inst.look));
  const pct = (n) => `${n}%`;

  const colorBox = h('div', { class: 'it-look-part' });
  const backBox = h('div', { class: 'it-look-part' });
  const musicBox = h('div', { class: 'it-look-part' });
  const live = () => previewLook(normalizeLook(draft));

  function drawColor() {
    const c = draft.color;
    const custom = c?.accent === 'custom' ? c.customColor : '#f29a2e';
    const picker = h('input', { type: 'color', class: 'it-color-input', value: custom, 'aria-label': t('instancetools.lookColorPick') });
    picker.addEventListener('input', () => {
      if (!isHex(picker.value)) return;
      draft.color = { accent: 'custom', customColor: picker.value.toLowerCase() };
      live();
    });
    picker.addEventListener('change', drawColor);
    mount(
      colorBox,
      h('div', { class: 'label' }, t('instancetools.lookColor')),
      h(
        'div',
        { class: 'it-swatches', role: 'group', 'aria-label': t('instancetools.lookColor') },
        h(
          'button',
          { type: 'button', class: ['it-swatch', !c && 'active'], 'aria-pressed': String(!c), onclick: () => ((draft.color = null), drawColor(), live()) },
          h('span', { class: 'it-swatch-dot it-swatch-none', 'aria-hidden': 'true' }),
          t('instancetools.lookSame'),
        ),
        PRESETS.map((p) =>
          h(
            'button',
            { type: 'button', class: ['it-swatch', c?.accent === p.id && 'active'], 'aria-pressed': String(c?.accent === p.id), onclick: () => ((draft.color = { accent: p.id }), drawColor(), live()) },
            h('span', { class: 'it-swatch-dot', style: { background: p.color }, 'aria-hidden': 'true' }),
            t(`appearance.preset_${p.id}`),
          ),
        ),
        h('label', { class: ['it-swatch', 'it-swatch-custom', c?.accent === 'custom' && 'active'] }, h('span', { class: 'it-swatch-dot', style: { background: custom }, 'aria-hidden': 'true' }), t('instancetools.lookColorOwn'), picker),
      ),
    );
  }

  function backgroundShade(bg) {
    if (bg.type === 'stars') return null;
    return h(
      'div',
      { class: 'it-look-shade' },
      slider(t('instancetools.lookDim'), { min: 0, max: 90, value: bg.dim ?? 45, format: pct, onInput: (v) => ((bg.dim = v), live()) }),
      slider(t('instancetools.lookBlur'), { min: 0, max: 24, value: bg.blur ?? 0, format: (n) => `${n} px`, onInput: (v) => ((bg.blur = v), live()) }),
    );
  }

  async function pickImage() {
    const files = await api.app.selectFiles({ title: t('instancetools.lookPickImage'), filters: [{ name: t('instancetools.lookImages'), extensions: IMAGE_EXT }] }).catch(() => []);
    if (!files.length) return;
    draft.background = { type: 'image', file: files[0], dim: draft.background?.dim ?? 45, blur: draft.background?.blur ?? 0 };
    drawBackground();
    live();
  }

  function gallery() {
    const bg = draft.background;
    const list = h(
      'div',
      { class: 'ap-wallpapers it-wallpapers', role: 'group', 'aria-label': t('instancetools.lookGallery') },
      WALLPAPERS.map((w) =>
        h(
          'button',
          {
            type: 'button',
            class: ['ap-wallpaper', bg?.id === w.id && 'active'],
            title: w.name,
            'aria-label': w.name,
            'aria-pressed': String(bg?.id === w.id),
            onclick: () => {
              draft.background = { type: 'wallpaper', id: w.id, dim: bg?.dim ?? 45, blur: bg?.blur ?? 0 };
              drawBackground();
              live();
            },
          },
          h('img', { src: w.thumb || w.src, alt: '', loading: 'lazy', decoding: 'async' }),
          w.video ? h('span', { class: 'ap-wallpaper-live', 'aria-hidden': 'true' }, icon('play'), t('appearance.liveBadge')) : null,
          h('span', { class: 'ap-wallpaper-check', 'aria-hidden': 'true' }, icon('check')),
        ),
      ),
    );
    return list;
  }

  function drawBackground() {
    const bg = draft.background;
    const kind = bg?.type || 'same';
    const pickKind = (v) => {
      if (v === 'same') draft.background = null;
      else if (v === 'stars') draft.background = { type: 'stars' };
      else if (v === 'image') {
        if (bg?.type !== 'image') return pickImage();
      } else if (v === 'wallpaper' && bg?.type !== 'wallpaper') {
        const first = WALLPAPERS.find((w) => !w.video) || WALLPAPERS[0];
        draft.background = first ? { type: 'wallpaper', id: first.id, dim: 45, blur: 0 } : null;
      }
      drawBackground();
      live();
      return undefined;
    };
    mount(
      backBox,
      h('div', { class: 'label' }, t('instancetools.lookBackground')),
      segmented(
        t('instancetools.lookBackground'),
        [
          { value: 'same', label: t('instancetools.lookSame') },
          { value: 'stars', icon: 'sparkles', label: t('instancetools.lookStars') },
          { value: 'wallpaper', icon: 'image', label: t('instancetools.lookGallery') },
          { value: 'image', icon: 'upload', label: t('instancetools.lookOwnImage') },
        ],
        kind,
        pickKind,
      ),
      kind === 'wallpaper' ? gallery() : null,
      kind === 'image'
        ? h('div', { class: 'row wrap it-look-file' }, /\.(mp4|webm|m4v|ogv)$/i.test(bg.file) ? null : h('img', { class: 'it-look-thumb', src: fileUrl(bg.file), alt: '' }), h('span', { class: 'small ellipsis spacer', title: bg.file }, baseName(bg.file)), h('button', { class: 'btn sm', type: 'button', onclick: pickImage }, icon('upload'), t('instancetools.lookChange')))
        : null,
      bg ? backgroundShade(bg) : null,
    );
  }

  async function pickAudio() {
    const files = await api.app.selectFiles({ title: t('instancetools.lookPickAudio'), filters: [{ name: t('instancetools.lookAudio'), extensions: AUDIO_EXT }] }).catch(() => []);
    if (!files.length) return;
    draft.music = { type: 'file', file: files[0], volume: draft.music?.volume ?? 35, pauseInGame: draft.music?.pauseInGame !== false };
    drawMusic();
    live();
  }

  function drawMusic() {
    const m = draft.music;
    const kind = m?.type || 'same';
    const pickKind = (v) => {
      if (v === 'same') draft.music = null;
      else if (v === 'off') draft.music = { type: 'off' };
      else if (m?.type !== 'file') return pickAudio();
      drawMusic();
      live();
      return undefined;
    };
    mount(
      musicBox,
      h('div', { class: 'label' }, t('instancetools.lookMusic')),
      segmented(
        t('instancetools.lookMusic'),
        [
          { value: 'same', label: t('instancetools.lookSame') },
          { value: 'off', icon: 'x', label: t('instancetools.lookMusicOff') },
          { value: 'file', icon: 'upload', label: t('instancetools.lookMusicFile') },
        ],
        kind,
        pickKind,
      ),
      kind === 'file'
        ? h(
            'div',
            { class: 'stack' },
            h('div', { class: 'row wrap it-look-file' }, h('span', { class: 'small ellipsis spacer', title: m.file }, baseName(m.file)), h('button', { class: 'btn sm', type: 'button', onclick: pickAudio }, icon('upload'), t('instancetools.lookChange'))),
            slider(t('instancetools.lookVolume'), { min: 0, max: 100, value: m.volume ?? 35, format: pct, onInput: (v) => ((m.volume = v), live()) }),
            h('div', { class: 'toggle-row' }, h('div', { class: 'tr-text' }, h('div', { class: 'tr-title' }, t('instancetools.lookPauseInGame'))), switchEl(m.pauseInGame !== false, (v) => ((m.pauseInGame = v), live()), t('instancetools.lookPauseInGame'))),
          )
        : null,
    );
  }

  function drawAll() {
    drawColor();
    drawBackground();
    drawMusic();
  }

  const looks = savedLooks().filter(Boolean);
  const fromLook = looks.length
    ? h(
        'div',
        { class: 'field it-look-saved' },
        h('label', { for: 'it-look-from' }, t('instancetools.lookFromSaved')),
        (() => {
          const sel = selectEl(
            [{ value: '', label: t('instancetools.lookFromSavedPick') }, ...looks.map((l) => ({ value: l.id, label: l.name }))],
            '',
            (id) => {
              const look = lookFromSaved(looks.find((l) => l.id === id));
              if (!look) return;
              Object.assign(draft, { color: null, background: null, music: null, ...look });
              drawAll();
              live();
            },
          );
          sel.id = 'it-look-from';
          return sel;
        })(),
      )
    : null;

  const save = async (value) => {
    try {
      const next = await api.instances.update(inst.id, { look: value });
      await store.refreshInstances().catch(() => {});
      ok(t(value ? 'instancetools.lookSaved' : 'instancetools.lookRemoved'), inst.name);
      dialog.close();
      onSaved?.(next);
    } catch (err) {
      fail(t('instancetools.lookSaveFailed'), err);
    }
  };

  const dialog = modal({
    title: t('instancetools.lookTitle'),
    subtitle: inst.name,
    icon: 'palette',
    size: 'wide',
    body: h('div', { class: 'stack it-look' }, h('p', { class: 'small muted it-look-lead' }, t('instancetools.lookLead')), fromLook, colorBox, backBox, musicBox),
    footer: [
      had ? h('button', { class: 'btn ghost', type: 'button', onclick: () => save(null) }, icon('x'), t('instancetools.lookRemove')) : null,
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn ghost', type: 'button', onclick: () => dialog.close() }, t('common.cancel')),
      h('button', { class: 'btn primary', type: 'button', onclick: () => save(normalizeLook(draft)) }, t('common.save')),
    ].filter(Boolean),
    onClose: () => endPreview(),
  });
  drawAll();
  live();
  return dialog;
}
