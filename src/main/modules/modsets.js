'use strict';
// Sets de mods por instancia: conjuntos con nombre (plantillas "PvP", "Shaders" y "Liviano" que el usuario completa)
// que recuerdan qué mods quedan activos. Se guardan en <instancia>/.venus/modsets.json. Aplicar uno renombra
// .jar y .jar.disabled, con una instantánea antes (módulo snapshots) para poder deshacer, y nunca con el juego
// corriendo ni durante la búsqueda del culpable de un crash. Lógica en ./modsets/logic.js.
// Canales:
//   modsets:list(id)                    -> { sets, lastApply, files: [{ file, name, enabled, title, project }], running }
//   modsets:template(id, templateId)    -> entradas iniciales de la plantilla con los mods de la instancia
//   modsets:save(id, set)               -> { set, sets } (set = { id?, name, template?, entries: [{ file, on }] })
//   modsets:remove(id, setId)           -> { sets }
//   modsets:check(id, entries)          -> [{ file, title, dep, provider, providerTitle }] dependencias que quedan afuera
//   modsets:apply(id, setId, { reason })-> { enabled, disabled, unknown, missing, conflicts, snapshotId, name }
//   modsets:undo(id)                    -> resultado de snapshots.restore (vuelve a como estaba antes de aplicar)
// Errores con err.code (la interfaz los traduce): badName, tooMany, notFound, alreadyRunning, instanceBusy, bisect,
// snapshotFailed, noUndo, locked.
const fsp = require('fs/promises');
const path = require('path');
const game = require('../core/game');
const instances = require('../core/instances');
const { readJson, writeJson } = require('../core/util');
const logic = require('./modsets/logic');

const STORE = path.join('.venus', 'modsets.json');
const FOLDER = 'mods';

function codeError(code) {
  return Object.assign(new Error(code), { code });
}

const storePath = (dir) => path.join(dir, STORE);
const readStore = async (dir) => logic.normalizeStore(await readJson(storePath(dir), null));
const writeStore = (dir, store) => writeJson(storePath(dir), store);

// Una operación por instancia: dos clics no se pisan.
const chains = new Map();
function withLock(id, fn) {
  const next = (chains.get(id) || Promise.resolve()).catch(() => {}).then(fn);
  const tail = next.catch(() => {});
  chains.set(id, tail);
  tail.then(() => {
    if (chains.get(id) === tail) chains.delete(id);
  });
  return next;
}

// Mods de la carpeta con su identidad (registros de Modrinth y CurseForge de la instancia).
async function listMods(inst) {
  const dir = path.join(inst.dir, FOLDER);
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  const records = { modrinth: inst.modrinth?.projects, curseforge: inst.curseforge?.projects };
  const titleOf = (name) => {
    for (const projects of Object.values(records)) for (const rec of Object.values(projects || {})) if (logic.baseName(rec?.file) === name && rec?.title) return rec.title;
    return null;
  };
  const out = [];
  for (const e of entries) {
    if (!e.isFile() || !logic.validFileName(e.name)) continue;
    const name = logic.baseName(e.name);
    out.push({ file: e.name, name, enabled: name === e.name, title: titleOf(name), project: logic.projectOf(records, name) });
  }
  return out.sort((a, b) => (a.title || a.name).localeCompare(b.title || b.name));
}

// Completa la identidad de cada entrada al guardar: si después el mod se actualiza, el set lo sigue reconociendo.
function withProjects(entries, files) {
  const byName = new Map(files.map((f) => [f.name.toLowerCase(), f.project]));
  return logic.normalizeEntries(entries).map((e) => ({ ...e, project: e.project || byName.get(e.file.toLowerCase()) || null }));
}

function assertFree(id) {
  require('./crash').assertNotBisecting(id);
}

function lockedError(err) {
  if (err?.code === 'EPERM' || err?.code === 'EBUSY' || err?.code === 'EACCES') return Object.assign(new Error(err.failedFile || ''), { code: 'locked', cause: err }); // el mensaje es el archivo
  return err;
}

