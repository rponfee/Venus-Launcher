'use strict';
// Avisos del servidor por Discord: validar el webhook, armar el mensaje y la cola de envío. Sin Electron ni red
// (se prueba con Node puro, ver test/). El mensaje solo lleva el nombre del servidor y el del jugador: nunca la
// consola, una IP ni una ruta.

// Solo estos dos dominios, por https y sin nada más: el webhook lleva un secreto y no puede ir a otro lado.
const HOSTS = new Set(['discord.com', 'discordapp.com']);
const PATH_RE = /^\/api\/webhooks\/(\d{15,25})\/([A-Za-z0-9_-]{20,128})\/?$/;

/** Devuelve la dirección normalizada (a discord.com) o null si no es un webhook de Discord. */
function parseWebhook(input) {
  const text = String(input ?? '').trim();
  if (!text || text.length > 300) return null;
  let u;
  try {
    u = new URL(text);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || !HOSTS.has(u.hostname) || u.port || u.username || u.password || u.search || u.hash) return null;
  const m = PATH_RE.exec(u.pathname);
  if (!m) return null;
  return { url: `https://discord.com/api/webhooks/${m[1]}/${m[2]}`, id: m[1] };
}

// Para mostrar sin el secreto
const maskWebhook = (id) => `discord.com/api/webhooks/${id}/••••••`;

const KINDS = ['started', 'stopped', 'crashed', 'join', 'leave', 'backup'];
const COLORS = { started: 0x57c97a, stopped: 0x9a8f85, crashed: 0xe5534b, join: 0x5b9dff, leave: 0x7c8aa5, backup: 0xf2bd4e, test: 0xff9a3d };
const DEFAULT_EVENTS = Object.freeze({ started: true, stopped: true, crashed: true, join: false, leave: false, backup: false });

function normalizeEvents(events) {
  const out = {};
  for (const k of KINDS) out[k] = typeof events?.[k] === 'boolean' ? events[k] : DEFAULT_EVENTS[k];
  return out;
}

// Controles y caracteres invisibles o de dirección de texto (armados con String.fromCharCode: ver arquitectura §8)
const INVISIBLE = new RegExp(`[${[[0, 31], [127, 159], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f], [0xfeff, 0xfeff]].map(([a, b]) => `${String.fromCharCode(a)}-${String.fromCharCode(b)}`).join('')}]`, 'g');
const ZWSP = String.fromCharCode(0x200b);

