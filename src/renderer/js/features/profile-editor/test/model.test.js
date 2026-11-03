'use strict';
// Logica pura de los perfiles (features/profile-editor/model.js): normalizar camelCase y snake_case, validar como
// profile_customize (0020_perfiles.sql), armar el patch con solo lo que cambio, CSS del fade y de los banners,
// errores del servidor, estadisticas publicadas y cuentas de las imagenes.
// Uso: node --test "src/renderer/js/features/profile-editor/test/"
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// model.js es un modulo ES (importa la lista de tipografias de fonts.js)
const SRC = require('url').pathToFileURL(path.join(__dirname, '..', 'model.js')).href;
let M;
test.before(async () => {
  M = await import(SRC);
});

const UID = '0b5b9a3e-1f0c-4c55-9a51-2d1c7e3f4a10';
const OTHER = '9d9d9d9d-1111-4222-8333-444455556666';
const media = (name, uid = UID) => `https://abcdefgh.supabase.co/storage/v1/object/public/profile-media/${uid}/${name}`;

// ---------- normalizar ----------
test('normaliza el perfil camelCase de profile_public', () => {
  const p = M.normalizeProfile({
    id: UID,
    username: 'ringo',
    displayName: 'Ringo',
    friendCode: 'VENUS-ABC123',
    mcName: 'Ringo_',
    bio: 'Hola',
    badges: ['founder', 3, 'early'],
    pronouns: 'él',
    theme: { from: '#F29A2E', to: '#3b1450', angle: 200 },
    nameStyle: { font: 'pixel', effect: 'rainbow', color: '#FFC562', glow: 40 },
    banner: { kind: 'preset', preset: 'nebula' },
    favoriteServers: [{ address: 'MC.Hypixel.net', name: 'Hypixel' }, { address: 'bad address' }],
    publicStats: { hours: 12.5, sessions: 40, topVersion: '1.21.1', topLoader: 'fabric', since: '2025-01-02', updatedAt: '2026-10-01T00:00:00Z' },
    featured: [{ url: media('featured-a.webp'), title: 'Mi castillo' }, { url: 'https://evil.example.com/x.png' }],
    equipped: { frame: 'frame_neon', title: 'title_legend', bogus: 'x' },
    premium: true,
    createdAt: '2025-01-01T00:00:00Z',
  });
  assert.equal(p.displayName, 'Ringo');
  assert.equal(p.name, 'Ringo');
  assert.equal(p.mcName, 'Ringo_');
  assert.deepEqual(p.badges, ['founder', 'early']);
  assert.deepEqual(p.theme, { from: '#f29a2e', to: '#3b1450', angle: 200 });
  assert.deepEqual(p.nameStyle, { font: 'pixel', effect: 'rainbow', color: '#ffc562', glow: 40, caps: false, italic: false, outline: false });
  assert.deepEqual(p.banner, { kind: 'preset', preset: 'nebula' });
  assert.equal(p.legacyBanner, null);
  assert.deepEqual(p.favoriteServers, [{ address: 'mc.hypixel.net', name: 'Hypixel' }]);
  assert.equal(p.publicStats.hours, 12.5);
  assert.equal(p.featured.length, 1);
  assert.deepEqual(p.equipped, { frame: 'frame_neon', title: 'title_legend' });
  assert.equal(p.premium, true);
  assert.equal(p.hasStyle, true);
});

