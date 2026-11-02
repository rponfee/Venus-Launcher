// Avisos de amigos y de servidores favoritos.
//  - Un amigo entra a un servidor o a un mundo (cambio de actividad en el evento 'presence' de social): toast
//    "X entró a <servidor>" con Unirme (joinServer de Multijugador) y alerta al overlay. Uno por amigo cada 10
//    minutos y se puede silenciar por amigo.
//  - Servidores favoritos (los del perfil de Venus, profile_public -> favoriteServers, más los marcados en esta PC):
//    se revisan cada 5 minutos solo con el launcher abierto, con el ping de Multijugador (serverlist:ping), y se
//    avisa cuando vuelven a estar en línea, se llenan o se vacían (configurable).
//  - Todo se apaga por tipo; mientras se juega, silencio en el launcher salvo en el overlay (configurable).
// Ajustes en settings.notify (valores por defecto en party/notify-logic.js). La lógica pura vive en
// features/party/notify-logic.js (carpeta auxiliar del mismo dueño) y se prueba con Node.
//
// Contrato:
//   startup()                 escucha la presencia de los amigos y arranca la revisión de favoritos (idempotente)
//   notifyPanel() -> Element  tarjeta de Ajustes (con .destroy())
// Extras: watchButton(address, name) -> Element (campana para las tarjetas de Multijugador, con .destroy()),
//   isWatched(address), toggleWatchServer(address, name), muteFriend(userId, muted), serverStatus(address)
import { h, icon, mount, ok, fail, ensureCss, loading, switchEl, setBusy, registerIcons } from '../ui.js';
import { store } from '../store.js';
import { t, loadNs, onLanguageChange } from '../i18n.js';
import { cloud } from '../cloud.js';
import { social } from '../social.js';
import { navigate } from '../app.js';
import * as N from './party/notify-logic.js';
import { cleanAddress, addressKey, cleanText } from './party/logic.js';
import { actionToast, pushOverlay, isPlaying } from './party/toasts.js';

registerIcons({
  ntBellOff: '<path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M17 17H4a1 1 0 0 1-.74-1.673C4.59 13.956 6 12.499 6 8a6 6 0 0 1 .258-1.742"/><path d="m2 2 20 20"/><path d="M8.668 3.01A6 6 0 0 1 18 8c0 2.687.77 4.653 1.707 6.05"/>',
  ntBellRing: '<path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M22 8c0-2.3-.8-4.3-2-6"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/><path d="M4 2C2.8 3.7 2 5.7 2 8"/>',
});

const NS = 'notify';
const PROFILE_REFRESH_MS = 30 * 60_000;
const FIRST_CHECK_MS = 60_000; // la primera revisión espera a que el launcher termine de arrancar
let readyPromise = null;

function prepare() {
  ensureCss('features/notify');
  if (!readyPromise) readyPromise = loadNs(NS).catch((err) => console.warn('[notify] textos', err));
  return readyPromise;
}

const cfg = () => N.readNotify(store.settings?.notify);
const tracker = N.createActivityTracker();
const friendLimit = N.createLimiter(N.FRIEND_COOLDOWN_MS);
const serverLimit = N.createLimiter(N.FRIEND_COOLDOWN_MS);
const servers = new Map(); // clave -> { key, address, name, sources, state, checkedAt, last }
const listeners = new Set();
let started = false;
let checking = false;
let checkTimer = null;
let profileFavs = [];
let profileAt = 0;
let profileUser = null;

function changed() {
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch (err) {
      console.error('[notify]', err);
    }
  }
}

async function save(patch) {
  try {
    await store.setSettings({ notify: patch });
    return true;
  } catch (err) {
    fail(t('notify.saveFailed'), err);
    return false;
  }
}

// ---------- Entrega ----------

