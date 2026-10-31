'use strict';
// Conflictos de mixins entre mods: cruza todas las inyecciones por clase y método objetivo.
//  - overwrite:          dos mods reemplazan (@Overwrite) el mismo método                     -> alto
//  - overwrite-inject:   un mod reemplaza un método en el que otro mod inyecta código         -> medio/alto
//  - redirect:           dos mods redirigen (@Redirect) la misma llamada del mismo método     -> medio
//  - redirect-callsite:  un @Redirect y otro inyector de MixinExtras sobre la misma llamada   -> medio
//  - crowded:            muchos mods tocan el mismo método                                    -> info

const CALLSITE = new Set(['redirect', 'modifyArg', 'modifyArgs', 'modifyConstant', 'modifyVariable', 'wrapOperation', 'wrapWithCondition', 'modifyExpressionValue', 'modifyReceiver']);
const BODY_AT = new Set(['HEAD', 'RETURN', 'TAIL']);
const WRAPPERS = new Set(['modifyArg', 'modifyArgs', 'wrapOperation', 'wrapWithCondition', 'modifyExpressionValue', 'modifyReceiver']);
const SEV = { high: 3, medium: 2, info: 1 };

// ¿La inyección depende de instrucciones concretas del cuerpo del método?
function isCallsite(e) {
  if (e.kind === 'overwrite') return false;
  if (CALLSITE.has(e.kind)) return true;
  if (e.kind === 'inject') return e.at.some((a) => !BODY_AT.has(String(a.v).toUpperCase()));
  return false;
}

