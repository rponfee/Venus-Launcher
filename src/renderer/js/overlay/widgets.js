// Vista del overlay: dibuja los widgets (Voice Chat, mensajes, avisos, capturas, musica y contadores) sobre un escenario del
// tamano del juego. La usan la pagina del overlay (renderer/overlay.html, js/overlay/page.js) y la vista previa
// de Ajustes (features/overlay.js), con los mismos estilos (styles/overlay.css, clases .ovl-).
//   const view = new OverlayView(root, { tr, preview, onMove, onTweak, onReset, onDone, onSelect, isReduced })
//   view.setLayout(layout)  -> { widgets, accent, motion, editing, mode } (lo arma el proceso principal)
//   view.handle(evento)     -> evento ya validado por el proceso principal (overlay/events.js), { kind: 'shown', shown }
//                              (la ventana se muestra o se esconde: oculta no hace falta ningun temporizador) o
//                              { kind: 'dnd', on } ("No molestar": al prenderlo se vacian los avisos y los mensajes)
//   view.select(id)         -> en la vista previa, marca un widget (el que se esta personalizando)
//   view.destroy()
// En el modo edicion (y siempre en la vista previa) los widgets se arrastran con el mouse o se mueven con el
// teclado (flechas, Mayus+flechas, 1 a 9 para la grilla); onMove(id, { anchor, x?, y? }) avisa cada cambio. Con el widget
// elegido, + y - cambian el tamano, [ y ] la opacidad y Supr (o H) lo oculta o lo muestra: onTweak(id, { scale?, opacity?, enabled? }).
// Los apagados se ven como un fantasma mientras se edita, para poder volver a prenderlos.
import { h, icon } from './dom.js';
import { ANCHORS, DIGIT_ANCHOR, boxFor, snap, clampBox, nudge, sizeOf, clampScale, mergeLocalMoves, fitFactor, stepValue } from './layout.js';
import { pickVoiceRows } from './logic.js';
import { drawPerf, samplePerf, hasPerfData, PERF_STALE_MS } from './perf.js';
import { drawCounters, sampleCounters, hasCounters, COUNTERS_STALE_MS } from './counters.js';

// perf (3.1): rendimiento del juego (FPS, RAM, CPU, ping y tiempo de sesion), ver perf.js. counters: muertes, bloques
// minados y tiempo de sesion, ver counters.js.
export const WIDGETS = ['voice', 'messages', 'alerts', 'captures', 'music', 'perf', 'counters'];
const WIDGET_ICON = { voice: 'mic', messages: 'message', alerts: 'info', captures: 'capture', music: 'music', perf: 'info', counters: 'info' };
const DEFAULT_DURATION = { alerts: 6, messages: 8, captures: 5 };
const MAX_ALERTS = 3;
const MAX_QUEUE = 20;
const MAX_MESSAGES = 3;
const MAX_CAPTURES = 2;
const MAX_VOICE_ROWS = 8;
const EXIT_MS = 180;
const MUSIC_CHANGE_MS = 8000;
const MUSIC_PAUSED_MS = 6000;
const ALERT_GROUP = { friend: 'friends', party: 'friends', server: 'servers', points: 'rewards', achievement: 'rewards' };
const CAPTURE_ICON = { screenshot: 'capture', clip: 'film', 'replay-saved': 'replay', recording: 'record' };
const CAPTURE_KEY = { screenshot: 'capScreenshot', clip: 'capClip', 'replay-saved': 'capReplay', recording: 'capRecordingSaved' };

let seq = 0;

function fmtClock(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}

// Avatar: imagen (https, data: o assets/) o la inicial del nombre si no hay o no carga.
function avatar(src, name, cls = 'ovl-av') {
  const initial = h('span', { class: `${cls} ovl-av-letter`, 'aria-hidden': 'true' }, String(name || '?').trim().charAt(0).toUpperCase() || '?');
  if (!src) return initial;
  const img = h('img', { class: cls, src, alt: '', draggable: 'false', referrerpolicy: 'no-referrer' });
  img.addEventListener('error', () => img.replaceWith(initial), { once: true });
  return img;
}

