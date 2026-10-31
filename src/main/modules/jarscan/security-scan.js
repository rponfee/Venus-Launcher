'use strict';
// Análisis estático de seguridad de un jar (mod o plugin): lee todas las clases (y los jars anidados),
// arma los textos ocultos con new String(new byte[]{...}), busca las firmas de Fractureiser y aplica
// reglas de comportamiento (robo de credenciales, webhooks, descarga y ejecución de código...).
// No ejecuta nada del jar: solo lo lee.
const crypto = require('crypto');
const cf = require('./classfile');
const { openJar, nestedJars } = require('./zip');
const { describe } = require('./modmeta');
const S = require('./signatures');

const RULES_VERSION = 3;
const MAX_DEPTH = 3;
const MAX_NESTED = 64 * 1024 * 1024;
const MAX_CLASS = 16 * 1024 * 1024;
const MAX_TEXT = 1024 * 1024;
const MAX_STRINGS = 25000;
const MAX_EVIDENCE = 6;
const YIELD_MS = 12;
const TEXT_EXT = /\.(json5?|txt|properties|ya?ml|toml|cfg|conf|ini|xml|js|mjs|sh|bat|cmd|ps1|vbs|py|lua|md)$/i;
const SCRIPT_EXT = /\.(js|mjs|sh|bat|cmd|ps1|vbs|py)$/i;
const NATIVE_EXT = /\.(dll|exe|so|dylib|jnilib|sys|scr)$/i;
const RESERVED = new Set(['do', 'if', 'for', 'int', 'new', 'try', 'byte', 'case', 'char', 'else', 'enum', 'goto', 'long', 'null', 'this', 'void', 'true', 'false']);
const SEVERITY_RANK = { critical: 4, high: 3, medium: 2, info: 1 };
const RULE_ORDER = {
  'known-malware': 9,
  'fractureiser-stage0': 8,
  'fractureiser-classes': 7,
  'fractureiser-stage0b': 6,
  'fractureiser-ioc': 5,
  'fractureiser-injected': 4,
  skyrage: 3,
  'session-exfil': 3,
  'credential-stealer': 2,
  'discord-webhook': 1,
};

const NATIVE_IOCS = ['Java_dev_neko_nekoclient', 'dev/neko/nekoclient', '85.217.144.130', '107.189.3.101', 'files-8ie.pages.dev', 'skyrage.de'];

const sleep0 = () => new Promise((r) => setImmediate(r));

