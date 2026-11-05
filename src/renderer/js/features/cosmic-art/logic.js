// Preferencias locales del emblema: nunca incluyen XP, nivel ni premios.
export const PLANETS = Object.freeze(['venus', 'mars', 'neptune']);
export const FRAMES = Object.freeze(['orbit', 'halo', 'nova']);
export const DEFAULT_APPEARANCE = Object.freeze({ planet: 'venus', frame: 'orbit', accent: '#f6b45a', number: '#fff5df' });
const hex = (value, fallback) => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : fallback;

// El número se dibuja sobre una placa oscura fija (#100c0a), también sobre fondos claros.
export function readableNumber(value) {
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) return false;
  const luminance = (color) => [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16) / 255)
    .map((c) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
    .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
  return (luminance(value) + 0.05) / (luminance('#100c0a') + 0.05) >= 4.5;
}

export function normalizeAppearance(value) {
  const v = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const number = hex(v.number, DEFAULT_APPEARANCE.number);
  return {
    planet: PLANETS.includes(v.planet) ? v.planet : DEFAULT_APPEARANCE.planet,
    frame: FRAMES.includes(v.frame) ? v.frame : DEFAULT_APPEARANCE.frame,
    accent: hex(v.accent, DEFAULT_APPEARANCE.accent),
    number: readableNumber(number) ? number : DEFAULT_APPEARANCE.number,
  };
}
