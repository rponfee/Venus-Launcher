'use strict';
// Reglas de los JSON de versión, nativos de LWJGL y argumentos de lanzamiento en macOS (Intel y Apple Silicon),
// comparados con Windows. Sin red: JSON de versión armados a mano con la forma de los de Mojang.
// node --test "src/main/core/test/launch-platform.test.js"
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const paths = require('../paths');
const { rulesAllow, flattenArgs } = require('../rules');
const minecraft = require('../minecraft');
const launch = require('../launch');
const platformInfo = require('../platform');

const OSX_ARM = { osName: 'osx', arch: 'arm64', osVersion: '24.1.0' };
const OSX_X64 = { osName: 'osx', arch: 'x64', osVersion: '23.6.0' };
const WIN = { osName: 'windows', arch: 'x64', osVersion: '10.0.26100' };

const art = (p) => ({ artifact: { path: p, url: `https://libraries.minecraft.net/${p}`, sha1: 'a', size: 1 } });
const onlyOn = (name) => [{ action: 'allow', os: { name } }];

// 1.21: LWJGL 3.3 con nativos como librerías del classpath, una por sistema (y arm64 para Mac).
const V121 = {
  id: '1.21',
  mainClass: 'net.minecraft.client.main.Main',
  arguments: {
    game: ['--username', '${auth_player_name}'],
    jvm: [
      { rules: onlyOn('osx'), value: ['-XstartOnFirstThread'] },
      { rules: onlyOn('windows'), value: '-XX:HeapDumpPath=MojangTricksIntelDriversForPerformance_javaw.exe_minecraft.exe.heapdump' },
      { rules: [{ action: 'allow', os: { arch: 'x86' } }], value: '-Xss1M' },
      '-Djava.library.path=${natives_directory}',
      '-cp',
      '${classpath}',
    ],
  },
  libraries: [
    { name: 'org.lwjgl:lwjgl:3.3.3', downloads: art('org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3.jar') },
    { name: 'org.lwjgl:lwjgl:3.3.3:natives-macos', downloads: art('org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-macos.jar'), rules: onlyOn('osx') },
    { name: 'org.lwjgl:lwjgl:3.3.3:natives-macos-arm64', downloads: art('org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-macos-arm64.jar'), rules: onlyOn('osx') },
    { name: 'org.lwjgl:lwjgl:3.3.3:natives-windows', downloads: art('org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar'), rules: onlyOn('windows') },
  ],
};

// 1.12.2: LWJGL 2, nativos "viejos" que se extraen (natives-osx) y una librería distinta para Mac.
const V1122 = {
  id: '1.12.2',
  mainClass: 'net.minecraft.client.main.Main',
  minecraftArguments: '--username ${auth_player_name}',
  libraries: [
    { name: 'org.lwjgl.lwjgl:lwjgl:2.9.4-nightly-20150209', downloads: art('org/lwjgl/lwjgl/lwjgl/2.9.4-nightly-20150209/lwjgl-2.9.4-nightly-20150209.jar'), rules: [{ action: 'allow' }, { action: 'disallow', os: { name: 'osx' } }] },
    { name: 'org.lwjgl.lwjgl:lwjgl:2.9.2-nightly-20140822', downloads: art('org/lwjgl/lwjgl/lwjgl/2.9.2-nightly-20140822/lwjgl-2.9.2-nightly-20140822.jar'), rules: onlyOn('osx') },
    {
      name: 'org.lwjgl.lwjgl:lwjgl-platform:2.9.4-nightly-20150209',
      natives: { linux: 'natives-linux', osx: 'natives-osx', windows: 'natives-windows' },
      extract: { exclude: ['META-INF/'] },
      downloads: { classifiers: { 'natives-osx': { path: 'n/natives-osx.jar', url: 'https://x/n/natives-osx.jar', sha1: 'b', size: 2 }, 'natives-windows': { path: 'n/natives-windows.jar', url: 'https://x/n/natives-windows.jar', sha1: 'c', size: 3 } } },
    },
  ],
};

let tmp;
test.before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'venus-launchplat-'));
  paths.setRoot(tmp);
});
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const files = (json, host) => minecraft.allLibraryFiles(minecraft.mergeChain([json], host), host).map((f) => path.basename(f.path) + (f.natives ? ' (nativo)' : ''));

