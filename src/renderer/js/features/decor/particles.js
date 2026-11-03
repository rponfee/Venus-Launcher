// Partículas sobre el fondo: un <canvas> propio dentro de .space-bg (encima de las estrellas y del fondo
// propio de Apariencia) con requestAnimationFrame. Se pausa con la ventana oculta, con un juego abierto, en el
// modo liviano y con movimiento reducido (lo decide el gate() que pasa decor.js: 'run', 'freeze' o 'clear').
// Tope de partículas por tamaño de ventana (settings.particleBudget).
// Contrato: init({ gate }), set(kind, density), refresh(), running(), current().
import { particleBudget } from './settings.js';

const MAX_DT = 0.05; // segundos: al volver de una pausa larga no se "saltan" las partículas
const MAX_DPR = 2;
const TAU = Math.PI * 2;
const LEAF_COLORS = ['#d97a2b', '#c9542a', '#e3a53a', '#8a5a2b', '#b8432f', '#e0c04a'];

const S = {
  canvas: null,
  ctx: null,
  kind: 'none',
  density: 'normal',
  items: [],
  raf: 0,
  last: 0,
  time: 0,
  w: 0,
  h: 0,
  gate: () => 'run',
  bound: false,
  meteor: null,
  nextMeteor: 0,
};

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (list) => list[Math.floor(Math.random() * list.length)];

function host() {
  return document.querySelector('.space-bg');
}

function ensureCanvas() {
  if (S.canvas?.isConnected) return S.canvas;
  const parent = host();
  if (!parent) return null;
  S.canvas?.remove();
  const canvas = document.createElement('canvas');
  canvas.className = 'dc-particles';
  canvas.setAttribute('aria-hidden', 'true');
  canvas.hidden = true;
  parent.append(canvas);
  S.canvas = canvas;
  S.ctx = canvas.getContext('2d');
  resize();
  return canvas;
}

function resize() {
  if (!S.canvas) return;
  S.w = Math.max(1, window.innerWidth);
  S.h = Math.max(1, window.innerHeight);
  const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
  S.canvas.width = Math.round(S.w * dpr);
  S.canvas.height = Math.round(S.h * dpr);
  S.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  fit();
}

// Ajusta la cantidad al tope del tamaño actual (agrega o quita sin reiniciar las demás).
function fit() {
  const budget = particleBudget(S.w, S.h, S.kind, S.density);
  if (S.items.length > budget) S.items.length = budget;
  while (S.items.length < budget) S.items.push(spawn(S.kind, false));
}

// fresh: entra por el borde (lluvia y nieve arriba, chispas abajo); si no, en cualquier punto (relleno inicial).
function spawn(kind, fresh) {
  const w = S.w;
  const h = S.h;
  switch (kind) {
    case 'snow': {
      const r = rand(1, 3);
      return { x: rand(0, w), y: fresh ? -6 : rand(0, h), r, vy: 16 + r * 13, sway: rand(0.5, 1.4), phase: rand(0, TAU), a: rand(0.35, 0.9) };
    }
    case 'rain':
      return { x: rand(-40, w), y: fresh ? rand(-60, -10) : rand(0, h), len: rand(9, 18), vy: rand(420, 720), vx: -45, a: rand(0.18, 0.45) };
    case 'leaves':
      return { x: rand(0, w), y: fresh ? -10 : rand(0, h), size: rand(4, 8), vy: rand(22, 46), vx: rand(-8, 8), rot: rand(0, TAU), vr: rand(-1.6, 1.6), sway: rand(0.4, 1.1), phase: rand(0, TAU), color: pick(LEAF_COLORS), a: rand(0.6, 0.95) };
    case 'embers': {
      const r = rand(1, 2.6);
      return { x: rand(0, w), y: fresh ? h + 4 : rand(0, h), r, vy: -(14 + rand(0, 40)), sway: rand(0.6, 1.8), phase: rand(0, TAU), a: rand(0.5, 0.95) };
    }
    case 'stars':
      return { x: rand(0, w), y: rand(0, h), size: rand(1.5, 3.5), vx: rand(-4, 4), vy: rand(-3, 3), phase: rand(0, TAU), speed: rand(0.8, 2.6), a: rand(0.5, 1) };
    default:
      return null;
  }
}

