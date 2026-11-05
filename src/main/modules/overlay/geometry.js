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
// Igual salvo por `tol` pixeles (el redondeo de la escala de Windows)
const nearRect = (a, b, tol = 1) => Boolean(a && b && ['x', 'y', 'width', 'height'].every((k) => Math.abs(a[k] - b[k]) <= tol));

// Que juego sigue el overlay: el que esta en primer plano; si ninguno, el ultimo que abrio su ventana.
function pickTarget(games) {
  const list = [...(games || [])].filter((g) => g?.info?.found);
  if (!list.length) return null;
  const fg = list.find((g) => g.info.foreground && g.info.foreground === g.info.hwnd);
  return fg || list.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))[0];
}

// La ventana del juego se puede cubrir: encontrada, visible, no minimizada y con tamano.
const usableInfo = (info) => Boolean(info?.found && !info.minimized && info.visible && info.rect?.width > 0 && info.rect?.height > 0);

// Decide si la ventana del overlay se ve y sobre que rectangulo.
//   enabled: overlay activado en Ajustes; userHidden: oculto con el atajo; editing / testing: modo edicion o
//   prueba (se ve aunque el juego no este en primer plano); target: juego elegido por pickTarget;
//   overlayHwnd: la ventana del overlay (si tiene el foco, el juego sigue "adelante" para el usuario); panel: hay un
//   panel abierto (recetas o asistente): se ve aunque este oculto con el atajo, siempre que el juego se pueda ver.
// Devuelve { show, mode: 'game' | 'screen' | null } ('screen': sin juego, sobre la pantalla principal).
function decide({ enabled, userHidden, editing, testing, target, overlayHwnd, panel }) {
  const info = target?.info;
  const usable = usableInfo(info);
  if (editing || testing) return { show: true, mode: usable ? 'game' : 'screen' };
  if (panel && enabled && usable) return { show: true, mode: 'game' };
  if (!enabled || userHidden || !usable) return { show: false, mode: usable ? 'game' : null };
  const front = info.foreground === info.hwnd || (overlayHwnd && info.foreground === String(overlayHwnd));
  return { show: Boolean(front), mode: 'game' };
}

// Algun juego (o el propio overlay) esta adelante? Con eso se arman los atajos globales: si el jugador esta en otra
// aplicacion, el atajo no se le saca. Mientras no se sabe nada de la ventana (el ayudante todavia arranca, o no pudo
// abrirse) se supone que si: sin esa red, el atajo no funcionaria nunca.
function gameInFront(games, overlayHwnd) {
  const list = [...(games || [])];
  if (!list.length) return false;
  return list.some((g) => {
    const info = g?.info;
    if (!info?.found) return true;
    if (info.minimized) return false;
    return Boolean(info.foreground) && (info.foreground === info.hwnd || (Boolean(overlayHwnd) && info.foreground === String(overlayHwnd)));
  });
}

module.exports = { parseLine, physicalToDip, sameRect, nearRect, pickTarget, decide, usableInfo, gameInFront };
