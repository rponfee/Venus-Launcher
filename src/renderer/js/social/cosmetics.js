// Cosmeticos del perfil (banners, insignias, cabeza de Minecraft) y formatos de presencia y actividad.
// Lo usan social.js, la pagina de Mensajes y las tarjetas de perfil. Todo lo que viene de otros
// usuarios se valida aca antes de mostrarlo (colores, direcciones, textos).
import { t, has } from '../i18n.js';
import { LOADERS } from '../ui.js';

// ---------- Banners ----------
// Se guardan en profiles.banner (max. 64 caracteres): "<preset>", "c:#rrggbb" (color) o "g:#rrggbb:#rrggbb" (degradado).
export const BANNERS = [
  { id: 'venus', colors: ['#ffd27a', '#f29a2e', '#9b4512'] },
  { id: 'sunset', colors: ['#ffd27a', '#ff7a59', '#6b2a5e'] },
  { id: 'nether', colors: ['#ff8a5c', '#b8321f', '#2a0c08'] },
  { id: 'redstone', colors: ['#ff8a80', '#d32f2f', '#4a0d0d'] },
  { id: 'gold', colors: ['#fff1a8', '#f0b429', '#7a4e0e'] },
  { id: 'forest', colors: ['#c6f27a', '#3f9a3a', '#12301a'] },
  { id: 'emerald', colors: ['#a8ffcf', '#1fb86a', '#0b3b25'] },
  { id: 'diamond', colors: ['#c8fff6', '#3fcfc0', '#0f4e55'] },
  { id: 'ocean', colors: ['#8fe6ff', '#2a7fd4', '#0e2a52'] },
  { id: 'aurora', colors: ['#7dffd6', '#6b8cff', '#a45cff'] },
  { id: 'amethyst', colors: ['#f1c6ff', '#a64dd6', '#3b1450'] },
  { id: 'end', colors: ['#e6dcff', '#7e5bd6', '#1a1030'] },
  { id: 'cherry', colors: ['#ffe0ec', '#ff7eb3', '#8c2f5a'] },
  { id: 'midnight', colors: ['#6f7fa8', '#2a3350', '#0d0f17'] },
  { id: 'stone', colors: ['#c9c2b8', '#7d756b', '#2e2a26'] },
  { id: 'snow', colors: ['#ffffff', '#cfe3f2', '#7b97b2'] },
];
const BANNER_MAP = new Map(BANNERS.map((b) => [b.id, b]));
const HEX = /^#[0-9a-f]{6}$/i;

