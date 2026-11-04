// Links venus://: el proceso principal (modules/deeplink.js) los valida y los manda por 'deeplink:open'. Acá nunca se
// hace nada solo: un diálogo dice qué va a pasar y de dónde viene, y recién con el "sí" se usa el flujo de siempre
// (instalar un modpack en una instancia nueva, entrar a un servidor). Hasta confirmar no se conecta a nada.
import { h, icon, modal, fail, copyText } from '../../ui.js';
import { store, api } from '../../store.js';
import { t } from '../../i18n.js';
import { navigate } from '../../app.js';
import { instanceLink } from './logic.js';

const MAX_WAITING = 3;
const waiting = [];
let showing = false;

function row(label, value) {
  return value ? h('div', { class: 'it-link-row' }, h('span', { class: 'it-link-label' }, label), h('span', { class: 'it-link-value', title: String(value) }, String(value))) : null;
}

// Promise<boolean>: true solo si el usuario confirma.
function confirmLink({ iconName, title, lead, rows, warn, okText, link }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      m.close();
      resolve(v);
    };
    const m = modal({
      title,
      subtitle: t('instancetools.linkSubtitle'),
      icon: iconName,
      size: 'sm',
      body: h(
        'div',
        { class: 'stack it-link' },
        h('p', { class: 'text-2 it-link-lead' }, lead),
        h('div', { class: 'it-link-rows' }, rows),
        warn ? h('div', { class: 'notice' }, icon('alert'), h('div', {}, warn)) : null,
        h('div', { class: 'small muted' }, t('instancetools.linkFrom')),
        h('code', { class: 'it-link-raw', title: link }, link),
      ),
      footer: [h('button', { class: 'btn ghost', type: 'button', onclick: () => finish(false) }, t('common.cancel')), h('button', { class: 'btn primary', type: 'button', onclick: () => finish(true) }, okText)],
      onClose: () => finish(false),
    });
  });
}

async function runModrinth(a) {
  const project = await api.modrinth.project(a.project);
  if (project?.project_type !== 'modpack') {
    fail(t('instancetools.linkNotModpackTitle'), t('instancetools.linkNotModpack', { name: project?.title || a.project }));
    return;
  }
  const { openInstallDialog } = await import('../install.js');
  await openInstallDialog(project, { type: 'modpack', versionId: a.version || undefined });
}

async function runCurseforge(a) {
  const status = await api.invoke('curseforge:status').catch(() => null);
  if (!status?.configured) {
    fail(t('instancetools.linkFailed'), t('instancetools.linkNoCurseforge'));
    return;
  }
  const project = await api.invoke('curseforge:project', a.modId);
  if (project?.project_type !== 'modpack') {
    fail(t('instancetools.linkNotModpackTitle'), t('instancetools.linkNotModpack', { name: project?.title || a.modId }));
    return;
  }
  const { openInstallDialog } = await import('../install.js');
  await openInstallDialog(project, { type: 'modpack' });
}

async function handle(a) {
  if (a.kind === 'modpack') {
    const curseforge = a.source === 'curseforge';
    const yes = await confirmLink({
      iconName: 'package',
      title: t('instancetools.linkPackTitle'),
      lead: t('instancetools.linkPackLead'),
      rows: [
        row(t('instancetools.linkSource'), curseforge ? 'CurseForge' : 'Modrinth'),
        row(t('instancetools.linkProject'), curseforge ? a.modId : a.project),
        curseforge ? null : row(t('instancetools.linkVersion'), a.version || t('instancetools.linkVersionPick')),
      ],
      okText: t('instancetools.linkPackOk'),
      link: a.link,
    });
    if (yes) await (curseforge ? runCurseforge(a) : runModrinth(a));
    return;
  }
  if (a.kind === 'server') {
    const yes = await confirmLink({
      iconName: 'server',
      title: t('instancetools.linkServerTitle'),
      lead: t('instancetools.linkServerLead'),
      rows: [row(t('instancetools.linkAddress'), a.address), row(t('instancetools.linkServerName'), a.name)],
      warn: a.lan ? t('instancetools.linkServerLan') : a.name ? t('instancetools.linkServerNameWarn') : null,
      okText: t('instancetools.linkServerOk'),
      link: a.link,
    });
    if (yes) {
      const { joinServer } = await import('../serverlist.js');
      await joinServer(a.address, a.name ? { name: a.name } : {});
    }
    return;
  }
  if (a.kind === 'instance') {
    if (!store.instances.length) await store.refreshInstances().catch(() => {});
    const inst = store.instances.find((i) => i.id === a.id);
    if (!inst) {
      fail(t('instancetools.linkFailed'), t('instancetools.linkNoInstance'));
      return;
    }
    const yes = await confirmLink({
      iconName: 'layers',
      title: t('instancetools.linkInstanceTitle'),
      lead: t('instancetools.linkInstanceLead'),
      rows: [row(t('instancetools.linkInstanceName'), inst.name), row(t('instancetools.linkVersion'), inst.mcVersion)],
      okText: t('instancetools.linkInstanceOk'),
      link: a.link,
    });
    if (yes) navigate(`instance/${encodeURIComponent(inst.id)}`);
  }
}

// La bienvenida es obligatoria: un link que llega antes espera a que termine.
function uiReady() {
  return store.settings?.onboarded === true || store.info?.skipOnboarding === true;
}

async function next() {
  if (showing || !uiReady()) return;
  const action = waiting.shift();
  if (!action) return;
  showing = true;
  try {
    await handle(action);
  } catch (err) {
    fail(t('instancetools.linkFailed'), err);
  } finally {
    showing = false;
    next();
  }
}

export function startLinks() {
  api.on('deeplink:open', (action) => {
    if (!action || typeof action !== 'object' || waiting.length >= MAX_WAITING) return;
    waiting.push(action);
    next();
  });
  store.on('settings', next);
  api.invoke('deeplink:ready').catch((err) => console.warn('[instancelook] links', err?.message || err));
}

// "Copiar link" de una instancia: el del modpack de origen si se conoce o, si no, el de la instancia (solo sirve en esta PC).
export function copyInstanceLink(inst) {
  const link = instanceLink(inst);
  if (link) copyText(link.link, t(link.kind === 'modpack' ? 'instance.copyLinkPack' : 'instance.copyLinkLocal'));
}
