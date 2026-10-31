'use strict';
// Una busqueda del mod culpable en curso para una instancia: arma la lista de mods con sus
// dependencias, corre el nucleo (bisect.js) con pruebas reales (runner.js), lleva el estado publico que
// ve la interfaz y al terminar, cancelar o fallar deja los mods y las opciones como estaban.
const { runBisect, estimateRounds, Cancelled } = require('./bisect');
const { ModSwitcher, createGameRunner } = require('./runner');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class BisectSession {
  /**
   * opts: { instanceId, instanceDir, instanceName, mode: 'crash'|'manual', mods: [registros de scanMods activos],
   *         suspects: { archivo: puntaje }, game, getLaunch, onUpdate(estado), runnerOptions }
   */
  constructor(opts) {
    this.instanceId = opts.instanceId;
    this.instanceDir = opts.instanceDir;
    this.instanceName = opts.instanceName;
    this.mode = opts.mode === 'manual' ? 'manual' : 'crash';
    this.game = opts.game;
    this.t = opts.t || ((k) => k);
    this.onUpdate = opts.onUpdate || (() => {});
    this.mods = opts.mods;
    this.names = Object.fromEntries(this.mods.map((m) => [m.file, { name: m.name, version: m.version, library: Boolean(m.library) }]));
    this.coreMods = this.mods.map((m) => ({
      key: m.file,
      ids: m.ids,
      provides: m.provides,
      deps: (m.depends || []).map((d) => d.id),
      library: Boolean(m.library),
    }));
    this.suspects = opts.suspects || {};
    this.ctrl = new AbortController();
    this.switcher = new ModSwitcher(this.instanceDir, this.mods.map((m) => m.file), { instanceId: this.instanceId, mode: this.mode, startedAt: Date.now() });
    this.runner = createGameRunner({ game: this.game, getLaunch: opts.getLaunch }, { instanceId: this.instanceId, ...(opts.runnerOptions || {}) });
    this.status = 'starting';
    this.phase = 'verify';
    this.round = 0;
    this.estimate = estimateRounds(this.mods.length);
    this.history = [];
    this.current = null;
    this.result = null;
    this.error = null;
    this.restoreFailed = [];
    this.startedAt = Date.now();
    this.finishedAt = null;
    this.done = null;
  }

  snapshot() {
    return {
      instanceId: this.instanceId,
      instanceName: this.instanceName,
      mode: this.mode,
      status: this.status,
      phase: this.phase,
      round: this.round,
      estimate: Math.max(this.estimate, this.round),
      total: this.mods.length,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      updatedAt: Date.now(),
      waiting: this.mode === 'manual' && this.runner.waiting,
      current: this.current ? { ...this.current, enabled: [...this.current.enabled] } : null,
      history: this.history.slice(),
      mods: this.names,
      result: this.result,
      error: this.error,
      restoreFailed: this.restoreFailed,
      active: !['done', 'cancelled', 'error'].includes(this.status),
    };
  }

  emit() {
    try {
      this.onUpdate(this.snapshot());
    } catch (err) {
      console.warn('[crash] progreso', err?.message || err);
    }
  }

  async waitGameClosed(ms) {
    const until = Date.now() + ms;
    while (this.game.status()[this.instanceId]) {
      if (Date.now() > until) return false;
      await sleep(300);
    }
    return true;
  }

  async test(enabled, info) {
    if (!(await this.waitGameClosed(30000))) throw new Error(this.t('crash.errGameStillRunning'));
    this.current = { round: info.round, phase: info.phase, purpose: info.purpose, enabled: [...enabled], startedAt: Date.now(), game: 'preparing' };
    this.status = 'running';
    this.emit();
    await this.switcher.apply(enabled);
    const onGame = (g) => {
      if (!this.current) return;
      this.current.game = g;
      this.emit();
    };
    const r = this.mode === 'manual' ? await this.runner.manualRound({ signal: this.ctrl.signal, onGame }) : await this.runner.crashRound({ signal: this.ctrl.signal, onGame });
    if (r.error) throw r.error;
    return r;
  }

  onProgress(ev) {
    if (ev.type === 'test') {
      this.round = ev.round;
      this.phase = ev.phase;
      this.estimate = ev.estimate;
    } else if (ev.type === 'result') {
      this.history.push({ round: ev.round, phase: ev.phase, purpose: this.current?.purpose || null, enabled: this.current?.enabled?.length || 0, result: ev.result, kind: ev.kind || null, ms: ev.ms || 0 });
    }
    this.emit();
  }

  describe(r) {
    const info = (file) => ({ file, ...(this.names[file] || { name: file, version: '' }) });
    return {
      kind: r.kind,
      culprits: (r.culprits || []).map((group) => group.map(info)),
      removedWith: (r.removedWith || []).map(info),
      confirmed: Boolean(r.confirmed),
      rounds: r.rounds,
      missing: r.missing || null,
    };
  }

  run() {
    if (this.done) return this.done;
    this.done = (async () => {
      this.emit();
      try {
        await this.switcher.begin();
        const res = await runBisect({
          mods: this.coreMods,
          suspects: this.suspects,
          signal: this.ctrl.signal,
          test: (enabled, info) => this.test(enabled, info),
          onProgress: (ev) => this.onProgress(ev),
        });
        this.result = this.describe(res);
        this.status = 'done';
      } catch (err) {
        if (err instanceof Cancelled || err?.cancelled || this.ctrl.signal.aborted) this.status = 'cancelled';
        else {
          this.status = 'error';
          this.error = err?.message || String(err);
        }
      } finally {
        this.current = null;
        if (this.game.status()[this.instanceId]) {
          try {
            this.game.stop(this.instanceId);
          } catch {
            /* ya estaba cerrado */
          }
          await this.waitGameClosed(20000);
        }
        try {
          const res = await this.switcher.restore();
          this.restoreFailed = res.failed;
        } catch (err) {
          this.restoreFailed = this.mods.map((m) => m.file);
          console.error('[crash] no se pudieron restaurar los mods', err);
        }
        this.finishedAt = Date.now();
        this.emit();
      }
      return this.snapshot();
    })();
    return this.done;
  }

  answer(works) {
    if (this.mode !== 'manual') return false;
    return this.runner.answer(works);
  }

  relaunch() {
    return this.runner.relaunch();
  }

  cancel() {
    if (!this.ctrl.signal.aborted) this.ctrl.abort();
    if (this.status !== 'done' && this.status !== 'error') this.status = 'cancelling';
    this.emit();
  }

  // Restauracion rapida al cerrar el launcher (sin esperar a que el juego termine de cerrarse)
  async emergencyRestore() {
    this.cancel();
    try {
      if (this.game.status()[this.instanceId]) this.game.stop(this.instanceId);
    } catch {
      /* nada */
    }
    return this.switcher.restore();
  }
}

module.exports = { BisectSession };
