'use strict';
// Analisis de un crash: junta las fuentes (crash report, log de la sesion o latest.log, hs_err_pid),
// las cruza con los mods instalados, calcula los mods sospechosos y corre la base de reglas.
// Devuelve hallazgos con textos ya traducidos y acciones ejecutables. Sin Electron.
const parse = require('./parse');
const modsLib = require('./mods');
const { RULES, act, finding, shortVersion, vendorOf, LOADER_NAMES } = require('./rules');
const { compareSemver } = require('../../core/util');

const LIMITS = { report: 400000, log: 700000, hsErr: 120000 };

const tail = (s, n) => (s && s.length > n ? s.slice(-n) : s || '');
const head = (s, n) => (s && s.length > n ? s.slice(0, n) : s || '');
const firstLine = (s) => String(s || '').split(/\r?\n/)[0].trim();

// ---------- Mods sospechosos ----------

function scoreSuspects(c, idx) {
  const scores = new Map();
  const bump = (file, pts, reason) => {
    if (!file || pts <= 0) return;
    const s = scores.get(file) || { score: 0, reasons: new Set() };
    s.score += pts;
    s.reasons.add(reason);
    scores.set(file, s);
  };
  const byId = (id, pts, reason) => {
    if (!id || modsLib.ENV_IDS.has(String(id).toLowerCase())) return;
    const file = idx.ids.primary(id) || idx.ids.files(id)[0];
    if (file && idx.enabled.has(file)) bump(file, pts, reason);
  };
  const r = c.report;
  for (const s of r?.suspected || []) byId(s.id, 10, 'forgeSuspected');
  for (const s of r?.erroredMods || []) byId(s.id, 7, 'forgeErrored');
  for (const s of r?.modSections || []) byId(s.id, 9, 'modFailed');
  for (const e of c.entrypoints) byId(e.modId, 10, 'entrypoint');
  for (const f of c.mixin.failures) {
    const file = idx.mixins.lookup(f.config) || idx.ids.primary(f.modId);
    if (file && idx.enabled.has(file)) bump(file, 8, 'mixin');
  }
  for (const ent of [r?.entity, r?.blockEntity].filter(Boolean)) {
    const ns = ent.type.split(':')[0];
    if (ns !== 'minecraft') byId(ns, 6, 'entity');
    else if (ent.cls) for (const f of idx.packages.lookup(ent.cls)) bump(f, 4, 'entity');
  }
  // Frames de la traza principal: la causa raiz pesa mas y los primeros frames mas que los de abajo
  const chain = c.primary ? [...(c.primary.causes || []).slice().reverse(), c.primary] : [];
  chain.forEach((node, depth) => {
    const weight = depth === 0 ? 1 : 0.6;
    let i = 0;
    for (const f of node.frames.slice(0, 40)) {
      const pos = weight * Math.pow(0.86, i++);
      const owners = new Set();
      if (f.handlerMod) {
        const file = idx.ids.primary(f.handlerMod) || idx.ids.files(f.handlerMod)[0];
        if (file) owners.add(file);
      }
      for (const cfg of f.mixins) {
        const file = idx.mixins.lookup(cfg);
        if (file) bump(file, 2.5 * pos, 'mixinFrame');
      }
      if (f.modId && !modsLib.ENV_IDS.has(f.modId)) {
        const file = idx.ids.primary(f.modId) || idx.ids.files(f.modId)[0];
        if (file) owners.add(file);
      } else if (f.jar) {
        const file = idx.fileByName(f.jar);
        if (file) owners.add(file);
      }
      if (!owners.size) for (const file of idx.packages.lookup(f.cls)) owners.add(file);
      for (const file of owners) {
        if (!idx.enabled.has(file)) continue;
        const lib = idx.byFile.get(file)?.library ? 0.5 : 1;
        bump(file, (4 * pos * lib) / owners.size, 'stack');
      }
    }
  });
  return [...scores.entries()]
    .map(([file, s]) => ({ file, score: Math.round(s.score * 10) / 10, reasons: [...s.reasons] }))
    .filter((s) => s.score >= 2.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);
}

// ---------- Indices ----------

