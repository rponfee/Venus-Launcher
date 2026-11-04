'use strict';
// Ventana oculta de la grabadora: la crea cuando hace falta (repeticion, grabacion o captura) y la cierra sola
// cuando queda sin uso. Tiene su propia sesion en memoria ("venus-capture"), con sus permisos y su manejador
// de getDisplayMedia, asi no toca los de la ventana principal (Voice Chat). La ventana elegida para capturar se
// decide aca (fuente de desktopCapturer); la pagina nunca elige otra.
const path = require('path');
const { EventEmitter } = require('events');

const PARTITION = 'venus-capture';
const CMD = 'capture:recorderCmd';
const MSG = 'capture:recorderMsg';
const IDLE_CLOSE_MS = 60000;
const START_TIMEOUT_MS = 15000;

class RecorderHost extends EventEmitter {
  constructor({ getMainWindow } = {}) {
    super();
    this.getMainWindow = getMainWindow || (() => null);
    this.win = null;
    this.ready = null; // promesa: la pagina cargo y avisó 'ready'
    this.current = null; // { source, audio } para el proximo getDisplayMedia
    this.pending = new Map(); // id de pedido -> { resolve, reject, timer }
    this.seq = 0;
    this.session = null; // id de la sesion de grabacion activa
    this.idleTimer = null;
    this.lock = Promise.resolve(); // getDisplayMedia de a uno (la fuente elegida es una sola a la vez)
    this.sessionReady = false;
    this.hookedMain = null; // ventana principal a la que ya se le engancho el cierre
    this.onMessage = this.onMessage.bind(this);
  }

  // ---------- Ventana ----------

