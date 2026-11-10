'use strict';
// 6.1: el overlay viene apagado. Valor por defecto, actualizacion de quien lo tenia prendido por defecto, costo cero apagado,
// disenos listos, "No molestar" y el unico lugar donde se decide la plataforma.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('../config');
const platform = require('../platform');
const { makeEnv, info, flush } = require('./harness');

const GAME = '5000';
const START = 1_000_000;
const tick = (t, ms) => t.mock.timers.tick(ms);

// ---------------------------------------------------------------- valor por defecto y actualizacion

test('valor por defecto: apagado en el modulo y en los ajustes del launcher', () => {
  assert.equal(config.DEFAULTS.enabled, false);
  assert.equal(config.normalize(undefined).enabled, false);
  assert.equal(config.normalize({}).enabled, false);
  assert.equal(config.normalize({ enabled: true }).enabled, true, 'quien lo prendio lo conserva');
  assert.equal(require('../../../core/settings').defaults().overlay.enabled, false);
});

test('actualizacion: quien lo usaba con el valor por defecto queda apagado y con un aviso pendiente', () => {
  const saved = { onboarded: true, language: 'es', overlay: { widgets: { voice: { scale: 1.2 } } } };
  const up = config.upgradeSaved(saved);
  assert.equal(up.overlay.enabled, false);
  assert.equal(up.overlay.offNotice, 'pending');
  assert.equal(up.overlay.widgets.voice.scale, 1.2, 'lo demas del overlay no se toca');
  assert.equal(saved.overlay.enabled, undefined, 'no cambia el objeto que se leyo');
  assert.equal(config.upgradeSaved({ onboarded: true }).overlay.offNotice, 'pending', 'sin nada del overlay guardado');
});

test('actualizacion: una eleccion guardada se respeta y una instalacion nueva no recibe el aviso', () => {
  for (const enabled of [true, false]) {
    const saved = { onboarded: true, overlay: { enabled } };
    assert.equal(config.upgradeSaved(saved), saved, `lo tenia ${enabled ? 'prendido' : 'apagado'} a mano`);
  }
  const fresh = { onboarded: false, language: null };
  assert.equal(config.upgradeSaved(fresh), fresh, 'todavia en la bienvenida');
  assert.deepEqual(config.upgradeSaved({}), {}, 'sin archivo de ajustes');
  const seen = { onboarded: true, overlay: { enabled: false, offNotice: 'seen' } };
  assert.equal(config.upgradeSaved(seen), seen, 'el aviso ya se vio');
  for (const raw of [null, undefined, 'x', [], 4]) assert.equal(config.upgradeSaved(raw), raw);
});

test('actualizacion: core/settings lo aplica al leer el archivo de la 6.0 (y no a uno nuevo)', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venus-ovl-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const paths = require('../../../core/paths');
  const settingsFile = require.resolve('../../../core/settings');
  const read = async (saved) => {
    paths.setRoot(dir);
    if (saved) fs.writeFileSync(path.join(dir, 'data', 'settings.json'), JSON.stringify(saved));
    else fs.rmSync(path.join(dir, 'data', 'settings.json'), { force: true });
    delete require.cache[settingsFile];
    return require(settingsFile).get();
  };
  t.after(() => delete require.cache[settingsFile]);
  let s = await read({ onboarded: true, language: 'es', afterLaunch: 'keep' });
  assert.deepEqual([s.overlay.enabled, s.overlay.offNotice], [false, 'pending'], '6.0 con el overlay por defecto');
  s = await read({ onboarded: true, overlay: { enabled: true } });
  assert.deepEqual([s.overlay.enabled, s.overlay.offNotice], [true, undefined], '6.0 prendido a mano');
  s = await read(null);
  assert.deepEqual([s.overlay.enabled, s.overlay.offNotice], [false, undefined], 'instalacion nueva');
});

// ---------------------------------------------------------------- costo cero apagado

