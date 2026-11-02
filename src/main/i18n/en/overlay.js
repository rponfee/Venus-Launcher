'use strict';
// Main-process texts for the in-game overlay (errors and its own alerts).
module.exports = {
  errBadEvent: 'The overlay notification is not valid ({field}).',
  serverOnlineTitle: 'Server ready',
  serverOnlineBody: '{name} is now open to play.',
  serverCrashedTitle: 'Your server shut down',
  serverCrashedBody: '{name} stopped because of an error.',
  playerJoinTitle: '{player} joined',
  playerJoinBody: 'Your server {name}.',
  taskDoneTitle: 'Task finished',
  taskFailedTitle: 'A task could not be completed',
  // Streamer mode (modules/streamer.js): shown instead of names, messages and codes
  streamerFriend: 'A friend',
  streamerFriendN: 'Friend {n}',
  streamerYou: 'You',
  streamerMessage: 'Sent you a message',
  streamerRoom: 'Voice room',
  streamerFriendAlert: 'Friend notification',
  streamerOnTitle: 'Streamer mode on',
  streamerOnBody: 'No names, messages, codes or addresses on screen.',
  streamerOffTitle: 'Streamer mode off',
};
