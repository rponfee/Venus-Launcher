// Pagina del overlay (renderer/overlay.html): recibe el layout y los eventos por su preload (window.overlayBridge,
// ver src/main/modules/overlay/preload.js) y los dibuja con OverlayView. No llega a ningun canal del launcher.
import { OverlayView } from './widgets.js';
import { createTranslator } from './i18n.js';
import { OverlayPanels } from './panels.js';

const bridge = window.overlayBridge;
const root = document.getElementById('overlay');
const tr = createTranslator();
const motionQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

const view = new OverlayView(root, {
  tr: (k, v) => tr.t(k, v),
  isReduced: () => Boolean(motionQuery?.matches),
  onMove: (id, pos) => bridge?.move(id, pos),
  onReset: () => bridge?.reset(),
  onDone: () => bridge?.done(),
});

// Paneles (recetas y asistente): van encima de los widgets y solo se ven con su atajo.
const panels = new OverlayPanels(root, {
  tr: (k, v) => tr.t(k, v),
  bridge,
  showAlert: (ev) => view.handle(ev),
  loadAssistantTexts: () => tr.loadAssistant(),
});

let lang = null;
let pending = Promise.resolve();
if (bridge) {
  bridge.onLayout((layout) => {
    // Los textos se cargan antes de dibujar; los layouts que llegan mientras tanto esperan su turno.
    pending = pending.then(async () => {
      if (layout?.lang !== lang) {
        lang = layout?.lang || 'es';
        await tr.load(lang);
        panels.reset(); // se vuelven a armar con los textos del idioma nuevo
      }
      view.setLayout(layout);
    });
  });
  bridge.onEvent((ev) => pending.then(() => view.handle(ev)));
  bridge.onPanel((msg) => pending.then(() => panels.handle(msg)));
  bridge.ready();
}
