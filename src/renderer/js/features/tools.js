// Herramientas y juego (3.1). startup() lo llama app.js: registra la pagina #/tools (caja de herramientas: Nether,
// stacks, yunque, ticks, colores y chunks) en el menu y arranca las funciones chicas alrededor del juego:
//   features/tools/mcnews.js    aviso de version nueva de Minecraft (evento mcnews:new del proceso principal)
//   features/tools/breaks.js    recordatorio de descansos y tope de horas por dia (settings.play.breaks)
//   features/tools/recap.js     resumen al cerrar el juego (settings.play.sessionRecap)
//   features/tools/schedule.js  descargas programadas: aviso en el panel de tareas y schedulePanel() para Ajustes
// Cada pieza carga sola si las otras fallan. Textos en el namespace "tools".
import { registerPage } from '../app.js';
import { t, loadNs } from '../i18n.js';

const PARTS = [
  () => import('./tools/mcnews.js'),
  () => import('./tools/breaks.js'),
  () => import('./tools/recap.js'),
  () => import('./tools/schedule.js'),
];

let started = false;

export function startup() {
  if (started) return;
  started = true;
  loadNs('tools')
    .catch((err) => console.warn('[tools] textos', err))
    .then(() => registerPage('tools', () => import('../pages/tools.js'), { icon: 'wrench', label: () => t('tools.nav') }));
  for (const load of PARTS) {
    load()
      .then((m) => m.startup?.())
      .catch((err) => console.warn('[tools]', err));
  }
}
