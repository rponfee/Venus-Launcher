'use strict';
// Que IA usa el Buscador inteligente. Sin Electron ni red: recibe los datos ya leidos y decide (se prueba solo).
//
// Reglas:
//  1. La IA del buscador es SOLO DE PAGO: hace falta un plan de pago de Venus IA. Sin plan (o sin sesion, o si no se
//     pudo comprobar el plan) queda apagada y el buscador usa el interprete local.
//  2. Con plan puede haber hasta dos fuentes, y se usa UNA sola, la que elige la persona:
//       venus  Venus IA (el backend del launcher: Anthropic y, de respaldo, OpenAI). Gasta la cuota del plan.
//       local  El Claude Code o el Codex de la propia PC (con su cuenta). No gasta la cuota de Venus IA.
//     Nunca las dos a la vez. La fuente local solo se ofrece con plan Go o superior (el mismo control que los motores
//     externos del Asistente) y con la app instalada y con sesion iniciada.
//  3. Antes de mandar lo que escribe a un proveedor se le avisa y acepta: un consentimiento por fuente.
//  4. Apagada o sin condiciones, el buscador funciona igual con el interprete local.
//
// prefs guardadas (settings.smartsearch.prefs): { useAi: false por defecto, aiSource: 'venus' | 'local' | null,
// aiConsent: { venus?: ISO, local?: ISO } }.

const SOURCES = ['venus', 'local'];
const ENGINE_APP = { claude: 'Claude Code', chatgpt: 'Codex' };

// Plan de la cuenta a partir de ai.status():
//   paid | none (sin plan) | signedOut | unknown (no se pudo comprobar) | disabled (IA apagada en Ajustes)
function planOf(st) {
  if (!st || typeof st !== 'object') return { state: 'unknown', name: null };
  if (st.enabled === false) return { state: 'disabled', name: null };
  if (!st.signedIn || !st.cloudConfigured) return { state: 'signedOut', name: null };
  const q = st.quota && typeof st.quota === 'object' ? st.quota : null;
  if (!q) return { state: 'unknown', name: null };
  if (q.status === 'none' || !q.plan) return { state: 'none', name: null };
  return { state: 'paid', name: String(q.planName || q.plan).slice(0, 40) };
}

// Primer motor local usable: el elegido en Ajustes si sirve, si no el primero que este instalado y con sesion.
function pickEngine(engines, preferred) {
  const usable = (id) => Boolean(engines?.[id]?.installed) && engines[id].loggedIn !== false;
  const order = [preferred, 'claude', 'chatgpt'].filter((id, i, all) => ENGINE_APP[id] && all.indexOf(id) === i);
  const id = order.find(usable);
  return id ? { engine: id, app: ENGINE_APP[id] } : null;
}

// Las versiones anteriores guardaban useAi: true por defecto, sin avisar: sin ningun aviso aceptado no cuenta como "quiere IA".
function cleanPrefs(prefs) {
  const aiConsent = {
    venus: typeof prefs?.aiConsent?.venus === 'string' ? prefs.aiConsent.venus : null,
    local: typeof prefs?.aiConsent?.local === 'string' ? prefs.aiConsent.local : null,
  };
  return {
    useAi: prefs?.useAi === true && Boolean(aiConsent.venus || aiConsent.local),
    aiSource: SOURCES.includes(prefs?.aiSource) ? prefs.aiSource : null,
    aiConsent,
  };
}

// Estado completo para la interfaz y para decidir si se usa la IA en una busqueda.
//   input: { status: ai.status(), engines: engines.cached(), entitled: Go o superior, preferredEngine, prefs }
function describe({ status, engines, entitled, preferredEngine, prefs } = {}) {
  const p = cleanPrefs(prefs);
  const plan = planOf(status);
  const paid = plan.state === 'paid';
  const eng = pickEngine(engines, preferredEngine);
  const sources = [
    { id: 'venus', available: paid },
    { id: 'local', available: paid && entitled === true && Boolean(eng), engine: eng?.engine || null, app: eng?.app || null, installed: Boolean(eng), entitled: entitled === true },
  ];
  const available = sources.filter((s) => s.available).map((s) => s.id);
  const source = p.aiSource && available.includes(p.aiSource) ? p.aiSource : available.includes('venus') ? 'venus' : available[0] || null;
  const consented = source ? Boolean(p.aiConsent[source]) : false;
  const wants = p.useAi;
  return {
    plan: plan.state,
    planName: plan.name,
    sources,
    // Hay que elegir solo cuando hay dos fuentes disponibles
    choose: available.length > 1,
    source,
    consent: { venus: Boolean(p.aiConsent.venus), local: Boolean(p.aiConsent.local) },
    wants,
    // La IA se usa de verdad solo si la persona la quiere, hay plan de pago, hay fuente y acepto el aviso
    active: wants && paid && Boolean(source) && consented,
    needsConsent: wants && paid && Boolean(source) && !consented,
  };
}

// Por que no se usa la IA aunque se la pidio (clave de aviso `warn_<clave>` de la interfaz); null si se puede usar.
function whyNot(view) {
  if (!view || view.active) return null;
  if (view.plan === 'paid') return view.needsConsent ? 'aiNeedsConsent' : null;
  return { none: 'aiNoPlan', signedOut: 'aiSignedOut', unknown: 'aiPlanUnknown', disabled: 'aiDisabled' }[view.plan] || 'aiNoPlan';
}

// Cambio pedido por la interfaz (smartsearch:aiSet). Devuelve las prefs nuevas o lanza { code } si no corresponde.
//   change: { useAi?: boolean, source?: 'venus' | 'local', consent?: boolean }
//   consent: true = la persona acepto AHORA el aviso de la fuente que queda elegida.
function applyChange(view, prefs, change = {}, now = new Date().toISOString()) {
  const next = cleanPrefs(prefs);
  const fail = (code) => Object.assign(new Error(code), { code });
  const wantsOn = change.useAi === true || (change.useAi === undefined && next.useAi);
  if (change.source !== undefined) {
    if (!SOURCES.includes(change.source)) throw fail('badSource');
    const target = view.sources.find((s) => s.id === change.source);
    if (!target?.available) throw fail(view.plan === 'paid' ? 'sourceUnavailable' : 'noplan');
    next.aiSource = change.source;
  }
  const source = next.aiSource && view.sources.find((s) => s.id === next.aiSource)?.available ? next.aiSource : view.source;
  if (change.useAi === true) {
    if (view.plan !== 'paid') throw fail('noplan');
    if (!source) throw fail('sourceUnavailable');
    if (change.consent !== true && !next.aiConsent[source]) throw fail('consent');
  }
  if (change.consent === true) {
    if (view.plan !== 'paid' || !source) throw fail('noplan');
    next.aiConsent[source] = now;
  }
  if (change.useAi !== undefined) next.useAi = change.useAi === true;
  // Cambiar de fuente sin haber aceptado su aviso apaga la IA hasta que lo acepte (nunca se manda nada sin aviso)
  if (change.source !== undefined && wantsOn && source && !next.aiConsent[source]) next.useAi = false;
  if (!next.aiSource && source) next.aiSource = source;
  return next;
}

module.exports = { SOURCES, ENGINE_APP, planOf, pickEngine, describe, whyNot, applyChange, cleanPrefs };
