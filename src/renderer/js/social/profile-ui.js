// Piezas visuales del modulo social: punto de presencia, cabeza de Minecraft, insignias, la tarjeta de perfil
// (con banner, fade, nombre con estilo, marco, titulo, servidores favoritos, estadisticas y capturas destacadas)
// y las acciones sobre un amigo (unirse a su servidor, invitar a voz, quitar, bloquear).
// "Mi perfil" abre el editor de features/profile-editor.js.
// Se pueden usar desde cualquier pagina: cargan solas su hoja de estilos y sus textos.
import { h, icon, mount, modal, toast, ok, fail, confirmDialog, copyText, avatarImg, ensureCss, registerIcons, fmtAgo, fmtDate, fmtDuration, loaderBadge, instanceLoaderKey, LOADERS } from '../ui.js';
import { store, api } from '../store.js';
import { t, loadNs, locale } from '../i18n.js';
import { social } from '../social.js';
import { cloud } from '../cloud.js';
import { badgesOf, headId, presenceLabel, activityLine, isJoinable, MY_STATUSES } from './cosmetics.js';
import { ensureProfileStyle, normalize, styledName, applyFrame, bannerEl as profileBanner, gradientCss, premiumChip, rankChip, cardStyleAttrs } from './profile-style.js';
import { mergeProfiles } from '../features/profile-editor/model.js';
import { achievementInfo } from '../pages/achievements/names.js';
import { shouldAutoplaySong } from './logic.js';

registerIcons({
  scCheckCheck: '<path d="M18 6 7 17l-5-5"/><path d="m22 10-7.5 7.5L13 16"/>',
  scReply: '<polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>',
  scSmilePlus: '<path d="M22 11v1a10 10 0 1 1-9-10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" x2="9.01" y1="9" y2="9"/><line x1="15" x2="15.01" y1="9" y2="9"/><path d="M16 5h6"/><path d="M19 2v6"/>',
  scUserMinus: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="22" x2="16" y1="11" y2="11"/>',
  scInbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  scArrowDown: '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
  scSend: '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
});

// Hoja de estilos y textos del modulo (por si se abre una tarjeta fuera de la pagina de Mensajes).
export async function prepareSocialUi() {
  ensureCss('pages/messages');
  ensureCss('features/profile-social');
  await Promise.all([loadNs('social'), ensureProfileStyle(), loadNs('achievements').catch(() => null)]);
  // Bandeja de regalos (3.1): avisa cuando llega uno nuevo
}

// ---------- Piezas ----------
export function presenceDot(presence, cls = '') {
  const p = ['online', 'away', 'busy', 'offline', 'invisible'].includes(presence) ? presence : 'offline';
  const label = presenceLabel(p);
  return h('span', { class: ['sc-dot', p, cls], role: 'img', 'aria-label': label, title: label });
}

// Acepta la fila de social (mc_uuid, mc_name, username) o el perfil normalizado (mcUuid, mcName)
const headSource = (profile) => (profile && ('mcName' in profile || 'mcUuid' in profile) ? { mc_uuid: profile.mcUuid, mc_name: profile.mcName, username: profile.username } : profile);

export function headImg(profile, size = 36, cls = '') {
  const img = avatarImg(headId(headSource(profile)), size > 48 ? 128 : 64, ['sc-head', cls].filter(Boolean).join(' '));
  img.style.width = `${size}px`;
  img.style.height = `${size}px`;
  return img;
}

export function headWithDot(profile, presence, size = 36) {
  return h('span', { class: 'sc-headwrap', style: { width: `${size}px`, height: `${size}px` } }, headImg(profile, size), presence ? presenceDot(presence) : null);
}

export function badgeChips(profile, { compact = false, max = 8, rank = true } = {}) {
  const list = badgesOf(profile, { rank }).slice(0, max);
  if (!list.length) return null;
  return h(
    'span',
    { class: ['sc-badges', compact && 'compact'] },
    list.map((b) =>
      h(
        'span',
        { class: 'sc-badge', title: b.label, 'aria-label': b.label, style: { '--c': b.color } },
        icon(b.icon),
        compact ? null : h('span', {}, b.label),
      ),
    ),
  );
}