test('normaliza la fila cruda de profiles (snake_case) con el banner viejo', () => {
  const p = M.normalizeProfile({
    id: UID,
    username: 'tomi',
    display_name: '  ',
    friend_code: 'VENUS-TOMI00',
    mc_name: 'TomiCraft',
    mc_uuid: '069a79f4-44e9-4726-a5be-fca90e38aaf5',
    banner: 'ocean',
    banner_style: { kind: 'image', url: media('banner-x.webp') },
    name_style: { font: 'serif', effect: 'glow', color: '#7fb2ff', glow: 70 },
    favorite_servers: [{ address: 'play.example.com:25566' }],
    public_stats: null,
    status_text: 'Jugando' + String.fromCharCode(0x2028) + 'bedwars',
    equipped: {},
    theme: {},
  });
  assert.equal(p.displayName, '');
  assert.equal(p.name, 'tomi');
  assert.equal(p.legacyBanner, 'ocean');
  assert.deepEqual(p.banner, { kind: 'image', url: media('banner-x.webp') });
  assert.equal(p.nameStyle.font, 'serif');
  assert.equal(p.theme, null);
  assert.equal(p.publicStats, null);
  assert.equal(p.statusText, 'Jugandobedwars');
  assert.deepEqual(p.favoriteServers, [{ address: 'play.example.com:25566' }]);
  assert.equal(p.hasStyle, true);
});

test('una fila vieja de social no trae estilo y queda con valores por defecto', () => {
  const p = M.normalizeProfile({ id: UID, username: 'luli', display_name: 'Luli', banner: 'cherry' });
  assert.equal(p.hasStyle, false);
  assert.deepEqual(p.nameStyle, { font: 'default', effect: 'none', color: null, glow: 0, caps: false, italic: false, outline: false });
  assert.deepEqual(p.banner, { kind: 'none' });
  assert.equal(p.legacyBanner, 'cherry');
});

test('rechaza datos peligrosos o fuera de rango al normalizar', () => {
  const p = M.normalizeProfile({
    nameStyle: { font: 'comic', effect: 'explode', color: 'red', glow: 400 },
    theme: { from: 'url(x)', to: '#12345', angle: 999 },
    banner: { kind: 'image', url: 'javascript:alert(1)' },
    pronouns: '<b>él</b>',
  });
  assert.deepEqual(p.nameStyle, { font: 'default', effect: 'none', color: null, glow: 0, caps: false, italic: false, outline: false });
  assert.equal(p.theme, null);
  assert.deepEqual(p.banner, { kind: 'none' });
  assert.equal(p.pronouns, 'bél/b');
});

test('blob: y data: solo se aceptan en la vista previa', () => {
  const raw = { banner: { kind: 'image', url: 'blob:file:///abc' }, featured: [{ url: 'data:image/png;base64,AAAA' }] };
  assert.deepEqual(M.normalizeProfile(raw).banner, { kind: 'none' });
  assert.equal(M.normalizeProfile(raw).featured.length, 0);
  assert.deepEqual(M.normalizeProfile(raw, { allowLocalMedia: true }).banner, { kind: 'image', url: 'blob:file:///abc' });
  assert.equal(M.normalizeProfile(raw, { allowLocalMedia: true }).featured.length, 1);
});

test('normalizar dos veces da lo mismo y mergeProfiles junta lo de social con lo de profile_public', () => {
  const once = M.normalizeProfile({ id: UID, displayName: 'R', nameStyle: { font: 'mono' }, banner: { kind: 'preset', preset: 'end' }, mc_uuid: 'x' });
  assert.deepEqual(M.normalizeProfile(once), once);
  const merged = M.normalizeProfile(M.mergeProfiles({ id: UID, display_name: 'Viejo', mc_uuid: '069a79f444e94726a5befca90e38aaf5', banner: 'gold' }, { id: UID, displayName: 'Nuevo', nameStyle: { effect: 'glow' } }));
  assert.equal(merged.displayName, 'Nuevo');
  assert.equal(merged.legacyBanner, 'gold');
  assert.equal(merged.nameStyle.effect, 'glow');
});

