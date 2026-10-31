// Instantáneas ("volver atrás con un clic"): línea de tiempo de una instancia, crear con o sin mundos,
// restaurar mostrando antes qué cambia (con deshacer), fijar/renombrar/borrar y opciones automáticas.
// Para otros módulos: snapshotBefore(instanceId, reason) guarda una rápida (sin mundos) antes de un cambio riesgoso.
import { h, icon, mount, modal, toast, ensureCss, registerIcons, fmtBytes, fmtAgo, fmtDate, fmtTime, emptyState, switchEl, selectEl, instanceIcon, loaderBadge, instanceLoaderKey, LOADERS, skeleton, setBusy } from '../ui.js';
import { store, api } from '../store.js';
import { t, has, loadNs } from '../i18n.js';

registerIcons({
  snpPin: '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>',
  snpMinus: '<path d="M5 12h14"/>',
});

const DEFAULTS = { autoBeforePlay: true, keepAuto: 10, keepDays: 30, autoIntervalHours: 6 };
const REASON_ICON = { manual: 'save', beforePlay: 'play', beforeRestore: 'undo', packUpdate: 'package', modUpdate: 'refresh', import: 'download', crash: 'bug' };
const GROUP_ICON = { mods: 'puzzle', packs: 'palette', config: 'sliders', options: 'settings', modpack: 'package' };
const KEEP_OPTIONS = [3, 5, 10, 20, 50];
const DAY_OPTIONS = [7, 30, 90, 0];
const NAMES_SHOWN = 8;

async function ready() {
  ensureCss('features/snapshots');
  try {
    await loadNs('snapshots');
  } catch {
    /* sin textos se ven las claves, pero no se rompe nada */
  }
}

const isMissing = (err) => /No handler registered/i.test(err?.message || '');
const errText = (err) => err?.message || String(err);

function fileUrl(p, version) {
  const parts = String(p || '').replace(/\\/g, '/').split('/');
  const enc = parts.map((s, i) => (i === 0 && /^[a-zA-Z]:$/.test(s) ? s : encodeURIComponent(s))).join('/');
  return `file:///${enc.replace(/^\/+/, '')}${version ? `?v=${encodeURIComponent(version)}` : ''}`;
}

function reasonOf(s) {
  const code = s.reasonCode || (s.kind === 'manual' ? 'manual' : null);
  if (code && has(`snapshots.reason_${code}`)) return { code, text: t(`snapshots.reason_${code}`) };
  return { code: null, text: s.reason || t('snapshots.reason_other') };
}

// "Hace un momento" -> "hace un momento" cuando va dentro de una frase.
function lower(text) {
  const s = String(text || '');
  return s ? s.charAt(0).toLocaleLowerCase() + s.slice(1) : s;
}

function stamp(ts) {
  return `${fmtDate(ts)} · ${fmtTime(ts)}`;
}

function versionLabel(meta) {
  if (!meta?.mcVersion) return '';
  const key = meta.preset === 'iris' ? 'iris' : meta.loader;
  const name = LOADERS[key]?.name || key;
  return key && key !== 'vanilla' ? `${meta.mcVersion} · ${name}` : meta.mcVersion;
}

function sameVersion(a, b) {
  return a && b && a.mcVersion === b.mcVersion && (a.loader || 'vanilla') === (b.loader || 'vanilla');
}

// Ventana con vistas (lista, crear, restaurar, progreso): una sola ventana de alto estable (no salta al
// cambiar de vista), Escape la cierra entera.
function shell(title, onClose) {
  const body = h('div', { class: 'snp' });
  // Encabezado comun de las herramientas de una instancia (icono + titulo); la instancia se ve en la tarjeta de arriba
  const m = modal({ title, icon: 'history', body, size: 'wide snp-modal', footer: [h('span', { class: 'snp-foot-spacer' })], onClose });
  const foot = m.el.querySelector('.modal-foot');
  const bodyBox = m.el.querySelector('.modal-body');
  return {
    m,
    show(parts, footer, { keepScroll = false } = {}) {
      const scroll = bodyBox ? bodyBox.scrollTop : 0;
      mount(body, ...parts);
      mount(foot, ...(footer || []));
      foot.classList.toggle('hidden', !footer || !footer.length);
      if (bodyBox) bodyBox.scrollTop = keepScroll ? scroll : 0;
      // Al cambiar de vista el foco no se pierde: va al primer control de la vista (o al boton de cerrar).
      if (!m.el.contains(document.activeElement)) {
        const target = m.el.querySelector('.modal-body button:not(:disabled), .modal-body input:not(:disabled), .modal-body select:not(:disabled)') || m.el.querySelector('.modal-head button');
        target?.focus({ preventScroll: true });
      }
    },
    // Despues de redibujar, el foco vuelve al control con esa clave (data-fk) si sigue en la vista
    focus(key) {
      const el = key && m.el.querySelector(`[data-fk="${CSS.escape(key)}"]`);
      if (el && !el.disabled) el.focus({ preventScroll: true });
      return Boolean(el);
    },
  };
}

