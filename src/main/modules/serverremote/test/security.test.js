'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const sec = require('../security');

test('token: al menos 128 bits, alfabeto sin confusiones y distinto cada vez', () => {
  const bits = sec.TOKEN_CHARS * Math.log2(sec.ALPHABET.length);
  assert.ok(bits >= 128, `${bits} bits`);
  assert.equal(new Set(sec.ALPHABET).size, 32);
  assert.ok(!/[ILOU]/.test(sec.ALPHABET));
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const tk = sec.newToken();
    assert.equal(tk.length, sec.TOKEN_CHARS);
    assert.equal(sec.normalizeCode(tk), tk);
    seen.add(tk);
  }
  assert.equal(seen.size, 2000);
});

test('token: cada carácter sale parejo (sin sesgo)', () => {
  const counts = new Map();
  const rounds = 4000;
  for (let i = 0; i < rounds; i++) for (const c of sec.newToken()) counts.set(c, (counts.get(c) || 0) + 1);
  const expected = (rounds * sec.TOKEN_CHARS) / 32;
  assert.equal(counts.size, 32);
  for (const [c, n] of counts) assert.ok(Math.abs(n - expected) < expected * 0.15, `${c}: ${n} contra ${expected}`);
});

test('código: se escribe a mano con guiones, minúsculas y confusiones', () => {
  const tk = sec.newToken();
  const shown = sec.formatCode(tk);
  assert.match(shown, /^([0-9A-Z]{4}-){6}[0-9A-Z]{4}$/);
  assert.equal(sec.normalizeCode(shown), tk);
  assert.equal(sec.normalizeCode(` ${shown.toLowerCase()} `), tk);
  assert.equal(sec.normalizeCode('O1IL'.repeat(7)), '0111'.repeat(7));
  for (const bad of ['', null, undefined, 'corto', 'U'.repeat(28), `${tk}A`, '<script>', 'A'.repeat(5000)]) assert.equal(sec.normalizeCode(bad), null, String(bad));
});

test('sameToken: solo con el mismo valor', () => {
  const tk = sec.newToken();
  assert.equal(sec.sameToken(tk, tk), true);
  assert.equal(sec.sameToken(tk, `${tk}A`), false);
  assert.equal(sec.sameToken(tk, tk.slice(0, -1)), false);
  assert.equal(sec.sameToken(tk, sec.newToken()), false);
  for (const bad of ['', null, undefined, 123, {}]) {
    assert.equal(sec.sameToken(bad, tk), false);
    assert.equal(sec.sameToken(tk, bad), false);
  }
});

test('Host: exactamente la IP y el puerto reales (DNS rebinding)', () => {
  assert.equal(sec.hostAllowed('192.168.0.5:50000', '192.168.0.5', 50000), true);
  for (const bad of [
    undefined,
    '',
    '192.168.0.5',
    '192.168.0.5:50001',
    '192.168.0.6:50000',
    'evil.example:50000',
    'evil.example',
    'localhost:50000',
    '127.0.0.1:50000',
    '192.168.0.5.evil.example:50000',
    '192.168.0.5:50000.evil.example',
    '[::1]:50000',
    '0.0.0.0:50000',
    ['192.168.0.5:50000'],
  ]) {
    assert.equal(sec.hostAllowed(bad, '192.168.0.5', 50000), false, String(bad));
  }
});

test('Host repetido: se rechaza', () => {
  assert.equal(sec.singleHost(['Host', 'a', 'Accept', 'b']), true);
  assert.equal(sec.singleHost(['Host', 'a', 'host', 'b']), false);
  assert.equal(sec.singleHost(['Accept', 'b']), false);
  assert.equal(sec.singleHost(undefined), false);
});

test('Origin: ausente o esta misma página', () => {
  assert.equal(sec.originAllowed(undefined, '192.168.0.5', 50000), true);
  assert.equal(sec.originAllowed('http://192.168.0.5:50000', '192.168.0.5', 50000), true);
  for (const bad of ['null', '', 'http://evil.example', 'https://192.168.0.5:50000', 'http://192.168.0.5:50001', 'http://192.168.0.5:50000/']) assert.equal(sec.originAllowed(bad, '192.168.0.5', 50000), false, bad);
});

