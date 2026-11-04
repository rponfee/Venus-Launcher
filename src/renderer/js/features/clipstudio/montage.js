// Montaje de la semana: un video con los mejores clips de los ultimos 7 dias. Propone los automaticos y los destacados
// (features/clipstudio/logic.js), el usuario saca, agrega y reordena, elige la duracion y una placa de titulo opcional.
// Si los clips tienen el mismo codec y tamanio se unen sin recodificar (rapido y sin perder calidad); si no, el video se
// recodifica con WebCodecs (encoder.js) y el audio se copia. El resultado va a <instancia>/clips/ como cualquier clip.
import { h, icon, mount, modal, ok, fail, setBusy, switchEl, selectEl, fmtDate, emptyState } from '../../ui.js';
import { api } from '../../store.js';
import { t } from '../../i18n.js';
import { cloud } from '../../cloud.js';
import './icons.js';
import { clock, reasonBadge } from '../../pages/clips/common.js';
import { proposeClips, addableClips, moveItem, planSegments, targetInstance, MONTAGE_TARGETS, MONTAGE_DEFAULT_TARGET, MONTAGE_DAYS, TITLE_MAX, TITLE_SECONDS } from './logic.js';
import { FrameEncoder, pickCodec, canEncode, encodeTitleCard, transcodeSegment } from './encoder.js';

const C = (key, vars) => t(`clipstudio.${key}`, vars);

// Ids de los clips destacados en el perfil (los compartidos que eligio el dueño)
function featuredIds() {
  const list = cloud.profile?.showcase?.clips;
  return new Set(Array.isArray(list) ? list.filter((x) => typeof x === 'string') : []);
}

function weekLabel(now = Date.now()) {
  const opts = { day: 'numeric', month: 'short' };
  return C('montageWeek', { from: fmtDate(now - (MONTAGE_DAYS - 1) * 86400000, opts), to: fmtDate(now, opts) });
}

/**
 * Abre el dialogo. opts = { items (de worlds:media), sharedMap, onSaved(res) }.
 */
