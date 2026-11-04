// Tarjetas de Ajustes que suman otros módulos: registerSettingsCard('general', (ctx) => Element | null).
// La página de Ajustes las agrega al final de esa sección, en el orden en que se registraron. Así cada función
// suma su tarjeta desde su propio archivo, sin tocar pages/settings/*.js. Secciones: las de SECTIONS en pages/settings.js.
const cards = new Map();

export function registerSettingsCard(section, fn) {
  if (!cards.has(section)) cards.set(section, []);
  cards.get(section).push(fn);
}

export function settingsCards(section) {
  return cards.get(section) || [];
}
