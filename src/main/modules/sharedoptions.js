'use strict';
// Ajustes compartidos entre instancias: un perfil maestro (data/sharedoptions.json) con grupos de options.txt que se
// guarda desde una instancia y se escribe en las que lo tengan prendido (sharedOptions: true en venus-instance.json)
// justo antes de lanzar. Con syncBack, al cerrar el juego se vuelve a leer ese options.txt para que un cambio hecho
// en el juego llegue al perfil. Nunca se escribe un options.txt con el juego corriendo. Lógica en ./sharedoptions/logic.js.
// Canales:
//   sharedoptions:get(instanceId?)        -> { profile: resumen, instance: { enabled, format, hasOptions, running } }
//   sharedoptions:saveFrom(instanceId)    -> resumen (guarda el perfil desde el options.txt de esa instancia)
//   sharedoptions:setPrefs({ groups?, syncBack? }) -> resumen
// Errores con err.code (la interfaz los traduce): noOptions, running.
const fsp = require('fs/promises');
const path = require('path');
const paths = require('../core/paths');
const game = require('../core/game');
const instances = require('../core/instances');
const { readJson, writeJson } = require('../core/util');
const safety = require('./packs/safety');
const logic = require('./sharedoptions/logic');

const FILE = 'sharedoptions.json';
const BACKUP = path.join('.venus', 'sharedoptions-backup.txt');

function codeError(code) {
  return Object.assign(new Error(code), { code });
}

const profilePath = () => paths.data(FILE);

async function readProfile() {
  return logic.normalizeProfile(await readJson(profilePath(), null));
}

// Una escritura por vez: leer, cambiar y guardar el perfil no se pisa con otro cierre de juego.
let chain = Promise.resolve();
function changeProfile(fn) {
  const run = chain.then(async () => {
    const next = await fn(await readProfile());
    if (next) await writeJson(profilePath(), next);
    return next;
  });
  chain = run.catch(() => {});
  return run;
}

async function readDoc(dir) {
  const text = await fsp.readFile(path.join(dir, 'options.txt'), 'utf8').catch(() => null);
  if (text === null) return { exists: false, doc: { eol: process.platform === 'win32' ? '\r\n' : '\n', entries: [] } };
  return { exists: true, text, doc: logic.parse(text) };
}

// Escribe el perfil en el options.txt de una instancia. Quien llama asegura que el juego no esté corriendo.
async function applyToDir(dir, profile, { mcVersion, loader } = {}) {
  const { exists, text, doc } = await readDoc(dir);
  const res = logic.applyTo(doc, profile, { mcVersion, loader });
  if (!res.changed.length) return { changed: [], blocked: res.blocked, written: false };
  if (exists) await safety.writeFileAtomic(path.join(dir, BACKUP), text, 'utf8').catch(() => {});
  await safety.writeFileAtomic(path.join(dir, 'options.txt'), logic.serialize(res.doc), 'utf8');
  return { changed: res.changed, blocked: res.blocked, written: true };
}

// Chequeo antes de jugar: corre con la partida en 'preparing', antes de abrir el juego.
async function beforeLaunch({ id, instance, quiet }) {
  if (quiet || instance?.sharedOptions !== true) return null;
  if (game.status()[id]?.state === 'running') return null;
  const profile = await readProfile();
  if (!profile.updatedAt) return null;
  try {
    const res = await applyToDir(instance.dir || instances.dir(id), profile, { mcVersion: instance.mcVersion, loader: instance.loader });
    if (res.blocked && res.blocked !== 'emptyFormat') console.warn(`[sharedoptions] ${id}: teclas sin escribir (${res.blocked})`);
  } catch (err) {
    console.warn('[sharedoptions] no se pudo escribir options.txt:', err?.message || err);
  }
  return null;
}

// El juego se cerró: si el interruptor está prendido, lo que cambió en el juego vuelve al perfil. Solo lee la instancia.
async function afterSession(session) {
  if (!session?.instanceId || session.quiet || session.crashed) return;
  const inst = await instances.get(session.instanceId).catch(() => null);
  if (inst?.sharedOptions !== true) return;
  const { exists, doc } = await readDoc(inst.dir);
  if (!exists) return;
  const data = logic.extract(doc, { mcVersion: inst.mcVersion });
  await changeProfile((profile) => {
    if (!profile.syncBack || !profile.updatedAt) return null;
    const { profile: next, changed } = logic.mergeBack(profile, data);
    return changed.length ? next : null;
  });
}

async function status(instanceId) {
  const profile = logic.summarize(await readProfile());
  if (typeof instanceId !== 'string' || !instanceId) return { profile, instance: null };
  const inst = await instances.get(instanceId);
  const { exists, doc } = await readDoc(inst.dir);
  return { profile, instance: { enabled: inst.sharedOptions === true, format: logic.effectiveFormat(inst.mcVersion, doc), hasOptions: exists, running: Boolean(game.status()[instanceId]) } };
}

async function saveFromInstance(instanceId) {
  const inst = await instances.get(instanceId);
  const { exists, doc } = await readDoc(inst.dir);
  if (!exists) throw codeError('noOptions');
  const data = logic.extract(doc, { mcVersion: inst.mcVersion });
  const next = await changeProfile((profile) => logic.saveFrom(profile, data, { source: { id: inst.id, name: inst.name, mcVersion: inst.mcVersion } }));
  return logic.summarize(next);
}

async function setPrefs(prefs) {
  const p = prefs && typeof prefs === 'object' ? prefs : {};
  const next = await changeProfile((profile) => {
    const out = { ...profile, groups: { ...profile.groups } };
    for (const id of logic.GROUP_IDS) if (typeof p.groups?.[id] === 'boolean') out.groups[id] = p.groups[id];
    if (typeof p.syncBack === 'boolean') out.syncBack = p.syncBack;
    return out;
  });
  return logic.summarize(next);
}

function register({ handle }) {
  handle('sharedoptions:get', status);
  handle('sharedoptions:saveFrom', saveFromInstance);
  handle('sharedoptions:setPrefs', setPrefs);

  game.addBeforeLaunch(beforeLaunch);
  game.events.on('session', (session) => {
    afterSession(session).catch((err) => console.warn('[sharedoptions] al cerrar el juego:', err?.message || err));
  });
}

module.exports = { register, beforeLaunch, afterSession, applyToDir, readProfile, saveFromInstance, setPrefs, status };