export class OverlayView {
  constructor(root, { tr, preview = false, onMove, onTweak, onReset, onDone, onSelect, isReduced, now } = {}) {
    this.root = root;
    this.tr = typeof tr === 'function' ? tr : (k) => k;
    this.preview = preview;
    this.onMove = onMove;
    this.onTweak = onTweak;
    this.onReset = onReset;
    this.onDone = onDone;
    this.onSelect = onSelect;
    this.isReduced = isReduced || (() => false);
    this.now = now || (() => Date.now());
    this.layout = null;
    this.data = { voice: null, messages: [], alerts: [], queue: [], captures: [], recording: null, music: null, perf: null, counters: null };
    this.timer = null;
    this.drag = null;
    this.destroyed = false;
    this.paused = false; // la ventana esta escondida: sin temporizadores (no se dibuja nada que nadie vea)
    this.selected = null;
    this.localMoves = new Map(); // widget -> { pos, at }: lo que se acaba de mover y todavia no volvio en un layout
    this.failed = new Set(); // widgets que no se pudieron dibujar (se avisa una vez)
    this.fit = 1;
    this.onKeyDoc = (e) => {
      if (e.key === 'Escape' && this.isEditing() && !this.preview) {
        e.preventDefault();
        this.onDone?.();
      }
    };
    this.build();
  }

  // ---------- Estructura ----------
  build() {
    this.root.classList.add('ovl-root');
    this.root.classList.toggle('ovl-preview', this.preview);
    this.stage = h('div', { class: 'ovl-stage' });
    this.guides = h('div', { class: 'ovl-guides', 'aria-hidden': 'true' }, ANCHORS.map((a) => h('span', { class: `ovl-guide ovl-at-${a}`, dataset: { anchor: a } })));
    this.cells = Object.fromEntries(ANCHORS.map((a) => [a, h('div', { class: `ovl-cell ovl-cell-${a}` })]));
    // Las 9 posiciones son las celdas de una grilla de 3x3: lo que crece en una empuja a la de al lado en vez de taparla
    this.grid = h('div', { class: 'ovl-grid' }, ...Object.values(this.cells));
    this.freeLayer = h('div', { class: 'ovl-free' });
    this.live = h('div', { class: 'ovl-sr', 'aria-live': 'polite' });
    this.els = {};
    this.inner = {};
    for (const id of WIDGETS) {
      const inner = h('div', { class: 'ovl-in' });
      const el = h('section', { class: `ovl-w ovl-w-${id}`, dataset: { widget: id }, hidden: true }, inner);
      el.addEventListener('pointerdown', (e) => this.dragStart(id, e));
      el.addEventListener('keydown', (e) => this.keyMove(id, e));
      this.els[id] = el;
      this.inner[id] = inner;
    }
    this.stage.append(this.guides, this.grid, this.freeLayer);
    this.root.append(this.stage, this.live);
    if (typeof ResizeObserver === 'function') {
      this.ro = new ResizeObserver(() => {
        this.fitGrid();
        this.placeFree();
      });
      this.ro.observe(this.stage);
    }
  }

  // Si lo anclado no entra en el area de juego (ventana chica, widgets grandes), se achica todo junto en vez de salirse o
  // taparse. Se mide a tamano completo y se aplica enseguida, sin pintar en el medio.
  fitGrid() {
    if (this.destroyed || this.preview) return;
    const g = this.grid;
    g.style.zoom = '1';
    const area = g.getBoundingClientRect();
    const f = fitFactor({ width: g.scrollWidth, height: g.scrollHeight }, { width: area.width, height: area.height });
    if (f !== this.fit) this.fit = f;
    g.style.zoom = f === 1 ? '' : String(f);
  }

  destroy() {
    this.destroyed = true;
    clearTimeout(this.timer);
    this.ro?.disconnect();
    document.removeEventListener('keydown', this.onKeyDoc, true);
    this.cancelDrag();
    this.root.replaceChildren();
  }

  isEditing() {
    return this.preview || Boolean(this.layout?.editing);
  }

  reduced() {
    const m = this.layout?.motion;
    return m === 'on' || (m !== 'off' && this.isReduced());
  }

  cfg(id) {
    return this.layout?.widgets?.[id] || null;
  }

  duration(id) {
    return (Number(this.cfg(id)?.duration) || DEFAULT_DURATION[id] || 6) * 1000;
  }

