'use strict';
// Biblioteca local de skins: copias de los PNG que eligio el jugador en <datos>/data/skins/<id>.png con un
// indice (index.json). Sin Electron: la carpeta y la papelera se inyectan (test/library.test.js).
// Los cambios del indice van en serie y se escriben de forma atomica (core/util.writeJson).
const fsp = require('fs/promises');
const crypto = require('crypto');
const png = require('./png');
const { readJson, writeJson } = require('../../core/util');
const { resolveInside, writeFileAtomic } = require('../packs/safety');

const ID = /^[a-z0-9]{8,24}$/;
const VARIANTS = new Set(['classic', 'slim']);
const SOURCES = new Set(['file', 'account', 'catalog']); // de donde salio la copia
const NAME_MAX = 40;
const MAX_ITEMS = 100;
const MAX_BYTES = 64 * 1024;

const newId = () => crypto.randomBytes(9).toString('hex');

// Nombre visible: sin caracteres de control, espacios simples y como mucho 40 caracteres.
function cleanName(raw) {
  const s = String(raw ?? '')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(s).slice(0, NAME_MAX).join('').trim();
}

// Nombre a partir del archivo elegido ("mi_skin-2.png" -> "mi skin-2").
function nameFromFile(file) {
  const base = String(file || '')
    .split(/[\\/]/)
    .pop()
    .replace(/\.png$/i, '')
    .replace(/_/g, ' ');
  return cleanName(base);
}

function validItem(it, seen) {
  if (!it || typeof it !== 'object' || !ID.test(it.id) || seen.has(it.id)) return null;
  if (it.width !== 64 || (it.height !== 64 && it.height !== 32)) return null;
  seen.add(it.id);
  const num = (v) => (Number.isFinite(v) && v >= 0 ? v : 0);
  return {
    id: it.id,
    name: cleanName(it.name) || it.id,
    variant: it.height === 32 ? 'classic' : VARIANTS.has(it.variant) ? it.variant : 'classic',
    width: 64,
    height: it.height,
    size: num(it.size),
    sha1: typeof it.sha1 === 'string' && /^[0-9a-f]{40}$/.test(it.sha1) ? it.sha1 : null,
    pixelHash: typeof it.pixelHash === 'string' && /^[0-9a-f]{40}$/.test(it.pixelHash) ? it.pixelHash : null,
    addedAt: num(it.addedAt),
    updatedAt: num(it.updatedAt),
    source: SOURCES.has(it.source) ? it.source : 'file',
  };
}

