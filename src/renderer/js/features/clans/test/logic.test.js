const { default: test } = await import('node:test');
const { default: assert } = await import('node:assert/strict');
const L = await import('../logic.js');

// Mismos vectores que la prueba de la migración (private.group_reserved): las dos listas tienen que coincidir.
const RESERVED = ['Admin Team', 'ADMIN', 'V3nus', 'venus', 'STAFF', 'Los Mods', 'mod', 'El Oficial', 'oficial', 'Official', 'Moderador', 'Soporte 24', 'AdminClan', 'ClanVenus', 'Vеnus', '4DM1N', 'M0D'];
const ALLOWED = ['Moderno', 'Badminton', 'Los Creeper', 'Commodore', 'Modpack Club', 'Venecia', 'Oficina', 'CR', 'MO'];

test('palabras reservadas, también disfrazadas', () => {
  for (const name of RESERVED) assert.equal(L.isReserved(name), true, name);
  for (const name of ALLOWED) assert.equal(L.isReserved(name), false, name);
});

test('nombre del clan', () => {
  assert.deepEqual(L.validateClanName('  Los   Creeper '), { ok: true, error: null, value: 'Los Creeper' });
  assert.equal(L.validateClanName('ab').error, 'bad_name');
  assert.equal(L.validateClanName('x'.repeat(31)).error, 'bad_name');
  assert.equal(L.validateClanName('x'.repeat(30)).ok, true);
  assert.equal(L.validateClanName('<b>Clan</b>').error, 'bad_name');
  assert.equal(L.validateClanName(`Clan${String.fromCharCode(0x202e)}x`).error, 'bad_name');
  assert.equal(L.validateClanName(`Clan${String.fromCharCode(0x200b)}x`).error, 'bad_name');
  assert.equal(L.validateClanName('Clan Venus').error, 'reserved_name');
  assert.equal(L.validateClanName(null).error, 'bad_name');
  assert.equal(L.validateClanName('Ñandú Team').ok, true);
});

test('tag: de 2 a 5 letras o números, sin importar mayúsculas', () => {
  assert.equal(L.validateTag(' cr ').value, 'CR');
  assert.equal(L.validateTag('a').error, 'bad_tag');
  assert.equal(L.validateTag('abcdef').error, 'bad_tag');
  assert.equal(L.validateTag('a-b').error, 'bad_tag');
  assert.equal(L.validateTag('ñu').error, 'bad_tag');
  assert.equal(L.validateTag('mod').error, 'reserved_tag');
  assert.equal(L.validateTag('4dm1n').error, 'reserved_tag');
  assert.equal(L.validateTag('v3nus').error, 'reserved_tag');
  assert.equal(L.validateTag('ofic').error, 'reserved_tag');
  assert.equal(L.validateTag('mc42').value, 'MC42');
});

test('descripción, canal y mensaje', () => {
  assert.equal(L.validateDescription(' hola\nchau ', 300).value, 'hola\nchau');
  assert.equal(L.validateDescription('x'.repeat(301), 300).error, 'bad_description');
  assert.equal(L.validateDescription(`a${String.fromCharCode(0x202e)}`, 300).error, 'bad_description');
  assert.equal(L.validateChannelName(' general ').value, 'general');
  assert.equal(L.validateChannelName('  ').error, 'bad_channel_name');
  assert.equal(L.validateChannelName('x'.repeat(31)).error, 'bad_channel_name');
  assert.equal(L.validateMessage('  hola <b>x</b> ').value, 'hola <b>x</b>');
  assert.equal(L.validateMessage('   ').error, 'bad_body');
  assert.equal(L.validateMessage('x'.repeat(2001)).error, 'bad_body');
  assert.equal(L.validateMessage('x'.repeat(2000)).ok, true);
  // Los emojis compuestos usan el carácter de unión de ancho cero: en un mensaje se aceptan
  assert.equal(L.validateMessage(`👨${String.fromCharCode(0x200d)}💻`).ok, true);
});

test('formulario completo', () => {
  const good = { name: 'Los Creeper', tag: 'CR', description: '', color: '#7c5cff', emblem: 'shield' };
  assert.equal(L.validateClanForm(good).ok, true);
  assert.equal(L.validateClanForm({ ...good, color: 'red' }).error, 'bad_color');
  assert.equal(L.validateClanForm({ ...good, emblem: 'bomba' }).error, 'bad_emblem');
  assert.equal(L.validateClanForm({ ...good, tag: '' }).error, 'bad_tag');
});

test('códigos de invitación', () => {
  assert.equal(L.normalizeCode('clan-abc234', 'CLAN'), 'CLAN-ABC234');
  assert.equal(L.normalizeCode(' ABC 234 ', 'CLAN'), 'CLAN-ABC234');
  assert.equal(L.normalizeCode('com abc234', 'COM'), 'COM-ABC234');
  assert.equal(L.normalizeCode('abc', 'CLAN'), null);
  assert.equal(L.normalizeCode('abc2345', 'CLAN'), null);
  assert.equal(L.normalizeCode('', 'COM'), null);
});

