'use strict';
// Preload minimo de la grabadora oculta (src/renderer/recorder.html): solo recibe ordenes del proceso principal y
// le devuelve mensajes por un unico canal. No expone nada mas (ni archivos, ni ajustes, ni otros canales).
const { contextBridge, ipcRenderer } = require('electron');

const CMD = 'capture:recorderCmd';
const MSG = 'capture:recorderMsg';

contextBridge.exposeInMainWorld('venusRecorder', {
  // fn(orden) para cada orden del proceso principal
  onCommand(fn) {
    if (typeof fn !== 'function') return;
    ipcRenderer.on(CMD, (_e, cmd) => fn(cmd));
  },
  // Mensaje al proceso principal ({ type, ... }; los pedazos de video van como Uint8Array)
  send(msg) {
    ipcRenderer.send(MSG, msg);
  },
});
