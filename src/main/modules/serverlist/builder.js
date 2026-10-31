'use strict';
// "Detectar los mods de un servidor y armar la instancia compatible":
// ping -> version + loader + lista de mods (Forge/NeoForge la publican; Fabric no) -> crear la instancia ->
// buscar cada mod en Modrinth (slug/nombre + loader + version, verificado) -> instalar los encontrados.
const instances = require('../../core/instances');
const modrinth = require('../../core/modrinth');
const { t } = require('../../core/i18n');
const slp = require('./slp');
const versions = require('./versions');
const serversdat = require('./serversdat');
const { parseAddress } = require('./address');

const LOADERS = ['vanilla', 'fabric', 'quilt', 'forge', 'neoforge'];

// ---------- Modrinth con cuidado: el limite (~300 pedidos/min) lo comparte todo el launcher ----------
const RATE = 4; // pedidos por segundo
const BURST = 6;
const bucket = { tokens: BURST, last: Date.now() };

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || new Error('Cancelado'));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason || new Error('Cancelado'));
      },
      { once: true },
    );
    return undefined;
  });
}

async function takeToken(signal) {
  for (;;) {
    const now = Date.now();
    bucket.tokens = Math.min(BURST, bucket.tokens + ((now - bucket.last) / 1000) * RATE);
    bucket.last = now;
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return;
    }
    await sleep(Math.ceil(((1 - bucket.tokens) / RATE) * 1000), signal);
  }
}

async function mr(fn, signal) {
  for (let attempt = 0; ; attempt++) {
    await takeToken(signal);
    try {
      return await fn();
    } catch (err) {
      if (err?.status === 429 && attempt < 3) {
        await sleep(15000 * (attempt + 1), signal);
        continue;
      }
      throw err;
    }
  }
}

// Ejecuta tareas con un maximo de N a la vez
async function pool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

// ---------- Comparaciones ----------

