import { validateMessage } from './logic.js';
import { validateAppearance, validateChannelSettings, validateCategoryName, validateTopicTitle, isStaff } from '../../pages/communities/logic.js';
import { PERMS, ROLE_LIMITS, explainPerms, mergeOverrides, permApplies, permsFor, validateRoleName } from './permissions.js';
import { greetingVariablesOk, renderGreeting, emptyGreeting } from './greeting.js';
import { MEDIA_LIMITS } from './media.js';
// Comunidades de ejemplo para capturas (VENUS_DEVSHOT + VENUS_REWARDS_FAKE, como Venus Points): misma forma que las RPC de
// 0033 y 0038, en memoria y sin red. 'new' no tiene comunidades; 'member' entra como miembro común; 'unavailable' responde que no hay servicio.
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const HOUR = 3600000;
const DAY = 24 * HOUR;
const iso = (ms) => new Date(ms).toISOString();

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

const person = (userId, username, displayName = username) => ({ userId, username, displayName, mcName: username, mcUuid: null });
const ME = person('fake-me', 'Ringo');
const P = {
  tomi: person('f-tomi', 'TomiCraft'),
  luna: person('f-luna', 'Luna_MC', 'Luna'),
  nacho: person('f-nacho', 'ElNacho', 'El Nacho'),
  pixel: person('f-pixel', 'PixelRoja', 'Pixel'),
  mora: person('f-mora', 'MoraBlock', 'Mora'),
  fer: person('f-fer', 'FerMiner', 'Fer'),
};
const EMOJIS = ['like', 'love', 'laugh', 'wow', 'sad', 'party', 'fire', 'eyes'];
const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

/** Dibujo propio para los GIFs de ejemplo (una carita sobre un degradado): nada de arte de terceros. */
export const fakeArt = (label, hue = 210) => 'data:image/svg+xml;utf8,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240" viewBox="0 0 160 120"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 70% 55%)"/><stop offset="1" stop-color="hsl(${(hue + 70) % 360} 70% 32%)"/></linearGradient></defs><rect width="160" height="120" fill="url(#g)"/><circle cx="80" cy="50" r="26" fill="#fff" fill-opacity=".88"/><circle cx="70" cy="44" r="4" fill="#222"/><circle cx="90" cy="44" r="4" fill="#222"/><path d="M66 58 Q80 72 94 58" stroke="#222" stroke-width="4" fill="none" stroke-linecap="round"/><text x="80" y="106" font-size="12" text-anchor="middle" fill="#fff" font-family="sans-serif">${esc(label)}</text></svg>`);

