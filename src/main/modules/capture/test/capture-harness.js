'use strict';
// Corre modules/capture.js con Electron, el juego, la grabadora y el disco simulados, y el reloj falso de node:test.
// Lo usa capture.test.js en un proceso aparte (asi el reloj falso y los modulos simulados no tocan las otras pruebas):
//   node capture-harness.js <escenario>  -> imprime el resultado como JSON en la ultima linea
const Module = require('module');
const os = require('os');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { EventEmitter } = require('events');
const { mock } = require('node:test');

const MAIN = path.join(__dirname, '..', '..', '..');
const abs = (rel) => path.join(MAIN, rel);
const GB = 1024 ** 3;

const scenario = process.argv[2];
if (process.argv[3] === 'darwin') Object.defineProperty(process, 'platform', { value: 'darwin' });

const webm = require(abs('modules/capture/webm.js'));
const fake = require('./fake-webm');
const { ID, idBytes, UNKNOWN_SIZE, uintEl } = webm;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'venus-capture-sim-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

// ---------- Disco ----------
const disk = { free: 500 * GB };
fsp.statfs = async () => ({ bavail: Math.floor(disk.free / 4096), bsize: 4096 });

// ---------- Modulos simulados ----------
const paths = require(abs('core/paths.js'));
paths.setRoot(path.join(tmp, 'data-root'));

const settingsState = { value: { capture: {} }, listeners: [] };
const settingsMock = {
  get: async () => settingsState.value,
  onChange: (fn) => settingsState.listeners.push(fn),
};
function setCapture(patch) {
  settingsState.value = { ...settingsState.value, capture: { ...settingsState.value.capture, ...patch } };
  for (const fn of settingsState.listeners) fn(settingsState.value, { capture: patch });
}

const gameState = { status: {} };
const gameMock = { status: () => gameState.status, events: new EventEmitter(), addBeforeLaunch() {}, activity: () => null };
const instancesMock = { dir: (id) => path.join(tmp, 'data-root', 'instances', id), get: async (id) => ({ id }) };

let host = null;
class FakeHost extends EventEmitter {
  constructor() {
    super();
    host = this;
    this.session = null;
    this.n = 0;
    this.starts = [];
    this.info = { width: 1920, height: 1080, codec: 'vp8', hardware: false };
  }

  async start(src, opts) {
    const session = `s${++this.n}`;
    this.session = session;
    this.starts.push({ session, opts });
    await null;
    this.clock = 0;
    this.headerSent = false;
    return { session, width: this.info.width, height: this.info.height, mimeType: 'video/webm', codec: this.info.codec, hardware: this.info.hardware, bitrate: 5e6, audio: true, audioFailed: false, fps: opts.fps, sourceFps: 0, stats: true };
  }

  async stop(session = this.session) {
    await null;
    if (this.session === session) this.session = null;
  }

  async flush() {
    return Boolean(this.session);
  }

  async thumb() {
    return null;
  }

  destroy() {
    this.session = null;
  }

  // Un segundo de video a `fps` cuadros (cuadro clave cada 2 s) + audio
  feedSecond(fps) {
    if (!this.session) return;
    const parts = [];
    if (!this.headerSent) {
      parts.push(fake.ebmlHeader(), idBytes(ID.Segment), UNKNOWN_SIZE, fake.info(), fake.tracks({ width: this.info.width, height: this.info.height }));
      this.headerSent = true;
      this.lastKey = -Infinity;
    }
    const start = this.clock;
    parts.push(idBytes(ID.Cluster), UNKNOWN_SIZE, uintEl(ID.Timecode, start));
    const frames = [];
    for (let i = 0; i < fps; i++) frames.push({ track: 1, time: start + Math.round((i * 1000) / fps) });
    for (let t = 0; t < 1000; t += 20) frames.push({ track: 2, time: start + t });
    frames.sort((a, b) => a.time - b.time || a.track - b.track);
    for (const f of frames) {
      let key = true;
      if (f.track === 1) {
        key = f.time - this.lastKey >= 2000;
        if (key) this.lastKey = f.time;
      }
      parts.push(fake.simpleBlock(f.track, f.time - start, key, Buffer.alloc(f.track === 1 ? 300 : 40, 7)));
    }
    this.clock += 1000;
    this.emit('chunk', { session: this.session, data: Buffer.concat(parts) });
  }
}

