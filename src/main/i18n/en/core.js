'use strict';
// Main-process core strings (ipc.js, main.js and core/game.js): errors, dialogs, tasks and log lines.
module.exports = {
  // Paths, links and encrypted store
  errPathNotAllowed: 'Path not allowed',
  errUrlNotAllowed: 'URL not allowed',
  errBadPath: 'Invalid path',
  errBadKey: 'Invalid key',

  // System dialogs
  selectFiles: 'Choose files',
  selectFolder: 'Choose folder',

  // Hardware
  gpuUnknown: 'Unknown',

  // Instances and content
  errCloseGameToDelete: 'Close the game before deleting the instance',
  taskAddOptifine: 'Adding OptiFine to {name}',
  taskInstallInto: 'Installing into {name}',
  taskModpack: 'Installing modpack',
  errNoModpack: 'No modpack was specified',

  // Game
  errAlreadyRunning: 'This instance is already running',
  errLaunchBlocked: 'Launch cancelled',
  logStarting: 'Starting {name} ({version}) with Java {java}',
  logMemoryMicrosoft: 'Memory: {min} MB - {max} MB · Account: {account} (Microsoft)',
  logMemoryOffline: 'Memory: {min} MB - {max} MB · Account: {account} (offline)',

  // Sign-in
  loginWindowTitle: 'Sign in with Microsoft',
};
