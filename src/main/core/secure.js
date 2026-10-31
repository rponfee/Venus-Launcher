'use strict';
// Almacen cifrado para tokens y claves (DPAPI en Windows, Keychain en macOS, libsecret en Linux).
// Nunca guardar secretos en settings.json: usar secure.get/set con una clave propia del modulo.
const paths = require('./paths');
const { readJson, writeJson } = require('./util');

let cipher = {
  encrypt: (s) => `raw:${Buffer.from(s).toString('base64')}`,
  decrypt: (s) => (s.startsWith('raw:') ? Buffer.from(s.slice(4), 'base64').toString() : s),
};

function configure(c) {
  cipher = c;
}

const FILE = () => paths.data('secure.json');
let cache = null;
let queue = Promise.resolve();

async function load() {
  if (!cache) cache = await readJson(FILE(), {});
  return cache;
}

async function get(key) {
  const data = await load();
  const raw = data[key];
  if (raw === undefined || raw === null) return null;
  try {
    return JSON.parse(cipher.decrypt(raw));
  } catch {
    return null;
  }
}

// Las escrituras van en cola. Si una falla (archivo tomado por un antivirus, por ejemplo), la cola sigue:
// el cambio ya quedo en memoria y se guarda con la escritura siguiente.
function set(key, value) {
  const run = queue.then(async () => {
    const data = await load();
    if (value === null || value === undefined) delete data[key];
    else data[key] = cipher.encrypt(JSON.stringify(value));
    await writeJson(FILE(), data);
  });
  queue = run.catch(() => {});
  return run;
}

function remove(key) {
  return set(key, null);
}

async function has(key) {
  return (await get(key)) !== null;
}

module.exports = { configure, get, set, remove, has };
