'use strict';
// Marcadores del mapa: validacion, archivo del mundo y codigos para compartir (que vienen de otra persona).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const markers = require('../markers');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'venus-markers-test-'));
const base = { name: 'Base', color: '#54c26a', icon: 'home', dimension: 'minecraft:overworld', x: 10, y: 64, z: -20 };
const b64 = (obj) => `${markers.CODE_PREFIX}${Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj), 'utf8').toString('base64url')}`;

test('validacion: nombre, color, icono, dimension y coordenadas', () => {
  const m = markers.normalizeMarker(base);
  assert.equal(m.name, 'Base');
  assert.match(m.id, /^m[a-f0-9]{12}$/);
  assert.ok(m.createdAt > 0);
  assert.deepEqual([m.color, m.icon, m.dimension, m.x, m.y, m.z], ['#54c26a', 'home', 'minecraft:overworld', 10, 64, -20]);

  // Lo que se puede corregir, se corrige
  const fixed = markers.normalizeMarker({ ...base, color: 'rojo', icon: 'virus', y: 99999, x: 10.6, name: `  a\tb\n${'x'.repeat(100)} ` });
  assert.equal(fixed.color, markers.COLORS[0]);
  assert.equal(fixed.icon, markers.ICONS[0]);
  assert.equal(fixed.y, null, 'altura fuera de rango: sin altura');
  assert.equal(fixed.x, 11);
  assert.equal([...fixed.name].length, markers.MAX_NAME);
  assert.ok(!/[\t\n]/.test(fixed.name));

  // Lo que no, se rechaza
  for (const bad of [null, [], 'x', { ...base, name: '   ' }, { ...base, name: 12 }, { ...base, x: 'a' }, { ...base, z: null }, { ...base, x: 30000001 }, { ...base, x: true }, { ...base, dimension: 'mal formada' }, { ...base, dimension: '../../etc:x' }, { ...base, dimension: 'a:../b' }, { ...base, dimension: 12 }]) {
    assert.equal(markers.normalizeMarker(bad), null, JSON.stringify(bad));
  }
  // Dimensiones de datapacks y las carpetas de mods viejos
  assert.ok(markers.normalizeMarker({ ...base, dimension: 'mi_mod:mundo/cueva' }));
  assert.ok(markers.normalizeMarker({ ...base, dimension: 'folder:DIM7' }));
  assert.equal(markers.normalizeMarker({ ...base, id: 'id con espacios' }).id.startsWith('m'), true, 'un id raro se reemplaza');
});

test('el nombre es texto: sin marcas de direccion ni separadores raros, y las etiquetas siguen siendo texto', () => {
  const rtl = String.fromCharCode(0x202e);
  const sep = String.fromCharCode(0x2028);
  assert.equal(markers.cleanName(`mi${rtl}base${sep}ok`), 'mi base ok');
  // No se escapa aca: la interfaz lo dibuja con nodos de texto
  assert.equal(markers.cleanName('<img src=x onerror=alert(1)>'), '<img src=x onerror=alert(1)>');
  // Un emoji no se corta por la mitad
  const name = markers.cleanName('😀'.repeat(markers.MAX_NAME + 5));
  assert.equal([...name].length, markers.MAX_NAME);
  assert.equal(name.at(-1) !== String.fromCharCode(0xd83d), true);
});

test('codigo: ida y vuelta, con acentos y emojis', () => {
  const list = [base, { ...base, name: 'Mina de ñandú 😀', dimension: 'minecraft:the_nether', y: null, icon: 'pickaxe', color: '#e5544b' }];
  const r = markers.encodeCode(list);
  assert.ok(r.code.startsWith(markers.CODE_PREFIX));
  assert.equal(r.count, 2);
  assert.equal(r.fitsMessage, true);
  const back = markers.decodeCode(r.code);
  assert.equal(back.dropped, 0);
  assert.deepEqual(back.markers[0], { name: 'Base', color: '#54c26a', icon: 'home', dimension: 'minecraft:overworld', x: 10, y: 64, z: -20 });
  assert.equal(back.markers[1].name, 'Mina de ñandú 😀');
  assert.equal(back.markers[1].y, null);
  // Se puede pegar con texto alrededor (por ejemplo, copiado de Mensajes)
  assert.equal(markers.decodeCode(`Fijate: ${r.code} , ahi esta`).markers.length, 2);
  // Un codigo no lleva los id de quien lo armo
  assert.ok(!Buffer.from(r.code.slice(markers.CODE_PREFIX.length), 'base64url').toString().includes('createdAt'));
});