function createLibrary({ dir, fail, trash = null, now = Date.now, makeId = newId, maxItems = MAX_ITEMS, warn = (...a) => console.warn(...a) } = {}) {
  if (!dir || typeof fail !== 'function') throw new Error('skins library: faltan dir o fail');
  // Un error del disco (sin permiso, disco lleno...) llega a la interfaz traducido; el detalle va a la consola.
  const known = (err) => {
    if (String(err?.code || '').startsWith('skins:')) return err;
    warn('[skins] biblioteca:', err?.message || String(err));
    return Object.assign(fail('diskError'), { cause: err });
  };
  const indexFile = () => resolveInside(dir, 'index.json', { instance: false });
  const fileOf = (id) => {
    const full = ID.test(id) ? resolveInside(dir, `${id}.png`, { instance: false }) : null;
    if (!full) throw fail('notFound');
    return full;
  };

  async function load() {
    const data = await readJson(indexFile(), null);
    const seen = new Set();
    const items = (Array.isArray(data?.items) ? data.items : []).map((it) => validItem(it, seen)).filter(Boolean).slice(0, maxItems);
    return { version: 1, items };
  }

  let queue = Promise.resolve();
  function mutate(fn) {
    const run = queue
      .then(async () => {
        const index = await load();
        const result = await fn(index);
        await writeJson(indexFile(), index);
        return result;
      })
      .catch((err) => {
        throw known(err);
      });
    queue = run.catch(() => {});
    return run;
  }

  // Lee y revisa el PNG de un item. null si falta o esta danado.
  async function readFile(item) {
    let bytes;
    try {
      bytes = await fsp.readFile(fileOf(item.id));
    } catch {
      return null;
    }
    if (bytes.length > MAX_BYTES) return null;
    const head = png.inspect(bytes);
    return head && head.width === item.width && head.height === item.height ? bytes : null;
  }

  const publicItem = (it) => ({ id: it.id, name: it.name, variant: it.variant, width: it.width, height: it.height, legacy: it.height === 32, size: it.size, addedAt: it.addedAt, updatedAt: it.updatedAt, source: it.source, sha1: it.sha1, pixelHash: it.pixelHash });

  return {
    MAX_ITEMS: maxItems,
    MAX_BYTES,

    // Todos los items, del mas nuevo al mas viejo, con la imagen en data: (o broken: true si el archivo falta).
    async list() {
      await queue;
      const index = await load();
      const items = [];
      for (const it of index.items) {
        const bytes = await readFile(it);
        items.push({ ...publicItem(it), broken: !bytes, image: bytes ? `data:image/png;base64,${bytes.toString('base64')}` : null });
      }
      return { items, max: maxItems };
    },

    // Item y bytes validados (para subirlo a la cuenta o exportarlo).
    async read(id) {
      if (typeof id !== 'string' || !ID.test(id)) throw fail('notFound');
      const it = (await load()).items.find((i) => i.id === id);
      if (!it) throw fail('notFound');
      const bytes = await readFile(it);
      if (!bytes) throw fail('fileDamaged');
      return { item: publicItem(it), bytes };
    },

    // Agrega una copia. Si la misma imagen ya estaba, devuelve esa con duplicate: true.
    async add(input, { name, variant, source = 'file' } = {}) {
      const buf = Buffer.isBuffer(input) ? input : input instanceof Uint8Array ? Buffer.from(input) : null;
      const checked = png.check(buf, { maxBytes: MAX_BYTES });
      if (!checked.ok) throw fail(checked.code === 'wrongSize' ? 'wrongSize' : checked.code === 'tooBig' ? 'tooBig' : 'invalidPng', { width: checked.width, height: checked.height });
      const { image, sha1, pixelHash } = checked;
      let written = null;
      try {
        return await mutate(async (index) => {
          const dup = index.items.find((i) => i.sha1 === sha1 || (pixelHash && i.pixelHash === pixelHash));
          if (dup) return { item: publicItem(dup), duplicate: true };
          if (index.items.length >= maxItems) throw fail('libraryFull', { max: maxItems });
          let id = makeId();
          while (index.items.some((i) => i.id === id)) id = makeId();
          const file = fileOf(id);
          await writeFileAtomic(file, buf);
          written = file;
          const at = now();
          const item = {
            id,
            name: cleanName(name) || id,
            variant: image.height === 32 ? 'classic' : VARIANTS.has(variant) ? variant : png.guessVariant(image),
            width: 64,
            height: image.height,
            size: buf.length,
            sha1,
            pixelHash,
            addedAt: at,
            updatedAt: at,
            source: SOURCES.has(source) ? source : 'file',
          };
          index.items.unshift(item);
          return { item: publicItem(item), duplicate: false };
        });
      } catch (err) {
        if (written) await fsp.rm(written, { force: true }).catch(() => {});
        throw err;
      }
    },

    async rename(id, name) {
      const clean = cleanName(name);
      if (!clean) throw fail('badName');
      return mutate((index) => {
        const it = index.items.find((i) => i.id === id);
        if (!it) throw fail('notFound');
        it.name = clean;
        it.updatedAt = now();
        return publicItem(it);
      });
    },

    async setVariant(id, variant) {
      if (!VARIANTS.has(variant)) throw fail('badVariant');
      return mutate((index) => {
        const it = index.items.find((i) => i.id === id);
        if (!it) throw fail('notFound');
        if (it.height === 32 && variant !== 'classic') throw fail('legacyVariant');
        it.variant = variant;
        it.updatedAt = now();
        return publicItem(it);
      });
    },

    // Saca el item del indice y manda el archivo a la papelera (si la papelera falla, lo borra).
    async remove(id) {
      if (typeof id !== 'string' || !ID.test(id)) throw fail('notFound');
      const removed = await mutate((index) => {
        const i = index.items.findIndex((it) => it.id === id);
        if (i < 0) throw fail('notFound');
        return index.items.splice(i, 1)[0];
      });
      const file = fileOf(removed.id);
      let gone = false;
      if (trash) gone = await trash(file).then(() => true, () => false);
      if (!gone) await fsp.rm(file, { force: true }).catch(() => {});
      return { id: removed.id };
    },
  };
}

module.exports = { createLibrary, cleanName, nameFromFile, MAX_ITEMS, MAX_BYTES };