test('reglas osx y arch se evalúan con el sistema indicado', () => {
  assert.equal(rulesAllow(onlyOn('osx'), {}, OSX_ARM), true);
  assert.equal(rulesAllow(onlyOn('osx'), {}, WIN), false);
  assert.equal(rulesAllow([{ action: 'allow', os: { name: 'osx', arch: 'arm64' } }], {}, OSX_ARM), true);
  assert.equal(rulesAllow([{ action: 'allow', os: { name: 'osx', arch: 'arm64' } }], {}, OSX_X64), false);
  // Las reglas viejas de versión de macOS ("^10\\.5\\.\\d$") no coinciden con un macOS moderno
  assert.equal(rulesAllow([{ action: 'allow', os: { name: 'osx', version: '^10\\.5\\.\\d$' } }], {}, OSX_ARM), false);
  assert.deepEqual(flattenArgs(V121.arguments.jvm, {}, OSX_ARM).slice(0, 2), ['-XstartOnFirstThread', '-Djava.library.path=${natives_directory}']);
  assert.ok(!flattenArgs(V121.arguments.jvm, {}, WIN).includes('-XstartOnFirstThread'));
  assert.ok(flattenArgs(V121.arguments.jvm, {}, WIN).some((a) => a.startsWith('-XX:HeapDumpPath')));
});

test('1.21 en Mac: nativos de Intel y de Apple Silicon en el classpath, nada de Windows; corre nativo en arm64', () => {
  assert.deepEqual(files(V121, OSX_ARM), ['lwjgl-3.3.3.jar', 'lwjgl-3.3.3-natives-macos.jar', 'lwjgl-3.3.3-natives-macos-arm64.jar']);
  assert.deepEqual(files(V121, WIN), ['lwjgl-3.3.3.jar', 'lwjgl-3.3.3-natives-windows.jar']);
  const resolved = minecraft.mergeChain([V121], OSX_ARM);
  assert.equal(platformInfo.gameArch(resolved, { platform: 'darwin', arch: 'arm64' }), 'arm64');
});

test('1.12.2 en Mac: LWJGL de Mac, natives-osx para extraer y Java x64 con Rosetta en Apple Silicon', () => {
  assert.deepEqual(files(V1122, OSX_ARM), ['lwjgl-2.9.2-nightly-20140822.jar', 'natives-osx.jar (nativo)']);
  assert.deepEqual(files(V1122, WIN), ['lwjgl-2.9.4-nightly-20150209.jar', 'natives-windows.jar (nativo)']);
  const resolved = minecraft.mergeChain([V1122], OSX_ARM);
  assert.equal(platformInfo.gameArch(resolved, { platform: 'darwin', arch: 'arm64' }), 'x64');
  assert.equal(platformInfo.gameArch(resolved, { platform: 'darwin', arch: 'x64' }), 'x64');
});

test('JVM de los JSON viejos: -XstartOnFirstThread solo con LWJGL 3 en Mac', () => {
  const lwjgl2 = minecraft.mergeChain([V1122], OSX_X64);
  const mac2 = launch.legacyJvmArgs(lwjgl2, { platform: 'darwin', arch: 'x64' });
  assert.ok(!mac2.includes('-XstartOnFirstThread'), 'con LWJGL 2 la ventana se cuelga');
  assert.ok(mac2.includes('-Xdock:name=Minecraft'));
  assert.ok(!mac2.some((a) => a.includes('HeapDumpPath')));
  const lwjgl3 = { libraries: [{ name: 'org.lwjgl:lwjgl:3.2.2' }] };
  assert.ok(launch.legacyJvmArgs(lwjgl3, { platform: 'darwin', arch: 'arm64' }).includes('-XstartOnFirstThread'));
  const win = launch.legacyJvmArgs(lwjgl3, { platform: 'win32', arch: 'x64' });
  assert.ok(!win.includes('-XstartOnFirstThread') && !win.includes('-Xdock:name=Minecraft'));
  assert.ok(win.some((a) => a.includes('HeapDumpPath')));
  assert.deepEqual(win.slice(-2), ['-cp', '${classpath}']);
});