test('color y emblema ajenos: si no son de la lista, lo de siempre', () => {
  assert.equal(L.safeColor('#AABBCC'), '#aabbcc');
  assert.equal(L.safeColor('red;background:url(x)'), L.COLORS[0]);
  assert.equal(L.safeEmblem('crown'), 'crown');
  assert.equal(L.safeEmblem('<img>'), 'shield');
  assert.equal(L.readableInk('#ffffff'), '#000000');
  assert.equal(L.readableInk('#000000'), '#ffffff');
  assert.equal(L.readableInk('cualquiera'), L.readableInk(L.COLORS[0]));
});

test('quién puede hacer qué en un clan', () => {
  assert.equal(L.canKickFromClan('leader', 'officer'), true);
  assert.equal(L.canKickFromClan('leader', 'member'), true);
  assert.equal(L.canKickFromClan('leader', 'leader'), false);
  assert.equal(L.canKickFromClan('officer', 'member'), true);
  assert.equal(L.canKickFromClan('officer', 'officer'), false);
  assert.equal(L.canKickFromClan('officer', 'leader'), false);
  assert.equal(L.canKickFromClan('member', 'member'), false);
  assert.equal(L.canKickFromClan(null, 'member'), false);
  assert.equal(L.canSetClanRole('leader', 'member'), true);
  assert.equal(L.canSetClanRole('leader', 'leader'), false);
  assert.equal(L.canSetClanRole('officer', 'member'), false);
  assert.equal(L.canTransferClan('leader', 'member'), true);
  assert.equal(L.canTransferClan('officer', 'member'), false);
  assert.equal(L.isClanStaff('officer'), true);
  assert.equal(L.isClanStaff('member'), false);
  assert.equal(L.isClanStaff(undefined), false);
});

test('miembros: líder, oficiales y después por antigüedad', () => {
  const out = L.sortClanMembers([{ userId: 'c', role: 'member', joinedAt: '2026-01-02' }, null, { userId: 'b', role: 'member', joinedAt: '2026-01-01' }, { userId: 'o', role: 'officer', joinedAt: '2026-03-01' }, { userId: 'l', role: 'leader', joinedAt: '2026-04-01' }]);
  assert.deepEqual(out.map((m) => m.userId), ['l', 'o', 'b', 'c']);
  assert.deepEqual(L.sortClanMembers(null), []);
});

test('logros y horas', () => {
  assert.equal(L.minutesToHours(90), 1.5);
  assert.equal(L.minutesToHours(100), 1.7);
  assert.equal(L.minutesToHours(-5), 0);
  assert.equal(L.minutesToHours(undefined), 0);
  assert.deepEqual(L.achievementView({ id: 'hours_100', kind: 'minutes', goal: 6000, value: 3000, unlocked: false }), { id: 'hours_100', kind: 'minutes', unlocked: false, pct: 50, value: 50, goal: 100 });
  assert.equal(L.achievementView({ id: 'members_5', kind: 'members', goal: 5, value: 50, unlocked: true }).pct, 100);
  assert.equal(L.achievementView(null).pct, 0);
});

test('por qué el ranking está en cero', () => {
  assert.equal(L.rankingNotice(null), 'unavailable');
  assert.equal(L.rankingNotice({ available: false, rows: [{ sharing: 0 }] }), 'unavailable');
  assert.equal(L.rankingNotice({ available: true, rows: [{ sharing: 0 }] }), 'nobody');
  assert.equal(L.rankingNotice({ available: true, rows: [] }), 'nobody');
  assert.equal(L.rankingNotice({ available: true, rows: [{ sharing: 1 }] }), 'nobody', 'con uno solo el servidor da cero');
  assert.equal(L.rankingNotice({ available: true, rows: [{ sharing: 0 }, { sharing: 2 }] }), null);
});

test('semanas de lunes a domingo en UTC', () => {
  assert.equal(L.weekOf(Date.parse('2026-11-08T23:59:59Z')), '2026-11-02');
  assert.equal(L.weekOf(Date.parse('2026-11-09T00:00:00Z')), '2026-11-09');
  assert.equal(L.shiftWeek('2026-11-02', -1), '2026-10-26');
  assert.equal(L.shiftWeek('2026-12-28', 1), '2027-01-04');
});

test('errores: el texto del servidor es el código', () => {
  assert.equal(L.classifyGroupError({ code: '22023', message: 'name_taken' }), 'name_taken');
  assert.equal(L.classifyGroupError({ code: '42501', message: 'user_banned' }), 'user_banned');
  assert.equal(L.classifyGroupError({ code: 'PT429', message: 'rate_limited' }), 'rate_limited');
  assert.equal(L.classifyGroupError({ code: '42501', message: 'not_authenticated' }), 'noSession');
  assert.equal(L.classifyGroupError({ code: 'PGRST202', message: 'Could not find the function' }), 'unavailable');
  assert.equal(L.classifyGroupError({ status: 404, message: 'x' }), 'unavailable');
  assert.equal(L.classifyGroupError({ code: 'PGRST301', message: 'JWT expired' }), 'noSession');
  assert.equal(L.classifyGroupError(new TypeError('Failed to fetch')), 'network');
  assert.equal(L.classifyGroupError({ message: 'Algo Raro Pasó' }), 'server');
  assert.equal(L.classifyGroupError(null), 'server');
});
