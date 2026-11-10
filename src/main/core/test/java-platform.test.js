'use strict';
// Selección del Java de Mojang y de Adoptium por plataforma y arquitectura (Windows, Mac Intel y Apple Silicon) y,
// fuera de Windows, la instalación de un runtime con la estructura de macOS (jre.bundle/Contents/Home/bin/java),
// permisos de ejecución y enlaces, con la red simulada.
// node --test "src/main/core/test/java-platform.test.js"
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const paths = require('../paths');
const http = require('../http');
const java = require('../java');
const platformInfo = require('../platform');

test('plataforma del índice de Mojang según sistema y arquitectura', () => {
  assert.equal(java.mojangPlatform('win32', 'x64'), 'windows-x64');
  assert.equal(java.mojangPlatform('win32', 'arm64'), 'windows-arm64');
  assert.equal(java.mojangPlatform('darwin', 'x64'), 'mac-os');
  assert.equal(java.mojangPlatform('darwin', 'arm64'), 'mac-os-arm64');
  assert.equal(java.mojangPlatform('linux', 'x64'), 'linux');
});

test('Apple Silicon: arm64 con respaldo x64; con Rosetta pedido, solo x64', () => {
  assert.deepEqual(java.runtimePlatforms({ platform: 'darwin', arch: 'arm64' }), ['mac-os-arm64', 'mac-os']);
  assert.deepEqual(java.runtimePlatforms({ platform: 'darwin', arch: 'arm64', want: 'x64' }), ['mac-os']);
  assert.deepEqual(java.runtimePlatforms({ platform: 'darwin', arch: 'arm64', want: 'arm64' }), ['mac-os-arm64', 'mac-os']);
  assert.deepEqual(java.runtimePlatforms({ platform: 'darwin', arch: 'x64' }), ['mac-os']);
  assert.deepEqual(java.runtimePlatforms({ platform: 'win32', arch: 'x64' }), ['windows-x64']);
  assert.deepEqual(java.runtimePlatforms({ platform: 'win32', arch: 'arm64' }), ['windows-arm64', 'windows-x64']);
});

test('carpeta del runtime: la de siempre, o -x64 cuando convive con el arm64', () => {
  assert.equal(java.runtimeDirName('java-runtime-gamma', { arch: 'arm64' }), 'java-runtime-gamma');
  assert.equal(java.runtimeDirName('java-runtime-gamma', { arch: 'arm64', want: 'x64' }), 'java-runtime-gamma-x64');
  assert.equal(java.runtimeDirName('java-runtime-gamma', { arch: 'x64', want: 'x64' }), 'java-runtime-gamma');
  assert.equal(java.runtimeDirName('jre-legacy', { arch: 'x64' }), 'jre-legacy');
});

test('Adoptium: tar.gz para mac, Java 8 x64 en Apple Silicon, x64 si se pide Rosetta', () => {
  assert.deepEqual(java.adoptiumTarget(17, { platform: 'darwin', arch: 'arm64' }), { osName: 'mac', arch: 'aarch64', ext: 'tar.gz' });
  assert.deepEqual(java.adoptiumTarget(8, { platform: 'darwin', arch: 'arm64' }), { osName: 'mac', arch: 'x64', ext: 'tar.gz' });
  assert.deepEqual(java.adoptiumTarget(17, { platform: 'darwin', arch: 'arm64', want: 'x64' }), { osName: 'mac', arch: 'x64', ext: 'tar.gz' });
  assert.deepEqual(java.adoptiumTarget(21, { platform: 'darwin', arch: 'x64' }), { osName: 'mac', arch: 'x64', ext: 'tar.gz' });
  assert.deepEqual(java.adoptiumTarget(21, { platform: 'win32', arch: 'x64' }), { osName: 'windows', arch: 'x64', ext: 'zip' });
  assert.deepEqual(java.adoptiumTarget(8, { platform: 'win32', arch: 'arm64' }), { osName: 'windows', arch: 'x64', ext: 'zip' });
});

test('índice: primera plataforma con el componente publicado (jre-legacy no existe para arm64)', () => {
  const index = {
    'mac-os-arm64': { 'jre-legacy': [], 'java-runtime-gamma': [{ version: { name: '17-arm' } }] },
    'mac-os': { 'jre-legacy': [{ version: { name: '8-x64' } }], 'java-runtime-gamma': [{ version: { name: '17-x64' } }] },
  };
  const arm = ['mac-os-arm64', 'mac-os'];
  assert.deepEqual(java.pickIndexEntry(index, 'java-runtime-gamma', arm), { entry: { version: { name: '17-arm' } }, platform: 'mac-os-arm64' });
  assert.deepEqual(java.pickIndexEntry(index, 'jre-legacy', arm), { entry: { version: { name: '8-x64' } }, platform: 'mac-os' });
  assert.equal(java.pickIndexEntry(index, 'java-runtime-gamma', ['mac-os']).entry.version.name, '17-x64');
  assert.equal(java.pickIndexEntry(null, 'jre-legacy', arm), null);
  assert.equal(java.archOfPlatform('mac-os-arm64'), 'arm64');
  assert.equal(java.archOfPlatform('mac-os'), 'x64');
  assert.equal(java.archOfPlatform('windows-x86'), 'ia32');
  assert.ok(java.JAVA_CANDIDATES.includes('jre.bundle/Contents/Home/bin/java'));
  assert.ok(java.JAVA_CANDIDATES.includes('Contents/Home/bin/java'));
});

