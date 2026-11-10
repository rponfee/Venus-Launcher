'use strict';
// Capacidades por plataforma y detalles de macOS (core/platform.js), sin Electron.
// node --test "src/main/core/test/platform.test.js"
const test = require('node:test');
const assert = require('node:assert/strict');
const platform = require('../platform');

const LWJGL2 = [{ name: 'org.lwjgl.lwjgl:lwjgl:2.9.4-nightly-20150209' }, { name: 'org.lwjgl.lwjgl:lwjgl-platform:2.9.4-nightly-20150209', natives: { osx: 'natives-osx', windows: 'natives-windows' } }];
const LWJGL32 = [{ name: 'org.lwjgl:lwjgl:3.2.2' }, { name: 'org.lwjgl:lwjgl:3.2.2', natives: { osx: 'natives-macos' }, downloads: { classifiers: { 'natives-macos': { url: 'x' } } } }];
const LWJGL33 = [{ name: 'org.lwjgl:lwjgl:3.3.3' }, { name: 'org.lwjgl:lwjgl:3.3.3:natives-macos' }, { name: 'org.lwjgl:lwjgl:3.3.3:natives-macos-arm64' }];

test('lo que depende de Windows no existe en macOS ni en Linux; lo demás sí', () => {
  for (const feature of Object.keys(platform.WINDOWS_ONLY)) {
    assert.equal(platform.supports(feature, 'win32'), true, feature);
    assert.equal(platform.supports(feature, 'darwin'), false, feature);
    assert.equal(platform.supports(feature, 'linux'), false, feature);
  }
  for (const feature of ['voice', 'discord', 'deeplink', 'servers', 'tunnels', 'skins', 'modrinth']) assert.equal(platform.supports(feature, 'darwin'), true, feature);
  const mac = platform.capabilities('darwin');
  assert.deepEqual(Object.keys(mac).sort(), Object.keys(platform.WINDOWS_ONLY).sort());
  assert.ok(Object.values(mac).every((v) => v === false));
  assert.ok(Object.values(platform.capabilities('win32')).every((v) => v === true));
  for (const f of ['overlay', 'nowplaying', 'capture', 'gameWindowBranding', 'windowsIntegration', 'desktopShortcuts']) assert.ok(f in mac, f);
});

test('nativos: arm64 solo desde LWJGL 3.3; LWJGL 3 para -XstartOnFirstThread', () => {
  assert.equal(platform.hasArm64MacNatives(LWJGL2), false);
  assert.equal(platform.hasArm64MacNatives(LWJGL32), false);
  assert.equal(platform.hasArm64MacNatives(LWJGL33), true);
  assert.equal(platform.hasArm64MacNatives([{ name: 'x:y:1', natives: { osx: 'natives-macos-arm64' } }]), true);
  assert.equal(platform.hasArm64MacNatives([{ name: 'x:y:1', downloads: { classifiers: { 'natives-macos-arm64': {} } } }]), true);
  assert.equal(platform.hasArm64MacNatives(undefined), false);
  assert.equal(platform.usesLwjgl3(LWJGL2), false);
  assert.equal(platform.usesLwjgl3(LWJGL32), true);
  assert.equal(platform.usesLwjgl3(LWJGL33), true);
});

test('arquitectura del juego: Rosetta solo en Apple Silicon y sin nativos arm64', () => {
  const armMac = { platform: 'darwin', arch: 'arm64' };
  assert.equal(platform.gameArch({ libraries: LWJGL33 }, armMac), 'arm64'); // 1.19+
  assert.equal(platform.gameArch({ libraries: LWJGL32 }, armMac), 'x64'); // 1.13 a 1.18.2
  assert.equal(platform.gameArch({ libraries: LWJGL2 }, armMac), 'x64'); // 1.12.2 y anteriores
  assert.equal(platform.gameArch({ libraries: LWJGL2 }, { platform: 'darwin', arch: 'x64' }), 'x64'); // Mac Intel
  assert.equal(platform.gameArch({ libraries: LWJGL2 }, { platform: 'win32', arch: 'x64' }), 'x64');
  assert.equal(platform.gameArch({ libraries: LWJGL2 }, { platform: 'win32', arch: 'arm64' }), 'arm64'); // Windows no cambia
  assert.equal(platform.isAppleSilicon(armMac), true);
  assert.equal(platform.isAppleSilicon({ platform: 'darwin', arch: 'x64' }), false);
});

