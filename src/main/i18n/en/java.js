'use strict';
module.exports = {
  downloadLabel: 'Java {major}',
  preparing: 'Preparing Java {major}...',
  downloadingAdoptium: 'Downloading Java {major} (Adoptium)...',
  extracting: 'Extracting Java {major}...',
  errInstall: 'Could not install Java {major}: {error}',
  errNoAdoptium: 'Adoptium does not publish Java {major} for this system',
  errNotFound: 'Java {major} was downloaded but does not run on this PC. Try again or pick a Java manually in the instance settings.',
  errOffline: 'This version needs Java {major}, which is not installed yet. Connect to the internet to download it (only needed once).',
  warnBroken: 'The Java chosen for this instance does not respond ({path}). In the instance settings, switch back to automatic Java.',
  warnTooOld: 'Minecraft {mc} needs Java {required} or newer, but this instance uses Java {current} (picked manually). It will not start: in the instance settings, switch back to automatic Java.',
  warnLegacyModded: 'Modded Minecraft {mc} is meant for Java 8, but this instance uses Java {current}. If it does not start, switch back to automatic Java in the instance settings.',
  spawnFailed: 'Could not start Java: {error}',
};
