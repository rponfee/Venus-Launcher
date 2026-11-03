// Sonidos de la interfaz con Web Audio: osciladores y envolventes cortas (packs.js), nunca archivos.
// Escucha los clics en botones (.btn, .icon-btn, .nav-item), los toasts (#toasts) y la apertura de diálogos
// (.modal-backdrop). Contrato: init({ getSounds }), play(id), playVoices(voices, volume), suspend().
import { soundSpec, volumeGain } from './packs.js';

const MIN_GAP_MS = 45; // dos clics seguidos (por ejemplo, teclado + click sintético) suenan una vez
const TOAST_SOUND = { good: 'success', bad: 'error', info: 'open' };

const S = { ctx: null, master: null, getSounds: () => ({ enabled: false, pack: 'soft', volume: 60 }), last: new Map(), bound: false, broken: false };

function context() {
  if (S.ctx || S.broken) return S.ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) {
    S.broken = true;
    return null;
  }
  try {
    S.ctx = new AC({ latencyHint: 'interactive' });
    S.master = S.ctx.createGain();
    S.master.gain.value = 1;
    S.master.connect(S.ctx.destination);
  } catch (err) {
    console.warn('[decor] audio', err?.message || err);
    S.broken = true;
    S.ctx = null;
  }
  return S.ctx;
}

// Toca una lista de voces ({ wave, freq, to, at, dur, gain, attack, lowpass }) al volumen (0-100).
export function playVoices(voices, volume) {
  if (!Array.isArray(voices) || !voices.length) return false;
  const gain = volumeGain(volume);
  if (gain <= 0) return false;
  const ac = context();
  if (!ac) return false;
  if (ac.state === 'suspended') ac.resume().catch(() => {});
  const t0 = ac.currentTime + 0.004;
  for (const v of voices) {
    try {
      const osc = ac.createOscillator();
      osc.type = v.wave || 'sine';
      const start = t0 + (v.at || 0);
      const dur = Math.max(0.01, v.dur || 0.05);
      const end = start + dur;
      osc.frequency.setValueAtTime(Math.max(1, v.freq || 440), start);
      if (v.to) osc.frequency.exponentialRampToValueAtTime(Math.max(1, v.to), end);
      const env = ac.createGain();
      const peak = Math.max(0.0002, Math.min(1, (v.gain ?? 0.3) * gain));
      const attack = Math.min(dur * 0.5, Math.max(0.002, v.attack || 0.004));
      env.gain.setValueAtTime(0.0001, start);
      env.gain.linearRampToValueAtTime(peak, start + attack);
      env.gain.exponentialRampToValueAtTime(0.0001, end);
      let node = osc;
      if (v.lowpass) {
        const filter = ac.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = v.lowpass;
        filter.Q.value = 0.7;
        osc.connect(filter);
        node = filter;
      }
      node.connect(env);
      env.connect(S.master);
      osc.onended = () => {
        try {
          osc.disconnect();
          env.disconnect();
          if (node !== osc) node.disconnect();
        } catch {
          /* ya desconectado */
        }
      };
      osc.start(start);
      osc.stop(end + 0.02);
    } catch (err) {
      console.warn('[decor] voz', err?.message || err);
    }
  }
  return true;
}

// Sonido de la interfaz (click, open, success, error) del pack elegido, solo si los sonidos están activados.
export function play(id) {
  const cfg = S.getSounds();
  if (!cfg?.enabled) return false;
  const now = performance.now();
  if (now - (S.last.get(id) || 0) < MIN_GAP_MS) return false;
  S.last.set(id, now);
  return playVoices(soundSpec(cfg.pack, id), cfg.volume);
}

function onClick(e) {
  if (!S.getSounds()?.enabled) return;
  const el = e.target?.closest?.('.btn, .icon-btn, .nav-item');
  if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true' || el.closest('[data-dc-silent]')) return;
  play('click');
}

function onToasts(records) {
  if (!S.getSounds()?.enabled) return;
  for (const r of records) {
    for (const n of r.addedNodes) {
      if (n.nodeType !== 1 || !n.classList.contains('toast')) continue;
      const kind = n.classList.contains('bad') ? 'bad' : n.classList.contains('good') ? 'good' : 'info';
      play(TOAST_SOUND[kind]);
      return; // varios toasts juntos: un solo sonido
    }
  }
}

function onBody(records) {
  if (!S.getSounds()?.enabled) return;
  for (const r of records) {
    for (const n of r.addedNodes) {
      if (n.nodeType === 1 && n.classList.contains('modal-backdrop')) {
        play('open');
        return;
      }
    }
  }
}

// getSounds(): { enabled, pack, volume } actuales (se consulta en cada evento: no hay que avisar los cambios).
export function init({ getSounds } = {}) {
  if (typeof getSounds === 'function') S.getSounds = getSounds;
  if (S.bound || typeof document === 'undefined') return;
  S.bound = true;
  document.addEventListener('click', onClick, true);
  const toasts = document.getElementById('toasts');
  if (toasts) new MutationObserver(onToasts).observe(toasts, { childList: true });
  new MutationObserver(onBody).observe(document.body, { childList: true });
}

// Libera el contexto (no hace falta en el uso normal; queda para pruebas).
export function suspend() {
  return S.ctx?.suspend?.() || Promise.resolve();
}
