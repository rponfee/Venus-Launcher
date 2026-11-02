'use strict';
// Textos del proceso principal del overlay dentro del juego (errores y avisos propios).
module.exports = {
  errBadEvent: 'El aviso para el overlay no es válido ({field}).',
  serverOnlineTitle: 'Servidor listo',
  serverOnlineBody: '{name} ya está abierto para jugar.',
  serverCrashedTitle: 'Tu servidor se cerró',
  serverCrashedBody: '{name} se detuvo por un error.',
  playerJoinTitle: '{player} entró',
  playerJoinBody: 'A tu servidor {name}.',
  taskDoneTitle: 'Tarea terminada',
  taskFailedTitle: 'No se pudo completar una tarea',
  // Modo streamer (modules/streamer.js): lo que se muestra en lugar de nombres, mensajes y códigos
  streamerFriend: 'Un amigo',
  streamerFriendN: 'Amigo {n}',
  streamerYou: 'Vos',
  streamerMessage: 'Te mandó un mensaje',
  streamerRoom: 'Sala de voz',
  streamerFriendAlert: 'Aviso de un amigo',
  streamerOnTitle: 'Modo streamer activado',
  streamerOnBody: 'Sin nombres, mensajes, códigos ni direcciones en pantalla.',
  streamerOffTitle: 'Modo streamer desactivado',
};
