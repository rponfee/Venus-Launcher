// Mapa del visor de semillas: canvas con arrastre y zoom, pedazos de biomas calculados en los hilos de pool.js, estructuras
// por region, slime chunks, punto de aparicion y fortalezas. Sigue la forma de features/worldmap.js.
import { h, icon } from '../../ui.js';
import { t } from '../../i18n.js';
import { GenPool } from './pool.js';
import { BIOME_RGBA } from './gen/biomes.js';
import { STRUCTURES, isSlimeChunk, seedLimbs } from './gen/structures.js';
import { structSprite } from './icons.js';

const T = (key, vars) => t(`seeds.${key}`, vars);
const TILE = 128; // igual que gen/world.js, sin cargarlo en este hilo
// Pixeles por bloque. De 1/4 para arriba cada muestra 1:4 se ve mas grande
const ZOOMS = [1 / 256, 1 / 128, 1 / 64, 1 / 32, 1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2, 4];
const DEFAULT_ZOOM = 5;
const MAX_LEVEL = 6;
const MAX_TILES = 900;
const SLIME_TILE = 32; // chunks por lado de cada capa de slime
const MAX_SLIME = 300;
// Una estructura se muestra si su region mide al menos esto en pantalla; mas lejos serian puntos encimados
const MIN_REGION_PX = 14;
const STRUCT_BATCH = 48;
const STRONG_BATCH = 6;
const SPRITE = 22; // pixeles CSS
const HIT = 14;
const SLIME_MIN_ZOOM = 5;
const WORLD_LIMIT = 30000000;

const levelForZoom = (zi) => {
  const ppb = ZOOMS[zi];
  if (ppb >= 1 / 4) return 0;
  return Math.min(MAX_LEVEL, Math.round(Math.log2(1 / (4 * ppb))));
};

export class SeedMap {
  // onHover({ x, z, biome }), onSelect(marcador o null), onView({ biomes, structures, hidden }) resumen de lo que se ve
  constructor({ onHover, onSelect, onView }) {
    this.onHover = onHover;
    this.onSelect = onSelect;
    this.onView = onView;
    this.view = { x: 0, z: 0, zi: DEFAULT_ZOOM };
    this.world = null;
    this.filters = new Set();
    this.slimeOn = false;
    this.doubtOn = true;
    this.tiles = new Map();
    this.pending = new Set();
    this.failed = new Set();
    this.slime = new Map();
    this.structs = new Map();
    this.spawn = null;
    this.spawnState = 'none';
    this.strong = [];
    this.strongState = 'none';
    this.planCoarse = [];
    this.planFine = [];
    this.planStructs = [];
    this.hoverJob = null;
    this.selected = null;
    this.drawn = [];
    this.sprites = new Map();
    this.hover = null;
    this.drag = null;
    this.raf = 0;
    this.resizeRaf = 0;
    this.closed = false;
    this.dpr = 1;
    this.cssW = 0;
    this.cssH = 0;
    this.wheelAcc = 0;
    this.lastSummary = 0;
    this.summaryTimer = 0;
    this.hoverTimer = 0;
    this.build();
    this.pool = new GenPool({ nextJob: (i, size) => this.nextJob(i, size), onReply: (msg) => this.onReply(msg) });
  }

