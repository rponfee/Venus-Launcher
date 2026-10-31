// Voz de proximidad dentro de Minecraft con el mod Simple Voice Chat: explicacion e instalacion en una
// instancia o en un servidor local (pasando antes por el chequeo de compatibilidad).
import { h, icon, mount, fail, ok, toast, selectEl, instanceIcon, loaderBadge, emptyState, loading, setBusy } from '../ui.js';
import { store, api } from '../store.js';
import { t } from '../i18n.js';
import { navigate } from '../app.js';
import { voice, SVC_PROJECT } from '../voice.js';
import { acceleratorParts } from './keys.js';
import { tSlot, kbdKeys, fieldId } from './ui-common.js';

const INSTANCE_LOADERS = new Set(['fabric', 'forge', 'neoforge', 'quilt']);

export function gameView(container) {
  let disposed = false;
  const instBox = h('div', { class: 'vc-svc-box' });
  const srvBox = h('div', { class: 'vc-svc-box' });
  const shortcut = acceleratorParts(voice.settings.muteShortcut);

  mount(
    container,
    h(
      'div',
      { class: 'vc-game' },
      h(
        'section',
        { class: 'card vc-game-hero', 'aria-labelledby': 'vc-game-title' },
        h('div', { class: 'vc-game-art', 'aria-hidden': 'true' }, h('span', { class: 'vc-wave w1' }), h('span', { class: 'vc-wave w2' }), h('span', { class: 'vc-wave w3' }), h('span', { class: 'vc-game-icon' }, icon('radio'))),
        h(
          'div',
          { class: 'vc-game-text' },
          h('div', { class: 'vc-eyebrow' }, t('voice.gameEyebrow')),
          h('h2', { class: 'vc-game-title', id: 'vc-game-title' }, t('voice.gameTitle')),
          h('p', { class: 'vc-game-sub' }, t('voice.gameText')),
          h(
            'ul',
            { class: 'vc-game-points' },
            h('li', {}, icon('users'), h('span', {}, t('voice.gamePoint1'))),
            h('li', {}, icon('server'), h('span', {}, t('voice.gamePoint2'))),
            h('li', {}, icon('keyboard'), h('span', {}, t('voice.gamePoint3'))),
            h('li', {}, icon('wifi'), h('span', {}, t('voice.gamePoint4'))),
          ),
        ),
      ),
      h(
        'div',
        { class: 'vc-game-grid' },
        h('section', { class: 'card vc-set-card vc-svc-card' }, cardHead('layers', t('voice.svcInstanceTitle'), t('voice.svcInstanceSub')), instBox),
        h('section', { class: 'card vc-set-card vc-svc-card' }, cardHead('server', t('voice.svcServerTitle'), t('voice.svcServerSub')), srvBox),
      ),
      h('div', { class: 'notice info vc-game-tip' }, icon('info'), h('div', {}, shortcut.length ? tSlot('voice.gameTip', 'keys', kbdKeys(shortcut)) : t('voice.gameTipNoShortcut'))),
    ),
  );

  function cardHead(iconName, title, sub) {
    return h('div', { class: 'vc-card-head' }, h('div', { class: 'vc-card-icon', 'aria-hidden': 'true' }, icon(iconName)), h('div', { class: 'vc-card-titles' }, h('h2', { class: 'card-title' }, title), h('p', { class: 'card-sub' }, sub)));
  }

  // Estado de instalacion: icono + texto (nunca solo el color)
  function statusLine(el, state) {
    el.className = ['vc-svc-status', state === 'yes' && 'good'].filter(Boolean).join(' ');
    if (state === 'checking') mount(el, h('div', { class: 'spinner', 'aria-hidden': 'true' }), t('voice.svcChecking'));
    else mount(el, icon(state === 'yes' ? 'check' : 'info'), t(state === 'yes' ? 'voice.svcInstalledYes' : 'voice.svcInstalledNo'));
  }

  // Revisa el chequeo de compatibilidad (features/compat.js) si esta disponible
  async function compatOk(target) {
    try {
      const m = await import('../features/compat.js');
      if (typeof m.checkBeforeInstall === 'function') return await m.checkBeforeInstall({ target, items: [{ projectId: SVC_PROJECT }] });
    } catch (err) {
      console.warn('[voice] chequeo de compatibilidad', err);
    }
    return true;
  }

  // ---------- Instancias ----------
  function drawInstances() {
    const list = store.instances.filter((i) => INSTANCE_LOADERS.has(i.loader));
    if (!list.length) {
      mount(instBox, emptyState('layers', t('voice.svcNoInstances'), t('voice.svcNoInstancesHint'), h('button', { class: 'btn sm', type: 'button', onclick: () => navigate('versions/new') }, icon('plus'), t('voice.createInstance'))));
      return;
    }
    let selected = list.find((i) => i.id === store.settings?.selectedInstance)?.id || list[0].id;
    const selId = fieldId('vc-svc-inst');
    const status = h('div', { class: 'vc-svc-status', role: 'status' });
    const preview = h('div', { class: 'vc-svc-target' });
    // La accion principal de la pestaña: instalar el mod en la instancia (boton de marca de Modrinth)
    const btn = h('button', { class: 'btn modrinth', type: 'button' }, icon('download'), t('voice.svcInstall'));
    const sel = selectEl(
      list.map((i) => ({ value: i.id, label: `${i.name} · ${i.mcVersion}` })),
      selected,
      (v) => {
        selected = v;
        refresh();
      },
    );
    sel.id = selId;
    const refresh = async () => {
      const inst = list.find((i) => i.id === selected);
      mount(preview, instanceIcon(inst), h('div', { class: 'vc-svc-main' }, h('div', { class: 'vc-svc-name', title: inst.name }, inst.name), h('div', { class: 'vc-svc-meta' }, inst.mcVersion)), loaderBadge(inst.loader));
      statusLine(status, 'checking');
      btn.disabled = true;
      let installed = false;
      try {
        const mods = await api.instances.content(selected, 'mods');
        installed = Array.isArray(mods) && mods.some((f) => f.projectId === SVC_PROJECT || /voicechat/i.test(f.file || ''));
      } catch {
        /* sin datos: se puede instalar igual */
      }
      if (disposed || inst.id !== selected) return;
      statusLine(status, installed ? 'yes' : 'no');
      mount(btn, icon(installed ? 'refresh' : 'download'), t(installed ? 'voice.svcReinstall' : 'voice.svcInstall'));
      btn.disabled = false;
    };
    btn.addEventListener('click', async () => {
      const id = selected;
      const done = setBusy(btn);
      try {
        if (!(await compatOk({ kind: 'instance', id }))) return;
        const r = await api.modrinth.install(id, SVC_PROJECT, null, {});
        ok(t('voice.svcDone'), (r?.installed || []).join(', ') || 'Simple Voice Chat');
        if (r?.warnings?.length) toast('info', t('voice.svcWarnings'), r.warnings.slice(0, 3).join(' · '), 8000);
      } catch (err) {
        fail(t('voice.svcFailed'), err);
      } finally {
        done();
        if (!disposed) refresh();
      }
    });
    mount(instBox, h('div', { class: 'field' }, h('label', { for: selId }, t('voice.svcChooseInstance')), sel), preview, h('div', { class: 'vc-svc-foot' }, status, btn));
    refresh();
  }

  // ---------- Servidores locales ----------
  async function drawServers() {
    mount(srvBox, loading(t('voice.loading')));
    let servers = [];
    try {
      servers = await api.servers.list();
    } catch (err) {
      if (!disposed) {
        const retry = h('button', { class: 'btn sm', type: 'button', onclick: () => drawServers() }, icon('refresh'), t('voice.retry'));
        mount(srvBox, h('div', { class: 'notice bad', role: 'alert' }, icon('alert'), h('div', { class: 'spacer' }, err.message), retry));
      }
      return;
    }
    if (disposed) return;
    const list = (Array.isArray(servers) ? servers : []).filter((s) => s && s.type && s.type !== 'vanilla');
    if (!list.length) {
      mount(srvBox, emptyState('server', t('voice.svcNoServers'), t('voice.svcNoServersHint'), h('button', { class: 'btn sm', type: 'button', onclick: () => navigate('servers') }, icon('server'), t('voice.openServers'))));
      return;
    }
    let selected = list[0].id;
    const selId = fieldId('vc-svc-srv');
    const status = h('div', { class: 'vc-svc-status', role: 'status' });
    // Secundario: solo lo necesita quien aloja el servidor
    const btn = h('button', { class: 'btn', type: 'button' }, icon('download'), t('voice.svcInstallServer'));
    const sel = selectEl(
      list.map((s) => ({ value: s.id, label: `${s.name} · ${s.type} ${s.mcVersion || ''}`.trim() })),
      selected,
      (v) => {
        selected = v;
        refresh();
      },
    );
    sel.id = selId;
    const refresh = async () => {
      btn.disabled = true;
      statusLine(status, 'checking');
      let installed = false;
      try {
        const s = await api.servers.get(selected);
        installed = Boolean(s?.modrinth?.projects?.[SVC_PROJECT]);
        if (!installed) {
          const c = await api.servers.content(selected);
          installed = (c?.files || []).some((f) => /voicechat/i.test(f.file || f.name || ''));
        }
      } catch {
        /* sin datos */
      }
      if (disposed) return;
      statusLine(status, installed ? 'yes' : 'no');
      btn.disabled = false;
    };
    btn.addEventListener('click', async () => {
      const id = selected;
      const done = setBusy(btn);
      try {
        if (!(await compatOk({ kind: 'server', id }))) return;
        const r = await api.servers.installProject(id, SVC_PROJECT, null);
        ok(t('voice.svcDone'), (r?.installed || []).join(', ') || 'Simple Voice Chat');
        toast('info', t('voice.svcServerNext'), t('voice.svcServerNextText'), 9000);
      } catch (err) {
        fail(t('voice.svcFailed'), err);
      } finally {
        done();
        if (!disposed) refresh();
      }
    });
    mount(srvBox, h('div', { class: 'field' }, h('label', { for: selId }, t('voice.svcChooseServer')), sel, h('div', { class: 'field-help' }, t('voice.svcPortHint'))), h('div', { class: 'vc-svc-foot' }, status, btn));
    refresh();
  }

  drawInstances();
  drawServers();
  const off = store.on('instances', () => !disposed && drawInstances());
  return () => {
    disposed = true;
    off();
  };
}
