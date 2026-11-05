// Fondos del chat y escenarios de voz incluidos: dibujados con CSS y SVG propios (styles/features/communityplans.css), originales y
// sin imágenes de terceros. Esta lista tiene que coincidir con la tabla community_presets de 0044_clanes_planes.sql (la prueba
// features/communities/test/plan.test.js lo comprueba contra la migración). El nombre de cada uno es communityplans.preset_<id>.
export const PRESETS = Object.freeze([
  { id: 'soft_grid', scope: 'chat', animated: false },
  { id: 'dunes', scope: 'chat', animated: false },
  { id: 'paper_dots', scope: 'chat', animated: false },
  { id: 'mesh', scope: 'chat', animated: false },
  { id: 'waves', scope: 'chat', animated: true },
  { id: 'drift', scope: 'chat', animated: true },
  { id: 'aurora', scope: 'stage', animated: true },
  { id: 'neon_city', scope: 'stage', animated: false },
  { id: 'campfire', scope: 'stage', animated: true },
  { id: 'starfield', scope: 'stage', animated: true },
  { id: 'sunset_bay', scope: 'stage', animated: false },
  { id: 'night_forest', scope: 'stage', animated: false },
]);

/** Los incluidos para un fondo de chat ('chat') o un escenario de voz ('stage'). */
export const presetsFor = (kind) => PRESETS.filter((p) => p.scope === kind);

/** Un incluido por id y tipo; null si no existe o es de otro tipo (nunca se arma una clase con texto ajeno). */
export const findPreset = (id, kind = null) => PRESETS.find((p) => p.id === id && (!kind || p.scope === kind)) || null;
