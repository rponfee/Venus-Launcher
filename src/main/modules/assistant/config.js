'use strict';
// Configuracion del asistente en archivos JSON junto a este modulo:
//   permissions.json        herramienta -> 'read' | 'reversible' | 'destructive'
//   jvm-args.json           lista blanca de argumentos de JVM (por id)
//   options-whitelist.json  opciones de options.txt permitidas, con tipo y rango
//   plans.json              catalogo de planes de respaldo (sin conexion; el del backend tiene prioridad)
// Los archivos se validan al leerlos: lo que no cumple el formato se descarta (nunca se "relaja" una regla).
const fs = require('fs');
const path = require('path');

const LEVELS = ['read', 'reversible', 'destructive'];
const PRESETS = ['g1', 'aikar', 'zgc', 'auto', 'none'];
// Argumentos que acepta jvm-args.json: flags -XX: que se prenden o apagan (-XX:+Nombre / -XX:-Nombre) o que
// llevan solo un numero (-XX:Nombre=200, con k/m/g) y -Xss. Nada de -D (configurationFile, library.path...) ni
// de opciones que ejecutan comandos o leen o escriben archivos (OnError, OnOutOfMemoryError, *File, *Path...).
const JVM_ARG = /^-(?:XX:(?:[+-][A-Za-z]\w*|[A-Za-z]\w*=\d+[kKmMgG]?)|Xss\d+[kKmM]?)$/;
const JVM_BLOCKED = /^-XX:[+-]?(?:On\w*|\w*(?:File|Path)|VMOptionsFile|Flags)(?:=|$)/;

function jvmArgAllowed(arg) {
  return typeof arg === 'string' && JVM_ARG.test(arg) && !JVM_BLOCKED.test(arg);
}

let cache = {};

function readConfig(name) {
  if (!(name in cache)) {
    try {
      cache[name] = JSON.parse(fs.readFileSync(path.join(__dirname, name), 'utf8'));
    } catch (err) {
      console.error(`[assistant] No se pudo leer ${name}:`, err.message);
      cache[name] = null;
    }
  }
  return cache[name];
}

function reload() {
  cache = {};
}

// herramienta -> nivel (solo niveles validos)
function permissions() {
  const raw = readConfig('permissions.json')?.tools || {};
  const out = {};
  for (const [tool, level] of Object.entries(raw)) if (LEVELS.includes(level)) out[tool] = level;
  return out;
}

function levelRank(level) {
  return LEVELS.indexOf(level);
}

// Nivel efectivo: el de la configuracion, pero nunca por debajo del minimo propio de la herramienta.
function effectiveLevel(tool, minLevel) {
  const configured = permissions()[tool];
  if (!configured) return null;
  return levelRank(configured) >= levelRank(minLevel) ? configured : minLevel;
}

function jvmFlags() {
  const raw = readConfig('jvm-args.json')?.flags;
  const out = [];
  const seen = new Set();
  for (const f of Array.isArray(raw) ? raw : []) {
    if (!f || typeof f.id !== 'string' || !/^[a-z0-9_]{2,40}$/.test(f.id) || seen.has(f.id)) continue;
    const isGc = f.group === 'gc';
    if (isGc && !PRESETS.includes(f.preset)) continue;
    const args = Array.isArray(f.args) ? f.args.filter((a) => typeof a === 'string') : [];
    if (args.some((a) => !jvmArgAllowed(a))) {
      console.warn(`[assistant] jvm-args.json: "${f.id}" tiene argumentos no permitidos y se ignora`);
      continue;
    }
    if (!isGc && !args.length) continue;
    seen.add(f.id);
    out.push({
      id: f.id,
      group: isGc ? 'gc' : null,
      preset: isGc ? f.preset : null,
      args: isGc ? [] : args,
      minJava: Number.isInteger(f.minJava) ? f.minJava : 8,
      maxJava: Number.isInteger(f.maxJava) ? f.maxJava : null,
      label: f.label && typeof f.label === 'object' ? f.label : { es: f.id, en: f.id },
      description: typeof f.description === 'string' ? f.description : '',
    });
  }
  return out;
}

const OPTION_TYPES = ['int', 'float', 'bool', 'enum', 'enumInt', 'fov'];

function optionKeys() {
  const raw = readConfig('options-whitelist.json')?.keys || {};
  const out = {};
  for (const [key, def] of Object.entries(raw)) {
    if (!/^[A-Za-z][\w]{1,40}$/.test(key) || !def || !OPTION_TYPES.includes(def.type)) continue;
    if ((def.type === 'int' || def.type === 'float' || def.type === 'fov') && !(Number.isFinite(def.min) && Number.isFinite(def.max))) continue;
    if (def.type === 'enum' && !(Array.isArray(def.values) && def.values.length)) continue;
    if (def.type === 'enumInt' && !(def.values && typeof def.values === 'object')) continue;
    out[key] = def;
  }
  return out;
}

const PLAN_MODELS = ['haiku', 'sonnet', 'opus'];
const PLAN_EFFORTS = ['low', 'medium', 'high', 'xhigh'];
const count = (n) => (Number.isInteger(n) && n >= 0 ? n : null);
const money = (n) => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null);

// Catalogo local con la misma forma que el del backend:
// [{ id, name, priceUsd, budgetUsd, models: [{ id, label, efforts, daily, weekly }] }]
function plans(lang) {
  const raw = readConfig('plans.json');
  const list = [];
  for (const p of Array.isArray(raw?.plans) ? raw.plans : []) {
    if (!p || typeof p.id !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(p.id) || list.some((x) => x.id === p.id)) continue;
    const models = (Array.isArray(p.models) ? p.models : [])
      .filter((m, i, all) => m && PLAN_MODELS.includes(m.id) && all.findIndex((x) => x?.id === m.id) === i)
      .map((m) => ({
        id: m.id,
        label: typeof m.label === 'string' && m.label ? m.label : m.id,
        efforts: PLAN_EFFORTS.filter((e) => Array.isArray(m.efforts) && m.efforts.includes(e)),
        daily: count(m.daily),
        weekly: count(m.weekly),
      }))
      .filter((m) => m.efforts.length);
    if (!models.length) continue;
    const name = typeof p.name === 'string' ? p.name : p.name && typeof p.name === 'object' ? p.name[lang] || p.name.en : null;
    list.push({ id: p.id, name: name || p.id, priceUsd: money(p.priceUsd), budgetUsd: money(p.budgetUsd), maxTokensPerRequest: count(p.maxTokensPerRequest), models });
  }
  return { placeholder: raw?.placeholder !== false, plans: list };
}

module.exports = { LEVELS, permissions, effectiveLevel, levelRank, jvmFlags, jvmArgAllowed, optionKeys, plans, reload };
