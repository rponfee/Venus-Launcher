// Análisis de mods:
// - openSecurityScan(instanceId): revisa cada jar (origen verificado en Modrinth/CurseForge, firmas de malware
//   como Fractureiser y comportamientos peligrosos), con progreso en vivo, detalles, cuarentena y papelera.
// - openMixinReport(instanceId): cruza los mixins de todos los mods y explica los posibles choques.
// openSecurityScan también acepta { serverId } para revisar los plugins y mods de un servidor local.
import { h, icon, mount, modal, ok, fail, confirmDialog, ensureCss, registerIcons, fmtAgo, fmtBytes, fmtDate, fmtTime, emptyState, switchEl, copyText, debounce } from '../ui.js';
import { store, api } from '../store.js';
import { t, loadNs, locale } from '../i18n.js';

registerIcons({
  anQuarantine: '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/><path d="M12 15v2"/>',
  anFingerprint: '<path d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4"/><path d="M14 13.12c0 2.38 0 6.38-1 8.88"/><path d="M17.29 21.02c.12-.6.43-2.3.5-3.02"/><path d="M2 12a10 10 0 0 1 18-6"/><path d="M2 16h.01"/><path d="M21.8 16c.2-2 .131-5.354 0-6"/><path d="M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2"/><path d="M8.65 22c.21-.66.45-1.32.57-2"/><path d="M9 6.8a6 6 0 0 1 9 5.2v2"/>',
  anMerge: '<path d="m8 6 4-4 4 4"/><path d="M12 2v10.3a4 4 0 0 1-1.172 2.872L4 22"/><path d="m20 22-5-5"/>',
});

const SEV_ORDER = { critical: 4, high: 3, medium: 2, info: 1 };
const SEV_PILL = { critical: 'bad an-crit', high: 'bad', medium: 'warn', info: 'info' };
const SEV_ICON = { critical: 'skull', high: 'shieldAlert', medium: 'alert', info: 'info' };
const MOD_LOADERS = new Set(['fabric', 'quilt', 'forge', 'neoforge', 'legacyfabric', 'babric', 'optifine']);
// Nombres de las anotaciones de Mixin (identificadores de Java: no se traducen)
const ANNOTATION = {
  overwrite: '@Overwrite',
  inject: '@Inject',
  redirect: '@Redirect',
  modifyVariable: '@ModifyVariable',
  modifyArg: '@ModifyArg',
  modifyArgs: '@ModifyArgs',
  modifyConstant: '@ModifyConstant',
  wrapOperation: '@WrapOperation',
  wrapWithCondition: '@WrapWithCondition',
  modifyExpressionValue: '@ModifyExpressionValue',
  modifyReturnValue: '@ModifyReturnValue',
  modifyReceiver: '@ModifyReceiver',
  wrapMethod: '@WrapMethod',
};
const AT_KEYS = new Set(['HEAD', 'RETURN', 'TAIL', 'INVOKE', 'INVOKE_ASSIGN', 'FIELD', 'NEW', 'CONSTANT', 'LOAD', 'STORE', 'JUMP']);

const openDialogs = new Map(); // clave -> diálogo abierto (evita duplicados)

async function ready() {
  ensureCss('features/analysis');
  try {
    await loadNs('analysis');
  } catch {
    /* sin textos se ven las claves, pero no se rompe nada */
  }
}

const isMissingChannel = (err) => /No handler registered/i.test(err?.message || '');
// "hace un momento" en minúscula para usarlo dentro de una oración
const ago = (ts) => {
  const s = fmtAgo(ts);
  return s.charAt(0).toLocaleLowerCase(locale()) + s.slice(1);
};
const isCancel = (err) => /cancel|abort/i.test(err?.message || '');

// ---------- Piezas comunes ----------

function sevPill(sev) {
  if (!sev) return h('span', { class: 'pill good an-pill' }, icon('check'), t('analysis.noFindings'));
  return h('span', { class: `pill an-pill ${SEV_PILL[sev] || ''}`, title: t(`analysis.sevHint_${sev}`) }, icon(SEV_ICON[sev]), t(`analysis.sev_${sev}`));
}

function countPill(sev, n) {
  return h('span', { class: `pill an-pill ${SEV_PILL[sev] || ''}`, title: t(`analysis.sevHint_${sev}`) }, icon(SEV_ICON[sev]), t(`analysis.count_${sev}`, { count: n }));
}

function thumb(src, fallback) {
  const box = h('div', { class: 'an-thumb', 'aria-hidden': 'true' });
  if (typeof src === 'string' && /^https:\/\//i.test(src)) {
    const img = h('img', { src, alt: '', loading: 'lazy' });
    img.addEventListener('error', () => mount(box, icon(fallback)), { once: true });
    box.append(img);
  } else box.append(icon(fallback));
  return box;
}

