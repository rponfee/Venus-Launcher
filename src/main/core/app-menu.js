'use strict';
// Menú de la aplicación en macOS. La ventana del launcher no tiene marco (usa su propia barra de título, igual que en
// Windows), pero macOS necesita un menú: sin él no andan Cmd+C/V/X/A/Z en los campos de texto ni Cmd+Q. Es mínimo a
// propósito: Cmd+K, Cmd+J y Cmd+M quedan para los atajos del launcher (por eso "Minimizar" va sin atajo y no hay menú
// Ver con Cmd+R). En Windows y Linux no se toca el menú.
//   menuTemplate({ appName, t }) -> plantilla para Menu.buildFromTemplate (sin Electron: se prueba con Node puro)
//   install({ Menu, getWindow, t, appName, platform }) -> true si puso el menú
function menuTemplate({ appName = 'Venus Launcher', t = (k) => k, minimize = null } = {}) {
  const l = (key, vars) => t(`macos.${key}`, vars);
  return [
    {
      label: appName,
      submenu: [
        { role: 'about', label: l('menuAbout', { app: appName }) },
        { type: 'separator' },
        { role: 'hide', label: l('menuHide', { app: appName }) },
        { role: 'hideOthers', label: l('menuHideOthers') },
        { role: 'unhide', label: l('menuShowAll') },
        { type: 'separator' },
        { role: 'quit', label: l('menuQuit', { app: appName }) },
      ],
    },
    {
      label: l('menuEdit'),
      submenu: [
        { role: 'undo', label: l('menuUndo') },
        { role: 'redo', label: l('menuRedo') },
        { type: 'separator' },
        { role: 'cut', label: l('menuCut') },
        { role: 'copy', label: l('menuCopy') },
        { role: 'paste', label: l('menuPaste') },
        { role: 'pasteAndMatchStyle', label: l('menuPasteMatch') },
        { role: 'delete', label: l('menuDelete') },
        { role: 'selectAll', label: l('menuSelectAll') },
      ],
    },
    {
      label: l('menuWindow'),
      submenu: [
        { label: l('menuMinimize'), click: () => minimize?.() },
        { role: 'zoom', label: l('menuZoom') },
        { type: 'separator' },
        { role: 'front', label: l('menuFront') },
      ],
    },
  ];
}

function install({ Menu, getWindow = () => null, t, appName, platform = process.platform } = {}) {
  if (platform !== 'darwin' || !Menu) return false;
  const minimize = () => {
    const w = getWindow();
    if (w && !w.isDestroyed()) w.minimize();
  };
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate({ appName, t, minimize })));
  return true;
}

module.exports = { menuTemplate, install };
