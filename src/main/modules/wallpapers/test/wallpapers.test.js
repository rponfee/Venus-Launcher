'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const paths = require('../../../core/paths');
const http = require('../../../core/http');
const wallpapers = require('../../wallpapers');
const VIDEOS = require('../videos.json');

const FAKE_ID = 'live-12';

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venus-wallpapers-'));
  paths.setRoot(dir);
  const realDownload = http.download;
  const realStat = fs.promises.stat;
  // Hace de cuenta que es la app empaquetada: los videos del repositorio no existen.
  fs.promises.stat = async (file, ...rest) => {
    if (String(file).includes(`${path.sep}renderer${path.sep}assets${path.sep}wallpapers`)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return realStat(file, ...rest);
  };
  t.after(() => {
    http.download = realDownload;
    fs.promises.stat = realStat;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('videos.json: los 16 fondos animados, con tamaño y SHA-256 de los archivos del repositorio', () => {
  assert.equal(Object.keys(VIDEOS).length, 16);
  for (const [id, video] of Object.entries(VIDEOS)) {
    assert.match(id, /^live-\d\d$/);
    assert.match(video.sha256, /^[0-9a-f]{64}$/);
    const file = path.join(__dirname, '..', '..', '..', '..', 'renderer', 'assets', 'wallpapers', `${id}.mp4`);
    if (!fs.existsSync(file)) continue;
    const buf = fs.readFileSync(file);
    assert.equal(buf.length, video.size, id);
    assert.equal(crypto.createHash('sha256').update(buf).digest('hex'), video.sha256, id);
  }
});

test('sin bajar nada, status dice que falta', async (t) => {
  setup(t);
  const s = await wallpapers.status();
  assert.deepEqual(s[FAKE_ID], { size: VIDEOS[FAKE_ID].size, path: null });
});

test('ensure baja de la página con GitHub de respaldo, exigiendo el hash, y una sola vez', async (t) => {
  setup(t);
  const items = [];
  const sent = [];
  http.download = async (item, { onBytes }) => {
    items.push(item);
    onBytes(item.size);
    fs.mkdirSync(path.dirname(item.path), { recursive: true });
    const fd = fs.openSync(item.path, 'w');
    fs.ftruncateSync(fd, item.size);
    fs.closeSync(fd);
    return { skipped: false };
  };
  const send = (...args) => sent.push(args);
  const [a, b] = await Promise.all([wallpapers.ensure(FAKE_ID, send), wallpapers.ensure(FAKE_ID, send)]);
  assert.equal(items.length, 1);
  assert.equal(a.path, b.path);
  assert.equal(path.basename(a.path), `${FAKE_ID}.mp4`);
  assert.equal(path.basename(path.dirname(a.path)), 'wallpapers');
  assert.deepEqual(items[0].urls.map((u) => new URL(u).host), ['venus-launcher-fondos.netlify.app', 'raw.githubusercontent.com']);
  assert.equal(items[0].sha256, VIDEOS[FAKE_ID].sha256);
  assert.equal(items[0].size, VIDEOS[FAKE_ID].size);
  assert.deepEqual(sent[0], ['wallpapers:progress', { id: FAKE_ID, percent: 100 }]);

  assert.equal((await wallpapers.status())[FAKE_ID].path, a.path);
  await wallpapers.ensure(FAKE_ID, send);
  assert.equal(items.length, 1, 'ya estaba bajado');
});

test('un archivo a medias no cuenta como bajado', async (t) => {
  const dir = setup(t);
  const file = path.join(dir, 'cache', 'wallpapers', `${FAKE_ID}.mp4`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'poco');
  assert.equal((await wallpapers.status())[FAKE_ID].path, null);
});

test('no acepta ids inventados ni rutas', async (t) => {
  setup(t);
  http.download = async () => {
    throw new Error('no debería bajar nada');
  };
  for (const id of ['../../secure', 'constructor', 'wallpaper-01', '']) {
    await assert.rejects(wallpapers.ensure(id));
    assert.equal(await wallpapers.localPath(id), null);
  }
});

test('si la descarga falla se puede volver a intentar', async (t) => {
  setup(t);
  let tries = 0;
  http.download = async () => {
    tries++;
    throw new Error('sin red');
  };
  await assert.rejects(wallpapers.ensure(FAKE_ID));
  await assert.rejects(wallpapers.ensure(FAKE_ID));
  assert.equal(tries, 2);
});
