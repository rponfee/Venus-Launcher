'use strict';
// Pruebas de la detección de errores de red (inicio de sesión y tareas), en varios idiomas.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { createClassifier, templateRegex } = require('../classify');

// Textos reales del launcher (proceso principal) en español, inglés y japonés.
const I18N = path.join(__dirname, '..', '..', '..', 'i18n');
const dict = (lang, ns) => require(path.join(I18N, lang, `${ns}.js`));
const LANGS = ['es', 'en', 'ja'];
const templates = [];
const disk = [];
for (const lang of LANGS) {
  const s = dict(lang, 'storage');
  templates.push({ text: s.errOffline, offline: true }, { text: s.errNetwork }, { text: s.errTimeout }, { text: s.errSomeFailed_one }, { text: s.errSomeFailed_other });
  templates.push({ text: dict(lang, 'modrinth').errNetwork, ids: ['modrinth'] });
  disk.push(s.errNoSpace, s.errDiskAccess, s.errDisk);
}
const classify = createClassifier({ templates, disk });
const fill = (text, vars) => text.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));

test('inicio de sesión: errores de la cuenta no consultan nada', () => {
  for (const code of ['cancelled', 'noGame', 'noProfile', 'noProfileOrGame', 'codeExpired', 'mcRateLimited', 'xerr_2148916233', 'xerr_2148916238']) {
    const c = classify({ source: 'login', code });
    assert.equal(c.autoCheck, false, code);
    assert.equal(c.network, false, code);
  }
});

test('inicio de sesión: red, rechazos sin 5xx o un error desconocido -> se comprueba solo', () => {
  const es = dict('es', 'accounts');
  const cases = [
    ['network', fill(es.network, { service: 'Xbox Live' })],
    ['msRejected', fill(es.msRejected, { detail: 'invalid_request' })],
    ['xblFailed', fill(es.xblFailed, { status: 400 })],
    ['xstsFailed', fill(es.xstsFailed, { code: 2148916239 })],
    ['mcLoginFailed', fill(es.mcLoginFailed, { status: 403 })],
    ['profileFailed', fill(es.profileFailed, { status: 401 })],
    ['unavailable', es.unavailable],
    ['', ''],
    [undefined, undefined],
  ];
  for (const [code, text] of cases) {
    const c = classify({ source: 'login', code, text });
    assert.equal(c.autoCheck, true, String(code));
    assert.equal(c.known, undefined, String(code));
    assert.deepEqual(c.ids, ['microsoft', 'xbox', 'minecraftServices']);
    assert.equal(c.focus, 'login');
  }
});

test('inicio de sesión: el error ya prueba que el servicio falló de su lado -> se dice sin consultar', () => {
  for (const lang of LANGS) {
    const a = dict(lang, 'accounts');
    const cases = [
      ['msUnavailable', a.msUnavailable, 'microsoft'],
      ['msRejected', fill(a.msRejected, { detail: 'server_error' }), 'microsoft'],
      ['msRejected', fill(a.msRejected, { detail: 'temporarily_unavailable' }), 'microsoft'],
      ['xblFailed', fill(a.xblFailed, { status: 503 }), 'xbox'],
      ['xstsFailed', fill(a.xstsFailed, { code: 'HTTP 502' }), 'xbox'],
      ['mcLoginFailed', fill(a.mcLoginFailed, { status: 500 }), 'minecraftServices'],
      ['profileFailed', fill(a.profileFailed, { status: 504 }), 'minecraftServices'],
    ];
    for (const [code, text, id] of cases) {
      const c = classify({ source: 'login', code, text });
      assert.equal(c.autoCheck, false, `${lang} ${code}`);
      assert.deepEqual(c.known, { kind: 'down', ids: [id] }, `${lang} ${code}`);
      assert.deepEqual(c.ids, [id]);
      assert.equal(c.focus, 'login');
    }
  }
  // Un código de cuenta nunca se toma como caída aunque el texto tenga un número parecido.
  assert.equal(classify({ source: 'login', code: 'xerr_2148916235', text: 'error 500' }).network, false);
  // Un XErr de 10 cifras no es un 5xx.
  assert.equal(classify({ source: 'login', code: 'xstsFailed', text: 'Xbox Live rechazó la cuenta (error 2148916239).' }).known, undefined);
});

test('tareas: errores de red en cualquier idioma, con el servicio del host', () => {
  for (const lang of LANGS) {
    const s = dict(lang, 'storage');
    const c = classify({ source: 'task', text: fill(s.errNetwork, { host: 'piston-meta.mojang.com', error: 'ENOTFOUND' }) });
    assert.equal(c.network, true, lang);
    assert.deepEqual(c.ids, ['mojangMeta'], lang);
    assert.equal(c.focus, 'downloads');
    assert.equal(c.autoCheck, false);
    const timeout = classify({ source: 'task', text: fill(s.errTimeout, { host: 'cdn.modrinth.com' }) });
    assert.deepEqual([timeout.network, timeout.ids, timeout.focus], [true, ['modrinth'], 'content'], lang);
  }
});

test('tareas: códigos y frases de red sin plantilla', () => {
  for (const text of ['connect ETIMEDOUT 1.2.3.4:443', 'socket hang up', 'TypeError: fetch failed', 'read ECONNRESET', 'getaddrinfo EAI_AGAIN libraries.minecraft.net', 'self-signed certificate in certificate chain (SELF_SIGNED_CERT_IN_CHAIN)']) {
    assert.equal(classify({ source: 'task', text }).network, true, text);
  }
  const lib = classify({ source: 'task', text: 'getaddrinfo EAI_AGAIN libraries.minecraft.net' });
  assert.deepEqual(lib.ids, ['mojangLibraries']);
});

