// Personalización del emblema local; el nivel siempre lo proporciona Venus Pass.
import { h, icon, mount, modal, selectEl, setBusy, ok } from '../../ui.js';
import { store } from '../../store.js';
import { t } from '../../i18n.js';
import { levelBadge } from '../../features/cosmic-art.js';
import { PLANETS, FRAMES, DEFAULT_APPEARANCE, normalizeAppearance, readableNumber } from '../../features/cosmic-art/logic.js';
const P = (key) => t(`pass.${key}`);

export function openAppearance(level) {
  let draft = normalizeAppearance(store.settings?.passAppearance);
  let alive = true;
  let pending = false;
  const preview = h('div', { class: 'ps-appearance-preview', 'aria-live': 'polite' });
  const planets = h('div', { class: 'ps-planet-options', role: 'group', 'aria-label': P('appearancePlanet') });
  const accent = h('input', { type: 'color', class: 'ps-appearance-color', id: 'ps-accent', value: draft.accent });
  const number = h('input', { type: 'color', class: 'ps-appearance-color', id: 'ps-number', value: draft.number });
  const frames = selectEl(FRAMES.map((value) => ({ value, label: P(`frame_${value}`) })), draft.frame, (value) => { draft.frame = value; paint(); });
  frames.id = 'ps-frame';
  const contrast = h('p', { class: 'field-error', role: 'status', hidden: true }, P('appearanceContrast'));
  const error = h('p', { class: 'field-error', role: 'alert', hidden: true });
  const save = h('button', { type: 'button', class: 'btn primary' }, icon('save'), P('appearanceSave'));
  const reset = h('button', { type: 'button', class: 'btn ghost', onclick: () => {
    if (pending) return;
    draft = { ...DEFAULT_APPEARANCE }; accent.value = draft.accent; number.value = draft.number; frames.value = draft.frame; paint();
  } }, icon('refresh'), P('appearanceReset'));
  const cancel = h('button', { type: 'button', class: 'btn ghost' }, P('appearanceCancel'));
  const field = (id, label, input) => h('div', { class: 'field' }, h('label', { for: id }, P(label)), input);
  const m = modal({
    title: P('customizeTitle'), icon: 'palette', subtitle: P('customizeHint'), size: 'lg',
    body: h('div', { class: 'ps-appearance' }, preview, h('div', { class: 'ps-appearance-fields' },
      h('div', { class: 'field' }, h('span', { class: 'label' }, P('appearancePlanet')), planets),
      field('ps-frame', 'appearanceFrame', frames), field('ps-accent', 'appearanceAccent', accent),
      field('ps-number', 'appearanceNumber', number), contrast, error)),
    footer: [reset, cancel, save], onClose: () => { alive = false; },
  });
  m.el.classList.add('ps-appearance-dialog');
  function paint() {
    if (!alive) return;
    mount(preview, levelBadge(level, draft, { label: P('level') }));
    mount(planets, PLANETS.map((planet) => h('button', {
      type: 'button', class: 'ps-planet-option', 'aria-pressed': String(draft.planet === planet), disabled: pending,
      onclick: () => { if (pending) return; draft.planet = planet; paint(); },
    }, h('img', { src: new URL(`../../../assets/venus/planet-${planet}.png`, import.meta.url).href, alt: '', 'aria-hidden': 'true' }), P(`planet_${planet}`))));
    contrast.hidden = readableNumber(draft.number);
    save.disabled = pending || !contrast.hidden;
  }
  accent.addEventListener('input', () => { draft.accent = accent.value; paint(); });
  number.addEventListener('input', () => { draft.number = number.value; paint(); });
  cancel.addEventListener('click', () => m.close());
  save.addEventListener('click', async () => {
    if (pending || !alive || !readableNumber(draft.number)) return;
    pending = true; error.hidden = true;
    const done = setBusy(save);
    for (const input of [accent, number, frames, reset]) input.disabled = true;
    paint();
    try {
      await store.setSettings({ passAppearance: normalizeAppearance(draft) });
      if (alive) { ok(P('appearanceSaved')); m.close(); }
    } catch {
      if (alive) { error.textContent = P('appearanceSaveFailed'); error.hidden = false; }
    } finally {
      pending = false; done();
      if (alive) { for (const input of [accent, number, frames, reset]) input.disabled = false; paint(); }
    }
  });
  paint();
  return m;
}
