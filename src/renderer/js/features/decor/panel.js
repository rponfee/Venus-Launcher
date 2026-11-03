// Tarjeta "Decoración" de Ajustes > Apariencia (debajo de "Interfaz"): partículas, sonidos, pantalla de inicio
// y cursor. Mismo armado que las tarjetas de appearance.js (card, toggleRow, rangeField, segmentados).
// Contrato: decorCard(ctx) -> Element, con ctx = { get, save, onChange, season, previewSplash, previewSound }.
import { h, icon, switchEl, registerIcons, reducedMotion } from '../../ui.js';
import { t } from '../../i18n.js';
import { PARTICLE_KINDS, DENSITIES, SOUND_PACKS, SPLASH_STYLES, CURSORS, SPLASH_TEXT_MAX, resolveParticles } from './settings.js';
import { SOUND_IDS } from './packs.js';
import { cursorDataUrl } from './cursors.js';

registerIcons({
  snowflake: '<line x1="2" x2="22" y1="12" y2="12"/><line x1="12" x2="12" y1="2" y2="22"/><path d="m20 16-4-4 4-4"/><path d="m4 8 4 4-4 4"/><path d="m16 4-4 4-4-4"/><path d="m8 20 4-4 4 4"/>',
  droplets: '<path d="M7 16.3c2.2 0 4-1.83 4-4.05 0-1.16-.57-2.26-1.71-3.19S7.29 6.75 7 5.3c-.29 1.45-1.14 2.84-2.29 3.76S3 11.1 3 12.25c0 2.22 1.8 4.05 4 4.05z"/><path d="M12.56 6.6A10.97 10.97 0 0 0 14 3.02c.5 2.5 2 4.9 4 6.5s3 3.5 3 5.5a6.98 6.98 0 0 1-11.91 4.97"/>',
  leaf: '<path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z"/><path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"/>',
  mousePointer: '<path d="M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z"/>',
  minus: '<path d="M5 12h14"/>',
});

const PARTICLE_ICON = { none: 'ban', snow: 'snowflake', rain: 'droplets', leaves: 'leaf', embers: 'flame', stars: 'sparkles' };
const PACK_ICON = { soft: 'moon', pixel: 'gamepad', space: 'rocket' };
const SPLASH_ICON = { logo: 'image', text: 'type', minimal: 'minus' };

let fieldSeq = 0;
const fieldId = (name) => `dc-${name}-${++fieldSeq}`;

function card(iconName, title, sub) {
  return h(
    'section',
    { class: 'card ax-card dc-card' },
    h('div', { class: 'ax-card-head' }, h('span', { class: 'ax-card-icon' }, icon(iconName)), h('div', {}, h('h3', { class: 'ax-card-title' }, title), sub ? h('p', { class: 'ax-card-sub' }, sub) : null)),
  );
}

function section(iconName, title, sub, ...children) {
  return h('div', { class: 'dc-section' }, h('div', { class: 'dc-section-head' }, h('div', { class: 'dc-section-title' }, icon(iconName), title), sub ? h('div', { class: 'dc-section-sub' }, sub) : null), ...children);
}

function toggleRow(title, sub, checked, onChangeFn) {
  const sw = switchEl(checked, onChangeFn, title);
  const input = sw.querySelector('input');
  return {
    el: h('div', { class: 'toggle-row' }, h('div', { class: 'tr-text' }, h('div', { class: 'tr-title' }, title), sub ? h('div', { class: 'tr-sub' }, sub) : null), sw),
    set: (v) => {
      input.checked = Boolean(v);
    },
  };
}

function rangeField(label, { min, max, step, value, format, onInput }) {
  const id = fieldId('range');
  const input = h('input', { type: 'range', class: 'range', id, min, max, step, value, 'aria-label': label });
  const out = h('span', { class: 'ax-value', 'aria-hidden': 'true' }, format(value));
  input.addEventListener('input', () => {
    out.textContent = format(Number(input.value));
    input.setAttribute('aria-valuetext', format(Number(input.value)));
    onInput(Number(input.value));
  });
  input.setAttribute('aria-valuetext', format(value));
  const el = h('div', { class: 'ax-field' }, h('div', { class: 'ax-field-head' }, h('label', { class: 'label', for: id }, label), out), input);
  return {
    el,
    set(v) {
      if (document.activeElement !== input) input.value = v;
      out.textContent = format(v);
      input.setAttribute('aria-valuetext', format(v));
    },
  };
}

