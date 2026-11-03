'use strict';
// Plantillas de mensajes del juego para gamelog.js, leidas de los archivos del propio Minecraft (nada viene escrito
// aca): el ingles sale del .jar del cliente de esa version y el idioma elegido en el juego (options.txt) de sus assets.
// Asi valen para cualquier version e idioma. Si algo no se puede leer, se sigue con lo que haya. Sin Electron.
const fsp = require('fs/promises');
const path = require('path');
const { wantedKey } = require('./gamelog');
const { ZipReader } = require('../modtranslate/zip');

const DEFAULT_LANG = 'en_us';
const JAR_ENTRIES = ['assets/minecraft/lang/en_us.json', 'assets/minecraft/lang/en_us.lang', 'assets/minecraft/lang/en_US.lang'];

// Idioma del juego en options.txt ("lang:es_ar"); sin el archivo (primera vez) el juego arranca en ingles
async function readLanguage(instanceDir) {
  if (!instanceDir) return DEFAULT_LANG;
  try {
    const text = await fsp.readFile(path.join(instanceDir, 'options.txt'), 'utf8');
    const m = /^lang:([A-Za-z0-9_-]{2,20})\s*$/m.exec(text);
    return m ? m[1] : DEFAULT_LANG;
  } catch {
    return DEFAULT_LANG;
  }
}

// Texto de un archivo de idioma a { clave: texto }: JSON desde 1.13; antes, lineas "clave=texto"
function parseLang(text) {
  const s = String(text ?? '').replace(/^﻿/, '');
  if (s.trimStart().startsWith('{')) {
    try {
      const data = JSON.parse(s);
      return data && typeof data === 'object' ? data : {};
    } catch {
      return {};
    }
  }
  const out = {};
  for (const line of s.split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq > 0 && !line.startsWith('#')) out[line.slice(0, eq).trim()] = line.slice(eq + 1);
  }
  return out;
}

// Solo las claves que usa gamelog.js (de un archivo con miles)
function pickKeys(all) {
  const out = {};
  for (const [key, value] of Object.entries(all || {})) if (typeof value === 'string' && wantedKey(key)) out[key] = value;
  return out;
}

// Tabla de un idioma desde los assets: indexes/<indice>.json dice que objeto es minecraft/lang/<idioma>
async function assetTable({ assetsDir, indexId, lang }) {
  if (!assetsDir || !indexId || !lang) return null;
  let index;
  try {
    index = JSON.parse(await fsp.readFile(path.join(assetsDir, 'indexes', `${indexId}.json`), 'utf8'));
  } catch {
    return null;
  }
  const wanted = new Set([`minecraft/lang/${lang}.json`, `minecraft/lang/${lang}.lang`].map((k) => k.toLowerCase()));
  const key = Object.keys(index?.objects || {}).find((k) => wanted.has(k.toLowerCase()));
  const hash = key && index.objects[key]?.hash;
  if (!hash || !/^[0-9a-f]{40}$/.test(hash)) return null;
  try {
    return pickKeys(parseLang(await fsp.readFile(path.join(assetsDir, 'objects', hash.slice(0, 2), hash), 'utf8')));
  } catch {
    return null;
  }
}

// Tabla en ingles desde el .jar del cliente (no esta en los assets). Se guarda en cacheFile para no volver a abrirlo.
async function clientTable({ jarPath, cacheFile }) {
  if (cacheFile) {
    try {
      const cached = JSON.parse(await fsp.readFile(cacheFile, 'utf8'));
      if (cached && typeof cached === 'object' && Object.keys(cached).length) return cached;
    } catch {
      /* todavia no esta */
    }
  }
  if (!jarPath) return null;
  let zip = null;
  try {
    // ZipReader lee solo lo que hace falta: abrir un .jar de 40 MB con adm-zip traba el proceso principal casi 1 s
    zip = await ZipReader.open(jarPath);
    const entry = JAR_ENTRIES.map((n) => zip.get(n)).find(Boolean);
    if (!entry) return null;
    const table = pickKeys(parseLang((await zip.read(entry)).toString('utf8')));
    if (cacheFile && Object.keys(table).length) {
      await fsp.mkdir(path.dirname(cacheFile), { recursive: true });
      await fsp.writeFile(cacheFile, JSON.stringify(table));
    }
    return table;
  } catch (err) {
    console.warn('[capture] idioma del juego:', err?.message || err);
    return null;
  } finally {
    await zip?.close();
  }
}

// Tablas de una partida para GameLogReader: siempre el ingles (lo que un servidor manda ya escrito suele estar en
// ingles) y, si es otro, el idioma elegido en el juego
async function loadTables({ assetsDir, indexId, lang, jarPath, cacheFile }) {
  const tables = [];
  const english = await clientTable({ jarPath, cacheFile });
  if (english) tables.push(english);
  if (lang && lang.toLowerCase() !== DEFAULT_LANG) {
    const own = await assetTable({ assetsDir, indexId, lang });
    if (own) tables.push(own);
  }
  return tables;
}

module.exports = { readLanguage, parseLang, pickKeys, assetTable, clientTable, loadTables, DEFAULT_LANG };