test('Rosetta 2: se busca solo en Apple Silicon', () => {
  const seen = [];
  const exists = (p) => (seen.push(p), true);
  assert.equal(platform.rosettaInstalled({ platform: 'darwin', arch: 'arm64', exists }), true);
  assert.deepEqual(seen, [platform.ROSETTA_RUNTIME]);
  assert.equal(platform.rosettaInstalled({ platform: 'darwin', arch: 'arm64', exists: () => false }), false);
  assert.equal(platform.rosettaInstalled({ platform: 'darwin', arch: 'arm64', exists: () => { throw new Error('x'); } }), false);
  assert.equal(platform.rosettaInstalled({ platform: 'darwin', arch: 'x64', exists: () => false }), true);
  assert.equal(platform.rosettaInstalled({ platform: 'win32', arch: 'arm64', exists: () => false }), true);
  assert.equal(platform.isBadCpuType({ errno: -86 }), true);
  assert.equal(platform.isBadCpuType(new Error('spawn Unknown system error -86')), true);
  assert.equal(platform.isBadCpuType(new Error('Bad CPU type in executable')), true);
  assert.equal(platform.isBadCpuType(Object.assign(new Error('spawn java ENOENT'), { code: 'ENOENT', errno: -2 })), false);
  assert.equal(platform.isBadCpuType(null), false);
  // Windows: la ruta de Java puede tener "-86" (usuario martin-86); eso no es falta de Rosetta.
  assert.equal(platform.isBadCpuType(Object.assign(new Error('spawn C:\\Users\\martin-86\\AppData\\Roaming\\.venuslauncher\\runtime\\jre-legacy\\bin\\javaw.exe ENOENT'), { code: 'ENOENT', errno: -4058 })), false);
  assert.equal(platform.isBadCpuType(Object.assign(new Error('spawn D:\\mc-86\\runtime\\bin\\javaw.exe EACCES'), { code: 'EACCES', errno: -4092 })), false);
});

test('Java que no arranca en Windows con "-86" en la ruta: se muestra el error real, no Rosetta', async () => {
  const launch = require('../launch');
  const java = require('path').join(require('os').tmpdir(), 'venus-no-existe-86', 'martin-86', 'javaw.exe');
  const lines = [];
  const code = await new Promise((resolve) => {
    launch.spawnGame({ java, args: [], cwd: require('os').tmpdir(), javaMajor: 8 }, { onLine: (l) => lines.push(l), onExit: resolve });
  });
  assert.equal(code, -1);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].level, 'ERROR');
  assert.ok(lines[0].text.includes('martin-86'), lines[0].text); // java.spawnFailed con el mensaje real
});

test('separador del classpath', () => {
  assert.equal(platform.classpathSeparator('win32'), ';');
  assert.equal(platform.classpathSeparator('darwin'), ':');
  assert.equal(platform.classpathSeparator('linux'), ':');
});

test('cerrar el juego en Windows: taskkill /T, con /F solo si se fuerza', () => {
  const calls = [];
  const spawnFn = (file, args) => (calls.push([file, args]), { on() {} });
  assert.equal(platform.stopProcess({ pid: 4242, platform: 'win32', spawnFn }), true);
  assert.equal(platform.stopProcess({ pid: 4242, force: false, platform: 'win32', spawnFn }), true);
  assert.deepEqual(calls, [
    ['taskkill', ['/pid', '4242', '/T', '/F']],
    ['taskkill', ['/pid', '4242', '/T']],
  ]);
  assert.equal(platform.stopProcess({ pid: 0, platform: 'win32', spawnFn }), false);
  assert.equal(platform.stopProcess({ pid: 'x', platform: 'win32', spawnFn }), false);
});

test('cerrar el juego en macOS: señales al grupo, sin taskkill; SIGKILL si sigue vivo', () => {
  const signals = [];
  let timer = null;
  const setTimer = (fn, ms) => ((timer = { fn, ms }), { unref() {} });
  const child = { pid: 900, exitCode: null, signalCode: null };
  const spawnFn = () => assert.fail('no usa taskkill en macOS');
  assert.equal(platform.stopProcess({ child, platform: 'darwin', spawnFn, killFn: (pid, sig) => signals.push([pid, sig]), setTimer }), true);
  assert.deepEqual(signals, [[-900, 'SIGTERM']]);
  assert.equal(timer.ms, 4000);
  timer.fn();
  assert.deepEqual(signals, [[-900, 'SIGTERM'], [-900, 'SIGKILL']]);

  // Ya terminó cuando vence el plazo: no se manda SIGKILL
  signals.length = 0;
  const done = { pid: 901, exitCode: 0, signalCode: null };
  platform.stopProcess({ child: done, platform: 'darwin', killFn: (pid, sig) => signals.push([pid, sig]), setTimer });
  timer.fn();
  assert.deepEqual(signals, [[-901, 'SIGTERM']]);

  // Cierre amable (control parental): solo SIGTERM, sin plazo
  signals.length = 0;
  timer = null;
  platform.stopProcess({ pid: 902, force: false, platform: 'darwin', killFn: (pid, sig) => signals.push([pid, sig]), setTimer });
  assert.deepEqual(signals, [[-902, 'SIGTERM']]);
  assert.equal(timer, null);

  // Sin grupo propio: al proceso solo
  signals.length = 0;
  const killFn = (pid, sig) => {
    if (pid < 0) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    signals.push([pid, sig]);
  };
  assert.equal(platform.stopProcess({ pid: 903, force: false, platform: 'darwin', killFn, setTimer }), true);
  assert.deepEqual(signals, [[903, 'SIGTERM']]);
  assert.equal(platform.stopProcess({ pid: 904, platform: 'darwin', killFn: () => { throw new Error('ESRCH'); }, setTimer }), false);
});

