// Timelapse de tu mundo: por instancia y apagado por defecto. Mientras se juega, el proceso principal guarda una imagen
// de la ventana del juego cada N segundos (modules/clipstudio/timelapse.js) en <instancia>/timelapse/<mundo o servidor>/;
// aca se elige cada cuanto y el tope de espacio, se genera el video (WebCodecs, encoder.js) con la velocidad elegida y se
// ofrece mandar las imagenes a la papelera.
import { h, icon, mount, modal, ok, fail, setBusy, switchEl, selectEl, fmtBytes, fmtDate, confirmDialog, emptyState, loading, toast } from '../../ui.js';
import { store, api } from '../../store.js';
import { t } from '../../i18n.js';
import './icons.js';
import { clock } from '../../pages/clips/common.js';
import { TIMELAPSE_SPEEDS, TIMELAPSE_DEFAULT_SPEED, planTimelapse, frameTimestamp, fitBox, outputBox, frameDate } from './logic.js';
import { FrameEncoder, pickCodec } from './encoder.js';

const C = (key, vars) => t(`clipstudio.${key}`, vars);
const EVERY = [5, 10, 15, 30, 60, 120];
const CAPS_MB = [256, 512, 1024, 2048, 5120];
const DATE_SHORT = { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' };

const everyLabel = (s) => (s < 60 ? C('everySeconds', { count: s }) : C('everyMinutes', { count: s / 60 }));
const capLabel = (mb) => fmtBytes(mb * 1048576);
// El nombre de una carpeta de servidor lleva la direccion: en modo streamer se difumina (.priv)
const isServerFolder = (name) => String(name).startsWith('server_');

/** Un cuadro de la carpeta como ImageBitmap */
async function loadFrame(instanceId, folder, name) {
  const bytes = await api.invoke('clipstudio:timelapseRead', instanceId, folder, name);
  return createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
}

/**
 * Arma el video. onProgress(0..1); signal.cancelled corta. Devuelve { path, name, duration } o null si se cancelo.
 * onJob(jobId) avisa el trabajo para poder cancelarlo.
 */
export async function buildTimelapse({ instanceId, folder, fps, every, onProgress, onJob, signal }) {
  if (signal?.cancelled) return null;
  const names = await api.invoke('clipstudio:timelapseFrames', instanceId, folder);
  const plan = planTimelapse(names.length, fps, every);
  if (!plan.frames) throw new Error(C('errNoFrames'));
  // El tamanio sale de una imagen del medio: si la ventana cambio un rato, esas quedan con franjas negras
  let sample = null;
  for (const i of [Math.floor(plan.frames / 2), plan.frames - 1, 0]) {
    sample = await loadFrame(instanceId, folder, names[i]).catch(() => null);
    if (sample) break;
  }
  if (!sample) throw new Error(C('errNoFrames'));
  const box = outputBox(sample.width, sample.height);
  sample.close?.();
  const track = await pickCodec(box.width, box.height, plan.fps);
  if (signal?.cancelled) return null;
  if (!track) throw new Error(C('errNoEncoder'));
  const { jobId } = await api.invoke('clipstudio:timelapseOpen', { instanceId, folder, width: box.width, height: box.height, codec: track, frameMs: plan.frameMs });
  let encoder = null;
  let finished = false;
  try {
    onJob?.(jobId);
    if (signal?.cancelled) return null;
    encoder = new FrameEncoder({ jobId, track, width: box.width, height: box.height, fps: plan.fps });
    const canvas = new OffscreenCanvas(box.width, box.height);
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.imageSmoothingQuality = 'high';
    let out = 0;
    for (let i = 0; i < plan.frames; i++) {
      if (signal?.cancelled) return null;
      let bmp;
      try {
        bmp = await loadFrame(instanceId, folder, names[i]);
      } catch (err) {
        // Una imagen rota no corta el video: se saltea
        console.warn('[clipstudio] imagen salteada:', names[i], err?.message || err);
        continue;
      }
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, box.width, box.height);
      const fit = fitBox(bmp.width, bmp.height, box.width, box.height);
      ctx.drawImage(bmp, fit.dx, fit.dy, fit.dw, fit.dh);
      bmp.close?.();
      const frame = new VideoFrame(canvas, { timestamp: frameTimestamp(out, plan.fps), duration: Math.round(1e6 / plan.fps) });
      try {
        await encoder.encode(frame, 2000);
      } finally {
        frame.close();
      }
      out += 1;
      onProgress?.((i + 1) / plan.frames);
    }
    await encoder.flush();
    encoder.close();
    if (signal?.cancelled) return null;
    const result = await api.invoke('clipstudio:finish', jobId);
    finished = true;
    return result;
  } catch (err) {
    if (signal?.cancelled) return null;
    throw err;
  } finally {
    encoder?.close();
    if (!finished) await api.invoke('clipstudio:cancel', jobId).catch(() => {});
  }
}

/**
 * Abre el dialogo. opts = { instanceId?, onSaved(res) }.
 */
