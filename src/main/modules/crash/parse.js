'use strict';
// Lectura de crash reports, logs y hs_err_pid: extrae excepciones con sus frames, bloques de error de
// Fabric/Forge/NeoForge, fallas de mixins, datos del sistema y marcas de "llego al menu principal".
// Funciones puras (texto -> datos), sin Electron.

// ---------- Frames y trazas de Java ----------

const FRAME_LINE = /^\s*at\s+(.+?)\(([^()]*)\)(.*)$/;
const HEADER = /^\s*(?:Exception in thread "[^"]*"\s+)?([A-Za-z_$][\w$]*(?:\.[\w$]+)+)(?::\s?(.*))?\s*$/;
const MIXIN_HANDLER = /^(?:handler|redirect|modify|localvar|wrapOperation|modifyExpressionValue|modifyReturnValue|wrapWithCondition|modifyArg|modifyArgs|modifyConstant|modifyVariable|wrapMethod|inject|md[0-9a-f]+)\$[0-9a-z]+\$([a-z][a-z0-9_.-]*)\$/i;

function looksLikeClass(cls) {
  const last = cls.slice(cls.lastIndexOf('.') + 1);
  return /^[A-Z]/.test(last) || /^class_\d+/.test(last) || last.includes('$');
}

// "at TRANSFORMER/sodium@0.5.3/me.x.Clase.metodo(Clase.java:10) ~[sodium.jar%23123!/:?] {re:mixin,pl:mixin:APP:sodium.mixins.json:X}"
function parseFrame(line) {
  const m = String(line).match(FRAME_LINE);
  if (!m) return null;
  const target = m[1].replace(/\/0x[0-9a-f]+/gi, '').trim();
  const parts = target.split('/');
  const qualified = parts.pop();
  let loader = null;
  let module = null;
  if (parts.length >= 2) {
    loader = parts[0];
    module = parts[1];
  } else if (parts.length === 1) module = parts[0];
  const dot = qualified.lastIndexOf('.');
  if (dot <= 0) return null;
  const cls = qualified.slice(0, dot);
  const method = qualified.slice(dot + 1);
  let modId = null;
  let modVersion = null;
  if (module && module.includes('@') && loader) {
    [modId, modVersion] = module.split('@');
  }
  const rest = m[3] || '';
  const jar = (rest.match(/\[([^\[\]:]+?\.jar)(?:%23\d+)?(?:!\/)?(?::[^\]]*)?\]/) || [])[1] || null;
  const mixins = [...rest.matchAll(/pl:mixin:APP:([\w.\-/]+?\.json)(?::[\w.$]+)?/g)].map((x) => x[1]);
  const handler = method.match(MIXIN_HANDLER);
  return {
    cls,
    method,
    source: m[2],
    loader,
    module,
    modId,
    modVersion,
    jar: jar ? jar.split(/[\\/]/).pop() : null,
    mixins,
    handlerMod: handler ? handler[1] : null,
    raw: String(line).trim(),
  };
}

// Busca hacia arriba la linea de encabezado ("paquete.Excepcion: mensaje") de una traza.
function findHeader(lines, frameIdx) {
  for (let j = frameIdx - 1; j >= Math.max(0, frameIdx - 120); j--) {
    const l = lines[j];
    const cause = l.match(/^\s*Caused by:\s+([\w$.]+)(?::\s?(.*))?$/);
    if (cause) return { cls: cause[1], msg: [cause[2] || '', ...lines.slice(j + 1, frameIdx)].join('\n').trim(), line: j };
    const m = l.match(HEADER);
    if (m && looksLikeClass(m[1])) return { cls: m[1], msg: [m[2] || '', ...lines.slice(j + 1, frameIdx)].join('\n').trim(), line: j };
    if (/^\[\d{1,2}:\d{2}:\d{2}/.test(l) || /^\s*$/.test(l)) {
      // La linea del log suele contener el mensaje y la excepcion va en la siguiente
      const inLog = l.match(/\]:\s+([A-Za-z_$][\w$]*(?:\.[\w$]+)+)(?::\s?(.*))?$/);
      if (inLog && looksLikeClass(inLog[1])) return { cls: inLog[1], msg: [inLog[2] || '', ...lines.slice(j + 1, frameIdx)].join('\n').trim(), line: j };
      return null;
    }
  }
  return null;
}

