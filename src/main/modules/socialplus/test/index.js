'use strict';
// Permite correr todas las pruebas con la carpeta: node --test "src/main/modules/socialplus/test/"
const fs = require('fs');
const path = require('path');

for (const f of fs.readdirSync(__dirname).filter((n) => n.endsWith('.test.js')).sort()) require(path.join(__dirname, f));
