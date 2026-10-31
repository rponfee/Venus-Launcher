'use strict';
// Configuración incluida en el launcher: claves y servidores de servicios externos que NO se configuran desde la
// interfaz salvo el Application ID público de Discord, que se puede configurar desde Ajustes.
// LA COMPLETA EL DUEÑO ANTES DE COMPILAR. Un valor vacío deja
// esa función apagada (CurseForge, Discord Rich Presence, TURN) o usa el servicio público (bore.pub).
//
// Para desarrollo (solo con el launcher sin empaquetar, o en pruebas con Node) cada valor se puede pisar con una
// variable de entorno: VENUS_CURSEFORGE_API_KEY, VENUS_DISCORD_CLIENT_ID, VENUS_TURN_URLS (separadas por coma),
// VENUS_TURN_USERNAME, VENUS_TURN_CREDENTIAL, VENUS_BORE_HOST y VENUS_BORE_SECRET. La interfaz no las muestra.
//
// Todo lo que va acá queda dentro del instalador y se puede extraer: usá solo claves pensadas para una app de
// escritorio (la API key de CurseForge for Studios, el Application ID de Discord, un usuario TURN propio del
// launcher). Nunca claves secretas de servidores (Stripe, service_role de Supabase, Anthropic u OpenAI).
// El proyecto de Supabase está aparte, en core/cloud-defaults.js.
const BUILT_IN = Object.freeze({
  // API key de CurseForge for Studios (console.curseforge.com → API keys). Vacía = sin catálogo de CurseForge.
  curseforgeApiKey: '',
  // Application ID de la aplicación "Venus Launcher" en discord.com/developers/applications. En Rich Presence →
  // Art Assets subí una imagen cuadrada llamada "venus" (el logo). Si está vacío, puede configurarse en Ajustes.
  discordClientId: '1565473760511787028',
  // Servidores TURN del Voice Chat para redes estrictas, por ejemplo ['turn:turn.ejemplo.com:3478',
  // 'turns:turn.ejemplo.com:5349']. Vacío = solo los STUN públicos (casi todas las redes andan igual).
  turn: Object.freeze({ urls: Object.freeze([]), username: '', credential: '' }),
  // Servidor de túneles bore (github.com/ekzhang/bore) para que los amigos entren a un servidor local sin abrir
  // puertos. secret solo si el servidor lo pide (bore server --secret).
  bore: Object.freeze({ host: 'bore.pub', secret: '' }),
});

const DEFAULT_BORE = 'bore.pub';
const CLIENT_ID = /^\d{17,21}$/;
const ICE_URL = /^(turns?|stun):[^\s,]+$/i;
const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

// Las variables de entorno solo valen en desarrollo: nunca en la app empaquetada.
function devEnv() {
  try {
    const electron = require('electron');
    return !(electron && typeof electron === 'object' && electron.app && electron.app.isPackaged);
  } catch {
    return true;
  }
}

function env(name) {
  const v = process.env[name];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

const text = (v, max = 512) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function hostOf(v) {
  const s = text(v, 300).toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/[/:].*$/, '');
  return HOST.test(s) ? s : null;
}

function urlList(v) {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\s,]+/) : [];
  return list.map((u) => text(u, 300)).filter((u) => ICE_URL.test(u)).slice(0, 8);
}

// Configuración vigente (se arma en cada llamada: es barata y así respeta las variables de las pruebas).
function get() {
  const dev = devEnv();
  const pick = (name, value) => (dev && env(name) !== null ? env(name) : value);
  const clientId = text(pick('VENUS_DISCORD_CLIENT_ID', BUILT_IN.discordClientId), 32);
  return {
    curseforgeApiKey: text(pick('VENUS_CURSEFORGE_API_KEY', BUILT_IN.curseforgeApiKey), 200),
    discordClientId: CLIENT_ID.test(clientId) ? clientId : '',
    turn: {
      urls: urlList(pick('VENUS_TURN_URLS', BUILT_IN.turn.urls)),
      username: text(pick('VENUS_TURN_USERNAME', BUILT_IN.turn.username), 256),
      credential: text(pick('VENUS_TURN_CREDENTIAL', BUILT_IN.turn.credential), 512),
    },
    bore: {
      host: hostOf(pick('VENUS_BORE_HOST', BUILT_IN.bore.host)) || DEFAULT_BORE,
      secret: text(pick('VENUS_BORE_SECRET', BUILT_IN.bore.secret), 512),
    },
  };
}

module.exports = { get, devEnv, BUILT_IN, DEFAULT_BORE };