/**
 * Trazas de Java dentro de un texto. Cada una: { cls, msg, frames, causes: [{ cls, msg, frames }], line }
 */
function parseTraces(text, { max = 60 } = {}) {
  const lines = String(text || '').split(/\r?\n/);
  const traces = [];
  let cur = null;
  let node = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s+at\s/.test(line) || /^\s*at\s+[\w$.]+[/.][\w$<>]+\(/.test(line)) {
      const f = parseFrame(line);
      if (!f) continue;
      if (!node) {
        const header = findHeader(lines, i);
        if (!header) continue;
        cur = { ...header, frames: [], causes: [] };
        node = cur;
        traces.push(cur);
        if (traces.length > max) traces.shift();
      }
      if (node.frames.length < 400) node.frames.push(f);
      continue;
    }
    if (/^\s*\.\.\. \d+ (more|common frames omitted)/.test(line)) continue;
    const cause = line.match(/^\s*Caused by:\s+([\w$.]+)(?::\s?(.*))?$/);
    if (cause && cur) {
      node = { cls: cause[1], msg: (cause[2] || '').trim(), frames: [] };
      cur.causes.push(node);
      continue;
    }
    if (/^\s*Suppressed:/.test(line) && cur) {
      node = { cls: 'suppressed', msg: '', frames: [] }; // se descarta
      continue;
    }
    if (node && node.frames.length) {
      // Fin de la traza actual
      node = null;
      cur = null;
    }
  }
  return traces;
}

const rootOf = (trace) => (trace?.causes?.length ? trace.causes[trace.causes.length - 1] : trace) || null;

// ---------- Crash report ----------

function section(text, name) {
  const re = new RegExp(`-- ${name} --\\r?\\n([\\s\\S]*?)(?=\\r?\\n-- [^\\n]+ --\\r?\\n|$)`);
  return (String(text).match(re) || [])[1] || '';
}

