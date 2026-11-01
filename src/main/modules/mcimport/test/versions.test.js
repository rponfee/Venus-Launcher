'use strict';
// Pruebas de la deteccion de version y loader de los perfiles del launcher oficial.
const test = require('node:test');
const assert = require('node:assert/strict');
const { detectVersion, resolveLatest, neoforgeMc, forgeShort } = require('../versions');

const MANIFEST_IDS = new Set(['1.21.1', '1.21', '1.20.4', '1.20.1', '1.12.2', '1.7.10', '1.8.9', '1.8', '24w14a', 'b1.7.3', '1.14.4', '1.16.5', '1.21.5-pre1', '1.14 Pre-Release 1']);

const TABLE = [
  // [lastVersionId, esperado]
  ['1.21.1', ['1.21.1', 'vanilla', null]],
  ['24w14a', ['24w14a', 'vanilla', null]],
  ['1.14 Pre-Release 1', ['1.14 Pre-Release 1', 'vanilla', null]],
  ['b1.7.3', ['b1.7.3', 'vanilla', null]],
  ['fabric-loader-0.16.5-1.21.1', ['1.21.1', 'fabric', '0.16.5']],
  ['fabric-loader-0.16.10-1.21.5-pre1', ['1.21.5-pre1', 'fabric', '0.16.10']],
  ['fabric-loader-0.16.0-beta.1-1.21', ['1.21', 'fabric', '0.16.0-beta.1']],
  ['fabric-loader-0.14.21-1.8.9', ['1.8.9', 'legacyfabric', '0.14.21']],
  ['fabric-loader-0.15.0-b1.7.3', ['b1.7.3', 'babric', '0.15.0']],
  ['quilt-loader-0.26.4-1.21.1', ['1.21.1', 'quilt', '0.26.4']],
  ['1.20.1-forge-47.3.0', ['1.20.1', 'forge', '47.3.0']],
  ['1.12.2-forge-14.23.5.2860', ['1.12.2', 'forge', '14.23.5.2860']],
  ['1.12.2-forge1.12.2-14.23.5.2847', ['1.12.2', 'forge', '14.23.5.2847']],
  ['1.7.10-Forge10.13.4.1614-1.7.10', ['1.7.10', 'forge', '10.13.4.1614']],
  ['1.8.9-forge1.8.9-11.15.1.2318-1.8.9', ['1.8.9', 'forge', '11.15.1.2318']],
  ['neoforge-21.1.65', ['1.21.1', 'neoforge', '21.1.65']],
  ['neoforge-20.4.237', ['1.20.4', 'neoforge', '20.4.237']],
  ['neoforge-21.0.0-beta', ['1.21', 'neoforge', '21.0.0-beta']],
  ['1.20.1-47.1.106', ['1.20.1', 'neoforge', '47.1.106']],
  ['1.20.1-OptiFine_HD_U_I6', ['1.20.1', 'optifine', 'HD_U_I6']],
  ['1.20.4-OptiFine_HD_U_I7_pre3', ['1.20.4', 'optifine', 'HD_U_I7_pre3']],
  ['1.8.9-OptiFine_HD_U_M5', ['1.8.9', 'optifine', 'HD_U_M5']],
];

for (const [id, [mc, loader, lv]] of TABLE) {
  test(`detecta ${id}`, () => {
    const r = detectVersion(id, null, { manifestIds: MANIFEST_IDS });
    assert.deepEqual(r, { ok: true, mcVersion: mc, loader, loaderVersion: lv });
  });
}

test('sin el manifest reconoce las versiones vanilla por su forma', () => {
  assert.equal(detectVersion('1.21.4', null).loader, 'vanilla');
  assert.equal(detectVersion('25w02a', null).loader, 'vanilla');
  assert.equal(detectVersion('26.1', null).loader, 'vanilla');
  assert.equal(detectVersion('1.20.5-rc1', null).loader, 'vanilla');
  assert.equal(detectVersion('Mi version rara', null).ok, false);
});

test('con el manifest, un id que no existe no es vanilla', () => {
  assert.deepEqual(detectVersion('1.99.9', null, { manifestIds: MANIFEST_IDS }), { ok: false, reason: 'unknown' });
});

test('loaders que Venus no instala quedan como no importables con su nombre', () => {
  assert.deepEqual(detectVersion('1.12.2-LiteLoader1.12.2', null, { manifestIds: MANIFEST_IDS }), { ok: false, reason: 'unsupportedLoader', loaderName: 'LiteLoader' });
  assert.deepEqual(detectVersion('LabyMod-4-1.20.4', null), { ok: false, reason: 'unsupportedLoader', loaderName: 'LabyMod' });
  const json = { id: 'custom', inheritsFrom: '1.12.2', libraries: [{ name: 'com.mumfrey:liteloader:1.12.2-SNAPSHOT' }] };
  assert.equal(detectVersion('custom', json).loaderName, 'LiteLoader');
  // Hereda de una version vanilla con un loader desconocido
  assert.deepEqual(detectVersion('MiCliente', { id: 'MiCliente', inheritsFrom: '1.21.1', libraries: [{ name: 'com.example:loader:1.0' }] }), { ok: false, reason: 'unsupportedLoader', loaderName: null });
});

