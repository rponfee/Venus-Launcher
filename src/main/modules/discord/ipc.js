'use strict';
// Cliente del IPC local de Discord (Rich Presence) en Node puro, sin dependencias.
// Windows: tubería con nombre \\?\pipe\discord-ipc-0..9 · Linux/macOS: socket unix <tmp>/discord-ipc-0..9
// Cada mensaje: opcode (int32 LE) + largo (int32 LE) + JSON en UTF-8.
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };
const HEADER = 8;
const MAX_FRAME = 4 * 1024 * 1024;

function encode(op, payload) {
  const json = Buffer.from(JSON.stringify(payload === undefined ? {} : payload), 'utf8');
  const buf = Buffer.alloc(HEADER + json.length);
  buf.writeInt32LE(op, 0);
  buf.writeInt32LE(json.length, 4);
  json.copy(buf, HEADER);
  return buf;
}

// Decodificador incremental: los mensajes pueden llegar partidos o varios juntos en un mismo chunk
class FrameDecoder {
  constructor() {
    this.buf = Buffer.alloc(0);
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : Buffer.from(chunk);
    const frames = [];
    while (this.buf.length >= HEADER) {
      const op = this.buf.readInt32LE(0);
      const len = this.buf.readInt32LE(4);
      if (len < 0 || len > MAX_FRAME) throw Object.assign(new Error(`Frame inválido (${len} bytes)`), { code: 'BAD_FRAME' });
      if (this.buf.length < HEADER + len) break;
      const body = this.buf.subarray(HEADER, HEADER + len).toString('utf8');
      this.buf = this.buf.subarray(HEADER + len);
      let data = null;
      try {
        data = body ? JSON.parse(body) : null;
      } catch {
        throw Object.assign(new Error('JSON inválido en el IPC de Discord'), { code: 'BAD_FRAME' });
      }
      frames.push({ op, data });
    }
    return frames;
  }
}

// Rutas donde Discord (o sus variantes flatpak/snap/Vesktop) abre el IPC
function candidatePaths({ prefix = 'discord-ipc', platform = process.platform, env = process.env } = {}) {
  const ids = Array.from({ length: 10 }, (_, i) => i);
  if (platform === 'win32') return ids.map((i) => `\\\\?\\pipe\\${prefix}-${i}`);
  const base = env.XDG_RUNTIME_DIR || env.TMPDIR || env.TMP || env.TEMP || '/tmp';
  const dirs = [
    base,
    path.join(base, 'app', 'com.discordapp.Discord'),
    path.join(base, 'app', 'com.discordapp.DiscordCanary'),
    path.join(base, 'app', 'dev.vencord.Vesktop'),
    path.join(base, '.flatpak', 'dev.vencord.Vesktop', 'xdg-run'),
    path.join(base, 'snap.discord'),
    path.join(base, 'snap.discord-canary'),
  ];
  if (base !== '/tmp') dirs.push('/tmp');
  return dirs.flatMap((d) => ids.map((i) => path.join(d, `${prefix}-${i}`)));
}

function ipcError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

function openSocket(p, timeout) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(p);
    const timer = setTimeout(() => {
      sock.destroy();
      reject(ipcError('TIMEOUT', 'timeout'));
    }, timeout);
    const onError = (err) => {
      clearTimeout(timer);
      sock.destroy();
      reject(err);
    };
    sock.once('connect', () => {
      clearTimeout(timer);
      sock.removeListener('error', onError);
      sock.on('error', () => {
        /* lo maneja el evento close */
      });
      resolve(sock);
    });
    sock.once('error', onError);
  });
}

/**
 * Conexión con Discord. Eventos: 'close' ({ code, message }), 'dispatch' ({ evt, data }).
 * const c = new DiscordIpc({ clientId }); const ready = await c.connect(); await c.setActivity({...});
 */
class DiscordIpc extends EventEmitter {
  constructor({ clientId, paths, timeout = 6000, pid = process.pid } = {}) {
    super();
    this.clientId = String(clientId || '');
    this.paths = paths || candidatePaths();
    this.timeout = timeout;
    this.pid = pid;
    this.sock = null;
    this.decoder = new FrameDecoder();
    this.pending = new Map();
    this.connected = false;
    this.closed = false;
    this.user = null;
  }

