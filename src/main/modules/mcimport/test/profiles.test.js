'use strict';
// Pruebas de la lectura de perfiles del launcher oficial (sin Electron).
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseProfilesText, mergeProfiles, cleanText, parseTime, cleanIcon, BOM } = require('../profiles');

const NOW = Date.UTC(2026, 10, 1);

test('lee los perfiles del launcher oficial con sus campos', () => {
  const text = JSON.stringify({
    profiles: {
      abc: { name: 'Fabric', type: 'custom', lastVersionId: 'fabric-loader-0.16.5-1.21.1', gameDir: 'C:\\Games\\mc', icon: 'Furnace', lastUsed: '2026-10-30T10:00:00.000Z', created: '2026-01-01T00:00:00.000Z', javaArgs: '-Xmx2G' },
      def: { name: '', type: 'latest-release', lastVersionId: 'latest-release' },
    },
    selectedProfile: 'abc',
  });
  const r = parseProfilesText(text, { now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.selected, 'o:abc');
  const [a, b] = r.profiles;
  assert.deepEqual(
    { id: a.id, type: a.type, name: a.name, version: a.lastVersionId, gameDir: a.gameDir, icon: a.icon, used: a.lastUsed > 0, created: a.created > 0 },
    { id: 'o:abc', type: 'custom', name: 'Fabric', version: 'fabric-loader-0.16.5-1.21.1', gameDir: 'C:\\Games\\mc', icon: { kind: 'builtin', name: 'Furnace' }, used: true, created: true },
  );
  assert.equal('javaArgs' in a, false, 'los argumentos de Java no se importan');
  assert.equal(b.type, 'latest-release');
  assert.equal(b.lastVersionId, 'latest-release');
});

test('el archivo de la Microsoft Store usa otro prefijo de id', () => {
  const r = parseProfilesText(JSON.stringify({ profiles: { abc: { name: 'X', lastVersionId: '1.20.4' } } }), { source: 'store', prefix: 's', now: NOW });
  assert.equal(r.profiles[0].id, 's:abc');
  assert.equal(r.profiles[0].source, 'store');
  assert.equal(r.profiles[0].type, 'custom', 'sin "type" (launcher viejo) es un perfil propio');
});

test('JSON roto, sin perfiles o demasiado grande', () => {
  assert.deepEqual(parseProfilesText('{"profiles": {', { now: NOW }), { ok: false, error: 'malformed' });
  assert.deepEqual(parseProfilesText('[]', { now: NOW }), { ok: false, error: 'noProfiles' });
  assert.deepEqual(parseProfilesText('{"profiles": []}', { now: NOW }), { ok: false, error: 'noProfiles' });
  assert.deepEqual(parseProfilesText('{"version": 3}', { now: NOW }), { ok: false, error: 'noProfiles' });
  assert.deepEqual(parseProfilesText(null), { ok: false, error: 'malformed' });
  assert.deepEqual(parseProfilesText(`{"profiles":{},"x":"${'a'.repeat(9 * 1024 * 1024)}"}`), { ok: false, error: 'malformed' });
});

test('acepta el BOM de Windows al principio', () => {
  const r = parseProfilesText(`${BOM}{"profiles":{"a":{"name":"X","lastVersionId":"1.21.1"}}}`, { now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.profiles.length, 1);
});

test('campos faltantes o con tipos raros no rompen nada', () => {
  const r = parseProfilesText(
    JSON.stringify({
      profiles: {
        a: {},
        b: { name: 42, type: 'weird', lastVersionId: '../../evil', gameDir: 7, icon: 'javascript:alert(1)', lastUsed: 'mañana' },
        c: null,
        d: 'texto',
        e: [],
        '': { name: 'sin clave' },
      },
    }),
    { now: NOW },
  );
  assert.equal(r.ok, true);
  assert.equal(r.profiles.length, 2);
  const [a, b] = r.profiles;
  assert.equal(a.type, 'custom');
  assert.equal(a.implicitLatest, 'latest-release', 'perfil viejo sin version = ultima release');
  assert.equal(b.name, '');
  assert.equal(b.type, 'custom');
  assert.equal(b.lastVersionId, null, 'un id con barras no es una version');
  assert.equal(b.implicitLatest, null, 'una version invalida no se adivina como la ultima');
  assert.equal(b.gameDir, null);
  assert.equal(b.icon, null);
  assert.equal(b.lastUsed, 0);
});

test('textos: sin caracteres de control ni marcas de direccion y con largo maximo', () => {
  const evil = ['Mi', String.fromCharCode(0x202e), 'perfil', String.fromCharCode(0x2028), String.fromCharCode(7), '  raro'].join('');
  assert.equal(cleanText(evil), 'Mi perfil raro');
  assert.equal(cleanText('x'.repeat(200), 80).length, 80);
  assert.equal(cleanText(undefined), '');
});

test('fechas: 1970 y el futuro lejano cuentan como nunca', () => {
  assert.equal(parseTime('1970-01-01T00:00:00.000Z', NOW), 0);
  assert.equal(parseTime('2099-01-01T00:00:00.000Z', NOW), 0);
  assert.equal(parseTime('2026-10-31T00:00:00.000Z', NOW), Date.UTC(2026, 9, 31));
  assert.equal(parseTime('no es una fecha', NOW), 0);
});

test('iconos: solo imagenes en data: o el nombre de un icono incorporado', () => {
  assert.deepEqual(cleanIcon('data:image/png;base64,iVBORw0KGgo='), { kind: 'image', data: 'data:image/png;base64,iVBORw0KGgo=' });
  assert.equal(cleanIcon('data:image/svg+xml;base64,PHN2Zz4='), null);
  assert.equal(cleanIcon('data:text/html;base64,PGh0bWw+'), null);
  assert.equal(cleanIcon('https://example.com/x.png'), null);
  assert.equal(cleanIcon(`data:image/png;base64,${'A'.repeat(300 * 1024)}`), null);
  assert.deepEqual(cleanIcon('Crafting_Table'), { kind: 'builtin', name: 'Crafting_Table' });
});

test('junta los dos archivos sin repetir el mismo perfil y ordena por uso', () => {
  const off = parseProfilesText(JSON.stringify({ profiles: { a: { name: 'Fabric', type: 'custom', lastVersionId: 'fabric-loader-0.16.5-1.21.1', lastUsed: '2026-10-01T00:00:00Z' }, b: { name: 'Viejo', type: 'custom', lastVersionId: '1.8.9' } } }), { now: NOW });
  const store = parseProfilesText(JSON.stringify({ profiles: { z: { name: 'fabric', type: 'custom', lastVersionId: 'fabric-loader-0.16.5-1.21.1', lastUsed: '2026-10-20T00:00:00Z' }, y: { name: 'Store', type: 'custom', lastVersionId: '1.20.4', lastUsed: '2026-09-01T00:00:00Z' } } }), { source: 'store', prefix: 's', now: NOW });
  const merged = mergeProfiles([off.profiles, store.profiles]);
  assert.deepEqual(
    merged.map((p) => p.id),
    ['s:z', 's:y', 'o:b'],
  );
  assert.deepEqual(merged[0].sources.sort(), ['official', 'store']);
});
