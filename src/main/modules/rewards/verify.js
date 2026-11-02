'use strict';
// Verificar la cuenta de Minecraft para las invitaciones de Venus Points (sin Electron, se prueba con Node puro).
// Usa el mismo camino que la insignia (ingame/badge.js): desafío de un solo uso, "entrar" al servidor de sesiones
// de Mojang con la cuenta de Microsoft elegida y la Edge Function mcverify lo confirma con Mojang. El token de
// Minecraft va solo a Mojang; a Venus llegan el UUID, el nombre y el desafío.
//
// createVerifier({ badgeClient, getAccount, t, warn? }) -> { verify(), busy() }
//   verify() -> { uuid, name, rewarded } (rewarded: la invitación pendiente se pagó con esta verificación)
//   Errores: Error con mensaje traducido (t('rewards.err_<código>')) y err.code (ERROR_CODES).

const ERROR_CODES = [
  'noAccount', // no hay ninguna cuenta de Minecraft
  'offlineAccount', // la cuenta elegida es sin conexión
  'accountSession', // la sesión de la cuenta de Microsoft venció (hay que volver a entrar)
  'noCloud', // el launcher no trae el servidor de Venus
  'noSession', // sin sesión de Venus (o venció)
  'network',
  'unavailable', // falta la Edge Function o la migración
  'multiplayerDisabled', // cuenta sin multijugador (privacidad de Xbox o cuenta infantil)
  'mojangSession', // Mojang rechazó el token
  'mojang', // Mojang no respondió
  'notVerified', // Mojang no confirmó el desafío
  'tooManyAccounts',
  'banned',
  'rateLimited',
  'server',
];

// Códigos de core/accounts (getLaunchAccount) y de ingame/badge.js -> los de ERROR_CODES.
function mapCode(code) {
  if (code === 'refreshFailed') return 'network'; // no se pudo renovar el token por la red
  if (code === 'sessionExpired' || code === 'needsLogin') return 'accountSession';
  return ERROR_CODES.includes(code) ? code : 'server';
}

// Estos se guardan en la consola (detalle técnico) además del mensaje para el usuario.
const LOGGED = new Set(['network', 'unavailable', 'mojang', 'server']);

function createVerifier({ badgeClient, getAccount, t, warn = (...args) => console.warn(...args) }) {
  let running = null;

  function fail(code, cause, vars) {
    if (LOGGED.has(code) && cause) warn('[rewards] verificar cuenta de Minecraft:', cause.code || '', cause.message || cause);
    return Object.assign(new Error(t(`rewards.err_${code}`, vars)), { code });
  }

  async function run() {
    let account;
    try {
      account = await getAccount();
    } catch (err) {
      // Cualquier otro error de la cuenta (token vencido, Xbox rechazó la renovación...) se arregla volviendo a entrar.
      const code = err?.code === 'noAccount' ? 'noAccount' : err?.code === 'network' || err?.code === 'refreshFailed' ? 'network' : 'accountSession';
      throw fail(code, err);
    }
    if (!account) throw fail('noAccount');
    if (account.type !== 'msa') throw fail('offlineAccount', null, { name: account.name || '' });
    let res;
    try {
      res = await badgeClient().enroll(account, { fn: 'mcverify' });
    } catch (err) {
      throw fail(mapCode(err?.code), err, { name: account.name || '' });
    }
    if (!res || typeof res.uuid !== 'string') throw fail('server', new Error('respuesta sin uuid'));
    // Nunca devolver el token: solo lo que la interfaz muestra.
    return { uuid: res.uuid, name: account.name || '', rewarded: res.rewarded === true };
  }

  // Dos clics seguidos (o la página y otra ventana) comparten la misma verificación.
  function verify() {
    if (!running) running = run().finally(() => (running = null));
    return running;
  }

  return { verify, busy: () => Boolean(running) };
}

module.exports = { createVerifier, mapCode, ERROR_CODES };
