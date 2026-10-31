'use strict';
// Evaluacion de reglas de los JSON de versiones de Minecraft (os, arch, version, features).
const os = require('os');
const { OS_NAME, compareNumeric } = require('./util');

const OS_VERSION = os.release();

function archMatches(arch) {
  if (!arch) return true;
  if (arch === 'x86') return process.arch === 'ia32';
  if (arch === 'x86_64' || arch === 'x64' || arch === 'amd64') return process.arch === 'x64';
  if (arch === 'arm64' || arch === 'aarch64') return process.arch === 'arm64';
  return arch === process.arch;
}

function ruleMatches(rule, features = {}) {
  if (rule.os) {
    const o = rule.os;
    if (o.name && o.name !== OS_NAME) return false;
    if (o.arch && !archMatches(o.arch)) return false;
    if (o.version) {
      try {
        if (!new RegExp(o.version).test(OS_VERSION)) return false;
      } catch {
        return false;
      }
    }
    if (o.versionRange) {
      if (o.versionRange.min && compareNumeric(OS_VERSION, o.versionRange.min) < 0) return false;
      if (o.versionRange.max && compareNumeric(OS_VERSION, o.versionRange.max) >= 0) return false;
    }
  }
  if (rule.features) {
    for (const [key, val] of Object.entries(rule.features)) {
      if (Boolean(features[key]) !== Boolean(val)) return false;
    }
  }
  return true;
}

function rulesAllow(rules, features) {
  if (!Array.isArray(rules) || !rules.length) return true;
  let allowed = false;
  for (const rule of rules) {
    if (ruleMatches(rule, features)) allowed = rule.action === 'allow';
  }
  return allowed;
}

// Aplana una lista de argumentos (strings u objetos {rules, value}) segun las reglas.
function flattenArgs(list, features) {
  const out = [];
  for (const a of list || []) {
    if (typeof a === 'string') out.push(a);
    else if (a && rulesAllow(a.rules, features)) out.push(...[].concat(a.value));
  }
  return out;
}

function substitute(str, vars) {
  return String(str).replace(/\$\{([^}]+)\}/g, (m, key) => (Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : m));
}

module.exports = { rulesAllow, flattenArgs, substitute, archMatches };
