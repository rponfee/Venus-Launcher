'use strict';
// Smart search (main process): errors and task titles.
module.exports = {
  errEmptyQuery: 'Type what you want to search for.',
  errTooLong: 'The request is too long (400 characters max).',
  errModrinth: 'Could not connect to Modrinth: {error}',
  errCanceled: 'Search canceled',
  errInvalid: 'The request is not valid.',
  errBadAuthor: 'The author is not valid: Modrinth usernames have no spaces or symbols.',
  errNothingToInstall: 'There is nothing to install.',
  errTooMany: 'You can install up to {max} items at a time.',
  errNoInstance: 'The instance no longer exists.',
  errNoServer: 'The server no longer exists.',
  errVanillaServer: 'Vanilla servers do not support mods or plugins.',
  errNoWorld: 'Data packs need a world: pick one.',
  taskInstallKit: 'Installing the kit into {name}',
  taskInstallKitServer: 'Installing plugins on {name}',
  taskItem: '{title} ({index}/{total})',
  taskPrepare: 'Installing {name}',
  kitResult: '{ok} of {total} installed',
};
