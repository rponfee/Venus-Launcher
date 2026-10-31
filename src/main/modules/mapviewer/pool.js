'use strict';
// Grupo de hilos (worker_threads) para renderizar regiones sin trabar el proceso principal.
// El codigo del hilo se arma en memoria con los archivos de esta carpeta (asi funciona igual dentro de un .asar).
// Dos colas: 'high' (teselas que la interfaz esta mostrando) y 'low' (renderizar todo).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');
const { t } = require('../../core/i18n');

const FILES = ['lz4', 'anvil', 'colors', 'legacy', 'chunk', 'render', 'png', 'worker'];
const IDLE_MS = 45000;

let bundle = null;
function buildBundle() {
  if (bundle) return bundle;
  const sources = {};
  for (const name of FILES) sources[`./${name}`] = fs.readFileSync(path.join(__dirname, `${name}.js`), 'utf8');
  bundle = `'use strict';
const vm = require('vm');
const SOURCES = ${JSON.stringify(sources)};
const cache = {};
function load(name) {
  const key = name.replace(/\\.js$/, '');
  if (!Object.prototype.hasOwnProperty.call(SOURCES, key)) return require(name);
  if (cache[key]) return cache[key].exports;
  const module = { exports: {} };
  cache[key] = module;
  const fn = vm.compileFunction(SOURCES[key], ['module', 'exports', 'require'], { filename: 'mapviewer/' + key.slice(2) + '.js' });
  fn(module, module.exports, load);
  return module.exports;
}
load('./worker');
`;
  return bundle;
}

function defaultSize() {
  const cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, Math.min(4, cores - 1));
}

class Pool {
  constructor({ size = defaultSize(), idleMs = IDLE_MS } = {}) {
    this.size = size;
    this.idleMs = idleMs;
    this.workers = [];
    this.high = [];
    this.low = [];
    this.seq = 0;
    this.idleTimer = null;
    this.closed = false;
  }

  spawn() {
    const w = new Worker(buildBundle(), { eval: true });
    const slot = { worker: w, job: null };
    w.on('message', (msg) => this.onMessage(slot, msg));
    w.on('error', (err) => this.onExit(slot, err));
    w.on('exit', (code) => this.onExit(slot, code ? new Error(t('mapviewer.errWorker', { code })) : null));
    w.unref();
    this.workers.push(slot);
    return slot;
  }

  onMessage(slot, msg) {
    const job = slot.job;
    slot.job = null;
    slot.worker.unref();
    if (job && msg && msg.id === job.id) {
      if (msg.ok) job.resolve(msg.png ? { ...msg.result, png: Buffer.from(msg.png.buffer, msg.png.byteOffset, msg.png.byteLength) } : msg.result);
      else {
        const err = new Error(msg.error || t('mapviewer.errWorker', { code: '?' }));
        err.code = msg.code || undefined;
        job.reject(err);
      }
    }
    this.pump();
  }

  onExit(slot, err) {
    const i = this.workers.indexOf(slot);
    if (i < 0) return;
    this.workers.splice(i, 1);
    if (slot.job) {
      slot.job.reject(err || new Error(t('mapviewer.errWorkerClosed')));
      slot.job = null;
    }
    if (!this.closed) this.pump();
  }

  // job: { file, dim, out, returnPng? } -> Promise<result>. Devuelve tambien un manejador para subir la prioridad.
  run(payload, priority = 'high') {
    if (this.closed) return Promise.reject(new Error(t('mapviewer.errWorkerClosed')));
    let handle;
    const promise = new Promise((resolve, reject) => {
      handle = { id: ++this.seq, payload, resolve, reject, priority };
    });
    (priority === 'low' ? this.low : this.high).push(handle);
    promise.handle = handle;
    this.pump();
    return promise;
  }

  // Pasa un trabajo de la cola baja a la alta (la interfaz lo necesita ya)
  promote(handle) {
    if (!handle || handle.priority === 'high') return;
    const i = this.low.indexOf(handle);
    if (i >= 0) {
      this.low.splice(i, 1);
      handle.priority = 'high';
      this.high.push(handle);
    }
  }

  pending() {
    return this.high.length + this.low.length + this.workers.filter((w) => w.job).length;
  }

  pump() {
    if (this.closed) return;
    clearTimeout(this.idleTimer);
    for (;;) {
      const queue = this.high.length ? this.high : this.low;
      if (!queue.length) break;
      let slot = this.workers.find((w) => !w.job);
      if (!slot) {
        if (this.workers.length >= this.size) break;
        try {
          slot = this.spawn();
        } catch (err) {
          const job = queue.shift();
          job.reject(err);
          continue;
        }
      }
      const job = queue.shift();
      slot.job = job;
      slot.worker.ref();
      try {
        slot.worker.postMessage({ id: job.id, ...job.payload });
      } catch (err) {
        slot.job = null;
        job.reject(err);
      }
    }
    if (!this.pending() && this.workers.length) {
      this.idleTimer = setTimeout(() => this.shrink(), this.idleMs);
      this.idleTimer.unref?.();
    }
  }

  // Cierra los hilos ociosos (liberan memoria) despues de un rato sin trabajo
  shrink() {
    for (const slot of [...this.workers]) {
      if (!slot.job) {
        this.workers.splice(this.workers.indexOf(slot), 1);
        slot.worker.terminate().catch(() => {});
      }
    }
  }

  async close() {
    this.closed = true;
    clearTimeout(this.idleTimer);
    const err = new Error(t('mapviewer.errWorkerClosed'));
    for (const job of [...this.high, ...this.low]) job.reject(err);
    this.high = [];
    this.low = [];
    const all = this.workers.splice(0);
    await Promise.all(
      all.map((slot) => {
        if (slot.job) slot.job.reject(err);
        return slot.worker.terminate().catch(() => {});
      }),
    );
  }
}

module.exports = { Pool, buildBundle, defaultSize };