  async connect() {
    let lastErr = null;
    for (const p of this.paths) {
      try {
        this.sock = await openSocket(p, Math.min(this.timeout, 3000));
        this.pipe = p;
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (!this.sock) throw ipcError('NO_DISCORD', 'Discord no está abierto', { cause: lastErr });
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.destroy();
        reject(ipcError('TIMEOUT', 'Discord no respondió al saludo'));
      }, this.timeout);
      this.sock.on('data', (chunk) => {
        let frames;
        try {
          frames = this.decoder.push(chunk);
        } catch (err) {
          this.destroy();
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(err);
          }
          return;
        }
        for (const f of frames) {
          if (!settled && f.op === OP.FRAME && f.data?.cmd === 'DISPATCH' && f.data?.evt === 'READY') {
            settled = true;
            clearTimeout(timer);
            this.connected = true;
            this.user = f.data.data?.user || null;
            resolve(f.data.data || {});
            continue;
          }
          if (!settled && f.op === OP.CLOSE) {
            settled = true;
            clearTimeout(timer);
            this.destroy();
            reject(ipcError(f.data?.code === 4000 ? 'INVALID_CLIENT' : 'CLOSED', f.data?.message || 'Discord cerró la conexión', { discordCode: f.data?.code }));
            return;
          }
          if (!settled && f.op === OP.FRAME && f.data?.evt === 'ERROR') {
            settled = true;
            clearTimeout(timer);
            this.destroy();
            reject(ipcError(f.data?.data?.code === 4000 ? 'INVALID_CLIENT' : 'RPC_ERROR', f.data?.data?.message || 'Error de Discord', { discordCode: f.data?.data?.code }));
            return;
          }
          this.onFrame(f);
        }
      });
      this.sock.on('close', () => {
        const wasConnected = this.connected;
        this.connected = false;
        this.sock = null;
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(ipcError('CLOSED', 'Se cortó la conexión con Discord'));
        }
        this.pending.clear();
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(ipcError('CLOSED', 'Discord cerró la conexión'));
        }
        if (wasConnected && !this.closed) this.emit('close', { code: this.closeCode || null, message: this.closeMessage || null });
      });
      this.sock.on('error', () => {
        /* el evento close se encarga */
      });
      this.write(OP.HANDSHAKE, { v: 1, client_id: this.clientId });
    });
  }

  onFrame(f) {
    if (f.op === OP.PING) {
      this.write(OP.PONG, f.data);
      return;
    }
    if (f.op === OP.CLOSE) {
      this.closeCode = f.data?.code;
      this.closeMessage = f.data?.message;
      this.sock?.end();
      return;
    }
    if (f.op !== OP.FRAME || !f.data) return;
    const { nonce, evt } = f.data;
    if (nonce && this.pending.has(nonce)) {
      const p = this.pending.get(nonce);
      this.pending.delete(nonce);
      clearTimeout(p.timer);
      if (evt === 'ERROR') p.reject(ipcError('RPC_ERROR', f.data.data?.message || 'Error de Discord', { discordCode: f.data.data?.code }));
      else p.resolve(f.data.data);
      return;
    }
    if (f.data.cmd === 'DISPATCH') this.emit('dispatch', { evt, data: f.data.data });
  }

  write(op, payload) {
    if (!this.sock || this.sock.destroyed) return false;
    return this.sock.write(encode(op, payload));
  }

  request(cmd, args) {
    if (!this.connected || !this.sock) return Promise.reject(ipcError('CLOSED', 'Sin conexión con Discord'));
    const nonce = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(nonce);
        reject(ipcError('TIMEOUT', 'Discord no respondió'));
      }, this.timeout);
      this.pending.set(nonce, { resolve, reject, timer });
      this.write(OP.FRAME, { cmd, args, nonce });
    });
  }

  // activity = null borra la actividad
  setActivity(activity) {
    return this.request('SET_ACTIVITY', activity ? { pid: this.pid, activity } : { pid: this.pid });
  }

  clearActivity() {
    return this.setActivity(null);
  }

  destroy() {
    this.closed = true;
    this.connected = false;
    try {
      this.sock?.destroy();
    } catch {
      /* ya cerrado */
    }
    this.sock = null;
  }

  // Cierre ordenado: borra la actividad (si se puede) y corta
  async close({ clear = true } = {}) {
    if (this.connected && clear) {
      try {
        await Promise.race([this.clearActivity(), new Promise((r) => setTimeout(r, 1200))]);
      } catch {
        /* Discord ya no responde */
      }
    }
    this.destroy();
  }
}

module.exports = { OP, encode, FrameDecoder, candidatePaths, DiscordIpc };
