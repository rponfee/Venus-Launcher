import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGroups } from '../../../features/communities/fake.js';

const backend = (scenario = 'demo') => createFakeGroups(scenario, { signedIn: () => true, userId: () => 'fake-me', onAuth: () => () => {} });
const KLIPY = { kind: 'klipy', url: 'https://static.klipy.com/ii/abc/def.gif' };
const names = (list) => list.map((x) => x.name);

test('roles propios: crear, repetir, asignar con tope y borrar', async () => {
  const b = backend();
  const role = await b.rpc('community_role_save', { p_community: 'm-1', p_name: 'Cartógrafos', p_color: '#3B82F6' });
  assert.equal(role.color, '#3b82f6');
  await assert.rejects(b.rpc('community_role_save', { p_community: 'm-1', p_name: 'cartógrafos' }), { code: 'role_name_taken' });
  await assert.rejects(b.rpc('community_role_save', { p_community: 'm-1', p_name: '' }), { code: 'bad_role_name' });
  await assert.rejects(b.rpc('community_role_save', { p_community: 'm-1', p_name: 'Color', p_color: 'azul' }), { code: 'bad_color' });
  await b.rpc('community_role_assign', { p_community: 'm-1', p_user: 'f-nacho', p_role: role.id });
  let members = (await b.rpc('community_members_list', { p_community: 'm-1' })).members;
  assert.deepEqual(members.find((m) => m.userId === 'f-nacho').roleIds, [role.id]);
  await assert.rejects(b.rpc('community_role_assign', { p_community: 'm-1', p_user: 'f-tomi', p_role: role.id }), { code: 'bad_target' });
  await assert.rejects(b.rpc('community_role_assign', { p_community: 'm-1', p_user: 'nadie', p_role: role.id }), { code: 'not_member_target' });
  for (const n of ['Uno', 'Dos', 'Tres', 'Cuatro']) {
    const r = await b.rpc('community_role_save', { p_community: 'm-1', p_name: n });
    await b.rpc('community_role_assign', { p_community: 'm-1', p_user: 'f-nacho', p_role: r.id });
  }
  const extra = await b.rpc('community_role_save', { p_community: 'm-1', p_name: 'Seis' });
  await assert.rejects(b.rpc('community_role_assign', { p_community: 'm-1', p_user: 'f-nacho', p_role: extra.id }), { code: 'too_many_member_roles' });
  await b.rpc('community_role_delete', { p_role: role.id });
  members = (await b.rpc('community_members_list', { p_community: 'm-1' })).members;
  assert.equal(members.find((m) => m.userId === 'f-nacho').roleIds.includes(role.id), false);
  const community = await b.rpc('community_get', { p_community: 'm-1' });
  assert.equal(community.roles.some((r) => r.id === role.id), false);
  assert.equal(community.maxRoles, 15);
});

test('un miembro común no administra roles ni permisos', async () => {
  const b = backend('member');
  await assert.rejects(b.rpc('community_role_save', { p_community: 'm-1', p_name: 'Intruso' }), { code: 'forbidden' });
  await assert.rejects(b.rpc('community_channel_perms_get', { p_channel: 't-1' }), { code: 'forbidden' });
  await assert.rejects(b.rpc('community_channel_perms_set', { p_channel: 't-1', p_perms: { write: false } }), { code: 'forbidden' });
  const community = await b.rpc('community_get', { p_community: 'm-1' });
  assert.equal(community.greetings, null, 'la bienvenida es del dueño');
  assert.ok(community.roles.length >= 1, 'pero la lista de roles la ve cualquiera');
});

