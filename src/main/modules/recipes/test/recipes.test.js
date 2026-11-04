'use strict';
// Lector de recetas: los formatos de cada epoca del juego, con .jar de prueba armados aca (nada de Mojang). Las recetas
// y los textos son de mentira a proposito: solo importa la forma de los archivos.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const AdmZip = require('adm-zip');
const { parseRecipe, parseIngredient, parseTag, expandTag, itemId, prettify } = require('../parse');
const { readJar } = require('../jar');
const { createBook, cardIconIds, wikiUrl, fold } = require('../book');
const recipes = require('../../recipes');

// PNG real de 1x1 (el lector revisa la firma)
function png(r = 200, g = 100, b = 50) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const t = Buffer.from(type);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.from([0, r, g, b]))), chunk('IEND', Buffer.alloc(0))]);
}

function makeJar(dir, name, files) {
  const zip = new AdmZip();
  for (const [p, content] of Object.entries(files)) zip.addFile(p, Buffer.isBuffer(content) ? content : Buffer.from(typeof content === 'string' ? content : JSON.stringify(content)));
  const file = path.join(dir, name);
  zip.writeZip(file);
  return file;
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'venus-recipes-test-'));

test('ids e ingredientes en todas sus formas', () => {
  assert.equal(itemId('stick'), 'minecraft:stick');
  assert.equal(itemId('Mod:Algo/Raro'), 'mod:algo/raro');
  for (const bad of ['', null, 12, 'a b', '../x', 'a:b:c', 'con"comillas']) assert.equal(itemId(bad), null, String(bad));
  assert.deepEqual(parseIngredient({ item: 'minecraft:stick' }), { items: ['minecraft:stick'], tags: [] });
  assert.deepEqual(parseIngredient({ tag: 'minecraft:planks' }), { items: [], tags: ['minecraft:planks'] });
  assert.deepEqual(parseIngredient('minecraft:stick'), { items: ['minecraft:stick'], tags: [] });
  assert.deepEqual(parseIngredient('#minecraft:planks'), { items: [], tags: ['minecraft:planks'] });
  assert.deepEqual(parseIngredient(['minecraft:a', '#minecraft:b', { item: 'minecraft:c' }]), { items: ['minecraft:a', 'minecraft:c'], tags: ['minecraft:b'] });
  assert.equal(parseIngredient({ nada: 1 }), null);
  assert.equal(parseIngredient(null), null);
  assert.equal(parseIngredient([]), null);
  assert.equal(parseIngredient({ item: '<img src=x>' }), null);
});

test('receta con forma: los formatos de 1.12, 1.20 y 1.21.2', () => {
  const pattern = ['A ', 'AB'];
  const old = parseRecipe({ type: 'crafting_shaped', pattern, key: { A: { item: 'minecraft:planks', data: 32767 }, B: { tag: 'minecraft:logs' } }, result: { item: 'minecraft:thing', count: 4 } }, 'minecraft:thing');
  const v120 = parseRecipe({ type: 'minecraft:crafting_shaped', pattern, key: { A: { item: 'minecraft:planks' }, B: { tag: 'minecraft:logs' } }, result: { item: 'minecraft:thing', count: 4 } }, 'minecraft:thing');
  const v121 = parseRecipe({ type: 'minecraft:crafting_shaped', pattern, key: { A: 'minecraft:planks', B: '#minecraft:logs' }, result: { id: 'minecraft:thing', count: 4 } }, 'minecraft:thing');
  for (const r of [old, v120, v121]) {
    assert.equal(r.kind, 'shaped');
    assert.equal(r.width, 2);
    assert.equal(r.height, 2);
    assert.deepEqual(r.result, { id: 'minecraft:thing', count: 4 });
    assert.equal(r.slots[1], null, 'el espacio del patron queda vacio');
    assert.deepEqual(r.slots[0].items, ['minecraft:planks']);
    assert.deepEqual(r.slots[3].tags, ['minecraft:logs']);
  }
  assert.equal(parseRecipe({ type: 'crafting_shaped', pattern: [], key: {}, result: 'minecraft:a' }, 'x'), null);
  assert.equal(parseRecipe({ type: 'crafting_shaped', pattern: ['A'], key: {}, result: 'minecraft:a' }, 'x'), null, 'sin ingredientes');
});

