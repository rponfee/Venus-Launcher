// Tarjeta del cliente: instancia para probar, crear una vanilla de la version del servidor,
// lanzar Minecraft conectado (Quick Play) y avisos de cuenta / online-mode.
import { h, icon, mount, fail, ok, loaderBadge, instanceIcon, setBusy } from '../../ui.js';
import { store, api } from '../../store.js';
import { t } from '../../i18n.js';
import { launchInstance, openAccounts } from '../../app.js';
import { toggleRow } from './common.js';
import { pluginDisplayName } from './project.js';

// Crea una instancia vanilla de la version del servidor y la deja elegida en el proyecto.
export async function createInstanceFor(ctx) {
  const p = ctx.p;
  const version = p.server.info?.mcVersion;
  if (!version) throw new Error(t('devmode.needServerFirst'));
  const inst = await api.instances.create({ name: t('devmode.instanceName', { name: pluginDisplayName(p), version }), mcVersion: version, loader: 'vanilla' });
  await store.refreshInstances().catch(() => {});
  await ctx.update({ client: { instanceId: inst.id } });
  ok(t('devmode.instanceCreated', { name: inst.name }), t('devmode.instanceCreatedText'));
  return inst;
}

// Abre el cliente conectado: si el servidor esta apagado lo inicia y el cliente se abre cuando este listo.
export async function launchClient(ctx) {
  const p = ctx.p;
  const srv = p.server.info;
  const instId = p.client.instanceId;
  if (!srv || !instId) return false;
  if (!store.selectedAccount()) {
    openAccounts({ welcome: true });
    return false;
  }
  if (ctx.serverState !== 'online') {
    await api.invoke('devmode:startServer', p.id, { launchClient: true });
    ok(t('devmode.clientQueued'), t('devmode.clientQueuedText'));
    return true;
  }
  const launched = await launchInstance(instId, { quickPlay: { server: 'localhost', port: srv.port } });
  if (launched) api.invoke('devmode:clientLaunched', p.id, instId).catch(() => {});
  return launched;
}

