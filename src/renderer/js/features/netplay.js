// Jugar con amigos sin abrir puertos:
//  - openWorldToFriends(instanceId): abrir un mundo de un jugador a amigos (e4mc o túnel de Venus al puerto LAN)
//  - serverNetPanel(serverId) -> Element: direcciones, UPnP, túnel (bore / playit.gg) y consejos de seguridad
//  - startup(): escucha las invitaciones 'join-world' que mandan los amigos
import { h, icon, mount, modal, ok, fail, toast, copyText, ensureCss, emptyState, switchEl, registerIcons, instanceIcon, instanceLoaderKey, loaderBadge, avatarImg, fmtTime, skeleton, setBusy } from '../ui.js';
import { store, api } from '../store.js';
import { t, loadNs } from '../i18n.js';
import { navigate, launchInstance } from '../app.js';
import { cloud } from '../cloud.js';

registerIcons({
  npRouter: '<rect width="20" height="8" x="2" y="14" rx="2"/><path d="M6.01 18H6"/><path d="M10.01 18H10"/><path d="M15 10v4"/><path d="M17.84 7.17a4 4 0 0 0-5.66 0"/><path d="M20.66 4.34a8 8 0 0 0-11.31 0"/>',
  npOrbit: '<circle cx="12" cy="12" r="3"/><circle cx="19" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><path d="M10.4 21.9a10 10 0 0 0 9.941-15.416"/><path d="M13.5 2.1a10 10 0 0 0-9.841 15.416"/>',
});

const NS = 'netplay';
let readyPromise = null;

// social.js se carga aparte: si el modulo de amigos falla, el resto de esta funcion sigue andando
let social = null;
let socialPromise = null;
function loadSocial() {
  if (!socialPromise) {
    socialPromise = import('../social.js')
      .then((m) => (social = m.social || null))
      .catch((err) => {
        console.warn('[netplay] amigos no disponibles', err);
        return null;
      });
  }
  return socialPromise;
}

function prepare() {
  ensureCss('features/netplay');
  if (!readyPromise) readyPromise = loadNs(NS).catch((err) => console.warn('[netplay] textos', err));
  return readyPromise;
}

const call = (name, ...args) => api.invoke(`netplay:${name}`, ...args);
const isMissing = (err) => /No handler registered/i.test(err?.message || '');
const PROVIDER_HOST = 'bore.pub';

// ---------- Piezas comunes ----------

function copyBtn(text, label = t('netplay.copy')) {
  return h('button', { class: 'icon-btn sm', title: label, 'aria-label': label, onclick: () => copyText(text, t('netplay.copied')) }, icon('copy'));
}

// Dirección grande (la que se comparte con amigos)
function addressDisplay(address, { placeholder, waiting = false } = {}) {
  if (!address) {
    return h('div', { class: ['np-address', 'empty', waiting && 'waiting'], role: 'status' }, waiting ? h('span', { class: 'np-pulse', 'aria-hidden': 'true' }) : icon('globe'), h('span', { class: 'np-address-text' }, placeholder || t('netplay.addressPending')));
  }
  return h('div', { class: 'np-address', role: 'status' }, icon('globe'), h('span', { class: 'np-address-text selectable', title: address }, address), copyBtn(address, t('netplay.copyAddress')));
}

function statusPill(kind, text, iconName) {
  return h('span', { class: ['pill', kind] }, iconName ? icon(iconName) : h('span', { class: ['np-dot', kind] }), text);
}

function tunnelPill(tun) {
  if (!tun) return statusPill('', t('netplay.tunnelOff'));
  switch (tun.status) {
    case 'online':
      return statusPill('good', t('netplay.tunnelOnline'));
    case 'connecting':
      return statusPill('warn', t('netplay.tunnelConnecting'));
    case 'reconnecting':
      return statusPill('warn', t('netplay.tunnelReconnecting'));
    case 'error':
      return statusPill('bad', t('netplay.tunnelError'), 'alert');
    default:
      return statusPill('', t('netplay.tunnelOff'));
  }
}

function verifiedLine(tun) {
  const v = tun?.verified;
  if (!v || tun.status !== 'online') return null;
  if (v.ok) return h('span', { class: 'np-verified good' }, icon('shieldCheck'), t('netplay.verifiedOk', { ms: v.latency }));
  return h('span', { class: 'np-verified bad', title: v.error || '' }, icon('alert'), t('netplay.verifiedFail'));
}

// Guarda y restaura el foco al redibujar (data-fk = clave estable del control)
function keepFocus(container, fn) {
  const key = document.activeElement && container.contains(document.activeElement) ? document.activeElement.dataset?.fk : null;
  fn();
  if (key) container.querySelector(`[data-fk="${key}"]`)?.focus();
}

// ---------- Amigos: enviar la dirección y recibir invitaciones ----------

function myName() {
  const p = cloud.profile;
  return p?.display_name || p?.username || store.selectedAccount()?.name || '';
}

function friendList() {
  let raw;
  if (!social) return [];
  try {
    raw = social.friends;
    if (typeof raw === 'function') raw = raw.call(social);
  } catch {
    raw = null;
  }
  const arr = Array.isArray(raw) ? raw : raw instanceof Map ? [...raw.values()] : raw && typeof raw === 'object' ? Object.values(raw) : [];
  return arr
    .map((f) => {
      if (!f || typeof f !== 'object') return null;
      const p = f.profile || f.friend || f;
      const id = p.id || f.userId || f.user_id || f.friend_id || f.id;
      const name = p.display_name || p.displayName || p.username || p.name || f.name || p.mc_name;
      let online = false;
      try {
        const pr = social?.presenceOf?.(id);
        online = Boolean(pr && (pr === 'online' || pr.online || ['online', 'playing', 'ingame', 'away'].includes(pr.status || pr.state)));
      } catch {
        online = false;
      }
      return id && name ? { id: String(id), name: String(name), mcName: p.mc_name || p.mcName || null, online } : null;
    })
    .filter(Boolean)
    .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
}

