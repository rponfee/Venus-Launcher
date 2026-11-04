'use strict';
// Parser de los links venus:// y su cola. node --test "src/main/modules/deeplink/test/"
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseLink, findLink, parseServer, cleanName } = require('../parse');
const { createLinkQueue, MAX_PENDING } = require('../queue');

test('modpack de Modrinth: slug o id, con versión opcional', () => {
  assert.deepEqual(parseLink('venus://modpack/modrinth/fabulously-optimized'), { kind: 'modpack', source: 'modrinth', project: 'fabulously-optimized', version: null, link: 'venus://modpack/modrinth/fabulously-optimized' });
  assert.deepEqual(parseLink('venus://modpack/modrinth/1KVo5zza?version=AbCd1234'), { kind: 'modpack', source: 'modrinth', project: '1KVo5zza', version: 'AbCd1234', link: 'venus://modpack/modrinth/1KVo5zza?version=AbCd1234' });
  assert.equal(parseLink('VENUS://MODPACK/MODRINTH/sodium')?.project, 'sodium');
  assert.equal(parseLink('venus://modpack/modrinth/sodium/')?.project, 'sodium');
});

test('modpack de Modrinth: id o versión con forma rara', () => {
  for (const link of [
    'venus://modpack/modrinth/',
    'venus://modpack/modrinth/../../etc',
    'venus://modpack/modrinth/..',
    'venus://modpack/modrinth/a..b',
    'venus://modpack/modrinth/.hidden',
    'venus://modpack/modrinth/sodium/extra',
    'venus://modpack/modrinth/sodium?version=../x',
    'venus://modpack/modrinth/sodium?version=',
    'venus://modpack/modrinth/sodium?version=abc',
    'venus://modpack/modrinth/sodium?version=AAAA1111&version=BBBB2222',
    `venus://modpack/modrinth/${'a'.repeat(65)}`,
    'venus://modpack/hangar/sodium',
    'venus://modpack/sodium',
  ]) {
    assert.equal(parseLink(link), null, link);
  }
});

test('un parámetro desconocido se ignora', () => {
  assert.equal(parseLink('venus://modpack/modrinth/sodium?utm=abc&x=1')?.project, 'sodium');
  assert.equal(parseLink('venus://modpack/modrinth/sodium?utm=abc')?.link, 'venus://modpack/modrinth/sodium');
  assert.equal(parseLink('venus://instance/mi-instancia?play=1')?.link, 'venus://instance/mi-instancia');
});

test('modpack de CurseForge: solo un número positivo', () => {
  assert.deepEqual(parseLink('venus://modpack/curseforge/285109'), { kind: 'modpack', source: 'curseforge', modId: 285109, link: 'venus://modpack/curseforge/285109' });
  for (const link of ['venus://modpack/curseforge/0', 'venus://modpack/curseforge/-1', 'venus://modpack/curseforge/12a', 'venus://modpack/curseforge/0123', 'venus://modpack/curseforge/99999999999', 'venus://modpack/curseforge/2147483648', 'venus://modpack/curseforge/1/2']) {
    assert.equal(parseLink(link), null, link);
  }
});

test('servidor: dominio, IP y puerto', () => {
  const a = parseLink('venus://server/play.hypixel.net');
  assert.equal(a.kind, 'server');
  assert.equal(a.address, 'play.hypixel.net');
  assert.equal(a.port, null);
  assert.equal(a.lan, false);
  assert.equal(parseLink('venus://server/Play.Example.COM:25570')?.address, 'play.example.com:25570');
  assert.equal(parseLink('venus://server/8.8.8.8:1')?.port, 1);
  assert.equal(parseLink('venus://server/[2606:4700::1111]:25565')?.address, '[2606:4700::1111]:25565');
  assert.equal(parseLink('venus://server/xn--mnchen-3ya.de')?.host, 'xn--mnchen-3ya.de');
});

test('servidor: la red privada se marca para avisar', () => {
  for (const host of ['192.168.0.10', '10.1.2.3', '172.16.0.1', '100.64.0.1', 'casa.local']) assert.equal(parseServer(host).lan, true, host);
  assert.equal(parseServer('[fd00::1]').lan, true);
  assert.equal(parseServer('172.32.0.1').lan, false);
});

test('servidor: intentos raros', () => {
  for (const link of [
    'venus://server/',
    'venus://server/localhost',
    'venus://server/localhost:25565',
    'venus://server/algo.localhost',
    'venus://server/miserver',
    'venus://server/127.0.0.1',
    'venus://server/127.1',
    'venus://server/0.0.0.0',
    'venus://server/169.254.1.1',
    'venus://server/224.0.0.1',
    'venus://server/2130706433',
    'venus://server/0x7f.0.0.1',
    'venus://server/0177.0.0.1',
    'venus://server/1.2.3.256',
    'venus://server/[::1]',
    'venus://server/[::]',
    'venus://server/[0:0:0:0:0:0:0:1]',
    'venus://server/[::ffff:127.0.0.1]',
    'venus://server/[fe80::1]',
    'venus://server/[zz::1]',
    'venus://server/[2606:4700::1111',
    'venus://server/user@example.com',
    'venus://server/user:pw@example.com',
    'venus://server/example.com:0',
    'venus://server/example.com:65536',
    'venus://server/example.com:port',
    'venus://server/example.com:25565:25565',
    'venus://server/exa_mple.com',
    'venus://server/-example.com',
    'venus://server/example-.com',
    'venus://server/example..com',
    'venus://server/.example.com',
    'venus://server/example.com.',
    'venus://server/example.com/extra',
    'venus://server/ex%61mple.com',
    'venus://server/example%2ecom',
    `venus://server/${'a'.repeat(64)}.com`,
    `venus://server/${'a.'.repeat(130)}com`,
  ]) {
    assert.equal(parseLink(link), null, link);
  }
});

