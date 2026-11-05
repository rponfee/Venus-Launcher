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

// Banner de ejemplo (una imagen quieta propia, 4:1): cielo, sol y colinas escalonadas dibujados en un <canvas>
function sampleBanner([sky, ground, sun], seed = 4) {
  const c = document.createElement('canvas');
  c.width = 1200;
  c.height = 300;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 300);
  grad.addColorStop(0, sky[0]);
  grad.addColorStop(1, sky[1]);
  g.fillStyle = grad;
  g.fillRect(0, 0, 1200, 300);
  g.fillStyle = sun;
  g.fillRect(880, 70, 56, 56);
  let s = seed * 9301 + 49297;
  for (let x = 0; x < 1200; x += 24) {
    s = (s * 9301 + 49297) % 233280;
    const hgt = 200 + Math.round((s / 233280) * 50);
    g.fillStyle = ground[0];
    g.fillRect(x, hgt, 24, 12);
    g.fillStyle = ground[1];
    g.fillRect(x, hgt + 12, 24, 300 - hgt);
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
    // Canción de ejemplo (formato de Openverse, datos inventados: el audio no existe)
    song: premium
      ? {
          provider: 'openverse',
          id: '00000000-0000-4000-8000-000000000001',
          title: 'Aurora pixelada',
          creator: 'Estudio Lunaria',
          license: 'by-sa',
          licenseVersion: '4.0',
          licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
          landing: 'https://www.jamendo.com/track/9000001',
          url: 'https://prod-1.storage.jamendo.com/?trackid=9000001&format=mp32',
          start: 24,
          len: 30,
        }
      : null,
    theme: premium ? { from: '#c2457a', to: '#2a3a8f', angle: 160 } : { from: '#3f9a3a', to: '#12301a', angle: 135 },
    nameStyle: premium ? { font: 'pixel', effect: 'rainbow', color: '#ffc562', glow: 35 } : { font: 'rounded', effect: 'gradient', color: '#9be36a', glow: 20 },
    // 4.6: sin diseños prediseñados. Premium muestra una imagen propia quieta; la cuenta gratis, el color clasico
    banner: premium ? { kind: 'image', url: sampleBanner([['#2b1b4f', '#c2457a'], ['#3b1450', '#1d0f2e'], '#ffe6b0']) } : { kind: 'none' },
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
    equipped: premium ? { frame: 'frame_wings', title: 'title_legend', badgeStyle: 'badge_gold' } : { frame: 'frame_leaves', title: 'title_explorer' },
    premium,
    createdAt: new Date(now - 420 * DAY).toISOString(),
  };
}

// Lo que tendria la cuenta de ejemplo: items comprados
export function demoOwned(kind = 'premium') {
  return kind === 'premium' ? ['frame_nebula', 'frame_flame', 'frame_ruby', 'title_explorer', 'title_legend', 'effect_fire'] : ['frame_leaves', 'title_explorer'];
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
// Rareza de ejemplo (porcentaje de jugadores por logro) para las insignias raras de la 3.1
export function demoRarity() {
  return { playtime_1: 92, playtime_5: 71, playtime_10h: 38, sessions_5: 80, diamond_1: 55, diamond_10: 12, dragon_1: 3.5, first_friend: 44, night_owl: 0.8, mobs_100: 24, blocks_1000: 60 };
}
export function demoClips() {
  return [{ id: '123e4567-e89b-12d3-a456-426614174000', url: 'https://example.invalid/clip.webm', title: 'Dragón en un golpe', expiresAt: null }];
}
// Resultados de ejemplo del buscador de KLIPY (sin red): miniaturas dibujadas en un <canvas>, direcciones con forma de KLIPY.
// Se usan solo con las capturas de desarrollo.
export function demoKlipy() {
  const palettes = [
    [['#7fd0ff', '#2a7fd4'], ['#e8e2a6', '#8f8a5c'], '#ffffff'],
    [['#ffb36b', '#6b2a5e'], ['#4f8a2b', '#6b4a2e'], '#fff1b8'],
    [['#2b1b4f', '#070b1f'], ['#3f7d3c', '#1d4426'], '#ffe6b0'],
    [['#ffd1e6', '#c2457a'], ['#7b3a66', '#4a1d3c'], '#ffffff'],
    [['#b6ffcf', '#17c964'], ['#067a3a', '#0b3d20'], '#fff1a8'],
    [['#0b1f3a', '#1fd3a6'], ['#0c3b34', '#061a17'], '#c4f4ff'],
    [['#ff7a59', '#3b1450'], ['#1e0c22', '#0e0610'], '#ffc562'],
    [['#c4f4ff', '#5aa7f0'], ['#dcecf8', '#9fb4d0'], '#ffffff'],
  ];
  const items = palettes.map((p, i) => ({
    slug: `demo-gif-${i + 1}`,
    title: `GIF ${i + 1}`,
    url: `https://static.klipy.com/demo/${i + 1}.webp`,
    thumb: sampleBanner(p, i + 2),
    still: null,
  }));
  return { items, hasNext: false };
}
