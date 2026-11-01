'use strict';
// Version y loader de un perfil del launcher oficial, a partir de lastVersionId y de versions/<id>/<id>.json
// (inheritsFrom, mainClass y librerias). Sin Electron ni red: se prueba con Node puro.
// Devuelve los mismos valores que usa la creacion de instancias de Venus (core/instances.create):
//   { ok: true, mcVersion, loader, loaderVersion }   loader: vanilla, fabric, quilt, forge, neoforge, optifine,
//                                                      legacyfabric o babric
//   { ok: false, reason, loaderName? }               reason: noVersion, latestUnknown, unsupportedLoader, unknown
const { validVersionId } = require('./profiles');

const MODDED = new Set(['fabric', 'quilt', 'forge', 'neoforge', 'legacyfabric', 'babric']);
// Loaders y clientes que existen pero Venus no instala (se listan como no importables con su nombre).
// "id" se busca en el id de la version y en la clase principal; "lib" en el comienzo de las librerias.
const UNSUPPORTED = [
  { id: /liteloader/i, lib: 'com.mumfrey:liteloader', name: 'LiteLoader' },
  { id: /labymod/i, lib: 'net.labymod', name: 'LabyMod' },
  { id: /lunar/i, lib: 'com.moonsworth', name: 'Lunar Client' },
  { id: /badlion/i, lib: 'net.badlion', name: 'Badlion' },
  { id: /riftloader|(^|[-_ ])rift([-_ ]|$)/i, lib: 'org.dimdev:riftloader', name: 'Rift' },
  { id: /feather/i, lib: 'net.digitalingot.feather', name: 'Feather' },
];

function unsupportedIn(id, json, libs) {
  const main = typeof json?.mainClass === 'string' ? json.mainClass : '';
  return UNSUPPORTED.find((u) => u.id.test(id) || (main && u.id.test(main)) || libs.some((n) => n.startsWith(u.lib))) || null;
}
const SEMVER = '\\d+\\.\\d+\\.\\d+(?:-(?:alpha|beta|rc|pre)(?:[.-]?\\d+)*)?(?:\\+[\\w.]+)?';
const FABRIC_ID = new RegExp(`^fabric-loader-(${SEMVER})-(.+)$`, 'i');
const QUILT_ID = new RegExp(`^quilt-loader-(${SEMVER})-(.+)$`, 'i');
const NEOFORGE_ID = /^neoforge-(\d+\.\d+\.\d+(?:[-.+][\w.]+)?)$/i;
const FORGE_ID = /^(\d+\.\d+(?:\.\d+)?)-forge-?(.+)$/i;
const NEO_LEGACY_ID = /^(1\.20\.1)-(47\.1\.\d+)$/;
const OPTIFINE_ID = /^(.+?)-OptiFine_(HD_.+)$/i;
const NUMERIC = /^\d+(?:\.\d+)+$/;

// Ids de versiones vanilla reconocibles sin el manifest (releases, snapshots, pre-releases y versiones viejas).
const VANILLA_PATTERNS = [
  /^1\.\d+(?:\.\d+)?$/,
  /^\d{2}\.\d+(?:\.\d+)?$/, // numeracion por anio (26.1)
  /^\d{2}w\d{2}[a-z]$/,
  /^1\.\d+(?:\.\d+)?-(?:pre|rc)-?\d+$/,
  /^\d{2}\.\d+(?:\.\d+)?-(?:snapshot|pre|rc)-\d+$/,
  /^1\.\d+(?:\.\d+)? Pre-Release \d+$/,
  /^(?:b|a)1\.\d+(?:\.\d+)?(?:_\d+)?[a-z]?$/,
  // Pre-classic, classic, indev e infdev con su forma exacta (rd-132211, c0.30_01c, in-20100223, inf-20100618)
  /^rd-\d{6,8}$/,
  /^c0\.\d+(?:\.\d+)?[a-z]?(?:_\d+[a-z]?)?$/,
  /^in-\d{8}(?:-\d{4})?$/,
  /^inf-\d{8}(?:-\d+)?$/,
];

function isModded(loader) {
  return MODDED.has(loader);
}

// ¿El id tiene la forma de una version de Mojang? (sin mirar el manifest)
function vanillaShape(id) {
  return validVersionId(id) && VANILLA_PATTERNS.some((re) => re.test(id));
}

function looksVanilla(id, manifestIds) {
  if (!validVersionId(id)) return false;
  if (manifestIds && typeof manifestIds.has === 'function' && manifestIds.size) return manifestIds.has(id);
  return vanillaShape(id);
}

