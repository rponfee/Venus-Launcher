'use strict';
// Ayudas de las pruebas: un armador de zips a mano, que permite escribir lo que un zip honesto nunca diría
// (tamaños que mienten, rutas con '..', enlaces simbólicos, entradas solapadas).
const zlib = require('zlib');

function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const count = files.length;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data ?? '', 'utf8');
    const method = f.method ?? (f.stored ? 0 : 8);
    const data = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const crc = f.crc ?? zlib.crc32(raw);
    const size = f.declaredSize ?? raw.length;
    const comp = f.declaredComp ?? data.length;
    const flags = f.flags ?? 0x0800;
    const localName = f.localName ? Buffer.from(f.localName, 'utf8') : name;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(comp >>> 0, 18);
    local.writeUInt32LE(size >>> 0, 22);
    local.writeUInt16LE(localName.length, 26);
    const entryOffset = f.offset ?? offset;
    locals.push(local, localName, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(((f.madeBy ?? 0) << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc >>> 0, 16);
    central.writeUInt32LE(comp >>> 0, 20);
    central.writeUInt32LE(size >>> 0, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((f.attrs ?? 0) >>> 0, 38);
    central.writeUInt32LE(entryOffset >>> 0, 42);
    centrals.push(central, name);
    offset += local.length + localName.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(count, 8);
  eocd.writeUInt16LE(count, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

function manifest(over = {}) {
  return {
    manifestVersion: 1,
    id: 'mi-extension',
    name: 'Mi extensión',
    version: '1.0.0',
    author: 'Alguien',
    description: 'Una extensión de prueba',
    minLauncherVersion: '3.0.0',
    permissions: ['storage'],
    entry: 'index.html',
    ...over,
  };
}

function goodFiles(over = {}) {
  return [
    { name: 'manifest.json', data: JSON.stringify(manifest(over)) },
    { name: 'index.html', data: '<!doctype html><title>x</title><script src="app.js"></script>' },
    { name: 'app.js', data: 'console.log(1);' },
  ];
}

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c49444154789c636060600000000400010d0a2db40000000049454e44ae426082', 'hex');

module.exports = { makeZip, manifest, goodFiles, PNG };
