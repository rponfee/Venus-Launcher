'use strict';
// Plataforma: qué funciones existen en cada sistema y los detalles de macOS, en un solo lugar. Sin Electron (se prueba
// con Node puro): cada función recibe platform/arch inyectables, como core/cipher.js o mcimport/running.js.
//   supports(funcion, platform?)   -> false si la función depende de una API de Windows (lista WINDOWS_ONLY)
//   capabilities(platform?)        -> { overlay: bool, ... } (la interfaz lo recibe en app:info.capabilities)
//   gameArch(resolved, host?)      -> arquitectura con la que corre el juego ('x64' en Apple Silicon si la versión no
//                                     trae nativos para arm64: va con el Java x64 y Rosetta 2)
//   rosettaInstalled(), stopProcess(), requestMediaAccess(), classpathSeparator(), keyLabel()
//   loginWindowModal(), isCloseWindowShortcut()   -> ventana de inicio de sesión de Microsoft (hoja en macOS)
const fs = require('fs');

// Funciones que dependen de una API de Windows. En macOS (y Linux) el módulo no arranca y la interfaz no las muestra
// o las marca como no disponibles. Todo lo que no figura acá funciona en todas las plataformas.
const WINDOWS_ONLY = Object.freeze({
  overlay: 'sigue la ventana del juego con Win32 (modules/overlay/tracker.js)',
  nowplaying: 'controles multimedia de Windows 10 y 11 (modules/nowplaying/script.js)',
  gameWindowBranding: 'ícono y título de la ventana del juego con PowerShell (modules/ingame/window.js)',
  windowsIntegration: 'accesos del escritorio y del menú Inicio (modules/windowsIntegration)',
  desktopShortcuts: 'accesos directos .lnk por instancia (modules/shortcuts.js)',
  capture: 'clips y capturas: la ventana del juego se busca con Win32 (modules/capture/window-find.js)',
  autoInstallUpdates: 'electron-updater solo instala versiones firmadas de Windows (modules/updater)',
  systemAudioShare: 'sonido del equipo al compartir pantalla (loopback de Windows)',
});

function supports(feature, platform = process.platform) {
  if (!Object.prototype.hasOwnProperty.call(WINDOWS_ONLY, feature)) return true;
  return platform === 'win32';
}

function capabilities(platform = process.platform) {
  const out = {};
  for (const feature of Object.keys(WINDOWS_ONLY)) out[feature] = supports(feature, platform);
  return out;
}

const isMac = (platform = process.platform) => platform === 'darwin';
const isAppleSilicon = ({ platform = process.platform, arch = process.arch } = {}) => platform === 'darwin' && arch === 'arm64';

// ---------- Minecraft en macOS ----------

const libName = (lib) => String(lib?.name || '');

// La versión trae nativos de LWJGL para Apple Silicon (LWJGL 3.3+, Minecraft 1.19 en adelante).
function hasArm64MacNatives(libraries) {
  return (libraries || []).some((lib) => {
    if (/:natives-macos-arm64$/.test(libName(lib))) return true;
    if (lib?.natives?.osx === 'natives-macos-arm64') return true;
    return Boolean(lib?.downloads?.classifiers?.['natives-macos-arm64']);
  });
}

// LWJGL 3 (Minecraft 1.13+). Con LWJGL 2 (1.12.2 y anteriores) -XstartOnFirstThread cuelga la ventana en macOS.
function usesLwjgl3(libraries) {
  return (libraries || []).some((lib) => /^org\.lwjgl:lwjgl:3\./.test(libName(lib)));
}

// Arquitectura del Java con el que se lanza el juego. En Apple Silicon, una versión sin nativos arm64 solo arranca con
// el Java x64 (traducido por Rosetta 2), igual que en el launcher oficial. En el resto, la del launcher.
function gameArch(resolved, { platform = process.platform, arch = process.arch } = {}) {
  if (isAppleSilicon({ platform, arch }) && !hasArm64MacNatives(resolved?.libraries)) return 'x64';
  return arch;
}

// Rosetta 2 instalado (solo tiene sentido en Apple Silicon). Lo mismo que revisa el instalador de Apple.
const ROSETTA_RUNTIME = '/Library/Apple/usr/libexec/oah/libRosettaRuntime';
function rosettaInstalled({ platform = process.platform, arch = process.arch, exists = fs.existsSync } = {}) {
  if (!isAppleSilicon({ platform, arch })) return true;
  try {
    return Boolean(exists(ROSETTA_RUNTIME));
  } catch {
    return false;
  }
}

// Un ejecutable x64 en una Mac con Apple Silicon sin Rosetta: "Bad CPU type in executable" (errno 86). En el texto
// solo cuenta "system error -86": el mensaje de spawn trae la ruta del ejecutable, que puede tener "-86" (C:\Users\x-86).
function isBadCpuType(err) {
  if (!err) return false;
  return err.errno === -86 || err.errno === 86 || err.code === 'EBADARCH' || /bad cpu type|EBADARCH|system error -86\b/i.test(String(err.message || ''));
}

function classpathSeparator(platform = process.platform) {
  return platform === 'win32' ? ';' : ':';
}

// ---------- Procesos ----------