test('apagado: abrir el juego no crea la ventana, ni el ayudante, ni el medidor, ni contadores, ni atajos', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: START });
  const env = makeEnv({ settings: { overlay: { enabled: false } } }, t);
  await flush();
  env.game.before[0]({ id: 'inst', instance: { dir: 'C:/x' }, resolved: { rootId: '1.20.1', assetIndex: { id: '12' } }, account: { uuid: null, name: 'Steve' }, quiet: false });
  env.startGame('inst', 4242);
  env.game.events.emit('log', 'inst', [{ text: '[Render thread/INFO]: [CHAT] Steve fell from a high place' }]);
  env.overlay.push({ kind: 'alert', title: 'Hola' });
  tick(t, 120000);
  const s = await env.status();
  assert.equal(env.windows.length, 0, 'sin ventana');
  assert.equal(env.tracks.length, 0, 'sin ayudante de PowerShell');
  assert.equal(env.samplers.length, 0, 'sin medidor de rendimiento');
  assert.equal(env.state().games.get('inst').counters, null, 'sin contadores');
  assert.equal(env.state().plays.get('inst').tablesAsked, false, 'sin leer los textos del juego');
  assert.equal(env.attempts.length, 0, 'ningun atajo global, ni intentado');
  assert.deepEqual([s.enabled, s.active, s.running, s.tracker], [false, false, true, 'off']);
  env.quit();
});

test('apagado: prenderlo en plena partida arranca todo y apagarlo lo suelta otra vez', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: START });
  const env = makeEnv({ settings: { overlay: { enabled: false } } }, t);
  await flush();
  env.game.before[0]({ id: 'inst', instance: { dir: 'C:/x' }, resolved: { rootId: '1.20.1', assetIndex: { id: '12' } }, account: { uuid: null, name: 'Steve' }, quiet: false });
  env.startGame('inst', 4242);
  await env.settings.set({ overlay: { enabled: true } });
  assert.equal(env.tracks.length, 1, 'ayudante');
  env.tracker.last().update(info({ hwnd: GAME, foreground: GAME }));
  const g = env.state().games.get('inst');
  assert.ok(g.counters, 'contadores');
  assert.equal(env.state().plays.get('inst').tablesAsked, true, 'textos del juego');
  assert.equal(env.windows.length, 1, 'ventana');
  assert.equal(env.shortcuts.size, 4, 'atajos con el juego adelante');
  await env.settings.set({ overlay: { enabled: false } });
  assert.equal(g.counters, null);
  assert.equal(env.tracker.last().stopped, true);
  assert.equal(env.shortcuts.size, 0);
  assert.equal(env.samplers.every((x) => x.stopped), true);
  env.quit();
});

// ---------------------------------------------------------------- disenos listos

test('disenos listos: solo prenden y apagan widgets (y un par de opciones), sin tocar posiciones', () => {
  assert.deepEqual(config.PRESET_IDS, ['minimal', 'full', 'performance']);
  for (const id of config.PRESET_IDS) {
    const patch = config.presetPatch(id);
    assert.deepEqual(Object.keys(patch).sort(), [...config.WIDGETS].sort(), id);
    for (const w of Object.values(patch)) {
      assert.equal(typeof w.enabled, 'boolean');
      for (const k of ['anchor', 'x', 'y', 'scale', 'opacity', 'theme']) assert.equal(k in w, false, `${id} no toca ${k}`);
    }
    // Lo que queda despues de aplicarlo sigue siendo una configuracion valida
    const c = config.normalize({ widgets: patch });
    for (const wid of config.WIDGETS) assert.equal(c.widgets[wid].enabled, patch[wid].enabled);
  }
  const on = (id) => config.WIDGETS.filter((w) => config.PRESETS[id][w].enabled);
  assert.deepEqual(on('minimal'), ['voice', 'alerts']);
  assert.deepEqual(on('full'), config.WIDGETS);
  assert.deepEqual(on('performance'), ['perf']);
  assert.equal(config.presetPatch('otro'), null);
  assert.equal(config.presetPatch('__proto__'), null);
  const a = config.presetPatch('minimal');
  a.voice.enabled = false;
  assert.equal(config.PRESETS.minimal.voice.enabled, true, 'cada parche es una copia');
});

test('disenos listos: el canal los guarda y devuelve el estado; uno que no existe se rechaza', async (t) => {
  const env = makeEnv({}, t);
  await flush();
  await env.settings.set({ overlay: { widgets: { voice: { anchor: 'br', scale: 1.4 } } } });
  const s = await env.invoke('overlay:preset', 'performance');
  assert.deepEqual(config.WIDGETS.filter((w) => s.config.widgets[w].enabled), ['perf']);
  assert.deepEqual([s.config.widgets.voice.anchor, s.config.widgets.voice.scale], ['br', 1.4], 'la posicion y el tamano siguen');
  assert.deepEqual(Object.keys(s.presets), config.PRESET_IDS, 'el estado trae los disenos para la interfaz');
  await assert.rejects(env.invoke('overlay:preset', 'nada'), (err) => err.code === 'invalid');
  env.quit();
});

