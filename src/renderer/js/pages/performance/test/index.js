// Punto de entrada para `node --test "src/renderer/js/pages/performance/test/"` (como pages/tools/test/index.js).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
for (const name of fs.readdirSync(dir).sort()) {
  if (name.endsWith('.test.js')) await import(pathToFileURL(path.join(dir, name)).href);
}