// Grupo de opciones (role radiogroup): clic o flechas eligen; solo la elegida entra en el orden de Tab.
function segmented({ label, options, get, set }) {
  const seg = h('div', { class: 'segmented dc-seg', role: 'radiogroup', 'aria-label': label });
  const btns = options.map((o) =>
    h(
      'button',
      { type: 'button', role: 'radio', title: o.label, dataset: { value: o.value }, onclick: () => set(o.value) },
      o.img ? h('img', { src: o.img, alt: '', width: 18, height: 18 }) : o.icon ? icon(o.icon) : null,
      o.label,
    ),
  );
  seg.append(...btns);
  seg.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return;
    const i = btns.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    const d = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1;
    const n = e.key === 'Home' ? 0 : e.key === 'End' ? btns.length - 1 : (i + d + btns.length) % btns.length;
    btns[n].focus();
    set(options[n].value);
  });
  const sync = () => {
    const v = get();
    btns.forEach((b) => {
      const on = b.dataset.value === v;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    });
  };
  sync();
  return { el: seg, sync };
}

const labeled = (label, el) => h('div', { class: 'dc-row' }, h('span', { class: 'dc-row-label' }, label), el);

export function decorCard(ctx) {
  const d = () => ctx.get();
  const root = card('sparkles', t('decor.title'), t('decor.sub'));

  // --- Partículas ---
  const partSeg = segmented({
    label: t('decor.particlesChoose'),
    options: PARTICLE_KINDS.map((k) => ({ value: k, label: t(`decor.particles_${k}`), icon: PARTICLE_ICON[k] })),
    get: () => d().particles,
    set: (v) => ctx.save({ particles: v }),
  });
  const densSeg = segmented({
    label: t('decor.density'),
    options: DENSITIES.map((k) => ({ value: k, label: t(`decor.density_${k}`) })),
    get: () => d().density,
    set: (v) => ctx.save({ density: v }),
  });
  const seasonal = toggleRow(t('decor.seasonal'), t('decor.seasonalSub'), d().seasonalParticles, (v) => ctx.save({ seasonalParticles: v }));
  const seasonText = h('span');
  const seasonNote = h('div', { class: 'dc-note', role: 'status' }, icon('info'), seasonText);
  const motionNote = h('div', { class: 'ax-hint' }, icon('info'), t('decor.motionOff'));
  const partSection = section('sparkles', t('decor.particles'), t('decor.particlesSub'), partSeg.el, labeled(t('decor.density'), densSeg.el), seasonNote, motionNote, h('div', { class: 'ax-toggles' }, seasonal.el));

  // --- Sonidos ---
  const soundsToggle = toggleRow(t('decor.soundsEnable'), t('decor.soundsEnableSub'), d().sounds.enabled, (v) => ctx.save({ sounds: { enabled: v } }));
  const packSeg = segmented({
    label: t('decor.pack'),
    options: SOUND_PACKS.map((p) => ({ value: p, label: t(`decor.pack_${p}`), icon: PACK_ICON[p] })),
    get: () => d().sounds.pack,
    set: (v) => {
      ctx.save({ sounds: { pack: v } });
      ctx.previewSound(v, 'open');
    },
  });
  packSeg.el.setAttribute('data-dc-silent', '');
  const volume = rangeField(t('decor.volume'), { min: 0, max: 100, step: 5, value: d().sounds.volume, format: (v) => t('decor.percent', { value: v }), onInput: (v) => ctx.save({ sounds: { volume: v } }, 300) });
  const testRow = h(
    'div',
    { class: 'dc-test-row', 'data-dc-silent': '', role: 'group', 'aria-label': t('decor.test') },
    SOUND_IDS.map((id) => h('button', { type: 'button', class: 'btn sm ghost', title: t('decor.test'), onclick: () => ctx.previewSound(d().sounds.pack, id) }, icon('play'), t(`decor.sound_${id}`))),
  );
  const soundSection = section('volume', t('decor.sounds'), t('decor.soundsSub'), h('div', { class: 'ax-toggles' }, soundsToggle.el), labeled(t('decor.pack'), packSeg.el), volume.el, testRow);

  // --- Pantalla de inicio ---
  const splashToggle = toggleRow(t('decor.splashEnable'), t('decor.splashEnableSub'), d().splash.enabled, (v) => ctx.save({ splash: { enabled: v } }));
  const styleSeg = segmented({
    label: t('decor.splashStyle'),
    options: SPLASH_STYLES.map((s) => ({ value: s, label: t(`decor.splash_${s}`), icon: SPLASH_ICON[s] })),
    get: () => d().splash.style,
    set: (v) => ctx.save({ splash: { style: v } }),
  });
  const textId = fieldId('splash-text');
  const textInput = h('input', { class: 'input', id: textId, maxlength: SPLASH_TEXT_MAX, placeholder: t('decor.splashTextPlaceholder'), value: d().splash.text, autocomplete: 'off', spellcheck: 'false' });
  textInput.addEventListener('input', () => ctx.save({ splash: { text: textInput.value } }, 500));
  const textField = h('div', { class: 'ax-field dc-splash-field' }, h('label', { class: 'label', for: textId }, t('decor.splashText')), textInput, h('div', { class: 'ax-hint' }, t('decor.splashTextHint', { max: SPLASH_TEXT_MAX })));
  const previewBtn = h('button', { type: 'button', class: 'btn sm', 'data-dc-splash-preview': '', onclick: () => ctx.previewSplash() }, icon('play'), t('decor.splashPreview'));
  const splashSection = section('monitor', t('decor.splash'), t('decor.splashSub'), h('div', { class: 'ax-toggles' }, splashToggle.el), labeled(t('decor.splashStyle'), styleSeg.el), textField, h('div', { class: 'row wrap' }, previewBtn));

  // --- Cursor ---
  const cursorSeg = segmented({
    label: t('decor.cursorChoose'),
    options: CURSORS.map((id) => ({ value: id, label: t(`decor.cursor_${id}`), icon: id === 'default' ? 'mousePointer' : null, img: id === 'default' ? null : cursorDataUrl(id, 'normal') })),
    get: () => d().cursor,
    set: (v) => ctx.save({ cursor: v }),
  });
  const cursorSection = section('mousePointer', t('decor.cursor'), t('decor.cursorSub'), cursorSeg.el);

  const divider = () => h('div', { class: 'dc-divider', 'aria-hidden': 'true' });
  root.append(partSection, divider(), soundSection, divider(), splashSection, divider(), cursorSection);

  const sync = () => {
    const cur = d();
    partSeg.sync();
    densSeg.sync();
    seasonal.set(cur.seasonalParticles);
    const res = resolveParticles(cur, ctx.season());
    seasonNote.hidden = !res.seasonal;
    if (res.seasonal) {
      seasonText.textContent = t('decor.seasonNow', {
        season: t(`decor.season_${res.season}`),
        kind: t(`decor.particles_${res.kind}`).toLowerCase(),
        choice: t(`decor.particles_${res.choice}`).toLowerCase(),
      });
    }
    motionNote.hidden = res.kind === 'none' || !reducedMotion();
    soundsToggle.set(cur.sounds.enabled);
    packSeg.sync();
    volume.set(cur.sounds.volume);
    splashToggle.set(cur.splash.enabled);
    styleSeg.sync();
    textField.hidden = cur.splash.style !== 'text';
    if (document.activeElement !== textInput) textInput.value = cur.splash.text;
    cursorSeg.sync();
  };
  sync();

  // Se sincroniza mientras está en pantalla y se desuscribe sola al salir del documento.
  let wasConnected = false;
  const offs = [];
  root.destroy = () => offs.splice(0).forEach((off) => off());
  offs.push(
    ctx.onChange(() => {
      if (root.isConnected) {
        wasConnected = true;
        sync();
      } else if (wasConnected) root.destroy();
    }),
  );
  return root;
}
