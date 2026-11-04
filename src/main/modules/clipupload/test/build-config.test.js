'use strict';
// Ejecuta el script de build en una VM con entorno y archivos en memoria: nunca accede a claves reales.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const script = path.resolve(__dirname, '../../../../../scripts/write-build-config.js');
const source = fs.readFileSync(script, 'utf8');
function build(env = {}) {
  let output = 'anterior';
  const logs = [];
  const fakeFs = { rmSync() { output = null; }, writeFileSync(file, data) { output = data; } };
  vm.runInNewContext(source, { __dirname: path.dirname(script), process: { env }, require: id => id === 'fs' ? fakeFs : path, console: { log: text => logs.push(text) } }, { filename: script });
  return { output: output && JSON.parse(output), logs: logs.join('\n') };
}

test('build: sin variables elimina configuracion anterior y no escribe otra', () => {
  assert.equal(build().output, null);
});

test('build: incorpora solo IDs publicos aunque CurseForge no este configurado', () => {
  const result = build({ VENUS_YOUTUBE_CLIENT_ID: ' test-youtube-id ', VENUS_TIKTOK_CLIENT_KEY: ' test-tiktok-id ' });
  assert.deepEqual(result.output, { youtubeClientId: 'test-youtube-id', tiktokClientKey: 'test-tiktok-id' });
  assert.equal(result.logs.includes('test-youtube-id'), false);
  assert.equal(result.logs.includes('test-tiktok-id'), false);
});

test('build: conserva CurseForge, omite valores vacios y no incorpora secretos OAuth', () => {
  const result = build({ VENUS_CURSEFORGE_API_KEY: ' test-curseforge ', VENUS_YOUTUBE_CLIENT_ID: ' ', VENUS_YOUTUBE_CLIENT_SECRET: 'test-omitted', TIKTOK_CLIENT_SECRET: 'test-omitted' });
  assert.deepEqual(result.output, { curseforgeApiKey: 'test-curseforge' });
  assert.equal(result.logs.includes('test-curseforge'), false);
  assert.equal(result.logs.includes('test-omitted'), false);
});