function parseReport(text) {
  if (!text) return null;
  const t = String(text);
  const out = {
    description: (t.match(/^Description:\s*(.+)$/m) || [])[1]?.trim() || '',
    time: (t.match(/^Time:\s*(.+)$/m) || [])[1]?.trim() || '',
    trace: null,
    suspected: [],
    modList: [],
    erroredMods: [],
    modSections: [],
    system: {},
    entity: null,
    blockEntity: null,
    levelName: null,
  };
  // Traza principal: la primera despues de "Description:"
  const descIdx = t.search(/^Description:/m);
  const walk = t.indexOf('A detailed walkthrough of the error');
  const head = t.slice(descIdx >= 0 ? descIdx : 0, walk > 0 ? walk : undefined);
  out.trace = parseTraces(head, { max: 3 })[0] || null;

  // Forge/NeoForge: "Suspected Mod(s):"
  const sus = t.match(/Suspected Mods?:[ \t]*(\S.*)?\r?\n((?:\t.*\r?\n?)*)/);
  if (sus && !/^NONE/i.test(sus[1] || '')) {
    for (const m of (sus[2] || '').matchAll(/^\t([^\t\r\n].*?) \(([\w.-]+)\), Version: (\S+)/gm)) out.suspected.push({ name: m[1].trim(), id: m[2], version: m[3] });
  }
  // Lista de mods de Forge: "archivo.jar |Nombre |id |version |ESTADO |Manifest: ..."
  for (const m of t.matchAll(/^\s+(\S+\.jar)\s*\|(.+?)\s*\|([\w.-]+)\s*\|(\S+)\s*\|(\w+)\s*\|/gm)) {
    const rec = { file: m[1], name: m[2].trim(), id: m[3], version: m[4], state: m[5] };
    out.modList.push(rec);
    if (/^(ERROR|ERRORED)$/i.test(rec.state)) out.erroredMods.push(rec);
  }
  // Forge viejo (1.12): tabla de estados "| UCHIJE | modid | Nombre | version | archivo |"
  for (const m of t.matchAll(/^\s*\|\s*([LCHIJADUE]+)\s*\|\s*([\w.-]+)\s*\|\s*(.+?)\s*\|\s*(\S+)\s*\|\s*(\S+?)\s*\|/gm)) {
    const rec = { file: m[5], name: m[3], id: m[2], version: m[4], state: m[1] };
    out.modList.push(rec);
    if (m[1].endsWith('E')) out.erroredMods.push(rec);
  }
  // Fabric: "Fabric Mods:" (dos tabs = mod principal)
  const fm = t.match(/Fabric Mods:[ \t]*\r?\n((?:\t\t.*\r?\n?)*)/);
  if (fm) {
    for (const m of fm[1].matchAll(/^\t\t([\w.-]+): (.+) (\S+)\s*$/gm)) out.modList.push({ id: m[1], name: m[2].trim(), version: m[3], file: null, state: '' });
  }
  // Secciones "-- MOD x --" de Forge con el mensaje de error
  for (const m of t.matchAll(/-- MOD ([\w.-]+) --\r?\nDetails:\r?\n([\s\S]*?)(?=\r?\nStacktrace:|\r?\n-- )/g)) {
    const body = m[2];
    out.modSections.push({
      id: m[1],
      file: ((body.match(/Mod File:\s*(.+)/) || [])[1] || '').trim().split(/[\\/]/).pop() || null,
      failure: ((body.match(/Failure message:\s*(.+)/) || [])[1] || '').trim(),
      exception: ((body.match(/Exception message:\s*(.+)/) || [])[1] || '').trim(),
    });
  }
  // Entidades y bloques que crashearon mientras se actualizaban
  const ent = section(t, 'Entity being ticked');
  if (ent) {
    const m = ent.match(/Entity Type:\s*([\w.-]+:[\w./-]+)(?:\s*\(([\w.$]+)\))?/);
    if (m) out.entity = { type: m[1], cls: m[2] || null };
  }
  const be = section(t, 'Block entity being ticked') || section(t, 'Block entity being rendered');
  if (be) {
    const m = be.match(/Name:\s*([\w.-]+:[\w./-]+)\s*\/\/\s*([\w.$]+)/) || be.match(/Block:\s*Block\{([\w.-]+:[\w./-]+)\}/);
    if (m) out.blockEntity = { type: m[1], cls: m[2] && m[2].includes('.') ? m[2] : null };
  }
  out.levelName = ((t.match(/^\s*Level name:\s*(.+)$/m) || [])[1] || '').trim() || null;
  // Detalles del sistema
  const sys = {};
  const pick = (re) => ((t.match(re) || [])[1] || '').trim();
  sys.minecraft = pick(/^\s*Minecraft Version:\s*(.+)$/m);
  sys.java = pick(/^\s*Java Version:\s*(.+)$/m);
  sys.javaMajor = majorOf(sys.java);
  sys.jvmFlags = pick(/^\s*JVM Flags:\s*(.+)$/m);
  sys.os = pick(/^\s*Operating System:\s*(.+)$/m);
  sys.gpu = pick(/^\s*Graphics card #0 name:\s*(.+)$/m) || pick(/^\s*GL info:\s*'?\s*([^']+)/m) || pick(/^\s*Backend API:\s*(.+)$/m);
  sys.gpuVendor = pick(/^\s*Graphics card #0 vendor:\s*(.+)$/m);
  sys.launched = pick(/^\s*Launched Version:\s*(.+)$/m);
  const memMax = t.match(/^\s*Memory:.*up to \d+ bytes \((\d+) MiB\)/m);
  sys.maxMemoryMb = memMax ? Number(memMax[1]) : xmxOf(sys.jvmFlags);
  out.system = sys;
  return out;
}

function majorOf(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  const m = s.match(/^1\.(\d+)/) || s.match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

function xmxOf(flags) {
  const m = String(flags || '').match(/-Xmx(\d+)([kKmMgG])?/);
  if (!m) return null;
  const n = Number(m[1]);
  const u = (m[2] || '').toLowerCase();
  return u === 'g' ? n * 1024 : u === 'k' ? Math.round(n / 1024) : u === 'm' ? n : Math.round(n / 1048576);
}

// ---------- Rangos de versiones ----------

// Frases de Fabric Loader ("version 0.5.9 or later") -> { op, v, v2 }
function parseRangeText(text) {
  const s = String(text || '').trim().replace(/\.$/, '');
  let m;
  if (!s || /^any version$/i.test(s) || s === '*') return { op: 'any', raw: s };
  if ((m = s.match(/^(?:any )?version (\S+) or later$/i))) return { op: 'ge', v: m[1], raw: s };
  if ((m = s.match(/^(?:any )?version (\S+) or earlier$/i))) return { op: 'le', v: m[1], raw: s };
  if ((m = s.match(/^(?:an?y? )?version (?:after|newer than|greater than|later than) (\S+)$/i))) return { op: 'gt', v: m[1], raw: s };
  if ((m = s.match(/^(?:an?y? )?version (?:before|older than|less than|earlier than) (\S+)$/i))) return { op: 'lt', v: m[1], raw: s };
  if ((m = s.match(/^any (\S+?)\.x version$/i))) return { op: 'major', v: m[1], raw: s };
  if ((m = s.match(/^(?:any )?version between (\S+) \((inclusive|exclusive)\) and (\S+) \((inclusive|exclusive)\)$/i))) return { op: 'between', v: m[1], v2: m[3], raw: s };
  if ((m = s.match(/^version (\S+)$/i))) return { op: 'eq', v: m[1], raw: s };
  return { op: 'raw', v: s, raw: s };
}

// Rangos Maven de Forge ("[47.2.0,)") -> { op, v, v2 }
function parseMavenRange(text) {
  const s = String(text || '').trim();
  let m;
  if (!s || s === '*' || s === '[,)' || s === '(,)') return { op: 'any', raw: s };
  if ((m = s.match(/^\[([^,\]]+)\]$/))) return { op: 'eq', v: m[1], raw: s };
  if ((m = s.match(/^\[([^,]+),\s*\)$/))) return { op: 'ge', v: m[1], raw: s };
  if ((m = s.match(/^\(([^,]+),\s*\)$/))) return { op: 'gt', v: m[1], raw: s };
  if ((m = s.match(/^\(\s*,([^,\]]+)\]$/))) return { op: 'le', v: m[1], raw: s };
  if ((m = s.match(/^\(\s*,([^,)]+)\)$/))) return { op: 'lt', v: m[1], raw: s };
  if ((m = s.match(/^[[(]([^,]+),([^,]+)[\])]$/))) return { op: 'between', v: m[1].trim(), v2: m[2].trim(), raw: s };
  if ((m = s.match(/^([\w.+-]+)$/))) return { op: 'ge', v: m[1], raw: s };
  return { op: 'raw', v: s, raw: s };
}

