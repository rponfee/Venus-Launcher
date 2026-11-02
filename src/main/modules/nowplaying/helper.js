'use strict';
// Proceso ayudante de Música: lo abre, lee sus mensajes, le manda comandos con respuesta y lo reabre si se cae,
// esperando cada vez más (1 s, 2 s, 4 s... hasta 60 s). Si avisa que Windows no tiene SMTC, no lo reabre.
// spawn, el comando, el reloj y los temporizadores se inyectan: las pruebas lo usan con un proceso falso.
//
// Estados (status): 'idle' (cerrado), 'starting', 'ready', 'retrying' (se cayó y espera para reabrir),
// 'stopping' y 'unsupported' (Windows sin SMTC). Eventos: 'message' (mensaje validado que no es ready/result),
// 'ready' (el mensaje ready), 'status' (status) y 'exit' ({ code, expected }).
const { EventEmitter } = require('events');
const { parseLine, encodeCommand, createLineSplitter } = require('./protocol');

// Espera creciente entre reintentos. Se reinicia cuando el proceso anduvo bien un rato (stableMs).
class Backoff {
  constructor({ base = 1000, factor = 2, max = 60000 } = {}) {
    this.base = base;
    this.factor = factor;
    this.max = max;
    this.failures = 0;
  }

  next() {
    const delay = Math.min(this.max, Math.round(this.base * this.factor ** this.failures));
    this.failures++;
    return delay;
  }

  reset() {
    this.failures = 0;
  }
}