test('codigo malo: formato, largo y campos', () => {
  const isBad = (fn, code = 'badCode') => assert.throws(fn, (e) => e.code === code);
  isBad(() => markers.decodeCode(''));
  isBad(() => markers.decodeCode(null));
  isBad(() => markers.decodeCode('hola'));
  isBad(() => markers.decodeCode('VENUS-LOOK:abc'));
  isBad(() => markers.decodeCode(`${markers.CODE_PREFIX}%%%`));
  isBad(() => markers.decodeCode(`${markers.CODE_PREFIX}AAAA`));
  isBad(() => markers.decodeCode(b64('no es json')));
  isBad(() => markers.decodeCode(b64({ v: 2, m: [] })));
  isBad(() => markers.decodeCode(b64({ v: 1, m: 'x' })));
  isBad(() => markers.decodeCode(b64({ v: 1, m: [] })));
  isBad(() => markers.decodeCode(b64({ v: 1, m: [['', '#000000', 'pin', 'minecraft:overworld', 1, 2, 3]] })), 'badCode');
  isBad(() => markers.decodeCode(`${markers.CODE_PREFIX}${'A'.repeat(markers.MAX_CODE * 3)}`), 'tooLong');
  isBad(() => markers.decodeCode(`${markers.CODE_PREFIX}${'A'.repeat(markers.MAX_CODE + 1)}`), 'tooLong');

  // Lo que sirve se usa y lo que no se cuenta
  const mixed = markers.decodeCode(b64({ v: 1, m: [['Bueno', '#123456', 'star', 'minecraft:overworld', 1, null, 3], ['', 'x', 'x', 'x', 'x', 'x', 'x'], 'no soy una fila', ['Sin coords', '#123456', 'star', 'minecraft:overworld', null, null, null]] }));
  assert.equal(mixed.markers.length, 1);
  assert.equal(mixed.dropped, 3);

  // Campos de mas o peligrosos: no pasan
  const evil = markers.decodeCode(b64({ v: 1, m: [['<b>x</b>', 'javascript:alert(1)', '../../x', 'minecraft:overworld', 1, 2, 3, 'extra', { a: 1 }]] }));
  assert.deepEqual(evil.markers[0], { name: '<b>x</b>', color: markers.COLORS[0], icon: markers.ICONS[0], dimension: 'minecraft:overworld', x: 1, y: 2, z: 3 });

  isBad(() => markers.encodeCode([]), 'badMarker');
  isBad(() => markers.encodeCode('x'), 'badMarker');
  isBad(() => markers.encodeCode(Array.from({ length: markers.MAX_IN_CODE + 1 }, () => base)), 'tooLong');
});

test('un codigo que no entra en un mensaje se avisa', () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ ...base, name: `Marcador numero ${i}`, x: i * 1000 }));
  const r = markers.encodeCode(many);
  assert.ok(r.length > markers.MESSAGE_MAX);
  assert.equal(r.fitsMessage, false);
  assert.equal(markers.decodeCode(r.code).markers.length, 60);
});

test('archivo del mundo: guardar, cambiar, borrar e importar sin repetir', async () => {
  const dir = tmp();
  try {
    assert.deepEqual(await markers.read(dir), [], 'sin archivo: lista vacia');
    const { marker } = await markers.save(dir, base);
    assert.ok(marker.id);
    assert.ok(fs.existsSync(path.join(dir, markers.FILE)));
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, markers.FILE), 'utf8'));
    assert.equal(onDisk.v, 1);
    assert.equal(onDisk.markers.length, 1);

    const edited = await markers.save(dir, { ...marker, name: 'Base nueva', x: 99, createdAt: 5 });
    assert.equal(edited.markers.length, 1, 'mismo id: se cambia');
    assert.equal(edited.marker.name, 'Base nueva');
    assert.equal(edited.marker.createdAt, marker.createdAt, 'la fecha de creacion no se pisa');

    const code = markers.encodeCode([{ ...base, name: 'Base nueva', x: 99 }, { ...base, name: 'Otra' }]);
    const r = await markers.addAll(dir, markers.decodeCode(code.code).markers);
    assert.deepEqual([r.added, r.skipped], [1, 1], 'el mismo lugar con el mismo nombre no se repite');
    assert.equal((await markers.read(dir)).length, 2);

    await assert.rejects(markers.save(dir, { name: '' }), (e) => e.code === 'badMarker');
    const gone = await markers.remove(dir, marker.id);
    assert.equal(gone.markers.length, 1);
    assert.equal((await markers.remove(dir, 'mnoexiste')).markers.length, 1);

    // Escrituras a la vez: ninguna pisa a la otra
    await Promise.all(Array.from({ length: 12 }, (_, i) => markers.save(dir, { ...base, name: `M${i}`, x: i })));
    assert.equal((await markers.read(dir)).length, 13);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('archivo roto o enorme: no rompe nada y se descarta lo que no sirve', async () => {
  const dir = tmp();
  try {
    const file = path.join(dir, markers.FILE);
    fs.writeFileSync(file, JSON.stringify({ v: 1, markers: [base, { name: '' }, 'x', { ...base, id: 'mabcdefg1', name: 'A' }, { ...base, id: 'mabcdefg1', name: 'Repetido' }] }));
    const list = await markers.read(dir);
    assert.deepEqual(list.map((m) => m.name), ['Base', 'A']);
    fs.writeFileSync(file, JSON.stringify({ markers: 'nada' }));
    assert.deepEqual(await markers.read(dir), []);
    fs.writeFileSync(file, 'x'.repeat(3 * 1024 * 1024));
    assert.deepEqual(await markers.read(dir), [], 'demasiado grande');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
