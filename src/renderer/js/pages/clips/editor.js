// Editor rapido de clips: recortar inicio y fin y exportar en horizontal o en vertical 9:16 (TikTok, Shorts,
// Reels) con el recorte centrado o elegido (deslizador o arrastrando el recuadro). Re-codifica en la interfaz:
// el video se reproduce una vez en un <video> oculto, cada cuadro se dibuja recortado en un canvas y
// MediaRecorder graba el canvas + el audio (WebM). Tarda lo mismo que dura el tramo elegido. El proceso
// principal (capture:saveExport) le agrega duracion e indice y lo guarda en <instancia>/clips/.
import { h, icon, mount, modal, ok, fail, confirmDialog, setBusy } from '../../ui.js';
import { api } from '../../store.js';
import { t } from '../../i18n.js';
import { verticalCrop, outputSize, exportBitrate, clampTrim, fmtClock, MIN_CLIP } from './crop.js';

const LONG_EXPORT = 180; // segundos: a partir de aca se avisa que tarda lo mismo que el video

function once(target, evt, ms = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout ${evt}`)), ms);
    target.addEventListener(
      evt,
      (e) => {
        clearTimeout(timer);
        resolve(e);
      },
      { once: true },
    );
    if (evt !== 'error') target.addEventListener('error', () => (clearTimeout(timer), reject(new Error(t('clips.videoUnsupported')))), { once: true });
  });
}

// Un WebM sin duracion (de otro grabador) dice Infinity: se fuerza a calcularla buscando el final
async function ensureDuration(video) {
  if (Number.isFinite(video.duration) && video.duration > 0) return video.duration;
  const wait = once(video, 'durationchange', 8000).catch(() => null);
  video.currentTime = 1e7;
  await wait;
  video.currentTime = 0;
  return Number.isFinite(video.duration) ? video.duration : 0;
}

// Rectangulo donde se ve el video dentro de su caja (object-fit: contain)
function contentBox(video) {
  const W = video.clientWidth;
  const H = video.clientHeight;
  const vw = video.videoWidth || 16;
  const vh = video.videoHeight || 9;
  const k = Math.min(W / vw, H / vh);
  const w = vw * k;
  const hh = vh * k;
  return { x: (W - w) / 2, y: (H - hh) / 2, w, h: hh, k };
}

function pickMime() {
  return ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m)) || '';
}

/**
 * Re-codifica [start, end] del video con el recorte. onProgress(0..1). Devuelve los bytes del WebM o null si
 * se cancelo (signal.cancelled = true).
 */
async function encodeClip({ url, start, end, crop, out, onProgress, signal }) {
  const v = document.createElement('video');
  v.preload = 'auto';
  v.playsInline = true;
  v.src = url;
  await once(v, 'loadedmetadata');
  const canvas = document.createElement('canvas');
  canvas.width = out.width;
  canvas.height = out.height;
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.imageSmoothingQuality = 'high';
  const vtrack = canvas.captureStream(0).getVideoTracks()[0];
  const ac = new AudioContext();
  const dest = ac.createMediaStreamDestination();
  ac.createMediaElementSource(v).connect(dest); // el audio va solo a la grabacion (no suena)
  const stream = new MediaStream([vtrack, ...dest.stream.getAudioTracks()]);
  const mimeType = pickMime();
  const rec = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), videoBitsPerSecond: exportBitrate(out.width, out.height, 60), audioBitsPerSecond: 128000 });
  const chunks = [];
  rec.ondataavailable = (e) => e.data?.size && chunks.push(e.data);
  const draw = () => {
    ctx.drawImage(v, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, out.width, out.height);
    vtrack.requestFrame?.();
  };
  const cleanup = () => {
    try {
      v.pause();
      v.removeAttribute('src');
      v.load();
    } catch {
      /* ya estaba libre */
    }
    stream.getTracks().forEach((tr) => tr.stop());
    ac.close().catch(() => {});
  };
  try {
    v.currentTime = start;
    await once(v, 'seeked');
    draw();
    rec.start(1000);
    await ac.resume().catch(() => {});
    await v.play();
    await new Promise((resolve) => {
      let lastDraw = performance.now();
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearInterval(watch);
        resolve();
      };
      const tick = () => {
        if (done) return;
        draw();
        lastDraw = performance.now();
        onProgress?.(Math.min(1, (v.currentTime - start) / (end - start)));
        if (signal.cancelled || v.currentTime >= end || v.ended) finish();
        else if (typeof v.requestVideoFrameCallback === 'function') v.requestVideoFrameCallback(tick);
      };
      // Respaldo si la ventana no dibuja (minimizada): dibuja y revisa el final cada 100 ms
      const watch = setInterval(() => {
        if (signal.cancelled || v.currentTime >= end || v.ended) return finish();
        if (performance.now() - lastDraw > 150) {
          draw();
          onProgress?.(Math.min(1, (v.currentTime - start) / (end - start)));
        }
      }, 100);
      if (typeof v.requestVideoFrameCallback === 'function') v.requestVideoFrameCallback(tick);
      v.addEventListener('ended', finish, { once: true });
    });
    v.pause();
    const stopped = once(rec, 'stop', 10000);
    rec.stop();
    await stopped;
    if (signal.cancelled) return null;
    const blob = new Blob(chunks, { type: mimeType || 'video/webm' });
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    cleanup();
  }
}

/**
 * Abre el editor de un clip (item de worlds:media). opts.onSaved({ path, name, duration }) al guardar.
 */
export function openEditor(item, { onSaved } = {}) {
  let duration = 0;
  let start = 0;
  let end = 0;
  let mode = 'horizontal';
  let pos = 0.5;
  let exporting = null; // { cancelled }
  let playingSel = false;

  const video = h('video', { class: 'cl-ed-video', src: item.url, preload: 'auto', playsinline: true, 'aria-label': t('clips.editorPreview') });
  const shadeL = h('div', { class: 'cl-ed-shade' });
  const shadeR = h('div', { class: 'cl-ed-shade' });
  const frame = h('div', { class: 'cl-ed-frame', role: 'presentation', title: t('clips.dragCrop') }, h('span', { class: 'cl-ed-frame-tag' }, '9:16'));
  const overlay = h('div', { class: 'cl-ed-overlay', hidden: true }, shadeL, frame, shadeR);
  const stage = h('div', { class: 'cl-ed-stage' }, video, overlay);

  // Linea de tiempo: tramo elegido + cabezal; los dos deslizadores son los controles accesibles
  const sel = h('div', { class: 'cl-ed-sel' });
  const head = h('div', { class: 'cl-ed-head' });
  const track = h('div', { class: 'cl-ed-track', title: t('clips.seekHint') }, sel, head);
  const startIn = h('input', { type: 'range', class: 'cl-ed-range', min: 0, max: 1, step: 0.05, value: 0, 'aria-label': t('clips.trimStart') });
  const endIn = h('input', { type: 'range', class: 'cl-ed-range', min: 0, max: 1, step: 0.05, value: 1, 'aria-label': t('clips.trimEnd') });
  const startTxt = h('span', { class: 'cl-ed-time num' });
  const endTxt = h('span', { class: 'cl-ed-time num' });
  const lenTxt = h('span', { class: 'cl-ed-len num' });
  const nowTxt = h('span', { class: 'cl-ed-now num', 'aria-live': 'off' });
  const playBtn = h('button', { class: 'btn sm', type: 'button', onclick: () => togglePlay() }, icon('play'), t('clips.playSelection'));
  const markIn = h('button', { class: 'btn sm ghost', type: 'button', title: t('clips.markStartHint'), onclick: () => setTrim(video.currentTime, end) }, icon('chevronRight'), t('clips.markStart'));
  const markOut = h('button', { class: 'btn sm ghost', type: 'button', title: t('clips.markEndHint'), onclick: () => setTrim(start, video.currentTime) }, t('clips.markEnd'), icon('chevronLeft'));

  // Formato y recorte
  const segBtn = (id, ic, label) => h('button', { type: 'button', 'data-mode': id, 'aria-pressed': 'false', onclick: () => setMode(id) }, icon(ic), label);
  const seg = h('div', { class: 'segmented cl-ed-seg', role: 'group', 'aria-label': t('clips.format') }, segBtn('horizontal', 'monitor', t('clips.formatHorizontal')), segBtn('vertical', 'clPhone', t('clips.formatVertical')));
  const posIn = h('input', { type: 'range', class: 'cl-ed-range', min: 0, max: 100, step: 1, value: 50, 'aria-label': t('clips.cropPosition') });
  const centerBtn = h('button', { class: 'btn sm ghost', type: 'button', onclick: () => setPos(0.5) }, icon('target'), t('clips.center'));
  const posRow = h('div', { class: 'cl-ed-field', hidden: true }, h('label', { class: 'cl-ed-label' }, t('clips.cropPosition')), h('div', { class: 'row' }, posIn, centerBtn), h('p', { class: 'cl-ed-help' }, t('clips.cropHelp')));
  const outInfo = h('div', { class: 'cl-ed-info' });
  const exportBtn = h('button', { class: 'btn primary block', type: 'button', onclick: () => runExport() }, icon('download'), t('clips.export'));
  const bar = h('div', { class: 'progress' }, h('i'));
  const progressTxt = h('span', { class: 'num' });
  const cancelBtn = h('button', { class: 'btn sm ghost', type: 'button', onclick: () => cancelExport() }, t('clips.cancel'));
  const progress = h('div', { class: 'cl-ed-progress', hidden: true, role: 'status', 'aria-live': 'polite' }, h('div', { class: 'row between' }, h('span', {}, t('clips.exporting')), progressTxt), bar, h('p', { class: 'cl-ed-help' }, t('clips.exportingHelp')), cancelBtn);

  const body = h(
    'div',
    { class: 'cl-ed' },
    h(
      'div',
      { class: 'cl-ed-left' },
      stage,
      h('div', { class: 'cl-ed-timeline' }, h('div', { class: 'row between cl-ed-times' }, startTxt, nowTxt, endTxt), track),
      h(
        'div',
        { class: 'cl-ed-trim' },
        h('label', { class: 'cl-ed-field' }, h('span', { class: 'cl-ed-label' }, t('clips.trimStart')), startIn),
        h('label', { class: 'cl-ed-field' }, h('span', { class: 'cl-ed-label' }, t('clips.trimEnd')), endIn),
      ),
      h('div', { class: 'row wrap cl-ed-controls' }, markIn, playBtn, markOut, h('span', { class: 'spacer' }), lenTxt),
    ),
    h('div', { class: 'cl-ed-side' }, h('div', { class: 'cl-ed-field' }, h('span', { class: 'cl-ed-label' }, t('clips.format')), seg), posRow, outInfo, h('div', { class: 'spacer' }), progress, exportBtn),
  );

  const m = modal({
    title: t('clips.editorTitle'),
    subtitle: item.file,
    icon: 'clScissors',
    size: 'xwide',
    body,
    onClose: () => {
      if (exporting) exporting.cancelled = true;
      video.pause();
      document.removeEventListener('keydown', onKey, true);
      resizeObs?.disconnect();
    },
  });

  // ---------- Dibujo ----------
  function drawTimes() {
    const span = Math.max(0.001, duration);
    sel.style.left = `${(start / span) * 100}%`;
    sel.style.width = `${((end - start) / span) * 100}%`;
    head.style.left = `${(Math.min(video.currentTime || 0, span) / span) * 100}%`;
    startTxt.textContent = fmtClock(start);
    endTxt.textContent = fmtClock(end);
    nowTxt.textContent = fmtClock(video.currentTime || 0);
    lenTxt.textContent = t('clips.selectionLength', { time: fmtClock(end - start) });
    startIn.value = String(start);
    endIn.value = String(end);
    startIn.setAttribute('aria-valuetext', fmtClock(start));
    endIn.setAttribute('aria-valuetext', fmtClock(end));
  }

  function currentCrop() {
    const w = video.videoWidth || 1280;
    const hh = video.videoHeight || 720;
    return mode === 'vertical' ? verticalCrop(w, hh, pos) : { sx: 0, sy: 0, sw: w, sh: hh };
  }

  function drawCrop() {
    overlay.hidden = mode !== 'vertical' || !video.videoWidth;
    if (!overlay.hidden) {
      const box = contentBox(video);
      const c = currentCrop();
      Object.assign(overlay.style, { left: `${box.x}px`, top: `${box.y}px`, width: `${box.w}px`, height: `${box.h}px` });
      const x = c.sx * box.k;
      const y = c.sy * box.k;
      const w = c.sw * box.k;
      const hh = c.sh * box.k;
      Object.assign(frame.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${hh}px` });
      // Sombras a los costados (o arriba y abajo) del recuadro
      const sideways = c.sh === (video.videoHeight || 0);
      Object.assign(shadeL.style, sideways ? { left: 0, top: 0, width: `${x}px`, height: '100%' } : { left: 0, top: 0, width: '100%', height: `${y}px` });
      Object.assign(shadeR.style, sideways ? { left: `${x + w}px`, top: 0, width: `${box.w - x - w}px`, height: '100%' } : { left: 0, top: `${y + hh}px`, width: '100%', height: `${box.h - y - hh}px` });
    }
    posRow.hidden = mode !== 'vertical';
    for (const b of seg.querySelectorAll('button')) {
      const on = b.dataset.mode === mode;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    }
    const out = outputSize(currentCrop(), mode);
    mount(
      outInfo,
      h('div', { class: 'cl-ed-info-row' }, icon('maximize'), h('span', {}, t('clips.outSize', { width: out.width, height: out.height }))),
      h('div', { class: 'cl-ed-info-row' }, icon('clock'), h('span', {}, t('clips.outLength', { time: fmtClock(end - start) }))),
      h('div', { class: 'cl-ed-info-row' }, icon('file'), h('span', {}, t('clips.outFormat'))),
    );
  }

  function setTrim(s, e) {
    const c = clampTrim(s, e, duration);
    start = c.start;
    end = c.end;
    if (video.currentTime < start || video.currentTime > end) video.currentTime = start;
    drawTimes();
    drawCrop();
  }

  function setMode(id) {
    mode = id === 'vertical' ? 'vertical' : 'horizontal';
    drawCrop();
  }

  function setPos(p) {
    pos = Math.min(1, Math.max(0, p));
    posIn.value = String(Math.round(pos * 100));
    posIn.setAttribute('aria-valuetext', t('clips.cropValue', { value: Math.round(pos * 100) }));
    drawCrop();
  }

  function togglePlay() {
    if (!video.paused) {
      video.pause();
      return;
    }
    if (video.currentTime < start || video.currentTime >= end - 0.05) video.currentTime = start;
    playingSel = true;
    video.play().catch(() => {});
  }

  // ---------- Eventos ----------
  startIn.addEventListener('input', () => setTrim(Number(startIn.value), end));
  endIn.addEventListener('input', () => setTrim(start, Number(endIn.value)));
  posIn.addEventListener('input', () => setPos(Number(posIn.value) / 100));
  video.addEventListener('timeupdate', () => {
    if (playingSel && video.currentTime >= end) {
      video.pause();
      video.currentTime = end;
    }
    drawTimes();
  });
  video.addEventListener('play', () => mount(playBtn, icon('pause'), t('clips.pause')));
  video.addEventListener('pause', () => {
    playingSel = false;
    mount(playBtn, icon('play'), t('clips.playSelection'));
  });
  track.addEventListener('pointerdown', (e) => {
    const r = track.getBoundingClientRect();
    video.currentTime = Math.min(duration, Math.max(0, ((e.clientX - r.left) / r.width) * duration));
    drawTimes();
  });
  // Arrastrar el recuadro vertical
  frame.addEventListener('pointerdown', (e) => {
    if (mode !== 'vertical') return;
    e.preventDefault();
    frame.setPointerCapture(e.pointerId);
    const box = contentBox(video);
    const c = currentCrop();
    const sideways = c.sh === video.videoHeight;
    const room = sideways ? box.w - c.sw * box.k : box.h - c.sh * box.k;
    const from = sideways ? e.clientX : e.clientY;
    const p0 = pos;
    const move = (ev) => room > 0 && setPos(p0 + ((sideways ? ev.clientX : ev.clientY) - from) / room);
    const up = () => {
      frame.removeEventListener('pointermove', move);
      frame.removeEventListener('pointerup', up);
      frame.removeEventListener('pointercancel', up);
    };
    frame.addEventListener('pointermove', move);
    frame.addEventListener('pointerup', up);
    frame.addEventListener('pointercancel', up);
  });
  const resizeObs = typeof ResizeObserver === 'function' ? new ResizeObserver(() => drawCrop()) : null;
  resizeObs?.observe(stage);

  const onKey = (e) => {
    if (exporting || !m.el.isConnected || document.querySelectorAll('.modal-backdrop').length > 1) return;
    const tag = e.target.tagName;
    if (tag === 'INPUT' && e.key !== ' ') return;
    if (e.key === ' ' && tag !== 'BUTTON') {
      e.preventDefault();
      togglePlay();
    } else if (e.key === 'i' || e.key === 'I') setTrim(video.currentTime, end);
    else if (e.key === 'o' || e.key === 'O') setTrim(start, video.currentTime);
  };
  document.addEventListener('keydown', onKey, true);

  video.addEventListener(
    'loadedmetadata',
    async () => {
      duration = await ensureDuration(video).catch(() => 0);
      if (!duration) {
        mount(body, h('div', { class: 'notice bad' }, icon('alert'), h('div', {}, t('clips.videoUnsupportedText'))));
        return;
      }
      for (const inp of [startIn, endIn]) inp.max = String(duration);
      start = 0;
      end = duration;
      drawTimes();
      drawCrop();
    },
    { once: true },
  );
  video.addEventListener('error', () => mount(body, h('div', { class: 'notice bad' }, icon('alert'), h('div', {}, h('strong', {}, t('clips.videoUnsupported')), ' ', t('clips.videoUnsupportedText')))), { once: true });

  // ---------- Exportar ----------
  function cancelExport() {
    if (exporting) exporting.cancelled = true;
  }

  async function runExport() {
    if (exporting || !duration || end - start < MIN_CLIP) return;
    if (end - start > LONG_EXPORT && !(await confirmDialog(t('clips.longExportTitle'), t('clips.longExportText', { time: fmtClock(end - start, 0) }), { okText: t('clips.export') }))) return;
    video.pause();
    const signal = { cancelled: false };
    exporting = signal;
    const done = setBusy(exportBtn);
    progress.hidden = false;
    for (const el of [startIn, endIn, posIn, markIn, markOut, playBtn, centerBtn, ...seg.querySelectorAll('button')]) el.disabled = true;
    const setP = (p) => {
      bar.firstChild.style.width = `${Math.round(p * 100)}%`;
      progressTxt.textContent = `${Math.round(p * 100)}%`;
    };
    setP(0);
    try {
      const crop = currentCrop();
      const out = outputSize(crop, mode);
      const bytes = await encodeClip({ url: item.url, start, end, crop, out, onProgress: setP, signal });
      if (!bytes) return;
      setP(1);
      const res = await api.invoke('capture:saveExport', { instanceId: item.instanceId, sourceName: item.file, mode }, bytes);
      ok(t('clips.exported'), res?.name || '');
      onSaved?.(res);
      m.close();
    } catch (err) {
      if (!signal.cancelled) fail(t('clips.exportFailed'), err);
    } finally {
      exporting = null;
      done();
      if (m.el.isConnected) {
        progress.hidden = true;
        for (const el of [startIn, endIn, posIn, markIn, markOut, playBtn, centerBtn, ...seg.querySelectorAll('button')]) el.disabled = false;
      }
    }
  }

  drawTimes();
  drawCrop();
  return m;
}
