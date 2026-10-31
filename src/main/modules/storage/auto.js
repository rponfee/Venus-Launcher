'use strict';
// Unificacion automatica de duplicados (settings.storage.autoDedupe): al abrir el launcher, despues de
// rafagas de cambios en mods/resourcepacks/shaderpacks/plugins y cada media hora. Siempre en segundo plano,
// solo cuando no hay tareas ni descargas, y sin tocar instancias abiertas ni servidores encendidos.
const fs = require('fs');
const paths = require('../../core/paths');
const tasks = require('../../core/tasks');

const STARTUP_DELAY = 90 * 1000;
const BURST_DELAY = 45 * 1000;
const RETRY_DELAY = 2 * 60 * 1000;
const PERIODIC = 30 * 60 * 1000;
// <id>/mods/x.jar (las rutas que informa fs.watch son relativas a instances/ o servers/)
const RELEVANT = /^[^\\/]+[\\/](mods|resourcepacks|shaderpacks|plugins)[\\/][^\\/]+$/i;
const ARCHIVE = /\.(jar|zip|mrpack)(\.disabled)?$/i;

// delays: tiempos de espera (se pueden acortar para probar).
function createAuto({ run, canRun, onResult, delays = {} }) {
  const STARTUP = delays.startup ?? STARTUP_DELAY;
  const BURST = delays.burst ?? BURST_DELAY;
  const RETRY = delays.retry ?? RETRY_DELAY;
  const EVERY = delays.periodic ?? PERIODIC;
  let enabled = false;
  let timer = null;
  let periodic = null;
  let watchers = [];
  let quietUntil = 0;
  let running = false;

  function schedule(ms) {
    if (!enabled) return;
    clearTimeout(timer);
    timer = setTimeout(fire, ms);
    timer.unref?.();
  }

  async function fire() {
    timer = null;
    if (!enabled || running) return;
    if (!canRun()) {
      schedule(RETRY);
      return;
    }
    running = true;
    quietUntil = Infinity; // los propios renombrados no disparan otra pasada
    try {
      onResult(await run());
    } catch (err) {
      console.warn('[storage] Unificación automática:', err?.message || err);
    } finally {
      running = false;
      quietUntil = Date.now() + 5000;
    }
  }

  const onTask = (task) => {
    if (enabled && task.state === 'done' && (task.meta?.instanceId || task.meta?.serverId)) schedule(BURST);
  };

  function watch() {
    // En Windows y macOS el seguimiento recursivo es nativo y barato; en Linux alcanza con las tareas y el repaso periodico.
    if (process.platform !== 'win32' && process.platform !== 'darwin') return;
    for (const base of [paths.instances(), paths.servers()]) {
      try {
        const w = fs.watch(base, { recursive: true, persistent: false }, (ev, name) => {
          if (!name || Date.now() < quietUntil) return;
          const rel = String(name);
          if (RELEVANT.test(rel) && ARCHIVE.test(rel)) schedule(BURST);
        });
        w.on('error', () => {
          try {
            w.close();
          } catch {
            /* ya cerrado */
          }
          watchers = watchers.filter((x) => x !== w);
        });
        watchers.push(w);
      } catch (err) {
        console.warn('[storage] No se pueden seguir los cambios de', base, err?.code || err?.message);
      }
    }
  }

  function unwatch() {
    for (const w of watchers) {
      try {
        w.close();
      } catch {
        /* ya cerrado */
      }
    }
    watchers = [];
  }

  function setEnabled(on, { startup = false } = {}) {
    const next = Boolean(on);
    if (next === enabled) return;
    enabled = next;
    if (enabled) {
      tasks.bus.on('update', onTask);
      watch();
      periodic = setInterval(() => schedule(1000), EVERY);
      periodic.unref?.();
      schedule(startup ? STARTUP : BURST);
    } else {
      tasks.bus.off('update', onTask);
      unwatch();
      clearInterval(periodic);
      periodic = null;
      clearTimeout(timer);
      timer = null;
    }
  }

  return {
    setEnabled,
    isEnabled: () => enabled,
    isRunning: () => running,
    stop: () => setEnabled(false),
  };
}

module.exports = { createAuto };
