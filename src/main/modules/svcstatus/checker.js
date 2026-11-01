'use strict';
// Estado de los servicios: corre las consultas en paralelo, guarda los resultados un rato (cacheMs) para no
// volver a consultar si se pide de nuevo enseguida y nunca hace dos rondas a la vez. Sin Electron: fetch,
// reloj, modo sin conexión y definiciones se inyectan (las pruebas usan versiones falsas).
//
// connectivity:
//  'always'  también se prueba la conexión (Cloudflare). Es lo que hace el panel, que abre el usuario.
//  'auto'    primero solo los servicios pedidos; la prueba de conexión corre solo si ninguno contestó
//            (si alguno contestó, internet anda y no hace falta consultar a nadie más). Es lo de después de un error.
const { probeService } = require('./probe');
const { pickIds, IDS } = require('./services');
const { computeVerdict } = require('./verdict');

const DEFAULTS = { cacheMs: 20000, timeoutMs: 6000, slowMs: 2500 };

function createChecker({ fetch, now = Date.now, isOffline = () => false, defs, cacheMs = DEFAULTS.cacheMs, timeoutMs = DEFAULTS.timeoutMs, slowMs = DEFAULTS.slowMs } = {}) {
  if (typeof fetch !== 'function') throw new TypeError('fetch');
  if (typeof defs !== 'function') throw new TypeError('defs');
  const cache = new Map(); // id -> { result, at }
  let running = null;
  let sweeps = 0;

  const ctx = { fetch, now, timeoutMs, slowMs };
  const fresh = (id) => {
    const c = cache.get(id);
    return Boolean(c) && now() - c.at < cacheMs;
  };
  // Algún servicio pedido contestó por HTTP (aunque sea con un 5xx): entonces internet anda.
  const anyAnswered = (list) => list.some((d) => fresh(d.id) && Number(cache.get(d.id).result.httpStatus) > 0);

  async function sweep(list) {
    if (!list.length) return;
    sweeps++;
    const results = await Promise.all(
      list.map((d) =>
        probeService(d, ctx).catch(() => ({ id: d.id, group: d.group, state: 'down', ms: null, reason: 'network', detail: 'network' })),
      ),
    );
    const at = now();
    results.forEach((r, i) => cache.set(list[i].id, { result: { ...r, at }, at }));
  }

  // Lo que falta consultar para este pedido (null = nada: alcanza con lo guardado).
  function plan(all, wanted, connectivity) {
    const inet = all.find((d) => d.id === 'internet');
    const stale = wanted.filter((d) => !d.skip && !fresh(d.id));
    if (connectivity === 'always') {
      const list = inet && !fresh('internet') ? [...stale, inet] : stale;
      return list.length ? () => sweep(list) : null;
    }
    const needInet = () => inet && !fresh('internet') && !anyAnswered(wanted.filter((d) => !d.skip));
    if (!stale.length && !needInet()) return null;
    return async () => {
      await sweep(stale);
      if (needInet()) await sweep([inet]);
    };
  }

  // failed: servicios que el launcher acaba de ver fallar de su lado (un 5xx al iniciar sesión o en una descarga).
  // Si la consulta de ahora contesta bien igual (la raíz anda y lo de atrás no), manda lo que pasó de verdad: va
  // como caído con motivo 'failed'. Solo en este resumen (copias): lo guardado no cambia.
  function summarize(all, wanted, ranSweep, failed = new Set()) {
    const results = [];
    for (const d of wanted) {
      if (d.skip) results.push({ id: d.id, group: d.group, state: 'skipped', ms: null, reason: d.skip });
      else if (fresh(d.id)) {
        const r = cache.get(d.id).result;
        results.push(failed.has(d.id) && (r.state === 'ok' || r.state === 'slow') ? { ...r, state: 'down', reason: 'failed', detail: null } : r);
      }
    }
    // Algún servicio contestó por HTTP (aunque sea con un error): internet anda. Alguno rápido: no está lenta.
    const answered = results.some((r) => Number(r.httpStatus) > 0);
    const fastOne = results.some((r) => r.state === 'ok');
    // La prueba de conexión entra si está fresca (en 'auto' puede venir de una ronda anterior del panel).
    const inet = all.find((d) => d.id === 'internet');
    let inetRes = inet && fresh('internet') ? cache.get('internet').result : null;
    // Cloudflare no contestó (bloqueado en esa red o caído) pero otros servicios sí: la conexión anda. Va como
    // deducida (una copia: lo guardado no se toca) para que el panel no diga "no responde" ni culpe a tu internet.
    if (inetRes && inetRes.state === 'down' && answered) inetRes = { id: inetRes.id, group: inetRes.group, state: 'ok', ms: null, inferred: true, at: inetRes.at };
    if (inetRes) results.unshift(inetRes);
    let internet = 'unknown';
    if (inetRes) internet = inetRes.state === 'down' ? 'down' : 'ok';
    else if (answered) internet = 'ok';
    const ats = results.map((r) => r.at).filter((a) => typeof a === 'number');
    const summary = {
      offlineMode: false,
      internet,
      internetReason: inetRes && inetRes.state === 'down' ? inetRes.reason || 'network' : null,
      internetSlow: Boolean(inetRes && inetRes.state === 'slow' && !fastOne),
      dns: inetRes ? (inetRes.dns === 'down' ? 'down' : inetRes.state === 'down' ? 'unknown' : 'ok') : 'unknown',
      checkedAt: ats.length ? Math.min(...ats) : now(),
      nextCheckAt: ats.length ? Math.max(...ats) + cacheMs : now(),
      cached: !ranSweep,
      results,
    };
    summary.verdict = computeVerdict(summary, wanted.map((d) => d.id));
    return summary;
  }

  function offlineSummary(all, wanted) {
    const at = now();
    const list = [all.find((d) => d.id === 'internet'), ...wanted].filter(Boolean);
    return {
      offlineMode: true,
      internet: 'unknown',
      internetReason: null,
      internetSlow: false,
      dns: 'unknown',
      checkedAt: at,
      nextCheckAt: at,
      cached: false,
      results: list.map((d) => ({ id: d.id, group: d.group, state: 'skipped', ms: null, reason: 'offline' })),
      verdict: { kind: 'offline', ids: [] },
    };
  }

  // check({ ids?, connectivity?, failed? }) -> resumen (ver svcstatus.js). Nunca lanza por un servicio caído.
  async function check({ ids, connectivity = 'always', failed = null } = {}) {
    const all = defs();
    const picked = pickIds(ids);
    const mode = connectivity === 'auto' && !picked.includes('internet') ? 'auto' : 'always';
    const wanted = all.filter((d) => d.id !== 'internet' && picked.includes(d.id));
    const failedIds = new Set((Array.isArray(failed) ? failed : []).filter((id) => typeof id === 'string' && id !== 'internet' && IDS.includes(id)));
    if (await isOffline()) return offlineSummary(all, wanted);
    let ranSweep = false;
    // Una sola ronda a la vez: si hay otra en curso, se espera y se vuelve a mirar qué falta.
    for (let i = 0; i < 6; i++) {
      if (running) {
        await running.catch(() => {});
        continue;
      }
      const job = plan(all, wanted, mode);
      if (!job) break;
      ranSweep = true;
      running = job().finally(() => {
        running = null;
      });
      await running.catch(() => {});
      break;
    }
    return summarize(all, wanted, ranSweep, failedIds);
  }

  return { check, stats: () => ({ sweeps, cached: cache.size, running: Boolean(running) }), clear: () => cache.clear() };
}

module.exports = { createChecker, DEFAULTS };