// ---------- Fabric: "Incompatible mods found!" ----------

const BUILTIN_NAMES = { minecraft: 'minecraft', 'fabric loader': 'fabricloader', java: 'java', 'openjdk 64-bit server vm': 'java', 'quilt loader': 'quilt_loader' };

function targetOf(name, id, bare) {
  if (id) return { id: id.trim(), name: name || id };
  if (name) return { id: BUILTIN_NAMES[name.toLowerCase()] || name.toLowerCase().replace(/\s+/g, '-'), name };
  return { id: bare.trim(), name: bare.trim() };
}

function parseFabricResolution(text) {
  const t = String(text || '');
  const out = { found: false, solutions: [], details: [] };
  if (!/Incompatible mods? (?:found|set)|Mod resolution (?:failed|encountered)|Some of your mods are incompatible|Unmet dependency listing|Could not find required mod|Errors were found!/i.test(t)) return out;
  out.found = true;
  const seen = new Set();
  for (const raw of t.split(/\r?\n/)) {
    const line = raw.replace(/^\s*(?:-\s*)?/, '').replace(/^\[[^\]]*\]\s*\[[^\]]*\]:\s*/, '').trim();
    if (!line || seen.has(line)) continue;
    let m = line.match(
      /^Mod '(.+?)' \(([^)]+)\) (\S+) (requires|is incompatible with|conflicts with|recommends|suggests) (.+?) of (?:mod )?(?:'([^']+)'(?: \(([^)]+)\))?|([\w.\-]+)), (which is missing|but only the wrong version is present: (.+?)|but a matching version is present: (.+?)|yet a conflicting version is present: (.+?)|but a conflicting version is present: (.+?))!?$/,
    );
    if (m) {
      seen.add(line);
      const target = targetOf(m[6], m[7], m[8] || '');
      const verb = m[4].toLowerCase();
      out.details.push({
        kind: verb === 'requires' ? (m[9].startsWith('which is missing') ? 'missing' : 'wrongVersion') : verb.startsWith('is incompatible') || verb.startsWith('conflicts') ? 'breaks' : 'recommends',
        mod: { name: m[1], id: m[2], version: m[3] },
        dep: target,
        range: parseRangeText(m[5]),
        present: m[10] || m[11] || m[12] || m[13] || null,
      });
      continue;
    }
    // Formato viejo (0.10/0.11): "Could not find required mod: x requires {y @ [>=1.0]}"
    m = line.match(/Could not find required mod: ([\w.-]+) requires \{([\w.-]+) @ \[([^\]]*)\]\}/);
    if (m) {
      seen.add(line);
      out.details.push({ kind: 'missing', mod: { name: m[1], id: m[1], version: '' }, dep: { id: m[2], name: m[2] }, range: { op: 'raw', v: m[3], raw: m[3] }, present: null });
      continue;
    }
    m = line.match(/^Mod ([\w.-]+) requires (?:mod )?([\w.-]+)(?: \{([^}]*)\})?, which is missing!?$/i);
    if (m) {
      seen.add(line);
      out.details.push({ kind: 'missing', mod: { name: m[1], id: m[1], version: '' }, dep: { id: m[2], name: m[2] }, range: { op: m[3] ? 'raw' : 'any', v: m[3] || '', raw: m[3] || '' }, present: null });
      continue;
    }
    m = line.match(/^Install ([\w.\-]+), (.+?)\.?$/);
    if (m) {
      seen.add(line);
      out.solutions.push({ type: 'install', id: m[1], range: parseRangeText(m[2]) });
      continue;
    }
    m = line.match(/^Replace (?:mod )?'(.+?)'(?: \(([^)]+)\))? (\S+) with (.+?)(?: that is compatible with:)?\.?$/);
    if (m) {
      seen.add(line);
      out.solutions.push({ type: 'replace', name: m[1], id: (m[2] || BUILTIN_NAMES[m[1].toLowerCase()] || m[1]).trim(), version: m[3], range: parseRangeText(m[4]) });
      continue;
    }
    m = line.match(/^Remove (?:mod )?'(.+?)'(?: \(([^)]+)\))? (\S+?)(?: from (.+?))?\.?$/);
    if (m) {
      seen.add(line);
      out.solutions.push({ type: 'remove', name: m[1], id: (m[2] || m[1]).trim(), version: m[3], path: m[4] || null });
    }
  }
  return out;
}