export function openTimelapse({ instanceId: wanted = '', onSaved } = {}) {
  const insts = Array.isArray(store.instances) ? store.instances : [];
  let instanceId = wanted && insts.some((i) => i.id === wanted) ? wanted : store.settings?.selectedInstance && insts.some((i) => i.id === store.settings.selectedInstance) ? store.settings.selectedInstance : insts[0]?.id || '';
  let data = null; // { config, used, folders }
  let status = null;
  let speed = TIMELAPSE_DEFAULT_SPEED;
  let running = null; // { folder, signal, jobId }
  let alive = true;

  const content = h('div', { class: 'cs-tl-content' }, loading());
  const instSel = selectEl(insts.map((i) => ({ value: i.id, label: i.name })), instanceId, (v) => {
    instanceId = v;
    load();
  });
  instSel.setAttribute('aria-label', C('timelapseInstance'));
  const m = modal({
    title: C('timelapseTitle'),
    subtitle: C('timelapseSubtitle'),
    icon: 'clock',
    size: 'wide',
    body: h('div', { class: 'cs-tl' }, insts.length ? h('div', { class: 'cs-field' }, h('label', { class: 'cs-label' }, C('timelapseInstance')), instSel) : null, content),
    onClose: () => {
      alive = false;
      off();
      if (running) cancel();
    },
  });
  const off = api.on('clipstudio:timelapse', (s) => {
    status = s;
    if (alive && !running) draw();
  });

  async function save(patch) {
    try {
      const config = await api.invoke('clipstudio:timelapseConfig', instanceId, patch);
      if (data) data.config = config;
      draw();
    } catch (err) {
      fail(C('saveFailed'), err);
    }
  }

  function statusLine() {
    if (!status?.instanceId || status.instanceId !== instanceId) return null;
    if (status.stopped) return h('div', { class: 'notice warn' }, icon('alert'), h('div', {}, status.stopped === 'full' ? C('timelapseStoppedFull') : C('timelapseStoppedDisk')));
    if (!status.active) return null;
    return h('div', { class: 'notice good' }, icon('clock'), h('div', {}, status.folder ? h('span', { class: isServerFolder(status.folder) ? 'priv' : '' }, C('timelapseRecording', { folder: status.folder, count: status.frames })) : C('timelapseWaiting')));
  }

  function configCard() {
    const cfg = data.config;
    const everySel = selectEl(EVERY.map((s) => ({ value: String(s), label: everyLabel(s) })), String(cfg.every), (v) => save({ every: Number(v) }));
    everySel.setAttribute('aria-label', C('timelapseEvery'));
    const capSel = selectEl(CAPS_MB.map((mb) => ({ value: String(mb), label: capLabel(mb) })), String(cfg.capMb), (v) => save({ capMb: Number(v) }));
    capSel.setAttribute('aria-label', C('timelapseCap'));
    const capBytes = cfg.capMb * 1048576;
    const pct = Math.min(100, Math.round((data.used / capBytes) * 100));
    return h(
      'div',
      { class: 'cs-tl-config' },
      h('div', { class: 'toggle-row' }, h('div', { class: 'tr-text' }, h('div', { class: 'tr-title' }, C('timelapseEnable')), h('div', { class: 'tr-sub' }, C('timelapseEnableSub'))), switchEl(cfg.enabled, (v) => save({ enabled: v }), C('timelapseEnable'))),
      h('div', { class: 'cs-tl-opts' }, h('div', { class: 'cs-field' }, h('label', { class: 'cs-label' }, C('timelapseEvery')), everySel), h('div', { class: 'cs-field' }, h('label', { class: 'cs-label' }, C('timelapseCap')), capSel)),
      h('div', { class: 'cs-tl-use' }, h('div', { class: 'row between' }, h('span', {}, C('timelapseUsed')), h('span', { class: 'num' }, `${fmtBytes(data.used)} / ${capLabel(cfg.capMb)}`)), h('div', { class: 'progress', 'aria-hidden': 'true' }, h('i', { style: { width: `${pct}%` } }))),
      h('p', { class: 'cs-help' }, C('timelapseHelp')),
      statusLine(),
    );
  }

  function speedSelect(count) {
    const sel = selectEl(
      TIMELAPSE_SPEEDS.map((s) => {
        const plan = planTimelapse(count, s.fps, data.config.every);
        return { value: s.id, label: C(`speed_${s.id}`, { time: clock(plan.duration) }) };
      }),
      speed,
      (v) => {
        speed = v;
      },
    );
    sel.setAttribute('aria-label', C('timelapseSpeed'));
    return sel;
  }

  function folderRow(f) {
    const genBtn = h('button', { class: 'btn sm primary', type: 'button', disabled: Boolean(running), onclick: () => generate(f, genBtn) }, icon('csFilm'), C('timelapseGenerate'));
    const openBtn = h('button', { class: 'icon-btn sm', type: 'button', title: C('openFolder'), 'aria-label': C('openFolder'), onclick: () => api.invoke('clipstudio:timelapseOpenFolder', instanceId, f.folder).catch((err) => fail(C('openFailed'), err)) }, icon('folderOpen'));
    const delBtn = h('button', { class: 'icon-btn sm danger', type: 'button', disabled: Boolean(running), title: C('timelapseDelete'), 'aria-label': C('timelapseDelete'), onclick: () => removeFolder(f) }, icon('trash'));
    const from = frameDate(f.first);
    const to = frameDate(f.last);
    return h(
      'div',
      { class: 'cs-tl-row', role: 'listitem' },
      h(
        'div',
        { class: 'cs-mt-main' },
        h('div', { class: ['cs-mt-name', 'ellipsis', isServerFolder(f.folder) && 'priv'], title: f.folder }, f.folder),
        h('div', { class: 'cs-mt-sub' }, h('span', { class: 'num' }, C('timelapseCount', { count: f.count })), h('span', { class: 'num' }, fmtBytes(f.bytes)), from ? h('span', {}, `${fmtDate(from, DATE_SHORT)} → ${fmtDate(to, DATE_SHORT)}`) : null),
      ),
      h('div', { class: 'cs-mt-btns' }, speedSelect(f.count), genBtn, openBtn, delBtn),
    );
  }

  function progressBlock() {
    const bar = h('div', { class: 'progress' }, h('i'));
    const txt = h('span', { class: 'num' }, '0%');
    running.setProgress = (p) => {
      const pct = Math.round(Math.min(1, p) * 100);
      bar.firstChild.style.width = `${pct}%`;
      txt.textContent = `${pct}%`;
    };
    return h('div', { class: 'cs-progress', role: 'status', 'aria-live': 'polite' }, h('div', { class: 'row between' }, h('span', { class: isServerFolder(running.folder) ? 'priv' : '' }, C('timelapseGenerating', { folder: running.folder })), txt), bar, h('button', { class: 'btn sm ghost', type: 'button', onclick: () => cancel() }, t('common.cancel')));
  }

  function draw() {
    if (!alive) return;
    if (!insts.length) return mount(content, emptyState('clock', C('timelapseNoInstances'), ''));
    instSel.disabled = Boolean(running);
    if (!data) return mount(content, loading());
    mount(
      content,
      configCard(),
      running ? progressBlock() : null,
      h('h3', { class: 'cs-subtitle' }, C('timelapseFolders')),
      data.folders.length ? h('div', { class: 'cs-tl-list', role: 'list' }, data.folders.map(folderRow)) : h('p', { class: 'cs-help' }, C('timelapseNoFrames')),
    );
  }

  async function load() {
    data = null;
    draw();
    const id = instanceId;
    try {
      const [list, st] = await Promise.all([api.invoke('clipstudio:timelapseList', id), api.invoke('clipstudio:timelapseStatus').catch(() => null)]);
      if (id !== instanceId || !alive) return;
      data = list;
      status = st;
      draw();
    } catch (err) {
      if (!alive) return;
      console.warn('[clipstudio] timelapse:', err?.message || err);
      mount(content, emptyState('alert', C('loadFailed'), err?.message || ''));
    }
  }

  async function cancel() {
    if (!running) return;
    running.signal.cancelled = true;
    const id = running.jobId;
    if (id) await api.invoke('clipstudio:cancel', id).catch(() => {});
  }

  async function generate(f, btn) {
    if (running) return;
    const sourceId = instanceId;
    const def = TIMELAPSE_SPEEDS.find((s) => s.id === speed) || TIMELAPSE_SPEEDS[1];
    running = { folder: f.folder, signal: { cancelled: false }, jobId: null, setProgress: () => {} };
    const done = setBusy(btn);
    draw();
    try {
      const res = await buildTimelapse({
        instanceId: sourceId,
        folder: f.folder,
        fps: def.fps,
        every: data.config.every,
        signal: running.signal,
        onJob: (id) => {
          if (running) running.jobId = id;
        },
        onProgress: (p) => running?.setProgress(p),
      });
      running = null;
      if (!res) {
        toast('info', C('timelapseCancelled'));
        if (alive) draw();
        return;
      }
      ok(C('timelapseSaved'), res.name || '');
      onSaved?.(res);
      if (alive) draw();
      if (await confirmDialog(C('timelapseDeleteAfterTitle'), C('timelapseDeleteAfterText', { count: f.count, size: fmtBytes(f.bytes) }), { okText: C('moveToTrash'), cancelText: C('keepFrames') })) await removeFolder(f, { confirmed: true, sourceId });
    } catch (err) {
      running = null;
      fail(C('timelapseFailed'), err);
      if (alive) draw();
    } finally {
      done();
    }
  }

  async function removeFolder(f, { confirmed = false, sourceId = instanceId } = {}) {
    if (!confirmed && !(await confirmDialog(C('timelapseDeleteTitle'), C('timelapseDeleteText', { count: f.count, size: fmtBytes(f.bytes) }), { okText: C('moveToTrash'), danger: true }))) return;
    try {
      await api.invoke('clipstudio:timelapseDelete', sourceId, f.folder);
      ok(C('timelapseDeleted'));
      if (alive) load();
    } catch (err) {
      fail(C('timelapseDeleteFailed'), err);
    }
  }

  load();
  return m;
}
