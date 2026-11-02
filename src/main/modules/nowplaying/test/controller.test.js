'use strict';
// Controlador: vista, elección de sesión, comandos, volumen, avisos al overlay y cuándo se abre el ayudante.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createController } = require('../controller');
const { fakeClock, fakeHelper, session } = require('./helpers');

const ART_A = 'data:image/jpeg;base64,AAAA';
const ART_B = 'data:image/jpeg;base64,BBBB';
const AUDIO = [
  { pid: 10, exe: 'Spotify.exe', pkg: '', volume: 0.8, muted: false, active: true },
  { pid: 20, exe: 'chrome.exe', pkg: '', volume: 0.5, muted: true, active: true },
];

function setup({ answer, cfg } = {}) {
  const clock = fakeClock();
  const helper = fakeHelper(answer);
  const changes = [];
  const ctl = createController({ helper, now: clock.now, timers: clock.timers, onChange: (v, info) => changes.push({ v, ...info }), emitDelayMs: 10, log: () => {} });
  if (cfg) ctl.setConfig(cfg);
  // Listo y con sesiones/mezclador
  const load = (list = [session({ updated: clock.now() })], { system = list[0]?.id || '', audio = AUDIO } = {}) => {
    helper.ready();
    helper.msg({ t: 'sessions', system, list });
    helper.msg({ t: 'audio', list: audio });
    clock.advance(20);
  };
  return { clock, helper, ctl, changes, load };
}

test('sin plataforma (no Windows): no disponible y los comandos fallan con "platform"', async () => {
  const ctl = createController({ helper: null, log: () => {} });
  const v = ctl.view();
  assert.equal(v.available, false);
  assert.equal(v.reason, 'platform');
  assert.equal(v.state, null);
  assert.equal(ctl.getState(), null);
  await assert.rejects(ctl.control('toggle'), { code: 'platform' });
  await assert.rejects(ctl.setVolume(0.5), { code: 'platform' });
  ctl.touch();
  ctl.dispose();
});

test('vista con sesión: estado del contrato, controles y volumen de la app', () => {
  const { ctl, load, helper, clock } = setup();
  load();
  helper.msg({ t: 'art', id: 'Spotify.exe', key: 'abc123', data: ART_A });
  const v = ctl.view();
  assert.equal(v.available, true);
  assert.equal(v.loaded, true);
  assert.equal(v.state.title, 'Canción');
  assert.equal(v.state.appName, 'Spotify');
  assert.equal(v.state.art, ART_A);
  assert.equal(v.state.playing, true);
  assert.deepEqual(v.can, { play: false, pause: true, toggle: true, next: true, prev: true, seek: true });
  assert.deepEqual(v.volume, { available: true, level: 0.8, muted: false });
  assert.deepEqual(v.source, { choice: 'auto', id: 'Spotify.exe', missing: false });
  // La posición avanza sola con el reloj (load ya avanzó 20 ms)
  clock.advance(5000);
  assert.equal(ctl.getState().position, 35020);
});

test('la portada de la canción anterior no se muestra mientras llega la nueva', () => {
  const { ctl, load, helper, clock } = setup();
  load();
  helper.msg({ t: 'art', id: 'Spotify.exe', key: 'abc123', data: ART_A });
  helper.msg({ t: 'sessions', system: 'Spotify.exe', list: [session({ title: 'Otra', key: 'def456', updated: clock.now() })] });
  assert.equal(ctl.getState().art, null);
  helper.msg({ t: 'art', id: 'Spotify.exe', key: 'def456', data: ART_B });
  assert.equal(ctl.getState().art, ART_B);
});

