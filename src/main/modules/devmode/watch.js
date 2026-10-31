'use strict';
// Vigilancia de archivos del proyecto:
//  - SourceWatcher: cambios en src/ (recursivo, de cada modulo) y en los archivos de build, con espera
//    (debounce) para compilar una sola vez aunque el IDE guarde muchos archivos seguidos.
//  - JarWatcher: el jar de salida (para quien compila desde el IDE): espera a que el archivo deje de
//    cambiar antes de avisar. Node puro: se puede probar sin Electron.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const BUILD_FILES = new Set(['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'gradle.properties', 'pom.xml']);
// Temporales de editores (IntelliJ, vim, VS Code) y carpetas generadas.
const IGNORED_FILE = /(~|\.swp|\.swx|\.swo|\.tmp|\.temp|\.bak|___jb_(tmp|old)___|\.class|\.DS_Store|4913)$/i;
const IGNORED_DIR = /(^|[\\/])(\.idea|\.git|\.gradle|node_modules)([\\/]|$)/;

class SourceWatcher {
  constructor({ roots, rootDir, debounceMs = 1500, onChange, onError }) {
    this.roots = roots; // carpetas src/ a vigilar (recursivo)
    this.rootDir = rootDir; // raiz del proyecto (solo archivos de build, no recursivo)
    this.debounceMs = debounceMs;
    this.onChange = onChange;
    this.onError = onError;
    this.watchers = [];
    this.timer = null;
    this.changed = new Set();
    this.closed = false;
    this.retry = null;
  }

  start() {
    this.closed = false;
    this.attach();
    return this;
  }

  attach() {
    this.detach();
    let ok = 0;
    for (const dir of this.roots) {
      try {
        const w = fs.watch(dir, { recursive: true }, (evt, file) => this.hit(path.join(dir, String(file || ''))));
        w.on('error', (err) => this.fail(err));
        this.watchers.push(w);
        ok++;
      } catch (err) {
        if (err.code !== 'ENOENT') this.onError?.(err);
      }
    }
    if (this.rootDir) {
      try {
        const w = fs.watch(this.rootDir, { recursive: false }, (evt, file) => {
          const name = String(file || '');
          if (BUILD_FILES.has(name)) this.hit(path.join(this.rootDir, name));
        });
        w.on('error', (err) => this.fail(err));
        this.watchers.push(w);
        ok++;
      } catch (err) {
        this.onError?.(err);
      }
    }
    return ok;
  }

  detach() {
    for (const w of this.watchers) {
      try {
        w.close();
      } catch {
        /* ya cerrado */
      }
    }
    this.watchers = [];
  }

  fail(err) {
    if (this.closed) return;
    this.onError?.(err);
    // Si la carpeta se borro o se movio (por ejemplo un "git checkout"), se vuelve a enganchar.
    clearTimeout(this.retry);
    this.retry = setTimeout(() => !this.closed && this.attach(), 3000);
  }

  hit(file) {
    if (this.closed || !file) return;
    const name = path.basename(file);
    if (IGNORED_FILE.test(name) || IGNORED_DIR.test(path.relative(this.rootDir || '', file))) return;
    this.changed.add(file);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fire(), this.debounceMs);
  }

  fire() {
    this.timer = null;
    const files = [...this.changed];
    this.changed.clear();
    if (files.length && !this.closed) this.onChange?.(files);
  }

  setDebounce(ms) {
    this.debounceMs = ms;
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    clearTimeout(this.retry);
    this.detach();
  }
}

// Espera a que un archivo deje de cambiar (tamaño y fecha iguales en dos lecturas seguidas).
async function waitStable(file, { interval = 400, tries = 30 } = {}) {
  let prev = null;
  for (let i = 0; i < tries; i++) {
    let st = null;
    try {
      st = await fsp.stat(file);
    } catch {
      st = null;
    }
    const sig = st ? `${st.size}:${st.mtimeMs}` : null;
    if (sig && sig === prev) return st;
    prev = sig;
    await new Promise((r) => setTimeout(r, interval));
  }
  return null;
}

class JarWatcher {
  // dirs: carpetas donde aparece el jar; match(file) decide si un .jar interesa.
  constructor({ dirs, debounceMs = 900, onJar, onError, pollMs = 4000 }) {
    this.dirs = dirs;
    this.debounceMs = debounceMs;
    this.onJar = onJar;
    this.onError = onError;
    this.pollMs = pollMs;
    this.watchers = new Map();
    this.timer = null;
    this.poller = null;
    this.closed = false;
    this.lastSig = new Map();
  }

  start() {
    this.closed = false;
    this.scanDirs();
    // Las carpetas pueden no existir antes del primer build: se revisan cada tanto.
    this.poller = setInterval(() => this.scanDirs(true), this.pollMs);
    if (this.poller.unref) this.poller.unref();
    return this;
  }

  scanDirs(checkChanges = false) {
    for (const dir of this.dirs) {
      if (this.watchers.has(dir)) continue;
      try {
        const w = fs.watch(dir, { recursive: false }, (evt, file) => {
          if (/\.jar$/i.test(String(file || ''))) this.kick();
        });
        w.on('error', () => {
          this.watchers.delete(dir);
          try {
            w.close();
          } catch {
            /* nada */
          }
        });
        this.watchers.set(dir, w);
        if (checkChanges) this.kick();
      } catch (err) {
        if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') this.onError?.(err);
      }
    }
  }

  kick() {
    if (this.closed) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.closed) this.onJar?.();
    }, this.debounceMs);
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    clearInterval(this.poller);
    for (const w of this.watchers.values()) {
      try {
        w.close();
      } catch {
        /* nada */
      }
    }
    this.watchers.clear();
  }
}

module.exports = { SourceWatcher, JarWatcher, waitStable, BUILD_FILES };