function deliver({ title, msg, iconName, overlayIcon, actions = [], key }) {
  const c = cfg();
  const where = N.deliveryFor(c, { playing: isPlaying(store.running) });
  // Durante la bienvenida no se muestra nada en el launcher
  if (where.toast && !document.body.classList.contains('onboarding')) actionToast({ kind: 'info', icon: iconName, title, msg, actions, key, ms: actions.length ? 12000 : 7000 });
  if (where.overlay) pushOverlay({ kind: 'alert', title, body: msg || undefined, icon: overlayIcon, ttl: 7000 });
}

async function join(address, act) {
  try {
    const { joinServer } = await import('./serverlist.js');
    const inst = act?.mcVersion ? store.instances.find((i) => i.mcVersion === act.mcVersion && (!act.loader || (i.preset === 'iris' ? 'iris' : i.loader || 'vanilla') === act.loader)) : null;
    return await joinServer(address, inst ? { instanceId: inst.id } : {});
  } catch (err) {
    fail(t('notify.joinFailed'), err);
    return false;
  }
}

// ---------- Amigos ----------

export async function muteFriend(userId, muted = true) {
  const c = cfg();
  const list = muted ? [...new Set([...c.muted, userId])] : c.muted.filter((id) => id !== userId);
  return save({ muted: list.slice(0, N.MAX_MUTED) });
}

// Lo que ya estaba pasando al arrancar (o al sumar un amigo) se anota sin avisar
function seedFriends() {
  if (social.state !== 'ready' || !Array.isArray(social.friends)) return;
  for (const f of social.friends) tracker.seed(f.id, f.activity, f.presence);
}

function onPresence({ userId, presence, activity } = {}) {
  if (!userId) return;
  const change = tracker.update(userId, activity, presence);
  const c = cfg();
  if (!N.friendEventAllowed(change, c, userId)) return;
  if (!friendLimit.allow(userId)) return;
  const friend = social.friendById?.(userId);
  const name = cleanText(friend?.name || social.nameOf?.(userId) || '') || '?';
  const mute = { label: t('notify.muteFriend'), icon: 'ntBellOff', ariaLabel: t('notify.muteFriendName', { name }), run: async () => {
    if (await muteFriend(userId, true)) ok(t('notify.mutedFriend', { name }), t('notify.mutedFriendText'));
  } };
  if (change.kind === 'server') {
    const act = friend?.activity || activity;
    deliver({
      title: t('notify.friendServer', { name, server: change.address }),
      msg: act?.mcVersion ? t('notify.friendVersion', { version: act.mcVersion }) : '',
      iconName: 'server',
      overlayIcon: 'friend',
      key: `notify-friend:${userId}`,
      actions: [{ label: t('notify.join'), icon: 'play', primary: true, ariaLabel: t('notify.joinName', { name }), run: () => join(change.address, act) }, mute],
    });
  } else {
    deliver({
      title: change.world ? t('notify.friendWorld', { name, world: change.world }) : t('notify.friendWorldNoName', { name }),
      msg: '',
      iconName: 'globe',
      overlayIcon: 'friend',
      key: `notify-friend:${userId}`,
      actions: [mute],
    });
  }
}

// ---------- Servidores favoritos ----------

async function refreshProfileFavorites(force = false) {
  await Promise.resolve(cloud.ready()).catch(() => {});
  const uid = cloud.user?.id || null;
  if (!uid || !cloud.isSignedIn()) {
    profileFavs = [];
    profileUser = null;
    return;
  }
  if (!force && profileUser === uid && Date.now() - profileAt < PROFILE_REFRESH_MS) return;
  profileAt = Date.now();
  profileUser = uid;
  try {
    const { data, error } = await cloud.client.rpc('profile_public', { p_user: uid });
    if (error) throw error;
    profileFavs = Array.isArray(data?.favoriteServers) ? data.favoriteServers.slice(0, 10) : [];
  } catch (err) {
    // Sin la migración de perfiles o sin red: solo se vigilan los marcados en esta PC
    console.warn('[notify] favoritos del perfil', err?.message || err);
    profileFavs = [];
  }
}

