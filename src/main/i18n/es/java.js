'use strict';
module.exports = {
  downloadLabel: 'Java {major}',
  preparing: 'Preparando Java {major}...',
  downloadingAdoptium: 'Descargando Java {major} (Adoptium)...',
  extracting: 'Extrayendo Java {major}...',
  errInstall: 'No se pudo instalar Java {major}: {error}',
  errNoAdoptium: 'Adoptium no publica Java {major} para este sistema',
  errNotFound: 'Se descargó Java {major}, pero no funciona en esta PC. Probá de nuevo o elegí un Java a mano en los ajustes de la instancia.',
  errOffline: 'Esta versión necesita Java {major} y todavía no está instalado. Conectate a internet para descargarlo (se hace una sola vez).',
  warnBroken: 'El Java elegido para esta instancia no responde ({path}). En los ajustes de la instancia, volvé a Java automático.',
  warnTooOld: 'Minecraft {mc} necesita Java {required} o más nuevo, pero esta instancia usa Java {current} (elegido a mano). No va a poder arrancar: en los ajustes de la instancia, volvé a Java automático.',
  warnLegacyModded: 'Minecraft {mc} con mods está pensado para Java 8, pero esta instancia usa Java {current}. Si no arranca, volvé a Java automático en los ajustes de la instancia.',
  spawnFailed: 'No se pudo iniciar Java: {error}',
};
