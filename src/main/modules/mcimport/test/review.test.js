'use strict';
// Casos que encontro la revision: version "ultima" que no puede bajar de la que ya se jugo, copias renombradas
// de una version vanilla, perfiles viejos con "latest-release", limpieza cuando borrar una instancia falla,
// PowerShell con rutas con acentos y el canal de importar (un solo pedido a la vez, carpetas permitidas).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { detectVersion, resolveLatest } = require('../versions');
const { parseProfilesText } = require('../profiles');
const { scanFolder } = require('../scan');
const { buildPlan } = require('../plan');
const { runPlan } = require('../runner');
const running = require('../running');
const { buildMinecraft, tmpDir, write, MANIFEST, NOW, DAY } = require('./fixture');

const names = { latestRelease: (v) => `Minecraft ${v}`, latestSnapshot: (v) => `Snapshot ${v}`, unnamed: (l, v) => `${l} ${v}` };
const vanillaJson = (id, releaseTime, type = 'release') => JSON.stringify({ id, type, releaseTime, time: releaseTime, mainClass: 'net.minecraft.client.main.Main', downloads: { client: { url: 'x' } } });

test('una copia renombrada de una version vanilla no se importa como una version que Venus no puede bajar', () => {
  const ids = new Set(['1.21.1', '1.20.1']);
  const renamed = { id: 'Mi Vanilla', type: 'release', mainClass: 'net.minecraft.client.main.Main', downloads: { client: {} } };
  assert.deepEqual(detectVersion('Mi Vanilla', renamed, { manifestIds: ids }), { ok: false, reason: 'unknown' });
  assert.deepEqual(detectVersion('Mi Vanilla', renamed), { ok: false, reason: 'unknown' });
  // Una release mas nueva que el manifest guardado, pero con su JSON vanilla en versions/: si
  const newer = JSON.parse(vanillaJson('1.21.11', '2026-10-20T10:00:00+00:00'));
  assert.deepEqual(detectVersion('1.21.11', newer, { manifestIds: ids }), { ok: true, mcVersion: '1.21.11', loader: 'vanilla', loaderVersion: null });
});

test('las versiones viejisimas se reconocen por su forma exacta, no cualquier id que empiece con c', () => {
  for (const id of ['rd-132211', 'c0.0.11a', 'c0.30_01c', 'in-20100223', 'in-20091223-1459', 'inf-20100618', 'a1.2.6', 'b1.7.3']) assert.equal(detectVersion(id, null).loader, 'vanilla', id);
  for (const id of ['cracked', 'custom', 'infinity', 'rdx']) assert.equal(detectVersion(id, null).ok, false, id);
});

test('ultima version: nunca una mas vieja que la que el launcher oficial ya instalo', () => {
  const stale = { latest: { release: '1.21.10', snapshot: '25w45a' }, versions: [{ id: '1.21.10', releaseTime: '2025-10-07T09:00:00+00:00' }, { id: '25w45a', releaseTime: '2025-11-04T09:00:00+00:00' }] };
  const local = [
    { id: '1.21.11', type: 'release', releaseTime: '2026-10-20T10:00:00+00:00' },
    { id: '1.21.1', type: 'release', releaseTime: '2024-08-08T12:24:45+00:00' },
  ];
  assert.equal(resolveLatest('latest-release', { manifest: stale, local }), '1.21.11');
  // Lo instalado mas viejo que el manifest no gana
  assert.equal(resolveLatest('latest-release', { manifest: stale, local: [local[1]] }), '1.21.10');
  // Snapshot: la release instalada mas nueva le gana a una snapshot vieja del manifest
  assert.equal(resolveLatest('latest-snapshot', { manifest: stale, local }), '1.21.11');
  // Sin fecha en el manifest no se puede comparar: manda el manifest
  assert.equal(resolveLatest('latest-release', { manifest: { latest: { release: '1.21.10' }, versions: [] }, local }), '1.21.10');
  assert.equal(resolveLatest('latest-release', { manifest: null, local }), '1.21.11');
  assert.equal(resolveLatest('latest-release', {}), null);
});