// Runtime de Mojang con la forma del de macOS. El "java" es un script que contesta -version como el de verdad: si el
// launcher no le da permiso de ejecución, la verificación falla.
function fakeMojang(tmp, plat, name) {
  const manifestUrl = `https://example.invalid/${plat}/${name}/manifest.json`;
  const files = {
    'jre.bundle': { type: 'directory' },
    'jre.bundle/Contents': { type: 'directory' },
    'jre.bundle/Contents/Home': { type: 'directory' },
    'jre.bundle/Contents/Home/bin': { type: 'directory' },
    'jre.bundle/Contents/Home/bin/java': { type: 'file', executable: true, downloads: { raw: { url: `${manifestUrl}#java`, sha1: 'a', size: 1 } } },
    'jre.bundle/Contents/Home/lib': { type: 'directory' },
    'jre.bundle/Contents/Home/lib/libjli.dylib': { type: 'file', executable: false, downloads: { raw: { url: `${manifestUrl}#lib`, sha1: 'b', size: 1 } } },
    'jre.bundle/Contents/MacOS': { type: 'directory' },
    'jre.bundle/Contents/MacOS/libjli.dylib': { type: 'link', target: '../Home/lib/libjli.dylib' },
  };
  return { entry: { manifest: { url: manifestUrl }, version: { name } }, manifestUrl, manifest: { files } };
}

test('fuera de Windows instala el runtime de Mojang con jre.bundle, permisos y enlaces', { skip: process.platform === 'win32' && 'la estructura de macOS se prueba en macOS y Linux' }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'venus-java-'));
  const saved = { getJson: http.getJson, downloadAll: http.downloadAll, download: http.download };
  t.after(() => {
    Object.assign(http, saved);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  paths.setRoot(tmp);
  const host = java.mojangPlatform();
  const native = fakeMojang(tmp, host, '17.0.8-native');
  const x64 = fakeMojang(tmp, 'mac-os', '17.0.8-x64');
  // En una Mac Intel la plataforma propia ya es mac-os: queda la "nativa"
  const index = { 'mac-os': { 'java-runtime-gamma': [x64.entry] }, [host]: { 'java-runtime-gamma': [native.entry] } };
  http.getJson = async (url) => {
    if (/java-runtime/.test(url) && /all\.json$/.test(url)) return index;
    if (url === native.manifestUrl) return native.manifest;
    if (url === x64.manifestUrl) return x64.manifest;
    throw new Error(`url inesperada ${url}`);
  };
  http.download = async () => assert.fail('no tiene que caer en Adoptium');
  http.downloadAll = async (items) => {
    for (const it of items) {
      fs.mkdirSync(path.dirname(it.path), { recursive: true });
      // Sin permiso de ejecución: lo tiene que dar java.js (chmod 755 de los "executable")
      const body = it.url.endsWith('#java') ? '#!/bin/sh\necho \'openjdk version "17.0.8" 2023-07-18\' >&2\necho \'OpenJDK Runtime Environment\' >&2\n' : 'x';
      fs.writeFileSync(it.path, body, { mode: 0o644 });
    }
  };

  const exe = await java.ensureRuntime('java-runtime-gamma', 17);
  assert.equal(exe, path.join(tmp, 'runtime', 'java-runtime-gamma', 'jre.bundle', 'Contents', 'Home', 'bin', 'java'));
  assert.ok(fs.statSync(exe).mode & 0o111, 'java tiene permiso de ejecución');
  assert.equal(fs.readlinkSync(path.join(tmp, 'runtime', 'java-runtime-gamma', 'jre.bundle', 'Contents', 'MacOS', 'libjli.dylib')), '../Home/lib/libjli.dylib');
  const marker = JSON.parse(fs.readFileSync(path.join(tmp, 'runtime', 'java-runtime-gamma', '.venus-runtime.json'), 'utf8'));
  assert.equal(marker.source, 'mojang:17.0.8-native');
  assert.equal(marker.major, 17);
  assert.equal(marker.arch, java.archOfPlatform(host));
  assert.equal((await java.getJavaVersion(exe)).major, 17);

  // Apple Silicon con una versión sin nativos arm64: Java x64 aparte (con Rosetta) o el aviso de instalar Rosetta.
  if (platformInfo.isAppleSilicon()) {
    if (platformInfo.rosettaInstalled()) {
      const exe64 = await java.ensureRuntime('java-runtime-gamma', 17, null, { arch: 'x64' });
      assert.equal(exe64, path.join(tmp, 'runtime', 'java-runtime-gamma-x64', 'jre.bundle', 'Contents', 'Home', 'bin', 'java'));
      const list = await java.listInstalledRuntimes();
      assert.deepEqual(list.map((r) => [r.component, r.arch]).sort(), [['java-runtime-gamma', 'arm64'], ['java-runtime-gamma-x64', 'x64']]);
    } else {
      await assert.rejects(java.ensureRuntime('java-runtime-gamma', 17, null, { arch: 'x64' }), (err) => err.code === 'rosettaMissing');
    }
  }
});
