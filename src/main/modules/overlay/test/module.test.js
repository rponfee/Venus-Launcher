'use strict';
// modules/overlay.js entero, con Electron, el juego y los ayudantes de PowerShell falsos (test/harness.js): el seguimiento de
// la ventana, los atajos, el foco de los paneles, el modo edicion, la pagina que no abre y lo que pasa si algo se rompe.
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv, info, flush } = require('./harness');

const GAME = '5000';
const START = 1_000_000;

// Partida abierta con su ventana encontrada y adelante
async function boot(options, t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: START });
  const env = makeEnv(options, t);
  await flush();
  env.startGame('inst', 4242);
  const tr = env.tracker.last();
  tr?.update?.(info({ hwnd: GAME, foreground: GAME }));
  return { env, tr };
}

const tick = (t, ms) => t.mock.timers.tick(ms);

// ---------------------------------------------------------------- rendimiento con el overlay apagado u oculto

test('rendimiento: el medidor se corta al apagar el overlay y mientras esta oculto con el atajo', async (t) => {
  const { env } = await boot({}, t);
  assert.equal(env.samplers.length, 1, 'mide mientras se juega');
  await env.settings.set({ overlay: { enabled: false } });
  assert.equal(env.samplers[0].stopped, true, 'apagado: no queda un PowerShell midiendo para nadie');
  await env.settings.set({ overlay: { enabled: true } });
  assert.equal(env.samplers.length, 2, 'prendido de nuevo: vuelve a medir');
  env.shortcuts.get('Alt+Shift+O')();
  assert.equal(env.samplers[1].stopped, true, 'oculto con el atajo: no hace falta medir');
  env.shortcuts.get('Alt+Shift+O')();
  assert.equal(env.samplers.length, 3, 'al mostrarlo vuelve a medir');
  env.quit();
});

test('apagar el overlay suelta atajos, ayudante y ventana', async (t) => {
  const { env, tr } = await boot({}, t);
  assert.equal(env.shortcuts.size, 3);
  await env.settings.set({ overlay: { enabled: false } });
  assert.equal(env.shortcuts.size, 0);
  assert.equal(tr.stopped, true);
  assert.equal(env.win().visible, false);
  assert.equal((await env.status()).active, false);
  env.quit();
});

// ---------------------------------------------------------------- atajos

test('atajos: solo estan armados con el juego adelante, y no se le sacan a las demas aplicaciones', async (t) => {
  const { env, tr } = await boot({}, t);
  assert.deepEqual([...env.shortcuts.keys()].sort(), ['Alt+Shift+A', 'Alt+Shift+O', 'Alt+Shift+R']);
  tr.update(info({ hwnd: GAME, foreground: '777' })); // el jugador se fue al navegador
  assert.equal(env.shortcuts.size, 0, 'con otra aplicacion adelante no se registra ninguno');
  tr.update(info({ hwnd: GAME, foreground: GAME }));
  assert.equal(env.shortcuts.size, 3, 'vuelve al juego: vuelven');
  tr.update(info({ hwnd: GAME, foreground: GAME, minimized: true }));
  assert.equal(env.shortcuts.size, 0, 'minimizado: tampoco');
  tr.update({ found: false }); // todavia no se sabe nada de la ventana: no se pierde el atajo
  assert.equal(env.shortcuts.size, 3);
  env.quit();
});

test('atajos: uno que otra aplicacion tiene tomado se avisa, no se reintenta en cada linea y se conserva con el juego atras', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: START });
  const env = makeEnv({}, t);
  env.takenByOthers.add('Alt+Shift+O');
  await flush();
  env.startGame('inst', 4242);
  const tr = env.tracker.last();
  tr.update(info({ hwnd: GAME, foreground: GAME }));
  assert.equal((await env.status()).shortcutOk, false);
  const tries = () => env.attempts.filter((a) => a === 'Alt+Shift+O').length;
  const before = tries();
  for (let i = 0; i < 20; i++) tr.update(info({ hwnd: GAME, foreground: GAME, x: 100 + i }));
  assert.equal(tries(), before, 'no se vuelve a probar en cada vuelta del ayudante');
  tick(t, 5100);
  tr.update(info({ hwnd: GAME, foreground: GAME }));
  assert.equal(tries(), before + 1, 'pasado un rato se vuelve a probar');
  tr.update(info({ hwnd: GAME, foreground: '777' }));
  assert.equal((await env.status()).shortcutOk, false, 'con el juego atras, Ajustes sigue avisando que no se pudo');
  env.quit();
});