async function openSendDialog(address, meta = {}) {
  await Promise.all([prepare(), loadSocial()]);
  await Promise.resolve(cloud.ready()).catch(() => {});
  const box = h('div', { class: 'np-send' });
  const m = modal({ title: t('netplay.sendTitle'), body: box, footer: [h('button', { class: 'btn ghost', onclick: () => m.close() }, t('netplay.close'))] });
  const head = h('div', { class: 'np-send-head' }, h('div', { class: 'small muted' }, t('netplay.sendAddressLabel')), addressDisplay(address));
  const signedIn = Boolean(cloud.isConfigured?.() && cloud.isSignedIn?.());
  if (!signedIn) {
    const configured = Boolean(cloud.isConfigured?.());
    mount(
      box,
      head,
      emptyState(
        'users',
        t(configured ? 'netplay.sendNeedsLogin' : 'netplay.sendNeedsCloud'),
        t('netplay.sendNeedsAccountText'),
        h('button', { class: 'btn primary', onclick: () => (m.close(), navigate('settings/cloud')) }, icon('logIn'), t('netplay.goToCloud')),
      ),
    );
    return;
  }
  if (typeof social?.sendSignal !== 'function') {
    mount(box, head, emptyState('users', t('netplay.sendUnavailable'), t('netplay.sendUnavailableText')));
    return;
  }
  const friends = friendList();
  if (!friends.length) {
    mount(box, head, emptyState('userPlus', t('netplay.noFriends'), t('netplay.noFriendsText'), h('button', { class: 'btn', onclick: () => (m.close(), navigate('messages')) }, icon('message'), t('netplay.goToFriends'))));
    return;
  }
  const payload = { address, kind: meta.kind || 'world', name: meta.name || null, mcVersion: meta.mcVersion || null, loader: meta.loader || null, from: myName() || null, fromMc: cloud.profile?.mc_name || store.selectedAccount()?.name || null };
  const rows = friends.map((f) => {
    const btn = h('button', { class: 'btn sm', 'aria-label': t('netplay.sendTo', { name: f.name }) }, icon('send'), t('netplay.send'));
    btn.addEventListener('click', async () => {
      // Mientras se envia: spinner en lugar del icono y el texto "Enviando..."
      mount(btn, icon('send'), t('netplay.sending'));
      const release = setBusy(btn);
      try {
        await social.sendSignal(f.id, 'join-world', payload);
        release();
        mount(btn, icon('check'), t('netplay.sent'));
        btn.classList.add('good');
        btn.disabled = true;
        ok(t('netplay.sentTitle'), t('netplay.sentText', { name: f.name }));
      } catch (err) {
        release();
        mount(btn, icon('send'), t('netplay.send'));
        fail(t('netplay.sendFailed'), err);
      }
    });
    return h(
      'div',
      { class: 'list-item np-friend', role: 'listitem' },
      h('div', { class: 'np-friend-av' }, avatarImg(f.mcName || f.name, 64, ''), h('span', { class: ['status-dot', f.online && 'online'], title: f.online ? t('netplay.friendOnline') : t('netplay.friendOffline'), 'aria-hidden': 'true' })),
      h('div', { class: 'li-main' }, h('div', { class: 'li-title', title: f.name }, f.name), h('div', { class: 'li-sub' }, f.online ? t('netplay.friendOnline') : t('netplay.friendOffline'))),
      btn,
    );
  });
  mount(box, head, h('div', { class: 'np-friends list', role: 'list' }, rows));
}

function friendNameById(id) {
  if (!id) return null;
  return friendList().find((f) => f.id === String(id))?.name || null;
}

const ADDRESS_RE = /^[a-z0-9.-]{1,253}(?::\d{1,5})?$/i;

// Invitaciones que llegan por señal: la misma dirección del mismo amigo se ignora durante 30 s y cada amigo abre
// como mucho 3 avisos por minuto, de a uno (si no, un amigo con señales en bucle tapa la ventana de diálogos)
const INVITE_REPEAT_MS = 30000;
const INVITE_WINDOW_MS = 60000;
const INVITE_MAX = 3;
const inviteLog = new Map(); // remitente -> [{ at, address }]
const inviteOpen = new Map(); // remitente -> diálogo abierto

function inviteAllowed(sender, address) {
  const now = Date.now();
  const recent = (inviteLog.get(sender) || []).filter((x) => now - x.at < INVITE_WINDOW_MS);
  const allowed = recent.length < INVITE_MAX && !recent.some((x) => x.address === address && now - x.at < INVITE_REPEAT_MS);
  if (allowed) recent.push({ at: now, address });
  inviteLog.set(sender, recent);
  return allowed;
}

async function showInvite(a, b, { fromSignal = false } = {}) {
  await Promise.all([prepare(), loadSocial()]);
  // social.js entrega { type, from, fromId, profile, payload } con el remitente que puso el servidor (la forma vieja
  // es (payload, fromId)). El from/fromMc del payload lo escribe quien manda: nunca se muestra como remitente.
  const evt = a && typeof a === 'object' && !('address' in a) && a.payload && typeof a.payload === 'object' ? a : null;
  const payload = evt ? evt.payload : a && typeof a === 'object' ? a : {};
  const fromId = typeof b === 'string' ? b : b?.id || (typeof evt?.fromId === 'string' ? evt.fromId : null);
  const address = String(payload.address || '').trim();
  if (!ADDRESS_RE.test(address)) return;
  const sender = fromId || '?';
  if (fromSignal && !inviteAllowed(sender, address.toLowerCase())) return;
  const name = String(friendNameById(fromId) || (typeof evt?.from === 'string' ? evt.from : '') || t('netplay.aFriend')).slice(0, 40);
  const version = typeof payload.mcVersion === 'string' && /^[\w.+-]{1,32}$/.test(payload.mcVersion) ? payload.mcVersion : null;
  const what = payload.kind === 'server' ? t('netplay.inviteServer', { name }) : t('netplay.inviteWorld', { name });
  const join = async () => {
    m.close();
    try {
      const mod = await import('./serverlist.js');
      await mod.joinServer(address, {});
    } catch (err) {
      console.warn('[netplay] unirse', err);
      copyText(address, t('netplay.copied'));
    }
  };
  // Un solo aviso abierto por amigo: el nuevo reemplaza al anterior
  inviteOpen.get(sender)?.close();
  const m = modal({
    title: t('netplay.inviteTitle'),
    body: h(
      'div',
      { class: 'np-invite' },
      h('div', { class: 'row np-invite-head' }, avatarImg(evt?.profile?.mc_name || name, 64, 'np-invite-av'), h('div', { class: 'spacer' }, h('div', { class: 'np-invite-text' }, what), version ? h('div', { class: 'small muted' }, t('netplay.inviteVersion', { version })) : null)),
      addressDisplay(address),
      h('div', { class: 'small muted' }, t('netplay.inviteHint')),
    ),
    footer: [h('button', { class: 'btn ghost', onclick: () => m.close() }, t('netplay.notNow')), h('button', { class: 'btn', onclick: () => copyText(address, t('netplay.copied')) }, icon('copy'), t('netplay.copy')), h('button', { class: 'btn primary', onclick: join }, icon('play'), t('netplay.join'))],
    onClose: () => {
      if (inviteOpen.get(sender) === m) inviteOpen.delete(sender);
    },
  });
  inviteOpen.set(sender, m);
}

// Muestra una invitación 'join-world' (la usa startup(); también sirve para invitaciones guardadas en el chat).
export function showWorldInvite(payload, fromId = null) {
  return showInvite(payload, fromId);
}

