// Stickers y emojis propios: direcciones, nombres, formato del mensaje y validacion de archivos.
// node --test "src/renderer/js/social/test/"
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStickerUrl, stickerInMessage, stickerUrl, isStickerName, cleanStickerName, emojiNames, splitEmojis, sniffImage, extOfMime, fitInside, uploadPlan, stickerError, StickerError, STICKER_LIMITS } from '../stickers.js';

const BASE = 'https://abc123.supabase.co';
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const ID = '33333333-3333-4333-8333-333333333333';
const URL_OK = `${BASE}/storage/v1/object/public/stickers/${USER}/${ID}.webp`;

test('solo se aceptan archivos del bucket de este proyecto', () => {
  assert.deepEqual(parseStickerUrl(URL_OK, BASE), { userId: USER, id: ID, ext: 'webp', path: `${USER}/${ID}.webp` });
  assert.equal(stickerUrl(`${USER}/${ID}.webp`, `${BASE}/`), URL_OK);
  const bad = [
    `https://otroproyecto.supabase.co/storage/v1/object/public/stickers/${USER}/${ID}.webp`,
    `https://abc123.supabase.co.evil.invalid/storage/v1/object/public/stickers/${USER}/${ID}.webp`,
    `http://abc123.supabase.co/storage/v1/object/public/stickers/${USER}/${ID}.webp`,
    `${BASE}/storage/v1/object/public/profile-media/${USER}/${ID}.webp`,
    `${BASE}/storage/v1/object/public/stickers/${USER}/${ID}.svg`,
    `${BASE}/storage/v1/object/public/stickers/${USER}/${ID}.webp?x=1`,
    `${BASE}/storage/v1/object/public/stickers/${USER}/../${ID}.webp`,
    `${BASE}/storage/v1/object/public/stickers/${USER}/sub/${ID}.webp`,
    `${BASE}/storage/v1/object/public/stickers/no-es-uuid/${ID}.webp`,
    'data:image/png;base64,AAAA',
    'javascript:alert(1)',
    '',
    null,
    12,
  ];
  for (const url of bad) assert.equal(parseStickerUrl(url, BASE), null, String(url));
  assert.equal(parseStickerUrl(URL_OK, ''), null, 'sin proyecto no se acepta nada');
});

test('un mensaje es sticker solo si es la direccion sola y de la carpeta del que escribio', () => {
  assert.equal(stickerInMessage(URL_OK, USER, BASE).id, ID);
  assert.equal(stickerInMessage(`  ${URL_OK}\n`, USER, BASE).id, ID);
  assert.equal(stickerInMessage(URL_OK, OTHER, BASE), null, 'el sticker de otro se ve como texto');
  assert.equal(stickerInMessage(`mira ${URL_OK}`, USER, BASE), null, 'con texto al lado sigue siendo texto');
  assert.equal(stickerInMessage('hola', USER, BASE), null);
  assert.equal(stickerInMessage(URL_OK, null, BASE), null);
});

test('nombres', () => {
  assert.equal(isStickerName('gato_1'), true);
  assert.equal(isStickerName('a'), false);
  assert.equal(isStickerName('Gato'), false);
  assert.equal(isStickerName('x'.repeat(25)), false);
  assert.equal(isStickerName('con espacio'), false);
  assert.equal(isStickerName(null), false);
  assert.equal(cleanStickerName('Mi Gato Ñandú!.PNG'), 'mi_gato_nandu');
  assert.equal(cleanStickerName('___'), '');
  assert.equal(cleanStickerName('x'.repeat(40)).length, STICKER_LIMITS.nameMax);
});

test('encuentra los :nombre: de un texto, sin repetir y con tope', () => {
  assert.deepEqual(emojiNames('hola :gato: y :perro_2: y :gato: fin'), ['gato', 'perro_2']);
  assert.deepEqual(emojiNames(':A: :a: : x: ::'), [], 'mayusculas, muy corto o con espacios no son nombres');
  assert.deepEqual(emojiNames('hora 12:30:45'), ['30'], 'dos digitos entre dos puntos parece un nombre');
  const many = Array.from({ length: 50 }, (_, i) => `:n${i}:`).join(' ');
  assert.equal(emojiNames(many).length, STICKER_LIMITS.perMessage);
  assert.deepEqual(emojiNames(null), []);
});

