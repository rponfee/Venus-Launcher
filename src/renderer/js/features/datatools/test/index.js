// Punto de entrada para `node --test "src/renderer/js/features/datatools/test/"` (como pages/tools/test/index.js).
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
for (const name of readdirSync(here).sort()) {
  if (name.endsWith('.test.js')) await import(pathToFileURL(join(here, name)).href);
}