test('Fetch Metadata: de otro sitio no pasa', () => {
  for (const ok of [undefined, 'same-origin', 'none']) assert.equal(sec.fetchSiteAllowed(ok), true);
  for (const bad of ['cross-site', 'same-site']) assert.equal(sec.fetchSiteAllowed(bad), false);
});

test('direcciones: solo privadas de la red de la casa, y nunca 0.0.0.0, pública, VPN ni virtual', () => {
  const list = [
    { name: 'Wi-Fi', address: '203.0.113.9', kind: 'lan' },
    { name: 'Tailscale', address: '100.100.1.2', kind: 'vpn' },
    { name: 'CGNAT', address: '100.64.0.5', kind: 'lan' },
    { name: 'Hamachi', address: '25.1.2.3', kind: 'vpn' },
    { name: 'vEthernet (WSL)', address: '172.20.0.1', kind: 'virtual' },
    { name: 'Todas', address: '0.0.0.0', kind: 'lan' },
    { name: 'Loopback', address: '127.0.0.1', kind: 'lan' },
    { name: 'Link-local', address: '169.254.10.1', kind: 'lan' },
    { name: 'Oficina', address: '172.16.0.8', kind: 'lan' },
    { name: 'Router', address: '10.0.0.7', kind: 'lan' },
    { name: 'Casa', address: '192.168.1.20', kind: 'lan' },
    null,
    { name: 'Sin dirección', kind: 'lan' },
  ];
  assert.deepEqual(sec.lanAddresses(list).map((a) => a.address), ['192.168.1.20', '10.0.0.7', '172.16.0.8']);
  assert.deepEqual(sec.lanAddresses(undefined), []);
});

test('quien pide tiene que estar en una red privada', () => {
  for (const ok of ['192.168.0.2', '10.1.2.3', '172.16.0.1', '172.31.255.255', '127.0.0.1']) assert.equal(sec.peerAllowed(ok), true, ok);
  for (const bad of ['203.0.113.9', '8.8.8.8', '100.64.0.1', '172.32.0.1', '169.254.1.1', '0.0.0.0', '::1', '2001:db8::1', '', null, undefined, 'evil']) assert.equal(sec.peerAllowed(bad), false, String(bad));
});

test('límite de intentos: bloquea, avisa la espera y se libera', () => {
  let clock = 1000;
  const lim = new sec.Limiter({ max: 3, windowMs: 1000, blockMs: 5000, now: () => clock });
  assert.equal(lim.retryAfter('a'), 0);
  lim.fail('a');
  lim.fail('a');
  assert.equal(lim.retryAfter('a'), 0);
  lim.fail('a');
  assert.equal(lim.retryAfter('a'), 5);
  assert.equal(lim.retryAfter('b'), 0);
  clock += 2000;
  assert.equal(lim.retryAfter('a'), 3);
  clock += 3001;
  assert.equal(lim.retryAfter('a'), 0);
  // Fallas viejas fuera de la ventana no se acumulan
  lim.fail('c');
  lim.fail('c');
  clock += 1001;
  lim.fail('c');
  assert.equal(lim.retryAfter('c'), 0);
});

test('límite de intentos: la memoria no crece sin tope', () => {
  const lim = new sec.Limiter({ maxKeys: 8 });
  for (let i = 0; i < 1000; i++) lim.fail(`ip${i}`);
  assert.ok(lim.keys.size <= 8);
});

