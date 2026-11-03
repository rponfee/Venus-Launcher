'use strict';
// Cifrado de tokens y claves con el almacén del sistema (safeStorage: DPAPI en Windows, Keychain en macOS y
// libsecret o KWallet en Linux). Lo usan core/accounts.js y core/secure.js.
//
// Un secreto nunca se escribe sin cifrar: si el sistema no tiene almacén seguro, queda solo en memoria hasta cerrar
// el launcher (en el archivo va "mem:<id>") y la próxima vez hay que volver a iniciar sesión.
// Los valores "raw:" (base64 sin cifrar) de versiones viejas se siguen leyendo y desaparecen al volver a guardarlos.
const crypto = require('crypto');

const NO_STORAGE = { isEncryptionAvailable: () => false };

function createCipher(safeStorage = NO_STORAGE, platform = process.platform) {
  const session = new Map();
  const available = () => {
    if (!safeStorage.isEncryptionAvailable()) return false;
    // En Linux sin llavero, "basic_text" cifra con una contraseña fija: es lo mismo que no cifrar.
    return platform !== 'linux' || safeStorage.getSelectedStorageBackend?.() !== 'basic_text';
  };
  return {
    encrypt(s) {
      if (available()) return `enc:${safeStorage.encryptString(s).toString('base64')}`;
      const id = crypto.randomUUID();
      session.set(id, s);
      return `mem:${id}`;
    },
    decrypt(s) {
      if (!s) return '';
      if (s.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(s.slice(4), 'base64'));
      if (s.startsWith('mem:')) return session.get(s.slice(4)) ?? '';
      if (s.startsWith('raw:')) return Buffer.from(s.slice(4), 'base64').toString();
      return s;
    },
  };
}

module.exports = { createCipher };