  // ---------- Layout ----------
  setLayout(layout) {
    if (this.destroyed || !layout) return;
    const wasEditing = this.isEditing();
    this.layout = { ...layout, widgets: mergeLocalMoves(JSON.parse(JSON.stringify(layout.widgets || {})), this.localMoves, this.now()) };
    const editing = this.isEditing();
    if (!editing) this.cancelDrag(); // si se salio del modo edicion con un arrastre a medias, el widget no queda trabado
    this.root.classList.toggle('ovl-editing', editing);
    this.root.classList.toggle('ovl-reduce', this.reduced());
    if (/^#[0-9a-f]{6}$/i.test(layout.accent || '')) this.root.style.setProperty('--ovl-accent', layout.accent);
    this.renderToolbar();
    if (editing && !this.preview) document.addEventListener('keydown', this.onKeyDoc, true);
    else document.removeEventListener('keydown', this.onKeyDoc, true);
    this.renderAll();
    if (editing && !wasEditing && !this.preview) requestAnimationFrame(() => WIDGETS.map((id) => this.els[id]).find((el) => !el.hidden)?.focus());
  }

  renderToolbar() {
    this.toolbar?.remove();
    this.toolbar = null;
    if (!this.layout?.editing || this.preview) return;
    const tr = this.tr;
    this.toolbar = h(
      'div',
      { class: 'ovl-toolbar', role: 'toolbar', 'aria-label': tr('editTitle') },
      h('span', { class: 'ovl-tb-icon' }, icon('grid')),
      h('div', { class: 'ovl-tb-text' }, h('strong', {}, tr('editTitle')), h('span', {}, this.layout.mode === 'screen' ? tr('editScreenHint') : tr('editHint'))),
      h('button', { type: 'button', class: 'ovl-btn', onclick: () => {
        this.localMoves.clear(); // lo que se restablece no lo pisa una posicion de hace un momento
        this.onReset?.();
      } }, icon('undo'), tr('editReset')),
      h('button', { type: 'button', class: 'ovl-btn primary', onclick: () => this.onDone?.() }, icon('check'), tr('editDone')),
    );
    this.root.append(this.toolbar);
  }

  renderAll() {
    for (const id of WIDGETS) this.safeRender(id);
    this.schedule();
  }

  // Un widget que no se puede dibujar (un dato raro) se esconde y no tira a los demas ni lo que llegue despues
  safeRender(id) {
    try {
      this.renderWidget(id);
    } catch (err) {
      this.els[id].hidden = true;
      if (!this.failed.has(id)) {
        this.failed.add(id);
        console.warn(`[overlay] no se pudo dibujar ${id}:`, err?.message || err);
      }
    }
  }

  // Vista previa de Ajustes: el widget marcado es el que se esta personalizando
  select(id) {
    this.selected = WIDGETS.includes(id) ? id : null;
    for (const w of WIDGETS) this.els[w].classList.toggle('ovl-selected', w === this.selected);
  }

  renderWidget(id) {
    if (!this.layout) return;
    const cfg = this.cfg(id);
    const el = this.els[id];
    const inner = this.inner[id];
    // En la vista previa un widget apagado se ve como un fantasma: se sabe donde esta y se lo puede prender o mover
    const ghost = this.isEditing() && Boolean(cfg) && !cfg.enabled;
    if (!cfg || (!cfg.enabled && !ghost)) {
      el.hidden = true;
      return;
    }
    const editing = this.isEditing();
    el.className = `ovl-w ovl-w-${id}${this.drag?.id === id ? ' ovl-dragging' : ''}${ghost ? ' ovl-ghost' : ''}${this.selected === id ? ' ovl-selected' : ''}`;
    inner.className = `ovl-in ovl-theme-${cfg.theme || 'dark'}`;
    inner.style.zoom = String(clampScale(cfg.scale));
    el.style.opacity = ghost ? '' : String(Math.min(1, Math.max(0.3, Number(cfg.opacity) || 1)));
    const shown = this[`draw_${id}`](inner, cfg, editing);
    el.hidden = !shown;
    if (editing) {
      el.tabIndex = 0;
      el.setAttribute('role', 'button');
      el.setAttribute('aria-label', this.tr('editWidgetAria', { name: this.tr(`w_${id}`), position: this.tr(`anchor_${cfg.anchor}`) }));
      if (!inner.querySelector(':scope > .ovl-tag')) inner.prepend(h('div', { class: 'ovl-tag' }, icon('grip'), this.tr(`w_${id}`)));
    } else {
      el.removeAttribute('tabindex');
      el.removeAttribute('role');
      el.removeAttribute('aria-label');
      inner.querySelector(':scope > .ovl-tag')?.remove();
    }
    this.place(id);
  }

  // Anclado: va a la celda de la grilla (varios en la misma celda se apilan en orden fijo). Libre: capa aparte.
  place(id) {
    const cfg = this.cfg(id);
    const el = this.els[id];
    if (!cfg || this.drag?.id === id) return;
    const target = cfg.anchor === 'free' ? this.freeLayer : this.cells[cfg.anchor] || this.cells.tl;
    const after = WIDGETS.slice(WIDGETS.indexOf(id) + 1).map((w) => this.els[w]).find((e) => e.parentNode === target) || null;
    if (el.parentNode !== target || el.nextSibling !== after) target.insertBefore(el, after);
    if (cfg.anchor === 'free') requestAnimationFrame(() => this.placeFree());
    else {
      el.style.left = '';
      el.style.top = '';
    }
  }

  placeFree() {
    if (this.destroyed || !this.layout) return;
    const area = this.stage.getBoundingClientRect();
    if (!area.width || !area.height) return;
    for (const id of WIDGETS) {
      const cfg = this.cfg(id);
      const el = this.els[id];
      if (cfg?.anchor !== 'free' || el.hidden || this.drag?.id === id) continue;
      const box = boxFor(cfg, sizeOf(el.getBoundingClientRect(), area));
      el.style.left = `${(box.left * 100).toFixed(3)}%`;
      el.style.top = `${(box.top * 100).toFixed(3)}%`;
    }
  }

  // ---------- Eventos ----------
  handle(ev) {
    if (this.destroyed || !ev || typeof ev !== 'object') return;
    const now = this.now();
    const d = this.data;
    if (ev.kind === 'shown') {
      // El proceso principal esconde y muestra la ventana: escondida no hace falta ningun temporizador (ni volver a dibujar
      // el reloj de la sesion cada segundo); al mostrarla se pone todo al dia de una vez.
      this.paused = ev.shown === false;
      if (this.paused) {
        clearTimeout(this.timer);
        this.timer = null;
      } else this.tick();
      return;
    }
    if (ev.kind === 'dnd') {
      // "No molestar" recien prendido: lo que estaba en pantalla se va (avisos, su cola y mensajes)
      if (ev.on) {
        d.alerts = [];
        d.queue = [];
        d.messages = [];
        this.safeRender('alerts');
        this.safeRender('messages');
        this.schedule();
      }
      return;
    }
    if (ev.kind === 'voice') {
      d.voice = ev;
      this.safeRender('voice');
    } else if (ev.kind === 'music') {
      const prev = d.music;
      const s = ev.state;
      if (!s) d.music = null;
      else {
        const key = `${s.title}|${s.artist || ''}`;
        const changed = !prev?.state || prev.key !== key || (s.playing && !prev.state.playing);
        d.music = {
          state: s,
          key,
          at: Number(s.positionAt) || Number(ev.at) || now,
          changedAt: changed ? now : prev.changedAt,
          pausedAt: s.playing ? 0 : prev?.state?.playing || !prev ? now : prev.pausedAt,
        };
      }
      this.safeRender('music');
    } else if (ev.kind === 'capture') {
      if (ev.type === 'recording-start') d.recording = { since: Number(ev.at) || now };
      else {
        if (ev.type === 'recording-stop') d.recording = null;
        if (this.cfg('captures')?.enabled !== false) {
          const type = ev.type === 'recording-stop' ? 'recording' : ev.type;
          d.captures.push({ key: `c${++seq}`, type, thumb: ev.thumb || null, duration: ev.duration, until: now + this.duration('captures') });
          d.captures = d.captures.slice(-MAX_CAPTURES);
        }
      }
      this.safeRender('captures');
    } else if (ev.kind === 'message') {
      if (this.cfg('messages')?.enabled === false) return;
      d.messages.push({ key: `m${++seq}`, from: ev.from, avatar: ev.avatar, text: ev.text, until: now + this.duration('messages') });
      d.messages = d.messages.slice(-MAX_MESSAGES);
      this.safeRender('messages');
    } else if (ev.kind === 'alert') {
      const cfg = this.cfg('alerts');
      if (cfg?.enabled === false) return;
      if (cfg?.filter && cfg.filter[ALERT_GROUP[ev.icon] || 'launcher'] === false) return;
      const item = { key: `a${++seq}`, title: ev.title, body: ev.body, icon: ev.icon || 'info', ttl: ev.ttl };
      if (d.alerts.length < MAX_ALERTS) d.alerts.push(this.showAlert(item, now));
      else d.queue = [...d.queue, item].slice(-MAX_QUEUE);
      this.safeRender('alerts');
    } else if (ev.kind === 'perf') {
      // Una muestra cada 2 s; con todo en null (se cerro el juego) el widget se esconde.
      d.perf = hasPerfData(ev) ? { ...ev, at: now } : null;
      this.safeRender('perf');
    } else if (ev.kind === 'counters') {
      // Una muestra cada 5 s (el reloj corre solo entre muestra y muestra); con todo en null, se esconde.
      d.counters = hasCounters(ev) ? { ...ev, at: now } : null;
      this.safeRender('counters');
    }
    this.schedule();
  }

  showAlert(item, now) {
    return { ...item, until: now + (item.ttl ? item.ttl * 1000 : this.duration('alerts')) };
  }

  // Un cuadro despues de dibujar se vuelve a medir si lo anclado entra en el area de juego
  queueFit() {
    if (this.preview || this.fitQueued || this.destroyed || typeof requestAnimationFrame !== 'function') return;
    this.fitQueued = true;
    requestAnimationFrame(() => {
      this.fitQueued = false;
      this.fitGrid();
    });
  }

  // Un solo temporizador: el vencimiento mas cercano, o cada segundo si hay un reloj en pantalla.
  schedule() {
    this.queueFit();
    clearTimeout(this.timer);
    this.timer = null;
    if (this.destroyed || this.preview || this.paused) return;
    const d = this.data;
    const now = this.now();
    let next = Infinity;
    for (const list of [d.alerts, d.messages, d.captures]) for (const it of list) next = Math.min(next, it.until);
    const m = d.music;
    if (m?.state) {
      if (m.state.playing && !this.musicHidden(now)) next = Math.min(next, now + 1000);
      if (this.cfg('music')?.show === 'change') next = Math.min(next, m.changedAt + MUSIC_CHANGE_MS + 20);
      if (!m.state.playing && m.pausedAt) next = Math.min(next, m.pausedAt + MUSIC_PAUSED_MS + 20);
    }
    if (d.recording) next = Math.min(next, now + 1000);
    if (d.perf) next = Math.min(next, d.perf.at + PERF_STALE_MS + 20);
    if (d.counters && this.cfg('counters')?.enabled !== false) next = Math.min(next, now + 1000);
    if (next === Infinity) return;
    this.timer = setTimeout(() => this.tick(), Math.max(60, Math.min(next - now, 60000)));
  }

  tick() {
    const now = this.now();
    const d = this.data;
    const before = [d.alerts.length, d.messages.length, d.captures.length];
    d.alerts = d.alerts.filter((a) => a.until > now);
    while (d.alerts.length < MAX_ALERTS && d.queue.length) d.alerts.push(this.showAlert(d.queue.shift(), now));
    d.messages = d.messages.filter((m) => m.until > now);
    d.captures = d.captures.filter((c) => c.until > now);
    if (before[0] !== d.alerts.length || d.queue.length) this.safeRender('alerts');
    if (before[1] !== d.messages.length) this.safeRender('messages');
    this.safeRender('captures');
    if (d.music) this.safeRender('music');
    if (d.perf && now - d.perf.at > PERF_STALE_MS) {
      d.perf = null; // sin muestras nuevas (se cerro el juego o el overlay dejo de medir)
      this.safeRender('perf');
    }
    if (d.counters) {
      if (now - d.counters.at > COUNTERS_STALE_MS) d.counters = null;
      this.safeRender('counters');
    }
    this.schedule();
  }

  // ---------- Listas con entrada y salida animadas ----------
  syncList(container, items, make) {
    const reduce = this.reduced();
    const existing = new Map();
    for (const c of [...container.children]) if (c.dataset.key) existing.set(c.dataset.key, c);
    const keys = new Set(items.map((i) => i.key));
    for (const [k, c] of existing) {
      if (keys.has(k) || c.classList.contains('ovl-out')) continue;
      if (reduce) c.remove();
      else {
        c.classList.add('ovl-out');
        setTimeout(() => c.remove(), EXIT_MS);
      }
    }
    let prev = null;
    for (const item of items) {
      let c = existing.get(item.key);
      if (!c) {
        c = make(item);
        c.dataset.key = item.key;
        if (!reduce) c.classList.add('ovl-enter');
      }
      const ref = prev ? prev.nextSibling : container.firstChild;
      if (c !== ref) container.insertBefore(c, ref);
      prev = c;
    }
  }

  list(inner, cls) {
    let box = inner.querySelector(`:scope > .${cls}`);
    if (!box) {
      box = h('div', { class: cls });
      inner.append(box);
    }
    return box;
  }

  // ---------- Widgets ----------
  draw_voice(inner, cfg, editing) {
    const tr = this.tr;
    let v = this.data.voice;
    if (this.preview || (!v?.room && editing)) v = this.sampleVoice();
    if (!v?.room) return false;
    const all = v.members || [];
    const members = cfg.show === 'speaking' ? all.filter((m) => m.speaking) : all;
    const state = (m) => [
      m.deafened ? h('span', { class: 'ovl-ic bad', title: tr('voiceDeafened'), role: 'img', 'aria-label': tr('voiceDeafened') }, icon('headphonesOff')) : null,
      m.muted && !m.deafened ? h('span', { class: 'ovl-ic bad', title: tr('voiceMuted'), role: 'img', 'aria-label': tr('voiceMuted') }, icon('micOff')) : null,
      m.speaking ? h('span', { class: 'ovl-ic talk', role: 'img', 'aria-label': tr('voiceSpeaking') }, icon('volume')) : null,
    ];
    const head = h(
      'div',
      { class: 'ovl-vhead' },
      h('span', { class: 'ovl-ic' }, icon(v.self?.muted ? 'micOff' : 'mic')),
      h('span', { class: 'ovl-vroom', title: v.room.name }, v.room.name || tr('w_voice')),
      state({ muted: v.self?.muted, deafened: v.self?.deafened }),
    );
    const rows = pickVoiceRows(members, MAX_VOICE_ROWS).map((m) =>
      h('div', { class: ['ovl-vrow', m.speaking && 'speaking', (m.muted || m.deafened) && 'quiet'] }, avatar(m.avatar, m.name), h('span', { class: 'ovl-vname' }, m.self ? tr('voiceYou', { name: m.name }) : m.name), state(m)),
    );
    const more = members.length - MAX_VOICE_ROWS;
    const tag = inner.querySelector(':scope > .ovl-tag');
    inner.replaceChildren(...(tag ? [tag] : []), head, ...rows, ...(more > 0 ? [h('div', { class: 'ovl-more' }, tr('voiceMore', { count: more }))] : []));
    return true;
  }

  draw_messages(inner, cfg, editing) {
    const tr = this.tr;
    let items = this.data.messages;
    if (this.preview || (!items.length && editing)) items = [{ key: 'sample', from: tr('sampleFriend1'), text: tr('sampleMessage'), avatar: null }];
    const box = this.list(inner, 'ovl-list');
    this.syncList(box, items, (m) =>
      h('div', { class: 'ovl-msg' }, avatar(m.avatar, m.from), h('div', { class: 'ovl-msg-main' }, h('div', { class: 'ovl-msg-from' }, m.from), h('div', { class: 'ovl-msg-text' }, cfg.hideContent ? tr('messageHidden') : m.text))),
    );
    // Si cambia "ocultar el contenido", los mensajes ya dibujados tambien cambian.
    for (const el of box.children) {
      const it = items.find((i) => i.key === el.dataset.key);
      const txt = el.querySelector('.ovl-msg-text');
      if (it && txt) txt.textContent = cfg.hideContent ? tr('messageHidden') : it.text;
    }
    return items.length > 0;
  }

  draw_alerts(inner, cfg, editing) {
    const tr = this.tr;
    let items = this.data.alerts;
    if (this.preview || (!items.length && editing)) items = [{ key: 'sample', icon: 'achievement', title: tr('sampleAlertTitle'), body: tr('sampleAlertBody') }];
    const box = this.list(inner, 'ovl-list');
    box.setAttribute('role', 'status');
    this.syncList(box, items, (a) =>
      h('div', { class: `ovl-alert ovl-k-${a.icon}` }, h('span', { class: 'ovl-alert-ic' }, icon(a.icon)), h('div', { class: 'ovl-alert-main' }, h('div', { class: 'ovl-alert-title' }, a.title), a.body ? h('div', { class: 'ovl-alert-body' }, a.body) : null)),
    );
    return items.length > 0;
  }

  draw_captures(inner, cfg, editing) {
    const tr = this.tr;
    let items = this.data.captures;
    let rec = this.data.recording;
    if (this.preview || (!items.length && !rec && editing)) {
      items = [{ key: 'sample', type: 'clip', duration: 30 }];
      rec = this.preview ? { since: this.now() - 83000 } : rec;
    }
    let pill = inner.querySelector(':scope > .ovl-rec');
    if (rec) {
      if (!pill) {
        pill = h('div', { class: 'ovl-rec', role: 'status' }, h('span', { class: 'ovl-rec-dot', 'aria-hidden': 'true' }), h('span', { class: 'ovl-rec-label' }, tr('capRecording')), h('span', { class: 'ovl-rec-time' }));
        const tag = inner.querySelector(':scope > .ovl-tag');
        if (tag) tag.after(pill);
        else inner.prepend(pill);
      }
      pill.querySelector('.ovl-rec-time').textContent = fmtClock((this.now() - rec.since) / 1000);
    } else pill?.remove();
    const box = this.list(inner, 'ovl-list');
    this.syncList(box, items, (c) =>
      h(
        'div',
        { class: 'ovl-cap' },
        c.thumb ? h('img', { class: 'ovl-cap-thumb', src: c.thumb, alt: '', draggable: 'false' }) : h('span', { class: 'ovl-cap-ic' }, icon(CAPTURE_ICON[c.type] || 'capture')),
        h('div', { class: 'ovl-cap-main' }, h('div', { class: 'ovl-cap-title' }, tr(CAPTURE_KEY[c.type] || 'capScreenshot')), c.duration ? h('div', { class: 'ovl-cap-sub' }, fmtClock(c.duration)) : null),
      ),
    );
    return Boolean(rec) || items.length > 0;
  }

  musicHidden(now) {
    const m = this.data.music;
    if (!m?.state) return true;
    if (this.cfg('music')?.show === 'change' && now > m.changedAt + MUSIC_CHANGE_MS) return true;
    return !m.state.playing && m.pausedAt > 0 && now > m.pausedAt + MUSIC_PAUSED_MS;
  }

  draw_music(inner, cfg, editing) {
    const tr = this.tr;
    const now = this.now();
    let m = this.data.music;
    if (this.preview || (editing && (!m?.state || this.musicHidden(now)))) m = { state: { title: tr('sampleSong'), artist: tr('sampleArtist'), playing: true, position: 74, duration: 201, appName: 'Spotify' }, at: now };
    else if (this.musicHidden(now)) return false;
    const s = m.state;
    const pos = s.position === null || s.position === undefined ? null : Math.min(s.duration || Infinity, s.position + (s.playing && !this.preview ? (now - m.at) / 1000 : 0));
    const pct = pos !== null && s.duration ? Math.min(100, (pos / s.duration) * 100) : null;
    const tag = inner.querySelector(':scope > .ovl-tag');
    inner.replaceChildren(
      ...(tag ? [tag] : []),
      h(
        'div',
        { class: 'ovl-music' },
        s.art ? h('img', { class: 'ovl-art', src: s.art, alt: '', draggable: 'false' }) : h('span', { class: 'ovl-art ovl-art-empty' }, icon('music')),
        h(
          'div',
          { class: 'ovl-music-main' },
          h('div', { class: 'ovl-song', title: s.title }, s.title),
          h('div', { class: 'ovl-artist' }, [s.artist, s.appName].filter(Boolean).join(' · ')),
          pct !== null
            ? h('div', { class: 'ovl-progress' }, h('span', { class: 'ovl-time' }, fmtClock(pos)), h('span', { class: 'ovl-bar' }, h('span', { class: 'ovl-bar-fill', style: { width: `${pct.toFixed(2)}%` } })), h('span', { class: 'ovl-time' }, fmtClock(s.duration)))
            : null,
        ),
        s.playing ? null : h('span', { class: 'ovl-ic', role: 'img', 'aria-label': tr('musicPaused'), title: tr('musicPaused') }, icon('pause')),
      ),
    );
    return true;
  }

  draw_perf(inner, cfg, editing) {
    let p = this.data.perf;
    if (this.preview || (!p && editing)) p = samplePerf();
    if (!p) return false;
    return drawPerf(inner, cfg, p, { tr: this.tr });
  }

  draw_counters(inner, cfg, editing) {
    let c = this.data.counters;
    if (this.preview || (!c && editing)) c = sampleCounters();
    if (!c) return false;
    return drawCounters(inner, cfg, c, { tr: this.tr, now: this.now(), lang: this.layout?.lang });
  }

  sampleVoice() {
    const tr = this.tr;
    return {
      room: { name: tr('sampleRoom'), code: '' },
      self: { muted: false, deafened: false },
      members: [
        { id: 's0', name: tr('sampleMe'), speaking: true, self: true },
        { id: 's1', name: tr('sampleFriend1'), speaking: false, muted: true },
        { id: 's2', name: tr('sampleFriend2'), speaking: false, deafened: true },
      ],
    };
  }

  // ---------- Modo edicion: arrastrar ----------
  dragStart(id, e) {
    if (!this.isEditing() || e.button !== 0) return;
    if (this.preview) {
      this.select(id);
      this.onSelect?.(id);
    }
    const el = this.els[id];
    const area = this.stage.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (!area.width || !area.height) return;
    e.preventDefault();
    el.focus({ preventScroll: true });
    el.setPointerCapture?.(e.pointerId);
    const size = sizeOf(r, area);
    this.drag = { id, x0: e.clientX, y0: e.clientY, start: { left: (r.left - area.left) / area.width, top: (r.top - area.top) / area.height }, size, area, moved: false, box: null };
    const move = (ev) => this.dragMove(ev);
    const stop = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.removeEventListener('lostpointercapture', up);
    };
    const up = (ev) => {
      stop();
      this.dragEnd(ev);
    };
    this.drag.stop = stop;
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('lostpointercapture', up);
  }

