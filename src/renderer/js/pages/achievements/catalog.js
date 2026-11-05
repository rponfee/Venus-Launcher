// Catalogo de logros de Venus (3.0). Logica pura, sin DOM ni imports: la usan la pagina de Logros, features/achievements.js,
// la vitrina del perfil y scripts/gen-achievements-sql.js, que arma la migracion con las filas de public.achievements.
// No hay tope: para sumar logros se agrega una escalera (o un paso) aca y se corre el script. Los ids nunca cambian.
//
// Desde la 4.6 los logros son SOLO de Venus: se calculan con datos del launcher (instalar, instancias, mods, capturas,
// horas y rachas que mide el propio launcher) o de la cuenta de Venus (perfil, amigos, mensajes, puntos). Nada sale de
// lo que pasa dentro del juego (estadisticas de los mundos, logros de Minecraft). Los que lo hacian se desactivaron en
// 0043_logros_venus.sql (active = false): sus desbloqueos y puntos ya dados quedan como estaban.
//
// Una escalera son varios pasos de una misma medida: "Coleccionista" I, II, III... Cada paso es un logro con su nivel
// (bronce a netherita, segun el lugar que ocupa en la escalera), sus puntos y su id `<familia>_<objetivo>`.
//   kind 'client': lo comprueba esta PC (sale de stats:report y achievements:localCounts); pocos puntos.
//   kind 'server': lo comprueba el servidor con la medida del mismo nombre (private.achievement_metric, 0023 y 0043).

export const TIERS = ['bronze', 'silver', 'gold', 'diamond', 'netherite'];
export const GROUPS = ['time', 'collection', 'capture', 'social', 'venus', 'special'];

const POINTS = {
  client: { bronze: 5, silver: 10, gold: 25, diamond: 50, netherite: 100 },
  server: { bronze: 15, silver: 30, gold: 60, diamond: 120, netherite: 250 },
};

// family, grupo, icono, medida, pasos, { kind, ids: { paso: 'id viejo' }, points: { paso: puntos }, tiers: [nivel de cada paso] }
const LADDERS = [
  // Tiempo (lo mide el launcher: cuanto tiempo y cuantos dias tuviste el juego abierto)
  ['playtime', 'time', 'clock', 'hours', [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000], { ids: { 10: 'playtime_10h', 100: 'playtime_100h' }, points: { 10: 100, 100: 400 } }],
  ['sessions', 'time', 'play', 'sessions', [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000], { ids: { 1: 'first_launch' }, points: { 1: 50 } }],
  ['streak', 'time', 'flame', 'bestStreak', [3, 7, 14, 30, 60, 100, 180, 365]],
  ['marathon', 'time', 'zap', 'longestHours', [2, 3, 4, 6, 8, 12]],
  ['days', 'time', 'calendar', 'daysPlayed', [5, 10, 25, 50, 100, 200, 365, 500]],
  // Coleccion (lo que hay en el launcher: instancias, mods, shaders, resource packs y servidores propios)
  ['instances', 'collection', 'layers', 'instances', [1, 3, 5, 10, 25, 50, 100], { ids: { 5: 'instances_5' }, points: { 5: 50 } }],
  ['rotation', 'collection', 'layers', 'instancesPlayed', [2, 3, 5, 10, 20]],
  ['versions', 'collection', 'history', 'versions', [2, 5, 10, 20, 40, 80]],
  ['loaders', 'collection', 'puzzle', 'loaders', [2, 3, 5, 7, 9]],
  ['mods', 'collection', 'package', 'mods', [1, 10, 50, 100, 250, 500, 1000, 2500]],
  ['shaders', 'collection', 'sparkles', 'shaders', [1, 5, 10, 25]],
  ['packs', 'collection', 'image', 'resourcepacks', [1, 5, 10, 25]],
  ['localservers', 'collection', 'server', 'localServers', [1, 3, 5, 10, 25]],
  // Capturas (la galeria del launcher)
  ['screenshots', 'capture', 'image', 'screenshots', [1, 10, 50, 100, 500, 1000, 5000], { ids: { 1: 'first_screenshot' }, points: { 1: 25 } }],
  ['clips', 'capture', 'camera', 'clips', [1, 5, 10, 25, 50, 100, 500], { ids: { 1: 'first_clip' }, points: { 1: 50 } }],
  // Social (los comprueba el servidor)
  ['friends', 'social', 'users', 'friends', [1, 5, 10, 25, 50, 100], { kind: 'server', ids: { 1: 'first_friend', 5: 'five_friends' }, points: { 1: 50, 5: 150 } }],
  ['referrals', 'social', 'heart', 'referrals', [1, 5, 10, 25, 50, 100], { kind: 'server', ids: { 1: 'first_referral', 5: 'five_referrals' }, points: { 1: 200, 5: 1000 } }],
  ['messages', 'social', 'message', 'messages', [10, 100, 500, 1000, 5000, 10000, 50000], { kind: 'server' }],
  ['shares', 'social', 'share', 'shares', [1, 5, 25, 100], { kind: 'server', ids: { 1: 'first_share' }, points: { 1: 50 } }],
  ['themes', 'social', 'palette', 'themes', [1, 3, 10], { kind: 'server', ids: { 1: 'theme_published' }, points: { 1: 100 } }],
  ['reviews', 'social', 'star', 'reviews', [1, 3, 10, 25], { kind: 'server' }],
  // Venus (la cuenta: antiguedad, Venus Points, misiones, tienda y los propios logros)
  ['member', 'venus', 'calendar', 'memberDays', [7, 30, 90, 180, 365, 730, 1825], { kind: 'server' }],
  ['earned', 'venus', 'star', 'pointsEarned', [100, 500, 1000, 5000, 10000, 50000, 100000], { kind: 'server' }],
  ['spent', 'venus', 'tag', 'pointsSpent', [100, 500, 1000, 2500, 5000, 10000], { kind: 'server' }],
  ['missions', 'venus', 'target', 'missions', [1, 10, 50, 100, 500, 1000, 5000], { kind: 'server' }],
  ['collector', 'venus', 'tag', 'items', [1, 5, 10, 20, 30, 50], { kind: 'server' }],
  // Los pasos 200, 300 y 400 (0043) quedaron fuera de alcance con el catalogo mas corto: el nivel de los cuatro que quedan es el de siempre
  ['achiever', 'venus', 'trophy', 'achievements', [10, 25, 50, 100], { kind: 'server', tiers: ['bronze', 'bronze', 'silver', 'gold'] }],
  ['dailies', 'venus', 'calendar', 'dailies', [7, 30, 90, 180, 365, 1000], { kind: 'server' }],
];

