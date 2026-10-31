'use strict';
// Pruebas del módulo discord con Node puro (sin Electron ni Discord real):
//   node src/main/modules/discord/selftest.js
// Usa un servidor IPC falso en una tubería/socket propio (no toca el discord-ipc-N real).
const net = require('net');
const os = require('os');
const path = require('path');
const fs = require('fs');
const assert = require('assert/strict');
const i18n = require('../../core/i18n');
const { OP, encode, FrameDecoder, candidatePaths, DiscordIpc } = require('./ipc');
const { buildActivity, testActivity, config, clamp, isPrivateAddress, normalizeButtons, validClientId } = require('./activity');
const { PresenceManager } = require('./presence');

i18n.setLanguage('es');
const { t } = i18n;
const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push(['ok', name]);
  } catch (err) {
    results.push(['FALLÓ', name, err]);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(25);
  }
  throw new Error('tiempo de espera agotado');
}

// ---------- Servidor IPC falso ----------
function pipePath(tag) {
  return process.platform === 'win32' ? `\\\\?\\pipe\\venus-selftest-${process.pid}-${tag}` : path.join(os.tmpdir(), `venus-selftest-${process.pid}-${tag}.sock`);
}

function fakeDiscord(p, { validClient = '123456789012345678' } = {}) {
  const srv = { frames: [], sockets: new Set(), server: null };
  srv.server = net.createServer((sock) => {
    srv.sockets.add(sock);
    const dec = new FrameDecoder();
    sock.on('data', (chunk) => {
      for (const f of dec.push(chunk)) {
        srv.frames.push(f);
        if (f.op === OP.HANDSHAKE) {
          if (f.data.client_id !== validClient) {
            sock.write(encode(OP.CLOSE, { code: 4000, message: 'Invalid Client ID' }));
            sock.end();
            continue;
          }
          // Respuesta partida en dos pedazos para probar el decodificador del cliente
          const ready = encode(OP.FRAME, { cmd: 'DISPATCH', evt: 'READY', data: { v: 1, user: { id: '80351110224678912', username: 'nelly', global_name: 'Nelly', avatar: null } } });
          sock.write(ready.subarray(0, 5));
          setTimeout(() => sock.write(ready.subarray(5)), 10);
          // Un PING de Discord: el cliente tiene que contestar PONG
          setTimeout(() => sock.write(encode(OP.PING, { n: 1 })), 30);
        } else if (f.op === OP.FRAME && f.data.cmd === 'SET_ACTIVITY') {
          const a = f.data.args.activity;
          if (a && a.buttons && a.buttons.some((b) => !/^https?:/.test(b.url))) {
            sock.write(encode(OP.FRAME, { cmd: 'SET_ACTIVITY', evt: 'ERROR', nonce: f.data.nonce, data: { code: 4000, message: 'child "activity" fails' } }));
          } else {
            sock.write(encode(OP.FRAME, { cmd: 'SET_ACTIVITY', evt: null, nonce: f.data.nonce, data: a || null }));
          }
        }
      }
    });
    sock.on('close', () => srv.sockets.delete(sock));
    sock.on('error', () => {});
  });
  srv.listen = () => new Promise((r) => srv.server.listen(p, r));
  srv.close = () =>
    new Promise((r) => {
      for (const s of srv.sockets) s.destroy();
      srv.server.close(() => r());
    });
  srv.activities = () => srv.frames.filter((f) => f.op === OP.FRAME && f.data.cmd === 'SET_ACTIVITY').map((f) => f.data.args);
  return srv;
}