test('servidor: el nombre es solo para mostrar y se limpia', () => {
  assert.equal(parseLink('venus://server/example.com?name=Mi%20Server')?.name, 'Mi Server');
  assert.equal(parseLink('venus://server/example.com?name=Mi+Server')?.name, 'Mi Server');
  assert.equal(parseLink('venus://server/example.com')?.name, null);
  // caracteres de control, marcas de dirección, códigos de color y etiquetas
  assert.equal(cleanName('%C2%A7cRojo'), 'Rojo');
  assert.equal(cleanName('a%E2%80%AEb'), 'ab');
  assert.equal(cleanName('%3Cscript%3Ex%3C%2Fscript%3E'), 'scriptx/script');
  assert.equal(cleanName('a%0Ab'), 'ab');
  // un nombre malo no invalida el link: queda sin nombre
  const long = parseLink(`venus://server/example.com?name=${'a'.repeat(41)}`);
  assert.equal(long.name, null);
  assert.equal(long.address, 'example.com');
  assert.equal(parseLink('venus://server/example.com?name=%E0%A4%A')?.name, null);
  assert.equal(parseLink('venus://server/example.com?name=ok')?.link, 'venus://server/example.com?name=ok');
  assert.equal(parseLink('venus://server/example.com?name=a&name=b'), null);
});

test('instancia: un solo segmento seguro', () => {
  assert.deepEqual(parseLink('venus://instance/fabric-1.21-a1b2'), { kind: 'instance', id: 'fabric-1.21-a1b2', link: 'venus://instance/fabric-1.21-a1b2' });
  for (const link of ['venus://instance/', 'venus://instance/..', 'venus://instance/../..', 'venus://instance/a/b', 'venus://instance/a..b', 'venus://instance/%2e%2e', 'venus://instance/a%2fb', 'venus://instance/con', 'venus://instance/NUL.txt', 'venus://instance/.venus', `venus://instance/${'a'.repeat(81)}`]) {
    assert.equal(parseLink(link), null, link);
  }
});

test('lo que no es un link válido se ignora', () => {
  for (const value of [
    null,
    undefined,
    42,
    {},
    '',
    'venus://',
    'venus:',
    'venus:/server/example.com',
    'https://example.com',
    'javascript:alert(1)',
    'venus://desconocido/algo',
    'venus://server',
    'venus://instance',
    'venus://server//example.com',
    'venus://server/example.com#fragmento',
    'venus://server/example.com?name=a b',
    'venus://server/example.com\n',
    'venus://server/exam\tple.com',
    'venus://server\\example.com',
    'venus://server/example.com" --gpu-launcher="calc',
    "venus://server/example.com' onerror='x",
    'venus://server/<script>',
    'venus://modpack/modrinth/sodium?version=AAAA1111#x',
    `venus://modpack/modrinth/sodium?x=${'a'.repeat(600)}`,
  ]) {
    assert.equal(parseLink(value), null, String(value));
  }
});

test('findLink toma el primer venus:// de los argumentos', () => {
  const argv = ['C:\\Venus.exe', '--flag', 'venus://server/example.com', 'venus://instance/otra'];
  assert.equal(findLink(argv)?.kind, 'server');
  assert.equal(findLink(['venus.exe', '--play-instance=x']), null);
  assert.equal(findLink(['venus.exe', 'venus://nada/x', 'venus://instance/otra']), null);
  assert.equal(findLink('venus://server/example.com'), null);
  assert.equal(findLink(undefined), null);
});

test('cola: espera a la interfaz, no repite y no crece sin límite', () => {
  const sent = [];
  let clock = 1000;
  const q = createLinkQueue((a) => sent.push(a.link), { now: () => clock });
  assert.equal(q.push(null), false);
  assert.equal(q.push({ link: 'venus://a/1' }), true);
  assert.equal(q.push({ link: 'venus://a/1' }), false, 'el mismo link enseguida no se repite');
  assert.equal(sent.length, 0, 'sin interfaz no se manda nada');
  assert.equal(q.ready(), 1);
  assert.deepEqual(sent, ['venus://a/1']);
  q.push({ link: 'venus://a/2' });
  assert.deepEqual(sent, ['venus://a/1', 'venus://a/2'], 'con interfaz se manda enseguida');
  assert.equal(q.ready(), 0, 'una recarga no vuelve a mandar nada');
  clock += 3000;
  assert.equal(q.push({ link: 'venus://a/1' }), true, 'pasado un rato se puede volver a abrir');

  const full = createLinkQueue(() => {}, { now: () => 0 });
  for (let i = 0; i < MAX_PENDING + 3; i++) full.push({ link: `venus://a/${i}` });
  assert.equal(full.size(), MAX_PENDING);
});
