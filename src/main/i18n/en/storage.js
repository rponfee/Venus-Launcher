'use strict';
// Main process strings: downloads (core/http.js) and storage (modules/storage).
module.exports = {
  // Downloads
  errCancelled: 'Cancelled by the user',
  errOffline: 'Offline mode is on: cannot connect to {host}. You can turn it off in the download settings.',
  errTimeout: '{host} stopped responding (no data for 30 s).',
  errNetwork: 'Could not connect to {host} ({error}).',
  errHttp: 'HTTP {status} at {url}',
  errHttpBody: 'HTTP {status} at {url}: {body}',
  errNoUrl: 'No download URL for {name}',
  errRange: 'The server did not allow resuming {name}; downloading it again.',
  errSize: 'Invalid size for {name}',
  errHash: 'Invalid {algo} hash for {name}',
  errSomeFailed_one: 'Could not download {count} file: {name} ({error})',
  errSomeFailed_other: 'Could not download {count} files. First: {name} ({error})',
  errBadJson: '{host} sent a response that could not be read. Try again in a moment.',
  errNoSpace: 'There is not enough disk space to save {name}. Free up some space and try again.',
  errDiskAccess: 'Could not save {name}: the file is in use or there is no permission to write it ({error}). Close the game or the antivirus using it and try again.',
  errDisk: 'Could not save {name} to disk ({error}).',

  // Storage
  errBusy: 'Another storage operation is already running. Wait for it to finish.',
  errTasksRunning: 'There are tasks in progress (installs or downloads). Wait for them to finish and try again.',
  errGameRunning: 'Close any running games and servers before deleting versions or Java.',
  errNothingChosen: 'Choose at least one category to clean.',
  taskDedupe: 'Merging duplicate files',
  taskScanning: 'Looking for duplicate files...',
  taskLinking: 'Replacing copies with links to the store...',
  taskClean: 'Freeing disk space',
  taskCleaning: 'Deleting what is no longer used...',
};
