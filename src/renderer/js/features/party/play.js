// "Jugar todos": preparar la instancia del plan en esta PC y entrar al servidor o al mundo del líder.
//   leaderPlay({ plan, instanceId })   el líder entra al servidor o abre su mundo a amigos (netplay)
//   memberJoin(plan, { prep, manual }) el miembro usa su instancia (actualizada), la importa o crea una compatible
//                                      y entra con joinServer (Quick Play)
//   prepareInstance(plan, { prep })    solo prepara (botones del panel); devuelve el id de la instancia o null
import { h, icon, modal, toast, ok, fail } from '../../ui.js';
import { store, api } from '../../store.js';
import { t } from '../../i18n.js';
import { cloud } from '../../cloud.js';
import { launchInstance } from '../../app.js';
import { prepFor, quickPlayOf, cleanText } from './logic.js';

const LOADER_NAMES = { vanilla: 'Vanilla', fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge', quilt: 'Quilt', optifine: 'OptiFine', iris: 'Iris', legacyfabric: 'Legacy Fabric', babric: 'Babric' };
const versionText = (pack) => t('party.versionLabel', { version: pack.mcVersion, loader: LOADER_NAMES[pack.loader] || pack.loader });
const isRunning = (id) => ['running', 'preparing'].includes(store.running[id]?.state);

// Entra a una dirección con una instancia: joinServer de Multijugador (elige cuenta, espera la preparación y usa
// Quick Play); si esa feature no carga, launchInstance con Quick Play directo.
async function enter(address, instanceId, name) {
  try {
    const { joinServer } = await import('../serverlist.js');
    return await joinServer(address, instanceId ? { instanceId, name: name || undefined } : {});
  } catch (err) {
    console.warn('[party] multijugador', err?.message || err);
    const qp = quickPlayOf(address);
    if (!instanceId || !qp) {
      fail(t('party.playFailed'), err);
      return false;
    }
    return launchInstance(instanceId, { quickPlay: qp });
  }
}

export async function leaderPlay({ plan, instanceId }) {
  const target = plan?.target;
  if (!target || !instanceId) return false;
  if (target.kind === 'server') {
    if (isRunning(instanceId)) {
      toast('info', t('party.alreadyPlaying'), t('party.alreadyPlayingText'));
      return false;
    }
    return enter(target.address, instanceId, target.name);
  }
  // Mundo: el diálogo de netplay guía (instalar e4mc o el túnel, jugar y abrir en LAN); la dirección les llega
  // a los miembros apenas está lista
  try {
    const { openWorldToFriends } = await import('../netplay.js');
    await openWorldToFriends(instanceId);
    return true;
  } catch (err) {
    fail(t('party.worldFailed'), err);
    return false;
  }
}

// ---------- Modpack compartido desactualizado ----------

// Aplica la última revisión del modpack compartido con los mismos canales que usa features/share.js
// (share:diff + share:applyManifest), con una instantánea antes de tocar nada.
async function updateShared(inst, pack) {
  await Promise.resolve(cloud.ready()).catch(() => {});
  if (!cloud.isSignedIn()) throw new Error(t('party.needsSession'));
  const { data, error } = await cloud.client.rpc('get_shared_pack', { p_code: pack.code });
  if (error || !data?.pack?.manifest) {
    console.warn('[party] modpack', error?.message || data?.error || 'sin datos');
    throw new Error(t('party.updateUnavailable'));
  }
  const remote = data.pack;
  if (isRunning(inst.id)) throw new Error(t('party.closeGameFirst', { name: inst.name }));
  const diff = await api.invoke('share:diff', inst.id, remote.manifest);
  const s = diff?.summary || {};
  const changes = (s.added || 0) + (s.removed || 0) + (s.updated || 0) + (s.toggled || 0) + (s.configs || 0) + (s.version ? 1 : 0);
  if (changes > 0) {
    try {
      const { snapshotBefore } = await import('../snapshots.js');
      await snapshotBefore(inst.id, t('party.snapshotReason', { name: cleanText(remote.name, 60) || pack.name }));
    } catch (err) {
      console.warn('[party] instantánea', err?.message || err);
    }
    await api.invoke('share:applyManifest', inst.id, remote.manifest, { removeMissing: false, applyOptions: false, revision: remote.revision });
  }
  await api.instances.update(inst.id, { share: { ...inst.share, name: remote.name, revision: remote.revision, syncedAt: Date.now() } });
  if (remote.is_group && inst.share?.role === 'member') await cloud.client.rpc('mark_pack_synced', { p_pack_id: remote.id, p_revision: remote.revision }).catch(() => {});
  await store.refreshInstances();
  return inst.id;
}

// ---------- Falta la instancia ----------

async function createCompatible(pack) {
  const loader = pack.loader === 'iris' ? 'fabric' : pack.loader;
  const inst = await api.instances.create({ name: cleanText(pack.name, 40) || undefined, mcVersion: pack.mcVersion, loader, preset: pack.loader === 'iris' ? 'iris' : null });
  await store.refreshInstances().catch(() => {});
  ok(t('party.createdTitle', { name: inst.name }), t('party.createdText'));
  return inst.id;
}

// Diálogo: importar el modpack con el código, crear una instancia compatible o (en un servidor) elegir otra.
// Devuelve { instanceId } | { pick: true } | null
function missingDialog(plan) {
  const pack = plan.pack;
  const shared = pack.kind === 'shared';
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      m.close();
      resolve(v);
    };
    const importBtn = shared
      ? h('button', { class: 'btn primary', type: 'button', onclick: async () => {
          finish(null);
          try {
            const { openImportCode } = await import('../share.js');
            await openImportCode(pack.code);
            toast('info', t('party.importStarted'), t('party.importStartedText'), 8000);
          } catch (err) {
            fail(t('party.importFailed'), err);
          }
        } }, icon('download'), t('party.importPack'))
      : null;
    const createBtn = h('button', { class: shared ? 'btn' : 'btn primary', type: 'button', onclick: async (e) => {
      e.currentTarget.disabled = true;
      try {
        finish({ instanceId: await createCompatible(pack) });
      } catch (err) {
        finish(null);
        fail(t('party.createFailed'), err);
      }
    } }, icon('plus'), t('party.createCompatible'));
    const pickBtn = plan.target?.kind === 'server' || plan.target?.address ? h('button', { class: 'btn ghost', type: 'button', onclick: () => finish({ pick: true }) }, t('party.pickOther')) : null;
    const m = modal({
      title: t(shared ? 'party.missingPackTitle' : 'party.missingVersionTitle'),
      icon: 'package',
      size: 'sm',
      body: h(
        'div',
        { class: 'pt-missing' },
        h('p', { class: 'text-2 pt-missing-text' }, shared ? t('party.missingPackText', { name: pack.name, code: pack.code }) : t('party.missingVersionText', { version: versionText(pack) })),
        shared ? h('p', { class: 'small muted pt-missing-text' }, t('party.missingPackHint', { version: versionText(pack) })) : null,
      ),
      footer: [pickBtn, h('span', { class: 'spacer' }), createBtn, importBtn],
      onClose: () => finish(null),
    });
  });
}

