'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scanStats } = require('../scan');

const UUID = '00112233445566778899aabbccddeeff';
const OTHER = 'ffeeddccbbaa99887766554433221100';
const dashed = (u) => `${u.slice(0, 8)}-${u.slice(8, 12)}-${u.slice(12, 16)}-${u.slice(16, 20)}-${u.slice(20)}`;

function world(root, instance, folder, files) {
  const dir = path.join(root, instance, 'saves', folder);
  fs.mkdirSync(path.join(dir, 'stats'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'level.dat'), '');
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, 'stats', name), content);
  return dir;
}

test('lee solo los archivos de las cuentas del launcher, en los dos formatos', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'venus-compete-'));
  try {
    world(root, 'nueva', 'Mundo', {
      [`${dashed(UUID)}.json`]: JSON.stringify({ DataVersion: 3700, stats: { 'minecraft:custom': { 'minecraft:mob_kills': 7, 'minecraft:deaths': 2, 'minecraft:play_time': 1200 }, 'minecraft:mined': { 'minecraft:diamond_ore': 1, 'minecraft:stone': 9 } } }),
      [`${dashed(OTHER)}.json`]: JSON.stringify({ stats: { 'minecraft:custom': { 'minecraft:mob_kills': 999 } } }),
    });
    world(root, 'vieja', 'Mundo 1.12', {
      [`${UUID}.json`]: JSON.stringify({ 'stat.mobKills': 3, 'stat.deaths': 1, 'stat.playOneMinute': 40, 'stat.mineBlock.minecraft.stone': 5, 'stat.mineBlock.minecraft.diamond_ore': 2 }),
    });
    world(root, 'rota', 'Escribiendo', { [`${UUID}.json`]: '{"stats":' });
    const list = ['nueva', 'vieja', 'rota', 'sin-saves'].map((id) => ({ id, dir: path.join(root, id) }));
    const known = new Set([UUID]);
    const out = await scanStats(list, known, {});
    const byKey = Object.fromEntries(out.map((f) => [f.key, f]));
    assert.deepEqual(byKey[`nueva|Mundo|${UUID}`].totals, { diamonds: 1, mobs: 7, blocks: 10, deaths: 2, play: 1200 });
    assert.deepEqual(byKey[`vieja|Mundo 1.12|${UUID}`].totals, { diamonds: 2, mobs: 3, blocks: 7, deaths: 1, play: 40 });
    assert.equal(byKey[`rota|Escribiendo|${UUID}`].unchanged, true);
    assert.equal(out.length, 3);

    // Lo que no cambió ni se abre
    const f = byKey[`nueva|Mundo|${UUID}`];
    const again = await scanStats([list[0]], known, { [f.key]: { mtimeMs: f.mtimeMs, size: f.size } });
    assert.deepEqual(again, [{ key: f.key, unchanged: true }]);

    // Sin cuentas no se lee nada
    assert.deepEqual(await scanStats(list, new Set(), {}), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
