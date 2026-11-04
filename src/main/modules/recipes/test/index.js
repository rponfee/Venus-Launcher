'use strict';
// Punto de entrada para `node --test "src/main/modules/recipes/test/"`.
const fs = require('fs');
const path = require('path');

for (const name of fs.readdirSync(__dirname).sort()) {
  if (name.endsWith('.test.js')) require(path.join(__dirname, name));
}
