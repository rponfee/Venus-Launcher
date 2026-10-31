'use strict';
// compat:prepare — aplica lo que el usuario confirmó en la revisión antes de instalar:
//   adopt:   registra archivos que ya estaban (agregados a mano) para que el instalador no los duplique
//   replace: mueve al historial los archivos que el nuevo reemplaza (misma mod o mismo id de mod)
//   enable:  activa dependencias desactivadas (.disabled)
//   install: instala lo sugerido que eligió (dependencias opcionales, Iris para shaders...)
const path = require('path');
const fsp = require('fs/promises');
const instances = require('../../core/instances');
const servers = require('../../core/servers');
const { exists } = require('../../core/util');
const { t } = require('../../core/i18n');
const targets = require('./target');
const history = require('./history');

const TYPE = { mods: 'mod', resourcepacks: 'resourcepack', shaderpacks: 'shader', plugins: 'plugin' };
const ID_RE = /^\w{1,64}$/;
const str = (v, max = 120) => (typeof v === 'string' ? v.slice(0, max) : '');
const httpsUrl = (v) => (typeof v === 'string' && /^https:\/\//i.test(v) ? v.slice(0, 500) : null);

function validFile(x) {
  return x && history.FOLDERS.has(x.folder) && history.isSafeName(x.file);
}

async function prepare(input = {}, { task, safePath } = {}) {
  const target = await targets.load(input.target);
  const full = (folder, file) => {
    const p = path.join(target.dir, folder, file);
    if (safePath) safePath(p);
    return p;
  };
  const out = { adopted: 0, replaced: 0, enabled: 0, installed: [], failed: [], batch: null };

  // 1) Registrar archivos que ya estaban
  const adopt = [];
  for (const a of Array.isArray(input.adopt) ? input.adopt : []) {
    if (!validFile(a) || typeof a.projectId !== 'string' || !ID_RE.test(a.projectId)) continue;
    if ((await exists(full(a.folder, a.file))) || (await exists(full(a.folder, `${a.file}.disabled`)))) adopt.push(a);
  }
  if (adopt.length) {
    await targets.updateRecords(target, (projects) => {
      for (const a of adopt) {
        projects[a.projectId] = {
          ...(projects[a.projectId] || {}),
          title: str(a.title) || a.file,
          icon: httpsUrl(a.icon),
          type: TYPE[a.folder],
          versionId: typeof a.versionId === 'string' && ID_RE.test(a.versionId) ? a.versionId : null,
          versionNumber: str(a.versionNumber, 80) || null,
          file: a.file,
          folder: a.folder,
          installedAt: Date.now(),
          adopted: true,
        };
      }
    });
    out.adopted = adopt.length;
  }

  // 2) Mover al historial lo que se reemplaza
  const replace = (Array.isArray(input.replace) ? input.replace : []).filter(validFile);
  if (replace.length) {
    const batch = history.createBatch(target.dir, 'install');
    try {
      for (const r of replace) {
        if (!(await exists(full(r.folder, r.file)))) continue;
        const title = str(r.title) || history.strip(r.file);
        const entry = {
          id: history.nextEntryId(batch),
          kind: 'replace',
          title: str(r.newTitle) || title,
          icon: httpsUrl(r.icon),
          folder: r.folder,
          old: {
            projectId: typeof r.oldProjectId === 'string' && ID_RE.test(r.oldProjectId) ? r.oldProjectId : null,
            file: history.strip(r.file),
            storedAs: null,
            versionId: typeof r.versionId === 'string' && ID_RE.test(r.versionId) ? r.versionId : null,
            versionNumber: str(r.versionNumber, 80) || null,
            disabled: /\.disabled$/i.test(r.file),
            title,
          },
          new:
            history.isSafeName(r.newFile) && typeof r.projectId === 'string' && ID_RE.test(r.projectId)
              ? { projectId: r.projectId, file: r.newFile, versionId: typeof r.newVersionId === 'string' && ID_RE.test(r.newVersionId) ? r.newVersionId : null, versionNumber: str(r.newVersionNumber, 80) || null, disabled: false, title: str(r.newTitle) || null }
              : null,
          rolledBack: null,
        };
        batch.index.entries.push(entry);
        entry.old.storedAs = await history.stash(batch, r.folder, r.file);
      }
    } catch (err) {
      await history.undoEntries(batch, batch.index.entries);
      throw err;
    }
    if (await history.saveBatch(batch)) {
      await targets.updateRecords(target, (projects) => {
        for (const e of batch.index.entries) {
          for (const [pid, rec] of Object.entries(projects)) if (history.strip(rec?.file) === e.old.file && (rec.folder || 'mods') === e.folder) delete projects[pid];
        }
      });
      out.replaced = batch.index.entries.length;
      out.batch = batch.id;
    }
  }

  // 3) Activar dependencias desactivadas
  for (const e of (Array.isArray(input.enable) ? input.enable : []).filter(validFile)) {
    if (!/\.disabled$/i.test(e.file)) continue;
    const from = full(e.folder, e.file);
    const to = full(e.folder, history.strip(e.file));
    if (!(await exists(from)) || (await exists(to))) continue;
    await fsp.rename(from, to).catch(async (err) => {
      // Bloqueado: en uso en esta instancia o compartido (enlace duro) con otra que esta abierta.
      const locked = await history.lockedError(err, from);
      throw locked === err ? new Error(err.message) : locked;
    });
    out.enabled++;
  }

  // 4) Instalar lo sugerido que se eligio (el instalador del nucleo agrega sus dependencias)
  const install = (Array.isArray(input.install) ? input.install : []).filter((i) => i && typeof i.projectId === 'string' && ID_RE.test(i.projectId));
  for (let n = 0; n < install.length; n++) {
    const it = install[n];
    const versionId = typeof it.versionId === 'string' && ID_RE.test(it.versionId) ? it.versionId : null;
    task?.update({ detail: str(it.title) || it.projectId, progress: n / install.length });
    try {
      if (target.kind === 'instance') await instances.installProject(target.id, it.projectId, versionId, { task, type: ['mod', 'resourcepack', 'shader'].includes(it.type) ? it.type : undefined });
      else if (typeof servers.installProject === 'function') await servers.installProject(target.id, it.projectId, versionId, task);
      else throw new Error(t('compat.errServerInstall'));
      out.installed.push(str(it.title) || it.projectId);
    } catch (err) {
      if (task?.signal?.aborted) throw err;
      out.failed.push({ title: str(it.title) || it.projectId, error: err?.message || String(err) });
    }
  }
  return out;
}

module.exports = { prepare };
