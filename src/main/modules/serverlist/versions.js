'use strict';
// Numeros de protocolo de Minecraft -> versiones (de menor a mayor dentro de cada protocolo).
// Sirve para saber que version usa un servidor cuando su "version.name" no lo dice claro
// ("Requires MC 1.8 / 1.21", "Velocity 3.4", "BungeeCord 1.8.x-1.21.x"...).
// La tabla trae las versiones conocidas y se completa sola con las nuevas (refresh()).

// Protocolo "netty" (1.7 en adelante)
const NETTY = {
  4: ['1.7.2', '1.7.4', '1.7.5'],
  5: ['1.7.6', '1.7.7', '1.7.8', '1.7.9', '1.7.10'],
  47: ['1.8', '1.8.1', '1.8.2', '1.8.3', '1.8.4', '1.8.5', '1.8.6', '1.8.7', '1.8.8', '1.8.9'],
  107: ['1.9'],
  108: ['1.9.1'],
  109: ['1.9.2'],
  110: ['1.9.3', '1.9.4'],
  210: ['1.10', '1.10.1', '1.10.2'],
  315: ['1.11'],
  316: ['1.11.1', '1.11.2'],
  335: ['1.12'],
  338: ['1.12.1'],
  340: ['1.12.2'],
  393: ['1.13'],
  401: ['1.13.1'],
  404: ['1.13.2'],
  477: ['1.14'],
  480: ['1.14.1'],
  485: ['1.14.2'],
  490: ['1.14.3'],
  498: ['1.14.4'],
  573: ['1.15'],
  575: ['1.15.1'],
  578: ['1.15.2'],
  735: ['1.16'],
  736: ['1.16.1'],
  751: ['1.16.2'],
  753: ['1.16.3'],
  754: ['1.16.4', '1.16.5'],
  755: ['1.17'],
  756: ['1.17.1'],
  757: ['1.18', '1.18.1'],
  758: ['1.18.2'],
  759: ['1.19'],
  760: ['1.19.1', '1.19.2'],
  761: ['1.19.3'],
  762: ['1.19.4'],
  763: ['1.20', '1.20.1'],
  764: ['1.20.2'],
  765: ['1.20.3', '1.20.4'],
  766: ['1.20.5', '1.20.6'],
  767: ['1.21', '1.21.1'],
  768: ['1.21.2', '1.21.3'],
  769: ['1.21.4'],
  770: ['1.21.5'],
  771: ['1.21.6'],
  772: ['1.21.7', '1.21.8'],
  773: ['1.21.9', '1.21.10'],
  774: ['1.21.11'],
  775: ['26.1', '26.1.1', '26.1.2'],
  776: ['26.2'],
  777: ['26.3'],
};

// Ping heredado (1.3 a 1.6): los numeros se repiten con los de netty, por eso van aparte.
const LEGACY = {
  39: ['1.3.1', '1.3.2'],
  47: ['1.4.2'],
  49: ['1.4.4', '1.4.5'],
  51: ['1.4.6', '1.4.7'],
  60: ['1.5', '1.5.1'],
  61: ['1.5.2'],
  73: ['1.6.1'],
  74: ['1.6.2'],
  78: ['1.6.4'],
};

const RELEASE_RE = /^\d+\.\d+(\.\d+)?$/;
const BY_VERSION = new Map();
let latestProtocol = 0;

function cmp(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

function index() {
  BY_VERSION.clear();
  for (const [proto, list] of Object.entries(NETTY)) {
    list.sort(cmp);
    for (const v of list) BY_VERSION.set(v, Number(proto));
  }
  latestProtocol = Math.max(...Object.keys(NETTY).map(Number));
}
index();

// Suma versiones nuevas a la tabla: [{ minecraftVersion, version (protocolo), usesNetty }]
function extend(list) {
  if (!Array.isArray(list)) return 0;
  let added = 0;
  for (const e of list) {
    const v = String(e?.minecraftVersion || '');
    const p = Number(e?.version);
    if (!e?.usesNetty || !RELEASE_RE.test(v) || !Number.isInteger(p) || p <= 0 || p >= 0x40000000) continue;
    if (BY_VERSION.has(v)) continue;
    (NETTY[p] = NETTY[p] || []).push(v);
    added++;
  }
  if (added) index();
  return added;
}

// Descarga la lista publica de protocolos (PrismarineJS) para conocer versiones posteriores a esta tabla.
const PROTOCOLS_URL = 'https://raw.githubusercontent.com/PrismarineJS/minecraft-data/master/data/pc/common/protocolVersions.json';
let refreshing = null;
function refresh() {
  if (!refreshing) {
    refreshing = (async () => {
      try {
        const http = require('../../core/http');
        const paths = require('../../core/paths');
        const data = await Promise.race([
          http.getJson(PROTOCOLS_URL, { cacheFile: paths.cache('serverlist-protocols.json'), cacheMaxAge: 3 * 24 * 3600 * 1000, retries: 1 }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 6000)),
        ]);
        return extend(data);
      } catch {
        return 0; // sin internet: alcanza con la tabla incluida
      }
    })();
  }
  return refreshing;
}

// Protocolo de una version de Minecraft ("1.20.1" -> 763) o null si no se conoce.
function protocolOf(version) {
  return BY_VERSION.get(String(version || '')) ?? null;
}

// Versiones de un protocolo (de menor a mayor)
function versionsOf(protocol) {
  return NETTY[protocol] ? [...NETTY[protocol]] : [];
}

// "1.21.4", "1.8.x" (-> 1.8) o "26.x" (-> 26: cualquier 26.*)
const VERSION_TOKEN = /(?:^|[^\w.])(\d+(?:\.\d+){1,2}|\d{2}(?=\.x))(?:\.x)?(?![\w.]*\d)/g;

