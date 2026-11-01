'use strict';
// Pruebas de la imagen del resumen: validacion del PNG que llega de la interfaz, nombre del archivo,
// copiar al portapapeles y guardar (con fakes de Electron).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const zlib = require('zlib');
const { parsePngDataUrl, pngFileName, copyPng, savePng } = require('../image');

function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf);
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

// PNG real de w x h (RGBA transparente)
function png(w, h) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const dataUrl = (buf) => `data:image/png;base64,${buf.toString('base64')}`;

test('acepta un PNG en data URL y lee su tamaño', () => {
  const buf = png(16, 9);
  const r = parsePngDataUrl(dataUrl(buf));
  assert.equal(r.width, 16);
  assert.equal(r.height, 9);
  assert.ok(r.buffer.equals(buf));
});

test('rechaza lo que no es un PNG valido', () => {
  const good = dataUrl(png(4, 4));
  const jpeg = `data:image/jpeg;base64,${Buffer.from('xx').toString('base64')}`;
  const notPng = dataUrl(Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(40)]));
  const cases = [undefined, null, 42, {}, '', 'data:image/png;base64,', jpeg, `${good}#`, good.replace('base64,', 'base64,***'), good.slice(0, -3), notPng, 'file:///C:/x.png'];
  for (const c of cases) assert.throws(() => parsePngDataUrl(c), (err) => err.code === 'badImage', String(c).slice(0, 40));
});

test('rechaza imagenes demasiado grandes', () => {
  assert.throws(() => parsePngDataUrl(dataUrl(png(8, 8)), { maxSide: 4 }), (err) => err.code === 'tooBig');
  assert.throws(() => parsePngDataUrl(dataUrl(png(8, 8)), { maxChars: 20 }), (err) => err.code === 'tooBig');
  // Un ancho o alto de 0 en la cabecera no es una imagen
  const zero = png(1, 1);
  zero.writeUInt32BE(0, 16);
  assert.throws(() => parsePngDataUrl(dataUrl(zero)), (err) => err.code === 'badImage');
});

test('nombre de archivo seguro y siempre .png', () => {
  assert.equal(pngFileName('venus-resumen-2026-11-08'), 'venus-resumen-2026-11-08.png');
  assert.equal(pngFileName('mi resumen.PNG'), 'mi resumen.png');
  assert.equal(pngFileName('..\\..\\Windows\\system32\\x'), '_.._Windows_system32_x.png');
  assert.equal(pngFileName('a/b:c*?"<>|'), 'a_b_c______.png');
  assert.equal(pngFileName('   ', 'venus-recap'), 'venus-recap.png');
  assert.equal(pngFileName(null, 'venus-recap'), 'venus-recap.png');
  assert.equal(pngFileName('CON', 'venus-recap'), 'venus-recap.png');
  assert.equal(pngFileName('nul', 'prn'), 'venus.png');
  assert.equal(pngFileName('x'.repeat(200)).length, 84);
  assert.equal(pngFileName('...'), 'venus.png');
});

test('copiar: escribe la imagen en el portapapeles (y en modo de prueba no lo toca)', () => {
  const url = dataUrl(png(20, 10));
  const written = [];
  const native = { isEmpty: () => false };
  const fakes = { clipboard: { writeImage: (img) => written.push(img) }, nativeImage: { createFromDataURL: (u) => (u === url ? native : null) } };
  assert.deepEqual(copyPng(url, fakes), { width: 20, height: 10 });
  assert.deepEqual(written, [native]);
  assert.deepEqual(copyPng(url, { ...fakes, dryRun: true }), { width: 20, height: 10 });
  assert.equal(written.length, 1);
  assert.throws(() => copyPng(url, { ...fakes, nativeImage: { createFromDataURL: () => ({ isEmpty: () => true }) } }), (err) => err.code === 'badImage');
  assert.throws(() => copyPng('data:text/plain;base64,aGk=', fakes), (err) => err.code === 'badImage');
  assert.equal(written.length, 1);
});

test('guardar: dialogo en la carpeta sugerida, agrega .png y escribe el PNG', async () => {
  const buf = png(30, 20);
  const dialogs = [];
  const writes = [];
  const base = {
    defaultDir: path.join('C:', 'Usuarios', 'yo', 'Imagenes'),
    writeFile: async (target, data) => writes.push({ target, data }),
    title: 'Guardar',
    filterName: 'Imagen PNG',
    fallbackName: 'venus-resumen',
  };
  const res = await savePng(dataUrl(buf), 'venus-resumen-2026-11-08', {
    ...base,
    showSaveDialog: async (opts) => {
      dialogs.push(opts);
      return { canceled: false, filePath: path.join('D:', 'capturas', 'mi-resumen') };
    },
  });
  assert.equal(dialogs.length, 1);
  assert.equal(dialogs[0].defaultPath, path.join(base.defaultDir, 'venus-resumen-2026-11-08.png'));
  assert.deepEqual(dialogs[0].filters, [{ name: 'Imagen PNG', extensions: ['png'] }]);
  assert.deepEqual(res, { path: path.join('D:', 'capturas', 'mi-resumen.png'), bytes: buf.length, width: 30, height: 20 });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].target, res.path);
  assert.ok(writes[0].data.equals(buf));
});

test('guardar: cancelar no escribe nada y una imagen invalida no abre el dialogo', async () => {
  let opened = 0;
  const writes = [];
  const opts = {
    defaultDir: 'C:\\x',
    writeFile: async () => writes.push(1),
    showSaveDialog: async () => {
      opened++;
      return { canceled: true, filePath: '' };
    },
  };
  assert.equal(await savePng(dataUrl(png(2, 2)), 'a', opts), null);
  await assert.rejects(savePng('data:image/png;base64,AAAA', 'a', opts), (err) => err.code === 'badImage');
  assert.equal(opened, 1);
  assert.equal(writes.length, 0);
});

test('guardar en modo de prueba: sin dialogo, en la carpeta fija', async () => {
  const writes = [];
  const res = await savePng(dataUrl(png(2, 2)), '../afuera', {
    fixedDir: path.join('C:', 'capturas'),
    writeFile: async (target) => writes.push(target),
    showSaveDialog: async () => {
      throw new Error('no deberia abrirse');
    },
  });
  assert.equal(res.path, path.join('C:', 'capturas', '_afuera.png'));
  assert.deepEqual(writes, [res.path]);
});
