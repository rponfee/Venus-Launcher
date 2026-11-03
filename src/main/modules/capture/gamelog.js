'use strict';
// Reconoce lo que le paso al jugador local leyendo la salida del juego (las lineas de game.events 'log'): muerte,
// logro (advancement) o jefe. Sin Electron ni archivos (se prueba con node:test); las plantillas las trae gamelang.js.
//
// Minecraft no escribe ningun codigo en el log: solo el texto del mensaje, ya traducido al idioma del juego
// ("[System] [CHAT] Steve fue asesinado/a por Zombi"). Por eso no se compara contra frases fijas: se arman las
// expresiones con las plantillas del propio juego ("%1$s fue asesinado/a por %2$s"), en ingles y en el idioma elegido,
// con el nombre de la cuenta en el lugar del jugador. Asi vale para cualquier idioma y solo para el jugador local: la
// muerte de otro, o un mensaje de chat que copia el texto, no coincide. Lo que se detecta y lo que no: docs/clips.md.

// Claves de las tablas de idioma que se usan (gamelang.js se queda solo con estas)
const DEATH_KEY = /^death\.(attack|fell)\./;
const DEATH_SKIP = /(message_too_long|\.link)$/;
const ADVANCEMENT_KEY = /^chat\.type\.(advancement\.(task|challenge|goal)|achievement)$/;
// Logros que solo se consiguen matando al jefe (hasta 1.11 tambien existia el del Wither)
const BOSS_TITLES = { 'advancements.end.kill_dragon.title': 'ender_dragon', 'achievement.theEnd2': 'ender_dragon', 'achievement.killWither': 'wither' };
const BOSS_NAMES = {
  'entity.minecraft.ender_dragon': 'ender_dragon',
  'entity.EnderDragon.name': 'ender_dragon',
  'entity.minecraft.wither': 'wither',
  'entity.WitherBoss.name': 'wither',
  'entity.minecraft.warden': 'warden',
  'entity.minecraft.elder_guardian': 'elder_guardian',
  'entity.ElderGuardian.name': 'elder_guardian',
};
// Comunes en servidores de minijuegos (no estan en las tablas del juego)
const EXTRA_DEATHS = ['%1$s fell into the void'];

const MAX_LINE = 1000;
const NAME_PREFIX = '(?:[^<>:]{0,32}?[\\s\\]~*])?'; // rango o equipo antes del nombre: "[VIP] Steve", "DontHurt Steve"
const END_PUNCT = '[.!…。！]*';

function wantedKey(key) {
  return (DEATH_KEY.test(key) && !DEATH_SKIP.test(key)) || ADVANCEMENT_KEY.test(key) || Object.hasOwn(BOSS_TITLES, key) || Object.hasOwn(BOSS_NAMES, key);
}

// ---------- Lineas del log ----------

const LOG_LINE = /^\[[^\]]*\]\s*\[([^\]/]+)\/([A-Z]+)\](?:\s*\[[^\]]*\])?\s*(?:\([^)]*\))?\s*:?\s?(.*)$/;
const CHAT = /^(?:\[([^\]]+)\]\s*)?\[CHAT\]\s?(.*)$/;

function clean(s) {
  return String(s)
    .replace(/§./g, '')
    .replace(/[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]/g, '')
    .trim();
}

/**
 * Mensaje de sistema de una linea del log o null. Formatos:
 *   [18:03:09] [Render thread/INFO]: [System] [CHAT] mensaje            (desde 1.19)
 *   [18:03:09] [Render thread/INFO]: [CHAT] mensaje                     (1.13 a 1.18; "Client thread" hasta 1.12)
 *   [02Nov2026 18:03:09.123] [Render thread/INFO] [net.minecraft.client.gui.components.ChatComponent/]: [CHAT] mensaje   (Forge)
 *   [18:03:09] [Server thread/INFO]: mensaje                            (el servidor integrado de un mundo propio)
 * El chat de otros jugadores lleva [Not Secure] o [Modified] y se descarta: nunca es un aviso del juego.
 */
function systemMessage(text) {
  const m = LOG_LINE.exec(firstLine(text));
  if (!m || m[2] !== 'INFO') return null;
  const chat = CHAT.exec(m[3]);
  if (chat) {
    if (chat[1] && chat[1] !== 'System') return null;
    return clean(chat[2]);
  }
  return m[1] === 'Server thread' ? clean(m[3]) : null;
}

function firstLine(text) {
  const s = String(text ?? '');
  const nl = s.indexOf('\n');
  return nl < 0 ? s : s.slice(0, nl);
}

// Nombre de la cuenta con la que arranco el juego ("Setting user: Steve"), o null
function settingUser(text) {
  const line = firstLine(text);
  if (!line.includes('Setting user: ') || line.includes('[CHAT]') || line.includes('Server thread')) return null;
  const m = /\/INFO\].*?\bSetting user: ([A-Za-z0-9_]{1,32})\s*$/.exec(line);
  return m ? m[1] : null;
}

// ---------- Plantillas a expresiones ----------

const escapeRe = (s) => String(s).replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
const literal = (s) => escapeRe(s).replace(/\s+/g, '\\s+');

