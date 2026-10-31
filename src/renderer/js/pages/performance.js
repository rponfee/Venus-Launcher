// Rendimiento: memoria para Minecraft (automatica o manual), opciones avanzadas de Java y del juego,
// datos de tu PC y monitor en vivo. La memoria de cada instancia se cambia desde su propia pagina.
import { h, icon, mount, fmtBytes, fmtMb, fmtAgo, fmtDuration, switchEl, selectEl, instanceIcon, fail, skeleton, setBusy } from '../ui.js';
import { store, api } from '../store.js';
import { t } from '../i18n.js';
import { ramSlider, bigValue, zoneOf, deriveMin, tierPill, openOptimizePicker, GC_PRESETS } from '../features/perf.js';

let advOpen = false; // "Opciones avanzadas" queda como la dejaste mientras dure la sesion

const pageHead = (actions) =>
  h('div', { class: 'page-head' }, h('div', { class: 'ph-text' }, h('h1', { class: 'page-title' }, t('performance.title')), h('p', { class: 'page-sub' }, t('performance.subtitle'))), actions ? h('div', { class: 'page-actions' }, actions) : null);

const optimizeBtn = () => h('button', { type: 'button', class: 'btn primary', onclick: () => openOptimizePicker() }, icon('wand'), t('performance.optimizeInstance'));

// Mientras llega el plan de memoria: la forma de la pagina (dos columnas de tarjetas)
function loadingView() {
  return h(
    'div',
    { class: 'pf-root' },
    pageHead(optimizeBtn()),
    h('div', { class: 'pf-layout' }, h('div', { class: 'pf-col pf-main' }, h('div', { class: 'card' }, skeleton('card', { lines: 5 }))), h('div', { class: 'pf-col pf-side' }, h('div', { class: 'card' }, skeleton('list', { rows: 3 })))),
  );
}

// Grupo de opciones (role="radiogroup"): una sola parada de Tab y flechas, Inicio y Fin para elegir
function radioKeys(group) {
  group.addEventListener('keydown', (e) => {
    const items = [...group.querySelectorAll('[role="radio"]')];
    const i = items.indexOf(document.activeElement);
    if (i < 0) return;
    let next = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = items[(i + 1) % items.length];
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = items[(i - 1 + items.length) % items.length];
    else if (e.key === 'Home') next = items[0];
    else if (e.key === 'End') next = items[items.length - 1];
    if (!next) return;
    e.preventDefault();
    next.click();
    // Al elegir se redibuja el grupo: el foco pasa a la opcion nueva
    group.querySelector('[aria-checked="true"]')?.focus();
  });
}

// Si el modulo de rendimiento no respondiera, la pagina sigue funcionando con datos basicos.
async function fallbackPlan(err) {
  console.warn('[performance]', err);
  const sys = await api.system.info().catch(() => null);
  const totalMb = sys ? sys.totalMem / 1048576 : 8192;
  const rec = sys?.recommended || { min: 1024, max: 4096 };
  const s = store.settings || {};
  const sliderMax = Math.max(2048, Math.floor((totalMb - 1024) / 256) * 256);
  return {
    totalMb,
    freeMb: (sys?.freeMem || 0) / 1048576,
    mode: s.memoryMode === 'manual' ? 'manual' : 'auto',
    manual: s.memory || rec,
    manualMax: s.perf?.manualMax || s.memory?.max || rec.max,
    plan: { base: rec.max, cap: rec.max, floor: 1024 },
    slider: { min: 1024, max: sliderMax, step: 256, low: 2048, high: Math.max(2560, Math.min(sliderMax, Math.floor((totalMb * 0.7) / 256) * 256)) },
    examples: [],
    error: err.message,
  };
}

