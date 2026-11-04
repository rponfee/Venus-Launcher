// Capas de Venus en el juego. El mod (mod/venus-badge) las dibuja; acá está lo que muestra el launcher: la vista previa plana
// de la textura, el aviso y el ajuste de la tienda (pages/rewards.js compra y equipa) y la capa puesta para el visor de
// skins. Reglas: supabase/migrations/0034_capas.sql · guía: docs/wip/capas-34.md.
import { h, icon, switchEl } from '../ui.js';
import { store } from '../store.js';
import { t } from '../i18n.js';
import { navigate } from '../app.js';
import { backend } from '../pages/rewards/backend.js';
import { loadImage, normalizeCape } from '../pages/skins/texture.js';
import { CAPE_IDS, capeIdOf } from './capes/logic.js';
import { CAPE_TEXTURES } from './capes/textures.js';

const C = (key, vars) => t(`capes.${key}`, vars);

// Nada que arrancar: todo se dibuja cuando se abre la tienda o el visor de skins.
export function startup() {}

/** Vista previa plana: la cara de afuera de la capa y las dos alas del elytra. null si no es una capa conocida. */
export function capeArt(item) {
  const id = capeIdOf(item);
  if (!id) return null;
  const image = { backgroundImage: `url("${CAPE_TEXTURES[id]}")` };
  return h(
    'div',
    { class: 'cp-art', 'aria-hidden': 'true' },
    h('span', { class: 'cp-tex cp-face', style: image }),
    h('span', { class: 'cp-wings', title: C('wingTitle') }, h('span', { class: 'cp-tex cp-wing', style: image }), h('span', { class: 'cp-tex cp-wing cp-wing-mirror', style: image })),
  );
}

/** Lo que hay que saber antes de comprar una capa y el interruptor de las capas ajenas (encabeza el grupo de la tienda). */
export function capesNotice(summary, { onVerify } = {}) {
  const hasMod = store.settings?.ingame?.badge === true;
  const showOthers = store.settings?.ingame?.capes !== false;
  const row = (text, action) => h('div', { class: 'notice info cp-notice' }, icon('info'), h('div', { class: 'spacer' }, text), action || null);
  return h(
    'div',
    { class: 'cp-head' },
    row(C('notice')),
    hasMod ? null : row(C('modNeeded'), h('button', { type: 'button', class: 'btn sm', onclick: () => navigate('settings/general') }, C('modGo'))),
    summary?.mcVerified ? null : row(C('verifyNeeded'), h('button', { type: 'button', class: 'btn sm', onclick: () => onVerify?.() }, C('verifyGo'))),
    h(
      'div',
      { class: 'cp-toggle' },
      h('div', { class: 'cp-toggle-text' }, h('strong', {}, C('showOthers')), h('span', {}, C('showOthersHint'))),
      switchEl(showOthers, (on) => store.setSettings({ ingame: { capes: on } }).catch((err) => console.warn('[capes] ajuste', err)), C('showOthers')),
    ),
  );
}

/** La capa de Venus puesta, como canvas para el visor de pages/skins, o null. Nunca falla: el visor sigue sin capa. */
export async function equippedCapeCanvas() {
  try {
    const b = await backend();
    if (!b.signedIn()) return null;
    const mine = await b.rpc('cape_mine');
    if (!mine?.active || !CAPE_IDS.includes(mine.cape)) return null;
    return normalizeCape(await loadImage(CAPE_TEXTURES[mine.cape]));
  } catch (err) {
    if (err?.code !== 'unavailable') console.warn('[capes] capa puesta', err?.code || err);
    return null;
  }
}
