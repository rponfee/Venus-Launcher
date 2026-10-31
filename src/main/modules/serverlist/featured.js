'use strict';
// Servidores destacados: tabla featured_servers de Supabase (si la nube esta configurada) o la lista
// incluida con el launcher. La consulta va directo a PostgREST con la anon key (solo lectura por RLS).
const cloudDefaults = require('../../core/cloud-defaults');
const paths = require('../../core/paths');
const i18n = require('../../core/i18n');
const { readJson, writeJson } = require('../../core/util');
const { parseAddress } = require('./address');
const BUNDLED = require('./featured.json');

const MEMORY_TTL = 10 * 60 * 1000;
let memory = null; // { at, url, rows }

// Siempre el proyecto del launcher (core/cloud-defaults.js): los ajustes viejos (settings.cloud) se ignoran.
async function cloudConfig() {
  const cfg = cloudDefaults.config();
  return cfg.configured ? { url: cfg.url, anonKey: cfg.anonKey } : null;
}

async function queryCloud(cfg) {
  const select = 'id,name,address,description,descriptions,tags,language,region,version,partner,sort';
  const url = `${cfg.url}/rest/v1/featured_servers?select=${select}&active=eq.true&order=partner.desc,sort.asc,name.asc&limit=60`;
  const headers = { apikey: cfg.anonKey, Accept: 'application/json' };
  // Las anon key "clasicas" son JWT y van tambien como Bearer; las publishable (sb_publishable_...) no.
  if (/^eyJ/.test(cfg.anonKey)) headers.Authorization = `Bearer ${cfg.anonKey}`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error('featured_servers: respuesta inválida');
  return rows;
}

function lang() {
  return String(i18n.getLanguage() || 'es').toLowerCase();
}

const TAG_RE = /^[a-z0-9-]{1,24}$/;

function normalize(row, source) {
  const addr = parseAddress(row.address);
  if (!addr) return null;
  const l = lang();
  const descs = row.descriptions && typeof row.descriptions === 'object' && !Array.isArray(row.descriptions) ? row.descriptions : {};
  let description = '';
  if (source === 'bundled') description = i18n.t(`serverlist.featured_${row.id}`);
  else description = String(descs[l] || descs[l.split('-')[0]] || row.description || descs.en || '');
  if (description === `serverlist.featured_${row.id}`) description = '';
  return {
    id: String(row.id),
    name: String(row.name || addr.display).slice(0, 64),
    address: addr.display,
    description: description.slice(0, 300),
    tags: (Array.isArray(row.tags) ? row.tags : []).map((tg) => String(tg).toLowerCase().trim()).filter((tg) => TAG_RE.test(tg)).slice(0, 6),
    language: String(row.language || '').slice(0, 8) || null,
    region: String(row.region || '').slice(0, 16) || null,
    version: String(row.version || '').slice(0, 40) || null,
    partner: Boolean(row.partner),
    sort: Number.isFinite(Number(row.sort)) ? Number(row.sort) : 100,
    source,
  };
}

function bundled() {
  return BUNDLED.map((r) => normalize(r, 'bundled')).filter(Boolean);
}

/**
 * Lista de destacados: [{ id, name, address, description, tags, language, region, version, partner, sort, source }]
 * source: 'cloud' | 'cache' | 'bundled'
 */
async function featured({ force = false } = {}) {
  const cfg = await cloudConfig();
  if (!cfg) return bundled();
  const cacheFile = paths.cache('serverlist-featured.json');
  if (!force && memory && memory.url === cfg.url && Date.now() - memory.at < MEMORY_TTL) {
    return memory.rows.length ? memory.rows.map((r) => normalize(r, 'cloud')).filter(Boolean) : bundled();
  }
  try {
    const rows = await queryCloud(cfg);
    memory = { at: Date.now(), url: cfg.url, rows };
    await writeJson(cacheFile, { url: cfg.url, at: Date.now(), rows }).catch(() => {});
    // Tabla vacia (todavia no se cargo nada): se muestra la lista incluida
    return rows.length ? rows.map((r) => normalize(r, 'cloud')).filter(Boolean) : bundled();
  } catch (err) {
    // 404: la migracion 0006 todavia no se aplico. Sin internet: ultima copia guardada.
    if (err.status !== 404) {
      const cached = await readJson(cacheFile, null);
      if (cached?.url === cfg.url && Array.isArray(cached.rows) && cached.rows.length) return cached.rows.map((r) => normalize(r, 'cache')).filter(Boolean);
    }
    console.warn('[serverlist] destacados de la nube:', err.message);
    return bundled();
  }
}

module.exports = { featured, bundled, cloudConfig };
