'use strict';
// Puente minimo de la ventana del overlay (contextIsolation + sandbox). Solo recibe el layout y los eventos, y
// en el modo edicion avisa las posiciones nuevas. No hay invoke generico: la pagina no llega a ningun canal
// del launcher. El proceso principal ademas revisa que los mensajes vengan de esta ventana. Los paneles (recetas y
// asistente) tienen un unico canal, overlay:panel, con una lista cerrada de acciones (overlay/panels.js).
const { contextBridge, ipcRenderer } = require('electron');

const listen = (channel) => (cb) => {
  if (typeof cb !== 'function') return () => {};
  const fn = (e, data) => cb(data);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.removeListener(channel, fn);
};
const tell = (msg) => ipcRenderer.send('overlay:page', msg);

contextBridge.exposeInMainWorld('overlayBridge', {
  onLayout: listen('overlay:layout'),
  onEvent: listen('overlay:event'),
  ready: () => tell({ type: 'ready' }),
  // Modo edicion: id del widget y { anchor: 'tl'...'br' } o { anchor: 'free', x, y } (fracciones de 0 a 1)
  move: (id, pos) => tell({ type: 'move', id: String(id), pos: pos && typeof pos === 'object' ? { anchor: String(pos.anchor), x: Number(pos.x), y: Number(pos.y) } : null }),
  reset: () => tell({ type: 'reset' }),
  done: () => tell({ type: 'done' }),
  // Paneles: lo que pide la pagina se revisa en el proceso principal, y solo vale con un panel abierto
  onPanel: listen('overlay:panelMsg'),
  panel: (req) => ipcRenderer.invoke('overlay:panel', req && typeof req === 'object' ? { ...req } : null),
  closePanel: () => tell({ type: 'panelClose' }),
});