// Texto -> solo letras y numeros ("Nature's Compass" -> "naturescompass")
const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
// Igual pero sin el posesivo ("Xaero's Minimap" -> "xaerominimap")
const normNoPossessive = (s) => norm(String(s || '').replace(/['’]s\b/gi, ''));

// ¿El proyecto es claramente ese mod? (slug o titulo iguales al id, ignorando separadores y posesivos)
function strongMatch(modId, slug, title) {
  const target = norm(modId);
  return norm(slug) === target || norm(title) === target || normNoPossessive(title) === target;
}

// Variantes de slug para ids "pegados": "sophisticatedbackpacks" -> "sophisticated-backpacks",
// "xaerominimap" -> "xaeros-minimap". Solo para ids de letras/numeros sin separadores.
function slugVariants(modId) {
  const id = modId.toLowerCase();
  const out = new Set();
  if (!/^[a-z0-9]{6,40}$/.test(id)) return out;
  for (let i = 3; i <= id.length - 3; i++) {
    const a = id.slice(0, i);
    const b = id.slice(i);
    if (/\d$/.test(a) && /^\d/.test(b)) continue;
    out.add(`${a}-${b}`);
    if (!a.endsWith('s')) out.add(`${a}s-${b}`);
  }
  return out;
}

function modLoaders(loader, mcVersion) {
  if (loader === 'neoforge') return mcVersion === '1.20.1' ? ['neoforge', 'forge'] : ['neoforge'];
  if (loader === 'quilt') return ['quilt', 'fabric'];
  return [loader];
}

// "2.5.1+mc1.20.1" ~ "2.5.1+mc1.20.1"; "1.20.1-1.12.0-forge" ~ "1.12.0"; ignora la version del juego
function sameVersion(candidate, wanted, mcVersion) {
  if (!candidate || !wanted) return false;
  const a = String(candidate).toLowerCase();
  const b = String(wanted).toLowerCase();
  if (a === b) return true;
  const mc = String(mcVersion || '').toLowerCase();
  const tokens = (s) => s.split(/[^a-z0-9.]+/).filter((x) => x && x !== mc && x !== `mc${mc}` && /\d\.\d/.test(x));
  const core = tokens(b).sort((x, y) => y.length - x.length)[0];
  return Boolean(core) && tokens(a).includes(core);
}

// ---------- Resolucion de mods ----------

/**
 * mods: [{ id, version }] -> { found: [{ mod, project, version, exact }], missing: [{ id, version, reason, projectSlug? }] }
 */
async function resolveMods(mods, { mcVersion, loader, signal, onProgress }) {
  const loaders = modLoaders(loader, mcVersion);
  const found = [];
  const missing = [];
  const total = mods.length;
  let done = 0;
  const tick = () => onProgress?.(++done, total);

  // Busca en bloque (un pedido cada 60 slugs) y devuelve modId -> proyecto
  const bySlug = new Map();
  async function bulk(slugToMod, accept) {
    const slugs = [...slugToMod.keys()];
    for (let i = 0; i < slugs.length; i += 60) {
      if (signal?.aborted) throw signal.reason;
      const chunk = slugs.slice(i, i + 60);
      const projects = await mr(() => modrinth.getProjects(chunk), signal).catch((err) => {
        if (signal?.aborted) throw err;
        console.warn('[serverlist] Modrinth /projects:', err.message);
        return [];
      });
      for (const p of projects || []) {
        const modId = slugToMod.get(String(p.slug).toLowerCase());
        if (!modId || bySlug.has(modId) || p.project_type !== 'mod') continue;
        if (!(p.loaders || []).some((l) => loaders.includes(l))) continue;
        if (accept(modId, p)) bySlug.set(modId, p);
      }
    }
  }

  // 1) Slug igual al id ("jei", "sophisticated_backpacks" -> "sophisticated-backpacks", "connectormod" -> "connector")
  const direct = new Map();
  for (const m of mods) {
    const id = m.id.toLowerCase();
    for (const s of [id, id.replace(/_/g, '-'), id.replace(/_/g, ''), id.replace(/[-_]?mod$/, '')]) {
      if (/^[a-z0-9][a-z0-9_-]{1,63}$/.test(s) && !direct.has(s)) direct.set(s, m.id);
    }
  }
  await bulk(direct, () => true);

  // 2) Ids "pegados": variantes con guion (y con posesivo), aceptando solo coincidencias claras
  const variants = new Map();
  for (const m of mods) {
    if (bySlug.has(m.id)) continue;
    for (const s of slugVariants(m.id)) if (!variants.has(s) && !direct.has(s)) variants.set(s, m.id);
  }
  await bulk(variants, (modId, p) => strongMatch(modId, p.slug, p.title));

  // 3) Para cada mod: proyecto (slug o busqueda) + version compatible (verificada)
  await pool(mods, 3, async (m) => {
    if (signal?.aborted) throw signal.reason;
    try {
      let project = null;
      let weak = false;
      const known = bySlug.get(m.id);
      if (known) project = { id: known.id, slug: known.slug, title: known.title, icon_url: known.icon_url || null };
      if (!project) {
        const query = m.id.replace(/[_-]+/g, ' ');
        const res = await mr(() => modrinth.search({ query, type: 'mod', gameVersion: mcVersion, loaders, limit: 8 }), signal);
        const hits = res?.hits || [];
        let hit = hits.find((hh) => strongMatch(m.id, hh.slug, hh.title));
        if (!hit && norm(m.id).length >= 6) {
          // coincidencia parcial: solo entre los primeros resultados y con la version confirmada mas abajo
          const parts = m.id.toLowerCase().split(/[_-]+/).filter((x) => x.length >= 3).map(norm);
          const has = (hh, p) => norm(hh.slug).includes(p) || norm(hh.title).includes(p) || normNoPossessive(hh.title).includes(p);
          hit = hits.slice(0, 3).find((hh) => parts.length && parts.every((p) => has(hh, p)));
          weak = Boolean(hit);
        }
        if (hit) project = { id: hit.project_id, slug: hit.slug, title: hit.title, icon_url: hit.icon_url || null };
      }
      if (!project) {
        missing.push({ id: m.id, version: m.version, reason: 'notFound' });
        return;
      }
      const list = await mr(() => modrinth.getVersions(project.id, { loaders, gameVersions: [mcVersion] }), signal);
      if (!list?.length) {
        missing.push({ id: m.id, version: m.version, reason: 'noVersion', projectSlug: project.slug, title: project.title });
        return;
      }
      const exactV = m.version ? list.find((v) => sameVersion(v.version_number, m.version, mcVersion) || sameVersion(v.name, m.version, mcVersion)) : null;
      if (weak && !exactV) {
        missing.push({ id: m.id, version: m.version, reason: 'notFound' });
        return;
      }
      const version = exactV || list.find((v) => v.version_type === 'release') || list[0];
      found.push({ mod: m, project, version, exact: Boolean(exactV) || !m.version });
    } catch (err) {
      if (signal?.aborted) throw err;
      missing.push({ id: m.id, version: m.version, reason: 'error' });
    } finally {
      tick();
    }
  });
  return { found, missing };
}

// ---------- Version del servidor ----------

// Proxies multi-version: prueba de la version mas nueva a la mas vieja cual acepta (de a una conexion,
// porque los anti-bots cortan rafagas). Incluye versiones mas nuevas que el rango del nombre, que suele
// quedar viejo ("Requires MC 1.8 / 1.21" en un servidor que ya acepta 26.3).
async function bestVersion(address, info) {
  if (info.modded || !info.mcVersion) return info.mcVersion;
  if (!info.versionRange && !info.versionPlaceholder) return info.mcVersion;
  const range = info.versionRange || [info.mcVersion, info.mcVersion];
  const latest = versions.versionsOf(versions.LATEST_PROTOCOL).at(-1) || range[1];
  const seen = new Set();
  const candidates = [];
  for (const v of versions.versionsInRange(range[0], latest)) {
    const p = versions.protocolOf(v);
    if (p && !seen.has(p)) {
      seen.add(p);
      candidates.push({ protocol: p, version: versions.versionsOf(p).at(-1) });
    }
  }
  for (const [i, c] of candidates.slice(0, 6).entries()) {
    if (i) await sleep(300);
    const ok = await slp.probe(address, c.protocol);
    if (ok === true) return c.version;
    if (ok === null) break; // el servidor empezo a cortar: no insistir
  }
  if (!info.versionPlaceholder) return info.mcVersion;
  const top = versions.protocolOf(range[1]);
  return top ? versions.versionsOf(top).at(-1) : info.mcVersion;
}

/**
 * Versiones para elegir al armar la instancia: { best, native, options: [...], fixed }
 * best = la mas nueva que acepta (probando), native = la que informa el servidor,
 * options = la ultima de cada familia dentro de su rango. fixed = servidor con mods (version exacta).
 */
async function versionOptions(address, info) {
  if (!info?.online || !info.mcVersion) return { best: info?.mcVersion || null, native: info?.mcVersion || null, options: info?.mcVersion ? [info.mcVersion] : [], fixed: false };
  if (info.modded) return { best: info.mcVersion, native: info.mcVersion, options: [info.mcVersion], fixed: true };
  const best = (await bestVersion(address, info)) || info.mcVersion;
  const range = info.versionRange || [info.mcVersion, info.mcVersion];
  const top = versions.compareVersions(best, range[1]) > 0 ? best : range[1];
  const families = new Map();
  for (const v of versions.versionsInRange(range[0], top)) {
    const fam = versions.family(v);
    if (!families.has(fam)) families.set(fam, v); // de la mas nueva a la mas vieja: la primera es el ultimo parche
  }
  const options = [...new Set([best, info.mcVersion, ...families.values()].filter(Boolean))].sort((a, b) => versions.compareVersions(b, a));
  return { best, native: info.mcVersion, options, fixed: false };
}

// Nombre lindo para la instancia: "play.cubecraft.net" -> "Cubecraft"
function suggestName(addr) {
  if (addr.ipVersion) return addr.display;
  const labels = addr.host.split('.').filter((l) => !/^(www|play|mc|hub|join|server|srv|java|connect|go)$/i.test(l));
  const core = labels.length >= 2 ? labels[labels.length - 2] : labels[0] || addr.host;
  return core.charAt(0).toUpperCase() + core.slice(1);
}

/**
 * Arma la instancia. opts: { loader?, name?, mods: true, prepare: true }
 * deps: { task, send, startPrepare(instance) } -> { instanceId, name, mcVersion, loader, loaderVersion, installed, missing, ... }
 */
async function build(address, opts = {}, { task, send, startPrepare } = {}) {
  const addr = parseAddress(address);
  if (!addr) throw new Error(t('serverlist.errInvalidAddress'));
  const signal = task?.signal;
  const update = (detail, progress) => task?.update({ detail, progress });

  update(t('serverlist.buildPinging'), 0.02);
  versions.refresh().catch(() => {});
  const info = await slp.ping(address, { force: true });
  if (!info.online) throw new Error(t('serverlist.errBuildOffline', { address: addr.display }));
  if (signal?.aborted) throw signal.reason;

  const loader = LOADERS.includes(opts.loader) ? opts.loader : info.loader && LOADERS.includes(info.loader) ? info.loader : 'vanilla';
  update(t('serverlist.buildVersion'), 0.05);
  // La version la puede fijar quien llama (la que ya le mostro al jugador)
  const forced = typeof opts.mcVersion === 'string' && /^[\w.-]{2,40}$/.test(opts.mcVersion) ? opts.mcVersion : null;
  const mcVersion = forced || (await bestVersion(address, info));
  if (!mcVersion) throw new Error(t('serverlist.errUnknownVersion'));
  const loaderVersion = loader === info.loader && info.loaderVersion ? info.loaderVersion : 'latest';
  const wantMods = opts.mods !== false && (loader === 'forge' || loader === 'neoforge') && loader === info.loader;
  const mods = wantMods ? info.mods : [];

  const name = String(opts.name || '').trim().slice(0, 60) || suggestName(addr);
  update(t('serverlist.buildCreating', { name }), 0.08);
  const inst = await instances.create({ name, mcVersion, loader, loaderVersion });
  send?.('instances:changed');
  const installed = [];
  let missing = [];
  try {
    await instances.update(inst.id, { serverlist: { address: addr.display, key: addr.key, builtAt: Date.now() } }).catch(() => {});
    if (mods.length) {
      update(t('serverlist.buildResolving', { done: 0, total: mods.length }), 0.1);
      const res = await resolveMods(mods, {
        mcVersion,
        loader,
        signal,
        onProgress: (done, total) => update(t('serverlist.buildResolving', { done, total }), 0.1 + 0.45 * (done / total)),
      });
      missing = res.missing;
      // Un proyecto puede cubrir varios mod ids: se instala una sola vez
      const byProject = new Map();
      for (const f of res.found) {
        if (!byProject.has(f.project.id)) byProject.set(f.project.id, { ...f, ids: [f.mod.id] });
        else byProject.get(f.project.id).ids.push(f.mod.id);
      }
      const plan = [...byProject.values()];
      const records = {};
      let done = 0;
      const quiet = { signal, downloadProgress: () => () => {} };
      update(t('serverlist.buildDownloading', { done: 0, total: plan.length }), 0.55);
      await pool(plan, 3, async (p) => {
        if (signal?.aborted) throw signal.reason;
        try {
          const item = { project: p.project, version: p.version, file: modrinth.primaryFile(p.version), type: 'mod' };
          Object.assign(records, await modrinth.executePlan(inst.dir, [item], { installed: {}, task: quiet }));
          for (const id of p.ids) installed.push({ id, title: p.project.title, projectId: p.project.id, slug: p.project.slug, versionNumber: p.version.version_number, wanted: p.mod.version, exact: p.exact });
        } catch (err) {
          if (signal?.aborted) throw err;
          for (const id of p.ids) missing.push({ id, version: p.mod.version, reason: 'download', projectSlug: p.project.slug, title: p.project.title });
        } finally {
          done++;
          update(t('serverlist.buildDownloading', { done, total: plan.length }), 0.55 + 0.42 * (done / plan.length));
        }
      });
      if (Object.keys(records).length) {
        const fresh = await instances.get(inst.id);
        await instances.update(inst.id, { modrinth: { ...(fresh.modrinth || {}), projects: { ...(fresh.modrinth?.projects || {}), ...records } } });
      }
    }
    // El servidor queda en la lista de multijugador de la nueva instancia
    await serversdat.add(require('path').join(instances.dir(inst.id), 'servers.dat'), { name: opts.serverName || name, ip: addr.display }).catch(() => {});
  } catch (err) {
    // Cancelado o roto a mitad de camino: no dejar una instancia a medio armar
    await instances.remove(inst.id).catch(() => {});
    send?.('instances:changed');
    throw err;
  }
  update(t('serverlist.buildDone'), 1);
  if (opts.prepare !== false && startPrepare) startPrepare(inst);
  installed.sort((a, b) => a.id.localeCompare(b.id));
  missing.sort((a, b) => a.id.localeCompare(b.id));
  return {
    instanceId: inst.id,
    name: inst.name,
    address: addr.display,
    mcVersion,
    loader,
    loaderVersion,
    detectedLoader: info.loader,
    modsListed: info.mods.length > 0,
    modsTotal: mods.length,
    installed,
    missing,
    serverOnly: info.serverOnlyMods || 0,
    truncated: Boolean(info.modsTruncated),
  };
}

module.exports = { build, resolveMods, bestVersion, versionOptions, sameVersion, suggestName, modLoaders, slugVariants, strongMatch };