function codeError(code, message = code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

class Helper extends EventEmitter {
  constructor({ spawn, command, now = Date.now, timers = { setTimeout, clearTimeout }, backoff = new Backoff(), readyTimeoutMs = 25000, requestTimeoutMs = 6000, stableMs = 60000, killAfterMs = 2000 }) {
    super();
    this.spawnFn = spawn;
    this.commandFn = command;
    this.now = now;
    this.timers = timers;
    this.backoff = backoff;
    this.readyTimeoutMs = readyTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.stableMs = stableMs;
    this.killAfterMs = killAfterMs;
    this.status = 'idle';
    this.wanted = false;
    this.child = null;
    this.hello = null; // último mensaje ready
    this.retryAt = 0;
    this.lastError = '';
    this.seq = 0;
    this.pending = new Map(); // req -> { resolve, reject, timer }
    this.queue = []; // líneas a mandar apenas esté listo
    this.timer = null; // reintento
    this.readyTimer = null;
    this.killTimer = null;
    this.startedAt = 0;
  }

  get running() {
    return Boolean(this.child);
  }

  info() {
    return { status: this.status, retryAt: this.status === 'retrying' ? this.retryAt : 0, failures: this.backoff.failures, audio: this.hello?.audio === true, thumbs: this.hello?.thumbs === true };
  }

  setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.emit('status', status);
  }

  // Que quede abierto (no hace nada si ya está abierto, esperando para reabrir o si Windows no tiene SMTC)
  start() {
    this.wanted = true;
    if (this.status === 'unsupported' || this.status === 'retrying' || this.child) return;
    this.spawnNow();
  }

  // Reintentar ya, sin esperar (botón Reintentar de la interfaz)
  retryNow() {
    if (this.status !== 'retrying') return false;
    this.wanted = true;
    this.spawnNow();
    return true;
  }

  // Cerrarlo (se le pide que salga y, si no sale, se lo mata)
  stop() {
    this.wanted = false;
    this.clearTimer('timer');
    if (this.status === 'retrying') this.setStatus('idle');
    if (!this.child) return;
    this.setStatus('stopping');
    this.writeRaw(encodeCommand({ cmd: 'quit' }));
    try {
      this.child.stdin?.end?.();
    } catch {
      /* ya cerrado */
    }
    const child = this.child;
    this.clearTimer('killTimer');
    this.killTimer = this.timers.setTimeout(() => {
      if (this.child === child) this.kill();
    }, this.killAfterMs);
  }

  kill() {
    try {
      this.child?.kill?.();
    } catch {
      /* ya terminó */
    }
  }

  clearTimer(name) {
    if (this[name]) this.timers.clearTimeout(this[name]);
    this[name] = null;
  }

  spawnNow() {
    this.clearTimer('timer');
    let child;
    try {
      const cmd = this.commandFn();
      child = this.spawnFn(cmd.file, cmd.args, { env: cmd.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      this.lastError = err?.message || String(err);
      this.onExit(null, null, true);
      return;
    }
    this.child = child;
    this.hello = null;
    this.startedAt = this.now();
    this.setStatus('starting');
    const split = createLineSplitter();
    let stderr = '';
    let ended = false;
    const finish = (code) => {
      if (ended) return;
      ended = true;
      if (this.child === child) this.onExit(code, stderr);
    };
    child.stdout?.setEncoding?.('utf8');
    child.stdout?.on('data', (chunk) => {
      if (this.child !== child) return;
      for (const line of split(chunk)) this.onLine(line);
    });
    child.stderr?.on('data', (chunk) => {
      stderr = (stderr + String(chunk)).slice(-2000);
    });
    child.stdin?.on?.('error', () => {}); // EPIPE si se cerró justo
    child.on('error', (err) => {
      this.lastError = err?.message || String(err);
      finish(null);
    });
    child.on('exit', (code) => finish(code));
    this.readyTimer = this.timers.setTimeout(() => {
      if (this.child === child && this.status === 'starting') {
        this.lastError = 'ready timeout';
        this.kill();
      }
    }, this.readyTimeoutMs);
  }

  onLine(line) {
    const msg = parseLine(line);
    if (!msg) return;
    if (msg.t === 'ready') {
      this.clearTimer('readyTimer');
      this.hello = msg;
      if (!msg.smtc) {
        this.lastError = msg.error || 'smtc';
        this.setStatus('unsupported');
        return; // el ayudante termina solo
      }
      this.setStatus('ready');
      const lines = this.queue.splice(0);
      for (const l of lines) this.writeRaw(l);
      this.emit('ready', msg);
      return;
    }
    if (msg.t === 'result') {
      const p = this.pending.get(msg.req);
      if (!p) return;
      this.pending.delete(msg.req);
      this.timers.clearTimeout(p.timer);
      p.resolve(msg);
      return;
    }
    this.emit('message', msg);
  }

  onExit(code, stderr, spawnFailed = false) {
    const ranMs = this.startedAt ? this.now() - this.startedAt : 0;
    this.child = null;
    this.startedAt = 0;
    this.clearTimer('readyTimer');
    this.clearTimer('killTimer');
    this.queue = [];
    for (const [req, p] of this.pending) {
      this.timers.clearTimeout(p.timer);
      p.reject(codeError('unavailable', 'helper exited'));
      this.pending.delete(req);
    }
    const stopping = this.status === 'stopping';
    const expected = !this.wanted || stopping || this.status === 'unsupported';
    if (!expected && stderr) this.lastError = String(stderr).trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 300);
    this.emit('exit', { code, expected, spawnFailed });
    if (this.status === 'unsupported') return;
    if (!this.wanted) {
      this.setStatus('idle');
      return;
    }
    // Se pidió cerrarlo y enseguida abrirlo de nuevo: se abre sin esperar
    if (stopping) {
      this.spawnNow();
      return;
    }
    // Se cayó: reabrir con espera creciente (si anduvo bien un rato, se empieza de nuevo desde la espera mínima)
    if (ranMs >= this.stableMs) this.backoff.reset();
    const delay = this.backoff.next();
    this.retryAt = this.now() + delay;
    this.setStatus('retrying');
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      if (this.wanted && !this.child && this.status === 'retrying') this.spawnNow();
    }, delay);
  }

  writeRaw(line) {
    try {
      this.child?.stdin?.write(line);
      return true;
    } catch {
      return false;
    }
  }

  // Comando con respuesta: resuelve con { ok, error } o rechaza con err.code 'unavailable' / 'timeout'
  request(cmd, args = {}) {
    if (!this.child || (this.status !== 'ready' && this.status !== 'starting')) return Promise.reject(codeError('unavailable', 'helper not running'));
    const req = ++this.seq;
    let line;
    try {
      line = encodeCommand({ ...args, cmd, req });
    } catch (err) {
      return Promise.reject(codeError('badCommand', err.message));
    }
    return new Promise((resolve, reject) => {
      const timer = this.timers.setTimeout(() => {
        this.pending.delete(req);
        reject(codeError('timeout'));
      }, this.requestTimeoutMs);
      this.pending.set(req, { resolve, reject, timer });
      if (this.status === 'ready') this.writeRaw(line);
      else this.queue.push(line);
    });
  }

  // Comando sin respuesta (poll, ping): solo si está listo
  notify(cmd) {
    if (this.status !== 'ready') return false;
    try {
      return this.writeRaw(encodeCommand({ cmd }));
    } catch {
      return false;
    }
  }
}

module.exports = { Helper, Backoff };
