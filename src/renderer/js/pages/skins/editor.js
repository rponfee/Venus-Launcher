// Editor de skins (página Skins): skins de 64x64 con modelo clásico o slim. Lápiz, goma, balde, cuentagotas,
// espejo izquierda/derecha, capa base y exterior (ver u ocultar y elegir cuál se edita), paleta y selector de
// color, zoom, deshacer/rehacer (Ctrl+Z / Ctrl+Y), plantilla con las zonas marcadas y vista 3D en vivo con el
// visor de la página (viewer.js). Empieza en blanco o desde una skin de la biblioteca y guarda una skin nueva
// en la biblioteca con los canales que ya existen: skins:addData (bytes del PNG, nunca rutas) + skins:setVariant.
// Al guardar avisa el logro 'skin_created' (evento venus:achievement, contrato 3; rewards lo reclama una vez).
// Contrato: openSkinEditor({ libraryId?, start?: { image: 'data:image/png;base64,...', variant, name },
//           onSaved?(resultado de skins:addData) }) -> Promise. Preferencias en settings.skineditor.
// Lógica pura (zonas, espejo, balde, historial) en editor/logic.js; el dibujo del lienzo en editor/canvas.js.
import { h, icon, mount, modal, toast, ok, fail, setBusy, confirmDialog, ensureCss, registerIcons, skeleton, emptyState } from '../../ui.js';
import { api, store } from '../../store.js';
import { t, loadNs } from '../../i18n.js';
import { keyLabel } from '../../platform.js';
import { createViewer } from './viewer.js';
import { loadImage, normalizeSkin } from './texture.js';
import { skinThumb } from './parts.js';
import * as L from './editor/logic.js';
import { drawCanvas, readColors, texelAt, LEGEND } from './editor/canvas.js';

registerIcons({
  seBrush: '<path d="m14.622 17.897-10.68-2.913"/><path d="M18.376 2.622a1 1 0 1 1 3.002 3.002L17.36 9.643a.5.5 0 0 0 0 .707l.944.944a2.41 2.41 0 0 1 0 3.408l-.944.944a.5.5 0 0 1-.707 0L8.354 7.348a.5.5 0 0 1 0-.707l.944-.944a2.41 2.41 0 0 1 3.408 0l.944.944a.5.5 0 0 0 .707 0z"/><path d="M9 8c-1.804 2.71-3.97 3.46-6.583 3.948a.507.507 0 0 0-.302.819l7.32 8.883a1 1 0 0 0 1.185.204C12.735 20.405 16 16.792 16 15"/>',
  seEraser: '<path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/>',
  seBucket: '<path d="m19 11-8-8-8.6 8.6a2 2 0 0 0 0 2.8l5.2 5.2c.8.8 2 .8 2.8 0L19 11Z"/><path d="m5 2 5 5"/><path d="M2 13h15"/><path d="M22 20a2 2 0 1 1-4 0c0-1.6 1.7-2.4 2-4 .3 1.6 2 2.4 2 4Z"/>',
  sePipette: '<path d="m2 22 1-1h3l9-9"/><path d="M3 21v-3l9-9"/><path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z"/>',
  seMirror: '<path d="m3 7 5 5-5 5V7"/><path d="m21 7-5 5 5 5V7"/><path d="M12 20v2"/><path d="M12 14v2"/><path d="M12 8v2"/><path d="M12 2v2"/>',
  seRedo: '<path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3l3 2.7"/>',
  seGrid: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/><path d="M9 3v18"/><path d="M15 3v18"/>',
  seTemplate: '<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>',
});

const TOOLS = [
  { id: 'pencil', icon: 'edit', key: 'B' },
  { id: 'eraser', icon: 'seEraser', key: 'E' },
  { id: 'bucket', icon: 'seBucket', key: 'G' },
  { id: 'picker', icon: 'sePipette', key: 'I' },
];
const ZOOM_MIN = 2;
const ZOOM_MAX = 24;
const NAME_MAX = 40;
const PREFS = { recent: [], grid: true, template: true, mirror: false };

let open = null; // editor abierto (uno por vez)

function prefs() {
  const raw = store.settings?.skineditor;
  const p = raw && typeof raw === 'object' ? raw : {};
  return { ...PREFS, ...p, recent: Array.isArray(p.recent) ? p.recent.filter((c) => /^#[0-9a-f]{6}$/.test(c)).slice(0, 10) : [] };
}

function cleanName(raw) {
  return Array.from(String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim()).slice(0, NAME_MAX).join('').trim();
}

// Pixeles de una skin (data: PNG) ya normalizada como la muestra el juego (las de 64x32 pasan a 64x64).
async function pixelsOf(dataUrl) {
  const { canvas, legacy } = normalizeSkin(await loadImage(dataUrl));
  return { px: new Uint8ClampedArray(canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, L.SIZE, L.SIZE).data), legacy };
}

async function pngBytes(px) {
  const c = document.createElement('canvas');
  c.width = L.SIZE;
  c.height = L.SIZE;
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(px), L.SIZE, L.SIZE), 0, 0);
  const blob = await new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error(t('skineditor.pngFailed')))), 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

export async function openSkinEditor(opts = {}) {
  if (open) {
    open.focus();
    return open;
  }
  ensureCss('pages/skins');
  ensureCss('pages/skin-editor');
  await loadNs('skins', 'skineditor');
  if (open) return open;
  open = buildEditor(opts);
  return open;
}