  // ---------- Estructura ----------
  build() {
    this.canvas = h('canvas', { class: 'sd-canvas', tabindex: 0, role: 'img', 'aria-label': T('canvasLabel'), title: T('canvasHint') });
    this.ctx = this.canvas.getContext('2d', { alpha: false });
    const tool = (name, label, onclick) => h('button', { class: 'sd-tool', type: 'button', title: label, 'aria-label': label, onclick }, icon(name));
    this.zoomIn = tool('zoomIn', T('zoomIn'), () => this.zoomBy(1));
    this.zoomOut = tool('zoomOut', T('zoomOut'), () => this.zoomBy(-1));
    this.spawnBtn = tool('sd-spawn', T('centerSpawn'), () => this.centerOnSpawn());
    this.originBtn = tool('crosshair', T('centerOrigin'), () => this.centerOn(0, 0));
    this.tools = h('div', { class: 'sd-panel sd-tools' }, this.zoomIn, this.zoomOut, h('span', { class: 'sd-tool-sep', 'aria-hidden': 'true' }), this.spawnBtn, this.originBtn);
    this.scaleEl = h('div', { class: 'sd-panel sd-scale' });
    this.busyEl = h('div', { class: 'sd-panel sd-busy', role: 'status', hidden: true }, h('div', { class: 'spinner', 'aria-hidden': 'true' }), h('span', {}, T('computing')));
    this.pop = h('div', { class: 'sd-pop-slot' });
    this.el = h('div', { class: 'sd-stage' }, this.canvas, this.tools, this.scaleEl, this.busyEl, this.pop);
    this.bind();
    // En el cuadro siguiente: redibujar dentro del aviso puede dar un error de bucle en el ResizeObserver
    this.resizeObserver = new ResizeObserver(() => {
      cancelAnimationFrame(this.resizeRaf);
      this.resizeRaf = requestAnimationFrame(() => this.resize());
    });
    this.resizeObserver.observe(this.el);
  }

