'use strict';
// Herramientas extra del asistente sobre instancias: RAM recomendada, duplicar y renombrar, instantaneas y mundos.
// Reutilizan los modulos que ya existen (perf/memory, core/instances, modules/snapshots, modules/worlds/backups):
// aca solo se validan los argumentos, se aplican las restricciones del dueño y se registra el Deshacer.
//   - Nunca se borra un mundo: backup_world solo crea una copia; restaurar una instantanea no toca los mundos.
//   - Todo ocurre dentro de la carpeta de la instancia (insideDir) o en las copias del propio launcher.
const os = require('os');
const path = require('path');
const instances = require('../../core/instances');
const settings = require('../../core/settings');
const { exists, dirSize } = require('../../core/util');
const { t } = require('../../core/i18n');
const memory = require('../perf/memory');
const worldBackups = require('../worlds/backups');
const serversTools = require('./tools-servers');
const { ToolError, assertBareFileName, insideDir } = require('./guards');

const MB = 1048576;
const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
const SNAP_ID = /^[\w.-]{1,80}$/;

let S = null;
const D = () => S.deps;

function snapshotsModule() {
  const m = D().optional('snapshots');
  if (!m || typeof m.create !== 'function') throw new ToolError(t('assistantx.errNoSnapshots'), 'snapshots');
  return m;
}

// Carpeta de un mundo de la instancia (con level.dat), sin salir de saves/.
async function existingWorld(inst, folder) {
  const name = assertBareFileName(String(folder ?? ''));
  const full = insideDir(inst.dir, 'saves', name);
  if (!(await exists(path.join(full, 'level.dat')))) throw new ToolError(t('assistantx.errNoWorld', { folder: name.slice(0, 80) }), 'world');
  return { name, full };
}

// ---------- RAM recomendada ----------
const recommendRam = {
  minLevel: 'read',
  async prepare(input) {
    const hasI = typeof input.instance_id === 'string' && input.instance_id.length > 0;
    const hasS = typeof input.server_id === 'string' && input.server_id.length > 0;
    if (hasI === hasS) throw new ToolError(t('assistantx.errRamTarget'), 'input');
    return hasI ? { inst: await S.getInstance(input.instance_id) } : { server: await serversTools.getServer(input.server_id) };
  },
  async run({ inst, server }) {
    const totalMb = Math.floor(os.totalmem() / MB);
    const freeMb = Math.floor(os.freemem() / MB);
    const { limit } = serversTools.ramLimit();
    const machine = { total_ram_mb: totalMb, free_ram_mb: freeMb, cpu_threads: os.cpus().length, max_allowed_mb: limit };
    if (server) {
      const adv = await serversTools.serverRamAdvice(server, { totalMb, freeMb });
      return {
        data: { target: 'server', server: { id: server.id, name: server.name, type: server.type, mc_version: server.mcVersion }, machine, current: { min_mb: server.memory?.min ?? null, max_mb: server.memory?.max ?? null }, ...adv, apply_with: `set_server_ram { server_id: "${server.id}", max_mb: ${adv.recommended.max_mb} }` },
        summary: t('assistantx.sumRecommendServer', { name: server.name, max: adv.recommended.max_mb }),
      };
    }
    const r = await memory.forInstance(inst, { totalMb, freeMb });
    const max = Math.min(r.max, limit);
    const s = await settings.get();
    const current = inst.memory?.override ? { mode: 'instance', min_mb: inst.memory.min, max_mb: inst.memory.max } : s.memoryMode === 'manual' ? { mode: 'global', max_mb: s.memory?.max } : { mode: 'auto', note: 'The launcher computes RAM automatically before each launch.' };
    const reasons = [`${r.modCount} mod(s)${r.isModpack ? ', modpack' : ''}${r.shaders ? ', shaders in use' : ''}: the instance asks for about ${r.need} MB.`];
    if (r.limited) reasons.push('This PC cannot give the instance everything it asks for; expect lower performance with that many mods.');
    if (r.lowFree) reasons.push(`Only about ${freeMb} MB of RAM are free right now: close other programs before playing.`);
    reasons.push('More RAM than needed does not add FPS and can make garbage-collection pauses longer.');
    return {
      data: {
        target: 'instance',
        instance: { id: inst.id, name: inst.name, mc_version: inst.mcVersion, loader: inst.loader },
        machine,
        content: { mods: r.modCount, modpack: r.isModpack, shaders: r.shaders },
        current,
        need_mb: r.need,
        recommended: { max_mb: max, min_mb: memory.deriveMin(max) },
        limited: r.limited,
        reasoning: reasons,
        apply_with: `set_ram { scope: "instance", instance_id: "${inst.id}", max_mb: ${max} }`,
      },
      summary: t('assistantx.sumRecommendInstance', { name: inst.name, max }),
    };
  },
};

