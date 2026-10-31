'use strict';
// Control de plan del MCP (del lado del launcher: es una restriccion del cliente, ver docs/mcp.md).
// El MCP funciona solo con la cuenta de Venus iniciada y un plan vigente de Venus IA (desde Basic) en estado
// 'active' o 'trialing'. La fuente es la cuota del backend de la IA (ai.status().quota) y, si no esta (IA
// apagada en Ajustes), el estado de facturacion (billing.state()).
// Un "no" del servidor (sin sesion, sin plan) corta enseguida. Un error de red o de sesion no: se usa el
// ultimo "si" verificado de esa misma cuenta durante unas horas (graceMs), asi un corte del backend no
// deja sin herramientas a quien paga.
// Sin Electron: las dependencias llegan por parametro (las pruebas usan dobles).

const { STATIC_PLANS } = require('../billing/client');
const DEFAULT_PAID = Object.freeze(STATIC_PLANS.map((plan) => plan.id));
const GRACE_MS = 72 * 3600 * 1000;

// reason: 'ok' | 'checking' | 'noCloud' | 'signedOut' | 'noPlan' | 'freePlan' | 'offline' | 'error'
function createGate({ aiStatus, billingState, session, readCache, writeCache, now = Date.now, graceMs = GRACE_MS, onChange = () => {} } = {}) {
  let current = { entitled: false, reason: 'checking', plan: null, planName: null, status: null, source: null, checkedAt: 0, verifiedAt: 0, definitive: false };
  let inflight = null;

  function isPaid(plan) {
    return typeof plan === 'string' && DEFAULT_PAID.includes(plan.toLowerCase());
  }

  function set(next) {
    const prev = current;
    current = { ...next, checkedAt: now() };
    if (prev.entitled !== current.entitled || prev.reason !== current.reason || prev.plan !== current.plan || prev.status !== current.status) {
      try {
        onChange(current, prev);
      } catch (err) {
        console.warn('[mcp] onChange del plan:', err?.message || err);
      }
    }
    return current;
  }

  // Plan segun la cuota de la IA o la facturacion. Devuelve { plan, planName, status, priceUsd, source } o
  // null si no se pudo saber (error de red, de sesion o sin servidor).
  async function readPlan(st) {
    const q = st && st.provider === 'backend' && st.quota && typeof st.quota === 'object' ? st.quota : null;
    if (q && typeof q.status === 'string') {
      return { plan: q.plan || null, planName: q.planName || null, status: q.status, priceUsd: typeof q.priceUsd === 'number' ? q.priceUsd : null, source: 'quota' };
    }
    if (typeof billingState !== 'function') return null;
    try {
      const b = await billingState();
      if (!b || typeof b !== 'object') return null;
      const status = b.active === true ? (b.status === 'trialing' ? 'trialing' : 'active') : 'none';
      return { plan: b.plan || null, planName: b.planName || null, status, priceUsd: null, source: 'billing' };
    } catch (err) {
      if (err?.code === 'noSession') return { signedOut: true };
      return null;
    }
  }

  async function evaluate({ refresh }) {
    const sess = await Promise.resolve(session ? session() : null).catch(() => null);
    let st = null;
    try {
      st = aiStatus ? await aiStatus({ refresh }) : null;
    } catch {
      st = null;
    }
    if (st && st.cloudConfigured === false) {
      await Promise.resolve(writeCache && writeCache(null)).catch(() => {});
      return { entitled: false, reason: 'noCloud', plan: null, planName: null, status: null, source: 'ai', definitive: true };
    }
    if ((st && st.signedIn === false) || (!sess && st)) {
      await Promise.resolve(writeCache && writeCache(null)).catch(() => {});
      return { entitled: false, reason: 'signedOut', plan: null, planName: null, status: null, source: 'ai', definitive: true };
    }
    const p = await readPlan(st);
    if (p && p.signedOut) {
      return { entitled: false, reason: 'signedOut', plan: null, planName: null, status: null, source: 'billing', definitive: true };
    }
    if (p) {
      const active = p.status === 'active' || p.status === 'trialing';
      const paid = isPaid(p.plan);
      if (active && paid) {
        const verifiedAt = now();
        await Promise.resolve(writeCache && writeCache({ userId: sess?.userId || null, plan: p.plan, planName: p.planName, status: p.status, at: verifiedAt })).catch(() => {});
        return { entitled: true, reason: 'ok', plan: p.plan, planName: p.planName, status: p.status, source: p.source, definitive: true, verifiedAt };
      }
      await Promise.resolve(writeCache && writeCache(null)).catch(() => {});
      return { entitled: false, reason: active ? 'freePlan' : 'noPlan', plan: p.plan, planName: p.planName, status: p.status, source: p.source, definitive: true };
    }
    // No se pudo saber: ultimo "si" de esta misma cuenta, si es reciente
    const cached = await Promise.resolve(readCache ? readCache() : null).catch(() => null);
    if (cached && sess?.userId && cached.userId === sess.userId && typeof cached.at === 'number' && now() - cached.at < graceMs && isPaid(cached.plan)) {
      return { entitled: true, reason: 'ok', plan: cached.plan, planName: cached.planName || null, status: cached.status || 'active', source: 'cache', definitive: false, verifiedAt: cached.at };
    }
    return { entitled: false, reason: sess ? 'offline' : 'error', plan: null, planName: null, status: null, source: null, definitive: false };
  }

  /** Revisa el plan (una sola revision a la vez). refresh: pedirle la cuota al backend aunque haya una reciente. */
  function check({ refresh = false } = {}) {
    if (inflight) return inflight;
    inflight = evaluate({ refresh })
      .then((v) => set({ verifiedAt: current.verifiedAt, ...v }))
      .catch((err) => set({ entitled: false, reason: 'error', plan: null, planName: null, status: null, source: null, definitive: false, error: err?.message || String(err) }))
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  /** Espera la revision en curso (o la primera) como mucho ms milisegundos. */
  async function ready(ms = 8000) {
    if (current.reason !== 'checking' && !inflight) return current;
    const p = inflight || check();
    await Promise.race([p, new Promise((r) => setTimeout(r, ms).unref?.())]);
    return current;
  }

  return {
    check,
    ready,
    isPaid,
    get state() {
      return current;
    },
    get entitled() {
      return current.entitled === true;
    },
    get checking() {
      return Boolean(inflight);
    },
  };
}

module.exports = { createGate, DEFAULT_PAID, GRACE_MS };
