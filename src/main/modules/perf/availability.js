'use strict';
// Disponibilidad de proyectos de Modrinth para una version + loader.
// Para cuidar la cuota de la API (compartida por todo el launcher): un pedido en lote para los
// proyectos, filtro local con sus versiones/loaders, pocos pedidos a la vez y cache en disco.
const paths = require('../../core/paths');
const http = require('../../core/http');
const modrinth = require('../../core/modrinth');
const { readJson, writeJson, sleep } = require('../../core/util');

const API = 'https://api.modrinth.com/v2';
const CACHE_FILE = () => paths.cache('perf-modrinth.json');
const PROJECT_TTL = 3 * 24 * 3600 * 1000;
const VERSION_TTL = 12 * 3600 * 1000;
const MISS_TTL = 6 * 3600 * 1000;
const MAX_PARALLEL = 4;

let cache = null;
let saveTimer = null;
let savePromise = null;

async function load() {
  if (!cache) {
    const data = await readJson(CACHE_FILE(), null);
    cache = data && data.v === 1 ? data : { v: 1, projects: {}, versions: {} };
  }
  return cache;
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    savePromise = writeJson(CACHE_FILE(), cache).catch(() => {});
  }, 400);
}

// Guarda la cache ya (para scripts de prueba que terminan enseguida).
async function flush() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (cache) await writeJson(CACHE_FILE(), cache).catch(() => {});
  }
  if (savePromise) await savePromise;
}

// ---------- Cola de pedidos ----------
let active = 0;
const waiting = [];

function limited(fn) {
  return new Promise((resolve, reject) => {
    const run = async () => {
      active++;
      try {
        resolve(await fn());
      } catch (err) {
        reject(err);
      } finally {
        active--;
        const next = waiting.shift();
        if (next) next();
      }
    };
    if (active < MAX_PARALLEL) run();
    else waiting.push(run);
  });
}

async function apiGet(pathname) {
  return limited(async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await http.getJson(`${API}${pathname}`, { retries: 2 });
      } catch (err) {
        // 429: la cuota se renueva cada minuto; esperamos un poco antes de reintentar
        if (err.status === 429 && attempt < 2) {
          await sleep(8000 * (attempt + 1));
          continue;
        }
        throw err;
      }
    }
  });
}

const enc = (v) => encodeURIComponent(JSON.stringify(v));

// ---------- Proyectos ----------
// Devuelve { slug: { id, slug, title, icon, type, gameVersions, loaders } | null }
async function projects(slugs) {
  const c = await load();
  const now = Date.now();
  const list = [...new Set(slugs.filter(Boolean))];
  const missing = list.filter((s) => !c.projects[s] || now - c.projects[s].at > PROJECT_TTL);
  if (missing.length) {
    try {
      for (let i = 0; i < missing.length; i += 100) {
        const chunk = missing.slice(i, i + 100);
        const data = await apiGet(`/projects?ids=${enc(chunk)}`);
        const found = new Set();
        for (const p of data || []) {
          const rec = {
            id: p.id,
            slug: p.slug,
            title: p.title,
            icon: p.icon_url || null,
            type: p.project_type,
            description: p.description || '',
            gameVersions: p.game_versions || [],
            loaders: p.loaders || [],
            at: now,
          };
          c.projects[p.slug] = rec;
          found.add(p.slug);
          found.add(p.id);
        }
        for (const s of chunk) if (!found.has(s)) c.projects[s] = { missing: true, at: now };
      }
      scheduleSave();
    } catch (err) {
      // Sin internet: si hay datos viejos en cache, sirven
      if (!list.some((s) => c.projects[s] && !c.projects[s].missing)) throw err;
    }
  }
  const out = {};
  for (const s of list) out[s] = c.projects[s] && !c.projects[s].missing ? c.projects[s] : null;
  return out;
}

