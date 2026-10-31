'use strict';
// Textos del proceso principal del módulo discord (lo que se ve en el perfil de Discord y errores).
module.exports = {
  largeText: 'Venus Launcher {version}',
  inLauncher: 'En el launcher',
  idleState: 'Eligiendo a qué jugar',
  versionVanilla: 'Minecraft {version}',
  versionLoader: '{loader} {version}',
  detailsInstance: '{name} · {version}',
  statePreparing: 'Preparando el juego',
  stateStarting: 'Iniciando Minecraft',
  stateMenu: 'En el menú principal',
  stateWorld: 'Un jugador · {world}',
  stateSingleplayer: 'Jugando en un jugador',
  stateServer: 'Jugando en {address}',
  stateMultiplayer: 'Jugando en multijugador',
  testDetails: 'Probando Rich Presence',
  testState: 'Todo listo en Venus Launcher',

  errInvalidClient: "Discord no reconoce ese Application ID. Revisalo en el portal de desarrolladores.",
  errConnect: 'No se pudo conectar con Discord: {error}',
  errActivity: 'Discord rechazó la actividad: {error}',
  errDisabled: 'Activá Rich Presence primero.',
  errNoClientId: "Configurá el Application ID de Discord en Ajustes → Privacidad → Discord.",
  errNoDiscord: 'Discord no está abierto en esta PC. Abrí la app de escritorio de Discord y probá de nuevo.',
  errClientIdFormat: "El Application ID debe ser un texto de 17 a 21 dígitos, o vacío para usar el valor incluido. No pegues tokens.",
};
