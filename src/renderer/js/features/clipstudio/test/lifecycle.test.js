'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const { ui, loadRenderer, turn, deferred } = require('./ui-harness');
const logic = () => import(pathToFileURL(path.join(__dirname, '../logic.js')).href);

async function timelapseRig(over = {}) {
  const calls = [];
  const signal = { cancelled: false };
  class Encoder { async encode() {} async flush() {} close() {} }
  const deps = {
    ...(await logic()), t: x => x,
    api: { invoke: async (channel, ...args) => {
      calls.push([channel, ...args]);
      if (channel.endsWith('Frames')) return ['a.jpg', 'b.jpg', 'c.jpg'];
      if (channel.endsWith('Read')) return new Uint8Array([1]);
      if (channel.endsWith('Open')) return { jobId: 'test-job' };
      if (channel.endsWith('finish')) return { name: 'test.webm' };
    } },
    createImageBitmap: async () => ({ width: 640, height: 360, close() {} }),
    pickCodec: async () => 'V_VP9', FrameEncoder: Encoder,
    OffscreenCanvas: class { getContext() { return { fillRect() {}, drawImage() {} }; } },
    VideoFrame: class { close() {} }, ...over,
  };
  const { buildTimelapse } = loadRenderer(path.join(__dirname, '../timelapse.js'), ['buildTimelapse'], deps);
  return { calls, signal, run: extra => buildTimelapse({ instanceId: 'test-instance', folder: 'test-world', fps: 10, every: 30, signal, ...extra }) };
}

test('timelapse: cancelar cuando llega el job tambien lo elimina', async () => {
  const r = await timelapseRig();
  const result = await r.run({ onJob: () => { r.signal.cancelled = true; } });
  assert.equal(result, null);
  assert.equal(r.calls.filter(([name]) => name === 'clipstudio:cancel').length, 1);
  assert.equal(r.calls.some(([name]) => name === 'clipstudio:finish'), false);
});

test('timelapse: error de constructor del codificador cancela el temporal', async () => {
  const r = await timelapseRig({ FrameEncoder: class { constructor() { throw new Error('codificador no disponible'); } } });
  await assert.rejects(r.run(), /codificador no disponible/);
  assert.equal(r.calls.filter(([name]) => name === 'clipstudio:cancel').length, 1);
});

test('timelapse: al cancelar mientras codifica no termina ni muestra un fallo', async () => {
  const r = await timelapseRig({ FrameEncoder: class { async encode() { r.signal.cancelled = true; throw new Error('cancelado'); } close() {} } });
  assert.equal(await r.run(), null);
  assert.equal(r.calls.filter(([name]) => name === 'clipstudio:cancel').length, 1);
});

test('timelapse: terminar conserva el archivo y no cancela el job', async () => {
  const r = await timelapseRig();
  assert.equal((await r.run()).name, 'test.webm');
  assert.equal(r.calls.some(([name]) => name === 'clipstudio:cancel'), false);
});

async function montageRig(over = {}) {
  const dom = ui(); const calls = []; const events = [];
  const deps = {
    ...dom.deps, ...(await logic()), cloud: {},
    api: { on: () => () => {}, invoke: async (channel) => {
      calls.push(channel);
      if (channel === 'clipstudio:probe') return [{ path: 'test.webm', ok: true, duration: 4, codec: 'V_VP9', width: 640, height: 360 }];
      if (channel === 'clipstudio:montageOpen') return { jobId: 'test-job', mode: 'encode', codec: 'V_VP9', width: 640, height: 360 };
      if (channel === 'clipstudio:finish') return { name: 'test.webm' };
    } },
    canEncode: () => true, pickCodec: async () => 'V_VP9',
    FrameEncoder: class { async flush() { events.push('flush'); } close() {} },
    encodeTitleCard: async () => { events.push('title'); },
    transcodeSegment: async () => { events.push('segment'); }, ...over,
  };
  const { openMontage } = loadRenderer(path.join(__dirname, '../montage.js'), ['openMontage'], deps);
  const m = openMontage({ items: [{ path: 'test.webm', kind: 'clip', file: 'test.webm', rel: 'clips/test.webm', date: Date.now(), instanceId: 'test-instance' }] });
  await turn();
  return { ...dom, m, calls, events };
}

test('montaje: escribe la placa completa antes de abrir el primer tramo recodificado', async () => {
  const r = await montageRig();
  r.m.el.querySelectorAll('input').find(el => el.change).change(true);
  await r.m.el.querySelectorAll('button').find(el => el.textContent.includes('clipstudio.montageCreate')).click();
  assert.deepEqual(r.events.slice(0, 3), ['title', 'flush', 'segment']);
  assert.equal(r.failures.length, 0);
});