function openExternal(url) {
  if (/^https:\/\//i.test(url)) api.app.openExternal(url).catch(() => {});
}

function settingSwitch(key, label, hint) {
  const on = store.settings?.analysis?.[key] !== false;
  const sw = switchEl(
    on,
    async (v) => {
      try {
        await store.setSettings({ analysis: { [key]: v } });
      } catch (err) {
        fail(t('analysis.settingFailed'), err);
      }
    },
    label,
  );
  return h('div', { class: 'an-setting', title: hint }, sw, h('span', { class: 'an-setting-text', 'aria-hidden': 'true' }, label));
}

// Ventana propia sobre modal(): cuerpo y pie reemplazables y limpieza al cerrar.
function createDialog(key, title, size = 'xwide', { icon: iconName, subtitle } = {}) {
  const ctl = { cleanups: [], closed: false };
  const body = h('div', { class: 'an-body' });
  const foot = h('div', { class: 'an-foot' });
  const m = modal({
    title,
    subtitle,
    icon: iconName,
    size: `${size} an-modal`,
    body,
    footer: [foot],
    onClose: () => {
      ctl.closed = true;
      openDialogs.delete(key);
      for (const fn of ctl.cleanups.splice(0)) {
        try {
          fn();
        } catch {
          /* ya limpio */
        }
      }
    },
  });
  ctl.el = m.el;
  ctl.body = body;
  ctl.foot = foot;
  ctl.close = () => m.close();
  openDialogs.set(key, ctl);
  return ctl;
}

function focusExisting(key) {
  const d = openDialogs.get(key);
  if (!d || d.closed) return false;
  d.el.querySelector('button, [tabindex]')?.focus?.();
  return true;
}

// Redibuja una zona sin perder el scroll del modal ni el foco del teclado (data-fk = clave estable).
function redraw(zone, ...children) {
  const scroller = zone.closest('.modal-body');
  const top = scroller ? scroller.scrollTop : 0;
  const active = document.activeElement;
  const fk = active && zone.contains(active) ? active.closest('[data-fk]')?.dataset.fk : null;
  mount(zone, ...children);
  if (scroller) scroller.scrollTop = top;
  if (fk) zone.querySelector(`[data-fk="${CSS.escape(fk)}"]`)?.focus({ preventScroll: true });
}

// Esqueleto del informe (encabezado + filas) mientras se carga o se hace el primer análisis.
function skeletonView(label, rows = 4) {
  const bone = (cls, style) => h('span', { class: `skeleton ${cls}`, style });
  const row = () => h('div', { class: 'skeleton-row' }, bone('skeleton-icon'), h('div', { class: 'skeleton-lines' }, bone('skeleton-line'), bone('skeleton-line')));
  return h(
    'div',
    { class: 'skeleton-group an-skel', role: 'status', 'aria-live': 'polite', 'aria-busy': 'true' },
    h('span', { class: 'sr-only' }, label),
    h(
      'div',
      { class: 'skeleton-shapes', 'aria-hidden': 'true' },
      h('div', { class: 'an-skel-hero' }, bone('skeleton-icon', { width: '56px', height: '56px', borderRadius: '12px' }), h('div', { class: 'skeleton-lines' }, bone('skeleton-line title'), bone('skeleton-line'))),
      h('div', { class: 'skeleton-list' }, Array.from({ length: rows }, row)),
    ),
  );
}

function progressView({ title, detail, pct, onCancel }) {
  return h(
    'div',
    { class: 'an-progress', role: 'status', 'aria-live': 'polite' },
    h('div', { class: 'an-progress-icon' }, h('div', { class: 'spinner lg' })),
    h(
      'div',
      { class: 'an-progress-main' },
      h('div', { class: 'an-progress-title' }, title),
      h('div', { class: 'an-progress-detail ellipsis', title: detail || '' }, detail || ' '),
      h('div', { class: ['progress', (pct === null || pct === undefined) && 'indeterminate'] }, h('i', { style: { width: `${Math.round((pct || 0) * 100)}%` } })),
    ),
    onCancel ? h('button', { class: 'btn sm ghost', type: 'button', onclick: onCancel }, icon('x'), t('analysis.cancel')) : null,
  );
}

// Secciones desplegables: recuerdan si estaban abiertas aunque se redibuje el contenido.
const openSections = new Set();
function keepOpen(details, key) {
  details.open = openSections.has(key);
  details.addEventListener('toggle', () => (details.open ? openSections.add(key) : openSections.delete(key)));
  return details;
}

function explainBox(titleKey, paragraphs, bullets, cls = '') {
  const det = h(
    'details',
    { class: `an-explain ${cls}` },
    h('summary', { 'data-fk': `sec:${titleKey}` }, icon('info'), h('span', {}, t(titleKey)), icon('chevronDown', 'an-chev')),
    h(
      'div',
      { class: 'an-explain-body' },
      paragraphs.map((k) => h('p', {}, t(k))),
      bullets?.length ? h('ul', {}, bullets.map((k) => h('li', {}, t(k)))) : null,
    ),
  );
  return keepOpen(det, titleKey);
}

function evidenceList(list) {
  if (!list?.length) return null;
  return h(
    'div',
    { class: 'an-evidence' },
    h('div', { class: 'an-evidence-label' }, t('analysis.evidence')),
    list.map((e) =>
      h(
        'div',
        { class: 'an-evidence-row' },
        h('span', { class: 'an-evidence-where mono', title: e.where }, e.where),
        h('code', { class: 'an-evidence-value selectable' }, e.value),
        h('button', { class: 'icon-btn sm', type: 'button', title: t('analysis.copy'), 'aria-label': t('analysis.copy'), onclick: () => copyText(`${e.where}: ${e.value}`) }, icon('copy')),
      ),
    ),
  );
}

function findingView(f) {
  return h(
    'div',
    { class: `an-finding sev-${f.severity}` },
    h(
      'div',
      { class: 'an-finding-head' },
      sevPill(f.severity),
      h('span', { class: 'an-finding-title' }, f.title),
      f.severity === 'critical' ? h('span', { class: `badge ${f.confirmed ? 'bad' : 'warn'}` }, f.confirmed ? t('analysis.confirmed') : t('analysis.unconfirmed')) : null,
      f.downgraded ? h('span', { class: 'badge', title: t('analysis.downgradedHint') }, icon('check'), t('analysis.downgraded')) : null,
    ),
    h('p', { class: 'an-finding-text' }, f.text),
    f.severity === 'critical' && !f.confirmed ? h('p', { class: 'an-finding-note' }, t('analysis.unconfirmedNote')) : null,
    evidenceList(f.evidence),
  );
}

function heroView({ sev, iconName, title, sub, meta, pills }) {
  return h(
    'div',
    { class: ['an-hero', sev ? `sev-${sev}` : 'is-clean'] },
    h('div', { class: 'an-hero-icon' }, icon(iconName)),
    h('div', { class: 'an-hero-main' }, h('div', { class: 'an-hero-title' }, title), h('div', { class: 'an-hero-sub' }, sub), meta?.length ? h('div', { class: 'an-hero-meta' }, meta) : null),
    pills?.length ? h('div', { class: 'an-hero-pills' }, pills) : null,
  );
}

function chipsView(filters, currentId, onPick) {
  return h(
    'div',
    { class: 'chips an-chips', role: 'group', 'aria-label': t('analysis.filterLabel') },
    filters.map((f) =>
      h(
        'button',
        {
          class: ['chip', f.id === currentId && 'active'],
          type: 'button',
          'aria-pressed': String(f.id === currentId),
          'data-fk': `chip:${f.id}`,
          onclick: () => onPick(f.id),
        },
        f.label,
      ),
    ),
  );
}

// Resumen recalculado en la interfaz después de mover o borrar archivos.
function summarize(files, system) {
  const by = { critical: 0, high: 0, medium: 0, info: 0 };
  let verified = 0;
  let unknown = 0;
  for (const f of files) {
    if (f.severity) by[f.severity]++;
    if (f.verifyState === 'verified') verified++;
    else if (f.verifyState === 'unknown') unknown++;
  }
  const systemBad = system?.findings?.length || 0;
  return { total: files.length, verified, unknown, offline: files.length - verified - unknown, bySeverity: by, system: systemBad, clean: !by.critical && !by.high && !by.medium && !systemBad };
}

// ======================================================================
// Análisis de seguridad
// ======================================================================

function targetOf(arg) {
  if (arg && typeof arg === 'object' && arg.serverId) return { serverId: String(arg.serverId) };
  return { instanceId: String(arg?.instanceId || arg || '') };
}

function targetName(target) {
  if (target.instanceId) return store.instances.find((i) => i.id === target.instanceId)?.name || '';
  return (store.servers || []).find((s) => s.id === target.serverId)?.name || '';
}

export async function openSecurityScan(instanceId) {
  await ready();
  const target = targetOf(instanceId);
  const progressKey = target.serverId ? `server:${target.serverId}` : `instance:${target.instanceId}`;
  const key = `sec:${progressKey}`;
  if (focusExisting(key)) return;
  const name = targetName(target);
  // Mismo encabezado que las demas herramientas de una instancia: icono + titulo + nombre debajo
  const dlg = createDialog(key, t('analysis.secTitle'), 'xwide', { icon: 'shieldCheck', subtitle: name || null });
  const state = { result: null, scanning: false, progress: null, filter: null, expanded: new Set(), error: null, taskId: null, busy: new Set() };
  const progressBox = h('div', { class: 'an-zone' });
  const mainBox = h('div', { class: 'an-zone an-stack' });
  mount(dlg.body, h('div', { class: 'an-stack' }, progressBox, mainBox));

  dlg.cleanups.push(
    api.on('security:progress', (p) => {
      if (p?.target !== progressKey) return;
      state.progress = p;
      state.taskId = p.taskId || state.taskId;
      if (state.scanning) renderProgress();
    }),
  );

  function renderFoot() {
    // Con el error a pantalla completa ya está "Reintentar": el pie no repite la acción
    const retryShown = Boolean(state.error && !state.scanning && !state.result && !state.error.missing);
    mount(
      dlg.foot,
      settingSwitch('launchSecurity', t('analysis.secLaunchCheck'), t('analysis.secLaunchCheckHint')),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn ghost', type: 'button', onclick: () => dlg.close() }, t('analysis.close')),
      retryShown ? null : h('button', { class: 'btn', type: 'button', disabled: state.scanning, onclick: () => scan(true) }, icon('refresh'), t('analysis.rescan')),
    );
  }

  function renderProgress() {
    if (dlg.closed) return;
    if (!state.scanning) {
      mount(progressBox);
      return;
    }
    const p = state.progress;
    const pct = !p ? null : p.phase === 'verify' ? 0.9 : p.phase === 'system' ? 0.96 : p.phase === 'done' ? 1 : p.total ? (p.done / p.total) * 0.85 : null;
    const detail = !p
      ? t('analysis.secPreparing')
      : p.phase === 'verify'
        ? t('analysis.secPhaseVerify')
        : p.phase === 'system'
          ? t('analysis.secPhaseSystem')
          : p.phase === 'done'
            ? t('analysis.secPhaseDone')
            : p.file
              ? t('analysis.secPhaseFile', { file: p.file, done: Math.min(p.done + 1, p.total), total: p.total })
              : t('analysis.secPreparing');
    mount(progressBox, progressView({ title: t('analysis.secScanning'), detail, pct, onCancel: state.taskId ? () => api.tasks.cancel(state.taskId).catch(() => {}) : null }));
  }

  function renderMain() {
    if (dlg.closed) return;
    mainBox.classList.toggle('is-refreshing', Boolean(state.scanning && state.result));
    dlg.el.classList.toggle('an-tall', Boolean(state.result?.summary?.total || state.result?.quarantine?.length));
    if (state.error && !state.scanning && !state.result) {
      const missing = state.error.missing;
      redraw(
        mainBox,
        h(
          'div',
          { class: 'an-state' },
          emptyState(
            'shieldAlert',
            missing ? t('analysis.unavailableTitle') : t('analysis.secErrorTitle'),
            missing ? t('analysis.unavailableText') : state.error.message,
            missing ? null : h('button', { class: 'btn primary', type: 'button', onclick: () => scan(false) }, icon('refresh'), t('analysis.retry')),
          ),
        ),
      );
      return;
    }
    if (!state.result) {
      redraw(mainBox, skeletonView(state.scanning ? t('analysis.secScanning') : t('analysis.loading')));
      return;
    }
    redraw(mainBox, ...resultView(state.result));
  }

  function resultView(r) {
    const s = r.summary;
    const parts = [];
    const issues = s.bySeverity.critical + s.bySeverity.high + s.bySeverity.medium + s.system;
    const worst = s.bySeverity.critical || s.system ? 'critical' : s.bySeverity.high ? 'high' : s.bySeverity.medium ? 'medium' : null;
    if (state.error && !state.scanning) {
      parts.push(h('div', { class: 'notice bad' }, icon('alert'), h('div', {}, state.error.missing ? t('analysis.unavailableText') : state.error.message)));
    }
    parts.push(
      heroView({
        sev: worst,
        iconName: worst ? 'shieldAlert' : 'shieldCheck',
        title: !s.total ? t('analysis.secEmptyTitle') : s.clean ? t('analysis.secCleanTitle') : t('analysis.secIssuesTitle', { count: issues }),
        sub: !s.total ? t('analysis.secEmptyText') : s.clean ? t('analysis.secCleanText', { count: s.total }) : t('analysis.secIssuesText', { count: s.total }),
        meta: [
          s.total ? h('span', {}, icon('anFingerprint'), t('analysis.verifiedCount', { count: s.verified, total: s.total })) : null,
          r.scannedAt ? h('span', { title: `${fmtDate(r.scannedAt)} ${fmtTime(r.scannedAt)}` }, icon('clock'), t('analysis.scannedAgo', { when: ago(r.scannedAt) })) : null,
        ].filter(Boolean),
        pills: ['critical', 'high', 'medium', 'info'].filter((k) => s.bySeverity[k]).map((k) => countPill(k, s.bySeverity[k])),
      }),
    );
    if (r.changed && !state.scanning) parts.push(h('div', { class: 'notice info' }, icon('info'), h('div', {}, t('analysis.secChanged'))));
    if (r.system?.findings?.length) {
      parts.push(h('div', { class: 'an-system' }, h('div', { class: 'an-system-head' }, icon('skull'), h('strong', {}, t('analysis.secSystemTitle'))), r.system.findings.map(findingView)));
    }
    if (r.offline) parts.push(h('div', { class: 'notice' }, icon('wifi'), h('div', {}, t('analysis.secOffline'))));
    if (r.files.length) {
      const flagged = r.files.filter((f) => SEV_ORDER[f.severity] >= 2);
      const unknown = r.files.filter((f) => f.verifyState !== 'verified');
      if (!state.filter) state.filter = flagged.length ? 'flagged' : 'all';
      const filters = [
        { id: 'flagged', label: t('analysis.filterFlagged', { count: flagged.length }), list: flagged },
        { id: 'all', label: t('analysis.filterAll', { count: r.files.length }), list: r.files },
        { id: 'unknown', label: t('analysis.filterUnknown', { count: unknown.length }), list: unknown },
      ];
      const listBox = h('div', { class: 'an-files' });
      const chipsBox = h('div', { class: 'an-toolbar' });
      const renderList = () => {
        const current = filters.find((f) => f.id === state.filter) || filters[1];
        redraw(chipsBox, chipsView(filters, current.id, (id) => ((state.filter = id), renderList())));
        redraw(
          listBox,
          current.list.length
            ? current.list.map(fileRow)
            : h('div', { class: 'an-empty-filter' }, icon('shieldCheck'), current.id === 'flagged' ? t('analysis.filterFlaggedEmpty') : t('analysis.filterUnknownEmpty')),
        );
      };
      renderList();
      parts.push(chipsBox, listBox);
    }
    if (r.quarantine?.length) parts.push(quarantineView(r.quarantine));
    parts.push(explainBox('analysis.secHowTitle', ['analysis.secHow1', 'analysis.secHow2', 'analysis.secHow3'], ['analysis.secHowTip1', 'analysis.secHowTip2', 'analysis.secHowTip3']));
    return parts;
  }

  function fileRow(f) {
    const id = `${f.folder}/${f.file}`;
    const open = state.expanded.has(id);
    const title = f.verified?.title || f.mod?.name || f.file;
    const source = f.verified
      ? h('span', { class: `badge ${f.verified.source === 'modrinth' ? 'modrinth' : 'good'}`, title: t('analysis.verifiedHint') }, icon('check'), f.verified.source === 'modrinth' ? t('analysis.verifiedModrinth') : t('analysis.verifiedCurseForge'))
      : f.verifyState === 'offline'
        ? h('span', { class: 'badge', title: t('analysis.uncheckedHint') }, icon('wifi'), t('analysis.unchecked'))
        : h('span', { class: 'badge warn', title: t('analysis.unknownHint') }, icon('alert'), t('analysis.unknownSource'));
    const version = f.verified?.versionNumber || f.mod?.version || '';
    const row = h('div', { class: ['an-file', open && 'is-open', f.severity && `sev-${f.severity}`] });
    const toggle = () => {
      if (state.expanded.has(id)) state.expanded.delete(id);
      else state.expanded.add(id);
      const next = fileRow(f);
      row.replaceWith(next);
      next.querySelector('.an-file-head')?.focus({ preventScroll: true });
    };
    row.append(
      h(
        'button',
        { class: 'an-file-head', type: 'button', 'aria-expanded': String(open), 'data-fk': `file:${id}`, onclick: toggle },
        thumb(f.verified?.icon, f.folder === 'plugins' ? 'plug' : 'puzzle'),
        h(
          'span',
          { class: 'an-file-main' },
          h('span', { class: 'an-file-title ellipsis', title }, title),
          h('span', { class: 'an-file-sub' }, h('span', { class: 'mono ellipsis', title: f.file }, f.file), version ? h('span', { class: 'an-ver ellipsis', title: version }, version) : null, h('span', { class: 'an-size' }, fmtBytes(f.size))),
        ),
        h('span', { class: 'an-file-badges' }, !f.enabled ? h('span', { class: 'badge' }, t('analysis.disabled')) : null, source),
        sevPill(f.severity),
        icon('chevronDown', 'an-chev'),
      ),
    );
    if (open) {
      const busy = state.busy.has(id);
      const links = [];
      if (f.verified?.source === 'modrinth' && f.verified.slug) {
        links.push(h('button', { class: 'btn sm ghost', type: 'button', onclick: () => openExternal(`https://modrinth.com/project/${encodeURIComponent(f.verified.slug)}`) }, icon('external'), t('analysis.viewModrinth')));
      } else if (f.verified?.url) {
        links.push(h('button', { class: 'btn sm ghost', type: 'button', onclick: () => openExternal(f.verified.url) }, icon('external'), t('analysis.viewCurseForge')));
      }
      row.append(
        h(
          'div',
          { class: 'an-file-body' },
          f.findings.length ? f.findings.map(findingView) : h('p', { class: 'an-file-ok' }, icon('shieldCheck'), f.verified ? t('analysis.fileOkVerified') : t('analysis.fileOk')),
          h(
            'dl',
            { class: 'an-facts' },
            h('dt', {}, 'SHA-1'),
            h('dd', { class: 'mono selectable' }, f.sha1),
            f.verified ? [h('dt', {}, t('analysis.factSource')), h('dd', {}, [f.verified.title || '—', f.verified.versionNumber].filter(Boolean).join(' · '))] : null,
            f.stats ? [h('dt', {}, t('analysis.factClasses')), h('dd', {}, [t('analysis.factClassCount', { count: f.stats.classes }), f.stats.nested ? t('analysis.factNestedCount', { count: f.stats.nested }) : null].filter(Boolean).join(' · '))] : null,
          ),
          h(
            'div',
            { class: 'an-actions' },
            links,
            h('span', { class: 'spacer' }),
            h('button', { class: ['btn sm', f.confirmed && 'primary'], type: 'button', disabled: busy, onclick: () => quarantineFile(f) }, icon('anQuarantine'), t('analysis.quarantine')),
            h('button', { class: 'btn sm danger', type: 'button', disabled: busy, onclick: () => removeFile(f) }, icon('trash'), t('analysis.remove')),
          ),
        ),
      );
    }
    return row;
  }

  function quarantineView(items) {
    return h(
      'div',
      { class: 'an-quarantine' },
      h('div', { class: 'an-section-title', role: 'heading', 'aria-level': '4' }, icon('anQuarantine'), t('analysis.quarantineTitle'), h('span', { class: 'an-count' }, String(items.length))),
      h('p', { class: 'an-section-sub' }, t('analysis.quarantineText')),
      items.map((q) =>
        h(
          'div',
          { class: 'an-q-row' },
          thumb(null, 'anQuarantine'),
          h(
            'div',
            { class: 'an-file-main' },
            h('span', { class: 'an-file-title ellipsis', title: q.mod?.name || q.file }, q.mod?.name || q.file),
            h('span', { class: 'an-file-sub' }, h('span', { class: 'mono ellipsis', title: q.file }, q.file), h('span', { class: 'an-size' }, t('analysis.quarantinedAgo', { when: ago(q.at) }))),
          ),
          q.severity ? sevPill(q.severity) : null,
          h('button', { class: 'btn sm', type: 'button', title: t('analysis.restoreHint'), onclick: () => restoreItem(q) }, icon('undo'), t('analysis.restore')),
          h('button', { class: 'btn sm danger', type: 'button', onclick: () => discardItem(q) }, icon('trash'), t('analysis.discard')),
        ),
      ),
    );
  }

  // Quita un archivo de la lista sin volver a analizar todo.
  function dropFile(f) {
    if (!state.result) return;
    const files = state.result.files.filter((x) => !(x.folder === f.folder && x.file === f.file));
    state.result = { ...state.result, files, summary: summarize(files, state.result.system) };
  }

  async function refreshQuarantine() {
    try {
      const list = await api.invoke('security:quarantined', target);
      if (state.result) state.result = { ...state.result, quarantine: list };
    } catch {
      /* se mantiene la lista anterior */
    }
  }

  async function quarantineFile(f) {
    if (!(await confirmDialog(t('analysis.quarantineConfirmTitle'), t('analysis.quarantineConfirmText', { file: f.file }), { okText: t('analysis.quarantine') }))) return;
    const id = `${f.folder}/${f.file}`;
    state.busy.add(id);
    try {
      await api.invoke('security:quarantine', target, id);
      ok(t('analysis.quarantined'), f.file);
      dropFile(f);
      await refreshQuarantine();
      store.refreshInstances().catch(() => {});
    } catch (err) {
      fail(t('analysis.actionFailed'), err);
    } finally {
      state.busy.delete(id);
      renderMain();
    }
  }

  async function removeFile(f) {
    if (!(await confirmDialog(t('analysis.removeConfirmTitle'), t('analysis.removeConfirmText', { file: f.file }), { okText: t('analysis.remove'), danger: true }))) return;
    const id = `${f.folder}/${f.file}`;
    state.busy.add(id);
    try {
      await api.invoke('security:remove', target, id);
      ok(t('analysis.removed'), f.file);
      dropFile(f);
      store.refreshInstances().catch(() => {});
    } catch (err) {
      fail(t('analysis.actionFailed'), err);
    } finally {
      state.busy.delete(id);
      renderMain();
    }
  }

  async function restoreItem(q) {
    try {
      await api.invoke('security:restore', target, q.id);
      ok(t('analysis.restored'), q.file);
      store.refreshInstances().catch(() => {});
      await scan(false);
    } catch (err) {
      fail(t('analysis.actionFailed'), err);
    }
  }

  async function discardItem(q) {
    if (!(await confirmDialog(t('analysis.discardConfirmTitle'), t('analysis.discardConfirmText', { file: q.file }), { okText: t('analysis.discard'), danger: true }))) return;
    try {
      await api.invoke('security:discard', target, q.id);
      ok(t('analysis.discarded'), q.file);
      await refreshQuarantine();
      renderMain();
    } catch (err) {
      fail(t('analysis.actionFailed'), err);
    }
  }

  async function scan(force) {
    if (state.scanning || dlg.closed) return;
    state.scanning = true;
    state.error = null;
    state.progress = null;
    renderProgress();
    renderMain();
    renderFoot();
    try {
      state.result = await api.invoke('security:scan', target, { force: Boolean(force) });
    } catch (err) {
      if (isMissingChannel(err)) state.error = { missing: true };
      else if (isCancel(err)) state.error = state.result ? null : { message: t('analysis.cancelled') };
      else state.error = { message: err?.message || String(err) };
    } finally {
      state.scanning = false;
      state.taskId = null;
      renderProgress();
      renderMain();
      renderFoot();
    }
  }

  renderFoot();
  renderMain();
  // Primero el último resultado guardado (aparece al instante) y enseguida un análisis nuevo (rápido: usa la cache).
  try {
    const saved = await api.invoke('security:results', target);
    if (saved && !dlg.closed && !state.result) {
      state.result = saved;
      renderMain();
    }
  } catch (err) {
    if (isMissingChannel(err)) {
      state.error = { missing: true };
      renderMain();
      return;
    }
  }
  scan(false);
}

// ======================================================================
// Informe de mixins
// ======================================================================

const prettyClass = (tg) => tg.clsName || tg.short || tg.cls.slice(tg.cls.lastIndexOf('/') + 1);
const prettyMethod = (tg) => tg.methodName || tg.method;
const atText = (a) => {
  const v = String(a.value || '').toUpperCase();
  return AT_KEYS.has(v) ? t(`analysis.at_${v}`) : a.value;
};

export async function openMixinReport(instanceId) {
  await ready();
  const id = String(instanceId || '');
  const key = `mix:${id}`;
  if (focusExisting(key)) return;
  const inst = store.instances.find((i) => i.id === id);
  const noLoader = Boolean(inst && !MOD_LOADERS.has(inst.loader));
  const dlg = createDialog(key, t('analysis.mixTitle'), noLoader ? 'wide' : 'xwide', { icon: 'layers', subtitle: inst?.name || null });
  const state = { report: null, running: false, progress: null, error: null, filter: 'important', query: '', open: new Set(), taskId: null };
  const progressBox = h('div', { class: 'an-zone' });
  const mainBox = h('div', { class: 'an-zone an-stack' });
  mount(dlg.body, h('div', { class: 'an-stack' }, progressBox, mainBox));

  dlg.cleanups.push(
    api.on('mixins:progress', (p) => {
      if (p?.instanceId !== id) return;
      state.progress = p;
      state.taskId = p.taskId || state.taskId;
      if (state.running) renderProgress();
    }),
  );

  function renderFoot() {
    const noMods = Boolean(state.error?.noMods);
    const retryShown = Boolean(state.error && !state.running && !state.report && !state.error.missing && !noMods);
    mount(
      dlg.foot,
      noMods ? null : settingSwitch('launchMixins', t('analysis.mixLaunchCheck'), t('analysis.mixLaunchCheckHint')),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn ghost', type: 'button', onclick: () => dlg.close() }, t('analysis.close')),
      noMods || retryShown ? null : h('button', { class: 'btn', type: 'button', disabled: state.running, onclick: () => run() }, icon('refresh'), t('analysis.reanalyze')),
    );
  }

  function renderProgress() {
    if (dlg.closed) return;
    if (!state.running) {
      mount(progressBox);
      return;
    }
    const p = state.progress;
    mount(
      progressBox,
      progressView({
        title: t('analysis.mixAnalyzing'),
        detail: !p ? t('analysis.secPreparing') : p.phase === 'conflicts' || p.phase === 'done' ? t('analysis.mixPhaseConflicts') : p.file ? t('analysis.mixPhaseFile', { file: p.file, done: Math.min(p.done + 1, p.total), total: p.total }) : t('analysis.secPreparing'),
        pct: !p ? null : p.phase === 'conflicts' || p.phase === 'done' ? 0.96 : p.total ? (p.done / p.total) * 0.92 : null,
        onCancel: state.taskId ? () => api.tasks.cancel(state.taskId).catch(() => {}) : null,
      }),
    );
  }

  function renderMain() {
    if (dlg.closed) return;
    mainBox.classList.toggle('is-refreshing', Boolean(state.running && state.report));
    dlg.el.classList.toggle('an-tall', Boolean(state.report?.conflicts?.length || state.report?.stats?.withMixins));
    if (state.error && !state.running && !state.report) {
      const { missing, noMods } = state.error;
      redraw(
        mainBox,
        h(
          'div',
          { class: 'an-state' },
          emptyState(
            missing ? 'shieldAlert' : noMods ? 'puzzle' : 'alert',
            missing ? t('analysis.unavailableTitle') : noMods ? t('analysis.mixNoModsTitle') : t('analysis.mixErrorTitle'),
            missing ? t('analysis.unavailableText') : noMods ? t('analysis.mixNoModsText') : state.error.message,
            missing || noMods ? null : h('button', { class: 'btn primary', type: 'button', onclick: () => run() }, icon('refresh'), t('analysis.retry')),
          ),
        ),
      );
      return;
    }
    if (!state.report) {
      redraw(mainBox, skeletonView(state.running ? t('analysis.mixAnalyzing') : t('analysis.loading')));
      return;
    }
    redraw(mainBox, ...reportView(state.report));
  }

  const modName = (r, i) => {
    const m = r.mods[i];
    return m ? m.name || m.id || m.file : '?';
  };

  function reportView(r) {
    const parts = [];
    const important = r.counts.high + r.counts.medium;
    const worst = r.counts.high ? 'high' : r.counts.medium ? 'medium' : null;
    const withMixins = r.stats.withMixins || 0;
    if (state.error && !state.running) parts.push(h('div', { class: 'notice bad' }, icon('alert'), h('div', {}, state.error.message || t('analysis.unavailableText'))));
    parts.push(
      heroView({
        sev: worst,
        iconName: worst ? 'anMerge' : 'shieldCheck',
        title: !withMixins ? t('analysis.mixNoMixinsTitle') : important ? t('analysis.mixIssuesTitle', { count: important }) : t('analysis.mixCleanTitle'),
        sub: !withMixins ? t('analysis.mixNoMixinsText') : important ? t('analysis.mixIssuesText') : t('analysis.mixCleanText'),
        meta: [
          r.stats.files ? h('span', {}, icon('file'), t('analysis.mixStatFiles', { count: r.stats.files })) : null,
          h('span', { title: t('analysis.mixStatModsHint') }, icon('puzzle'), t('analysis.mixStatMods', { count: withMixins })),
          h('span', {}, icon('layers'), t('analysis.mixStatClasses', { count: r.stats.mixinClasses })),
          h('span', {}, icon('target'), t('analysis.mixStatInjections', { count: r.stats.injections })),
          r.analyzedAt ? h('span', { title: `${fmtDate(r.analyzedAt)} ${fmtTime(r.analyzedAt)}` }, icon('clock'), t('analysis.scannedAgo', { when: ago(r.analyzedAt) })) : null,
        ].filter(Boolean),
        pills: ['high', 'medium', 'info'].filter((k) => r.counts[k]).map((k) => countPill(k, r.counts[k])),
      }),
    );
    parts.push(explainBox('analysis.mixWhatTitle', ['analysis.mixWhat1', 'analysis.mixWhat2'], ['analysis.mixDo1', 'analysis.mixDo2', 'analysis.mixDo3', 'analysis.mixDo4']));
    if (r.unreadable?.length) parts.push(h('div', { class: 'notice' }, icon('alert'), h('div', {}, t('analysis.mixUnreadable', { count: r.unreadable.length, files: r.unreadable.slice(0, 3).join(', ') }))));

    if (r.conflicts.length) {
      const listBox = h('div', { class: 'an-groups' });
      const chipsBox = h('div');
      const search = h('input', { class: 'input', type: 'search', value: state.query, placeholder: t('analysis.mixSearch'), 'aria-label': t('analysis.mixSearch') });
      const filters = [
        { id: 'important', label: t('analysis.mixFilterImportant', { count: important }) },
        { id: 'all', label: t('analysis.mixFilterAll', { count: r.conflicts.length }) },
      ];
      const renderList = () => {
        redraw(chipsBox, chipsView(filters, state.filter, (fid) => ((state.filter = fid), renderList())));
        redraw(listBox, conflictsView(r));
      };
      search.addEventListener(
        'input',
        debounce(() => {
          state.query = search.value;
          redraw(listBox, conflictsView(r));
        }, 180),
      );
      renderList();
      parts.push(h('div', { class: 'an-toolbar' }, chipsBox, h('span', { class: 'spacer' }), h('div', { class: 'input-icon an-search' }, icon('search'), search)), listBox);
    }
    if (r.hot?.length) parts.push(hotView(r));
    parts.push(modsView(r));
    return parts;
  }

  function conflictsView(r) {
    const q = state.query.trim().toLowerCase();
    let list = r.conflicts.filter((c) => state.filter === 'all' || c.severity !== 'info');
    if (q) {
      list = list.filter((c) =>
        [c.target.cls, c.target.clsName, c.target.method, c.target.methodName, c.call?.name, c.call?.nameAlias, ...c.mods.map((i) => modName(r, i))]
          .filter(Boolean)
          .some((s) => String(s).toLowerCase().includes(q)),
      );
    }
    if (!list.length) return h('div', { class: 'an-empty-filter' }, icon('shieldCheck'), q ? t('analysis.mixNoMatches') : t('analysis.mixNoImportant'));
    const groups = new Map();
    for (const c of list) {
      if (!groups.has(c.target.cls)) groups.set(c.target.cls, []);
      groups.get(c.target.cls).push(c);
    }
    return [...groups.entries()].map(([cls, items]) => {
      const tg = items[0].target;
      const worst = items.reduce((a, c) => (SEV_ORDER[c.severity] > SEV_ORDER[a] ? c.severity : a), 'info');
      const raw = cls.replace(/\//g, '.');
      return h(
        'section',
        { class: `an-group sev-${worst}` },
        h(
          'header',
          { class: 'an-group-head' },
          icon('box'),
          h('span', { class: 'an-group-title', title: tg.guess ? t('analysis.guessHint') : tg.clsFull || raw }, tg.guess ? `≈ ${prettyClass(tg)}` : prettyClass(tg)),
          h('span', { class: 'an-group-raw mono ellipsis', title: raw }, raw),
          h('span', { class: 'an-count', title: t('analysis.groupCount', { count: items.length }) }, String(items.length)),
        ),
        items.map((c) => conflictView(r, c)),
      );
    });
  }

  function conflictView(r, c) {
    const open = state.open.has(c.id);
    const kindText = c.kind === 'overwrite-inject' ? t(`analysis.kindText_overwrite-inject_${c.severity === 'high' ? 'high' : 'medium'}`) : t(`analysis.kindText_${c.kind}`, { count: c.mods.length });
    const hints = [c.managed && t('analysis.hintManaged'), c.dynamic && t('analysis.hintDynamic'), c.optional && t('analysis.hintOptional'), c.ambiguous && t('analysis.hintAmbiguous')].filter(Boolean);
    const methodLabel = prettyMethod(c.target);
    const rawMethod = `${c.target.method}${c.target.desc || ''}`;
    const el = h('div', { class: ['an-conflict', `sev-${c.severity}`, open && 'is-open'] });
    const toggle = () => {
      if (state.open.has(c.id)) state.open.delete(c.id);
      else state.open.add(c.id);
      const next = conflictView(r, c);
      el.replaceWith(next);
      next.querySelector('.an-conflict-toggle')?.focus({ preventScroll: true });
    };
    const callLabel = c.call ? `${c.call.ownerName || c.call.owner.slice(c.call.owner.lastIndexOf('/') + 1)}.${c.call.nameAlias || c.call.name}` : '';
    el.append(
      h(
        'div',
        { class: 'an-conflict-head' },
        sevPill(c.severity),
        h(
          'div',
          { class: 'an-conflict-main' },
          h('div', { class: 'an-conflict-title' }, t(`analysis.kind_${c.kind}`)),
          h(
            'div',
            { class: 'an-conflict-target' },
            h('span', { class: 'an-method', title: rawMethod }, `${prettyClass(c.target)}.${methodLabel}`),
            methodLabel !== c.target.method || c.target.desc ? h('span', { class: 'mono an-raw ellipsis', title: rawMethod }, rawMethod) : null,
          ),
          c.call ? h('div', { class: 'an-call', title: c.call.key }, icon('target'), t('analysis.mixCall', { call: callLabel })) : null,
        ),
        h(
          'button',
          {
            class: 'btn sm ghost an-conflict-toggle',
            type: 'button',
            'aria-expanded': String(open),
            'data-fk': `c:${c.id}`,
            onclick: toggle,
          },
          open ? t('analysis.hideDetails') : t('analysis.showDetails'),
          icon('chevronDown', 'an-chev'),
        ),
      ),
      h('div', { class: 'an-mods' }, c.mods.map((i) => h('span', { class: 'an-mod-chip', title: r.mods[i]?.nested ? `${r.mods[i].file} → ${r.mods[i].nested}` : r.mods[i]?.file || '' }, icon('puzzle'), modName(r, i)))),
      h('p', { class: 'an-conflict-text' }, kindText),
    );
    // append() nativo convierte null en el texto "null": las sugerencias se agregan solo si hay
    if (hints.length) el.append(h('div', { class: 'an-hints' }, hints.map((x) => h('span', { class: 'an-hint' }, icon('info'), x))));
    if (open) {
      el.append(
        h(
          'div',
          { class: 'an-entries' },
          c.entries.map((e) =>
            h(
              'div',
              { class: 'an-entry' },
              h('span', { class: 'an-entry-mod ellipsis' }, modName(r, e.mod)),
              h('code', { class: 'an-entry-ann' }, ANNOTATION[e.kind] || e.kind),
              h('span', { class: 'an-entry-desc' }, t(`analysis.inj_${e.kind}`), e.at?.length ? h('span', { class: 'muted', title: e.at.map((a) => a.named || a.target || a.value).join('\n') }, ` · ${e.at.map(atText).join(', ')}`) : null),
              h('span', { class: 'an-entry-mixin mono ellipsis', title: `${e.mixin}#${e.handler}` }, `${e.mixin.slice(e.mixin.lastIndexOf('.') + 1)}#${e.handler}`),
              h('span', { class: 'an-entry-flags' }, h('span', { class: 'badge', title: t('analysis.priorityHint') }, t('analysis.priority', { n: e.priority })), e.optional ? h('span', { class: 'badge', title: t('analysis.hintOptional') }, t('analysis.optional')) : null),
            ),
          ),
          h('div', { class: 'an-entry-actions' }, h('button', { class: 'btn sm ghost', type: 'button', onclick: () => copyText(conflictText(r, c), t('analysis.copied')) }, icon('copy'), t('analysis.copyDetails'))),
        ),
      );
    }
    return el;
  }

  // Texto técnico para pegar en un reporte de errores al autor de un mod.
  function conflictText(r, c) {
    const lines = [`${t(`analysis.kind_${c.kind}`)}: ${c.target.cls.replace(/\//g, '.')}#${c.target.method}${c.target.desc || ''}`];
    for (const e of c.entries) {
      const at = e.at?.length ? ` @At(${e.at.map((a) => `${a.value}${a.target ? ` ${a.target}` : ''}`).join(', ')})` : '';
      lines.push(`- ${modName(r, e.mod)} (${r.mods[e.mod]?.file || ''}): ${ANNOTATION[e.kind] || e.kind} ${e.mixin}#${e.handler}${at}`);
    }
    return lines.join('\n');
  }

  function hotView(r) {
    const max = Math.max(...r.hot.map((x) => x.mods.length));
    return h(
      'div',
      { class: 'an-hot' },
      h('div', { class: 'an-section-title', role: 'heading', 'aria-level': '4' }, icon('flame'), t('analysis.mixHotTitle')),
      h('p', { class: 'an-section-sub' }, t('analysis.mixHotText')),
      h(
        'div',
        { class: 'an-hot-list' },
        r.hot.map((x) =>
          h(
            'div',
            { class: 'an-hot-row', title: x.mods.map((i) => modName(r, i)).join(', ') },
            h('span', { class: 'an-hot-name ellipsis' }, x.guess ? `≈ ${x.clsName}` : x.clsName || x.cls.slice(x.cls.lastIndexOf('/') + 1)),
            h('span', { class: 'an-hot-bar', 'aria-hidden': 'true' }, h('i', { style: { width: `${Math.round((x.mods.length / max) * 100)}%` } })),
            h('span', { class: 'an-hot-count' }, t('analysis.mixHotCount', { count: x.mods.length })),
          ),
        ),
      ),
    );
  }

  function modsView(r) {
    const mods = r.mods.filter((m) => m.mixins > 0).sort((a, b) => b.injections - a.injections);
    // Sin mods con mixins el encabezado ya lo explica: no hace falta una lista vacía
    if (!mods.length) return null;
    const det = h(
      'details',
      { class: 'an-explain an-mods-list' },
      h('summary', { 'data-fk': 'sec:mods' }, icon('puzzle'), h('span', {}, t('analysis.mixModsTitle', { count: mods.length })), icon('chevronDown', 'an-chev')),
      h(
        'div',
        { class: 'an-explain-body' },
        mods.length
          ? h(
              'table',
              { class: 'table an-table' },
              h('thead', {}, h('tr', {}, h('th', {}, t('analysis.colMod')), h('th', {}, t('analysis.colFile')), h('th', { class: 'num' }, t('analysis.colMixins')), h('th', { class: 'num' }, t('analysis.colInjections')))),
              h(
                'tbody',
                {},
                mods.map((m) =>
                  h(
                    'tr',
                    {},
                    h('td', {}, h('span', { class: 'an-td-name' }, m.name, m.plugin ? h('span', { class: 'badge an-mini', title: t('analysis.hintManaged') }, t('analysis.pluginBadge')) : null)),
                    h('td', { class: 'mono an-td-file', title: m.nested ? `${m.file} → ${m.nested}` : m.file }, m.nested ? `${m.file} → ${m.nested}` : m.file),
                    h('td', { class: 'num' }, String(m.mixins)),
                    h('td', { class: 'num' }, String(m.injections)),
                  ),
                ),
              ),
            )
          : h('p', { class: 'muted' }, t('analysis.mixNoMixinsText')),
      ),
    );
    return keepOpen(det, 'mix:mods');
  }

  async function run() {
    if (state.running || dlg.closed) return;
    state.running = true;
    state.error = null;
    state.progress = null;
    renderProgress();
    renderMain();
    renderFoot();
    try {
      state.report = await api.invoke('mixins:analyze', id);
    } catch (err) {
      if (isMissingChannel(err)) state.error = { missing: true };
      else if (inst && !MOD_LOADERS.has(inst.loader)) state.error = { noMods: true, message: err?.message };
      else if (isCancel(err)) state.error = state.report ? null : { message: t('analysis.cancelled') };
      else state.error = { message: err?.message || String(err) };
    } finally {
      state.running = false;
      state.taskId = null;
      renderProgress();
      renderMain();
      renderFoot();
    }
  }

  renderFoot();
  renderMain();
  if (noLoader) {
    state.error = { noMods: true };
    renderMain();
    renderFoot();
    return;
  }
  try {
    const saved = await api.invoke('mixins:results', id);
    if (saved?.conflicts && !dlg.closed) {
      state.report = saved;
      renderMain();
    }
  } catch (err) {
    if (isMissingChannel(err)) {
      state.error = { missing: true };
      renderMain();
      return;
    }
  }
  run();
}