// ---------- Forge / NeoForge ----------

function parseForgeDeps(text) {
  const out = [];
  const seen = new Set();
  for (const m of String(text || '').matchAll(/Mod ID: '([^']+)', Requested by: '([^']+)', Expected range: '([^']*)', Actual version: '([^']*)'/g)) {
    const key = `${m[1]}|${m[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ modId: m[1], requestedBy: m[2], range: parseMavenRange(m[3]), rawRange: m[3], actual: /\[?MISSING\]?/i.test(m[4]) ? null : m[4] });
  }
  // Forge 1.12: "net.minecraftforge.fml.common.MissingModsException: Mod x (X) requires [y@[1.0,)]"
  for (const m of String(text || '').matchAll(/MissingModsException: Mod ([\w.-]+) \((.+?)\) requires \[([^\]@]+)@?([^\]]*\]?)\]?/g)) {
    const key = `${m[3]}|${m[1]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ modId: m[3].trim(), requestedBy: m[1], range: parseMavenRange(m[4]), rawRange: m[4], actual: null });
  }
  return out;
}

function parseDuplicates(text) {
  const out = [];
  const t = String(text || '');
  for (const m of t.matchAll(/Mod ID: '([^']+)' from mod files: ([^\r\n]+)/g)) {
    out.push({ id: m[1], files: m[2].split(/,\s*/).map((s) => s.trim().split(/[\\/]/).pop()).filter(Boolean) });
  }
  for (const m of t.matchAll(/Duplicate mod(?:s)? (?:found|detected)[^\r\n]*?:?\s*'?([\w.-]+)'?/gi)) {
    if (!out.some((d) => d.id === m[1])) out.push({ id: m[1], files: [] });
  }
  return out;
}