function buildEditor({ libraryId = null, start = null, onSaved = null } = {}) {
  const p = prefs();
  const S = {
    px: L.blankSkin('classic'),
    variant: 'classic',
    cleanPx: null,
    cleanVariant: 'classic',
    tool: 'pencil',
    lastPaintTool: 'pencil',
    color: [217, 164, 65, 255],
    mirror: Boolean(p.mirror),
    layer: 'base',
    show: { base: true, outer: true },
    zoom: 8,
    fit: true,
    grid: p.grid !== false,
    template: p.template !== false,
    recent: p.recent,
    hover: null,
    cursor: null,
    focused: false,
    history: L.createHistory({ limit: 100 }),
    sourceName: '',
    saving: false,
    closed: false,
    prefsDirty: false,
  };
  S.cleanPx = new Uint8ClampedArray(S.px);
  let colors = readColors();
  const uid = `se-${Date.now().toString(36)}`;

  // ---------- Barra de herramientas ----------
  const toolBtns = TOOLS.map((tool) =>
    h('button', { type: 'button', class: 'icon-btn se-tool', role: 'radio', 'aria-checked': 'false', dataset: { tool: tool.id }, title: t('skineditor.toolTip', { name: t(`skineditor.tool_${tool.id}`), key: tool.key }), 'aria-label': t(`skineditor.tool_${tool.id}`), 'aria-keyshortcuts': tool.key, onclick: () => setTool(tool.id) }, icon(tool.icon)),
  );
  const toolGroup = h('div', { class: 'se-group', role: 'radiogroup', 'aria-label': t('skineditor.toolsLabel') }, toolBtns);
  toolGroup.addEventListener('keydown', (e) => {
    const i = toolBtns.indexOf(document.activeElement);
    if (i < 0 || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    const n = (i + (e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1) + toolBtns.length) % toolBtns.length;
    toolBtns[n].focus();
    setTool(toolBtns[n].dataset.tool);
  });
  const toggleBtn = (name, iconName, key, onclick) => h('button', { type: 'button', class: 'icon-btn se-toggle', 'aria-pressed': 'false', title: key ? t('skineditor.toolTip', { name: t(`skineditor.${name}`), key }) : t(`skineditor.${name}`), 'aria-label': t(`skineditor.${name}`), 'aria-keyshortcuts': key || null, onclick }, icon(iconName));
  const actionBtn = (name, iconName, key, onclick) => h('button', { type: 'button', class: 'icon-btn', title: key ? t('skineditor.toolTip', { name: t(`skineditor.${name}`), key }) : t(`skineditor.${name}`), 'aria-label': t(`skineditor.${name}`), 'aria-keyshortcuts': key || null, onclick }, icon(iconName));
  const mirrorBtn = toggleBtn('mirror', 'seMirror', 'M', () => setMirror(!S.mirror));
  const undoBtn = actionBtn('undo', 'undo', keyLabel('Ctrl+Z'), () => undo());
  const redoBtn = actionBtn('redo', 'seRedo', keyLabel('Ctrl+Y'), () => redo());
  const zoomOutBtn = actionBtn('zoomOut', 'zoomOut', '-', () => setZoom(S.zoom - 1));
  const zoomInBtn = actionBtn('zoomIn', 'zoomIn', '+', () => setZoom(S.zoom + 1));
  const fitBtn = actionBtn('zoomFit', 'maximize', '0', () => fitZoom(true));
  const zoomLabel = h('span', { class: 'se-zoom num', 'aria-live': 'polite' });
  const gridBtn = toggleBtn('grid', 'seGrid', null, () => {
    S.grid = !S.grid;
    S.prefsDirty = true;
    syncToolbar();
    redraw();
  });
  const templateBtn = toggleBtn('template', 'seTemplate', null, () => {
    S.template = !S.template;
    S.prefsDirty = true;
    syncToolbar();
    redraw();
  });
  const toolbar = h(
    'div',
    { class: 'se-toolbar', role: 'toolbar', 'aria-label': t('skineditor.toolbarLabel') },
    toolGroup,
    h('span', { class: 'se-sep', 'aria-hidden': 'true' }),
    mirrorBtn,
    h('span', { class: 'se-sep', 'aria-hidden': 'true' }),
    undoBtn,
    redoBtn,
    h('span', { class: 'spacer' }),
    gridBtn,
    templateBtn,
    h('span', { class: 'se-sep', 'aria-hidden': 'true' }),
    zoomOutBtn,
    zoomLabel,
    zoomInBtn,
    fitBtn,
  );

  // ---------- Lienzo ----------
  const canvas = h('canvas', { class: 'se-canvas', 'aria-hidden': 'true' });
  const helpId = `${uid}-help`;
  const surface = h('div', { class: 'se-surface', role: 'application', tabindex: '0', 'aria-roledescription': t('skineditor.canvasRole'), 'aria-label': t('skineditor.canvasLabel'), 'aria-describedby': helpId }, canvas);
  const stage = h('div', { class: 'se-stage' }, surface);
  const statusPos = h('span', { class: 'se-status-pos num' });
  const statusZone = h('span', { class: 'se-status-zone ellipsis' });
  const statusSwatch = h('span', { class: 'se-status-sw', 'aria-hidden': 'true' });
  const statusNote = h('span', { class: 'se-status-note', role: 'status', 'aria-live': 'polite' });
  const live = h('div', { class: 'sr-only', 'aria-live': 'polite' });
  const statusBar = h('div', { class: 'se-status' }, statusPos, statusSwatch, statusZone, statusNote);
  const legend = h(
    'div',
    { class: 'se-legend', 'aria-hidden': 'true' },
    LEGEND.map((l) => h('span', { class: 'se-legend-item' }, h('i', { style: { '--se-c': `var(${l.token})` } }), t(`skineditor.legend_${l.id}`))),
    h('span', { class: 'se-legend-item se-legend-dash' }, h('i'), t('skineditor.legendOuter')),
  );
  const help = h('p', { class: 'se-help', id: helpId }, t('skineditor.help'));
  const main = h('div', { class: 'se-main' }, toolbar, stage, statusBar, legend, help, live);

  // ---------- Panel lateral ----------
  const viewer = createViewer({ label: t('skineditor.previewLabel') });
  const previewCanvas = document.createElement('canvas');
  previewCanvas.width = L.SIZE;
  previewCanvas.height = L.SIZE;
  // el visor lee las caras de este lienzo para saltear las vacías de la capa exterior
  const previewCtx = previewCanvas.getContext('2d', { willReadFrequently: true });
  const frontBtn = h('button', { type: 'button', onclick: () => viewer.show('front') }, t('skineditor.front'));
  const backBtn = h('button', { type: 'button', onclick: () => viewer.show('back') }, t('skineditor.back'));
  const preview = h('section', { class: 'se-card se-preview', 'aria-label': t('skineditor.previewTitle') }, viewer.el, h('div', { class: 'segmented se-seg se-view-seg', role: 'group', 'aria-label': t('skineditor.viewGroup') }, frontBtn, backBtn));

  const modelBtns = ['classic', 'slim'].map((v) => h('button', { type: 'button', role: 'radio', 'aria-checked': 'false', dataset: { variant: v }, onclick: () => setVariant(v) }, t(`skineditor.model_${v}`)));
  const modelGroup = h('div', { class: 'segmented se-seg', role: 'radiogroup', 'aria-labelledby': `${uid}-model` }, modelBtns);
  modelGroup.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    const next = S.variant === 'classic' ? 'slim' : 'classic';
    setVariant(next);
    modelBtns.find((b) => b.dataset.variant === next).focus();
  });
  const modelCard = h('section', { class: 'se-card' }, h('h4', { class: 'se-h', id: `${uid}-model` }, t('skineditor.modelTitle')), modelGroup, h('p', { class: 'se-sub' }, t('skineditor.modelHelp')));

  const layerRows = L.LAYERS.map((layer) => {
    const pick = h('button', { type: 'button', class: 'se-layer-pick', role: 'radio', 'aria-checked': 'false', dataset: { layer }, onclick: () => setLayer(layer) }, h('span', { class: 'se-radio', 'aria-hidden': 'true' }), h('span', { class: 'se-layer-text' }, h('span', { class: 'se-layer-name' }, t(`skineditor.layerName_${layer}`)), h('span', { class: 'se-layer-sub', title: t(`skineditor.layerSub_${layer}`) }, t(`skineditor.layerSub_${layer}`))));
    const eye = h('button', { type: 'button', class: 'icon-btn sm se-eye', 'aria-pressed': 'true', dataset: { layer }, onclick: () => toggleShow(layer) });
    return { layer, pick, eye, el: h('div', { class: 'se-layer', dataset: { layer } }, pick, eye) };
  });
  const layerGroup = h('div', { class: 'se-layers', role: 'radiogroup', 'aria-labelledby': `${uid}-layers` }, layerRows.map((r) => r.el));
  layerGroup.addEventListener('keydown', (e) => {
    if (!['ArrowUp', 'ArrowDown'].includes(e.key) || !e.target.classList.contains('se-layer-pick')) return;
    e.preventDefault();
    const next = S.layer === 'base' ? 'outer' : 'base';
    setLayer(next);
    layerRows.find((r) => r.layer === next).pick.focus();
  });
  const layerCard = h('section', { class: 'se-card' }, h('h4', { class: 'se-h', id: `${uid}-layers` }, t('skineditor.layersTitle')), layerGroup);

  const swatchBtn = h('button', { type: 'button', class: 'se-current', title: t('skineditor.pickColor'), 'aria-label': t('skineditor.pickColor'), onclick: () => nativeColor.click() });
  const nativeColor = h('input', { type: 'color', class: 'se-native-color', tabindex: '-1', 'aria-hidden': 'true' });
  const hexId = `${uid}-hex`;
  const hexInput = h('input', { class: 'input se-hex', id: hexId, maxlength: 7, spellcheck: 'false', autocomplete: 'off' });
  const paletteBtns = L.PALETTE.map((c) => h('button', { type: 'button', class: 'se-sw', style: { '--se-sw': c }, title: c, 'aria-label': t('skineditor.colorNamed', { color: c }), 'aria-pressed': 'false', dataset: { color: c }, onclick: () => setColor(L.parseHex(c)) }));
  const recentHost = h('div', { class: 'se-palette se-recent' });
  const recentWrap = h('div', { class: 'se-recent-wrap' }, h('div', { class: 'se-mini-label' }, t('skineditor.recent')), recentHost);
  const colorCard = h(
    'section',
    { class: 'se-card' },
    h('h4', { class: 'se-h' }, t('skineditor.colorTitle')),
    h('div', { class: 'se-color-row' }, swatchBtn, h('div', { class: 'field se-hex-field' }, h('label', { for: hexId, class: 'sr-only' }, t('skineditor.hexLabel')), hexInput), nativeColor),
    h('div', { class: 'se-palette', role: 'group', 'aria-label': t('skineditor.paletteLabel') }, paletteBtns),
    recentWrap,
  );
  const side = h('div', { class: 'se-side' }, colorCard, layerCard, modelCard);
  const body = h('div', { class: 'se-root' }, main, preview, side);

  // ---------- Pie ----------
  const nameId = `${uid}-name`;
  const nameErrId = `${uid}-name-err`;
  const nameInput = h('input', { class: 'input se-name', id: nameId, maxlength: NAME_MAX, autocomplete: 'off', spellcheck: 'false' });
  const nameErr = h('div', { class: 'field-error se-name-err', id: nameErrId, role: 'alert', hidden: true }, icon('alert'), h('span', {}, t('skineditor.nameRequired')));
  const startBtn = h('button', { type: 'button', class: 'btn ghost', onclick: () => openStartPicker() }, icon('layers'), t('skineditor.startFrom'));
  const aiBtn = h('button', { type: 'button', class: 'btn tonal', title: t('skineditor.aiOpenTip'), onclick: () => openAi() }, icon('sparkles'), t('skineditor.aiOpen'));
  const cancelBtn = h('button', { type: 'button', class: 'btn ghost', onclick: () => requestClose() }, t('skineditor.close'));
  const saveBtn = h('button', { type: 'button', class: 'btn primary', onclick: () => save() }, icon('save'), t('skineditor.save'));
  const footer = [
    h('div', { class: 'se-foot-name' }, h('label', { for: nameId }, t('skineditor.nameLabel')), h('div', { class: 'se-name-wrap' }, nameInput, nameErr)),
    startBtn,
    aiBtn,
    h('span', { class: 'spacer' }),
    cancelBtn,
    saveBtn,
  ];

  const m = modal({ title: t('skineditor.title'), subtitle: t('skineditor.subtitle'), icon: 'seBrush', body, footer, size: 'xwide', closable: false, onClose: () => cleanup() });
  m.el.classList.add('se-modal');
  const head = m.el.querySelector('.modal-head');
  const subtitleEl = m.el.querySelector('.modal-sub');
  const closeX = h('button', { type: 'button', class: 'icon-btn sm', title: t('skineditor.close'), 'aria-label': t('skineditor.close'), onclick: () => requestClose() }, icon('x'));
  head?.append(closeX);

  // ---------- Estado -> interfaz ----------
  let rafId = 0;
  function redraw() {
    if (rafId || S.closed) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      if (!S.closed) drawCanvas(canvas, { ...S, cursor: S.focused ? S.cursor : null }, colors);
    });
  }

  let t3d = 0;
  function update3d(now = false) {
    const run = () => {
      t3d = 0;
      if (S.closed) return;
      let data = L.withLayers(S.px, S.show, S.variant);
      if (S.show.base) data = L.opaqueBase(data, S.variant);
      previewCtx.putImageData(new ImageData(data, L.SIZE, L.SIZE), 0, 0);
      viewer.setSkin(previewCanvas, S.variant);
    };
    if (now) {
      clearTimeout(t3d);
      run();
    } else if (!t3d) t3d = setTimeout(run, 120);
  }

  const dirty = () => S.variant !== S.cleanVariant || !L.samePixels(S.px, S.cleanPx);

  function syncToolbar() {
    toolBtns.forEach((b) => {
      const on = b.dataset.tool === S.tool;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    });
    mirrorBtn.classList.toggle('active', S.mirror);
    mirrorBtn.setAttribute('aria-pressed', String(S.mirror));
    gridBtn.classList.toggle('active', S.grid);
    gridBtn.setAttribute('aria-pressed', String(S.grid));
    templateBtn.classList.toggle('active', S.template);
    templateBtn.setAttribute('aria-pressed', String(S.template));
    undoBtn.disabled = !S.history.canUndo();
    redoBtn.disabled = !S.history.canRedo();
    zoomOutBtn.disabled = S.zoom <= ZOOM_MIN;
    zoomInBtn.disabled = S.zoom >= ZOOM_MAX;
    fitBtn.classList.toggle('active', S.fit);
    zoomLabel.textContent = t('skineditor.zoomValue', { zoom: S.zoom });
    legend.hidden = !S.template;
    surface.dataset.tool = S.tool;
  }

  function syncSide() {
    modelBtns.forEach((b) => {
      const on = b.dataset.variant === S.variant;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    });
    for (const r of layerRows) {
      const on = r.layer === S.layer;
      r.el.classList.toggle('active', on);
      r.el.classList.toggle('se-hidden-layer', !S.show[r.layer]);
      r.pick.setAttribute('aria-checked', String(on));
      r.pick.tabIndex = on ? 0 : -1;
      const shown = S.show[r.layer];
      const label = t(shown ? 'skineditor.hideLayer' : 'skineditor.showLayer', { layer: t(`skineditor.layerName_${r.layer}`) });
      r.eye.setAttribute('aria-pressed', String(shown));
      r.eye.title = label;
      r.eye.setAttribute('aria-label', label);
      mount(r.eye, icon(shown ? 'eye' : 'eyeOff'));
    }
    syncColor();
  }

  function syncColor() {
    const hex = L.toHex(S.color);
    swatchBtn.style.setProperty('--se-sw', hex);
    if (document.activeElement !== hexInput) {
      hexInput.value = hex;
      hexInput.classList.remove('invalid');
      hexInput.removeAttribute('aria-invalid');
    }
    if (nativeColor.value !== hex) nativeColor.value = hex;
    paletteBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.color === hex)));
    mount(recentHost, S.recent.map((c) => h('button', { type: 'button', class: 'se-sw', style: { '--se-sw': c }, title: c, 'aria-label': t('skineditor.colorNamed', { color: c }), 'aria-pressed': String(c === hex), onclick: () => setColor(L.parseHex(c)) })));
    recentWrap.hidden = !S.recent.length;
  }

  function syncTitle() {
    const d = dirty();
    saveBtn.classList.toggle('se-unsaved', d);
    if (subtitleEl) {
      const text = S.sourceName ? t('skineditor.subtitleFrom', { name: S.sourceName }) : t('skineditor.subtitle');
      subtitleEl.textContent = d ? t('skineditor.subtitleUnsaved', { text }) : text;
      subtitleEl.title = subtitleEl.textContent;
    }
  }

  function zoneText(z) {
    return z ? t('skineditor.zoneLabel', { part: t(`skineditor.part_${z.part}`), face: t(`skineditor.face_${z.face}`), layer: t(`skineditor.layer_${z.layer}`) }) : t('skineditor.zoneNone');
  }

  function colorText(c) {
    return c[3] === 0 ? t('skineditor.transparent') : L.toHex(c);
  }

  function updateStatus(p) {
    if (!p) {
      statusPos.textContent = '';
      statusZone.textContent = t('skineditor.statusIdle');
      statusSwatch.hidden = true;
      return;
    }
    const c = L.getPixel(S.px, p.x, p.y);
    statusPos.textContent = t('skineditor.position', { x: p.x, y: p.y });
    statusZone.textContent = `${zoneText(L.zoneAt(p.x, p.y, S.variant))} · ${colorText(c)}`;
    statusSwatch.hidden = false;
    statusSwatch.classList.toggle('se-clear', c[3] === 0);
    statusSwatch.style.setProperty('--se-sw', c[3] === 0 ? 'transparent' : L.toHex(c));
  }

  let noteTimer = 0;
  function note(text) {
    statusNote.textContent = text;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => (statusNote.textContent = ''), 3500);
  }

  let announceTimer = 0;
  function announce(p) {
    clearTimeout(announceTimer);
    announceTimer = setTimeout(() => {
      const c = L.getPixel(S.px, p.x, p.y);
      live.textContent = t('skineditor.cursorAnnounce', { x: p.x, y: p.y, zone: zoneText(L.zoneAt(p.x, p.y, S.variant)), color: colorText(c) });
    }, 160);
  }

  // ---------- Acciones ----------
  function setTool(id) {
    S.tool = id;
    if (id !== 'picker') S.lastPaintTool = id;
    syncToolbar();
  }

  function setMirror(on) {
    S.mirror = Boolean(on);
    S.prefsDirty = true;
    syncToolbar();
    redraw();
    note(t(S.mirror ? 'skineditor.mirrorOn' : 'skineditor.mirrorOff'));
  }

  function setVariant(v) {
    const next = L.normVariant(v);
    if (next === S.variant) return;
    S.variant = next;
    syncSide();
    syncTitle();
    redraw();
    update3d(true);
  }

  function setLayer(layer) {
    S.layer = layer;
    if (!S.show[layer]) S.show[layer] = true;
    syncSide();
    redraw();
    update3d();
  }

  function toggleShow(layer) {
    S.show[layer] = !S.show[layer];
    syncSide();
    redraw();
    update3d(true);
  }

  function setColor(rgba, { remember = true } = {}) {
    if (!rgba) return;
    S.color = [rgba[0], rgba[1], rgba[2], 255];
    if (remember) {
      const next = L.pushRecent(S.recent, L.toHex(S.color));
      if (next.join() !== S.recent.join()) {
        S.recent = next;
        S.prefsDirty = true;
      }
    }
    if (S.tool === 'eraser' || S.tool === 'picker') setTool(S.lastPaintTool === 'eraser' ? 'pencil' : S.lastPaintTool);
    syncColor();
  }

  function fitZoom(force = false) {
    if (force) S.fit = true;
    if (!S.fit) return;
    const r = stage.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const z = Math.floor(Math.min(r.width - 24, r.height - 24) / L.SIZE);
    S.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
    syncToolbar();
    redraw();
  }

  function setZoom(z) {
    const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(z)));
    if (next === S.zoom && !S.fit) return;
    S.fit = false;
    S.zoom = next;
    syncToolbar();
    redraw();
  }

  function afterChange() {
    syncToolbar();
    syncTitle();
    redraw();
    update3d(true);
  }

  function undo() {
    const prev = S.history.undo(S.px);
    if (!prev) return;
    S.px = prev;
    afterChange();
    note(t('skineditor.undone'));
  }

  function redo() {
    const next = S.history.redo(S.px);
    if (!next) return;
    S.px = next;
    afterChange();
    note(t('skineditor.redone'));
  }

  // Aplica una herramienta en un pixel. Devuelve cuántos pixeles cambiaron.
  let warned = false;
  function applyAt(x, y, tool) {
    const z = L.zoneAt(x, y, S.variant);
    if (!z) return 0;
    if (z.layer !== S.layer) {
      if (!warned) note(t('skineditor.otherLayer', { layer: t(`skineditor.layerName_${z.layer}`) }));
      warned = true;
      return 0;
    }
    if (!S.show[S.layer]) {
      if (!warned) note(t('skineditor.layerHidden'));
      warned = true;
      return 0;
    }
    const opts = { variant: S.variant, layer: S.layer, mirror: S.mirror };
    if (tool === 'bucket') return L.floodFill(S.px, x, y, S.color, opts).length;
    return L.paint(S.px, x, y, tool === 'eraser' ? L.TRANSPARENT : S.color, opts).length;
  }

  function pick(x, y, { keepTool = false } = {}) {
    const c = L.getPixel(S.px, x, y);
    if (c[3] === 0) {
      note(t('skineditor.pickTransparent'));
      return;
    }
    S.color = [c[0], c[1], c[2], 255];
    S.recent = L.pushRecent(S.recent, L.toHex(S.color));
    S.prefsDirty = true;
    if (!keepTool && S.tool === 'picker') setTool(S.lastPaintTool === 'eraser' ? 'pencil' : S.lastPaintTool);
    syncColor();
    note(t('skineditor.picked', { color: L.toHex(S.color) }));
  }

  function commit(before, count) {
    if (count > 0) {
      S.history.record(before);
      afterChange();
    } else redraw();
  }

  // Un toque (teclado o balde): una sola entrada en el historial.
  function applyOnce(x, y, tool) {
    if (tool === 'picker') {
      pick(x, y);
      return;
    }
    warned = false;
    const before = new Uint8ClampedArray(S.px);
    commit(before, applyAt(x, y, tool));
  }

  // ---------- Puntero ----------
  let stroke = null;
  surface.addEventListener('contextmenu', (e) => e.preventDefault());
  surface.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.button !== 2) return;
    const p = texelAt(canvas, e);
    surface.focus({ preventScroll: true });
    if (!p) return;
    e.preventDefault();
    S.cursor = p;
    const tool = e.altKey ? 'picker' : e.button === 2 ? 'eraser' : S.tool;
    if (tool === 'picker') {
      pick(p.x, p.y, { keepTool: e.altKey });
      redraw();
      return;
    }
    if (tool === 'bucket') {
      applyOnce(p.x, p.y, tool);
      return;
    }
    warned = false;
    stroke = { before: new Uint8ClampedArray(S.px), last: p, tool, count: applyAt(p.x, p.y, tool), id: e.pointerId };
    try {
      surface.setPointerCapture(e.pointerId);
    } catch {
      /* puntero que ya no existe: el trazo termina con pointerup o al salir */
    }
    redraw();
    update3d();
  });
  surface.addEventListener('pointermove', (e) => {
    const p = texelAt(canvas, e);
    S.hover = p;
    updateStatus(p);
    if (stroke && p && e.pointerId === stroke.id) {
      for (const q of L.line(stroke.last.x, stroke.last.y, p.x, p.y).slice(1)) stroke.count += applyAt(q.x, q.y, stroke.tool);
      stroke.last = p;
      S.cursor = p;
      update3d();
    }
    redraw();
  });
  const endStroke = (e) => {
    if (!stroke || (e && e.pointerId !== undefined && e.pointerId !== stroke.id)) return;
    const s = stroke;
    stroke = null;
    commit(s.before, s.count);
  };
  surface.addEventListener('pointerup', endStroke);
  surface.addEventListener('pointercancel', endStroke);
  surface.addEventListener('lostpointercapture', endStroke);
  surface.addEventListener('pointerleave', () => {
    S.hover = null;
    updateStatus(S.focused ? S.cursor : null);
    redraw();
  });
  surface.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setZoom(S.zoom + (e.deltaY < 0 ? 1 : -1));
  }, { passive: false });
  surface.addEventListener('focus', () => {
    S.focused = true;
    if (!S.cursor) S.cursor = { x: 8, y: 8 };
    updateStatus(S.cursor);
    redraw();
  });
  surface.addEventListener('blur', () => {
    S.focused = false;
    endStroke();
    redraw();
  });

  // ---------- Teclado en el lienzo ----------
  surface.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 8 : 1;
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[e.key] && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      const c = S.cursor || { x: 8, y: 8 };
      S.cursor = { x: Math.max(0, Math.min(L.SIZE - 1, c.x + moves[e.key][0])), y: Math.max(0, Math.min(L.SIZE - 1, c.y + moves[e.key][1])) };
      S.hover = null;
      updateStatus(S.cursor);
      announce(S.cursor);
      redraw();
      scrollToCursor();
      return;
    }
    if ((e.key === ' ' || e.key === 'Enter') && S.cursor && !e.ctrlKey) {
      e.preventDefault();
      applyOnce(S.cursor.x, S.cursor.y, e.altKey ? 'picker' : S.tool);
      updateStatus(S.cursor);
      announce(S.cursor);
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && S.cursor) {
      e.preventDefault();
      applyOnce(S.cursor.x, S.cursor.y, 'eraser');
      updateStatus(S.cursor);
      announce(S.cursor);
    }
  });

  function scrollToCursor() {
    if (!S.cursor) return;
    const sr = stage.getBoundingClientRect();
    const cr = canvas.getBoundingClientRect();
    const x = cr.left + (S.cursor.x + 0.5) * (cr.width / L.SIZE);
    const y = cr.top + (S.cursor.y + 0.5) * (cr.height / L.SIZE);
    if (x < sr.left + 16) stage.scrollLeft -= sr.left + 16 - x;
    else if (x > sr.right - 16) stage.scrollLeft += x - sr.right + 16;
    if (y < sr.top + 16) stage.scrollTop -= sr.top + 16 - y;
    else if (y > sr.bottom - 16) stage.scrollTop += y - sr.bottom + 16;
  }

  // ---------- Atajos del editor ----------
  const isTyping = (el) => el instanceof HTMLElement && (el.matches('input:not([type="color"]):not([type="checkbox"]):not([type="radio"]), textarea, select') || el.isContentEditable);
  m.el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.defaultPrevented) {
      e.preventDefault();
      if (stroke) endStroke();
      requestClose();
      return;
    }
    if (isTyping(e.target) || e.defaultPrevented) return;
    const k = e.key.toLowerCase();
    if (e.ctrlKey || e.metaKey) {
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (k === 'y' || (k === 'z' && e.shiftKey)) {
        e.preventDefault();
        redo();
      } else if (k === 's') {
        e.preventDefault();
        save();
      }
      return;
    }
    if (e.altKey) return;
    const tool = TOOLS.find((x) => x.key.toLowerCase() === k) || (k === 'p' ? TOOLS[0] : null);
    if (tool) {
      e.preventDefault();
      setTool(tool.id);
    } else if (k === 'm') {
      e.preventDefault();
      setMirror(!S.mirror);
    } else if (k === '+' || k === '=') {
      e.preventDefault();
      setZoom(S.zoom + 1);
    } else if (k === '-') {
      e.preventDefault();
      setZoom(S.zoom - 1);
    } else if (k === '0') {
      e.preventDefault();
      fitZoom(true);
    }
  });

  // ---------- Color ----------
  nativeColor.addEventListener('input', () => setColor(L.parseHex(nativeColor.value), { remember: false }));
  nativeColor.addEventListener('change', () => setColor(L.parseHex(nativeColor.value)));
  hexInput.addEventListener('input', () => {
    const c = L.parseHex(hexInput.value);
    if (!c) return;
    hexInput.classList.remove('invalid');
    hexInput.removeAttribute('aria-invalid');
    setColor(c, { remember: false });
  });
  hexInput.addEventListener('change', () => {
    const c = L.parseHex(hexInput.value);
    if (c) setColor(c);
  });
  hexInput.addEventListener('blur', () => {
    const bad = Boolean(hexInput.value.trim()) && !L.parseHex(hexInput.value);
    hexInput.classList.toggle('invalid', bad);
    if (bad) hexInput.setAttribute('aria-invalid', 'true');
    else syncColor();
  });

  // ---------- Empezar desde ----------
  function setStart({ px, variant, name = '' }) {
    S.px = new Uint8ClampedArray(px);
    S.variant = L.normVariant(variant);
    S.cleanPx = new Uint8ClampedArray(S.px);
    S.cleanVariant = S.variant;
    S.history.clear();
    S.sourceName = name;
    S.layer = 'base';
    S.show = { base: true, outer: true };
    nameInput.value = name ? cleanName(t('skineditor.editedName', { name })) : t('skineditor.newName');
    nameErr.hidden = true;
    nameInput.removeAttribute('aria-invalid');
    syncSide();
    syncToolbar();
    syncTitle();
    redraw();
    update3d(true);
  }

  // ---------- Creador con IA ----------
  // El resultado entra como un solo cambio del historial: Ctrl+Z vuelve a la skin de antes.
  function openAi() {
    import('./editor/aipanel.js')
      .then(({ openAiPanel }) =>
        openAiPanel({
          variant: S.variant,
          hasContent: !L.isBlank(S.px) && !L.samePixels(S.px, L.blankSkin(S.variant)),
          getCurrent: () => new Uint8ClampedArray(S.px),
          onApply: ({ px, variant }) => {
            if (S.closed) return;
            const before = new Uint8ClampedArray(S.px);
            setVariant(variant);
            S.px = new Uint8ClampedArray(px);
            S.history.record(before);
            S.layer = 'base';
            S.show = { base: true, outer: true };
            syncSide();
            afterChange();
            note(t('skineditor.aiApplied'));
          },
        }),
      )
      .catch((err) => toast('bad', t('skineditor.aiTitle'), err?.message || String(err)));
  }

  async function confirmDiscard() {
    if (!dirty()) return true;
    return confirmDialog(t('skineditor.replaceTitle'), t('skineditor.replaceText'), { okText: t('skineditor.replaceOk'), danger: true });
  }

  async function openStartPicker() {
    const host = h('div', { class: 'se-start' }, skeleton('grid', { items: 6, min: 120 }));
    const pm = modal({ title: t('skineditor.startTitle'), subtitle: t('skineditor.startSub'), icon: 'layers', size: 'wide', body: host, footer: [h('button', { type: 'button', class: 'btn ghost', onclick: () => pm.close() }, t('skineditor.cancel'))] });
    const choose = async (fn) => {
      if (!(await confirmDiscard())) return;
      pm.close();
      fn();
    };
    const canvasOf = (px) => {
      const c = document.createElement('canvas');
      c.width = L.SIZE;
      c.height = L.SIZE;
      c.getContext('2d').putImageData(new ImageData(px, L.SIZE, L.SIZE), 0, 0);
      return c;
    };
    const blankBtns = ['classic', 'slim'].map((v) =>
      h('button', { type: 'button', class: 'se-start-tile se-start-blank', onclick: () => choose(() => setStart({ px: L.blankSkin(v), variant: v })) }, h('span', { class: 'se-start-art' }, skinThumb(canvasOf(L.blankSkin(v)), v, 'se-start-thumb')), h('span', { class: 'se-start-name' }, t(`skineditor.blank_${v}`))),
    );
    let items = [];
    let failed = false;
    try {
      const r = await api.invoke('skins:library');
      items = (Array.isArray(r?.items) ? r.items : []).filter((it) => !it.broken && it.image);
    } catch (err) {
      console.warn('[skineditor] biblioteca:', err?.message || err);
      failed = true;
    }
    const tiles = [];
    for (const it of items) {
      try {
        const { px } = await pixelsOf(it.image);
        tiles.push(h('button', { type: 'button', class: 'se-start-tile', title: it.name, onclick: () => choose(() => setStart({ px, variant: it.variant, name: it.name })) }, h('span', { class: 'se-start-art' }, skinThumb(canvasOf(px), it.variant, 'se-start-thumb')), h('span', { class: 'se-start-name ellipsis' }, it.name)));
      } catch (err) {
        console.warn('[skineditor] no se pudo leer la skin', it.id, err?.message || err);
      }
    }
    if (!host.isConnected) return;
    mount(
      host,
      h('h4', { class: 'se-h' }, t('skineditor.startBlank')),
      h('div', { class: 'se-start-grid' }, blankBtns),
      h('h4', { class: 'se-h' }, t('skineditor.startLibrary')),
      failed
        ? h('div', { class: 'notice bad' }, icon('alert'), h('span', {}, t('skineditor.libraryFailed')))
        : tiles.length
          ? h('div', { class: 'se-start-grid' }, tiles)
          : emptyState('user', t('skineditor.libraryEmptyTitle'), t('skineditor.libraryEmptyText')),
    );
  }

  // ---------- Guardar ----------
  async function save() {
    if (S.saving) return;
    const name = cleanName(nameInput.value);
    if (!name) {
      nameErr.hidden = false;
      nameInput.setAttribute('aria-invalid', 'true');
      nameInput.setAttribute('aria-describedby', nameErrId);
      nameInput.focus();
      return;
    }
    nameErr.hidden = true;
    nameInput.removeAttribute('aria-invalid');
    nameInput.removeAttribute('aria-describedby');
    const data = L.cleanUnused(S.px, S.variant);
    if (L.isBlank(data)) {
      toast('info', t('skineditor.emptySkinTitle'), t('skineditor.emptySkinText'));
      return;
    }
    S.saving = true;
    const done = setBusy(saveBtn);
    try {
      const bytes = await pngBytes(data);
      const r = await api.invoke('skins:addData', [{ name: `${name}.png`, bytes }]);
      const failedItem = r?.failed?.[0];
      if (failedItem) throw Object.assign(new Error(failedItem.message || t('skineditor.saveFailed')), { code: failedItem.code });
      const item = r?.added?.[0] || null;
      const dup = r?.duplicates?.[0] || null;
      if (item) {
        if (item.variant !== S.variant) await api.invoke('skins:setVariant', item.id, S.variant).then((x) => Object.assign(item, x || { variant: S.variant })).catch((err) => console.warn('[skineditor] modelo:', err?.message || err));
        if (item.name !== name) await api.invoke('skins:rename', item.id, name).then((x) => Object.assign(item, x || { name })).catch(() => {});
        // Logro de la PC (contrato 3): rewards lo reclama una sola vez por cuenta
        try {
          window.dispatchEvent(new CustomEvent('venus:achievement', { detail: { id: 'skin_created' } }));
        } catch {
          /* sin logros */
        }
      }
      S.cleanPx = new Uint8ClampedArray(S.px);
      S.cleanVariant = S.variant;
      syncTitle();
      if (typeof onSaved === 'function') {
        try {
          onSaved(r);
        } catch (err) {
          console.warn('[skineditor] onSaved', err);
        }
      } else if (item) ok(t('skineditor.saved'), item.name);
      else if (dup) toast('info', t('skineditor.alreadySaved'), dup.name);
      if (item && typeof onSaved === 'function') note(t('skineditor.savedNote', { name: item.name }));
    } catch (err) {
      console.warn('[skineditor] guardar:', err?.code || '', err?.message || err);
      fail(t('skineditor.saveFailed'), err);
    } finally {
      S.saving = false;
      done();
    }
  }

  // ---------- Cerrar ----------
  async function requestClose() {
    if (S.closed) return;
    if (dirty() && !(await confirmDialog(t('skineditor.discardTitle'), t('skineditor.discardText'), { okText: t('skineditor.discardOk'), danger: true }))) return;
    m.close();
  }

  function cleanup() {
    if (S.closed) return;
    S.closed = true;
    open = null;
    cancelAnimationFrame(rafId);
    clearTimeout(t3d);
    clearTimeout(noteTimer);
    clearTimeout(announceTimer);
    ro?.disconnect();
    offSettings?.();
    viewer.destroy();
    if (S.prefsDirty) store.setSettings({ skineditor: { recent: S.recent, grid: S.grid, template: S.template, mirror: S.mirror } }).catch((err) => console.warn('[skineditor] preferencias:', err?.message || err));
  }

  // El tema puede cambiar con el editor abierto: se releen los colores del lienzo
  const offSettings = store.on('settings', () => {
    colors = readColors();
    redraw();
  });
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => fitZoom()) : null;
  ro?.observe(stage);

  // ---------- Arranque ----------
  setStart({ px: S.px, variant: 'classic' });
  syncToolbar();
  updateStatus(null);
  requestAnimationFrame(() => fitZoom(true));
  (async () => {
    try {
      let from = start;
      if (!from && libraryId) {
        const r = await api.invoke('skins:library');
        const it = (r?.items || []).find((x) => x.id === libraryId && !x.broken && x.image);
        if (it) from = { image: it.image, variant: it.variant, name: it.name };
      }
      if (!from?.image || S.closed) return;
      const { px } = await pixelsOf(from.image);
      if (!S.closed && !dirty()) setStart({ px, variant: from.variant, name: typeof from.name === 'string' ? from.name.slice(0, NAME_MAX) : '' });
    } catch (err) {
      console.warn('[skineditor] skin inicial:', err?.message || err);
      if (!S.closed) note(t('skineditor.startFailed'));
    }
  })();

  return {
    focus: () => surface.focus({ preventScroll: true }),
    close: () => requestClose(),
  };
}
