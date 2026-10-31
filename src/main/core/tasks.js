'use strict';
// Tareas en segundo plano con progreso (descargas, instalaciones). La UI escucha 'update'.
const { EventEmitter } = require('events');

const bus = new EventEmitter();
const active = new Map();
let counter = 0;

class Task {
  constructor(title, meta = {}) {
    this.id = `t${++counter}`;
    this.title = title;
    this.detail = '';
    this.progress = null; // null = indeterminado, 0..1
    this.state = 'running';
    this.meta = meta;
    this.controller = new AbortController();
    this._last = 0;
    active.set(this.id, this);
    this.emit(true);
  }

  get signal() {
    return this.controller.signal;
  }

  snapshot() {
    return { id: this.id, title: this.title, detail: this.detail, progress: this.progress, state: this.state, meta: this.meta };
  }

  emit(force = false) {
    const now = Date.now();
    if (!force && now - this._last < 120) return;
    this._last = now;
    bus.emit('update', this.snapshot());
  }

  update({ detail, progress, title } = {}) {
    if (title !== undefined) this.title = title;
    if (detail !== undefined) this.detail = detail;
    if (progress !== undefined) this.progress = progress === null ? null : Math.max(0, Math.min(1, progress));
    this.emit();
  }

  // Devuelve un callback para downloadAll que mapea el avance a un rango [from, to]
  downloadProgress(label, from = 0, to = 1) {
    return ({ done, total, bytes, totalBytes }) => {
      const frac = totalBytes > 0 ? bytes / totalBytes : total ? done / total : 1;
      this.update({
        detail: `${label} ${done}/${total}${totalBytes ? ` · ${(bytes / 1048576).toFixed(1)} / ${(totalBytes / 1048576).toFixed(1)} MB` : ''}`,
        progress: from + (to - from) * Math.min(1, frac),
      });
    };
  }

  cancel() {
    this.controller.abort(new Error('Cancelado por el usuario'));
  }

  done(detail = 'Completado') {
    this.state = 'done';
    this.detail = detail;
    this.progress = 1;
    this.emit(true);
    active.delete(this.id);
  }

  fail(err) {
    this.state = 'error';
    this.detail = err?.message || String(err);
    this.emit(true);
    active.delete(this.id);
  }
}

// Ejecuta una funcion como tarea y la marca como completada/fallida automaticamente.
async function run(title, fn, meta) {
  const task = new Task(title, meta);
  try {
    const result = await fn(task);
    task.done();
    return result;
  } catch (err) {
    task.fail(err);
    throw err;
  }
}

function cancel(id) {
  const t = active.get(id);
  if (t) t.cancel();
}

module.exports = { Task, run, bus, cancel, list: () => [...active.values()].map((t) => t.snapshot()) };