function watchList() {
  const c = cfg();
  return N.mergeFavorites(profileFavs, c.watch, { includeProfile: c.profileServers });
}

function serverEventText(s, e, res) {
  const name = s.name || s.address;
  if (e === 'online') return { title: t('notify.serverOnline', { name }), msg: res?.players ? t('notify.serverPlayers', { online: res.players.online ?? 0, max: res.players.max ?? 0 }) : '' };
  if (e === 'full') return { title: t('notify.serverFull', { name }), msg: t('notify.serverPlayers', { online: res?.players?.online ?? 0, max: res?.players?.max ?? 0 }) };
  return { title: t('notify.serverEmpty', { name }), msg: t('notify.serverEmptyText') };
}

export async function checkServers({ manual = false } = {}) {
  if (checking) return false;
  const c = cfg();
  if (!manual && !(c.serverOnline || c.serverFull || c.serverEmpty)) return false;
  checking = true;
  changed();
  try {
    await refreshProfileFavorites();
    const list = watchList();
    const keys = new Set(list.map((s) => s.key));
    for (const k of [...servers.keys()]) if (!keys.has(k)) servers.delete(k);
    if (!list.length) return true;
    const { pingServer } = await import('./serverlist.js');
    for (const s of list) {
      const res = await pingServer(s.address);
      if (res?.error === 'unavailable') break; // Multijugador no está cargado: se intenta en la próxima vuelta
      const prev = servers.get(s.key);
      const { state, events } = N.nextServerState(prev?.state, res);
      servers.set(s.key, { ...s, state, checkedAt: Date.now(), last: res });
      for (const e of N.serverEventsAllowed(events, cfg())) {
        if (!serverLimit.allow(`${s.key}:${e}`)) continue;
        const text = serverEventText(s, e, res);
        deliver({
          ...text,
          iconName: e === 'full' ? 'users' : 'server',
          overlayIcon: 'server',
          key: `notify-server:${s.key}`,
          actions: e === 'full' ? [] : [{ label: t('notify.join'), icon: 'play', primary: true, ariaLabel: t('notify.joinServer', { name: s.name }), run: () => join(s.address) }],
        });
      }
    }
    return true;
  } catch (err) {
    console.warn('[notify] servidores', err?.message || err);
    return false;
  } finally {
    checking = false;
    changed();
  }
}

function scheduleChecks(delay = N.SERVER_CHECK_MS) {
  clearTimeout(checkTimer);
  checkTimer = setTimeout(async () => {
    await checkServers();
    scheduleChecks();
  }, delay);
}

export function isWatched(address) {
  const key = addressKey(address);
  return Boolean(key) && cfg().watch.some((s) => addressKey(s.address) === key);
}

export async function toggleWatchServer(address, name) {
  const c = cfg();
  if (!cleanAddress(address)) return false;
  const was = isWatched(address);
  if (!was && c.watch.length >= N.MAX_WATCH) {
    fail(t('notify.watchFull'), t('notify.watchFullText', { max: N.MAX_WATCH }));
    return false;
  }
  const next = N.toggleWatch(c.watch, address, name);
  if (!(await save({ watch: next }))) return false;
  changed();
  if (!was) ok(t('notify.watching', { name: cleanText(name, 40) || cleanAddress(address) }), t('notify.watchingText'));
  return true;
}

// Último estado conocido de un servidor vigilado (para mostrarlo en otras pantallas) o null
export function serverStatus(address) {
  const s = servers.get(addressKey(address));
  return s ? { online: s.state?.online ?? null, players: s.state?.players ?? null, max: s.state?.max ?? null, checkedAt: s.checkedAt } : null;
}

// ---------- Arranque ----------