// ---------- Versiones ----------
// Mejor version de un proyecto para mcVersion + loaders (release > beta > alpha), o null.
async function bestVersion(project, mcVersion, loaders) {
  const key = `${project.id}|${mcVersion}|${loaders.join(',')}`;
  const c = await load();
  const hit = c.versions[key];
  const now = Date.now();
  if (hit && now - hit.at < (hit.id ? VERSION_TTL : MISS_TTL)) return hit.id ? hit : null;
  // Filtro rapido con los datos del proyecto (sin pedidos)
  const versionOk = project.gameVersions.includes(mcVersion);
  const loaderOk = !loaders.length || loaders.some((l) => project.loaders.includes(l));
  if (!versionOk || !loaderOk) {
    c.versions[key] = { id: null, at: now };
    scheduleSave();
    return null;
  }
  try {
    const q = [`game_versions=${enc([mcVersion])}`, 'include_changelog=false'];
    if (loaders.length) q.unshift(`loaders=${enc(loaders)}`);
    const list = await apiGet(`/project/${encodeURIComponent(project.id)}/version?${q.join('&')}`);
    const v = list.find((x) => x.version_type === 'release') || list.find((x) => x.version_type === 'beta') || list[0];
    const rec = v
      ? {
          id: v.id,
          number: v.version_number,
          channel: v.version_type,
          deps: (v.dependencies || []).filter((d) => d.dependency_type === 'required' && d.project_id).map((d) => d.project_id),
          at: now,
        }
      : { id: null, at: now };
    c.versions[key] = rec;
    scheduleSave();
    return rec.id ? rec : null;
  } catch (err) {
    if (hit) return hit.id ? hit : null;
    throw err;
  }
}

// Loaders validos para mods y shaders segun el loader de la instancia (los mismos que usa la instalacion).
function loadersFor({ mcVersion, loader, preset, shaderMod = false }) {
  const pseudo = { loader, mcVersion, preset };
  const mod = modrinth.modLoadersFor(pseudo);
  let shader = [];
  if (loader === 'optifine') shader = ['optifine'];
  else if (shaderMod || preset === 'iris') shader = ['iris'];
  return { mod, shader };
}

// groups: [{ key, candidates: [slug, ...], type: 'mod' | 'shader', unless?: key }]
// Devuelve un item por grupo con el primer candidato disponible (o el primero, marcado no disponible).
async function resolveGroups(groups, { mcVersion, loaders }) {
  const meta = await projects(groups.flatMap((g) => g.candidates));
  let firstError = null;

  const resolveOne = async (g) => {
    const lds = g.type === 'shader' ? loaders.shader : loaders.mod;
    if (lds.length || g.type === 'shader') {
      for (const slug of g.candidates) {
        const p = meta[slug];
        if (!p) continue;
        if (g.type === 'shader' && !lds.length) break; // sin mod de shaders no hay donde cargarlos
        try {
          const v = await bestVersion(p, mcVersion, lds);
          if (v) return item(g, p, { available: true, versionId: v.id, versionNumber: v.number, deps: v.deps });
        } catch (err) {
          firstError = firstError || err;
        }
      }
    }
    const p = g.candidates.map((s) => meta[s]).find(Boolean);
    return item(g, p || { slug: g.candidates[0], title: g.candidates[0] }, { available: false });
  };

  // Primero los grupos normales; los "unless" solo si su grupo de referencia no se pudo resolver
  const plain = groups.filter((g) => !g.unless);
  const resolved = new Map();
  for (const [i, r] of (await Promise.all(plain.map(resolveOne))).entries()) resolved.set(plain[i].key, r);
  const conditional = groups.filter((g) => g.unless && !resolved.get(g.unless)?.available);
  for (const [i, r] of (await Promise.all(conditional.map(resolveOne))).entries()) {
    // Una alternativa que tampoco existe no suma nada: alcanza con mostrar la principal
    if (r.available) resolved.set(conditional[i].key, r);
  }
  const out = groups.filter((g) => resolved.has(g.key)).map((g) => resolved.get(g.key));
  if (firstError && !out.some((x) => x.available)) throw firstError;
  return out;
}

function item(g, p, extra) {
  return {
    key: g.key,
    projectId: p.id || null,
    slug: p.slug,
    title: p.title || p.slug,
    icon: p.icon || null,
    type: g.type || 'mod',
    ...extra,
  };
}

module.exports = { projects, bestVersion, resolveGroups, loadersFor, flush };