test('avisos: la canción y la pausa avisan al overlay; el avance normal no', () => {
  const { load, helper, clock, changes } = setup();
  load();
  assert.equal(changes.length, 1);
  assert.equal(changes[0].overlayChanged, true);
  changes.length = 0;
  // Misma canción 3 s después con la posición al día: nada
  clock.advance(3000);
  helper.msg({ t: 'sessions', system: 'Spotify.exe', list: [session({ position: 33000, updated: clock.now() })] });
  clock.advance(20);
  assert.equal(changes.length, 0);
  // Pausa
  helper.msg({ t: 'sessions', system: 'Spotify.exe', list: [session({ status: 5, position: 33020, updated: clock.now() })] });
  clock.advance(20);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].overlayChanged, true);
  assert.equal(changes[0].state.playing, false);
  // Cambia solo el volumen: avisa a la interfaz, no al overlay
  changes.length = 0;
  helper.msg({ t: 'audio', list: [{ ...AUDIO[0], volume: 0.3 }, AUDIO[1]] });
  clock.advance(20);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].uiChanged, true);
  assert.equal(changes[0].overlayChanged, false);
});

test('fuente: Spotify primero; elegida a mano; elegida que no está abierta', () => {
  const list = [session({ id: 'Chrome', app: 'Chrome', status: 4, key: 'c1' }), session({ id: 'Spotify.exe', status: 5 })];
  const { ctl, load } = setup();
  load(list, { system: 'Chrome' });
  assert.equal(ctl.view().source.id, 'Chrome', 'Spotify en pausa y Chrome sonando');
  ctl.setConfig({ source: 'Spotify.exe' });
  assert.equal(ctl.view().source.id, 'Spotify.exe');
  ctl.setConfig({ source: 'AppleInc.AppleMusicWin_nzyj5cx40ttqa!App' });
  const v = ctl.view();
  assert.equal(v.source.id, 'Chrome');
  assert.equal(v.source.missing, true);
  const src = ctl.sources();
  assert.equal(src.choice, 'AppleInc.AppleMusicWin_nzyj5cx40ttqa!App');
  assert.deepEqual(src.list.map((s) => [s.id, s.selected, s.system]), [['Chrome', true, true], ['Spotify.exe', false, false]]);
});

test('comandos: alternar, siguiente y alternativa play/pausa si la app no ofrece alternar', async () => {
  const { ctl, load, helper } = setup();
  load();
  await ctl.control('toggle');
  await ctl.control('next');
  assert.deepEqual(helper.calls, [{ cmd: 'toggle', args: { id: 'Spotify.exe' } }, { cmd: 'next', args: { id: 'Spotify.exe' } }]);
  helper.msg({ t: 'sessions', system: 'Chrome', list: [session({ id: 'Chrome', app: 'Chrome', canToggle: false, status: 4 })] });
  helper.calls.length = 0;
  const v = await ctl.control('toggle');
  assert.deepEqual(helper.calls, [{ cmd: 'pause', args: { id: 'Chrome' } }]);
  assert.equal(v.state.playing, false, 'se ve en pausa enseguida');
});

test('comandos: errores del ayudante y acciones inválidas', async () => {
  const { ctl, load } = setup({ answer: (cmd) => (cmd === 'next' ? { ok: false, error: 'rejected' } : cmd === 'prev' ? Object.assign(new Error('t'), { code: 'timeout' }) : { ok: true }) });
  load();
  await assert.rejects(ctl.control('next'), { code: 'rejected' });
  await assert.rejects(ctl.control('prev'), { code: 'timeout' });
  await assert.rejects(ctl.control('borrarTodo'), { code: 'badAction' });
});

test('sin reproductores abiertos: "noSession"', async () => {
  const { ctl, load } = setup();
  load([]);
  assert.equal(ctl.view().state, null);
  await assert.rejects(ctl.control('toggle'), { code: 'noSession' });
});

test('adelantar, retroceder y saltar: posición absoluta en la línea de tiempo y dentro de la canción', async () => {
  const { ctl, load, helper, clock } = setup();
  load([session({ start: 1000, position: 31000, end: 181000, status: 5, updated: clock.now() })]);
  await ctl.control('forward');
  assert.deepEqual(helper.calls.pop(), { cmd: 'seek', args: { id: 'Spotify.exe', position: 41000 } });
  assert.equal(ctl.getState().position, 40000, 'se ve enseguida');
  await ctl.control('back', 60000);
  assert.deepEqual(helper.calls.pop(), { cmd: 'seek', args: { id: 'Spotify.exe', position: 1000 } });
  await ctl.control('seek', 999999);
  assert.deepEqual(helper.calls.pop(), { cmd: 'seek', args: { id: 'Spotify.exe', position: 1000 + 180000 - 500 } });
  helper.msg({ t: 'sessions', system: '', list: [session({ canSeek: false })] });
  await assert.rejects(ctl.control('forward'), { code: 'noSeek' });
});