// Copia de core/loaders/forge.neoforgeMc (version de NeoForge -> version de Minecraft), sin sus dependencias.
function neoforgeMc(v) {
  if (v.startsWith('0.')) return v.split('.')[1];
  const [main, suffix] = v.split('+');
  const core = main.split('-')[0];
  const p = core.split('.');
  const major = parseInt(p[0], 10);
  let mc;
  if (major >= 25) mc = p[2] && p[2] !== '0' ? `${p[0]}.${p[1]}.${p[2]}` : `${p[0]}.${p[1]}`;
  else mc = p[1] === '0' ? `1.${p[0]}` : `1.${p[0]}.${p[1]}`;
  if (suffix && /^(snapshot|pre|rc)-\d+$/.test(suffix)) mc = `${mc}-${suffix}`;
  return mc;
}

// Fabric en Minecraft viejo es Legacy Fabric (antes de 1.14) o Babric (Beta 1.7.3).
function fabricKind(mc, libs) {
  if (libs.some((n) => /(^|[.:])babric([.:]|$)|glass-launcher/i.test(n)) || /^b1\.7\.3$/.test(mc)) return 'babric';
  if (libs.some((n) => n.startsWith('net.legacyfabric'))) return 'legacyfabric';
  const m = /^1\.(\d+)(?:\.\d+)?$/.exec(mc);
  if (m && Number(m[1]) < 14) return 'legacyfabric';
  return 'fabric';
}

// "1.20.1-47.3.0", "1.12.2-14.23.5.2860", "1.7.10-10.13.4.1614-1.7.10" -> "47.3.0", "14.23.5.2860", "10.13.4.1614"
function forgeShort(v, mc) {
  let out = String(v || '');
  if (mc && out.startsWith(`${mc}-`)) out = out.slice(mc.length + 1);
  if (mc && out.endsWith(`-${mc}`)) out = out.slice(0, -(mc.length + 1));
  return NUMERIC.test(out) ? out : null;
}

function libraryNames(json) {
  const list = Array.isArray(json?.libraries) ? json.libraries : [];
  const out = [];
  for (const l of list.slice(0, 2000)) if (l && typeof l.name === 'string' && l.name.length <= 300) out.push(l.name);
  return out;
}

function libVersion(libs, prefix) {
  const hit = libs.find((n) => n.startsWith(prefix));
  if (!hit) return null;
  const v = hit.slice(prefix.length).split(':')[0].split('@')[0];
  return v || null;
}

const ok = (mcVersion, loader, loaderVersion = null) => (validVersionId(mcVersion) ? { ok: true, mcVersion, loader, loaderVersion: loaderVersion || null } : { ok: false, reason: 'unknown' });

// Lo que dicen las librerias del JSON de la version (o null si no alcanza para decidir).
function fromJson(id, json, manifestIds) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const libs = libraryNames(json);
  const parent = validVersionId(json.inheritsFrom) ? json.inheritsFrom : null;
  const bad = unsupportedIn(id, json, libs);
  if (bad) return { ok: false, reason: 'unsupportedLoader', loaderName: bad.name };
  const fabric = libVersion(libs, 'net.fabricmc:fabric-loader:');
  if (fabric && parent) return ok(parent, fabricKind(parent, libs), fabric);
  const quilt = libVersion(libs, 'org.quiltmc:quilt-loader:');
  if (quilt && parent) return ok(parent, 'quilt', quilt);
  const neo = libVersion(libs, 'net.neoforged:neoforge:');
  if (neo) return ok(parent || neoforgeMc(neo), 'neoforge', neo);
  // NeoForge para 1.20.1 todavia se publicaba como net.neoforged:forge (y su fmlloader)
  const neoLegacy = libVersion(libs, 'net.neoforged:forge:') || libVersion(libs, 'net.neoforged:fmlloader:');
  if (neoLegacy && parent) {
    const short = forgeShort(neoLegacy, parent);
    if (short) return ok(parent, 'neoforge', short);
  }
  const forge = libVersion(libs, 'net.minecraftforge:forge:') || libVersion(libs, 'net.minecraftforge:fmlloader:') || libVersion(libs, 'net.minecraftforge:minecraftforge:');
  if (forge && parent) {
    const short = forgeShort(forge, parent);
    if (short) return ok(parent, 'forge', short);
  }
  const of = libVersion(libs, 'optifine:OptiFine:');
  if (of && parent) {
    const m = /_(HD_.+)$/.exec(of);
    if (m) return ok(parent, 'optifine', m[1]);
  }
  // JSON vanilla: sin padre y con un id que Venus pueda bajar de Mojang (del manifest, o con forma de version y
  // la descarga del cliente: una release mas nueva que el manifest guardado). Una copia renombrada ("Mi Vanilla")
  // no se puede reproducir y queda como version desconocida.
  const vanillaJson = json.downloads?.client || json.mainClass === 'net.minecraft.client.main.Main';
  if (!parent && json.id === id && (looksVanilla(id, manifestIds) || (vanillaJson && vanillaShape(id)))) {
    return ok(id, 'vanilla');
  }
  return null;
}

