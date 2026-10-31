'use strict';
// ZIP por streaming (con ZIP64) para copias de mundos: no carga los archivos en memoria, asi que
// sirve para mundos de varios GB. Escribe con descriptores de datos y lee con el directorio central.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
const { once } = require('events');

const MAX32 = 0xffffffff;
const MAX16 = 0xffff;
// Archivos que ya vienen comprimidos: se guardan sin volver a comprimir.
const STORED = new Set(['.zip', '.jar', '.png', '.jpg', '.jpeg', '.gz', '.ogg', '.mp3', '.7z', '.rar', '.mcpack']);

function dosDateTime(ms) {
  const d = new Date(ms || Date.now());
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

// Escritor con contrapresion y contador de bytes.
function createOutput(file) {
  const out = fs.createWriteStream(file);
  let offset = 0;
  let failed = null;
  out.on('error', (err) => {
    failed = err;
  });
  return {
    get offset() {
      return offset;
    },
    async write(buf) {
      if (failed) throw failed;
      offset += buf.length;
      if (!out.write(buf)) await once(out, 'drain');
    },
    async close() {
      if (failed) throw failed;
      out.end();
      await once(out, 'finish');
    },
    destroy() {
      out.destroy();
    },
  };
}

async function walk(base, rel, out, exclude) {
  let entries = [];
  try {
    entries = await fsp.readdir(path.join(base, rel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (exclude && exclude(r, e)) continue;
    if (e.isDirectory()) {
      out.push({ rel: r, dir: true });
      await walk(base, r, out, exclude);
    } else if (e.isFile()) out.push({ rel: r, dir: false });
  }
}

/**
 * Crea un ZIP con el contenido de varias carpetas.
 * sources: [{ dir, prefix }] -> cada archivo queda como "<prefix>/<ruta relativa>".
 * opts: { exclude(rel, dirent), onProgress({ done, total, bytes, totalBytes }), signal, level }
 */
async function zipFolders(sources, outFile, opts = {}) {
  const items = [];
  for (const src of sources) {
    const list = [];
    await walk(src.dir, '', list, opts.exclude);
    for (const it of list) {
      const full = path.join(src.dir, ...it.rel.split('/'));
      const st = await fsp.stat(full).catch(() => null);
      if (!st) continue;
      items.push({ name: `${src.prefix ? `${src.prefix}/` : ''}${it.rel}${it.dir ? '/' : ''}`, full, dir: it.dir, size: it.dir ? 0 : st.size, mtime: st.mtimeMs });
    }
  }
  const totalBytes = items.reduce((a, i) => a + i.size, 0);
  let bytes = 0;
  let done = 0;
  const report = () => opts.onProgress && opts.onProgress({ done, total: items.length, bytes, totalBytes });
  await fsp.mkdir(path.dirname(outFile), { recursive: true });
  const tmp = `${outFile}.part`;
  const out = createOutput(tmp);
  const central = [];
  try {
    for (const it of items) {
      if (opts.signal?.aborted) throw opts.signal.reason || new Error('aborted');
      const nameBuf = Buffer.from(it.name, 'utf8');
      const { time, date } = dosDateTime(it.mtime);
      const stored = it.dir || STORED.has(path.extname(it.name).toLowerCase());
      const method = stored ? 0 : 8;
      const zip64 = it.size >= MAX32 - 64 * 1024 * 1024;
      const offset = out.offset;
      // Cabecera local (tamaños y CRC van en el descriptor de datos posterior)
      const extra = zip64 ? Buffer.alloc(20) : Buffer.alloc(0);
      if (zip64) {
        extra.writeUInt16LE(0x0001, 0);
        extra.writeUInt16LE(16, 2);
      }
      const head = Buffer.alloc(30);
      head.writeUInt32LE(0x04034b50, 0);
      head.writeUInt16LE(zip64 ? 45 : 20, 4);
      head.writeUInt16LE(0x0808, 6);
      head.writeUInt16LE(method, 8);
      head.writeUInt16LE(time, 10);
      head.writeUInt16LE(date, 12);
      head.writeUInt32LE(0, 14);
      head.writeUInt32LE(zip64 ? MAX32 : 0, 18);
      head.writeUInt32LE(zip64 ? MAX32 : 0, 22);
      head.writeUInt16LE(nameBuf.length, 26);
      head.writeUInt16LE(extra.length, 28);
      await out.write(head);
      await out.write(nameBuf);
      if (extra.length) await out.write(extra);

      let crc = 0;
      let usize = 0;
      let csize = 0;
      if (!it.dir) {
        const input = fs.createReadStream(it.full, { highWaterMark: 1024 * 1024 });
        if (method === 8) {
          const deflate = zlib.createDeflateRaw({ level: opts.level ?? 6 });
          let pumpErr = null;
          // La lectura alimenta al compresor mientras este bucle escribe su salida.
          const pump = (async () => {
            for await (const chunk of input) {
              crc = zlib.crc32(chunk, crc);
              usize += chunk.length;
              bytes += chunk.length;
              if (!deflate.write(chunk)) await once(deflate, 'drain');
            }
            deflate.end();
          })().catch((err) => {
            pumpErr = err;
            deflate.destroy(err);
          });
          let finished = false;
          try {
            for await (const chunk of deflate) {
              csize += chunk.length;
              await out.write(chunk);
              report();
            }
            finished = true;
          } finally {
            if (!finished) {
              // Corta la lectura (y una posible espera de 'drain') para que el bombeo termine.
              input.destroy();
              deflate.on('error', () => {});
              deflate.destroy(new Error('aborted'));
            }
            await pump;
          }
          if (pumpErr) throw pumpErr;
        } else {
          for await (const chunk of input) {
            crc = zlib.crc32(chunk, crc);
            usize += chunk.length;
            bytes += chunk.length;
            csize += chunk.length;
            await out.write(chunk);
            report();
          }
        }
      }
      const big = zip64 || usize >= MAX32 || csize >= MAX32;
      const desc = Buffer.alloc(zip64 ? 24 : 16);
      desc.writeUInt32LE(0x08074b50, 0);
      desc.writeUInt32LE(crc >>> 0, 4);
      if (zip64) {
        desc.writeBigUInt64LE(BigInt(csize), 8);
        desc.writeBigUInt64LE(BigInt(usize), 16);
      } else {
        if (big) throw new Error(`zip64 required for ${it.name}`);
        desc.writeUInt32LE(csize, 8);
        desc.writeUInt32LE(usize, 12);
      }
      await out.write(desc);
      central.push({ nameBuf, method, time, date, crc: crc >>> 0, csize, usize, offset, dir: it.dir });
      done++;
      report();
    }

    // Directorio central
    const cdStart = out.offset;
    for (const c of central) {
      const needs = { u: c.usize >= MAX32, c: c.csize >= MAX32, o: c.offset >= MAX32 };
      const fields = [];
      if (needs.u) fields.push(c.usize);
      if (needs.c) fields.push(c.csize);
      if (needs.o) fields.push(c.offset);
      const extra = Buffer.alloc(fields.length ? 4 + fields.length * 8 : 0);
      if (fields.length) {
        extra.writeUInt16LE(0x0001, 0);
        extra.writeUInt16LE(fields.length * 8, 2);
        fields.forEach((v, i) => extra.writeBigUInt64LE(BigInt(v), 4 + i * 8));
      }
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0);
      h.writeUInt16LE(45, 4);
      h.writeUInt16LE(fields.length ? 45 : 20, 6);
      h.writeUInt16LE(0x0808, 8);
      h.writeUInt16LE(c.method, 10);
      h.writeUInt16LE(c.time, 12);
      h.writeUInt16LE(c.date, 14);
      h.writeUInt32LE(c.crc, 16);
      h.writeUInt32LE(needs.c ? MAX32 : c.csize, 20);
      h.writeUInt32LE(needs.u ? MAX32 : c.usize, 24);
      h.writeUInt16LE(c.nameBuf.length, 28);
      h.writeUInt16LE(extra.length, 30);
      h.writeUInt16LE(0, 32);
      h.writeUInt16LE(0, 34);
      h.writeUInt16LE(0, 36);
      h.writeUInt32LE(c.dir ? 0x10 : 0, 38);
      h.writeUInt32LE(needs.o ? MAX32 : c.offset, 42);
      await out.write(h);
      await out.write(c.nameBuf);
      if (extra.length) await out.write(extra);
    }
    const cdSize = out.offset - cdStart;
    const zip64End = central.length >= MAX16 || cdStart >= MAX32 || cdSize >= MAX32;
    if (zip64End) {
      const recOffset = out.offset;
      const rec = Buffer.alloc(56);
      rec.writeUInt32LE(0x06064b50, 0);
      rec.writeBigUInt64LE(44n, 4);
      rec.writeUInt16LE(45, 12);
      rec.writeUInt16LE(45, 14);
      rec.writeUInt32LE(0, 16);
      rec.writeUInt32LE(0, 20);
      rec.writeBigUInt64LE(BigInt(central.length), 24);
      rec.writeBigUInt64LE(BigInt(central.length), 32);
      rec.writeBigUInt64LE(BigInt(cdSize), 40);
      rec.writeBigUInt64LE(BigInt(cdStart), 48);
      const loc = Buffer.alloc(20);
      loc.writeUInt32LE(0x07064b50, 0);
      loc.writeUInt32LE(0, 4);
      loc.writeBigUInt64LE(BigInt(recOffset), 8);
      loc.writeUInt32LE(1, 16);
      await out.write(rec);
      await out.write(loc);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(Math.min(central.length, MAX16), 8);
    end.writeUInt16LE(Math.min(central.length, MAX16), 10);
    end.writeUInt32LE(Math.min(cdSize, MAX32), 12);
    end.writeUInt32LE(Math.min(cdStart, MAX32), 16);
    end.writeUInt16LE(0, 20);
    await out.write(end);
    await out.close();
    await fsp.rename(tmp, outFile);
    return { file: outFile, entries: central.length, size: (await fsp.stat(outFile)).size, bytes: totalBytes };
  } catch (err) {
    out.destroy();
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

// ---------- Lectura ----------

async function readAt(fh, pos, len) {
  const buf = Buffer.alloc(len);
  let read = 0;
  while (read < len) {
    const { bytesRead } = await fh.read(buf, read, len - read, pos + read);
    if (!bytesRead) break;
    read += bytesRead;
  }
  return buf.subarray(0, read);
}

// Devuelve las entradas del directorio central: [{ name, method, crc, csize, usize, offset, dir }]
async function listEntries(file) {
  const fh = await fsp.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const tailLen = Math.min(size, 65557);
    const tail = await readAt(fh, size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('invalid zip');
    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);
    if (count === MAX16 || cdSize === MAX32 || cdOffset === MAX32) {
      const locPos = size - tailLen + eocd - 20;
      const loc = await readAt(fh, locPos, 20);
      if (loc.readUInt32LE(0) === 0x07064b50) {
        const recPos = Number(loc.readBigUInt64LE(8));
        const rec = await readAt(fh, recPos, 56);
        if (rec.readUInt32LE(0) !== 0x06064b50) throw new Error('invalid zip64');
        count = Number(rec.readBigUInt64LE(32));
        cdSize = Number(rec.readBigUInt64LE(40));
        cdOffset = Number(rec.readBigUInt64LE(48));
      }
    }
    const cd = await readAt(fh, cdOffset, cdSize);
    const out = [];
    let p = 0;
    for (let i = 0; i < count && p + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error('invalid zip directory');
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const crc = cd.readUInt32LE(p + 16);
      let csize = cd.readUInt32LE(p + 20);
      let usize = cd.readUInt32LE(p + 24);
      const nlen = cd.readUInt16LE(p + 28);
      const xlen = cd.readUInt16LE(p + 30);
      const clen = cd.readUInt16LE(p + 32);
      let offset = cd.readUInt32LE(p + 42);
      const name = cd.subarray(p + 46, p + 46 + nlen).toString(flags & 0x0800 ? 'utf8' : 'latin1');
      const extra = cd.subarray(p + 46 + nlen, p + 46 + nlen + xlen);
      let q = 0;
      while (q + 4 <= extra.length) {
        const tag = extra.readUInt16LE(q);
        const len = extra.readUInt16LE(q + 2);
        if (tag === 0x0001) {
          let r = q + 4;
          if (usize === MAX32) {
            usize = Number(extra.readBigUInt64LE(r));
            r += 8;
          }
          if (csize === MAX32) {
            csize = Number(extra.readBigUInt64LE(r));
            r += 8;
          }
          if (offset === MAX32) offset = Number(extra.readBigUInt64LE(r));
        }
        q += 4 + len;
      }
      out.push({ name, method, crc, csize, usize, offset, dir: name.endsWith('/') });
      p += 46 + nlen + xlen + clen;
    }
    return out;
  } finally {
    await fh.close();
  }
}

// Ruta segura dentro de la carpeta destino (evita "../", rutas absolutas y unidades).
function safeTarget(destDir, name) {
  const clean = name.replace(/\\/g, '/');
  if (/^([a-zA-Z]:|\/)/.test(clean) || clean.split('/').some((seg) => seg === '..')) return null;
  const target = path.resolve(destDir, ...clean.split('/').filter(Boolean));
  const root = path.resolve(destDir);
  return target === root || target.startsWith(root + path.sep) ? target : null;
}

/**
 * Extrae un ZIP en destDir. opts: { onProgress({ done, total, bytes, totalBytes }), signal, filter(name) }
 */
async function unzip(file, destDir, opts = {}) {
  const entries = (await listEntries(file)).filter((e) => !opts.filter || opts.filter(e.name));
  const totalBytes = entries.reduce((a, e) => a + e.usize, 0);
  let bytes = 0;
  let done = 0;
  const fh = await fsp.open(file, 'r');
  try {
    for (const e of entries) {
      if (opts.signal?.aborted) throw opts.signal.reason || new Error('aborted');
      const target = safeTarget(destDir, e.name);
      if (!target) continue;
      if (e.dir) {
        await fsp.mkdir(target, { recursive: true });
        done++;
        continue;
      }
      if (e.method !== 0 && e.method !== 8) throw new Error(`unsupported zip method ${e.method}`);
      const lh = await readAt(fh, e.offset, 30);
      if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error('invalid zip entry');
      const start = e.offset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      const output = fs.createWriteStream(target);
      let crc = 0;
      let written = 0;
      const input = e.csize ? fs.createReadStream(file, { start, end: start + e.csize - 1, highWaterMark: 1024 * 1024 }) : null;
      let source = [];
      if (input && e.method === 8) {
        const inflate = zlib.createInflateRaw();
        input.on('error', (err) => inflate.destroy(err));
        source = input.pipe(inflate);
      } else if (input) source = input;
      try {
        for await (const chunk of source) {
          crc = zlib.crc32(chunk, crc);
          written += chunk.length;
          bytes += chunk.length;
          if (!output.write(chunk)) await once(output, 'drain');
          if (opts.onProgress) opts.onProgress({ done, total: entries.length, bytes, totalBytes });
        }
      } catch (err) {
        output.destroy();
        input?.destroy();
        throw err;
      }
      output.end();
      await once(output, 'finish');
      if ((crc >>> 0) !== e.crc || written !== e.usize) throw new Error(`zip crc mismatch: ${e.name}`);
      done++;
      if (opts.onProgress) opts.onProgress({ done, total: entries.length, bytes, totalBytes });
    }
  } finally {
    await fh.close();
  }
  return { entries: done, bytes };
}

module.exports = { zipFolders, unzip, listEntries, safeTarget };