test('montaje: cerrar mientras abre el job elimina el temporal tardio', async () => {
  const opening = deferred(); const calls = [];
  const r = await montageRig({ api: { on: () => () => {}, invoke: async channel => {
    calls.push(channel);
    if (channel === 'clipstudio:probe') return [{ path: 'test.webm', ok: true, duration: 4 }];
    if (channel === 'clipstudio:montageOpen') return opening.promise;
  } } });
  const run = r.m.el.querySelectorAll('button').find(el => el.textContent.includes('clipstudio.montageCreate')).click();
  r.m.close();
  opening.resolve({ jobId: 'late-job', mode: 'copy' });
  await run;
  assert.ok(calls.includes('clipstudio:cancel'));
  assert.equal(calls.includes('clipstudio:montageCopy'), false);
  assert.equal(r.failures.length, 0);
});


test('timelapse: la confirmacion borra imagenes de la instancia de origen aunque cambie la seleccion', async () => {
  const dom = ui(); const calls = [];
  let dialog;
  const deps = {
    ...dom.deps, ...(await logic()),
    store: { instances: [{ id: 'origen', name: 'Origen' }, { id: 'otra', name: 'Otra' }], settings: {} },
    api: { on: () => () => {}, invoke: async (channel, ...args) => {
      calls.push([channel, ...args]);
      if (channel === 'clipstudio:timelapseList') return { config: { every: 30, capMb: 256 }, used: 30, folders: [{ folder: 'Mundo', count: 3, bytes: 30 }] };
      if (channel === 'clipstudio:timelapseFrames') return ['a.jpg', 'b.jpg', 'c.jpg'];
      if (channel === 'clipstudio:timelapseRead') return new Uint8Array([1]);
      if (channel === 'clipstudio:timelapseOpen') return { jobId: 'test-job' };
      if (channel === 'clipstudio:finish') return { name: 'test.webm' };
    } },
    createImageBitmap: async () => ({ width: 640, height: 360, close() {} }), pickCodec: async () => 'V_VP9',
    FrameEncoder: class { async encode() {} async flush() {} close() {} },
    OffscreenCanvas: class { getContext() { return { fillRect() {}, drawImage() {} }; } }, VideoFrame: class { close() {} },
    confirmDialog: async () => {
      dialog.el.querySelector('select').change('otra');
      await turn();
      return true;
    },
  };
  const { openTimelapse } = loadRenderer(path.join(__dirname, '../timelapse.js'), ['openTimelapse'], deps);
  dialog = openTimelapse({ instanceId: 'origen' });
  await turn();
  await dialog.el.querySelectorAll('button').find(el => el.textContent.includes('clipstudio.timelapseGenerate')).click();
  assert.deepEqual(calls.find(([name]) => name === 'clipstudio:timelapseDelete'), ['clipstudio:timelapseDelete', 'origen', 'Mundo']);
  assert.equal(dom.failures.length, 0);
  dialog.close();
});

test('subir: la confirmacion conserva proveedor y privacidad y no permite dos subidas', async () => {
  const dom = ui(); const calls = []; const confirm = deferred(); const upload = deferred();
  const deps = {
    ...dom.deps, copyText: async () => {}, confirmDialog: () => confirm.promise,
    api: { on: () => () => {}, invoke: async (channel, ...args) => {
      calls.push([channel, ...args]);
      if (channel === 'clipupload:status') return { youtube: { configured: true, connected: true }, tiktok: { configured: true, connected: true } };
      if (channel === 'clipupload:upload') return upload.promise;
    } },
  };
  const { openUpload } = loadRenderer(path.join(__dirname, '../upload.js'), ['openUpload'], deps);
  const dialog = openUpload({ file: 'test.webm', path: 'test.webm', size: 10 });
  await turn();
  const submit = dialog.el.querySelectorAll('button').find(el => el.textContent.includes('clipstudio.uploadOk'));
  const pending = submit.click();
  assert.equal(submit.disabled, true);
  const tiktok = dialog.el.querySelectorAll('button').find(el => el.textContent.includes('clipstudio.provider_tiktok'));
  tiktok.onclick();
  dialog.el.querySelector('select').change('public');
  confirm.resolve(true);
  await turn();
  const sent = calls.find(([name]) => name === 'clipupload:upload')[1];
  assert.equal(sent.provider, 'youtube');
  assert.equal(sent.privacy, 'private');
  dialog.el.querySelectorAll('button').find(el => el.textContent.includes('clipstudio.uploadOk')).onclick();
  await turn();
  assert.equal(calls.filter(([name]) => name === 'clipupload:upload').length, 1);
  upload.resolve({ provider: 'tiktok', status: 'inbox' });
  await pending;
  assert.equal(calls.some(([name]) => name === 'clipupload:cancel'), false);
  assert.equal(dom.failures.length, 0);
});
