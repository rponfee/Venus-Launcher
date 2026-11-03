// Tipografias extra del nombre (3.0): fuentes libres (OFL o Apache) incluidas en el launcher, sin bajar nada.
// De aca salen la lista que valida model.js (la misma que private.profile_fonts en el servidor), el selector del
// editor, las pilas de profile-style.js y el CSS generado (scripts/import-name-fonts.js -> profile-fonts.css).
// scale ajusta el tamaño: cada fuente tiene un alto y un ancho muy distintos y el nombre tiene que entrar igual.
export const FONT_GROUPS = ['basic', 'pixel', 'tech', 'display', 'script', 'elegant', 'rounded'];

export const EXTRA_FONTS = [
  { id: 'press', label: 'Press Start', pkg: 'press-start-2p', family: 'Press Start 2P', weight: 400, group: 'pixel', scale: 0.66 },
  { id: 'vt323', label: 'VT323', pkg: 'vt323', family: 'VT323', weight: 400, group: 'pixel', scale: 1.22 },
  { id: 'silkscreen', label: 'Silkscreen', pkg: 'silkscreen', family: 'Silkscreen', weight: 700, group: 'pixel', scale: 0.84 },
  { id: 'elite', label: 'Special Elite', pkg: 'special-elite', family: 'Special Elite', weight: 400, group: 'pixel', scale: 1 },
  { id: 'orbitron', label: 'Orbitron', pkg: 'orbitron', family: 'Orbitron', weight: 700, group: 'tech', scale: 0.88 },
  { id: 'audiowide', label: 'Audiowide', pkg: 'audiowide', family: 'Audiowide', weight: 400, group: 'tech', scale: 0.9 },
  { id: 'exo', label: 'Exo 2', pkg: 'exo-2', family: 'Exo 2', weight: 700, group: 'tech', scale: 1 },
  { id: 'blackops', label: 'Black Ops', pkg: 'black-ops-one', family: 'Black Ops One', weight: 400, group: 'tech', scale: 0.92 },
  { id: 'russo', label: 'Russo One', pkg: 'russo-one', family: 'Russo One', weight: 400, group: 'tech', scale: 0.94 },
  { id: 'bungee', label: 'Bungee', pkg: 'bungee', family: 'Bungee', weight: 400, group: 'display', scale: 0.84 },
  { id: 'righteous', label: 'Righteous', pkg: 'righteous', family: 'Righteous', weight: 400, group: 'display', scale: 1 },
  { id: 'bangers', label: 'Bangers', pkg: 'bangers', family: 'Bangers', weight: 400, group: 'display', scale: 1.08 },
  { id: 'creepster', label: 'Creepster', pkg: 'creepster', family: 'Creepster', weight: 400, group: 'display', scale: 1.08 },
  { id: 'monoton', label: 'Monoton', pkg: 'monoton', family: 'Monoton', weight: 400, group: 'display', scale: 0.86 },
  { id: 'anton', label: 'Anton', pkg: 'anton', family: 'Anton', weight: 400, group: 'display', scale: 1.02 },
  { id: 'bebas', label: 'Bebas Neue', pkg: 'bebas-neue', family: 'Bebas Neue', weight: 400, group: 'display', scale: 1.14 },
  { id: 'oswald', label: 'Oswald', pkg: 'oswald', family: 'Oswald', weight: 700, group: 'display', scale: 1 },
  { id: 'lobster', label: 'Lobster', pkg: 'lobster', family: 'Lobster', weight: 400, group: 'script', scale: 1.06 },
  { id: 'pacifico', label: 'Pacifico', pkg: 'pacifico', family: 'Pacifico', weight: 400, group: 'script', scale: 0.96 },
  { id: 'dancing', label: 'Dancing Script', pkg: 'dancing-script', family: 'Dancing Script', weight: 700, group: 'script', scale: 1.16 },
  { id: 'caveat', label: 'Caveat', pkg: 'caveat', family: 'Caveat', weight: 700, group: 'script', scale: 1.22 },
  { id: 'marker', label: 'Permanent Marker', pkg: 'permanent-marker', family: 'Permanent Marker', weight: 400, group: 'script', scale: 0.98 },
  { id: 'cinzel', label: 'Cinzel', pkg: 'cinzel', family: 'Cinzel', weight: 700, group: 'elegant', scale: 0.96 },
  { id: 'playfair', label: 'Playfair', pkg: 'playfair-display', family: 'Playfair Display', weight: 700, group: 'elegant', scale: 1.02 },
  { id: 'abril', label: 'Abril Fatface', pkg: 'abril-fatface', family: 'Abril Fatface', weight: 400, group: 'elegant', scale: 1.02 },
  { id: 'fredoka', label: 'Fredoka', pkg: 'fredoka', family: 'Fredoka', weight: 700, group: 'rounded', scale: 1 },
  { id: 'comfortaa', label: 'Comfortaa', pkg: 'comfortaa', family: 'Comfortaa', weight: 700, group: 'rounded', scale: 0.92 },
  { id: 'baloo', label: 'Baloo', pkg: 'baloo-2', family: 'Baloo 2', weight: 700, group: 'rounded', scale: 1.04 },
];

// Pila de cada fuente: si el nombre tiene letras que la fuente no trae (japones, coreano, chino...), sigue con la del launcher
export const fontStack = (f) => `'${f.family}', 'Outfit', system-ui, 'Segoe UI', sans-serif`;