// Logros sueltos: id, grupo, icono, nivel, puntos, tipo y medida (null = lo avisa otra parte con 'venus:achievement')
const SINGLES = [
  ['first_party', 'social', 'users', 'bronze', 75, 'client', null],
  ['skin_created', 'collection', 'palette', 'bronze', 50, 'client', null],
  ['first_voice', 'social', 'mic', 'bronze', 25, 'client', null],
  ['first_overlay', 'special', 'monitor', 'bronze', 15, 'client', null],
  ['night_owl', 'special', 'moon', 'silver', 25, 'client', 'flagNightOwl'],
  ['early_bird', 'special', 'sun', 'silver', 25, 'client', 'flagEarlyBird'],
  ['weekend_warrior', 'special', 'calendar', 'silver', 25, 'client', 'flagWeekend'],
  ['crash_survivor', 'special', 'shield', 'silver', 25, 'client', 'flagCrashSurvivor'],
  ['anniversary', 'special', 'star', 'gold', 50, 'client', 'flagAnniversary'],
  ['profile_complete', 'venus', 'user', 'silver', 100, 'server', 'profile'],
  ['mc_verified', 'venus', 'shieldCheck', 'silver', 100, 'server', 'verified'],
  ['badge_on', 'venus', 'star', 'bronze', 50, 'server', 'badge'],
  ['premium', 'venus', 'crown', 'gold', 300, 'server', 'premium'],
];

function tierOf(index, length) {
  if (length <= 1) return 'gold';
  return TIERS[Math.min(TIERS.length - 1, Math.floor((index / (length - 1)) * (TIERS.length - 0.001)))];
}

function build() {
  const list = [];
  let sort = 0;
  LADDERS.forEach(([family, group, icon, metric, steps, opts = {}]) => {
    const kind = opts.kind || 'client';
    steps.forEach((target, i) => {
      const tier = opts.tiers?.[i] || tierOf(i, steps.length);
      list.push({
        id: opts.ids?.[target] || `${family}_${target}`,
        family,
        group,
        icon,
        metric,
        target,
        step: i + 1,
        tier,
        kind,
        points: opts.points?.[target] ?? POINTS[kind][tier],
        sort: (sort += 10),
      });
    });
  });
  for (const [id, group, icon, tier, points, kind, metric] of SINGLES) {
    list.push({ id, family: id, group, icon, metric, target: 1, step: 1, tier, kind, points, single: true, sort: (sort += 10) });
  }
  return list;
}