  // El arrastre se suelta sin guardar nada (se salio del modo edicion o se cerro la vista a la mitad)
  cancelDrag() {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    d.stop?.();
    this.els[d.id].classList.remove('ovl-dragging');
    this.root.classList.remove('ovl-is-dragging');
    for (const g of this.guides.children) g.classList.remove('on');
    if (this.layout) this.place(d.id);
  }

  dragMove(e) {
    const d = this.drag;
    if (!d) return;
    const dx = e.clientX - d.x0;
    const dy = e.clientY - d.y0;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    const el = this.els[d.id];
    if (!d.moved) {
      d.moved = true;
      el.classList.add('ovl-dragging');
      this.root.classList.add('ovl-is-dragging');
      this.freeLayer.append(el);
    }
    d.box = clampBox({ left: d.start.left + dx / d.area.width, top: d.start.top + dy / d.area.height }, d.size);
    el.style.left = `${(d.box.left * 100).toFixed(3)}%`;
    el.style.top = `${(d.box.top * 100).toFixed(3)}%`;
    const res = snap(d.box, d.size, { aspect: d.area.width / d.area.height });
    for (const g of this.guides.children) g.classList.toggle('on', g.dataset.anchor === res.anchor);
  }

  dragEnd() {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    const el = this.els[d.id];
    el.classList.remove('ovl-dragging');
    this.root.classList.remove('ovl-is-dragging');
    for (const g of this.guides.children) g.classList.remove('on');
    if (!d.moved || !d.box) return this.place(d.id);
    this.applyMove(d.id, snap(d.box, d.size, { aspect: d.area.width / d.area.height }));
  }

