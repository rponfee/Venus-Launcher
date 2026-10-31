// Rendimiento (funciones reutilizables): panel de memoria de una instancia, dialogo "Optimizar"
// (RAM, recolector de Java, mods de rendimiento, opciones de video y packs de contenido)
// y el deslizador de RAM con zonas que tambien usa la pagina de Rendimiento.
import { h, icon, mount, modal, fail, ok, toast, fmtMb, debounce, switchEl, instanceIcon, loaderBadge, instanceLoaderKey, emptyState, ensureCss, setBusy } from '../ui.js';
import { store, api } from '../store.js';
import { t, loadNs } from '../i18n.js';
import { navigate } from '../app.js';

export const GC_PRESETS = ['auto', 'aikar', 'zgc', 'g1', 'none'];
const OPTION_ORDER = ['renderDistance', 'simulationDistance', 'graphicsMode', 'particles', 'renderClouds', 'entityShadows', 'ao', 'mipmapLevels', 'biomeBlendRadius', 'entityDistanceScaling', 'maxFps', 'enableVsync'];
const TIER_PILL = { low: 'warn', mid: '', high: 'good', ultra: 'pfx-ultra' };

// Textos y estilos propios: la funcion se puede usar desde cualquier pagina (por ejemplo, la de la instancia).
export async function ensurePerfUi() {
  ensureCss('features/perf');
  await loadNs('perf');
}

// Memoria inicial (-Xms): la mitad de la maxima, entre 512 MB y 4 GB (igual que el proceso principal).
export function deriveMin(max) {
  return Math.min(max, Math.min(4096, Math.max(512, Math.floor(max / 2 / 256) * 256)));
}

export function zoneOf(value, slider) {
  if (value < slider.low) return 'low';
  if (value > slider.high) return 'high';
  return 'ok';
}

export function tierPill(sys, extraClass = '') {
  const tier = sys?.tier || 'mid';
  const parts = [sys?.cpuModel, sys?.gpu, sys?.totalMem ? fmtMb(Math.round(sys.totalMem / 1048576 / 1024) * 1024) : null].filter(Boolean);
  return h(
    'span',
    { class: ['pill', TIER_PILL[tier], 'pfx-tier', extraClass], title: parts.join(' · ') || null },
    icon(tier === 'ultra' || tier === 'high' ? 'rocket' : 'gauge'),
    t('perf.yourPc', { tier: t(`perf.tier_${tier}`) }),
  );
}

// ---------- Deslizador de RAM con zonas (poco / ideal / demasiado) ----------
// slider: { min, max, step, low, high }. Devuelve { el, value(), set(v) }.
const THUMB = 22;
function trackPos(p) {
  // El centro del control no llega a los bordes: compensamos medio ancho del control
  return `calc(${p}% + ${(THUMB / 2 - (p / 100) * THUMB).toFixed(2)}px)`;
}

export function ramSlider({ value, slider, recommended = null, label, onInput }) {
  const { min, max, step } = slider;
  const pct = (v) => Math.max(0, Math.min(100, ((v - min) / Math.max(1, max - min)) * 100));
  const clampV = (v) => Math.min(max, Math.max(min, Math.round(v / step) * step));
  const input = h('input', { type: 'range', class: 'pfx-range', min, max, step, value: clampV(value), 'aria-label': label || t('perf.ramAria') });
  const zoneLabels = h('div', { class: 'pfx-zones', 'aria-hidden': 'true' });
  const lo = pct(slider.low);
  const hi = pct(slider.high);
  const widths = [lo, hi - lo, 100 - hi];
  ['low', 'ok', 'high'].forEach((z, i) => {
    const w = widths[i];
    zoneLabels.append(h('span', { class: `z-${z}`, style: { width: `${w}%` }, title: t(`perf.zone_${z}`) }, w >= 14 ? t(`perf.zone_${z}`) : ''));
  });
  const rec =
    recommended && recommended >= min && recommended <= max
      ? h('div', { class: 'pfx-rec', style: { left: trackPos(pct(recommended)) }, title: t('perf.recommendedMark', { mem: fmtMb(recommended) }) }, h('i'))
      : null;
  const el = h(
    'div',
    { class: 'pfx-slider', style: { '--lo': trackPos(lo), '--hi': trackPos(hi) } },
    rec,
    input,
    zoneLabels,
    h('div', { class: 'pfx-scale' }, h('span', {}, fmtMb(min)), h('span', {}, fmtMb(max))),
  );
  const describe = () => {
    const v = +input.value;
    input.setAttribute('aria-valuetext', `${fmtMb(v)} · ${t(`perf.zone_${zoneOf(v, slider)}`)}`);
  };
  describe();
  input.addEventListener('input', () => {
    describe();
    onInput?.(+input.value);
  });
  return {
    el,
    input,
    value: () => +input.value,
    set(v) {
      input.value = clampV(v);
      describe();
      onInput?.(+input.value);
    },
  };
}

