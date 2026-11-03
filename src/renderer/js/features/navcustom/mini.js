// Vista del modo mini (html[data-mini]): la barra lateral y la pagina se esconden y queda una columna con lo
// esencial: cuenta, instancia elegida con Jugar, amigos conectados (los mismos datos que el Inicio, via
// social.js) y el reproductor de musica (miniPlayer de features/nowplaying). Entrar o salir pide al proceso
// principal que cambie el tamano de la ventana (window:mini, modules/miniwindow.js) y guarda
// settings.window.mini (+ miniRestore, el tamano de antes) para que el launcher reabra como quedo.
import { h, icon, mount, fail, avatarImg, instanceIcon, loaderBadge, instanceLoaderKey, loaderVersionLabel, fmtDuration, selectEl } from '../../ui.js';
import { store, api } from '../../store.js';
import { t } from '../../i18n.js';
import { social } from '../../social.js';
import { cloud } from '../../cloud.js';
import { navigate, launchInstance, openAccounts } from '../../app.js';
import { normalizeFriend, sortFriends } from '../../pages/home/logic.js';

const S = { root: null, els: null, offs: [], timer: null, friendsTimer: null, busy: false, selected: null, mode: null };
const isMissing = (err) => /No handler registered/i.test(String(err?.message || err || ''));

export const isMini = () => document.documentElement.hasAttribute('data-mini');

export async function setMini(on, { persist = true } = {}) {
  on = Boolean(on);
  if (S.busy) return isMini();
  S.busy = true;
  try {
    let result = null;
    try {
      result = await api.invoke('window:mini', on);
    } catch (err) {
      if (!isMissing(err)) console.warn('[navcustom] window:mini', err?.message || err);
    }
    document.documentElement.toggleAttribute('data-mini', on);
    if (on) mountView();
    else unmountView();
    if (persist) {
      const patch = { window: { mini: on } };
      if (on && result?.restore && typeof result.restore === 'object') patch.window.miniRestore = result.restore;
      try {
        await store.setSettings(patch);
      } catch (err) {
        fail(t('navcustom.miniFailed'), err);
      }
    }
  } finally {
    S.busy = false;
  }
  return on;
}

// Sale del modo mini y, si se pide, abre una ruta (en mini la pagina no se ve)
async function leaveTo(route) {
  await setMini(false);
  if (route) navigate(route);
}

// ---------- Cuenta ----------

function drawAccount() {
  const btn = S.els.acc;
  const acc = store.selectedAccount();
  btn.title = t('navcustom.miniAccounts');
  btn.setAttribute('aria-label', t('navcustom.miniAccounts'));
  if (!acc) {
    mount(btn, h('span', { class: 'avatar nc-mini-av nc-mini-av-empty' }, icon('user')), h('span', { class: 'nc-mini-acc-text' }, h('span', { class: 'nc-mini-acc-name' }, t('navcustom.miniAddAccount')), h('span', { class: 'nc-mini-acc-sub' }, t('navcustom.miniNeededToPlay'))));
    return;
  }
  mount(
    btn,
    avatarImg(acc.type === 'msa' ? acc.uuid : acc.name, 64, 'avatar nc-mini-av'),
    h('span', { class: 'nc-mini-acc-text' }, h('span', { class: 'nc-mini-acc-name ellipsis priv' }, acc.name), h('span', { class: 'nc-mini-acc-sub' }, acc.type === 'msa' ? 'Microsoft' : t('navcustom.miniOffline'))),
  );
}

// ---------- Instancia + Jugar ----------

function modeOf(inst) {
  if (!inst) return 'empty';
  const run = store.running[inst.id];
  if (run?.state === 'running') return 'running';
  if (run?.state === 'preparing' || store.taskFor(inst.id)) return 'preparing';
  return 'idle';
}

const taskPct = (task) => (task && task.progress !== null && task.progress !== undefined ? Math.max(0, Math.min(100, Math.round(task.progress * 100))) : null);

