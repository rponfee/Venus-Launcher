// Registra los packs de iconos del menu (px-<icono> y fi-<icono>) en ui.js y elige el nombre a dibujar segun
// settings.nav.iconPack. app.js lo importa al arrancar (asi el menu ya sale con el pack elegido) y el resto
// de la interfaz no cambia: solo el menu lateral pide sus iconos por aca.
import { registerIcons } from '../../ui.js';
import { packIconMap, packIconName } from './packs.js';

registerIcons(packIconMap());

// Iconos propios de la funcion (engranaje del menu, modo mini, asas del editor)
registerIcons({
  ncGrip: '<circle cx="9" cy="6" r="1" fill="currentColor"/><circle cx="15" cy="6" r="1" fill="currentColor"/><circle cx="9" cy="12" r="1" fill="currentColor"/><circle cx="15" cy="12" r="1" fill="currentColor"/><circle cx="9" cy="18" r="1" fill="currentColor"/><circle cx="15" cy="18" r="1" fill="currentColor"/>',
  ncUp: '<path d="m18 15-6-6-6 6"/>',
  ncDown: '<path d="m6 9 6 6 6-6"/>',
  ncPin: '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>',
  ncPinOff: '<path d="M12 17v5"/><path d="M15 9.34V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H7.89"/><path d="m2 2 20 20"/><path d="M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h11"/>',
  ncMini: '<rect x="3" y="3" width="18" height="18" rx="2"/><rect x="12" y="11" width="7" height="8" rx="1" fill="currentColor" stroke="none"/>',
  ncMiniOff: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 12h8"/><path d="M12 8v8"/>',
  ncWide: '<path d="M3 8V5a2 2 0 0 1 2-2h3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M21 16v3a2 2 0 0 1-2 2h-3"/><path d="M8 21H5a2 2 0 0 1-2-2v-3"/><path d="M8 12h8"/>',
  ncNarrow: '<path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/>',
});

// Nombre del icono del menu para el pack elegido ('outline' o desconocido: el de siempre)
export function navIconName(name, pack) {
  return packIconName(name, pack);
}
