'use strict';
// Unico lugar donde se decide si el overlay del juego existe en esta plataforma. El seguimiento de la ventana del juego
// usa la API de Win32 (tracker.js), asi que hoy es solo Windows. Lo usan modules/overlay.js (overlay:status.supported,
// que lee la interfaz: Ajustes y la bienvenida esconden lo que no se puede usar) y cualquier otro modulo que lo necesite
// (por ejemplo, el puerto a macOS). Sin Electron: se puede llamar desde las pruebas.
//   available()          -> true en Windows
//   available('darwin')  -> false (para probar otra plataforma)
function available(platform = process.platform) {
  return platform === 'win32';
}

module.exports = { available };
