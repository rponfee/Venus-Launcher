'use strict';

const { createWindowsIntegration } = require('./windowsIntegration/service');

function register({ app, handle }) {
  const { shell, nativeImage } = require('electron');
  const service = createWindowsIntegration({
    app, shell, nativeImage,
    portable: Boolean(process.env.PORTABLE_EXECUTABLE_DIR || process.env.PORTABLE_EXECUTABLE_FILE),
  });
  const noArguments = (action) => (...args) => {
    if (args.length) {
      const error = new Error('Esta acción no acepta parámetros.');
      error.code = 'invalidArguments';
      throw error;
    }
    return action();
  };
  // No automatic repair on startup: writes require the explicit interface action.
  handle('windowsIntegration:status', noArguments(service.status));
  handle('windowsIntegration:repair', noArguments(service.repair));
}

module.exports = { register };