test('sin forma, horno y parecidos, cortapiedras y herreria', () => {
  const shapeless = parseRecipe({ type: 'minecraft:crafting_shapeless', ingredients: [{ item: 'minecraft:a' }, '#minecraft:b'], result: { id: 'minecraft:c' } }, 'minecraft:c');
  assert.equal(shapeless.kind, 'shapeless');
  assert.equal(shapeless.slots.length, 2);
  assert.equal(shapeless.result.count, 1);

  // horno viejo con resultado de texto, horno nuevo con objeto
  const oldFurnace = parseRecipe({ type: 'minecraft:smelting', ingredient: { item: 'minecraft:a' }, result: 'minecraft:b', experience: 0.7, cookingtime: 200 }, 'minecraft:b');
  const newFurnace = parseRecipe({ type: 'minecraft:blasting', ingredient: 'minecraft:a', result: { id: 'minecraft:b' }, experience: 0.1, cookingtime: 100 }, 'minecraft:b2');
  assert.deepEqual([oldFurnace.kind, oldFurnace.station, oldFurnace.time, oldFurnace.xp, oldFurnace.result.id], ['cooking', 'smelting', 200, 0.7, 'minecraft:b']);
  assert.deepEqual([newFurnace.station, newFurnace.result.id], ['blasting', 'minecraft:b']);
  assert.equal(parseRecipe({ type: 'minecraft:smoking', ingredient: 'minecraft:a', result: 'minecraft:b' }, 'x').station, 'smoking');
  assert.equal(parseRecipe({ type: 'minecraft:campfire_cooking', ingredient: 'minecraft:a', result: 'minecraft:b' }, 'x').station, 'campfire');

  // cortapiedras: la cantidad afuera (viejo) o adentro (nuevo)
  assert.equal(parseRecipe({ type: 'minecraft:stonecutting', ingredient: { item: 'minecraft:a' }, result: 'minecraft:b', count: 2 }, 'x').result.count, 2);
  assert.equal(parseRecipe({ type: 'minecraft:stonecutting', ingredient: 'minecraft:a', result: { id: 'minecraft:b', count: 3 } }, 'x').result.count, 3);

  const smith = parseRecipe({ type: 'minecraft:smithing_transform', template: 'minecraft:t', base: 'minecraft:a', addition: '#minecraft:c', result: { id: 'minecraft:d' } }, 'x');
  assert.equal(smith.kind, 'smithing');
  assert.equal(smith.slots.length, 3);
  assert.equal(parseRecipe({ type: 'minecraft:smithing', base: { item: 'minecraft:a' }, addition: { item: 'minecraft:b' }, result: { item: 'minecraft:d' } }, 'x').slots.length, 2);
  assert.equal(parseRecipe({ type: 'minecraft:crafting_transmute', input: '#minecraft:a', material: 'minecraft:b', result: { id: 'minecraft:c' } }, 'x').kind, 'shapeless');
  // 26.1: teñir e impregnar
  const dyed = parseRecipe({ type: 'minecraft:crafting_dye', category: 'misc', dye: '#minecraft:dyes', group: 'dyed_armor', result: { id: 'minecraft:leather_boots' }, target: 'minecraft:leather_boots' }, 'x');
  assert.deepEqual([dyed.kind, dyed.slots[0].items, dyed.slots[1].tags, dyed.result.id], ['shapeless', ['minecraft:leather_boots'], ['minecraft:dyes'], 'minecraft:leather_boots']);
  const imbued = parseRecipe({ type: 'minecraft:crafting_imbue', category: 'misc', material: 'minecraft:arrow', result: { count: 8, id: 'minecraft:tipped_arrow' }, source: 'minecraft:lingering_potion' }, 'x');
  assert.deepEqual([imbued.slots[0].items, imbued.slots[1].items, imbued.result.count], [['minecraft:lingering_potion'], ['minecraft:arrow'], 8]);
});