export function openMontage({ items = [], sharedMap = {}, onSaved } = {}) {
  const now = Date.now();
  let chosen = proposeClips(items, { now, sharedMap, featuredIds: featuredIds() });
  let target = MONTAGE_DEFAULT_TARGET;
  let useTitle = false;
  let titleText = C('montageDefaultTitle');
  const probes = new Map(); // ruta -> { ok, duration, codec, width, height }
  let running = null; // { cancelled }
  let jobId = null;
  let addOpen = false;

  const listBox = h('div', { class: 'cs-mt-list', role: 'list', 'aria-label': C('montageChosen') });
  const addBox = h('div', { class: 'cs-mt-add' });
  const summary = h('div', { class: 'cs-mt-summary', 'aria-live': 'polite' });
  const titleInput = h('input', { class: 'input', type: 'text', maxlength: TITLE_MAX, value: titleText, 'aria-label': C('montageTitleLabel') });
  titleInput.addEventListener('input', () => {
    titleText = titleInput.value;
  });
  const titleField = h('div', { class: 'cs-field', hidden: true }, h('label', { class: 'cs-label' }, C('montageTitleLabel')), titleInput);
  const targetSel = selectEl(
    MONTAGE_TARGETS.map((s) => ({ value: String(s), label: s ? (s < 60 ? C('seconds', { count: s }) : C('minutes', { count: s / 60 })) : C('montageNoLimit') })),
    String(target),
    (v) => {
      target = Number(v);
      draw();
    },
  );
  targetSel.setAttribute('aria-label', C('montageTarget'));
  const titleSwitch = switchEl(
    useTitle,
    (v) => {
      useTitle = v;
      titleField.hidden = !v;
      draw();
    },
    C('montageTitleSwitch'),
  );
  const createBtn = h('button', { class: 'btn primary block', type: 'button', onclick: () => run() }, icon('csFilm'), C('montageCreate'));
  const bar = h('div', { class: 'progress' }, h('i'));
  const barText = h('span', { class: 'num' });
  const stepText = h('span', {});
  const cancelBtn = h('button', { class: 'btn sm ghost', type: 'button', onclick: () => cancel() }, t('common.cancel'));
  const progress = h('div', { class: 'cs-progress', hidden: true, role: 'status', 'aria-live': 'polite' }, h('div', { class: 'row between' }, stepText, barText), bar, cancelBtn);

  const body = h(
    'div',
    { class: 'cs-mt' },
    h('div', { class: 'cs-mt-left' }, listBox, addBox),
    h(
      'div',
      { class: 'cs-mt-side' },
      h('div', { class: 'cs-field' }, h('label', { class: 'cs-label' }, C('montageTarget')), targetSel, h('p', { class: 'cs-help' }, C('montageTargetHelp'))),
      h('div', { class: 'toggle-row' }, h('div', { class: 'tr-text' }, h('div', { class: 'tr-title' }, C('montageTitleSwitch')), h('div', { class: 'tr-sub' }, C('montageTitleSub'))), titleSwitch),
      titleField,
      summary,
      h('div', { class: 'spacer' }),
      progress,
      createBtn,
    ),
  );

  const m = modal({
    title: C('montageTitle'),
    subtitle: weekLabel(now),
    icon: 'csFilm',
    size: 'xwide',
    body,
    onClose: () => {
      if (running) cancel();
    },
  });

  const durationOf = (it) => probes.get(it.path)?.duration || 0;
  const usable = () => chosen.filter((it) => probes.get(it.path)?.ok);

  function currentPlan() {
    return planSegments(usable().map((it) => ({ path: it.path, duration: durationOf(it) })), target, { title: useTitle });
  }

  function drawList() {
    const plan = currentPlan();
    const byPath = new Map(plan.segments.map((s) => [s.path, s]));
    if (!chosen.length) {
      mount(listBox, emptyState('csFilm', C('montageEmpty'), C('montageEmptyText')));
      return;
    }
    mount(
      listBox,
      chosen.map((it, i) => {
        const info = probes.get(it.path);
        const seg = byPath.get(it.path);
        const up = h('button', { class: 'icon-btn sm', type: 'button', disabled: i === 0, title: C('moveUp'), 'aria-label': C('moveUpName', { name: it.file }), onclick: () => move(i, i - 1) }, icon('csUp'));
        const down = h('button', { class: 'icon-btn sm', type: 'button', disabled: i === chosen.length - 1, title: C('moveDown'), 'aria-label': C('moveDownName', { name: it.file }), onclick: () => move(i, i + 1) }, icon('chevronDown'));
        const remove = h('button', { class: 'icon-btn sm', type: 'button', title: C('remove'), 'aria-label': C('removeName', { name: it.file }), onclick: () => removeAt(i) }, icon('x'));
        let line = '';
        if (info && !info.ok) line = C('montageClipBad');
        else if (seg) line = seg.trimmed ? C('montageClipTrimmed', { length: clock(seg.length), total: clock(seg.duration) }) : clock(seg.length);
        else if (info) line = C('montageClipLeftOut');
        return h(
          'div',
          { class: ['cs-mt-row', info && !info.ok && 'bad'], role: 'listitem' },
          h('span', { class: 'cs-mt-num num', 'aria-hidden': 'true' }, String(i + 1)),
          h(
            'div',
            { class: 'cs-mt-main' },
            h('div', { class: 'cs-mt-name ellipsis', title: it.file }, reasonBadge(it, 'cl-reason inline'), it.world || it.instanceName || it.file),
            h('div', { class: 'cs-mt-sub' }, h('span', {}, fmtDate(it.date, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })), h('span', { class: 'num' }, line)),
          ),
          h('div', { class: 'cs-mt-btns' }, up, down, remove),
        );
      }),
    );
  }

  function drawAdd() {
    const rest = addableClips(items, chosen, { now });
    const toggle = h('button', { class: 'btn sm ghost', type: 'button', 'aria-expanded': String(addOpen), disabled: !rest.length, onclick: () => ((addOpen = !addOpen), drawAdd()) }, icon('plus'), C('montageAdd', { count: rest.length }));
    mount(
      addBox,
      toggle,
      addOpen && rest.length
        ? h(
            'div',
            { class: 'cs-mt-addlist', role: 'list' },
            rest.map((it) =>
              h(
                'div',
                { class: 'cs-mt-addrow', role: 'listitem' },
                h('div', { class: 'cs-mt-main' }, h('div', { class: 'cs-mt-name ellipsis', title: it.file }, reasonBadge(it, 'cl-reason inline'), it.world || it.instanceName || it.file), h('div', { class: 'cs-mt-sub' }, fmtDate(it.date, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))),
                h('button', { class: 'btn sm', type: 'button', 'aria-label': C('montageAddName', { name: it.file }), onclick: () => add(it) }, icon('plus'), C('add')),
              ),
            ),
          )
        : null,
    );
  }

  function drawSummary() {
    const plan = currentPlan();
    const rows = [h('div', { class: 'cs-info-row' }, icon('clock'), h('span', {}, C('montageTotal', { time: clock(plan.total) })))];
    if (plan.dropped) rows.push(h('div', { class: 'cs-info-row warn' }, icon('alert'), h('span', {}, C('montageDropped', { count: plan.dropped }))));
    const list = usable();
    if (list.length) {
      const first = probes.get(list[0].path);
      const same = list.every((it) => {
        const p = probes.get(it.path);
        return p.codec === first.codec && p.width === first.width && p.height === first.height;
      });
      rows.push(h('div', { class: 'cs-info-row' }, icon(same ? 'zap' : 'refresh'), h('span', {}, same ? C('montageModeCopy') : C('montageModeEncode'))));
      const inst = list.find((it) => it.instanceId === targetInstance(list));
      if (inst) rows.push(h('div', { class: 'cs-info-row' }, icon('folder'), h('span', { class: 'ellipsis' }, C('montageSavedIn', { name: inst.instanceName || inst.instanceId }))));
    }
    mount(summary, rows);
    createBtn.disabled = Boolean(running) || !plan.segments.length;
  }

  function draw() {
    drawList();
    drawAdd();
    drawSummary();
  }

  function move(from, to) {
    chosen = moveItem(chosen, from, to);
    draw();
  }

  function removeAt(i) {
    chosen = chosen.filter((_, n) => n !== i);
    draw();
  }

  async function add(it) {
    chosen = [...chosen, it];
    draw();
    await loadProbes([it]);
    draw();
  }

  async function loadProbes(list) {
    const missing = list.filter((it) => !probes.has(it.path));
    if (!missing.length) return;
    const res = await api.invoke('clipstudio:probe', missing.map((it) => it.path)).catch((err) => {
      console.warn('[clipstudio] probe:', err?.message || err);
      return [];
    });
    for (const p of res) probes.set(p.path, p);
  }

  function setProgress(p, step) {
    const pct = Math.round(Math.min(1, Math.max(0, p)) * 100);
    bar.firstChild.style.width = `${pct}%`;
    barText.textContent = `${pct}%`;
    if (step) stepText.textContent = step;
  }

  function lock(on) {
    for (const el of body.querySelectorAll('button, input, select')) {
      if (el !== cancelBtn) el.disabled = on;
    }
    progress.hidden = !on;
  }

  async function cancel() {
    if (!running) return;
    running.cancelled = true;
    const id = jobId;
    jobId = null;
    if (id) await api.invoke('clipstudio:cancel', id).catch(() => {});
  }

  async function run() {
    if (running) return;
    const plan = currentPlan();
    if (!plan.segments.length) return;
    if (useTitle && !titleText.trim()) {
      titleInput.focus();
      fail(C('montageFailed'), C('montageNeedTitle'));
      return;
    }
    const signal = { cancelled: false };
    running = signal;
    const done = setBusy(createBtn);
    lock(true);
    setProgress(0, C('montagePreparing'));
    let off = null;
    let encoder = null;
    try {
      const instanceId = targetInstance(usable());
      const job = await api.invoke('clipstudio:montageOpen', { instanceId, segments: plan.segments.map((s) => ({ path: s.path, start: s.start, length: s.trimmed ? s.length : null })) });
      jobId = job.jobId;
      if (signal.cancelled) return;
      const total = Math.max(0.1, plan.total);
      const needEncoder = job.mode === 'encode' || useTitle;
      if (needEncoder) {
        // Unir sin recodificar: la placa tiene que salir en el mismo codec y tamanio que los clips
        const wanted = job.mode === 'copy' ? [job.codec] : ['V_VP9', 'V_VP8'];
        const track = canEncode() ? await pickCodec(job.width, job.height, 30, wanted) : null;
        if (!track || (job.mode === 'encode' && track !== job.codec)) {
          if (job.mode === 'encode') throw new Error(C('errNoEncoder'));
          encoder = null;
          if (useTitle) ok(C('montageNoTitleCard'));
        } else encoder = new FrameEncoder({ jobId: job.jobId, track, width: job.width, height: job.height, fps: 30 });
      }
      if (encoder && useTitle) {
        setProgress(0, C('montageStepTitle'));
        await encodeTitleCard(encoder, { title: titleText.trim().slice(0, TITLE_MAX), subtitle: weekLabel(now), signal });
        if (signal.cancelled) return;
        // El siguiente tramo toma su inicio de los cuadros ya escritos.
        await encoder.flush();
      }
      if (job.mode === 'copy') {
        if (encoder) {
          await encoder.flush();
          encoder.close();
          encoder = null;
        }
        const startAt = useTitle ? TITLE_SECONDS : 0;
        setProgress(startAt / total, C('montageStepCopy'));
        off = api.on('clipstudio:progress', (e) => {
          if (e?.jobId === job.jobId) setProgress((startAt + e.done) / total);
        });
        const finished = await api.invoke('clipstudio:montageCopy', job.jobId);
        if (!finished || signal.cancelled) return;
      } else {
        setProgress(useTitle ? TITLE_SECONDS / total : 0, C('montageStepEncode'));
        for (let i = 0; i < plan.segments.length; i++) {
          if (signal.cancelled) return;
          await transcodeSegment(encoder, job.jobId, i, { signal, onTime: (ms) => setProgress(ms / 1000 / total) });
          await encoder.flush();
        }
        encoder.close();
        encoder = null;
      }
      if (signal.cancelled) return;
      setProgress(1, C('montageFinishing'));
      const res = await api.invoke('clipstudio:finish', job.jobId);
      jobId = null;
      ok(C('montageSaved'), res?.name || '');
      running = null;
      onSaved?.(res);
      m.close();
    } catch (err) {
      if (!signal.cancelled) fail(C('montageFailed'), err);
      if (jobId) await api.invoke('clipstudio:cancel', jobId).catch(() => {});
      jobId = null;
    } finally {
      off?.();
      encoder?.close();
      if (jobId) await api.invoke('clipstudio:cancel', jobId).catch(() => {});
      jobId = null;
      running = null;
      done();
      if (m.el.isConnected) {
        lock(false);
        draw();
      }
    }
  }

  draw();
  loadProbes(chosen).then(() => {
    if (m.el.isConnected && !running) draw();
  });
  return m;
}
