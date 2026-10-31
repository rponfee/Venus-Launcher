'use strict';
// Main process texts for the discord module (what shows on the Discord profile and errors).
module.exports = {
  largeText: 'Venus Launcher {version}',
  inLauncher: 'In the launcher',
  idleState: 'Choosing what to play',
  versionVanilla: 'Minecraft {version}',
  versionLoader: '{loader} {version}',
  detailsInstance: '{name} · {version}',
  statePreparing: 'Getting the game ready',
  stateStarting: 'Starting Minecraft',
  stateMenu: 'In the main menu',
  stateWorld: 'Singleplayer · {world}',
  stateSingleplayer: 'Playing singleplayer',
  stateServer: 'Playing on {address}',
  stateMultiplayer: 'Playing multiplayer',
  testDetails: 'Testing Rich Presence',
  testState: 'All set in Venus Launcher',

  errInvalidClient: "Discord does not recognize that Application ID. Check it in the Developer Portal.",
  errConnect: 'Could not connect to Discord: {error}',
  errActivity: 'Discord rejected the activity: {error}',
  errDisabled: 'Enable Rich Presence first.',
  errNoClientId: "Configure the Discord Application ID in Settings → Privacy → Discord.",
  errNoDiscord: 'Discord is not open on this PC. Open the Discord desktop app and try again.',
  errClientIdFormat: "The Application ID must be a 17 to 21 digit string, or empty to use the bundled value. Do not paste tokens.",
};