const electronMock = {
  screen: { getPrimaryDisplay: () => ({ size: { width: 1920, height: 1080 }, scaleFactor: 1, displayFrequency: 60 }) },
  desktopCapturer: { getSources: async () => [{ id: 'window:777:0', name: 'Minecraft 1.21.1' }] },
  globalShortcut: { isRegistered: () => false, register: () => true, unregister() {} },
  nativeImage: { createFromBuffer: () => ({ isEmpty: () => true }) },
  shell: { openPath: async () => '' },
};

const overrides = new Map([
  [abs('core/settings.js'), settingsMock],
  [abs('core/game.js'), gameMock],
  [abs('core/instances.js'), instancesMock],
  [abs('modules/capture/host.js'), { RecorderHost: FakeHost }],
  [abs('modules/capture/window-find.js'), { WAIT_MIN: 15, findWindow: () => ({ promise: Promise.resolve(777), cancel() {} }), sourceId: (hwnd) => `window:${hwnd}:0`, matchByTitle: (s) => s[0] || null }],
  [abs('modules/overlay.js'), { push() {} }],
]);
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronMock;
  let resolved = null;
  try {
    resolved = Module._resolveFilename(request, parent);
  } catch {
    resolved = null;
  }
  if (resolved && overrides.has(path.resolve(resolved))) return overrides.get(path.resolve(resolved));
  return origLoad.apply(this, arguments);
};

// ---------- Tiempo simulado ----------
const realSetTimeout = setTimeout;
const settle = (ms = 150) => new Promise((r) => realSetTimeout(r, ms));
mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 1_800_000_000_000 });
const turn = async (n = 30) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

// Lo guardado antes de abrir el launcher (para ver que se carga al arrancar)
if (scenario === 'platformSettings') settingsState.value = { capture: { replaySeconds: 600, quality: '1440p', notify: false, copyTo: tmp } };

const sent = [];
const capture = require(abs('modules/capture.js'));
const handlers = new Map();
capture.register({ handle: (ch, fn) => handlers.set(ch, fn), send: (ch, payload) => sent.push({ ch, payload }), onQuit() {}, getWindow: () => null });
const notices = () => sent.filter((s) => s.ch === 'capture:notice').map((s) => s.payload.message);

async function init(saved) {
  settingsState.value = { capture: saved };
  await turn();
  setCapture(saved);
  await turn();
}

async function startGame(id = 'inst1', pid = 4242) {
  gameState.status = { [id]: { state: 'running', pid, startedAt: Date.now() } };
  gameMock.events.emit('state', id, gameState.status[id]);
  await turn();
  await settle(100);
}

// Avanza `seconds` segundos: cada segundo llega un pedazo de `fps` cuadros y corre el temporizador de capture.js
async function play(seconds, fps) {
  for (let i = 0; i < seconds; i++) {
    host?.feedSecond(typeof fps === 'function' ? fps(i) : fps);
    await turn(6);
    mock.timers.tick(1000);
    await turn(6);
  }
  await settle(50);
}

const starts = () => host.starts.length;