/**
 * Cierra un proceso (el juego o un servidor) y sus hijos.
 *  - Windows: taskkill /T (con /F si force). Sin /F, Windows le pide a la ventana que se cierre (el juego guarda).
 *  - macOS/Linux: el juego se lanza con detached (grupo de procesos propio), así que la señal va al grupo: SIGTERM, y
 *    si force y sigue vivo a los graceMs, SIGKILL. Sin grupo (un proceso que no es líder), al proceso solo.
 * Devuelve true si se mandó la orden.
 */
function stopProcess({ pid, child = null, force = true, graceMs = 4000, platform = process.platform, spawnFn = null, killFn = process.kill.bind(process), setTimer = setTimeout } = {}) {
  const id = Number(pid || child?.pid);
  if (!Number.isInteger(id) || id <= 0) return false;
  if (platform === 'win32') {
    const spawn = spawnFn || require('child_process').spawn;
    try {
      const args = ['/pid', String(id), '/T', ...(force ? ['/F'] : [])];
      spawn('taskkill', args, { windowsHide: true, stdio: 'ignore' }).on?.('error', () => {});
      return true;
    } catch {
      return false;
    }
  }
  const signal = (sig) => {
    try {
      killFn(-id, sig); // todo el grupo
      return true;
    } catch {
      try {
        killFn(id, sig);
        return true;
      } catch {
        return false;
      }
    }
  };
  const sent = signal('SIGTERM');
  if (sent && force) {
    const alive = () => (child ? child.exitCode === null && child.signalCode === null : true);
    const timer = setTimer(() => {
      if (alive()) signal('SIGKILL');
    }, graceMs);
    timer?.unref?.();
  }
  return sent;
}

// ---------- Permisos de macOS ----------

// Micrófono (Voice Chat) en macOS: el sistema pide permiso una sola vez (texto de NSMicrophoneUsageDescription en el
// Info.plist). Devuelve true si se puede usar lo pedido. En Windows no hace nada.
// Una lista vacía es compartir pantalla (Electron solo pone 'audio'/'video' para micrófono y cámara): no pide nada acá,
// sigue al selector del sistema. Sin lista (undefined) se asume micrófono.
async function requestMediaAccess(mediaTypes, systemPreferences, platform = process.platform) {
  if (platform !== 'darwin' || !systemPreferences) return true;
  const kinds = new Set();
  for (const type of Array.isArray(mediaTypes) ? mediaTypes : ['audio']) {
    if (type === 'audio') kinds.add('microphone');
    else if (type === 'video') kinds.add('camera');
  }
  for (const kind of kinds) {
    let status = 'not-determined';
    try {
      status = systemPreferences.getMediaAccessStatus(kind);
    } catch {
      /* versiones viejas de macOS: se pregunta igual */
    }
    if (status === 'granted') continue;
    if (status === 'denied' || status === 'restricted') return false;
    try {
      if (!(await systemPreferences.askForMediaAccess(kind))) return false;
    } catch {
      return false;
    }
  }
  return true;
}

// ---------- Ventanas ----------

// Ventana de inicio de sesión de Microsoft: modal sobre la principal, salvo en macOS, donde una modal con padre es
// una hoja sin barra de título ni botón de cerrar (no se podría cancelar). Ahí va como ventana hija común.
function loginWindowModal(hasParent, platform = process.platform) {
  return Boolean(hasParent) && platform !== 'darwin';
}

// Cmd+W en macOS cierra la ventana de inicio de sesión (el menú de la app no trae "Cerrar"). En Windows no hace nada.
function isCloseWindowShortcut(input, platform = process.platform) {
  if (platform !== 'darwin' || !input || input.type !== 'keyDown') return false;
  return Boolean(input.meta) && !input.control && !input.alt && !input.shift && String(input.key || '').toLowerCase() === 'w';
}

// ---------- Teclas ----------

// "Ctrl+K" -> "⌘K" y "Ctrl+Shift+R" -> "⇧⌘R" en macOS (Cmd hace lo mismo que Ctrl en los atajos del launcher). Solo
// cambia atajos de una letra, número o Enter: "Ctrl izquierdo" o "Ctrl+Alt" (teclas físicas) quedan como están.
// Hay una copia para la interfaz en src/renderer/js/platform.js.
const CMD = String.fromCharCode(0x2318);
const SHIFT = String.fromCharCode(0x21e7);
function keyLabel(text, platform = process.platform) {
  if (platform !== 'darwin' || typeof text !== 'string') return text;
  return text.replace(/\bCtrl(\s?)\+\s?(?:(?:Shift|Mayús)\s?\+\s?)?(Enter\b|[A-Z0-9](?![\p{L}\p{N}]))/gu, (m, space, key) => {
    const shift = /Shift|Mayús/.test(m) ? SHIFT : '';
    return space ? `${shift}${CMD} + ${key}` : `${shift}${CMD}${key}`;
  });
}

module.exports = {
  WINDOWS_ONLY,
  supports,
  capabilities,
  isMac,
  isAppleSilicon,
  hasArm64MacNatives,
  usesLwjgl3,
  gameArch,
  rosettaInstalled,
  isBadCpuType,
  classpathSeparator,
  stopProcess,
  requestMediaAccess,
  loginWindowModal,
  isCloseWindowShortcut,
  keyLabel,
  ROSETTA_RUNTIME,
};
