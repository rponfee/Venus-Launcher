'use strict';
// Avatar siempre circular y banners sin diseños ni GIF propios (4.6): contratos de las hojas de estilos, de los textos y del
// editor. La interfaz necesita DOM, asi que son pruebas que leen los archivos: cuidan que no vuelvan las formas de antes
// (cuadrada, hexagonal), los 16 diseños, el banner animado de Premium ni la subida de GIF.
// Uso: node --test "src/renderer/js/social/test/"
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const RENDERER = path.join(__dirname, '..', '..', '..'); // src/renderer
const read = (...p) => fs.readFileSync(path.join(RENDERER, ...p), 'utf8');
const css = (...p) => read('styles', ...p).replace(/\/\*[\s\S]*?\*\//g, ''); // sin comentarios
const js = (...p) => read('js', ...p);
// Sin comentarios de linea: las menciones en texto no cuentan, el codigo si
const code = (src) => src.replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/\s.*$/gm, '');

// Todas las hojas de estilos del launcher
function allCss(dir = path.join(RENDERER, 'styles')) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) out.push(...allCss(full));
    else if (name.endsWith('.css')) out.push(full);
  }
  return out;
}

// [{ selector, body }] de las reglas simples de una hoja (sin @media anidados: alcanza para buscar un radio)
function rules(text) {
  const out = [];
  const re = /([^{}@]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(text))) out.push({ selector: m[1].trim(), body: m[2].trim() });
  return out;
}

test('el avatar es un circulo en todas partes: una regla global con !important cubre cada cabeza de perfil', () => {
  const main = rules(css('main.css'));
  const rule = main.find((r) => /border-radius:\s*50%\s*!important/.test(r.body) && r.selector.split(',').map((s) => s.trim()).includes('.sc-head'));
  assert.ok(rule, 'falta la regla .sc-head { border-radius: 50% !important } en main.css');
  const sel = rule.selector.split(',').map((s) => s.trim());
  // Mensajes, comunidades y chats usan headImg() (.sc-head); la voz dibuja .vc-avatar; y las listas de amigos de otras pantallas
  for (const s of ['.vc-avatar', '.hm-av-img', '.shr-avatar', '.cl-avatar', '.np-friend-av img', '.nc-mini-fav-img', '.mpa-avatar', '.srv-item .avatar', '.cfg-v-avatar']) assert.ok(sel.includes(s), s);
  assert.ok(main.some((r) => r.selector === '.vc-ring' && /border-radius:\s*50%\s*!important/.test(r.body)), 'el anillo de la voz tambien es redondo');
});

test('ninguna hoja le da otra forma a .sc-head, y las formas viejas (pf-avatar-*) ya no existen', () => {
  for (const file of allCss()) {
    const text = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const name = path.relative(RENDERER, file);
    assert.ok(!/pf-avatar-(hex|round|square)/.test(text), `${name}: quedo una forma vieja del avatar`);
    for (const r of rules(text)) {
      if (!/\.sc-head(?![\w-])/.test(r.selector)) continue;
      const radius = /(?:^|[;\s])border-radius:\s*([^;]+)/.exec(r.body);
      if (radius) assert.match(radius[1].trim(), /^50%/, `${name}: ${r.selector} redondea distinto`);
      assert.ok(!/clip-path/.test(r.body), `${name}: ${r.selector} recorta la cabeza`);
    }
  }
  assert.match(rules(css('pages', 'messages.css')).find((r) => r.selector === '.sc-head').body, /border-radius:\s*50%/);
});