// Numero grande "6 GB" + pastilla de zona (para el modo manual y la memoria personalizada).
export function bigValue() {
  const num = h('span', { class: 'pfx-big-num' });
  const unit = h('span', { class: 'pfx-big-unit' });
  const pill = h('span', { class: 'pill' });
  const el = h('div', { class: 'pfx-big', 'aria-live': 'polite' }, num, unit, pill);
  return {
    el,
    set(mb, zone) {
      const [n, u] = fmtMb(mb).split(' ');
      num.textContent = n;
      unit.textContent = u;
      if (zone) {
        pill.className = `pill ${zone === 'ok' ? 'good' : zone === 'low' ? 'warn' : 'bad'}`;
        pill.textContent = t(`perf.zone_${zone}`);
        pill.hidden = false;
      } else pill.hidden = true;
    },
    setPill(node) {
      pill.replaceWith(node);
    },
  };
}

// Bloques de carga con un texto visible (el analisis puede tardar unos segundos).
function waitSkeleton(text, shapes) {
  return h(
    'div',
    { class: 'skeleton-group', role: 'status', 'aria-live': 'polite', 'aria-busy': 'true' },
    text ? h('div', { class: 'pfx-wait' }, h('div', { class: 'spinner', 'aria-hidden': 'true' }), text) : h('span', { class: 'sr-only' }, t('common.loading')),
    h('div', { class: 'skeleton-shapes', 'aria-hidden': 'true' }, shapes),
  );
}

const bone = (cls) => h('span', { class: `skeleton ${cls}` });

// ---------- Panel de memoria de una instancia ----------
export function instanceMemoryPanel(instance) {
  const root = h('div', { class: 'pfx-mem' }, h('div', { class: 'pfx-mem-skel' }, waitSkeleton(null, [bone(''), bone('')])));
  const id = instance?.id;
  (async () => {
    await ensurePerfUi();
    if (!id) {
      mount(root, h('div', { class: 'small muted' }, t('perf.errNoInstance')));
      return;
    }
    const load = async () => {
      let plan;
      try {
        plan = await api.invoke('perf:memoryPlan', { instanceId: id });
      } catch (err) {
        mount(
          root,
          h(
            'div',
            { class: 'notice bad pfx-error', role: 'alert' },
            icon('alert'),
            h('div', {}, t('perf.loadError', { error: err.message })),
            h(
              'button',
              {
                type: 'button',
                class: 'btn sm',
                onclick: () => {
                  mount(root, h('div', { class: 'pfx-mem-skel' }, waitSkeleton(null, [bone(''), bone('')])));
                  load();
                },
              },
              icon('refresh'),
              t('common.retry'),
            ),
          ),
        );
        return;
      }
      drawPanel(root, plan);
    };
    await load();
  })();
  return root;
}