test('atajos: no pisan a Minecraft, a Windows, a las capturas ni al Voice Chat, y entre los del overlay no se repiten', async (t) => {
  const { env } = await boot({ settings: { voice: { muteShortcut: 'Alt+Shift+M' } } }, t);
  const set = (accel) => env.invoke('overlay:setShortcut', accel);
  assert.deepEqual(pick(await set('Ctrl+W'), ['ok', 'code']), { ok: false, code: 'minecraft' });
  assert.deepEqual(pick(await set('Shift+K'), ['ok', 'code']), { ok: false, code: 'minecraft' });
  assert.deepEqual(pick(await set('Ctrl+Alt+Q'), ['ok', 'code']), { ok: false, code: 'altgr' });
  assert.deepEqual(pick(await set('Alt+F4'), ['ok', 'code']), { ok: false, code: 'system' });
  assert.deepEqual(pick(await set('Alt+Shift+F9'), ['ok', 'code', 'who']), { ok: false, code: 'venus', who: 'capture' });
  assert.deepEqual(pick(await set('Shift+Alt+M'), ['ok', 'code', 'who']), { ok: false, code: 'venus', who: 'voice' }, 'sin importar el orden de las teclas');
  assert.deepEqual(pick(await set('Alt+Shift+R'), ['ok', 'code', 'who']), { ok: false, code: 'venus', who: 'overlay' }, 'el de las recetas');
  assert.equal((await set(42)).code, 'invalid', 'un valor que no es texto no borra el atajo');
  assert.equal((await env.status()).shortcut, 'Alt+Shift+O');
  const panel = await env.invoke('overlay:setPanelShortcut', 'assistant', 'Alt+Shift+O');
  assert.deepEqual(pick(panel, ['ok', 'code', 'who']), { ok: false, code: 'venus', who: 'overlay' });
  assert.equal(env.setCalls.length, 0, 'nada de eso se guardo');
  // Uno bueno se guarda y queda armado
  const good = await set('Alt+Shift+K');
  assert.equal(good.ok, true);
  assert.equal((await env.status()).shortcut, 'Alt+Shift+K');
  assert.ok(env.shortcuts.has('Alt+Shift+K') && !env.shortcuts.has('Alt+Shift+O'));
  env.quit();
});

test('atajos: si otra aplicacion lo tiene, no se guarda y se conserva el anterior', async (t) => {
  const { env } = await boot({}, t);
  env.takenByOthers.add('Alt+Shift+K');
  const r = await env.invoke('overlay:setShortcut', 'Alt+Shift+K');
  assert.deepEqual(pick(r, ['ok', 'code', 'shortcut']), { ok: false, code: 'taken', shortcut: 'Alt+Shift+O' });
  assert.ok(env.shortcuts.has('Alt+Shift+O'), 'el anterior sigue andando');
  env.quit();
});

// ---------------------------------------------------------------- seguimiento de la ventana

test('ayudante: si se cae solo se vuelve a abrir (tres veces) y despues se avisa que fallo', async (t) => {
  const { env, tr } = await boot({}, t);
  assert.equal((await env.status()).tracker, 'ok');
  tr.end({ clean: false, lines: 3 });
  assert.equal((await env.status()).tracker, 'starting', 'esperando para reintentar');
  tick(t, 1000);
  assert.equal(env.tracks.length, 2);
  env.tracks[1].end({ clean: false });
  tick(t, 3000);
  assert.equal(env.tracks.length, 3);
  env.tracks[2].end({ clean: false });
  tick(t, 8000);
  assert.equal(env.tracks.length, 4);
  env.tracks[3].end({ clean: false });
  tick(t, 60000);
  assert.equal(env.tracks.length, 4, 'a la tercera se rinde');
  assert.equal((await env.status()).tracker, 'failed');
  env.quit();
});

test('ayudante: si anduvo, una caida de mas adelante vuelve a tener sus intentos; el fin normal no se reintenta', async (t) => {
  const { env, tr } = await boot({}, t);
  tr.end({ clean: false });
  tick(t, 1000);
  env.tracks[1].update(info({ hwnd: GAME, foreground: GAME }));
  env.tracks[1].end({ clean: false });
  tick(t, 1000);
  assert.equal(env.tracks.length, 3, 'anduvo: el contador volvio a cero');
  env.tracks[2].end({ clean: true });
  tick(t, 60000);
  assert.equal(env.tracks.length, 3, 'termino por su cuenta (se cerro el juego): no se reabre');
  env.quit();
});