// ---------- Tarjeta de perfil ----------
const P = (k, vars) => t(`profile.${k}`, vars);

function statTiles(stats) {
  if (!stats) return null;
  const nf = (n, max = 0) => {
    try {
      return new Intl.NumberFormat(locale(), { maximumFractionDigits: max }).format(n);
    } catch {
      return String(n);
    }
  };
  const tile = (value, label) => h('div', { class: 'pf-stat' }, h('div', { class: 'pf-stat-value', title: typeof value === 'string' ? value : null }, value), h('div', { class: 'pf-stat-label' }, label));
  const tiles = [];
  if (Number.isFinite(stats.hours)) tiles.push(tile(P('hoursShort', { hours: nf(stats.hours, stats.hours < 10 ? 1 : 0) }), P('statHours')));
  if (Number.isFinite(stats.sessions)) tiles.push(tile(nf(stats.sessions), P('statSessions')));
  if (stats.topVersion) tiles.push(tile(stats.topVersion, P('statVersion')));
  if (stats.topLoader) tiles.push(tile(LOADERS[stats.topLoader] ? loaderBadge(stats.topLoader) : stats.topLoader, P('statLoader')));
  if (stats.since) {
    const d = new Date(`${stats.since}T12:00:00`);
    if (Number.isFinite(d.getTime())) tiles.push(tile(fmtDate(d.getTime(), { month: 'short', year: 'numeric' }), P('statSince')));
  }
  for (const k of ['daysPlayed', 'bestStreak', 'longestHours', 'versions', 'loaders', 'instances', 'worlds', 'blocks', 'mobs', 'deaths', 'distanceKm']) {
    if (stats[k] > 0) tiles.push(tile(nf(stats[k], k === 'longestHours' || k === 'distanceKm' ? 1 : 0), P(`stat_${k}`)));
  }
  return tiles.length ? h('div', { class: 'pf-stats' }, tiles) : null;
}

async function joinFavorite(address) {
  try {
    const { joinServer } = await import('../features/serverlist.js');
    await joinServer(address);
  } catch (err) {
    fail(t('social.joinFailed'), err);
  }
}

function serverRows(servers, { preview, onAction }) {
  if (!servers?.length) return null;
  return h(
    'div',
    { class: 'pf-servers' },
    servers.map((s) =>
      h(
        'div',
        { class: 'pf-server' },
        h('span', { class: 'pf-server-icon' }, icon('server')),
        h('div', { class: 'pf-server-main' }, h('span', { class: 'pf-server-name ellipsis', title: s.name || s.address }, s.name || s.address), s.name ? h('span', { class: 'pf-server-addr ellipsis', title: s.address }, s.address) : null),
        h(
          'button',
          {
            class: 'btn tonal sm',
            type: 'button',
            disabled: preview,
            title: P('joinServerTitle', { address: s.address }),
            'aria-label': P('joinServerTitle', { address: s.address }),
            onclick: () => {
              onAction?.();
              joinFavorite(s.address);
            },
          },
          icon('play'),
          P('joinServer'),
        ),
      ),
    ),
  );
}

function openShot(shot) {
  modal({
    title: shot.title || P('featuredTitle'),
    size: 'wide',
    body: h('div', { class: 'pf-lightbox' }, h('img', { src: shot.url, alt: shot.title || P('featuredAlt') })),
  });
}

function featuredGrid(list, { preview }) {
  if (!list?.length) return null;
  return h(
    'div',
    { class: 'pf-featured' },
    list.map((f, i) =>
      h(
        'button',
        { class: 'pf-shot', type: 'button', disabled: preview, title: f.title || P('featuredAlt'), 'aria-label': f.title ? P('featuredOpen', { title: f.title }) : P('featuredOpenN', { n: i + 1 }), onclick: () => openShot(f) },
        h('img', { src: f.url, alt: '', loading: 'lazy', decoding: 'async' }),
        f.title ? h('span', { class: 'pf-shot-title' }, f.title) : null,
      ),
    ),
  );
}