test('lo que no se puede mostrar se saltea; los tipos de mods con los campos de siempre, se muestran', () => {
  for (const type of ['minecraft:crafting_special_bookcloning', 'crafting_decorated_pot', 'minecraft:smithing_trim']) assert.equal(parseRecipe({ type }, 'x'), null, type);
  for (const raw of [null, [], 'x', {}, { type: 3 }, { type: 'desconocido' }]) assert.equal(parseRecipe(raw, 'x'), null);
  const mod = parseRecipe({ type: 'create:mixing', ingredients: [{ item: 'minecraft:a' }], results: [{ item: 'create:b', count: 2 }] }, 'create:b');
  assert.deepEqual([mod.kind, mod.station, mod.result.id, mod.result.count], ['other', 'create:mixing', 'create:b', 2]);
});

test('tags: anidados, con objetos y sin colgarse con un ciclo', () => {
  const tags = { 'minecraft:a': parseTag({ values: ['minecraft:x', '#minecraft:b', { id: 'minecraft:y', required: false }, 12, { nada: 1 }] }), 'minecraft:b': parseTag({ values: ['minecraft:z', '#minecraft:a'] }) };
  assert.deepEqual([...expandTag(tags, 'minecraft:a')].sort(), ['minecraft:x', 'minecraft:y', 'minecraft:z']);
  assert.deepEqual(parseTag(null), []);
  assert.deepEqual([...expandTag(tags, 'minecraft:nada')], []);
});

