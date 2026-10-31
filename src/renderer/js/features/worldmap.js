// Mapa del mundo: visor desde arriba de un mundo guardado, sin abrir el juego.
// El proceso principal dibuja una tesela PNG de 512x512 por region (mapviewer:*) y la guarda en cache;
// aca se arman en un canvas con arrastre, zoom con la rueda (pixelado al acercar), marcadores de aparicion
// y jugadores, cambio de dimension, "Renderizar todo" y exportar la vista como PNG.
import { h, icon, mount, modal, ok, fail, ensureCss, registerIcons, avatarImg, copyText, setBusy, reducedMotion } from '../ui.js';
import { store, api } from '../store.js';
import { t, loadNs, locale } from '../i18n.js';

const NS = 'worldmap';
const TILE = 512;
const ZOOMS = [0.125, 0.25, 0.5, 1, 2, 3, 4, 6, 8, 12, 16];
const DEFAULT_ZOOM = 3; // 1 pixel por bloque
const MAX_INFLIGHT = 4;
const MAX_TILES = 240;
const LOWRES = 128;
const EXPORT_MAX = 4096;
const VANILLA = { 'minecraft:overworld': 'overworld', 'minecraft:the_nether': 'nether', 'minecraft:the_end': 'end' };
const DIM_ICONS = { overworld: 'sun', nether: 'flame', end: 'moon' };
const SCALES = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384];
// Colores de los jugadores: tokens del tema (el violeta mezcla dos tokens), resueltos al abrir el mapa
const PLAYER_COLORS = ['var(--info)', 'var(--good)', 'var(--bad)', 'color-mix(in oklch, var(--info), var(--bad))', 'var(--warn)', 'var(--modrinth)', 'var(--accent)'];
// Colores que dibuja el canvas (no entiende var()): se leen de los tokens con su transparencia
const CANVAS_COLORS = {
  placeholder: 'color-mix(in srgb, var(--surface-2) 72%, transparent)',
  stripes: 'color-mix(in srgb, var(--accent-hi) 7%, transparent)',
  placeholderLine: 'color-mix(in srgb, var(--accent-hi) 14%, transparent)',
  placeholderText: 'color-mix(in srgb, var(--text-2) 80%, transparent)',
  errorFill: 'color-mix(in srgb, var(--bad) 8%, transparent)',
  errorLine: 'color-mix(in srgb, var(--bad) 40%, transparent)',
  gridFine: 'color-mix(in srgb, var(--text) 12%, transparent)',
  gridRegion: 'color-mix(in srgb, var(--accent-hi) 45%, transparent)',
  exportBg: 'var(--bg-0)',
  spawn: 'var(--accent)',
  ink: 'var(--text)',
  labelBg: 'color-mix(in srgb, var(--bg-0) 78%, transparent)',
  captionBg: 'color-mix(in srgb, var(--bg-0) 72%, transparent)',
  caption: 'var(--cream)',
};

// Valor final (rgb/rgba/color()) de un color CSS con variables, leido con un elemento de prueba
function resolveColors(map) {
  const probe = h('span', { 'aria-hidden': 'true', style: { position: 'absolute', visibility: 'hidden', pointerEvents: 'none' } });
  document.body.append(probe);
  const out = {};
  for (const [key, css] of Object.entries(map)) {
    probe.style.color = '';
    probe.style.color = css;
    out[key] = getComputedStyle(probe).color;
  }
  probe.remove();
  return out;
}

registerIcons({
  flag: '<path d="M4 22V4a1 1 0 0 1 .4-.8A6 6 0 0 1 8 2c3 0 5 2 7.333 2q2 0 3.067-.8A1 1 0 0 1 20 4v10a1 1 0 0 1-.4.8A6 6 0 0 1 16 16c-3 0-5-2-8-2a6 6 0 0 0-4 1.528"/>',
  locate: '<line x1="2" x2="5" y1="12" y2="12"/><line x1="19" x2="22" y1="12" y2="12"/><line x1="12" x2="12" y1="2" y2="5"/><line x1="12" x2="12" y1="19" y2="22"/><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="3"/>',
});

let ready = null;
function ensureUi() {
  ensureCss('features/worldmap');
  if (!ready) ready = loadNs(NS).catch((err) => console.warn('[worldmap] textos', err));
  return ready;
}

let current = null;

// Abre el visor de mapas de un mundo (carpeta dentro de saves/)
export async function openWorldMap(instanceId, worldFolder) {
  await ensureUi();
  if (current) current.close();
  try {
    current = new MapViewer(instanceId, worldFolder);
    current.open();
  } catch (err) {
    console.error('[worldmap]', err);
    fail(t('worldmap.openFailed'), err);
  }
}

const fmtInt = (n) => Math.round(n).toLocaleString(locale());
const keyOf = (dim, rx, rz) => `${dim}|${rx},${rz}`;

