'use strict';
// Lectura de los mixins de un mod: configs (fabric.mod.json, quilt.mod.json, mods.toml/neoforge.mods.toml,
// MANIFEST MixinConfigs), refmaps y clases mixin con sus objetivos (@Mixin value/targets) y sus
// inyecciones (@Overwrite, @Inject, @Redirect, @ModifyVariable, @ModifyArg(s), @ModifyConstant y los de
// MixinExtras). Los selectores se pasan por el refmap para compararlos entre mods con los nombres reales.
const cf = require('./classfile');
const { openJar, lenientJson } = require('./zip');
const { describe, asList } = require('./modmeta');

const MIXIN_VERSION = 3;
const MAX_DEPTH = 3;
const MAX_NESTED = 64 * 1024 * 1024;

const T_MIXIN = 'Lorg/spongepowered/asm/mixin/Mixin;';
const T_PSEUDO = 'Lorg/spongepowered/asm/mixin/Pseudo;';
const T_OVERWRITE = 'Lorg/spongepowered/asm/mixin/Overwrite;';
const INJECTORS = {
  'Lorg/spongepowered/asm/mixin/injection/Inject;': 'inject',
  'Lorg/spongepowered/asm/mixin/injection/Redirect;': 'redirect',
  'Lorg/spongepowered/asm/mixin/injection/ModifyVariable;': 'modifyVariable',
  'Lorg/spongepowered/asm/mixin/injection/ModifyArg;': 'modifyArg',
  'Lorg/spongepowered/asm/mixin/injection/ModifyArgs;': 'modifyArgs',
  'Lorg/spongepowered/asm/mixin/injection/ModifyConstant;': 'modifyConstant',
};
// MixinExtras puede venir reubicado dentro de otro paquete: se reconoce por el final del nombre.
const EXTRAS = [
  ['/injector/wrapoperation/WrapOperation;', 'wrapOperation'],
  ['/injector/v2/WrapWithCondition;', 'wrapWithCondition'],
  ['/injector/WrapWithCondition;', 'wrapWithCondition'],
  ['/injector/ModifyExpressionValue;', 'modifyExpressionValue'],
  ['/injector/ModifyReturnValue;', 'modifyReturnValue'],
  ['/injector/ModifyReceiver;', 'modifyReceiver'],
  ['/injector/wrapmethod/WrapMethod;', 'wrapMethod'],
];

function injectorKind(type) {
  if (INJECTORS[type]) return INJECTORS[type];
  if (!/mixinextras/i.test(type)) return null;
  for (const [suffix, kind] of EXTRAS) if (type.endsWith(suffix)) return kind;
  return null;
}

// Valor de anotación como lista (los atributos de un solo elemento pueden venir sin arreglo).
function list(ev) {
  if (!ev) return [];
  return ev.tag === '[' ? ev.values : [ev];
}

const descToInternal = (d) => (/^L.+;$/.test(d) ? d.slice(1, -1) : d);

/**
 * Selector de Mixin -> { owner, name, desc }. Formatos: "name", "name(desc)ret", "Lowner;name(desc)ret",
 * "owner.name(desc)", "name:desc" (campos) y cuantificadores "{2}", "+", "*" al final del nombre.
 */