export const ACHIEVEMENTS = build();
export const ACHIEVEMENT_BY_ID = new Map(ACHIEVEMENTS.map((a) => [a.id, a]));
// Logros de esta PC que aceptan quedar pendientes hasta iniciar sesion
export const CLIENT_IDS = ACHIEVEMENTS.filter((a) => a.kind === 'client').map((a) => a.id);

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV'];
export const roman = (n) => ROMAN[n - 1] || String(n);

// Familias: una tarjeta por escalera, con sus pasos en orden
export function families(list = ACHIEVEMENTS) {
  const map = new Map();
  for (const a of list) {
    if (!map.has(a.family)) map.set(a.family, { id: a.family, group: a.group, icon: a.icon, metric: a.metric, kind: a.kind, single: Boolean(a.single), steps: [] });
    map.get(a.family).steps.push(a);
  }
  return [...map.values()];
}

// Que logros de esta PC se cumplen con estas medidas y todavia no estan desbloqueados
export function clientMet(metrics, unlocked = new Set(), list = ACHIEVEMENTS) {
  const out = [];
  for (const a of list) {
    if (a.kind !== 'client' || !a.metric || unlocked.has(a.id)) continue;
    const v = Number(metrics?.[a.metric]);
    if (Number.isFinite(v) && v >= a.target) out.push(a.id);
  }
  return out;
}

// Estado de una familia: { current (ultimo paso conseguido), next, value, progress, done, unlockedCount }
export function familyState(fam, { unlocked = new Map(), metrics = {} } = {}) {
  const value = Number(metrics[fam.metric]);
  const known = Number.isFinite(value) ? value : null;
  let current = null;
  let next = null;
  let unlockedCount = 0;
  for (const s of fam.steps) {
    if (unlocked.has(s.id)) {
      current = s;
      unlockedCount++;
    } else if (!next) next = s;
  }
  const base = current && current.target < (next?.target ?? Infinity) ? current.target : 0;
  const progress = next ? (known === null ? 0 : Math.max(0, Math.min(1, known / next.target))) : 1;
  return { current, next, value: known, base, progress, done: !next, unlockedCount };
}

// Rareza segun el porcentaje de jugadores que lo tiene. Con pocos usuarios el porcentaje no dice nada: null.
export const RARITY_MIN_USERS = 20;
export function rarityOf(pct, totalUsers) {
  if (!Number.isFinite(pct) || !(totalUsers >= RARITY_MIN_USERS)) return null;
  if (pct <= 1) return 'legendary';
  if (pct <= 5) return 'epic';
  if (pct <= 20) return 'rare';
  if (pct <= 50) return 'uncommon';
  return 'common';
}

// Medidas de esta PC a partir de los datos del launcher (cada parte puede faltar). Solo del launcher: las estadisticas
// de los mundos y los logros de Minecraft no cuentan (4.6).
export function metricsFrom({ report, local, instances, localServers } = {}) {
  const m = {};
  const set = (k, v) => {
    if (Number.isFinite(v)) m[k] = v;
  };
  if (report) {
    const tot = report.totals || {};
    set('hours', (Number(tot.ms) || 0) / 3600000);
    set('sessions', Number(tot.sessions));
    set('bestStreak', Number(report.streak?.longest?.days));
    set('longestHours', (Number(report.records?.longestSession?.ms) || 0) / 3600000);
    set('daysPlayed', Number(tot.daysPlayed));
    set('instancesPlayed', Number(tot.instancesPlayed));
    set('versions', Number(tot.versionsPlayed));
    set('loaders', Number(tot.loadersPlayed));
    const ms = new Map((report.milestones || []).map((x) => [x.id, x]));
    set('flagNightOwl', ms.get('nightOwl')?.achievedAt ? 1 : 0);
    set('flagEarlyBird', ms.get('earlyBird')?.achievedAt ? 1 : 0);
    set('flagWeekend', ms.get('weekend')?.achievedAt ? 1 : 0);
    set('flagCrashSurvivor', ms.get('crashSurvivor')?.achievedAt ? 1 : 0);
    set('flagAnniversary', ms.get('anniversary')?.achievedAt ? 1 : 0);
  }
  if (local) {
    set('mods', Number(local.mods));
    set('shaders', Number(local.shaders));
    set('resourcepacks', Number(local.resourcepacks));
    set('screenshots', Number(local.screenshots));
    set('clips', Number(local.clips));
  }
  set('instances', Number(instances));
  set('localServers', Number(localServers));
  return m;
}