test('escaneo: "ultima version" usa la instalada si es mas nueva que el manifest guardado', async () => {
  const fx = buildMinecraft();
  write(path.join(fx.root, 'versions', '1.21.11', '1.21.11.json'), vanillaJson('1.21.11', '2026-10-20T10:00:00+00:00'));
  const manifest = { ...MANIFEST, versions: MANIFEST.versions.map((v) => ({ ...v, releaseTime: v.id === '1.21.1' ? '2024-08-08T12:24:45+00:00' : '2020-01-01T00:00:00+00:00' })) };
  const scan = await scanFolder(fx.root, { venusRoot: tmpDir('venus-'), manifest, now: NOW, names, checkLocks: false });
  const latest = scan.profiles.find((p) => p.key === 'aaaa1111');
  assert.deepEqual(latest.version, { ok: true, mcVersion: '1.21.11', loader: 'vanilla', loaderVersion: null });
  assert.equal(latest.suggestedName, 'Minecraft 1.21.11');
});

test('perfil viejo con lastVersionId "latest-release" o "latest-snapshot" es la ultima version', () => {
  const text = JSON.stringify({ profiles: { a: { name: 'Viejo', type: 'custom', lastVersionId: 'latest-release' }, b: { name: 'Snap', lastVersionId: 'latest-snapshot' }, c: { name: 'Fijo', type: 'custom', lastVersionId: '1.20.1' } } });
  const r = parseProfilesText(text, { now: NOW });
  const by = Object.fromEntries(r.profiles.map((p) => [p.key, p]));
  assert.equal(by.a.implicitLatest, 'latest-release');
  assert.equal(by.b.implicitLatest, 'latest-snapshot');
  assert.equal(by.c.implicitLatest, null);
});

test('escaneo: el perfil viejo con "latest-release" se puede importar', async () => {
  const fx = buildMinecraft();
  const file = path.join(fx.root, 'launcher_profiles.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.profiles.viejo = { name: 'Perfil viejo', type: 'custom', lastVersionId: 'latest-release', lastUsed: new Date(NOW - 70 * DAY).toISOString() };
  fs.writeFileSync(file, JSON.stringify(data));
  const scan = await scanFolder(fx.root, { venusRoot: tmpDir('venus-'), manifest: MANIFEST, now: NOW, names, checkLocks: false });
  const p = scan.profiles.find((x) => x.key === 'viejo');
  assert.deepEqual(p.version, { ok: true, mcVersion: '1.21.1', loader: 'vanilla', loaderVersion: null });
  assert.equal(p.latestType, 'latest-release');
});

test('si borrar una instancia creada falla de golpe, igual se borran las demas y llega el error original', async () => {
  const fx = buildMinecraft();
  const venusRoot = tmpDir('venus-');
  const scan = await scanFolder(fx.root, { venusRoot, manifest: MANIFEST, now: NOW, names, checkLocks: false });
  const id = (key) => scan.profiles.find((p) => p.key === key).id;
  const plan = buildPlan(scan, { profiles: [id('aaaa1111'), id('bbbb2222'), id('cccc3333')] });
  const made = [];
  const removed = [];
  let n = 0;
  const instDir = path.join(venusRoot, 'instances');
  await assert.rejects(
    runPlan(plan, {
      stagingRoot: path.join(venusRoot, 'mcimport'),
      venusRoot,
      checkLock: async () => false,
      createInstance: async (o) => {
        if (++n === 3) throw Object.assign(new Error('fallo al crear la tercera'), { code: 'EXPLOTO' });
        const dir = path.join(instDir, `i${n}`);
        fs.mkdirSync(dir, { recursive: true });
        made.push(`i${n}`);
        return { id: `i${n}`, dir, name: o.name };
      },
      markInstance: async () => {},
      // La primera falla sin devolver una promesa (como instances.dir() con un id invalido)
      removeInstance: (iid) => {
        if (iid === 'i1') throw new Error('id invalido');
        removed.push(iid);
        fs.rmSync(path.join(instDir, iid), { recursive: true, force: true });
        return Promise.resolve();
      },
    }),
    (err) => err.code === 'EXPLOTO',
  );
  assert.deepEqual(made, ['i1', 'i2']);
  assert.deepEqual(removed, ['i2'], 'la segunda se borra aunque la primera haya fallado');
});

test('PowerShell devuelve las rutas en UTF-8 (usuarios con acentos o eñe)', () => {
  assert.match(running.PS_SCRIPT, /OutputEncoding\s*=\s*\[System\.Text\.Encoding\]::UTF8/);
  const dirs = running.parseGameDirs('"C:\\java\\bin\\javaw.exe" -Xmx2G net.minecraft.client.main.Main --username x --gameDir "C:\\Users\\José Ñandú\\AppData\\Roaming\\.minecraft" --assetsDir y');
  assert.deepEqual(dirs, ['C:\\Users\\José Ñandú\\AppData\\Roaming\\.minecraft']);
});
