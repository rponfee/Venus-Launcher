'use strict';
// Read-only readiness check. Installation and repair remain explicit user actions.
const fsp = require('fs/promises');
const path = require('path');
const instances = require('../core/instances');
const minecraft = require('../core/minecraft');
const java = require('../core/java');
const accounts = require('../core/accounts');
const game = require('../core/game');

async function check(instanceId) {
  const inst = await instances.get(instanceId);
  const checks = [];
  const add = (code, level, vars = {}) => checks.push({ code, level, vars });
  if (game.status()[inst.id]) add('running', 'info');
  if (!inst.mcVersion) add('noVersion', 'error');
  if (!inst.installed) add('firstInstall', 'info');
  else if (inst.versionId) {
    try {
      const local = await minecraft.resolveVersionLocal(inst.versionId);
      if (!local) add('missingVersion', 'warning');
      else {
        const verified = await minecraft.quickVerify(local.resolved);
        if (!verified.ok) add('missingLibraries', 'warning', { count: verified.missing.length });
      }
    } catch {
      add('missingVersion', 'warning');
    }
  }

  if (inst.java?.path) {
    const result = await java.checkJavaFor({ javaPath: inst.java.path, mcVersion: inst.mcVersion, loader: inst.loader });
    if (!result.ok) add(result.problem === 'tooOld' ? 'javaTooOld' : result.problem === 'legacyModded' ? 'javaLegacy' : 'javaBroken', 'warning', { required: java.majorForMinecraft(inst.mcVersion) });
  }

  try {
    const fs = await fsp.statfs(inst.dir);
    const free = Number(fs.bavail) * Number(fs.bsize);
    const needed = inst.installed ? 512 * 1024 * 1024 : 2 * 1024 * 1024 * 1024;
    if (Number.isFinite(free) && free < needed) add('lowDisk', 'warning', { gb: (free / (1024 ** 3)).toFixed(1) });
  } catch { /* statfs is unavailable on some filesystems */ }

  const accountList = await accounts.list();
  const selected = accountList.accounts.find((a) => a.id === accountList.selected);
  if (!selected) add('noAccount', 'error');
  else if (selected.needsLogin) add('accountLogin', 'warning');

  if (inst.sharedOptions !== false) {
    try {
      const shared = await require('./sharedoptions').status(inst.id);
      if (shared.profile?.saved && shared.profile.groups?.controls && !shared.instance?.format) add('keyFormat', 'warning');
    } catch { /* shared settings are optional */ }
  }

  if (inst.loader && inst.loader !== 'vanilla') {
    try {
      const inventory = require('./compat/inventory');
      const inv = await inventory.scan({ dir: inst.dir, folders: ['mods'], records: {} }, { identify: false, meta: true });
      const duplicates = [...inv.byModId.values()].filter((files) => files.filter((f) => f.enabled).length > 1);
      if (duplicates.length) add('duplicateMods', 'warning', { count: duplicates.length });
    } catch { /* an unreadable mod must not block the entire check */ }
  }

  if (!checks.some((item) => item.level === 'error' || item.level === 'warning')) add('ready', 'ok');
  return { instanceId: inst.id, checkedAt: Date.now(), checks };
}

function register({ handle }) {
  handle('preflight:check', check);
}

module.exports = { register, check };