function viewHead(title, onBack, extra) {
  return h(
    'div',
    { class: 'snp-view-head' },
    onBack ? h('button', { type: 'button', class: 'icon-btn sm', title: t('snapshots.back'), 'aria-label': t('snapshots.back'), onclick: onBack }, icon('arrowLeft')) : null,
    h('h4', { class: 'snp-view-title' }, title),
    extra || null,
  );
}

function progressView(text) {
  const bar = h('i', { style: { width: '0%' } });
  const progress = h('div', { class: 'progress indeterminate', role: 'progressbar', 'aria-label': text }, bar);
  const detail = h('div', { class: 'snp-progress-detail', 'aria-live': 'polite' }, ' ');
  const el = h('div', { class: 'snp-progress', role: 'status' }, h('div', { class: 'snp-progress-icon', 'aria-hidden': 'true' }, h('div', { class: 'spinner lg' })), h('div', { class: 'snp-progress-title' }, text), progress, detail);
  return {
    el,
    update(task) {
      if (task.detail) detail.textContent = task.detail;
      if (typeof task.progress === 'number') {
        const pct = Math.round(task.progress * 100);
        progress.classList.remove('indeterminate');
        progress.setAttribute('aria-valuenow', String(pct));
        bar.style.width = `${pct}%`;
      }
    },
  };
}

// Sigue las tareas del proceso principal de esta instancia (crear/restaurar) para mostrar el avance.
function followTask(instanceId, kinds, onUpdate) {
  return store.on('task', (task) => {
    if (task?.meta?.instanceId === instanceId && kinds.includes(task.meta?.kind)) onUpdate(task);
  });
}