// ---------------------------------------------------------------- no molestar

test('no molestar: plan de cada modo', () => {
  assert.deepEqual(config.dndPlan(15, 1000), { until: 1000 + 15 * 60000, game: false });
  assert.deepEqual(config.dndPlan('60', 0), { until: 3600000, game: false });
  assert.deepEqual(config.dndPlan('game', 5), { until: 0, game: true });
  for (const bad of [0, 30, 'x', null, undefined, {}, -15]) assert.equal(config.dndPlan(bad, 0), null, String(bad));
  assert.equal(config.dndSilences({ kind: 'alert' }), true);
  assert.equal(config.dndSilences({ kind: 'message' }), true);
  for (const kind of ['voice', 'music', 'capture', 'perf', 'counters']) assert.equal(config.dndSilences({ kind }), false, kind);
  for (const icon of ['capture', 'music']) assert.equal(config.dndSilences({ kind: 'alert', icon }), false, `aviso ${icon}`);
  assert.equal(config.dndSilences({ kind: 'alert', icon: 'info' }), true);
});

test('no molestar: los avisos que responden al jugador o son criticos pasan y no se cuentan como perdidos', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: START });
  const env = makeEnv({}, t);
  await flush();
  env.startGame('inst', 4242);
  env.tracker.last().update(info({ hwnd: GAME, foreground: GAME }));
  env.page({ type: 'ready' });
  const events = () => env.win().sentOn('overlay:event');
  await env.invoke('overlay:dnd', 15);
  const before = events().length;
  env.overlay.push({ kind: 'alert', title: 'Volumen 40%', icon: 'music', ttl: 1500 });
  env.overlay.push({ kind: 'alert', title: 'No se pudo guardar el clip', body: 'sin disco', icon: 'capture', ttl: 5000 });
  env.overlay.push({ kind: 'alert', icon: 'info', title: 'El juego se cierra en 1 minuto', ttl: 12 }, { direct: true });
  env.overlay.push({ kind: 'alert', icon: 'info', title: 'Un aviso cualquiera' });
  const after = events().slice(before).map((e) => e.title);
  assert.deepEqual(after, ['Volumen 40%', 'No se pudo guardar el clip', 'El juego se cierra en 1 minuto']);
  assert.equal((await env.status()).dnd.missed, 1, 'solo el aviso comun cuenta como perdido');
  // Desde la interfaz no se puede saltar
  await env.invoke('overlay:push', { kind: 'alert', icon: 'info', title: 'Desde la interfaz' }, { direct: true });
  assert.equal((await env.status()).dnd.missed, 2);
  env.quit();
});

test('no molestar: calla avisos y mensajes un rato, deja pasar la voz y las capturas, y al terminar dice cuantos fueron', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: START });
  const env = makeEnv({}, t);
  await flush();
  env.startGame('inst', 4242);
  env.tracker.last().update(info({ hwnd: GAME, foreground: GAME }));
  env.page({ type: 'ready' });
  const events = () => env.win().sentOn('overlay:event');
  let s = await env.invoke('overlay:dnd', 15);
  assert.equal(s.dnd.on, true);
  assert.equal(s.dnd.until, START + 15 * 60000);
  assert.ok(events().some((e) => e.kind === 'dnd' && e.on === true), 'la pagina vacia lo que estaba en pantalla');
  const before = events().length;
  env.overlay.push({ kind: 'alert', title: 'Logro' });
  env.overlay.push({ kind: 'message', from: 'Sofi', text: 'hola' });
  env.overlay.push({ kind: 'capture', type: 'screenshot' });
  const after = events().slice(before);
  assert.deepEqual(after.map((e) => e.kind), ['capture'], 'solo la captura llego');
  s = await env.status();
  assert.equal(s.dnd.missed, 2);
  tick(t, 15 * 60000 + 10);
  s = await env.status();
  assert.equal(s.dnd.on, false, 'se apaga solo');
  const last = events().filter((e) => e.kind === 'alert').at(-1);
  assert.ok(last, 'aviso de que termino');
  assert.match(last.body, /2/, 'dice cuantos se perdio');
  await assert.rejects(async () => env.invoke('overlay:dnd', 'mucho'), (err) => err.code === 'invalid');
  env.quit();
});