function drawPlay() {
  const el = S.els.play;
  const inst = store.selectedInstance();
  const mode = modeOf(inst);
  S.selected = inst?.id || null;
  S.mode = mode;
  if (!inst) {
    mount(el, h('div', { class: 'nc-mini-empty-box' }, icon('layers'), h('p', {}, t('navcustom.miniNoInstance')), h('button', { class: 'btn sm tonal', type: 'button', onclick: () => leaveTo('versions/new') }, icon('plus'), t('navcustom.miniCreate'))));
    return;
  }
  const run = store.running[inst.id] || {};
  const task = store.taskFor(inst.id);
  let picker = null;
  if (store.instances.length > 1) {
    picker = selectEl(
      store.instances.map((i) => ({ value: i.id, label: i.name })),
      inst.id,
      (id) => store.setSettings({ selectedInstance: id }).catch((err) => fail(t('navcustom.miniFailed'), err)),
      'select nc-mini-select',
    );
    picker.title = t('navcustom.miniChangeInstance');
    picker.setAttribute('aria-label', t('navcustom.miniChangeInstance'));
  }
  let button;
  let status = null;
  if (mode === 'running') {
    button = h('button', { class: 'play-btn stop nc-mini-btn', type: 'button', onclick: () => api.instances.stop(inst.id).catch((err) => fail(t('navcustom.miniStopFailed'), err)) }, icon('stop'), h('span', {}, t('navcustom.miniStop')));
    status = h(
      'div',
      { class: 'nc-mini-status', role: 'status' },
      h('span', { class: 'status-dot online' }),
      run.startedAt ? h('span', { dataset: { since: String(run.startedAt) } }, t('navcustom.miniRunningFor', { time: fmtDuration(Date.now() - run.startedAt) })) : h('span', {}, t('navcustom.miniRunning')),
    );
  } else if (mode === 'preparing') {
    const pct = taskPct(task);
    button = h('button', { class: 'play-btn nc-mini-btn is-busy', type: 'button', disabled: true, 'aria-busy': 'true' }, h('span', { class: 'spinner nc-mini-spin' }), h('span', { class: 'nc-mini-prep' }, pct !== null ? t('navcustom.miniPreparingPct', { pct }) : t('navcustom.miniPreparing')));
    status = h('div', { class: 'nc-mini-status nc-mini-status-task', role: 'status' }, task?.detail || task?.title || t('navcustom.miniPreparing'));
  } else {
    button = h('button', { class: 'play-btn nc-mini-btn', type: 'button', onclick: () => launchInstance(inst.id) }, icon('play'), h('span', {}, t('navcustom.miniPlay')));
  }
  mount(
    el,
    h(
      'div',
      { class: 'nc-mini-inst' },
      instanceIcon(inst, 'nc-mini-ii'),
      h(
        'div',
        { class: 'nc-mini-inst-text' },
        h('div', { class: 'nc-mini-inst-name ellipsis', title: inst.name }, inst.name),
        h('div', { class: 'nc-mini-inst-sub' }, h('span', { class: 'badge' }, icon('box'), t('navcustom.miniInstanceSub', { version: inst.mcVersion })), loaderBadge(instanceLoaderKey(inst), loaderVersionLabel(inst))),
      ),
    ),
    picker,
    button,
    status,
  );
}

// Progreso de "Preparando" sin redibujar la tarjeta (asi el selector de instancias no se cierra)
function patchTask(task) {
  const inst = store.selectedInstance();
  if (!inst || task?.meta?.instanceId !== inst.id) return;
  if (modeOf(inst) !== S.mode || inst.id !== S.selected) {
    drawPlay();
    return;
  }
  if (S.mode !== 'preparing') return;
  const pct = taskPct(store.taskFor(inst.id) || task);
  const label = S.els.play.querySelector('.nc-mini-prep');
  if (label) label.textContent = pct !== null ? t('navcustom.miniPreparingPct', { pct }) : t('navcustom.miniPreparing');
  const detail = S.els.play.querySelector('.nc-mini-status-task');
  if (detail) detail.textContent = task?.detail || task?.title || t('navcustom.miniPreparing');
}