function step(dt) {
  const w = S.w;
  const h = S.h;
  const t = S.time;
  const items = S.items;
  for (let i = 0; i < items.length; i++) {
    const p = items[i];
    switch (S.kind) {
      case 'snow':
        p.y += p.vy * dt;
        p.x += Math.sin(t * p.sway + p.phase) * 14 * dt;
        if (p.y > h + 6) items[i] = spawn('snow', true);
        else if (p.x < -6) p.x = w + 6;
        else if (p.x > w + 6) p.x = -6;
        break;
      case 'rain':
        p.y += p.vy * dt;
        p.x += p.vx * dt;
        if (p.y > h + 20 || p.x < -60) items[i] = spawn('rain', true);
        break;
      case 'leaves':
        p.y += p.vy * dt;
        p.x += (p.vx + Math.sin(t * p.sway + p.phase) * 22) * dt;
        p.rot += p.vr * dt;
        if (p.y > h + 12) items[i] = spawn('leaves', true);
        else if (p.x < -12) p.x = w + 12;
        else if (p.x > w + 12) p.x = -12;
        break;
      case 'embers':
        p.y += p.vy * dt;
        p.x += Math.sin(t * p.sway + p.phase) * 12 * dt;
        if (p.y < -8) items[i] = spawn('embers', true);
        break;
      case 'stars':
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        if (p.x < -6) p.x = w + 6;
        else if (p.x > w + 6) p.x = -6;
        if (p.y < -6) p.y = h + 6;
        else if (p.y > h + 6) p.y = -6;
        break;
      default:
        break;
    }
  }
  if (S.kind === 'stars') stepMeteor(dt);
}

// Estrella fugaz cada tanto (solo con "destellos").
function stepMeteor(dt) {
  if (S.meteor) {
    const m = S.meteor;
    m.x += m.vx * dt;
    m.y += m.vy * dt;
    m.life -= dt;
    if (m.life <= 0 || m.x > S.w + 200 || m.y > S.h + 200) S.meteor = null;
    return;
  }
  S.nextMeteor -= dt;
  if (S.nextMeteor > 0) return;
  S.nextMeteor = rand(4, 10);
  S.meteor = { x: rand(-100, S.w * 0.7), y: rand(-60, S.h * 0.4), vx: rand(700, 1000), vy: rand(250, 420), life: rand(0.5, 0.8), len: rand(90, 160) };
}