function drawPanel(root, plan) {
  const info = plan.instance;
  let mem = { ...info.memory };
  const globalAuto = plan.mode !== 'manual';
  const save = debounce(async (patch) => {
    try {
      const updated = await api.instances.update(info.id, { memory: patch });
      mem = { ...mem, ...(updated?.memory || patch) };
      store.refreshInstances().catch(() => {});
    } catch (err) {
      fail(t('perf.saveError'), err);
    }
  }, 300);

  const body = h('div', { class: 'pfx-mem-body' });
  const seg = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': t('perf.instModeAria') });
  const drawSeg = () =>
    mount(
      seg,
      [
        ['inherit', globalAuto ? t('perf.instMode_auto') : t('perf.instMode_global'), globalAuto ? 'sparkles' : 'settings'],
        ['custom', t('perf.instMode_custom'), 'sliders'],
      ].map(([key, label, ic]) => {
        const active = (key === 'custom') === Boolean(mem.override);
        return h(
          'button',
          {
            type: 'button',
            role: 'radio',
            'aria-checked': String(active),
            class: active ? 'active' : null,
            onclick: () => {
              if (active) return;
              if (key === 'custom') {
                // Arranca desde lo que la instancia recibe hoy, para que el cambio no sorprenda
                const start = globalAuto ? info.auto.max : plan.manual.max || info.auto.max;
                mem = { ...mem, override: true, max: start, min: deriveMin(start) };
                save({ override: true, max: mem.max, min: mem.min });
              } else {
                mem = { ...mem, override: false };
                save({ override: false });
              }
              drawSeg();
              drawBody();
            },
          },
          icon(ic),
          label,
        );
      }),
    );

  const drawBody = () => {
    if (!mem.override) {
      if (globalAuto) {
        const text = info.modCount > 0 ? t('perf.instAutoText', { mem: fmtMb(info.auto.max), count: info.modCount }) : t('perf.instAutoTextVanilla', { mem: fmtMb(info.auto.max) });
        const big = bigValue();
        big.set(info.auto.max, null);
        mount(body, h('div', { class: 'pfx-mem-auto' }, big.el, h('div', { class: 'pfx-mem-text' }, h('div', {}, text), h('div', { class: 'small muted' }, t('perf.instAutoHint')))));
      } else {
        const big = bigValue();
        big.set(plan.manual.max || info.auto.max, null);
        mount(
          body,
          h(
            'div',
            { class: 'pfx-mem-auto' },
            big.el,
            h('div', { class: 'pfx-mem-text' }, h('div', {}, t('perf.instGlobalText', { mem: fmtMb(plan.manual.max || info.auto.max) })), h('button', { type: 'button', class: 'btn ghost sm pfx-link', onclick: () => navigate('performance') }, icon('arrowRight'), t('perf.instGoPerformance'))),
          ),
        );
      }
      return;
    }
    const big = bigValue();
    const xms = h('div', { class: 'small muted' });
    const update = (v) => {
      big.set(v, zoneOf(v, info.slider));
      xms.textContent = t('perf.xms', { mem: fmtMb(deriveMin(v)) });
    };
    const slider = ramSlider({
      value: mem.max || info.auto.max,
      slider: info.slider,
      recommended: info.auto.max,
      label: t('perf.ramAriaInstance'),
      onInput: (v) => {
        update(v);
        mem = { ...mem, max: v, min: deriveMin(v) };
        save({ override: true, max: v, min: deriveMin(v) });
      },
    });
    update(slider.value());
    mount(
      body,
      big.el,
      slider.el,
      h('div', { class: 'pfx-mem-foot' }, h('div', { class: 'small text-2' }, t('perf.instCustomHint', { mem: fmtMb(info.auto.max) })), xms),
    );
  };

  drawSeg();
  drawBody();
  mount(root, h('div', { class: 'pfx-mem-head' }, seg), body);
}

// ---------- Elegir instancia para optimizar ----------
export async function openOptimizePicker() {
  await ensurePerfUi();
  const list = store.instances || [];
  const m = modal({
    title: t('perf.optimizePick'),
    body: list.length
      ? h(
          'div',
          { class: 'list pfx-pick' },
          list.map((inst) =>
            h(
              'button',
              {
                type: 'button',
                class: 'list-item pfx-pick-item',
                onclick: () => {
                  m.close();
                  openOptimize(inst.id);
                },
              },
              instanceIcon(inst),
              h('div', { class: 'li-main' }, h('div', { class: 'li-title', title: inst.name }, inst.name), h('div', { class: 'li-sub' }, t('perf.mcVersion', { version: inst.mcVersion }))),
              loaderBadge(instanceLoaderKey(inst)),
              icon('chevronRight', 'pfx-chev'),
            ),
          ),
        )
      : emptyState(
          'layers',
          t('perf.optimizePickEmpty'),
          t('perf.optimizePickEmptyText'),
          h(
            'button',
            {
              class: 'btn primary',
              type: 'button',
              onclick: () => {
                m.close();
                navigate('versions/new');
              },
            },
            icon('plus'),
            t('perf.createInstance'),
          ),
        ),
  });
}