// Redes del perfil: abren en el navegador (ya estan filtradas a sitios conocidos)
function linkRow(links, { preview }) {
  if (!links?.length) return null;
  return h(
    'div',
    { class: 'pf-links' },
    links.map((l) =>
      h(
        'button',
        {
          class: 'pf-link',
          type: 'button',
          disabled: preview,
          title: l.url,
          onclick: async () => {
            const { openLink } = await import('../community.js');
            openLink(l.url);
          },
        },
        icon('link'),
        h('span', {}, P(`link_${l.kind}`)),
      ),
    ),
  );
}

// Logros destacados
function pinnedAchievements(list) {
  if (!list?.length) return null;
  return h(
    'div',
    { class: 'pf-achs' },
    list.map((a) => {
      const info = achievementInfo(a.id);
      return h(
        'div',
        { class: 'pf-ach', dataset: { tier: info.tier }, title: info.desc || info.name },
        h('span', { class: 'pf-ach-icon' }, icon(info.icon)),
        h('span', { class: 'pf-ach-main' }, h('span', { class: 'pf-ach-name' }, info.name), h('span', { class: 'pf-ach-tier' }, a.at ? `${info.tierLabel} · ${fmtDate(a.at)}` : info.tierLabel)),
      );
    }),
  );
}

// Clips destacados: se reproducen al tocarlos (preload none: no baja nada hasta entonces)
function pinnedClips(list) {
  const clips = (list || []).filter((c) => c.url);
  if (!clips.length) return null;
  return h(
    'div',
    { class: 'pf-clips' },
    clips.map((c) => h('div', { class: 'pf-clip' }, h('video', { src: c.url, controls: true, preload: 'none', playsinline: true, 'aria-label': c.title || P('pinnedClips') }), c.title ? h('span', { class: 'pf-clip-title', title: c.title }, c.title) : null)),
  );
}

// Insignias por logros raros (3.1): chips con el icono del logro
function rareBadgeChips(list) {
  const items = (list || []).map((a) => ({ a, info: achievementInfo(a.id) })).filter((x) => x.info);
  if (!items.length) return null;
  return h(
    'div',
    { class: 'pf-rare', role: 'list', 'aria-label': P('rareBadges') },
    items.map(({ a, info }) =>
      h('span', { class: 'pf-rare-chip', role: 'listitem', dataset: { rarity: info.tier === 'netherite' ? 'legendary' : 'epic' }, title: a.at ? `${info.name} · ${fmtDate(a.at)}` : info.name }, icon(info.icon), h('span', {}, info.name)),
    ),
  );
}

// Skin en 3D: se pide recien cuando el visitante toca el boton (consulta a Mojang). Con la pose y el fondo elegidos (3.1).
function skinBlock(n, { preview }) {
  if (!n.showcase?.skin || !n.mcName) return null;
  const box = h('div', { class: 'pf-skin-box' });
  const btn = h('button', { class: 'btn tonal sm', type: 'button', disabled: preview }, icon('user'), P('skinView', { name: n.mcName }));
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      ensureCss('pages/skins');
      await loadNs('skins').catch(() => null);
      const [{ createViewer }, { loadImage, normalizeSkin }] = await Promise.all([import('../pages/skins/viewer.js'), import('../pages/skins/texture.js')]);
      const res = await api.invoke('skins:publicSkin', n.mcName);
      const norm = normalizeSkin(await loadImage(res.dataUrl));
      const viewer = createViewer({ label: P('skinViewerLabel', { name: n.mcName }) });
      viewer.setSkin(norm.canvas, res.variant);
      const pose = n.showcase.skinPose || 'stand';
      const bg = n.showcase.skinBg || 'none';
      mount(box, h('div', { class: ['pf-skin-stage', pose !== 'stand' && `pf-skin-pose-${pose}`, bg !== 'none' && `pf-skinbg-${bg}`] }, viewer.el));
    } catch (err) {
      console.warn('[perfil] skin:', err?.code || err?.message || err);
      btn.disabled = false;
      toast('bad', P('skinFailed'));
    }
  });
  mount(box, btn);
  return box;
}

