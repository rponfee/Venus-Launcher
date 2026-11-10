'use strict';
// IPC de Discord (Rich Presence): rutas por plataforma (en macOS, socket Unix en $TMPDIR/discord-ipc-N) y una conexión
// real con un "Discord" de mentira por el mismo canal que usa el sistema (tubería con nombre en Windows, socket Unix en
// macOS y Linux).
// node --test "src/main/modules/discord/test/*.test.js"
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { candidatePaths, DiscordIpc, FrameDecoder, encode } = require('../ipc');

test('macOS: socket en $TMPDIR (la carpeta por usuario de /var/folders) y /tmp de respaldo', () => {
  const tmpdir = '/var/folders/ab/cdefgh/T/';
  const list = candidatePaths({ platform: 'darwin', env: { TMPDIR: tmpdir } });
  assert.equal(list[0], path.join(tmpdir, 'discord-ipc-0'));
  assert.equal(list[9], path.join(tmpdir, 'discord-ipc-9'));
  assert.ok(list.includes(path.join('/tmp', 'discord-ipc-0')));
  assert.ok(list.every((p) => !p.includes('pipe')));
  // Sin TMPDIR (raro en macOS): /tmp
  assert.equal(candidatePaths({ platform: 'darwin', env: {} })[0], path.join('/tmp', 'discord-ipc-0'));
});

test('Windows: tuberías con nombre', () => {
  const list = candidatePaths({ platform: 'win32', env: {} });
  assert.equal(list.length, 10);
  assert.equal(list[0], '\\\\?\\pipe\\discord-ipc-0');
});

test('conexión real por el canal del sistema: saludo, READY y SET_ACTIVITY', async (t) => {
  const prefix = `venus-ipc-test-${process.pid}`;
  const dir = process.platform === 'win32' ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'vdc-'));
  const paths = candidatePaths({ prefix, platform: process.platform, env: dir ? { TMPDIR: dir } : {} });
  const seen = [];
  const server = net.createServer((sock) => {
    const dec = new FrameDecoder();
    sock.on('data', (chunk) => {
      for (const f of dec.push(chunk)) {
        seen.push(f);
        if (f.op === 0) sock.write(encode(1, { cmd: 'DISPATCH', evt: 'READY', data: { user: { username: 'prueba' } } }));
        else if (f.op === 1) sock.write(encode(1, { cmd: f.data.cmd, nonce: f.data.nonce, data: { ok: true } }));
      }
    });
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(paths[0], resolve));
  t.after(() => {
    server.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });
  const client = new DiscordIpc({ clientId: '123', paths: paths.slice(0, 2), timeout: 3000, pid: 77 });
  const ready = await client.connect();
  assert.equal(ready.user.username, 'prueba');
  assert.equal(client.pipe, paths[0]);
  assert.deepEqual(await client.setActivity({ details: 'Jugando' }), { ok: true });
  await client.close({ clear: false });
  assert.deepEqual(seen[0], { op: 0, data: { v: 1, client_id: '123' } });
  assert.equal(seen[1].data.cmd, 'SET_ACTIVITY');
  assert.deepEqual(seen[1].data.args, { pid: 77, activity: { details: 'Jugando' } });
});
