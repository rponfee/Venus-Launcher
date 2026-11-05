import { validateMessage } from './logic.js';
import { validateAppearance, validateChannelSettings, validateCategoryName, validateTopicTitle, isStaff } from '../../pages/communities/logic.js';
// Clanes y comunidades de ejemplo para capturas (VENUS_DEVSHOT + VENUS_REWARDS_FAKE, como Venus Points): misma forma que las
// RPC de 0033, en memoria y sin red. 'new' no tiene clan ni comunidades y sí una invitación; 'unavailable' responde que no hay servicio.
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
const ACH = (members, days, minutes) => [
  ['members_5', 'members', 5, members], ['members_20', 'members', 20, members], ['members_50', 'members', 50, members],
  ['age_30', 'days', 30, days], ['age_180', 'days', 180, days], ['age_365', 'days', 365, days],
  ['hours_100', 'minutes', 6000, minutes], ['hours_1000', 'minutes', 60000, minutes], ['hours_5000', 'minutes', 300000, minutes],
].map(([id, kind, goal, value]) => ({ id, kind, goal, value, unlocked: value >= goal }));

export function createFakeGroups(scenario = 'demo', base) {
  const now = Date.now();
  const empty = scenario === 'new';
  const seq = { n: 1 };
  const newId = (p) => `${p}-${seq.n++}`;

  const clans = new Map([
    ['c-mine', { id: 'c-mine', name: 'Los del Nether', tag: 'NTHR', description: 'Jugamos survival técnico los fines de semana.\nSi te gusta la redstone, sos de los nuestros.', color: '#e5484d', emblem: 'flame', isOpen: true, createdAt: iso(now - 80 * DAY), inviteCode: 'CLAN-HX7K2M',
      members: [{ ...ME, role: 'leader', joinedAt: iso(now - 80 * DAY) }, { ...P.tomi, role: 'officer', joinedAt: iso(now - 70 * DAY) }, { ...P.luna, role: 'member', joinedAt: iso(now - 40 * DAY) }, { ...P.nacho, role: 'member', joinedAt: iso(now - 3 * DAY) }],
      requests: [{ user: P.mora, at: iso(now - 5 * HOUR) }], invited: [{ user: P.fer, at: iso(now - DAY) }], minutes: 4210, sharing: 2, total: 7350 }],
    ['c-2', { id: 'c-2', name: 'Redstone <b>Lab</b>', tag: 'RLAB', description: 'Texto ajeno con <i>etiquetas</i>: se ve tal cual.', color: '#0ea5e9', emblem: 'zap', isOpen: true, createdAt: iso(now - 200 * DAY), members: Array.from({ length: 23 }, (_, i) => ({ ...person(`r-${i}`, `Lab${i}`), role: i ? 'member' : 'leader', joinedAt: iso(now - (200 - i) * DAY) })), requests: [], invited: [], minutes: 9180, sharing: 6, total: 90000 }],
    ['c-3', { id: 'c-3', name: 'Mineros del Sur', tag: 'SUR', description: 'Cuevas, diamantes y mate.', color: '#f5a524', emblem: 'pickaxe', isOpen: true, createdAt: iso(now - 12 * DAY), members: [{ ...P.pixel, role: 'leader', joinedAt: iso(now - 12 * DAY) }, { ...P.fer, role: 'member', joinedAt: iso(now - 9 * DAY) }], requests: [], invited: [], minutes: 0, sharing: 0, total: 0 }],
  ]);
  let myClan = empty ? null : 'c-mine';
  let sharePlaytime = false; // permiso separado: nunca se hereda de Compartir con mis amigos
  let invites = empty ? [{ clan: 'c-3', invitedBy: P.pixel, at: iso(now - 2 * HOUR) }] : [];
  let requests = [];

  const card = (c) => ({ id: c.id, name: c.name, tag: c.tag, description: c.description, color: c.color, emblem: c.emblem, isOpen: c.isOpen, createdAt: c.createdAt, maxMembers: 50, memberCount: c.members.length });
  const clanJson = (c) => {
    const me = c.members.find((m) => m.userId === 'fake-me');
    const staff = me && me.role !== 'member';
    const days = Math.floor((Date.now() - Date.parse(c.createdAt)) / DAY);
    return { ...card(c), myRole: me?.role || null, inviteCode: staff ? c.inviteCode : null, shared: { available: true, sharing: c.sharing, weekMinutes: c.minutes, totalMinutes: c.total }, requested: requests.some((r) => r.clan === c.id), achievements: ACH(c.members.length, days, c.total), members: c.members, requests: staff ? c.requests : [], invited: staff ? c.invited : [] };
  };
  const clanOf = (id) => clans.get(id) || fail('not_found');
  const mineClan = () => clans.get(myClan) || fail('not_in_clan');
  const myMember = () => mineClan().members.find((m) => m.userId === 'fake-me');
  const needClan = (...roles) => {
    if (!roles.includes(myMember().role)) fail('forbidden');
    return mineClan();
  };

  const channel = (id, kind, name, position, people = []) => ({ id, kind, name, position, people, topic: '', icon: { text: 'hash', voice: 'headphones', announcement: 'megaphone', forum: 'message-circle' }[kind] || 'hash', categoryId: null, slowmodeSeconds: 0, postingRole: kind === 'announcement' ? 'staff' : 'members', isPrivate: false });
  const communities = new Map([
    ['m-1', { id: 'm-1', name: 'Mina Central', description: 'La comunidad para los que juegan en la Mina. Reglas simples: respeto y nada de spam.', isPublic: true, createdAt: iso(now - 60 * DAY), inviteCode: 'COM-K3M9PQ', myRole: 'owner',
      channels: [channel('t-1', 'text', 'general', 0), channel('t-2', 'text', 'servidores', 1), channel('t-3', 'text', 'capturas', 2), channel('v-1', 'voice', 'general', 3, [P.tomi, P.luna]), channel('v-2', 'voice', 'en partida', 4)],
      members: [{ ...ME, role: 'owner', joinedAt: iso(now - 60 * DAY) }, { ...P.tomi, role: 'moderator', joinedAt: iso(now - 50 * DAY) }, { ...P.luna, role: 'member', joinedAt: iso(now - 40 * DAY) }, { ...P.nacho, role: 'member', joinedAt: iso(now - 20 * DAY), mutedUntil: iso(now + HOUR) }, { ...P.pixel, role: 'member', joinedAt: iso(now - 2 * DAY) }],
      bans: [{ ...P.fer, at: iso(now - 4 * DAY) }], extra: 214 }],
    ['m-2', { id: 'm-2', name: 'Técnicos de Redstone', description: 'Máquinas, granjas y dudas.', isPublic: true, createdAt: iso(now - 90 * DAY), inviteCode: 'COM-TTT222', myRole: 'member', channels: [channel('t-9', 'text', 'general', 0), channel('v-9', 'voice', 'taller', 1)], members: [{ ...P.pixel, role: 'owner', joinedAt: iso(now - 90 * DAY) }, { ...ME, role: 'member', joinedAt: iso(now - DAY) }], bans: [], extra: 58 }],
    ['m-3', { id: 'm-3', name: 'Constructores del Oeste', description: 'Mostrá lo que construiste.', isPublic: true, createdAt: iso(now - 30 * DAY), inviteCode: 'COM-WWW333', myRole: null, channels: [channel('t-7', 'text', 'general', 0)], members: [{ ...P.mora, role: 'owner', joinedAt: iso(now - 30 * DAY) }], bans: [], extra: 31 }],
  ]);
  for (const c of communities.values()) Object.assign(c, { theme: 'default', color: '#f6b45a', icon: 'users', banner: 'none', welcome: '', rules: '', categories: [] });
  const demo = communities.get('m-1');
  Object.assign(demo, { color: '#c87939', icon: 'mountain', banner: 'sunset', welcome: 'Un lugar para construir y jugar juntos.', rules: 'Respetá a los demás.\nNo compartas datos personales.\nPublicá cada tema en su canal.',
    categories: [{ id: 'cat-info', name: 'La comunidad', position: 0 }, { id: 'cat-play', name: 'Jugamos juntos', position: 1 }] });
  demo.channels.unshift({ ...channel('a-1', 'announcement', 'novedades', -1), categoryId: 'cat-info', topic: 'Noticias y eventos de la comunidad.' });
  demo.channels.push({ ...channel('f-1', 'forum', 'proyectos', 5), categoryId: 'cat-play', topic: 'Compartí una idea y conversá en su propio hilo.' });
  demo.channels.push({ ...channel('s-1', 'text', 'equipo', 6), isPrivate: true, postingRole: 'staff', categoryId: 'cat-info' });
  if (scenario === 'member') { demo.myRole = 'member'; demo.members[0].role = 'member'; demo.members[1].role = 'owner'; }
  demo.channels.forEach((ch) => { ch.categoryId ||= ch.kind === 'voice' || ch.kind === 'forum' ? 'cat-play' : 'cat-info'; });
  if (empty) {
    for (const id of ['m-1', 'm-2']) communities.get(id).myRole = null;
    for (const id of ['m-1', 'm-2']) communities.get(id).members = communities.get(id).members.filter((m) => m.userId !== 'fake-me');
    communities.get('m-1').members[0].role = 'owner';
  }
  const message = (id, author, minutesAgo, body, extra = {}) => ({ id, channelId: 't-1', communityId: 'm-1', authorId: author.userId, at: iso(now - minutesAgo * 60000), deleted: false, hidden: false, body, author: { ...author, role: author.userId === 'f-tomi' ? 'moderator' : author.userId === 'fake-me' ? 'owner' : 'member' }, ...extra });
  const messages = new Map([['t-1', [
    message('x-0', P.nacho, 2880, 'Mensaje viejo de hace dos días.'),
    message('x-1', P.tomi, 180, 'Buenas! Abrimos el servidor nuevo esta noche.'),
    message('x-2', P.tomi, 179, 'La dirección está en #servidores. Mirá https://venus.example/reglas antes de entrar.'),
    message('x-3', P.luna, 95, 'Yo voy. <b>Esto no es HTML</b> y se ve tal cual.'),
    message('x-4', P.nacho, 94, '', { deleted: true }),
    message('x-5', ME, 40, 'Listo, nos vemos a las 21.'),
    message('x-6', P.pixel, 12, '', { hidden: true }),
    message('x-7', P.luna, 3, '¿Alguien tiene un mapa del Nether?'),
  ]]]);
  messages.set('a-1', [message('announcement-1', P.tomi, 90, 'Este sábado construimos la plaza central. ¡Sumate!', { channelId: 'a-1' })]);
  messages.set('f-1', [
    message('topic-1', P.luna, 60, 'Propongo una estación para conectar nuestras bases. ¿Qué materiales usamos?', { channelId: 'f-1', title: 'Una estación para todos', parentId: null, replyCount: 1 }),
    message('reply-1', P.tomi, 50, 'Puedo preparar las vías y traer cobre.', { channelId: 'f-1', title: null, parentId: 'topic-1' }),
    message('topic-2', P.pixel, 30, 'Acá podemos coordinar la construcción de la plaza.', { channelId: 'f-1', title: 'La plaza de la comunidad', parentId: null, replyCount: 0 }),
  ]);
  const commOf = (id) => communities.get(id) || fail('not_found');
  const commCard = (c) => ({ id: c.id, name: c.name, description: c.description, isPublic: c.isPublic, createdAt: c.createdAt, maxMembers: 500, maxChannels: 50, theme: c.theme, color: c.color, icon: c.icon, banner: c.banner, memberCount: c.members.length + c.extra, channelCount: c.channels.length, myRole: c.myRole });
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
  const lastPost = (ch) => (messages.get(ch.id) || []).filter((m) => m.authorId === 'fake-me').reduce((at, m) => Math.max(at, Date.parse(m.at) || 0), 0);
  const channelJson = (c, ch) => ({
    ...ch, canPost: ch.kind !== 'voice' && (isStaff(c.myRole) || (ch.postingRole !== 'staff' && ch.kind !== 'announcement')),
    nextPostAt: !isStaff(c.myRole) && ch.slowmodeSeconds && lastPost(ch) ? iso(lastPost(ch) + ch.slowmodeSeconds * 1000) : null,
  });
  const readChannel = (id) => {
    const { c, ch } = channelOf(id);
    needComm(c.id);
    if (ch.isPrivate && !isStaff(c.myRole)) fail('not_found');
    return { c, ch };
  };
  const postChannel = (id) => {
    const { c, ch } = readChannel(id);
    if (!channelJson(c, ch).canPost) fail('forbidden');
    const until = c.members.find((m) => m.userId === 'fake-me')?.mutedUntil;
    if (until && Date.parse(until) > Date.now()) fail('community_muted');
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
  const addMessage = (c, ch, body, extra = {}) => {
    const check = validateMessage(body);
    if (!check.ok) fail(check.error);
    const m = { id: newId('x'), channelId: ch.id, communityId: c.id, authorId: 'fake-me', at: iso(Date.now()), body: check.value,
      parentId: null, deleted: false, hidden: false, author: { ...ME, role: c.myRole }, ...extra };
    messages.set(ch.id, [...(messages.get(ch.id) || []), m]);
    return m;
  };

  const reports = [
    { id: 'rep-1', kind: 'message', targetId: 'x-3', communityId: 'm-1', reason: 'abuse', text: 'Me insultó en el canal general.', status: 'open', snapshot: { body: 'Yo voy. <b>Esto no es HTML</b> y se ve tal cual.', channel: 'general', community: 'Mina Central' }, at: iso(now - 2 * HOUR), reporter: P.nacho, targetUser: P.luna },
    { id: 'rep-2', kind: 'community', targetId: 'm-3', communityId: 'm-3', reason: 'spam', text: null, status: 'open', snapshot: { name: 'Constructores del Oeste' }, at: iso(now - DAY), reporter: P.fer, targetUser: P.mora },
    { id: 'rep-3', kind: 'clan', targetId: 'c-2', reason: 'other', text: 'Nombre raro.', status: 'closed', snapshot: { name: 'Redstone <b>Lab</b>', tag: 'RLAB' }, at: iso(now - 5 * DAY), closedAt: iso(now - 4 * DAY), reporter: P.tomi, targetUser: null },
  ];
  const like = (text, q) => String(text).toLowerCase().includes(String(q || '').toLowerCase());

  const rpcs = {
    clan_share_playtime: ({ p_share }) => { sharePlaytime = p_share === true; return { sharePlaytime }; },
    clan_me: () => ({ sharePlaytime, clan: myClan ? clanJson(clans.get(myClan)) : null, invites: invites.map((i) => ({ clan: card(clanOf(i.clan)), invitedBy: i.invitedBy, at: i.at })), requests: requests.map((r) => ({ clan: card(clanOf(r.clan)), at: r.at })) }),
    clan_get: ({ p_clan }) => clanJson(clanOf(p_clan)),
    clan_search: ({ p_query }) => [...clans.values()].filter((c) => c.isOpen && (like(c.name, p_query) || like(c.tag, p_query))).sort((a, b) => b.members.length - a.members.length).map(card),
    clan_tags: ({ p_users }) => (p_users || []).flatMap((u) => { const c = [...clans.values()].find((x) => x.members.some((m) => m.userId === u)); return c ? [{ userId: u, clanId: c.id, tag: c.tag, name: c.name, color: c.color, emblem: c.emblem }] : []; }),
    clan_ranking: () => {
      const rows = [...clans.values()].map((c) => ({ id: c.id, name: c.name, tag: c.tag, color: c.color, emblem: c.emblem, members: c.members.length, sharing: c.sharing, minutes: c.minutes, mine: c.id === myClan })).sort((a, b) => b.minutes - a.minutes || b.members - a.members).map((r, i) => ({ ...r, pos: i + 1 }));
      return { week: iso(now).slice(0, 10), available: true, rows, mine: rows.find((r) => r.mine) || null };
    },
    clan_create: ({ p_name, p_tag, p_description, p_color, p_emblem, p_open }) => {
      if ([...clans.values()].some((c) => c.name.toLowerCase() === p_name.toLowerCase())) fail('name_taken');
      if ([...clans.values()].some((c) => c.tag === p_tag.toUpperCase())) fail('tag_taken');
      const id = newId('c');
      clans.set(id, { id, name: p_name, tag: p_tag.toUpperCase(), description: p_description, color: p_color, emblem: p_emblem, isOpen: p_open, createdAt: iso(Date.now()), inviteCode: 'CLAN-NEW234', members: [{ ...ME, role: 'leader', joinedAt: iso(Date.now()) }], requests: [], invited: [], minutes: 0, sharing: 0, total: 0 });
      myClan = id;
      invites = [];
      requests = [];
      return clanJson(clans.get(id));
    },
    clan_update: ({ p_patch }) => { const c = needClan('leader'); Object.assign(c, p_patch); return clanJson(c); },
    clan_invite: ({ p_user }) => { const c = needClan('leader', 'officer'); c.invited.unshift({ user: Object.values(P).find((p) => p.userId === p_user), at: iso(Date.now()) }); return { ok: true }; },
    clan_invite_cancel: ({ p_user }) => { const c = needClan('leader', 'officer'); c.invited = c.invited.filter((i) => i.user.userId !== p_user); return { ok: true }; },
    clan_invite_respond: ({ p_clan, p_accept }) => {
      invites = invites.filter((i) => i.clan !== p_clan);
      if (!p_accept) return { ok: true, joined: false };
      clanOf(p_clan).members.push({ ...ME, role: 'member', joinedAt: iso(Date.now()) });
      myClan = p_clan;
      invites = [];
      return { ok: true, joined: true, clan: clanJson(clanOf(p_clan)) };
    },
    clan_request: ({ p_clan }) => { if (myClan) fail('already_in_clan'); requests.push({ clan: p_clan, at: iso(Date.now()) }); return { ok: true }; },
    clan_request_cancel: ({ p_clan }) => { requests = requests.filter((r) => r.clan !== p_clan); return { ok: true }; },
    clan_request_respond: ({ p_user, p_accept }) => {
      const c = needClan('leader', 'officer');
      const r = c.requests.find((x) => x.user.userId === p_user);
      c.requests = c.requests.filter((x) => x !== r);
      if (p_accept && r) c.members.push({ ...r.user, role: 'member', joinedAt: iso(Date.now()) });
      return { ok: true, joined: !!p_accept };
    },
    clan_join_code: ({ p_code }) => {
      if (myClan) fail('already_in_clan');
      const c = [...clans.values()].find((x) => x.inviteCode === p_code);
      if (!c) fail('not_found');
      c.members.push({ ...ME, role: 'member', joinedAt: iso(Date.now()) });
      myClan = c.id;
      return { ok: true, clan: clanJson(c) };
    },
    clan_regen_code: () => { const c = needClan('leader', 'officer'); c.inviteCode = 'CLAN-R3GEN2'; return { inviteCode: c.inviteCode }; },
    clan_leave: () => {
      const c = mineClan();
      if (myMember().role === 'leader' && c.members.length > 1) fail('leader_must_transfer');
      c.members = c.members.filter((m) => m.userId !== 'fake-me');
      myClan = null;
      if (!c.members.length) clans.delete(c.id);
      return { ok: true, dissolved: !c.members.length };
    },
    clan_kick: ({ p_user }) => { const c = needClan('leader', 'officer'); c.members = c.members.filter((m) => m.userId !== p_user); return { ok: true }; },
    clan_set_role: ({ p_user, p_role }) => { const c = needClan('leader'); c.members.find((m) => m.userId === p_user).role = p_role; return { ok: true }; },
    clan_transfer: ({ p_user }) => { const c = needClan('leader'); myMember().role = 'officer'; c.members.find((m) => m.userId === p_user).role = 'leader'; return { ok: true }; },

    community_my: () => [...communities.values()].filter((c) => c.myRole).map(commCard),
    community_search: ({ p_query }) => [...communities.values()].filter((c) => c.isPublic && like(c.name, p_query)).sort((a, b) => b.extra - a.extra).map(commCard),
    community_get: ({ p_community }) => {
      const c = commOf(p_community);
      if (!c.myRole) return { ...commCard(c), bannedHere: false };
      return { ...commCard(c), inviteCode: c.myRole === 'member' ? null : c.inviteCode, mutedUntil: c.members.find((m) => m.userId === 'fake-me')?.mutedUntil || null, welcome: c.welcome, rules: c.rules, categories: c.categories, channels: c.channels.filter((ch) => !ch.isPrivate || isStaff(c.myRole)).map((ch) => channelJson(c, ch)) };
    },
    community_create: ({ p_name, p_description, p_public }) => {
      if ([...communities.values()].filter((c) => c.myRole === 'owner').length >= 3) fail('too_many_communities');
      const id = newId('m');
      const c = { id, name: p_name, description: p_description, isPublic: p_public, theme: 'default', color: '#f6b45a', icon: 'users', banner: 'none', welcome: '', rules: '', categories: [], createdAt: iso(Date.now()), inviteCode: 'COM-NEW234', myRole: 'owner', channels: [channel(newId('t'), 'text', 'general', 0), channel(newId('v'), 'voice', 'general', 1)], members: [{ ...ME, role: 'owner', joinedAt: iso(Date.now()) }], bans: [], extra: 0 };
      communities.set(id, c);
      return commCard(c);
    },
    community_update: ({ p_community, p_patch }) => { const c = needComm(p_community, 'owner'); Object.assign(c, p_patch); return commCard(c); },
    community_delete: ({ p_community }) => { needComm(p_community, 'owner'); communities.delete(p_community); return { ok: true }; },
    community_transfer: ({ p_community, p_user }) => { const c = needComm(p_community, 'owner'); c.members.find((m) => m.userId === 'fake-me').role = 'moderator'; c.members.find((m) => m.userId === p_user).role = 'owner'; c.myRole = 'moderator'; return { ok: true }; },
    community_join: ({ p_community }) => { const c = commOf(p_community); c.myRole = 'member'; c.members.push({ ...ME, role: 'member', joinedAt: iso(Date.now()) }); return commCard(c); },
    community_join_code: ({ p_code }) => {
      const c = [...communities.values()].find((x) => x.inviteCode === p_code);
      if (!c) fail('not_found');
      c.myRole ||= 'member';
      return commCard(c);
    },
    community_regen_code: ({ p_community }) => { const c = needComm(p_community, 'owner', 'moderator'); c.inviteCode = 'COM-R3GEN2'; return { inviteCode: c.inviteCode }; },
    community_leave: ({ p_community }) => {
      const c = needComm(p_community);
      if (c.myRole === 'owner' && c.members.length > 1) fail('owner_must_transfer');
      c.myRole = null;
      c.members = c.members.filter((m) => m.userId !== 'fake-me');
      if (!c.members.length) communities.delete(p_community);
      return { ok: true, dissolved: !c.members.length };
    },
    community_members_list: ({ p_community, p_offset = 0 }) => { const c = needComm(p_community); return { total: c.members.length + (p_offset ? 0 : c.extra), members: p_offset ? [] : c.members }; },
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
      messages.delete(p_channel);
      return { ok: true };
    },
    community_channels_reorder: ({ p_community, p_ids }) => {
      const c = needComm(p_community, 'owner', 'moderator');
      validateOrder(c.channels, p_ids);
      c.channels.forEach((ch) => { ch.position = p_ids.indexOf(ch.id); });
      return { ok: true };
    },
    community_messages_page: ({ p_channel, p_before, p_limit = 50 }) => {
      const { ch } = readChannel(p_channel);
      if (!['text', 'announcement'].includes(ch.kind)) fail('bad_kind');
      return page(messages.get(p_channel) || [], p_before, p_limit);
    },
    community_send: ({ p_channel, p_body }) => {
      const { c, ch } = postChannel(p_channel);
      if (!['text', 'announcement'].includes(ch.kind)) fail('bad_kind');
      return addMessage(c, ch, p_body);
    },
    community_forum_topics: ({ p_channel, p_before, p_limit = 30 }) => {
      const { ch } = readChannel(p_channel);
      if (ch.kind !== 'forum') fail('bad_kind');
      return page((messages.get(p_channel) || []).filter((m) => !m.parentId), p_before, p_limit).reverse().map((m) => ({
        ...m, replyCount: (messages.get(p_channel) || []).filter((r) => r.parentId === m.id && !r.deleted).length,
      }));
    },
    community_forum_topic_create: ({ p_channel, p_title, p_body }) => {
      const { c, ch } = postChannel(p_channel);
      if (ch.kind !== 'forum') fail('bad_kind');
      const title = validateTopicTitle(p_title);
      if (!title.ok) fail(title.error);
      return addMessage(c, ch, p_body, { title: title.value, parentId: null, replyCount: 0 });
    },
    community_forum_replies: ({ p_topic, p_before, p_limit = 50 }) => {
      const topic = topicOf(p_topic);
      readChannel(topic.channelId);
      if (topic.deleted) fail('thread_deleted');
      return page((messages.get(topic.channelId) || []).filter((m) => m.parentId === p_topic), p_before, p_limit);
    },
    community_forum_reply: ({ p_topic, p_body }) => {
      const topic = topicOf(p_topic);
      const { c, ch } = postChannel(topic.channelId);
      if (topic.deleted) fail('thread_deleted');
      return addMessage(c, ch, p_body, { parentId: p_topic, title: null });
    },
    community_message_delete: ({ p_id }) => {
      const msg = [...messages.values()].flat().find((m) => m.id === p_id);
      if (!msg) fail('not_found');
      const { c } = readChannel(msg.channelId);
      if (msg.authorId !== 'fake-me' && !isStaff(c.myRole)) fail('forbidden');
      for (const list of messages.values()) for (const m of list) {
        if (m.id === p_id || m.parentId === p_id) Object.assign(m, { deleted: true, body: '', title: null });
      }
      return { ok: true };
    },
    community_voice_room: ({ p_channel }) => {
      const { c, ch } = readChannel(p_channel);
      if (ch.kind !== 'voice') fail('bad_kind');
      return { code: 'ABC234', roomId: 'r-' + ch.id, name: c.name + ' · ' + ch.name, max: 8 };
    },
    community_report: () => ({ ok: true }),

    admin_groups: ({ p_kind, p_query }) => (p_kind === 'clan'
      ? [...clans.values()].filter((c) => like(c.name, p_query) || like(c.tag, p_query)).map((c) => ({ ...card(c), leader: c.members.find((m) => m.role === 'leader') || null, reports: c.id === 'c-2' ? 1 : 0 }))
      : [...communities.values()].filter((c) => like(c.name, p_query)).map((c) => ({ ...commCard(c), owner: c.members.find((m) => m.role === 'owner') || null, reports: c.id === 'm-1' ? 1 : 0 }))),
    admin_group_detail: ({ p_kind, p_id }) => (p_kind === 'clan' ? { ...card(clanOf(p_id)), members: clanOf(p_id).members } : { ...commCard(commOf(p_id)), members: commOf(p_id).members, channels: commOf(p_id).channels }),
    admin_group_dissolve: ({ p_kind, p_id }) => { (p_kind === 'clan' ? clans : communities).delete(p_id); return { ok: true }; },
    admin_group_remove: ({ p_kind, p_id, p_user }) => { const g = p_kind === 'clan' ? clanOf(p_id) : commOf(p_id); g.members = g.members.filter((m) => m.userId !== p_user); return { ok: true }; },
    admin_group_reports: () => reports,
    admin_group_report_close: ({ p_id, p_remove }) => { const r = reports.find((x) => x.id === p_id); r.status = 'closed'; r.closedAt = iso(Date.now()); return { ok: true, removed: !!p_remove }; },
  };

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
  };
}