// ---------- Formato de opciones de video ----------
function fmtOption(key, v) {
  if (v === undefined || v === null) return t('perf.val_unset');
  switch (key) {
    case 'renderDistance':
    case 'simulationDistance':
      return t('perf.val_chunks', { n: v });
    case 'graphicsMode':
      return t(`perf.val_graphics_${v}`);
    case 'particles':
      return t(`perf.val_particles_${v}`);
    case 'renderClouds':
      return t(`perf.val_clouds_${v}`);
    case 'maxFps':
      return v >= 260 ? t('perf.val_unlimited') : String(v);
    case 'entityDistanceScaling':
      return t('perf.val_percent', { n: Math.round(v * 100) });
    case 'biomeBlendRadius': {
      const side = v * 2 + 1;
      return v === 0 ? t('perf.val_off') : `${side}×${side}`;
    }
    case 'entityShadows':
    case 'enableVsync':
    case 'ao':
      return v ? t('perf.val_on') : t('perf.val_off');
    default:
      return String(v);
  }
}

// ---------- Dialogo "Optimizar" ----------
// Antes de sumar mods: chequeo de compatibilidad (modulo compat) e instantanea (modulo snapshots).
// Si esos modulos todavia no existen, se sigue igual.
async function beforeRiskyChange(instanceId, items, reason) {
  if (!items.length) return true;
  try {
    const compat = await import('./compat.js');
    if (typeof compat.checkBeforeInstall === 'function') {
      const go = await compat.checkBeforeInstall({ target: { kind: 'instance', id: instanceId }, items });
      if (go === false) return false;
    }
  } catch (err) {
    console.warn('[perf] compat', err);
  }
  try {
    const snaps = await import('./snapshots.js');
    if (typeof snaps.snapshotBefore === 'function') await snaps.snapshotBefore(instanceId, reason);
  } catch (err) {
    console.warn('[perf] snapshot', err);
  }
  return true;
}

function checkRow({ checked = true, disabled = false, title, sub, aside, iconEl, onChange }) {
  const input = h('input', { type: 'checkbox', checked, disabled });
  input.addEventListener('change', () => onChange?.(input.checked));
  return h(
    'label',
    { class: ['pfx-check', disabled && 'disabled'] },
    input,
    h('span', { class: 'pfx-box', 'aria-hidden': 'true' }, icon('check')),
    iconEl || null,
    h('span', { class: 'pfx-check-main' }, h('span', { class: 'pfx-check-title' }, title), sub ? h('span', { class: 'pfx-check-sub' }, sub) : null),
    aside || null,
  );
}