let started = false;
export async function startup() {
  if (started) return;
  started = true;
  const s = await loadSocial();
  try {
    if (typeof s?.onSignal === 'function') s.onSignal('join-world', (a, b) => showInvite(a, b, { fromSignal: true }).catch((err) => console.warn('[netplay] invitación', err)));
  } catch (err) {
    console.warn('[netplay] señales', err);
  }
}

// ---------- Mundo de un jugador para amigos ----------

function lanKeys() {
  return h('span', { class: 'np-keys' }, h('span', { class: 'kbd' }, 'Esc'), icon('chevronRight'), h('span', { class: 'kbd' }, t('netplay.mcOpenToLan')), icon('chevronRight'), h('span', { class: 'kbd' }, t('netplay.mcStartLan')));
}

function step(n, status, title, text, side, extra) {
  return h(
    'li',
    { class: ['np-step', status, !side && 'noside'] },
    h('div', { class: 'np-step-num', 'aria-hidden': 'true' }, status === 'done' ? icon('check') : String(n)),
    h('div', { class: 'np-step-main' }, h('div', { class: 'np-step-title' }, title), text ? h('div', { class: 'np-step-text' }, text) : null, extra || null),
    side ? h('div', { class: 'np-step-side' }, side) : null,
  );
}

export async function openWorldToFriends(instanceId) {
  await prepare();
  let inst = store.instances.find((i) => i.id === instanceId);
  if (!inst) inst = await api.instances.get(instanceId).catch(() => null);
  if (!inst) {
    fail(t('netplay.instanceMissing'));
    return null;
  }
  const st = { status: null, world: null, method: null, loadError: null, unavailable: false, installing: false, toggling: false, sinceLan: 0 };
  // Esqueleto con la forma del dialogo (cabecera y pasos) mientras se consulta el estado
  const bone = (cls) => h('span', { class: `skeleton ${cls}` });
  const worldSkeleton = () =>
    h(
      'div',
      { class: 'skeleton-group', role: 'status', 'aria-live': 'polite', 'aria-busy': 'true' },
      h('span', { class: 'sr-only' }, t('common.loading')),
      h(
        'div',
        { class: 'skeleton-shapes np-skel', 'aria-hidden': 'true' },
        bone('np-skel-head'),
        [0, 1, 2].map(() => h('div', { class: 'np-skel-step' }, bone('np-skel-num'), h('div', { class: 'skeleton-lines' }, bone('skeleton-line title'), bone('skeleton-line')))),
      ),
    );
  const body = h('div', { class: 'np-world' }, worldSkeleton());
  const offs = [];
  let lanTimer = null;
  const m = modal({
    title: t('netplay.worldTitle'),
    icon: 'globe',
    size: 'wide',
    body,
    footer: [h('button', { class: 'btn ghost', 'data-fk': 'close', onclick: () => m.close() }, t('netplay.close'))],
    onClose: () => {
      offs.forEach((off) => off());
      clearTimeout(lanTimer);
    },
  });

  const running = () => store.running[instanceId]?.state === 'running' || Boolean(st.world?.running);
  const e4mcCapable = () => ['fabric', 'quilt', 'forge', 'neoforge'].includes(inst.loader);

  const load = async () => {
    try {
      const s = await call('e4mcStatus', instanceId);
      st.status = s;
      st.world = { ...(st.world || {}), ...s };
      if (!st.method) st.method = s.supported === false ? 'tunnel' : 'e4mc';
      if (s.autoTunnel && st.method !== 'tunnel' && !s.domain) st.method = 'tunnel';
      st.loadError = null;
    } catch (err) {
      if (isMissing(err)) st.unavailable = true;
      else st.loadError = err.message;
      if (!st.method) st.method = e4mcCapable() ? 'e4mc' : 'tunnel';
    }
    render();
  };

  const install = async () => {
    st.installing = true;
    render();
    try {
      const r = await call('e4mcSetup', instanceId);
      if (r.alreadyInstalled && !r.enabledNow) ok(t('netplay.e4mcAlready'));
      else ok(t('netplay.e4mcInstalledTitle'), r.restartNeeded ? t('netplay.e4mcRestart') : t('netplay.e4mcInstalledText'));
      store.refreshInstances?.().catch(() => {});
    } catch (err) {
      fail(t('netplay.e4mcInstallFailed'), err);
    } finally {
      st.installing = false;
      await load();
    }
  };

  const setAutoTunnel = async (enabled) => {
    st.toggling = true;
    render();
    try {
      st.world = { ...(st.world || {}), ...(await call('worldTunnel', instanceId, enabled)) };
    } catch (err) {
      fail(t('netplay.tunnelFailed'), err);
    } finally {
      st.toggling = false;
      render();
    }
  };

  const play = () => {
    launchInstance(instanceId);
    render();
  };

  function methodPicker() {
    if (!e4mcCapable()) return null;
    const opt = (id, iconName, label) => h('button', { class: st.method === id ? 'active' : '', 'aria-pressed': String(st.method === id), 'data-fk': `m-${id}`, onclick: () => ((st.method = id), render()) }, icon(iconName), label);
    return h('div', { class: 'np-method' }, h('span', { class: 'label' }, t('netplay.methodLabel')), h('div', { class: 'segmented', role: 'group', 'aria-label': t('netplay.methodLabel') }, opt('e4mc', 'zap', t('netplay.methodE4mc')), opt('tunnel', 'npOrbit', t('netplay.methodTunnel'))));
  }

  function e4mcSteps() {
    const s = st.status || {};
    const w = st.world || {};
    const isRunning = running();
    const installed = Boolean(s.installed);
    const lan = w.lanPort;
    const domain = w.domain;
    const task = store.taskFor?.(instanceId);
    let installSide;
    let installText = installed ? t('netplay.stepInstallDone') : t('netplay.stepInstallText');
    let installStatus = installed ? 'done' : 'active';
    if (installed) installSide = statusPill('good', s.versionNumber ? t('netplay.e4mcVersion', { version: s.versionNumber }) : t('netplay.installed'));
    else if (st.installing || (task && /e4mc/i.test(task.title || ''))) installSide = h('span', { class: 'np-inline-status' }, h('span', { class: 'spinner np-spin' }), task?.progress ? `${Math.round(task.progress * 100)}%` : t('netplay.installing'));
    else if (s.disabled) installSide = h('button', { class: 'btn primary sm', 'data-fk': 'install', onclick: install }, icon('power'), t('netplay.enableE4mc'));
    else if (s.reason === 'version') {
      installStatus = 'blocked';
      installText = t('netplay.e4mcNoVersion', { version: inst.mcVersion });
      installSide = h('button', { class: 'btn sm', 'data-fk': 'to-tunnel', onclick: () => ((st.method = 'tunnel'), render()) }, icon('npOrbit'), t('netplay.useTunnel'));
    } else installSide = h('button', { class: 'btn primary sm', 'data-fk': 'install', disabled: !s.available && !s.lookupError, onclick: install }, icon('download'), t('netplay.installE4mc'));
    const restartNote = installed && isRunning && s.restartNeeded ? h('div', { class: 'np-note warn' }, icon('alert'), t('netplay.e4mcRestart')) : null;

    const playStatus = isRunning ? 'done' : installed ? 'active' : 'todo';
    const playSide = isRunning ? statusPill('good', t('netplay.gameRunning')) : h('button', { class: 'btn sm', 'data-fk': 'play', disabled: !installed && installStatus !== 'blocked', onclick: play }, icon('play'), t('netplay.play'));

    const lanStatus = lan ? 'done' : isRunning ? 'active' : 'todo';
    const lanSide = lan ? statusPill('good', t('netplay.lanOpen', { port: lan })) : isRunning ? h('span', { class: 'np-inline-status muted' }, h('span', { class: 'np-pulse', 'aria-hidden': 'true' }), t('netplay.waitingLan')) : null;

    const addrStatus = domain ? 'done' : lan ? 'active' : 'todo';
    const slow = lan && !domain && st.sinceLan && Date.now() - st.sinceLan > 20000;
    const addrExtra = h(
      'div',
      { class: 'np-step-extra' },
      addressDisplay(domain, { waiting: Boolean(lan && !domain), placeholder: lan ? t('netplay.waitingDomain') : t('netplay.addressPending') }),
      w.error === 'e4mc' ? h('div', { class: 'np-note bad' }, icon('alert'), t('netplay.e4mcError')) : slow ? h('div', { class: 'np-note' }, icon('info'), t('netplay.e4mcSlow')) : null,
      domain ? shareRow(domain) : null,
    );
    return [
      step(1, installStatus, t('netplay.stepInstall'), installText, installSide, restartNote),
      step(2, playStatus, t('netplay.stepPlay'), t('netplay.stepPlayText'), playSide),
      step(3, lanStatus, t('netplay.stepLan'), null, lanSide, h('div', { class: 'np-step-text' }, lanKeys())),
      step(4, addrStatus, t('netplay.stepShare'), t('netplay.stepShareE4mc'), null, addrExtra),
    ];
  }

  function tunnelSteps() {
    const w = st.world || {};
    const isRunning = running();
    const auto = Boolean(w.autoTunnel);
    const lan = w.lanPort;
    const tun = w.tunnel && w.tunnel.status !== 'stopped' ? w.tunnel : null;
    const address = tun?.status === 'online' || tun?.status === 'reconnecting' ? tun.publicAddress : null;
    const autoSwitch = switchEl(auto, (v) => setAutoTunnel(v), t('netplay.stepTunnel'));
    const autoInput = autoSwitch.querySelector('input');
    autoInput.dataset.fk = 'auto-tunnel';
    if (st.toggling) autoInput.disabled = true;
    const addrExtra = h(
      'div',
      { class: 'np-step-extra' },
      addressDisplay(address, { waiting: Boolean(auto && lan && !address), placeholder: auto && lan ? t('netplay.tunnelConnecting') : t('netplay.addressPending') }),
      tun ? h('div', { class: 'row wrap np-tunnel-meta' }, tunnelPill(tun), verifiedLine(tun), tun.connections ? h('span', { class: 'small muted' }, t('netplay.connections', { count: tun.connections })) : null) : null,
      w.tunnelError ? h('div', { class: 'np-note bad' }, icon('alert'), w.tunnelError, h('button', { class: 'btn sm', 'data-fk': 'retry', onclick: () => setAutoTunnel(true) }, icon('refresh'), t('netplay.retry'))) : null,
      address ? shareRow(address) : null,
    );
    return [
      step(1, auto ? 'done' : 'active', t('netplay.stepTunnel'), t('netplay.stepTunnelText', { host: PROVIDER_HOST }), autoSwitch),
      step(2, isRunning ? 'done' : auto ? 'active' : 'todo', t('netplay.stepPlay'), t('netplay.stepPlayText'), isRunning ? statusPill('good', t('netplay.gameRunning')) : h('button', { class: 'btn sm', 'data-fk': 'play', onclick: play }, icon('play'), t('netplay.play'))),
      step(3, lan ? 'done' : isRunning ? 'active' : 'todo', t('netplay.stepLan'), null, lan ? statusPill('good', t('netplay.lanOpen', { port: lan })) : isRunning ? h('span', { class: 'np-inline-status muted' }, h('span', { class: 'np-pulse', 'aria-hidden': 'true' }), t('netplay.waitingLan')) : null, h('div', { class: 'np-step-text' }, lanKeys())),
      step(4, address ? 'done' : lan && auto ? 'active' : 'todo', t('netplay.stepShare'), t('netplay.stepShareTunnel'), null, addrExtra),
    ];
  }

  function shareRow(address) {
    return h(
      'div',
      { class: 'row wrap np-share' },
      h('button', { class: 'btn primary sm', 'data-fk': 'send', onclick: () => openSendDialog(address, { kind: 'world', name: inst.name, mcVersion: inst.mcVersion, loader: inst.loader }) }, icon('send'), t('netplay.sendToFriend')),
      h('button', { class: 'btn sm', 'data-fk': 'copy', onclick: () => copyText(address, t('netplay.copied')) }, icon('copy'), t('netplay.copyAddress')),
    );
  }

  function render() {
    keepFocus(body, () => {
      if (st.unavailable) {
        mount(body, emptyState('npOrbit', t('netplay.unavailable'), t('netplay.unavailableText')));
        return;
      }
      if (!st.status && !st.loadError) {
        mount(body, worldSkeleton());
        return;
      }
      const isRunning = running();
      const head = h(
        'div',
        { class: 'np-world-head' },
        instanceIcon(inst, 'np-inst-icon'),
        h(
          'div',
          { class: 'spacer', style: { minWidth: 0 } },
          h('div', { class: 'np-world-name ellipsis' }, inst.name),
          h('div', { class: 'row wrap np-world-meta' }, h('span', { class: 'badge' }, icon('box'), `Minecraft ${inst.mcVersion}`), loaderBadge(instanceLoaderKey(inst)), isRunning ? statusPill('good', t('netplay.gameRunning')) : statusPill('', t('netplay.gameClosed'))),
        ),
      );
      const intro = h('p', { class: 'np-intro' }, st.method === 'e4mc' ? t('netplay.introE4mc') : t('netplay.introTunnel'));
      const noE4mc = !e4mcCapable()
        ? h(
            'div',
            { class: 'notice info np-alt' },
            icon('info'),
            h('div', { class: 'spacer' }, h('div', {}, t(inst.loader === 'optifine' ? 'netplay.noE4mcOptifine' : inst.loader === 'vanilla' ? 'netplay.noE4mcVanilla' : 'netplay.noE4mcLoader')), h('div', { class: 'small np-alt-sub' }, t('netplay.altServer'))),
            h('button', { class: 'btn sm', 'data-fk': 'to-servers', onclick: () => (m.close(), navigate('servers')) }, icon('server'), t('netplay.goToServers')),
          )
        : null;
      mount(
        body,
        head,
        methodPicker(),
        noE4mc,
        intro,
        st.loadError
          ? h(
              'div',
              { class: 'notice bad np-load-error' },
              icon('alert'),
              h('div', {}, st.loadError),
              h('button', { class: 'btn sm', 'data-fk': 'reload', onclick: (e) => (setBusy(e.currentTarget), load()) }, icon('refresh'), t('netplay.retry')),
            )
          : null,
        h('ol', { class: 'np-steps' }, st.method === 'e4mc' && e4mcCapable() ? e4mcSteps() : tunnelSteps()),
        h('div', { class: 'np-tip' }, icon('users'), h('span', {}, t('netplay.friendsTip', { version: inst.mcVersion }), e4mcCapable() ? ` ${t('netplay.friendsTipMods')}` : '')),
      );
    });
  }

  const onWorld = (snap) => {
    if (snap?.instanceId !== instanceId) return;
    if (snap.lanPort && !st.world?.lanPort) {
      st.sinceLan = Date.now();
      clearTimeout(lanTimer);
      lanTimer = setTimeout(render, 21000);
    }
    st.world = { ...(st.world || {}), ...snap };
    render();
  };
  offs.push(
    api.on('netplay:world', onWorld),
    api.on('netplay:e4mcDomain', (id, domain) => {
      if (id !== instanceId) return;
      st.world = { ...(st.world || {}), domain };
      render();
    }),
    api.on('netplay:tunnel', (snap) => {
      if (snap?.instanceId !== instanceId) return;
      st.world = { ...(st.world || {}), tunnel: snap.status === 'stopped' ? null : snap };
      render();
    }),
    store.on('running', () => render()),
    store.on('task', (task) => {
      if (task?.meta?.instanceId === instanceId && /e4mc/i.test(task.title || '')) render();
    }),
  );
  load();
  return m;
}

