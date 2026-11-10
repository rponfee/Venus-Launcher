'use strict';
// Textos del proceso principal del overlay dentro del juego (errores y avisos propios).
module.exports = {
  errBadEvent: 'El aviso para el overlay no es válido ({field}).',
  errOffline: 'El asistente necesita internet para contestar. Revisá tu conexión y probá de nuevo.',
  serverOnlineTitle: 'Servidor listo',
  serverOnlineBody: '{name} ya está abierto para jugar.',
  serverCrashedTitle: 'Tu servidor se cerró',
  serverCrashedBody: '{name} se detuvo por un error.',
  playerJoinTitle: '{player} entró',
  playerJoinBody: 'A tu servidor {name}.',
  taskDoneTitle: 'Tarea terminada',
  taskFailedTitle: 'No se pudo completar una tarea',
  errBadPreset: 'Ese diseño del overlay no existe.',
  errBadDnd: 'Elegí cuánto tiempo dura «No molestar».',
  dndOnTitle: 'No molestar activado',
  dndOnBody: 'Los avisos y mensajes no se muestran hasta que cierres el juego.',
  dndOffTitle: 'No molestar desactivado',
  dndEndedTitle: 'Terminó «No molestar»',
  dndEndedBody_one: 'Mientras tanto llegó {count} aviso o mensaje.',
  dndEndedBody_other: 'Mientras tanto llegaron {count} avisos o mensajes.',
};