// ---------- Mixins ----------

function parseMixins(text) {
  const t = String(text || '');
  const failures = [];
  const conflicts = [];
  const missingConfigs = [];
  const add = (f) => {
    if (!failures.some((x) => x.config === f.config && x.mixin === f.mixin && x.modId === f.modId)) failures.push(f);
  };
  for (const m of t.matchAll(/Mixin apply for mod ([\w.-]+) failed ([\w.\-/]+?\.json):([\w.$]+) from mod ([\w.-]+) -> ([\w.$]+): ([\w.$]+)(?:[ :]+([^\r\n]*))?/g)) {
    add({ modId: m[4] || m[1], config: m[2], mixin: m[3], target: m[5], error: m[6].split('.').pop(), detail: (m[7] || '').slice(0, 300) });
  }
  for (const m of t.matchAll(/Mixin \[([\w.\-/]+?\.json):([\w.$]+)\] from phase \[\w+\] in config \[([\w.\-/]+?\.json)\] FAILED during (\w+)/g)) {
    add({ modId: null, config: m[3], mixin: m[2], target: null, error: `FAILED during ${m[4]}`, detail: '' });
  }
  for (const m of t.matchAll(/Mixin (?:prepare|transformation|apply) (?:for|of) mod ([\w.-]+) failed(?: ([\w.\-/]+?\.json)(?::([\w.$]+))?)?/g)) {
    add({ modId: m[1], config: m[2] || null, mixin: m[3] || null, target: null, error: '', detail: '' });
  }
  for (const m of t.matchAll(/Critical injection failure: ([^\r\n]+)/g)) {
    const inner = m[1].match(/-> ([\w.\-/]+?\.json):([\w.$]+) ->/);
    const target = (m[1].match(/ in ([\w.$]+)\./) || [])[1] || null;
    if (inner) add({ modId: null, config: inner[1], mixin: inner[2], target, error: 'InvalidInjectionException', detail: m[1].slice(0, 300) });
  }
  for (const m of t.matchAll(/@Redirect conflict\. Skipping ([\w.\-/]+?\.json):([\w.$]+)->@Redirect::\S+ with priority \d+, already redirected by ([\w.\-/]+?\.json):([\w.$]+)->@Redirect::/g)) {
    conflicts.push({ a: { config: m[1], mixin: m[2] }, b: { config: m[3], mixin: m[4] }, kind: 'redirect' });
  }
  for (const m of t.matchAll(/Method overwrite conflict for (\S+) in ([\w.\-/]+?\.json):([\w.$]+), previously written by ([\w.\-/]+?\.json):([\w.$]+)\. Skipping method\./g)) {
    conflicts.push({ a: { config: m[2], mixin: m[3] }, b: { config: m[4], mixin: m[5] }, kind: 'overwrite', member: m[1] });
  }
  for (const m of t.matchAll(/Mixin config ([\w.\-/]+?\.json) does not exist/g)) if (!missingConfigs.includes(m[1])) missingConfigs.push(m[1]);
  return { failures, conflicts, missingConfigs };
}

// ---------- Otros datos del log ----------

