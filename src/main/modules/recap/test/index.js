'use strict';
// Permite correr todas las pruebas con la carpeta: node --test "src/main/modules/recap/test/"
// (Node 24 toma la carpeta como un modulo y carga este archivo, que suma cada *.test.js). Tambien andan los
// archivos sueltos: node --test "src/main/modules/recap/test/*.test.js"
const fs = require('fs');
const path = require('path');

for (const f of fs.readdirSync(__dirname).filter((n) => n.endsWith('.test.js')).sort()) require(path.join(__dirname, f));