export function parseBanner(value) {
  const v = String(value || '').trim();
  if (BANNER_MAP.has(v)) return { kind: 'preset', id: v, colors: BANNER_MAP.get(v).colors };
  let m = v.match(/^c:(#[0-9a-f]{6})$/i);
  if (m) return { kind: 'solid', colors: [m[1], m[1]] };
  m = v.match(/^g:(#[0-9a-f]{6}):(#[0-9a-f]{6})$/i);
  if (m) return { kind: 'gradient', colors: [m[1], m[2]] };
  return { kind: 'preset', id: 'venus', colors: BANNER_MAP.get('venus').colors, fallback: true };
}

export function encodeBanner({ kind, id, colors = [] }) {
  if (kind === 'preset' && BANNER_MAP.has(id)) return id;
  if (kind === 'solid' && HEX.test(colors[0] || '')) return `c:${colors[0].toLowerCase()}`;
  if (kind === 'gradient' && HEX.test(colors[0] || '') && HEX.test(colors[1] || '')) return `g:${colors[0].toLowerCase()}:${colors[1].toLowerCase()}`;
  return 'venus';
}

// Fondo CSS del banner (solo colores ya validados; nunca texto libre del usuario).
export function bannerBackground(value, angle = 135) {
  const { colors } = parseBanner(value);
  if (colors.length === 3) return `linear-gradient(${angle}deg, ${colors[0]}, ${colors[1]} 48%, ${colors[2]})`;
  return colors[0] === colors[1] ? colors[0] : `linear-gradient(${angle}deg, ${colors[0]}, ${colors[1]})`;
}

// Color de acento (el del medio) para bordes y brillos.
export function bannerAccent(value) {
  const { colors } = parseBanner(value);
  return colors[colors.length === 3 ? 1 : 0];
}

export function bannerName(id) {
  return t(`social.banner_${id}`);
}

// ---------- Insignias (las asigna el servidor: profiles.badges) ----------
export const BADGES = {
  founder: { icon: 'crown', color: '#ffc562' },
  staff: { icon: 'shield', color: '#ff8a5c' },
  dev: { icon: 'code', color: '#7fb2ff' },
  tester: { icon: 'bug', color: '#9be36a' },
  supporter: { icon: 'heart', color: '#ff7eb3' },
  creator: { icon: 'camera', color: '#c58cff' },
  early: { icon: 'rocket', color: '#ffd27a' },
  partner: { icon: 'star', color: '#ffe066' },
  translator: { icon: 'languages', color: '#6fe0d0' },
  verified: { icon: 'shieldCheck', color: '#5aa7f0' },
};

export function badgeInfo(id) {
  const key = String(id || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24);
  if (!key) return null;
  const meta = BADGES[key];
  return {
    id: key,
    icon: meta?.icon || 'tag',
    color: meta?.color || '#d4bfa8',
    label: has(`social.badge_${key}`) ? t(`social.badge_${key}`) : key,
  };
}

export function badgesOf(profile) {
  const list = Array.isArray(profile?.badges) ? profile.badges : [];
  return list.slice(0, 8).map(badgeInfo).filter(Boolean);
}

// ---------- Nombres y cabezas ----------
export function displayName(profile) {
  const d = typeof profile?.display_name === 'string' ? profile.display_name.trim() : '';
  return d || profile?.username || '';
}

const MC_NAME = /^[A-Za-z0-9_]{3,16}$/;
const MC_UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

export function isMcName(v) {
  return MC_NAME.test(String(v || ''));
}

// Lo que se pasa a mc-heads.net: uuid de Minecraft, nombre de Minecraft o el usuario de Venus.
export function headId(profile) {
  if (MC_UUID.test(profile?.mc_uuid || '')) return profile.mc_uuid.replace(/-/g, '');
  if (isMcName(profile?.mc_name)) return profile.mc_name;
  if (isMcName(profile?.username)) return profile.username;
  return 'MHF_Steve';
}

// ---------- Presencia ----------
export const PRESENCES = ['online', 'away', 'busy', 'offline'];
export const MY_STATUSES = ['online', 'away', 'busy', 'invisible'];

export function presenceLabel(presence) {
  return t(`social.presence_${PRESENCES.includes(presence) || presence === 'invisible' ? presence : 'offline'}`);
}

export function isOnline(presence) {
  return presence === 'online' || presence === 'away' || presence === 'busy';
}

// ---------- Actividad ----------
const LOADER_KEYS = Object.keys(LOADERS);

// Solo direcciones utiles para un amigo: nada de localhost, IPs privadas ni nombres de red local.
export function publicAddress(addr) {
  const a = String(addr || '').trim().toLowerCase();
  if (!/^[a-z0-9.-]{1,253}(:\d{1,5})?$/.test(a)) return null;
  const host = a.replace(/:\d+$/, '');
  if (!host.includes('.') || host.startsWith('.') || host.endsWith('.') || host.includes('..')) return null;
  if (/\.(local|lan|home|internal|localdomain|localhost|test|invalid)$/.test(host)) return null;
  const ip = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ip) {
    const [x, y] = [Number(ip[1]), Number(ip[2])];
    if ([ip[1], ip[2], ip[3], ip[4]].some((n) => Number(n) > 255)) return null;
    if (x === 0 || x === 10 || x === 127 || x >= 224) return null;
    if ((x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 169 && y === 254) || (x === 100 && y >= 64 && y <= 127)) return null;
  }
  return a;
}

const clean = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, '').trim().slice(0, max) : '');

// Valida la actividad que manda un amigo (user_activity.activity).
export function sanitizeActivity(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!['menu', 'singleplayer', 'server'].includes(raw.type)) return null;
  const out = {
    type: raw.type,
    instanceName: clean(raw.instanceName, 48),
    mcVersion: /^[\w.\- ]{1,24}$/.test(raw.mcVersion || '') ? raw.mcVersion : '',
    loader: LOADER_KEYS.includes(raw.loader) ? raw.loader : '',
    since: Number.isFinite(raw.since) && raw.since > 0 ? raw.since : null,
  };
  if (raw.type === 'server') out.address = publicAddress(raw.address);
  if (raw.type === 'singleplayer') out.world = clean(raw.world, 48);
  return out;
}

export function versionLabel(act) {
  if (!act?.mcVersion) return '';
  const loader = act.loader && act.loader !== 'vanilla' ? LOADERS[act.loader]?.name : '';
  return loader ? t('social.versionLoader', { version: act.mcVersion, loader }) : act.mcVersion;
}

// "Jugando 1.21.1 · mc.hypixel.net"
export function activityLine(act) {
  if (!act) return '';
  const version = versionLabel(act) || 'Minecraft';
  if (act.type === 'server') return act.address ? t('social.act_server', { version, address: act.address }) : t('social.act_multiplayer', { version });
  if (act.type === 'singleplayer') return act.world ? t('social.act_world', { version, world: act.world }) : t('social.act_singleplayer', { version });
  return t('social.act_menu', { version });
}

export function isJoinable(act) {
  return act?.type === 'server' && Boolean(act.address);
}