(async () => {
  // ---------- Frames ----------
  await test('encode: cabecera int32 LE + JSON', () => {
    const b = encode(OP.HANDSHAKE, { v: 1, client_id: '42' });
    assert.equal(b.readInt32LE(0), 0);
    assert.equal(b.readInt32LE(4), b.length - 8);
    assert.deepEqual(JSON.parse(b.subarray(8).toString()), { v: 1, client_id: '42' });
  });
  await test('decoder: frames partidos y varios juntos', () => {
    const d = new FrameDecoder();
    const a = encode(OP.FRAME, { cmd: 'A', texto: 'ñandú ✓' });
    const b = encode(OP.PING, { x: 2 });
    const all = Buffer.concat([a, b]);
    assert.equal(d.push(all.subarray(0, 3)).length, 0);
    assert.equal(d.push(all.subarray(3, a.length + 2)).length, 1);
    const rest = d.push(all.subarray(a.length + 2));
    assert.equal(rest.length, 1);
    assert.equal(rest[0].op, OP.PING);
    const d2 = new FrameDecoder();
    const two = d2.push(Buffer.concat([a, b]));
    assert.equal(two.length, 2);
    assert.equal(two[0].data.texto, 'ñandú ✓');
  });
  await test('decoder: largo inválido lanza error', () => {
    const bad = Buffer.alloc(8);
    bad.writeInt32LE(1, 0);
    bad.writeInt32LE(-5, 4);
    assert.throws(() => new FrameDecoder().push(bad), /inválido/);
  });
  await test('rutas del IPC por plataforma', () => {
    const w = candidatePaths({ platform: 'win32' });
    assert.equal(w.length, 10);
    assert.equal(w[0], '\\\\?\\pipe\\discord-ipc-0');
    const l = candidatePaths({ platform: 'linux', env: { XDG_RUNTIME_DIR: '/run/user/1000' } });
    assert.ok(l.includes(path.join('/run/user/1000', 'discord-ipc-0')));
    assert.ok(l.some((p) => p.includes('com.discordapp.Discord')));
    assert.ok(l.some((p) => p.includes('snap.discord')));
  });

  // ---------- Actividad ----------
  const cfg = config({ discord: { enabled: true, clientId: '123456789012345678' } });
  const base = { cfg, t, appVersion: '1.0.0', launcherStartedAt: 1000 };
  await test('validación del Application ID', () => {
    assert.ok(validClientId('123456789012345678'));
    assert.ok(!validClientId('abc'));
    assert.ok(!validClientId('12345'));
  });
  await test('clamp: mínimo 2 y máximo 128 caracteres', () => {
    assert.equal(clamp('A').length, 2);
    assert.equal(clamp('x'.repeat(300)).length, 128);
    assert.equal(clamp('   '), null);
  });
  await test('privacidad: IP, LAN y túneles no se muestran', () => {
    assert.ok(isPrivateAddress('192.168.0.10'));
    assert.ok(isPrivateAddress('45.12.3.4:25565'));
    assert.ok(isPrivateAddress('[2001:db8::1]:25565'));
    assert.ok(isPrivateAddress('localhost'));
    assert.ok(isPrivateAddress('mi-pc'));
    assert.ok(isPrivateAddress('abc-def.sa.e4mc.link'));
    assert.ok(isPrivateAddress('bore.pub:41234'));
    assert.ok(isPrivateAddress('casa.local'));
    assert.ok(!isPrivateAddress('mc.hypixel.net'));
    assert.ok(!isPrivateAddress('play.universocraft.com:25565'));
  });
  await test('botones: máximo 2, https/http y etiqueta de hasta 32', () => {
    const b = normalizeButtons([{ label: 'Web', url: 'https://a.com' }, { label: 'x', url: 'javascript:alert(1)' }, { label: 'y'.repeat(40), url: 'https://b.com' }, { label: 'Discord', url: 'https://discord.gg/abc' }, { label: 'Otro', url: 'https://c.com' }]);
    assert.deepEqual(b.map((x) => x.label), ['Web', 'Discord']);
  });
  await test('en el launcher', () => {
    const a = buildActivity({ ...base, session: null });
    assert.equal(a.details, 'En el launcher');
    assert.equal(a.timestamps.start, 1000);
    assert.equal(a.assets.large_image, 'venus');
    assert.equal(a.instance, false);
    assert.equal(buildActivity({ ...base, cfg: { ...cfg, showIdle: false }, session: null }), null);
  });
  const inst = { name: 'Supervivencia', mcVersion: '1.21.4', loader: 'fabric', icon: null };
  await test('jugando: instancia, loader y estado', () => {
    const menu = buildActivity({ ...base, session: { state: 'running', startedAt: 5000, instance: inst, activity: { type: 'menu' } } });
    assert.equal(menu.details, 'Supervivencia · Fabric 1.21.4');
    assert.equal(menu.state, 'En el menú principal');
    assert.equal(menu.timestamps.start, 5000);
    const world = buildActivity({ ...base, session: { state: 'running', startedAt: 5000, instance: inst, activity: { type: 'singleplayer', world: 'Mi mundo' } } });
    assert.equal(world.state, 'Un jugador · Mi mundo');
    const hidden = buildActivity({ ...base, cfg: { ...cfg, showWorld: false, showInstance: false }, session: { state: 'running', startedAt: 5000, instance: { ...inst, loader: 'vanilla' }, activity: { type: 'singleplayer', world: 'Mi mundo' } } });
    assert.equal(hidden.state, 'Jugando en un jugador');
    assert.equal(hidden.details, 'Minecraft 1.21.4');
    const srv = buildActivity({ ...base, session: { state: 'running', startedAt: 1, instance: inst, activity: { type: 'server', address: 'mc.hypixel.net' } } });
    assert.equal(srv.state, 'Jugando en mc.hypixel.net');
    const priv = buildActivity({ ...base, session: { state: 'running', startedAt: 1, instance: inst, activity: { type: 'server', address: '181.1.2.3:25565' } } });
    assert.equal(priv.state, 'Jugando en multijugador');
    const prep = buildActivity({ ...base, session: { state: 'preparing', startedAt: 1, instance: inst, activity: null } });
    assert.equal(prep.state, 'Preparando el juego');
  });
  await test('ícono https del modpack como imagen grande', () => {
    const a = buildActivity({ ...base, session: { state: 'running', startedAt: 1, instance: { ...inst, icon: 'https://cdn.modrinth.com/data/x/icon.png' }, activity: { type: 'menu' } } });
    assert.equal(a.assets.large_image, 'https://cdn.modrinth.com/data/x/icon.png');
    assert.equal(a.assets.small_image, 'venus');
  });
  await test('idioma inglés', () => {
    i18n.setLanguage('en');
    assert.equal(buildActivity({ ...base, session: null }).details, 'In the launcher');
    i18n.setLanguage('es');
  });

  // ---------- Cliente IPC contra un Discord falso ----------
  const p1 = pipePath('a');
  const srv = fakeDiscord(p1);
  await srv.listen();
  await test('handshake, READY partido, PING/PONG y SET_ACTIVITY', async () => {
    const c = new DiscordIpc({ clientId: '123456789012345678', paths: [pipePath('nada'), p1], timeout: 3000 });
    const ready = await c.connect();
    assert.equal(ready.user.username, 'nelly');
    await until(() => srv.frames.some((f) => f.op === OP.PONG));
    const res = await c.setActivity({ details: 'Hola', state: 'Mundo', instance: false });
    assert.equal(res.details, 'Hola');
    const sent = srv.activities().at(-1);
    assert.equal(sent.pid, process.pid);
    await c.close();
    assert.equal(srv.activities().at(-1).activity, undefined, 'al cerrar se borra la actividad');
  });
  await test('Application ID inválido -> INVALID_CLIENT', async () => {
    const c = new DiscordIpc({ clientId: '999999999999999999', paths: [p1], timeout: 3000 });
    await assert.rejects(c.connect(), (err) => err.code === 'INVALID_CLIENT');
  });
  await test('sin Discord -> NO_DISCORD', async () => {
    const c = new DiscordIpc({ clientId: '123456789012345678', paths: [pipePath('nada')], timeout: 1000 });
    await assert.rejects(c.connect(), (err) => err.code === 'NO_DISCORD');
  });

  // ---------- PresenceManager ----------
  await test('presencia: conecta, envía, no repite y respeta el intervalo', async () => {
    srv.frames.length = 0;
    const m = new PresenceManager({ t, paths: [p1], minInterval: 300, retryMin: 200 });
    m.configure({ enabled: true, clientId: '123456789012345678' });
    m.setDesired({ details: 'Uno', instance: false });
    await until(() => m.state === 'connected');
    await until(() => srv.activities().some((a) => a.activity?.details === 'Uno'));
    m.setDesired({ details: 'Uno', instance: false });
    m.setDesired({ details: 'Dos', instance: false });
    m.setDesired({ details: 'Tres', instance: false });
    await until(() => srv.activities().some((a) => a.activity?.details === 'Tres'));
    const details = srv.activities().map((a) => a.activity?.details);
    assert.ok(!details.includes('Dos'), 'los cambios seguidos se agrupan');
    assert.equal(details.filter((d) => d === 'Uno').length, 1, 'no se repite la misma actividad');
    assert.equal(m.status().user.username, 'nelly');
    await m.shutdown();
    await until(() => srv.activities().at(-1)?.activity === undefined);
  });
  await test('presencia: Discord rechaza la actividad -> activityError', async () => {
    const m = new PresenceManager({ t, paths: [p1], minInterval: 100 });
    m.configure({ enabled: true, clientId: '123456789012345678' });
    m.setDesired({ details: 'Malo', buttons: [{ label: 'x', url: 'ftp://x' }] });
    await until(() => m.status().activityError);
    assert.match(m.status().activityError, /rechazó/);
    await m.shutdown();
  });
  await test('presencia: ID inválido -> error; desactivar -> off', async () => {
    const m = new PresenceManager({ t, paths: [p1] });
    m.configure({ enabled: true, clientId: '999999999999999999' });
    await until(() => m.state === 'error');
    assert.equal(m.status().error, t('discord.errInvalidClient'));
    m.configure({ enabled: false, clientId: '999999999999999999' });
    assert.equal(m.state, 'off');
    m.configure({ enabled: true, clientId: '' });
    assert.equal(m.state, 'unconfigured');
    await m.shutdown();
  });
  await test('presencia: espera a Discord y se reconecta cuando se cierra y vuelve', async () => {
    const p2 = pipePath('b');
    const m = new PresenceManager({ t, paths: [p2], minInterval: 100, retryMin: 150 });
    m.configure({ enabled: true, clientId: '123456789012345678' });
    m.setDesired({ details: 'Esperando', instance: false });
    await until(() => m.state === 'waiting');
    const s2 = fakeDiscord(p2);
    await s2.listen();
    await until(() => m.state === 'connected', 6000);
    await until(() => s2.activities().some((a) => a.activity?.details === 'Esperando'));
    await s2.close();
    await until(() => m.state === 'waiting');
    const s3 = fakeDiscord(p2);
    await s3.listen();
    await until(() => m.state === 'connected', 10000);
    await until(() => s3.activities().some((a) => a.activity?.details === 'Esperando'), 6000);
    await m.shutdown();
    await s3.close();
  });
  await test('presencia: prueba muestra la actividad de prueba y después vuelve', async () => {
    const m = new PresenceManager({ t, paths: [p1], minInterval: 100 });
    m.configure({ enabled: true, clientId: '123456789012345678' });
    m.setDesired({ details: 'Normal', instance: false });
    await until(() => srv.activities().some((a) => a.activity?.details === 'Normal'));
    const act = testActivity({ cfg, t, appVersion: '1.0.0' });
    const st = await m.test(act);
    assert.equal(st.testing, true);
    assert.equal(srv.activities().at(-1).activity.details, 'Probando Rich Presence');
    await m.shutdown();
  });
  await srv.close();

  // ---------- Discord real (solo si está abierto): saludo con un ID inválido, sin cambiar tu perfil ----------
  const real = candidatePaths().filter((p) => {
    if (process.platform !== 'win32') return fs.existsSync(p);
    try {
      return fs.readdirSync('\\\\.\\pipe\\').includes(path.basename(p.replace(/^\\\\\?\\pipe\\/, '')));
    } catch {
      return false;
    }
  });
  if (real.length) {
    await test('Discord real: responde al saludo (ID inválido -> 4000)', async () => {
      const c = new DiscordIpc({ clientId: '100000000000000001', paths: real, timeout: 5000 });
      await assert.rejects(c.connect(), (err) => err.code === 'INVALID_CLIENT' || err.code === 'CLOSED');
    });
  } else {
    results.push(['--', 'Discord real: no está abierto en esta PC (prueba omitida)']);
  }

  let failed = 0;
  for (const [st, name, err] of results) {
    if (st === 'FALLÓ') failed++;
    console.log(`${st.padEnd(6)} ${name}${err ? `\n       ${err.stack || err}` : ''}`);
  }
  console.log(`\n${results.filter((r) => r[0] === 'ok').length} ok, ${failed} con errores`);
  process.exit(failed ? 1 : 0);
})();
