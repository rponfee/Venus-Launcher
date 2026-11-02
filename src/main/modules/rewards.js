'use strict';
// Venus Points (docs/venus-points.md): el proceso principal solo verifica la cuenta de Minecraft para que las
// invitaciones paguen. Puntos, logros, tienda e invitaciones van directo de la interfaz a Supabase (0021_puntos).
//
// Canales:
//   rewards:verifyMinecraft() -> { uuid, name, rewarded }   con la cuenta de Microsoft elegida (core/accounts)
//                                errores con err.code: ver rewards/verify.js (ERROR_CODES)
//   rewards:fakeMode()        -> null, o el escenario de capturas (VENUS_DEVSHOT + VENUS_REWARDS_FAKE, sin empaquetar):
//                                'demo', 'premium', 'new', 'signedOut' o 'unavailable'
const { t } = require('../core/i18n');
const { createVerifier } = require('./rewards/verify');

const FAKE_STATES = ['demo', 'premium', 'new', 'signedOut', 'unavailable'];
let verifier = null;

function fakeMode() {
  const raw = process.env.VENUS_REWARDS_FAKE;
  if (!process.env.VENUS_DEVSHOT || !raw) return null;
  try {
    if (require('electron').app.isPackaged) return null;
  } catch {
    return null;
  }
  return FAKE_STATES.includes(raw) ? raw : 'demo';
}

function getVerifier() {
  if (verifier) return verifier;
  if (fakeMode()) {
    verifier = require('./rewards/fake').createFakeVerifier({ t });
    console.warn('[rewards] Modo de capturas (VENUS_REWARDS_FAKE): verificación de ejemplo, sin Mojang ni servidor.');
    return verifier;
  }
  verifier = createVerifier({
    badgeClient: () => require('./ingame').badgeClient(),
    getAccount: () => require('../core/accounts').getLaunchAccount(),
    t,
  });
  return verifier;
}

// Para otros módulos del proceso principal (por ejemplo, el overlay).
const verifyMinecraft = () => getVerifier().verify();

function register({ handle }) {
  handle('rewards:verifyMinecraft', () => verifyMinecraft());
  handle('rewards:fakeMode', () => fakeMode());
}

module.exports = { register, verifyMinecraft };
