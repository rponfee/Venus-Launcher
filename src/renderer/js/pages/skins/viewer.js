// Vista previa en 3D hecha con transformaciones CSS (sin WebGL ni librerias): cada caja del personaje tiene
// seis caras y cada cara es un canvas chico con su pedazo de la textura, ampliado con
// image-rendering: pixelated. Chromium ordena las caras en profundidad (transform-style: preserve-3d).
// Se gira arrastrando, con las flechas del teclado (es un control deslizante para el lector de pantalla)
// o con los botones de la pagina. Con movimiento reducido no hay animacion. Si el navegador no tuviera 3D,
// muestra el frente y la espalda planos.
import { h, reducedMotion } from '../../ui.js';
import { t } from '../../i18n.js';
import { faceRects, playerParts, capePart } from './model.js';
import { drawFlat } from './texture.js';

const S = 10; // px de CSS por pixel de Minecraft (despues se escala la escena entera para que entre)
const EPS = 0.4; // cada cara se agranda un poco para que no se vean costuras entre caras vecinas
const FACES = ['front', 'back', 'right', 'left', 'top', 'bottom'];
const DEFAULT = { yaw: 25, pitch: 10 };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const norm = (deg) => ((Math.round(deg) % 360) + 360) % 360;

function faceTransform(face, W, H, D) {
  if (face === 'front') return `translateZ(${(D * S) / 2}px)`;
  if (face === 'back') return `rotateY(180deg) translateZ(${(D * S) / 2}px)`;
  if (face === 'right') return `rotateY(-90deg) translateZ(${(W * S) / 2}px)`;
  if (face === 'left') return `rotateY(90deg) translateZ(${(W * S) / 2}px)`;
  if (face === 'top') return `rotateX(90deg) translateZ(${(H * S) / 2}px)`;
  return `rotateX(-90deg) translateZ(${(H * S) / 2}px)`;
}

function faceSize(face, W, H, D) {
  if (face === 'front' || face === 'back') return [W, H];
  if (face === 'right' || face === 'left') return [D, H];
  return [W, D];
}

// La capa exterior suele tener caras vacias: esas no se dibujan (menos capas para el compositor).
function isEmpty(src, x, y, w, h) {
  const ctx = src.getContext('2d', { willReadFrequently: true });
  const px = ctx.getImageData(x, y, w, h).data;
  for (let i = 3; i < px.length; i += 4) if (px[i]) return false;
  return true;
}

function sideOf(yaw) {
  const d = norm(yaw);
  if (d <= 45 || d >= 315) return t('skins.sideFront');
  if (d < 135) return t('skins.sideRight');
  if (d <= 225) return t('skins.sideBack');
  return t('skins.sideLeft');
}

export function supports3d() {
  return typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('transform-style', 'preserve-3d');
}