function parseEntrypoints(text) {
  const out = [];
  for (const m of String(text || '').matchAll(/Could not execute entrypoint stage '(\w+)' due to errors, provided by '([\w.-]+)'(?: at '([^']+)')?/g)) {
    if (!out.some((e) => e.modId === m[2])) out.push({ stage: m[1], modId: m[2], at: m[3] || null });
  }
  // Forge 1.12: "Caught exception from Nombre (modid)"
  for (const m of String(text || '').matchAll(/Caught exception from (.+?) \(([\w.-]+)\)/g)) {
    if (!out.some((e) => e.modId === m[2])) out.push({ stage: 'init', modId: m[2], name: m[1], at: null });
  }
  // Forge/NeoForge: "Sodium (sodium) encountered an error during the common_setup event phase"
  for (const m of String(text || '').matchAll(/(.+?) \(([\w.-]+)\) (?:encountered an error during the|has failed to load correctly during) ([\w_ ]+?)(?: event)? phase/g)) {
    if (!out.some((e) => e.modId === m[2])) out.push({ stage: m[3].trim(), modId: m[2], name: m[1].replace(/^.*[:\]]\s*/, '').trim(), at: null });
  }
  for (const m of String(text || '').matchAll(/Failed to create mod instance\. ModID: ([\w.-]+), class ([\w.$]+)/g)) {
    if (!out.some((e) => e.modId === m[1])) out.push({ stage: 'construct', modId: m[1], at: m[2] });
  }
  return out;
}

function parseHsErr(text) {
  if (!text) return null;
  const t = String(text);
  if (!/A fatal error has been detected by the Java Runtime Environment|There is insufficient memory for the Java Runtime Environment/.test(t)) return null;
  const frame = t.match(/#\s+Problematic frame:\s*\r?\n#\s+(\w)\s+\[([^\]+]+)(?:\+0x[0-9a-f]+)?\]\s*([^\r\n]*)/i);
  return {
    error: (t.match(/#\s+(EXCEPTION_\w+|SIG[A-Z]+|Internal Error)/) || [])[1] || null,
    insufficientMemory: /There is insufficient memory for the Java Runtime Environment to continue/.test(t),
    module: frame ? frame[2].trim() : null,
    frameType: frame ? frame[1] : null,
    symbol: frame ? frame[3].trim() : null,
    javaMajor: majorOf((t.match(/#\s+JRE version:.*?\(([\d._]+)/) || [])[1]),
    is32bit: /windows-x86\b|Client VM|32-Bit/i.test((t.match(/#\s+Java VM:[^\r\n]*/) || [''])[0]),
  };
}

function javaFromLog(text) {
  const t = String(text || '');
  const m = t.match(/(?:con|with) Java (\d+(?:[._]\d+)*)/) || t.match(/java version (\d+(?:[._]\d+)*)/i) || t.match(/JVM identified as .*?\b(\d+)(?:\.\d+)*[+-]/) || t.match(/Java is .*?version (\d+(?:[._]\d+)*)/);
  return m ? majorOf(m[1]) : null;
}

// Marcas de que el juego llego al menu principal (para saber si el crash fue al arrancar o jugando).
const MENU_MARKERS = {
  atlas: /Created:\s+\d+x\d+(?:x\d+)?\s+\S*atlas/i,
  sound: /Sound engine started/i,
  legacyDone: /Forge Mod Loader has successfully loaded \d+ mods?/i,
};
const IN_GAME = /joined the game|Starting integrated minecraft server|Connecting to [^\s,]+,\s*\d+|Loaded \d+ advancements|Preparing spawn area|Changing view distance/i;

function progressOf(text) {
  const t = String(text || '');
  const atlas = MENU_MARKERS.atlas.test(t);
  const sound = MENU_MARKERS.sound.test(t);
  const legacy = MENU_MARKERS.legacyDone.test(t);
  return { reachedMenu: (atlas && sound) || legacy, inGame: IN_GAME.test(t) };
}

// Ruta de archivo de configuracion mencionada cerca de un error ("config/sodium-options.json").
function configPathsIn(text) {
  const out = [];
  for (const m of String(text || '').matchAll(/(?:^|[\s'"(=\[/\\])((?:config|defaultconfigs)[\\/][^\s'"():,\]]+?\.(?:json5?|toml|cfg|properties|ya?ml|txt|conf|snbt|ini))\b/gim)) {
    const p = m[1].replace(/\\/g, '/');
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

module.exports = {
  parseFrame,
  parseTraces,
  rootOf,
  parseReport,
  parseRangeText,
  parseMavenRange,
  parseFabricResolution,
  parseForgeDeps,
  parseDuplicates,
  parseMixins,
  parseEntrypoints,
  parseHsErr,
  javaFromLog,
  progressOf,
  configPathsIn,
  majorOf,
  xmxOf,
  MENU_MARKERS,
  looksLikeClass,
};