// Comparación simple de versiones para quedarse con la copia más nueva de un mod repetido.
function cmpVersion(a, b) {
  const pa = String(a || '').split(/[^0-9A-Za-z]+/);
  const pb = String(b || '').split(/[^0-9A-Za-z]+/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || '0';
    const y = pb[i] || '0';
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const d = Number(x) - Number(y);
      if (d) return d < 0 ? -1 : 1;
    } else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function pickAlias(votes) {
  let best = null;
  let n = 0;
  for (const [k, v] of Object.entries(votes || {})) if (v > n) [best, n] = [k, v];
  return best;
}

// Normaliza el objetivo de un @At para comparar llamadas: "Lowner;name(desc)" -> "owner.name(desc)"
function callKey(t) {
  const s = String(t || '').trim();
  if (!s) return '';
  const m = /^L([^;]+);(.+)$/.exec(s);
  return m ? `${m[1]}.${m[2]}` : s;
}

/**
 * mods: [{ key, id, name, version, file, path, configs, mixins, aliases }] (salida de extractMixins + datos del archivo)
 * Devuelve { mods (sin duplicados), conflicts, hot, aliases: { classes, methods }, stats }
 */
function computeConflicts(input, { crowdThreshold = 4 } = {}) {
  // 1) Un mod que viene repetido (jar-in-jar en varios mods) se carga una sola vez: la versión más nueva.
  const byId = new Map();
  const mods = [];
  for (const m of input) {
    if (!m.mixins?.length && !m.id) continue;
    const id = m.id || m.key;
    const prev = byId.get(id);
    if (prev) {
      const v = cmpVersion(m.version, prev.version);
      if (v > 0 || (v === 0 && (m.mixins?.length || 0) > (prev.mixins?.length || 0))) {
        mods[mods.indexOf(prev)] = m;
        byId.set(id, m);
      }
      continue;
    }
    byId.set(id, m);
    mods.push(m);
  }

  // 2) Nombres legibles: votos de todos los refmaps y de los nombres de las clases mixin.
  const classVotes = {};
  const methodVotes = {};
  const guessVotes = {};
  for (const m of mods) {
    for (const [k, v] of Object.entries(m.aliases?.c || {})) for (const [name, n] of Object.entries(v)) classVotes[k] = { ...(classVotes[k] || {}), [name]: (classVotes[k]?.[name] || 0) + n };
    for (const [k, v] of Object.entries(m.aliases?.m || {})) for (const [name, n] of Object.entries(v)) methodVotes[k] = { ...(methodVotes[k] || {}), [name]: (methodVotes[k]?.[name] || 0) + n };
    for (const x of m.mixins || []) {
      if (x.t.length === 1 && x.g) guessVotes[x.t[0]] = { ...(guessVotes[x.t[0]] || {}), [x.g]: (guessVotes[x.t[0]]?.[x.g] || 0) + 1 };
    }
  }
  const classAlias = (cls) => {
    const named = pickAlias(classVotes[cls]);
    if (named) return { name: named.slice(named.lastIndexOf('/') + 1).replace(/\$/g, '.'), full: named.replace(/\//g, '.'), guess: false };
    const outer = cls.includes('$') ? cls.slice(0, cls.indexOf('$')) : null;
    const outerNamed = outer && pickAlias(classVotes[outer]);
    if (outerNamed) return { name: `${outerNamed.slice(outerNamed.lastIndexOf('/') + 1)}${cls.slice(cls.indexOf('$')).replace(/\$/g, '.')}`, full: null, guess: false };
    const g = pickAlias(guessVotes[cls]);
    if (g) return { name: g, full: null, guess: true };
    return null;
  };
  const methodAlias = (name) => pickAlias(methodVotes[name]);

  // 3) Indice: "clase#metodo" -> entradas
  const index = new Map();
  const classMods = new Map();
  let mixinClasses = 0;
  let injections = 0;
  mods.forEach((mod, mi) => {
    for (const x of mod.mixins || []) {
      mixinClasses++;
      const managed = Boolean(mod.configs?.[x.cfg]?.plugin);
      for (const target of x.t) {
        if (!classMods.has(target)) classMods.set(target, new Set());
        classMods.get(target).add(mi);
        const push = (name, entry) => {
          const key = `${target}#${name}`;
          if (!index.has(key)) index.set(key, []);
          index.get(key).push({ mod: mi, mixin: x.c, prio: x.p, managed, dyn: Boolean(x.dyn), ...entry });
        };
        for (const o of x.ow) {
          injections++;
          push(o.n, { kind: 'overwrite', desc: o.d, at: [], optional: false, handler: o.n, named: '' });
        }
        for (const inj of x.inj) {
          for (const sel of inj.m) {
            if (!sel.n || sel.n === '*' || sel.n.includes('*') || sel.n.startsWith('/')) continue;
            injections++;
            push(sel.n, { kind: inj.k, desc: sel.d || '', at: inj.at || [], optional: !inj.req, handler: inj.h, named: sel.s || '', cancellable: Boolean(inj.can) });
          }
        }
      }
    }
  });

  // 4) Conflictos
  const conflicts = [];
  const seen = new Set();
  for (const [key, entries] of index) {
    const distinct = new Set(entries.map((e) => e.mod));
    if (distinct.size < 2) continue;
    const [cls, name] = [key.slice(0, key.lastIndexOf('#')), key.slice(key.lastIndexOf('#') + 1)];
    // Separar sobrecargas cuando hay descriptores distintos (las entradas sin descriptor van a todos los grupos)
    const descs = [...new Set(entries.map((e) => e.desc).filter(Boolean))];
    const groups = descs.length <= 1 ? [{ desc: descs[0] || '', entries }] : descs.map((d) => ({ desc: d, entries: entries.filter((e) => !e.desc || e.desc === d) }));
    for (const g of groups) {
      const ambiguous = g.entries.some((e) => !e.desc) && descs.length > 1;
      const found = [];
      const overwriters = new Set(g.entries.filter((e) => e.kind === 'overwrite').map((e) => e.mod));
      if (overwriters.size >= 2) {
        found.push({ kind: 'overwrite', severity: 'high', entries: g.entries.filter((e) => e.kind === 'overwrite') });
      }
      if (overwriters.size >= 1) {
        const others = g.entries.filter((e) => !overwriters.has(e.mod) && e.kind !== 'overwrite');
        if (others.length) {
          const callsite = others.some((e) => isCallsite(e) && !e.optional);
          found.push({ kind: 'overwrite-inject', severity: callsite ? 'high' : 'medium', entries: [...g.entries.filter((e) => e.kind === 'overwrite'), ...others] });
        }
      }
      // Llamadas redirigidas
      const byCall = new Map();
      for (const e of g.entries) {
        if (e.kind === 'overwrite' || e.kind === 'modifyConstant') continue;
        for (const a of e.at) {
          const ck = callKey(a.t);
          if (!ck || !/^(INVOKE|INVOKE_ASSIGN|FIELD|NEW|MIXINEXTRAS:EXPRESSION)$/i.test(String(a.v))) continue;
          if (!isCallsite(e)) continue;
          if (!byCall.has(ck)) byCall.set(ck, []);
          byCall.get(ck).push({ e, ordinal: typeof a.o === 'number' ? a.o : -1, at: a });
        }
      }
      for (const [ck, list] of byCall) {
        const redirects = list.filter((x) => x.e.kind === 'redirect');
        if (!redirects.length) continue;
        const overlap = (a, b) => a.e.mod !== b.e.mod && (a.ordinal < 0 || b.ordinal < 0 || a.ordinal === b.ordinal);
        const rr = redirects.filter((a) => redirects.some((b) => overlap(a, b)));
        if (new Set(rr.map((x) => x.e.mod)).size >= 2) {
          found.push({ kind: 'redirect', severity: 'medium', call: ck, entries: rr.map((x) => x.e) });
        }
        const wraps = list.filter((x) => WRAPPERS.has(x.e.kind) && redirects.some((r) => overlap(r, x)));
        if (wraps.length) {
          const involved = [...redirects.filter((r) => wraps.some((w) => overlap(r, w))), ...wraps];
          if (new Set(involved.map((x) => x.e.mod)).size >= 2) found.push({ kind: 'redirect-callsite', severity: 'medium', call: ck, entries: involved.map((x) => x.e) });
        }
      }
      if (!found.length && distinct.size >= crowdThreshold && new Set(g.entries.map((e) => e.mod)).size >= crowdThreshold) {
        found.push({ kind: 'crowded', severity: 'info', entries: g.entries });
      }
      for (const f of found) {
        const sig = `${f.kind}|${cls}|${name}|${f.call || ''}|${[...new Set(f.entries.map((e) => e.mod))].sort().join(',')}`;
        if (seen.has(sig)) continue;
        seen.add(sig);
        // Si todo lo que aporta un mod viene de un plugin que decide en tiempo real (getMixins), es probable
        // que el mod ya evite el choque: se baja un nivel.
        const involved = [...new Set(f.entries.map((e) => e.mod))];
        const dynamic = involved.some((mi) => f.entries.filter((e) => e.mod === mi).every((e) => e.dyn));
        if (dynamic && f.severity !== 'info') f.severity = f.severity === 'high' ? 'medium' : 'info';
        const ca = classAlias(cls);
        const callOwner = f.call ? f.call.slice(0, f.call.indexOf('.')) : '';
        const callName = f.call ? f.call.slice(f.call.indexOf('.') + 1).replace(/[(:].*$/, '') : '';
        conflicts.push({
          id: `c${conflicts.length + 1}`,
          kind: f.kind,
          severity: f.severity,
          target: {
            cls,
            clsName: ca?.name || null,
            clsFull: ca?.full || null,
            guess: Boolean(ca?.guess),
            method: name,
            methodName: methodAlias(name) || f.entries.find((e) => e.named)?.named || null,
            desc: g.desc || '',
          },
          call: f.call
            ? { key: f.call, owner: callOwner, ownerName: classAlias(callOwner)?.name || null, name: callName, nameAlias: methodAlias(callName) || null }
            : null,
          mods: [...new Set(f.entries.map((e) => e.mod))],
          entries: f.entries.map((e) => ({
            mod: e.mod,
            mixin: e.mixin.replace(/\//g, '.'),
            kind: e.kind,
            handler: e.handler,
            at: e.at.map((a) => ({ value: a.v, target: a.t || '', named: a.n || '', ordinal: typeof a.o === 'number' ? a.o : -1 })),
            priority: e.prio,
            optional: e.optional,
            cancellable: Boolean(e.cancellable),
          })),
          managed: f.entries.some((e) => e.managed),
          dynamic,
          ambiguous,
          optional: f.entries.every((e) => e.optional || e.kind === 'overwrite') && f.entries.some((e) => e.optional),
        });
      }
    }
  }
  conflicts.sort((a, b) => SEV[b.severity] - SEV[a.severity] || b.mods.length - a.mods.length || a.target.cls.localeCompare(b.target.cls));

  // 5) Clases más modificadas
  const hot = [...classMods.entries()]
    .filter(([, set]) => set.size >= 3)
    .sort((a, b) => b[1].size - a[1].size)
    .slice(0, 10)
    .map(([cls, set]) => {
      const ca = classAlias(cls);
      return { cls, clsName: ca?.name || null, guess: Boolean(ca?.guess), mods: [...set] };
    });

  return {
    mods,
    conflicts,
    hot,
    stats: {
      mods: mods.length,
      withMixins: mods.filter((m) => m.mixins?.length).length,
      mixinClasses,
      injections,
      targets: classMods.size,
    },
  };
}

module.exports = { computeConflicts, cmpVersion, isCallsite, callKey };