// Solo con el id (sin JSON o con un JSON que no alcanza).
function fromId(id, manifestIds, json) {
  const bad = unsupportedIn(id, null, []);
  if (bad) return { ok: false, reason: 'unsupportedLoader', loaderName: bad.name };
  let m = FABRIC_ID.exec(id);
  if (m) return ok(m[2], fabricKind(m[2], libraryNames(json)), m[1]);
  m = QUILT_ID.exec(id);
  if (m) return ok(m[2], 'quilt', m[1]);
  m = NEOFORGE_ID.exec(id);
  if (m) return ok(neoforgeMc(m[1]), 'neoforge', m[1]);
  m = FORGE_ID.exec(id);
  if (m) {
    const short = forgeShort(m[2], m[1]);
    if (short) return ok(m[1], 'forge', short);
  }
  m = NEO_LEGACY_ID.exec(id);
  if (m) return ok(m[1], 'neoforge', m[2]);
  m = OPTIFINE_ID.exec(id);
  if (m && looksVanilla(m[1], manifestIds)) return ok(m[1], 'optifine', m[2]);
  if (looksVanilla(id, manifestIds)) return ok(id, 'vanilla');
  return null;
}

/**
 * Detecta version y loader. json: contenido de versions/<id>/<id>.json (o null). ctx: { manifestIds: Set }
 * (ids del manifest de Mojang, si se tiene: hace exacta la deteccion de versiones vanilla).
 */
function detectVersion(id, json, { manifestIds = null } = {}) {
  if (!validVersionId(id)) return { ok: false, reason: 'noVersion' };
  const byJson = fromJson(id, json, manifestIds);
  if (byJson) return byJson;
  const byId = fromId(id, manifestIds, json);
  if (byId) return byId;
  // Un JSON que hereda de una version vanilla con un loader desconocido: no se puede reproducir.
  if (json && validVersionId(json.inheritsFrom)) return { ok: false, reason: 'unsupportedLoader', loaderName: null };
  return { ok: false, reason: 'unknown' };
}

const timeOf = (v) => (typeof v === 'string' && v.length <= 40 ? Date.parse(v) : NaN);

/**
 * Version a la que apunta un perfil "latest-release" / "latest-snapshot" (o uno viejo sin version).
 * sources: { manifest: { latest: { release, snapshot }, versions: [{ id, releaseTime }] } | null,
 *            local: [{ id, type, releaseTime }] } (JSON vanilla de la carpeta versions/ del launcher oficial).
 * El manifest guardado puede ser viejo: si el launcher oficial ya instalo una version mas nueva, gana esa (los
 * mundos ya se abrieron con ella y abrirlos con una anterior los puede romper).
 */
function resolveLatest(type, { manifest = null, local = [] } = {}) {
  const want = type === 'latest-snapshot' ? 'snapshot' : 'release';
  const types = want === 'snapshot' ? new Set(['snapshot', 'release']) : new Set(['release']);
  const best =
    (Array.isArray(local) ? local : [])
      .filter((v) => v && validVersionId(v.id) && types.has(v.type) && Number.isFinite(timeOf(v.releaseTime)))
      .sort((a, b) => timeOf(b.releaseTime) - timeOf(a.releaseTime))[0] || null;
  const fromManifest = manifest?.latest?.[want];
  if (!validVersionId(fromManifest)) return best ? best.id : null;
  if (!best || best.id === fromManifest) return fromManifest;
  const entry = Array.isArray(manifest.versions) ? manifest.versions.find((v) => v && v.id === fromManifest) : null;
  const manifestTime = timeOf(entry?.releaseTime);
  // Sin fecha en el manifest no se puede comparar: manda el manifest.
  return Number.isFinite(manifestTime) && timeOf(best.releaseTime) > manifestTime ? best.id : fromManifest;
}

module.exports = { detectVersion, resolveLatest, isModded, looksVanilla, vanillaShape, neoforgeMc, forgeShort, MODDED };
