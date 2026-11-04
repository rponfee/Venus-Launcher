// Arma golden.json desde la salida de harness.c: unas pocas semillas, con las listas largas resumidas en un hash.
// Uso: node make-golden.js <salida-del-harness.jsonl> <semillas> <referencias.jsonl>
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { listHash } from './cases.js';

const [file, seedCount, refsFile] = process.argv.slice(2);
const max = Number(seedCount) || 4;
const seeds = [];
const cases = [];
const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
for await (const raw of rl) {
  if (!raw.trim()) continue;
  const c = JSON.parse(raw);
  if (c.seed !== undefined && !seeds.includes(c.seed)) {
    if (seeds.length >= max) break;
    seeds.push(c.seed);
  }
  if (c.k === 'struct') {
    const n = c.list.length;
    const hash = listHash(c.list.map((e) => [e[0], e[1], e[2], e[3], e[4], e[5] ? 1 : 0]));
    delete c.list;
    cases.push({ ...c, n, listHash: hash });
  } else if (c.k === 'strong') {
    // Las 128 fortalezas tardan: en la prueba de siempre, todas en dos versiones de una semilla y tres en el resto
    const all = c.seed === seeds[0] && (c.mc === '1.21.4' || c.mc === '1.19.2');
    const list = c.list.slice(0, all ? 128 : 3);
    cases.push({ k: 'strong', mc: c.mc, seed: c.seed, count: list.length, listHash: listHash(list) });
  } else {
    cases.push(c);
  }
}
const refs = fs.readFileSync(refsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const out = {
  source: 'cubiomes e61f90580cbdd883214a8054670dacae655e59c0 (MIT), compilado sin cambios a WebAssembly con Emscripten 3.1.39 -O2 -fwrapv junto con harness.c. Ver build.txt.',
  refs,
  seeds,
  cases,
};
const dest = path.join(path.dirname(fileURLToPath(import.meta.url)), 'golden.json');
fs.writeFileSync(dest, `${JSON.stringify(out).replace(/\},\{/g, '},\n{')}\n`);
console.log('casos', cases.length, 'semillas', seeds.length, 'bytes', fs.statSync(dest).size);
