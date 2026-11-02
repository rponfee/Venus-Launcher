'use strict';
// Permite correr todas las pruebas pasando la carpeta: node --test "src/main/modules/nowplaying/test/"
// (Node 24 trata la carpeta como un módulo y carga este archivo). También anda con ".../test/*.test.js".
const fs = require('fs');
const path = require('path');

for (const name of fs.readdirSync(__dirname).filter((n) => n.endsWith('.test.js')).sort()) require(path.join(__dirname, name));