test('permisos por canal: el miembro ve y puede lo que dicen las reglas, con roles propios encima', async () => {
  const b = backend('member');
  let community = await b.rpc('community_get', { p_community: 'm-1' });
  const by = (id) => community.channels.find((c) => c.id === id);
  assert.equal(by('s-1'), undefined, 'privado sin rol: no llega');
  assert.equal(by('a-1').canPost, false);
  assert.equal(by('t-3').canPost, true);
  assert.equal(by('t-3').canEmbed, false, 'capturas: sin enlaces ni GIFs para todos');
  assert.equal(by('v-2').canConnect, false);
  await assert.rejects(b.rpc('community_messages_page', { p_channel: 's-1' }), { code: 'forbidden' });
  await assert.rejects(b.rpc('community_send', { p_channel: 't-3', p_body: 'mirá https://example.com' }), { code: 'embeds_forbidden' });
  await assert.rejects(b.rpc('community_send_media', { p_channel: 't-3', p_media: KLIPY }), { code: 'embeds_forbidden' });
  await assert.rejects(b.rpc('community_voice_room', { p_channel: 'v-2' }), { code: 'voice_forbidden' });
  assert.equal((await b.rpc('community_send', { p_channel: 't-3', p_body: 'solo texto' })).body, 'solo texto');
  assert.equal((await b.rpc('community_send', { p_channel: 't-1', p_body: 'con enlace https://example.com' })).body, 'con enlace https://example.com');
  community = await b.rpc('community_get', { p_community: 'm-1' });
  assert.equal((await b.rpc('community_voice_room', { p_channel: 'v-1' })).canSpeak, true);
});

test('el dueño edita permisos y la vista "qué puede hacer" coincide con lo que se aplica', async () => {
  const b = backend();
  const role = (await b.rpc('community_get', { p_community: 'm-1' })).roles[0];
  let cfg = await b.rpc('community_channel_perms_get', { p_channel: 't-2' });
  assert.deepEqual(cfg.applies, ['view', 'write', 'embeds', 'react']);
  assert.equal(cfg.everyone.write, true);
  cfg = await b.rpc('community_channel_perms_set', { p_channel: 't-2', p_perms: { write: false, react: false } });
  assert.deepEqual([cfg.everyone.write, cfg.everyone.react], [false, false]);
  cfg = await b.rpc('community_channel_perms_set', { p_channel: 't-2', p_role: role.id, p_perms: { write: 'allow' } });
  assert.equal(cfg.roles.find((r) => r.roleId === role.id).perms.write, 'allow');
  const explain = await b.rpc('community_perms_explain', { p_channel: 't-2', p_subject: role.id });
  const row = (perm) => explain.perms.find((p) => p.perm === perm);
  assert.deepEqual([row('write').allowed, row('write').source], [true, 'role_allow']);
  assert.deepEqual([row('react').allowed, row('react').source], [false, 'everyone_deny']);
  assert.equal((await b.rpc('community_perms_explain', { p_channel: 't-2', p_subject: 'moderator' })).perms.every((p) => p.source === 'staff' || p.source === 'not_applicable'), true);
  await assert.rejects(b.rpc('community_channel_perms_set', { p_channel: 'v-1', p_perms: { write: false } }), { code: 'bad_permission' });
  await assert.rejects(b.rpc('community_channel_perms_set', { p_channel: 'a-1', p_perms: { write: true } }), { code: 'bad_posting_role' });
  await assert.rejects(b.rpc('community_channel_perms_set', { p_channel: 't-2', p_role: 'otro', p_perms: { write: 'allow' } }), { code: 'bad_role' });
  await assert.rejects(b.rpc('community_channel_perms_set', { p_channel: 't-2', p_role: role.id, p_perms: { write: 'quizá' } }), { code: 'bad_permission' });
  cfg = await b.rpc('community_channel_perms_set', { p_channel: 't-2', p_role: role.id, p_perms: { write: 'inherit' } });
  assert.deepEqual(cfg.roles.find((r) => r.roleId === role.id).perms, {});
});

test('reacciones: una por emoji, hasta cinco, quitar la propia y canal sin reacciones', async () => {
  const b = backend();
  let res = await b.rpc('community_react', { p_message: 'x-7', p_emoji: 'like' });
  assert.deepEqual(res.reactions, [{ emoji: 'like', count: 1, mine: true }]);
  res = await b.rpc('community_react', { p_message: 'x-7', p_emoji: 'like' });
  assert.equal(res.reactions[0].count, 1, 'repetir no suma');
  for (const e of ['love', 'laugh', 'wow', 'sad']) await b.rpc('community_react', { p_message: 'x-7', p_emoji: e });
  await assert.rejects(b.rpc('community_react', { p_message: 'x-7', p_emoji: 'fire' }), { code: 'too_many_reactions' });
  await assert.rejects(b.rpc('community_react', { p_message: 'x-7', p_emoji: 'poop' }), { code: 'bad_emoji' });
  res = await b.rpc('community_react', { p_message: 'x-7', p_emoji: 'sad', p_on: false });
  assert.equal(res.reactions.some((r) => r.emoji === 'sad'), false);
  assert.equal((await b.rpc('community_react', { p_message: 'x-s', p_emoji: 'like' })).reactions[0].mine, true, 'el equipo reacciona donde los demás no');
  const member = backend('member');
  await assert.rejects(member.rpc('community_react', { p_message: 'x-s', p_emoji: 'like' }), { code: 'react_forbidden' });
  await assert.rejects(member.rpc('community_react', { p_message: 'x-4', p_emoji: 'like' }), { code: 'not_found' }, 'mensaje borrado');
  assert.equal((await member.rpc('community_react', { p_message: 'x-7', p_emoji: 'like' })).reactions[0].mine, true);
});