const section = (iconName, label, content) => (content ? h('div', { class: 'pf-sec' }, h('div', { class: 'pf-sec-label' }, icon(iconName), h('span', {}, label)), content) : null);

// Cancion de perfil (3.1): solo llega para los amigos y el dueño (profile_public); el reproductor se carga aparte
function songBox(n, { preview, self, friend }) {
  if (!n.song?.url) return null;
  const box = h('div', { class: 'pf-song-box' });
  import('./song.js')
    .then((m) => {
      if (!box.isConnected && !preview) return;
      const el = m.songPlayer(n.song, { name: n.name, autoplay: shouldAutoplaySong({ song: n.song, allowed: m.songsAllowed(), preview, self, friend: Boolean(friend) }) });
      if (el) mount(box, el);
    })
    .catch((err) => console.warn('[profile] cancion:', err?.message || err));
  return box;
}

// Libro de visitas (3.1): se muestra si el dueño lo prendio (card_style.guestbook)
function guestbookBox(n, { preview, self, friend }) {
  if (!n.cardStyle?.guestbook || !n.id) return null;
  const box = h('div', { class: 'pf-gb-box' });
  if (preview) {
    mount(box, h('div', { class: 'pf-gb-empty' }, icon('message'), P('guestbookOn')));
    return box;
  }
  import('./guestbook.js')
    .then((m) => mount(box, m.guestbookSection(n.id, { isMe: self, isFriend: Boolean(friend), preview })))
    .catch((err) => console.warn('[profile] libro de visitas:', err?.message || err));
  return box;
}

/**
 * Tarjeta del perfil (modal de perfil, vista previa del editor y donde haga falta).
 * profile: fila de profiles o perfil de profile_public. full: agrega actividad, descripcion, servidores favoritos,
 * estadisticas, capturas destacadas y datos. preview: vista previa del editor (botones inactivos, acepta blob:).
 */