async function applySet(id, setId, { reason } = {}, deps = {}) {
  const snapshot = deps.snapshot || ((instanceId, opts) => require('./snapshots').create(instanceId, opts));
  return game.withStoppedInstance(id, async () => {
    assertFree(id);
    const inst = await instances.get(id);
    const store = await readStore(inst.dir);
    const set = store.sets.find((s) => s.id === setId);
    if (!set) throw codeError('notFound');
    const files = await listMods(inst);
    const plan = logic.planApply(set, files);
    let snapshotId = null;
    if (plan.renames.length) {
      try {
        const snap = await snapshot(id, { kind: 'auto', reason: typeof reason === 'string' ? reason.slice(0, 120) : set.name, worlds: 'none' });
        snapshotId = snap?.id || null;
      } catch (err) {
        console.warn('[modsets] instantánea:', err?.message || err);
      }
      if (!snapshotId) throw codeError('snapshotFailed');
      try {
        await logic.executeRenames(path.join(inst.dir, FOLDER), plan.renames);
      } catch (err) {
        throw lockedError(err);
      }
      store.lastApply = { setId: set.id, name: set.name, snapshotId, at: Date.now() };
      await writeStore(inst.dir, store);
    }
    return { name: set.name, enabled: plan.enable, disabled: plan.disable, unknown: plan.unknown, missing: plan.missing, conflicts: plan.conflicts, snapshotId };
  });
}

async function undoLast(id, deps = {}) {
  const restore = deps.restore || ((instanceId, snap, opts) => require('./snapshots').restore(instanceId, snap, opts));
  return game.withStoppedInstance(id, async () => {
    assertFree(id);
    const inst = await instances.get(id);
    const store = await readStore(inst.dir);
    if (!store.lastApply?.snapshotId) throw codeError('noUndo');
    const result = await restore(id, store.lastApply.snapshotId, { worlds: 'none' });
    store.lastApply = null;
    await writeStore(inst.dir, store);
    return result;
  });
}

function register({ handle, send }) {
  const changed = () => {
    try {
      send('instances:changed');
    } catch {
      /* ventana cerrada */
    }
  };

  handle('modsets:list', async (id) => {
    const inst = await instances.get(id);
    const store = await readStore(inst.dir);
    return { sets: store.sets, lastApply: store.lastApply, files: await listMods(inst), running: Boolean(game.status()[id]) };
  });
  handle('modsets:template', async (id, templateId) => {
    const inst = await instances.get(id);
    return logic.templateEntries(templateId, await listMods(inst));
  });
  handle('modsets:save', (id, raw) =>
    withLock(id, async () => {
      const inst = await instances.get(id);
      const store = await readStore(inst.dir);
      const current = store.sets.find((s) => s.id === raw?.id) || null;
      const set = logic.normalizeSet({ ...current, ...raw, id: current?.id || logic.newSetId(), entries: withProjects(raw?.entries, await listMods(inst)), createdAt: current?.createdAt, updatedAt: Date.now() });
      if (!set) throw codeError('badName');
      if (!current && store.sets.length >= logic.MAX_SETS) throw codeError('tooMany');
      store.sets = current ? store.sets.map((s) => (s.id === set.id ? set : s)) : [...store.sets, set];
      await writeStore(inst.dir, store);
      return { set, sets: store.sets };
    }),
  );
  handle('modsets:remove', (id, setId) =>
    withLock(id, async () => {
      const inst = await instances.get(id);
      const store = await readStore(inst.dir);
      store.sets = store.sets.filter((s) => s.id !== setId);
      await writeStore(inst.dir, store);
      return { sets: store.sets };
    }),
  );
  handle('modsets:check', async (id, entries) => {
    const inst = await instances.get(id);
    const inventory = require('./compat/inventory');
    const records = { ...(inst.modrinth?.projects || {}), ...(inst.curseforge?.projects || {}) };
    const inv = await inventory.scan({ dir: inst.dir, records, folders: [FOLDER] }, { folders: [FOLDER], identify: false, meta: true });
    inventory.flush().catch(() => {});
    const mods = inv.files.map((f) => ({ name: f.name, title: f.title || f.meta?.mods?.[0]?.name || f.name, mods: f.meta?.mods || [] }));
    const active = logic.activeAfter(logic.normalizeEntries(entries), await listMods(inst));
    return logic.missingDependencies(mods, active);
  });
  handle('modsets:apply', (id, setId, opts) =>
    withLock(id, async () => {
      const res = await applySet(id, setId, opts && typeof opts === 'object' ? opts : {});
      changed();
      return res;
    }),
  );
  handle('modsets:undo', (id) =>
    withLock(id, async () => {
      const res = await undoLast(id);
      changed();
      return res;
    }),
  );
}

module.exports = { register, applySet, undoLast, listMods };