test('los marcos de la cabeza son dibujos SVG redondos (frames.css) y el punto de presencia va sobre el borde del circulo', () => {
  const style = rules(css('features', 'profile-style.css'));
  // Los marcos viejos (pseudo-elementos con radio y colores) ya no estan en profile-style.css
  assert.ok(!/pf-frame-(pixel|neon|gold|venus)/.test(css('features', 'profile-style.css')));
  assert.ok(!/--pf-frame-(r|w)/.test(css('features', 'profile-style.css')) && !/--pf-frame-(r|w)/.test(css('features', 'profile-editor.css')));
  const dot = style.find((r) => r.selector === '.pf-card-head .sc-dot');
  assert.match(dot.body, /right:\s*1px/);
});

test('el editor ya no ofrece la forma de la cabeza ni los diseños de banner ni el GIF propio', () => {
  const editor = code(js('features', 'profile-editor.js'));
  assert.ok(!/cardRadio\('avatar'/.test(editor), 'selector de forma de la cabeza');
  assert.ok(!/AVATAR_SHAPES|avatarGroup|card_avatar/.test(editor));
  assert.ok(!/BANNER_PRESETS|presetCss|presetLayers/.test(editor));
  assert.ok(!/gifBanner|pickGif/.test(editor));
  // 'animated' solo puede aparecer como codigo de error de la imagen (MediaError), nunca como tipo de banner
  // (el 'preset' de parseBanner, "cur.kind", es el color clasico de siempre y se queda)
  assert.ok(!/(banner\(\)|\bb|S\.draft\.custom\.banner)\.kind\s*(===|!==)\s*'(animated|preset)'/.test(editor) && !/kind:\s*'(animated|preset)'/.test(editor) && !/bannerTab === '(animated|preset)'/.test(editor));
  assert.match(editor, /const MEDIA_CODES = \['type', 'animated',/);
  // Solo quedan tres tipos de banner: color clasico, GIF de KLIPY e imagen propia
  assert.match(editor, /\['color', 'klipy', 'image'\]\.map/);
  // La imagen propia se lee mirando el contenido del archivo
  assert.match(editor, /readImageFile\(file, \{ still: true \}\)/);
  // "Disposicion" se conserva
  assert.match(editor, /cardRadio\('layout'/);
  const media = code(js('features', 'profile-editor', 'media.js'));
  assert.ok(!/gifBanner|image\/gif/.test(media));
  assert.match(media, /bannerSourceError/);
  assert.ok(!/gif:\s*'image\/gif'/.test(media), 'uploadMedia ya no sube GIF');
  for (const f of ['profile-style.js', 'profile-ui.js']) assert.ok(!/BANNER_PRESETS|presetCss|'animated'|freezeGif/.test(code(js('social', f))), f);
  const share = code(js('features', 'profile-editor', 'share.js'));
  assert.ok(!/presetLayers|drawLayers|'animated'/.test(share));
  // La imagen para compartir dibuja la cabeza redonda
  assert.match(share, /roundRect\(g, hx, hy, HS, HS, HS \/ 2\)/);
});

test('textos (es y en): sin las formas del avatar ni los diseños, y con lo nuevo del editor', async () => {
  const OLD = [
    'card_avatar', 'card_avatar_square', 'card_avatar_round', 'card_avatar_hex',
    'bannerKind_preset', 'bannerKind_animated', 'bannerGifPick', 'bannerGifHint', 'bannerGifLocked', 'bannerGifLockedText', 'err_premium_banner',
    ...['stars', 'sunset', 'nebula', 'forest', 'ocean', 'nether', 'end', 'aurora', 'cherry', 'desert', 'snow', 'deepdark', 'lush', 'mesa', 'mushroom', 'void'].map((k) => `banner_${k}`),
  ];
  const NEW = ['bannerPreview', 'bannerStill', 'errMedia_animated', 'sec_nav', 'sec_card', 'sec_cardHint', 'sec_name', 'sec_nameHint', 'sec_chat', 'sec_chatHint'];
  const KEEP = ['card_layout', 'card_layout_classic', 'card_layout_center', 'bannerKind', 'bannerKind_image', 'bannerKind_klipy', 'bannerKind_color', 'bannerPick', 'bannerImageHint', 'bannerColorHint', 'bannerFocus', 'bannerRemove', 'errMedia_type'];
  const dicts = {};
  for (const lang of ['es', 'en']) dicts[lang] = (await import(pathToFileURL(path.join(RENDERER, 'i18n', lang, 'profile.js')).href)).default;
  for (const lang of ['es', 'en']) {
    for (const k of OLD) assert.ok(!(k in dicts[lang]), `${lang}: quedo ${k}`);
    for (const k of [...NEW, ...KEEP]) assert.ok(typeof dicts[lang][k] === 'string' && dicts[lang][k].length > 3, `${lang}: falta ${k}`);
    // Los textos nuevos no prometen lo que ya no hay
    assert.ok(!/premium/i.test(dicts[lang].bannerStill + dicts[lang].errMedia_animated + dicts[lang].bannerImageHint));
  }
  assert.match(dicts.es.errMedia_animated, /GIF.*APNG.*WebP/);
  assert.match(dicts.en.errMedia_animated, /GIF.*APNG.*WebP/);
  assert.match(dicts.es.errMedia_type, /PNG, JPG o WebP\.$/);
  assert.match(dicts.en.errMedia_type, /PNG, JPG or WebP image\.$/);
  // Mismas claves nuevas en los dos idiomas
  for (const k of NEW) assert.equal(typeof dicts.en[k], typeof dicts.es[k], k);
});

test('la base: el servidor y el cliente piden lo mismo (profile_customize de 0039 y model.js)', async () => {
  const sql = fs.readFileSync(path.join(RENDERER, '..', '..', 'supabase', 'migrations', '0039_perfil_circular_banners.sql'), 'utf8');
  const M = await import(pathToFileURL(path.join(RENDERER, 'js', 'features', 'profile-editor', 'model.js')).href);
  // Avatar: solo 'round'
  assert.match(sql, /\(v \? 'avatar' and \(jsonb_typeof\(v -> 'avatar'\) <> 'string' or \(v ->> 'avatar'\) <> 'round'\)\)/);
  assert.deepEqual(M.AVATAR_SHAPES, ['round']);
  // Banner: ni preset ni animated, y la ruta de la imagen
  const customize = /create or replace function public\.profile_customize[\s\S]*?end \$\$;/.exec(sql)[0];
  assert.ok(!/'preset'|'animated'|profile_banners|premium_required:banner/.test(customize));
  assert.match(sql, /banner\(-\[A-Za-z0-9_-\]\{1,64\}\)\?\\\.\(webp\|jpg\|jpeg\|png\)\$/);
  const UID = '0b5b9a3e-1f0c-4c55-9a51-2d1c7e3f4a10';
  const url = (n) => `https://abcdefgh.supabase.co/storage/v1/object/public/profile-media/${UID}/${n}`;
  for (const n of ['banner-a.webp', 'banner-a.jpg', 'banner-a.jpeg', 'banner-a.png', 'banner.webp']) assert.equal(M.isBannerImageUrl(url(n), UID), true, n);
  for (const n of ['banner-a.gif', 'banner-a.apng', 'banner-a.GIF', 'featured-a.webp', 'banner-a']) assert.equal(M.isBannerImageUrl(url(n), UID), false, n);
  // El bucket no acepta gif y las politicas piden una extension de imagen quieta
  assert.match(sql, /allowed_mime_types = array\['image\/png', 'image\/jpeg', 'image\/webp'\]/);
  assert.equal((sql.match(/lower\(storage\.extension\(name\)\) in \('webp', 'jpg', 'jpeg', 'png'\)/g) || []).length, 2);
  // Termina como las demas: revoke a anon y grant solo a authenticated
  assert.match(sql, /revoke all on function public\.profile_customize\(jsonb\) from public, anon;/);
  assert.match(sql, /grant execute on function public\.profile_customize\(jsonb\) to authenticated;/);
});