export function profileCard(profile, { presence = 'offline', statusText = '', self = false, full = false, compact = false, friend = null, preview = false, onJoin, onAction } = {}) {
  ensureProfileStyle();
  ensureCss('features/profile-social');
  const n = normalize(profile, { allowLocalMedia: preview });
  const fade = gradientCss(n);
  const name = n.name || t('social.someone');
  const head = applyFrame(
    h('span', { class: 'sc-headwrap pf-card-head', style: { width: '76px', height: '76px' } }, headImg(n, 76), presence ? presenceDot(presence) : null),
    n,
  );
  const sub = [n.pronouns ? h('span', { class: 'ellipsis', title: n.pronouns }, n.pronouns) : null, n.username ? h('span', { class: 'ellipsis', title: `@${n.username}` }, `@${n.username}`) : null].filter(Boolean);
  const showStatus = presence || statusText;
  const body = [
    h('div', { class: 'pf-card-top' }, head, h('div', { class: 'pf-card-chips' }, rankChip(n), badgeChips(n, { compact: true, max: 6, rank: false }))),
    h(
      'div',
      { class: 'pf-card-names' },
      h('div', { class: 'pf-card-name-line' }, styledName(n, { size: 'lg' })),
      sub.length ? h('div', { class: 'pf-card-sub' }, sub.flatMap((s, i) => (i ? [h('span', { class: 'pf-dot-sep', 'aria-hidden': 'true' }), s] : [s]))) : null,
    ),
    rareBadgeChips(n.showcase?.rareBadges),
    showStatus
      ? h(
          'div',
          { class: 'pf-card-status' },
          presenceDot(presence),
          h('span', { class: 'pf-card-presence' }, self && presence === 'invisible' ? t('social.presence_invisible') : presenceLabel(presence)),
          statusText ? h('span', { class: 'pf-card-statustext ellipsis', title: statusText }, statusText) : null,
        )
      : null,
  ];
  if (full) {
    const facts = [
      friend?.since ? h('div', { class: 'pf-fact' }, icon('heart'), t('social.friendsSince', { date: fmtDate(friend.since) })) : null,
      n.mcName ? h('div', { class: 'pf-fact' }, icon('pickaxe'), t('social.mcName', { name: n.mcName })) : null,
      n.createdAt ? h('div', { class: 'pf-fact' }, icon('calendar'), P('memberSince', { date: fmtDate(n.createdAt, { month: 'long', year: 'numeric' }) })) : null,
      n.friendCode
        ? h(
            'div',
            { class: 'pf-fact' },
            icon('hash'),
            h('span', { class: 'kbd selectable priv' }, n.friendCode),
            h('button', { class: 'icon-btn sm', type: 'button', title: t('social.copyCode'), 'aria-label': t('social.copyCode'), onclick: () => copyText(n.friendCode, t('social.codeCopied')) }, icon('copy')),
          )
        : null,
    ].filter(Boolean);
    body.push(
      friend?.presence === 'offline' && friend.lastSeen ? h('div', { class: 'pf-profile-note' }, icon('clock'), t('social.lastSeen', { ago: fmtAgo(friend.lastSeen) })) : null,
      friend ? activityBlock(friend, { onJoin }) : null,
      section('music', P('song'), songBox(n, { preview, self, friend })),
      section('user', t('social.about'), n.bio ? h('div', { class: 'pf-bio selectable' }, n.bio) : null),
      section('link', P('links'), linkRow(n.links, { preview })),
      section('trophy', Number.isFinite(n.achievementCount) ? P('pinnedAchCount', { n: n.achievementCount, total: n.achievementTotal || '?' }) : P('pinnedAch'), pinnedAchievements(n.showcase.achievements)),
      section('server', P('favoriteServers'), serverRows(n.favoriteServers, { preview, onAction })),
      section('chart', P('publicStats'), statTiles(n.publicStats)),
      section('camera', P('pinnedClips'), pinnedClips(n.showcase.clips)),
      section('user', P('showcaseSkin'), skinBlock(n, { preview })),
      section('camera', P('featured'), featuredGrid(n.featured, { preview })),
      section('message', P('guestbook'), guestbookBox(n, { preview, self, friend })),
      facts.length ? h('div', { class: 'pf-divider', role: 'presentation' }) : null,
      facts.length ? h('div', { class: 'pf-facts' }, facts) : null,
    );
  }
  const look = cardStyleAttrs(n);
  return h(
    'article',
    { class: ['pf-card', fade && 'has-fade', compact && 'compact', ...look.classes], style: { ...(fade ? { '--pf-fade': fade, '--pf-fade-to': n.theme.to } : {}), ...look.vars }, 'aria-label': P('cardAria', { name }) },
    profileBanner(n, { cls: 'pf-card-banner' }),
    h('div', { class: 'pf-card-body' }, body),
  );
}

// Bloque "Jugando ahora" con boton Unirse.
export function activityBlock(friend, { onJoin } = {}) {
  const act = friend?.activity;
  if (!act) return null;
  const joinable = isJoinable(act);
  return h(
    'div',
    { class: 'sc-activity' },
    h('div', { class: 'sc-activity-icon' }, icon(act.type === 'server' ? 'server' : act.type === 'singleplayer' ? 'globe' : 'gamepad')),
    h(
      'div',
      { class: 'sc-activity-main' },
      h('div', { class: 'sc-activity-title' }, t('social.playingNow')),
      h('div', { class: 'sc-activity-line ellipsis', title: activityLine(act) }, activityLine(act)),
      h(
        'div',
        { class: 'sc-activity-meta' },
        act.loader ? loaderBadge(act.loader, act.mcVersion || null) : act.mcVersion ? h('span', { class: 'badge' }, act.mcVersion) : null,
        act.instanceName ? h('span', { class: 'sc-activity-inst ellipsis', title: act.instanceName }, act.instanceName) : null,
        act.since ? h('span', { class: 'sc-activity-since' }, t('social.playingFor', { time: fmtDuration(Date.now() - act.since) })) : null,
      ),
    ),
    // Unirme con el tinte de acento (igual que en Inicio y Multijugador): no compite con la accion principal
    joinable ? h('button', { class: 'btn tonal sm', type: 'button', onclick: () => (onJoin ? onJoin() : joinFriend(friend)) }, icon('play'), t('social.join')) : null,
  );
}

