// Lo que no sale de cubiomes: versiones ofrecidas, pedazos del mapa y textos.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSIONS, versionForGame, versionByKey } from '../gen/versions.js';
import { SeedWorld, loadTree, TILE, SURFACE_Y } from '../gen/world.js';
import { typesFor, OVERWORLD_TYPES, STRUCTURES } from '../gen/structures.js';
import { BIOME_KEYS, BIOME_RGBA } from '../gen/biomes.js';
import { createService } from '../service.js';
import es from '../../../../i18n/es/seeds.js';
import en from '../../../../i18n/en/seeds.js';

test('cada version del juego cae en la fila correcta', () => {
  const key = (v) => versionForGame(v)?.key ?? null;
  assert.equal(key('1.17.1'), null);
  assert.equal(key('1.8.9'), null);
  assert.equal(key('1.18'), '1.18');
  assert.equal(key('1.18.2'), '1.18');
  assert.equal(key('1.19'), '1.19.2');
  assert.equal(key('1.19.2'), '1.19.2');
  assert.equal(key('1.19.3'), '1.19.4');
  assert.equal(key('1.20.1'), '1.20');
  assert.equal(key('1.20.6'), '1.20');
  assert.equal(key('1.21'), '1.21.1');
  assert.equal(key('1.21.1'), '1.21.1');
  assert.equal(key('1.21.2'), '1.21.3');
  assert.equal(key('1.21.4'), '1.21.4');
  assert.equal(key('1.21.11'), '1.21.4');
  assert.equal(key(undefined), null);
  assert.equal(key('snapshot'), null);
});

test('cada estructura existe solo desde su version', () => {
  const has = (type, v) => typesFor(0, versionByKey(v).mc).includes(type);
  assert.equal(has('ancient_city', '1.18'), false);
  assert.equal(has('ancient_city', '1.19.2'), true);
  assert.equal(has('trail_ruins', '1.19.4'), false);
  assert.equal(has('trail_ruins', '1.20'), true);
  assert.equal(has('trial_chambers', '1.20'), false);
  assert.equal(has('trial_chambers', '1.21.1'), true);
  assert.deepEqual(typesFor(-1, versionByKey('1.21.4').mc), ['fortress', 'bastion']);
  assert.deepEqual(typesFor(1, versionByKey('1.21.4').mc), []);
  for (const type of OVERWORLD_TYPES) assert.ok(STRUCTURES[type], type);
});

test('un pedazo de mapa son las mismas celdas que preguntar una por una', async () => {
  const tree = await loadTree(VERSIONS[0].table);
  const w = new SeedWorld({ seed: 987654321n, version: VERSIONS[0].key, dim: 0, tree });
  for (const [level, tx, tz] of [[0, 0, 0], [0, -3, 2], [2, 1, -1], [5, -1, -1]]) {
    const out = new Uint8Array(TILE * TILE);
    w.fillTile(out, level, tx, tz, SURFACE_Y);
    const step = 1 << level;
    const mid = step >> 1;
    for (const [i, j] of [[0, 0], [127, 0], [0, 127], [64, 33], [127, 127]]) {
      assert.equal(out[j * TILE + i], w.biomeAt((tx * TILE + i) * step + mid, SURFACE_Y, (tz * TILE + j) * step + mid));
    }
  }
});

test('el End en 1:4 y 1:16 usa el bioma del chunk', () => {
  const w = new SeedWorld({ seed: 4242n, version: VERSIONS[0].key, dim: 1, tree: null });
  const fine = new Uint8Array(TILE * TILE);
  w.fillTile(fine, 0, 2, 3, 0);
  // Una celda 1:4 y su chunk
  for (const [i, j] of [[0, 0], [10, 77], [127, 127]]) {
    const x4 = 2 * TILE + i;
    const z4 = 3 * TILE + j;
    assert.equal(fine[j * TILE + i], w.biomeAt(x4, 0, z4));
  }
});

test('todo bioma que puede salir tiene color y nombre', async () => {
  for (const id of BIOME_KEYS.keys()) assert.ok(BIOME_RGBA[id] >>> 24 === 0xff && (BIOME_RGBA[id] !== 0xff000000 || id === 127));
  const missing = [];
  for (const key of BIOME_KEYS.values()) {
    if (!es[`b_${key}`] || !en[`b_${key}`]) missing.push(key);
  }
  assert.deepEqual(missing, []);
});

test('es y en tienen las mismas claves y variables', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(es).sort());
  const vars = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join();
  for (const key of Object.keys(es)) assert.equal(vars(en[key]), vars(es[key]), key);
});

test('el codigo no llama a las claves que no existen', () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const files = [path.join(dir, '..', '..', 'seeds.js'), path.join(dir, '..', 'map.js')];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/\bT\('([A-Za-z0-9_]+)'/g)) assert.ok(es[m[1]] !== undefined, `${path.basename(file)}: ${m[1]}`);
  }
  for (const type of [...OVERWORLD_TYPES, 'stronghold', 'fortress', 'bastion']) assert.ok(es[`s_${type}`], type);
});

test('el servicio contesta y descarta lo de un mundo anterior', async () => {
  const replies = [];
  const svc = createService((m) => replies.push(m));
  await svc.handle({ t: 'init', gen: 1, seed: '1', version: '1.21.4', dim: 0 });
  await svc.handle({ t: 'tile', gen: 1, job: 10, key: 'k', level: 3, tx: 0, tz: 0, y: SURFACE_Y });
  assert.equal(replies.at(-1).t, 'tile');
  assert.equal(replies.at(-1).ids.length, TILE * TILE);
  await svc.handle({ t: 'structs', gen: 1, job: 11, type: 'village', regions: [0, 0, -1, -1] });
  assert.equal(replies.at(-1).results.length, 2);
  await svc.handle({ t: 'strong', gen: 1, job: 12, count: 3 });
  assert.equal(replies.at(-1).list.length, 3);
  await svc.handle({ t: 'spawn', gen: 1, job: 13 });
  assert.ok(Number.isInteger(replies.at(-1).pos.x));
  await svc.handle({ t: 'init', gen: 2, seed: '2', version: '1.21.4', dim: -1 });
  await svc.handle({ t: 'tile', gen: 1, job: 14, key: 'viejo', level: 3, tx: 0, tz: 0, y: 0 });
  assert.equal(replies.at(-1).t, 'skip');
  await svc.handle({ t: 'structs', gen: 2, job: 15, type: 'fortress', regions: [0, 0] });
  assert.equal(replies.at(-1).t, 'structs');
});