test('ayudante: sin poder abrirlo, el estado dice que fallo en vez de buscar para siempre', async (t) => {
  const { env } = await boot({ noTracker: true }, t);
  const s = await env.status();
  assert.equal(s.running, true);
  assert.equal(s.found, false);
  assert.equal(s.tracker, 'failed');
  env.quit();
});

// ---------------------------------------------------------------- la pagina del overlay

test('pagina: si no avisa que esta lista se descarta y se rinde a la tercera, hasta una prueba nueva', async (t) => {
  const { env, tr } = await boot({}, t);
  assert.equal(env.windows.length, 1);
  tick(t, 10000);
  assert.equal(env.windows[0].isDestroyed(), true, 'la ventana que no avisa se cierra');
  tr.update(info({ hwnd: GAME, foreground: GAME, x: 101 }));
  assert.equal(env.windows.length, 2, 'se arma de nuevo');
  tick(t, 10000);
  tr.update(info({ hwnd: GAME, foreground: GAME, x: 102 }));
  assert.equal(env.windows.length, 3);
  tick(t, 10000);
  tr.update(info({ hwnd: GAME, foreground: GAME, x: 103 }));
  assert.equal(env.windows.length, 3, 'a la tercera vez seguida deja de insistir');
  assert.equal((await env.status()).pageFailed, true);
  await env.invoke('overlay:test', []);
  assert.equal(env.windows.length, 4, 'una prueba es un pedido nuevo');
  assert.equal((await env.status()).pageFailed, false);
  env.page({ type: 'ready' });
  tick(t, 20000);
  assert.equal(env.win().isDestroyed(), false, 'si avisa que esta lista, queda');
  env.quit();
});

test('pagina: si la ventana no se puede crear no sale ningun error y el estado lo dice', async (t) => {
  const { env, tr } = await boot({ windowThrows: true }, t);
  for (let i = 0; i < 4; i++) tr.update(info({ hwnd: GAME, foreground: GAME, x: 200 + i }));
  assert.equal((await env.status()).pageFailed, true);
  env.quit();
});

test('una falla dentro del overlay no sale por los callbacks del ayudante ni de los ajustes', async (t) => {
  const { env, tr } = await boot({ window: { throwOnBounds: true } }, t);
  assert.doesNotThrow(() => tr.update(info({ hwnd: GAME, foreground: GAME, x: 150 })));
  assert.doesNotThrow(() => tr.end({ clean: true }));
  await assert.doesNotReject(env.settings.set({ overlay: { widgets: { voice: { scale: 1.2 } } } }));
  env.quit();
});

test('pagina colgada con un panel abierto: se sueltan el mouse y el teclado', async (t) => {
  const { env } = await boot({}, t);
  env.page({ type: 'ready' });
  env.shortcuts.get('Alt+Shift+R')();
  assert.equal((await env.status()).panel, 'recipes');
  const win = env.win();
  win.emit('unresponsive');
  const s = await env.status();
  assert.equal(s.panel, null);
  assert.equal(win.isDestroyed(), true);
  env.quit();
});

// ---------------------------------------------------------------- ventana: posicion y tamano

test('ventana: si Electron la deja con otro tamano al pasarla a otro monitor, se pide de nuevo', async (t) => {
  const { env } = await boot({ window: { firstSize: true } }, t);
  const win = env.win();
  assert.equal(win.boundsCalls, 2);
  assert.deepEqual(win.bounds, { x: 100, y: 100, width: 1280, height: 720 });
  env.quit();
});

test('ventana: al cambiar la escala o las pantallas el rectangulo se vuelve a poner', async (t) => {
  const { env } = await boot({}, t);
  const win = env.win();
  const n = win.boundsCalls;
  env.screen.emit('display-metrics-changed');
  assert.equal(win.boundsCalls, n + 1);
  env.screen.emit('display-added');
  assert.equal(win.boundsCalls, n + 2);
  env.quit();
  env.screen.emit('display-removed');
  assert.equal(win.boundsCalls, n + 2, 'al salir se sueltan los oyentes');
});

// ---------------------------------------------------------------- modo edicion