test('reemplaza solo los :nombre: que conoce el que escribio; lo demas queda como texto', () => {
  const lookup = (n) => ({ gato: 'U1' })[n] || null;
  assert.deepEqual(splitEmojis('hola :gato: y :perro: fin', lookup), ['hola ', { name: 'gato', url: 'U1' }, ' y :perro: fin']);
  assert.deepEqual(splitEmojis(':gato:', lookup), [{ name: 'gato', url: 'U1' }]);
  assert.deepEqual(splitEmojis(':perro:', lookup), [':perro:']);
  assert.deepEqual(splitEmojis('sin nada', lookup), ['sin nada']);
  assert.deepEqual(splitEmojis('', lookup), []);
  assert.deepEqual(splitEmojis(':gato:', null), [':gato:']);
  const many = Array.from({ length: STICKER_LIMITS.perMessage + 5 }, () => ':gato:').join('');
  assert.equal(splitEmojis(many, lookup).filter((p) => typeof p !== 'string').length, STICKER_LIMITS.perMessage, 'tope de imagenes por mensaje');
});

const bytes = (...head) => {
  const b = new Uint8Array(16);
  b.set(head);
  return b;
};

test('reconoce el tipo por los bytes, no por el nombre', () => {
  assert.equal(sniffImage(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)), 'image/png');
  assert.equal(sniffImage(bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61)), 'image/gif');
  assert.equal(sniffImage(bytes(0x47, 0x49, 0x46, 0x38, 0x37, 0x61)), 'image/gif');
  assert.equal(sniffImage(bytes(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50)), 'image/webp');
  assert.equal(sniffImage(bytes(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45)), null, 'un WAV no es una imagen');
  assert.equal(sniffImage(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg">')), null, 'SVG no');
  assert.equal(sniffImage(bytes(0xff, 0xd8, 0xff)), null, 'JPEG no');
  assert.equal(sniffImage(new Uint8Array(3)), null);
  assert.equal(sniffImage(null), null);
  assert.equal(extOfMime('image/webp'), 'webp');
  assert.equal(extOfMime('image/svg+xml'), null);
});

test('achica sin agrandar ni deformar', () => {
  assert.deepEqual(fitInside(640, 320), { width: 320, height: 160 });
  assert.deepEqual(fitInside(100, 50), { width: 100, height: 50 });
  assert.deepEqual(fitInside(320, 320), { width: 320, height: 320 });
  assert.deepEqual(fitInside(1000, 1), { width: 320, height: 1 });
});

test('decide si se sube tal cual, se achica o se pide otro', () => {
  const ok = { bytes: 1000, width: 320, height: 200 };
  assert.equal(uploadPlan({ mime: 'image/png', ...ok }), 'keep');
  assert.equal(uploadPlan({ mime: 'image/gif', ...ok }), 'keep', 'un GIF que entra conserva la animacion');
  assert.equal(uploadPlan({ mime: 'image/png', ...ok, width: 321 }), 'resize');
  assert.equal(uploadPlan({ mime: 'image/webp', ...ok, bytes: STICKER_LIMITS.bytes + 1 }), 'resize');
  assert.equal(uploadPlan({ mime: 'image/gif', ...ok, width: 321 }), 'gif_too_big');
  assert.equal(uploadPlan({ mime: 'image/gif', ...ok, bytes: STICKER_LIMITS.bytes + 1 }), 'gif_too_big');
});

test('traduce los errores del servidor a codigos estables', () => {
  const code = (e) => stickerError(e).code;
  assert.equal(code({ message: 'limit_reached' }), 'limit_reached');
  assert.equal(code({ message: 'name_taken' }), 'name_taken');
  assert.equal(code({ message: 'user_muted' }), 'user_muted');
  assert.equal(code({ message: 'user_banned' }), 'user_banned');
  assert.equal(code({ message: 'bad_type' }), 'type');
  assert.equal(code({ message: 'no_file' }), 'unavailable');
  assert.equal(code({ code: 'PGRST202', message: 'Could not find the function' }), 'unavailable');
  assert.equal(code({ message: 'Bucket not found' }), 'unavailable');
  assert.equal(code({ statusCode: 413, message: 'x' }), 'too_big');
  assert.equal(code({ message: 'new row violates row-level security policy' }), 'denied');
  assert.equal(code({ message: 'mime type image/svg+xml is not supported' }), 'type');
  assert.equal(code({ message: 'Failed to fetch' }), 'network');
  const mine = new StickerError('decode');
  assert.equal(stickerError(mine), mine);
});
