// Pagina del overlay (renderer/overlay.html): recibe el layout y los eventos por su preload (window.overlayBridge,
// ver src/main/modules/overlay/preload.js) y los dibuja con OverlayView. No llega a ningun canal del launcher.
import { OverlayView } from './widgets.js';
import { createTranslator } from './i18n.js';
import { OverlayPanels } from './panels.js';
import { createSerial } from './logic.js';

const bridge = window.overlayBridge;
const root = document.getElementById('overlay');
const tr = createTranslator();
const motionQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

const view = new OverlayView(root, {
  tr: (k, v) => tr.t(k, v),
  isReduced: () => Boolean(motionQuery?.matches),
  onMove: (id, pos) => bridge?.move(id, pos),
  onTweak: (id, patch) => bridge?.tweak?.(id, patch),
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
// Layouts, eventos y mensajes de los paneles entran de a uno y en orden: los textos se cargan antes de dibujar. Si una
// tarea falla (un dato raro, un idioma que no carga) se avisa y la cola sigue: un error no puede dejar a la pagina sorda.
const report = (err) => console.warn('[overlay] pagina:', err?.message || err);
const serial = createSerial(report);
if (bridge) {
  bridge.onLayout((layout) =>
    serial(async () => {
      if (layout?.lang !== lang) {
        lang = layout?.lang || 'es';
        await tr.load(lang).catch(report);
        panels.reset(); // se vuelven a armar con los textos del idioma nuevo
      }
      view.setLayout(layout);
    }),
  );
  bridge.onEvent((ev) => serial(() => view.handle(ev)));
  // Un panel que tarda (leer los archivos del juego) no frena a los avisos: se lo deja andando sin esperarlo
  bridge.onPanel((msg) =>
    serial(() => {
      Promise.resolve(panels.handle(msg)).catch(report);
    }),
  );
  bridge.ready();
}
