'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const gamelang = require('../gamelang');
const { GameLogReader } = require('../gamelog');

function withDir(fn) {
  return async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'venus-gamelang-test-'));
    try {
      await fn(root);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

// Assets como los que baja el launcher: indexes/<id>.json + objects/<2>/<hash>
function fakeAssets(root, files) {
  const assets = path.join(root, 'assets');
  const objects = {};
  let n = 0;
  for (const [key, text] of Object.entries(files)) {
    const hash = String(++n).padStart(40, 'a');
    fs.mkdirSync(path.join(assets, 'objects', hash.slice(0, 2)), { recursive: true });
    fs.writeFileSync(path.join(assets, 'objects', hash.slice(0, 2), hash), text);
    objects[key] = { hash, size: text.length };
  }
  fs.mkdirSync(path.join(assets, 'indexes'), { recursive: true });
  fs.writeFileSync(path.join(assets, 'indexes', '32.json'), JSON.stringify({ objects }));
  return assets;
}

function fakeJar(root, entries) {
  const zip = new AdmZip();
  for (const [name, text] of Object.entries(entries)) zip.addFile(name, Buffer.from(text, 'utf8'));
  const file = path.join(root, 'client.jar');
  zip.writeZip(file);
  return file;
}

const EN_JSON = JSON.stringify({ 'death.attack.generic': '%1$s died', 'death.screen.title': 'You Died!', 'chat.type.advancement.task': '%s has made the advancement %s', 'block.minecraft.stone': 'Stone' });
const ES_JSON = JSON.stringify({ 'death.attack.generic': '%1$s murió', 'chat.type.advancement.task': '%s acaba de conseguir el progreso %s', 'advancements.end.kill_dragon.title': 'La libertad del End', 'block.minecraft.stone': 'Piedra' });

test(
  'idioma del juego en options.txt',
  withDir(async (root) => {
    assert.equal(await gamelang.readLanguage(root), 'en_us', 'sin el archivo, ingles');
    assert.equal(await gamelang.readLanguage(null), 'en_us');
    fs.writeFileSync(path.join(root, 'options.txt'), 'version:3900\nautoJump:false\nlang:es_ar\nfov:0.0\n');
    assert.equal(await gamelang.readLanguage(root), 'es_ar');
    fs.writeFileSync(path.join(root, 'options.txt'), 'version:3900\r\nlang:es_AR\r\n');
    assert.equal(await gamelang.readLanguage(root), 'es_AR', 'hasta 1.10 va con mayusculas');
    fs.writeFileSync(path.join(root, 'options.txt'), 'version:3900\n');
    assert.equal(await gamelang.readLanguage(root), 'en_us');
  }),
);

test('archivos de idioma: JSON (1.13+) y lineas clave=texto (hasta 1.12)', () => {
  assert.deepEqual(gamelang.parseLang('{"a":"b"}'), { a: 'b' });
  assert.deepEqual(gamelang.parseLang('﻿{"a":"b"}'), { a: 'b' });
  assert.deepEqual(gamelang.parseLang('{roto'), {});
  assert.deepEqual(gamelang.parseLang('# comentario\nchat.type.achievement=%s has just earned the achievement %s\r\ndeath.attack.mob=%1$s = %2$s\nsin igual\n'), { 'chat.type.achievement': '%s has just earned the achievement %s', 'death.attack.mob': '%1$s = %2$s' });
  assert.deepEqual(gamelang.pickKeys({ 'death.attack.mob': 'x', 'block.minecraft.stone': 'y', 'death.fell.killer': 3 }), { 'death.attack.mob': 'x' });
});

test(
  'tabla de un idioma desde los assets, con cualquier mayuscula en la clave',
  withDir(async (root) => {
    const assets = fakeAssets(root, { 'minecraft/lang/es_ar.json': ES_JSON, 'minecraft/lang/de_DE.lang': 'death.attack.generic=%1$s starb\nblock.stone=Stein\n', 'minecraft/sounds.json': '{}' });
    const es = await gamelang.assetTable({ assetsDir: assets, indexId: '32', lang: 'es_ar' });
    assert.equal(es['death.attack.generic'], '%1$s murió');
    assert.equal(es['advancements.end.kill_dragon.title'], 'La libertad del End');
    assert.equal(es['block.minecraft.stone'], undefined, 'solo las claves que se usan');
    const de = await gamelang.assetTable({ assetsDir: assets, indexId: '32', lang: 'de_de' });
    assert.deepEqual(de, { 'death.attack.generic': '%1$s starb' });
    assert.equal(await gamelang.assetTable({ assetsDir: assets, indexId: '32', lang: 'fr_fr' }), null, 'idioma que no esta');
    assert.equal(await gamelang.assetTable({ assetsDir: assets, indexId: 'nada', lang: 'es_ar' }), null, 'indice que no esta');
    assert.equal(await gamelang.assetTable({ assetsDir: assets, indexId: null, lang: 'es_ar' }), null);
  }),
);

test(
  'ingles desde el .jar del cliente, guardado en cache para no volver a abrirlo',
  withDir(async (root) => {
    const jar = fakeJar(root, { 'assets/minecraft/lang/en_us.json': EN_JSON, 'version.json': '{}' });
    const cacheFile = path.join(root, 'cache', 'capture-lang', '1.21.json');
    const table = await gamelang.clientTable({ jarPath: jar, cacheFile });
    assert.equal(table['death.attack.generic'], '%1$s died');
    assert.equal(table['block.minecraft.stone'], undefined);
    assert.ok(fs.existsSync(cacheFile));
    // Con la cache ya no hace falta el .jar
    fs.rmSync(jar);
    assert.deepEqual(await gamelang.clientTable({ jarPath: jar, cacheFile }), table);
    assert.equal(await gamelang.clientTable({ jarPath: jar, cacheFile: null }), null, 'sin .jar ni cache');
    assert.equal(await gamelang.clientTable({ jarPath: null }), null);
  }),
);

test(
  'versiones viejas: el .lang dentro del .jar',
  withDir(async (root) => {
    const jar = fakeJar(root, { 'assets/minecraft/lang/en_US.lang': 'chat.type.achievement=%s has just earned the achievement %s\nachievement.theEnd2=The End.\n' });
    const table = await gamelang.clientTable({ jarPath: jar });
    assert.deepEqual(table, { 'chat.type.achievement': '%s has just earned the achievement %s', 'achievement.theEnd2': 'The End.' });
  }),
);

test(
  'las tablas de una partida reconocen el ingles y el idioma elegido, de punta a punta',
  withDir(async (root) => {
    const assets = fakeAssets(root, { 'minecraft/lang/es_ar.json': ES_JSON });
    const jarPath = fakeJar(root, { 'assets/minecraft/lang/en_us.json': EN_JSON });
    const tables = await gamelang.loadTables({ assetsDir: assets, indexId: '32', lang: 'es_ar', jarPath });
    assert.equal(tables.length, 2);
    const r = new GameLogReader({ player: 'Steve', tables });
    assert.deepEqual(r.read('[1] [Render thread/INFO]: [System] [CHAT] Steve murió'), { reason: 'death' });
    assert.deepEqual(r.read('[1] [Render thread/INFO]: [System] [CHAT] Steve died'), { reason: 'death' }, 'lo que un servidor manda escrito en ingles');
    assert.deepEqual(r.read('[1] [Render thread/INFO]: [System] [CHAT] Steve acaba de conseguir el progreso [La libertad del End]'), { reason: 'boss', boss: 'ender_dragon', title: 'La libertad del End' });
    assert.equal((await gamelang.loadTables({ assetsDir: assets, indexId: '32', lang: 'en_us', jarPath })).length, 1, 'en ingles alcanza con el .jar');
    assert.deepEqual(await gamelang.loadTables({ assetsDir: null, indexId: null, lang: 'es_ar', jarPath: null }), [], 'sin nada para leer, sin tablas');
  }),
);
