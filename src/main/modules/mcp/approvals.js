'use strict';
// Confirmaciones del MCP: una accion destructiva (remove_mod, deshacer la creacion de una instancia), un cambio
// riesgoso (cambiar la version o el loader de una instancia con mundos) o una instalacion masiva espera a que el
// usuario la apruebe en la ventana del launcher.
// Nunca se aprueba sola: si no contesta a tiempo queda 'expired' (= denegada); si el cliente MCP corta el
// pedido, 'cancelled'. La interfaz recibe el evento mcp:approval y responde con mcp:approve(requestId, ok).
// Si la interfaz todavia no escucha (por ejemplo, durante el arranque), se usa un dialogo nativo (showNative).
const crypto = require('crypto');

const TIMEOUT_MS = 50000;

function createApprovals({ send = () => {}, timeoutMs = TIMEOUT_MS, uiReady = () => false, showNative = null, attention = () => {}, now = Date.now } = {}) {
  const pending = new Map(); // requestId -> { payload, finish }

  function publicView(p) {
    const { requestId, tool, kind, title, message, items, okText, danger, client, source, createdAt, expiresAt } = p;
    return { requestId, tool, kind, title, message, items, okText, danger, client, source, createdAt, expiresAt, state: 'pending' };
  }

  /**
   * payload: { tool, kind, title, message, items?, okText?, danger?, client?, source? }
   * Devuelve 'approved' | 'denied' | 'expired' | 'cancelled'.
   */
  function request(payload, { signal, timeout = timeoutMs } = {}) {
    return new Promise((resolve) => {
      const requestId = `a${crypto.randomBytes(9).toString('hex')}`;
      const createdAt = now();
      const p = {
        requestId,
        tool: String(payload.tool || ''),
        kind: payload.kind || 'destructive',
        title: String(payload.title || ''),
        message: String(payload.message || ''),
        items: Array.isArray(payload.items) ? payload.items.slice(0, 20).map((x) => String(x).slice(0, 200)) : [],
        okText: payload.okText ? String(payload.okText) : null,
        danger: payload.danger !== false,
        client: payload.client || null,
        source: payload.source || 'local',
        createdAt,
        expiresAt: createdAt + timeout,
      };
      let done = false;
      let timer = null;
      let nativeAbort = null;
      const onAbort = () => finish('cancelled');
      function finish(state) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        pending.delete(requestId);
        signal?.removeEventListener('abort', onAbort);
        if (nativeAbort) nativeAbort.abort();
        try {
          send('mcp:approval', { requestId, state });
        } catch {
          /* ventana cerrada */
        }
        resolve(state);
      }
      if (signal?.aborted) {
        done = true;
        resolve('cancelled');
        return;
      }
      pending.set(requestId, { payload: p, finish });
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => finish('expired'), timeout);
      timer.unref?.();
      try {
        attention(p);
      } catch {
        /* sin ventana */
      }
      if (uiReady() || typeof showNative !== 'function') {
        try {
          send('mcp:approval', publicView(p));
        } catch {
          /* ventana cerrada */
        }
      } else {
        nativeAbort = new AbortController();
        Promise.resolve(showNative(p, nativeAbort.signal))
          .then((ok) => {
            if (ok === true) finish('approved');
            else if (ok === false) finish('denied');
          })
          .catch(() => {});
      }
    });
  }

  function answer(requestId, ok) {
    const entry = pending.get(String(requestId || ''));
    if (!entry) return false;
    entry.finish(ok === true ? 'approved' : 'denied');
    return true;
  }

  function list() {
    return [...pending.values()].map((e) => publicView(e.payload));
  }

  function cancelAll() {
    for (const e of [...pending.values()]) e.finish('cancelled');
  }

  return { request, answer, list, cancelAll, get size() {
    return pending.size;
  } };
}

module.exports = { createApprovals, TIMEOUT_MS };
