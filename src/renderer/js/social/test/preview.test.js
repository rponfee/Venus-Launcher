import test from 'node:test';
import assert from 'node:assert/strict';
import { messagePreview } from '../preview.js';
const base = 'https://example.supabase.co';
const sender = '11111111-1111-4111-8111-111111111111';
const sticker = base + '/storage/v1/object/public/stickers/' + sender + '/22222222-2222-4222-8222-222222222222.png';
const labels = { sticker: 'Sticker', gif: 'GIF' };
test('los avisos de stickers usan una etiqueta y el texto normal se conserva', () => {
  assert.equal(messagePreview(sticker, sender, base, labels), 'Sticker');
  assert.equal(messagePreview('Hola', sender, base, labels), 'Hola');
  assert.equal(messagePreview('https://example.com/image.png', sender, base, labels), 'https://example.com/image.png');
  assert.equal(messagePreview(sticker, 'other', base, labels), sticker);
});