// Versiones que aparecen en un texto ("Paper 1.21.1" -> ['1.21.1'], "1.8.x-1.21.x" -> ['1.8', '1.21'])
function versionTokens(text) {
  const out = [];
  const s = String(text || '').replace(/§./g, '');
  for (const m of s.matchAll(VERSION_TOKEN)) {
    const v = m[1];
    // descarta numeros que no parecen versiones de Minecraft (Velocity 3.4.0...)
    if (/^1\.\d{1,2}(\.\d{1,2})?$/.test(v) || /^(2[5-9]|[3-9]\d)(\.\d{1,2}){0,2}$/.test(v)) out.push(v);
  }
  return [...new Set(out)];
}

// "1.21.4" -> "1.21"; "26.1.2" -> "26.1"
function family(v) {
  return String(v).split('.').slice(0, 2).join('.');
}

// Compara una version solo hasta el largo del token: ("26.3", "26") -> 0; ("1.21.4", "1.21") -> 0
function cmpPrefix(v, token) {
  const pv = String(v).split('.').map(Number);
  const pt = String(token).split('.').map(Number);
  for (let i = 0; i < pt.length; i++) {
    const d = (pv[i] || 0) - (pt[i] || 0);
    if (d) return d;
  }
  return 0;
}

// Ultima version conocida que empieza con el token ("1.21" -> "1.21.11", "26" -> "26.3")
function latestInFamily(token) {
  let best = null;
  for (const v of BY_VERSION.keys()) if (cmpPrefix(v, token) === 0 && (!best || cmp(v, best) > 0)) best = v;
  return best;
}

const inRange = (v, range) => cmpPrefix(v, range[0]) >= 0 && cmpPrefix(v, range[1]) <= 0;

// Versiones conocidas entre dos tokens (inclusive), de la mas nueva a la mas vieja
function versionsInRange(min, max) {
  return [...BY_VERSION.keys()].filter((v) => inRange(v, [min, max])).sort((a, b) => cmp(b, a));
}

/**
 * Mejor estimacion de la version de Minecraft de un servidor.
 * { name, protocol, legacy } -> { mcVersion, range: [min, max] | null, exact, placeholder }
 * placeholder = el protocolo informado no corresponde a lo que dice el nombre (proxies multi-version).
 */
function resolve({ name, protocol, legacy = false } = {}) {
  const tokens = versionTokens(name);
  const table = legacy ? LEGACY : NETTY;
  const byProto = Number.isInteger(protocol) && table[protocol] ? [...table[protocol]].sort(cmp) : null;
  let range = null;
  if (tokens.length >= 2) {
    const sorted = [...tokens].sort(cmp);
    range = [sorted[0], sorted.at(-1)];
  }
  const concrete = (tk) => (protocolOf(tk) ? tk : latestInFamily(tk) || (tk.includes('.') ? tk : null));
  // Snapshots: el protocolo lleva el bit 30 y el nombre es la version ("25w14a", "26.4-snapshot-5")
  if (!legacy && Number.isInteger(protocol) && protocol >= 0x40000000) {
    const sn = String(name || '').replace(/§./g, '').trim();
    if (/^(\d{2}w\d{2}[a-z]|\d+\.\d+(\.\d+)?-(snapshot|pre|rc)-\d+)$/i.test(sn)) return { mcVersion: sn, range: null, exact: true, placeholder: false };
  }
  if (byProto) {
    const protoVersion = byProto.at(-1);
    if (range) {
      if (inRange(protoVersion, range)) return { mcVersion: protoVersion, range, exact: byProto.length === 1, placeholder: false };
      // Protocolo mas nuevo que el rango del nombre: el nombre quedo viejo ("1.8.x - 1.20.x" con 26.3).
      if (cmpPrefix(protoVersion, range[1]) > 0) return { mcVersion: protoVersion, range: [range[0], protoVersion], exact: byProto.length === 1, placeholder: false };
      // Mas viejo que el rango: es un protocolo "de relleno" para clientes desconocidos (CubeCraft responde 1.12.2).
      return { mcVersion: concrete(range[1]) || protoVersion, range, exact: false, placeholder: true };
    }
    if (tokens.length === 1 && byProto.includes(tokens[0])) return { mcVersion: tokens[0], range, exact: true, placeholder: false };
    if (tokens.length === 1 && !legacy && cmpPrefix(protoVersion, tokens[0]) !== 0) {
      // "We support 1.20" con el protocolo de otra version: manda el nombre
      return { mcVersion: concrete(tokens[0]) || protoVersion, range, exact: false, placeholder: true };
    }
    // Mismo protocolo, varias versiones: la ultima es la mas usada (1.20.1, 1.21.1, 1.8.9...)
    return { mcVersion: protoVersion, range, exact: byProto.length === 1, placeholder: false };
  }
  // Protocolo desconocido (snapshots o versiones nuevas): usar lo que diga el nombre.
  if (tokens.length) {
    const top = [...tokens].sort(cmp).at(-1);
    return { mcVersion: concrete(top), range, exact: tokens.length === 1, placeholder: false };
  }
  return { mcVersion: null, range, exact: false, placeholder: false };
}

module.exports = {
  NETTY,
  LEGACY,
  get LATEST_PROTOCOL() {
    return latestProtocol;
  },
  protocolOf,
  versionsOf,
  versionTokens,
  versionsInRange,
  inRange,
  latestInFamily,
  family,
  resolve,
  extend,
  refresh,
  compareVersions: cmp,
};