// Deja lista la instancia del plan. Devuelve el id, { pick: true } (que Multijugador elija) o null (se canceló o
// quedó importando).
async function resolveInstance(plan, prep) {
  const p = prep || prepFor(plan, store.instances);
  if (p.prep === 'ok' && p.instanceId) return p.instanceId;
  if (p.prep === 'update' && p.instanceId) {
    const inst = store.instances.find((i) => i.id === p.instanceId);
    if (!inst) return null;
    toast('info', t('party.updatingTitle', { name: inst.name }), t('party.updatingText'), 5000);
    try {
      return await updateShared(inst, plan.pack);
    } catch (err) {
      // No se pudo actualizar: se juega igual con la copia que hay (el servidor dirá si falta algo)
      toast('info', t('party.updateFailed', { name: inst.name }), err.message, 9000);
      return inst.id;
    }
  }
  const choice = await missingDialog(plan);
  if (!choice) return null;
  return choice.pick ? { pick: true } : choice.instanceId;
}

export async function prepareInstance(plan, { prep } = {}) {
  if (!plan?.pack) return null;
  const res = await resolveInstance(plan, prep);
  return typeof res === 'string' ? res : null;
}

export async function memberJoin(plan, { prep } = {}) {
  const target = plan?.target;
  if (!target?.address) return false;
  const res = await resolveInstance(plan, prep);
  if (!res) return false;
  const address = target.address;
  if (res.pick) return enter(address, null, target.name);
  if (isRunning(res)) {
    toast('info', t('party.alreadyPlaying'), t('party.alreadyPlayingText'));
    return false;
  }
  return enter(address, res, target.name);
}
