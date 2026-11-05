// Cuidado del juego (antes "Herramientas y juego", 3.1). startup() lo llama app.js y arranca las funciones chicas
// alrededor del juego, cada una en su archivo:
//   features/playcare/mcnews.js    aviso de version nueva de Minecraft (evento mcnews:new del proceso principal)
//   features/playcare/breaks.js    recordatorio de descansos y tope de horas por dia (settings.play.breaks)
//   features/playcare/recap.js     resumen al cerrar el juego (settings.play.sessionRecap)
//   features/playcare/schedule.js  descargas programadas: aviso en el panel de tareas y schedulePanel() para Ajustes
// Cada pieza carga sola si las otras fallan. Textos en el namespace "playcare". Ya no hay pagina #/tools.
import { loadNs } from '../i18n.js';

const PARTS = [
  () => import('./playcare/mcnews.js'),
  () => import('./playcare/breaks.js'),
  () => import('./playcare/recap.js'),
  () => import('./playcare/schedule.js'),
];

let started = false;

export function startup() {
  if (started) return;
  started = true;
  loadNs('playcare').catch((err) => console.warn('[playcare] textos', err));
  for (const load of PARTS) {
    load()
      .then((m) => m.startup?.())
      .catch((err) => console.warn('[playcare]', err));
  }
}
