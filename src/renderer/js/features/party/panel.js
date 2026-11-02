// Interfaz de los Grupos para jugar: panel del grupo (diálogo) y tarjeta para Multijugador o Inicio.
// No guarda estado propio del grupo: dibuja lo que da ctrl.snapshot() y llama a las acciones de ctrl
// (features/party.js). Estilos en styles/features/party.css (prefijo pt-).
import { h, icon, mount, modal, emptyState, loading, skeleton, setBusy, confirmDialog, loaderBadge, instanceIcon, copyText, switchEl } from '../../ui.js';
import { store, api } from '../../store.js';
import { t } from '../../i18n.js';
import { cloud } from '../../cloud.js';
import { social } from '../../social.js';
import { navigate } from '../../app.js';
import { headImg, presenceDot, prepareSocialUi } from '../../social/profile-ui.js';
import { MAX_MEMBERS, cleanAddress, addressKey, planComplete, cleanText } from './logic.js';

const isOnline = (p) => p === 'online' || p === 'away' || p === 'busy';
const CUSTOM = '__custom';

function keepFocus(container, fn) {
  const key = document.activeElement && container.contains(document.activeElement) ? document.activeElement.dataset?.fk : null;
  fn();
  if (key) container.querySelector(`[data-fk="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
}

// Acción asíncrona de un botón: queda ocupado mientras corre
function busyRun(btn, fn) {
  const done = setBusy(btn);
  return Promise.resolve()
    .then(fn)
    .catch((err) => console.warn('[party]', err))
    .finally(done);
}

function avatarOf(id, name, size = 36) {
  const profile = social.profileOf?.(id) || { username: name };
  return headImg(profile, size, 'pt-head');
}

// ---------- Piezas del plan ----------

function packView(ctrl, plan, inst) {
  const pack = plan?.pack;
  if (!pack) return null;
  const shared = pack.kind === 'shared';
  return h(
    'div',
    { class: 'pt-pack' },
    inst ? instanceIcon(inst, 'pt-pack-icon') : h('div', { class: 'pt-pack-icon pt-pack-generic', 'aria-hidden': 'true' }, icon(shared ? 'package' : 'box')),
    h(
      'div',
      { class: 'pt-pack-main' },
      h('div', { class: 'pt-pack-name ellipsis', title: shared ? pack.name : ctrl.planGame(plan) }, shared ? pack.name : pack.name || ctrl.planGame(plan)),
      h(
        'div',
        { class: 'row wrap pt-pack-meta' },
        loaderBadge(pack.loader, pack.mcVersion),
        shared ? h('span', { class: 'badge accent', title: t('party.sharedCodeTip') }, icon('share'), t('party.sharedCode', { code: pack.code })) : null,
      ),
    ),
  );
}

function targetLine(ctrl, snap) {
  const plan = snap.party?.plan;
  const tg = plan?.target;
  if (!tg) return h('div', { class: 'pt-target muted' }, icon('compass'), h('span', {}, t('party.noTarget')));
  if (tg.kind === 'server') {
    return h(
      'div',
      { class: 'pt-target' },
      icon('server'),
      h('div', { class: 'pt-target-main' }, h('div', { class: 'pt-target-name ellipsis', title: tg.name }, tg.name), h('div', { class: 'pt-target-addr mono ellipsis', title: tg.address }, tg.address)),
      h('button', { class: 'icon-btn sm', type: 'button', title: t('party.copyAddress'), 'aria-label': t('party.copyAddress'), onclick: () => copyText(tg.address, t('party.copied')) }, icon('copy')),
    );
  }
  return h(
    'div',
    { class: 'pt-target' },
    icon('globe'),
    h(
      'div',
      { class: 'pt-target-main' },
      h('div', { class: 'pt-target-name ellipsis' }, t('party.worldOf', { name: snap.party.leaderName })),
      tg.address ? h('div', { class: 'pt-target-addr mono ellipsis', title: tg.address }, tg.address) : h('div', { class: 'small muted' }, t('party.worldNotOpen')),
    ),
    tg.address ? h('button', { class: 'icon-btn sm', type: 'button', title: t('party.copyAddress'), 'aria-label': t('party.copyAddress'), onclick: () => copyText(tg.address, t('party.copied')) }, icon('copy')) : null,
  );
}

function pill(kind, iconName, text) {
  return h('span', { class: ['pill', kind, 'pt-pill'] }, iconName ? icon(iconName) : null, text);
}

function memberPills(m, snap) {
  const out = [];
  if (m.leader) out.push(pill('', 'ptCrown', t('party.leader')));
  else {
    out.push(m.ready ? pill('good', 'check', t('party.ready')) : pill('', 'clock', t('party.notReady')));
    if (snap.party.plan && m.prep === 'update') out.push(pill('warn', 'refresh', t('party.prepUpdate')));
    else if (snap.party.plan && m.prep === 'missing') out.push(pill('warn', 'download', t('party.prepMissing')));
  }
  if (!m.online && !m.self) out.push(pill('bad', 'wifiOff', t('party.offline')));
  return out;
}

// ---------- Panel ----------

let openPanel = null;

export async function openPartyPanel(ctrl) {
  if (openPanel?.alive) {
    openPanel.focus();
    return openPanel.m;
  }
  await prepareSocialUi().catch(() => {});
  const body = h('div', { class: 'pt-panel' });
  const foot = h('div', { class: 'pt-foot' });
  const ui = {
    alive: true,
    servers: null, // { saved: [{ address, name }], favorites: [...] }
    serversLoading: false,
    pings: new Map(), // dirección -> resultado (o 'loading')
    serverChoice: null, // valor del selector (dirección o CUSTOM)
    addrInput: h('input', { class: 'input pt-addr-input', type: 'text', maxlength: 260, spellcheck: 'false', autocomplete: 'off', placeholder: t('party.addressPlaceholder'), 'aria-label': t('party.addressLabel'), dataset: { fk: 'addr' } }),
    addrError: h('div', { class: 'field-error pt-addr-error', role: 'alert' }),
    friendFilter: h('input', { class: 'input pt-friend-filter', type: 'search', placeholder: t('party.searchFriends'), 'aria-label': t('party.searchFriends'), dataset: { fk: 'ffilter' } }),
  };
  const m = modal({
    title: t('party.title'),
    subtitle: t('party.subNone'),
    icon: 'ptPartyUsers',
    size: 'wide',
    body,
    footer: foot,
    onClose: () => {
      ui.alive = false;
      off();
      if (openPanel?.m === m) openPanel = null;
    },
  });
  openPanel = { m, alive: true, focus: () => m.el.focus() };
  const sub = m.el.querySelector('.modal-sub');

  const useAddress = () => {
    const raw = ui.addrInput.value;
    const address = cleanAddress(raw);
    if (!address) {
      mount(ui.addrError, icon('alert'), h('span', {}, t('party.badAddress')));
      ui.addrInput.setAttribute('aria-invalid', 'true');
      ui.addrInput.focus();
      return;
    }
    mount(ui.addrError);
    ui.addrInput.removeAttribute('aria-invalid');
    ctrl.setTarget({ kind: 'server', address, name: address });
    ui.serverChoice = address;
  };
  ui.addrInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      useAddress();
    }
  });
  ui.addrInput.addEventListener('input', () => {
    mount(ui.addrError);
    ui.addrInput.removeAttribute('aria-invalid');
  });
  ui.friendFilter.addEventListener('input', () => render());

  async function loadServers() {
    if (ui.servers || ui.serversLoading) return;
    ui.serversLoading = true;
    const out = { saved: [], favorites: [] };
    try {
      const list = await api.invoke('serverlist:saved');
      out.saved = (Array.isArray(list) ? list : []).map((s) => ({ address: cleanAddress(s.ip), name: cleanText(s.name, 60) })).filter((s) => s.address).slice(0, 40);
    } catch (err) {
      console.warn('[party] guardados', err?.message || err);
    }
    try {
      await Promise.resolve(cloud.ready()).catch(() => {});
      if (cloud.isSignedIn()) {
        const { data, error } = await cloud.client.rpc('profile_public', { p_user: cloud.user.id });
        if (error) throw error;
        const favs = Array.isArray(data?.favoriteServers) ? data.favoriteServers : [];
        out.favorites = favs.map((s) => ({ address: cleanAddress(s?.address), name: cleanText(s?.name, 60) })).filter((s) => s.address).slice(0, 10);
      }
    } catch (err) {
      console.warn('[party] favoritos del perfil', err?.message || err);
    }
    ui.servers = out;
    ui.serversLoading = false;
    if (ui.alive) render();
  }

  async function ping(address) {
    const key = addressKey(address);
    if (!key || ui.pings.has(key)) return;
    ui.pings.set(key, 'loading');
    try {
      const { pingServer } = await import('../serverlist.js');
      ui.pings.set(key, await pingServer(address));
    } catch {
      ui.pings.set(key, { online: false });
    }
    if (ui.alive) render();
  }

  // ---------- Vistas ----------

  function gateView(gate) {
    if (gate === 'loading') return skeleton('list', { rows: 3 });
    const retry = typeof social.retry === 'function' ? h('button', { class: 'btn', type: 'button', onclick: (e) => busyRun(e.currentTarget, () => social.retry()) }, icon('refresh'), t('party.retry')) : null;
    return emptyState('alert', t('party.serviceDown'), t('party.serviceDownText'), retry);
  }

  function invitesView(snap) {
    if (!snap.invites.length) return null;
    return h(
      'div',
      { class: 'pt-invites' },
      h('div', { class: 'pt-sec-head' }, h('h4', {}, t('party.invitesTitle'))),
      h(
        'div',
        { class: 'list', role: 'list' },
        snap.invites.map((inv) =>
          h(
            'div',
            { class: 'list-item pt-member', role: 'listitem' },
            avatarOf(inv.leader, inv.name),
            h('div', { class: 'li-main' }, h('div', { class: 'li-title ellipsis priv', title: inv.name }, t('party.inviteFrom', { name: inv.name })), h('div', { class: 'li-sub ellipsis' }, inv.game ? (inv.where ? t('party.inviteGameWhere', { game: inv.game, where: inv.where }) : inv.game) : t('party.inviteNoPlan'))),
            h('button', { class: 'btn sm ghost', type: 'button', dataset: { fk: `dec-${inv.leader}` }, onclick: (e) => busyRun(e.currentTarget, () => ctrl.declineInvite(inv.leader)) }, t('party.decline')),
            h('button', { class: 'btn sm tonal', type: 'button', dataset: { fk: `acc-${inv.leader}` }, onclick: (e) => busyRun(e.currentTarget, () => ctrl.acceptInvite(inv.leader)) }, icon('check'), t('party.accept')),
          ),
        ),
      ),
    );
  }

  function noPartyView(snap) {
    return h(
      'div',
      { class: 'pt-none' },
      emptyState(
        'ptPartyUsers',
        t('party.emptyTitle'),
        t('party.emptyText', { max: MAX_MEMBERS }),
        h('button', { class: 'btn primary', type: 'button', dataset: { fk: 'create' }, onclick: (e) => busyRun(e.currentTarget, () => ctrl.createParty()) }, icon('plus'), t('party.create')),
      ),
      invitesView(snap),
    );
  }

  function membersView(snap) {
    const p = snap.party;
    const leader = snap.role === 'leader';
    const rows = p.members.map((mb) =>
      h(
        'div',
        { class: ['list-item', 'pt-member', !mb.online && !mb.self && 'disabled'], role: 'listitem' },
        avatarOf(mb.id, mb.name),
        h('div', { class: 'li-main' }, h('div', { class: 'li-title ellipsis priv', title: mb.name }, mb.self ? t('party.youName', { name: mb.name }) : mb.name), h('div', { class: 'pt-pills' }, memberPills(mb, snap))),
        leader && !mb.leader
          ? h('button', { class: 'icon-btn sm danger', type: 'button', title: t('party.kickName', { name: mb.name }), 'aria-label': t('party.kickName', { name: mb.name }), dataset: { fk: `kick-${mb.id}` }, onclick: async () => {
              if (await confirmDialog(t('party.kickTitle'), t('party.kickConfirm', { name: mb.name }), { okText: t('party.kick'), danger: true })) ctrl.kickMember(mb.id);
            } }, icon('logout'))
          : null,
      ),
    );
    const pending = p.invited.map((inv) =>
      h(
        'div',
        { class: 'list-item pt-member pending', role: 'listitem' },
        avatarOf(inv.id, inv.name),
        h('div', { class: 'li-main' }, h('div', { class: 'li-title ellipsis', title: inv.name }, inv.name), h('div', { class: 'pt-pills' }, pill('info', 'send', t('party.invitedPill')))),
        leader ? h('button', { class: 'icon-btn sm', type: 'button', title: t('party.cancelInviteName', { name: inv.name }), 'aria-label': t('party.cancelInviteName', { name: inv.name }), dataset: { fk: `cancel-${inv.id}` }, onclick: () => ctrl.cancelInvite(inv.id) }, icon('x')) : null,
      ),
    );
    return h(
      'div',
      { class: 'pt-sec' },
      h('div', { class: 'pt-sec-head' }, h('h4', {}, t('party.membersTitle')), h('span', { class: 'badge num' }, t('party.countOf', { count: p.members.length, max: MAX_MEMBERS }))),
      h('div', { class: 'list pt-members', role: 'list', 'aria-label': t('party.membersTitle') }, rows, pending),
    );
  }

  function friendsView(snap) {
    const p = snap.party;
    const taken = new Set([...p.members.map((x) => x.id), ...p.invited.map((x) => x.id)]);
    const q = ui.friendFilter.value.trim().toLowerCase();
    const list = (Array.isArray(social.friends) ? social.friends : [])
      .filter((f) => !taken.has(f.id))
      .filter((f) => !q || String(f.name || '').toLowerCase().includes(q))
      .sort((a, b) => Number(isOnline(b.presence)) - Number(isOnline(a.presence)) || String(a.name).localeCompare(String(b.name)))
      .slice(0, 40);
    const full = p.slots <= 0;
    const rows = list.map((f) => {
      const online = isOnline(f.presence);
      const reason = full ? t('party.fullText', { max: MAX_MEMBERS }) : online ? null : t('party.friendOfflineTip');
      return h(
        'div',
        { class: ['list-item', 'pt-friend', !online && 'disabled'], role: 'listitem' },
        h('span', { class: 'pt-headwrap' }, avatarOf(f.id, f.name, 32), presenceDot(f.presence)),
        h('div', { class: 'li-main' }, h('div', { class: 'li-title ellipsis', title: f.name }, f.name), h('div', { class: 'li-sub' }, online ? t('party.friendOnline') : t('party.friendOffline'))),
        h('button', { class: 'btn sm tonal', type: 'button', disabled: Boolean(reason), title: reason || t('party.inviteName', { name: f.name }), 'aria-label': t('party.inviteName', { name: f.name }), dataset: { fk: `inv-${f.id}` }, onclick: (e) => busyRun(e.currentTarget, () => ctrl.inviteToParty(f.id)) }, icon('userPlus'), t('party.invite')),
      );
    });
    const total = Array.isArray(social.friends) ? social.friends.length : 0;
    return h(
      'div',
      { class: 'pt-sec' },
      h('div', { class: 'pt-sec-head' }, h('h4', {}, t('party.inviteTitleSec')), full ? h('span', { class: 'small muted' }, t('party.full')) : null),
      total > 6 ? ui.friendFilter : null,
      rows.length
        ? h('div', { class: 'list pt-friends', role: 'list', 'aria-label': t('party.inviteTitleSec') }, rows)
        : total
          ? h('div', { class: 'small muted pt-empty-line' }, q ? t('party.noFriendMatch') : t('party.allInvited'))
          : h('div', { class: 'pt-empty-line' }, h('span', { class: 'small muted' }, t('party.noFriends')), h('button', { class: 'btn sm', type: 'button', onclick: () => (m.close(), navigate('messages')) }, icon('message'), t('party.goFriends'))),
    );
  }

  // Selector de servidor del líder: guardados del Multijugador, favoritos del perfil u otra dirección
  function serverPicker(snap) {
    const tg = snap.party.plan?.target;
    if (!ui.servers) {
      loadServers();
      return skeleton('line');
    }
    const all = [...ui.servers.saved, ...ui.servers.favorites];
    const current = tg?.kind === 'server' ? tg.address : null;
    if (ui.serverChoice === null) ui.serverChoice = current || '';
    const known = all.some((s) => s.address === ui.serverChoice);
    const value = ui.serverChoice === CUSTOM || (ui.serverChoice && !known) ? CUSTOM : ui.serverChoice;
    if (value === CUSTOM && current && !ui.addrInput.value) ui.addrInput.value = current;
    const opt = (s) => h('option', { value: s.address, selected: s.address === value }, s.name && s.name !== s.address ? t('party.serverOption', { name: s.name, address: s.address }) : s.address);
    const select = h(
      'select',
      { class: 'select', id: 'pt-server', dataset: { fk: 'server' } },
      h('option', { value: '', selected: !value }, t('party.pickServer')),
      ui.servers.saved.length ? h('optgroup', { label: t('party.savedServers') }, ui.servers.saved.map(opt)) : null,
      ui.servers.favorites.length ? h('optgroup', { label: t('party.profileServers') }, ui.servers.favorites.map(opt)) : null,
      h('option', { value: CUSTOM, selected: value === CUSTOM }, t('party.otherAddress')),
    );
    select.addEventListener('change', () => {
      ui.serverChoice = select.value;
      if (select.value && select.value !== CUSTOM) {
        const s = all.find((x) => x.address === select.value);
        ctrl.setTarget({ kind: 'server', address: s.address, name: s.name || s.address });
      } else render();
      if (select.value === CUSTOM) setTimeout(() => ui.addrInput.focus(), 0);
    });
    const parts = [h('div', { class: 'field' }, h('label', { for: 'pt-server' }, t('party.serverLabel')), select)];
    if (value === CUSTOM) {
      parts.push(
        h(
          'div',
          { class: 'field' },
          h('div', { class: 'pt-addr-row' }, ui.addrInput, h('button', { class: 'btn', type: 'button', dataset: { fk: 'use-addr' }, onclick: useAddress }, icon('check'), t('party.useAddress'))),
          ui.addrError,
        ),
      );
    }
    if (current) {
      const key = addressKey(current);
      const res = ui.pings.get(key);
      if (!res) ping(current);
      parts.push(
        h(
          'div',
          { class: 'pt-ping small', role: 'status' },
          !res || res === 'loading'
            ? [h('span', { class: 'spinner pt-spin', 'aria-hidden': 'true' }), t('party.pinging')]
            : res.online
              ? [icon('wifi'), t('party.pingOnline', { online: res.players?.online ?? 0, max: res.players?.max ?? 0 }), res.mcVersion || res.version?.name ? h('span', { class: 'muted' }, ` · ${res.mcVersion || res.version?.name}`) : null]
              : [icon('wifiOff'), t('party.pingOffline')],
        ),
      );
    }
    return parts;
  }

  function leaderPlanView(snap) {
    const p = snap.party;
    const insts = [...(store.instances || [])].sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0));
    if (!insts.length) {
      return emptyState('layers', t('party.noInstances'), t('party.noInstancesText'), h('button', { class: 'btn', type: 'button', onclick: () => (m.close(), navigate('versions/new')) }, icon('plus'), t('party.newInstance')));
    }
    const inst = insts.find((i) => i.id === p.instanceId) || null;
    const select = h(
      'select',
      { class: 'select', id: 'pt-inst', dataset: { fk: 'inst' } },
      h('option', { value: '', selected: !inst }, t('party.pickInstance')),
      insts.map((i) => h('option', { value: i.id, selected: i.id === p.instanceId }, t('party.instanceOption', { name: i.name, version: i.mcVersion, loader: ctrl.loaderName(i.preset === 'iris' ? 'iris' : i.loader) }))),
    );
    select.addEventListener('change', () => ctrl.setLeaderInstance(select.value || null));
    const pack = p.plan?.pack;
    let hint = null;
    if (pack?.kind === 'shared') hint = h('div', { class: 'small muted pt-hint' }, icon('info'), h('span', {}, t('party.sharedHint')));
    else if (pack && pack.loader !== 'vanilla' && inst) {
      hint = h(
        'div',
        { class: 'notice info pt-hint-box' },
        icon('share'),
        h('div', { class: 'spacer' }, t('party.shareHint')),
        h('button', { class: 'btn sm', type: 'button', dataset: { fk: 'share' }, onclick: async () => {
          try {
            const { openShareDialog } = await import('../share.js');
            openShareDialog(inst.id);
          } catch (err) {
            console.warn('[party] compartir', err);
          }
        } }, icon('share'), t('party.shareNow')),
      );
    } else if (pack) hint = h('div', { class: 'small muted pt-hint' }, icon('info'), h('span', {}, t('party.vanillaHint', { version: pack.mcVersion })));

    const kind = p.plan?.target?.kind || 'server';
    const pickKind = (id) => {
      if (id === kind) return;
      if (id === 'world') ctrl.setTarget({ kind: 'world' });
      else {
        ui.serverChoice = '';
        ctrl.setTarget(null);
        render();
      }
    };
    const seg = (id, iconName, label) =>
      h('button', { type: 'button', role: 'radio', class: kind === id ? 'active' : '', 'aria-checked': String(kind === id), tabindex: kind === id ? '0' : '-1', disabled: !pack, dataset: { fk: `kind-${id}` }, onclick: () => pickKind(id) }, icon(iconName), label);
    const kinds = h('div', { class: 'segmented pt-kinds', role: 'radiogroup', 'aria-label': t('party.whereLabel') }, seg('server', 'server', t('party.kindServer')), seg('world', 'globe', t('party.kindWorld')));
    kinds.addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key) || !pack) return;
      e.preventDefault();
      pickKind(kind === 'server' ? 'world' : 'server');
      setTimeout(() => kinds.querySelector('[aria-checked="true"]')?.focus(), 0);
    });
    let where = null;
    if (pack && kind === 'world') {
      const addr = p.plan?.target?.address;
      where = h(
        'div',
        { class: 'pt-world' },
        h('p', { class: 'small text-2 pt-world-text' }, t('party.worldExplain')),
        targetLine(ctrl, snap),
        h('button', { class: 'btn sm', type: 'button', dataset: { fk: 'open-world' }, onclick: async () => {
          try {
            const { openWorldToFriends } = await import('../netplay.js');
            openWorldToFriends(p.instanceId);
          } catch (err) {
            console.warn('[party] netplay', err);
          }
        } }, icon('globe'), addr ? t('party.worldManage') : t('party.worldOpenNow')),
      );
    } else if (pack) where = serverPicker(snap);
    return h(
      'div',
      { class: 'pt-sec' },
      h('div', { class: 'pt-sec-head' }, h('h4', {}, t('party.planTitle'))),
      h('div', { class: 'field' }, h('label', { for: 'pt-inst' }, t('party.instanceLabel')), select),
      packView(ctrl, p.plan, inst),
      hint,
      h('div', { class: 'field pt-where' }, h('span', { class: 'pt-label', id: 'pt-where-label' }, t('party.whereLabel')), kinds),
      where,
    );
  }

  function memberPlanView(snap) {
    const p = snap.party;
    if (!p.plan) {
      return h('div', { class: 'pt-sec' }, h('div', { class: 'pt-sec-head' }, h('h4', {}, t('party.planTitle'))), h('div', { class: 'pt-wait' }, icon('clock'), h('span', {}, t('party.waitingPlan', { name: p.leaderName }))));
    }
    const prep = p.myPrep?.prep;
    const inst = store.instances.find((i) => i.id === p.myPrep?.instanceId) || null;
    let mine;
    if (prep === 'ok') mine = h('div', { class: 'notice good pt-mine' }, icon('check'), h('div', {}, t('party.mineOk', { name: inst?.name || '' })));
    else if (prep === 'update') {
      mine = h('div', { class: 'notice pt-mine' }, icon('refresh'), h('div', { class: 'spacer' }, t('party.mineUpdate', { name: inst?.name || '' })), h('button', { class: 'btn sm', type: 'button', dataset: { fk: 'prep' }, onclick: (e) => busyRun(e.currentTarget, () => ctrl.prepareMine()) }, icon('refresh'), t('party.updateNow')));
    } else {
      mine = h('div', { class: 'notice pt-mine' }, icon('download'), h('div', { class: 'spacer' }, t(p.plan.pack.kind === 'shared' ? 'party.mineMissingPack' : 'party.mineMissing')), h('button', { class: 'btn sm', type: 'button', dataset: { fk: 'prep' }, onclick: (e) => busyRun(e.currentTarget, () => ctrl.prepareMine()) }, icon('wrench'), t('party.prepareNow')));
    }
    const readySwitch = switchEl(p.myReady, (v) => ctrl.setMyReady(v), t('party.imReady'));
    const readyInput = readySwitch.querySelector('input');
    readyInput.dataset.fk = 'ready';
    if (prep !== 'ok' && !p.myReady) readyInput.disabled = true;
    return h(
      'div',
      { class: 'pt-sec' },
      h('div', { class: 'pt-sec-head' }, h('h4', {}, t('party.planTitle'))),
      packView(ctrl, p.plan, inst),
      targetLine(ctrl, snap),
      mine,
      h('div', { class: 'toggle-row pt-ready' }, h('div', { class: 'tr-text' }, h('div', { class: 'tr-title' }, t('party.imReady')), h('div', { class: 'tr-sub' }, prep === 'ok' ? t('party.imReadySub') : t('party.imReadyNeedsPrep'))), readySwitch),
    );
  }

  function voiceView(snap) {
    const p = snap.party;
    const leader = snap.role === 'leader';
    let content;
    if (p.voice) {
      content = h(
        'div',
        { class: 'pt-voice' },
        icon('mic'),
        h('div', { class: 'spacer' }, h('div', { class: 'pt-voice-title' }, t('party.voiceActive')), h('div', { class: 'small muted' }, t('party.voiceCode', { code: p.voice }))),
        leader
          ? h('button', { class: 'btn sm', type: 'button', dataset: { fk: 'voice' }, onclick: () => (m.close(), navigate('voice')) }, icon('headphones'), t('party.openVoice'))
          : h('button', { class: 'btn sm tonal', type: 'button', dataset: { fk: 'voice' }, onclick: (e) => busyRun(e.currentTarget, () => ctrl.joinPartyVoice()) }, icon('mic'), t('party.joinVoice')),
      );
    } else if (leader) {
      content = h(
        'div',
        { class: 'pt-voice' },
        icon('mic'),
        h('div', { class: 'spacer small muted' }, t('party.voiceExplain')),
        h('button', { class: 'btn sm', type: 'button', dataset: { fk: 'voice' }, onclick: (e) => busyRun(e.currentTarget, () => ctrl.createVoiceRoom()) }, icon('plus'), t('party.createVoice')),
      );
    } else content = h('div', { class: 'pt-voice small muted' }, icon('micOff'), h('span', {}, t('party.noVoice')));
    return h('div', { class: 'pt-sec' }, h('div', { class: 'pt-sec-head' }, h('h4', {}, t('party.voiceTitle'))), content);
  }

  function footer(snap) {
    const p = snap.party;
    if (!p) return [h('span', { class: 'spacer' }), h('button', { class: 'btn ghost', type: 'button', onclick: () => m.close() }, t('party.close'))];
    if (snap.role === 'leader') {
      const complete = planComplete(p.plan);
      const alone = p.members.length < 2;
      const why = !complete ? t('party.playNoPlanText') : alone ? t('party.playAloneText') : t('party.playAllTip');
      return [
        h('button', { class: 'btn ghost danger', type: 'button', dataset: { fk: 'disband' }, onclick: async () => {
          if (await confirmDialog(t('party.disbandTitle'), t('party.disbandConfirm'), { okText: t('party.disband'), danger: true })) ctrl.disband();
        } }, icon('logout'), t('party.disband')),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn primary', type: 'button', disabled: !complete || alone, title: why, dataset: { fk: 'play' }, onclick: (e) => busyRun(e.currentTarget, async () => {
          if (await ctrl.playAll()) m.close();
        }) }, icon('play'), t('party.playAll')),
      ];
    }
    const playBtn = p.play
      ? h('button', { class: 'btn primary', type: 'button', disabled: p.pendingPlay, title: p.pendingPlay ? t('party.waitingWorldText') : null, dataset: { fk: 'join' }, onclick: (e) => busyRun(e.currentTarget, async () => {
          if (await ctrl.joinPartyGame()) m.close();
        }) }, icon('play'), p.pendingPlay ? t('party.waitingWorldShort') : t('party.joinGame'))
      : null;
    return [
      h('button', { class: 'btn ghost danger', type: 'button', dataset: { fk: 'leave' }, onclick: async () => {
        if (await confirmDialog(t('party.leaveTitle'), t('party.leaveConfirm', { name: p.leaderName }), { okText: t('party.leave'), danger: true })) ctrl.leaveParty();
      } }, icon('logout'), t('party.leave')),
      h('span', { class: 'spacer' }),
      playBtn || h('button', { class: 'btn ghost', type: 'button', onclick: () => m.close() }, t('party.close')),
    ];
  }

  function render() {
    if (!ui.alive) return;
    // Con un selector abierto no se redibuja (se cerraría la lista): se espera a que pierda el foco
    const active = document.activeElement;
    if (active?.tagName === 'SELECT' && m.el.contains(active)) {
      if (!ui.deferred) {
        ui.deferred = true;
        active.addEventListener('blur', () => {
          ui.deferred = false;
          setTimeout(render, 0);
        }, { once: true });
      }
      return;
    }
    const snap = ctrl.snapshot();
    const p = snap.party;
    if (sub) {
      const text = p ? (snap.role === 'leader' ? t('party.subLeader', { count: p.members.length, max: MAX_MEMBERS }) : t('party.subMember', { name: p.leaderName })) : snap.joining ? t('party.joining', { name: snap.joining.leaderName }) : t('party.subNone');
      sub.textContent = text;
      sub.title = text;
    }
    keepFocus(m.el, () => {
      if (snap.gate === 'signin' || snap.gate === 'cloud') {
        mount(body, emptyState('logIn', t('party.signInTitle'), t('party.signInText'), h('button', { class: 'btn primary', type: 'button', onclick: () => (m.close(), navigate('settings/cloud')) }, icon('logIn'), t('party.signIn'))));
      } else if (snap.gate && !p) mount(body, gateView(snap.gate));
      else if (snap.joining) mount(body, loading(t('party.joining', { name: snap.joining.leaderName })));
      else if (!p) mount(body, noPartyView(snap));
      else {
        mount(
          body,
          h(
            'div',
            { class: 'pt-grid' },
            h('div', { class: 'pt-col' }, membersView(snap), snap.role === 'leader' ? friendsView(snap) : null, snap.role === 'member' ? invitesView(snap) : null),
            h('div', { class: 'pt-col' }, snap.role === 'leader' ? leaderPlanView(snap) : memberPlanView(snap), voiceView(snap)),
          ),
        );
      }
      mount(foot, footer(snap));
    });
  }

  const offs = [ctrl.onChange(() => render()), store.on('instances', () => render()), social.on('friends', () => render()), social.on('presence', () => render())];
  const off = () => offs.splice(0).forEach((fn) => fn());
  render();
  return m;
}

// ---------- Tarjeta (Multijugador o Inicio) ----------

export function mountPartyCard(root, ctrl) {
  const draw = () => {
    const snap = ctrl.snapshot();
    const p = snap.party;
    const head = (sub) => h('div', { class: 'card-head' }, h('div', {}, h('div', { class: 'card-title' }, icon('ptPartyUsers'), t('party.cardTitle')), h('div', { class: 'card-sub' }, sub)));
    if (snap.gate === 'signin' || snap.gate === 'cloud') {
      mount(root, head(t('party.cardSignIn')), h('div', { class: 'pt-card-actions' }, h('button', { class: 'btn tonal sm', type: 'button', onclick: () => navigate('settings/cloud') }, icon('logIn'), t('party.signIn'))));
      return;
    }
    if (snap.gate === 'service') {
      mount(root, head(t('party.serviceDownText')));
      return;
    }
    if (!p) {
      const online = (Array.isArray(social.friends) ? social.friends : []).filter((f) => isOnline(f.presence)).slice(0, 5);
      mount(
        root,
        head(snap.joining ? t('party.joining', { name: snap.joining.leaderName }) : t('party.cardText', { max: MAX_MEMBERS })),
        snap.invites.length
          ? h('div', { class: 'pt-card-invite' }, icon('send'), h('span', { class: 'spacer ellipsis' }, t('party.cardInvite', { name: snap.invites[0].name })), h('button', { class: 'btn sm tonal', type: 'button', onclick: (e) => busyRun(e.currentTarget, () => ctrl.acceptInvite(snap.invites[0].leader)) }, icon('check'), t('party.accept')))
          : null,
        h(
          'div',
          { class: 'pt-card-actions' },
          online.length ? h('div', { class: 'pt-faces', 'aria-label': t('party.friendsOnline', { count: online.length }), role: 'img' }, online.map((f) => avatarOf(f.id, f.name, 28))) : null,
          online.length ? h('span', { class: 'small muted' }, t('party.friendsOnline', { count: online.length })) : null,
          h('span', { class: 'spacer' }),
          h('button', { class: 'btn tonal sm', type: 'button', disabled: Boolean(snap.joining), onclick: () => ctrl.createParty().then((created) => created && ctrl.open()) }, icon('plus'), t('party.create')),
        ),
      );
      return;
    }
    const readyCount = p.members.filter((x) => x.leader || x.ready).length;
    const summary = p.plan ? [ctrl.planGame(p.plan), ctrl.planWhere(p.plan)].filter(Boolean).join(' · ') : t('party.cardNoPlan');
    mount(
      root,
      head(snap.role === 'leader' ? t('party.subLeader', { count: p.members.length, max: MAX_MEMBERS }) : t('party.subMember', { name: p.leaderName })),
      h(
        'div',
        { class: 'pt-card-party' },
        h('div', { class: 'pt-faces', role: 'list', 'aria-label': t('party.membersTitle') }, p.members.map((mb) => h('span', { class: ['pt-face', (mb.leader || mb.ready) && 'ready'], role: 'listitem', title: mb.name, 'aria-label': mb.leader || mb.ready ? t('party.faceReady', { name: mb.name }) : t('party.faceNotReady', { name: mb.name }) }, avatarOf(mb.id, mb.name, 30)))),
        h('div', { class: 'pt-card-plan' }, h('div', { class: 'ellipsis', title: summary }, summary), h('div', { class: 'small muted' }, t('party.readyCount', { count: readyCount, total: p.members.length }))),
      ),
      h(
        'div',
        { class: 'pt-card-actions' },
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn sm', type: 'button', onclick: () => ctrl.open() }, icon('ptPartyUsers'), t('party.openPanel')),
        snap.role === 'leader' ? h('button', { class: 'btn sm tonal', type: 'button', disabled: !planComplete(p.plan) || p.members.length < 2, onclick: (e) => busyRun(e.currentTarget, () => ctrl.playAll()) }, icon('play'), t('party.playAll')) : null,
      ),
    );
  };
  const offs = [ctrl.onChange(draw), social.on('friends', draw), social.on('presence', draw)];
  draw();
  return () => offs.splice(0).forEach((fn) => fn());
}