test('volumen: nivel de la app, silencio y quitar el silencio al subir', async () => {
  const { ctl, load, helper } = setup();
  load([session({ id: 'Chrome', app: 'Chrome', key: 'c1' })]);
  assert.deepEqual(ctl.view().volume, { available: true, level: 0.5, muted: true });
  const v = await ctl.setVolume(0.7);
  assert.deepEqual(helper.calls, [
    { cmd: 'setVolume', args: { pids: [20], volume: 0.7 } },
    { cmd: 'setMute', args: { pids: [20], muted: false } },
  ]);
  assert.deepEqual(v.volume, { available: true, level: 0.7, muted: false });
  helper.calls.length = 0;
  await ctl.control('mute');
  assert.deepEqual(helper.calls, [{ cmd: 'setMute', args: { pids: [20], muted: true } }]);
  helper.calls.length = 0;
  await ctl.control('volumeDown');
  assert.equal(helper.calls[0].args.volume, 0.65);
  await assert.rejects(ctl.setVolume('mucho'), { code: 'badAction' });
});

test('volumen: la app no está en el mezclador -> "noAudio"', async () => {
  const { ctl, load } = setup();
  load([session({ id: 'MSEdge', app: 'MSEdge' })]);
  assert.equal(ctl.view().volume.available, false);
  await assert.rejects(ctl.setVolume(0.5), { code: 'noAudio' });
  await assert.rejects(ctl.control('volumeUp'), { code: 'noAudio' });
});

test('espera a que el ayudante esté listo antes de mandar un comando', async () => {
  const { ctl, helper, clock } = setup();
  const p = ctl.control('toggle');
  assert.equal(helper.starts, 1, 'lo abrió');
  helper.ready();
  helper.msg({ t: 'sessions', system: 'Spotify.exe', list: [session()] });
  await p;
  assert.deepEqual(helper.calls, [{ cmd: 'toggle', args: { id: 'Spotify.exe' } }]);
  // Si no queda listo a tiempo: "unavailable"
  const s2 = setup();
  const p2 = s2.ctl.control('toggle');
  s2.clock.advance(9001);
  await assert.rejects(p2, { code: 'unavailable' });
  assert.ok(clock);
});

test('Windows sin SMTC: no disponible y los comandos fallan con "unsupported"', async () => {
  const { ctl, helper } = setup();
  const p = ctl.control('toggle');
  helper.status = 'unsupported';
  helper.emit('status', 'unsupported');
  await assert.rejects(p, { code: 'unsupported' });
  const v = ctl.view();
  assert.equal(v.available, false);
  assert.equal(v.reason, 'unsupported');
  await assert.rejects(ctl.control('next'), { code: 'unsupported' });
});

test('cuándo está abierto: pedido de la interfaz que vence, juego abierto y cierre', () => {
  const { ctl, helper, clock } = setup();
  assert.equal(helper.starts, 0, 'no se abre hasta que hace falta');
  ctl.touch();
  assert.equal(helper.running, true);
  clock.advance(30000);
  ctl.touch(); // la interfaz lo vuelve a pedir
  clock.advance(44000);
  assert.equal(helper.running, true);
  clock.advance(2000);
  assert.equal(helper.running, false, 'se cerró solo al vencer el pedido');
  ctl.setGameActive(true);
  assert.equal(helper.running, true);
  clock.advance(10 * 60000);
  assert.equal(helper.running, true, 'con el juego abierto sigue');
  ctl.setGameActive(false);
  assert.equal(helper.running, false);
});

test('si el ayudante se cierra, se olvida lo que mostraba', () => {
  const { ctl, load, helper, clock } = setup();
  load();
  assert.ok(ctl.getState());
  helper.emit('exit', { code: 1, expected: false });
  clock.advance(20);
  assert.equal(ctl.getState(), null);
  assert.equal(ctl.view().loaded, false);
});