export function clientCard(ctx) {
  const el = h('section', { class: 'card dm-card dm-client', 'aria-label': t('devmode.clientCard') });

  const draw = () => {
    const p = ctx.p;
    const srv = p.server.info;
    const version = srv?.mcVersion || null;
    const insts = store.instances || [];
    const inst = insts.find((i) => i.id === p.client.instanceId) || null;
    const same = version ? insts.filter((i) => i.mcVersion === version) : insts;
    const other = version ? insts.filter((i) => i.mcVersion !== version) : [];
    const running = inst ? store.running[inst.id] : null;
    const acc = store.selectedAccount();

    const sel = h(
      'select',
      { class: 'select', id: 'dm-client-inst', 'aria-label': t('devmode.instance') },
      h('option', { value: '' }, insts.length ? t('devmode.pickInstance') : t('devmode.noInstances')),
      same.length ? h('optgroup', { label: version ? t('devmode.sameVersion', { version }) : t('devmode.allInstances') }, same.map((i) => h('option', { value: i.id, selected: i.id === p.client.instanceId }, `${i.name} · ${i.mcVersion}`))) : null,
      other.length ? h('optgroup', { label: t('devmode.otherVersions') }, other.map((i) => h('option', { value: i.id, selected: i.id === p.client.instanceId }, `${i.name} · ${i.mcVersion}`))) : null,
    );
    if (p.client.instanceId && !inst) sel.append(h('option', { value: p.client.instanceId, selected: true }, t('devmode.instanceGone')));
    sel.addEventListener('change', () => ctx.update({ client: { instanceId: sel.value || null } }));

    const createBtn =
      version && !same.length
        ? h(
            'button',
            {
              class: 'btn sm',
              type: 'button',
              onclick: async (e) => {
                const done = setBusy(e.currentTarget);
                try {
                  await createInstanceFor(ctx);
                } catch (err) {
                  fail(t('devmode.errInstance'), err);
                } finally {
                  done();
                }
              },
            },
            icon('plus'),
            t('devmode.createVanilla', { version }),
          )
        : null;

    let launchBtn;
    if (running) {
      launchBtn = h(
        'div',
        { class: 'dm-running' },
        h('span', { class: 'pill good' }, h('span', { class: 'status-dot online' }), running.state === 'preparing' ? t('devmode.clientPreparing') : t('devmode.clientRunning')),
        h('button', { class: 'btn sm ghost', type: 'button', onclick: () => api.instances.stop(inst.id).catch((err) => fail(t('devmode.errStopClient'), err)) }, icon('stop'), t('devmode.closeClient')),
      );
    } else {
      const label = !srv || ctx.serverState === 'online' ? t('devmode.launchClient') : t('devmode.launchBoth');
      // Secundario: la accion principal de la pagina es la del ciclo de arriba
      launchBtn = h(
        'button',
        {
          class: 'btn block dm-launch',
          type: 'button',
          disabled: !srv || !inst,
          title: !srv ? t('devmode.needServerFirst') : !inst ? t('devmode.needInstance') : t('devmode.launchHint', { port: srv.port }),
          onclick: async (e) => {
            const done = setBusy(e.currentTarget);
            try {
              await launchClient(ctx);
            } catch (err) {
              fail(t('devmode.errLaunch'), err);
            } finally {
              done();
            }
          },
        },
        icon('gamepad'),
        label,
      );
    }

    const notices = [];
    if (!srv) notices.push(h('div', { class: 'notice info' }, icon('info'), h('div', {}, t('devmode.clientNeedsServer'))));
    if (inst && version && inst.mcVersion !== version) notices.push(h('div', { class: 'notice' }, icon('alert'), h('div', {}, t('devmode.versionMismatch', { inst: inst.mcVersion, server: version }))));
    if (!acc) {
      notices.push(h('div', { class: 'notice' }, icon('user'), h('div', { class: 'spacer' }, t('devmode.noAccount')), h('button', { class: 'btn sm', type: 'button', onclick: () => openAccounts() }, t('devmode.accounts'))));
    } else if (srv && acc.type !== 'msa' && srv.onlineMode !== false) {
      notices.push(
        h(
          'div',
          { class: 'notice' },
          icon('alert'),
          h('div', { class: 'spacer' }, t('devmode.offlineAccountWarn', { name: acc.name })),
          h(
            'button',
            {
              class: 'btn sm',
              type: 'button',
              onclick: async (e) => {
                const done = setBusy(e.currentTarget);
                try {
                  const r = await api.invoke('devmode:setOnlineMode', p.id, false);
                  ok(t('devmode.onlineOffDone'), r.restartNeeded ? t('devmode.restartToApply') : null);
                  ctx.refresh();
                } catch (err) {
                  fail(t('devmode.errOnline'), err);
                } finally {
                  done();
                }
              },
            },
            t('devmode.disableOnline'),
          ),
        ),
      );
    }

    mount(
      el,
      h('div', { class: 'card-head' }, h('h2', { class: 'card-title' }, icon('gamepad'), t('devmode.clientCard'))),
      inst
        ? h(
            'div',
            { class: 'dm-inst' },
            instanceIcon(inst, 'dm-inst-icon'),
            h('div', { class: 'dm-inst-main' }, h('div', { class: 'dm-inst-name ellipsis', title: inst.name }, inst.name), h('div', { class: 'row wrap dm-inst-meta' }, loaderBadge(inst.loader || 'vanilla'), h('span', { class: 'small muted' }, inst.mcVersion))),
          )
        : null,
      h('div', { class: 'field' }, h('label', { for: 'dm-client-inst' }, t('devmode.instance')), h('div', { class: 'dm-inst-pick' }, sel, createBtn)),
      launchBtn,
      toggleRow(t('devmode.autoLaunch'), t('devmode.autoLaunchSub'), p.client.autoLaunch, (v) => ctx.update({ client: { autoLaunch: v } })),
      notices.length ? h('div', { class: 'stack dm-notices' }, notices) : null,
    );
  };

  draw();
  const offs = [ctx.on('project', draw), ctx.on('running', draw), ctx.on('instances', draw), ctx.on('accounts', draw), ctx.on('server', draw)];
  return { el, destroy: () => offs.forEach((o) => o()) };
}