test('edicion: mantener una flecha apretada guarda una sola vez, con la ultima posicion', async (t) => {
  const { env } = await boot({}, t);
  env.page({ type: 'ready' });
  await env.invoke('overlay:edit', true);
  const before = env.setCalls.length;
  for (let i = 1; i <= 30; i++) env.page({ type: 'move', id: 'voice', pos: { anchor: 'free', x: i / 100, y: 0.5 } });
  assert.equal(env.setCalls.length, before, 'todavia no se guardo nada');
  tick(t, 160);
  await flush();
  assert.equal(env.setCalls.length, before + 1, 'un solo guardado');
  assert.deepEqual(env.setCalls.at(-1), { overlay: { widgets: { voice: { anchor: 'free', x: 0.3, y: 0.5 } } } });
  // Al terminar de editar se guarda lo que quedaba sin esperar
  env.page({ type: 'move', id: 'music', pos: { anchor: 'tc' } });
  env.page({ type: 'done' });
  await flush();
  assert.deepEqual(env.setCalls.at(-1), { overlay: { widgets: { music: { anchor: 'tc' } } } });
  env.quit();
});

test('edicion: la pagina solo manda si es la ventana del overlay y si se esta editando', async (t) => {
  const { env } = await boot({}, t);
  env.page({ type: 'ready' });
  const before = env.setCalls.length;
  env.page({ type: 'move', id: 'voice', pos: { anchor: 'tl' } }); // no se edita
  await env.invoke('overlay:edit', true);
  env.page({ type: 'move', id: 'voice', pos: { anchor: 'tl' } }, { id: 999 }); // de otra ventana
  env.page({ type: 'move', id: '__proto__', pos: { anchor: 'tl' } });
  env.page({ type: 'move', id: 'voice', pos: { anchor: 'x' } });
  env.page({ type: 'move', id: 'voice', pos: { anchor: 'free', x: 'a', y: 1 } });
  env.page(null);
  env.page('hola');
  tick(t, 500);
  await flush();
  assert.equal(env.setCalls.length, before, 'nada de eso llega a los ajustes');
  env.quit();
});

test('edicion: volver al juego no le roba el foco al overlay si se abre otra edicion enseguida', async (t) => {
  const { env, tr } = await boot({}, t);
  env.page({ type: 'ready' });
  await env.invoke('overlay:edit', true);
  tr.update(info({ hwnd: GAME, foreground: env.win().hwnd })); // el overlay tiene el foco
  await env.invoke('overlay:edit', false);
  await env.invoke('overlay:edit', true); // la vuelve a abrir antes de que pasen los 60 ms
  tick(t, 600);
  assert.deepEqual(tr.fronts, [], 'el juego no se trae al frente por encima de la edicion');
  env.quit();
});

test('edicion: al terminar, el juego vuelve al frente', async (t) => {
  const { env, tr } = await boot({}, t);
  env.page({ type: 'ready' });
  await env.invoke('overlay:edit', true);
  tr.update(info({ hwnd: GAME, foreground: env.win().hwnd }));
  await env.invoke('overlay:edit', false);
  tick(t, 70);
  assert.deepEqual(tr.fronts, [GAME]);
  env.quit();
});

// ---------------------------------------------------------------- paneles: foco

test('panel: sin foco a los 1,8 s se cierra con un aviso; con foco queda; al cerrar el juego vuelve al frente', async (t) => {
  const { env, tr } = await boot({}, t);
  env.page({ type: 'ready' });
  env.shortcuts.get('Alt+Shift+R')();
  assert.equal((await env.status()).panel, 'recipes');
  const hwnd = env.win().hwnd;
  tick(t, 700);
  assert.deepEqual(tr.fronts, [hwnd], 'a los 700 ms le pide el foco al ayudante');
  tick(t, 1200);
  assert.equal((await env.status()).panel, null, 'sin foco: cerrado');
  assert.ok(env.win().sentOn('overlay:panelMsg').some((m) => m.type === 'notice' && m.key === 'pn_noFocus'));
  // Ahora con foco
  tr.fronts.length = 0;
  env.shortcuts.get('Alt+Shift+R')();
  tr.update(info({ hwnd: GAME, foreground: hwnd }));
  tick(t, 2500);
  assert.equal((await env.status()).panel, 'recipes', 'si Windows le dio el foco, sigue abierto');
  tr.update(info({ hwnd: GAME, foreground: hwnd, x: 120 }));
  env.page({ type: 'panelClose' });
  assert.equal((await env.status()).panel, null);
  tick(t, 70);
  assert.deepEqual(tr.fronts, [GAME], 'cerrar el panel devuelve el juego al frente');
  env.quit();
});