test('tareas: 5xx sí, 4xx no', () => {
  const c = classify({ source: 'task', text: 'HTTP 503 en https://api.modrinth.com/v2/project/sodium' });
  assert.deepEqual([c.network, c.ids, c.focus], [true, ['modrinth'], 'content']);
  assert.equal(classify({ source: 'task', text: 'HTTP 404 en https://api.modrinth.com/v2/project/nada' }).network, false);
  const cf = classify({ source: 'task', text: 'HTTP 502 at https://edge.forgecdn.net/files/1/2/x.jar' });
  assert.deepEqual(cf.ids, ['curseforge']);
});

test('tareas: un "HTTP 5xx en <url>" dice qué servicio falló de su lado (known), lo demás no', () => {
  const s = dict('es', 'storage');
  const some = classify({ source: 'task', text: fill(s.errSomeFailed_other, { count: 2, name: 'sodium.jar', error: 'HTTP 503 en https://cdn.modrinth.com/data/AANobbMI/sodium.jar' }) });
  assert.deepEqual(some.known, { kind: 'down', ids: ['modrinth'] });
  assert.deepEqual(classify({ source: 'task', text: 'HTTP 500（https://piston-meta.mojang.com/mc/game/version_manifest_v2.json）' }).known, { kind: 'down', ids: ['mojangMeta'] });
  // 5xx de un host que no se comprueba (un maven de loaders): es de la red, pero sin servicio conocido
  const maven = classify({ source: 'task', text: 'HTTP 502 en https://maven.neoforged.net/releases/x.jar' });
  assert.deepEqual([maven.network, maven.known], [true, undefined]);
  // Errores de red sin respuesta del servidor: no se sabe si es de ellos
  assert.equal(classify({ source: 'task', text: fill(s.errNetwork, { host: 'cdn.modrinth.com', error: 'ETIMEDOUT' }) }).known, undefined);
  assert.equal(classify({ source: 'task', text: fill(s.errSomeFailed_one, { count: 1, name: 'x.jar', error: 'HTTP 404 en https://cdn.modrinth.com/x.jar' }) }).known, undefined);
});

test('tareas: modo sin conexión, descargas fallidas y plantilla con servicio propio', () => {
  const off = classify({ source: 'task', text: fill(dict('es', 'storage').errOffline, { host: 'piston-meta.mojang.com' }) });
  assert.equal(off.network, true);
  assert.equal(off.offline, true);
  const some = classify({ source: 'task', text: fill(dict('en', 'storage').errSomeFailed_other, { count: 3, name: 'x.jar', error: 'boom' }) });
  assert.equal(some.network, true);
  const mr = classify({ source: 'task', text: dict('en', 'modrinth').errNetwork });
  assert.deepEqual(mr.ids, ['modrinth']);
});

test('tareas: lo que no es de la red no ofrece el panel', () => {
  const s = dict('es', 'storage');
  for (const text of [
    fill(s.errNoSpace, { name: 'x.jar' }),
    fill(s.errSomeFailed_one, { count: 1, name: 'x.jar', error: fill(s.errNoSpace, { name: 'x.jar' }) }),
    'Cancelado por el usuario',
    'Java 21 no está instalado',
    // Crashes de Java y errores de archivos: nada de red
    'Exception in thread "main" java.lang.NullPointerException: Cannot invoke "Object.toString()"',
    'java.lang.OutOfMemoryError: Java heap space',
    'net.minecraftforge.installertools.ConsoleTool falló (código 1): java.lang.IllegalStateException: Mixin apply failed',
    "EACCES: permission denied, open 'C:\\Users\\x\\mods\\sodium.jar'",
    "EPERM: operation not permitted, rename 'a.part' -> 'a.jar'",
    'ENOSPC: no space left on device, write',
    'This operation was aborted',
    'Hash sha1 inválido para sodium-fabric-0.6.0.jar',
    'HTTP 404 en https://cdn.modrinth.com/data/AANobbMI/versions/x/sodium.jar',
    '',
  ]) {
    assert.equal(classify({ source: 'task', text }).network, false, text);
  }
  assert.equal(classify(null).network, false);
  assert.equal(classify({ source: 'task', text: 42 }).network, false);
});

test('tareas: errores de red de Java (instaladores de loaders) y el tiempo agotado de fetch', () => {
  for (const text of [
    'processor falló (código 1):\njava.net.UnknownHostException: piston-data.mojang.com',
    'java.net.SocketTimeoutException: connect timed out',
    'java.net.ConnectException: Connection refused: connect',
    'javax.net.ssl.SSLHandshakeException: PKIX path building failed',
    'TimeoutError: The operation was aborted due to timeout',
  ]) {
    assert.equal(classify({ source: 'task', text }).network, true, text);
  }
  assert.deepEqual(classify({ source: 'task', text: 'java.net.UnknownHostException: piston-data.mojang.com' }).ids, ['mojangMeta']);
});

test('textos enormes no traban nada', () => {
  const t0 = Date.now();
  classify({ source: 'task', text: `${'No se pudo conectar con '.repeat(5000)}x` });
  assert.ok(Date.now() - t0 < 500);
});

test('plantillas casi sin texto fijo se descartan', () => {
  assert.equal(templateRegex('{host}: {error}'), null);
  assert.equal(templateRegex(''), null);
  assert.ok(templateRegex('No se pudo conectar con {host} ({error}).').test('No se pudo conectar con a.b (X).'));
});
