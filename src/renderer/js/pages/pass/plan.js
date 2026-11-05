// Venus Pass (4.6): el plan de premios, en un solo lugar. El Pase se gana solo jugando: una pista de 380 niveles, 60 XP
// por nivel (1 XP por minuto jugado, hasta 120 por día). De acá salen los premios que carga la migración
// (supabase/migrations/0041_venus_pass_tiempo.sql, generada con scripts/gen-pass-rewards-sql.js) y los de las capturas
// (pages/pass/fake.js). Para cambiar un premio se edita este archivo, se corre el script y se actualiza la prueba;
// una vez publicado, los cambios se hacen desde Administración > Venus Pass (no hace falta otra migración).
// Lógica pura, sin DOM: la importa node:test y el script de generación.

export const SEASON_ID = 'venus-pass';
export const LEVELS = 380;
export const XP_PER_LEVEL = 60; // 60 minutos de juego por nivel: 380 horas en total
export const PLAY_CAP = 120; // minutos por día que dan XP (el servidor tiene el mismo tope)
export const PREMIUM_BONUS = 0.2; // Venus Premium: +20 % de XP por los minutos jugados con Premium
export const TRACK = 'free'; // la única pista (la columna `track` de 0026 se conserva; nada usa 'premium')

// Marcos del pase: los ítems nuevos que carga la migración (los dibuja social/frames.js).
export const FRAME_LEVELS = [25, 60, 100, 150, 200, 260, 320, 380];
export const FRAME_ITEMS = FRAME_LEVELS.map((level, i) => ({ id: `pass_frame_${i + 1}`, kind: 'frame', sort: 310 + i, style: `pass${i + 1}`, level }));

// Títulos y efectos de nombre en niveles clave. Los `pass_s1_*` son cosméticos propios del pase (0026, ya cargados); el
// resto son ítems de la tienda (0021/0023) que acá se ganan jugando. Un nivel con cosmético no da puntos.
export const TITLE_LEVELS = { 10: 'pass_s1_free_title', 35: 'title_explorer', 85: 'pass_s1_title', 125: 'title_collector', 175: 'title_hardcore', 230: 'title_veteran', 340: 'title_legend' };
export const EFFECT_LEVELS = { 45: 'effect_shimmer', 110: 'effect_ocean', 165: 'pass_s1_effect', 215: 'effect_gold', 280: 'effect_galaxy', 350: 'effect_glitch' };

/** Venus Points de un nivel sin cosmético: 10 al principio y +2 cada 50 niveles (hasta 24); los múltiplos de 10 valen el triple. */
export function pointsFor(level) {
  const base = 10 + 2 * Math.floor((level - 1) / 50);
  return level % 10 === 0 ? base * 3 : base;
}

/** El cosmético que da un nivel (id de shop_items) o null. */
export function itemAt(level) {
  const frame = FRAME_ITEMS.find((f) => f.level === level);
  return frame ? frame.id : TITLE_LEVELS[level] || EFFECT_LEVELS[level] || null;
}

/** Todos los premios del 1 al último nivel: [{ level, kind: 'points', amount } | { level, kind: 'item', itemId }]. */
export function buildRewards(levels = LEVELS) {
  const out = [];
  for (let level = 1; level <= levels; level++) {
    const itemId = itemAt(level);
    out.push(itemId ? { level, kind: 'item', itemId } : { level, kind: 'points', amount: pointsFor(level) });
  }
  return out;
}

/** Ids de los cosméticos que reparte el plan, sin repetir. */
export const planItemIds = () => [...new Set(buildRewards().filter((r) => r.kind === 'item').map((r) => r.itemId))];
