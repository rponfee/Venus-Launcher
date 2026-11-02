'use strict';
// Cuentas del overlay sin Electron: lineas del ayudante que sigue la ventana del juego, paso de pixeles fisicos
// a DIP (puntos independientes de la escala de Windows), que juego seguir y si la ventana se muestra.

const int = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : null);

// Linea JSON del ayudante -> estado de la ventana del juego (o null si la linea no sirve).
//   { ok: 0 }                               todavia no hay ventana
//   { ok: 1, hwnd, fgw, x, y, w, h, min, vis, full, dpi }   rectangulo del area de juego en pixeles fisicos
//   { end: 1 }                              el ayudante termino (se cerro el juego o el launcher)
function parseLine(line) {
  let d;
  try {
    d = JSON.parse(String(line).trim());
  } catch {
    return null;
  }
  if (!d || typeof d !== 'object') return null;
  if (d.end) return { end: true };
  if (!d.ok) return { found: false };
  const rect = { x: int(d.x), y: int(d.y), width: int(d.w), height: int(d.h) };
  if (Object.values(rect).some((v) => v === null)) return null;
  return {
    found: true,
    hwnd: String(d.hwnd ?? ''),
    foreground: String(d.fgw ?? ''),
    rect,
    minimized: d.min === 1 || d.min === true,
    visible: d.vis !== 0 && d.vis !== false,
    fullscreen: d.full === 1 || d.full === true,
    dpi: int(d.dpi) || 96,
  };
}

// Rectangulo fisico -> DIP con la lista de pantallas de Electron (respaldo de screen.screenToDipRect).
// Cada pantalla: { bounds (DIP), scaleFactor, nativeOrigin? (origen fisico) }. Sin nativeOrigin se supone
// que el origen fisico es el de bounds multiplicado por la escala (pantallas en fila, sin huecos).
function physicalToDip(rect, displays) {
  const list = (Array.isArray(displays) ? displays : []).filter((d) => d?.bounds && d.scaleFactor > 0);
  if (!list.length) return { ...rect };
  const phys = list.map((d) => {
    const s = d.scaleFactor;
    const ox = Number.isFinite(d.nativeOrigin?.x) ? d.nativeOrigin.x : d.bounds.x * s;
    const oy = Number.isFinite(d.nativeOrigin?.y) ? d.nativeOrigin.y : d.bounds.y * s;
    return { d, s, x: ox, y: oy, width: d.bounds.width * s, height: d.bounds.height * s };
  });
  // La pantalla que tiene el centro del rectangulo; si ninguna, la mas cercana.
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const dist = (p) => {
    const dx = cx < p.x ? p.x - cx : cx > p.x + p.width ? cx - (p.x + p.width) : 0;
    const dy = cy < p.y ? p.y - cy : cy > p.y + p.height ? cy - (p.y + p.height) : 0;
    return dx * dx + dy * dy;
  };
  const best = phys.reduce((a, b) => (dist(b) < dist(a) ? b : a));
  return {
    x: Math.round(best.d.bounds.x + (rect.x - best.x) / best.s),
    y: Math.round(best.d.bounds.y + (rect.y - best.y) / best.s),
    width: Math.max(1, Math.round(rect.width / best.s)),
    height: Math.max(1, Math.round(rect.height / best.s)),
  };
}

const sameRect = (a, b) => Boolean(a && b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height);

// Que juego sigue el overlay: el que esta en primer plano; si ninguno, el ultimo que abrio su ventana.
function pickTarget(games) {
  const list = [...(games || [])].filter((g) => g?.info?.found);
  if (!list.length) return null;
  const fg = list.find((g) => g.info.foreground && g.info.foreground === g.info.hwnd);
  return fg || list.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))[0];
}

// Decide si la ventana del overlay se ve y sobre que rectangulo.
//   enabled: overlay activado en Ajustes; userHidden: oculto con el atajo; editing / testing: modo edicion o
//   prueba (se ve aunque el juego no este en primer plano); target: juego elegido por pickTarget;
//   overlayHwnd: la ventana del overlay (si tiene el foco, el juego sigue "adelante" para el usuario).
// Devuelve { show, mode: 'game' | 'screen' | null } ('screen': sin juego, sobre la pantalla principal).
function decide({ enabled, userHidden, editing, testing, target, overlayHwnd }) {
  const info = target?.info;
  const usable = Boolean(info?.found && !info.minimized && info.visible && info.rect?.width > 0 && info.rect?.height > 0);
  if (editing || testing) return { show: true, mode: usable ? 'game' : 'screen' };
  if (!enabled || userHidden || !usable) return { show: false, mode: usable ? 'game' : null };
  const front = info.foreground === info.hwnd || (overlayHwnd && info.foreground === String(overlayHwnd));
  return { show: Boolean(front), mode: 'game' };
}

module.exports = { parseLine, physicalToDip, sameRect, pickTarget, decide };