// ---------- lo que se ve ----------
test('efecto, marco, titulo y estilo de insignia que se dibujan', () => {
  assert.equal(M.effectiveEffect({ nameStyle: { effect: 'gradient' }, equipped: { nameEffect: 'effect_fire' } }), 'gradient');
  assert.equal(M.effectiveEffect({ nameStyle: { effect: 'none' }, equipped: { nameEffect: 'effect_fire' } }), 'fire');
  assert.equal(M.effectiveEffect({}), 'none');
  assert.equal(M.frameOf({ equipped: { frame: 'frame_gold' } }), 'gold');
  assert.equal(M.frameOf({ equipped: { frame: 'frame_nope' } }), null);
  assert.equal(M.titleOf({ equipped: { title: 'title_redstoner' } }), 'redstoner');
  assert.equal(M.badgeStyleOf({ premium: true, equipped: {} }), 'gold');
  assert.equal(M.badgeStyleOf({ premium: false, equipped: { badgeStyle: 'badge_ice' } }), 'ice');
  assert.equal(M.badgeStyleOf({ premium: false, equipped: {} }), null);
});

test('CSS del fade', () => {
  assert.equal(M.gradientCss({ theme: { from: '#F29A2E', to: '#3b1450', angle: 90 } }), 'linear-gradient(90deg, #f29a2e, #3b1450)');
  assert.equal(M.gradientCss({ from: '#111111', to: '#222222', angle: 400 }), 'linear-gradient(135deg, #111111, #222222)');
  assert.equal(M.gradientCss({ from: '#111111' }), 'linear-gradient(135deg, #111111, #111111)');
  assert.equal(M.gradientCss({ theme: {} }), '');
  assert.equal(M.gradientCss(null), '');
  assert.equal(M.gradientCss({ theme: { from: 'red', to: 'blue' } }), '');
});

