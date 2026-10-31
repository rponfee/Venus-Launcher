// Red: "Jugar en este servidor" (Quick Play a localhost) y el panel de red de netplay (direcciones LAN,
// VPN e IP publica, UPnP y tuneles; lo provee features/netplay.js). Si ese panel no carga, se muestran
// las direcciones locales y los pasos para abrir el puerto a mano.
import { h, icon, mount, selectEl, copyText, skeleton, sectionTitle } from '../../ui.js';
import { store, api } from '../../store.js';
import { t } from '../../i18n.js';
import { navigate, launchInstance } from '../../app.js';
import { typeMeta } from './common.js';

const LOADER_FOR = { fabric: ['fabric', 'quilt'], quilt: ['quilt'], forge: ['forge'], neoforge: ['neoforge'], mohist: ['forge'], youer: ['neoforge'] };

// Instancias ordenadas por compatibilidad con el servidor (misma version y loader primero).
export function rankInstances(srv) {
  const want = LOADER_FOR[srv.type];
  const proxy = typeMeta(srv.type).kind === 'proxy';
  return store.instances
    .map((i) => {
      const sameVersion = proxy || i.mcVersion === srv.mcVersion;
      const sameLoader = !want || want.includes(i.loader);
      return { inst: i, score: (sameVersion ? 2 : 0) + (sameLoader ? 1 : 0), sameVersion, sameLoader };
    })
    .sort((a, b) => b.score - a.score || (b.inst.lastPlayed || 0) - (a.inst.lastPlayed || 0));
}

export async function playOnServer(srv, instanceId) {
  return launchInstance(instanceId, { quickPlay: { server: 'localhost', port: srv.port } });
}

export function networkTab(container, ctx) {
  const srv = ctx.srv;
  let ranked = rankInstances(srv);
  let pick = ranked[0]?.inst.id || null;
  const playBox = h('div');
  const netBox = h('div', { class: 'sv-netpanel' });

  function drawPlay() {
    ranked = rankInstances(srv);
    if (!ranked.some((x) => x.inst.id === pick)) pick = ranked[0]?.inst.id || null;
    const r = ranked.find((x) => x.inst.id === pick);
    const notes = [];
    if (r && !r.sameVersion) notes.push(h('div', { class: 'notice' }, icon('alert'), t('server.playVersionWarn', { a: r.inst.mcVersion, b: srv.mcVersion })));
    if (r && !r.sameLoader) notes.push(h('div', { class: 'notice' }, icon('alert'), t('server.playLoaderWarn')));
    if (LOADER_FOR[srv.type]) notes.push(h('div', { class: 'field-help' }, t('server.playModsHint')));
    const offline = ctx.state() === 'offline';
    let instSel = null;
    if (ranked.length) {
      instSel = selectEl(
        ranked.map(({ inst, sameVersion, sameLoader }) => ({ value: inst.id, label: `${inst.name} · ${inst.mcVersion}${sameVersion && sameLoader ? ' ✓' : ''}` })),
        pick,
        (v) => ((pick = v), drawPlay()),
      );
      instSel.setAttribute('aria-label', t('server.playTitle'));
    }
    mount(
      playBox,
      h(
        'div',
        { class: 'card' },
        h('h2', { class: 'card-title' }, icon('gamepad'), t('server.playTitle')),
        h('div', { class: 'card-sub' }, t('server.playSub', { port: srv.port })),
        ranked.length
          ? h(
              'div',
              { class: 'stack' },
              h(
                'div',
                { class: 'sv-play-row' },
                instSel,
                h('button', { class: 'btn', disabled: !pick || offline, title: offline ? t('server.playOfflineHint') : null, 'aria-describedby': offline ? 'sv-play-offline' : null, onclick: () => playOnServer(srv, pick) }, icon('play'), t('server.playHere')),
              ),
              notes,
              offline ? h('div', { class: 'field-help', id: 'sv-play-offline' }, t('server.playOfflineHint')) : null,
            )
          : h('div', { class: 'sv-play-row' }, h('div', { class: 'small muted spacer' }, t('server.playNoInstances')), h('button', { class: 'btn', onclick: () => navigate('versions') }, icon('plus'), t('server.createInstance'))),
      ),
    );
  }

  // Direcciones de esta PC y de la red local: solo si el panel de red (netplay) no esta disponible,
  // porque ese panel ya las muestra (LAN, VPN, IP publica y tuneles).
  async function addressesCard() {
    const addrs = await api.servers.addresses().catch(() => []);
    const row = (label, value) => h('div', { class: 'sv-friend-row' }, h('span', { class: 'sv-friend-k ellipsis', title: label }, label), h('span', { class: 'kbd selectable', title: value }, value), h('button', { class: 'icon-btn sm', title: t('common.copy'), 'aria-label': `${t('common.copy')}: ${value}`, onclick: () => copyText(value) }, icon('copy')));
    return h(
      'div',
      { class: 'card' },
      h('h2', { class: 'card-title' }, icon('wifi'), t('server.addressesTitle')),
      h('div', { class: 'card-sub' }, t('server.addressesSub')),
      h('div', { class: 'stack sv-friends' }, row(t('server.addrThisPc'), srv.port === 25565 ? 'localhost' : `localhost:${srv.port}`), addrs.map((a) => row(a.name, srv.port === 25565 ? a.address : `${a.address}:${srv.port}`))),
      h('div', { class: 'sv-hint' }, t('server.firewallHint')),
    );
  }

  let netEl = null;
  async function drawNetPanel() {
    const title = h('div', { class: 'sv-net-head' }, sectionTitle(t('server.netTitle')), h('p', { class: 'sv-net-sub' }, t('server.netSub')));
    mount(netBox, title, h('div', { class: 'card' }, skeleton('card', { lines: 3 })));
    try {
      const mod = await import('../../features/netplay.js');
      const panel = mod.serverNetPanel(srv.id);
      netEl = panel instanceof Promise ? await panel : panel;
      // El panel de netplay ya trae su propio diseño: se muestra sin envolverlo en otra tarjeta.
      mount(netBox, title, netEl instanceof Node ? netEl : h('div', { class: 'card small muted' }, t('server.netUnavailable')));
    } catch (err) {
      console.warn('[servers] panel de red', err);
      const fallback = h(
        'div',
        { class: 'card' },
        h('h2', { class: 'card-title' }, icon('network'), t('server.netTitle')),
        h('div', { class: 'stack sv-section' }, h('div', { class: 'small text-2' }, t('server.netFallback1', { port: srv.port })), h('div', { class: 'small text-2' }, t('server.netFallback2'))),
      );
      mount(netBox, h('div', { class: 'sv-two-col' }, await addressesCard(), fallback));
    }
  }

  mount(container, h('div', { class: 'stack' }, playBox, netBox));
  drawPlay();
  drawNetPanel();
  const offState = ctx.on('state', drawPlay);
  const offInst = store.on('instances', drawPlay);
  return () => {
    offState();
    offInst();
    try {
      netEl?.destroy?.();
    } catch {
      /* el panel ya se limpio */
    }
  };
}