test('micrófono en macOS: pregunta una vez, respeta lo que el usuario negó; en Windows no hace nada', async () => {
  const calls = [];
  const prefs = (status, answer = true) => ({
    getMediaAccessStatus: (kind) => (calls.push(['status', kind]), status),
    askForMediaAccess: async (kind) => (calls.push(['ask', kind]), answer),
  });
  assert.equal(await platform.requestMediaAccess(['audio'], prefs('not-determined'), 'darwin'), true);
  assert.deepEqual(calls, [['status', 'microphone'], ['ask', 'microphone']]);
  calls.length = 0;
  assert.equal(await platform.requestMediaAccess(['audio'], prefs('granted'), 'darwin'), true);
  assert.deepEqual(calls, [['status', 'microphone']]);
  assert.equal(await platform.requestMediaAccess(['audio'], prefs('denied'), 'darwin'), false);
  assert.equal(await platform.requestMediaAccess(['audio'], prefs('not-determined', false), 'darwin'), false);
  // Sin lista (undefined): micrófono, como antes
  calls.length = 0;
  assert.equal(await platform.requestMediaAccess(undefined, prefs('not-determined'), 'darwin'), true);
  assert.deepEqual(calls, [['status', 'microphone'], ['ask', 'microphone']]);
  assert.equal(await platform.requestMediaAccess(undefined, prefs('denied'), 'darwin'), false);
  // Lista vacía: compartir pantalla. No depende del micrófono ni pregunta nada.
  calls.length = 0;
  assert.equal(await platform.requestMediaAccess([], prefs('denied'), 'darwin'), true);
  assert.equal(await platform.requestMediaAccess([], prefs('restricted'), 'darwin'), true);
  assert.equal(await platform.requestMediaAccess([], prefs('not-determined'), 'darwin'), true);
  assert.deepEqual(calls, []);
  assert.equal(await platform.requestMediaAccess(['video'], prefs('denied'), 'darwin'), false);
  calls.length = 0;
  assert.equal(await platform.requestMediaAccess(['audio'], prefs('denied'), 'win32'), true);
  assert.deepEqual(calls, []);
  const broken = { getMediaAccessStatus: () => { throw new Error('x'); }, askForMediaAccess: async () => { throw new Error('y'); } };
  assert.equal(await platform.requestMediaAccess(['audio'], broken, 'darwin'), false);
});

test('ventana de inicio de sesión de Microsoft: modal en Windows, ventana hija con botón de cerrar en macOS', () => {
  assert.equal(platform.loginWindowModal(true, 'win32'), true); // Windows igual que antes
  assert.equal(platform.loginWindowModal(false, 'win32'), false);
  assert.equal(platform.loginWindowModal(true, 'linux'), true);
  assert.equal(platform.loginWindowModal(true, 'darwin'), false); // sin hoja
  assert.equal(platform.loginWindowModal(false, 'darwin'), false);
  const key = (over) => ({ type: 'keyDown', key: 'w', meta: true, control: false, alt: false, shift: false, ...over });
  assert.equal(platform.isCloseWindowShortcut(key(), 'darwin'), true);
  assert.equal(platform.isCloseWindowShortcut(key({ key: 'W' }), 'darwin'), true);
  assert.equal(platform.isCloseWindowShortcut(key({ type: 'keyUp' }), 'darwin'), false);
  assert.equal(platform.isCloseWindowShortcut(key({ meta: false }), 'darwin'), false);
  assert.equal(platform.isCloseWindowShortcut(key({ shift: true }), 'darwin'), false);
  assert.equal(platform.isCloseWindowShortcut(key({ key: 'q' }), 'darwin'), false);
  assert.equal(platform.isCloseWindowShortcut(key(), 'win32'), false);
  assert.equal(platform.isCloseWindowShortcut(key({ meta: false, control: true }), 'win32'), false);
  assert.equal(platform.isCloseWindowShortcut(null, 'darwin'), false);
});

test('rótulos de teclas: ⌘ en macOS, sin tocar las teclas físicas', () => {
  const k = (s) => platform.keyLabel(s, 'darwin');
  assert.equal(k('Ctrl+K'), '⌘K');
  assert.equal(k('Asistente IA (Ctrl+J)'), 'Asistente IA (⌘J)');
  assert.equal(k('Ctrl+Shift+R'), '⇧⌘R');
  assert.equal(k('Ctrl + Enter también envía.'), '⌘ + Enter también envía.');
  assert.equal(k('pegala con Ctrl+V donde quieras'), 'pegala con ⌘V donde quieras');
  assert.equal(k('Ctrl izquierdo'), 'Ctrl izquierdo');
  assert.equal(k('Ctrl+Alt es AltGr'), 'Ctrl+Alt es AltGr');
  assert.equal(k('Usá Ctrl, Alt o Shift'), 'Usá Ctrl, Alt o Shift');
  assert.equal(k('Ctrl+rueda para el zoom'), 'Ctrl+rueda para el zoom');
  assert.equal(platform.keyLabel('Ctrl+K', 'win32'), 'Ctrl+K');
  assert.equal(platform.keyLabel(null, 'darwin'), null);
});