function parseSelector(raw) {
  let s = String(raw || '').trim();
  let owner = '';
  const m = /^L([^;(]+);(.*)$/.exec(s);
  if (m) {
    owner = m[1];
    s = m[2];
  } else {
    const p = s.indexOf('(');
    const head = p >= 0 ? s.slice(0, p) : s;
    const dot = head.lastIndexOf('.');
    if (dot > 0 && head.slice(0, dot).includes('.') === false && head.slice(0, dot).includes('/')) {
      owner = head.slice(0, dot);
      s = s.slice(dot + 1);
    } else if (dot > 0 && /^[a-z][\w$]*(\.[\w$]+)+$/.test(head.slice(0, dot))) {
      owner = head.slice(0, dot).replace(/\./g, '/');
      s = s.slice(dot + 1);
    }
  }
  let name = s;
  let desc = '';
  const paren = s.indexOf('(');
  const colon = s.indexOf(':');
  if (paren >= 0) {
    name = s.slice(0, paren);
    desc = s.slice(paren);
  } else if (colon >= 0) {
    name = s.slice(0, colon);
    desc = s.slice(colon + 1);
  }
  name = name.replace(/\{[\d,\s]*\}$/, '').replace(/[+*]$/, (q) => (name.length > 1 ? '' : q));
  return { owner, name: name.trim(), desc: desc.trim() };
}

function isWildcard(sel) {
  return !sel.name || sel.name === '*' || sel.name.includes('*') || sel.name.startsWith('/');
}

// ---------- Refmaps y nombres legibles ----------

function loadRefmap(jar, name) {
  const j = lenientJson(jar.text(name, 8 * 1024 * 1024));
  if (!j || typeof j !== 'object') return null;
  if (j.mappings && typeof j.mappings === 'object') return j.mappings;
  const envs = j.data && typeof j.data === 'object' ? Object.values(j.data) : [];
  return envs.find((e) => e && typeof e === 'object') || null;
}

function resolve(refmap, mixinCls, str) {
  const m = refmap?.[mixinCls];
  if (m && typeof m[str] === 'string') return m[str];
  return str;
}

function resolveClass(refmap, mixinCls, str) {
  const internal = String(str).replace(/\./g, '/');
  const m = refmap?.[mixinCls];
  const hit = m && (m[str] || m[internal]);
  return typeof hit === 'string' ? hit.replace(/\./g, '/') : internal;
}

function vote(map, key, value) {
  if (!key || !value || key === value) return;
  let m = map[key];
  if (!m) m = map[key] = {};
  m[value] = (m[value] || 0) + 1;
}

// Nombres "de desarrollo" (mojmap o yarn) a partir de pares original -> remapeado del refmap.
function learnAliases(aliases, original, remapped) {
  if (!original || !remapped || original === remapped) return;
  const a = parseSelector(original);
  const b = parseSelector(remapped);
  if (a.owner && b.owner) vote(aliases.c, b.owner, a.owner);
  if (a.name && b.name && a.name !== b.name && !isWildcard(a) && !isWildcard(b)) vote(aliases.m, b.name, a.name);
  const ca = [...a.desc.matchAll(/L([^;]+);/g)].map((x) => x[1]);
  const cb = [...b.desc.matchAll(/L([^;]+);/g)].map((x) => x[1]);
  if (ca.length && ca.length === cb.length) ca.forEach((n, i) => vote(aliases.c, cb[i], n));
  // entradas de clase: "net/minecraft/client/renderer/LevelRenderer$1" -> "net/minecraft/class_761$1"
  if (!a.desc && !b.desc && original.includes('/') && remapped.includes('/') && !original.includes(';')) vote(aliases.c, remapped, original);
}

// Nombre de clase sugerido por el nombre del mixin: "MixinLevelRenderer_Foo" / "LevelRendererMixin" -> "LevelRenderer"
function guessFromMixin(cls) {
  let simple = cls.slice(cls.lastIndexOf('/') + 1);
  simple = simple.split('$')[0];
  simple = simple.replace(/^Mixin(?=[A-Z])/, '').replace(/_.*$/, '');
  simple = simple.replace(/(Mixin|Accessor|Invoker|Access|Hooks?|Ext(ension)?|Patch)$/, '');
  return /^[A-Z][A-Za-z0-9]{2,}$/.test(simple) ? simple : '';
}

// ---------- Clases mixin ----------

function readAt(ann, refmap, mixinCls, aliases) {
  const v = ann.values;
  const target = typeof v.target?.value === 'string' ? v.target.value : '';
  const resolved = target ? resolve(refmap, mixinCls, target) : '';
  if (target) learnAliases(aliases, target, resolved);
  // Registro compacto (la cache puede tener decenas de miles): se omiten los valores por defecto.
  const out = { v: typeof v.value?.value === 'string' ? v.value.value : 'HEAD' };
  if (resolved) out.t = resolved;
  if (target && target !== resolved) out.n = target;
  if (typeof v.ordinal?.value === 'number' && v.ordinal.value >= 0) out.o = v.ordinal.value;
  return out;
}

function descSelector(ann) {
  const v = ann.values;
  const name = typeof v.value?.value === 'string' ? v.value.value : '';
  const args = list(v.args).filter((x) => x.tag === 'c').map((x) => x.desc);
  const ret = v.ret?.tag === 'c' ? v.ret.desc : 'V';
  return name ? `${name}(${args.join('')})${ret}` : '';
}

function readMixinClass(c, refmap, opts, aliases) {
  const ann = cf.findAnnotation(c, T_MIXIN);
  if (!ann) return null;
  const targets = [];
  for (const v of list(ann.values.value)) if (v.tag === 'c') targets.push(descToInternal(v.desc));
  for (const v of list(ann.values.targets)) {
    if (v.tag !== 's') continue;
    const resolved = resolveClass(refmap, c.name, v.value);
    learnAliases(aliases, v.value.replace(/\./g, '/'), resolved);
    targets.push(resolved);
  }
  const priority = typeof ann.values.priority?.value === 'number' ? ann.values.priority.value : opts.priority;
  const inj = [];
  const ow = [];
  for (const m of c.methods) {
    for (const a of cf.annotationsOf(m)) {
      if (a.type === T_OVERWRITE) {
        ow.push({ n: m.name, d: m.desc });
        continue;
      }
      const kind = injectorKind(a.type);
      if (!kind) continue;
      const sels = [];
      for (const s of list(a.values.method)) {
        if (s.tag !== 's') continue;
        const resolved = resolve(refmap, c.name, s.value);
        learnAliases(aliases, s.value, resolved);
        const p = parseSelector(resolved);
        const named = parseSelector(s.value);
        const sel = { n: p.name };
        if (p.desc) sel.d = p.desc;
        if (named.name && named.name !== p.name) sel.s = named.name;
        sels.push(sel);
      }
      for (const d of list(a.values.target)) {
        if (d.tag !== '@') continue;
        const p = parseSelector(descSelector(d.annotation));
        if (p.name) sels.push(p.desc ? { n: p.name, d: p.desc } : { n: p.name });
      }
      const ats = [];
      for (const atv of list(a.values.at)) if (atv.tag === '@') ats.push(readAt(atv.annotation, refmap, c.name, aliases));
      if (kind === 'modifyConstant') {
        for (const k of list(a.values.constant)) {
          if (k.tag !== '@') continue;
          const cv = k.annotation.values;
          const val = ['intValue', 'floatValue', 'longValue', 'doubleValue', 'stringValue'].map((key) => cv[key]?.value).find((x) => x !== undefined);
          const at = { v: 'CONSTANT' };
          if (val !== undefined) at.t = String(val);
          else if (cv.nullValue?.value) at.t = 'null';
          if (typeof cv.ordinal?.value === 'number' && cv.ordinal.value >= 0) at.o = cv.ordinal.value;
          ats.push(at);
        }
      }
      const req = typeof a.values.require?.value === 'number' && a.values.require.value >= 0 ? a.values.require.value : opts.defaultRequire;
      const rec = { k: kind, h: m.name, m: sels };
      if (ats.length) rec.at = ats;
      if (req) rec.req = req;
      if (a.values.cancellable?.value === true) rec.can = true;
      inj.push(rec);
    }
  }
  const out = { c: c.name, cfg: opts.cfgIdx, t: [...new Set(targets)], p: priority, inj, ow };
  if (cf.findAnnotation(c, T_PSEUDO)) out.pseudo = true;
  if (c.access & cf.ACC.INTERFACE) out.iface = true;
  const g = guessFromMixin(c.name);
  if (g) out.g = g;
  return out;
}

// Mixins de un jar ya abierto (sin los anidados). env: 'client' | 'server'
function extractFromJar(jar, { env = 'client' } = {}) {
  const meta = describe(jar);
  const rec = {
    loader: meta.loader,
    id: meta.id,
    name: meta.name,
    version: meta.version,
    configs: [],
    mixins: [],
    aliases: { c: {}, m: {} },
    errors: [],
  };
  const seen = new Set();
  for (const mc of meta.mixinConfigs) {
    if (mc.env && mc.env !== '*' && mc.env !== env) continue;
    const text = jar.text(mc.config, 4 * 1024 * 1024);
    if (!text) {
      rec.errors.push({ code: 'configMissing', config: mc.config });
      continue;
    }
    const cfg = lenientJson(text);
    if (!cfg || typeof cfg !== 'object') {
      rec.errors.push({ code: 'configInvalid', config: mc.config });
      continue;
    }
    const pkg = typeof cfg.package === 'string' ? cfg.package.trim() : '';
    const priority = Number.isFinite(cfg.priority) ? cfg.priority : 1000;
    const defaultRequire = Number.isFinite(cfg.injectors?.defaultRequire) ? cfg.injectors.defaultRequire : 0;
    const refmap = typeof cfg.refmap === 'string' ? loadRefmap(jar, cfg.refmap) : null;
    const names = [...asList(cfg.mixins), ...asList(env === 'server' ? cfg.server : cfg.client)].filter((n) => typeof n === 'string' && n.trim());
    const plugin = typeof cfg.plugin === 'string' && Boolean(cfg.plugin);
    const cfgIdx = rec.configs.push({ name: mc.config, priority, plugin, required: cfg.required === true, count: names.length }) - 1;
    const classes = names.map((n) => (pkg ? `${pkg}.${n.trim()}` : n.trim()).replace(/\./g, '/'));
    // Config sin lista y con plugin (p. ej. Embeddium): el plugin arma la lista en tiempo real con getMixins().
    // Se toman como candidatas todas las clases @Mixin del paquete.
    let dynamic = false;
    if (!classes.length && plugin && pkg) {
      const prefix = `${pkg.replace(/\./g, '/')}/`;
      for (const e of jar.entries) if (e.name.startsWith(prefix) && e.name.endsWith('.class')) classes.push(e.name.slice(0, -6));
      dynamic = true;
    }
    for (const internal of classes) {
      if (seen.has(internal)) continue;
      seen.add(internal);
      const data = jar.read(`${internal}.class`, 8 * 1024 * 1024);
      if (!data) {
        if (!dynamic) rec.errors.push({ code: 'classMissing', config: mc.config, cls: internal });
        continue;
      }
      let c;
      try {
        c = cf.parseClass(data);
      } catch {
        rec.errors.push({ code: 'classInvalid', config: mc.config, cls: internal });
        continue;
      }
      const mixin = readMixinClass(c, refmap, { priority, defaultRequire, cfgIdx }, rec.aliases);
      if (mixin) {
        if (dynamic) mixin.dyn = true;
        rec.mixins.push(mixin);
      }
    }
    if (dynamic) rec.configs[cfgIdx].count = rec.mixins.filter((m) => m.cfg === cfgIdx).length;
  }
  return rec;
}

const sleep0 = () => new Promise((r) => setImmediate(r));

/**
 * Lee un jar y sus jars anidados. Devuelve { v, mods: [rec...] } donde cada rec es un mod
 * (el principal primero) con path = '' o la ruta del jar anidado.
 */
async function extractMixins(buf, { env = 'client', signal } = {}) {
  const mods = [];
  async function walk(b, path, depth) {
    const jar = openJar(b);
    const rec = extractFromJar(jar, { env });
    rec.path = path;
    if (rec.id || rec.mixins.length || depth === 0) mods.push(rec);
    if (depth >= MAX_DEPTH) return;
    const before = mods.length;
    for (const e of jar.entries) {
      if (!/\.jar$/i.test(e.name)) continue;
      if (signal?.aborted) throw signal.reason || new Error('aborted');
      const data = jar.read(e, MAX_NESTED);
      if (!data) continue;
      await sleep0();
      try {
        await walk(data, path ? `${path}!/${e.name}` : e.name, depth + 1);
      } catch (err) {
        if (signal?.aborted) throw err;
      }
    }
    // Jars "envoltorio" (NeoForge jarjar): la config declarada afuera vive en un jar anidado.
    const nestedConfigs = new Set(mods.slice(before).flatMap((m) => m.configs.map((c) => c.name)));
    rec.errors = rec.errors.filter((err) => err.code !== 'configMissing' || !nestedConfigs.has(err.config));
  }
  try {
    await walk(buf, '', 0);
  } catch (err) {
    if (signal?.aborted) throw err;
    return { v: MIXIN_VERSION, mods: [], error: err?.code || 'corrupt' };
  }
  return { v: MIXIN_VERSION, mods };
}

module.exports = { extractMixins, extractFromJar, parseSelector, isWildcard, injectorKind, MIXIN_VERSION };
