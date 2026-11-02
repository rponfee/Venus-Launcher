'use strict';
// Ayudas de las pruebas de Música: reloj y temporizadores falsos, proceso hijo falso y ayudante falso.
const { EventEmitter } = require('events');

function fakeClock(start = 1800000000000) {
  let t = start;
  let seq = 0;
  const list = [];
  const clock = {
    now: () => t,
    timers: {
      setTimeout: (fn, ms) => {
        const id = ++seq;
        list.push({ id, at: t + Math.max(0, ms || 0), fn });
        return id;
      },
      clearTimeout: (id) => {
        const i = list.findIndex((x) => x.id === id);
        if (i >= 0) list.splice(i, 1);
      },
    },
    // Avanza el reloj ejecutando en orden los temporizadores que vencen
    advance(ms) {
      const end = t + ms;
      for (;;) {
        list.sort((a, b) => a.at - b.at || a.id - b.id);
        const next = list[0];
        if (!next || next.at > end) break;
        list.shift();
        t = next.at;
        next.fn();
      }
      t = end;
    },
    pending: () => list.length,
  };
  return clock;
}

// Proceso hijo falso: guarda lo que se le escribe y deja emitir líneas y la salida
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.written = [];
  child.ended = false;
  child.killed = false;
  child.stdin = new EventEmitter();
  child.stdin.write = (line) => {
    child.written.push(line);
    return true;
  };
  child.stdin.end = () => {
    child.ended = true;
  };
  child.kill = () => {
    child.killed = true;
    child.emit('exit', null);
  };
  child.line = (obj) => child.stdout.emit('data', `${typeof obj === 'string' ? obj : JSON.stringify(obj)}\n`);
  child.commands = () => child.written.map((l) => JSON.parse(l));
  return child;
}

function fakeSpawn() {
  const children = [];
  const spawn = (file, args, opts) => {
    const c = fakeChild();
    c.file = file;
    c.args = args;
    c.opts = opts;
    children.push(c);
    return c;
  };
  return { spawn, children, last: () => children[children.length - 1] };
}

// Ayudante falso para el controlador: responde los comandos con `answer(cmd, args)`
function fakeHelper(answer = () => ({ ok: true })) {
  const h = new EventEmitter();
  h.status = 'idle';
  h.running = false;
  h.calls = [];
  h.starts = 0;
  h.stops = 0;
  h.info = () => ({ status: h.status, retryAt: 0, failures: 0 });
  h.start = () => {
    h.starts++;
    if (h.status === 'unsupported' || h.running) return;
    h.running = true;
    h.status = 'starting';
  };
  h.stop = () => {
    h.stops++;
    h.running = false;
    h.status = 'idle';
  };
  h.retryNow = () => false;
  h.request = async (cmd, args) => {
    h.calls.push({ cmd, args });
    const r = answer(cmd, args);
    if (r instanceof Error) throw r;
    return { t: 'result', req: h.calls.length, ok: r.ok !== false, error: r.ok === false ? r.error || 'rejected' : null };
  };
  // Simula que el ayudante quedó listo y mandó sesiones/audio
  h.ready = () => {
    h.running = true;
    h.status = 'ready';
    h.emit('status', 'ready');
  };
  h.msg = (m) => h.emit('message', m);
  return h;
}

const session = (over = {}) => ({
  id: 'Spotify.exe',
  app: 'Spotify.exe',
  title: 'Canción',
  artist: 'Artista',
  album: 'Disco',
  key: 'abc123',
  status: 4,
  position: 30000,
  start: 0,
  end: 180000,
  updated: 0,
  canPlay: false,
  canPause: true,
  canToggle: true,
  canNext: true,
  canPrev: true,
  canSeek: true,
  ...over,
});

module.exports = { fakeClock, fakeChild, fakeSpawn, fakeHelper, session };