// ---------- Menu emergente sencillo ----------
let openMenuState = null;
export function popMenu(anchor, items) {
  if (openMenuState) {
    const same = openMenuState.anchor === anchor;
    openMenuState.close();
    if (same) return;
  }
  const list = items.filter(Boolean);
  const buttons = list.map((it) =>
    h(
      'button',
      {
        class: ['sc-menu-item', it.danger && 'danger', it.active && 'active'],
        type: 'button',
        role: it.active !== undefined ? 'menuitemradio' : 'menuitem',
        'aria-checked': it.active !== undefined ? String(Boolean(it.active)) : null,
        onclick: () => {
          close();
          it.run();
        },
      },
      it.icon ? (typeof it.icon === 'string' ? icon(it.icon) : it.icon) : null,
      h('span', {}, it.label),
      it.active ? icon('check', 'sc-menu-check') : null,
    ),
  );
  // Las acciones destructivas quedan separadas de las comunes
  const firstDanger = list.findIndex((it) => it.danger);
  const children = buttons.flatMap((b, i) => (i === firstDanger && i > 0 ? [h('div', { class: 'sc-menu-sep', role: 'separator' }), b] : [b]));
  const menu = h('div', { class: 'sc-menu', role: 'menu' }, children);
  document.body.append(menu);
  if (anchor.hasAttribute('aria-haspopup')) anchor.setAttribute('aria-expanded', 'true');
  const r = anchor.getBoundingClientRect();
  const mr = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(window.innerWidth - mr.width - 8, r.right - mr.width))}px`;
  const below = r.bottom + 6;
  menu.style.top = `${below + mr.height > window.innerHeight - 8 ? Math.max(8, r.top - mr.height - 6) : below}px`;
  const onDown = (e) => {
    if (!menu.contains(e.target) && !anchor.contains(e.target)) close();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
      anchor.focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const i = buttons.indexOf(document.activeElement);
      const next = buttons[(i + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length];
      next?.focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      (e.key === 'Home' ? buttons[0] : buttons[buttons.length - 1])?.focus();
    } else if (e.key === 'Tab') {
      // Tab sale del menu (como en los menus del sistema) y lo cierra
      close();
    }
  };
  function close() {
    menu.remove();
    if (anchor.hasAttribute('aria-haspopup')) anchor.setAttribute('aria-expanded', 'false');
    document.removeEventListener('mousedown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', close);
    if (openMenuState?.menu === menu) openMenuState = null;
  }
  setTimeout(() => {
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('resize', close);
  }, 0);
  document.addEventListener('keydown', onKey, true);
  buttons[0]?.focus();
  openMenuState = { menu, anchor, close };
}

// Elegir el estado propio (En linea / Ausente / No molestar / Invisible).
export function statusMenu(anchor) {
  const current = social.prefs().status;
  popMenu(
    anchor,
    MY_STATUSES.map((s) => ({
      label: presenceLabel(s),
      icon: presenceDot(s, 'sc-menu-dot'),
      active: current === s,
      run: () => social.setStatus(s).catch((err) => fail(t('social.saveFailed'), err)),
    })),
  );
}

// ---------- Acciones sobre un amigo ----------
export async function joinFriend(friend) {
  const act = friend?.activity;
  if (!isJoinable(act)) return;
  try {
    const { joinServer } = await import('../features/serverlist.js');
    // instancia local con la misma version y loader que la del amigo (si hay)
    const inst = store.instances.find((i) => i.mcVersion === act.mcVersion && (!act.loader || instanceLoaderKey(i) === act.loader));
    await joinServer(act.address, inst ? { instanceId: inst.id } : {});
  } catch (err) {
    fail(t('social.joinFailed'), err);
  }
}

export async function inviteToVoice(friend) {
  try {
    const { voice } = await import('../voice.js');
    if (typeof voice?.inviteFriend !== 'function') {
      toast('info', t('social.voiceUnavailable'), t('social.voiceUnavailableText'));
      return;
    }
    await voice.inviteFriend(friend.id);
    ok(t('social.voiceInvited', { name: friend.name }));
  } catch (err) {
    fail(t('social.voiceInviteFailed'), err);
  }
}

export async function confirmRemoveFriend(friend) {
  if (!(await confirmDialog(t('social.removeTitle'), t('social.removeConfirm', { name: friend.name }), { okText: t('social.remove'), danger: true }))) return false;
  try {
    await social.removeFriend(friend.id);
    ok(t('social.removed', { name: friend.name }));
    return true;
  } catch (err) {
    fail(t('social.actionFailed'), err);
    return false;
  }
}

export async function confirmBlock(user) {
  if (!(await confirmDialog(t('social.blockTitle'), t('social.blockConfirm', { name: user.name }), { okText: t('social.block'), danger: true }))) return false;
  try {
    await social.blockUser(user.id);
    ok(t('social.blocked', { name: user.name }));
    return true;
  } catch (err) {
    fail(t('social.actionFailed'), err);
    return false;
  }
}

// ---------- Perfil publico (profile_public, con cache corta) ----------
const PUBLIC_TTL = 60_000;
const publicCache = new Map(); // id -> { at, data }
let publicWarned = false;

/** Perfil completo de cualquier usuario (camelCase) o null si no se pudo (sin sesion, sin servicio o no existe). */
export async function fetchPublicProfile(userId, { force = false } = {}) {
  if (!userId) return null;
  const c = publicCache.get(userId);
  if (!force && c && Date.now() - c.at < PUBLIC_TTL) return c.data;
  try {
    await cloud.ready();
    if (!cloud.isSignedIn()) return null;
    const { data, error } = await cloud.client.rpc('profile_public', { p_user: userId });
    if (error) throw error;
    const out = data && typeof data === 'object' ? data : null;
    publicCache.set(userId, { at: Date.now(), data: out });
    return out;
  } catch (err) {
    if (!publicWarned) {
      publicWarned = true;
      console.warn('[profile] profile_public:', err?.message || err);
    }
    return null;
  }
}

// Despues de guardar el perfil propio
export function forgetPublicProfile(userId) {
  publicCache.delete(userId);
}

// ---------- Perfil de otro usuario (o el propio) ----------
export async function openProfile(userId, { profile: given = null } = {}) {
  await prepareSocialUi();
  const friend = social.friendById(userId);
  let base = given || social.profileOf(userId) || friend?.profile || null;
  if (!base) {
    base = await fetchPublicProfile(userId);
    if (!base) {
      fail(P('loadFailed'), P('loadFailedText'));
      return null;
    }
  }
  const myId = social.userId || cloud.user?.id || null;
  const isMe = Boolean(myId && userId === myId);
  const name = normalize(base).name || t('social.someone');
  const pres = friend || isMe ? social.presenceOf(userId) : { presence: null, statusText: base.status_text || '' };
  const incoming = social.requests.incoming.find((r) => r.id === userId);
  const outgoing = social.requests.outgoing.find((r) => r.id === userId);
  const isBlocked = social.blocked.some((b) => b.id === userId);
  const user = { id: userId, name };

  const act = (fn) => async () => {
    m.close();
    await fn();
  };
  const footer = [];
  if (isMe) {
    footer.push(
      h('button', { class: 'btn ghost', type: 'button', onclick: act(() => import('../features/profile-editor.js').then((mod) => mod.openShareProfile())) }, icon('share'), P('shareProfile')),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn primary', type: 'button', onclick: act(() => openMyProfile()) }, icon('palette'), P('editProfile')),
    );
  } else if (friend) {
    footer.push(
      h('button', { class: 'icon-btn danger', type: 'button', title: t('social.block'), 'aria-label': t('social.block'), onclick: act(() => confirmBlock(user)) }, icon('ban')),
      h('button', { class: 'icon-btn danger', type: 'button', title: t('social.remove'), 'aria-label': t('social.remove'), onclick: act(() => confirmRemoveFriend(friend)) }, icon('scUserMinus')),
      reportBtn(),
      h('span', { class: 'spacer' }),
      // Regalar (3.1): puntos o un cosmetico de la tienda
      h('button', { class: 'btn', type: 'button', onclick: () => import('./gifts.js').then((m) => m.openGiftDialog({ id: userId, name, profile: latestPub })).catch((e) => fail(P('giftFailed'), e)) }, icon('sparkles'), P('gift')),
      h('button', { class: 'btn', onclick: act(() => inviteToVoice(friend)), disabled: friend.presence === 'offline', title: friend.presence === 'offline' ? t('social.friendOffline') : null }, icon('mic'), t('social.inviteVoice')),
      h('button', { class: 'btn primary', onclick: act(() => social.openChat(userId)) }, icon('message'), t('social.sendMessage')),
    );
  } else if (incoming) {
    footer.push(
      h('button', { class: 'btn ghost', onclick: act(() => social.declineRequest(userId).catch((e) => fail(t('social.actionFailed'), e))) }, icon('x'), t('social.decline')),
      h('button', { class: 'btn primary', onclick: act(() => social.acceptRequest(userId).then(() => ok(t('social.nowFriends', { name }))).catch((e) => fail(t('social.actionFailed'), e))) }, icon('check'), t('social.accept')),
    );
  } else if (outgoing) {
    footer.push(h('button', { class: 'btn ghost', onclick: act(() => social.cancelRequest(userId).catch((e) => fail(t('social.actionFailed'), e))) }, icon('x'), t('social.cancelRequest')));
  } else if (isBlocked) {
    footer.push(h('button', { class: 'btn', onclick: act(() => social.unblockUser(userId).catch((e) => fail(t('social.actionFailed'), e))) }, icon('check'), t('social.unblock')));
  }
  if (!isMe && !friend) footer.unshift(reportBtn());
  // Denunciar (3.1): la cancion o el contenido del perfil
  function reportBtn() {
    return h('button', { class: 'icon-btn', type: 'button', title: P('report'), 'aria-label': P('report'), onclick: () => import('./report.js').then((mod) => mod.openReportDialog({ id: userId, name, hasSong: Boolean(normalize(latestPub || base).song?.url) })).catch((e) => fail(P('reportFailed'), e)) }, icon('alert'));
  }

  let latestPub = null;
  const body = h('div', { class: 'pf-profile' });
  const draw = (p) =>
    mount(
      body,
      profileCard(p, {
        full: true,
        self: isMe,
        friend,
        // Sin presencia (no es amigo) el estado sale de profile_public, que ya lo manda vacio si vencio
        presence: pres.presence,
        statusText: friend || isMe ? pres.statusText : normalize(p).statusText,
        onJoin: friend ? act(() => joinFriend(friend)) : undefined,
        onAction: () => m.close(),
      }),
    );
  draw(base);
  const m = modal({ title: t('social.profileTitle', { name }), body, footer: footer.length ? footer : null, onClose: () => import('./song.js').then((s) => s.stopSongs()).catch(() => {}) });
  // Lo personalizado llega aparte (profile_public): se vuelve a dibujar cuando esta
  fetchPublicProfile(userId).then((pub) => {
    latestPub = pub;
    if (pub && body.isConnected) draw(mergeProfiles(base, pub));
  });
  return m;
}

// Tarjeta completa de un perfil que ya se tiene (vista previa de cosmeticos, capturas de desarrollo)
export async function previewProfile(profile, { title, presence = null } = {}) {
  await prepareSocialUi();
  const n = normalize(profile, { allowLocalMedia: true });
  return modal({
    title: title || t('social.profileTitle', { name: n.name || t('social.someone') }),
    body: h('div', { class: 'pf-profile' }, profileCard(profile, { full: true, preview: true, presence })),
  });
}

// ---------- Mi perfil (editor) ----------
export async function openMyProfile(opts) {
  try {
    const { openProfileEditor } = await import('../features/profile-editor.js');
    return await openProfileEditor(opts);
  } catch (err) {
    console.error('[profile] editor', err);
    fail(P('openFailed'), err);
    return null;
  }
}