function draw() {
  const ctx = S.ctx;
  const t = S.time;
  ctx.clearRect(0, 0, S.w, S.h);
  const items = S.items;
  switch (S.kind) {
    case 'snow':
      ctx.fillStyle = '#ffffff';
      for (const p of items) {
        ctx.globalAlpha = p.a;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, TAU);
        ctx.fill();
      }
      break;
    case 'rain':
      ctx.strokeStyle = '#bed7ff';
      ctx.lineWidth = 1;
      ctx.lineCap = 'round';
      for (const p of items) {
        ctx.globalAlpha = p.a;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x + p.vx * 0.02, p.y + p.len);
        ctx.stroke();
      }
      break;
    case 'leaves':
      for (const p of items) {
        ctx.globalAlpha = p.a;
        ctx.fillStyle = p.color;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.beginPath();
        ctx.ellipse(0, 0, p.size, p.size * 0.55, 0, 0, TAU);
        ctx.fill();
        ctx.restore();
      }
      break;
    case 'embers':
      for (const p of items) {
        const a = p.a * (0.6 + 0.4 * Math.sin(t * 8 + p.phase));
        ctx.globalAlpha = a * 0.25;
        ctx.fillStyle = '#ff7a1e';
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r * 2.6, 0, TAU);
        ctx.fill();
        ctx.globalAlpha = a;
        ctx.fillStyle = '#ffb347';
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, TAU);
        ctx.fill();
      }
      break;
    case 'stars':
      ctx.strokeStyle = '#ffecc8';
      ctx.fillStyle = '#fff7e6';
      ctx.lineWidth = 1;
      ctx.lineCap = 'round';
      for (const p of items) {
        const a = p.a * (0.25 + 0.75 * (0.5 + 0.5 * Math.sin(t * p.speed + p.phase)));
        ctx.globalAlpha = a;
        ctx.beginPath();
        ctx.moveTo(p.x - p.size, p.y);
        ctx.lineTo(p.x + p.size, p.y);
        ctx.moveTo(p.x, p.y - p.size);
        ctx.lineTo(p.x, p.y + p.size);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(p.x, p.y, 0.9, 0, TAU);
        ctx.fill();
      }
      if (S.meteor) {
        const m = S.meteor;
        const k = Math.hypot(m.vx, m.vy) || 1;
        const tx = m.x - (m.vx / k) * m.len;
        const ty = m.y - (m.vy / k) * m.len;
        const grad = ctx.createLinearGradient(m.x, m.y, tx, ty);
        grad.addColorStop(0, 'rgba(255, 250, 235, 0.95)');
        grad.addColorStop(1, 'rgba(255, 250, 235, 0)');
        ctx.globalAlpha = Math.min(1, m.life * 2);
        ctx.strokeStyle = grad;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(m.x, m.y);
        ctx.lineTo(tx, ty);
        ctx.stroke();
      }
      break;
    default:
      break;
  }
  ctx.globalAlpha = 1;
}

function loop(now) {
  S.raf = 0;
  if (S.gate() !== 'run' || S.kind === 'none' || !S.canvas?.isConnected) {
    refresh();
    return;
  }
  const dt = Math.min(MAX_DT, Math.max(0, (now - S.last) / 1000));
  S.last = now;
  S.time += dt;
  step(dt);
  draw();
  S.raf = requestAnimationFrame(loop);
}

function start() {
  if (S.raf || S.kind === 'none') return;
  const canvas = ensureCanvas();
  if (!canvas) return;
  canvas.hidden = false;
  S.last = performance.now();
  S.raf = requestAnimationFrame(loop);
}

// clear: borra y esconde el canvas (modo liviano, movimiento reducido, sin partículas); si no, deja el último
// cuadro quieto (ventana oculta o juego abierto) y sigue al volver.
function stop(clear) {
  if (S.raf) cancelAnimationFrame(S.raf);
  S.raf = 0;
  if (!clear || !S.canvas) return;
  S.ctx?.clearRect(0, 0, S.w, S.h);
  S.canvas.hidden = true;
}

// gate(): 'run' si se puede animar ahora (ventana visible, sin juego abierto, sin modo liviano ni movimiento
// reducido), 'freeze' para dejar el último cuadro quieto (ventana oculta, juego abierto) o 'clear' para esconder
// el canvas (modo liviano, movimiento reducido).
export function init({ gate } = {}) {
  if (typeof gate === 'function') S.gate = gate;
  if (S.bound) return;
  S.bound = true;
  window.addEventListener('resize', () => {
    if (S.canvas) resize();
  });
}

export function set(kind, density = 'normal') {
  const changed = kind !== S.kind || density !== S.density;
  S.kind = kind;
  S.density = density;
  if (!changed) return;
  S.items = [];
  S.meteor = null;
  S.nextMeteor = rand(1, 4);
  if (kind === 'none') {
    stop(true);
    return;
  }
  if (ensureCanvas()) fit();
  refresh();
}

// Vuelve a decidir si corre o se pausa (visibilidad, juego, modo liviano, movimiento reducido).
export function refresh() {
  if (S.kind === 'none') {
    stop(true);
    return;
  }
  const mode = S.gate();
  if (mode === 'run') start();
  else stop(mode === 'clear');
}

export function running() {
  return S.raf !== 0;
}

export function current() {
  return { kind: S.kind, density: S.density, count: S.items.length };
}