  applyMove(id, res) {
    const cfg = this.cfg(id);
    if (!cfg || !res) return;
    Object.assign(cfg, res);
    if (!this.preview) this.localMoves.set(id, { pos: { ...this.localMoves.get(id)?.pos, ...res }, at: this.now() });
    this.safeRender(id);
    this.live.textContent = this.tr('movedTo', { name: this.tr(`w_${id}`), position: this.tr(`anchor_${cfg.anchor}`) });
    this.onMove?.(id, res);
  }

  // Tamano, opacidad y oculto con el teclado: + y -, [ y ] (o Re Pag y Av Pag), Supr o H. null si la tecla no es de estas.
  // En los teclados en espanol los corchetes salen con AltGr (Ctrl+Alt): con AltGr se aceptan igual.
  keyTweak(cfg, e) {
    const altGr = typeof e.getModifierState === 'function' && e.getModifierState('AltGraph');
    if (!altGr && (e.ctrlKey || e.altKey || e.metaKey)) return null;
    const k = e.key;
    if (k === '+' || k === '=') return { scale: stepValue(cfg.scale, 0.1, 0.6, 1.6, 0.05) };
    if (k === '-' || k === '_') return { scale: stepValue(cfg.scale, -0.1, 0.6, 1.6, 0.05) };
    if (k === ']' || k === '}' || k === 'PageUp') return { opacity: stepValue(cfg.opacity, 0.1, 0.3, 1, 0.01) };
    if (k === '[' || k === '{' || k === 'PageDown') return { opacity: stepValue(cfg.opacity, -0.1, 0.3, 1, 0.01) };
    if (k === 'Delete' || k === 'Backspace' || k === 'h' || k === 'H') return { enabled: !cfg.enabled };
    return null;
  }