// ---------- Duplicar y renombrar ----------
const duplicateInstance = {
  minLevel: 'reversible',
  async prepare(input) {
    const inst = await S.getInstance(input.instance_id);
    S.assertNotRunning(inst);
    const name = String(input.name ?? '').replace(/[\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
    return { scope: 'create', inst, name, worlds: input.include_worlds === true };
  },
  async run(p, ctx) {
    const copy = await instances.duplicate(p.inst.id, { name: p.name || undefined, worlds: p.worlds });
    ctx.action.entry.instanceId = copy.id;
    ctx.action.target('instance:create');
    ctx.action.op({ type: 'removeInstance', instanceId: copy.id });
    if (ctx.conv && !ctx.conv.createdInstances.includes(copy.id)) ctx.conv.createdInstances.push(copy.id);
    D().send('instances:changed');
    const worlds = await require('./undo').countWorlds(copy.dir);
    const warnings = worlds ? [t('assistantx.warnDuplicateWorlds', { count: worlds })] : [];
    return {
      data: { instance_id: copy.id, name: copy.name, source_id: p.inst.id, mc_version: copy.mcVersion, loader: copy.loader, worlds_copied: worlds, warnings },
      warnings,
      summary: t('assistantx.sumDuplicated', { name: p.inst.name, copy: copy.name }),
    };
  },
};

const renameInstance = {
  minLevel: 'reversible',
  async prepare(input) {
    const inst = await S.getInstance(input.instance_id);
    const name = String(input.name ?? '').replace(/[\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!name) throw new ToolError(t('assistantx.errEmptyName'), 'input');
    return { scope: 'instance', instanceId: inst.id, inst, name, skipFullSnapshot: true };
  },
  async run(p, ctx) {
    const { inst, name } = p;
    if (inst.name === name) return S.noChange(t('assistantx.sumRenameSame', { name }), { name });
    ctx.action.target('meta:name');
    ctx.action.op({ type: 'meta', fields: [{ path: 'name', had: true, value: inst.name }] });
    await instances.update(inst.id, { name });
    D().send('instances:changed');
    return { data: { instance_id: inst.id, before: inst.name, after: name }, summary: t('assistantx.sumRenamed', { from: inst.name, to: name }) };
  },
};

// ---------- Instantaneas ----------
const listSnapshots = {
  minLevel: 'read',
  async prepare(input) {
    return { inst: await S.getInstance(input.instance_id) };
  },
  async run({ inst }) {
    const snaps = snapshotsModule();
    const items = await snaps.list(inst.id);
    const out = items.slice(0, 60).map((x) => ({
      id: x.id,
      created: iso(x.createdAt),
      kind: x.kind,
      label: x.label || null,
      reason: x.reason || null,
      pinned: x.pinned,
      worlds_included: (x.worlds || []).length,
      files: x.stats?.files ?? null,
      size_mb: x.stats?.bytes ? Math.round((x.stats.bytes / MB) * 10) / 10 : null,
      game: x.instance ? `${x.instance.mcVersion} ${x.instance.loader}` : null,
    }));
    return { data: { instance_id: inst.id, count: items.length, snapshots: out }, summary: t('assistantx.sumSnapshots', { count: items.length, name: inst.name }) };
  },
};

const createSnapshot = {
  minLevel: 'reversible',
  async prepare(input) {
    const inst = await S.getInstance(input.instance_id);
    snapshotsModule();
    const label = String(input.label ?? '').replace(/[\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
    return { scope: 'instance', instanceId: inst.id, inst, label, worlds: input.include_worlds === true, skipFullSnapshot: true };
  },
  async run(p, ctx) {
    const snaps = snapshotsModule();
    if (p.worlds) S.assertNotRunning(p.inst);
    const r = await snaps.create(p.inst.id, { kind: 'manual', label: p.label || t('assistantx.snapshotLabel'), reason: t('assistant.snapshotReason'), worlds: p.worlds ? 'all' : 'none' });
    if (!r?.reused) {
      ctx.action.target(`snapshot:${r.id}`);
      ctx.action.op({ type: 'removeSnapshot', snapshotId: r.id });
    }
    return {
      data: { snapshot_id: r.id, files: r.stats?.files ?? null, size_mb: r.stats?.bytes ? Math.round((r.stats.bytes / MB) * 10) / 10 : null, worlds_included: (r.worlds || []).length },
      summary: t('assistantx.sumSnapshotCreated', { name: p.inst.name }),
    };
  },
};

const restoreSnapshot = {
  minLevel: 'destructive',
  async prepare(input) {
    const inst = await S.getInstance(input.instance_id);
    S.assertNotRunning(inst);
    const snaps = snapshotsModule();
    const id = String(input.snapshot_id ?? '');
    if (!SNAP_ID.test(id)) throw new ToolError(t('assistantx.errSnapshotId'), 'snapshot');
    const hit = (await snaps.list(inst.id)).find((x) => x.id === id);
    if (!hit) throw new ToolError(t('assistantx.errSnapshotId'), 'snapshot');
    const when = iso(hit.createdAt) || id;
    return {
      inst,
      id,
      confirm: {
        kind: 'destructive',
        title: t('assistantx.confirmSnapshotTitle'),
        message: t('assistantx.confirmSnapshotText', { name: inst.name, when: when.slice(0, 16).replace('T', ' '), label: hit.label || '—' }),
        okText: t('assistantx.confirmSnapshotOk'),
        items: [hit.label || id],
        danger: true,
      },
    };
  },
  async run({ inst, id }) {
    const snaps = snapshotsModule();
    // Solo la configuracion y el contenido: los mundos nunca se tocan desde el asistente (worlds: 'none').
    const r = await snaps.restore(inst.id, id, { worlds: 'none' });
    D().send('instances:changed');
    return {
      data: { restored: id, safety_snapshot_id: r?.safetyId || null, worlds_touched: false, note: 'The state before the restore was saved automatically as a snapshot, so this can be reverted.' },
      summary: t('assistantx.sumSnapshotRestored', { name: inst.name }),
    };
  },
};

// ---------- Mundos de una instancia ----------
const listWorlds = {
  minLevel: 'read',
  async prepare(input) {
    return { inst: await S.getInstance(input.instance_id) };
  },
  async run({ inst }) {
    const list = await instances.content(inst.id, 'saves').catch(() => []);
    const out = [];
    for (const w of list.slice(0, 100)) {
      out.push({
        folder: w.folder,
        name: w.displayName,
        last_played: iso(w.lastPlayed),
        game_mode: w.gameMode,
        hardcore: w.hardcore,
        cheats: w.cheats,
        version: w.version,
        datapacks: w.datapacks,
        size_mb: Math.round(((await dirSize(path.join(inst.dir, 'saves', w.folder)).catch(() => 0)) / MB) * 10) / 10,
      });
    }
    const backups = await worldBackups.list(inst.id).catch(() => []);
    return { data: { instance_id: inst.id, count: out.length, worlds: out, backups_available: backups.length }, summary: t('assistantx.sumWorlds', { count: out.length, name: inst.name }) };
  },
};

const backupWorld = {
  minLevel: 'reversible',
  async prepare(input) {
    const inst = await S.getInstance(input.instance_id);
    const world = await existingWorld(inst, input.folder);
    return { scope: 'instance', instanceId: inst.id, inst, world, skipFullSnapshot: true };
  },
  async run({ inst, world }, ctx) {
    const res = await D().runTask(t('assistantx.taskWorldBackup', { name: world.name }), (task) => worldBackups.create(inst, world.name, { task }), inst.id, ctx.signal);
    ctx.action.target(`backup:${res.name}`);
    ctx.action.op({ type: 'removeBackupFile', name: res.name });
    D().send('worlds:updated', { kind: 'backups', instanceId: inst.id, world: world.name });
    const warnings = D().isRunning(inst.id) ? [t('assistantx.warnWorldOpen')] : [];
    return { data: { backup: res.name, world: world.name, size_mb: Math.round((res.size / MB) * 10) / 10, warnings }, warnings, summary: t('assistantx.sumWorldBackup', { world: world.name, name: inst.name }) };
  },
};

function build(shared) {
  S = shared;
  return {
    recommend_ram: recommendRam,
    duplicate_instance: duplicateInstance,
    rename_instance: renameInstance,
    list_snapshots: listSnapshots,
    create_snapshot: createSnapshot,
    restore_snapshot: restoreSnapshot,
    list_worlds: listWorlds,
    backup_world: backupWorld,
  };
}

module.exports = { build };
