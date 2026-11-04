'use strict';
// Paneles del overlay (recetas y asistente): que se le acepta a la pagina y que se le manda. La pagina no llega a
// ningun canal del launcher: cada pedido pasa por cleanRequest (lista cerrada de acciones, tipos y largos) y lo atiende
// overlay.js solo mientras hay un panel abierto, y solo si viene de la ventana del overlay. Sin Electron: lo prueban
// overlay/test/panels.test.js.

const PANELS = ['recipes', 'assistant'];
const MAX_QUERY = 80;
const MAX_TEXT = 8000; // el mismo tope que assistant/agent.js
const ITEM_ID = /^[a-z0-9_.-]+:[a-z0-9_./-]{1,190}$/;
const REQUEST_ID = /^r[a-zA-Z0-9_-]{4,40}$/;
// A donde puede mandar un aviso del panel dentro del launcher: nada mas que esto
const ROUTES = ['settings/plan', 'settings/ai', 'settings/cloud/venus', 'settings/privacy'];

const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

// Pedido de la pagina -> pedido limpio o null. Los campos de mas se descartan.
function cleanRequest(req) {
  if (!req || typeof req !== 'object' || Array.isArray(req) || typeof req.action !== 'string') return null;
  switch (req.action) {
    case 'recipes.info':
    case 'recipes.wikiAllow':
    case 'assistant.open':
    case 'assistant.cancel':
    case 'assistant.new':
      return { action: req.action };
    case 'recipes.search':
      return typeof req.query === 'string' ? { action: req.action, query: req.query.slice(0, MAX_QUERY) } : null;
    case 'recipes.item':
    case 'recipes.wiki':
      return typeof req.id === 'string' && !req.id.includes('..') && !req.id.includes('//') && ITEM_ID.test(req.id) ? { action: req.action, id: req.id } : null;
    case 'assistant.send': {
      const body = typeof req.text === 'string' ? req.text.trim() : '';
      return body && body.length <= MAX_TEXT ? { action: req.action, text: body } : null;
    }
    case 'assistant.confirm':
      // Sin "Permitir siempre": eso se elige en la ventana del launcher
      return typeof req.requestId === 'string' && REQUEST_ID.test(req.requestId) && typeof req.approved === 'boolean' ? { action: req.action, requestId: req.requestId, approved: req.approved } : null;
    case 'launcher.open':
      return ROUTES.includes(req.route) ? { action: req.action, route: req.route } : null;
    case 'panel.switch':
      return PANELS.includes(req.id) ? { action: req.action, id: req.id } : null;
    default:
      return null;
  }
}

// Si un panel se puede abrir ahora: 'ok', 'nogame' o 'fullscreen' (el juego en pantalla completa se minimiza al perder
// el foco y ya paso una vez en esta partida). Sin juego a la vista no hay nada sobre lo que abrirlo.
function canOpen({ usable, fullscreen, fsBlocked }) {
  if (!usable) return 'nogame';
  return fullscreen && fsBlocked ? 'fullscreen' : 'ok';
}

// Por que el asistente no puede contestar, con el mismo criterio que quotaInfo y blockedFor de features/assistant.js:
// 'disabled', 'unavailable' (sin sesion de Venus), 'plan', 'quota', 'offline' o null.
function assistantBlock(st, { online = true } = {}) {
  if (!st) return 'unavailable';
  if (st.enabled === false) return 'disabled';
  if (!online) return 'offline';
  if (!st.provider) return 'unavailable';
  if (st.needsPlan) return 'plan';
  const opts = Array.isArray(st.modelOptions) ? st.modelOptions : [];
  if (opts.length && opts.every((o) => o.blocked)) {
    // Con el Claude Code o el Codex del usuario, la cuota de Venus IA agotada no importa
    const eng = st.engines;
    const external = eng?.current && eng.current !== 'venus' && eng.entitled && eng[eng.current]?.usable;
    if (!external) return 'quota';
  }
  return null;
}

const STR = { title: 200, message: 2000, summary: 400, error: 2000, okText: 60, name: 80, stopReason: 40, code: 40, kind: 20, state: 20, level: 20, turnId: 40, requestId: 60, toolUseId: 80 };

// Evento del asistente para la pagina: solo lo que dibuja, con los textos acotados. Lo demas no viaja.
function cleanEvent(ev) {
  if (!ev || typeof ev !== 'object' || typeof ev.type !== 'string') return null;
  const out = { type: ev.type.slice(0, 20), seq: Number.isFinite(ev.seq) ? ev.seq : 0 };
  for (const [k, max] of Object.entries(STR)) if (typeof ev[k] === 'string') out[k] = ev[k].slice(0, max);
  if (typeof ev.text === 'string') out.text = ev.text.slice(0, 60000);
  for (const k of ['ok', 'declined', 'danger', 'noChange', 'failover', 'truncated']) if (ev[k] === true) out[k] = true;
  if (Array.isArray(ev.items)) out.items = ev.items.slice(0, 12).map((x) => text(x, 200));
  if (Array.isArray(ev.warnings)) out.warnings = ev.warnings.slice(0, 6).map((x) => text(x, 300));
  if (ev.undoId) out.undoable = true; // Deshacer sigue estando en la ventana del launcher
  if (ev.mcp && typeof ev.mcp === 'object') out.mcpTool = text(ev.mcp.title || ev.mcp.tool, 80);
  return out;
}

// Conversacion para la pagina: los ultimos eventos alcanzan para seguir la charla.
function cleanConversation(conv, max = 120) {
  if (!conv) return null;
  const events = Array.isArray(conv.events) ? conv.events.slice(-max).map(cleanEvent).filter(Boolean) : [];
  const pending = new Set(Array.isArray(conv.pendingConfirms) ? conv.pendingConfirms : []);
  return { id: conv.id, title: text(conv.title, 200), running: Boolean(conv.running), seq: Number(conv.seq) || 0, events, pending: [...pending] };
}

// La conversacion que retoma el panel: la que esta corriendo o la reciente (6 horas), como el panel lateral del launcher.
const RECENT_MS = 6 * 3600 * 1000;
function pickConversation(list, now = Date.now()) {
  if (!Array.isArray(list) || !list.length) return null;
  const running = list.find((c) => c?.running);
  if (running) return running.id;
  return list[0] && now - Number(list[0].updatedAt) < RECENT_MS ? list[0].id : null;
}

module.exports = { cleanRequest, canOpen, assistantBlock, cleanEvent, cleanConversation, pickConversation, ROUTES, MAX_TEXT, MAX_QUERY };