export function createFakeGroups(scenario = 'demo', base) {
  const now = Date.now();
  const empty = scenario === 'new';
  const seq = { n: 1 };
  const newId = (p) => `${p}-${seq.n++}`;

  const channel = (id, kind, name, position, people = []) => ({ id, kind, name, position, people, topic: '', icon: { text: 'hash', voice: 'headphones', announcement: 'megaphone', forum: 'message-circle' }[kind] || 'hash', categoryId: null, slowmodeSeconds: 0, postingRole: kind === 'announcement' ? 'staff' : 'members', isPrivate: false, perm: { embeds: true, react: true, connect: true, speak: true }, rolePerms: {} });
  const communities = new Map([
    ['m-1', { id: 'm-1', name: 'Mina Central', description: 'La comunidad para los que juegan en la Mina. Reglas simples: respeto y nada de spam.', isPublic: true, createdAt: iso(now - 60 * DAY), inviteCode: 'COM-K3M9PQ', myRole: 'owner',
      channels: [channel('t-1', 'text', 'general', 0), channel('t-2', 'text', 'servidores', 1), channel('t-3', 'text', 'capturas', 2), channel('v-1', 'voice', 'general', 3, [P.tomi, P.luna]), channel('v-2', 'voice', 'en partida', 4)],
      members: [{ ...ME, role: 'owner', joinedAt: iso(now - 60 * DAY) }, { ...P.tomi, role: 'moderator', joinedAt: iso(now - 50 * DAY) }, { ...P.luna, role: 'member', joinedAt: iso(now - 40 * DAY) }, { ...P.nacho, role: 'member', joinedAt: iso(now - 20 * DAY), mutedUntil: iso(now + HOUR) }, { ...P.pixel, role: 'member', joinedAt: iso(now - 2 * DAY) }],
      bans: [{ ...P.fer, at: iso(now - 4 * DAY) }], extra: 214 }],
    ['m-2', { id: 'm-2', name: 'Técnicos de Redstone', description: 'Máquinas, granjas y dudas.', isPublic: true, createdAt: iso(now - 90 * DAY), inviteCode: 'COM-TTT222', myRole: 'member', channels: [channel('t-9', 'text', 'general', 0), channel('v-9', 'voice', 'taller', 1)], members: [{ ...P.pixel, role: 'owner', joinedAt: iso(now - 90 * DAY) }, { ...ME, role: 'member', joinedAt: iso(now - DAY) }], bans: [], extra: 58 }],
    ['m-3', { id: 'm-3', name: 'Constructores del Oeste', description: 'Mostrá lo que construiste.', isPublic: true, createdAt: iso(now - 30 * DAY), inviteCode: 'COM-WWW333', myRole: null, channels: [channel('t-7', 'text', 'general', 0)], members: [{ ...P.mora, role: 'owner', joinedAt: iso(now - 30 * DAY) }], bans: [], extra: 31 }],
  ]);
  for (const c of communities.values()) Object.assign(c, { theme: 'default', color: '#f6b45a', icon: 'users', banner: 'none', welcome: '', rules: '', categories: [], roles: [], media: [], greetings: { join: emptyGreeting(), leave: emptyGreeting() } });
  const demo = communities.get('m-1');
  Object.assign(demo, { color: '#c87939', icon: 'mountain', banner: 'sunset', welcome: 'Un lugar para construir y jugar juntos.', rules: 'Respetá a los demás.\nNo compartas datos personales.\nPublicá cada tema en su canal.',
    categories: [{ id: 'cat-info', name: 'La comunidad', position: 0 }, { id: 'cat-play', name: 'Jugamos juntos', position: 1 }] });
  demo.channels.unshift({ ...channel('a-1', 'announcement', 'novedades', -1), categoryId: 'cat-info', topic: 'Noticias y eventos de la comunidad.' });
  demo.channels.push({ ...channel('f-1', 'forum', 'proyectos', 5), categoryId: 'cat-play', topic: 'Compartí una idea y conversá en su propio hilo.' });
  demo.channels.push({ ...channel('s-1', 'text', 'equipo', 6), isPrivate: true, postingRole: 'staff', categoryId: 'cat-info' });
  demo.channels.forEach((ch) => { ch.categoryId ||= ch.kind === 'voice' || ch.kind === 'forum' ? 'cat-play' : 'cat-info'; });
  // Roles propios, permisos por canal y GIFs subidos de la comunidad de ejemplo.
  demo.roles = [{ id: 'r-build', name: 'Constructores', color: '#22c55e', position: 0 }, { id: 'r-news', name: 'Redactores', color: '#f59e0b', position: 1 }, { id: 'r-listen', name: 'Oyentes', color: '#06b6d4', position: 2 }];
  demo.members.find((m) => m.userId === 'f-luna').roleIds = ['r-build'];
  demo.members.find((m) => m.userId === 'f-pixel').roleIds = ['r-news', 'r-build'];
  const byId = (id) => demo.channels.find((ch) => ch.id === id);
  byId('s-1').rolePerms = { 'r-build': { view: 'allow', write: 'allow' } };
  byId('a-1').rolePerms = { 'r-news': { write: 'allow' } };
  byId('t-3').perm.embeds = false; byId('t-3').rolePerms = { 'r-build': { embeds: 'allow' } };
  byId('t-2').perm.react = false; // servidores: se lee y no se reacciona
  byId('v-2').perm.connect = false; byId('v-2').rolePerms = { 'r-build': { connect: 'allow' }, 'r-listen': { connect: 'allow', speak: 'deny' } };
  const mediaItem = (id, name, status, by, hue, ago, extra = {}) => ({ id, name, status, path: `m-1/${id}.gif`, mime: 'image/gif', bytes: 480000 + hue * 1000, width: 320, height: 240, createdAt: iso(now - ago * HOUR), reviewedAt: status === 'pending' ? null : iso(now - (ago - 1) * HOUR), rejectReason: null, uploadedBy: by, hue, ...extra });
  demo.media = [
    mediaItem('g-1', 'Bienvenida al server', 'approved', ME, 30, 120),
    mediaItem('g-2', 'Creeper feliz', 'pending', P.tomi, 130, 3),
    mediaItem('g-3', 'Construyendo', 'pending', ME, 200, 1),
    mediaItem('g-4', 'Meme no apto', 'rejected', P.tomi, 340, 48, { rejectReason: 'Contenido no apto para todo público' }),
  ];
  // Otras comunidades con GIFs pendientes para la cola de Venus.
  communities.get('m-2').media = [mediaItem('g-5', 'Pistón rojo', 'pending', P.pixel, 10, 6, { path: 'm-2/g-5.gif', width: 480, height: 270 })];
  communities.get('m-3').media = [mediaItem('g-6', 'Casa del árbol', 'approved', P.mora, 90, 200, { path: 'm-3/g-6.gif' })];
  demo.greetings.join = { enabled: true, channelId: 't-1', body: '¡Bienvenido/a {usuario} a {comunidad}! Ya somos {miembros}. Pasá por #reglas antes de escribir.', media: { kind: 'upload', id: 'g-1' }, mediaStatus: 'approved' };
  demo.greetings.leave = { enabled: true, channelId: 't-1', body: '{usuario} se fue de {comunidad}. ¡Suerte en el camino!', media: null, mediaStatus: null };
  if (scenario === 'member') { demo.myRole = 'member'; demo.members[0].role = 'member'; demo.members[1].role = 'owner'; }
  if (empty) {
    for (const id of ['m-1', 'm-2']) communities.get(id).myRole = null;
    for (const id of ['m-1', 'm-2']) communities.get(id).members = communities.get(id).members.filter((m) => m.userId !== 'fake-me');
    communities.get('m-1').members[0].role = 'owner';
  }
  const message = (id, author, minutesAgo, body, extra = {}) => ({ id, channelId: 't-1', communityId: 'm-1', authorId: author.userId, at: iso(now - minutesAgo * 60000), deleted: false, hidden: false, system: null, media: null, reactions: [], body, author: { ...author, role: author.userId === 'f-tomi' ? 'moderator' : author.userId === 'fake-me' ? 'owner' : 'member' }, ...extra });
  const messages = new Map([['t-1', [
    message('x-0', P.nacho, 2880, 'Mensaje viejo de hace dos días.'),
    message('x-j', P.pixel, 2870, '¡Bienvenido/a Pixel a Mina Central! Ya somos 220. Pasá por #reglas antes de escribir.', { system: 'join', media: { kind: 'upload', id: 'g-1', path: 'm-1/g-1.gif', name: 'Bienvenida al server', width: 320, height: 240 } }),
    message('x-1', P.tomi, 180, 'Buenas! Abrimos el servidor nuevo esta noche.', { reactions: [{ emoji: 'fire', count: 3, mine: true }, { emoji: 'party', count: 1, mine: false }] }),
    message('x-2', P.tomi, 179, 'La dirección está en #servidores. Mirá https://venus.example/reglas antes de entrar.'),
    message('x-3', P.luna, 95, 'Yo voy. <b>Esto no es HTML</b> y se ve tal cual.', { reactions: [{ emoji: 'like', count: 2, mine: false }] }),
    message('x-4', P.nacho, 94, '', { deleted: true }),
    message('x-5', ME, 40, 'Listo, nos vemos a las 21.'),
    message('x-6', P.pixel, 12, '', { hidden: true }),
    message('x-g', P.luna, 6, '', { media: { kind: 'upload', id: 'g-1', path: 'm-1/g-1.gif', name: 'Bienvenida al server', width: 320, height: 240 }, reactions: [{ emoji: 'laugh', count: 2, mine: false }] }),
    message('x-7', P.luna, 3, '¿Alguien tiene un mapa del Nether?'),
  ]]]);
  messages.set('t-2', [message('x-s', P.tomi, 300, 'Servidor nuevo: lo encontrás en la lista de Multijugador.', { channelId: 't-2' })]);
  messages.set('a-1', [message('announcement-1', P.tomi, 90, 'Este sábado construimos la plaza central. ¡Sumate!', { channelId: 'a-1' })]);
  messages.set('f-1', [
    message('topic-1', P.luna, 60, 'Propongo una estación para conectar nuestras bases. ¿Qué materiales usamos?', { channelId: 'f-1', title: 'Una estación para todos', parentId: null, replyCount: 1 }),
    message('reply-1', P.tomi, 50, 'Puedo preparar las vías y traer cobre.', { channelId: 'f-1', title: null, parentId: 'topic-1' }),
    message('topic-2', P.pixel, 30, 'Acá podemos coordinar la construcción de la plaza.', { channelId: 'f-1', title: 'La plaza de la comunidad', parentId: null, replyCount: 0 }),
  ]);
  const commOf = (id) => communities.get(id) || fail('not_found');
  const commCard = (c) => ({ id: c.id, name: c.name, description: c.description, isPublic: c.isPublic, createdAt: c.createdAt, maxMembers: 500, maxChannels: 50, maxCategories: 20, theme: c.theme, color: c.color, icon: c.icon, banner: c.banner, memberCount: c.members.length + c.extra, channelCount: c.channels.filter((ch) => canView(c, ch)).length, myRole: c.myRole });
  const needComm = (id, ...roles) => {
    const c = commOf(id);
    if (!c.myRole) fail('not_member');
    if (roles.length && !roles.includes(c.myRole)) fail('forbidden');
    return c;
  };
  const channelOf = (id) => {
    for (const c of communities.values()) {
      const ch = c.channels.find((x) => x.id === id);
      if (ch) return { c, ch };
    }
    return fail('not_found');
  };
  const validateOrder = (items, ids) => {
    if (!Array.isArray(ids) || ids.length !== items.length || new Set(ids).size !== ids.length || ids.some((id) => !items.some((item) => item.id === id))) fail('bad_order');
  };
  // Permisos: el mismo cálculo que el servidor (features/communities/permissions.js), para la cuenta de ejemplo.
  const everyoneOf = (ch) => ({ view: !ch.isPrivate, write: ch.postingRole === 'members', ...ch.perm });
  const myMember = (c) => c.members.find((m) => m.userId === 'fake-me');
  const permsOf = (c, ch) => {
    const overrides = mergeOverrides((myMember(c)?.roleIds || []).map((id) => ch.rolePerms[id]));
    const res = explainPerms({ kind: ch.kind, base: c.myRole || 'member', everyone: everyoneOf(ch), overrides });
    return Object.fromEntries(PERMS.map((p) => [p, res[p].allowed]));
  };
  const canView = (c, ch) => !c.myRole ? !ch.isPrivate : permsOf(c, ch).view;
  const isMuted = (c) => { const until = myMember(c)?.mutedUntil; return !!until && Date.parse(until) > Date.now(); };
  const lastPost = (ch) => (messages.get(ch.id) || []).filter((m) => m.authorId === 'fake-me').reduce((at, m) => Math.max(at, Date.parse(m.at) || 0), 0);
  const channelJson = (c, ch) => {
    const can = permsOf(c, ch);
    const limited = isMuted(c);
    const { perm, rolePerms, ...rest } = ch;
    return {
      ...rest, can, canPost: can.write && !limited, canEmbed: can.embeds && !limited, canReact: can.react && !limited, canConnect: can.connect, canSpeak: can.speak,
      nextPostAt: !isStaff(c.myRole) && ch.slowmodeSeconds && lastPost(ch) ? iso(lastPost(ch) + ch.slowmodeSeconds * 1000) : null,
    };
  };
  const readChannel = (id) => {
    const { c, ch } = channelOf(id);
    needComm(c.id);
    if (!permsOf(c, ch).view) fail('forbidden');
    return { c, ch };
  };
  const postChannel = (id, { embeds = false } = {}) => {
    const { c, ch } = readChannel(id);
    if (!channelJson(c, ch).canPost) fail('forbidden');
    if (isMuted(c)) fail('community_muted');
    if (embeds && !channelJson(c, ch).canEmbed) fail('embeds_forbidden');
    const next = channelJson(c, ch).nextPostAt;
    if (next && Date.parse(next) > Date.now()) throw Object.assign(new Error('slowmode'), { code: 'slowmode', nextPostAt: next });
    return { c, ch };
  };
  const page = (items, before, limit) => items.filter((m) => !before || Date.parse(m.at) < Date.parse(before)).slice(-Math.min(100, Math.max(1, limit)));
  const topicOf = (id) => {
    const topic = [...messages.values()].flat().find((m) => m.id === id && !m.parentId && m.title !== undefined);
    if (!topic) fail('not_found');
    return topic;
  };
  const hasLink = (text) => /(https?:\/\/|www\.|discord\.gg\/|discord(app)?\.com\/invite)/i.test(text);
  const addMessage = (c, ch, body, extra = {}) => {
    const m = { id: newId('x'), channelId: ch.id, communityId: c.id, authorId: 'fake-me', at: iso(Date.now()), body,
      parentId: null, deleted: false, hidden: false, system: null, media: null, reactions: [], author: { ...ME, role: c.myRole }, ...extra };
    messages.set(ch.id, [...(messages.get(ch.id) || []), m]);
    return m;
  };
  const mediaOf = (id) => {
    for (const c of communities.values()) {
      const item = c.media.find((m) => m.id === id);
      if (item) return { c, item };
    }
    return fail('not_found');
  };
  // Un GIF subido en un mensaje: la ruta solo si está aprobado, como community_media_view.
  const mediaView = (media) => {
    if (media?.kind !== 'upload') return media;
    const found = [...communities.values()].flatMap((c) => c.media).find((m) => m.id === media.id);
    return found?.status === 'approved' ? { kind: 'upload', id: found.id, name: found.name, path: found.path, width: found.width, height: found.height } : { kind: 'upload', id: media.id, unavailable: true };
  };
  const mediaJson = (c, item) => {
    const mine = item.uploadedBy.userId === 'fake-me';
    const seesAll = mine || c.myRole === 'owner';
    return { id: item.id, communityId: c.id, name: item.name, status: item.status, mime: item.mime, bytes: item.bytes, width: item.width, height: item.height, createdAt: item.createdAt, reviewedAt: item.reviewedAt,
      mine, rejectReason: seesAll ? item.rejectReason : null, path: item.status === 'approved' || seesAll ? item.path : null, uploadedBy: item.uploadedBy };
  };
  const checkMedia = (c, media, approved) => {
    if (media?.kind === 'klipy') {
      if (!/^https:\/\/static[0-9]*\.klipy\.com\/[A-Za-z0-9/._~-]+$/.test(String(media.url))) fail('bad_media');
      return media;
    }
    if (media?.kind === 'upload') {
      const item = c.media.find((m) => m.id === media.id);
      if (!item || !(item.status === 'approved' || (!approved && item.status === 'pending'))) fail('bad_media');
      return { kind: 'upload', id: item.id };
    }
    return fail('bad_media');
  };
  // Bienvenida o despedida automática, como private.community_greet.
  const greet = (c, kind, who) => {
    const g = c.greetings[kind];
    if (!g?.enabled || !g.channelId) return;
    const ch = c.channels.find((x) => x.id === g.channelId);
    if (!ch || ch.isPrivate) return;
    const body = renderGreeting(g.body, { user: who.displayName || who.username, community: c.name, members: c.members.length + c.extra });
    const media = g.media?.kind === 'upload' ? (c.media.find((m) => m.id === g.media.id)?.status === 'approved' ? { kind: 'upload', id: g.media.id } : null) : g.media;
    if (!body && !media) return;
    messages.set(ch.id, [...(messages.get(ch.id) || []), { id: newId('x'), channelId: ch.id, communityId: c.id, authorId: who.userId, at: iso(Date.now()), body, parentId: null, deleted: false, hidden: false, system: kind, media, reactions: [], author: { ...who, role: 'member' } }]);
  };
  const withViews = (m) => ({ ...m, media: m.deleted ? null : mediaView(m.media) });

  const reports = [
    { id: 'rep-1', kind: 'message', targetId: 'x-3', communityId: 'm-1', reason: 'abuse', text: 'Me insultó en el canal general.', status: 'open', snapshot: { body: 'Yo voy. <b>Esto no es HTML</b> y se ve tal cual.', channel: 'general', community: 'Mina Central' }, at: iso(now - 2 * HOUR), reporter: P.nacho, targetUser: P.luna },
    { id: 'rep-2', kind: 'community', targetId: 'm-3', communityId: 'm-3', reason: 'spam', text: null, status: 'open', snapshot: { name: 'Constructores del Oeste' }, at: iso(now - DAY), reporter: P.fer, targetUser: P.mora },
    { id: 'rep-3', kind: 'media', targetId: 'g-6', communityId: 'm-3', reason: 'nsfw', text: 'No parece apto para todo público.', status: 'open', snapshot: { name: 'Casa del árbol', path: 'm-3/g-6.gif', community: 'Constructores del Oeste' }, at: iso(now - 5 * HOUR), reporter: P.fer, targetUser: P.mora },
  ];
  const like = (text, q) => String(text).toLowerCase().includes(String(q || '').toLowerCase());
  const everyMedia = () => [...communities.values()].flatMap((c) => c.media.map((item) => ({ c, item })));
  const permsConfig = (c, ch) => ({ channelId: ch.id, kind: ch.kind, applies: permsFor(ch.kind), everyone: everyoneOf(ch),
    roles: c.roles.map((r) => ({ roleId: r.id, name: r.name, color: r.color, perms: { ...(ch.rolePerms[r.id] || {}) } })) });

  const rpcs = {
    community_my: () => [...communities.values()].filter((c) => c.myRole).map(commCard),
    community_search: ({ p_query }) => [...communities.values()].filter((c) => c.isPublic && like(c.name, p_query)).sort((a, b) => b.extra - a.extra).map(commCard),
    community_get: ({ p_community }) => {
      const c = commOf(p_community);
      if (!c.myRole) return { ...commCard(c), bannedHere: false };
      return { ...commCard(c), inviteCode: c.myRole === 'member' ? null : c.inviteCode, mutedUntil: myMember(c)?.mutedUntil || null, welcome: c.welcome, rules: c.rules, categories: c.categories,
        roles: c.roles.map((r) => ({ ...r, memberCount: c.members.filter((m) => m.roleIds?.includes(r.id)).length })), myRoleIds: myMember(c)?.roleIds || [], maxRoles: ROLE_LIMITS.roles,
        greetings: c.myRole === 'owner' ? structuredClone(c.greetings) : null,
        channels: c.channels.filter((ch) => canView(c, ch)).map((ch) => channelJson(c, ch)) };
    },
    community_create: ({ p_name, p_description, p_public }) => {
      if ([...communities.values()].filter((c) => c.myRole === 'owner').length >= 3) fail('too_many_communities');
      const id = newId('m');
      const c = { id, name: p_name, description: p_description, isPublic: p_public, theme: 'default', color: '#f6b45a', icon: 'users', banner: 'none', welcome: '', rules: '', categories: [], roles: [], media: [], greetings: { join: emptyGreeting(), leave: emptyGreeting() }, createdAt: iso(Date.now()), inviteCode: 'COM-NEW234', myRole: 'owner', channels: [channel(newId('t'), 'text', 'general', 0), channel(newId('v'), 'voice', 'general', 1)], members: [{ ...ME, role: 'owner', joinedAt: iso(Date.now()) }], bans: [], extra: 0 };
      communities.set(id, c);
      return commCard(c);
    },
    community_update: ({ p_community, p_patch }) => { const c = needComm(p_community, 'owner'); Object.assign(c, p_patch); return commCard(c); },
    community_delete: ({ p_community }) => { needComm(p_community, 'owner'); communities.delete(p_community); return { ok: true }; },
    community_transfer: ({ p_community, p_user }) => { const c = needComm(p_community, 'owner'); c.members.find((m) => m.userId === 'fake-me').role = 'moderator'; c.members.find((m) => m.userId === p_user).role = 'owner'; c.myRole = 'moderator'; return { ok: true }; },
    community_join: ({ p_community }) => {
      const c = commOf(p_community);
      c.myRole = 'member';
      c.members.push({ ...ME, role: 'member', joinedAt: iso(Date.now()) });
      greet(c, 'join', ME);
      return commCard(c);
    },
    community_join_code: ({ p_code }) => {
      const c = [...communities.values()].find((x) => x.inviteCode === p_code);
      if (!c) fail('not_found');
      if (!c.myRole) {
        c.myRole = 'member';
        c.members.push({ ...ME, role: 'member', joinedAt: iso(Date.now()) });
        greet(c, 'join', ME);
      }
      return commCard(c);
    },
    community_regen_code: ({ p_community }) => { const c = needComm(p_community, 'owner', 'moderator'); c.inviteCode = 'COM-R3GEN2'; return { inviteCode: c.inviteCode }; },
    community_leave: ({ p_community }) => {
      const c = needComm(p_community);
      if (c.myRole === 'owner' && c.members.length > 1) fail('owner_must_transfer');
      c.myRole = null;
      c.members = c.members.filter((m) => m.userId !== 'fake-me');
      if (!c.members.length) communities.delete(p_community);
      else greet(c, 'leave', ME);
      return { ok: true, dissolved: !c.members.length };
    },
    community_members_list: ({ p_community, p_offset = 0 }) => { const c = needComm(p_community); return { total: c.members.length + (p_offset ? 0 : c.extra), members: p_offset ? [] : c.members.map((m) => ({ ...m, roleIds: m.roleIds || [] })) }; },
    community_set_role: ({ p_community, p_user, p_role }) => { const c = needComm(p_community, 'owner'); c.members.find((m) => m.userId === p_user).role = p_role; return { ok: true }; },
    community_mute: ({ p_community, p_user, p_minutes }) => { const c = needComm(p_community, 'owner', 'moderator'); const until = p_minutes ? iso(Date.now() + p_minutes * 60000) : null; c.members.find((m) => m.userId === p_user).mutedUntil = until; return { ok: true, mutedUntil: until }; },
    community_kick: ({ p_community, p_user }) => {
      const c = needComm(p_community, 'owner', 'moderator');
      const m = c.members.find((x) => x.userId === p_user);
      c.members = c.members.filter((x) => x !== m);
      c.bans.unshift({ ...m, at: iso(Date.now()) });
      return { ok: true };
    },
    community_unban: ({ p_community, p_user }) => { const c = needComm(p_community, 'owner', 'moderator'); c.bans = c.bans.filter((x) => x.userId !== p_user); return { ok: true }; },
    community_bans_list: ({ p_community }) => needComm(p_community, 'owner', 'moderator').bans,
    community_customize: ({ p_community, p_patch }) => {
      const c = needComm(p_community, 'owner');
      const check = validateAppearance({ ...c, ...p_patch });
      if (!check.ok) fail(check.error);
      Object.assign(c, check.value);
      return rpcs.community_get({ p_community });
    },
    community_category_save: ({ p_community, p_category = null, p_name }) => {
      const c = needComm(p_community, 'owner', 'moderator');
      const check = validateCategoryName(p_name);
      if (!check.ok) fail(check.error);
      const category = p_category ? c.categories.find((g) => g.id === p_category) : null;
      if (p_category && !category) fail('bad_category');
      if (!category && c.categories.length >= 20) fail('too_many_categories');
      if (category) { category.name = check.value; return category; }
      const next = { id: newId('category'), name: check.value, position: c.categories.length };
      c.categories.push(next); return next;
    },
    community_category_delete: ({ p_category }) => {
      const c = [...communities.values()].find((value) => value.categories.some((g) => g.id === p_category));
      if (!c) fail('not_found');
      needComm(c.id, 'owner', 'moderator');
      c.categories = c.categories.filter((g) => g.id !== p_category);
      c.channels.forEach((ch) => { if (ch.categoryId === p_category) ch.categoryId = null; });
      return { ok: true };
    },
    community_category_reorder: ({ p_community, p_ids }) => {
      const c = needComm(p_community, 'owner', 'moderator');
      validateOrder(c.categories, p_ids);
      c.categories.forEach((g) => { g.position = p_ids.indexOf(g.id); });
      return { ok: true };
    },
    community_channel_create: (args) => rpcs.community_channel_create_configured({ ...args, p_patch: {} }),
    community_channel_create_configured: ({ p_community, p_kind, p_name, p_patch = {} }) => {
      const c = needComm(p_community, 'owner', 'moderator');
      if (c.channels.length >= 50) fail('too_many_channels');
      const baseChannel = channel(newId('channel'), p_kind, p_name, c.channels.length);
      const check = validateChannelSettings({ ...baseChannel, ...p_patch, kind: p_kind, name: p_name }, c.categories);
      if (!check.ok) fail(check.error);
      Object.assign(baseChannel, check.value);
      c.channels.push(baseChannel);
      return channelJson(c, baseChannel);
    },
    community_channel_configure: ({ p_channel, p_patch }) => {
      const { c, ch } = channelOf(p_channel);
      needComm(c.id, 'owner', 'moderator');
      const check = validateChannelSettings({ ...ch, ...p_patch, kind: ch.kind }, c.categories);
      if (!check.ok) fail(check.error);
      Object.assign(ch, check.value);
      return channelJson(c, ch);
    },
    community_channel_rename: ({ p_channel, p_name }) => rpcs.community_channel_configure({ p_channel, p_patch: { name: p_name } }),
    community_channel_delete: ({ p_channel }) => {
      const { c, ch } = channelOf(p_channel);
      needComm(c.id, 'owner', 'moderator');
      c.channels = c.channels.filter((x) => x !== ch);
      for (const g of Object.values(c.greetings)) if (g.channelId === p_channel) g.channelId = null;
      messages.delete(p_channel);
      return { ok: true };
    },
    community_channels_reorder: ({ p_community, p_ids }) => {
      const c = needComm(p_community, 'owner', 'moderator');
      validateOrder(c.channels, p_ids);
      c.channels.forEach((ch) => { ch.position = p_ids.indexOf(ch.id); });
      return { ok: true };
    },
    // Roles propios y permisos por canal.
    community_role_save: ({ p_community, p_name, p_color = '#94a3b8', p_role = null }) => {
      const c = needComm(p_community, 'owner');
      const check = validateRoleName(p_name, c.roles, p_role);
      if (!check.ok) fail(check.error);
      if (!/^#[0-9a-f]{6}$/i.test(p_color)) fail('bad_color');
      if (p_role) {
        const role = c.roles.find((r) => r.id === p_role) || fail('bad_role');
        Object.assign(role, { name: check.value, color: p_color.toLowerCase() });
        return role;
      }
      if (c.roles.length >= ROLE_LIMITS.roles) fail('too_many_roles');
      const role = { id: newId('r'), name: check.value, color: p_color.toLowerCase(), position: c.roles.length };
      c.roles.push(role);
      return role;
    },
    community_role_delete: ({ p_role }) => {
      const c = [...communities.values()].find((x) => x.roles.some((r) => r.id === p_role)) || fail('bad_role');
      needComm(c.id, 'owner');
      c.roles = c.roles.filter((r) => r.id !== p_role);
      c.members.forEach((m) => { m.roleIds = (m.roleIds || []).filter((id) => id !== p_role); });
      c.channels.forEach((ch) => { delete ch.rolePerms[p_role]; });
      return { ok: true };
    },
    community_role_assign: ({ p_community, p_user, p_role, p_on = true }) => {
      const c = needComm(p_community, 'owner', 'moderator');
      const target = c.members.find((m) => m.userId === p_user) || fail('not_member_target');
      if (target.role !== 'member') fail('bad_target');
      if (!c.roles.some((r) => r.id === p_role)) fail('bad_role');
      const ids = new Set(target.roleIds || []);
      if (p_on) {
        if (!ids.has(p_role) && ids.size >= ROLE_LIMITS.perMember) fail('too_many_member_roles');
        ids.add(p_role);
      } else ids.delete(p_role);
      target.roleIds = [...ids];
      return { ok: true };
    },
    community_channel_perms_get: ({ p_channel }) => {
      const { c, ch } = channelOf(p_channel);
      needComm(c.id, 'owner', 'moderator');
      return permsConfig(c, ch);
    },
    community_channel_perms_set: ({ p_channel, p_role = null, p_perms }) => {
      const { c, ch } = channelOf(p_channel);
      needComm(c.id, 'owner', 'moderator');
      if (p_role && !c.roles.some((r) => r.id === p_role)) fail('bad_role');
      const next = structuredClone({ isPrivate: ch.isPrivate, postingRole: ch.postingRole, perm: ch.perm, rolePerms: ch.rolePerms });
      for (const [perm, value] of Object.entries(p_perms || {})) {
        if (!PERMS.includes(perm) || !permApplies(ch.kind, perm)) fail('bad_permission');
        if (!p_role) {
          if (typeof value !== 'boolean') fail('bad_permission');
          if (perm === 'view') next.isPrivate = !value;
          else if (perm === 'write') { if (value && ch.kind === 'announcement') fail('bad_posting_role'); next.postingRole = value ? 'members' : 'staff'; }
          else next.perm[perm] = value;
        } else {
          const own = next.rolePerms[p_role] || (next.rolePerms[p_role] = {});
          if (value === null || value === 'inherit') delete own[perm];
          else if (value === 'allow' || value === 'deny') own[perm] = value;
          else fail('bad_permission');
          if (!Object.keys(own).length) delete next.rolePerms[p_role];
        }
      }
      Object.assign(ch, next);
      return permsConfig(c, ch);
    },
    community_perms_explain: ({ p_channel, p_subject = 'everyone' }) => {
      const { c, ch } = channelOf(p_channel);
      needComm(c.id, 'owner', 'moderator');
      const role = c.roles.find((r) => r.id === p_subject);
      if (!role && !['owner', 'moderator', 'everyone'].includes(p_subject)) fail('bad_role');
      const res = explainPerms({ kind: ch.kind, base: ['owner', 'moderator'].includes(p_subject) ? p_subject : 'member', everyone: everyoneOf(ch), overrides: role ? ch.rolePerms[role.id] || {} : {} });
      return { channelId: ch.id, subject: p_subject, perms: PERMS.map((perm) => ({ perm, ...res[perm] })) };
    },
    community_messages_page: ({ p_channel, p_before, p_limit = 50 }) => {
      const { ch } = readChannel(p_channel);
      if (!['text', 'announcement'].includes(ch.kind)) fail('bad_kind');
      return page(messages.get(p_channel) || [], p_before, p_limit).map(withViews);
    },
    community_send: ({ p_channel, p_body }) => {
      const check = validateMessage(p_body);
      if (!check.ok) fail(check.error);
      const { c, ch } = postChannel(p_channel, { embeds: hasLink(check.value) });
      if (!['text', 'announcement'].includes(ch.kind)) fail('bad_kind');
      return addMessage(c, ch, check.value);
    },
    community_send_media: ({ p_channel, p_media, p_body = '' }) => {
      const { c, ch } = postChannel(p_channel, { embeds: true });
      if (!['text', 'announcement'].includes(ch.kind)) fail('bad_kind');
      if (String(p_body).length > 500) fail('bad_body');
      return withViews(addMessage(c, ch, String(p_body).trim(), { media: checkMedia(c, p_media, true) }));
    },
    community_react: ({ p_message, p_emoji, p_on = true }) => {
      const msg = [...messages.values()].flat().find((m) => m.id === p_message);
      if (!msg || msg.deleted) fail('not_found');
      const { c, ch } = readChannel(msg.channelId);
      if (!EMOJIS.includes(p_emoji)) fail('bad_emoji');
      if (p_on) {
        if (!channelJson(c, ch).canReact) fail('react_forbidden');
        const mine = msg.reactions.filter((r) => r.mine).length;
        if (!msg.reactions.some((r) => r.emoji === p_emoji && r.mine) && mine >= 5) fail('too_many_reactions');
      }
      const row = msg.reactions.find((r) => r.emoji === p_emoji);
      if (p_on && !row?.mine) {
        if (row) Object.assign(row, { count: row.count + 1, mine: true });
        else msg.reactions.push({ emoji: p_emoji, count: 1, mine: true });
      } else if (!p_on && row?.mine) {
        row.count -= 1;
        row.mine = false;
        if (row.count <= 0) msg.reactions = msg.reactions.filter((r) => r !== row);
      }
      return { id: msg.id, reactions: structuredClone(msg.reactions) };
    },
    community_forum_topics: ({ p_channel, p_before, p_limit = 30 }) => {
      const { ch } = readChannel(p_channel);
      if (ch.kind !== 'forum') fail('bad_kind');
      return page((messages.get(p_channel) || []).filter((m) => !m.parentId), p_before, p_limit).reverse().map((m) => ({
        ...m, replyCount: (messages.get(p_channel) || []).filter((r) => r.parentId === m.id && !r.deleted).length,
      }));
    },
    community_forum_topic_create: ({ p_channel, p_title, p_body }) => {
      const check = validateMessage(p_body);
      if (!check.ok) fail(check.error);
      const { c, ch } = postChannel(p_channel, { embeds: hasLink(`${p_title} ${check.value}`) });
      if (ch.kind !== 'forum') fail('bad_kind');
      const title = validateTopicTitle(p_title);
      if (!title.ok) fail(title.error);
      return addMessage(c, ch, check.value, { title: title.value, parentId: null, replyCount: 0 });
    },
    community_forum_replies: ({ p_topic, p_before, p_limit = 50 }) => {
      const topic = topicOf(p_topic);
      readChannel(topic.channelId);
      if (topic.deleted) fail('thread_deleted');
      return page((messages.get(topic.channelId) || []).filter((m) => m.parentId === p_topic), p_before, p_limit);
    },
    community_forum_reply: ({ p_topic, p_body }) => {
      const check = validateMessage(p_body);
      if (!check.ok) fail(check.error);
      const topic = topicOf(p_topic);
      const { c, ch } = postChannel(topic.channelId, { embeds: hasLink(check.value) });
      if (topic.deleted) fail('thread_deleted');
      return addMessage(c, ch, check.value, { parentId: p_topic, title: null });
    },
    community_message_delete: ({ p_id }) => {
      const msg = [...messages.values()].flat().find((m) => m.id === p_id);
      if (!msg) fail('not_found');
      const { c } = readChannel(msg.channelId);
      if ((msg.authorId !== 'fake-me' || msg.system) && !isStaff(c.myRole)) fail('forbidden');
      for (const list of messages.values()) for (const m of list) {
        if (m.id === p_id || m.parentId === p_id) Object.assign(m, { deleted: true, body: '', title: null, media: null });
      }
      return { ok: true };
    },
    community_voice_room: ({ p_channel }) => {
      const { c, ch } = readChannel(p_channel);
      if (ch.kind !== 'voice') fail('bad_kind');
      if (!channelJson(c, ch).canConnect) fail('voice_forbidden');
      return { code: 'ABC234', roomId: 'r-' + ch.id, name: c.name + ' · ' + ch.name, max: 8, canSpeak: channelJson(c, ch).canSpeak };
    },
    // GIFs de la comunidad.
    community_media_register: ({ p_id, p_community, p_name, p_width, p_height }) => {
      const c = needComm(p_community, 'owner', 'moderator');
      const file = files.get(`${p_community}/${p_id}`);
      if (!file) fail('no_file');
      const name = String(p_name ?? '').trim();
      if (!name || name.length > MEDIA_LIMITS.name) fail('bad_media_name');
      if (![p_width, p_height].every((n) => n >= MEDIA_LIMITS.min && n <= MEDIA_LIMITS.max)) fail('bad_dimensions');
      if (c.media.filter((m) => ['pending', 'approved'].includes(m.status)).length >= MEDIA_LIMITS.total) fail('media_limit');
      if (c.media.filter((m) => m.status === 'pending').length >= MEDIA_LIMITS.pending) fail('media_pending_limit');
      const item = { id: p_id, name, status: 'pending', path: file.path, mime: file.type, bytes: file.size, width: p_width, height: p_height, createdAt: iso(Date.now()), reviewedAt: null, rejectReason: null, uploadedBy: ME, hue: 250 };
      c.media.unshift(item);
      return mediaJson(c, item);
    },
    community_media_list: ({ p_community }) => {
      const c = needComm(p_community);
      return c.media.filter((m) => m.status === 'approved' || c.myRole === 'owner' || m.uploadedBy.userId === 'fake-me').map((m) => mediaJson(c, m));
    },
    community_media_resolve: ({ p_ids }) => (p_ids || []).flatMap((id) => {
      const found = everyMedia().find((x) => x.item.id === id && x.item.status === 'approved' && x.c.myRole);
      return found ? [{ id, communityId: found.c.id, name: found.item.name, path: found.item.path, width: found.item.width, height: found.item.height }] : [];
    }),
    community_media_delete: ({ p_id }) => {
      const { c, item } = mediaOf(p_id);
      needComm(c.id);
      if (item.uploadedBy.userId !== 'fake-me' && c.myRole !== 'owner') fail('forbidden');
      c.media = c.media.filter((m) => m !== item);
      return { ok: true, path: item.path };
    },
    community_greeting_save: ({ p_community, p_kind, p_patch }) => {
      const c = needComm(p_community, 'owner');
      if (!['join', 'leave'].includes(p_kind)) fail('bad_kind');
      const next = { ...c.greetings[p_kind] };
      for (const [key, value] of Object.entries(p_patch || {})) {
        if (key === 'enabled') next.enabled = value === true;
        else if (key === 'channelId') {
          const ch = value === null ? null : c.channels.find((x) => x.id === value);
          if (value !== null && (!ch || !['text', 'announcement'].includes(ch.kind) || ch.isPrivate)) fail('bad_greeting_channel');
          next.channelId = value;
        } else if (key === 'body') {
          if (typeof value !== 'string' || value.length > 500) fail('bad_greeting_text');
          if (!greetingVariablesOk(value)) fail('bad_greeting_variable');
          next.body = value.trim();
        } else if (key === 'media') {
          next.media = value === null ? null : checkMedia(c, value, false);
        } else fail('bad_request');
      }
      if (next.enabled && !next.channelId) fail('greeting_needs_channel');
      if (next.enabled && !next.body && !next.media) fail('greeting_empty');
      next.mediaStatus = next.media?.kind === 'upload' ? c.media.find((m) => m.id === next.media.id)?.status || 'missing' : null;
      c.greetings[p_kind] = next;
      return structuredClone(c.greetings);
    },
    community_report: () => ({ ok: true }),

    admin_groups: ({ p_query }) => [...communities.values()].filter((c) => like(c.name, p_query)).map((c) => ({ ...commCard(c), owner: c.members.find((m) => m.role === 'owner') || null, reports: reports.filter((r) => r.communityId === c.id && r.status === 'open').length })),
    admin_group_detail: ({ p_id }) => ({ ...commCard(commOf(p_id)), members: commOf(p_id).members, channels: commOf(p_id).channels }),
    admin_group_dissolve: ({ p_id }) => { communities.delete(p_id); return { ok: true }; },
    admin_group_remove: ({ p_id, p_user }) => { const g = commOf(p_id); g.members = g.members.filter((m) => m.userId !== p_user); return { ok: true }; },
    admin_group_reports: () => reports,
    admin_group_report_close: ({ p_id, p_remove }) => {
      const r = reports.find((x) => x.id === p_id);
      r.status = 'closed';
      r.closedAt = iso(Date.now());
      if (p_remove && r.kind === 'media') {
        const found = everyMedia().find((x) => x.item.id === r.targetId);
        if (found) Object.assign(found.item, { status: 'removed', rejectReason: 'report' });
      }
      return { ok: true, removed: !!p_remove };
    },
    admin_community_media_queue: ({ p_status = 'pending' }) => {
      const rows = everyMedia().filter((x) => x.item.status === p_status).sort((a, b) => (p_status === 'pending' ? 1 : -1) * (Date.parse(a.item.createdAt) - Date.parse(b.item.createdAt)));
      return { pending: everyMedia().filter((x) => x.item.status === 'pending').length, total: rows.length,
        items: rows.map(({ c, item }) => ({ id: item.id, communityId: c.id, community: c.name, name: item.name, path: item.path, mime: item.mime, bytes: item.bytes, width: item.width, height: item.height, status: item.status,
          rejectReason: item.rejectReason, createdAt: item.createdAt, reviewedAt: item.reviewedAt, uploadedBy: item.uploadedBy, reports: reports.filter((r) => r.kind === 'media' && r.targetId === item.id && r.status === 'open').length })) };
    },
    admin_community_media_review: ({ p_id, p_decision, p_reason = null }) => {
      const { item } = mediaOf(p_id);
      if (!['approve', 'reject', 'remove'].includes(p_decision)) fail('bad_decision');
      if (['approve', 'reject'].includes(p_decision) && item.status !== 'pending') fail('bad_state');
      if (p_decision === 'remove' && item.status !== 'approved') fail('bad_state');
      const reason = String(p_reason ?? '').trim();
      if (p_decision !== 'approve' && (reason.length < 3 || reason.length > 200)) fail('reason_required');
      item.status = { approve: 'approved', reject: 'rejected', remove: 'removed' }[p_decision];
      item.rejectReason = p_decision === 'approve' ? null : reason;
      item.reviewedAt = iso(Date.now());
      return { ok: true, status: item.status };
    },
  };

  // Archivos "subidos" en memoria: lo que mediaUrl devuelve para un GIF de ejemplo es un dibujo propio.
  const files = new Map();
  return {
    fake: true,
    signedIn: base.signedIn,
    userId: base.userId,
    onAuth: base.onAuth,
    async rpc(name, args = {}) {
      await wait(60);
      if (!base.signedIn()) fail('noSession');
      if (scenario === 'unavailable') fail('unavailable');
      const fn = rpcs[name];
      if (!fn) fail('unavailable');
      return structuredClone(fn(args));
    },
    friends: async () => Object.values(P).map((p) => ({ id: p.userId, name: p.displayName, profile: { username: p.username, mc_name: p.mcName } })),
    isBlocked: () => false,
    watchChannel(_id, { onStatus } = {}) {
      onStatus?.('SUBSCRIBED');
      return () => {};
    },
    async mediaUrl(path) {
      const own = [...files.values()].find((f) => f.path === path);
      if (own?.url) return own.url;
      const found = everyMedia().find((x) => x.item.path === path);
      return found ? fakeArt(found.item.name, found.item.hue ?? 210) : null;
    },
    async uploadMedia(path, file) {
      await wait(80);
      const url = typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function' && typeof Blob !== 'undefined' && file instanceof Blob ? URL.createObjectURL(file) : null;
      files.set(path.replace(/\.[a-z]+$/, ''), { path, size: file.size, type: file.type, url });
    },
    async removeMedia(path) {
      files.delete(path.replace(/\.[a-z]+$/, ''));
    },
  };
}