test('acciones: lista cerrada', () => {
  assert.deepEqual(sec.parseAction('{"action":"start"}'), { action: 'start' });
  assert.deepEqual(sec.parseAction('{"action":"stop","confirm":true}'), { action: 'stop' });
  assert.deepEqual(sec.parseAction('{"action":"restart","confirm":true}'), { action: 'restart' });
  assert.deepEqual(sec.parseAction('{"action":"command","command":"  list ","confirm":true}'), { action: 'command', command: 'list' });
  const codes = {
    'no es json': 'bad_json',
    '[]': 'bad_json',
    null: 'bad_json',
    '"start"': 'bad_json',
    '{}': 'unknown_action',
    '{"action":"kill"}': 'unknown_action',
    '{"action":"__proto__"}': 'unknown_action',
    '{"action":"constructor"}': 'unknown_action',
    '{"action":"toString"}': 'unknown_action',
    '{"action":1}': 'unknown_action',
    '{"action":"start","x":1}': 'bad_field',
    '{"action":"start","command":"op yo"}': 'bad_field',
    '{"action":"stop"}': 'confirm_required',
    '{"action":"stop","confirm":"true"}': 'confirm_required',
    '{"action":"restart"}': 'confirm_required',
    '{"action":"command","command":"list"}': 'confirm_required',
    '{"action":"command","confirm":true}': 'bad_command',
    '{"action":"command","command":"","confirm":true}': 'bad_command',
    '{"action":"command","command":"   ","confirm":true}': 'bad_command',
    '{"action":"command","command":1,"confirm":true}': 'bad_command',
    '{"action":"command","command":"a\\nop yo","confirm":true}': 'bad_command',
    '{"action":"command","command":"a\\rb","confirm":true}': 'bad_command',
    '{"action":"command","command":"a\\u2028b","confirm":true}': 'bad_command',
  };
  for (const [raw, code] of Object.entries(codes)) assert.throws(() => sec.parseAction(raw), (err) => err.code === code, raw);
  assert.throws(() => sec.parseAction(JSON.stringify({ action: 'command', command: 'x'.repeat(sec.MAX_COMMAND + 1), confirm: true })), (err) => err.code === 'bad_command');
  assert.deepEqual(Object.keys(sec.ACTIONS).sort(), ['command', 'restart', 'start', 'stop']);
});

test('consola: saca las direcciones y deja el resto', () => {
  assert.equal(sec.redactLine('[12:30:45] [Server thread/INFO]: Steve[/192.168.0.20:51234] logged in with entity id 7'), '[12:30:45] [Server thread/INFO]: Steve[/•••] logged in with entity id 7');
  assert.equal(sec.redactLine('Steve[/[2001:db8::1]:51234] logged in'), 'Steve[/•••] logged in');
  assert.equal(sec.redactLine('Steve[/[::1]:51234] logged in'), 'Steve[/•••] logged in');
  assert.equal(sec.redactLine('Starting server on 8.8.8.8'), 'Starting server on •••');
  assert.equal(sec.redactLine('[12:30:45] Done (3.456s)! For help'), '[12:30:45] Done (3.456s)! For help');
  assert.equal(sec.redactLine('[Server thread/INFO]: Starting minecraft server version 1.21.4'), '[Server thread/INFO]: Starting minecraft server version 1.21.4');
  assert.equal(sec.redactLine('x'.repeat(5000)).length, 600);
  assert.equal(sec.redactLine(null), '');
});

test('dispositivo: lista cerrada, el User-Agent crudo nunca sale', () => {
  assert.deepEqual(sec.deviceInfo('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36'), { os: 'Android', browser: 'Chrome' });
  assert.deepEqual(sec.deviceInfo('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Version/17 Mobile Safari/604.1'), { os: 'iPhone', browser: 'Safari' });
  assert.deepEqual(sec.deviceInfo('SamsungBrowser/24 Android Chrome'), { os: 'Android', browser: 'Samsung' });
  assert.deepEqual(sec.deviceInfo('<img src=x onerror=alert(1)>'), { os: null, browser: null });
  assert.deepEqual(sec.deviceInfo(undefined), { os: null, browser: null });
});

test('IP sin el prefijo de IPv4 mapeada', () => {
  assert.equal(sec.cleanIp('::ffff:192.168.0.5'), '192.168.0.5');
  assert.equal(sec.cleanIp('192.168.0.5'), '192.168.0.5');
  assert.equal(sec.cleanIp(undefined), '');
});