test('.jar del formato nuevo (data/minecraft/recipe, 1.21): recetas, tags, nombres e iconos', async () => {
  const dir = tmp();
  try {
    const jar = makeJar(dir, 'nuevo.jar', {
      'data/minecraft/recipe/palo.json': { type: 'minecraft:crafting_shaped', pattern: ['A', 'A'], key: { A: '#minecraft:maderas' }, result: { id: 'minecraft:palo', count: 4 } },
      'data/minecraft/recipe/lingote.json': { type: 'minecraft:smelting', ingredient: 'minecraft:mena', result: { id: 'minecraft:lingote' }, cookingtime: 200, experience: 0.7 },
      'data/minecraft/recipe/especial.json': { type: 'minecraft:crafting_special_algo' },
      'data/minecraft/recipe/roto.json': '{ esto no es json',
      'data/minecraft/advancement/recipes/palo.json': { type: 'minecraft:crafting_shapeless', ingredients: ['minecraft:no_cuenta'], result: { id: 'minecraft:no_cuenta' } },
      'data/minecraft/tags/item/maderas.json': { values: ['minecraft:roble', '#minecraft:otras'] },
      'data/minecraft/tags/item/otras.json': { values: ['minecraft:abeto'] },
      'assets/minecraft/lang/en_us.json': { 'item.minecraft.palo': 'Stick Fake', 'block.minecraft.roble': 'Oak Fake', 'item.minecraft.solo_nombre': 'Name Only', 'chat.type.text': 'no hace falta' },
      'assets/minecraft/items/palo.json': { model: { type: 'minecraft:model', model: 'minecraft:item/palo' } },
      'assets/minecraft/models/item/palo.json': { parent: 'minecraft:item/generated', textures: { layer0: 'minecraft:item/palo' } },
      'assets/minecraft/models/item/roble.json': { parent: 'minecraft:block/roble' },
      'assets/minecraft/models/block/roble.json': { parent: 'minecraft:block/cube_all', textures: { all: 'minecraft:block/roble' } },
      'assets/minecraft/models/block/cube_all.json': { parent: 'block/cube', textures: { particle: '#all' } },
      'assets/minecraft/models/item/solo_nombre.json': { parent: 'minecraft:item/generated', textures: { layer0: 'minecraft:item/solo_nombre' } },
      'assets/minecraft/models/item/bow_pulling_0.json': { parent: 'item/generated', textures: { layer0: 'item/palo' } },
      'assets/minecraft/textures/item/palo.png': png(),
      'assets/minecraft/textures/block/roble.png': png(10, 20, 30),
      'assets/minecraft/textures/item/solo_nombre.png': Buffer.from('no es un png'),
      'assets/minecraft/textures/block/lingote.png': png(1, 2, 3),
    });
    const data = await readJar(jar);
    assert.deepEqual(data.recipes.map((r) => r.id).sort(), ['minecraft:lingote', 'minecraft:palo'], 'sin las especiales, las rotas ni las de advancement/');
    assert.deepEqual(data.tags['minecraft:maderas'], ['minecraft:roble', '#minecraft:otras']);
    assert.ok(data.items.includes('minecraft:solo_nombre'), 'un item con modelo y nombre aunque no tenga receta');
    assert.ok(!data.items.includes('minecraft:bow_pulling_0'), 'un modelo suelto sin nombre no es un item');
    assert.equal(data.en['chat.type.text'], undefined, 'solo nombres de items y bloques');
    assert.ok(data.icons['minecraft:palo'], 'icono por el modelo del item');
    assert.ok(data.icons['minecraft:roble'], 'icono de un bloque por su modelo y sus padres');
    assert.ok(data.icons['minecraft:lingote'], 'sin modelo: la carpeta de texturas');
    assert.equal(data.icons['minecraft:solo_nombre'], undefined, 'lo que no es un PNG no se usa');

    const book = createBook([data]);
    assert.equal(book.recipeCount, 2);
    const hit = book.search('stick');
    assert.equal(hit.items[0].id, 'minecraft:palo');
    assert.equal(hit.items[0].name, 'Stick Fake');
    const card = book.card('minecraft:palo');
    assert.equal(card.recipes.length, 1);
    assert.deepEqual(card.recipes[0].slots[0].items.map((i) => i.id), ['minecraft:roble', 'minecraft:abeto']);
    assert.equal(card.recipes[0].slots[0].tag, 'minecraft:maderas');
    assert.equal(card.recipes[0].result.count, 4);
    assert.deepEqual(book.card('minecraft:abeto').uses.map((r) => r.id), ['minecraft:palo'], 'se usa en: tambien por los tags');
    assert.ok(cardIconIds(card).includes('minecraft:abeto'));
    assert.equal(book.card('minecraft:no_existe'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('.jar de los formatos viejos: data/minecraft/recipes (1.13) y assets/minecraft/recipes con .lang (1.12)', async () => {
  const dir = tmp();
  try {
    const v113 = makeJar(dir, 'v113.jar', {
      'data/minecraft/recipes/palo.json': { type: 'minecraft:crafting_shapeless', ingredients: [{ item: 'minecraft:a' }], result: { item: 'minecraft:palo', count: 2 } },
      'data/minecraft/tags/items/maderas.json': { values: ['minecraft:a'] },
      'assets/minecraft/lang/en_us.json': { 'item.minecraft.palo': 'Stick Fake' },
    });
    const a = await readJar(v113);
    assert.equal(a.recipes[0].result.count, 2);
    assert.deepEqual(a.tags['minecraft:maderas'], ['minecraft:a']);

    const v112 = makeJar(dir, 'v112.jar', {
      'assets/minecraft/recipes/palo.json': { type: 'crafting_shaped', pattern: ['#'], key: { '#': { item: 'minecraft:planks', data: 32767 } }, result: { item: 'minecraft:palo', data: 0, count: 4 } },
      'assets/minecraft/recipes/_constants.json': [{ name: 'X', ingredient: { item: 'minecraft:a' } }],
      'assets/minecraft/lang/en_us.lang': 'item.stick.name=Stick\n',
      'assets/minecraft/models/item/palo.json': { parent: 'item/generated', textures: { layer0: 'items/palo' } },
      'assets/minecraft/textures/items/palo.png': png(),
    });
    const b = await readJar(v112);
    assert.deepEqual(b.recipes.map((r) => r.id), ['minecraft:palo']);
    assert.ok(b.icons['minecraft:palo'], 'textures/items de las versiones viejas');
    const book = createBook([b]);
    assert.equal(book.search('palo').items[0].name, 'Palo', 'sin nombre en el idioma: el id prolijo');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('busqueda: sin acentos, en los dos idiomas, lo mas parecido primero', () => {
  const book = createBook([
    {
      recipes: [],
      tags: {},
      items: ['minecraft:piston', 'minecraft:sticky_piston', 'minecraft:stone'],
      en: { 'block.minecraft.piston': 'Piston', 'block.minecraft.sticky_piston': 'Sticky Piston', 'block.minecraft.stone': 'Stone' },
      own: {},
    },
  ], { langTable: { 'block.minecraft.piston': 'Pistón', 'block.minecraft.sticky_piston': 'Pistón pegajoso', 'block.minecraft.stone': 'Piedra' } });
  assert.deepEqual(book.search('piston').items.map((i) => i.id), ['minecraft:piston', 'minecraft:sticky_piston']);
  assert.equal(book.search('PISTÓN').items[0].name, 'Pistón');
  assert.equal(book.search('stone').items[0].name, 'Piedra', 'tambien por el nombre en ingles');
  assert.equal(book.search('minecraft:stone').total, 1, 'y por el id');
  assert.equal(book.search('sticky pis').total, 1);
  assert.equal(book.search('nada que ver').total, 0);
  assert.equal(fold('  ÁRBOL '), 'arbol');
  assert.equal(prettify('mod:algo/oak_planks'), 'Oak Planks');
});

test('un mod suma recetas e items y puede reemplazar una receta del juego', () => {
  const vanilla = { recipes: [parseRecipe({ type: 'crafting_shapeless', ingredients: ['minecraft:a'], result: 'minecraft:b' }, 'minecraft:b')], tags: { 'minecraft:t': ['minecraft:a'] }, en: {}, own: {}, items: ['minecraft:a', 'minecraft:b'] };
  const mod = { recipes: [parseRecipe({ type: 'crafting_shapeless', ingredients: ['mod:x'], result: 'minecraft:b' }, 'minecraft:b'), parseRecipe({ type: 'crafting_shapeless', ingredients: ['#minecraft:t'], result: 'mod:y' }, 'mod:y')], tags: { 'minecraft:t': ['mod:x'] }, en: { 'item.mod.y': 'Mod Item' }, own: {}, items: ['mod:y'] };
  const book = createBook([vanilla, mod]);
  assert.equal(book.recipeCount, 2);
  assert.deepEqual(book.card('minecraft:b').recipes[0].slots[0].items.map((i) => i.id), ['mod:x'], 'gana el del mod');
  assert.deepEqual(book.card('mod:y').recipes[0].slots[0].items.map((i) => i.id), ['minecraft:a', 'mod:x'], 'los tags se suman');
  assert.equal(book.search('mod item').items[0].id, 'mod:y');
});

test('wiki: solo para lo del juego y con el nombre escapado', () => {
  assert.equal(wikiUrl('minecraft:oak_planks', 'Oak Planks'), 'https://minecraft.wiki/w/Special:Search?search=Oak%20Planks&go=Go');
  assert.equal(new URL(wikiUrl('minecraft:x', 'a&b=c#d?')).searchParams.get('search'), 'a&b=c#d?');
  assert.equal(wikiUrl('mod:x', 'Algo'), null);
  assert.equal(wikiUrl('minecraft:x', ''), null);
  assert.equal(wikiUrl(null, 'Algo'), null);
});

test('sesion: lee el .jar una vez, usa la cache, los mods y los nombres de los assets', async () => {
  const dir = tmp();
  try {
    const versions = path.join(dir, 'v');
    fs.mkdirSync(versions);
    const jar = makeJar(versions, 'test.jar', {
      'data/minecraft/recipe/palo.json': { type: 'minecraft:crafting_shapeless', ingredients: ['minecraft:a'], result: { id: 'minecraft:palo' } },
      'assets/minecraft/lang/en_us.json': { 'item.minecraft.palo': 'Stick Fake' },
      'assets/minecraft/textures/item/palo.png': png(),
    });
    const instance = path.join(dir, 'inst');
    fs.mkdirSync(path.join(instance, 'mods'), { recursive: true });
    makeJar(path.join(instance, 'mods'), 'mod.jar', {
      'data/mimod/recipe/cosa.json': { type: 'minecraft:crafting_shapeless', ingredients: ['minecraft:palo'], result: { id: 'mimod:cosa' } },
      'assets/mimod/lang/en_us.json': { 'item.mimod.cosa': 'Mod Thing' },
      'assets/mimod/lang/es_ar.json': { 'item.mimod.cosa': 'Cosa del mod' },
      'assets/mimod/textures/item/cosa.png': png(9, 9, 9),
    });
    fs.writeFileSync(path.join(instance, 'mods', 'roto.jar'), 'no soy un zip');
    fs.writeFileSync(path.join(instance, 'mods', 'apagado.jar.disabled'), 'nada');
    // Assets: el indice dice que objeto es minecraft/lang/es_ar.json
    const assets = path.join(dir, 'assets');
    const hash = 'ab'.padEnd(40, 'c');
    fs.mkdirSync(path.join(assets, 'indexes'), { recursive: true });
    fs.mkdirSync(path.join(assets, 'objects', 'ab'), { recursive: true });
    fs.writeFileSync(path.join(assets, 'indexes', '99.json'), JSON.stringify({ objects: { 'minecraft/lang/es_ar.json': { hash } } }));
    fs.writeFileSync(path.join(assets, 'objects', 'ab', hash), JSON.stringify({ 'item.minecraft.palo': 'Palo de prueba' }));
    const cacheDir = path.join(dir, 'cache');
    const opts = { rootId: '1.21.1', jarPath: jar, instanceDir: instance, lang: 'es_ar', assetIndex: '99', mods: true, assetsDir: assets, cacheDir };

    const s = await recipes.open(opts);
    assert.equal(s.info.version, '1.21.1');
    assert.equal(s.info.mods, 1, 'un mod bueno');
    assert.equal(s.info.modsFailed, 1, 'el .jar roto se cuenta y no corta nada');
    assert.equal(s.info.translated, true);
    const found = await s.search('palo');
    assert.equal(found.items[0].name, 'Palo de prueba');
    assert.match(found.icons['minecraft:palo'], /^data:image\/png;base64,/);
    const card = await s.card('mimod:cosa');
    assert.equal(card.name, 'Cosa del mod', 'el mod trae su propia traduccion');
    assert.equal(card.wiki, false, 'lo de un mod no esta en minecraft.wiki');
    assert.ok(card.icons['mimod:cosa']);
    assert.ok(card.icons['minecraft:palo'], 'el icono de otro .jar tambien');
    assert.equal(s.wiki('minecraft:palo'), 'https://minecraft.wiki/w/Special:Search?search=Stick%20Fake&go=Go');
    assert.equal(s.wiki('mimod:cosa'), null);
    assert.equal(s.wiki('no:existe'), null);
    assert.ok(fs.readdirSync(cacheDir).some((f) => f.startsWith('1.21.1-') && f.endsWith('.json')), 'cache con la version en el nombre');

    // Segunda vez: sin el .jar del mod en memoria y con la cache de disco alcanza (el .jar podria ser cualquier cosa)
    recipes.forget();
    const again = await recipes.open(opts);
    assert.equal((await again.search('palo')).items[0].name, 'Palo de prueba');
    assert.ok((await again.search('palo')).icons['minecraft:palo']);
    assert.equal(await recipes.open(opts), again, 'misma sesion mientras no cambie nada');

    await assert.rejects(recipes.open({ rootId: 'x', jarPath: path.join(dir, 'no-esta.jar') }), (e) => e.code === 'noJar');
    await assert.rejects(recipes.open({ rootId: '../malo', jarPath: jar }), (e) => e.code === 'noVersion');
    await assert.rejects(recipes.open({ jarPath: jar }), (e) => e.code === 'noVersion');
  } finally {
    recipes.forget();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
