'use strict';
// Almacen en disco de la cache y del contador de pedidos de la musica de perfil: data/profilemusic.json.
// Solo guarda pistas ya validadas (policy.trackFromResult) y marcas de tiempo: nada de datos de la persona.
const { readJson, writeJson } = require('../../core/util');

function createDiskStore(file) {
  return {
    read: () => readJson(file, null),
    write: (state) => writeJson(file, state),
  };
}

module.exports = { createDiskStore };
