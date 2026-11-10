'use strict';
// Evaluacion de reglas de los JSON de versiones de Minecraft (os, arch, version, features).
// host (opcional, para las pruebas): { osName: 'windows' | 'osx' | 'linux', arch: process.arch, osVersion }.
const os = require('os');
const { OS_NAME, compareNumeric } = require('./util');

const OS_VERSION = os.release();
const HOST = Object.freeze({ osName: OS_NAME, arch: process.arch, osVersion: OS_VERSION });

function archMatches(arch, hostArch = process.arch) {
  if (!arch) return true;
  if (arch === 'x86') return hostArch === 'ia32';
  if (arch === 'x86_64' || arch === 'x64' || arch === 'amd64') return hostArch === 'x64';
  if (arch === 'arm64' || arch === 'aarch64') return hostArch === 'arm64';
  return arch === hostArch;
}

function ruleMatches(rule, features = {}, host = HOST) {
  if (rule.os) {
    const o = rule.os;
    if (o.name && o.name !== host.osName) return false;
    if (o.arch && !archMatches(o.arch, host.arch)) return false;
    if (o.version) {
      try {
        if (!new RegExp(o.version).test(host.osVersion)) return false;
      } catch {
        return false;
      }
    }
    if (o.versionRange) {
      if (o.versionRange.min && compareNumeric(host.osVersion, o.versionRange.min) < 0) return false;
      if (o.versionRange.max && compareNumeric(host.osVersion, o.versionRange.max) >= 0) return false;
    }
  }
  if (rule.features) {
    for (const [key, val] of Object.entries(rule.features)) {
      if (Boolean(features[key]) !== Boolean(val)) return false;
    }
  }
  return true;
}

function rulesAllow(rules, features, host = HOST) {
  if (!Array.isArray(rules) || !rules.length) return true;
  let allowed = false;
  for (const rule of rules) {
    if (ruleMatches(rule, features, host)) allowed = rule.action === 'allow';
  }
  return allowed;
}

// Aplana una lista de argumentos (strings u objetos {rules, value}) segun las reglas.
function flattenArgs(list, features, host = HOST) {
  const out = [];
  for (const a of list || []) {
    if (typeof a === 'string') out.push(a);
    else if (a && rulesAllow(a.rules, features, host)) out.push(...[].concat(a.value));
  }
  return out;
}

function substitute(str, vars) {
  return String(str).replace(/\$\{([^}]+)\}/g, (m, key) => (Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : m));
}

module.exports = { rulesAllow, flattenArgs, substitute, archMatches, HOST };
