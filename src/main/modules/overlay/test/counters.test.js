'use strict';
// Contadores en pantalla: lectura de las estadisticas del juego, la cuenta desde que arranca la sesion y las muertes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const counters = require('../counters');
const config = require('../config');
const { validate } = require('../events');
const { esm } = require('./helpers');

const stats = (deaths, mined) => ({ stats: { 'minecraft:custom': { 'minecraft:deaths': deaths, 'minecraft:jump': 5 }, 'minecraft:mined': mined }, DataVersion: 3000 });

test('estadisticas: el formato de 1.13 en adelante y el viejo', () => {
  assert.deepEqual(counters.parseStats(stats(3, { 'minecraft:stone': 10, 'minecraft:dirt': 5 })), { deaths: 3, mined: 15 });
  assert.deepEqual(counters.parseStats({ 'stat.deaths': 2, 'stat.mineBlock.minecraft.stone': 4, 'stat.mineBlock.minecraft.dirt': 1, 'stat.jump': 100 }), { deaths: 2, mined: 5 });
  for (const raw of [null, 'x', [], {}, { stats: {} }, { stats: { 'minecraft:mined': 'x' } }]) assert.deepEqual(counters.parseStats(raw), { deaths: 0, mined: 0 }, JSON.stringify(raw));
  assert.deepEqual(counters.parseStats(stats('x', { a: -5, b: 'y', c: 2.9 })), { deaths: 0, mined: 2 });
});

test('la cuenta arranca en la sesion: lo de antes no suma', () => {
  const t = counters.createTally();
  assert.deepEqual(counters.view(t), { deaths: 0, mined: null, multiplayer: false }, 'sin mundo todavia');
  counters.enter(t, 'world:a');
  counters.observe(t, { deaths: 7, mined: 1000 }); // lo que ya tenia ese mundo
  assert.deepEqual(counters.view(t), { deaths: 0, mined: 0, multiplayer: false });
  counters.observe(t, { deaths: 8, mined: 1040 });
  assert.deepEqual(counters.view(t), { deaths: 1, mined: 40, multiplayer: false });
});

test('muertes: en vivo por el registro, sin contarlas dos veces cuando el juego guarda', () => {
  const t = counters.createTally();
  counters.enter(t, 'world:a');
  counters.observe(t, { deaths: 7, mined: 0 });
  counters.addDeath(t);
  counters.addDeath(t);
  assert.equal(counters.view(t).deaths, 2, 'antes de que el juego guarde');
  counters.observe(t, { deaths: 9, mined: 0 });
  assert.equal(counters.view(t).deaths, 2, 'despues de guardar: las mismas dos');
  counters.observe(t, { deaths: 10, mined: 0 });
  assert.equal(counters.view(t).deaths, 3, 'una que el registro no vio (otro idioma) tambien cuenta');
});

test('varios mundos y servidores: se acumula, y en multijugador solo hay muertes', () => {
  const t = counters.createTally();
  counters.enter(t, 'world:a');
  counters.observe(t, { deaths: 1, mined: 100 });
  counters.observe(t, { deaths: 2, mined: 150 });
  counters.enter(t, 'world:b');
  counters.observe(t, { deaths: 50, mined: 5000 });
  counters.observe(t, { deaths: 50, mined: 5007 });
  assert.deepEqual(counters.view(t), { deaths: 1, mined: 57, multiplayer: false });
  counters.enter(t, 'server:mc.ejemplo.com');
  counters.addDeath(t);
  assert.deepEqual(counters.view(t), { deaths: 2, mined: 57, multiplayer: true });
  // Volver al mundo a: la foto se saca de nuevo, no vuelve a sumar lo de antes
  counters.enter(t, 'world:a');
  counters.observe(t, { deaths: 2, mined: 150 });
  assert.deepEqual(counters.view(t), { deaths: 2, mined: 57, multiplayer: false });
  // Una estadistica que baja (se borro el archivo) no resta
  counters.observe(t, { deaths: 0, mined: 0 });
  assert.deepEqual(counters.view(t), { deaths: 2, mined: 57, multiplayer: false });

  const mp = counters.createTally();
  counters.enter(mp, 'server:x');
  counters.addDeath(mp);
  assert.deepEqual(counters.view(mp), { deaths: 1, mined: null, multiplayer: true }, 'sin archivo: los bloques no se saben');
});

