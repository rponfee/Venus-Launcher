'use strict';

const path = require('node:path');

const APP_ID = 'com.venuslauncher.app';
const APP_NAME = 'Venus Launcher';

function loadImage(nativeImage, file) {
  try {
    const image = nativeImage.createFromPath(file);
    return image && !image.isEmpty() ? image : undefined;
  } catch { return undefined; }
}

// Windows shell properties need a real, stable icon file outside app.asar.
// An unavailable image must not prevent the launcher from opening.
function createWindowBranding({ app, nativeImage, platform = process.platform,
  resourcesPath = process.resourcesPath, execPath = process.execPath }) {
  const developmentIcon = path.resolve(__dirname, '../../../../build/icon.ico');
  const png = path.resolve(__dirname, '../../../renderer/assets/logo-256.png');
  if (platform !== 'win32') return { icon: loadImage(nativeImage, png), taskbarDetails: null };

  const ico = app.isPackaged ? (resourcesPath ? path.win32.join(resourcesPath, 'venus.ico') : '') : developmentIcon;
  const windowsIcon = loadImage(nativeImage, ico);
  const icon = windowsIcon || (!app.isPackaged ? loadImage(nativeImage, png) : undefined);
  const taskbarDetails = {
    appId: APP_ID,
    // The executable already embeds the Venus icon and is the Windows fallback.
    appIconPath: windowsIcon ? ico : execPath,
    appIconIndex: 0,
    relaunchDisplayName: APP_NAME,
  };
  if (app.isPackaged) taskbarDetails.relaunchCommand = `"${execPath}"`;
  return { icon, taskbarDetails };
}

function applyTaskbarBranding(window, branding) {
  if (!branding.taskbarDetails) return true;
  let applied = true;
  try { if (branding.icon) window.setIcon(branding.icon); }
  catch { applied = false; }
  try { window.setAppDetails(branding.taskbarDetails); }
  catch { applied = false; }
  return applied;
}

module.exports = { APP_ID, APP_NAME, createWindowBranding, applyTaskbarBranding };
