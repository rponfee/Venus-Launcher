'use strict';
// Permite correr todas las pruebas con la carpeta: node --test "src/main/modules/mcimport/test/"
// (Node toma la carpeta como modulo y carga este archivo, que suma cada *.test.js). Tambien andan los archivos
// sueltos: node --test "src/main/modules/mcimport/test/*.test.js"
const fs = require('fs');
const path = require('path');

for (const f of fs.readdirSync(__dirname).filter((n) => n.endsWith('.test.js')).sort()) require(path.join(__dirname, f));