test('una muerte que aparece dos veces (servidor y chat) cuenta una sola', () => {
  let clock = 1000;
  const gate = counters.createDeathGate(2000, () => clock);
  assert.equal(gate(), true);
  clock += 50;
  assert.equal(gate(), false);
  clock += 2500;
  assert.equal(gate(), true);
});

test('uuid con guiones, como el nombre del archivo', () => {
  assert.equal(counters.dashUuid('0123456789abcdef0123456789abcdef'), '01234567-89ab-cdef-0123-456789abcdef');
  assert.equal(counters.dashUuid('01234567-89AB-cdef-0123-456789abcdef'), '01234567-89ab-cdef-0123-456789abcdef');
  for (const bad of [null, '', 'x', '../../etc', '0123456789abcdef0123456789abcde']) assert.equal(counters.dashUuid(bad), null);
});

test('seguimiento real sobre archivos: mundo existente, juego que guarda y multijugador', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venus-counters-test-'));
  const uuid = '01234567-89ab-cdef-0123-456789abcdef';
  const statsDir = path.join(dir, 'saves', 'Mi mundo', 'stats');
  fs.mkdirSync(statsDir, { recursive: true });
  fs.writeFileSync(path.join(statsDir, `${uuid}.json`), JSON.stringify(stats(5, { 'minecraft:stone': 100 })));
  fs.writeFileSync(path.join(statsDir, 'otro-jugador.json'), JSON.stringify(stats(99, { 'minecraft:stone': 9999 })));
  let activity = { type: 'menu' };
  const seen = [];
  let clock = 1000000;
  const w = counters.createWatch({ instanceDir: dir, uuid, startedAt: clock - 60000, getActivity: () => activity, onUpdate: (ev) => seen.push(ev), interval: 5, now: () => clock, gateMs: 2000 });
  const waitFor = async (fn) => {
    for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 5));
    assert.ok(fn(), 'condicion que no llego');
  };
  try {
    await waitFor(() => seen.length > 0);
    assert.equal(seen[0].session, 60);
    assert.equal(seen[0].mined, null, 'en el menu todavia no hay mundo');
    activity = { type: 'singleplayer', world: 'Mi mundo' };
    await waitFor(() => seen.at(-1).mined === 0);
    assert.equal(seen.at(-1).deaths, 0, 'la foto inicial no suma');

    // Muerte en vivo, dos avisos casi juntos
    assert.equal(w.death(), true);
    assert.equal(w.death(), false);
    assert.equal(seen.at(-1).deaths, 1);

    // El juego guarda
    await new Promise((r) => setTimeout(r, 20));
    fs.writeFileSync(path.join(statsDir, `${uuid}.json`), JSON.stringify(stats(6, { 'minecraft:stone': 130 })));
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(statsDir, `${uuid}.json`), later, later);
    await waitFor(() => seen.at(-1).mined === 30);
    assert.equal(seen.at(-1).deaths, 1, 'la muerte del archivo es la misma que la del registro');

    activity = { type: 'server', address: 'mc.ejemplo.com' };
    await waitFor(() => seen.at(-1).multiplayer === true);
    assert.equal(seen.at(-1).mined, 30, 'lo minado antes sigue');
    clock += 3000;
    w.death();
    assert.equal(seen.at(-1).deaths, 2);

    // Una carpeta rara no arma una ruta afuera del juego
    activity = { type: 'singleplayer', world: '../../afuera' };
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(seen.at(-1).multiplayer, true, 'se ignora');
  } finally {
    w.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const count = seen.length;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(seen.length, count, 'parado: no hay mas avisos');
});