// ---------- Panel de conexión de un servidor local ----------

export function serverNetPanel(serverId) {
  const root = h('div', { class: 'np-panel', 'aria-busy': 'true' }, h('div', { class: 'card' }, skeleton('card', { lines: 3 })));
  const offs = [];
  let disposed = false;
  let seen = false;
  const born = Date.now();
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearInterval(watch);
    offs.forEach((off) => off());
  };
  // Sin hook de limpieza en el contrato: se limpia solo cuando el elemento sale del documento
  const watch = setInterval(() => {
    if (root.isConnected) seen = true;
    else if (seen || Date.now() - born > 60000) dispose();
  }, 2000);
  root.destroy = dispose;
  prepare()
    .then(() => buildServerPanel(root, serverId, offs, () => disposed))
    .catch((err) => {
      console.error('[netplay]', err);
      mount(root, h('div', { class: 'notice bad' }, icon('alert'), err.message));
    });
  return root;
}

async function buildServerPanel(root, serverId, offs, isDisposed) {
  const md = { srv: null, state: 'offline', prefs: null, addrs: null, addrsError: null, upnp: null, tunnel: null, bore: null, props: null, playit: null, provider: 'bore', busy: {}, unavailable: false, test: null };
  try {
    md.srv = await api.servers.get(serverId);
  } catch (err) {
    mount(root, emptyState('alert', t('netplay.serverMissing'), err.message));
    root.removeAttribute('aria-busy');
    return;
  }
  md.state = md.srv.state || 'offline';
  const port = () => md.srv.port || 25565;

  const cTunnel = h('section', { class: 'card np-card np-hero np-span', 'aria-labelledby': `np-tun-${serverId}` });
  const cAddr = h('section', { class: 'card np-card' });
  const cUpnp = h('section', { class: 'card np-card' });
  const cSafety = h('section', { class: 'card np-card np-span' });
  mount(root, h('div', { class: 'np-grid' }, cTunnel, cAddr, cUpnp, cSafety));
  root.removeAttribute('aria-busy');

  const live = () => md.state === 'online' || md.state === 'starting';

  // --- Datos ---
  const loadPrefs = async () => {
    try {
      md.prefs = await call('serverPrefs', serverId);
      if (md.prefs.customAddress && !md.tunnel) md.provider = 'playit';
    } catch (err) {
      if (isMissing(err)) md.unavailable = true;
      md.prefs = md.prefs || { upnp: false, voice: false, tunnelAuto: false, customAddress: null, voiceChat: { installed: false } };
    }
  };
  const loadTunnel = async () => {
    try {
      const list = await call('tunnels');
      md.tunnel = list.find((x) => x.serverId === serverId) || list.find((x) => !x.instanceId && x.localPort === port()) || null;
    } catch (err) {
      if (isMissing(err)) md.unavailable = true;
    }
  };
  await Promise.all([
    loadPrefs(),
    loadTunnel(),
    call('boreConfig').then((b) => (md.bore = b)).catch(() => {}),
    call('playitInfo').then((p) => (md.playit = p)).catch(() => {}),
    api.servers.properties(serverId).then((p) => (md.props = p)).catch(() => (md.props = {})),
  ]);
  if (isDisposed()) return;
  if (md.tunnel) md.provider = 'bore';

  // --- Tarjeta: túnel ---
  function renderTunnel() {
    keepFocus(cTunnel, () => {
      const seg = (id, label) => h('button', { class: md.provider === id ? 'active' : '', 'aria-pressed': String(md.provider === id), 'data-fk': `prov-${id}`, onclick: () => ((md.provider = id), renderTunnel()) }, label);
      const head = h(
        'div',
        { class: 'np-card-head' },
        h('div', { class: 'np-card-icon', 'aria-hidden': 'true' }, icon('npOrbit')),
        h('div', { class: 'spacer', style: { minWidth: 0 } }, h('h3', { class: 'np-card-title', id: `np-tun-${serverId}` }, t('netplay.tunnelTitle')), h('p', { class: 'np-card-sub' }, t('netplay.tunnelSub'))),
        h('div', { class: 'segmented np-provider', role: 'group', 'aria-label': t('netplay.providerLabel') }, seg('bore', md.bore?.host || PROVIDER_HOST), seg('playit', 'playit.gg')),
      );
      if (md.unavailable) {
        mount(cTunnel, head, h('div', { class: 'notice' }, icon('alert'), t('netplay.unavailableText')));
        return;
      }
      mount(cTunnel, head, md.provider === 'playit' ? playitBody() : boreBody());
    });
  }

  function boreBody() {
    const tun = md.tunnel && md.tunnel.status !== 'stopped' ? md.tunnel : null;
    const host = md.bore?.host || PROVIDER_HOST;
    const address = tun && (tun.status === 'online' || tun.status === 'reconnecting') ? tun.publicAddress : null;
    const connecting = md.busy.start || tun?.status === 'connecting';
    let main;
    if (address) {
      main = h(
        'div',
        { class: 'np-tunnel-live' },
        addressDisplay(address),
        h(
          'div',
          { class: 'row wrap np-actions' },
          h('button', { class: 'btn primary', 'data-fk': 'send', onclick: () => openSendDialog(address, { kind: 'server', name: md.srv.name, mcVersion: md.srv.mcVersion, loader: md.srv.type }) }, icon('send'), t('netplay.sendToFriend')),
          h('button', { class: 'btn', 'data-fk': 'copy', onclick: () => copyText(address, t('netplay.copied')) }, icon('copy'), t('netplay.copyAddress')),
          h('button', { class: 'btn', 'data-fk': 'verify', disabled: Boolean(md.busy.verify), onclick: verify }, md.busy.verify ? h('span', { class: 'spinner np-spin' }) : icon('activity'), t('netplay.verify')),
          h('span', { class: 'spacer' }),
          h('button', { class: 'btn danger', 'data-fk': 'stop', onclick: stopTunnel }, icon('stop'), t('netplay.stopTunnel')),
        ),
        h(
          'div',
          { class: 'row wrap np-tunnel-meta' },
          tunnelPill(tun),
          verifiedLine(tun),
          h('span', { class: 'small muted' }, t('netplay.connections', { count: tun.connections || 0 })),
          tun.startedAt ? h('span', { class: 'small muted' }, t('netplay.since', { time: fmtTime(tun.startedAt) })) : null,
        ),
        tun.warning?.code === 'localUnreachable' && Date.now() - (tun.warning.at || 0) < 120000 ? h('div', { class: 'np-note warn' }, icon('alert'), t('netplay.localUnreachable', { port: tun.localPort })) : null,
        tun.status === 'reconnecting' ? h('div', { class: 'np-note' }, icon('refresh'), t('netplay.reconnectingText')) : null,
      );
    } else {
      // Con el servidor apagado el boton no es la accion principal: la ayuda de al lado explica que falta
      const startBtn = h('button', { class: live() || connecting ? 'btn primary lg' : 'btn lg', 'data-fk': 'start', disabled: connecting || !live(), 'aria-describedby': `np-cta-${serverId}`, onclick: startTunnel }, connecting ? h('span', { class: 'spinner np-spin', 'aria-hidden': 'true' }) : icon('npOrbit'), connecting ? t('netplay.connectingTo', { host }) : t('netplay.startTunnel'));
      main = h(
        'div',
        { class: 'np-tunnel-idle' },
        h('div', { class: 'np-tunnel-cta' }, startBtn, h('div', { class: 'small muted np-cta-hint', id: `np-cta-${serverId}` }, live() ? t('netplay.tunnelHint', { host }) : t('netplay.tunnelNeedsServer'))),
        tun?.status === 'error' ? h('div', { class: 'np-note bad' }, icon('alert'), tun.error || t('netplay.tunnelError')) : null,
      );
    }
    const autoRow = h(
      'div',
      { class: 'toggle-row np-auto' },
      h('div', { class: 'tr-text' }, h('div', { class: 'tr-title' }, t('netplay.tunnelAuto')), h('div', { class: 'tr-sub' }, t('netplay.tunnelAutoSub'))),
      fkSwitch(Boolean(md.prefs?.tunnelAuto), (v) => savePrefs({ tunnelAuto: v }), t('netplay.tunnelAuto'), 'tunnel-auto'),
    );
    return h('div', { class: 'np-hero-body' }, main, autoRow, h('div', { class: 'np-fineprint' }, icon('info'), t('netplay.boreNote', { host })));
  }

  let playitInput = null;
  function playitBody() {
    const local = `127.0.0.1:${port()}`;
    const saved = md.prefs?.customAddress || null;
    if (!playitInput) {
      playitInput = h('input', { class: 'input', 'data-fk': 'playit-input', placeholder: t('netplay.playitPlaceholder'), maxlength: 260, 'aria-label': t('netplay.playitPaste'), spellcheck: 'false' });
      playitInput.addEventListener('keydown', (e) => e.key === 'Enter' && playitInput.value.trim() && saveAddr(playitInput.value.trim()));
    }
    const input = playitInput;
    const saveAddr = async (value) => {
      try {
        const r = await call('setServerPrefs', serverId, { customAddress: value });
        md.prefs = { ...md.prefs, ...r.prefs };
        md.test = null;
        if (value) input.value = '';
        renderTunnel();
        renderAddr();
        if (value) ok(t('netplay.playitSaved'));
      } catch (err) {
        fail(t('netplay.saveFailed'), err);
      }
    };
    const open = (url) => url && api.app.openExternal(url).catch((err) => fail(t('netplay.openFailed'), err));
    const guide = h(
      'ol',
      { class: 'np-guide' },
      h('li', {}, h('div', {}, t('netplay.playitStep1')), h('button', { class: 'btn sm', onclick: () => open(md.playit?.downloadUrl) }, icon('external'), t('netplay.playitDownload'))),
      h('li', {}, h('div', {}, t('netplay.playitStep2')), h('div', { class: 'row' }, h('span', { class: 'kbd selectable' }, local), copyBtn(local), h('button', { class: 'btn sm ghost', onclick: () => open(md.playit?.dashboardUrl) }, icon('external'), t('netplay.playitDashboard')))),
      h('li', {}, h('div', {}, t('netplay.playitStep3')), h('div', { class: 'row' }, input, h('button', { class: 'btn sm primary', onclick: () => input.value.trim() && saveAddr(input.value.trim()) }, icon('save'), t('netplay.save')))),
    );
    const testRes = md.test && md.test.address === saved ? md.test : null;
    const savedBox = saved
      ? h(
          'div',
          { class: 'np-tunnel-live' },
          addressDisplay(saved),
          h(
            'div',
            { class: 'row wrap np-actions' },
            h('button', { class: 'btn primary', 'data-fk': 'send-playit', onclick: () => openSendDialog(saved, { kind: 'server', name: md.srv.name, mcVersion: md.srv.mcVersion, loader: md.srv.type }) }, icon('send'), t('netplay.sendToFriend')),
            h('button', { class: 'btn', 'data-fk': 'test-playit', disabled: Boolean(md.busy.test), onclick: () => testAddress(saved) }, md.busy.test ? h('span', { class: 'spinner np-spin' }) : icon('activity'), t('netplay.verify')),
            h('span', { class: 'spacer' }),
            h('button', { class: 'btn ghost', 'data-fk': 'forget', onclick: () => saveAddr(null) }, icon('trash'), t('netplay.forgetAddress')),
          ),
          testRes ? h('div', { class: 'row wrap np-tunnel-meta' }, testRes.ok ? h('span', { class: 'np-verified good' }, icon('shieldCheck'), t('netplay.verifiedOk', { ms: testRes.latency })) : h('span', { class: 'np-verified bad' }, icon('alert'), testRes.error)) : null,
        )
      : null;
    return h('div', { class: 'np-hero-body' }, savedBox, h('div', { class: 'np-note' }, icon('info'), t('netplay.playitNote')), saved ? h('details', { class: 'np-adv' }, h('summary', {}, icon('list'), t('netplay.playitGuide')), h('div', { class: 'np-adv-body' }, guide)) : guide);
  }

  function fkSwitch(checked, onChange, label, fk) {
    const el = switchEl(checked, onChange, label);
    el.querySelector('input').dataset.fk = fk;
    return el;
  }

  async function startTunnel() {
    md.busy.start = true;
    renderTunnel();
    try {
      md.tunnel = await call('tunnelStart', { serverId, provider: 'bore' });
      ok(t('netplay.tunnelReadyTitle'), t('netplay.tunnelReadyText', { address: md.tunnel.publicAddress }));
    } catch (err) {
      fail(t('netplay.tunnelFailed'), err);
    } finally {
      md.busy.start = false;
      renderTunnel();
      renderAddr();
    }
  }

  async function stopTunnel() {
    if (!md.tunnel) return;
    try {
      await call('tunnelStop', md.tunnel.id);
      md.tunnel = null;
    } catch (err) {
      fail(t('netplay.tunnelFailed'), err);
    }
    renderTunnel();
    renderAddr();
  }

  async function verify() {
    if (!md.tunnel) return;
    md.busy.verify = true;
    renderTunnel();
    try {
      const v = await call('tunnelVerify', md.tunnel.id);
      if (v && md.tunnel) md.tunnel = { ...md.tunnel, verified: v };
      if (v && !v.ok) toast('bad', t('netplay.verifiedFail'), v.error);
    } catch (err) {
      fail(t('netplay.verifyFailed'), err);
    } finally {
      md.busy.verify = false;
      renderTunnel();
    }
  }

  async function testAddress(address) {
    md.busy.test = true;
    renderTunnel();
    try {
      md.test = { address, ...(await call('test', address)) };
    } catch (err) {
      md.test = { address, ok: false, error: err.message };
    } finally {
      md.busy.test = false;
      renderTunnel();
    }
  }

  async function savePrefs(patch) {
    try {
      const r = await call('setServerPrefs', serverId, patch);
      md.prefs = { ...md.prefs, ...r.prefs };
      if (r.error) fail(t('netplay.upnpFailed'), r.error);
    } catch (err) {
      fail(t('netplay.saveFailed'), err);
    }
    renderTunnel();
    renderUpnp();
    renderAddr();
  }

  // --- Tarjeta: direcciones ---
  function renderAddr() {
    keepFocus(cAddr, () => {
      const p = port();
      const a = md.addrs;
      const row = (label, value, extra, cls) => h('div', { class: ['np-addr-row', cls] }, h('span', { class: 'np-addr-label' }, label), h('div', { class: 'np-addr-main' }, h('span', { class: 'np-addr-value selectable', title: value }, value), extra || null), copyBtn(value));
      const infoRow = (label, content) => h('div', { class: 'np-addr-row' }, h('span', { class: 'np-addr-label' }, label), h('div', { class: 'np-addr-main' }, content));
      const mapping = md.upnp?.mappings?.find((x) => x.protocol === 'TCP' && x.port === p);
      const tun = md.tunnel && (md.tunnel.status === 'online' || md.tunnel.status === 'reconnecting') ? md.tunnel : null;
      const rows = [row(t('netplay.addrThisPc'), `localhost:${p}`)];
      if (a) {
        a.lan.forEach((ip, i) => rows.push(row(i === 0 ? t('netplay.addrLan') : t('netplay.addrLanOther'), `${ip}:${p}`)));
        for (const v of a.vpn || []) rows.push(row(t('netplay.addrVpn', { name: v.name }), `${v.address}:${p}`));
        if (a.publicIp) {
          const ext = mapping?.externalPort || p;
          const pill = mapping ? statusPill('good', t('netplay.portOpen')) : a.cgnat ? statusPill('bad', 'CGNAT') : statusPill('warn', t('netplay.portClosed'));
          rows.push(row(t('netplay.addrPublic'), `${a.publicIp}:${ext}`, pill, 'np-public'));
        } else rows.push(infoRow(t('netplay.addrPublic'), h('span', { class: 'small muted' }, t('netplay.publicUnknown'))));
      } else if (md.addrsError) rows.push(h('div', { class: 'np-note bad' }, icon('alert'), md.addrsError));
      else rows.push(infoRow(t('netplay.addrLan'), h('span', { class: 'np-inline-status muted' }, h('span', { class: 'spinner np-spin' }), t('netplay.detecting'))));
      if (tun) rows.push(row(t('netplay.addrTunnel'), tun.publicAddress, null, 'np-tunnel-row'));
      else if (md.prefs?.customAddress) rows.push(row('playit.gg', md.prefs.customAddress, null, 'np-tunnel-row'));
      const cgnat = a?.cgnat ? h('div', { class: 'np-note bad' }, icon('shieldAlert'), t(a.cgnatReason === 'doubleNat' ? 'netplay.cgnatDouble' : 'netplay.cgnatText')) : null;
      mount(
        cAddr,
        h('div', { class: 'np-card-head' }, h('div', { class: 'np-card-icon', 'aria-hidden': 'true' }, icon('wifi')), h('div', { class: 'spacer' }, h('h3', { class: 'np-card-title' }, t('netplay.addrTitle')), h('p', { class: 'np-card-sub' }, t('netplay.addrSub'))), h('button', { class: 'icon-btn sm', title: t('netplay.refresh'), 'aria-label': t('netplay.refresh'), 'data-fk': 'addr-refresh', onclick: () => loadAddrs(true) }, icon('refresh'))),
        h('div', { class: 'np-addr-list' }, rows),
        cgnat,
        h('div', { class: 'np-fineprint' }, icon('info'), t('netplay.firewallNote')),
      );
    });
  }

  async function loadAddrs(force = false) {
    if (force) {
      md.addrs = null;
      md.addrsError = null;
      renderAddr();
    }
    try {
      md.addrs = await call('addresses', { force });
    } catch (err) {
      if (isMissing(err)) {
        // Sin el modulo: al menos las direcciones LAN del nucleo
        const list = await api.servers.addresses().catch(() => []);
        md.addrs = { lan: list.map((x) => x.address), vpn: [], publicIp: null, cgnat: null };
      } else md.addrsError = err.message;
    }
    if (!isDisposed()) renderAddr();
  }

  // --- Tarjeta: UPnP ---
  function renderUpnp() {
    keepFocus(cUpnp, () => {
      const p = port();
      const u = md.upnp;
      const enabled = Boolean(md.prefs?.upnp);
      const mapping = u?.mappings?.find((x) => x.protocol === 'TCP' && x.port === p);
      let status;
      if (md.unavailable) status = h('div', { class: 'np-status' }, icon('alert'), t('netplay.unavailableText'));
      else if (!u || u.discovering) status = h('div', { class: 'np-status' }, h('span', { class: 'spinner np-spin' }), t('netplay.upnpSearching'));
      else if (!u.available) status = h('div', { class: 'np-status warn' }, icon('alert'), h('div', { class: 'spacer' }, h('div', {}, t('netplay.upnpNotFound')), h('div', { class: 'small muted' }, t('netplay.upnpNotFoundHelp'))));
      else {
        const method = u.method === 'upnp' ? 'UPnP' : u.method === 'pcp' ? 'PCP' : 'NAT-PMP';
        const routerName = u.router?.name && u.router.name !== method ? u.router.name : u.router?.host || '';
        status = h(
          'div',
          { class: 'stack np-upnp-info' },
          h('div', { class: 'np-status good' }, icon('npRouter'), h('div', { class: 'spacer ellipsis' }, t('netplay.upnpRouter', { name: routerName, method })), u.externalIp ? h('span', { class: 'small muted np-ext-ip' }, t('netplay.upnpExternal', { ip: u.externalIp })) : null),
          mapping
            ? h('div', { class: 'np-status good' }, icon('check'), t('netplay.upnpMapped', { port: mapping.externalPort, ip: mapping.internalClient || '?' }))
            : enabled && !live()
              ? h('div', { class: 'np-status' }, icon('clock'), t('netplay.upnpPending'))
              : enabled && u.error
                ? h('div', { class: 'np-status bad' }, icon('alert'), u.error)
                : null,
          mapping?.error ? h('div', { class: 'np-status bad' }, icon('alert'), mapping.error) : null,
        );
      }
      const vc = md.prefs?.voiceChat;
      mount(
        cUpnp,
        h('div', { class: 'np-card-head' }, h('div', { class: 'np-card-icon', 'aria-hidden': 'true' }, icon('npRouter')), h('div', { class: 'spacer' }, h('h3', { class: 'np-card-title' }, t('netplay.upnpTitle')), h('p', { class: 'np-card-sub' }, t('netplay.upnpSub'))), h('button', { class: 'icon-btn sm', title: t('netplay.searchAgain'), 'aria-label': t('netplay.searchAgain'), 'data-fk': 'upnp-refresh', disabled: Boolean(u?.discovering), onclick: () => loadUpnp(true) }, icon('refresh'))),
        h('div', { class: 'toggle-row' }, h('div', { class: 'tr-text' }, h('div', { class: 'tr-title' }, t('netplay.upnpToggle', { port: p })), h('div', { class: 'tr-sub' }, t('netplay.upnpToggleSub'))), fkSwitch(enabled, (v) => savePrefs({ upnp: v }), t('netplay.upnpToggle', { port: p }), 'upnp')),
        vc?.installed ? h('div', { class: 'toggle-row' }, h('div', { class: 'tr-text' }, h('div', { class: 'tr-title' }, t('netplay.voiceToggle', { port: vc.port })), h('div', { class: 'tr-sub' }, t('netplay.voiceToggleSub'))), fkSwitch(Boolean(md.prefs?.voice), (v) => savePrefs({ voice: v }), t('netplay.voiceToggle', { port: vc.port }), 'voice')) : null,
        status,
      );
    });
  }

  async function loadUpnp(refresh = false) {
    if (refresh) {
      md.upnp = { ...(md.upnp || {}), discovering: true };
      renderUpnp();
    }
    try {
      md.upnp = await call('upnpStatus', { refresh, port: port() });
    } catch (err) {
      if (isMissing(err)) md.unavailable = true;
      else md.upnp = { available: false, discovering: false, error: err.message, mappings: [] };
    }
    if (isDisposed()) return;
    renderUpnp();
    renderAddr();
  }

  // --- Tarjeta: seguridad ---
  function renderSafety() {
    const props = md.props || {};
    const online = props['online-mode'] !== 'false';
    const wl = props['white-list'] === 'true';
    const tip = (iconName, text) => h('li', {}, icon(iconName), h('span', {}, text));
    mount(
      cSafety,
      h(
        'div',
        { class: 'np-card-head wrap' },
        h('div', { class: 'np-card-icon', 'aria-hidden': 'true' }, icon('shield')),
        h('div', { class: 'spacer' }, h('h3', { class: 'np-card-title' }, t('netplay.safetyTitle')), h('p', { class: 'np-card-sub' }, t('netplay.safetySub'))),
        h('div', { class: 'row wrap np-safety-pills' }, online ? statusPill('good', t('netplay.onlineModeOn'), 'shieldCheck') : statusPill('bad', t('netplay.onlineModeOff'), 'shieldAlert'), wl ? statusPill('good', t('netplay.whitelistOn'), 'lock') : statusPill('warn', t('netplay.whitelistOff'), 'users')),
      ),
      !online ? h('div', { class: 'np-note bad' }, icon('alert'), t('netplay.onlineModeWarn')) : null,
      h('ul', { class: 'np-tips' }, tip('lock', t('netplay.tipWhitelist')), tip('shieldCheck', t('netplay.tipOnline')), tip('users', t('netplay.tipShare')), tip('save', t('netplay.tipBackup'))),
      h('div', { class: 'row np-safety-actions' }, h('button', { class: 'btn sm', onclick: () => navigate(`server/${serverId}/properties`) }, icon('sliders'), t('netplay.goToConfig')), h('button', { class: 'btn sm ghost', onclick: () => navigate(`server/${serverId}/players`) }, icon('users'), t('netplay.goToPlayers'))),
    );
  }

  renderTunnel();
  renderAddr();
  renderUpnp();
  renderSafety();

  offs.push(
    api.on('netplay:tunnel', (snap) => {
      if (!snap) return;
      const mine = snap.serverId === serverId || (!snap.instanceId && snap.localPort === port() && (!md.tunnel || md.tunnel.id === snap.id));
      if (!mine) return;
      md.tunnel = snap.status === 'stopped' ? null : snap;
      renderTunnel();
      renderAddr();
    }),
    api.on('netplay:upnp', (snap) => {
      md.upnp = { ...(md.upnp || {}), ...snap };
      renderUpnp();
      renderAddr();
    }),
    api.on('server:state', (id, s) => {
      if (id !== serverId || !s) return;
      const changed = md.state !== s.state;
      md.state = s.state;
      if (changed) {
        renderTunnel();
        renderUpnp();
      }
    }),
    api.on('servers:changed', async () => {
      const srv = await api.servers.get(serverId).catch(() => null);
      if (srv && !isDisposed()) {
        md.srv = srv;
        renderTunnel();
        renderAddr();
        renderUpnp();
      }
    }),
  );
  loadAddrs();
  loadUpnp();
}

startup();