test('color legible y brillo', () => {
  assert.equal(M.readableColor('#ffe6b0'), '#ffe6b0');
  const dark = M.readableColor('#200000');
  assert.ok(M.contrastRatio(dark, '#1b130e') >= 4.5, dark);
  assert.equal(M.readableColor('nope'), M.DEFAULT_NAME_COLOR);
  assert.equal(M.glowFilter(0, '#ffffff'), 'none');
  assert.match(M.glowFilter(100, '#ffc562'), /^drop-shadow\(0 0 12px #ffc562[0-9a-f]{2}\)$/);
  assert.match(M.glowFilter(50, 'bad', 2), /^drop-shadow\(0 0 14px #ffe6b0/);
  // Sobre un fade verde, un verde medio se aclara hasta leerse
  const bg = M.fadeSurface({ from: '#3f9a3a', to: '#12301a' });
  assert.notEqual(bg, '#1b130e');
  assert.ok(M.contrastRatio(M.readableColor('#3f9a3a', bg), bg) >= 4.5);
  assert.equal(M.fadeSurface(null), '#1b130e');
});

test('los 8 banners prediseñados tienen CSS y capas para el lienzo', () => {
  for (const id of M.BANNER_PRESETS) {
    const css = M.presetCss(id);
    assert.ok(css.length > 50, id);
    assert.match(css, /linear-gradient\(/, id);
    assert.ok(!/undefined|NaN/.test(css), id);
    assert.ok(Array.isArray(M.presetLayers(id)) && M.presetLayers(id).length >= 3, id);
  }
  assert.equal(M.presetCss('nope'), '');
  // Estable: la misma semilla da siempre lo mismo
  assert.equal(M.presetCss('stars'), M.presetCss('stars'));
});

test('extremos del degradado lineal como en CSS', () => {
  const [x0, y0, x1, y1] = M.linearPoints(90, 200, 100);
  assert.deepEqual([x0, Math.round(y0), x1, Math.round(y1)], [0, 50, 200, 50]);
  const [, a, , b] = M.linearPoints(180, 200, 100);
  assert.deepEqual([Math.round(a) + 0, Math.round(b)], [0, 100]);
});

// ---------- validar ----------
const ctx = { userId: UID, premium: false, owned: new Set(['frame_neon', 'effect_fire']) };

test('valida pronombres y descripcion como el servidor', () => {
  assert.equal(M.validateField('pronouns', 'ella/elle', ctx), null);
  assert.equal(M.validateField('pronouns', '', ctx), null);
  assert.equal(M.validateField('pronouns', null, ctx), null);
  assert.equal(M.validateField('pronouns', 'x'.repeat(25), ctx), 'bad_pronouns');
  assert.equal(M.validateField('pronouns', '<script>', ctx), 'bad_pronouns');
  assert.equal(M.validateField('pronouns', 'a\nb', ctx), 'bad_pronouns');
  assert.equal(M.validateField('bio', 'x'.repeat(200), ctx), null);
  assert.equal(M.validateField('bio', 'x'.repeat(201), ctx), 'bad_bio');
  assert.equal(M.validateField('bio', 5, ctx), 'bad_bio');
});

test('valida el fade y el estilo del nombre', () => {
  assert.equal(M.validateField('theme', { from: '#000000', to: '#ffffff', angle: 360 }, ctx), null);
  assert.equal(M.validateField('theme', {}, ctx), null);
  assert.equal(M.validateField('theme', { from: '#000', to: '#ffffff' }, ctx), 'bad_theme');
  assert.equal(M.validateField('theme', { angle: -1 }, ctx), 'bad_theme');
  assert.equal(M.validateField('theme', { from: '#000000', extra: 1 }, ctx), 'bad_theme');
  assert.equal(M.validateField('nameStyle', { font: 'condensed', effect: 'gradient', color: '#abcdef', glow: 100 }, ctx), null);
  assert.equal(M.validateField('nameStyle', { font: 'papyrus' }, ctx), 'bad_nameStyle');
  assert.equal(M.validateField('nameStyle', { glow: 101 }, ctx), 'bad_nameStyle');
  assert.equal(M.validateField('nameStyle', { size: 3 }, ctx), 'bad_nameStyle');
  // Efectos premium: con premium, o con el efecto comprado
  assert.equal(M.validateField('nameStyle', { effect: 'rainbow' }, ctx), 'premium_required:nameStyle');
  assert.equal(M.validateField('nameStyle', { effect: 'fire' }, ctx), null);
  assert.equal(M.validateField('nameStyle', { effect: 'rainbow' }, { ...ctx, premium: true }), null);
});

test('valida el banner (solo archivos propios y el animado con premium)', () => {
  assert.equal(M.validateField('banner', { kind: 'preset', preset: 'aurora' }, ctx), null);
  assert.equal(M.validateField('banner', { kind: 'preset', preset: 'venus' }, ctx), 'bad_banner');
  assert.equal(M.validateField('banner', { kind: 'none' }, ctx), null);
  assert.equal(M.validateField('banner', { kind: 'image', url: media('banner-1.webp') }, ctx), null);
  assert.equal(M.validateField('banner', { kind: 'image', url: media('banner-1.webp', OTHER) }, ctx), 'bad_banner');
  assert.equal(M.validateField('banner', { kind: 'image', url: media('a b.webp') }, ctx), 'bad_banner');
  assert.equal(M.validateField('banner', { kind: 'animated', url: media('banner-1.gif') }, ctx), 'premium_required:banner');
  assert.equal(M.validateField('banner', { kind: 'animated', url: media('banner-1.gif') }, { ...ctx, premium: true }), null);
  assert.equal(M.validateField('banner', { preset: 'stars' }, ctx), 'bad_banner');
});

test('valida servidores favoritos, estadisticas y destacadas', () => {
  assert.equal(M.validateField('favoriteServers', [{ address: 'mc.hypixel.net' }, { address: 'play.x.org:25566', name: 'X' }], ctx), null);
  assert.equal(M.validateField('favoriteServers', Array.from({ length: 6 }, () => ({ address: 'a.b' })), ctx), 'bad_favoriteServers');
  assert.equal(M.validateField('favoriteServers', [{ address: 'mc_server.net' }], ctx), 'bad_favoriteServers');
  assert.equal(M.validateField('favoriteServers', [{ address: 'a.b', name: 'x'.repeat(41) }], ctx), 'bad_favoriteServers');
  assert.equal(M.validateField('favoriteServers', [{ address: 'a.b', port: 1 }], ctx), 'bad_favoriteServers');
  assert.equal(M.validateField('publicStats', null, ctx), null);
  assert.equal(M.validateField('publicStats', { hours: 10, sessions: 3, topVersion: '1.21', topLoader: 'fabric', since: '2025-01-01' }, ctx), null);
  assert.equal(M.validateField('publicStats', { hours: -1 }, ctx), 'bad_publicStats');
  assert.equal(M.validateField('publicStats', { updatedAt: 'x' }, ctx), 'bad_publicStats');
  assert.equal(M.validateField('publicStats', { topLoader: 'x'.repeat(17) }, ctx), 'bad_publicStats');
  assert.equal(M.validateField('featured', [{ url: media('featured-1.webp'), title: 'Hola' }], ctx), null);
  assert.equal(M.validateField('featured', ['f', 'g', 'h', 'i', 'j', 'k', 'l'].map((n) => ({ url: media(`${n}.webp`) })), ctx), 'bad_featured');
  assert.equal(M.validateField('featured', ['f', 'g', 'h', 'i', 'j', 'k'].map((n) => ({ url: media(`${n}.webp`) })), ctx), null);
  assert.equal(M.validateField('featured', [{ url: media('f.webp'), title: 'x'.repeat(61) }], ctx), 'bad_featured');
});

test('valida lo equipado (comprado o premium)', () => {
  assert.equal(M.validateField('equipped', { frame: 'frame_neon', title: null }, ctx), null);
  assert.equal(M.validateField('equipped', { frame: 'frame_gold' }, ctx), 'not_owned:frame_gold');
  assert.equal(M.validateField('equipped', { frame: 'title_legend' }, { ...ctx, owned: new Set(['title_legend']) }), 'not_owned:title_legend');
  assert.equal(M.validateField('equipped', { frame: 'frame_venus' }, ctx), 'not_owned:frame_venus');
  assert.equal(M.validateField('equipped', { frame: 'frame_venus', badgeStyle: 'badge_gold', title: 'title_supporter' }, { ...ctx, premium: true }), null);
  assert.equal(M.validateField('equipped', { hat: 'x' }, ctx), 'bad_equipped');
  assert.equal(M.validateField('equipped', [], ctx), 'bad_equipped');
});

test('validatePatch rechaza campos desconocidos y devuelve el primero que falla', () => {
  assert.deepEqual(M.validatePatch({ pronouns: 'él', bio: 'Hola' }, ctx), { ok: true });
  assert.deepEqual(M.validatePatch({ display_name: 'x' }, ctx), { ok: false, code: 'bad_field:display_name', field: 'display_name' });
  assert.deepEqual(M.validatePatch({ theme: { from: 'x' } }, ctx), { ok: false, code: 'bad_theme', field: 'theme' });
  assert.deepEqual(M.validatePatch(null, ctx), { ok: false, code: 'bad_request', field: null });
});

// ---------- patch ----------
test('buildPatch manda solo lo que cambio, en forma canonica', () => {
  const base = M.customOf(M.normalizeProfile({ pronouns: 'él', bio: 'Hola', nameStyle: { font: 'pixel', glow: 20 }, banner: { kind: 'preset', preset: 'stars' }, theme: { from: '#111111', to: '#222222', angle: 90 } }));
  assert.deepEqual(M.buildPatch(base, { ...base }), {});
  const draft = { ...base, pronouns: '  él ', bio: 'Hola de nuevo', nameStyle: { font: 'pixel', effect: 'none', color: null, glow: 20 } };
  assert.deepEqual(M.buildPatch(base, draft), { bio: 'Hola de nuevo' });
  const d2 = { ...base, theme: { from: '#111111', to: '#222222', angle: 90.2 }, banner: { kind: 'none' }, nameStyle: { font: 'default', glow: 0 } };
  assert.deepEqual(M.buildPatch(base, d2), { banner: { kind: 'none' }, nameStyle: {} });
  const d3 = { ...base, publicStats: { hours: 1, sessions: 2, topVersion: '' }, featured: [{ url: media('f.webp'), title: ' ' }], equipped: { frame: 'frame_neon', title: '' } };
  assert.deepEqual(M.buildPatch(base, d3), { publicStats: { hours: 1, sessions: 2 }, featured: [{ url: media('f.webp') }], equipped: { frame: 'frame_neon' } });
});

test('buildPatch ignora updatedAt de las estadisticas guardadas', () => {
  const base = M.customOf(M.normalizeProfile({ publicStats: { hours: 3, sessions: 1, updatedAt: '2026-01-01' } }));
  assert.deepEqual(M.buildPatch(base, { ...base, publicStats: { hours: 3, sessions: 1 } }), {});
  assert.deepEqual(M.buildPatch(base, { ...base, publicStats: null }), { publicStats: null });
});

// ---------- errores del servidor ----------
test('traduce los errores de profile_customize', () => {
  assert.deepEqual(M.parseCustomizeError({ message: 'bad_theme', code: '22023' }), { code: 'bad_theme', kind: 'validation', field: 'theme', item: null });
  assert.deepEqual(M.parseCustomizeError({ message: 'premium_required:banner' }), { code: 'premium_required:banner', kind: 'premium', field: 'banner', item: null });
  assert.deepEqual(M.parseCustomizeError({ message: 'not_owned:frame_gold' }), { code: 'not_owned:frame_gold', kind: 'owned', field: 'equipped', item: 'frame_gold' });
  assert.equal(M.parseCustomizeError({ message: 'user_muted', code: '42501' }).kind, 'blocked');
  assert.equal(M.parseCustomizeError({ message: 'user_banned' }).code, 'user_banned');
  assert.equal(M.parseCustomizeError({ message: 'bad_field:display_name' }).field, 'display_name');
  assert.equal(M.parseCustomizeError({ message: 'Could not find the function public.profile_customize(p_patch) in the schema cache', code: 'PGRST202' }).kind, 'unavailable');
  assert.equal(M.parseCustomizeError({ message: 'not_authenticated' }).kind, 'session');
  assert.equal(M.parseCustomizeError(new Error('Failed to fetch')).kind, 'unknown');
});

// ---------- estadisticas ----------
test('estadisticas publicadas desde stats:report', () => {
  const report = {
    firstPlay: new Date(2025, 2, 4, 15).getTime(),
    totals: { ms: 37.26 * 3_600_000, sessions: 120 },
    byVersion: [{ id: '?', ms: 999999999 }, { id: '1.21.1', ms: 5000 }],
    byLoader: [{ id: 'fabric', ms: 9000 }, { id: 'vanilla', ms: 100 }],
  };
  const s = M.publicStatsFromReport(report);
  assert.deepEqual(s, { hours: 37.3, sessions: 120, topVersion: '1.21.1', topLoader: 'fabric', since: '2025-03-04' });
  assert.equal(M.validateField('publicStats', s, ctx), null);
  assert.deepEqual(M.publicStatsFromReport({ totals: {} }), { hours: 0, sessions: 0 });
  assert.equal(M.publicStatsFromReport(null), null);
});

// ---------- imagenes ----------
test('recorte, tamaño final y nombres de archivo', () => {
  assert.deepEqual(M.cropRect(1920, 1080, 4, 0.5), { sx: 0, sy: 300, sw: 1920, sh: 480 });
  assert.deepEqual(M.cropRect(1920, 1080, 4, 0), { sx: 0, sy: 0, sw: 1920, sh: 480 });
  assert.deepEqual(M.cropRect(4000, 500, 4, 1), { sx: 2000, sy: 0, sw: 2000, sh: 500 });
  assert.deepEqual(M.fitSize(1920, 480, 1200, 300), { width: 1200, height: 300 });
  assert.deepEqual(M.fitSize(800, 200, 1200, 300), { width: 800, height: 200 });
  const name = M.mediaFileName('banner', 'webp', 1_700_000_000_000, 0.5);
  assert.match(name, /^banner-[a-z0-9]+\.webp$/);
  assert.match(M.mediaFileName('featured', 'exe'), /^featured-[a-z0-9]+\.webp$/);
  assert.deepEqual(M.mediaPathFromUrl(media('banner-1.webp')), { userId: UID, name: 'banner-1.webp', path: `${UID}/banner-1.webp` });
  assert.deepEqual(M.orphanMedia([{ name: 'banner-1.webp' }, { name: 'featured-2.webp' }, { name: '.emptyFolderPlaceholder' }], [media('featured-2.webp')]), ['banner-1.webp', '.emptyFolderPlaceholder']);
  assert.equal(M.isServerAddress('mc.hypixel.net:25565'), true);
  assert.equal(M.isServerAddress('mc.hypixel.net:123456'), false);
});

// ---------- 3.0 ----------
test('3.0: tipografias, efectos, banners y marcos nuevos', () => {
  assert.ok(M.FONTS.length >= 29, 'al menos 22 tipografias nuevas');
  assert.equal(new Set(M.FONTS).size, M.FONTS.length);
  assert.equal(M.validateField('nameStyle', { font: 'press', caps: true, italic: true, outline: true }, {}), null);
  assert.equal(M.validateField('nameStyle', { font: 'comic-sans' }, {}), 'bad_nameStyle');
  assert.equal(M.validateField('nameStyle', { caps: 'si' }, {}), 'bad_nameStyle');
  assert.equal(M.validateField('nameStyle', { effect: 'galaxy' }, { premium: false }), 'premium_required:nameStyle');
  assert.equal(M.validateField('nameStyle', { effect: 'galaxy' }, { premium: true }), null);
  for (const id of M.BANNER_PRESETS) assert.ok(M.presetCss(id), id);
  assert.equal(M.frameStyle('frame_diamond'), 'diamond');
  assert.equal(M.titleStyle('title_vip'), 'vip');
  assert.equal(M.gradientCss({ theme: { from: '#111111', via: '#222222', to: '#333333', angle: 90 } }), 'linear-gradient(90deg, #111111, #222222, #333333)');
  const ids = M.SHOP_CATALOG.map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.length - 15 >= 22, 'al menos 22 cosmeticos nuevos');
});

test('3.0: banner de KLIPY para todos y solo con direcciones de KLIPY', () => {
  const url = 'https://static.klipy.com/ii/935d7ab9/14/af/um0L4dFH.webp';
  assert.equal(M.validateField('banner', { kind: 'klipy', url, still: 'https://static1.klipy.com/ii/a.jpg', slug: 'gato-1' }, { premium: false }), null);
  assert.equal(M.validateField('banner', { kind: 'klipy', url: 'https://evil.example/a.gif' }, {}), 'bad_banner');
  assert.equal(M.validateField('banner', { kind: 'klipy', url: 'http://static.klipy.com/a.gif' }, {}), 'bad_banner');
  assert.equal(M.validateField('banner', { kind: 'klipy', url: 'https://static.klipy.com.evil.example/a.gif' }, {}), 'bad_banner');
  const n = M.normalizeProfile({ banner_style: { kind: 'klipy', url, slug: 'gato-1', extra: 'x' } });
  assert.deepEqual(n.banner, { kind: 'klipy', url, slug: 'gato-1' });
  assert.deepEqual(M.normalizeProfile({ banner_style: { kind: 'klipy', url: 'https://evil.example/a.gif' } }).banner, { kind: 'none' });
  assert.deepEqual(M.buildPatch({ banner: { kind: 'none' } }, { banner: n.banner }), { banner: { kind: 'klipy', url, slug: 'gato-1' } });
});

test('3.0: redes solo de sitios conocidos', () => {
  assert.equal(M.isProfileLink('youtube', 'https://www.youtube.com/@venus'), true);
  assert.equal(M.isProfileLink('youtube', 'https://youtu.be/abc'), true);
  assert.equal(M.isProfileLink('twitch', 'https://twitch.tv/venus'), true);
  assert.equal(M.isProfileLink('youtube', 'https://youtube.com.evil.example/x'), false);
  assert.equal(M.isProfileLink('youtube', 'http://youtube.com/x'), false);
  assert.equal(M.isProfileLink('youtube', 'https://youtube.com/'), false);
  assert.equal(M.isProfileLink('otro', 'https://youtube.com/x'), false);
  assert.equal(M.isProfileLink('constructor', 'https://youtube.com/x'), false);
  assert.equal(M.validateField('links', [{ kind: 'x', url: 'https://x.com/venus' }], {}), null);
  assert.equal(M.validateField('links', Array(6).fill({ kind: 'x', url: 'https://x.com/venus' }), {}), 'bad_links');
  assert.deepEqual(M.normalizeProfile({ links: [{ kind: 'x', url: 'https://evil.example/a' }, { kind: 'kick', url: 'https://kick.com/venus' }] }).links, [{ kind: 'kick', url: 'https://kick.com/venus' }]);
});

test('3.0: estilo de la tarjeta, vitrina y rango', () => {
  assert.equal(M.validateField('cardStyle', { pattern: 'hex', avatar: 'round', layout: 'center', accent: '#ff0000' }, {}), null);
  assert.equal(M.validateField('cardStyle', { pattern: 'url(evil)' }, {}), 'bad_cardStyle');
  // Desde la 3.1 el estilo normalizado trae ademas tema, burbuja, entrada, cancion y libro (en sus valores por defecto)
  assert.deepEqual(M.normalizeProfile({ card_style: { pattern: 'x', accent: 'rojo' } }).cardStyle, {
    pattern: 'none',
    avatar: 'square',
    layout: 'classic',
    accent: null,
    theme: { id: 'none', particles: false },
    bubble: { style: 'default', color: null },
    entry: 'none',
    song: null,
    guestbook: false,
  });
  assert.equal(M.validateField('showcase', { achievements: ['diamond_1'], skin: true }, {}), null);
  assert.equal(M.validateField('showcase', { achievements: Array(7).fill('diamond_1') }, {}), 'bad_showcase');
  assert.equal(M.validateField('showcase', { clips: ['no-es-uuid'] }, {}), 'bad_showcase');
  const pub = { showcase: { skin: true, achievements: [{ id: 'diamond_1', at: '2026-11-02' }], clips: [{ id: '123e4567-e89b-12d3-a456-426614174000', url: 'https://x/y.webm', title: 'Clip' }] } };
  const n = M.normalizeProfile(pub);
  assert.equal(n.showcase.skin, true);
  assert.equal(n.showcase.clips[0].url, 'https://x/y.webm');
  // customOf es canonico: la pose, el fondo y las insignias raras en su valor por defecto no aparecen
  assert.deepEqual(M.customOf(n).showcase, { achievements: ['diamond_1'], clips: ['123e4567-e89b-12d3-a456-426614174000'], skin: true });
  assert.equal(M.normalizeProfile({ rank: 'owner' }).rank, 'owner');
  assert.equal(M.normalizeProfile({ rank: 'dios' }).rank, null);
});

test('3.0: respuesta de KLIPY en su orden, sin lo que no es un GIF', () => {
  const file = (n) => ({ md: { webp: { url: `https://static.klipy.com/${n}.webp` }, jpg: { url: `https://static.klipy.com/${n}.jpg` } }, sm: { webp: { url: `https://static.klipy.com/${n}-s.webp` } } });
  const res = M.parseGifs({ result: true, data: { has_next: true, data: [{ type: 'gif', slug: 'b', title: 'B', file: file('b') }, { type: 'ad', content: '<x>' }, { type: 'gif', slug: 'a', file: file('a') }, { type: 'gif', slug: 'sin-archivo', file: {} }] } });
  assert.deepEqual(res.items.map((g) => g.slug), ['b', 'a']);
  assert.equal(res.items[0].url, 'https://static.klipy.com/b.webp');
  assert.equal(res.items[0].thumb, 'https://static.klipy.com/b-s.webp');
  assert.equal(res.items[0].still, 'https://static.klipy.com/b.jpg');
  assert.equal(res.hasNext, true);
  assert.deepEqual(M.parseGifs(null), { items: [], hasNext: false });
});