test('el JSON de la version manda sobre el nombre (perfil renombrado)', () => {
  const fabric = { id: 'Mi Fabric', inheritsFrom: '1.21.1', libraries: [{ name: 'net.fabricmc:fabric-loader:0.16.5' }, { name: 'net.fabricmc:intermediary:1.21.1' }] };
  assert.deepEqual(detectVersion('Mi Fabric', fabric), { ok: true, mcVersion: '1.21.1', loader: 'fabric', loaderVersion: '0.16.5' });
  const quilt = { id: 'q', inheritsFrom: '1.20.1', libraries: [{ name: 'org.quiltmc:quilt-loader:0.26.4' }] };
  assert.equal(detectVersion('q', quilt).loader, 'quilt');
  const forge = { id: 'f', inheritsFrom: '1.20.1', libraries: [{ name: 'net.minecraftforge:fmlloader:1.20.1-47.3.0' }] };
  assert.deepEqual(detectVersion('f', forge), { ok: true, mcVersion: '1.20.1', loader: 'forge', loaderVersion: '47.3.0' });
  const neoLegacy = { id: '1.20.1-forge-47.1.106', inheritsFrom: '1.20.1', libraries: [{ name: 'net.neoforged:forge:1.20.1-47.1.106' }] };
  assert.deepEqual(detectVersion('1.20.1-forge-47.1.106', neoLegacy), { ok: true, mcVersion: '1.20.1', loader: 'neoforge', loaderVersion: '47.1.106' });
  const neo = { id: 'neoforge-21.1.65', inheritsFrom: '1.21.1', libraries: [{ name: 'net.neoforged:neoforge:21.1.65:universal' }] };
  assert.deepEqual(detectVersion('neoforge-21.1.65', neo), { ok: true, mcVersion: '1.21.1', loader: 'neoforge', loaderVersion: '21.1.65' });
  const of = { id: 'OptiFine', inheritsFrom: '1.20.1', libraries: [{ name: 'optifine:OptiFine:1.20.1_HD_U_I6' }] };
  assert.deepEqual(detectVersion('OptiFine', of), { ok: true, mcVersion: '1.20.1', loader: 'optifine', loaderVersion: 'HD_U_I6' });
  const legacy = { id: 'lf', inheritsFrom: '1.12.2', libraries: [{ name: 'net.fabricmc:fabric-loader:0.15.0' }, { name: 'net.legacyfabric:intermediary:1.12.2' }] };
  assert.equal(detectVersion('lf', legacy).loader, 'legacyfabric');
  // Un JSON vanilla con id de version de Mojang (con o sin manifest) si; una copia renombrada no (Venus no la puede bajar)
  const vanilla = { id: '1.21.1', mainClass: 'net.minecraft.client.main.Main', downloads: { client: {} } };
  assert.deepEqual(detectVersion('1.21.1', vanilla), { ok: true, mcVersion: '1.21.1', loader: 'vanilla', loaderVersion: null });
  assert.deepEqual(detectVersion('Mi Vanilla', { ...vanilla, id: 'Mi Vanilla' }), { ok: false, reason: 'unknown' });
});

test('ids invalidos', () => {
  assert.deepEqual(detectVersion('', null), { ok: false, reason: 'noVersion' });
  assert.deepEqual(detectVersion('../x', null), { ok: false, reason: 'noVersion' });
  assert.deepEqual(detectVersion(null, null), { ok: false, reason: 'noVersion' });
  assert.deepEqual(detectVersion(' 1.21', null), { ok: false, reason: 'noVersion' });
});

test('ultima version: manifest primero y si no, las versiones instaladas', () => {
  const manifest = { latest: { release: '1.21.10', snapshot: '25w45a' } };
  assert.equal(resolveLatest('latest-release', { manifest }), '1.21.10');
  assert.equal(resolveLatest('latest-snapshot', { manifest }), '25w45a');
  const local = [
    { id: '1.20.1', type: 'release', releaseTime: '2023-06-12T13:25:51+00:00' },
    { id: '1.21.1', type: 'release', releaseTime: '2024-08-08T12:24:45+00:00' },
    { id: '24w14a', type: 'snapshot', releaseTime: '2024-04-03T12:00:00+00:00' },
  ];
  assert.equal(resolveLatest('latest-release', { local }), '1.21.1');
  assert.equal(resolveLatest('latest-snapshot', { local }), '1.21.1');
  assert.equal(resolveLatest('latest-release', {}), null);
});

test('ayudantes: NeoForge y Forge', () => {
  assert.equal(neoforgeMc('21.1.65'), '1.21.1');
  assert.equal(neoforgeMc('21.0.3'), '1.21');
  assert.equal(neoforgeMc('20.2.86'), '1.20.2');
  assert.equal(forgeShort('1.7.10-10.13.4.1614-1.7.10', '1.7.10'), '10.13.4.1614');
  assert.equal(forgeShort('1.20.1-abc', '1.20.1'), null);
});