export async function openSnapshots(instanceId) {
  await ready();
  let inst = store.instances.find((i) => i.id === instanceId) || null;
  if (!inst) inst = await api.instances.get(instanceId).catch(() => null);
  if (!inst) {
    toast('bad', t('snapshots.title'), t('snapshots.errNoInstance'));
    return;
  }

  const state = { items: null, error: null, missing: false, settings: { ...DEFAULTS }, usage: null, view: 'list', busy: false, confirm: null, renaming: null, focus: null };
  const offs = [];
  // El titulo dice que es; la tarjeta de arriba dice de que instancia (sin repetir el nombre dos veces)
  const ui = shell(t('snapshots.title'), () => offs.forEach((off) => off()));
  const running = () => Boolean(store.running[instanceId]);

  offs.push(
    api.on('snapshots:changed', (id) => {
      if (id === instanceId && state.view === 'list' && !state.busy) load({ keepScroll: true });
    }),
    store.on('running', () => {
      if (state.view === 'list') renderList({ keepScroll: true });
    }),
    store.on('instances', (list) => {
      const fresh = list.find((i) => i.id === instanceId);
      if (fresh) inst = fresh;
    }),
  );

  async function load({ keepScroll = false } = {}) {
    try {
      const r = await api.invoke('snapshots:list', instanceId);
      state.items = r.items || [];
      state.settings = { ...DEFAULTS, ...(r.settings || {}) };
      state.error = null;
    } catch (err) {
      state.items = null;
      state.missing = isMissing(err);
      state.error = errText(err);
    }
    if (state.view === 'list') renderList({ keepScroll });
    loadUsage();
  }

  async function loadUsage() {
    try {
      state.usage = await api.invoke('snapshots:usage', instanceId);
    } catch {
      state.usage = null;
    }
    if (state.view === 'list') renderSettings();
  }

  // ---------- Lista ----------
  const settingsSlot = h('div', { class: 'snp-settings-slot' });

  function header() {
    const count = state.items?.length || 0;
    // Sin instantaneas el boton principal es el del estado vacio: aca no se repite
    const empty = Boolean(state.items && !count && !state.error);
    return h(
      'div',
      { class: 'snp-head' },
      instanceIcon(inst, 'snp-inst-icon'),
      h(
        'div',
        { class: 'snp-head-text' },
        h('div', { class: 'snp-head-name ellipsis', title: inst.name }, inst.name),
        h('div', { class: 'snp-head-meta' }, h('span', { class: 'badge' }, icon('box'), inst.mcVersion), loaderBadge(instanceLoaderKey(inst)), state.items ? h('span', { class: 'snp-head-count' }, icon('history'), t('snapshots.count', { count })) : null),
      ),
      empty ? null : h('button', { type: 'button', class: 'btn primary', disabled: Boolean(state.error) || !state.items, dataset: { fk: 'create' }, onclick: () => showCreate() }, icon('plus'), t('snapshots.create')),
    );
  }

  function renderList({ keepScroll = false } = {}) {
    state.view = 'list';
    const parts = [header()];
    if (running()) parts.push(h('div', { class: 'notice snp-running' }, icon('alert'), h('div', {}, t('snapshots.running'))));
    if (state.error) {
      parts.push(
        state.missing
          ? emptyState('history', t('snapshots.title'), t('snapshots.unavailable'))
          : h('div', { class: 'notice bad', role: 'alert' }, icon('alert'), h('div', { class: 'snp-notice-body' }, h('div', {}, t('snapshots.loadError', { error: state.error })), h('button', { type: 'button', class: 'btn sm', onclick: load }, icon('refresh'), t('snapshots.retry')))),
      );
    } else if (!state.items) parts.push(h('div', { class: 'snp-skeleton' }, skeleton('list', { rows: 3, label: t('snapshots.loading') })));
    else if (!state.items.length) {
      parts.push(h('div', { class: 'snp-empty' }, emptyState('history', t('snapshots.emptyTitle'), t('snapshots.emptyText'), h('button', { type: 'button', class: 'btn primary', dataset: { fk: 'create-first' }, onclick: () => showCreate() }, icon('save'), t('snapshots.createFirst')))));
    } else {
      parts.push(h('p', { class: 'snp-intro' }, t('snapshots.intro')));
      parts.push(h('ol', { class: 'snp-timeline', 'aria-label': t('snapshots.timeline') }, state.items.map((s, i) => timelineItem(s, i === 0))));
    }
    parts.push(settingsSlot);
    renderSettings();
    ui.show(parts, [h('button', { type: 'button', class: 'btn ghost', onclick: () => ui.m.close() }, t('snapshots.close'))], { keepScroll });
    // Despues de confirmar, renombrar o fijar, el foco vuelve a donde estaba (no salta al principio)
    if (state.focus) {
      ui.focus(state.focus);
      state.focus = null;
    }
  }

  function timelineItem(s, latest) {
    const reason = reasonOf(s);
    const title = s.label || (reason.code === 'manual' ? t('snapshots.manualTitle') : reason.text);
    // Etiqueta chica: el motivo si hay nombre propio; si no, si fue automatica.
    const chip = s.label ? reason.text : s.kind === 'manual' ? null : t('snapshots.kindAuto');
    const stats = s.stats || {};
    const changedVersion = s.instance && !sameVersion(s.instance, inst);
    const confirming = state.confirm === s.id;
    const renaming = state.renaming === s.id;
    const busy = state.busy;

    let titleEl;
    if (renaming) {
      const input = h('input', { class: 'input snp-rename', value: s.label || '', maxlength: 80, placeholder: t('snapshots.renamePlaceholder'), 'aria-label': t('snapshots.rename') });
      const saveBtn = h('button', { type: 'button', class: 'btn sm' }, icon('check'), t('snapshots.saveName'));
      const save = async () => {
        if (saveBtn.disabled) return;
        const release = setBusy(saveBtn);
        await act(() => api.invoke('snapshots:update', instanceId, s.id, { label: input.value }));
        release();
        state.renaming = null;
        state.focus = `ren|${s.id}`;
        renderList({ keepScroll: true });
      };
      saveBtn.addEventListener('click', save);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') save();
        if (e.key === 'Escape') {
          e.stopPropagation(); // que no se cierre toda la ventana
          state.renaming = null;
          state.focus = `ren|${s.id}`;
          renderList({ keepScroll: true });
        }
      });
      setTimeout(() => input.focus(), 20);
      titleEl = h('div', { class: 'snp-rename-row' }, input, saveBtn);
    } else {
      titleEl = h('div', { class: 'snp-item-title' }, h('span', { class: 'ellipsis', title }, title), s.pinned ? h('span', { class: 'badge accent snp-pin-badge', title: t('snapshots.pin') }, icon('snpPin'), t('snapshots.pinned')) : null);
      // Detalle que dejo quien la creo (ej. "Actualizacion del modpack 14.0.0 -> 14.1.1") cuando hay un motivo conocido.
      if (reason.code && s.reason && s.reason !== title) titleEl = [titleEl, h('div', { class: 'snp-item-reason ellipsis', title: s.reason }, s.reason)];
    }

    // Borrar se confirma en la misma fila: el foco va a "Cancelar" (lo seguro) y vuelve al tacho al cancelar
    const actions = confirming
      ? h(
          'div',
          { class: 'snp-confirm', role: 'group', 'aria-label': t('snapshots.deleteConfirm') },
          h('span', { class: 'snp-confirm-text' }, t('snapshots.deleteConfirm')),
          h(
            'button',
            {
              type: 'button',
              class: 'btn sm ghost',
              dataset: { fk: `no|${s.id}` },
              onclick: () => {
                state.confirm = null;
                state.focus = `del|${s.id}`;
                renderList({ keepScroll: true });
              },
            },
            t('snapshots.cancel'),
          ),
          h('button', { type: 'button', class: 'btn sm danger', dataset: { fk: `yes|${s.id}` }, onclick: (e) => remove(s, e.currentTarget) }, icon('trash'), t('snapshots.deleteYes')),
        )
      : h(
          'div',
          { class: 'snp-actions' },
          h('button', { type: 'button', class: 'btn sm', dataset: { fk: `res|${s.id}` }, disabled: busy || running(), title: running() ? t('snapshots.running') : t('snapshots.restore'), onclick: () => showRestore(s) }, icon('undo'), t('snapshots.restore')),
          h(
            'button',
            {
              type: 'button',
              class: ['icon-btn sm', s.pinned && 'active'],
              title: s.pinned ? t('snapshots.unpin') : t('snapshots.pin'),
              'aria-label': s.pinned ? t('snapshots.unpin') : t('snapshots.pin'),
              'aria-pressed': String(Boolean(s.pinned)),
              dataset: { fk: `pin|${s.id}` },
              disabled: busy,
              onclick: async () => {
                await act(() => api.invoke('snapshots:update', instanceId, s.id, { pinned: !s.pinned }));
                state.focus = `pin|${s.id}`;
                await load({ keepScroll: true });
              },
            },
            icon('snpPin'),
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'icon-btn sm',
              title: t('snapshots.rename'),
              'aria-label': t('snapshots.rename'),
              dataset: { fk: `ren|${s.id}` },
              disabled: busy,
              onclick: () => {
                state.renaming = s.id;
                state.confirm = null;
                renderList({ keepScroll: true });
              },
            },
            icon('edit'),
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'icon-btn sm danger',
              title: t('snapshots.delete'),
              'aria-label': t('snapshots.delete'),
              dataset: { fk: `del|${s.id}` },
              disabled: busy,
              onclick: () => {
                state.confirm = s.id;
                state.renaming = null;
                state.focus = `no|${s.id}`;
                renderList({ keepScroll: true });
              },
            },
            icon('trash'),
          ),
        );

    return h(
      'li',
      { class: ['snp-item', `snp-kind-${s.kind === 'manual' ? 'manual' : 'auto'}`, s.pinned && 'pinned', latest && 'latest', confirming && 'confirming'] },
      h('div', { class: 'snp-dot', 'aria-hidden': 'true' }, icon(REASON_ICON[reason.code] || 'history')),
      h(
        'div',
        { class: 'snp-item-main' },
        h('div', { class: 'snp-item-when' }, h('time', { datetime: new Date(s.createdAt).toISOString() }, stamp(s.createdAt)), h('span', { class: 'snp-ago' }, fmtAgo(s.createdAt)), chip ? h('span', { class: ['snp-kind', s.kind === 'manual' ? 'manual' : 'auto'] }, chip) : null),
        titleEl,
        h(
          'div',
          { class: 'snp-item-stats' },
          h('span', {}, icon('file'), t('snapshots.files', { count: stats.files || 0 })),
          h('span', {}, icon('database'), fmtBytes(stats.bytes || 0)),
          h('span', { class: stats.newBytes ? 'snp-new' : 'snp-same' }, icon(stats.newBytes ? 'plus' : 'check'), stats.newBytes ? t('snapshots.added', { size: fmtBytes(stats.newBytes) }) : t('snapshots.nothingNew')),
          changedVersion ? h('span', { class: 'snp-version', title: t('snapshots.versionThenTitle', { version: versionLabel(s.instance) }) }, icon('layers'), t('snapshots.versionThen', { version: versionLabel(s.instance) })) : null,
        ),
        s.worlds?.length ? h('div', { class: 'snp-worlds-chips' }, s.worlds.slice(0, 6).map((w) => h('span', { class: 'snp-world-chip', title: w }, icon('globe'), h('span', { class: 'ellipsis' }, w))), s.worlds.length > 6 ? h('span', { class: 'snp-world-chip more', title: s.worlds.slice(6).join(', ') }, `+${s.worlds.length - 6}`) : null) : null,
      ),
      actions,
    );
  }

  async function act(fn) {
    state.busy = true;
    try {
      return await fn();
    } catch (err) {
      toast('bad', t('snapshots.actionFailed'), errText(err), 6000);
      return null;
    } finally {
      state.busy = false;
    }
  }

  async function remove(s, btn) {
    setBusy(btn);
    const ok = await act(() => api.invoke('snapshots:delete', instanceId, s.id));
    state.confirm = null;
    if (ok) toast('good', t('snapshots.deleted'), s.label || stamp(s.createdAt), 2500);
    // El foco pasa a la instantanea siguiente (o a "Crear") en lugar de perderse
    const i = (state.items || []).findIndex((x) => x.id === s.id);
    const next = state.items?.[i + 1] || state.items?.[i - 1];
    state.focus = next ? `res|${next.id}` : 'create';
    await load({ keepScroll: true });
  }

  // ---------- Opciones automaticas ----------
  function renderSettings() {
    if (state.view !== 'list') return;
    if (state.error && state.missing) {
      mount(settingsSlot);
      return;
    }
    const cfg = state.settings;
    const save = async (patch) => {
      try {
        await store.setSettings({ snapshots: patch });
        state.settings = { ...state.settings, ...patch };
      } catch (err) {
        toast('bad', t('snapshots.actionFailed'), errText(err));
      }
    };
    const keep = selectEl(
      KEEP_OPTIONS.includes(cfg.keepAuto) ? KEEP_OPTIONS.map((n) => ({ value: n, label: t('snapshots.keepAutoValue', { count: n }) })) : [...KEEP_OPTIONS, cfg.keepAuto].sort((a, b) => a - b).map((n) => ({ value: n, label: t('snapshots.keepAutoValue', { count: n }) })),
      cfg.keepAuto,
      (v) => save({ keepAuto: Number(v) }),
      'select snp-select',
    );
    const uid = instanceId.replace(/[^\w-]/g, '_');
    keep.id = `snp-keep-${uid}`;
    const dayList = DAY_OPTIONS.includes(cfg.keepDays) ? DAY_OPTIONS : [...DAY_OPTIONS.filter(Boolean), cfg.keepDays].sort((a, b) => a - b).concat(0);
    const days = selectEl(
      dayList.map((n) => ({ value: n, label: n ? t('snapshots.days', { count: n }) : t('snapshots.daysNever') })),
      cfg.keepDays,
      (v) => save({ keepDays: Number(v) }),
      'select snp-select',
    );
    days.id = `snp-days-${uid}`;
    const u = state.usage;
    const store0 = u?.store;
    const cleanBtn = h('button', { type: 'button', class: 'btn sm ghost' }, icon('sparkles'), t('snapshots.cleanup'));
    cleanBtn.addEventListener('click', async () => {
      const release = setBusy(cleanBtn);
      let freed = 0;
      try {
        const a = u?.orphans?.length ? await api.invoke('snapshots:cleanOrphans') : { freed: 0 };
        const b = await api.invoke('snapshots:gc');
        freed = (a?.freed || 0) + (b?.freed || 0);
        toast('good', t('snapshots.cleanupDone'), t('snapshots.cleanupText', { size: fmtBytes(freed) }), 3500);
      } catch (err) {
        toast('bad', t('snapshots.actionFailed'), errText(err));
      }
      release();
      loadUsage();
    });
    mount(
      settingsSlot,
      h(
        'section',
        { class: 'snp-settings', 'aria-labelledby': `snp-settings-${uid}` },
        h('div', { class: 'snp-settings-title', id: `snp-settings-${uid}`, role: 'heading', 'aria-level': '4' }, icon('sliders'), t('snapshots.settingsTitle')),
        h(
          'div',
          { class: 'snp-settings-grid' },
          h('div', { class: 'toggle-row snp-toggle' }, switchEl(cfg.autoBeforePlay, (v) => save({ autoBeforePlay: v }), t('snapshots.autoBeforePlay')), h('div', { class: 'tr-text' }, h('div', { class: 'tr-title' }, t('snapshots.autoBeforePlay')), h('div', { class: 'tr-sub' }, t('snapshots.autoBeforePlayHint')))),
          h('div', { class: 'snp-keep' }, h('div', { class: 'field' }, h('label', { for: keep.id }, t('snapshots.keepAuto')), keep), h('div', { class: 'field' }, h('label', { for: days.id }, t('snapshots.keepDays')), days)),
        ),
        h('div', { class: 'snp-settings-foot' }, icon('info'), h('span', {}, t('snapshots.retentionHint'))),
        store0
          ? h(
              'div',
              { class: 'snp-usage' },
              icon('database'),
              h(
                'div',
                { class: 'snp-usage-text' },
                h('div', {}, store0.shared ? t('snapshots.usageShared', { size: fmtBytes(store0.bytes), shared: fmtBytes(store0.shared) }) : t('snapshots.usage', { size: fmtBytes(store0.bytes) })),
                u.orphans?.length ? h('div', { class: 'snp-usage-sub' }, t('snapshots.orphans', { count: u.orphans.length })) : null,
              ),
              cleanBtn,
            )
          : null,
      ),
    );
  }

  // ---------- Crear ----------
  async function showCreate() {
    state.view = 'create';
    // Volver a la lista con el foco en el boton que abrio esta vista
    const backToList = () => {
      state.focus = state.items?.length ? 'create' : 'create-first';
      renderList();
    };
    const label = h('input', { class: 'input', maxlength: 80, placeholder: t('snapshots.labelPlaceholder'), id: 'snp-label' });
    const worldsBox = h('div', { class: 'snp-worlds' }, skeleton('list', { rows: 2, label: t('snapshots.worldsLoading') }));
    const estimate = h('div', { class: 'snp-estimate', 'aria-live': 'polite' });
    const selected = new Set();
    let worlds = [];
    const saveBtn = h('button', { type: 'button', class: 'btn primary' }, icon('save'), t('snapshots.saveSnapshot'));
    const worldTools = h('div', { class: 'snp-world-tools' });

    const drawEstimate = () => {
      const size = worlds.filter((w) => selected.has(w.folder)).reduce((a, w) => a + (w.size || 0), 0);
      mount(estimate, icon(selected.size ? 'globe' : 'zap'), selected.size ? t('snapshots.estimate', { size: fmtBytes(size) }) : t('snapshots.estimateNone'));
    };
    const drawWorlds = () => {
      if (!worlds.length) {
        mount(worldsBox, h('div', { class: 'snp-worlds-empty' }, icon('globe'), h('span', {}, t('snapshots.worldsNone'))));
        mount(worldTools);
        return;
      }
      const lock = running();
      mount(
        worldTools,
        h('button', { type: 'button', class: 'btn sm ghost', disabled: lock || selected.size === worlds.length, onclick: () => (worlds.forEach((w) => selected.add(w.folder)), drawWorlds()) }, t('snapshots.selectAll')),
        h('button', { type: 'button', class: 'btn sm ghost', disabled: lock || !selected.size, onclick: () => (selected.clear(), drawWorlds()) }, t('snapshots.selectNone')),
      );
      mount(
        worldsBox,
        lock ? h('div', { class: 'notice snp-running' }, icon('alert'), h('div', {}, t('snapshots.worldsRunning'))) : null,
        worlds.map((w) => {
          const input = h('input', { type: 'checkbox', checked: selected.has(w.folder), disabled: lock, dataset: { fk: `w|${w.folder}` } });
          input.addEventListener('change', () => {
            if (input.checked) selected.add(w.folder);
            else selected.delete(w.folder);
            row.classList.toggle('on', input.checked);
            // "Todos" / "Ninguno" se habilitan segun lo elegido
            const [allBtn, noneBtn] = worldTools.querySelectorAll('button');
            if (allBtn) allBtn.disabled = lock || selected.size === worlds.length;
            if (noneBtn) noneBtn.disabled = lock || !selected.size;
            drawEstimate();
          });
          const sub = t('snapshots.worldPlayed', { ago: lower(fmtAgo(w.lastPlayed)) });
          const row = h(
            'label',
            { class: ['snp-world', selected.has(w.folder) && 'on', lock && 'disabled'] },
            input,
            h('div', { class: 'snp-world-icon' }, w.icon ? h('img', { src: fileUrl(w.icon, w.iconTime), alt: '' }) : icon('globe')),
            h(
              'div',
              { class: 'snp-world-text' },
              h('div', { class: 'snp-world-name ellipsis', title: w.name }, w.name),
              h('div', { class: 'snp-world-sub ellipsis', title: w.lastSnapshot ? `${sub} · ${t('snapshots.worldSaved')}` : sub }, sub, w.lastSnapshot ? h('span', { class: 'snp-world-saved' }, ' · ', t('snapshots.worldSaved')) : null),
            ),
            h('span', { class: 'snp-world-size' }, fmtBytes(w.size || 0)),
          );
          return row;
        }),
      );
      drawEstimate();
    };

    const doSave = async () => {
      saveBtn.disabled = true;
      const pv = progressView(t('snapshots.saving'));
      state.view = 'progress';
      state.busy = true;
      ui.show([pv.el], []);
      const off = followTask(instanceId, ['snapshots:create'], (task) => pv.update(task));
      try {
        const r = await api.invoke('snapshots:create', instanceId, { kind: 'manual', label: label.value, worlds: [...selected] });
        toast('good', t('snapshots.saved'), t('snapshots.savedText', { count: r.stats?.files || 0, size: fmtBytes(r.stats?.newBytes || 0) }), 4000);
        state.busy = false;
        state.view = 'list';
        await load();
      } catch (err) {
        state.busy = false;
        toast('bad', t('snapshots.createFailed'), errText(err), 8000);
        showCreate();
      } finally {
        off();
      }
    };
    saveBtn.addEventListener('click', doSave);
    label.addEventListener('keydown', (e) => e.key === 'Enter' && doSave());

    ui.show(
      [
        viewHead(t('snapshots.createTitle'), backToList),
        h(
          'div',
          { class: 'snp-form' },
          h('div', { class: 'field' }, h('label', { for: 'snp-label' }, t('snapshots.labelField')), label),
          h('div', { class: 'notice info snp-always' }, icon('shieldCheck'), h('div', {}, t('snapshots.alwaysSaved'))),
          h('div', { class: 'snp-section-head' }, h('div', { class: 'snp-section-title' }, icon('globe'), t('snapshots.worldsTitle')), worldTools),
          h('p', { class: 'snp-section-hint' }, t('snapshots.worldsHint')),
          worldsBox,
          estimate,
        ),
      ],
      [h('button', { type: 'button', class: 'btn ghost', onclick: backToList }, t('snapshots.cancel')), saveBtn],
    );
    setTimeout(() => label.focus(), 40);
    drawEstimate();
    const loadWorlds = async () => {
      mount(worldsBox, skeleton('list', { rows: 2, label: t('snapshots.worldsLoading') }));
      try {
        worlds = await api.invoke('snapshots:worlds', instanceId);
        if (state.view !== 'create') return;
        drawWorlds();
      } catch (err) {
        if (state.view !== 'create') return;
        // Sin la lista se puede guardar igual (sin mundos); el error ofrece reintentar
        mount(worldsBox, h('div', { class: 'notice bad', role: 'alert' }, icon('alert'), h('div', { class: 'snp-notice-body' }, h('div', {}, t('snapshots.worldsError', { error: errText(err) })), h('button', { type: 'button', class: 'btn sm', onclick: loadWorlds }, icon('refresh'), t('snapshots.retry')))));
      }
    };
    await loadWorlds();
  }

  // ---------- Restaurar ----------
  function groupBlock(g) {
    const c = g.counts;
    if (!c.add && !c.remove && !c.change) return null;
    const names = [...g.add.map((n) => ['add', n]), ...g.remove.map((n) => ['remove', n]), ...g.change.map((n) => ['change', n])];
    const total = c.add + c.remove + c.change;
    const markIcon = { add: 'plus', remove: 'snpMinus', change: 'refresh' };
    const markText = { add: t('snapshots.markAdd'), remove: t('snapshots.markRemove'), change: t('snapshots.markChange') };
    return h(
      'div',
      { class: 'snp-group' },
      h(
        'div',
        { class: 'snp-group-head' },
        h('span', { class: 'snp-group-icon' }, icon(GROUP_ICON[g.key] || 'file')),
        h('span', { class: 'snp-group-name' }, t(`snapshots.group_${g.key}`)),
        h(
          'span',
          { class: 'snp-group-counts' },
          c.add ? h('span', { class: 'pill good' }, t('snapshots.willAdd', { count: c.add })) : null,
          c.remove ? h('span', { class: 'pill bad' }, t('snapshots.willRemove', { count: c.remove })) : null,
          c.change ? h('span', { class: 'pill warn' }, t('snapshots.willChange', { count: c.change })) : null,
        ),
      ),
      names.length
        ? h(
            'ul',
            { class: 'snp-names' },
            names.slice(0, NAMES_SHOWN).map(([kind, n]) => h('li', { class: `snp-name ${kind}`, title: `${markText[kind]}: ${n}` }, h('span', { class: 'snp-mark', role: 'img', 'aria-label': markText[kind] }, icon(markIcon[kind])), h('span', { class: 'ellipsis' }, n))),
            total > NAMES_SHOWN ? h('li', { class: 'snp-name more' }, t('snapshots.moreItems', { count: total - NAMES_SHOWN })) : null,
          )
        : null,
    );
  }

  async function showRestore(s) {
    state.view = 'restore';
    const reason = reasonOf(s);
    const changes = h('div', { class: 'snp-changes', 'aria-live': 'polite' }, skeleton('list', { rows: 2, label: t('snapshots.comparing') }));
    const worldSel = new Set(s.worlds || []);
    let includeWorlds = false;
    const restoreBtn = h('button', { type: 'button', class: 'btn primary', disabled: running() }, icon('undo'), t('snapshots.confirmRestore'));
    const worldsBox = h('div', { class: 'snp-restore-worlds' });

    const drawWorlds = (cmp) => {
      if (!s.worlds?.length) {
        mount(worldsBox);
        return;
      }
      const info = new Map((cmp?.worlds || []).map((w) => [w.folder, w]));
      const master = h('input', { type: 'checkbox', checked: includeWorlds });
      master.addEventListener('change', () => {
        includeWorlds = master.checked;
        drawWorlds(cmp);
      });
      mount(
        worldsBox,
        h('label', { class: 'snp-include' }, master, h('span', { class: 'snp-include-text' }, h('span', { class: 'snp-include-title' }, icon('globe'), t('snapshots.includeWorlds')), h('span', { class: 'snp-include-sub' }, t('snapshots.includeWorldsHint')))),
        includeWorlds
          ? h(
              'div',
              { class: 'snp-restore-world-list' },
              s.worlds.map((w) => {
                const cb = h('input', { type: 'checkbox', checked: worldSel.has(w) });
                cb.addEventListener('change', () => {
                  if (cb.checked) worldSel.add(w);
                  else worldSel.delete(w);
                  restoreBtn.disabled = running() || (includeWorlds && !worldSel.size && !hasFileChanges(cmp));
                });
                const wi = info.get(w);
                return h('label', { class: 'snp-world compact' }, cb, h('span', { class: 'snp-world-icon' }, icon('globe')), h('span', { class: 'snp-world-text' }, h('span', { class: 'snp-world-name ellipsis' }, w), h('span', { class: 'snp-world-sub' }, wi && !wi.exists ? t('snapshots.worldMissing') : t('snapshots.worldFiles', { count: wi?.files || 0 }))));
              }),
            )
          : null,
      );
    };
    const hasFileChanges = (cmp) => Boolean(cmp && (cmp.total.add || cmp.total.remove || cmp.total.change || cmp.instance.changed));

    const doRestore = async (target = s, worlds = includeWorlds ? [...worldSel] : 'none', undo = false) => {
      state.view = 'progress';
      state.busy = true;
      const pv = progressView(undo ? t('snapshots.undoing') : t('snapshots.restoring'));
      ui.show([pv.el], []);
      const off = followTask(instanceId, ['snapshots:restore', 'snapshots:create'], (task) => pv.update(task));
      try {
        const r = await api.invoke('snapshots:restore', instanceId, target.id, { worlds });
        state.busy = false;
        store.refreshInstances().catch(() => {});
        if (undo) {
          toast('good', t('snapshots.undoDone'), stamp(target.createdAt), 3500);
          state.view = 'list';
          await load();
        } else showDone(r, worlds);
      } catch (err) {
        state.busy = false;
        toast('bad', t('snapshots.restoreFailed'), errText(err), 9000);
        state.view = 'list';
        await load();
      } finally {
        off();
      }
    };
    restoreBtn.addEventListener('click', () => doRestore());

    ui.show(
      [
        viewHead(t('snapshots.restoreTitle', { date: stamp(s.createdAt) }), () => {
          state.focus = `res|${s.id}`;
          renderList();
        }),
        h('div', { class: 'snp-restore-meta' }, h('span', { class: ['snp-kind', s.kind === 'manual' ? 'manual' : 'auto'] }, icon(REASON_ICON[reason.code] || 'history'), reason.text), s.label ? h('span', { class: 'snp-restore-label ellipsis', title: s.label }, s.label) : null, h('span', { class: 'snp-restore-ago' }, fmtAgo(s.createdAt))),
        running() ? h('div', { class: 'notice snp-running' }, icon('alert'), h('div', {}, t('snapshots.running'))) : null,
        h('div', { class: 'snp-section-title', role: 'heading', 'aria-level': '4' }, icon('diff'), t('snapshots.changesTitle')),
        changes,
        worldsBox,
        h('div', { class: 'notice good snp-safety' }, icon('shieldCheck'), h('div', {}, t('snapshots.safetyNote'))),
      ],
      [
        h(
          'button',
          {
            type: 'button',
            class: 'btn ghost',
            onclick: () => {
              state.focus = `res|${s.id}`;
              renderList();
            },
          },
          t('snapshots.cancel'),
        ),
        restoreBtn,
      ],
    );
    drawWorlds(null);

    const loadCompare = async () => {
      mount(changes, skeleton('list', { rows: 2, label: t('snapshots.comparing') }));
      try {
        const cmp = await api.invoke('snapshots:compare', instanceId, s.id);
        if (state.view !== 'restore') return;
        const blocks = cmp.groups.map(groupBlock).filter(Boolean);
        mount(
          changes,
          cmp.instance.changed ? h('div', { class: 'notice snp-version-change' }, icon('layers'), h('div', {}, t('snapshots.versionChange', { from: versionLabel(cmp.instance.from), to: versionLabel(cmp.instance.to) }))) : null,
          blocks.length ? blocks : h('div', { class: 'snp-nochanges' }, icon('check'), h('span', {}, t('snapshots.noChanges'))),
        );
        drawWorlds(cmp);
      } catch (err) {
        if (state.view !== 'restore') return;
        // Se puede restaurar igual; el error explica que no se pudo comparar y ofrece reintentar
        mount(changes, h('div', { class: 'notice bad', role: 'alert' }, icon('alert'), h('div', { class: 'snp-notice-body' }, h('div', {}, t('snapshots.compareError', { error: errText(err) })), h('button', { type: 'button', class: 'btn sm', onclick: loadCompare }, icon('refresh'), t('snapshots.retry')))));
      }
    };
    await loadCompare();

    function showDone(r, worlds) {
      state.view = 'done';
      const safety = r.safetyId ? { id: r.safetyId, createdAt: Date.now() } : null;
      ui.show(
        [
          h(
            'div',
            { class: 'snp-done' },
            h('div', { class: 'snp-done-art', 'aria-hidden': 'true' }, icon('check')),
            h('div', { class: 'snp-done-title' }, t('snapshots.restoredTitle')),
            h('p', { class: 'snp-done-text' }, r.restored || r.removed ? t('snapshots.restoredText', { restored: r.restored, removed: r.removed }) : t('snapshots.restoredSame')),
            r.metaChanged ? h('p', { class: 'snp-done-text' }, t('snapshots.restoredMeta')) : null,
            safety ? h('div', { class: 'notice info snp-done-note' }, icon('history'), h('div', {}, t('snapshots.restoredSafety'))) : null,
          ),
        ],
        [
          safety ? h('button', { type: 'button', class: 'btn ghost', onclick: () => doRestore(safety, worlds, true) }, icon('undo'), t('snapshots.undo')) : null,
          h(
            'button',
            {
              type: 'button',
              class: 'btn',
              onclick: () => {
                state.view = 'list';
                load();
              },
            },
            icon('history'),
            t('snapshots.backToList'),
          ),
          h('button', { type: 'button', class: 'btn primary', onclick: () => ui.m.close() }, t('snapshots.close')),
        ].filter(Boolean),
      );
    }
  }

  renderList();
  load();
}

/**
 * Instantánea rápida (sin mundos) antes de un cambio riesgoso. reason: texto o código conocido
 * ('modUpdate', 'packUpdate'...). Devuelve el id de la instantánea o null si no se pudo.
 */
export async function snapshotBefore(instanceId, reason) {
  await ready();
  const code = typeof reason === 'string' && /^[a-zA-Z]+$/.test(reason) && has(`snapshots.reason_${reason}`) ? reason : null;
  const opts = { kind: 'auto', worlds: 'none' };
  if (code) opts.reasonCode = code;
  else if (typeof reason === 'string') opts.reason = reason.slice(0, 120);
  try {
    const r = await api.invoke('snapshots:create', instanceId, opts);
    toast('good', r?.reused ? t('snapshots.toastReady') : t('snapshots.toastSaved'), t('snapshots.toastSavedText'), 3500);
    return r?.id || null;
  } catch (err) {
    if (!isMissing(err)) toast('bad', t('snapshots.toastFailed'), errText(err), 6000);
    return null;
  }
}
