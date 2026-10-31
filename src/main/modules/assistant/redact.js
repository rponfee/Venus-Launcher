'use strict';
// Anonimizacion de lo que se le manda al modelo: carpeta del usuario y nombre de usuario del sistema,
// nombre del equipo, nombres de jugador de las cuentas, UUIDs, emails, tokens/claves e IPs.
// Se aplica a todos los resultados de herramientas y al bloque de contexto de cada pregunta.
const os = require('os');

const COMMON_WORDS = new Set(['user', 'users', 'admin', 'administrator', 'java', 'minecraft', 'mods', 'root', 'test', 'game', 'player', 'home', 'windows', 'steam', 'public', 'default', 'guest', 'owner', 'pc']);

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Ruta como patron que acepta \ o / (y barras escapadas de JSON) entre segmentos.
function pathPattern(p) {
  const parts = String(p || '')
    .split(/[\\/]+/)
    .filter(Boolean)
    .map(escapeRe);
  return parts.length ? parts.join('[\\\\/]+') : null;
}

const RULES = [
  // Claves y tokens
  [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, '<token>'],
  [/\bsk-ant-[\w-]{10,}/g, '<token>'],
  [/\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}/g, '<token>'],
  [/\b(Bearer|Basic)\s+[\w.~+/=-]{12,}/gi, '$1 <token>'],
  [/(--(?:accessToken|session|uuid|xuid|clientId|username)\s+)\S+/gi, '$1<redacted>'],
  [/((?:access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?(?:id|token)?|password|passwd|pwd|secret|api[_-]?key|apikey|authorization|token)["']?\s*[:=]\s*["']?)[^\s"',;&]{4,}/gi, '$1<redacted>'],
  // Emails
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '<email>'],
  // UUIDs (con y sin guiones)
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>'],
  [/\b[0-9a-f]{32}\b/gi, '<uuid>'],
  // IPv4 que no parecen numeros de version (1.20.1.2 dentro de un nombre de archivo no se toca)
  [/(?<![\w.:-])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?![\w.-]|\.\d)/g, '<ip>'],
  // IPv6 completas o comprimidas con ::
  [/(?<![\w:])(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}(?![\w:])/gi, '<ip>'],
  [/(?<![\w:])(?:[0-9a-f]{1,4}:){1,6}:(?:[0-9a-f]{1,4}:){0,5}[0-9a-f]{1,4}(?![\w:])/gi, '<ip>'],
];

// Crea un anonimizador con los datos locales que hay que esconder.
function createRedactor({ homedir = os.homedir(), username = safeUser(), hostname = os.hostname(), players = [] } = {}) {
  const rules = [];
  const home = pathPattern(homedir);
  if (home) rules.push([new RegExp(home, 'gi'), '~']);
  const user = String(username || '').trim();
  if (user.length >= 2) {
    const u = escapeRe(user);
    rules.push([new RegExp(`([\\\\/]+(?:Users|home|Documents and Settings)[\\\\/]+)${u}(?=[\\\\/"'\\s]|$)`, 'gi'), '$1<user>']);
    if (user.length >= 4 && !COMMON_WORDS.has(user.toLowerCase())) rules.push([new RegExp(`(?<![\\w-])${u}(?![\\w-])`, 'gi'), '<user>']);
  }
  const host = String(hostname || '').trim();
  if (host.length >= 4 && !COMMON_WORDS.has(host.toLowerCase())) rules.push([new RegExp(`(?<![\\w-])${escapeRe(host)}(?![\\w-])`, 'gi'), '<host>']);
  const names = [...new Set((players || []).map((p) => String(p || '').trim()).filter((p) => p.length >= 3 && /^[\w]{3,32}$/.test(p)))];
  names.sort((a, b) => b.length - a.length);
  for (const n of names) rules.push([new RegExp(`(?<![\\w])${escapeRe(n)}(?![\\w])`, 'gi'), '<player>']);
  const all = [...rules, ...RULES];

  function str(s) {
    let out = s;
    for (const [re, rep] of all) out = out.replace(re, rep);
    return out;
  }

  function walk(v, depth = 0) {
    if (typeof v === 'string') return str(v);
    if (depth > 12 || v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = walk(x, depth + 1);
    return out;
  }

  return walk;
}

function safeUser() {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USERNAME || process.env.USER || '';
  }
}

// Anonimizador con los nombres de las cuentas del launcher (se refresca cada minuto).
let cached = null;
async function currentRedactor() {
  if (cached && Date.now() - cached.at < 60000) return cached.fn;
  let players = [];
  try {
    const accounts = require('../../core/accounts');
    const list = await accounts.list();
    players = (list.accounts || []).map((a) => a.name);
  } catch {
    players = [];
  }
  cached = { at: Date.now(), fn: createRedactor({ players }) };
  return cached.fn;
}

function resetCache() {
  cached = null;
}

module.exports = { createRedactor, currentRedactor, resetCache };