test('no molestar: con el atajo es "hasta cerrar el juego", avisa como quedo y se apaga al cerrar el juego', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: START });
  const env = makeEnv({}, t);
  await flush();
  env.startGame('inst', 4242);
  env.tracker.last().update(info({ hwnd: GAME, foreground: GAME }));
  env.page({ type: 'ready' });
  env.shortcuts.get('Alt+Shift+N')();
  let s = await env.status();
  assert.deepEqual([s.dnd.on, s.dnd.game, s.dnd.until], [true, true, null]);
  const confirm = env.win().sentOn('overlay:event').filter((e) => e.kind === 'alert').at(-1);
  assert.ok(confirm?.title, 'el aviso de que se prendio pasa aunque este en silencio');
  tick(t, 5 * 3600 * 1000);
  assert.equal((await env.status()).dnd.on, true, 'no vence por tiempo');
  env.stopGame('inst');
  s = await env.status();
  assert.equal(s.dnd.on, false, 'se apago al cerrar el juego');
  // Y el atajo, apretado dos veces, lo prende y lo apaga
  env.startGame('inst', 4343);
  env.tracker.last().update(info({ hwnd: GAME, foreground: GAME }));
  env.shortcuts.get('Alt+Shift+N')();
  env.shortcuts.get('Alt+Shift+N')();
  assert.equal((await env.status()).dnd.on, false);
  env.quit();
});

test('no molestar: el atajo es configurable como los de los paneles y no choca con los otros', async (t) => {
  const env = makeEnv({}, t);
  await flush();
  const taken = await env.invoke('overlay:setPanelShortcut', 'dnd', 'Alt+Shift+R');
  assert.deepEqual([taken.ok, taken.code, taken.who], [false, 'venus', 'overlay']);
  const good = await env.invoke('overlay:setPanelShortcut', 'dnd', 'Alt+Shift+J');
  assert.equal(good.ok, true);
  assert.equal((await env.status()).panelShortcuts.dnd, 'Alt+Shift+J');
  env.quit();
});

// ---------------------------------------------------------------- plataforma

test('plataforma: un solo lugar decide si hay overlay (hoy solo Windows)', () => {
  assert.equal(platform.available('win32'), true);
  for (const p of ['darwin', 'linux', 'freebsd', 'aix', '']) assert.equal(platform.available(p), false, p);
  assert.equal(platform.available(), process.platform === 'win32');
});

test('plataforma: sin overlay (macOS) y prendido en los ajustes no toma ningun atajo global durante la partida', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: START });
  t.mock.method(platform, 'available', () => false);
  const env = makeEnv({ settings: { overlay: { enabled: true } } }, t);
  await flush();
  env.startGame('inst', 4242);
  env.overlay.push({ kind: 'alert', title: 'Hola' });
  tick(t, 60000);
  const s = await env.status();
  assert.deepEqual([s.supported, s.active, s.tracker], [false, false, 'off']);
  assert.equal(env.windows.length, 0, 'sin ventana');
  assert.equal(env.attempts.length, 0, 'ningun atajo global, ni intentado');
  assert.equal(env.shortcuts.size, 0);
  assert.equal(s.dnd.missed, 0);
  env.quit();
});

// ---------------------------------------------------------------- modo edicion con el overlay apagado

test('modo edicion con el overlay apagado: minimiza el launcher, y al salir devuelve el foco al juego y suelta el ayudante', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: START });
  const env = makeEnv({ settings: { overlay: { enabled: false } } }, t);
  await flush();
  env.startGame('inst', 4242);
  assert.equal(env.tracks.length, 0, 'apagado: sin ayudante');
  await env.invoke('overlay:edit', true);
  assert.deepEqual(env.main.calls, ['minimize'], 'el launcher se minimiza aunque el ayudante no haya informado');
  const tr = env.tracker.last();
  assert.ok(tr, 'el ayudante arranca para la edicion');
  tr.update(info({ hwnd: GAME, foreground: '7777' }));
  await env.invoke('overlay:edit', false);
  assert.equal(tr.stopped, false, 'sigue vivo para devolver el foco');
  tick(t, 700);
  assert.ok(tr.fronts.includes(GAME), 'el foco vuelve al juego');
  assert.equal(tr.stopped, true, 'y despues se suelta');
  assert.equal(env.state().games.get('inst').track, null);
  env.quit();
});