/**
 * Expresion de una plantilla de Minecraft ("%1$s was slain by %2$s", "%s has made the advancement %s", "%%" = %).
 * args = { numero: expresion }: los argumentos que no estan valen cualquier texto. null si la plantilla no usa
 * alguno de los pedidos o si casi no tiene texto propio (coincidiria con cualquier cosa).
 */
function compileTemplate(raw, args) {
  if (typeof raw !== 'string') return null;
  // Igual que el mensaje: algunas traducciones traen espacios de mas en las puntas
  const tpl = clean(raw);
  if (!tpl) return null;
  let out = '';
  let own = '';
  let last = 0;
  let next = 1;
  const used = new Set();
  for (const m of tpl.matchAll(/%(?:(\d+)\$)?s|%%/g)) {
    const text = tpl.slice(last, m.index);
    out += literal(text);
    own += text;
    last = m.index + m[0].length;
    if (m[0] === '%%') {
      out += '%';
      continue;
    }
    const n = m[1] ? Number(m[1]) : next++;
    used.add(n);
    out += args[n] ?? '.+?';
  }
  const tail = tpl.slice(last);
  out += literal(tail);
  own += tail;
  if (own.replace(/\s/g, '').length < 2) return null;
  for (const n of Object.keys(args)) if (!used.has(Number(n))) return null;
  try {
    return new RegExp(`^${out}${END_PUNCT}$`, 'iu');
  } catch {
    return null;
  }
}

// Expresiones para un jugador. tables = [{ clave: texto }] (mismas claves que los archivos de idioma del juego).
function buildMatcher(player, tables) {
  const name = String(player);
  const nameRe = NAME_PREFIX + escapeRe(name);
  const deaths = new Set(EXTRA_DEATHS);
  const advancements = new Set();
  const bossTitles = new Map();
  const bossNames = new Map();
  for (const table of tables || []) {
    for (const [key, value] of Object.entries(table || {})) {
      if (typeof value !== 'string') continue;
      if (DEATH_KEY.test(key)) {
        if (!DEATH_SKIP.test(key)) deaths.add(value);
      } else if (ADVANCEMENT_KEY.test(key)) advancements.add(value);
      else if (Object.hasOwn(BOSS_TITLES, key)) bossTitles.set(value.toLowerCase(), BOSS_TITLES[key]);
      else if (Object.hasOwn(BOSS_NAMES, key)) bossNames.set(value.toLowerCase(), BOSS_NAMES[key]);
    }
  }
  const keep = (list) => list.filter(Boolean);
  const onDeath = keep([...deaths].map((tpl) => compileTemplate(tpl, { 1: nameRe })));
  const onAdvancement = keep([...advancements].map((tpl) => compileTemplate(tpl, { 1: nameRe, 2: '\\[(.+)\\]' })));
  // Un jefe que murio por el jugador, si el servidor o un mod lo anuncia con el formato del juego
  const bossAlt = [...bossNames.keys()].map(escapeRe).join('|');
  const onBossKill = bossAlt ? keep([...deaths].map((tpl) => compileTemplate(tpl, { 1: `(?:the\\s+)?(?<boss>${bossAlt})`, 2: nameRe }))) : [];
  const needle = name.toLowerCase();
  return (message) => {
    if (!message || !message.toLowerCase().includes(needle)) return null;
    for (const re of onAdvancement) {
      const m = re.exec(message);
      if (!m) continue;
      const title = m[1];
      const boss = bossTitles.get(title.toLowerCase());
      return boss ? { reason: 'boss', boss, title } : { reason: 'advancement', title };
    }
    for (const re of onBossKill) {
      const m = re.exec(message);
      if (m) return { reason: 'boss', boss: bossNames.get(m.groups.boss.toLowerCase()) };
    }
    for (const re of onDeath) if (re.test(message)) return { reason: 'death' };
    return null;
  };
}

/**
 * Lector de la salida de una partida. read(linea) devuelve:
 *   { reason: 'death' | 'advancement' | 'boss', boss?, title? }  un evento del jugador local
 *   { setup: 'reload' }                                          el juego recargo sus recursos (pudo cambiar de idioma)
 *   null                                                         cualquier otra cosa
 * player = nombre de la cuenta de la partida; si el log dice otro ("Setting user:"), vale el del log.
 */
class GameLogReader {
  constructor({ player = null, tables = [] } = {}) {
    this.player = player || null;
    this.tables = tables;
    this.userSeen = false;
    this.matcher = null;
  }

  setTables(tables) {
    this.tables = tables || [];
    this.matcher = null;
  }

  setPlayer(name) {
    if (name === this.player) return;
    this.player = name || null;
    this.matcher = null;
  }

  read(text) {
    if (typeof text !== 'string' || !text || text.length > MAX_LINE) return null;
    if (!text.includes('[CHAT]') && !text.includes('[Server thread/INFO]')) {
      if (!this.userSeen) {
        const user = settingUser(text);
        if (user) {
          this.userSeen = true;
          this.setPlayer(user);
          return null;
        }
      }
      return text.includes('Reloading ResourceManager') ? { setup: 'reload' } : null;
    }
    if (!this.player) return null;
    const message = systemMessage(text);
    if (!message) return null;
    if (!this.matcher) this.matcher = buildMatcher(this.player, this.tables);
    return this.matcher(message);
  }
}

module.exports = { GameLogReader, systemMessage, settingUser, compileTemplate, buildMatcher, wantedKey };
