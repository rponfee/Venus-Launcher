// Resumen al cerrar el juego (3.1, settings.play.sessionRecap, true por defecto): cuando game:state pasa a cerrado,
// un modal chico con la duracion de la sesion, la instancia, las capturas y clips guardados en ese rato
// (capture:saved, con worlds:media por fecha de respaldo), los logros desbloqueados (venus:achievement) y las
// misiones completadas (misiones que llegaron a su objetivo mientras se jugaba, con venus:mission de por medio), y
// un boton "Ver estadisticas". Las partidas de prueba (quiet), las de menos de un minuto y las que terminan en crash
// (ya tienen su propio dialogo) no muestran nada.
import { h, icon, modal, fmtDuration, ensureCss } from '../../ui.js';
import { store, api } from '../../store.js';
import { t, loadNs } from '../../i18n.js';
import { navigate } from '../../app.js';

const T = (key, vars) => t(`tools.${key}`, vars);
const MIN_SESSION_MS = 60 * 1000;
const MEDIA_SLACK_MS = 5000;

let started = false;
const sessions = new Map(); // instanceId -> { startedAt, shots, clips, achievements: Set, missionEvents, missionsBefore }

const enabled = () => store.settings?.play?.sessionRecap !== false;

// Misiones que ya llegaron a su objetivo (claves 'periodo:id'), con features/missions.js si esta.
async function completedMissions() {
  try {
    const m = await import('../missions.js');
    const data = m.getMissions?.()?.data;
    const out = new Set();
    for (const period of ['daily', 'weekly']) {
      for (const x of data?.[period]?.missions || []) if (x.claimed || m.missionValue(period, x.metric) >= x.target) out.add(`${period}:${x.id}`);
    }
    return out;
  } catch {
    return new Set();
  }
}

async function begin(id, st) {
  const s = { startedAt: Number(st.startedAt) || Date.now(), shots: 0, clips: 0, achievements: new Set(), missionEvents: 0, missionsBefore: new Set() };
  sessions.set(id, s);
  s.missionsBefore = await completedMissions();
}

// Capturas y clips guardados en la carpeta de la instancia desde que empezo la sesion (si los eventos se perdieron).
async function mediaCounts(id, since) {
  try {
    const r = await api.invoke('worlds:media', { instanceId: id, kind: 'all', limit: 200 });
    let shots = 0;
    let clips = 0;
    for (const it of r?.items || []) {
      const at = Number(it.time || it.mtime) || 0;
      if (at < since - MEDIA_SLACK_MS) continue;
      if (it.kind === 'clip') clips++;
      else shots++;
    }
    return { shots, clips };
  } catch {
    return null;
  }
}

async function achievementLabel(id) {
  try {
    const m = await import('../../pages/achievements/names.js');
    await loadNs('achievements').catch(() => {});
    return m.achievementName(id);
  } catch {
    return String(id).replace(/_/g, ' ');
  }
}

async function finish(id, s, st) {
  if (!enabled() || st.state === 'crashed') return;
  const endedAt = Date.now();
  const duration = endedAt - s.startedAt;
  if (duration < MIN_SESSION_MS) return;
  await loadNs('tools').catch(() => {});
  ensureCss('pages/tools');
  const inst = store.instances.find((i) => i.id === id);
  const [after, media] = await Promise.all([completedMissions(), mediaCounts(id, s.startedAt)]);
  const missions = [...after].filter((k) => !s.missionsBefore.has(k)).length;
  const shots = Math.max(s.shots, media?.shots || 0);
  const clips = Math.max(s.clips, media?.clips || 0);
  const names = await Promise.all([...s.achievements].slice(0, 8).map(achievementLabel));

  const tile = (ic, label, value) => h('div', { class: 'tools-recap-tile' }, h('span', { class: 'tools-recap-ic' }, icon(ic)), h('div', { class: 'tools-recap-text' }, h('div', { class: 'tools-recap-val' }, value), h('div', { class: 'tools-recap-lab' }, label)));
  const body = h(
    'div',
    { class: 'tools-recap' },
    h('div', { class: 'tools-recap-hero' }, icon('clock'), h('div', {}, h('div', { class: 'tools-recap-big' }, T('recapDuration', { time: fmtDuration(duration) })), inst ? h('div', { class: 'muted small' }, `${T('recapInstance')}: ${inst.name}`) : null)),
    h('div', { class: 'tools-recap-grid' }, tile('camera', T('recapCaptures'), String(shots)), tile('play', T('recapClips'), String(clips)), tile('trophy', T('recapAchievements'), String(s.achievements.size)), tile('star', T('recapMissions'), String(missions))),
    s.achievements.size
      ? h('div', { class: 'tools-recap-list' }, h('div', { class: 'label' }, T('recapAchievements')), h('ul', {}, names.map((n) => h('li', {}, icon('trophy'), h('span', {}, n)))))
      : h('div', { class: 'muted small' }, `${T('recapAchievements')}: ${T('recapNone')}`),
  );
  const dlg = modal({
    title: T('recapTitle'),
    subtitle: inst?.name || null,
    icon: 'gamepad',
    body,
    footer: [
      h('button', { type: 'button', class: 'btn ghost', onclick: () => dlg.close() }, T('recapClose')),
      h(
        'button',
        {
          type: 'button',
          class: 'btn primary',
          onclick: () => {
            dlg.close();
            navigate('stats');
          },
        },
        icon('chart'),
        T('recapStats'),
      ),
    ],
  });
}

export function startup() {
  if (started) return;
  started = true;
  // Juegos que ya estaban abiertos al cargar la interfaz (recarga con Ctrl+Mayus+R)
  for (const [id, r] of Object.entries(store.running || {})) if (r?.state === 'running' && !r.quiet && !sessions.has(id)) begin(id, r);
  api.on('game:state', (id, st) => {
    if (!st || st.quiet) return;
    if (st.state === 'running') {
      if (!sessions.has(id)) begin(id, st);
    } else if (st.state !== 'preparing') {
      const s = sessions.get(id);
      sessions.delete(id);
      if (s) finish(id, s, st).catch((err) => console.warn('[tools] resumen', err));
    }
  });
  api.on('capture:saved', (evt) => {
    if (!evt) return;
    const s = (evt.instanceId && sessions.get(evt.instanceId)) || [...sessions.values()][0];
    if (!s) return;
    if (evt.type === 'screenshot') s.shots++;
    else s.clips++;
  });
  window.addEventListener('venus:achievement', (e) => {
    const id = e?.detail?.id;
    if (typeof id === 'string') for (const s of sessions.values()) s.achievements.add(id);
  });
  window.addEventListener('venus:mission', () => {
    for (const s of sessions.values()) s.missionEvents++;
  });
}

// Para las pruebas manuales desde la consola: un resumen de ejemplo sin cerrar un juego.
export function previewRecap(instanceId) {
  const id = instanceId || store.selectedInstance()?.id;
  if (!id) return undefined;
  const s = { startedAt: Date.now() - 47 * 60 * 1000 - MIN_SESSION_MS, shots: 3, clips: 1, achievements: new Set(['first_overlay']), missionEvents: 2, missionsBefore: new Set() };
  return finish(id, s, { state: 'stopped' });
}
