// Punto de entrada para `node --test "src/renderer/js/features/playcare/test/"`: Node toma la carpeta como un modulo y
// carga este archivo, que suma todas las pruebas de la carpeta (modulos ES, como las de features/themes/test).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
for (const name of fs.readdirSync(dir).sort()) {
  if (name.endsWith('.test.js')) await import(pathToFileURL(path.join(dir, name)).href);
}
