'use strict';
// Permisos del navegador: solo la página propia que pide acceso. Un marco incrustado no hereda los de su ventana.
const path = require('path');
const { fileURLToPath } = require('url');
function isAppPage(url, file) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'file:') return false;
    const actual = path.resolve(fileURLToPath(parsed));
    const expected = path.resolve(file);
    return process.platform === 'win32' ? actual.toLowerCase() === expected.toLowerCase() : actual === expected;
  } catch { return false; }
}
function isPermissionRequester(wc, details, file) {
  if (details?.isMainFrame === false) return false;
  const url = details?.requestingUrl || (details?.isMainFrame === true ? wc?.getURL?.() : '');
  return isAppPage(url, file);
}
module.exports = { isAppPage, isPermissionRequester };
