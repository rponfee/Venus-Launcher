// El port contra datos que no salen de el:
//  - los hashes publicados en tests.c de cubiomes (testGeneration, b6_hashes): 4096 semillas por version, un punto por semilla
//  - golden.json: lo que calcula cubiomes en C en biomas, estructuras, fortalezas, aparicion y slime chunks
// De donde sale cada cosa y como regenerarla: reference/build.txt y docs/wip/semillas-34.md
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SeedWorld, loadTree } from '../gen/world.js';
import { versionByKey } from '../gen/versions.js';
import { MUSHROOM_FIELDS } from '../gen/biomes.js';
import { getRef } from './reference/hashes.js';
import { checkCase, newStats } from './reference/cases.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(fs.readFileSync(path.join(dir, 'reference', 'golden.json'), 'utf8'));

// Copiados de tests.c de cubiomes: { MC_1_20, MC_1_19, MC_1_19_2, MC_1_18 } -> b6_hashes[0..3]
const PUBLISHED_B6 = [
  ['1.20', 0x0f8888ab],
  ['1.19.4', 0x391c36ec],
  ['1.19.2', 0xea3e8c1c],
  ['1.18', 0xade7f891],
];

for (const [version, expected] of PUBLISHED_B6) {
  test(`hash publicado por cubiomes para ${version}`, async () => {
    const tree = await loadTree(versionByKey(version).table);
    assert.equal(getRef((seed) => new SeedWorld({ seed, version, dim: 0, tree }), 6), expected);
  });
}

// Sin hash publicado: los genero el binario de cubiomes (que si da los publicados de arriba)
for (const ref of golden.refs.filter((r) => r.published === undefined)) {
  test(`hash de cubiomes en C para ${ref.mc}, dimension ${ref.dim}`, async () => {
    const tree = ref.dim === 0 ? await loadTree(versionByKey(ref.mc).table) : null;
    assert.equal(getRef((seed) => new SeedWorld({ seed, version: ref.mc, dim: ref.dim, tree }), ref.bits), ref.hash);
  });
}

test('ejemplo del README de cubiomes: la semilla 262 tiene Campos de hongos en el origen (1.18)', async () => {
  // El README lo hace a escala 1:1 en (0, 63, 0), que elige una de las celdas 1:4 de alrededor; aca se miran esas celdas
  const tree = await loadTree(versionByKey('1.18').table);
  const w = new SeedWorld({ seed: 262n, version: '1.18', dim: 0, tree });
  const found = [];
  for (let z = -1; z <= 1; z++) for (let x = -1; x <= 1; x++) found.push(w.biomeAt(x, 15, z));
  assert.ok(found.includes(MUSHROOM_FIELDS), found.join());
});

test('el binario de referencia da los hashes publicados', () => {
  // Sin esto golden.json no valdria nada: es la prueba de que se compilo bien
  for (const ref of golden.refs.filter((r) => r.published !== undefined)) assert.equal(ref.hash, ref.published, ref.mc);
  assert.equal(golden.refs.filter((r) => r.published !== undefined).length, 4);
});

test('el port da lo mismo que cubiomes en C', async () => {
  const stats = newStats();
  const diffs = [];
  for (const c of golden.cases) {
    const found = await checkCase(c, stats);
    if (found.length) diffs.push(...found.map((d) => `${c.k} ${c.mc ?? ''} ${c.dim ?? ''} ${c.seed}: ${d}`));
  }
  assert.deepEqual(diffs.slice(0, 20), []);
  assert.ok(stats.cases > 500);
  assert.ok(stats.cells > 200000);
  assert.ok(stats.structures > 1000);
  assert.ok(stats.strongholds >= 128);
});
