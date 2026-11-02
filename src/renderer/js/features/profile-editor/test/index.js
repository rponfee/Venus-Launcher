'use strict';
// Punto de entrada para `node --test "src/renderer/js/features/profile-editor/test/"`: Node 24 toma la carpeta
// como un modulo y carga este archivo, que suma todas las pruebas de la carpeta. Tambien se pueden correr con
// `node --test "src/renderer/js/features/profile-editor/test/*.test.js"`.
const fs = require('fs');
const path = require('path');

for (const name of fs.readdirSync(__dirname).sort()) {
  if (name.endsWith('.test.js')) require(path.join(__dirname, name));
}
