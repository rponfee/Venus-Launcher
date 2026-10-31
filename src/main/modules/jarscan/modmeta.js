'use strict';
// Metadatos de un mod o plugin dentro de su jar: id, nombre, versión, loader, configs de mixins y jars anidados.
// Formatos: fabric.mod.json, quilt.mod.json, META-INF/neoforge.mods.toml, META-INF/mods.toml, mcmod.info,
// MANIFEST.MF (MixinConfigs) y plugin.yml / paper-plugin.yml / bungee.yml / velocity-plugin.json.
const toml = require('./toml');
const { lenientJson, parseManifest } = require('./zip');

const asList = (v) => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);
const str = (v) => (v === undefined || v === null ? '' : String(v)).trim();

function cleanVersion(v, jarVersion) {
  const s = str(v);
  if (!s || /^\$\{[^}]*\}$/.test(s)) return jarVersion || '';
  return s;
}

// Valor de primer nivel de un YAML simple (plugin.yml): "name: Foo"
function yamlTop(text, key) {
  const m = new RegExp(`^${key}:\\s*['"]?([^'"\\r\\n#]+)['"]?`, 'm').exec(text || '');
  return m ? m[1].trim() : '';
}

/**
 * describe(jar) -> {
 *   loader: 'fabric'|'quilt'|'forge'|'neoforge'|'legacyforge'|'plugin'|null,
 *   id, name, version, mods: [{ id, name, version }],
 *   mixinConfigs: [{ config, env: 'client'|'server'|'*' }],
 *   nested: ['META-INF/jars/x.jar', ...] (declarados), manifest
 * }
 */
function describe(jar) {
  const manifest = parseManifest(jar.has('META-INF/MANIFEST.MF') ? jar.text('META-INF/MANIFEST.MF', 256 * 1024) : '');
  const jarVersion = manifest['Implementation-Version'] || manifest['Specification-Version'] || '';
  const out = { loader: null, id: '', name: '', version: '', mods: [], mixinConfigs: [], nested: [], manifest };
  const addMixin = (config, env = '*') => {
    const c = str(config);
    if (c && !out.mixinConfigs.some((m) => m.config === c)) out.mixinConfigs.push({ config: c, env });
  };

  if (jar.has('fabric.mod.json')) {
    const j = lenientJson(jar.text('fabric.mod.json', 1024 * 1024));
    if (j && typeof j === 'object' && j.id) {
      out.loader = 'fabric';
      out.mods.push({ id: str(j.id), name: str(j.name) || str(j.id), version: str(j.version) });
      for (const m of asList(j.mixins)) {
        if (typeof m === 'string') addMixin(m);
        else if (m && typeof m === 'object') addMixin(m.config, typeof m.environment === 'string' ? m.environment : '*');
      }
      for (const nested of asList(j.jars)) if (nested?.file) out.nested.push(str(nested.file));
    }
  }
  if (!out.loader && jar.has('quilt.mod.json')) {
    const j = lenientJson(jar.text('quilt.mod.json', 1024 * 1024));
    const ql = j?.quilt_loader;
    if (ql?.id) {
      out.loader = 'quilt';
      out.mods.push({ id: str(ql.id), name: str(ql.metadata?.name) || str(ql.id), version: str(ql.version) });
      for (const m of asList(j.mixin)) if (typeof m === 'string') addMixin(m);
      for (const nested of asList(ql.jars)) out.nested.push(typeof nested === 'string' ? nested : str(nested?.file));
    }
  }
  for (const [file, loader] of [
    ['META-INF/neoforge.mods.toml', 'neoforge'],
    ['META-INF/mods.toml', 'forge'],
  ]) {
    if (!jar.has(file)) continue;
    let doc = null;
    try {
      doc = toml.parse(jar.text(file, 1024 * 1024));
    } catch {
      doc = null;
    }
    if (!doc) continue;
    const list = asList(doc.mods).filter((m) => m && typeof m === 'object' && m.modId);
    if (list.length && !out.loader) out.loader = loader;
    for (const m of list) {
      if (!out.mods.some((x) => x.id === str(m.modId))) out.mods.push({ id: str(m.modId), name: str(m.displayName) || str(m.modId), version: cleanVersion(m.version, jarVersion) });
    }
    for (const m of asList(doc.mixins)) if (m && typeof m === 'object' && m.config) addMixin(m.config);
  }
  if (!out.loader && jar.has('mcmod.info')) {
    const j = lenientJson(jar.text('mcmod.info', 512 * 1024));
    const list = Array.isArray(j) ? j : Array.isArray(j?.modList) ? j.modList : [];
    const mods = list.filter((m) => m && m.modid);
    if (mods.length) {
      out.loader = 'legacyforge';
      for (const m of mods) out.mods.push({ id: str(m.modid).toLowerCase(), name: str(m.name) || str(m.modid), version: cleanVersion(m.version, jarVersion) });
    }
  }
  // Forge viejo y algunos mods de NeoForge declaran los mixins en el MANIFEST
  for (const c of str(manifest.MixinConfigs).split(',')) addMixin(c);

  if (!out.loader) {
    for (const file of ['paper-plugin.yml', 'plugin.yml', 'bungee.yml']) {
      if (!jar.has(file)) continue;
      const text = jar.text(file, 256 * 1024) || '';
      const name = yamlTop(text, 'name');
      if (name) {
        out.loader = 'plugin';
        out.mods.push({ id: name.toLowerCase(), name, version: yamlTop(text, 'version') });
        break;
      }
    }
  }
  if (!out.loader && jar.has('velocity-plugin.json')) {
    const j = lenientJson(jar.text('velocity-plugin.json', 256 * 1024));
    if (j?.id) {
      out.loader = 'plugin';
      out.mods.push({ id: str(j.id), name: str(j.name) || str(j.id), version: str(j.version) });
    }
  }
  if (out.mods.length) {
    out.id = out.mods[0].id;
    out.name = out.mods[0].name;
    out.version = out.mods[0].version;
  } else {
    out.name = str(manifest['Implementation-Title']) || str(manifest['Automatic-Module-Name']) || '';
    out.version = jarVersion;
  }
  return out;
}

module.exports = { describe, asList };
