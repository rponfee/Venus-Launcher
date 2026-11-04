'use strict';
// Cliente propio de obs-websocket v5, con la WebSocket global (sin dependencias ni Electron: se prueba con un socket falso).
// Protocolo: el servidor manda Hello (op 0); si pide autenticacion, la respuesta es
//   base64(sha256(base64(sha256(contraseña + salt)) + challenge))
// y va en Identify (op 1). Con Identified (op 2) ya se pueden mandar pedidos (Request, op 6; la respuesta llega en
// RequestResponse, op 7) y llegan los eventos (Event, op 5) de las categorias suscriptas.
const crypto = require('crypto');
const { EventEmitter } = require('events');

const OP = { Hello: 0, Identify: 1, Identified: 2, Event: 5, Request: 6, RequestResponse: 7 };
const RPC_VERSION = 1;
const SUB_GENERAL = 1 << 0;
const SUB_SCENES = 1 << 2;
const SUB_OUTPUTS = 1 << 6;
const SUBSCRIPTIONS = SUB_GENERAL | SUB_SCENES | SUB_OUTPUTS;
const SUBPROTOCOL = 'obswebsocket.json';
const CONNECT_TIMEOUT_MS = 6000;
const REQUEST_TIMEOUT_MS = 8000;
// Codigos con los que cierra el servidor
const CLOSE_AUTH_FAILED = 4009;
const CLOSE_RPC_UNSUPPORTED = 4010;

const sha256b64 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('base64');

function authResponse(password, salt, challenge) {
  return sha256b64(sha256b64(`${password}${salt}`) + challenge);
}

function coded(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

class ObsClient extends EventEmitter {
  /** opts = { host, port, password, WebSocketImpl?, timeouts? }. Eventos: 'event' (tipo, datos), 'close' ({ code, reason }). */
  constructor({ host = '127.0.0.1', port = 4455, password = '', WebSocketImpl = null, connectTimeout = CONNECT_TIMEOUT_MS, requestTimeout = REQUEST_TIMEOUT_MS } = {}) {
    super();
    this.url = `ws://${String(host).includes(':') ? `[${host}]` : host}:${Number(port)}`;
    this.password = password || '';
    this.WS = WebSocketImpl || globalThis.WebSocket;
    this.connectTimeout = connectTimeout;
    this.requestTimeout = requestTimeout;
    this.ws = null;
    this.pending = new Map();
    this.seq = 0;
    this.identified = false;
    this.closed = false;
  }

  // Conecta e identifica. Devuelve { rpcVersion, obsWebSocketVersion }. Errores con code: 'refused', 'timeout', 'auth',
  // 'authRequired' (pide contraseña y no hay), 'version'.
  connect() {
    if (!this.WS) return Promise.reject(coded('refused', 'no WebSocket'));
    return new Promise((resolve, reject) => {
      let settled = false;
      let hello = null;
      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) {
          this.closeSocket();
          reject(err);
        } else resolve(value);
      };
      const timer = setTimeout(() => finish(coded('timeout')), this.connectTimeout);
      timer.unref?.();
      let ws;
      try {
        ws = new this.WS(this.url, SUBPROTOCOL);
      } catch (err) {
        finish(coded('refused', err?.message));
        return;
      }
      this.ws = ws;
      ws.onmessage = (e) => {
        let msg;
        try {
          msg = JSON.parse(typeof e.data === 'string' ? e.data : Buffer.from(e.data).toString('utf8'));
        } catch {
          return;
        }
        if (msg?.op === OP.Hello) {
          hello = msg.d || {};
          const identify = { rpcVersion: RPC_VERSION, eventSubscriptions: SUBSCRIPTIONS };
          if (hello.authentication) {
            if (!this.password) {
              finish(coded('authRequired'));
              return;
            }
            identify.authentication = authResponse(this.password, hello.authentication.salt, hello.authentication.challenge);
          }
          this.sendOp(OP.Identify, identify);
        } else if (msg?.op === OP.Identified) {
          this.identified = true;
          finish(null, { rpcVersion: msg.d?.negotiatedRpcVersion ?? RPC_VERSION, obsWebSocketVersion: hello?.obsWebSocketVersion || null });
        } else if (msg?.op === OP.Event) {
          this.emit('event', String(msg.d?.eventType || ''), msg.d?.eventData || {});
        } else if (msg?.op === OP.RequestResponse) {
          this.onResponse(msg.d || {});
        }
      };
      ws.onerror = () => finish(coded('refused'));
      ws.onclose = (e) => {
        const code = Number(e?.code) || 0;
        this.failPending(coded('closed'));
        const wasIdentified = this.identified;
        this.identified = false;
        if (!settled) {
          if (code === CLOSE_AUTH_FAILED) finish(coded('auth'));
          else if (code === CLOSE_RPC_UNSUPPORTED) finish(coded('version'));
          else finish(coded('refused'));
        }
        if (wasIdentified || !this.closed) this.emit('close', { code, reason: String(e?.reason || '') });
      };
    });
  }

  sendOp(op, d) {
    this.ws?.send(JSON.stringify({ op, d }));
  }

  onResponse(d) {
    const p = this.pending.get(d.requestId);
    if (!p) return;
    this.pending.delete(d.requestId);
    clearTimeout(p.timer);
    if (d.requestStatus?.result) p.resolve(d.responseData || {});
    else {
      const err = coded('request', d.requestStatus?.comment || d.requestType);
      err.status = d.requestStatus?.code ?? null;
      p.reject(err);
    }
  }

  failPending(err) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  // Un pedido: request('GetSceneList') -> responseData
  request(requestType, requestData) {
    if (!this.identified) return Promise.reject(coded('closed'));
    const requestId = `v${(++this.seq).toString(36)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(coded('timeout'));
      }, this.requestTimeout);
      timer.unref?.();
      this.pending.set(requestId, { resolve, reject, timer });
      const d = { requestType, requestId };
      if (requestData) d.requestData = requestData;
      try {
        this.sendOp(OP.Request, d);
      } catch (err) {
        this.pending.delete(requestId);
        clearTimeout(timer);
        reject(coded('closed', err?.message));
      }
    });
  }

  closeSocket() {
    try {
      this.ws?.close();
    } catch {
      /* ya estaba cerrado */
    }
  }

  close() {
    this.closed = true;
    this.identified = false;
    this.failPending(coded('closed'));
    this.closeSocket();
    this.ws = null;
  }

  // ---------- Pedidos que usa el launcher ----------

  async sceneList() {
    const r = await this.request('GetSceneList');
    const scenes = (Array.isArray(r.scenes) ? r.scenes : []).map((s) => String(s?.sceneName || '')).filter(Boolean);
    // OBS las manda de abajo hacia arriba: se muestran como en su lista
    return { scenes: scenes.reverse(), current: r.currentProgramSceneName || null };
  }

  setScene(sceneName) {
    return this.request('SetCurrentProgramScene', { sceneName });
  }

  // { streaming, recording }
  async outputs() {
    const [stream, record] = await Promise.all([this.request('GetStreamStatus'), this.request('GetRecordStatus')]);
    return { streaming: stream.outputActive === true, recording: record.outputActive === true };
  }
}

module.exports = { ObsClient, OP, SUBSCRIPTIONS, SUBPROTOCOL, CLOSE_AUTH_FAILED, CLOSE_RPC_UNSUPPORTED, authResponse };
