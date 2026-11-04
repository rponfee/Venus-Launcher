// Genera gen/tables/btree*.js desde tables/btree*.h de cubiomes (solo hay que correrlo si se actualiza cubiomes).
// Uso: node gen-tables.js <carpeta de cubiomes>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '..', '..', 'gen', 'tables');
const src = process.argv[2];
if (!src) throw new Error('falta la carpeta de cubiomes');
fs.mkdirSync(out, { recursive: true });

for (const name of ['btree18', 'btree192', 'btree19', 'btree20', 'btree21wd']) {
  const text = fs.readFileSync(path.join(src, 'tables', `${name}.h`), 'utf8').replace(/\/\/.*$/gm, '');
  const order = Number(text.match(new RegExp(`${name}_order = (\\d+)`))[1]);
  const steps = text.match(new RegExp(`${name}_steps\\[\\] = \\{([^}]*)\\}`))[1].split(',').map((s) => Number(s.trim())).filter((s, i, a) => i < a.length && !Number.isNaN(s));
  const paramBody = text.slice(text.indexOf(`${name}_param`), text.indexOf(`${name}_nodes`));
  const pairs = [...paramBody.matchAll(/\{\s*(-?\d+)\s*,\s*(-?\d+)\s*\}/g)].map((m) => [Number(m[1]), Number(m[2])]);
  const nodesBody = text.slice(text.indexOf(`${name}_nodes`));
  // Cada nodo se escribe con la macro o el literal de 64 bits del encabezado
  const nodes = [...nodesBody.matchAll(/0x([0-9a-fA-F]+)/g)].map((m) => BigInt(`0x${m[1]}`));
  const param = Buffer.alloc(pairs.length * 4);
  pairs.forEach(([a, b], i) => {
    param.writeInt16LE(a, i * 4);
    param.writeInt16LE(b, i * 4 + 2);
  });
  const nodeBuf = Buffer.alloc(nodes.length * 8);
  nodes.forEach((v, i) => nodeBuf.writeBigUInt64LE(v, i * 8));
  const js =
    `// Generado por test/reference/gen-tables.js desde tables/${name}.h de cubiomes (MIT, ver ../LICENSE-cubiomes.txt). No editar.\n` +
    `export default {\n  order: ${order},\n  steps: [${steps.join(', ')}],\n  param: '${param.toString('base64')}',\n  nodes: '${nodeBuf.toString('base64')}',\n};\n`;
  fs.writeFileSync(path.join(out, `${name}.js`), js);
  console.log(name, 'orden', order, 'pasos', steps.join(','), 'parametros', pairs.length, 'nodos', nodes.length, 'archivo', js.length, 'bytes');
}
