'use strict';
// Modo de capturas (VENUS_DEVSHOT + VENUS_REWARDS_FAKE, nunca en la app empaquetada): la verificación de la cuenta
// de Minecraft responde sola, sin Mojang ni el servidor de Venus. VENUS_REWARDS_FAKE_VERIFY_ERROR=<código> la hace
// fallar con ese código (ver verify.js). Los datos de la página los inventa pages/rewards/fake.js en la interfaz.
const { mapCode } = require('./verify');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createFakeVerifier({ t, error = process.env.VENUS_REWARDS_FAKE_VERIFY_ERROR } = {}) {
  return {
    async verify() {
      await wait(1200);
      if (error) {
        const code = mapCode(error);
        throw Object.assign(new Error(t(`rewards.err_${code}`, { name: 'Steve' })), { code });
      }
      return { uuid: '853c80ef-3c37-49fd-aa49-938b674adae6', name: 'Steve', rewarded: true };
    },
    busy: () => false,
  };
}

module.exports = { createFakeVerifier };
