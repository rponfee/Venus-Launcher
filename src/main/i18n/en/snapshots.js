// Main-process texts for snapshots (task titles and user-facing errors).
module.exports = {
  taskCreate: 'Saving a snapshot of {name}',
  taskRestore: 'Restoring {name}',
  stepScan: 'Checking files…',
  stepSaving: 'Saving {done} of {total}',
  stepSafety: 'Saving the current state just in case…',
  stepCompare: 'Comparing with the snapshot…',
  stepRestoring: 'Restoring {done} of {total}',

  errNoInstance: 'The instance does not exist or was deleted.',
  errNotFound: 'That snapshot no longer exists.',
  errRunning: 'Close the game before restoring a snapshot.',
  errRunningWorlds: 'Close the game to include worlds in the snapshot: the game is writing them.',
  errBadWorld: 'That world was not found in the instance.',
  errTooMany: 'There are too many files to save (more than {count}).',
  errNoSpace: 'There is not enough disk space to save the snapshot.',
  errDamaged: 'The file {file} in the snapshot is damaged. Your previous state was saved in the "Before restoring" snapshot.',
  errMissingObjects: 'Some files of this snapshot are missing from the store: it cannot be restored. Nothing was changed.',
  errLocked: 'Could not use {file}: another program has it open. Close it and try again.',
};
