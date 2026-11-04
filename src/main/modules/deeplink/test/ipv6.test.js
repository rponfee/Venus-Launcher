'use strict';
// Direcciones de ejemplo: solo clasificación, sin DNS ni conexiones.
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseServer } = require('../parse');

test('las representaciones equivalentes de IPv4 privada mapeada conservan el aviso LAN', () => {
  const hosts = ['[::ffff:192.168.1.5]', '[::ffff:c0a8:105]', '[0:0:0:0:0:ffff:c0a8:0105]'];
  for (const host of hosts) {
    const parsed = parseServer(host);
    assert.equal(parsed.lan, true);
    assert.equal(parsed.host, host.slice(1, -1));
  }
});

test('una IPv4 de documentación mapeada sigue siendo no privada en ambas notaciones', () => {
  for (const host of ['[::ffff:192.0.2.5]', '[::ffff:c000:205]', '[0:0:0:0:0:ffff:c000:0205]']) {
    assert.equal(parseServer(host).lan, false);
  }
});

test('la notación IPv6 nativa conserva clasificación y puerto', () => {
  assert.equal(parseServer('[fd00:0:0:0:0:0:0:5]:25565').lan, true);
  const parsed = parseServer('[2001:db8::5]:25565');
  assert.equal(parsed.lan, false);
  assert.equal(parsed.port, 25565);
});