test('sin archivo todavia (mundo nuevo): la foto inicial es cero y el primer guardado suma todo', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venus-counters-test-'));
  const statsDir = path.join(dir, 'saves', 'Nuevo', 'stats');
  fs.mkdirSync(path.join(dir, 'saves', 'Nuevo'), { recursive: true });
  const seen = [];
  const w = counters.createWatch({ instanceDir: dir, uuid: null, startedAt: Date.now(), getActivity: () => ({ type: 'singleplayer', world: 'Nuevo' }), onUpdate: (ev) => seen.push(ev), interval: 5 });
  const waitFor = async (fn) => {
    for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 5));
    assert.ok(fn(), 'condicion que no llego');
  };
  try {
    await waitFor(() => seen.at(-1)?.mined === 0);
    fs.mkdirSync(statsDir);
    fs.writeFileSync(path.join(statsDir, 'cualquiera.json'), JSON.stringify(stats(1, { 'minecraft:dirt': 12 })));
    await waitFor(() => seen.at(-1).mined === 12);
    assert.equal(seen.at(-1).deaths, 1);
  } finally {
    w.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('evento del contrato 1 y ajustes del widget', () => {
  assert.deepEqual(validate({ kind: 'counters', deaths: 2.9, mined: 347, session: 100, multiplayer: true, extra: 1 }), { kind: 'counters', deaths: 2, mined: 347, session: 100, multiplayer: true });
  assert.deepEqual(validate({ kind: 'counters', deaths: null, mined: 'x', session: -5 }), { kind: 'counters', deaths: null, mined: null, session: 0, multiplayer: false });
  const c = config.normalize(undefined);
  assert.ok(config.WIDGETS.includes('counters'));
  assert.deepEqual(c.widgets.counters.show, { deaths: true, mined: true, session: true });
  const custom = config.normalize({ widgets: { counters: { enabled: false, show: { mined: false, otro: true } } } });
  assert.equal(custom.widgets.counters.enabled, false);
  assert.deepEqual(custom.widgets.counters.show, { deaths: true, mined: false, session: true });
  assert.deepEqual(config.positionPatch('counters', { anchor: 'tc' }), { counters: { anchor: 'tc' } });
  assert.equal(config.resetPatch().counters.anchor, config.DEFAULTS.widgets.counters.anchor);
});

test('lo que muestra el widget: numeros, sin dato y el reloj que corre solo', async () => {
  // dom.js no se usa en estas funciones: se cargan con un document de mentira
  globalThis.document ??= { createElementNS: () => ({ setAttribute() {} }), createElement: () => ({}) };
  const src = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'renderer', 'js', 'overlay', 'counters.js'), 'utf8');
  const perf = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'renderer', 'js', 'overlay', 'perf.js'), 'utf8');
  const dom = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'renderer', 'js', 'overlay', 'dom.js'), 'utf8');
  const url = (s) => `data:text/javascript;base64,${Buffer.from(s).toString('base64')}`;
  const domUrl = url(dom);
  const perfUrl = url(perf.replace("'./dom.js'", JSON.stringify(domUrl)));
  const m = await import(url(src.replace("'./dom.js'", JSON.stringify(domUrl)).replace("'./perf.js'", JSON.stringify(perfUrl))));
  assert.deepEqual(m.counterValues({ deaths: 2, mined: 1234, session: 65 }, null, 'en-US'), { deaths: '2', mined: '1,234', session: '1:05' });
  assert.deepEqual(m.counterValues({ deaths: 0, mined: null, session: null }, null, 'en-US'), { deaths: '0', mined: null, session: null });
  assert.equal(m.sessionNow({ session: 10, at: 1000 }, 4000), 13);
  assert.equal(m.sessionNow({ session: null }, 4000), null);
  assert.equal(m.hasCounters({ deaths: null, mined: null, session: null }), false);
  assert.equal(m.hasCounters({ deaths: 0 }), true);
  assert.equal(m.fmtCount(1234567, 'es-AR'), '1.234.567');
  void esm;
});