// ---------- Escenarios ----------
const scenarios = {
  // #0: con la repeticion en pausa por falta de disco, volver a un largo que entra la reanuda
  async noRoomRetry() {
    disk.free = 4 * GB;
    await init({ replay: true, replaySeconds: 60, quality: '2160p', fps: 60, level: 'high' });
    await startGame();
    Object.assign(host.info, { width: 3840, height: 2160 });
    await play(20, 60);
    const before = capture.status().replay;
    setCapture({ replaySeconds: 1800 });
    await settle(200);
    await play(2, 60);
    const blocked = capture.status().replay;
    setCapture({ replaySeconds: 60 });
    await settle(200);
    await play(5, 60);
    const after = capture.status().replay;
    return { before: before.active, blocked: { active: blocked.active, error: blocked.error }, after: { active: after.active, error: after.error } };
  },

  // #0: en pausa por falta de disco; se libera lugar y vuelve sola (el chequeo es cada 15 s)
  async noRoomFreed() {
    disk.free = 3 * GB;
    await init({ replay: true, replaySeconds: 1800, quality: '1080p', fps: 60, level: 'medium' });
    await startGame();
    await play(3, 60);
    const blocked = capture.status().replay;
    disk.free = 200 * GB;
    await play(16, 60);
    const after = capture.status().replay;
    return { blocked: { active: blocked.active, error: blocked.error }, after: { active: after.active, error: after.error } };
  },

  // #1: codificador por software; despues de un buen rato el juego deja de dar cuadros (ventana minimizada): no se
  // reinicia ni se baja la calidad (el buffer no se pierde)
  async lateStall() {
    await init({ replay: true, quality: '1080p', fps: 60 });
    await startGame();
    await play(60, 60);
    const buffered = capture.status().replay.buffered;
    await play(15, 0);
    await play(10, 25);
    const st = capture.status();
    return { starts: starts(), degraded: st.degraded, bufferedBefore: buffered, bufferedAfter: st.replay.buffered };
  },

  // #1: un tiron de 3 s al arrancar (pantalla de carga) no baja la calidad
  async earlyHiccup() {
    await init({ replay: true, quality: '1080p', fps: 30 });
    await startGame();
    await play(8, 30);
    await play(3, 0);
    await play(25, 30);
    return { starts: starts(), degraded: capture.status().degraded };
  },

  // #3: grabando con un codificador que no llega: un solo paso y un solo aviso; al terminar se aplica
  async degradeWhileRecording() {
    await init({ replay: true, quality: '1080p', fps: 60 });
    await startGame();
    await play(3, 40);
    const rec = capture.startRecording();
    await play(1, 40);
    await rec;
    await play(30, 40);
    const during = { degraded: capture.status().degraded, notices: notices().length, starts: starts() };
    await capture.stopRecording();
    await settle(200);
    await play(2, 40);
    return { during, after: { starts: starts(), lastFps: host.starts.at(-1).opts.fps, lastBox: host.starts.at(-1).opts.box.height } };
  },

  // #3: un reinicio pendiente de una grabacion sin repeticion no queda para despues (y no borra el buffer)
  async staleRestart() {
    await init({ replay: false, quality: '1080p', fps: 30 });
    await startGame();
    const p = capture.startRecording();
    await play(2, 30);
    await p;
    await play(5, 30);
    setCapture({ level: 'high' });
    await play(3, 30);
    await capture.stopRecording();
    await settle(200);
    setCapture({ replay: true });
    await settle(200);
    await play(40, 30);
    const before = capture.status().replay.buffered;
    await capture.startRecording();
    await play(5, 30);
    await capture.stopRecording();
    await settle(300);
    await play(2, 30);
    return { before, after: capture.status().replay.buffered };
  },

  // #4 y #6: "nativa" manda a la grabadora el tope de 4K (no la pantalla principal)
  async nativeBox() {
    await init({ replay: true, quality: 'native', fps: 30 });
    await startGame();
    await play(2, 30);
    return { box: host.starts[0].opts.box };
  },

  // #5: el buffer entra pero no queda lugar para guardar el clip entero
  async saveTight() {
    disk.free = 5.5 * GB;
    await init({ replay: true, replaySeconds: 1800, quality: '1080p', fps: 60, level: 'medium' });
    await startGame();
    await play(3, 60);
    const st = capture.status();
    return { active: st.replay.active, diskOk: st.diskOk, diskSaveOk: st.diskSaveOk, need: st.diskEstimate, notices: notices() };
  },

  // #9: con la placa de video, "unos X Mbps" es lo que se espera que ocupe y no lo pedido
  async liveBitrate() {
    await init({ replay: true, quality: '1080p', fps: 60 });
    host.info = { width: 1920, height: 1080, codec: 'av1', hardware: true };
    await startGame();
    await play(2, 60);
    return { live: capture.status().live.bitrate };
  },

  // #7: sin grabacion en esta plataforma igual se cargan los ajustes guardados
  async platformSettings() {
    await turn();
    await settle(50);
    const first = capture.status().settings;
    setCapture({ notify: true });
    await turn();
    const st = await handlers.get('capture:status')();
    return { available: st.available, first: { replaySeconds: first.replaySeconds, quality: first.quality, notify: first.notify, copyTo: first.copyTo === tmp }, notify: st.settings.notify };
  },
};

(async () => {
  const fn = scenarios[scenario];
  if (!fn) throw new Error(`escenario desconocido: ${scenario}`);
  const out = await fn();
  console.log(JSON.stringify(out));
  process.exit(0);
})().catch((err) => {
  console.error('FALLO', err);
  process.exit(1);
});
