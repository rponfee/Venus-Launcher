'use strict';
// Herramienta de desarrollo: recorre las paginas y guarda capturas + consola.
// Uso: VENUS_DEVSHOT=<carpeta> npx electron .   (opcional: VENUS_DEVSHOT_ROUTES=home,stats)
const fs = require('fs');
const path = require('path');

module.exports = function devshot(win, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  // VENUS_DEVSHOT_SIZE=1040x680: tamaño de la ventana para las capturas (sin ella, el de siempre: 1300x820)
  const size = /^(\d{3,4})x(\d{3,4})$/.exec(process.env.VENUS_DEVSHOT_SIZE || '');
  if (size) {
    const [w, hgt] = [Number(size[1]), Number(size[2])];
    win.setMinimumSize(Math.min(1040, w), Math.min(680, hgt));
    win.setContentSize(w, hgt);
  }
  const raw = process.env.VENUS_DEVSHOT_ROUTES || 'home,stats,versions,versions/new,modrinth,performance,servers,voice,messages,updates,settings';
  const routes = raw.includes(';;') ? raw.split(';;') : raw.split(',');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = [];
  win.webContents.on('console-message', (...args) => {
    const d = args[0] || {};
    const message = d.message ?? args[2];
    const level = d.level ?? args[1];
    const source = d.sourceId ?? args[4];
    const line = d.lineNumber ?? args[3];
    log.push(`[${level}] ${message} (${source}:${line})`);
  });
  win.webContents.once('did-finish-load', async () => {
    await wait(Number(process.env.VENUS_DEVSHOT_FIRST || 3000));
    for (const [i, r] of routes.entries()) {
      const cut = r.indexOf('|');
      const route = cut < 0 ? r : r.slice(0, cut);
      const js = cut < 0 ? null : r.slice(cut + 1);
      await win.webContents.executeJavaScript(`location.hash = '#/${route}'`);
      await wait(Number(process.env.VENUS_DEVSHOT_WAIT || 2500));
      if (js) {
        await win.webContents.executeJavaScript(js).catch((e) => log.push(`[js-error] ${e.message}`));
        await wait(1500);
      }
      const img = await win.webContents.capturePage();
      const name = `${String(i).padStart(2, '0')}-${route.replace(/[^\w.-]+/g, '_')}${js ? '_js' : ''}.png`;
      fs.writeFileSync(path.join(outDir, name), img.toPNG());
    }
    fs.writeFileSync(path.join(outDir, 'console.log'), log.join('\n'));
    if (!process.env.VENUS_DEVSHOT_KEEP) require('electron').app.quit();
  });
};