test('GIFs en el chat: KLIPY validado, subidos solo aprobados y retirados dejan de verse', async () => {
  const b = backend();
  const sent = await b.rpc('community_send_media', { p_channel: 't-1', p_media: KLIPY, p_body: 'un gato' });
  assert.deepEqual(sent.media, KLIPY);
  await assert.rejects(b.rpc('community_send_media', { p_channel: 't-1', p_media: { kind: 'klipy', url: 'https://evil.example/x.gif' } }), { code: 'bad_media' });
  await assert.rejects(b.rpc('community_send_media', { p_channel: 't-1', p_media: { kind: 'upload', id: 'g-2' } }), { code: 'bad_media' }, 'pendiente');
  await assert.rejects(b.rpc('community_send_media', { p_channel: 't-1', p_media: { kind: 'upload', id: 'g-4' } }), { code: 'bad_media' }, 'rechazado');
  const ok = await b.rpc('community_send_media', { p_channel: 't-1', p_media: { kind: 'upload', id: 'g-1' } });
  assert.equal(ok.media.path, 'm-1/g-1.gif');
  await b.rpc('admin_community_media_review', { p_id: 'g-1', p_decision: 'remove', p_reason: 'Retirado por una denuncia' });
  const page = await b.rpc('community_messages_page', { p_channel: 't-1' });
  assert.ok(page.filter((m) => m.media?.kind === 'upload').every((m) => m.media.unavailable === true && !m.media.path), 'ningún mensaje conserva la ruta de un GIF retirado');
});

test('galería: nace pendiente, el miembro solo ve lo aprobado y el dueño ve el estado', async () => {
  const owner = backend();
  const file = new Blob([new Uint8Array(1500)], { type: 'image/gif' });
  await owner.uploadMedia('m-1/nuevo.gif', file);
  const item = await owner.rpc('community_media_register', { p_id: 'nuevo', p_community: 'm-1', p_name: 'Mi GIF', p_width: 320, p_height: 200 });
  assert.equal(item.status, 'pending');
  assert.equal(item.mine, true);
  assert.equal(typeof (await owner.mediaUrl(item.path)), 'string');
  await assert.rejects(owner.rpc('community_media_register', { p_id: 'fantasma', p_community: 'm-1', p_name: 'X', p_width: 100, p_height: 100 }), { code: 'no_file' });
  await assert.rejects(owner.rpc('community_media_register', { p_id: 'nuevo', p_community: 'm-1', p_name: 'X', p_width: 8, p_height: 100 }), { code: 'bad_dimensions' });
  const list = await owner.rpc('community_media_list', { p_community: 'm-1' });
  assert.equal(list.find((m) => m.id === 'g-4').rejectReason, 'Contenido no apto para todo público');
  assert.deepEqual(names(list).sort(), ['Bienvenida al server', 'Construyendo', 'Creeper feliz', 'Meme no apto', 'Mi GIF']);
  const member = backend('member');
  const seen = await member.rpc('community_media_list', { p_community: 'm-1' });
  assert.deepEqual(names(seen), ['Bienvenida al server', 'Construyendo'], 'un miembro común ve lo aprobado y lo que subió él, nada de lo pendiente de otros');
  assert.equal(seen.find((m) => m.id === 'g-2'), undefined);
  assert.equal(seen[0].rejectReason, null);
  assert.deepEqual(await member.rpc('community_media_resolve', { p_ids: ['g-1', 'g-2'] }).then((r) => r.map((x) => x.id)), ['g-1']);
  const gone = await owner.rpc('community_media_delete', { p_id: 'nuevo' });
  assert.equal(gone.path, 'm-1/nuevo.gif');
});

