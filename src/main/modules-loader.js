'use strict';
// Carga automatica de los modulos de funciones: cada archivo src/main/modules/*.js puede exportar
//   preReady(ctx)  -> se llama antes de app.whenReady (registrar protocolos, flags de Chromium)
//   register(ctx)  -> se llama al iniciar, con { app, handle, send, getWindow, safePath, onQuit }
// Los archivos auxiliares de un modulo van en una subcarpeta (src/main/modules/<modulo>/...) y no se autocargan.
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'modules');
let loaded = null;

function load() {
  if (loaded) return loaded;
  loaded = [];
  let files = [];
  try {
    files = fs
      .readdirSync(DIR, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith('.js'))
      .map((d) => d.name)
      .sort();
  } catch {
    files = [];
  }
  for (const file of files) {
    try {
      loaded.push({ name: file.slice(0, -3), mod: require(path.join(DIR, file)) });
    } catch (err) {
      console.error(`[modules] No se pudo cargar ${file}:`, err);
    }
  }
  return loaded;
}

function preReady(ctx) {
  for (const { name, mod } of load()) {
    if (typeof mod.preReady !== 'function') continue;
    try {
      mod.preReady(ctx);
    } catch (err) {
      console.error(`[modules] preReady ${name}:`, err);
    }
  }
}

async function register(ctx) {
  for (const { name, mod } of load()) {
    if (typeof mod.register !== 'function') continue;
    try {
      await mod.register(ctx);
    } catch (err) {
      console.error(`[modules] register ${name}:`, err);
    }
  }
}

module.exports = { load, preReady, register };