export async function startup() {
  if (started) return;
  started = true;
  await prepare();
  seedFriends();
  social.on('presence', onPresence);
  social.on('friends', seedFriends);
  social.on('state', (st) => {
    if (st !== 'ready') tracker.clear();
  });
  cloud.on('auth', () => {
    refreshProfileFavorites(true).then(changed).catch(() => {});
  });
  onLanguageChange(() => loadNs(NS).then(changed).catch(() => {}));
  scheduleChecks(FIRST_CHECK_MS);
}

// ---------- Botón "Avisarme" para tarjetas de servidores ----------

export function watchButton(address, name) {
  const btn = h('button', { class: 'icon-btn sm nt-watch', type: 'button' });
  const paint = () => {
    const on = isWatched(address);
    const label = on ? t('notify.unwatchName', { name: name || address }) : t('notify.watchName', { name: name || address });
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.setAttribute('aria-pressed', String(on));
    btn.classList.toggle('active', on);
    mount(btn, icon(on ? 'ntBellRing' : 'bell'));
  };
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const done = setBusy(btn);
    try {
      await toggleWatchServer(address, name);
    } finally {
      done();
      paint();
    }
  });
  const offs = [store.on('settings', paint)];
  prepare().then(paint);
  paint();
  btn.destroy = () => offs.splice(0).forEach((off) => off());
  return btn;
}

// ---------- Panel de Ajustes ----------

function toggleRow(title, sub, checked, onChange, fk) {
  const sw = switchEl(checked, onChange, title);
  sw.querySelector('input').dataset.fk = fk;
  return h('div', { class: 'toggle-row nt-row' }, h('div', { class: 'tr-text' }, h('div', { class: 'tr-title' }, title), sub ? h('div', { class: 'tr-sub' }, sub) : null), sw);
}

function statusPill(s) {
  const st = s?.state;
  if (!st) return h('span', { class: 'pill nt-pill' }, icon('clock'), t('notify.statusUnknown'));
  if (st.online === null) return h('span', { class: 'pill warn nt-pill' }, icon('wifiOff'), t('notify.statusNoReply'));
  if (st.online === false) return h('span', { class: 'pill bad nt-pill' }, icon('wifiOff'), t('notify.statusOffline'));
  const full = st.max > 0 && st.players >= st.max;
  return h('span', { class: ['pill', full ? 'warn' : 'good', 'nt-pill'] }, icon('wifi'), t('notify.statusOnline', { online: st.players ?? 0, max: st.max ?? 0 }));
}