  ensureWindow() {
    if (this.win && !this.win.isDestroyed()) return this.ready;
    const { BrowserWindow, session, ipcMain } = require('electron');
    const ses = session.fromPartition(PARTITION);
    if (!this.sessionReady) {
      this.sessionReady = true;
      const allowed = new Set(['media', 'display-capture']);
      ses.setPermissionRequestHandler((wc, permission, cb) => cb(allowed.has(permission)));
      ses.setPermissionCheckHandler((wc, permission) => allowed.has(permission));
      ses.setDisplayMediaRequestHandler((request, callback) => {
        const cur = this.current;
        try {
          if (!cur?.source) return callback({});
          const streams = { video: cur.source };
          if (cur.audio && request?.audioRequested && process.platform === 'win32') streams.audio = 'loopback';
          callback(streams);
        } catch (err) {
          console.warn('[capture] getDisplayMedia:', err?.message || err);
        }
      });
      ipcMain.on(MSG, this.onMessage);
    }
    this.win = new BrowserWindow({
      show: false,
      width: 320,
      height: 200,
      skipTaskbar: true,
      focusable: false,
      paintWhenInitiallyHidden: true,
      title: 'Venus Recorder',
      webPreferences: {
        partition: PARTITION,
        preload: path.join(__dirname, 'recorder-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        spellcheck: false,
      },
    });
    const win = this.win;
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.on('closed', () => {
      if (this.win === win) {
        this.win = null;
        this.lost('closed');
      }
    });
    win.webContents.on('render-process-gone', (_e, details) => {
      console.warn('[capture] la grabadora se cerro:', details?.reason || '');
      if (this.win === win) this.destroy();
    });
    // Si se cierra la ventana principal, la oculta no puede quedar viva (si no, la app no termina de cerrarse)
    const main = this.getMainWindow();
    if (main && !main.isDestroyed() && this.hookedMain !== main) {
      this.hookedMain = main;
      main.once('closed', () => this.destroy());
    }
    this.ready = new Promise((resolve, reject) => {
      this.readyWaiter = { resolve, reject };
      setTimeout(() => reject(new Error('recorder timeout')), START_TIMEOUT_MS).unref?.();
    });
    this.ready.catch(() => {});
    win.loadFile(path.join(__dirname, '..', '..', '..', 'renderer', 'recorder.html')).catch((err) => this.readyWaiter?.reject(err));
    return this.ready;
  }

  // La pagina ya no esta: se cortan los pedidos y la sesion activa
  lost(reason) {
    this.ready = null;
    this.failAll(new Error('recorder closed'));
    if (this.session) {
      const id = this.session;
      this.session = null;
      this.emit('ended', { session: id, reason });
    }
  }

  destroy() {
    clearTimeout(this.idleTimer);
    const win = this.win;
    this.win = null;
    this.lost('closed');
    if (win && !win.isDestroyed()) win.destroy();
  }

  // Cierra la ventana un rato despues de quedar sin uso (libera la memoria del proceso de la pagina)
  scheduleIdle() {
    clearTimeout(this.idleTimer);
    if (this.session || this.pending.size) return;
    this.idleTimer = setTimeout(() => {
      if (!this.session && !this.pending.size) this.destroy();
    }, IDLE_CLOSE_MS);
    this.idleTimer.unref?.();
  }

  send(cmd) {
    if (!this.win || this.win.isDestroyed()) throw new Error('recorder closed');
    this.win.webContents.send(CMD, cmd);
  }

  failAll(err) {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }

  // Pedido con respuesta (por id) y tiempo limite
  request(cmd, timeout = START_TIMEOUT_MS) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error('recorder timeout'), { code: 'timeout' }));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ ...cmd, id });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  answer(id, err, value) {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id);
    if (err) p.reject(err);
    else p.resolve(value);
    this.scheduleIdle();
  }

  onMessage(event, msg) {
    if (!this.win || this.win.isDestroyed() || event.sender !== this.win.webContents) return; // solo la grabadora
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'ready':
        this.readyWaiter?.resolve(true);
        break;
      case 'chunk':
        if (msg.session === this.session && msg.data && msg.data.byteLength) this.emit('chunk', { session: msg.session, data: Buffer.from(msg.data.buffer, msg.data.byteOffset, msg.data.byteLength) });
        break;
      case 'ended':
        if (msg.session === this.session) {
          this.session = null;
          this.emit('ended', { session: msg.session, reason: String(msg.reason || 'ended') });
          this.scheduleIdle();
        }
        break;
      case 'warning':
        console.warn('[capture] grabadora:', String(msg.message || '').slice(0, 300));
        break;
      case 'reply': {
        const err = msg.error ? Object.assign(new Error(String(msg.error).slice(0, 500)), { code: msg.code || 'recorder', name: msg.name || 'Error' }) : null;
        this.answer(msg.id, err, msg.value);
        break;
      }
      default:
    }
  }

  // Corre fn con la fuente elegida para los getDisplayMedia que pida la pagina mientras tanto
  withSource(source, audio, fn) {
    const run = this.lock.then(async () => {
      this.current = { source, audio: Boolean(audio) };
      try {
        return await fn();
      } finally {
        this.current = null;
      }
    });
    this.lock = run.catch(() => {});
    return run;
  }

  // ---------- Sesion de grabacion (repeticion y grabacion comparten una sola) ----------

  /**
   * Empieza a capturar la fuente. opts = { box: { width, height } | null, fps, audio, bitrate: { bpp, min, max },
   * keyframeMs }. Devuelve { session, width, height, mimeType, audio } (los pedazos llegan por 'chunk').
   */
  async start(source, opts) {
    clearTimeout(this.idleTimer);
    await this.ensureWindow();
    const session = `s${Date.now().toString(36)}${(++this.seq).toString(36)}`;
    this.session = session;
    try {
      const info = await this.withSource(source, opts.audio, () => this.request({ type: 'start', session, sourceId: source.id, ...opts }));
      return { session, ...info };
    } catch (err) {
      if (this.session === session) this.session = null;
      this.scheduleIdle();
      throw err;
    }
  }

  // Pide los datos que el MediaRecorder todavia no entrego (antes de guardar la repeticion)
  async flush() {
    if (!this.session) return false;
    try {
      await this.request({ type: 'flush', session: this.session }, 2500);
      return true;
    } catch {
      return false;
    }
  }

  // Miniatura del cuadro actual (data: JPEG chico) o null
  async thumb() {
    if (!this.session) return null;
    try {
      const v = await this.request({ type: 'thumb', session: this.session, width: 320 }, 2500);
      return typeof v === 'string' && v.startsWith('data:image/') ? v : null;
    } catch {
      return null;
    }
  }

  async stop() {
    const session = this.session;
    if (!session) return;
    try {
      await this.request({ type: 'stop', session }, 5000);
    } catch {
      /* la pagina ya no estaba */
    }
    if (this.session === session) this.session = null;
    this.scheduleIdle();
  }

  // ---------- Captura de pantalla (tamanio real de la ventana) ----------

  // Devuelve { data: Buffer PNG, width, height }. opts = { mime, quality, maxHeight, reuse }: otro formato, achicada y
  // sacada de la captura que este andando (timelapse); sin opts, el PNG al tamanio real de siempre.
  async grab(source, opts = {}) {
    clearTimeout(this.idleTimer);
    await this.ensureWindow();
    try {
      const v = await this.withSource(source, false, () => this.request({ type: 'grab', sourceId: source.id, ...opts }, 10000));
      if (!v?.data?.byteLength) throw new Error('empty frame');
      return { data: Buffer.from(v.data.buffer, v.data.byteOffset, v.data.byteLength), width: v.width, height: v.height };
    } finally {
      this.scheduleIdle();
    }
  }
}

module.exports = { RecorderHost, PARTITION };