function modIcon(url) {
  if (!url || !/^https:\/\//.test(url)) return h('span', { class: 'pfx-modicon' }, icon('package'));
  const img = h('img', { src: url, alt: '', loading: 'lazy' });
  img.addEventListener('error', () => img.replaceWith(icon('package')), { once: true });
  return h('span', { class: 'pfx-modicon' }, img);
}

// Que proponer sobre la memoria de la instancia:
// - automatica (sin modo bajos recursos): nada, ya se recalcula en cada partida contando los mods nuevos;
// - global o personalizada: el valor recomendado, sin bajar por defecto una eleccion propia salvo en bajos recursos.
function memProposal(r, lowEnd) {
  const cm = r.currentMemory;
  if (!cm) return { show: false, preselect: false };
  if (cm.mode === 'auto' && !lowEnd) return { show: false, auto: true, preselect: false };
  if (cm.max === r.memory.max) return { show: false, preselect: false };
  return { show: true, preselect: lowEnd || cm.mode !== 'custom' || (cm.max || 0) < r.memory.max };
}

function section(title, count, ...children) {
  return h('section', { class: 'pfx-sec' }, h('div', { class: 'pfx-sec-head' }, h('h4', {}, title), count ? h('span', { class: 'badge accent' }, count) : null), ...children);
}

export async function openOptimize(instanceId, { tab = 'perf' } = {}) {
  await ensurePerfUi();
  let inst = store.instances.find((i) => i.id === instanceId) || null;
  if (!inst) inst = await api.instances.get(instanceId).catch(() => null);
  if (!inst) {
    fail(t('perf.optimizeError'), t('perf.errNoInstance'));
    return;
  }

  const state = { tab, lowEnd: false, rec: null, recError: null, packs: null, packsError: null, packsLoading: false };
  let recToken = 0;
  const sel = { memory: false, jvm: false, mods: new Set(), options: new Set(), packs: new Set() };

  const headPill = h('span', { class: 'pfx-head-pill' });
  const content = h('div', { class: 'pfx-opt-content' });
  const runningBox = h('div');
  const applyBtn = h('button', { type: 'button', class: 'btn primary' }, icon('zap'), t('perf.applyNothing'));
  const lowEndSwitch = switchEl(false, (v) => {
    state.lowEnd = v;
    loadRec();
  }, t('perf.lowEnd'));
  const tabs = h('div', { class: 'segmented pfx-tabs', role: 'tablist', 'aria-label': t('perf.tabsAria') });

  const isRunning = () => Boolean(store.running[instanceId]);

  const TABS = [
    ['perf', t('perf.tabPerf'), 'gauge'],
    ['packs', t('perf.tabPacks'), 'package'],
  ];
  const selectTab = (key) => {
    if (state.tab === key) return;
    state.tab = key;
    drawTabs();
    drawContent();
    updateApply();
    if (key === 'packs' && !state.packs && !state.packsLoading) loadPacks();
  };
  tabs.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    selectTab(state.tab === 'perf' ? 'packs' : 'perf');
    tabs.querySelector('.active')?.focus();
  });
  const drawTabs = () =>
    mount(
      tabs,
      TABS.map(([key, label, ic]) =>
        h(
          'button',
          {
            type: 'button',
            role: 'tab',
            'aria-selected': String(state.tab === key),
            tabindex: state.tab === key ? 0 : -1,
            class: state.tab === key ? 'active' : null,
            onclick: () => selectTab(key),
          },
          icon(ic),
          label,
        ),
      ),
    );

  const lowEndText = h('span', { class: 'pfx-lowend-text' }, h('span', { class: 'pfx-lowend-title' }, t('perf.lowEnd')), h('span', { class: 'pfx-lowend-sub' }, t('perf.lowEndHint')));
  lowEndText.addEventListener('click', () => lowEndSwitch.querySelector('input')?.click());
  const lowEndBox = h('div', { class: 'pfx-lowend' }, lowEndSwitch, lowEndText);

  // El nombre ya esta en el titulo: la franja muestra version, loader y la gama de la PC.
  const head = h(
    'div',
    { class: 'pfx-opt-head' },
    instanceIcon(inst),
    h('div', { class: 'pfx-opt-inst' }, h('span', { class: 'badge' }, icon('box'), t('perf.mcVersion', { version: inst.mcVersion })), loaderBadge(instanceLoaderKey(inst))),
    headPill,
  );

  const body = h('div', { class: 'pfx-opt' }, head, h('div', { class: 'pfx-opt-bar' }, tabs, lowEndBox), runningBox, content);
  const offRunning = store.on('running', () => {
    drawRunning();
    updateApply();
  });
  const m = modal({
    title: t('perf.optimizeHeading'),
    subtitle: inst.name,
    icon: 'gauge',
    body,
    size: 'wide',
    footer: [h('button', { type: 'button', class: 'btn ghost', onclick: () => m.close() }, t('common.cancel')), applyBtn],
    onClose: () => offRunning(),
  });
  m.el.classList.add('pfx-modal');

  function drawRunning() {
    mount(runningBox, isRunning() ? h('div', { class: 'notice pfx-running' }, icon('alert'), h('div', {}, t('perf.running'))) : null);
  }

  function changeCount() {
    if (state.tab === 'packs') return sel.packs.size;
    const r = state.rec;
    if (!r) return 0;
    return (sel.memory ? 1 : 0) + (sel.jvm ? 1 : 0) + sel.mods.size + sel.options.size;
  }

  function updateApply() {
    if (applyBtn.classList.contains('loading')) return;
    const n = changeCount();
    const waiting = state.tab === 'perf' ? !state.rec : !state.packs;
    applyBtn.disabled = waiting || n === 0 || isRunning();
    // Mientras se analiza no se dice "nada para cambiar": todavia no se sabe
    const label = waiting ? t('perf.applyIdle') : n === 0 ? t('perf.applyNothing') : state.tab === 'packs' ? t('perf.installPacks', { count: n }) : t('perf.apply', { count: n });
    mount(applyBtn, icon(state.tab === 'packs' ? 'download' : 'zap'), label);
  }

  // ----- Pestaña Rendimiento -----
  async function loadRec() {
    const token = ++recToken;
    state.rec = null;
    state.recError = null;
    drawContent();
    updateApply();
    let rec = null;
    let error = null;
    try {
      rec = await api.invoke('perf:recommend', { instanceId, lowEnd: state.lowEnd });
    } catch (err) {
      error = err.message;
    }
    if (token !== recToken) return; // llego tarde: ya se pidio otra recomendacion
    if (rec) {
      state.rec = rec;
      // Seleccion inicial: todo lo que cambia algo
      sel.memory = memProposal(rec, state.lowEnd).preselect;
      sel.jvm = rec.jvmPreset !== rec.currentJvmPreset;
      sel.mods = new Set(rec.mods.filter((x) => !x.installed).map((x) => x.projectId));
      sel.options = new Set(OPTION_ORDER.filter((k) => rec.options[k] !== undefined && rec.currentOptions?.[k] !== rec.options[k]));
      mount(headPill, tierPill({ ...rec.system, tier: rec.tier }));
    } else state.recError = error;
    drawContent();
    updateApply();
  }

  function perfTab() {
    if (state.recError) {
      return h(
        'div',
        { class: 'notice bad pfx-error', role: 'alert' },
        icon('alert'),
        h('div', {}, t('perf.loadError', { error: state.recError })),
        h('button', { type: 'button', class: 'btn sm', onclick: loadRec }, icon('refresh'), t('common.retry')),
      );
    }
    const r = state.rec;
    if (!r) {
      return waitSkeleton(t('perf.analyzing'), [
        bone('pfx-skel-block'),
        bone('skeleton-line pfx-skel-title'),
        h('div', { class: 'pfx-skel-grid' }, bone(''), bone('')),
        bone('skeleton-line pfx-skel-title'),
        h('div', { class: 'pfx-skel-grid' }, bone(''), bone(''), bone(''), bone('')),
      ]);
    }
    const parts = [h('div', { class: 'notice info pfx-reason' }, icon('sparkles'), h('div', {}, r.reason))];
    // Sin loader de mods, la nota va dentro del recuadro "Crear instancia Fabric" (no se repite)
    const notes = r.loaderSupported ? r.notes || [] : (r.notes || []).slice(1);
    for (const n of notes) parts.push(h('div', { class: 'notice' }, icon('info'), h('div', {}, n)));

    // Memoria y Java
    const memRows = [];
    const cm = r.currentMemory;
    const prop = memProposal(r, state.lowEnd);
    if (prop.show) {
      memRows.push(
        checkRow({
          checked: sel.memory,
          title: t('perf.memRow', { mem: fmtMb(r.memory.max) }),
          sub: t(`perf.memNow_${cm.mode}`, { mem: fmtMb(cm.max || 0) }),
          iconEl: h('span', { class: 'pfx-rowicon' }, icon('memory')),
          onChange: (v) => {
            sel.memory = v;
            updateApply();
          },
        }),
      );
    } else if (prop.auto) {
      memRows.push(h('div', { class: 'pfx-okline' }, icon('check'), t('perf.memAutoOk', { mem: fmtMb(r.memory.max) })));
    } else if (cm) {
      memRows.push(h('div', { class: 'pfx-okline' }, icon('check'), t('perf.memOk', { mem: fmtMb(cm.max || r.memory.max) })));
    }
    if (r.jvmPreset !== r.currentJvmPreset) {
      memRows.push(
        checkRow({
          checked: sel.jvm,
          title: t('perf.jvmRow', { name: t(`perf.gc_${r.jvmPreset}`) }),
          sub: t('perf.jvmNow', { name: t(`perf.gc_${r.currentJvmPreset}`) }),
          iconEl: h('span', { class: 'pfx-rowicon' }, icon('coffee')),
          onChange: (v) => {
            sel.jvm = v;
            updateApply();
          },
        }),
      );
    }
    parts.push(section(t('perf.secMemory'), null, ...memRows));

    // Mods
    if (r.loaderSupported) {
      const toAdd = r.mods.filter((x) => !x.installed).length;
      let modsBody;
      if (r.modsError) modsBody = [h('div', { class: 'notice' }, icon('wifi'), h('div', {}, r.modsError))];
      else if (!r.mods.length) modsBody = [h('div', { class: 'pfx-okline muted' }, icon('info'), t('perf.modsNone'))];
      else {
        modsBody = [
          h(
            'div',
            { class: 'pfx-mods' },
            r.mods.map((mod) =>
              checkRow({
                checked: mod.installed || sel.mods.has(mod.projectId),
                disabled: mod.installed,
                title: mod.title,
                sub: mod.reason,
                iconEl: modIcon(mod.icon),
                aside: mod.installed ? h('span', { class: 'badge good' }, icon('check'), t('perf.installed')) : null,
                onChange: (v) => {
                  if (v) sel.mods.add(mod.projectId);
                  else sel.mods.delete(mod.projectId);
                  updateApply();
                },
              }),
            ),
          ),
        ];
        if (!toAdd) modsBody.unshift(h('div', { class: 'pfx-okline' }, icon('check'), t('perf.modsAllInstalled')));
      }
      parts.push(section(t('perf.secMods'), toAdd ? t('perf.secModsCount', { count: toAdd }) : null, ...modsBody));
    } else {
      parts.push(
        section(
          t('perf.secMods'),
          null,
          h(
            'div',
            { class: 'pfx-switch-loader' },
            icon('info'),
            h('div', { class: 'small text-2' }, r.notes?.[0] || t('perf.switchLoaderText')),
            h(
              'button',
              {
                type: 'button',
                class: 'btn sm',
                onclick: () => {
                  m.close();
                  // Instalar nueva con Fabric y la misma version de Minecraft ya elegidas
                  navigate(`versions/new/fabric/${encodeURIComponent(inst.mcVersion)}`);
                },
              },
              icon('plus'),
              t('perf.switchLoader'),
            ),
          ),
        ),
      );
    }

    // Opciones de video
    const keys = OPTION_ORDER.filter((k) => r.options[k] !== undefined && r.currentOptions?.[k] !== r.options[k]);
    let optBody;
    if (!keys.length) optBody = [h('div', { class: 'pfx-okline' }, icon('check'), t('perf.optionsOk'))];
    else {
      optBody = [
        r.optionsFileExists ? null : h('div', { class: 'small muted pfx-opts-note' }, t('perf.optionsNew')),
        h(
          'div',
          { class: 'pfx-opts' },
          keys.map((k) =>
            checkRow({
              checked: sel.options.has(k),
              title: t(`perf.opt_${k}`),
              aside: h(
                'span',
                { class: 'pfx-change' },
                r.optionsFileExists ? h('span', { class: 'from' }, fmtOption(k, r.currentOptions?.[k])) : null,
                r.optionsFileExists ? icon('arrowRight') : null,
                h('span', { class: 'to' }, fmtOption(k, r.options[k])),
              ),
              onChange: (v) => {
                if (v) sel.options.add(k);
                else sel.options.delete(k);
                updateApply();
              },
            }),
          ),
        ),
      ];
    }
    parts.push(section(t('perf.secOptions'), keys.length ? t('perf.secOptionsCount', { count: keys.length }) : null, ...optBody));
    return h('div', { class: 'stack pfx-perf' }, parts);
  }

  // ----- Pestaña Packs -----
  async function loadPacks() {
    state.packsLoading = true;
    state.packsError = null;
    drawContent();
    try {
      state.packs = await api.invoke('catalog:packs', { instanceId });
    } catch (err) {
      state.packsError = err.message;
    }
    state.packsLoading = false;
    drawContent();
    updateApply();
  }

  function packsTab() {
    if (state.packsError) {
      return h(
        'div',
        { class: 'notice bad pfx-error', role: 'alert' },
        icon('alert'),
        h('div', {}, t('perf.packsError', { error: state.packsError })),
        h('button', { type: 'button', class: 'btn sm', onclick: loadPacks }, icon('refresh'), t('common.retry')),
      );
    }
    if (!state.packs) return waitSkeleton(t('perf.packsLoading', { version: inst.mcVersion }), [h('div', { class: 'pfx-skel-grid tall' }, bone(''), bone(''), bone(''), bone(''))]);
    return h(
      'div',
      { class: 'pfx-packs' },
      state.packs.map((p) => {
        const pending = p.items.filter((i) => i.available && !i.installed).length;
        const disabled = pending === 0;
        if (disabled) sel.packs.delete(p.id);
        const input = h('input', { type: 'checkbox', checked: sel.packs.has(p.id), disabled, 'aria-label': p.title });
        const card = h(
          'label',
          { class: ['pfx-pack', sel.packs.has(p.id) && 'selected', disabled && 'disabled'] },
          input,
          h(
            'div',
            { class: 'pfx-pack-head' },
            h('span', { class: 'pfx-pack-icon' }, icon(p.icon || 'package')),
            h('div', { class: 'pfx-pack-text' }, h('div', { class: 'pfx-pack-title' }, p.title), h('div', { class: 'pfx-pack-desc' }, p.description)),
            h('span', { class: 'pfx-box', 'aria-hidden': 'true' }, icon('check')),
          ),
          h(
            'div',
            { class: 'pfx-pack-items' },
            p.items.map((it) =>
              h(
                'span',
                {
                  class: ['pfx-item', !it.available && 'off', it.installed && 'done'],
                  title: !it.available ? t('perf.packUnavailable') : it.installed ? t('perf.installed') : it.title,
                },
                it.installed ? icon('check') : it.type === 'shader' ? icon('sun') : null,
                it.title,
              ),
            ),
          ),
          p.note ? h('div', { class: 'pfx-pack-note' }, p.note) : null,
          !p.note && pending === 0 && p.available > 0 ? h('div', { class: 'pfx-pack-note good' }, t('perf.packInstalledAll')) : null,
        );
        input.addEventListener('change', () => {
          if (input.checked) sel.packs.add(p.id);
          else sel.packs.delete(p.id);
          card.classList.toggle('selected', input.checked);
          updateApply();
        });
        return card;
      }),
    );
  }

  function drawContent() {
    lowEndBox.classList.toggle('hidden', state.tab !== 'perf');
    mount(content, state.tab === 'perf' ? perfTab() : packsTab());
  }

  // ----- Aplicar -----
  applyBtn.addEventListener('click', async () => {
    if (applyBtn.disabled) return;
    if (state.tab === 'packs') {
      const ids = [...sel.packs];
      const items = state.packs.filter((p) => sel.packs.has(p.id)).flatMap((p) => p.items.filter((i) => i.available && !i.installed && i.projectId).map((i) => ({ projectId: i.projectId, versionId: i.versionId })));
      const done = setBusy(applyBtn);
      const go = await beforeRiskyChange(instanceId, items, t('perf.snapshotReasonPacks'));
      done();
      if (!go) {
        updateApply();
        return;
      }
      m.close();
      try {
        const r = await api.invoke('catalog:installPacks', instanceId, ids);
        reportResult(t('perf.packsInstalledTitle', { name: inst.name }), r);
      } catch (err) {
        fail(t('perf.packsInstallError'), err);
      }
      store.refreshInstances().catch(() => {});
      return;
    }
    const r = state.rec;
    const mods = r.mods.filter((x) => !x.installed && sel.mods.has(x.projectId)).map((x) => ({ projectId: x.projectId, versionId: x.versionId, title: x.title }));
    const opts = {
      memory: sel.memory ? r.memory : null,
      jvmPreset: sel.jvm ? r.jvmPreset : undefined,
      mods,
      options: Object.fromEntries([...sel.options].map((k) => [k, r.options[k]])),
      lowEnd: state.lowEnd,
    };
    const done = setBusy(applyBtn);
    const go = await beforeRiskyChange(instanceId, mods.map((x) => ({ projectId: x.projectId, versionId: x.versionId })), t('perf.snapshotReason'));
    done();
    if (!go) {
      updateApply();
      return;
    }
    m.close();
    try {
      const res = await api.invoke('perf:applyRecommended', instanceId, opts);
      reportResult(t('perf.appliedTitle', { name: inst.name }), res);
    } catch (err) {
      fail(t('perf.optimizeError'), err);
    }
    store.refreshInstances().catch(() => {});
  });

  drawTabs();
  drawRunning();
  drawContent();
  updateApply();
  if (state.tab === 'packs') loadPacks();
  loadRec();
}

function reportResult(title, r) {
  const installed = r?.installed?.length || 0;
  const failed = r?.failed || [];
  if (failed.length) {
    toast('bad', title, t('perf.appliedFailed', { list: failed.map((f) => f.title).join(', ') }), 9000);
    return;
  }
  ok(title, installed ? t('perf.appliedText', { count: installed }) : t('perf.appliedNoMods'));
}

// Atajo: abrir directamente la pestaña de packs de contenido.
export function openPacks(instanceId) {
  return openOptimize(instanceId, { tab: 'packs' });
}