export function createViewer({ label = '', onChange } = {}) {
  const has3d = supports3d();
  const model = h('div', { class: 'sk-model' });
  const stage = h('div', { class: 'sk-stage' }, model);
  const flatFront = h('canvas', { class: 'sk-flat-canvas', 'aria-hidden': 'true' });
  const flatBack = h('canvas', { class: 'sk-flat-canvas', 'aria-hidden': 'true' });
  const flat = h('div', { class: 'sk-flat' }, flatFront, flatBack);
  const el = h(
    'div',
    has3d
      ? { class: 'sk-viewer', role: 'slider', tabindex: '0', 'aria-label': label, 'aria-valuemin': '0', 'aria-valuemax': '359', 'aria-orientation': 'horizontal' }
      : { class: 'sk-viewer sk-viewer-flat', role: 'img', 'aria-label': label },
    h('div', { class: 'sk-glow', 'aria-hidden': 'true' }),
    h('div', { class: 'sk-floor', 'aria-hidden': 'true' }),
    has3d ? stage : flat,
  );

  const st = { yaw: DEFAULT.yaw, pitch: DEFAULT.pitch, skin: null, variant: 'classic', cape: null, capeOn: true, paused: false, poses: {}, tween: null, raf: 0, t0: 0, destroyed: false };

  function applyView() {
    model.style.transform = `rotateX(${-st.pitch}deg) rotateY(${st.yaw}deg)`;
    if (has3d) {
      el.setAttribute('aria-valuenow', String(norm(st.yaw)));
      el.setAttribute('aria-valuetext', t('skins.angleText', { side: sideOf(st.yaw), deg: norm(st.yaw) }));
    }
    onChange?.(view());
  }

  // Pose de reposo del juego: los brazos se balancean apenas y la capa acompana.
  function applyPose(sec) {
    const z = sec ? Math.cos(sec * 1.8) * 0.05 + 0.05 : 0.05;
    const x = sec ? Math.sin(sec * 1.34) * 0.05 : 0;
    const set = (id, v) => {
      if (st.poses[id]) st.poses[id].style.transform = v;
    };
    set('rightArm', `rotateZ(${z}rad) rotateX(${x}rad)`);
    set('leftArm', `rotateZ(${-z}rad) rotateX(${-x}rad)`);
    set('cape', `rotateX(${-6 - (sec ? 1.6 + Math.sin(sec * 1.1) * 1.6 : 0)}deg)`);
  }

  function build() {
    model.textContent = '';
    st.poses = {};
    if (!st.skin) return;
    if (!has3d) {
      drawFlat(flatFront, st.skin, st.variant, { side: 'front', scale: 1 });
      drawFlat(flatBack, st.skin, st.variant, { side: 'back', scale: 1 });
      return;
    }
    const parts = playerParts(st.variant);
    if (st.cape && st.capeOn) parts.push(capePart());
    for (const part of parts) {
      const pose = h('div', { class: 'sk-pose' });
      const node = h('div', { class: 'sk-part', dataset: { part: part.id } }, pose);
      node.style.transform = `translate3d(${part.pivot[0] * S}px, ${part.pivot[1] * S}px, ${part.pivot[2] * S}px)`;
      for (const b of part.boxes) {
        const src = b.texture === 'cape' ? st.cape : st.skin;
        const [w, hh, d] = b.size;
        const inf = b.inflate || 0;
        const [W, H, D] = [w + 2 * inf, hh + 2 * inf, d + 2 * inf];
        const boxEl = h('div', { class: ['sk-box', b.overlay && 'sk-overlay'] });
        boxEl.style.transform = `translate3d(${b.offset[0] * S}px, ${b.offset[1] * S}px, ${b.offset[2] * S}px)${b.turn ? ` rotateY(${b.turn}deg)` : ''}`;
        const rects = faceRects(b.uv[0], b.uv[1], w, hh, d);
        for (const face of FACES) {
          const [x, y, fw, fh] = rects[face];
          if (b.overlay && isEmpty(src, x, y, fw, fh)) continue;
          const c = document.createElement('canvas');
          c.width = fw;
          c.height = fh;
          c.className = 'sk-face';
          const ctx = c.getContext('2d');
          ctx.imageSmoothingEnabled = false;
          // La cara de abajo va invertida en el mapa UV de Minecraft
          if (face === 'bottom') {
            ctx.translate(0, fh);
            ctx.scale(1, -1);
          }
          ctx.drawImage(src, x, y, fw, fh, 0, 0, fw, fh);
          const [cw, ch] = faceSize(face, W, H, D);
          const pw = cw * S + EPS * 2;
          const ph = ch * S + EPS * 2;
          Object.assign(c.style, { width: `${pw}px`, height: `${ph}px`, left: `${-pw / 2}px`, top: `${-ph / 2}px`, transform: faceTransform(face, W, H, D) });
          boxEl.append(c);
        }
        pose.append(boxEl);
      }
      model.append(node);
      st.poses[part.id] = pose;
    }
    applyPose(0);
    applyView();
    schedule();
  }

  const animating = () => !st.destroyed && has3d && st.skin && !st.paused && !reducedMotion() && el.isConnected && !document.hidden;

  function frame(now) {
    st.raf = 0;
    if (st.destroyed) return;
    let more = false;
    if (st.tween) {
      const k = clamp((now - st.tween.start) / st.tween.ms, 0, 1);
      const e = 1 - (1 - k) ** 3;
      st.yaw = st.tween.from.yaw + (st.tween.to.yaw - st.tween.from.yaw) * e;
      st.pitch = st.tween.from.pitch + (st.tween.to.pitch - st.tween.from.pitch) * e;
      applyView();
      if (k < 1) more = true;
      else st.tween = null;
    }
    if (animating()) {
      if (!st.t0) st.t0 = now;
      applyPose((now - st.t0) / 1000);
      more = true;
    } else applyPose(0);
    if (more) st.raf = requestAnimationFrame(frame);
  }

  function schedule() {
    if (!st.raf && !st.destroyed) st.raf = requestAnimationFrame(frame);
  }

  // Gira hasta (yaw, pitch) por el camino mas corto, con una transicion corta (sin ella con movimiento reducido).
  function turnTo(yaw, pitch = st.pitch) {
    const delta = ((((yaw - st.yaw) % 360) + 540) % 360) - 180;
    const to = { yaw: st.yaw + delta, pitch: clamp(pitch, -30, 40) };
    if (reducedMotion() || !has3d) {
      st.tween = null;
      st.yaw = to.yaw;
      st.pitch = to.pitch;
      applyView();
      return;
    }
    st.tween = { from: { yaw: st.yaw, pitch: st.pitch }, to, start: performance.now(), ms: 320 };
    schedule();
  }

  function view() {
    const d = norm(st.yaw);
    return { yaw: d, pitch: Math.round(st.pitch), side: d <= 45 || d >= 315 ? 'front' : d >= 135 && d <= 225 ? 'back' : 'side' };
  }

  // ---------- Arrastrar y teclado ----------
  let drag = null;
  if (has3d) {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      el.focus({ preventScroll: true });
      el.setPointerCapture?.(e.pointerId);
      st.tween = null;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
      el.classList.add('sk-dragging');
    });
    el.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      st.yaw += (e.clientX - drag.x) * 0.6;
      st.pitch = clamp(st.pitch + (e.clientY - drag.y) * 0.4, -30, 40);
      drag.x = e.clientX;
      drag.y = e.clientY;
      applyView();
    });
    const end = (e) => {
      if (!drag || (e.pointerId !== undefined && e.pointerId !== drag.id)) return;
      drag = null;
      el.classList.remove('sk-dragging');
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('lostpointercapture', end);
    el.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 45 : 15;
      const keys = {
        ArrowLeft: () => turnTo(st.yaw - step),
        ArrowRight: () => turnTo(st.yaw + step),
        ArrowUp: () => turnTo(st.yaw, st.pitch + 10),
        ArrowDown: () => turnTo(st.yaw, st.pitch - 10),
        PageUp: () => turnTo(st.yaw - 90),
        PageDown: () => turnTo(st.yaw + 90),
        Home: () => turnTo(0, DEFAULT.pitch),
        End: () => turnTo(180, DEFAULT.pitch),
      };
      if (!keys[e.key] || e.altKey || e.ctrlKey || e.metaKey) return;
      e.preventDefault();
      keys[e.key]();
    });
  }

  // ---------- Tamano: la escena se escala para entrar en el recuadro ----------
  const fit = () => {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const k = clamp(Math.min(r.height / (S * 45), r.width / (S * 26)), 0.35, 2.4);
    el.style.setProperty('--sk-k', k.toFixed(3));
  };
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(fit) : null;
  ro?.observe(el);
  // Si cambia el movimiento reducido (Ajustes > Accesibilidad), se arranca o se frena la animacion
  const mo = new MutationObserver(() => schedule());
  if (document.body) mo.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  const onVisible = () => schedule();
  document.addEventListener('visibilitychange', onVisible);

  applyView();

  return {
    el,
    has3d,
    setSkin(canvas, variant = 'classic') {
      st.skin = canvas || null;
      st.variant = variant === 'slim' ? 'slim' : 'classic';
      build();
    },
    setCape(canvas) {
      st.cape = canvas || null;
      build();
    },
    setCapeVisible(on) {
      st.capeOn = Boolean(on);
      build();
    },
    get capeVisible() {
      return st.capeOn;
    },
    get hasCape() {
      return Boolean(st.cape);
    },
    setPaused(on) {
      st.paused = Boolean(on);
      st.t0 = 0;
      schedule();
    },
    get paused() {
      return st.paused;
    },
    show(side) {
      if (side === 'back') turnTo(180, DEFAULT.pitch);
      else if (side === 'front') turnTo(0, DEFAULT.pitch);
      else turnTo(DEFAULT.yaw, DEFAULT.pitch);
    },
    rotate(deg) {
      turnTo(st.yaw + deg);
    },
    view,
    destroy() {
      st.destroyed = true;
      if (st.raf) cancelAnimationFrame(st.raf);
      ro?.disconnect();
      mo.disconnect();
      document.removeEventListener('visibilitychange', onVisible);
    },
  };
}
