'use strict';
// Sonidos propios del soundboard: hasta 8 archivos de audio de hasta 200 KB en <datos>/soundboard, mas un index.json con
// sus nombres y los atajos (de los propios y del pack). Nunca salen de la PC. Sin Electron: la carpeta entra por parametro.
// Errores con err.code: too_many, too_big, bad_type, bad_name, not_found, bad_shortcut.
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { readJson, writeJson } = require('../../core/util');

const MAX_SOUNDS = 8;
const MAX_BYTES = 200 * 1024;
const NAME_MAX = 24;
const ID_RE = /^[a-f0-9]{16}$/;
const SOUND_ID_RE = /^(?:[a-z]{2,16}|custom:[a-f0-9]{16})$/;
const ACCEL_RE = /^[A-Za-z0-9+=\-[\];',./\\`]{1,60}$/;

function coded(code) {
  const err = new Error(code);
  err.code = code;
  return err;
}

// Tipo de audio por los primeros bytes: lo demas (un ejecutable renombrado, por ejemplo) no se guarda
function sniffAudio(b) {
  if (b.length < 12) return null;
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'audio/webm';
  if (b.toString('latin1', 0, 4) === 'OggS') return 'audio/ogg';
  if (b.toString('latin1', 0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WAVE') return 'audio/wav';
  if (b.toString('latin1', 4, 8) === 'ftyp') return 'audio/mp4';
  if (b.toString('latin1', 0, 4) === 'fLaC') return 'audio/flac';
  return null;
}

function cleanName(name) {
  return String(name ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX);
}

class SoundStore {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'index.json');
    this.chain = Promise.resolve();
  }

  // Las escrituras van en serie: dos altas seguidas no se pisan el indice
  serial(fn) {
    const run = this.chain.then(fn);
    this.chain = run.catch(() => {});
    return run;
  }

  async index() {
    const raw = await readJson(this.file, {});
    return {
      items: Array.isArray(raw?.items) ? raw.items.filter((x) => x && ID_RE.test(x.id) && typeof x.name === 'string') : [],
      shortcuts: raw?.shortcuts && typeof raw.shortcuts === 'object' ? raw.shortcuts : {},
    };
  }

  async save(data) {
    await fsp.mkdir(this.dir, { recursive: true });
    await writeJson(this.file, data);
    return data;
  }

  list() {
    return this.index();
  }

  soundPath(id) {
    if (!ID_RE.test(String(id))) throw coded('not_found');
    return path.join(this.dir, `${id}.sound`);
  }

  add({ name, bytes }) {
    return this.serial(async () => {
      const buf = Buffer.isBuffer(bytes) ? bytes : bytes instanceof Uint8Array ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) : null;
      if (!buf || !buf.length) throw coded('bad_type');
      if (buf.length > MAX_BYTES) throw coded('too_big');
      const mime = sniffAudio(buf);
      if (!mime) throw coded('bad_type');
      const clean = cleanName(name);
      if (!clean) throw coded('bad_name');
      const data = await this.index();
      if (data.items.length >= MAX_SOUNDS) throw coded('too_many');
      const id = crypto.randomBytes(8).toString('hex');
      await fsp.mkdir(this.dir, { recursive: true });
      await fsp.writeFile(this.soundPath(id), buf);
      data.items.push({ id, name: clean, bytes: buf.length, mime, addedAt: Date.now() });
      return this.save(data);
    });
  }

  async read(id) {
    const data = await this.index();
    if (!data.items.some((x) => x.id === id)) throw coded('not_found');
    return fsp.readFile(this.soundPath(id));
  }

  rename(id, name) {
    return this.serial(async () => {
      const clean = cleanName(name);
      if (!clean) throw coded('bad_name');
      const data = await this.index();
      const it = data.items.find((x) => x.id === id);
      if (!it) throw coded('not_found');
      it.name = clean;
      return this.save(data);
    });
  }

  remove(id) {
    return this.serial(async () => {
      const data = await this.index();
      if (!data.items.some((x) => x.id === id)) throw coded('not_found');
      data.items = data.items.filter((x) => x.id !== id);
      delete data.shortcuts[`custom:${id}`];
      await this.save(data);
      await fsp.rm(this.soundPath(id), { force: true });
      return data;
    });
  }

  // accel vacio = sacar el atajo
  setShortcut(soundId, accel) {
    return this.serial(async () => {
      if (!SOUND_ID_RE.test(String(soundId))) throw coded('bad_shortcut');
      const value = typeof accel === 'string' ? accel.trim() : '';
      if (value && !ACCEL_RE.test(value)) throw coded('bad_shortcut');
      const data = await this.index();
      if (value) data.shortcuts[soundId] = value;
      else delete data.shortcuts[soundId];
      return this.save(data);
    });
  }
}

module.exports = { SoundStore, sniffAudio, cleanName, MAX_SOUNDS, MAX_BYTES, NAME_MAX };