// Texto no confiable (nombres de jugadores y de servidor): sin controles, sin formato de Markdown, sin menciones
// visibles ni enlaces, y con largo acotado. allowed_mentions ya evita que alguien reciba una notificación.
function cleanText(value, max = 64) {
  const text = String(value ?? '').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim().slice(0, max);
  return text
    .replace(/[\\*_~`|>#[\]()-]/g, '\\$&')
    .replace(/@/g, `@${ZWSP}`)
    .replace(/:\/\//g, `:${ZWSP}//`)
    .replace(/discord\.gg/gi, (m) => m.replace('.', `${ZWSP}.`));
}

/**
 * Cuerpo del pedido a Discord. t: traductor ('serverremote.*'). Solo lee server y player: aunque le pasen más datos,
 * no llegan al mensaje.
 */
function buildMessage(kind, { server, player } = {}, t) {
  const vars = { server: cleanText(server), player: cleanText(player, 32) };
  const embed = { title: t(`serverremote.discord_${kind}`, vars).slice(0, 256), color: COLORS[kind] ?? COLORS.test, timestamp: new Date().toISOString() };
  if (kind === 'test') embed.description = t('serverremote.discord_testText', vars);
  return { username: 'Venus Launcher', allowed_mentions: { parse: [] }, embeds: [embed] };
}

// ---------- Cola ----------
const MAX_RETRY_MS = 15 * 60000;
const DEFAULT_INTERVAL_MS = 2100; // Discord admite unos 30 mensajes por minuto en un canal

/**
 * Cola de mensajes de un webhook: uno por vez, con espacio entre pedidos, tope de pendientes y reintentos. enqueue()
 * vuelve al instante: el servidor nunca espera a Discord.
 *   send(payload) -> Promise<{ status, retryAfterMs?, remaining?, resetAfterMs? }> (o lanza si falla la red)
 *   onResult({ ok, code?, payload, retries }) se llama con cada mensaje terminado.
 * Códigos: 'invalid' (401, 403, 404: el webhook no sirve; se descarta lo pendiente hasta que reset() lo habilite),
 * 'rejected' (otro 4xx), 'retries' (se agotaron los reintentos), 'limit' (demasiados 429 seguidos), 'overflow' (se
 * descartó por el tope) y 'cleared' (se vació la cola).
 */
function createQueue({ send, onResult = () => {}, maxItems = 30, minIntervalMs = DEFAULT_INTERVAL_MS, maxRetries = 4, backoffMs = 2000, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const items = [];
  let timer = null;
  let busy = false;
  let nextAt = 0;
  let dead = false;

  const finish = (item, result) => {
    try {
      item.done?.(result);
      onResult({ ...result, payload: item.payload, retries: item.retries });
    } catch (err) {
      console.warn('[serverdiscord] resultado:', err?.message || err);
    }
  };

  function wake() {
    if (busy || timer || !items.length) return;
    const wait = Math.max(0, nextAt - now());
    timer = setTimer(() => {
      timer = null;
      pump().catch((err) => console.warn('[serverdiscord] cola:', err?.message || err));
    }, wait);
    timer?.unref?.();
  }

  async function pump() {
    if (busy || !items.length) return;
    busy = true;
    const item = items[0];
    let res = null;
    let failed = false;
    try {
      res = await send(item.payload);
    } catch {
      failed = true;
    }
    busy = false;
    nextAt = now() + minIntervalMs;
    if (items[0] !== item) {
      // Se vació la cola mientras este pedido estaba en camino: ya se le contestó
      wake();
      return;
    }
    if (!failed && res.status >= 200 && res.status < 300) {
      items.shift();
      // Discord avisa cuando se está por acabar el cupo: mejor esperar que comerse un 429
      if (res.remaining === 0 && res.resetAfterMs > 0) nextAt = Math.max(nextAt, now() + Math.min(res.resetAfterMs, MAX_RETRY_MS));
      finish(item, { ok: true });
    } else if (!failed && res.status === 429) {
      // El 429 no cuenta como intento fallido hasta el doble de reintentos, y siempre se respeta la espera que pide
      nextAt = now() + Math.min(Math.max(res.retryAfterMs || 0, 1000), MAX_RETRY_MS);
      item.limited = (item.limited || 0) + 1;
      if (item.limited > maxRetries * 2) {
        items.shift();
        finish(item, { ok: false, code: 'limit' });
      }
    } else if (!failed && [401, 403, 404].includes(res.status)) {
      dead = true;
      for (const it of items.splice(0)) finish(it, { ok: false, code: 'invalid' });
    } else if (!failed && res.status >= 400 && res.status < 500) {
      items.shift();
      finish(item, { ok: false, code: 'rejected' });
    } else {
      // Red caída o 5xx: se reintenta más tarde con espera creciente
      item.retries++;
      if (item.retries > maxRetries) {
        items.shift();
        finish(item, { ok: false, code: 'retries' });
      } else nextAt = now() + backoffMs * 2 ** (item.retries - 1);
    }
    wake();
  }

  return {
    // Devuelve una promesa que se resuelve cuando el mensaje terminó (bien o mal). Nunca lanza.
    enqueue(payload, { important = false } = {}) {
      return new Promise((resolve) => {
        const item = { payload, retries: 0, done: resolve, important };
        if (dead) {
          finish(item, { ok: false, code: 'invalid' });
          return;
        }
        if (items.length >= maxItems) {
          // Se pierde el más viejo que no esté en camino y no sea una prueba del usuario
          const i = items.findIndex((it, n) => n > 0 && !it.important);
          if (i < 0) {
            finish(item, { ok: false, code: 'overflow' });
            return;
          }
          finish(items.splice(i, 1)[0], { ok: false, code: 'overflow' });
        }
        items.push(item);
        wake();
      });
    },
    // Webhook nuevo: se puede volver a mandar
    reset() {
      dead = false;
    },
    clear() {
      if (timer) clearTimer(timer);
      timer = null;
      for (const it of items.splice(0)) finish(it, { ok: false, code: 'cleared' });
    },
    size: () => items.length,
    isDead: () => dead,
  };
}

// Lee de la respuesta de Discord lo que le importa a la cola. El header Retry-After y el campo retry_after son segundos.
async function readResponse(res) {
  const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  const out = { status: res.status };
  const remaining = num(res.headers?.get?.('x-ratelimit-remaining'));
  if (remaining !== null) out.remaining = remaining;
  const reset = num(res.headers?.get?.('x-ratelimit-reset-after'));
  if (reset !== null) out.resetAfterMs = reset * 1000;
  if (res.status === 429) {
    let seconds = num(res.headers?.get?.('retry-after'));
    if (seconds === null) {
      const body = await res.json?.().catch?.(() => null);
      seconds = num(body?.retry_after);
    }
    out.retryAfterMs = (seconds ?? 5) * 1000;
  }
  return out;
}

module.exports = { parseWebhook, maskWebhook, cleanText, buildMessage, createQueue, readResponse, normalizeEvents, KINDS, DEFAULT_EVENTS };
