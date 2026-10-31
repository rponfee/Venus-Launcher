// Piezas de interfaz compartidas por las pestanas de Estadisticas.
import { h, icon, mount, selectEl } from '../../ui.js';
import { t } from '../../i18n.js';

// Tarjeta con encabezado (icono + titulo + subtitulo) y acciones a la derecha
export function card({ icon: ic, title, sub, actions, cls, id } = {}, ...body) {
  return h(
    'section',
    { class: ['card', 'st-card', cls], id },
    h(
      'div',
      { class: 'st-card-head' },
      h('div', { class: 'st-card-titles' }, h('h2', { class: 'card-title' }, ic ? icon(ic) : null, title), sub ? h('div', { class: 'card-sub st-card-sub' }, sub) : null),
      actions && actions.filter(Boolean).length ? h('div', { class: 'st-card-actions' }, actions.filter(Boolean)) : null,
    ),
    ...body,
  );
}

// Control segmentado accesible. options: [{ id, label, icon? }]
export function segmented(options, value, onChange, label = '') {
  let current = value;
  const wrap = h('div', { class: 'segmented st-seg', role: 'group', 'aria-label': label });
  const draw = () =>
    mount(
      wrap,
      options.map((o) =>
        h(
          'button',
          {
            type: 'button',
            class: o.id === current ? 'active' : null,
            'aria-pressed': String(o.id === current),
            onclick: () => {
              if (o.id === current) return;
              current = o.id;
              draw();
              onChange(o.id);
            },
          },
          o.icon ? icon(o.icon) : null,
          o.label,
        ),
      ),
    );
  draw();
  return wrap;
}

// Tarjeta de numero destacado
export function kpi({ icon: ic, label, value, foot, hero = false, title }) {
  return h(
    'div',
    { class: ['card', 'kpi', 'st-kpi', hero && 'hero-kpi st-kpi-hero'] },
    h('div', { class: 'kpi-label' }, icon(ic), label),
    h('div', { class: 'kpi-value', title: title || (typeof value === 'string' ? value : null) }, value),
    foot ? h('div', { class: 'kpi-foot' }, foot) : null,
  );
}

// Error de una vista: que paso + boton Reintentar
export function errorBox(err, onRetry) {
  return h(
    'div',
    { class: 'notice bad st-error', role: 'alert' },
    icon('alert'),
    h('div', { class: 'spacer' }, h('div', { class: 'st-error-title' }, t('stats.loadError')), h('div', { class: 'small' }, err?.message || String(err || ''))),
    onRetry ? h('button', { class: 'btn sm', type: 'button', onclick: onRetry }, icon('refresh'), t('stats.retry')) : null,
  );
}

// ---------- Cargando (skeleton con la forma de cada vista) ----------
// Un hueso suelto para armar formas propias dentro de skeletonBox()
export const bone = (cls = 'skeleton-line', style) => h('span', { class: `skeleton ${cls}`, style });

// Agrupa formas propias con un solo aviso "Cargando..." para el lector de pantalla
export function skeletonBox(label, ...shapes) {
  return h(
    'div',
    { class: 'skeleton-group st-skel', role: 'status', 'aria-live': 'polite', 'aria-busy': 'true' },
    h('span', { class: 'sr-only' }, label || t('stats.loading')),
    h('div', { class: 'skeleton-shapes', 'aria-hidden': 'true' }, ...shapes),
  );
}

export const skeletonKpi = () => h('div', { class: 'card kpi st-kpi st-skel-kpi' }, bone('skeleton-line st-skel-label'), bone('skeleton-line title st-skel-value'), bone('skeleton-line st-skel-foot'));

export const skeletonCard = (height = 170) => h('div', { class: 'card st-card st-skel-card' }, bone('skeleton-line title'), bone('skeleton-line st-skel-sub'), bone('skeleton-block', { height: `${height}px` }));

// Pestana cargando: filtro opcional, numeros destacados y tarjetas
export function panelSkeleton(label, { kpis = 0, cards = 2, filter = false } = {}) {
  return skeletonBox(
    label,
    filter ? bone('skeleton-block st-skel-filter') : null,
    kpis ? h('div', { class: 'st-ig-kpis' }, Array.from({ length: kpis }, skeletonKpi)) : null,
    h('div', { class: ['st-grid', cards > 1 && 'st-grid-2'] }, Array.from({ length: cards }, () => skeletonCard())),
  );
}

// Filtro de alcance de las estadisticas del juego: instancia + mundo (lo comparten "En el juego" y "Logros")
export function scopeBar(ctx) {
  const st = ctx.state;
  const data = st.ingame;
  const opts = (data?.options || []).filter((o) => o.worlds.length || o.id === st.scope.instanceId);
  const inst = opts.find((o) => o.id === st.scope.instanceId) || null;
  const instSel = selectEl(
    [{ value: '', label: t('stats.allInstances') }, ...opts.map((o) => ({ value: o.id, label: t('stats.instanceOption', { name: o.name, count: o.worlds.length }) }))],
    st.scope.instanceId || '',
    (v) => ctx.loadIngame({ instanceId: v || null, world: null }),
  );
  instSel.setAttribute('aria-label', t('stats.filterInstance'));
  const worldSel = selectEl([{ value: '', label: t('stats.allWorlds') }, ...(inst?.worlds || []).map((w) => ({ value: w.folder, label: w.name }))], st.scope.world || '', (v) =>
    ctx.loadIngame({ instanceId: st.scope.instanceId, world: v || null }),
  );
  worldSel.setAttribute('aria-label', t('stats.filterWorld'));
  if (!inst) worldSel.disabled = true;
  const busy = Boolean(st.ingameLoading);
  return h(
    'div',
    { class: 'st-filter', role: 'search' },
    h('label', { class: 'st-filter-field' }, h('span', { class: 'label' }, t('stats.filterInstance')), instSel),
    h('label', { class: 'st-filter-field' }, h('span', { class: 'label' }, t('stats.filterWorld')), worldSel),
    h(
      'div',
      { class: 'st-filter-end' },
      busy ? h('div', { class: 'st-filter-busy small muted', role: 'status' }, h('div', { class: 'spinner' }), t('stats.reading')) : null,
      h(
        'button',
        { class: 'icon-btn', type: 'button', title: t('stats.reread'), 'aria-label': t('stats.reread'), disabled: busy, onclick: () => ctx.loadIngame(st.scope, { force: true }) },
        icon('refresh'),
      ),
    ),
  );
}

// Modo de juego del level.dat
export function gameModeBadge(mode, hardcore) {
  if (hardcore) return h('span', { class: 'badge bad' }, icon('skull'), t('stats.mode_hardcore'));
  if (mode === null || mode === undefined || mode < 0 || mode > 3) return null;
  return h('span', { class: 'badge' }, t(`stats.mode_${mode}`));
}
