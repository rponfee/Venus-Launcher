// Mete las traducciones de .tr/done-<idioma>.json en los archivos de idioma. Valida variables y que no falte nada.
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const TR = path.join(ROOT, '.tr');
const kinds = { renderer: 'src/renderer/i18n', main: 'src/main/i18n' };
const vars = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
const problems = [];
for (const file of fs.readdirSync(TR).filter((f) => /^done-/.test(f))) {
  const lang = file.slice(5, -5);
  const need = JSON.parse(fs.readFileSync(path.join(TR, `need-${lang}.json`), 'utf8'));
  const done = JSON.parse(fs.readFileSync(path.join(TR, file), 'utf8'));
  let added = 0;
  for (const [group, keys] of Object.entries(need)) {
    const [kind, ns] = group.split('/');
    const target = path.join(ROOT, kinds[kind], lang, `${ns}.js`);
    const given = done[group] || {};
    const lines = [];
    let src = null;
    if (fs.existsSync(target)) src = fs.readFileSync(target, 'utf8');
    const crlf = src?.includes('\r\n');
    if (src) src = src.replace(/\r\n/g, '\n');
    for (const [k, info] of Object.entries(keys)) {
      const v = given[k];
      if (typeof v !== 'string' || !v.trim()) {
        problems.push(`${lang} ${group}.${k}: falta`);
        continue;
      }
      if (vars(v) !== vars(info.en)) {
        problems.push(`${lang} ${group}.${k}: variables ${vars(v)} != ${vars(info.en)}`);
        continue;
      }
      const line = `  ${k}: ${JSON.stringify(v)},`;
      const re = new RegExp(`^  ${k}: .*$`, 'm');
      if (src && re.test(src)) src = src.replace(re, () => line);
      else lines.push(line);
      added++;
    }
    if (src === null) {
      const head = kind === 'renderer' ? 'export default {' : "'use strict';\nmodule.exports = {";
      src = `${head}\n${lines.join('\n')}\n};\n`;
    } else if (lines.length) {
      const end = src.lastIndexOf('};');
      src = `${src.slice(0, end).replace(/\s*$/, '\n')}${lines.join('\n')}\n${src.slice(end)}`;
    }
    fs.writeFileSync(target, crlf ? src.replace(/\n/g, '\r\n') : src);
  }
  console.log(lang, added);
}
console.log(problems.length ? problems.slice(0, 60).join('\n') : 'sin problemas');
console.log('problemas:', problems.length);