// ---------- Misiones ----------
// Misma lista que public.missions (0023). metric: lo que cuenta features/missions.js
export const MISSIONS = [
  // Diarias
  { id: 'd_play_15', period: 'daily', metric: 'playMinutes', target: 15, points: 15, icon: 'clock' },
  { id: 'd_play_30', period: 'daily', metric: 'playMinutes', target: 30, points: 25, icon: 'clock' },
  { id: 'd_play_60', period: 'daily', metric: 'playMinutes', target: 60, points: 35, icon: 'clock' },
  { id: 'd_launch_1', period: 'daily', metric: 'launches', target: 1, points: 10, icon: 'play' },
  { id: 'd_launch_2', period: 'daily', metric: 'launches', target: 2, points: 15, icon: 'play' },
  { id: 'd_shot_1', period: 'daily', metric: 'screenshots', target: 1, points: 15, icon: 'image' },
  { id: 'd_clip_1', period: 'daily', metric: 'clips', target: 1, points: 20, icon: 'camera' },
  { id: 'd_server_1', period: 'daily', metric: 'serverJoins', target: 1, points: 15, icon: 'server' },
  { id: 'd_world_1', period: 'daily', metric: 'worldVisits', target: 1, points: 10, icon: 'globe' },
  { id: 'd_message_1', period: 'daily', metric: 'messages', target: 1, points: 15, icon: 'message' },
  { id: 'd_voice_1', period: 'daily', metric: 'voiceJoins', target: 1, points: 20, icon: 'mic' },
  { id: 'd_reward_1', period: 'daily', metric: 'dailyRewards', target: 1, points: 10, icon: 'calendar' },
  // Semanales
  { id: 'w_play_180', period: 'weekly', metric: 'playMinutes', target: 180, points: 60, icon: 'clock' },
  { id: 'w_play_300', period: 'weekly', metric: 'playMinutes', target: 300, points: 90, icon: 'clock' },
  { id: 'w_play_600', period: 'weekly', metric: 'playMinutes', target: 600, points: 130, icon: 'clock' },
  { id: 'w_launch_5', period: 'weekly', metric: 'launches', target: 5, points: 50, icon: 'play' },
  { id: 'w_launch_10', period: 'weekly', metric: 'launches', target: 10, points: 80, icon: 'play' },
  { id: 'w_shot_5', period: 'weekly', metric: 'screenshots', target: 5, points: 50, icon: 'image' },
  { id: 'w_clip_3', period: 'weekly', metric: 'clips', target: 3, points: 60, icon: 'camera' },
  { id: 'w_server_3', period: 'weekly', metric: 'serverJoins', target: 3, points: 50, icon: 'server' },
  { id: 'w_message_10', period: 'weekly', metric: 'messages', target: 10, points: 50, icon: 'message' },
  { id: 'w_voice_3', period: 'weekly', metric: 'voiceJoins', target: 3, points: 70, icon: 'mic' },
  { id: 'w_ach_3', period: 'weekly', metric: 'achievements', target: 3, points: 70, icon: 'trophy' },
  { id: 'w_reward_5', period: 'weekly', metric: 'dailyRewards', target: 5, points: 80, icon: 'calendar' },
];
export const MISSION_BONUS = { daily: 25, weekly: 100 };
export const MISSION_BY_ID = new Map(MISSIONS.map((m) => [m.id, m]));

// Claves del periodo actual, las mismas que private.mission_period_key (dia UTC y semana ISO 8601)
export function dailyKey(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}
export function weeklyKey(now = Date.now()) {
  const d = new Date(now);
  const day = (d.getUTCDay() + 6) % 7; // lunes = 0
  const thursday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 3));
  const year = thursday.getUTCFullYear();
  const week = Math.floor((thursday - Date.UTC(year, 0, 1)) / 604800000) + 1;
  return `${year}-W${String(week).padStart(2, '0')}`;
}