function dotted(name) {
  return String(name).replace(/\.class$/, '').replace(/\//g, '.');
}

function clip(s, max = 220) {
  const t = String(s).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ' ');
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function sha(buf, algo) {
  return crypto.createHash(algo).update(buf).digest('hex');
}

// Coincidencia de una secuencia de llamadas (en orden, con huecos). 'owner.name' acepta cualquier descriptor.
function matchSequence(tokens, sig) {
  let k = 0;
  for (const tok of tokens) {
    const want = sig[k];
    if (want.includes('(') ? tok === want : tok.startsWith(`${want}(`)) {
      k++;
      if (k === sig.length) return true;
    }
  }
  return false;
}

class Context {
  constructor() {
    this.strings = new Map(); // texto -> { where, hidden }
    this.classFlags = new Map(); // where -> banderas de API
    this.flags = 0;
    this.firstApi = new Map(); // bandera -> { where, value }
    this.findings = [];
    this.classCount = 0;
    this.parsed = 0;
    this.malformed = [];
    this.obf = 0;
    this.obfSample = [];
    this.natives = [];
    this.nested = 0;
    this.nestedUnreadable = [];
    this.iocPackages = [];
    this.b64 = [];
    this.lastYield = Date.now();
  }

  async maybeYield(signal) {
    if (Date.now() - this.lastYield > YIELD_MS) {
      await sleep0();
      this.lastYield = Date.now();
      if (signal?.aborted) throw signal.reason || new Error('aborted');
    }
  }

  addString(s, where, hidden = false) {
    if (typeof s !== 'string' || s.length < 4) return;
    if (s.length >= 120 && /^[A-Za-z0-9+/=\s]+$/.test(s)) {
      this.checkBase64(s, where, hidden);
      return;
    }
    if (!S.QUICK.test(s)) return;
    const prev = this.strings.get(s);
    if (prev) {
      if (hidden && !prev.hidden) this.strings.set(s, { where, hidden: true });
      return;
    }
    if (this.strings.size < MAX_STRINGS) this.strings.set(s, { where, hidden });
  }

  checkBase64(s, where, hidden) {
    const d = S.decodeBase64Blob(s);
    if (!d) return;
    if (d.kind === 'class' || d.kind === 'zip' || d.kind === 'exe' || d.kind === 'elf' || d.kind === 'script') {
      this.b64.push({ where, kind: d.kind, sample: s.slice(0, 60) });
      if (d.text) this.addString(d.text.slice(0, 4000), where, true);
      if (d.kind === 'class') this.addEmbeddedClass(d.buf, where);
    } else if (d.kind === 'url' || d.kind === 'text') {
      // texto escondido en base64: se revisa como texto oculto
      const text = d.text.slice(0, 4000);
      if (S.QUICK.test(text)) this.addString(text, where, true);
      if (d.kind === 'url') this.b64.push({ where, kind: 'url', sample: clip((S.URL_ANY.exec(text) || [text])[0], 120) });
    }
  }

  // Clase escondida en base64: se leen sus textos para no perder indicadores.
  addEmbeddedClass(buf, where) {
    try {
      const c = cf.parseClass(buf);
      for (const s of c.pool.utf8s()) this.addString(s, `${where} (base64)`, true);
    } catch {
      for (const s of S.rawStrings(buf)) this.addString(s, `${where} (base64)`, true);
    }
  }

  api(flag, where, value) {
    this.flags |= flag;
    if (!this.firstApi.has(flag)) this.firstApi.set(flag, { where, value });
  }

  add(rule, severity, evidence, extra = {}) {
    const ev = [];
    for (const e of evidence) {
      if (!e) continue;
      if (ev.some((x) => x.where === e.where && x.value === e.value)) continue;
      ev.push({ where: clip(e.where, 160), value: clip(e.value) });
      if (ev.length >= MAX_EVIDENCE) break;
    }
    const prev = this.findings.find((f) => f.rule === rule);
    if (prev) {
      for (const e of ev) if (prev.evidence.length < MAX_EVIDENCE && !prev.evidence.some((x) => x.where === e.where && x.value === e.value)) prev.evidence.push(e);
      if (SEVERITY_RANK[severity] > SEVERITY_RANK[prev.severity]) prev.severity = severity;
      if (extra.confirmed) prev.confirmed = true;
      return prev;
    }
    const f = { rule, severity, confirmed: Boolean(extra.confirmed), evidence: ev, vars: extra.vars || {} };
    this.findings.push(f);
    return f;
  }
}

// ---------- Clases ----------

function obfuscatedName(internal) {
  let simple = internal.slice(internal.lastIndexOf('/') + 1);
  const dollar = simple.lastIndexOf('$');
  if (dollar >= 0) {
    simple = simple.slice(dollar + 1);
    if (/^\d+$/.test(simple) || !simple) return false; // clases anonimas
  }
  if (/^[A-Za-z]{1,2}$/.test(simple)) return true;
  if (/^[Il1|]{3,}$/.test(simple) || /^[O0o]{4,}$/.test(simple)) return true;
  if (RESERVED.has(simple)) return true;
  if (/[^\x21-\x7e]/.test(simple)) return true; // caracteres invisibles o unicode raros
  return false;
}

function analyzeClass(buf, where, ctx) {
  ctx.classCount++;
  let c;
  try {
    c = cf.parseClass(buf);
  } catch {
    // Clase dañada (a propósito o no): se buscan indicadores en sus bytes crudos.
    ctx.malformed.push(where);
    for (const s of S.rawStrings(buf)) ctx.addString(s, where, false);
    return;
  }
  ctx.parsed++;
  if (obfuscatedName(c.name)) {
    ctx.obf++;
    if (ctx.obfSample.length < 4) ctx.obfSample.push(where);
  }
  const pool = c.pool;
  let flags = 0;
  for (const ref of pool.refs()) {
    const f = S.refFlags(ref);
    if (f) {
      flags |= f;
      for (let bit = 1; bit <= f; bit <<= 1) if (f & bit) ctx.api(bit, where, `${dotted(ref.owner)}.${ref.name}`);
    }
  }
  if (flags) ctx.classFlags.set(where, flags);
  for (const s of pool.utf8s()) if (s !== c.name) ctx.addString(s, where, false);

  const injected = c.methods.filter((m) => S.INJECTED_METHOD.test(m.name) && m.desc === '()V' && m.access & cf.ACC.STATIC);
  const needsCode = injected.length || flags & (S.F.STRBYTES | S.F.REFLECT | S.F.EXEC | S.F.CLASSLOAD | S.F.B64);
  if (!needsCode) return;

  const clinit = c.methods.find((m) => m.name === '<clinit>');
  const clinitCalls = new Set();
  if (clinit?.attrs.code) {
    const dec = cf.decodeCode(clinit.attrs.code.code);
    for (let i = 0; i < dec.length; i++) {
      if (dec.ops[i] !== cf.OP.INVOKESTATIC) continue;
      try {
        const ref = pool.ref(dec.args[i]);
        if (ref.owner === c.name) clinitCalls.add(ref.name);
      } catch {
        /* referencia rota */
      }
    }
  }

  for (const m of c.methods) {
    if (!m.attrs.code) continue;
    const res = analyzeMethod(c, m, ctx, where);
    const isInjected = injected.includes(m) && clinitCalls.has(m.name);
    if (isInjected) {
      ctx.add('fractureiser-injected', 'critical', [{ where, value: `${m.name}()` }], { confirmed: res.reflect && (res.hidden > 0 || res.urlLoader) });
    }
    if (res.stage0) ctx.add('fractureiser-stage0', 'critical', [{ where, value: `${m.name}${m.desc}` }], { confirmed: true });
    if (res.stage0b) ctx.add('fractureiser-stage0b', 'critical', [{ where, value: `${m.name}${m.desc}` }]);
  }
}

// Recorre el bytecode: textos ocultos en arreglos de bytes/chars y secuencias de llamadas.
function analyzeMethod(c, m, ctx, where) {
  const pool = c.pool;
  const dec = cf.decodeCode(m.attrs.code.code);
  const tokens = [];
  let hidden = 0;
  let reflect = false;
  let urlLoader = false;
  let arr = null;
  let finished = null; // arreglo recién terminado que puede ir a new String(...)
  let finishedAt = -10;
  for (let i = 0; i < dec.length; i++) {
    const op = dec.ops[i];
    if (op === cf.OP.NEWARRAY && (dec.args[i] === 8 || dec.args[i] === 5)) {
      arr = { type: dec.args[i] === 8 ? 'B' : 'C', vals: [] };
      continue;
    }
    if (arr) {
      if (op === cf.OP.DUP && i + 3 < dec.length) {
        const idx = cf.intConst(dec, pool, i + 1);
        const val = cf.intConst(dec, pool, i + 2);
        const st = dec.ops[i + 3];
        if (idx !== null && val !== null && idx >= 0 && idx < 65536 && (st === cf.OP.BASTORE || st === cf.OP.CASTORE)) {
          arr.vals[idx] = val;
          i += 3;
          continue;
        }
      }
      finished = arr;
      finishedAt = i;
      arr = null;
    }
    if (op >= cf.OP.INVOKEVIRTUAL && op <= cf.OP.INVOKEINTERFACE) {
      let ref;
      try {
        ref = pool.ref(dec.args[i]);
      } catch {
        continue;
      }
      const tok = `${ref.owner}.${ref.name}${ref.desc}`;
      tokens.push(tok);
      if (ref.owner === 'java/lang/Class' && ref.name === 'forName') reflect = true;
      if (ref.owner === 'java/net/URLClassLoader') urlLoader = true;
      if (finished && i - finishedAt <= 2 && ref.owner === 'java/lang/String' && ref.name === '<init>' && /^\(\[[BC]/.test(ref.desc)) {
        const text = arrayText(finished);
        if (text) {
          hidden++;
          if (/java\.net\.URLClassLoader/.test(text)) urlLoader = true;
          ctx.addString(text, where, true);
        }
        finished = null;
      }
    }
  }
  const stage0 = tokens.filter((t) => t === 'java/lang/String.<init>([B)V').length >= 2 && matchSequence(tokens, S.SIG_STAGE0);
  const stage0b = matchSequence(tokens, S.SIG_STAGE0B);
  return { stage0, stage0b, hidden, reflect, urlLoader };
}

function arrayText(a) {
  const vals = a.vals;
  if (vals.length < 3 || vals.length > 4096) return null;
  let s = '';
  let printable = 0;
  if (a.type === 'B') {
    const buf = Buffer.alloc(vals.length);
    for (let i = 0; i < vals.length; i++) buf[i] = (vals[i] ?? 0) & 0xff;
    s = buf.toString('utf8');
  } else {
    for (let i = 0; i < vals.length; i++) s += String.fromCharCode((vals[i] ?? 0) & 0xffff);
  }
  for (const ch of s) if (ch >= ' ' && ch <= '~') printable++;
  return printable / s.length >= 0.85 ? s : null;
}

function looksSensitive(text) {
  return S.URL_ANY.test(text) || /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(text) || /java\.(net|lang\.Runtime|lang\.ProcessBuilder)|URLClassLoader|defineClass|appdata|local storage|leveldb|\.minecraft|launcher_accounts|user\.home/i.test(text);
}

// ---------- Recursos (no clases) ----------

function scanText(text, where, ctx) {
  if (!S.QUICK.test(text)) return;
  for (const line of text.split(/\r?\n/)) {
    if (line.length > 20000) {
      for (const m of line.matchAll(/[A-Za-z0-9+/]{120,}={0,2}/g)) ctx.addString(m[0], where, false);
      continue;
    }
    const t = line.trim();
    if (t.length >= 4 && S.QUICK.test(t)) ctx.addString(t.slice(0, 2000), where, false);
  }
}

function scanNative(buf, where, ctx) {
  ctx.natives.push(where);
  for (const ioc of NATIVE_IOCS) if (buf.indexOf(ioc) >= 0) ctx.addString(ioc, where, true);
}

// ---------- Jar ----------

async function walkJar(buf, prefix, depth, ctx, signal) {
  const jar = openJar(buf);
  for (const e of jar.entries) {
    await ctx.maybeYield(signal);
    const where = (name) => (prefix ? `${prefix}!/${name}` : name);
    if (e.name.endsWith('.class')) {
      const data = jar.read(e, MAX_CLASS);
      if (!data) continue;
      const cls = e.name.replace(/^META-INF\/versions\/\d+\//, '');
      if (S.IOC_PACKAGES.some((p) => cls.startsWith(p))) ctx.iocPackages.push(where(dotted(cls)));
      analyzeClass(data, where(dotted(cls)), ctx);
    } else if (/\.jar$/i.test(e.name)) {
      if (depth >= MAX_DEPTH) continue;
      const data = jar.read(e, MAX_NESTED);
      if (!data) {
        ctx.nestedUnreadable.push(where(e.name));
        continue;
      }
      ctx.nested++;
      const known = S.KNOWN_SHA1.get(sha(data, 'sha1'));
      if (known) ctx.add('known-malware', 'critical', [{ where: where(e.name), value: known }], { confirmed: true, vars: { name: known } });
      try {
        await walkJar(data, where(e.name), depth + 1, ctx, signal);
      } catch (err) {
        if (signal?.aborted) throw err;
        ctx.nestedUnreadable.push(where(e.name));
      }
    } else if (NATIVE_EXT.test(e.name)) {
      const data = jar.read(e, MAX_NESTED);
      if (data) scanNative(data, where(e.name), ctx);
      else ctx.natives.push(where(e.name));
    } else if (TEXT_EXT.test(e.name) && (SCRIPT_EXT.test(e.name) || !/^(assets|data)\//.test(e.name)) && e.size <= MAX_TEXT) {
      const text = jar.text(e, MAX_TEXT);
      if (text) scanText(text, where(e.name), ctx);
    }
  }
  return jar;
}

// ---------- Reglas ----------

function evaluate(ctx) {
  const strings = [...ctx.strings.entries()].map(([s, info]) => ({ s, norm: s.toLowerCase().replace(/\\/g, '/'), ...info }));
  const net = (where) => Boolean((ctx.classFlags.get(where) || 0) & S.F.NET);
  const risky = (where) => Boolean((ctx.classFlags.get(where) || 0) & (S.F.NET | S.F.CLASSLOAD | S.F.EXEC));
  const apiEv = (flag) => ctx.firstApi.get(flag) || null;

  // Fractureiser / SkyRage: indicadores de compromiso
  for (const st of strings) {
    for (const ioc of S.IOC_STRINGS) {
      const hit = ioc.exact ? st.norm.trim() === ioc.s : st.norm.includes(ioc.s);
      if (!hit) continue;
      const confirmed = st.hidden || risky(st.where);
      ctx.add(ioc.family === 'skyrage' ? 'skyrage' : 'fractureiser-ioc', 'critical', [{ where: st.where, value: st.s }], { confirmed });
    }
  }
  if (ctx.iocPackages.length) {
    ctx.add('fractureiser-classes', 'critical', ctx.iocPackages.slice(0, MAX_EVIDENCE).map((w) => ({ where: w, value: w.split('!/').pop() })), { confirmed: true });
  }

  // Exfiltración: webhooks de Discord y bots de Telegram
  const exfil = [];
  for (const st of strings) {
    const wh = S.WEBHOOK_FULL.exec(st.s);
    if (wh) {
      ctx.add('discord-webhook', 'high', [{ where: st.where, value: wh[0] }]);
      exfil.push({ where: st.where, value: wh[0] });
      continue;
    }
    const tg = S.TELEGRAM_FULL.exec(st.s);
    if (tg) {
      ctx.add('telegram-bot', 'high', [{ where: st.where, value: tg[0] }]);
      exfil.push({ where: st.where, value: tg[0] });
      continue;
    }
    if (S.WEBHOOK_ANY.test(st.s) || S.TELEGRAM_ANY.test(st.s)) exfil.push({ where: st.where, value: st.s, generic: true });
    else if (S.PASTE_SITES.test(st.s) || S.FILE_DROPS.test(st.s) || S.IP_LOOKUP.test(st.s)) exfil.push({ where: st.where, value: st.s, weak: true });
  }

  // Credenciales: rutas de Discord, navegadores, cuentas de launchers y billeteras
  const credentials = [];
  for (const st of strings) {
    if (S.DISCORD_TOKEN_REGEX.test(st.s)) credentials.push({ where: st.where, value: st.s, kind: 'discord' });
    for (const p of S.CREDENTIAL_PATHS) if (p.re.test(st.norm)) credentials.push({ where: st.where, value: st.s, kind: p.kind });
  }
  if (credentials.length) {
    const kinds = [...new Set(credentials.map((c) => c.kind))];
    if (ctx.flags & S.F.NET) {
      ctx.add('credential-stealer', 'high', [...credentials, apiEv(S.F.NET)], { vars: { kinds } });
    } else {
      ctx.add('credential-paths', 'medium', credentials, { vars: { kinds } });
    }
  }

  // Token de sesión de Minecraft
  if (ctx.flags & S.F.SESSION) {
    const ev = apiEv(S.F.SESSION);
    const strong = exfil.filter((e) => !e.weak);
    if (strong.length || (exfil.length && credentials.length)) ctx.add('session-exfil', 'high', [ev, ...exfil]);
    else if (net(ev.where)) ctx.add('session-network', 'medium', [ev, apiEv(S.F.NET)]);
  }

  const generic = exfil.filter((e) => e.generic);
  if (generic.length && !ctx.findings.some((f) => f.rule === 'discord-webhook' || f.rule === 'telegram-bot' || f.rule === 'session-exfil')) {
    ctx.add('webhook-generic', 'info', generic);
  }

  // Código descargado y ejecutado en tiempo real
  for (const [where, flags] of ctx.classFlags) {
    if (!(flags & S.F.CLASSLOAD)) continue;
    const urls = strings.filter((st) => st.where === where && /^https?:\/\//i.test(st.s.trim()));
    if ((flags & S.F.URLCL && (urls.length || flags & S.F.NET)) || (!(flags & S.F.URLCL) && flags & S.F.NET)) {
      ctx.add('remote-code', 'medium', [{ where, value: (urls[0] && urls[0].s) || apiEv(S.F.CLASSLOAD)?.value || '' }]);
    }
  }

  // Ejecución de programas
  if (ctx.flags & S.F.EXEC) {
    let strong = false;
    for (const [where, flags] of ctx.classFlags) {
      if (flags & S.F.EXEC && flags & (S.F.NET | S.F.B64)) {
        ctx.add('exec-download', 'medium', [{ where, value: apiEv(S.F.EXEC)?.value || 'Runtime.exec' }]);
        strong = true;
      }
    }
    if (!strong) ctx.add('exec', 'info', [apiEv(S.F.EXEC)]);
  }

  // Cargas útiles escondidas en base64
  const payloads = ctx.b64.filter((b) => b.kind !== 'url');
  if (payloads.length) ctx.add('hidden-payload', 'medium', payloads.map((b) => ({ where: b.where, value: `${b.kind}: ${b.sample}…` })), { vars: { kinds: [...new Set(payloads.map((b) => b.kind))] } });
  const hiddenUrls = [...ctx.b64.filter((b) => b.kind === 'url').map((b) => ({ where: b.where, value: b.sample }))];
  for (const st of strings) if (st.hidden && looksSensitive(st.s)) hiddenUrls.push({ where: st.where, value: st.s });
  if (hiddenUrls.length && !ctx.findings.some((f) => f.severity === 'critical' && f.confirmed)) ctx.add('hidden-strings', 'medium', hiddenUrls);

  // Instrucciones bajadas de sitios de pegado e IPs sueltas
  if (ctx.flags & S.F.NET) {
    const paste = strings.filter((st) => S.PASTE_SITES.test(st.s));
    if (paste.length) ctx.add('paste-fetch', 'medium', paste.map((st) => ({ where: st.where, value: st.s })));
    const ips = [];
    for (const st of strings) {
      const ip = S.publicIpUrl(st.s);
      if (ip && !S.IOC_STRINGS.some((i) => ip.includes(i.s))) ips.push({ where: st.where, value: ip });
    }
    if (ips.length) ctx.add('ip-url', 'medium', ips);
  }

  // Ofuscación fuerte
  const marks = strings.filter((st) => S.OBF_MARKS.test(st.s));
  const ratio = ctx.parsed ? ctx.obf / ctx.parsed : 0;
  if (marks.length || (ctx.parsed >= 20 && ratio >= 0.5)) {
    ctx.add('obfuscated', 'info', [...marks.map((st) => ({ where: st.where, value: st.s })), ...ctx.obfSample.map((w) => ({ where: w, value: w.split('.').pop() }))], {
      vars: { percent: Math.round(ratio * 100) },
    });
  }

  if (ctx.natives.length) ctx.add('native-code', 'info', ctx.natives.map((w) => ({ where: w, value: w.split('/').pop() })), { vars: { count: ctx.natives.length } });
  if (ctx.malformed.length || ctx.nestedUnreadable.length) {
    ctx.add('malformed', 'info', [...ctx.malformed, ...ctx.nestedUnreadable].map((w) => ({ where: w, value: w.split('!/').pop() })), {
      vars: { count: ctx.malformed.length + ctx.nestedUnreadable.length },
    });
  }

  // Lo más grave primero; entre iguales, la regla más descriptiva (la etapa 0 explica mejor que el método inyectado).
  const order = (f) => SEVERITY_RANK[f.severity] * 100 + (f.confirmed ? 50 : 0) + (RULE_ORDER[f.rule] || 0);
  return ctx.findings.sort((a, b) => order(b) - order(a));
}

/**
 * Analiza un jar ya leído. Devuelve:
 * { v, meta: { loader, id, name, version }, findings: [{ rule, severity, confirmed, evidence, vars }],
 *   stats: { classes, parsed, malformed, nested, natives, ms }, error? }
 * Los hallazgos de hash (Fractureiser conocido) también se incluyen.
 */
async function analyzeJar(buf, { signal, hashes } = {}) {
  const started = Date.now();
  const ctx = new Context();
  const sha1 = hashes?.sha1 || sha(buf, 'sha1');
  const sha256 = hashes?.sha256 || sha(buf, 'sha256');
  const known = S.KNOWN_SHA1.get(sha1) || S.KNOWN_SHA256.get(sha256);
  if (known) ctx.add('known-malware', 'critical', [{ where: 'SHA-1', value: sha1 }], { confirmed: true, vars: { name: known } });
  let meta = { loader: null, id: '', name: '', version: '' };
  let error = null;
  try {
    const jar = await walkJar(buf, '', 0, ctx, signal);
    try {
      const d = describe(jar);
      meta = { loader: d.loader, id: d.id, name: d.name, version: d.version };
    } catch {
      /* sin metadatos */
    }
  } catch (err) {
    if (signal?.aborted) throw err;
    error = err?.code || 'corrupt';
    ctx.add('unreadable', 'info', [{ where: 'zip', value: err?.message || String(err) }]);
  }
  const findings = evaluate(ctx);
  return {
    v: RULES_VERSION,
    meta,
    findings,
    stats: { classes: ctx.classCount, parsed: ctx.parsed, malformed: ctx.malformed.length, nested: ctx.nested, natives: ctx.natives.length, ms: Date.now() - started },
    error,
  };
}

function worstSeverity(findings) {
  let best = null;
  for (const f of findings || []) if (!best || SEVERITY_RANK[f.severity] > SEVERITY_RANK[best]) best = f.severity;
  return best;
}

module.exports = { analyzeJar, worstSeverity, matchSequence, obfuscatedName, RULES_VERSION, SEVERITY_RANK };