  applyTweak(id, patch) {
    const cfg = this.cfg(id);
    if (!cfg || !patch) return;
    Object.assign(cfg, patch);
    // En la pagina del overlay el layout vuelve del proceso principal con un guardado atrasado; la vista previa no tiene ese vuelo
    if (!this.preview) this.localMoves.set(id, { pos: { ...this.localMoves.get(id)?.pos, ...patch }, at: this.now() });
    this.safeRender(id);
    const sum = patch.enabled !== undefined ? this.tr(patch.enabled ? 'tweakShown' : 'tweakHidden', { name: this.tr(`w_${id}`) }) : this.tr('tweakSize', { name: this.tr(`w_${id}`), scale: Math.round(cfg.scale * 100), opacity: Math.round(cfg.opacity * 100) });
    this.live.textContent = sum;
    this.onTweak?.(id, patch);
    this.els[id].focus({ preventScroll: true });
  }

  // Teclado: flechas (Mayus: pasos grandes), 1 a 9 para la grilla, Enter o Escape para terminar.
  keyMove(id, e) {
    if (!this.isEditing()) return;
    const cfg = this.cfg(id);
    if (!cfg) return;
    const tweak = this.keyTweak(cfg, e);
    if (tweak) {
      e.preventDefault();
      this.applyTweak(id, tweak);
      return;
    }
    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    let res = null;
    if (arrows[e.key]) res = nudge(cfg, ...arrows[e.key], e.shiftKey ? 0.05 : 0.01);
    else if (DIGIT_ANCHOR[e.key] && !e.ctrlKey && !e.altKey && !e.metaKey) res = { anchor: DIGIT_ANCHOR[e.key] };
    else if ((e.key === 'Enter' || e.key === 'Escape') && !this.preview) {
      e.preventDefault();
      e.stopPropagation();
      this.onDone?.();
      return;
    }
    if (!res) return;
    e.preventDefault();
    this.applyMove(id, res);
    this.els[id].focus({ preventScroll: true });
  }
}
