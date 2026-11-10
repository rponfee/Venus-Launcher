'use strict';
// Main-process texts for the in-game overlay (errors and its own alerts).
module.exports = {
  errOffline: 'The assistant needs an internet connection to answer. Check your connection and try again.',
  errBadEvent: 'The overlay notification is not valid ({field}).',
  serverOnlineTitle: 'Server ready',
  serverOnlineBody: '{name} is now open to play.',
  serverCrashedTitle: 'Your server shut down',
  serverCrashedBody: '{name} stopped because of an error.',
  playerJoinTitle: '{player} joined',
  playerJoinBody: 'Your server {name}.',
  taskDoneTitle: 'Task finished',
  taskFailedTitle: 'A task could not be completed',
  errBadPreset: 'That overlay layout does not exist.',
  errBadDnd: 'Choose how long Do Not Disturb should last.',
  dndOnTitle: 'Do Not Disturb on',
  dndOnBody: 'Alerts and messages stay hidden until you close the game.',
  dndOffTitle: 'Do Not Disturb off',
  dndEndedTitle: 'Do Not Disturb ended',
  dndEndedBody_one: '{count} alert or message arrived meanwhile.',
  dndEndedBody_other: '{count} alerts or messages arrived meanwhile.',
};
