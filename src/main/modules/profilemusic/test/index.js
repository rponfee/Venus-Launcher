'use strict';
// Punto de entrada para `node --test "src/main/modules/profilemusic/test/"` (como mcnews/test/index.js).
const fs = require('fs');
const path = require('path');

for (const name of fs.readdirSync(__dirname).sort()) {
  if (name.endsWith('.test.js')) require(path.join(__dirname, name));
}