export function notifyPanel() {
  const root = h('section', { class: 'card nt-panel', 'aria-busy': 'true', dataset: { anchor: 'notify' } }, loading());
  const offs = [];
  let disposed = false;
  const addInput = h('input', { class: 'input', type: 'text', id: 'nt-add-addr', maxlength: 260, spellcheck: 'false', autocomplete: 'off', dataset: { fk: 'add-addr' } });
  const addName = h('input', { class: 'input', type: 'text', id: 'nt-add-name', maxlength: 40, autocomplete: 'off', dataset: { fk: 'add-name' } });
  const addError = h('div', { class: 'field-error nt-add-error', role: 'alert', id: 'nt-add-error' });
  root.destroy = () => {
    disposed = true;
    offs.splice(0).forEach((off) => off());
  };

  const add = async () => {
    const address = cleanAddress(addInput.value);
    if (!address) {
      mount(addError, icon('alert'), h('span', {}, t('notify.badAddress')));
      addInput.setAttribute('aria-invalid', 'true');
      addInput.focus();
      return;
    }
    mount(addError);
    addInput.removeAttribute('aria-invalid');
    if (isWatched(address)) {
      addInput.value = '';
      addName.value = '';
      return;
    }
    if (await toggleWatchServer(address, addName.value)) {
      addInput.value = '';
      addName.value = '';
      checkServers({ manual: true });
    }
  };
  addInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      add();
    }
  });
  addInput.addEventListener('input', () => {
    mount(addError);
    addInput.removeAttribute('aria-invalid');
  });

  const draw = () => {
    if (disposed) return;
    const c = cfg();
    const set = (key) => (v) => save({ [key]: v });
    const keyFocus = document.activeElement && root.contains(document.activeElement) ? document.activeElement.dataset?.fk : null;
    addInput.placeholder = t('notify.addPlaceholder');
    addName.placeholder = t('notify.addNamePlaceholder');
    addInput.setAttribute('aria-describedby', 'nt-add-error');

    // Amigos silenciados
    const friends = Array.isArray(social.friends) ? social.friends : [];
    const mutedChips = c.muted.map((id) => {
      const name = cleanText(friends.find((f) => f.id === id)?.name || social.nameOf?.(id) || '') || t('notify.someone');
      return h('span', { class: 'chip nt-chip' }, icon('ntBellOff'), h('span', { class: 'ellipsis' }, name), h('button', { class: 'nt-chip-x', type: 'button', title: t('notify.unmuteName', { name }), 'aria-label': t('notify.unmuteName', { name }), dataset: { fk: `unmute-${id}` }, onclick: () => muteFriend(id, false) }, icon('x')));
    });
    const candidates = friends.filter((f) => !c.muted.includes(f.id)).sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const muteSelect = h(
      'select',
      { class: 'select nt-mute-select', id: 'nt-mute', dataset: { fk: 'mute' }, disabled: !candidates.length },
      h('option', { value: '' }, candidates.length ? t('notify.mutePick') : t('notify.muteNone')),
      candidates.map((f) => h('option', { value: f.id }, f.name)),
    );
    muteSelect.addEventListener('change', () => muteSelect.value && muteFriend(muteSelect.value, true));

    // Servidores vigilados
    const list = watchList();
    const anyServerEvent = c.serverOnline || c.serverFull || c.serverEmpty;
    const rows = list.map((s) => {
      const st = servers.get(s.key);
      const local = s.sources.includes('local');
      return h(
        'div',
        { class: 'list-item nt-server', role: 'listitem' },
        h('div', { class: 'li-icon nt-server-icon', 'aria-hidden': 'true' }, icon('server')),
        h(
          'div',
          { class: 'li-main' },
          h('div', { class: 'li-title ellipsis', title: s.name }, s.name),
          h('div', { class: 'li-sub row wrap nt-server-sub' }, h('span', { class: 'mono ellipsis', title: s.address }, s.address), s.sources.map((src) => h('span', { class: 'badge nt-src' }, t(src === 'profile' ? 'notify.srcProfile' : 'notify.srcLocal')))),
        ),
        statusPill(st),
        local ? h('button', { class: 'icon-btn sm danger', type: 'button', title: t('notify.removeName', { name: s.name }), 'aria-label': t('notify.removeName', { name: s.name }), dataset: { fk: `rm-${s.key}` }, onclick: () => toggleWatchServer(s.address, s.name) }, icon('trash')) : null,
      );
    });
    const checkBtn = h('button', { class: 'btn sm', type: 'button', dataset: { fk: 'check' }, disabled: checking || !list.length, onclick: async (e) => {
      const done = setBusy(e.currentTarget);
      try {
        await checkServers({ manual: true });
      } finally {
        done();
      }
    } }, icon('refresh'), checking ? t('notify.checking') : t('notify.checkNow'));
    const signedIn = cloud.isSignedIn() || social.state === 'ready';

    mount(
      root,
      h('div', { class: 'card-head' }, h('div', {}, h('div', { class: 'card-title' }, icon('bell'), t('notify.title')), h('div', { class: 'card-sub' }, t('notify.subtitle')))),
      h(
        'div',
        { class: 'nt-group' },
        h('h4', { class: 'nt-group-title' }, icon('users'), t('notify.friendsTitle')),
        !signedIn ? h('div', { class: 'notice info nt-note' }, icon('info'), h('div', { class: 'spacer' }, t('notify.friendsNeedSession')), h('button', { class: 'btn sm', type: 'button', onclick: () => navigate('settings/cloud') }, icon('logIn'), t('notify.signIn'))) : null,
        toggleRow(t('notify.optFriendServers'), t('notify.optFriendServersSub'), c.friendServers, set('friendServers'), 'friendServers'),
        toggleRow(t('notify.optFriendWorlds'), t('notify.optFriendWorldsSub'), c.friendWorlds, set('friendWorlds'), 'friendWorlds'),
        h(
          'div',
          { class: 'nt-muted' },
          h('label', { class: 'nt-label', for: 'nt-mute' }, t('notify.mutedTitle')),
          h('div', { class: 'small muted' }, t('notify.mutedSub')),
          mutedChips.length ? h('div', { class: 'chips nt-chips' }, mutedChips) : null,
          muteSelect,
        ),
      ),
      h(
        'div',
        { class: 'nt-group' },
        h('h4', { class: 'nt-group-title' }, icon('server'), t('notify.serversTitle')),
        toggleRow(t('notify.optServerOnline'), t('notify.optServerOnlineSub'), c.serverOnline, set('serverOnline'), 'serverOnline'),
        toggleRow(t('notify.optServerFull'), t('notify.optServerFullSub'), c.serverFull, set('serverFull'), 'serverFull'),
        toggleRow(t('notify.optServerEmpty'), t('notify.optServerEmptySub'), c.serverEmpty, set('serverEmpty'), 'serverEmpty'),
        toggleRow(t('notify.optProfileServers'), signedIn ? t('notify.optProfileServersSub') : t('notify.optProfileServersNoSession'), c.profileServers, set('profileServers'), 'profileServers'),
        h('div', { class: 'nt-servers-head' }, h('span', { class: 'nt-label' }, t('notify.watchedTitle', { count: list.length })), h('span', { class: 'spacer' }), checkBtn),
        !anyServerEvent && list.length ? h('div', { class: 'small muted nt-note' }, t('notify.serversOff')) : null,
        rows.length ? h('div', { class: 'list nt-servers', role: 'list', 'aria-label': t('notify.serversTitle') }, rows) : h('div', { class: 'small muted nt-empty' }, t('notify.noServers')),
        h(
          'div',
          { class: 'nt-add' },
          h('div', { class: 'field' }, h('label', { for: 'nt-add-addr' }, t('notify.addLabel')), addInput),
          h('div', { class: 'field' }, h('label', { for: 'nt-add-name' }, t('notify.addNameLabel')), addName),
          h('button', { class: 'btn', type: 'button', dataset: { fk: 'add' }, onclick: add }, icon('plus'), t('notify.add')),
        ),
        addError,
        h('div', { class: 'small muted' }, t('notify.checkEvery')),
      ),
      h(
        'div',
        { class: 'nt-group' },
        h('h4', { class: 'nt-group-title' }, icon('gamepad'), t('notify.playingTitle')),
        toggleRow(t('notify.optQuiet'), t('notify.optQuietSub'), c.quietWhilePlaying, set('quietWhilePlaying'), 'quiet'),
        toggleRow(t('notify.optOverlay'), t('notify.optOverlaySub'), c.overlay, set('overlay'), 'overlay'),
      ),
    );
    if (keyFocus) root.querySelector(`[data-fk="${CSS.escape(keyFocus)}"]`)?.focus({ preventScroll: true });
  };

  prepare()
    .then(() => refreshProfileFavorites())
    .then(() => {
      if (disposed) return;
      root.removeAttribute('aria-busy');
      draw();
      offs.push(store.on('settings', draw), social.on('friends', draw), cloud.on('auth', draw));
      listeners.add(draw);
      offs.push(() => listeners.delete(draw));
      if (![...servers.values()].length && watchList().length) checkServers({ manual: true });
    })
    .catch((err) => {
      if (disposed) return;
      console.error('[notify]', err);
      root.removeAttribute('aria-busy');
      mount(root, h('div', { class: 'notice bad' }, icon('alert'), h('div', {}, t('notify.panelError'))));
    });
  return root;
}
