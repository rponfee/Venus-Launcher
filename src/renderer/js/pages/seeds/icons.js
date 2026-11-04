// Iconos y colores de las estructuras: el mismo trazo (24x24) sirve para el mapa (Path2D) y para la interfaz
// (registerIcons). Dibujos propios del launcher. El color es un dato del mapa, como el de los biomas.
import { registerIcons } from '../../ui.js';

export const STRUCT_STYLE = {
  village: { color: '#b4532a', d: 'M3 11 12 3l9 8M5 9.5V20h14V9.5M10 20v-6h4v6' },
  desert_pyramid: { color: '#c08512', d: 'M12 4 22 20H2ZM12 4 9 20M12 4l3 16' },
  jungle_temple: { color: '#3f7d20', d: 'M3 20h18M5 20v-4h14v4M7 16v-4h10v4M9 12V8h6v4' },
  swamp_hut: { color: '#2a7f68', d: 'M4 12l8-7 8 7M6 10.5V17h12v-6.5M8 17v4M16 17v4' },
  igloo: { color: '#4a86b8', d: 'M3 19a9 9 0 0 1 18 0ZM9 19v-3a3 3 0 0 1 6 0v3' },
  monument: { color: '#1f6f9c', d: 'M8 6l4-3 4 3M4 9h16M6 9v8M12 9v8M18 9v8M3 20c2-1.5 3-1.5 5 0s3 1.5 5 0 3-1.5 5 0 2 1 3 .5' },
  mansion: { color: '#6b4a2b', d: 'M3 21V9l4-3v3l5-5 5 5V6l4 3v12ZM10 21v-5h4v5' },
  outpost: { color: '#7a3b3b', d: 'M9 21V9h6v12M7 9V5h2v2h2V5h2v2h2V5h2v4ZM6 21h12' },
  ancient_city: { color: '#176b78', d: 'M12 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM12 5a7 7 0 0 1 7 7M5 12a7 7 0 0 1 7-7M5 12a7 7 0 0 0 7 7M19 12a7 7 0 0 1-7 7' },
  trail_ruins: { color: '#8a6d3b', d: 'M4 21V9a8 8 0 0 1 8-7M20 21v-8M2 21h20M12 2l-1 4 2 2-1 4' },
  trial_chambers: { color: '#a8622c', d: 'M4 4h16v16H4ZM4 12h16M12 4v16' },
  stronghold: { color: '#5a3d9a', d: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7ZM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z' },
  fortress: { color: '#7c2d2d', d: 'M4 21V8h4v3h3V8h2v3h3V8h4v13ZM10 21v-5h4v5' },
  bastion: { color: '#4a4048', d: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6ZM9 10h.01M15 10h.01M9 15h6' },
  spawn: { color: '#c2410c', d: 'M4 22V4a1 1 0 0 1 .4-.8A6 6 0 0 1 8 2c3 0 5 2 7.3 2q2 0 3.1-.8A1 1 0 0 1 20 4v10a1 1 0 0 1-.4.8A6 6 0 0 1 16 16c-3 0-5-2-8-2a6 6 0 0 0-4 1.5' },
};

registerIcons(Object.fromEntries(Object.entries(STRUCT_STYLE).map(([k, v]) => [`sd-${k}`, `<path d="${v.d}"/>`])));

// Sprite de un tipo: circulo de su color con el dibujo en blanco. `size` en pixeles de canvas
export function structSprite(type, size) {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const g = c.getContext('2d');
  const style = STRUCT_STYLE[type];
  const r = size / 2;
  g.beginPath();
  g.arc(r, r, r - 1, 0, Math.PI * 2);
  g.fillStyle = style.color;
  g.fill();
  g.lineWidth = Math.max(1, size / 16);
  g.strokeStyle = 'rgba(255,255,255,0.85)';
  g.stroke();
  const inner = size * 0.62;
  g.translate((size - inner) / 2, (size - inner) / 2);
  g.scale(inner / 24, inner / 24);
  g.strokeStyle = '#fff';
  g.lineWidth = 2.2;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.stroke(new Path2D(style.d));
  return c;
}
