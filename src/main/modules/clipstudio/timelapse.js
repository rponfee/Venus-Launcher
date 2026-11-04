'use strict';
// Timelapse: mientras se juega, una imagen de la ventana del juego cada N segundos en
// <instancia>/timelapse/<mundo o servidor>/<fecha>.jpg. Apagado por defecto y por instancia. Las dependencias se pasan
// de afuera para probarlo con node:test: { grab, activityOf, config, usage, freeBytes, write, stamp, notify, now, emit }.
//   grab(instanceId) -> { data, width, height } · activityOf(instanceId) -> actividad de core/game
//   config(instanceId) -> ajustes normalizados · usage(instanceId) -> bytes de timelapse/ de la instancia
//   freeBytes(instanceId) -> bytes libres o null · write(instanceId, carpeta, nombre, datos) · notify(clave)
const logic = require('./timelapse-logic');

const TICK_MS = 1000;

function createTimelapse(deps) {
  const now = deps.now || Date.now;
  let session = null; // { instanceId, cfg, used, lastAt, busy, frames, folder, stopped }
  let timer = null;
  let starting = null; // identifica el inicio pendiente para descartar respuestas de una partida anterior

  function view() {
    if (!session) return { active: false };
    return { active: !session.stopped, instanceId: session.instanceId, every: session.cfg.every, folder: session.folder, frames: session.frames, used: session.used, capBytes: session.cfg.capMb * 1048576, stopped: session.stopped };
  }

  const emit = () => deps.emit?.(view());

  function stopTimer() {
    clearInterval(timer);
    timer = null;
  }

  function stopBecause(cur, reason) {
    cur.stopped = reason;
    stopTimer();
    deps.notify?.(reason === 'full' ? 'timelapseFull' : 'timelapseNoDisk');
    emit();
  }

  // Un paso: se llama cada segundo mientras hay una partida con el timelapse prendido (y desde las pruebas)
  async function tick() {
    const cur = session;
    if (!cur || cur.stopped || cur.busy) return null;
    const folder = logic.folderForActivity(deps.activityOf(cur.instanceId));
    if (folder !== cur.folder) {
      cur.folder = folder;
      emit();
    }
    // Lo barato primero: sin esto no se consulta el disco cada segundo
    const pre = logic.decide({ now: now(), lastAt: cur.lastAt, everyMs: cur.cfg.every * 1000, used: 0, capBytes: Infinity, free: null, folder, busy: false });
    if (pre.action === 'wait') return pre;
    cur.busy = true;
    try {
      const free = await Promise.resolve(deps.freeBytes(cur.instanceId)).catch(() => null);
      if (session !== cur) return { action: 'skip' };
      const res = logic.decide({ now: now(), lastAt: cur.lastAt, everyMs: cur.cfg.every * 1000, used: cur.used, capBytes: cur.cfg.capMb * 1048576, free, folder, busy: false });
      if (res.action === 'full' || res.action === 'noDisk') {
        stopBecause(cur, res.action === 'full' ? 'full' : 'noDisk');
        return res;
      }
      if (res.action !== 'capture') return res;
      cur.lastAt = now();
      const shot = await deps.grab(cur.instanceId);
      if (session !== cur || logic.folderForActivity(deps.activityOf(cur.instanceId)) !== folder || logic.isBlankFrame(shot?.data?.byteLength, shot?.width, shot?.height)) return { action: 'skip' };
      const buf = shot.data;
      if (cur.used + buf.byteLength > cur.cfg.capMb * 1048576) {
        stopBecause(cur, 'full');
        return { action: 'full' };
      }
      await deps.write(cur.instanceId, folder, deps.stamp(), buf);
      cur.used += buf.byteLength;
      cur.frames += 1;
      emit();
      return { action: 'captured' };
    } catch (err) {
      // Sin ventana, juego cerrandose, sin lugar: esa imagen se saltea y el juego no se entera
      if (err?.code === 'ENOSPC' && session === cur) stopBecause(cur, 'noDisk');
      else if (err?.code !== 'noGame' && err?.code !== 'noWindow') deps.warn?.(err);
      return { action: 'skip' };
    } finally {
      cur.busy = false;
    }
  }

  // Empezo una partida (no silenciosa) de esa instancia. Si ya hay otra andando, sigue la que empezo ultimo.
  async function start(instanceId) {
    const request = { instanceId };
    starting = request;
    const cfg = logic.normalizeConfig(await deps.config(instanceId));
    if (starting !== request) return view();
    if (!cfg.enabled) {
      starting = null;
      if (session?.instanceId === instanceId) stop(instanceId);
      return view();
    }
    const used = await Promise.resolve(deps.usage(instanceId)).catch(() => 0);
    if (starting !== request) return view();
    starting = null;
    session = { instanceId, cfg, used: Number(used) || 0, lastAt: 0, busy: false, frames: 0, folder: null, stopped: null };
    stopTimer();
    timer = setInterval(() => {
      tick().catch((err) => deps.warn?.(err));
    }, TICK_MS);
    timer.unref?.();
    emit();
    return view();
  }

  function stop(instanceId) {
    if (!instanceId || starting?.instanceId === instanceId) starting = null;
    if (!session || (instanceId && session.instanceId !== instanceId)) return;
    session = null;
    stopTimer();
    emit();
  }

  return { start, stop, tick, view };
}

module.exports = { createTimelapse };
