// Datos de ejemplo de los perfiles, solo para capturas de desarrollo (scripts/devshot.js con VENUS_DEVSHOT).
// No hablan con ningun servidor. Las capturas destacadas de ejemplo se dibujan en un <canvas> (data: URL).
//   VENUS_DEVSHOT_ROUTES="messages|import('./js/features/profile-editor.js').then((m) => m.openProfileEditor({ demo: 'premium' }));0"
//   VENUS_DEVSHOT_ROUTES="messages|import('./js/features/profile-editor/demo.js').then((d) => d.openDemoCard());0"
const DAY = 86_400_000;

// Paisaje pixel chico (cielo, sol y colinas escalonadas) como captura de ejemplo
function sampleShot(seed, [sky, ground, sun]) {
  const c = document.createElement('canvas');
  c.width = 320;
  c.height = 180;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 180);
  grad.addColorStop(0, sky[0]);
  grad.addColorStop(1, sky[1]);
  g.fillStyle = grad;
  g.fillRect(0, 0, 320, 180);
  g.fillStyle = sun;
  g.fillRect(230 - seed * 20, 30, 28, 28);
  let s = seed * 9301 + 49297;
  for (let x = 0; x < 320; x += 16) {
    s = (s * 9301 + 49297) % 233280;
    const hgt = 110 + Math.round((s / 233280) * 30);
    g.fillStyle = ground[0];
    g.fillRect(x, hgt, 16, 8);
    g.fillStyle = ground[1];
    g.fillRect(x, hgt + 8, 16, 180 - hgt);
  }
  return c.toDataURL('image/png');
}

export function demoProfile(kind = 'premium') {
  const premium = kind === 'premium';
  const now = Date.now();
  return {
    id: '0b5b9a3e-1f0c-4c55-9a51-2d1c7e3f4a10',
    username: premium ? 'Ringo' : 'TomiCraft',
    displayName: premium ? 'Ringo' : 'Tomi',
    friendCode: premium ? 'VENUS-R1NG0X' : 'VENUS-T0M1XX',
    mcName: premium ? 'Notch' : 'jeb_',
    bio: premium ? 'Constructor de castillos y granjas de hierro. Los viernes, bedwars con los pibes. Si me ves conectado, sumate.' : 'Main bedwars. Siempre con ganas de un survival nuevo.',
    badges: premium ? ['founder', 'early'] : ['supporter'],
    pronouns: premium ? 'él' : 'elle',
    theme: premium ? { from: '#c2457a', to: '#2a3a8f', angle: 160 } : { from: '#3f9a3a', to: '#12301a', angle: 135 },
    nameStyle: premium ? { font: 'pixel', effect: 'rainbow', color: '#ffc562', glow: 35 } : { font: 'rounded', effect: 'gradient', color: '#9be36a', glow: 20 },
    banner: { kind: 'preset', preset: premium ? 'nebula' : 'forest' },
    favoriteServers: premium
      ? [
          { address: 'mc.hypixel.net', name: 'Hypixel' },
          { address: 'play.cubecraft.net', name: 'CubeCraft' },
        ]
      : [{ address: 'mc.hypixel.net', name: 'Hypixel' }],
    publicStats: premium ? { hours: 412.5, sessions: 380, topVersion: '1.21.1', topLoader: 'fabric', since: '2024-03-14' } : { hours: 37.2, sessions: 41, topVersion: '1.20.4', topLoader: 'vanilla', since: '2025-08-02' },
    featured: premium
      ? [
          { url: sampleShot(1, [['#ffb36b', '#6b2a5e'], ['#4f8a2b', '#6b4a2e'], '#fff1b8']), title: 'Atardecer en la base' },
          { url: sampleShot(2, [['#7fd0ff', '#2a7fd4'], ['#e8e2a6', '#8f8a5c'], '#ffffff']), title: 'La isla del End' },
          { url: sampleShot(3, [['#2b1b4f', '#070b1f'], ['#3f7d3c', '#1d4426'], '#ffe6b0']) },
        ]
      : [],
    equipped: premium ? { frame: 'frame_venus', title: 'title_legend', badgeStyle: 'badge_gold' } : { frame: 'frame_pixel', title: 'title_explorer' },
    premium,
    createdAt: new Date(now - 420 * DAY).toISOString(),
  };
}

// Lo que tendria la cuenta de ejemplo: items comprados
export function demoOwned(kind = 'premium') {
  return kind === 'premium' ? ['frame_pixel', 'frame_neon', 'title_explorer', 'title_legend', 'effect_fire'] : ['frame_pixel', 'title_explorer'];
}

export function demoStats() {
  return { hours: 412.5, sessions: 380, topVersion: '1.21.1', topLoader: 'fabric', since: '2024-03-14' };
}

export function demoSavedServers() {
  return [
    { name: 'Hypixel', address: 'mc.hypixel.net' },
    { name: 'CubeCraft', address: 'play.cubecraft.net' },
    { name: 'Mineplex', address: 'us.mineplex.com' },
    { name: 'Servidor de la casa', address: '192.168.0.20' },
  ];
}

// Tarjeta de perfil de ejemplo (capturas de desarrollo)
export async function openDemoCard(kind = 'premium') {
  const { store } = await import('../../store.js');
  if (!store.info?.devshot) return null;
  const { previewProfile } = await import('../../social/profile-ui.js');
  return previewProfile(demoProfile(kind), { presence: 'online' });
}

// Datos de ejemplo de la 3.0: logros para destacar, clips compartidos y resultados de KLIPY (sin red)
export function demoUnlocked() {
  return ['playtime_1', 'playtime_5', 'playtime_10h', 'sessions_5', 'diamond_1', 'diamond_10', 'dragon_1', 'first_friend', 'night_owl', 'mobs_100', 'blocks_1000'];
}
export function demoClips() {
  return [{ id: '123e4567-e89b-12d3-a456-426614174000', url: 'https://example.invalid/clip.webm', title: 'Dragón en un golpe', expiresAt: null }];
}
export function demoKlipy() {
  return { items: [], hasNext: false };
}
