// Aplica solo traducciones completas y con variables válidas. Uso: node scripts/tr-merge.js [pt fr ...]
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const TR = path.join(ROOT, '.tr');
const kinds = { renderer: 'src/renderer/i18n', main: 'src/main/i18n' };
const supported = new Set(['pt', 'fr', 'de', 'it', 'nl', 'pl', 'ru', 'uk', 'tr', 'ja', 'ko', 'zh']);
const vars = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
const PLURAL = /_(zero|one|two|few|many|other)$/;
const chosen = process.argv.slice(2);
const langs = chosen.length ? [...new Set(chosen)] : fs.readdirSync(TR).filter((f) => /^done-[a-z]{2}\.json$/.test(f)).map((f) => f.slice(5, -5));
const problems = [], writes = [], totals = {};
for (const lang of langs) {
  if (!supported.has(lang)) { problems.push(`${lang}: idioma desconocido`); continue; }
  let need, done;
  try {
    need = JSON.parse(fs.readFileSync(path.join(TR, `need-${lang}.json`), 'utf8').replace(/^\uFEFF/, ''));
    done = JSON.parse(fs.readFileSync(path.join(TR, `done-${lang}.json`), 'utf8').replace(/^\uFEFF/, ''));
  } catch (err) { problems.push(`${lang}: ${err.message}`); continue; }
  totals[lang] = 0;
  for (const [group, keys] of Object.entries(need)) {
    const [kind, ns] = group.split('/');
    if (!Object.hasOwn(kinds, kind) || !/^[a-z0-9_-]+$/i.test(ns)) { problems.push(`${lang}: grupo inválido ${group}`); continue; }
    const target = path.join(ROOT, kinds[kind], lang, `${ns}.js`);
    const reference = fs.readFileSync(path.join(ROOT, kinds[kind], 'en', `${ns}.js`), 'utf8');
    const raw = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
    const crlf = (raw ?? reference).includes('\r\n');
    let src = raw?.replace(/\r\n/g, '\n') ?? null;
    const lines = [];
    // Formas de plural que el inglés no tiene (few y many en ruso, ucraniano o polaco): se aceptan solo si acompañan a
    // un plural pedido, no existen en inglés (una clave que nadie pidió nunca pisa una traducción) y traen las mismas
    // variables que la forma pedida (la _other si está).
    const pluralInfo = new Map();
    for (const [key, info] of Object.entries(keys)) {
      if (!PLURAL.test(key)) continue;
      const base = key.replace(PLURAL, '');
      if (!pluralInfo.has(base) || key.endsWith('_other')) pluralInfo.set(base, info);
    }
    const inEnglish = (key) => new RegExp(`^  ${key}: `, 'm').test(reference);
    const extras = Object.keys(done[group] || {}).filter((key) => !(key in keys) && /^\w+$/.test(key) && PLURAL.test(key) && pluralInfo.has(key.replace(PLURAL, '')) && !inEnglish(key));
    const entries = [...Object.entries(keys), ...extras.map((key) => [key, pluralInfo.get(key.replace(PLURAL, ''))])];
    for (const [key, info] of entries) {
      const value = done[group]?.[key];
      if (typeof value !== 'string' || !value.trim()) { problems.push(`${lang} ${group}.${key}: falta`); continue; }
      if (vars(value) !== vars(info.en)) { problems.push(`${lang} ${group}.${key}: variables distintas`); continue; }
      if (!/^[\w-]+$/.test(key)) { problems.push(`${lang} ${group}.${key}: clave inválida`); continue; }
      const label = /^\w+$/.test(key) ? key : `'${key}'`;
      const line = `  ${label}: ${JSON.stringify(value)},`;
      const re = new RegExp(`^  ${label}: .*$`, 'm');
      if (src && re.test(src)) src = src.replace(re, () => line);
      else lines.push(line);
      totals[lang]++;
    }
    if (src === null) src = `${kind === 'renderer' ? 'export default {' : "'use strict';\nmodule.exports = {"}\n${lines.join('\n')}\n};\n`;
    else if (lines.length) {
      const end = src.lastIndexOf('};');
      if (end < 0) { problems.push(`${target}: sin cierre`); continue; }
      src = `${src.slice(0, end).replace(/\s*$/, '\n')}${lines.join('\n')}\n${src.slice(end)}`;
    }
    writes.push([target, crlf ? src.replace(/\n/g, '\r\n') : src]);
  }
}
if (problems.length) {
  console.error(problems.slice(0, 60).join('\n'));
  console.error(`problemas: ${problems.length}; no se modificó ningún idioma`);
  process.exit(1);
}
for (const [target, source] of writes) fs.writeFileSync(target, source);
console.log(totals);
console.log('sin problemas');
