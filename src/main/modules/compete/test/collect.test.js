'use strict';
// El circuito completo del proceso principal contra una carpeta de datos temporal: foto inicial, envío, confirmación,
// cuenta nueva y compartir apagado. Las cuentas de Minecraft se simulan: el resto es el código de verdad.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const UUID = '00112233445566778899aabbccddeeff';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'venus-compete-'));
const paths = require('../../../core/paths');
paths.setRoot(root);

const accountsFile = require.resolve('../../../core/accounts');
require.cache[accountsFile] = { id: accountsFile, filename: accountsFile, loaded: true, exports: { list: async () => ({ accounts: [{ uuid: UUID }] }) } };

const settings = require('../../../core/settings');
const stats = require('../../../core/stats');
const compete = require('../../compete');

const statsDir = path.join(paths.instance('prueba'), 'saves', 'Mundo', 'stats');
const statsFile = path.join(statsDir, `${UUID}.json`);

function writeStats({ diamonds = 0, mobs = 0, stone = 0, deaths = 0, minutes = 0 }, ageMs = 0) {
  fs.writeFileSync(statsFile, JSON.stringify({ stats: {
    'minecraft:custom': { 'minecraft:mob_kills': mobs, 'minecraft:deaths': deaths, 'minecraft:play_time': minutes * 60 * 20 },
    'minecraft:mined': { 'minecraft:diamond_ore': diamonds, 'minecraft:stone': stone },
  } }));
  const when = new Date(Date.now() - ageMs);
  fs.utimesSync(statsFile, when, when);
}

test.before(() => {
  fs.mkdirSync(statsDir, { recursive: true });
  fs.writeFileSync(path.join(paths.instance('prueba'), 'venus-instance.json'), JSON.stringify({ name: 'Prueba' }));
  fs.writeFileSync(path.join(statsDir, '..', 'level.dat'), '');
});

test.after(async () => {
  await new Promise((r) => setTimeout(r, 100));
  fs.rmSync(root, { recursive: true, force: true });
});

test('con compartir apagado no lee ni manda nada', async () => {
  writeStats({ diamonds: 50, minutes: 600 });
  assert.deepEqual(await compete.collect({ userId: 'u1' }), { off: true, reports: [] });
  assert.equal(fs.existsSync(paths.data('compete.json')), false);
});

test('la primera vez solo saca la foto: lo que ya estaba no se manda nunca', async () => {
  await settings.set({ compete: { share: true } });
  assert.deepEqual(await compete.collect({ userId: 'u1' }), { first: true, reports: [] });
  assert.deepEqual(await compete.collect({ userId: 'u1' }), { reports: [] });
});

test('sin cuenta de Venus no hace nada', async () => {
  assert.deepEqual(await compete.collect({}), { off: true, reports: [] });
});

test('manda la diferencia y, confirmada, no la vuelve a mandar', async () => {
  // La foto se sacó hace una hora y después se jugaron 44 minutos
  const saved = JSON.parse(fs.readFileSync(paths.data('compete.json'), 'utf8'));
  fs.writeFileSync(paths.data('compete.json'), JSON.stringify({ ...saved, cursor: Date.now() - 60 * 60000 }));
  const start = Date.now() - 45 * 60000;
  stats.recordSession({ instanceId: 'prueba', name: 'Prueba', mcVersion: '1.21', loader: 'vanilla', start, end: Date.now() - 60000, crashed: false });
  writeStats({ diamonds: 53, mobs: 4, stone: 20, deaths: 1, minutes: 640 });
  const first = await compete.collect({ userId: 'u1' });
  assert.equal(first.reports.length, 1);
  const [report] = first.reports;
  assert.equal(report.minutes, 44);
  assert.deepEqual([report.diamonds, report.mobs, report.blocks, report.deaths], [3, 4, 23, 1]);
  assert.equal(report.files, undefined);

  // Sin confirmar (el servidor no respondió), se vuelve a calcular lo mismo
  const again = await compete.collect({ userId: 'u1' });
  assert.deepEqual(again.reports, first.reports);

  assert.equal(await compete.commit('otro', report.week), false);
  assert.equal(await compete.commit(again.token, report.week), true);
  assert.deepEqual(await compete.collect({ userId: 'u1' }), { reports: [] });
});

test('un archivo con muchísimo más tiempo de juego que el jugado no se manda', async () => {
  writeStats({ diamonds: 500, stone: 9000, minutes: 5000 });
  assert.deepEqual(await compete.collect({ userId: 'u1' }), { reports: [] });
  // Queda como el nuevo punto de partida
  writeStats({ diamonds: 501, stone: 9000, minutes: 5001 });
  const out = await compete.collect({ userId: 'u1' });
  assert.equal(out.reports[0].diamonds, 1);
  await compete.commit(out.token, out.reports[0].week);
});

test('con otra cuenta de Venus empieza de cero', async () => {
  writeStats({ diamonds: 700, stone: 9000, minutes: 5002 });
  assert.deepEqual(await compete.collect({ userId: 'u2' }), { first: true, reports: [] });
  assert.deepEqual(await compete.collect({ userId: 'u2' }), { reports: [] });
});

test('reiniciar olvida el punto de partida', async () => {
  writeStats({ diamonds: 701, stone: 9000, minutes: 5002 });
  assert.equal(await compete.reset(), true);
  assert.deepEqual(await compete.collect({ userId: 'u2' }), { first: true, reports: [] });
});
