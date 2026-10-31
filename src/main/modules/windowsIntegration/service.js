'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { APP_ID, APP_NAME } = require('./branding');

const SHORTCUTS = ['desktop', 'startMenu'];
const emptyShortcut = () => ({ exists: false, valid: false, error: null });
const windowsPath = (value) => typeof value === 'string' && value
  ? path.win32.normalize(value).toLowerCase() : '';

function createWindowsIntegration({ app, shell, nativeImage, fileSystem = fs,
  platform = process.platform, portable = false, execPath = process.execPath,
  resourcesPath = process.resourcesPath }) {
  const reason = platform !== 'win32' ? 'platform' : !app.isPackaged ? 'development'
    : portable ? 'portable' : typeof shell?.writeShortcutLink !== 'function'
      || typeof shell?.readShortcutLink !== 'function' || typeof nativeImage?.createFromPath !== 'function'
      ? 'unavailable' : null;
  const icon = platform === 'win32' && resourcesPath ? path.win32.join(resourcesPath, 'venus.ico') : '';

  function location(name) {
    try {
      const base = app.getPath(name === 'desktop' ? 'desktop' : 'appData');
      if (typeof base !== 'string' || !path.win32.isAbsolute(base)) return null;
      return name === 'desktop' ? path.win32.join(base, `${APP_NAME}.lnk`)
        : path.win32.join(base, 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${APP_NAME}.lnk`);
    } catch { return null; }
  }

  function iconAvailable() {
    try {
      const stat = fileSystem.lstatSync(icon);
      if (!stat.isFile() || stat.isSymbolicLink()) return false;
      return !nativeImage.createFromPath(icon).isEmpty();
    } catch { return false; }
  }

  function inspect(file, hasIcon) {
    if (!file) return { ...emptyShortcut(), error: 'locationUnavailable' };
    let exists = false;
    try {
      const stat = fileSystem.lstatSync(file);
      exists = true;
      if (!stat.isFile() || stat.isSymbolicLink()) return { exists, valid: false, error: 'readFailed' };
      const shortcut = shell.readShortcutLink(file);
      const valid = hasIcon && windowsPath(shortcut.target) === windowsPath(execPath)
        && windowsPath(shortcut.icon) === windowsPath(icon) && Number(shortcut.iconIndex) === 0
        && shortcut.appUserModelId === APP_ID && !shortcut.args;
      return { exists, valid: Boolean(valid), error: null };
    } catch (error) {
      if (!exists && error?.code === 'ENOENT') return emptyShortcut();
      return { exists, valid: false, error: 'readFailed' };
    }
  }

  function status() {
    const result = {
      supported: !reason, reason,
      shortcuts: { desktop: emptyShortcut(), startMenu: emptyShortcut() },
      results: null,
    };
    if (reason) return result;
    const hasIcon = iconAvailable();
    for (const name of SHORTCUTS) result.shortcuts[name] = inspect(location(name), hasIcon);
    return result;
  }

  function repair() {
    if (reason) return status();
    const results = {};
    const hasIcon = iconAvailable();
    for (const name of SHORTCUTS) {
      const file = location(name);
      if (!file) { results[name] = { ok: false, error: 'locationUnavailable' }; continue; }
      if (!hasIcon) { results[name] = { ok: false, error: 'iconUnavailable' }; continue; }
      try {
        // Never follow a link or overwrite a directory masquerading as our .lnk.
        try {
          const stat = fileSystem.lstatSync(file);
          if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid shortcut file');
        } catch (error) { if (error?.code !== 'ENOENT') throw error; }
        fileSystem.mkdirSync(path.win32.dirname(file), { recursive: true });
        const written = shell.writeShortcutLink(file, 'create', {
          target: execPath,
          cwd: path.win32.dirname(execPath),
          args: '',
          description: APP_NAME,
          icon,
          iconIndex: 0,
          appUserModelId: APP_ID,
        });
        const checked = written && inspect(file, true).valid;
        results[name] = { ok: Boolean(checked), error: checked ? null : 'writeFailed' };
      } catch { results[name] = { ok: false, error: 'writeFailed' }; }
    }
    return { ...status(), results };
  }

  return { status, repair };
}

module.exports = { createWindowsIntegration };