  bind() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      c.setPointerCapture(e.pointerId);
      this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, vx: this.view.x, vz: this.view.z, moved: false };
      this.el.classList.add('dragging');
    });
    c.addEventListener('pointermove', (e) => {
      const r = c.getBoundingClientRect();
      this.hover = { sx: e.clientX - r.left, sy: e.clientY - r.top };
      if (this.drag && this.drag.id === e.pointerId) {
        const dx = e.clientX - this.drag.x;
        const dy = e.clientY - this.drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) this.drag.moved = true;
        const s = ZOOMS[this.view.zi];
        this.view.x = this.drag.vx - dx / s;
        this.view.z = this.drag.vz - dy / s;
        this.scheduleDraw();
      }
      this.updateHover();
    });
    const endDrag = (e) => {
      if (!this.drag || this.drag.id !== e.pointerId) return;
      const moved = this.drag.moved;
      this.drag = null;
      this.el.classList.remove('dragging');
      try {
        c.releasePointerCapture(e.pointerId);
      } catch {
        /* ya liberado */
      }
      if (!moved && e.type === 'pointerup') this.clickAt(e);
    };
    c.addEventListener('pointerup', endDrag);
    c.addEventListener('pointercancel', endDrag);
    c.addEventListener('pointerleave', () => {
      if (this.drag) return;
      this.hover = null;
      this.onHover(null);
    });
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.wheelAcc += e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY;
        if (Math.abs(this.wheelAcc) < 50) return;
        const dir = this.wheelAcc < 0 ? 1 : -1;
        this.wheelAcc = 0;
        const r = c.getBoundingClientRect();
        this.zoomAt(this.view.zi + dir, e.clientX - r.left, e.clientY - r.top);
      },
      { passive: false },
    );
    c.addEventListener('dblclick', (e) => {
      const r = c.getBoundingClientRect();
      this.zoomAt(this.view.zi + (e.shiftKey ? -1 : 1), e.clientX - r.left, e.clientY - r.top);
    });
    c.addEventListener('keydown', (e) => {
      const step = 90 / ZOOMS[this.view.zi];
      const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      if (moves[e.key]) {
        this.view.x += moves[e.key][0];
        this.view.z += moves[e.key][1];
        this.scheduleDraw();
        e.preventDefault();
      } else if (e.key === '+' || e.key === '=') {
        this.zoomBy(1);
        e.preventDefault();
      } else if (e.key === '-' || e.key === '_') {
        this.zoomBy(-1);
        e.preventDefault();
      } else if (e.key === 'Escape' && this.selected) {
        this.select(null);
        e.stopPropagation();
      }
    });
  }

  // ---------- Mundo ----------
  setWorld({ seed, version, dim, y }) {
    this.world = { seed: String(seed), version, dim, y };
    this.limbs = seedLimbs(BigInt(seed));
    this.bgColor = null; // el tema se puede haber cambiado
    this.tiles.clear();
    this.pending.clear();
    this.failed.clear();
    this.slime.clear();
    this.structs.clear();
    this.planCoarse = [];
    this.planFine = [];
    this.planStructs = [];
    this.hoverJob = null;
    this.spawn = null;
    this.spawnState = dim === 0 ? 'wanted' : 'none';
    this.strong = [];
    this.strongState = dim === 0 ? 'wanted' : 'none';
    this.select(null);
    this.pool.setWorld({ seed: this.world.seed, version, dim });
    this.scheduleDraw();
  }

  setY(y) {
    // Otro mundo para los hilos: asi lo que este en camino con la altura anterior se descarta
    if (this.world && this.world.y !== y) this.setWorld({ ...this.world, y });
  }

  setFilters(types) {
    this.filters = new Set(types);
    if (this.selected && this.selected.kind !== 'spawn' && !this.filters.has(this.selected.type)) this.select(null);
    this.scheduleDraw();
  }

  setSlime(on) {
    this.slimeOn = on;
    this.scheduleDraw();
  }

  setDoubtful(on) {
    this.doubtOn = on;
    if (!on && this.selected?.doubt) this.select(null);
    this.scheduleDraw();
  }

  // ---------- Dibujo ----------
  resize() {
    if (this.closed) return;
    const w = this.el.clientWidth;
    const hgt = this.el.clientHeight;
    if (!w || !hgt) return;
    this.dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    this.cssW = w;
    this.cssH = hgt;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(hgt * this.dpr);
    this.sprites.clear();
    this.draw();
  }

  scheduleDraw() {
    if (this.closed || this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.draw();
    });
  }

  tileSpan(level) {
    return TILE * 4 * 2 ** level;
  }

  draw() {
    if (this.closed || !this.canvas.width || !this.world) return;
    const g = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const v = this.view;
    // Hasta el borde del mundo: mas alla no hay nada que calcular
    v.x = Math.max(-WORLD_LIMIT, Math.min(WORLD_LIMIT, v.x));
    v.z = Math.max(-WORLD_LIMIT, Math.min(WORLD_LIMIT, v.z));
    const ppb = ZOOMS[v.zi];
    const s = ppb * this.dpr;
    const level = levelForZoom(v.zi);
    const span = this.tileSpan(level);
    const x0 = v.x - W / 2 / s;
    const z0 = v.z - H / 2 / s;
    const x1 = v.x + W / 2 / s;
    const z1 = v.z + H / 2 / s;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.imageSmoothingEnabled = false;
    g.fillStyle = this.backdrop();
    g.fillRect(0, 0, W, H);

    // Biomas: si falta un pedazo se usa otro nivel ya calculado, escalado
    const tx0 = Math.floor(x0 / span);
    const tx1 = Math.floor(x1 / span);
    const tz0 = Math.floor(z0 / span);
    const tz1 = Math.floor(z1 / span);
    const fine = [];
    const now = performance.now();
    for (let tz = tz0; tz <= tz1; tz++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const X0 = Math.round((tx * span - v.x) * s + W / 2);
        const Z0 = Math.round((tz * span - v.z) * s + H / 2);
        const X1 = Math.round(((tx + 1) * span - v.x) * s + W / 2);
        const Z1 = Math.round(((tz + 1) * span - v.z) * s + H / 2);
        const key = `${level}|${tx}|${tz}`;
        const tile = this.tiles.get(key);
        if (tile) {
          tile.used = now;
          g.drawImage(tile.canvas, X0, Z0, X1 - X0, Z1 - Z0);
        } else {
          this.drawFallback(level, tx, tz, X0, Z0, X1 - X0, Z1 - Z0, now);
          if (!this.pending.has(key) && !this.failed.has(key)) fine.push({ key, level, tx, tz, dist: Math.hypot((tx + 0.5) * span - v.x, (tz + 0.5) * span - v.z) });
        }
      }
    }
    fine.sort((a, b) => a.dist - b.dist);
    this.planFine = fine;
    this.planCoarse = this.coarsePlan(level, x0, z0, x1, z1);

    if (this.slimeOn && this.world.dim === 0 && v.zi >= SLIME_MIN_ZOOM) this.drawSlime(g, s, W, H, x0, z0, x1, z1);
    this.drawMarkers(g, s, W, H, x0, z0, x1, z1);
    this.evict();
    this.updateChrome();
    this.positionPop();
    this.scheduleSummary();
    this.pool.pump();
  }

  backdrop() {
    if (!this.bgColor) {
      const probe = h('span', { style: { color: 'var(--bg-0)', position: 'absolute', visibility: 'hidden' } });
      document.body.append(probe);
      this.bgColor = getComputedStyle(probe).color;
      probe.remove();
    }
    return this.bgColor;
  }

  // Una vista gruesa de toda la pantalla, dos niveles mas arriba: se calcula primero y aparece enseguida
  coarsePlan(level, x0, z0, x1, z1) {
    const coarse = Math.min(MAX_LEVEL, level + 2);
    if (coarse === level) return [];
    const span = this.tileSpan(coarse);
    const out = [];
    for (let tz = Math.floor(z0 / span); tz <= Math.floor(z1 / span); tz++) {
      for (let tx = Math.floor(x0 / span); tx <= Math.floor(x1 / span); tx++) {
        const key = `${coarse}|${tx}|${tz}`;
        if (this.tiles.has(key)) this.tiles.get(key).used = performance.now();
        else if (!this.pending.has(key) && !this.failed.has(key)) out.push({ key, level: coarse, tx, tz });
      }
    }
    return out;
  }

  drawFallback(level, tx, tz, X, Z, W, H, now) {
    const g = this.ctx;
    // Primero un nivel mas grueso: un trozo escalado
    for (let up = 1; up <= 3 && level + up <= MAX_LEVEL; up++) {
      const f = 2 ** up;
      const ptx = Math.floor(tx / f);
      const ptz = Math.floor(tz / f);
      const parent = this.tiles.get(`${level + up}|${ptx}|${ptz}`);
      if (!parent) continue;
      parent.used = now;
      const size = TILE / f;
      g.drawImage(parent.canvas, (tx - ptx * f) * size, (tz - ptz * f) * size, size, size, X, Z, W, H);
      return;
    }
    // Si se alejo el zoom, los pedazos mas finos que ya estaban
    if (level > 0) {
      for (let j = 0; j < 2; j++) {
        for (let i = 0; i < 2; i++) {
          const child = this.tiles.get(`${level - 1}|${tx * 2 + i}|${tz * 2 + j}`);
          if (!child) continue;
          child.used = now;
          const hw = W / 2;
          const hh = H / 2;
          g.drawImage(child.canvas, X + i * hw, Z + j * hh, hw, hh);
        }
      }
    }
  }

  drawSlime(g, s, W, H, x0, z0, x1, z1) {
    const span = SLIME_TILE * 16;
    for (let tz = Math.floor(z0 / span); tz <= Math.floor(z1 / span); tz++) {
      for (let tx = Math.floor(x0 / span); tx <= Math.floor(x1 / span); tx++) {
        const X0 = Math.round((tx * span - this.view.x) * s + W / 2);
        const Z0 = Math.round((tz * span - this.view.z) * s + H / 2);
        const X1 = Math.round(((tx + 1) * span - this.view.x) * s + W / 2);
        const Z1 = Math.round(((tz + 1) * span - this.view.z) * s + H / 2);
        g.drawImage(this.slimeLayer(tx, tz), X0, Z0, X1 - X0, Z1 - Z0);
      }
    }
  }

  slimeLayer(tx, tz) {
    const key = `${tx}|${tz}`;
    let c = this.slime.get(key);
    if (c) return c;
    if (this.slime.size >= MAX_SLIME) this.slime.clear();
    c = document.createElement('canvas');
    c.width = SLIME_TILE;
    c.height = SLIME_TILE;
    const g = c.getContext('2d');
    g.fillStyle = 'rgba(70, 255, 110, 0.62)';
    const { hi, lo } = this.limbs;
    for (let j = 0; j < SLIME_TILE; j++) {
      for (let i = 0; i < SLIME_TILE; i++) {
        if (isSlimeChunk(hi, lo, tx * SLIME_TILE + i, tz * SLIME_TILE + j)) g.fillRect(i, j, 1, 1);
      }
    }
    this.slime.set(key, c);
    return c;
  }

  sprite(type) {
    const px = Math.round(SPRITE * this.dpr);
    let c = this.sprites.get(type);
    if (!c) {
      c = structSprite(type, px);
      this.sprites.set(type, c);
    }
    return c;
  }

  drawMarkers(g, s, W, H, x0, z0, x1, z1) {
    const drawn = [];
    const hidden = [];
    const v = this.view;
    const put = (m) => {
      if (m.x < x0 - 30 / s || m.x > x1 + 30 / s || m.z < z0 - 30 / s || m.z > z1 + 30 / s) return;
      const px = (m.x - v.x) * s + W / 2;
      const py = (m.z - v.z) * s + H / 2;
      const size = Math.round(SPRITE * this.dpr);
      // Las dudosas se ven apagadas: la estimacion las descarta, pero pueden estar
      g.globalAlpha = m.doubt ? 0.5 : 1;
      g.drawImage(this.sprite(m.type), Math.round(px - size / 2), Math.round(py - size / 2));
      g.globalAlpha = 1;
      drawn.push({ ...m, px: px / this.dpr, py: py / this.dpr });
    };
    this.planStructs = [];
    for (const type of this.filters) {
      if (type === 'stronghold' || type === 'spawn') continue;
      const cfg = STRUCTURES[type];
      if (!cfg) continue;
      const span = cfg.size * 16;
      if (span * ZOOMS[v.zi] < MIN_REGION_PX) {
        hidden.push(type);
        continue;
      }
      let cache = this.structs.get(type);
      if (!cache) {
        cache = new Map();
        this.structs.set(type, cache);
      }
      // Una region de margen: la estructura de la region de al lado puede caer dentro de la vista
      const rx0 = Math.floor(x0 / span) - 1;
      const rx1 = Math.floor(x1 / span) + 1;
      const rz0 = Math.floor(z0 / span) - 1;
      const rz1 = Math.floor(z1 / span) + 1;
      const missing = [];
      for (let rz = rz0; rz <= rz1; rz++) {
        for (let rx = rx0; rx <= rx1; rx++) {
          const key = `${rx},${rz}`;
          const res = cache.get(key);
          if (res === undefined) missing.push(rx, rz);
          else if (res && (this.doubtOn || !res.doubt)) put({ kind: 'struct', type, x: res.x, z: res.z, biome: res.biome, doubt: res.doubt, id: `${type}:${key}` });
        }
      }
      for (let i = 0; i < missing.length; i += STRUCT_BATCH * 2) this.planStructs.push({ t: 'structs', type, regions: missing.slice(i, i + STRUCT_BATCH * 2) });
    }
    if (this.filters.has('stronghold')) this.strong.forEach((p, i) => put({ kind: 'stronghold', type: 'stronghold', x: p.x, z: p.z, id: `stronghold:${i}`, index: i + 1 }));
    if (this.spawn) put({ kind: 'spawn', type: 'spawn', x: this.spawn.x, z: this.spawn.z, id: 'spawn' });
    this.drawn = drawn;
    this.hiddenTypes = hidden;
    if (this.selected) {
      const m = drawn.find((d) => d.id === this.selected.id);
      if (m) {
        g.beginPath();
        g.arc(m.px * this.dpr, m.py * this.dpr, ((SPRITE + 7) / 2) * this.dpr, 0, Math.PI * 2);
        g.lineWidth = 2 * this.dpr;
        g.strokeStyle = '#fff';
        g.stroke();
      }
    }
  }

  // ---------- Trabajos ----------
  // Lo pide cada hilo al quedar libre. El orden es: lo del cursor, estructuras, aparicion, vista gruesa, fortalezas y detalle
  nextJob(index, size) {
    if (!this.world) return null;
    if (this.hoverJob) {
      const job = this.hoverJob;
      this.hoverJob = null;
      return job;
    }
    while (this.planStructs.length) {
      const job = this.planStructs.shift();
      const cache = this.structs.get(job.type);
      const regions = [];
      for (let i = 0; i < job.regions.length; i += 2) {
        const key = `${job.regions[i]},${job.regions[i + 1]}`;
        if (cache.get(key) !== undefined) continue;
        cache.set(key, null);
        regions.push(job.regions[i], job.regions[i + 1]);
      }
      if (regions.length) return { t: 'structs', type: job.type, regions };
    }
    if (this.spawnState === 'wanted') {
      this.spawnState = 'pending';
      return { t: 'spawn' };
    }
    const takeTile = (list) => {
      while (list.length) {
        const job = list.shift();
        if (this.tiles.has(job.key) || this.pending.has(job.key)) continue;
        this.pending.add(job.key);
        return { t: 'tile', key: job.key, level: job.level, tx: job.tx, tz: job.tz, y: this.world.y };
      }
      return null;
    };
    const coarse = takeTile(this.planCoarse);
    if (coarse) return coarse;
    // Las fortalezas guardan su estado en un hilo: siempre el primero
    const strongFirst = index === 0 && this.strongState === 'wanted' && size > 1;
    if (strongFirst) return { t: 'strong', count: STRONG_BATCH };
    const fine = takeTile(this.planFine);
    if (fine) return fine;
    if (index === 0 && this.strongState === 'wanted') return { t: 'strong', count: STRONG_BATCH };
    return null;
  }

  onReply(msg) {
    switch (msg.t) {
      case 'restart':
        this.pending.clear();
        for (const cache of this.structs.values()) cache.clear();
        if (this.spawnState === 'pending') this.spawnState = 'wanted';
        // Las fortalezas vuelven a empezar en el hilo nuevo
        if (this.strongState !== 'none') {
          this.strong = [];
          this.strongState = 'wanted';
        }
        break;
      case 'tile':
        this.pending.delete(msg.key);
        this.addTile(msg);
        break;
      case 'structs': {
        const cache = this.structs.get(msg.type);
        if (cache) {
          msg.results.forEach((res, i) => {
            cache.set(`${msg.regions[i * 2]},${msg.regions[i * 2 + 1]}`, res);
          });
        }
        break;
      }
      case 'strong':
        this.strong.push(...msg.list);
        if (msg.done) this.strongState = 'done';
        break;
      case 'spawn':
        this.spawn = msg.pos;
        this.spawnState = 'done';
        break;
      case 'biome':
        if (this.hoverCell && this.hoverCell.x === msg.x && this.hoverCell.z === msg.z) {
          this.hoverCell.biome = msg.id;
          this.onHover({ ...this.hoverCell });
        }
        return;
      case 'failed':
        if (msg.kind === 'tile') {
          this.pending.delete(msg.key);
          this.failed.add(msg.key);
        } else if (msg.kind === 'strong') this.strongState = 'done';
        else if (msg.kind === 'spawn') this.spawnState = 'done';
        break;
      default:
        return;
    }
    this.scheduleDraw();
  }

  addTile(msg) {
    const c = document.createElement('canvas');
    c.width = TILE;
    c.height = TILE;
    const g = c.getContext('2d');
    const img = g.createImageData(TILE, TILE);
    const px = new Uint32Array(img.data.buffer);
    const { ids } = msg;
    const seen = new Uint32Array(256);
    for (let i = 0; i < ids.length; i++) {
      px[i] = BIOME_RGBA[ids[i]];
      seen[ids[i]]++;
    }
    g.putImageData(img, 0, 0);
    const present = [];
    for (let i = 0; i < 256; i++) if (seen[i]) present.push(i, seen[i]);
    this.tiles.set(msg.key, { key: msg.key, level: msg.level, tx: msg.tx, tz: msg.tz, canvas: c, ids, present, used: performance.now() });
  }

  evict() {
    if (this.tiles.size <= MAX_TILES) return;
    const list = [...this.tiles.values()].sort((a, b) => a.used - b.used);
    for (const tile of list) {
      if (this.tiles.size <= MAX_TILES * 0.85) break;
      this.tiles.delete(tile.key);
    }
  }

  // ---------- Coordenadas, seleccion y resumen ----------
  blockAt(sx, sy) {
    const s = ZOOMS[this.view.zi];
    return { x: Math.floor(this.view.x + (sx - this.cssW / 2) / s), z: Math.floor(this.view.z + (sy - this.cssH / 2) / s) };
  }

  // Bioma del pixel, si su pedazo ya esta
  biomeFromTiles(x, z) {
    for (let level = levelForZoom(this.view.zi); level <= MAX_LEVEL; level++) {
      const span = this.tileSpan(level);
      const tx = Math.floor(x / span);
      const tz = Math.floor(z / span);
      const tile = this.tiles.get(`${level}|${tx}|${tz}`);
      if (!tile) continue;
      const cell = 4 * 2 ** level;
      const i = Math.floor((x - tx * span) / cell);
      const j = Math.floor((z - tz * span) / cell);
      return tile.ids[j * TILE + i];
    }
    return -1;
  }

  updateHover() {
    if (!this.hover || !this.world) return;
    const b = this.blockAt(this.hover.sx, this.hover.sy);
    const cell = { x: b.x, z: b.z, biome: this.biomeFromTiles(b.x, b.z) };
    this.hoverCell = cell;
    this.onHover({ ...cell });
    // Lejos, un pixel cubre varias celdas: se pregunta por la celda exacta cuando el cursor se queda quieto
    clearTimeout(this.hoverTimer);
    if (levelForZoom(this.view.zi) > 0 || cell.biome < 0) {
      this.hoverTimer = setTimeout(() => {
        if (this.closed || this.hoverCell !== cell) return;
        this.hoverJob = { t: 'biome', x: cell.x, z: cell.z, y: this.world.y };
        this.pool.pump();
      }, 140);
    }
  }

  clickAt(e) {
    const r = this.canvas.getBoundingClientRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    let best = null;
    let bestD = HIT;
    for (const m of this.drawn) {
      const d = Math.hypot(m.px - sx, m.py - sy);
      if (d <= bestD) {
        best = m;
        bestD = d;
      }
    }
    this.select(best);
  }

  select(marker) {
    this.selected = marker;
    this.onSelect(marker);
    this.scheduleDraw();
  }

  // El panel de la seleccion sigue a su marcador; se oculta si salio de la vista
  positionPop() {
    const el = this.pop.firstElementChild;
    if (!el) return;
    const m = this.selected && this.drawn.find((d) => d.id === this.selected.id);
    if (!m) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    const w = el.offsetWidth;
    const hgt = el.offsetHeight;
    const pad = 8;
    let x = m.px + 18;
    if (x + w > this.cssW - pad) x = m.px - w - 18;
    if (x < pad) x = pad;
    let y = m.py - hgt / 2;
    if (y < pad) y = pad;
    if (y + hgt > this.cssH - pad) y = this.cssH - hgt - pad;
    el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  updateChrome() {
    const v = this.view;
    this.zoomIn.disabled = v.zi >= ZOOMS.length - 1;
    this.zoomOut.disabled = v.zi <= 0;
    this.spawnBtn.disabled = !this.spawn;
    const ppb = ZOOMS[v.zi];
    this.scaleEl.textContent = ppb >= 1 ? T('scaleIn', { px: ppb }) : T('scaleOut', { blocks: 1 / ppb });
    const busy = this.pending.size > 0 || this.planFine.length > 0 || this.planCoarse.length > 0;
    this.busyEl.hidden = !busy;
  }

  // Lo que se ve, para la leyenda y la lista de estructuras (como mucho cuatro veces por segundo)
  scheduleSummary() {
    if (this.summaryTimer) return;
    this.summaryTimer = setTimeout(() => {
      this.summaryTimer = 0;
      if (!this.closed) this.summary();
    }, 250);
  }

  summary() {
    const v = this.view;
    const s = ZOOMS[v.zi];
    const level = levelForZoom(v.zi);
    const span = this.tileSpan(level);
    const x0 = v.x - this.cssW / 2 / s;
    const z0 = v.z - this.cssH / 2 / s;
    const x1 = v.x + this.cssW / 2 / s;
    const z1 = v.z + this.cssH / 2 / s;
    const totals = new Map();
    for (let tz = Math.floor(z0 / span); tz <= Math.floor(z1 / span); tz++) {
      for (let tx = Math.floor(x0 / span); tx <= Math.floor(x1 / span); tx++) {
        // Con el zoom recien cambiado, un nivel mas grueso alcanza para la leyenda
        let tile = this.tiles.get(`${level}|${tx}|${tz}`);
        for (let up = 1; !tile && up <= 2 && level + up <= MAX_LEVEL; up++) tile = this.tiles.get(`${level + up}|${tx >> up}|${tz >> up}`);
        if (!tile) continue;
        const p = tile.present;
        for (let i = 0; i < p.length; i += 2) totals.set(p[i], (totals.get(p[i]) || 0) + p[i + 1]);
      }
    }
    const biomes = [...totals].sort((a, b) => b[1] - a[1]).map(([id]) => id);
    const counts = {};
    for (const m of this.drawn) if (!m.doubt) counts[m.type] = (counts[m.type] || 0) + 1;
    const near = this.drawn
      .filter((m) => m.px >= 0 && m.py >= 0 && m.px <= this.cssW && m.py <= this.cssH)
      .map((m) => ({ ...m, d: Math.hypot(m.x - v.x, m.z - v.z) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 8);
    this.onView({ biomes, counts, near, hidden: this.hiddenTypes || [], strongLoading: this.strongState === 'wanted', slimeTooFar: this.slimeOn && this.world.dim === 0 && v.zi < SLIME_MIN_ZOOM });
  }

  // ---------- Navegacion ----------
  zoomAt(zi, sx, sy) {
    const v = this.view;
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
    this.zoomAt(this.view.zi + d, this.cssW / 2, this.cssH / 2);
  }

  centerOn(x, z, zi) {
    this.view.x = x;
    this.view.z = z;
    if (zi !== undefined) this.view.zi = zi;
    this.scheduleDraw();
  }

  centerOnSpawn() {
    if (this.spawn) this.centerOn(this.spawn.x, this.spawn.z);
  }

  // Entre Overworld y Nether las coordenadas se dividen o multiplican por 8
  rescale(f) {
    this.view.x *= f;
    this.view.z *= f;
  }

  destroy() {
    this.closed = true;
    cancelAnimationFrame(this.raf);
    cancelAnimationFrame(this.resizeRaf);
    clearTimeout(this.summaryTimer);
    clearTimeout(this.hoverTimer);
    this.resizeObserver?.disconnect();
    this.pool.destroy();
    this.tiles.clear();
    this.slime.clear();
  }
}