// ---------- Amigos conectados ----------

function friendList() {
  let list = [];
  try {
    if (Array.isArray(social.friends)) list = social.friends;
  } catch {
    list = [];
  }
  const presenceOf = typeof social.presenceOf === 'function' ? (id) => social.presenceOf(id) : null;
  return sortFriends(list.map((f) => normalizeFriend(f, presenceOf)).filter(Boolean));
}

function friendSub(f) {
  const a = f.activity;
  if (a?.type === 'server' && a.address) return t('navcustom.miniFriendOnServer', { address: a.address });
  if (a?.instance) return t('navcustom.miniFriendPlaying', { name: a.instance });
  if (a?.type === 'singleplayer') return t('navcustom.miniFriendInWorld');
  return f.statusText || t('navcustom.miniFriendOnline');
}

function openChat(f) {
  leaveTo(null).catch(() => {});
  if (typeof social.openChat === 'function') Promise.resolve(social.openChat(f.id)).catch((err) => console.warn('[navcustom] openChat:', err));
  else navigate(`messages/${encodeURIComponent(f.id)}`);
}

async function joinAddress(address) {
  try {
    const mod = await import('../serverlist.js');
    await mod.joinServer(address, {});
  } catch (err) {
    fail(t('navcustom.miniJoinFailed'), err);
  }
}

function friendRow(f) {
  const canJoin = f.activity?.type === 'server' && f.activity.address;
  return h(
    'div',
    { class: 'nc-mini-friend' },
    h(
      'button',
      { class: 'nc-mini-friend-main', type: 'button', title: t('navcustom.miniFriendChat', { name: f.name }), onclick: () => openChat(f) },
      h('span', { class: 'nc-mini-fav' }, avatarImg(f.avatar, 64, 'nc-mini-fav-img'), h('span', { class: ['status-dot', 'online', `st-${f.status}`] })),
      h('span', { class: 'nc-mini-friend-text' }, h('span', { class: 'nc-mini-friend-name ellipsis priv' }, f.name), h('span', { class: 'nc-mini-friend-sub ellipsis priv' }, friendSub(f))),
    ),
    canJoin
      ? h('button', { class: 'icon-btn sm', type: 'button', title: t('navcustom.miniFriendJoin', { name: f.name }), 'aria-label': t('navcustom.miniFriendJoin', { name: f.name }), onclick: () => joinAddress(f.activity.address) }, icon('logIn'))
      : null,
  );
}

function drawFriends() {
  const el = S.els.friends;
  const friends = friendList();
  const online = friends.filter((f) => f.online);
  let configured = false;
  let signedIn = false;
  try {
    configured = cloud.isConfigured();
    signedIn = cloud.isSignedIn();
  } catch {
    /* nube no disponible */
  }
  const state = typeof social.state === 'string' ? social.state : '';
  let body;
  if (online.length) body = h('div', { class: 'nc-mini-list' }, online.slice(0, 8).map(friendRow));
  else if (!configured || state === 'disabled' || state === 'missingSchema' || state === 'error') body = h('p', { class: 'nc-mini-empty' }, t('navcustom.miniFriendsUnavailable'));
  else if (!signedIn || state === 'signedOut') body = h('div', { class: 'nc-mini-empty' }, h('p', {}, t('navcustom.miniFriendsSignIn')), h('button', { class: 'btn sm tonal', type: 'button', onclick: () => leaveTo('settings/cloud/venus') }, icon('logIn'), t('navcustom.miniFriendsSignInBtn')));
  else body = h('p', { class: 'nc-mini-empty' }, t('navcustom.miniFriendsNone'));
  mount(
    el,
    h('div', { class: 'nc-mini-card-head' }, icon('users'), h('span', { class: 'nc-mini-card-title' }, t('navcustom.miniFriends')), online.length ? h('span', { class: 'pill good' }, t('navcustom.miniFriendsCount', { count: online.length })) : null),
    body,
  );
}