function buildIndex(mods) {
  const enabledList = mods.filter((m) => m.enabled);
  const byFile = new Map(mods.map((m) => [m.file, m]));
  const byLower = new Map();
  for (const m of mods) {
    byLower.set(m.file.toLowerCase(), m.file);
    byLower.set(m.base.toLowerCase(), m.file);
  }
  return {
    all: mods,
    enabledList,
    enabled: new Set(enabledList.map((m) => m.file)),
    byFile,
    ids: modsLib.buildIdIndex(enabledList),
    allIds: modsLib.buildIdIndex(mods),
    packages: modsLib.buildPackageIndex(enabledList),
    mixins: modsLib.buildMixinIndex(enabledList),
    fileByName: (name) => byLower.get(String(name || '').split(/[\\/]/).pop().toLowerCase()) || null,
  };
}

// ---------- Analisis ----------

/**
 * input: { report, log, latest, tail, hsErr, code, instance: { id, name, mcVersion, loader, loaderVersion,
 *          memoryMb, javaPath, jvmArgs, globalJvmArgs }, mods: [registros de scanMods], system: { totalMemMb, gpu } }
 * opts:  { t, language }
 */
function analyze(input, { t, language = 'es' } = {}) {
  const tr = t || ((k) => k);
  const reportText = head(input.report || '', LIMITS.report);
  let logText = tail(input.log || '', LIMITS.log);
  if (logText.split('\n').length < 60 && input.latest) logText = `${tail(input.latest, LIMITS.log)}\n${logText}`;
  else if (!logText) logText = tail(input.latest || '', LIMITS.log);
  const tailText = (input.tail || '').trim();
  const hsText = head(input.hsErr || '', LIMITS.hsErr);
  const all = [reportText, logText, logText.includes(tailText.slice(-400)) ? '' : tailText, hsText].filter(Boolean).join('\n');

  const report = parse.parseReport(reportText);
  const traces = parse.parseTraces(`${logText}\n${tailText}`);
  const primary = report?.trace || traces[traces.length - 1] || null;
  const root = parse.rootOf(primary);
  const chainText = primary ? [primary, ...(primary.causes || [])].map((n) => `${n.cls}: ${n.msg}`).join('\n') : '';
  const rootFrames = (root?.frames || []).slice(0, 12).map((f) => f.raw).join('\n');

  const mods = input.mods || [];
  const idx = buildIndex(mods);
  const inst = input.instance || {};
  const hs = parse.parseHsErr(hsText);
  const javaMajor = report?.system?.javaMajor || hs?.javaMajor || parse.javaFromLog(all) || null;
  const memoryMb = report?.system?.maxMemoryMb || inst.memoryMb || null;

  // Rutas de configs mencionadas cerca del error de lectura
  const near = [];
  const lines = all.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (/JsonSyntaxException|MalformedJsonException|ParsingException|JsonParseException|ConfigLoadingException|TomlParseException|Expected BEGIN_OBJECT|Unterminated object/.test(lines[i])) {
      near.push(...lines.slice(Math.max(0, i - 30), i + 30));
    }
  }
  const configPaths = parse.configPathsIn(`${chainText}\n${near.join('\n')}`);

  const c = {
    instance: inst,
    code: input.code ?? null,
    all,
    report,
    primary,
    root,
    rootText: `${chainText}\n${rootFrames}`,
    fabric: parse.parseFabricResolution(`${logText}\n${tailText}`),
    forgeDeps: parse.parseForgeDeps(all),
    duplicates: parse.parseDuplicates(all),
    mixin: parse.parseMixins(all),
    entrypoints: parse.parseEntrypoints(all),
    hs,
    javaMajor,
    memoryMb,
    configPaths,
    gpuVendor: vendorOf(`${report?.system?.gpu || ''} ${report?.system?.gpuVendor || ''}`) || vendorOf(input.system?.gpu) || null,
    progress: parse.progressOf(logText),
  };

  const suspects = scoreSuspects(c, idx);
  const suspectSet = new Map(suspects.map((s) => [s.file, s]));
  const listFmt = (() => {
    try {
      return new Intl.ListFormat(language, { style: 'long', type: 'conjunction' });
    } catch {
      return { format: (a) => a.join(', ') };
    }
  })();
  const numFmt = (() => {
    try {
      return new Intl.NumberFormat(language, { maximumFractionDigits: 1 });
    } catch {
      return { format: (n) => String(n) };
    }
  })();
  const totalMb = Math.max(2048, Number(input.system?.totalMemMb) || 8192);

  const record = (file) => (file ? idx.byFile.get(file) || null : null);
  const nameOf = (id) => {
    const rec = record(idx.allIds.primary(id) || idx.allIds.files(id)[0]);
    if (rec) return rec.name;
    const fromReport = report?.modList?.find((m) => m.id === id);
    if (fromReport?.name) return fromReport.name;
    return LOADER_NAMES[id] || String(id || '?');
  };
  const fmtRange = (range) => {
    if (!range) return tr('crash.range_any');
    if (range.op === 'raw') return range.raw || range.v || '*';
    return tr(`crash.range_${range.op}`, { v: shortVersion(range.v), v2: shortVersion(range.v2) });
  };
  const needsNewer = (range, present) => {
    if (!present || !range?.v) return true;
    const cmp = (() => {
      try {
        return compareSemver(present, range.v);
      } catch {
        return 0;
      }
    })();
    if (['le', 'lt'].includes(range.op)) return false;
    if (range.op === 'eq') return cmp < 0;
    return cmp < 0 || range.op === 'any' || range.op === 'raw';
  };

  const h = {
    record,
    byFile: record,
    nameOf,
    fileByName: idx.fileByName,
    enabledMods: () => idx.enabledList,
    enabledById: (id) => {
      const f = idx.ids.primary(id) || idx.ids.files(id)[0];
      return f ? record(f) : null;
    },
    disabledById: (id) => {
      const f = idx.allIds.files(id).find((x) => !idx.enabled.has(x));
      return f ? record(f) : null;
    },
    mod(id, name, version) {
      const rec = record(idx.ids.primary(id) || idx.ids.files(id)[0]) || record(idx.allIds.primary(id));
      return {
        id,
        name: name || rec?.name || nameOf(id),
        version: version || rec?.version || '',
        file: rec?.file || null,
        enabled: rec ? rec.enabled : false,
        resolved: rec,
      };
    },
    modForClass(cls) {
      const files = idx.packages.lookup(cls);
      return files.length ? record(files[0]) : null;
    },
    modForMixin(config, modId) {
      const file = config ? idx.mixins.lookup(config) : null;
      if (file) return record(file);
      const guess = String(config || '').split('/').pop().replace(/[.-]?(client|common|forge|fabric|neoforge|core)?\.?mixins?\.json$/i, '').replace(/\.json$/, '');
      const rec = (modId && h.enabledById(modId)) || (guess && h.enabledById(guess));
      if (rec) return rec;
      if (modId) return { name: nameOf(modId), file: null, enabled: false };
      return null;
    },
    topSuspect() {
      const s = suspects.find((x) => x.score >= 3);
      return s ? record(s.file) : null;
    },
    isSuspect: (file) => (suspectSet.get(file)?.score || 0) >= 3,
    duplicateIds() {
      const map = new Map();
      for (const m of idx.enabledList) {
        const id = m.ids[0];
        if (!id || modsLib.ENV_IDS.has(id)) continue;
        if (!map.has(id)) map.set(id, []);
        map.get(id).push(m.file);
      }
      return [...map.entries()].filter(([, files]) => files.length > 1);
    },
    isWrongLoader(m) {
      const L = m.loaders || [];
      if (!L.length || m.corrupt) return false;
      const fabricLike = L.includes('fabric') || L.includes('quilt');
      const forgeLike = L.includes('forge') || L.includes('legacyforge');
      const neo = L.includes('neoforge');
      switch (inst.loader) {
        case 'fabric':
        case 'legacyfabric':
          return !L.includes('fabric');
        case 'quilt':
          return !fabricLike;
        case 'forge':
          return !forgeLike;
        case 'neoforge': {
          if (neo) return false;
          if (forgeLike) {
            if (inst.mcVersion === '1.20.1') return false;
            const modern = compareSemver(String(inst.mcVersion || '0'), '1.20.5') >= 0;
            return modern || m.wantsForge;
          }
          return fabricLike;
        }
        default:
          return false;
      }
    },
    loaderOfMod(m) {
      const L = m.loaders || [];
      if (L.includes('neoforge')) return 'NeoForge';
      if (L.includes('forge') || L.includes('legacyforge')) return 'Forge';
      if (L.includes('fabric')) return 'Fabric';
      if (L.includes('quilt')) return 'Quilt';
      return '?';
    },
    list(names) {
      const uniq = [...new Set(names.filter(Boolean))];
      if (uniq.length > 4) return listFmt.format([...uniq.slice(0, 3), tr('crash.moreCount', { count: uniq.length - 3 })]);
      return listFmt.format(uniq);
    },
    fmtRam(mb) {
      if (!mb) return '?';
      return mb >= 1024 ? `${numFmt.format(mb / 1024)} GB` : `${mb} MB`;
    },
    ramUp(cur) {
      const base = cur || 2048;
      const cap = Math.max(2048, Math.floor((totalMb * 0.7) / 512) * 512);
      let to = Math.ceil((base * 1.5) / 1024) * 1024;
      if (to < base + 1024) to = base + 1024;
      to = Math.min(to, cap);
      return to > base ? to : null;
    },
    ramDown(cur) {
      const base = cur || 4096;
      const to = Math.floor(Math.min(base - 1024, totalMb * 0.5) / 512) * 512;
      return Math.max(1024, to);
    },
    hasCustomArgs: () => Boolean(String(inst.jvmArgs || '').trim()),
    fmtRange,
    versionProblem(mod, dep, range, present) {
      const depId = String(dep.id || '').toLowerCase();
      const mods = [mod.file];
      if (depId === 'minecraft') {
        return finding('wrong_minecraft', 93, 'high', { mod: mod.name, required: fmtRange(range), present: present || inst.mcVersion || '?' }, { mods, actions: [act.update(true), act.disable(mod.resolved), act.search(mod.name)] });
      }
      if (['fabricloader', 'fabric-loader', 'quilt_loader', 'quilt-loader', 'forge', 'neoforge'].includes(depId)) {
        const loader = LOADER_NAMES[depId] || dep.name || depId;
        return finding('loader_outdated', 91, 'high', { mod: mod.name, loader, range: fmtRange(range), present: present || inst.loaderVersion || '?' }, { mods, actions: [act.updateLoader(loader), act.disable(mod.resolved)] });
      }
      if (depId === 'java') {
        const major = Number(String(range?.v || '').match(/\d+/)?.[0]) || null;
        return finding('java_required', 92, 'high', { mod: mod.name, major: major || '?' }, { mods, actions: [major ? act.useJava(major >= 9 ? major : 8) : null] });
      }
      const depMod = h.mod(dep.id, dep.name, present);
      const newer = needsNewer(range, present);
      return finding('dep_wrong_version', 90, 'high', { mod: mod.name, dep: depMod.name, range: fmtRange(range), present: shortVersion(present || depMod.version) || '?' }, {
        textKey: newer ? 'crash.r_dep_wrong_version_textUpdateDep' : 'crash.r_dep_wrong_version_textUpdateMod',
        mods: [mod.file, depMod.file],
        actions: [act.update(true), act.search(newer ? depMod.name : mod.name), act.disable(mod.resolved)],
      });
    },
    missingDep(depId, depName, range, reqMods) {
      const id = String(depId || '').toLowerCase();
      const disabled = h.disabledById(id);
      const names = reqMods.map((m) => m.name);
      const count = new Set(names).size || 1;
      const vars = { dep: depName || nameOf(id), mod: names[0] || '?', mods: h.list(names), range: fmtRange(range), count };
      if (id === 'fabric-api' || id === 'fabric') {
        return finding('fabric_api_missing', 97, 'high', vars, {
          textKey: disabled ? 'crash.r_fabric_api_missing_textDisabled' : 'crash.r_fabric_api_missing_text',
          mods: reqMods.map((m) => m.file),
          actions: [disabled ? act.enable(disabled) : act.install('fabric-api', 'Fabric API')],
        });
      }
      return finding('missing_dep', 96, 'high', vars, {
        textKey: disabled ? 'crash.r_missing_dep_textDisabled' : 'crash.r_missing_dep_text',
        mods: reqMods.map((m) => m.file),
        actions: [disabled ? act.enable(disabled) : act.install(id, vars.dep, { range: vars.range }), count === 1 ? act.disable(reqMods[0].resolved) : null],
      });
    },
  };

  // Correr las reglas
  let found = [];
  for (const r of RULES) {
    try {
      const res = r.fn(c, h);
      if (!res) continue;
      for (const f of Array.isArray(res) ? res : [res]) if (f) found.push(f);
    } catch (err) {
      console.warn('[crash] regla', r.id, err?.message || err);
    }
  }
  // Sin una explicacion fuerte: el mod sospechoso o una explicacion general
  const shortExc = root ? root.cls.split('.').pop() : primary ? primary.cls.split('.').pop() : '';
  if (!found.some((f) => f.confidence !== 'low' && f.priority >= 60)) {
    const top = suspects[0] && suspects[0].score >= 4 ? record(suspects[0].file) : null;
    if (top) {
      found.push(
        finding('suspect_mod', 60, suspects[0].score >= 8 ? 'medium' : 'low', { mod: top.name, exception: shortExc || '?' }, {
          mods: [top.file],
          actions: [act.update(true), act.disable(top), act.bisect()],
          severity: 'warn',
        }),
      );
    } else if (!found.length) {
      found.push(
        finding('generic', 10, 'low', { exception: shortExc, code: c.code ?? '?' }, {
          textKey: shortExc ? 'crash.r_generic_text' : c.code === null || c.code === undefined ? 'crash.r_generic_textNoInfo' : 'crash.r_generic_textNoExc',
          actions: [act.bisect()],
          severity: 'warn',
        }),
      );
    }
  }
  // Ordenar y quitar repetidos
  const confRank = { high: 3, medium: 2, low: 1 };
  found.sort((a, b) => b.priority - a.priority || confRank[b.confidence] - confRank[a.confidence]);
  const seen = new Set();
  found = found.filter((f) => {
    const key = `${f.id}|${JSON.stringify(f.vars)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const modInfo = (file) => {
    const m = record(file);
    return m ? { file: m.file, name: m.name, version: shortVersion(m.version), library: m.library, enabled: m.enabled } : null;
  };
  const renderVars = (vars) => {
    const out = {};
    for (const [k, v] of Object.entries(vars || {})) out[k] = v && typeof v === 'object' && v.$t ? tr(v.$t, vars) : v;
    return out;
  };
  const rendered = found.slice(0, 8).map((f) => {
    const vars = renderVars(f.vars);
    const seenA = new Set();
    return {
      id: f.id,
      priority: f.priority,
      confidence: f.confidence,
      severity: f.severity,
      title: tr(f.titleKey, vars),
      text: tr(f.textKey, vars),
      mods: [...new Set(f.mods)].map(modInfo).filter(Boolean),
      actions: f.actions
        .filter((a) => {
          const key = `${a.type}|${JSON.stringify(a.payload || {})}`;
          if (seenA.has(key)) return false;
          seenA.add(key);
          return true;
        })
        .map((a) => ({ type: a.type, label: tr(a.label[0], a.label[1]), payload: a.payload || {}, primary: Boolean(a.primary) })),
    };
  });

  return {
    findings: rendered,
    suspects: suspects.map((s) => ({ ...modInfo(s.file), score: s.score, reasons: s.reasons.map((r) => tr(`crash.reason_${r}`)) })).filter((s) => s.file),
    exception: primary
      ? { cls: primary.cls, msg: firstLine(primary.msg).slice(0, 300), root: root && root !== primary ? { cls: root.cls, msg: firstLine(root.msg).slice(0, 300) } : null }
      : null,
    description: report?.description || '',
    progress: c.progress,
    javaMajor,
    memoryMb,
    gpuVendor: c.gpuVendor,
    fabricResolution: c.fabric.found,
  };
}

module.exports = { analyze, scoreSuspects, buildIndex };