export default {
  ns: ['performance', 'perf'],
  css: ['pages/performance', 'features/perf'],
  async render(root) {
    mount(root, loadingView());
    let plan;
    try {
      plan = await api.invoke('perf:memoryPlan');
    } catch (err) {
      plan = await fallbackPlan(err);
    }
    let s = store.settings;
    const offs = [store.on('settings', (v) => (s = v))];

    // Guardado agrupado: varios cambios seguidos (argumentos, ventana...) viajan juntos
    let pending = null;
    let saveTimer = null;
    const queueSave = (patch) => {
      pending = { ...(pending || {}), ...patch, ...(patch.window ? { window: { ...(pending?.window || {}), ...patch.window } } : {}) };
      clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        const p = pending;
        pending = null;
        try {
          s = await store.setSettings(p);
        } catch (err) {
          fail(t('perf.saveError'), err);
        }
      }, 300);
    };

    // ---------- Memoria ----------
    let mode = plan.mode;
    const sl = plan.slider;
    let manualMax = Math.min(sl.max, Math.max(sl.min, plan.manualMax || plan.plan.base));
    const ramBody = h('div', { class: 'pf-ram-body' });
    const seg = h('div', { class: 'segmented pf-mode', role: 'radiogroup', 'aria-label': t('performance.modeAria') });

    const drawSeg = () =>
      mount(
        seg,
        [
          ['auto', t('performance.modeAuto'), 'sparkles'],
          ['manual', t('performance.modeManual'), 'sliders'],
        ].map(([key, label, ic]) =>
          h('button', { type: 'button', role: 'radio', 'aria-checked': String(mode === key), tabindex: mode === key ? '0' : '-1', class: mode === key ? 'active' : null, onclick: () => setMode(key) }, icon(ic), label),
        ),
      );
    radioKeys(seg);

    const setMode = (key) => {
      if (key === mode) return;
      mode = key;
      drawSeg();
      drawRam();
      if (key === 'auto') queueSave({ memoryMode: 'auto' });
      else queueSave({ memoryMode: 'manual', memory: { max: manualMax, min: deriveMin(manualMax) }, perf: { manualMax } });
    };

    const autoView = () => {
      const p = plan.plan;
      const total = plan.totalMb;
      const totalLabel = fmtMb(Math.round(total / 1024) * 1024);
      const big = bigValue();
      big.set(p.base, null);
      big.setPill(h('span', { class: 'pill pfx-ultra' }, icon('sparkles'), t('performance.autoBadge')));
      const sentence = p.cap > p.base ? t('performance.autoSentence', { total: totalLabel, base: fmtMb(p.base), cap: fmtMb(p.cap) }) : t('performance.autoSentenceFlat', { total: totalLabel, base: fmtMb(p.base) });
      const pct = (v) => `${Math.max(0, Math.min(100, (v / total) * 100)).toFixed(2)}%`;
      const rest = Math.max(0, Math.round((total - p.cap) / 512) * 512);
      return [
        big.el,
        h('p', { class: 'pf-sentence' }, sentence),
        h('div', { class: 'pf-bar', role: 'img', 'aria-label': sentence }, h('i', { class: 'pf-bar-base', style: { width: pct(p.base) } }), p.cap > p.base ? h('i', { class: 'pf-bar-extra', style: { width: pct(p.cap - p.base) } }) : null),
        h(
          'div',
          { class: 'legend pf-legend' },
          h('span', { class: 'lg-item' }, h('span', { class: 'sw pf-sw-base' }), t('performance.barMinecraft', { mem: fmtMb(p.base) })),
          p.cap > p.base ? h('span', { class: 'lg-item' }, h('span', { class: 'sw pf-sw-extra' }), t('performance.barModpacks', { mem: fmtMb(p.cap) })) : null,
          h('span', { class: 'lg-item' }, h('span', { class: 'sw pf-sw-rest' }), t('performance.barSystem', { mem: fmtMb(rest) })),
        ),
        plan.examples?.length
          ? h(
              'div',
              { class: 'pf-examples' },
              plan.examples.map((e) =>
                h(
                  'div',
                  { class: 'pf-example' },
                  h('span', { class: 'pf-ex-label' }, icon(e.kind === 'vanilla' ? 'box' : e.kind === 'mods' ? 'puzzle' : 'layers'), t(`performance.ex_${e.kind}`, { count: e.count })),
                  h('span', { class: 'pf-ex-value' }, fmtMb(e.max)),
                ),
              ),
            )
          : null,
        h('div', { class: 'pf-hint' }, icon('info'), h('span', {}, t('performance.autoHint'))),
      ];
    };

    const manualView = () => {
      const big = bigValue();
      const zoneHint = h('div', { class: 'pf-zone-hint' });
      const xms = h('div', { class: 'small muted' });
      const update = (v) => {
        const z = zoneOf(v, sl);
        big.set(v, z);
        zoneHint.className = `pf-zone-hint z-${z}`;
        mount(zoneHint, icon(z === 'ok' ? 'check' : 'alert'), h('span', {}, t(`perf.zoneHint_${z}`)));
        xms.textContent = t('perf.xms', { mem: fmtMb(deriveMin(v)) });
      };
      const slider = ramSlider({
        value: manualMax,
        slider: sl,
        recommended: plan.plan.base,
        onInput: (v) => {
          update(v);
          manualMax = v;
          queueSave({ memoryMode: 'manual', memory: { max: v, min: deriveMin(v) }, perf: { manualMax: v } });
        },
      });
      update(slider.value());
      return [
        h('div', { class: 'pf-manual-top' }, big.el, h('button', { type: 'button', class: 'btn ghost sm', onclick: () => slider.set(plan.plan.base) }, icon('undo'), t('performance.useRecommended', { mem: fmtMb(plan.plan.base) }))),
        slider.el,
        h('div', { class: 'pf-manual-foot' }, zoneHint, h('div', { class: 'small text-2' }, t('performance.manualHint', { low: fmtMb(sl.low), high: fmtMb(sl.high) })), xms),
      ];
    };

    const drawRam = () => mount(ramBody, mode === 'auto' ? autoView() : manualView());
    drawSeg();
    drawRam();

    const ramCard = h(
      'section',
      { class: 'card pf-ram', 'aria-labelledby': 'pf-ram-title' },
      h('div', { class: 'pf-ram-head' }, h('h2', { class: 'card-title pf-card-h', id: 'pf-ram-title' }, icon('memory'), t('performance.ramTitle')), seg),
      plan.error ? h('div', { class: 'notice bad pf-error', role: 'alert' }, icon('alert'), h('div', {}, t('performance.loadError', { error: plan.error }))) : null,
      ramBody,
    );

    // ---------- Opciones avanzadas ----------
    const gcBox = h('div', { class: 'pf-gc', role: 'radiogroup', 'aria-label': t('performance.gcTitle') });
    const drawGc = () =>
      mount(
        gcBox,
        GC_PRESETS.map((id) => {
          const active = (s.jvmPreset || 'auto') === id;
          return h(
            'button',
            {
              type: 'button',
              role: 'radio',
              'aria-checked': String(active),
              tabindex: active ? '0' : '-1',
              class: ['pf-gc-item', active && 'active'],
              onclick: () => {
                if ((s.jvmPreset || 'auto') === id) return;
                s = { ...s, jvmPreset: id };
                queueSave({ jvmPreset: id });
                drawGc();
              },
            },
            h('span', { class: 'pf-gc-name' }, t(`perf.gc_${id}`), id === 'auto' ? h('span', { class: 'badge accent' }, t('common.recommended')) : null),
            h('span', { class: 'pf-gc-desc' }, t(`perf.gc_${id}_desc`)),
          );
        }),
      );
    drawGc();
    radioKeys(gcBox);
    const argsInput = h('input', { class: 'input mono', value: s.jvmArgs || '', placeholder: t('performance.jvmArgsPlaceholder'), spellcheck: 'false', id: 'pf-jvm-args' });
    argsInput.addEventListener('input', () => queueSave({ jvmArgs: argsInput.value }));
    const wInput = h('input', { class: 'input', type: 'number', min: 320, max: 7680, placeholder: t('performance.windowAuto'), value: s.window?.width || '', id: 'pf-win-w' });
    const hInput = h('input', { class: 'input', type: 'number', min: 240, max: 4320, placeholder: t('performance.windowAuto'), value: s.window?.height || '', id: 'pf-win-h' });
    const saveWin = () => queueSave({ window: { width: Math.max(0, +wInput.value || 0), height: Math.max(0, +hInput.value || 0) } });
    wInput.addEventListener('input', saveWin);
    hInput.addEventListener('input', saveWin);
    const field = (labelText, control, forId) => h('div', { class: 'field' }, h('label', forId ? { for: forId } : {}, labelText), control);

    const adv = h(
      'details',
      { class: 'card pf-adv', open: advOpen },
      h(
        'summary',
        { class: 'pf-adv-sum' },
        h('span', { class: 'pf-adv-icon' }, icon('sliders')),
        h('span', { class: 'pf-adv-text' }, h('span', { class: 'pf-adv-title' }, t('performance.advTitle')), h('span', { class: 'pf-adv-sub' }, t('performance.advSub'))),
        icon('chevronDown', 'pf-adv-chev'),
      ),
      h(
        'div',
        { class: 'pf-adv-body' },
        h('div', { class: 'pf-adv-block' }, h('div', { class: 'pf-adv-label' }, t('performance.gcTitle')), h('div', { class: 'small muted' }, t('performance.gcSub')), gcBox),
        field(t('performance.jvmArgs'), argsInput, 'pf-jvm-args'),
        h(
          'div',
          { class: 'form-grid' },
          field(t('performance.priority'), selectEl(['low', 'normal', 'above', 'high'].map((v) => ({ value: v, label: t(`performance.priority_${v}`) })), s.priority || 'normal', (v) => queueSave({ priority: v }))),
          field(t('performance.afterLaunch'), selectEl(['keep', 'minimize', 'hide'].map((v) => ({ value: v, label: t(`performance.afterLaunch_${v}`) })), s.afterLaunch || 'minimize', (v) => queueSave({ afterLaunch: v }))),
          field(t('performance.windowWidth'), wInput, 'pf-win-w'),
          field(t('performance.windowHeight'), hInput, 'pf-win-h'),
        ),
        h(
          'div',
          { class: 'toggle-row pf-fullscreen' },
          h('div', { class: 'tr-text' }, h('div', { class: 'tr-title' }, t('performance.fullscreen')), h('div', { class: 'tr-sub' }, t('performance.fullscreenSub'))),
          switchEl(Boolean(s.window?.fullscreen), (v) => queueSave({ window: { fullscreen: v } }), t('performance.fullscreen')),
        ),
      ),
    );
    adv.addEventListener('toggle', () => {
      advOpen = adv.open;
    });

    // ---------- Tu PC ----------
    const pcPill = h('span');
    const pcBody = h('div', { class: 'pf-pc-body' }, skeleton('list', { rows: 3, label: t('performance.measuring') }));
    const spec = (ic, label, value, sub, extra) =>
      h(
        'div',
        { class: 'pf-spec' },
        h('span', { class: 'pf-spec-icon' }, icon(ic)),
        h('div', { class: 'pf-spec-main' }, h('div', { class: 'pf-spec-label' }, label), h('div', { class: 'pf-spec-value', title: value }, value), sub ? h('div', { class: 'pf-spec-sub' }, sub) : null),
        extra || null,
      );
    const benchBtn = h('button', { type: 'button', class: 'btn ghost sm', onclick: () => loadSystem(true) }, icon('refresh'), t('performance.rebench'));
    const benchInfo = h('span', { class: 'tiny muted', 'aria-live': 'polite' });
    const drawPc = (sys) => {
      mount(pcPill, tierPill(sys));
      mount(
        pcBody,
        h(
          'div',
          { class: 'pf-specs' },
          spec(
            'cpu',
            t('performance.cpu'),
            sys.cpuModel,
            t('performance.coresThreads', { cores: sys.cores, threads: sys.threads }),
            sys.cpuScore ? h('span', { class: 'badge accent pf-score', title: t('performance.scoreHint') }, t('performance.scoreValue', { score: sys.cpuScore })) : null,
          ),
          spec('monitor', t('performance.gpu'), sys.gpu || t('performance.gpuUnknown'), sys.gpu ? t(`perf.gpu_${sys.gpuTier}`) : null),
          spec('memory', t('performance.ram'), fmtMb(Math.round(sys.totalMem / 1048576 / 1024) * 1024), t('performance.ramFree', { mem: fmtBytes(sys.freeMem) })),
        ),
        h('div', { class: 'pf-pc-foot' }, benchInfo, benchBtn),
      );
      // fmtAgo puede empezar en mayuscula ("Hace un momento"): va en el medio de la frase
      const ago = sys.benchmarkedAt ? fmtAgo(sys.benchmarkedAt) : '';
      benchInfo.textContent = ago ? t('performance.benchedAt', { ago: ago.charAt(0).toLocaleLowerCase() + ago.slice(1) }) : '';
    };
    const loadSystem = async (rerun = false) => {
      // Midiendo de nuevo: el boton muestra el spinner y el texto "Midiendo..." (setBusy le devuelve el foco)
      let done = null;
      if (rerun) {
        done = setBusy(benchBtn);
        mount(benchBtn, icon('refresh'), t('performance.benching'));
      }
      try {
        drawPc(await api.invoke(rerun ? 'perf:benchmark' : 'perf:system'));
      } catch (err) {
        // Error: que paso y como seguir (volver a medir)
        mount(
          pcBody,
          h('div', { class: 'notice bad pf-error', role: 'alert' }, icon('alert'), h('div', { class: 'spacer' }, t('performance.loadError', { error: err.message })), h('button', { type: 'button', class: 'btn sm', onclick: () => loadSystem(true) }, icon('refresh'), t('common.retry'))),
        );
      } finally {
        mount(benchBtn, icon('refresh'), t('performance.rebench'));
        done?.();
      }
    };
    loadSystem();
    const pcCard = h('section', { class: 'card pf-pc' }, h('div', { class: 'card-head' }, h('h2', { class: 'card-title pf-card-h' }, icon('cpu'), t('performance.pcTitle')), pcPill), pcBody);

    // ---------- En vivo ----------
    const ramBox = h('div', { class: 'pf-live-ram' }, skeleton(3));
    const gamesBox = h('div', { class: 'pf-live-games' });
    const limits = new Map(); // instancia -> limite de RAM (bytes) para la barra
    const limitFor = (id) => {
      if (limits.has(id)) return limits.get(id);
      limits.set(id, null);
      api
        .invoke('perf:memoryPlan', { instanceId: id })
        .then((p) => {
          const inst = p.instance;
          const max = inst?.memory?.override ? inst.memory.max : p.mode === 'manual' ? p.manual.max : inst?.auto?.max;
          limits.set(id, max ? max * 1048576 : null);
        })
        .catch(() => {});
      return null;
    };
    const gauge = (label, pctValue, valueText) =>
      h('div', { class: 'gauge-row' }, h('span', { class: 'muted' }, label), h('div', { class: 'progress', role: 'progressbar', 'aria-label': label, 'aria-valuenow': Math.round(pctValue), 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('i', { style: { width: `${Math.min(100, Math.max(0, pctValue)).toFixed(1)}%` } })), h('span', { class: 'g-val' }, valueText));
    const drawUsage = (u) => {
      const games = u.games.reduce((a, g) => a + g.memory, 0);
      const used = u.totalMem - u.freeMem;
      const other = Math.max(0, used - games);
      const pct = (v) => `${((v / u.totalMem) * 100).toFixed(2)}%`;
      mount(
        ramBox,
        h('div', { class: 'pf-live-top' }, h('span', { class: 'label' }, t('performance.sysRam')), h('span', { class: 'small text-2 num' }, t('performance.ramUsedOf', { used: fmtBytes(used), total: fmtBytes(u.totalMem) }))),
        h('div', { class: 'meter', role: 'img', 'aria-label': t('performance.meterAria', { mc: fmtBytes(games), other: fmtBytes(other), free: fmtBytes(u.freeMem) }) }, h('i', { style: { width: pct(games) } }), h('i', { class: 'used', style: { width: pct(other) } })),
        h(
          'div',
          { class: 'legend pf-live-legend' },
          games > 0 ? h('span', { class: 'lg-item' }, h('span', { class: 'sw pf-sw-base' }), t('performance.legendMinecraft', { mem: fmtBytes(games) })) : null,
          h('span', { class: 'lg-item' }, h('span', { class: 'sw pf-sw-other' }), t('performance.legendOther', { mem: fmtBytes(other) })),
          h('span', { class: 'lg-item' }, h('span', { class: 'sw pf-sw-rest' }), t('performance.legendFree', { mem: fmtBytes(u.freeMem) })),
        ),
        gauge(t('performance.sysCpu'), u.cpu, `${u.cpu.toFixed(0)} %`),
      );
      mount(
        gamesBox,
        u.games.length
          ? u.games.map((g) => {
              const inst = store.instances.find((i) => i.id === g.instanceId);
              const limit = limitFor(g.instanceId) || u.totalMem;
              return h(
                'div',
                { class: 'pf-game' },
                h('div', { class: 'row' }, inst ? instanceIcon(inst) : null, h('div', { class: 'spacer ellipsis' }, h('div', { class: 'pf-game-name ellipsis', title: inst?.name || g.instanceId }, inst?.name || g.instanceId), h('div', { class: 'small muted num' }, t('performance.gameMeta', { pid: g.pid, time: fmtDuration(g.elapsed) })))),
                gauge(t('performance.gameRam'), (g.memory / limit) * 100, fmtBytes(g.memory)),
                gauge(t('performance.gameCpu'), g.cpu, `${g.cpu.toFixed(0)} %`),
              );
            })
          : h('div', { class: 'pf-live-empty' }, icon('gamepad'), h('span', {}, t('performance.liveEmpty'))),
      );
    };
    let polling = false;
    const poll = async () => {
      if (polling || document.hidden) return;
      polling = true;
      try {
        drawUsage(await api.system.usage());
      } catch {
        /* sin datos por ahora */
      } finally {
        polling = false;
      }
    };
    poll();
    const timer = setInterval(poll, 2000);
    const liveCard = h(
      'section',
      { class: 'card pf-live' },
      h('div', { class: 'card-head' }, h('h2', { class: 'card-title pf-card-h' }, icon('activity'), t('performance.liveTitle')), h('span', { class: 'tiny muted' }, t('performance.liveSub'))),
      ramBox,
      gamesBox,
    );

    mount(
      root,
      h('div', { class: 'pf-root' }, pageHead(optimizeBtn()), h('div', { class: 'pf-layout' }, h('div', { class: 'pf-col pf-main' }, ramCard, adv), h('div', { class: 'pf-col pf-side' }, pcCard, liveCard))),
    );

    return () => {
      clearInterval(timer);
      if (pending) {
        clearTimeout(saveTimer);
        store.setSettings(pending).catch(() => {});
      }
      offs.forEach((off) => off());
    };
  },
};