const scheduleFriends = () => {
  clearTimeout(S.friendsTimer);
  S.friendsTimer = setTimeout(() => S.root && drawFriends(), 150);
};

// ---------- Musica ----------

function drawMusic() {
  const el = S.els.music;
  const head = h('div', { class: 'nc-mini-card-head' }, icon('music'), h('span', { class: 'nc-mini-card-title' }, t('navcustom.miniMusic')));
  const empty = h('p', { class: 'nc-mini-empty nc-mini-music-empty' }, t('navcustom.miniMusicNone'));
  mount(el, head, empty);
  import('../nowplaying.js')
    .then((m) => {
      if (!S.root || S.els.music !== el || typeof m.miniPlayer !== 'function') return;
      // El reproductor queda oculto si no suena nada: el texto de abajo lo reemplaza (CSS)
      el.insertBefore(m.miniPlayer(), empty);
    })
    .catch((err) => console.warn('[navcustom] nowplaying', err?.message || err));
}

// ---------- Vista ----------

function tick() {
  S.root?.querySelectorAll('[data-since]').forEach((el) => {
    const since = Number(el.dataset.since);
    if (since) el.textContent = t('navcustom.miniRunningFor', { time: fmtDuration(Date.now() - since) });
  });
}

function subscribe() {
  const sub = (off) => typeof off === 'function' && S.offs.push(off);
  sub(store.on('instances', drawPlay));
  sub(store.on('running', drawPlay));
  sub(store.on('accounts', () => (drawAccount(), drawPlay())));
  sub(
    store.on('settings', () => {
      if ((store.selectedInstance()?.id || null) !== S.selected) drawPlay();
    }),
  );
  sub(store.on('task', (task) => task?.meta?.instanceId && patchTask(task)));
  if (typeof social?.on === 'function') for (const ev of ['friends', 'presence', 'state', 'ready']) sub(social.on(ev, scheduleFriends));
  if (typeof cloud?.on === 'function') {
    sub(cloud.on('auth', scheduleFriends));
    sub(cloud.on('config', scheduleFriends));
  }
  S.timer = setInterval(tick, 30000);
}

function mountView() {
  if (S.root) {
    redraw();
    return;
  }
  const host = document.querySelector('.app') || document.body;
  S.els = {
    acc: h('button', { class: 'nc-mini-acc', type: 'button', onclick: () => openAccounts() }),
    play: h('section', { class: 'card nc-mini-card nc-mini-play' }),
    friends: h('section', { class: 'card nc-mini-card nc-mini-friends' }),
    music: h('section', { class: 'card nc-mini-card nc-mini-music' }),
  };
  const exit = h('button', { class: 'icon-btn sm nc-mini-exit', type: 'button', title: t('navcustom.miniExit'), 'aria-label': t('navcustom.miniExit'), onclick: () => setMini(false) }, icon('ncMiniOff'));
  S.root = h('div', { class: 'nc-mini', role: 'region', 'aria-label': t('navcustom.miniMode') }, h('header', { class: 'nc-mini-top' }, S.els.acc, exit), S.els.play, S.els.friends, S.els.music);
  host.append(S.root);
  subscribe();
  redraw();
}

function unmountView() {
  if (!S.root) return;
  for (const off of S.offs) {
    try {
      off();
    } catch {
      /* ya desuscripto */
    }
  }
  S.offs = [];
  clearInterval(S.timer);
  clearTimeout(S.friendsTimer);
  S.root.remove(); // el mini reproductor se limpia solo al salir del documento
  S.root = null;
  S.els = null;
}

// Vuelve a dibujar todo (por ejemplo, al cambiar el idioma)
export function redraw() {
  if (!S.root) return;
  S.root.setAttribute('aria-label', t('navcustom.miniMode'));
  const exit = S.root.querySelector('.nc-mini-exit');
  if (exit) {
    exit.title = t('navcustom.miniExit');
    exit.setAttribute('aria-label', exit.title);
  }
  drawAccount();
  drawPlay();
  drawFriends();
  drawMusic();
}