function dimLabel(id) {
  const kind = VANILLA[id];
  if (kind) return t(`worldmap.dim_${kind}`);
  const name = String(id).replace(/^folder:/, '').split(/[:/]/).pop() || String(id);
  return name.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

function playerName(p) {
  return p.name || t('worldmap.unnamed', { id: (p.uuid || '?').slice(0, 8) });
}

class MapViewer {
  constructor(instanceId, folder) {
    this.instanceId = instanceId;
    this.folder = folder;
    this.info = null;
    this.dim = null;
    this.views = new Map();
    this.regionSets = new Map();
    this.tiles = new Map();
    this.queue = [];
    this.inflight = 0;
    this.closed = false;
    this.raf = 0;
    this.animTimer = 0;
    this.drag = null;
    this.hover = null;
    this.wheelAcc = 0;
    this.cssW = 0;
    this.cssH = 0;
    this.dpr = 1;
    this.errors = new Set();
    this.legacy = false;
    this.renderTask = null;
    this.renderingAll = false;
    this.lastExport = null;
    this.markerEls = [];
    this.markerDim = null;
    this.menu = null;
    this.offs = [];
    this.prefs = { grid: false, markers: true, ...(store.settings?.mapviewer || {}) };
    this.refreshColors();
  }

  // Lee los colores del tema actual (al abrir y antes de exportar: el acento se puede cambiar en vivo)
  refreshColors() {
    this.colors = resolveColors(CANVAS_COLORS);
    this.playerColors = Object.values(resolveColors(Object.fromEntries(PLAYER_COLORS.map((c, i) => [i, c]))));
    this.pattern = null;
  }

  // ---------- Estructura ----------
  open() {
    this.stillStripes = reducedMotion();
    const inst = store.instances.find((i) => i.id === this.instanceId);
    this.titleEl = h('span', { class: 'wm-title' }, t('worldmap.title', { world: this.folder }));
    this.subEl = h('span', { class: 'wm-sub' }, inst?.name || '');
    const head = h('span', { class: 'wm-head' }, h('span', { class: 'wm-head-icon' }, icon('map')), h('span', { class: 'wm-head-text' }, this.titleEl, this.subEl));

    this.canvas = h('canvas', { class: 'wm-canvas', tabindex: 0, role: 'img', 'aria-label': t('worldmap.canvasLabel', { world: this.folder }), title: t('worldmap.canvasHint') });
    this.ctx = this.canvas.getContext('2d', { alpha: true });
    this.markersEl = h('div', { class: 'wm-markers' });
    this.dimsEl = h('div', { class: 'wm-panel wm-dims', role: 'group', hidden: true, 'aria-label': t('worldmap.dimsLabel') });

    const toolBtn = (name, label, onclick, extra = {}) => h('button', { class: 'wm-tool', type: 'button', title: label, 'aria-label': label, onclick, ...extra }, icon(name));
    this.zoomInBtn = toolBtn('zoomIn', t('worldmap.zoomIn'), () => this.zoomBy(1));
    this.zoomOutBtn = toolBtn('zoomOut', t('worldmap.zoomOut'), () => this.zoomBy(-1));
    this.spawnBtn = toolBtn('flag', t('worldmap.centerSpawn'), () => this.centerSpawn());
    this.playerBtn = toolBtn('locate', t('worldmap.centerPlayers'), (e) => this.onPlayerButton(e), { 'aria-haspopup': 'menu' });
    this.gridBtn = toolBtn('grid', t('worldmap.grid'), () => this.togglePref('grid'), { 'aria-pressed': String(this.prefs.grid) });
    this.markersBtn = toolBtn(this.prefs.markers ? 'eye' : 'eyeOff', t('worldmap.markers'), () => this.togglePref('markers'), { 'aria-pressed': String(this.prefs.markers) });
    this.toolsEl = h(
      'div',
      { class: 'wm-panel wm-tools' },
      this.zoomInBtn,
      this.zoomOutBtn,
      h('span', { class: 'wm-tool-sep', 'aria-hidden': 'true' }),
      this.spawnBtn,
      this.playerBtn,
      h('span', { class: 'wm-tool-sep', 'aria-hidden': 'true' }),
      this.gridBtn,
      this.markersBtn,
    );

    this.coordMain = h('span', { class: 'wm-coord-main' });
    this.coordSub = h('span', { class: 'wm-coord-sub' });
    this.coordsEl = h('button', { class: 'wm-panel wm-coords', type: 'button', hidden: true, title: t('worldmap.copyCoords'), 'aria-label': t('worldmap.copyCoords'), onclick: () => this.copyCoords() }, this.coordMain, this.coordSub);
    this.scaleBar = h('span', { class: 'wm-scale-bar' });
    this.scaleLabel = h('span', { class: 'wm-scale-label' });
    this.scaleEl = h('div', { class: 'wm-panel wm-scale', hidden: true, 'aria-hidden': 'true' }, h('span', { class: 'wm-north' }, t('worldmap.north')), this.scaleLabel, this.scaleBar);
    this.progressText = h('span', { class: 'wm-progress-text' });
    this.progressFill = h('i');
    this.progressCancel = h('button', { class: 'wm-progress-cancel', type: 'button', title: t('worldmap.cancel'), 'aria-label': t('worldmap.cancel'), onclick: () => this.cancelRenderAll() }, icon('x'));
    this.progressEl = h(
      'div',
      { class: 'wm-panel wm-progress', hidden: true, role: 'status', 'aria-live': 'polite' },
      h('div', { class: 'spinner' }),
      h('div', { class: 'wm-progress-main' }, this.progressText, h('div', { class: 'progress' }, this.progressFill)),
      this.progressCancel,
    );
    this.overlayEl = h('div', { class: 'wm-overlay', hidden: true });
    this.stage = h('div', { class: 'wm-stage' }, this.canvas, this.markersEl, this.dimsEl, this.toolsEl, this.coordsEl, this.scaleEl, this.progressEl, this.overlayEl);

    this.statusEl = h('div', { class: 'wm-status' });
    this.refreshBtn = h('button', { class: 'btn ghost', type: 'button', title: t('worldmap.refreshHint'), onclick: () => this.refresh() }, icon('refresh'), t('worldmap.refresh'));
    this.exportBtn = h('button', { class: 'btn', type: 'button', title: t('worldmap.exportHint'), onclick: () => this.exportPng() }, icon('download'), t('worldmap.exportPng'));
    this.renderBtn = h('button', { class: 'btn primary', type: 'button', title: t('worldmap.renderAllHint'), onclick: () => this.renderAll() }, icon('layers'), t('worldmap.renderAll'));

    this.modal = modal({
      title: head,
      body: this.stage,
      footer: [this.statusEl, this.refreshBtn, this.exportBtn, this.renderBtn],
      size: 'wm-modal',
      onClose: () => this.destroy(),
    });
    this.modal.el.parentElement?.classList.add('wm-backdrop');
    this.modal.el.querySelector('.modal-body')?.classList.add('wm-body');
    this.modal.el.querySelector('.modal-foot')?.classList.add('wm-foot');

    this.bindEvents();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.stage);
    this.resize();
    this.setButtonsEnabled(false);
    this.load();
    setTimeout(() => !this.closed && this.canvas.focus({ preventScroll: true }), 60);
  }

  close() {
    this.modal?.close();
  }

  destroy() {
    if (this.closed) return;
    this.closed = true;
    if (current === this) current = null;
    cancelAnimationFrame(this.raf);
    clearTimeout(this.animTimer);
    this.resizeObserver?.disconnect();
    for (const off of this.offs) {
      try {
        off();
      } catch {
        /* ya desuscripto */
      }
    }
    this.closeMenu();
    this.queue = [];
    for (const tile of this.tiles.values()) tile.low?.close?.();
    this.tiles.clear();
  }

  bindEvents() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      this.closeMenu();
      c.setPointerCapture(e.pointerId);
      const v = this.view();
      if (!v) return;
      this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, vx: v.x, vz: v.z };
      this.stage.classList.add('dragging');
    });
    c.addEventListener('pointermove', (e) => {
      const r = c.getBoundingClientRect();
      this.hover = { sx: e.clientX - r.left, sy: e.clientY - r.top };
      if (this.drag && this.drag.id === e.pointerId) {
        const v = this.view();
        const s = ZOOMS[v.zi];
        v.x = this.drag.vx - (e.clientX - this.drag.x) / s;
        v.z = this.drag.vz - (e.clientY - this.drag.y) / s;
        this.scheduleDraw();
      } else this.updateCoords();
    });
    const endDrag = (e) => {
      if (!this.drag || this.drag.id !== e.pointerId) return;
      this.drag = null;
      this.stage.classList.remove('dragging');
      try {
        c.releasePointerCapture(e.pointerId);
      } catch {
        /* ya liberado */
      }
    };
    c.addEventListener('pointerup', endDrag);
    c.addEventListener('pointercancel', endDrag);
    c.addEventListener('pointerleave', () => {
      if (this.drag) return;
      this.hover = null;
      this.updateCoords();
    });
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const v = this.view();
        if (!v) return;
        this.wheelAcc += e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY;
        if (Math.abs(this.wheelAcc) < 50) return;
        const dir = this.wheelAcc < 0 ? 1 : -1;
        this.wheelAcc = 0;
        const r = c.getBoundingClientRect();
        this.zoomAt(v.zi + dir, e.clientX - r.left, e.clientY - r.top);
      },
      { passive: false },
    );
    c.addEventListener('dblclick', (e) => {
      const v = this.view();
      if (!v) return;
      const r = c.getBoundingClientRect();
      this.zoomAt(v.zi + (e.shiftKey ? -1 : 1), e.clientX - r.left, e.clientY - r.top);
    });
    c.addEventListener('keydown', (e) => {
      const v = this.view();
      if (!v) return;
      const step = 90 / ZOOMS[v.zi];
      const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      if (moves[e.key]) {
        v.x += moves[e.key][0];
        v.z += moves[e.key][1];
        this.scheduleDraw();
        e.preventDefault();
      } else if (e.key === '+' || e.key === '=') {
        this.zoomBy(1);
        e.preventDefault();
      } else if (e.key === '-' || e.key === '_') {
        this.zoomBy(-1);
        e.preventDefault();
      }
    });
    // Escape cierra primero el menu de jugadores (sin cerrar el visor)
    this.stage.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.menu) {
        e.stopPropagation();
        this.closeMenu();
        this.playerBtn.focus();
      }
    });
    this.offs.push(api.on('mapviewer:tileReady', (p) => this.onTileReady(p)));
    this.offs.push(store.on('task', (task) => this.onTask(task)));
  }

  // ---------- Datos ----------
  async load() {
    this.setOverlay('loading');
    let info;
    try {
      info = await api.invoke('mapviewer:info', this.instanceId, this.folder);
    } catch (err) {
      if (!this.closed) this.setOverlay('error', err);
      return;
    }
    if (this.closed) return;
    this.applyInfo(info);
    const first = this.pickInitialDim();
    if (first) this.setDimension(first);
    else this.updateOverlay();
    this.setButtonsEnabled(true);
  }

  applyInfo(info) {
    this.info = info;
    this.regionSets = new Map(Object.entries(info.regions || {}).map(([dim, list]) => [dim, new Set(list.map(([x, z]) => `${x},${z}`))]));
    this.legacy = Boolean(info.world?.legacy);
    const name = info.world?.name || this.folder;
    this.titleEl.textContent = t('worldmap.title', { world: name });
    this.canvas.setAttribute('aria-label', t('worldmap.canvasLabel', { world: name }));
    const inst = store.instances.find((i) => i.id === this.instanceId);
    this.subEl.textContent = [inst?.name, info.world?.version ? t('worldmap.version', { version: info.world.version }) : null].filter(Boolean).join(' · ');
    this.markerDim = null;
    this.buildDims();
    this.updatePlayerButton();
    this.updateStatus();
  }

  pickInitialDim() {
    const dims = this.info?.dimensions || [];
    const withRegions = (id) => (this.regionSets.get(id)?.size || 0) > 0;
    const host = (this.info?.players || []).find((p) => p.host) || this.info?.players?.[0];
    if (host && withRegions(host.dimension)) return host.dimension;
    if (withRegions('minecraft:overworld')) return 'minecraft:overworld';
    return dims.find((d) => withRegions(d.id))?.id || dims[0]?.id || null;
  }

  async refresh() {
    if (!this.info) return this.load();
    const done = setBusy(this.refreshBtn);
    try {
      const info = await api.invoke('mapviewer:info', this.instanceId, this.folder);
      if (this.closed) return;
      this.applyInfo(info);
      if (!this.dim || !this.info.dimensions.some((d) => d.id === this.dim)) {
        const first = this.pickInitialDim();
        if (first) this.setDimension(first);
      }
      // Las teselas se vuelven a pedir: el proceso principal decide si cambio la region
      this.errors.clear();
      for (const tile of this.tiles.values()) if (tile.state !== 'loading') tile.state = tile.img ? 'stale' : 'pending';
      this.updateOverlay();
      this.scheduleDraw();
    } catch (err) {
      fail(t('worldmap.errorTitle'), err);
    } finally {
      if (!this.closed) done();
    }
  }

  // ---------- Dimensiones ----------
  buildDims() {
    const dims = this.info?.dimensions || [];
    if (dims.length <= 1) {
      this.dimsEl.hidden = true;
      return;
    }
    this.dimsEl.hidden = false;
    const main = dims.slice(0, 3);
    const extra = dims.slice(3);
    const btns = main.map((d) => {
      const kind = VANILLA[d.id];
      return h(
        'button',
        { type: 'button', class: 'wm-dim', dataset: { dim: d.id }, 'aria-pressed': 'false', title: dimLabel(d.id), onclick: () => this.setDimension(d.id) },
        icon(DIM_ICONS[kind] || 'sparkles'),
        h('span', {}, dimLabel(d.id)),
      );
    });
    let select = null;
    if (extra.length) {
      select = h(
        'select',
        { class: 'wm-dim-select', 'aria-label': t('worldmap.moreDims'), title: t('worldmap.moreDims') },
        h('option', { value: '' }, t('worldmap.moreDims')),
        extra.map((d) => h('option', { value: d.id }, dimLabel(d.id))),
      );
      select.addEventListener('change', () => select.value && this.setDimension(select.value));
    }
    mount(this.dimsEl, h('div', { class: 'segmented wm-seg' }, btns), select);
    this.renderDims();
  }

  renderDims() {
    for (const b of this.dimsEl.querySelectorAll('.wm-dim')) {
      const on = b.dataset.dim === this.dim;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    }
    const sel = this.dimsEl.querySelector('select');
    if (sel) sel.value = [...sel.options].some((o) => o.value === this.dim) ? this.dim : '';
  }

  setDimension(id, center = null) {
    const prev = this.dim;
    const prevView = prev ? this.views.get(prev) : null;
    this.dim = id;
    if (!this.views.has(id)) this.views.set(id, this.initialView(id, prev, prevView));
    if (center) {
      const v = this.views.get(id);
      v.x = center.x;
      v.z = center.z;
    }
    this.queue = [];
    this.closeMenu();
    this.renderDims();
    this.markerDim = null;
    this.updateOverlay();
    this.updateStatus();
    this.scheduleDraw();
  }

  initialView(id, prevId, prevView) {
    const kind = VANILLA[id];
    const prevKind = prevId ? VANILLA[prevId] : null;
    // Entre la superficie y el Nether las coordenadas se dividen o multiplican por 8
    if (prevView && ((kind === 'nether' && prevKind === 'overworld') || (kind === 'overworld' && prevKind === 'nether'))) {
      const f = kind === 'nether' ? 1 / 8 : 8;
      const guess = { x: prevView.x * f, z: prevView.z * f, zi: Math.max(prevView.zi, DEFAULT_ZOOM) };
      if (this.nearRegions(id, guess.x, guess.z)) return guess;
    }
    const host = (this.info?.players || []).find((p) => p.dimension === id && p.host) || (this.info?.players || []).find((p) => p.dimension === id);
    if (host && this.nearRegions(id, host.x, host.z)) return { x: host.x, z: host.z, zi: DEFAULT_ZOOM };
    const sp = this.info?.spawn;
    if (sp && sp.dimension === id && this.nearRegions(id, sp.x, sp.z)) return { x: sp.x, z: sp.z, zi: DEFAULT_ZOOM };
    const b = this.info?.dimensions?.find((d) => d.id === id)?.bounds;
    if (b) {
      // Centro de la zona con regiones; si es muy grande se arranca mas lejos
      const span = Math.max(b.maxX - b.minX, b.maxZ - b.minZ);
      const zi = span > 6000 ? 1 : span > 2500 ? 2 : DEFAULT_ZOOM;
      const best = this.densestRegion(id);
      return best ? { x: best.x, z: best.z, zi } : { x: (b.minX + b.maxX) / 2, z: (b.minZ + b.maxZ) / 2, zi };
    }
    return { x: 0, z: 0, zi: DEFAULT_ZOOM };
  }

  // true si hay alguna region a menos de una region de distancia del punto
  nearRegions(id, x, z) {
    const set = this.regionSets.get(id);
    if (!set || !set.size) return false;
    const rx = Math.floor(x / TILE);
    const rz = Math.floor(z / TILE);
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) if (set.has(`${rx + dx},${rz + dz}`)) return true;
    return false;
  }

  // Centro del grupo de regiones mas denso (evita arrancar en una region aislada lejos del resto)
  densestRegion(id) {
    const set = this.regionSets.get(id);
    if (!set || !set.size) return null;
    let best = null;
    let bestScore = -Infinity;
    for (const key of set) {
      const [rx, rz] = key.split(',').map(Number);
      let score = 0;
      for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) if (set.has(`${rx + dx},${rz + dz}`)) score++;
      score -= Math.hypot(rx, rz) / 1000;
      if (score > bestScore) {
        bestScore = score;
        best = { rx, rz };
      }
    }
    let sx = 0;
    let sz = 0;
    let n = 0;
    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (!set.has(`${best.rx + dx},${best.rz + dz}`)) continue;
        sx += best.rx + dx;
        sz += best.rz + dz;
        n++;
      }
    }
    return { x: (sx / n) * TILE + TILE / 2, z: (sz / n) * TILE + TILE / 2 };
  }

  hasData() {
    return (this.regionSets.get(this.dim)?.size || 0) > 0;
  }

  view() {
    return this.dim ? this.views.get(this.dim) : null;
  }

  // ---------- Capa de estados (cargando, vacio, error) ----------
  setOverlay(kind, err) {
    if (!kind) {
      this.overlayEl.hidden = true;
      return;
    }
    this.overlayEl.hidden = false;
    if (kind === 'loading') {
      mount(this.overlayEl, h('div', { class: 'wm-loading', role: 'status', 'aria-live': 'polite' }, h('div', { class: 'spinner lg', 'aria-hidden': 'true' }), h('div', {}, t('worldmap.loading'))));
      return;
    }
    if (kind === 'error') {
      mount(
        this.overlayEl,
        h(
          'div',
          { class: 'wm-state card', role: 'alert' },
          h('div', { class: 'wm-state-icon bad' }, icon('alert')),
          h('div', { class: 'wm-state-title' }, t('worldmap.errorTitle')),
          h('div', { class: 'wm-state-text' }, err?.message || String(err || '')),
          h('button', { class: 'btn', type: 'button', onclick: () => this.load() }, icon('refresh'), t('worldmap.retry')),
        ),
      );
      return;
    }
    // Cada estado dice que pasa y ofrece como seguir (otra dimension con terreno o volver a leer el mundo)
    const other = kind === 'emptyDim' ? (this.info?.dimensions || []).find((d) => d.id !== this.dim && (this.regionSets.get(d.id)?.size || 0) > 0) : null;
    const reread = h('button', { class: 'btn', type: 'button', onclick: () => this.refresh() }, icon('refresh'), t('worldmap.refresh'));
    const texts = {
      emptyDim: [icon('map'), t('worldmap.emptyTitle'), t('worldmap.emptyText'), other ? h('button', { class: 'btn', type: 'button', onclick: () => this.setDimension(other.id) }, icon(DIM_ICONS[VANILLA[other.id]] || 'sparkles'), t('worldmap.showDim', { dim: dimLabel(other.id) })) : reread],
      noRegions: [icon('globe'), t('worldmap.noRegionsTitle'), t('worldmap.noRegionsText'), reread],
      unsupported: [icon('alert'), t('worldmap.unsupportedTitle'), t(`worldmap.unsupported_${this.info?.world?.unsupported || 'mcregion'}`), null],
    };
    const [ic, title, text, action] = texts[kind];
    mount(this.overlayEl, h('div', { class: 'wm-state card' }, h('div', { class: 'wm-state-icon' }, ic), h('div', { class: 'wm-state-title' }, title), h('div', { class: 'wm-state-text' }, text), action));
  }

  updateOverlay() {
    if (!this.info) return;
    const total = [...this.regionSets.values()].reduce((a, s) => a + s.size, 0);
    if (!total) this.setOverlay(this.info.world?.unsupported ? 'unsupported' : 'noRegions');
    else if (!(this.regionSets.get(this.dim)?.size > 0)) this.setOverlay('emptyDim');
    else this.setOverlay(null);
  }

  setButtonsEnabled(on) {
    const has = on && this.hasData();
    this.exportBtn.disabled = !has;
    this.renderBtn.disabled = !has || this.renderingAll;
    // Sin terreno en esta dimension no hay nada que mover ni medir: se ocultan los paneles del mapa
    this.toolsEl.hidden = !has;
    if (!has) {
      this.coordsEl.hidden = true;
      this.scaleEl.hidden = true;
    }
    this.updatePlayerButton();
  }

  updateStatus() {
    const parts = [];
    const count = this.regionSets.get(this.dim)?.size || 0;
    if (this.info) parts.push(h('span', { class: 'wm-stat' }, icon('grid'), t('worldmap.regions', { count })));
    if (this.legacy) parts.push(h('span', { class: 'pill warn wm-pill' }, icon('alert'), t('worldmap.legacyNotice')));
    if (this.errors.size) parts.push(h('span', { class: 'pill bad wm-pill' }, icon('alert'), t('worldmap.tileErrors', { count: this.errors.size })));
    if (this.lastExport) {
      const file = this.lastExport;
      parts.push(
        h(
          'button',
          {
            class: 'btn sm ghost wm-reveal',
            type: 'button',
            title: file,
            onclick: () => api.invoke('mapviewer:reveal', file).catch((err) => fail(t('worldmap.exportFailed'), err)),
          },
          icon('folderOpen'),
          t('worldmap.showInFolder'),
        ),
      );
    }
    if (count && parts.length === 1) parts.push(h('span', { class: 'wm-hint' }, t('worldmap.hintShort')));
    mount(this.statusEl, parts);
    this.setButtonsEnabled(Boolean(this.info));
  }

  // ---------- Dibujo ----------
  resize() {
    const w = this.stage.clientWidth;
    const hgt = this.stage.clientHeight;
    if (!w || !hgt) return;
    this.dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    this.cssW = w;
    this.cssH = hgt;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(hgt * this.dpr);
    this.draw();
  }

  scheduleDraw() {
    if (this.closed || this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.draw();
    });
  }

  draw() {
    if (this.closed) return;
    const g = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, H);
    const v = this.view();
    const set = this.regionSets.get(this.dim);
    if (!v || !set || !set.size || !W) {
      this.updateMarkers();
      this.updateCoords();
      this.updateScale();
      return;
    }
    const s = ZOOMS[v.zi] * this.dpr;
    const x0 = v.x - W / 2 / s;
    const z0 = v.z - H / 2 / s;
    const rx0 = Math.floor(x0 / TILE);
    const rz0 = Math.floor(z0 / TILE);
    const rx1 = Math.floor((x0 + W / s) / TILE);
    const rz1 = Math.floor((z0 + H / s) / TILE);
    const cx = v.x / TILE;
    const cz = v.z / TILE;
    g.imageSmoothingEnabled = s < 1;
    g.imageSmoothingQuality = 'medium';
    const wanted = [];
    let loading = false;
    const now = performance.now();
    this.visible = new Set();
    for (let rz = rz0; rz <= rz1; rz++) {
      for (let rx = rx0; rx <= rx1; rx++) {
        if (!set.has(`${rx},${rz}`)) continue;
        const X0 = Math.round((rx * TILE - v.x) * s + W / 2);
        const Z0 = Math.round((rz * TILE - v.z) * s + H / 2);
        const X1 = Math.round(((rx + 1) * TILE - v.x) * s + W / 2);
        const Z1 = Math.round(((rz + 1) * TILE - v.z) * s + H / 2);
        const key = keyOf(this.dim, rx, rz);
        this.visible.add(key);
        const tile = this.tiles.get(key);
        const dist = Math.hypot(rx + 0.5 - cx, rz + 0.5 - cz);
        if (tile) tile.used = now;
        if (tile?.img) {
          const small = s * TILE < LOWRES * 1.25;
          if (small && !tile.low) this.makeLowRes(tile);
          g.drawImage(small && tile.low ? tile.low : tile.img, X0, Z0, X1 - X0, Z1 - Z0);
          if (tile.state === 'stale' || tile.state === 'pending') wanted.push({ rx, rz, dist });
        } else if (!tile || tile.state === 'pending' || tile.state === 'loading' || tile.state === 'stale') {
          this.drawPlaceholder(X0, Z0, X1 - X0, Z1 - Z0, now);
          loading = true;
          if (!tile || tile.state !== 'loading') wanted.push({ rx, rz, dist });
        } else if (tile.state === 'error') this.drawErrorTile(X0, Z0, X1 - X0, Z1 - Z0);
      }
    }
    if (this.prefs.grid) this.drawGrid(v, s, W, H);
    this.requestTiles(wanted);
    this.updateMarkers();
    this.updateScale();
    this.updateCoords();
    if (loading && !this.stillStripes) {
      clearTimeout(this.animTimer);
      this.animTimer = setTimeout(() => this.scheduleDraw(), 70);
    }
  }

  stripes() {
    if (this.pattern) return this.pattern;
    const c = document.createElement('canvas');
    c.width = 24;
    c.height = 24;
    const g = c.getContext('2d');
    g.strokeStyle = this.colors.stripes;
    g.lineWidth = 6;
    g.beginPath();
    for (let i = -24; i <= 48; i += 12) {
      g.moveTo(i, 0);
      g.lineTo(i - 24, 24);
    }
    g.stroke();
    this.pattern = this.ctx.createPattern(c, 'repeat');
    return this.pattern;
  }

  drawPlaceholder(x, y, w, hgt, now) {
    const g = this.ctx;
    g.fillStyle = this.colors.placeholder;
    g.fillRect(x, y, w, hgt);
    const pat = this.stripes();
    // Las rayas se mueven mientras se dibuja la region (quietas con movimiento reducido)
    pat.setTransform(new DOMMatrix().translate(this.stillStripes ? 0 : (now / 40) % 24, 0));
    g.fillStyle = pat;
    g.fillRect(x, y, w, hgt);
    g.strokeStyle = this.colors.placeholderLine;
    g.lineWidth = 1;
    g.strokeRect(x + 0.5, y + 0.5, w - 1, hgt - 1);
    if (w >= 150 * this.dpr && hgt >= 60 * this.dpr) {
      g.font = `600 ${13 * this.dpr}px Outfit, system-ui, sans-serif`;
      g.fillStyle = this.colors.placeholderText;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(t('worldmap.drawing'), x + w / 2, y + hgt / 2);
    }
  }

  drawErrorTile(x, y, w, hgt) {
    const g = this.ctx;
    g.fillStyle = this.colors.errorFill;
    g.fillRect(x, y, w, hgt);
    g.strokeStyle = this.colors.errorLine;
    g.setLineDash([6 * this.dpr, 5 * this.dpr]);
    g.strokeRect(x + 0.5, y + 0.5, w - 1, hgt - 1);
    g.setLineDash([]);
  }

  drawGrid(v, s, W, H) {
    const g = this.ctx;
    const x0 = v.x - W / 2 / s;
    const z0 = v.z - H / 2 / s;
    const x1 = x0 + W / s;
    const z1 = z0 + H / s;
    const line = (step, color, width) => {
      g.strokeStyle = color;
      g.lineWidth = width;
      g.beginPath();
      for (let x = Math.ceil(x0 / step) * step; x <= x1; x += step) {
        const px = Math.round((x - v.x) * s + W / 2) + 0.5;
        g.moveTo(px, 0);
        g.lineTo(px, H);
      }
      for (let z = Math.ceil(z0 / step) * step; z <= z1; z += step) {
        const pz = Math.round((z - v.z) * s + H / 2) + 0.5;
        g.moveTo(0, pz);
        g.lineTo(W, pz);
      }
      g.stroke();
    };
    if (s >= 1.5) line(16, this.colors.gridFine, 1);
    line(TILE, this.colors.gridRegion, Math.max(1, Math.round(this.dpr)));
  }

  makeLowRes(tile) {
    if (tile.lowPending || !window.createImageBitmap) return;
    tile.lowPending = true;
    createImageBitmap(tile.img, { resizeWidth: LOWRES, resizeHeight: LOWRES, resizeQuality: 'medium' })
      .then((bmp) => {
        if (this.closed || !this.tiles.has(tile.key)) return bmp.close();
        tile.low = bmp;
        this.scheduleDraw();
        return null;
      })
      .catch(() => {})
      .finally(() => {
        tile.lowPending = false;
      });
  }

  // ---------- Teselas ----------
  requestTiles(list) {
    const wanted = new Set();
    for (const w of list) {
      const key = keyOf(this.dim, w.rx, w.rz);
      wanted.add(key);
      let tile = this.tiles.get(key);
      if (!tile) {
        tile = { key, dim: this.dim, rx: w.rx, rz: w.rz, state: 'pending', img: null, url: null, low: null, used: performance.now() };
        this.tiles.set(key, tile);
      }
      tile.prio = w.dist;
    }
    this.queue = [...wanted].map((k) => this.tiles.get(k)).filter((tile) => tile && (tile.state === 'pending' || tile.state === 'stale'));
    this.queue.sort((a, b) => a.prio - b.prio);
    this.pump();
  }

  pump() {
    while (!this.closed && this.inflight < MAX_INFLIGHT && this.queue.length) {
      const tile = this.queue.shift();
      if (tile.state !== 'pending' && tile.state !== 'stale') continue;
      this.loadTile(tile);
    }
  }

  async loadTile(tile) {
    const hadImage = Boolean(tile.img);
    tile.state = 'loading';
    this.inflight++;
    try {
      const res = await api.invoke('mapviewer:tile', this.instanceId, this.folder, tile.dim, tile.rx, tile.rz);
      if (this.closed) return;
      if (res?.legacy && !this.legacy) {
        this.legacy = true;
        this.updateStatus();
      }
      if (!res || res.empty || !res.url) {
        tile.state = 'empty';
        tile.img = null;
        tile.url = null;
      } else await this.setTileImage(tile, res.url);
      if (this.errors.delete(tile.key)) this.updateStatus();
    } catch (err) {
      if (this.closed) return;
      console.warn('[worldmap]', err?.message || err);
      tile.state = hadImage ? 'ready' : 'error';
      this.errors.add(tile.key);
      this.updateStatus();
    } finally {
      this.inflight--;
      if (!this.closed) {
        this.evict();
        this.pump();
        this.scheduleDraw();
      }
    }
  }

  async setTileImage(tile, url) {
    if (tile.url === url && tile.img) {
      tile.state = 'ready';
      return;
    }
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    if (this.closed) return;
    tile.img = img;
    tile.url = url;
    tile.low?.close?.();
    tile.low = null;
    tile.state = 'ready';
  }

  // Libera las teselas mas lejanas cuando hay demasiadas en memoria (nunca las que se estan viendo)
  evict() {
    const visible = this.visible || new Set();
    const limit = Math.max(MAX_TILES, Math.ceil(visible.size * 1.3));
    if (this.tiles.size <= limit) return;
    const v = this.view();
    const cx = v ? v.x / TILE : 0;
    const cz = v ? v.z / TILE : 0;
    const candidates = [...this.tiles.values()].filter((tile) => tile.state !== 'loading' && !visible.has(tile.key));
    candidates.sort((a, b) => (b.dim !== this.dim) - (a.dim !== this.dim) || Math.hypot(b.rx - cx, b.rz - cz) - Math.hypot(a.rx - cx, a.rz - cz));
    for (const tile of candidates) {
      if (this.tiles.size <= limit * 0.85) break;
      tile.low?.close?.();
      this.tiles.delete(tile.key);
    }
  }

  onTileReady(p) {
    if (this.closed || !p || p.instanceId !== this.instanceId || p.world !== this.folder) return;
    let set = this.regionSets.get(p.dimension);
    if (!set) {
      set = new Set();
      this.regionSets.set(p.dimension, set);
    }
    const isNew = !set.has(`${p.rx},${p.rz}`);
    set.add(`${p.rx},${p.rz}`);
    const key = keyOf(p.dimension, p.rx, p.rz);
    const tile = this.tiles.get(key);
    if (p.empty || !p.url) {
      if (tile) {
        tile.state = 'empty';
        tile.img = null;
      }
    } else if (tile && tile.url !== p.url && tile.state !== 'loading') {
      tile.state = 'loading';
      this.setTileImage(tile, p.url)
        .catch(() => {
          tile.state = tile.img ? 'ready' : 'error';
        })
        .finally(() => this.scheduleDraw());
    }
    if (isNew && p.dimension === this.dim) {
      this.updateOverlay();
      this.updateStatus();
    }
    if (p.dimension === this.dim) this.scheduleDraw();
  }

  // ---------- Marcadores ----------
  markerList() {
    const out = [];
    const sp = this.info?.spawn;
    if (sp && sp.dimension === this.dim) out.push({ kind: 'spawn', x: sp.x + 0.5, z: sp.z + 0.5, label: t('worldmap.spawn'), title: `${t('worldmap.spawnFull')} · ${t('worldmap.coords', { x: fmtInt(sp.x), z: fmtInt(sp.z) })}` });
    (this.info?.players || []).forEach((p, i) => {
      if (p.dimension !== this.dim) return;
      const name = playerName(p);
      out.push({ kind: 'player', x: p.x, z: p.z, label: name, player: p, color: this.playerColors[i % this.playerColors.length], title: `${name} · ${t('worldmap.coords', { x: fmtInt(p.x), z: fmtInt(p.z) })}` });
    });
    return out;
  }

  buildMarkers() {
    this.markerDim = this.dim;
    this.markerEls = this.markerList().map((m) => {
      const el =
        m.kind === 'spawn'
          ? h(
              'button',
              { class: 'wm-marker wm-m-spawn', type: 'button', title: m.title, 'aria-label': m.title, onclick: () => this.centerOn(m.x, m.z) },
              h('span', { class: 'wm-pin' }, icon('flag')),
              h('span', { class: 'wm-mlabel' }, m.label),
            )
          : h(
              'button',
              { class: 'wm-marker wm-m-player', type: 'button', title: m.title, 'aria-label': m.title, style: { '--pc': m.color }, onclick: () => this.centerOn(m.x, m.z) },
              h('span', { class: 'wm-face' }, avatarImg(m.player.name || m.player.uuid || 'MHF_Steve', 32, 'wm-avatar')),
              h('span', { class: 'wm-mlabel' }, m.label),
            );
      return { ...m, el };
    });
    mount(this.markersEl, this.markerEls.map((m) => m.el));
  }

  updateMarkers() {
    if (this.markerDim !== this.dim) this.buildMarkers();
    const v = this.view();
    const show = Boolean(v) && this.prefs.markers && this.hasData();
    this.markersEl.hidden = !show;
    if (!show) return;
    const s = ZOOMS[v.zi];
    // Muy lejos los nombres se pisan: solo se ven al pasar el mouse
    this.markersEl.classList.toggle('wm-far', s < 0.5);
    for (const m of this.markerEls) {
      const x = (m.x - v.x) * s + this.cssW / 2;
      const y = (m.z - v.z) * s + this.cssH / 2;
      const inside = x > -40 && y > -40 && x < this.cssW + 40 && y < this.cssH + 40;
      m.el.hidden = !inside;
      if (inside) m.el.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
    }
  }

  // ---------- Coordenadas y escala ----------
  blockAt(sx, sy) {
    const v = this.view();
    const s = ZOOMS[v.zi];
    return { x: Math.floor(v.x + (sx - this.cssW / 2) / s), z: Math.floor(v.z + (sy - this.cssH / 2) / s) };
  }

  updateCoords() {
    const v = this.view();
    if (!v || !this.hasData()) {
      this.coordsEl.hidden = true;
      return;
    }
    this.coordsEl.hidden = false;
    const b = this.hover ? this.blockAt(this.hover.sx, this.hover.sy) : { x: Math.floor(v.x), z: Math.floor(v.z) };
    this.coordBlock = b;
    this.coordMain.textContent = t('worldmap.coords', { x: fmtInt(b.x), z: fmtInt(b.z) });
    this.coordSub.textContent = this.hover ? t('worldmap.chunkRegion', { cx: b.x >> 4, cz: b.z >> 4, rx: b.x >> 9, rz: b.z >> 9 }) : t('worldmap.center');
  }

  copyCoords() {
    const b = this.coordBlock;
    if (b) copyText(`${b.x} ${b.z}`, t('worldmap.coordsCopied'));
  }

  updateScale() {
    const v = this.view();
    if (!v || !this.hasData()) {
      this.scaleEl.hidden = true;
      return;
    }
    this.scaleEl.hidden = false;
    const s = ZOOMS[v.zi];
    const blocks = SCALES.find((n) => n * s >= 64) || SCALES[SCALES.length - 1];
    this.scaleBar.style.width = `${Math.round(blocks * s)}px`;
    this.scaleLabel.textContent = t('worldmap.blocks', { count: blocks });
    this.zoomInBtn.disabled = v.zi >= ZOOMS.length - 1;
    this.zoomOutBtn.disabled = v.zi <= 0;
  }

  // ---------- Navegacion ----------
  zoomAt(zi, sx, sy) {
    const v = this.view();
    if (!v) return;
    const next = Math.max(0, Math.min(ZOOMS.length - 1, zi));
    if (next === v.zi) return;
    const s0 = ZOOMS[v.zi];
    const s1 = ZOOMS[next];
    const wx = v.x + (sx - this.cssW / 2) / s0;
    const wz = v.z + (sy - this.cssH / 2) / s0;
    v.zi = next;
    v.x = wx - (sx - this.cssW / 2) / s1;
    v.z = wz - (sy - this.cssH / 2) / s1;
    this.scheduleDraw();
  }

  zoomBy(d) {
    const v = this.view();
    if (v) this.zoomAt(v.zi + d, this.cssW / 2, this.cssH / 2);
  }

  centerOn(x, z, zi) {
    const v = this.view();
    if (!v) return;
    v.x = x;
    v.z = z;
    if (zi !== undefined) v.zi = zi;
    this.scheduleDraw();
  }

  centerSpawn() {
    const sp = this.info?.spawn;
    if (!sp) return;
    if (sp.dimension !== this.dim && this.regionSets.get(sp.dimension)?.size) this.setDimension(sp.dimension, { x: sp.x + 0.5, z: sp.z + 0.5 });
    else this.centerOn(sp.x + 0.5, sp.z + 0.5, Math.max(this.view()?.zi ?? DEFAULT_ZOOM, DEFAULT_ZOOM));
  }

  goToPlayer(p) {
    this.closeMenu();
    if (p.dimension !== this.dim && this.info?.dimensions?.some((d) => d.id === p.dimension)) this.setDimension(p.dimension, { x: p.x, z: p.z });
    else this.centerOn(p.x, p.z, Math.max(this.view()?.zi ?? DEFAULT_ZOOM, DEFAULT_ZOOM));
    this.canvas.focus({ preventScroll: true });
  }

  updatePlayerButton() {
    const players = this.info?.players || [];
    const sp = this.info?.spawn;
    this.spawnBtn.disabled = !sp;
    const spawnLabel = sp ? t('worldmap.centerSpawn') : t('worldmap.noSpawn');
    this.spawnBtn.title = spawnLabel;
    this.spawnBtn.setAttribute('aria-label', spawnLabel);
    this.playerBtn.disabled = !players.length;
    const label = !players.length ? t('worldmap.noPlayers') : players.length === 1 ? t('worldmap.centerPlayer', { name: playerName(players[0]) }) : t('worldmap.centerPlayers');
    this.playerBtn.title = label;
    this.playerBtn.setAttribute('aria-label', label);
  }

  onPlayerButton(e) {
    e.stopPropagation();
    const players = this.info?.players || [];
    if (!players.length) return;
    if (players.length === 1) {
      this.goToPlayer(players[0]);
      return;
    }
    if (this.menu) {
      this.closeMenu();
      return;
    }
    const items = players.map((p) =>
      h(
        'button',
        { class: 'wm-menu-item', type: 'button', role: 'menuitem', tabindex: '-1', onclick: () => this.goToPlayer(p) },
        avatarImg(p.name || p.uuid || 'MHF_Steve', 32, 'wm-menu-avatar'),
        h(
          'span',
          { class: 'wm-menu-main' },
          h('span', { class: 'wm-menu-name' }, h('span', { class: 'ellipsis' }, playerName(p)), p.host ? h('span', { class: 'badge accent' }, t('worldmap.host')) : null),
          h('span', { class: 'wm-menu-sub' }, `${dimLabel(p.dimension)} · ${t('worldmap.coords', { x: fmtInt(p.x), z: fmtInt(p.z) })}`),
        ),
      ),
    );
    this.menu = h('div', { class: 'wm-menu', role: 'menu', 'aria-label': t('worldmap.playersTitle') }, h('div', { class: 'wm-menu-title', 'aria-hidden': 'true' }, t('worldmap.playersTitle')), items);
    // Flechas, Inicio y Fin recorren la lista; Tab sale del menu
    this.menu.addEventListener('keydown', (ev) => {
      const i = items.indexOf(document.activeElement);
      let next = null;
      if (ev.key === 'ArrowDown') next = items[(i + 1) % items.length];
      else if (ev.key === 'ArrowUp') next = items[(i - 1 + items.length) % items.length];
      else if (ev.key === 'Home') next = items[0];
      else if (ev.key === 'End') next = items.at(-1);
      else if (ev.key === 'Tab') this.closeMenu();
      if (next) {
        ev.preventDefault();
        next.focus();
      }
    });
    this.stage.append(this.menu);
    this.playerBtn.setAttribute('aria-expanded', 'true');
    items[0]?.focus();
    const outside = (ev) => {
      if (this.menu && !this.menu.contains(ev.target) && ev.target !== this.playerBtn) this.closeMenu();
    };
    this.menuOff = () => document.removeEventListener('pointerdown', outside, true);
    document.addEventListener('pointerdown', outside, true);
  }

  closeMenu() {
    if (!this.menu) return;
    this.menu.remove();
    this.menu = null;
    this.playerBtn?.setAttribute('aria-expanded', 'false');
    this.menuOff?.();
    this.menuOff = null;
  }

  togglePref(key) {
    this.prefs[key] = !this.prefs[key];
    const btn = key === 'grid' ? this.gridBtn : this.markersBtn;
    btn.setAttribute('aria-pressed', String(this.prefs[key]));
    if (key === 'markers') mount(btn, icon(this.prefs.markers ? 'eye' : 'eyeOff'));
    store.setSettings({ mapviewer: { grid: this.prefs.grid, markers: this.prefs.markers } }).catch(() => {});
    this.scheduleDraw();
  }

  // ---------- Renderizar todo ----------
  async renderAll() {
    if (this.renderingAll || !this.dim) return;
    this.renderingAll = true;
    const dim = this.dim;
    this.renderBtn.disabled = true;
    this.showProgress(0, this.regionSets.get(dim)?.size || 0, true);
    try {
      const res = await api.invoke('mapviewer:renderAll', this.instanceId, this.folder, dim);
      if (this.closed) return;
      if (res?.rendered) ok(t('worldmap.renderDone'), t('worldmap.renderDoneText', { count: res.rendered }));
      else ok(t('worldmap.renderDone'), t('worldmap.renderUpToDate'));
      if (res?.failed) this.updateStatus();
    } catch (err) {
      if (!this.closed && !/cancel/i.test(err?.message || '')) fail(t('worldmap.renderFailed'), err);
    } finally {
      this.renderingAll = false;
      this.renderTask = null;
      if (!this.closed) {
        this.progressEl.hidden = true;
        this.setButtonsEnabled(true);
        this.scheduleDraw();
      }
    }
  }

  onTask(task) {
    const meta = task?.meta?.mapviewer;
    if (this.closed || !meta || meta.instanceId !== this.instanceId || meta.world !== this.folder) return;
    if (task.state !== 'running') return;
    this.renderTask = task;
    const m = /(\d+)\D+(\d+)/.exec(task.detail || '');
    const done = m ? Number(m[1]) : 0;
    const total = m ? Number(m[2]) : 0;
    this.showProgress(done, total, !m, task.progress);
  }

  showProgress(done, total, starting, progress) {
    this.progressEl.hidden = false;
    this.progressText.textContent = starting ? t('worldmap.renderingStart') : t('worldmap.renderingAll', { done, total });
    const pct = progress !== undefined && progress !== null ? progress : total ? done / total : 0;
    this.progressFill.style.width = `${Math.round(pct * 100)}%`;
    this.progressCancel.hidden = !this.renderTask;
  }

  cancelRenderAll() {
    if (this.renderTask) api.tasks.cancel(this.renderTask.id).catch(() => {});
  }

  // ---------- Exportar ----------
  async ensureTilesFor(rx0, rz0, rx1, rz1) {
    const set = this.regionSets.get(this.dim) || new Set();
    const jobs = [];
    for (let rz = rz0; rz <= rz1; rz++) {
      for (let rx = rx0; rx <= rx1; rx++) {
        if (!set.has(`${rx},${rz}`)) continue;
        const key = keyOf(this.dim, rx, rz);
        let tile = this.tiles.get(key);
        if (tile?.img || tile?.state === 'empty' || tile?.state === 'error') continue;
        if (!tile) {
          tile = { key, dim: this.dim, rx, rz, state: 'pending', img: null, url: null, low: null, used: performance.now() };
          this.tiles.set(key, tile);
        }
        jobs.push(
          (async () => {
            for (let i = 0; i < 200 && tile.state === 'loading'; i++) await new Promise((r) => setTimeout(r, 100));
            if (tile.img || tile.state === 'empty') return;
            const res = await api.invoke('mapviewer:tile', this.instanceId, this.folder, tile.dim, rx, rz);
            if (res?.url) await this.setTileImage(tile, res.url);
            else tile.state = 'empty';
          })().catch(() => {}),
        );
      }
    }
    await Promise.all(jobs);
  }

  async exportPng() {
    const v = this.view();
    if (!v || !this.info) return;
    const oldLabel = [...this.exportBtn.childNodes];
    const done = setBusy(this.exportBtn);
    mount(this.exportBtn, icon('download'), t('worldmap.exporting'));
    this.refreshColors();
    try {
      const s = ZOOMS[v.zi];
      const bw = this.cssW / s;
      const bh = this.cssH / s;
      // Al menos 1 pixel por bloque (o la escala de la vista si esta acercada), hasta 4096 px de lado
      const es = Math.min(Math.max(1, s), EXPORT_MAX / Math.max(bw, bh));
      const outW = Math.max(1, Math.round(bw * es));
      const outH = Math.max(1, Math.round(bh * es));
      const x0 = v.x - bw / 2;
      const z0 = v.z - bh / 2;
      const rx0 = Math.floor(x0 / TILE);
      const rz0 = Math.floor(z0 / TILE);
      const rx1 = Math.floor((x0 + bw) / TILE);
      const rz1 = Math.floor((z0 + bh) / TILE);
      await this.ensureTilesFor(rx0, rz0, rx1, rz1);
      if (this.closed) return;
      const c = document.createElement('canvas');
      c.width = outW;
      c.height = outH;
      const g = c.getContext('2d');
      g.fillStyle = this.colors.exportBg;
      g.fillRect(0, 0, outW, outH);
      g.imageSmoothingEnabled = es < 1;
      g.imageSmoothingQuality = 'high';
      for (let rz = rz0; rz <= rz1; rz++) {
        for (let rx = rx0; rx <= rx1; rx++) {
          const tile = this.tiles.get(keyOf(this.dim, rx, rz));
          if (!tile?.img) continue;
          const X0 = Math.round((rx * TILE - x0) * es);
          const Z0 = Math.round((rz * TILE - z0) * es);
          const X1 = Math.round(((rx + 1) * TILE - x0) * es);
          const Z1 = Math.round(((rz + 1) * TILE - z0) * es);
          g.drawImage(tile.img, X0, Z0, X1 - X0, Z1 - Z0);
        }
      }
      if (this.prefs.markers) this.drawExportMarkers(g, x0, z0, es, outW, outH);
      this.drawCaption(g, outW, outH, v);
      const blob = await new Promise((resolve) => c.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error(t('worldmap.exportFailed'));
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const name = `${this.info.world?.name || this.folder} - ${dimLabel(this.dim)}`;
      const res = await api.invoke('mapviewer:saveImage', bytes, name);
      if (res?.path) {
        this.lastExport = res.path;
        ok(t('worldmap.exported'), res.path);
        this.updateStatus();
      }
    } catch (err) {
      fail(t('worldmap.exportFailed'), err);
    } finally {
      if (!this.closed) {
        mount(this.exportBtn, ...oldLabel);
        done();
        this.setButtonsEnabled(true);
      }
    }
  }

  drawExportMarkers(g, x0, z0, es, W, H) {
    const scale = Math.max(1, Math.min(2.5, Math.max(W, H) / 1600));
    g.font = `700 ${Math.round(13 * scale)}px Outfit, system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'top';
    for (const m of this.markerList()) {
      const x = (m.x - x0) * es;
      const y = (m.z - z0) * es;
      if (x < -20 || y < -20 || x > W + 20 || y > H + 20) continue;
      const r = (m.kind === 'spawn' ? 7 : 8) * scale;
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fillStyle = m.kind === 'spawn' ? this.colors.spawn : m.color;
      g.fill();
      g.lineWidth = 2.5 * scale;
      g.strokeStyle = this.colors.ink;
      g.stroke();
      const label = m.label;
      const tw = g.measureText(label).width;
      const pad = 5 * scale;
      const ly = y + r + 5 * scale;
      g.fillStyle = this.colors.labelBg;
      g.fillRect(x - tw / 2 - pad, ly - 2 * scale, tw + pad * 2, 18 * scale);
      g.fillStyle = this.colors.ink;
      g.fillText(label, x, ly);
    }
  }

  drawCaption(g, W, H, v) {
    const scale = Math.max(1, Math.min(2.5, Math.max(W, H) / 1600));
    const text = t('worldmap.exportCaption', { world: this.info.world?.name || this.folder, dimension: dimLabel(this.dim), x: fmtInt(v.x), z: fmtInt(v.z) });
    g.font = `600 ${Math.round(12 * scale)}px Outfit, system-ui, sans-serif`;
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    const tw = g.measureText(text).width;
    const pad = 8 * scale;
    const hgt = 24 * scale;
    g.fillStyle = this.colors.captionBg;
    g.fillRect(10 * scale, H - hgt - 10 * scale, tw + pad * 2, hgt);
    g.fillStyle = this.colors.caption;
    g.fillText(text, 10 * scale + pad, H - 10 * scale - hgt / 2);
  }
}
