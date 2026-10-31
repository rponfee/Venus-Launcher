// Main-process strings for the modpack sharing module (manifests, diffs and applying revisions).
module.exports = {
  errModrinth: 'Could not reach Modrinth to identify the mods: {error}',
  errBadManifest: 'The shared modpack is damaged or invalid.',
  errNewerFormat: 'This modpack was shared with a newer version of Venus Launcher. Update the launcher to use it.',
  errTooLarge: 'The modpack is too big to share (too many configs). Turn off "Include configs" or move large files out of config/.',
  errGameRunning: 'Close the game before syncing this instance.',
  errBusyLaunch: 'The shared modpack of this instance is being updated. Wait for it to finish and play again.',

  taskApply: 'Syncing {name}',
  taskCreate: 'Creating {name}',
  stepCompare: 'Comparing with the shared modpack...',
  stepDownload_one: 'Downloading {count} file...',
  stepDownload_other: 'Downloading {count} files...',
  progressLabel: 'Mods',
  stepApply: 'Applying changes...',
  stepDone: 'Done',

  warnUnavailable: '{name} can no longer be downloaded: add it manually.',
  warnRemove: 'Could not remove {name}: {error}',
  warnToggle: 'Could not enable or disable {name}: {error}',
  warnConfig: 'Could not write {name}: {error}',
  warnPrepare: 'The mods are ready, but the game could not be installed yet ({error}). It will retry when you play.',
  errBadPath: 'The shared modpack has a file path that is not allowed.',
};
