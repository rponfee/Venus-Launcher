'use strict';
// Punto de entrada para `node --test "web/app/test/"`: Node toma la carpeta como un módulo y carga este archivo, que suma todas
// las pruebas de la carpeta (igual que las de src/renderer/js/social/test/).
const fs = require('fs');
const path = require('path');

for (const name of fs.readdirSync(__dirname).sort()) {
  if (name.endsWith('.test.js')) require(path.join(__dirname, name));
}