test('panel: si el jugador se va a otra ventana o el juego se minimiza, se cierra', async (t) => {
  const { env, tr } = await boot({}, t);
  env.page({ type: 'ready' });
  env.shortcuts.get('Alt+Shift+A')();
  tr.update(info({ hwnd: GAME, foreground: env.win().hwnd }));
  tick(t, 600);
  env.win().emit('blur');
  assert.equal((await env.status()).panel, null, 'blur despues de la gracia: cerrado');
  env.shortcuts.get('Alt+Shift+A')();
  tr.update(info({ hwnd: GAME, foreground: env.win().hwnd, minimized: true }));
  assert.equal((await env.status()).panel, null, 'juego minimizado: cerrado');
  env.quit();
});

test('cerrar el juego con el overlay en edicion o con un panel suelta todo', async (t) => {
  const { env, tr } = await boot({}, t);
  env.page({ type: 'ready' });
  await env.invoke('overlay:edit', true);
  env.stopGame('inst');
  let s = await env.status();
  assert.equal(s.editing, false);
  assert.equal(s.running, false);
  assert.equal(env.shortcuts.size, 0);
  assert.equal(tr.stopped, true);
  assert.equal(env.win().visible, false);
  tick(t, 61000);
  assert.equal(env.windows[0].isDestroyed(), true, 'sin juego la ventana se cierra al minuto');
  // Y con un panel
  env.startGame('inst', 4343);
  env.tracker.last().update(info({ hwnd: GAME, foreground: GAME }));
  env.page({ type: 'ready' });
  env.shortcuts.get('Alt+Shift+R')();
  assert.equal((await env.status()).panel, 'recipes');
  env.stopGame('inst', 'crashed');
  s = await env.status();
  assert.equal(s.panel, null);
  env.quit();
});

// ---------------------------------------------------------------- partidas que no llegaron a abrirse

test('una partida que fallo al lanzar no deja sus datos guardados', async (t) => {
  const { env } = await boot({}, t);
  const before = env.game.before[0];
  before({ id: 'roto', instance: { dir: 'C:/x' }, resolved: { rootId: '1.20.1', assetIndex: { id: '12' } }, account: { uuid: '11111111222233334444555555555555', name: 'Steve' }, quiet: false });
  assert.equal(env.state().plays.has('roto'), true);
  env.stopGame('roto', 'stopped'); // el lanzamiento fallo: nunca llego a 'running'
  assert.equal(env.state().plays.has('roto'), false);
  env.quit();
});

// ---------------------------------------------------------------- asistente y recetas dentro del juego

function withPanel(env, tr, id) {
  env.page({ type: 'ready' });
  env.shortcuts.get(id === 'assistant' ? 'Alt+Shift+A' : 'Alt+Shift+R')();
  tr.update(info({ hwnd: GAME, foreground: env.win().hwnd }));
}

test('asistente: sin conexion el panel lo dice enseguida, sin preguntarle a la nube, y enviar da un error que se entiende', async (t) => {
  const { env, tr } = await boot({}, t);
  let asked = 0;
  env.stub('../../assistant', { status: async () => (asked++, { enabled: true, provider: 'venus' }), send: async () => ({ conversationId: 'c1' }) });
  env.stub('../../assistant/agent', { conversations: async () => [], conversation: async () => null });
  withPanel(env, tr, 'assistant');
  env.online = false;
  const open = await env.panelRequest({ action: 'assistant.open' });
  assert.equal(open.ok, true);
  assert.equal(open.data.block, 'offline');
  assert.equal(asked, 0, 'no se llamo a la nube');
  const sent = await env.panelRequest({ action: 'assistant.send', text: 'hola' });
  assert.equal(sent.ok, false);
  assert.equal(sent.code, 'offline');
  assert.match(sent.error, /conexi/i);
  env.quit();
});

test('asistente: con la IA apagada lo dice sin consultar, y si el estado no llega en 8 s el panel no queda en blanco', { timeout: 5000 }, async (t) => {
  const { env, tr } = await boot({ settings: { ai: { enabled: false } } }, t);
  let asked = 0;
  env.stub('../../assistant', { status: () => (asked++, new Promise(() => {})) });
  env.stub('../../assistant/agent', { conversations: async () => [], conversation: async () => null });
  withPanel(env, tr, 'assistant');
  const off = await env.panelRequest({ action: 'assistant.open' });
  assert.equal(off.data.block, 'disabled');
  assert.equal(asked, 0);
  await env.settings.set({ ai: { enabled: true } });
  const slow = env.panelRequest({ action: 'assistant.open' });
  await flush();
  tick(t, 8100);
  const r = await slow;
  assert.equal(r.ok, true);
  assert.equal(r.data.block, 'unavailable');
  env.quit();
});