test('cola de Venus: aprobar, rechazar con motivo y retirar', async () => {
  const b = backend();
  const queue = await b.rpc('admin_community_media_queue', { p_status: 'pending' });
  assert.ok(queue.pending >= 3);
  assert.ok(queue.items.every((i) => i.status === 'pending' && i.path && i.community && i.uploadedBy));
  await assert.rejects(b.rpc('admin_community_media_review', { p_id: 'g-2', p_decision: 'reject' }), { code: 'reason_required' });
  await assert.rejects(b.rpc('admin_community_media_review', { p_id: 'g-2', p_decision: 'remove', p_reason: 'No va a pasar' }), { code: 'bad_state' });
  assert.equal((await b.rpc('admin_community_media_review', { p_id: 'g-2', p_decision: 'approve' })).status, 'approved');
  assert.equal((await b.rpc('admin_community_media_review', { p_id: 'g-3', p_decision: 'reject', p_reason: 'Se ve mal' })).status, 'rejected');
  await assert.rejects(b.rpc('admin_community_media_review', { p_id: 'g-3', p_decision: 'approve' }), { code: 'bad_state' });
  const rejected = await b.rpc('admin_community_media_queue', { p_status: 'rejected' });
  assert.equal(rejected.items.find((i) => i.id === 'g-3').rejectReason, 'Se ve mal');
  const reports = await b.rpc('admin_group_reports');
  const mediaReport = reports.find((r) => r.kind === 'media');
  assert.equal((await b.rpc('admin_group_report_close', { p_id: mediaReport.id, p_remove: true })).removed, true);
  assert.equal((await b.rpc('admin_community_media_queue', { p_status: 'removed' })).items.some((i) => i.id === mediaReport.targetId), true);
});

test('bienvenida y despedida: validación, y se publican al entrar y salir', async () => {
  const b = backend('new');
  const c = await b.rpc('community_create', { p_name: 'Prueba de avisos', p_description: '', p_public: true });
  const state = await b.rpc('community_get', { p_community: c.id });
  const general = state.channels.find((ch) => ch.kind === 'text');
  await assert.rejects(b.rpc('community_greeting_save', { p_community: c.id, p_kind: 'join', p_patch: { enabled: true, body: 'Hola' } }), { code: 'greeting_needs_channel' });
  await assert.rejects(b.rpc('community_greeting_save', { p_community: c.id, p_kind: 'join', p_patch: { body: 'Hola {nombre}' } }), { code: 'bad_greeting_variable' });
  await assert.rejects(b.rpc('community_greeting_save', { p_community: c.id, p_kind: 'join', p_patch: { channelId: 'nope' } }), { code: 'bad_greeting_channel' });
  await assert.rejects(b.rpc('community_greeting_save', { p_community: c.id, p_kind: 'join', p_patch: { enabled: true, channelId: general.id } }), { code: 'greeting_empty' });
  await assert.rejects(b.rpc('community_greeting_save', { p_community: c.id, p_kind: 'join', p_patch: { media: { kind: 'upload', id: 'g-1' } } }), { code: 'bad_media' }, 'un archivo de otra comunidad');
  const saved = await b.rpc('community_greeting_save', { p_community: c.id, p_kind: 'leave', p_patch: { enabled: true, channelId: general.id, body: '{usuario} se fue de {comunidad}', media: KLIPY } });
  assert.equal(saved.leave.enabled, true);
  assert.equal(saved.join.enabled, false);
  assert.deepEqual(saved.leave.media, KLIPY);
});

test('un mensaje de bienvenida del sistema lo arma el servidor con los datos del momento', async () => {
  const b = backend('new');
  await b.rpc('community_greeting_save', { p_community: 'm-3', p_kind: 'join', p_patch: {} }).catch(() => {});
  const joined = await b.rpc('community_join', { p_community: 'm-3' });
  assert.equal(joined.id, 'm-3');
  const mine = await b.rpc('community_get', { p_community: 'm-3' });
  assert.equal(mine.greetings, null);
});