test('recetas: una lectura que no termina vence a los 90 s y la proxima vez se pide de nuevo', { timeout: 5000 }, async (t) => {
  const { env, tr } = await boot({}, t);
  env.game.before[0]({ id: 'inst', instance: { dir: 'C:/x' }, resolved: { rootId: '1.20.1', assetIndex: { id: '12' } }, account: { uuid: null, name: 'Steve' }, quiet: false });
  let opened = 0;
  env.stub('../../recipes', { open: () => (++opened === 1 ? new Promise(() => {}) : Promise.resolve({ info: { version: '1.20.1', recipes: 3, mods: 0 } })) });
  withPanel(env, tr, 'recipes');
  const first = env.panelRequest({ action: 'recipes.info' });
  await flush();
  tick(t, 90100);
  const r1 = await first;
  assert.equal(r1.ok, false);
  assert.equal(r1.code, 'timeout');
  const r2 = await env.panelRequest({ action: 'recipes.info' });
  assert.equal(r2.ok, true, 'la segunda vez se vuelve a pedir');
  assert.equal(r2.data.version, '1.20.1');
  assert.equal(opened, 2);
  env.quit();
});

// ---------------------------------------------------------------- pedidos de la pagina

test('panel: la pagina solo puede pedir lo que esta en la lista, desde su ventana y con un panel abierto', async (t) => {
  const { env, tr } = await boot({}, t);
  env.page({ type: 'ready' });
  assert.equal((await env.panelRequest({ action: 'assistant.new' })).code, 'closed', 'sin panel abierto');
  withPanel(env, tr, 'recipes');
  assert.equal((await env.panelRequest({ action: 'assistant.new' }, { webContents: { id: 1 }, isDestroyed: () => false })).code, 'forbidden', 'de otra ventana');
  for (const bad of [null, 'hola', { action: 'launcher.open', route: 'https://malo.example' }, { action: 'settings.set', patch: {} }, { action: 'recipes.item', id: '../../x' }, { action: 'assistant.confirm', requestId: 'r1', approved: 'si' }, { action: 'panel.switch', id: 'otro' }]) {
    assert.equal((await env.panelRequest(bad)).code, 'bad', JSON.stringify(bad));
  }
  assert.equal((await env.panelRequest({ action: 'assistant.new' })).ok, true);
  env.quit();
});

// ---------------------------------------------------------------- estado visible

test('estado: dice si el overlay esta activo, si encontro el juego y por que no', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: START });
  const env = makeEnv({}, t);
  await flush();
  let s = await env.status();
  assert.deepEqual([s.running, s.found, s.tracker, s.active], [false, false, 'off', false]);
  env.startGame('inst', 4242);
  s = await env.status();
  assert.deepEqual([s.running, s.found, s.tracker], [true, false, 'starting'], 'buscando la ventana');
  env.tracker.last().update(info({ hwnd: GAME, foreground: GAME }));
  s = await env.status();
  assert.deepEqual([s.found, s.visible, s.tracker, s.active], [true, true, 'ok', true]);
  env.tracker.last().update(info({ hwnd: GAME, foreground: '9' }));
  s = await env.status();
  assert.deepEqual([s.found, s.visible], [true, false], 'otra aplicacion adelante: el overlay se esconde');
  env.quit();
});

function pick(obj, keys) {
  return Object.fromEntries(keys.map((k) => [k, obj[k]]));
}

test('pagina: se entera de cuando la ventana se muestra o se esconde (escondida no corre temporizadores)', async (t) => {
  const { env, tr } = await boot({}, t);
  env.page({ type: 'ready' });
  const shown = () => env.win().sentOn('overlay:event').filter((e) => e.kind === 'shown').map((e) => e.shown);
  assert.equal(shown().at(-1), true);
  tr.update(info({ hwnd: GAME, foreground: '9' })); // el jugador se fue a otra aplicacion
  assert.equal(shown().at(-1), false);
  tr.update(info({ hwnd: GAME, foreground: GAME }));
  assert.equal(shown().at(-1), true);
  env.quit();
});
