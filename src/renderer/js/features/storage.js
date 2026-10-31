// Almacenamiento y descargas (paneles reutilizables, por ejemplo en Ajustes):
//  - storagePanel(): espacio en disco por categoria, archivos repetidos entre instancias y servidores
//    (se guardan una sola vez con enlaces duros), unificacion automatica y limpieza con vista previa.
//  - downloadsPanel(): velocidad en vivo, pausa global, limite de velocidad, descargas simultaneas
//    y modo sin conexion.
// Cada panel carga sus textos y estilos solo, y se desuscribe de los eventos al salir del documento.
import { h, icon, mount, loading, toast, ok, fail, confirmDialog, fmtBytes, fmtAgo, switchEl, ensureCss, registerIcons, debounce, setBusy } from '../ui.js';
import { api } from '../store.js';
import { t, loadNs, locale } from '../i18n.js';
import { navigate } from '../app.js';

registerIcons({
  stgWifiOff:
    '<path d="M12 20h.01"/><path d="M8.5 16.429a5 5 0 0 1 7 0"/><path d="M5 12.859a10 10 0 0 1 5.17-2.69"/><path d="M19 12.859a10 10 0 0 0-2.007-1.523"/><path d="M2 8.82a15 15 0 0 1 4.177-2.643"/><path d="M22 8.82a15 15 0 0 0-11.288-3.764"/><path d="m2 2 20 20"/>',
});

const CAT_ICONS = {
  instances: 'layers',
  servers: 'server',
  versions: 'package',
  libraries: 'box',
  assets: 'image',
  runtime: 'coffee',
  cache: 'refresh',
  store: 'link',
  snapshots: 'history',
  backups: 'archive',
  other: 'folder',
};
const FOLDER_ICONS = { mods: 'puzzle', resourcepacks: 'image', shaderpacks: 'sun', plugins: 'plug' };
const CLEAN_KINDS = ['cache', 'unusedVersions', 'unusedRuntimes', 'orphanStore', 'partials'];
const CLEAN_DETAILS = new Set(['cache', 'unusedVersions', 'unusedRuntimes']);
// Limite de velocidad en KB/s; 0 = sin limite (al final del deslizador)
const LIMIT_STEPS = [128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 0];
const CONCURRENCY = [0, 1, 2, 4, 8, 16];
const GROUPS_SHORT = 4;
let uidSeq = 0;

async function ensureUi() {
  ensureCss('features/storage');
  await loadNs('storage');
}

const isCancel = (err) => /cancel/i.test(err?.message || '');

// Esqueletos de carga: un solo anuncio para el lector de pantalla + una nota visible de qué se está haciendo.
const bone = (cls, style) => h('span', { class: `skeleton ${cls}`, style });
const boneRow = (iconStyle = null) => h('div', { class: 'skeleton-row' }, bone('skeleton-icon', iconStyle), h('div', { class: 'skeleton-lines' }, bone('skeleton-line'), bone('skeleton-line')));
function skel(label, note, ...shapes) {
  return h(
    'div',
    { class: 'skeleton-group', role: 'status', 'aria-live': 'polite', 'aria-busy': 'true' },
    h('span', { class: 'sr-only' }, label),
    h('div', { class: 'skeleton-shapes stg-skel', 'aria-hidden': 'true' }, shapes),
    note ? h('div', { class: 'stg-skel-note', 'aria-hidden': 'true' }, h('span', { class: 'spinner stg-skel-spin' }), note) : null,
  );
}
function usageSkeleton() {
  return skel(
    t('storage.usageFirstTime'),
    t('storage.usageFirstTime'),
    h(
      'div',
      { class: 'stg-skel-hero' },
      h('div', { class: 'skeleton-lines stg-skel-total' }, bone('skeleton-line', { width: '150px', height: '38px' }), bone('skeleton-line', { width: '110px' })),
      h('div', { class: 'skeleton-lines stg-skel-disk' }, bone('skeleton-line', { height: '8px' }), bone('skeleton-line', { width: '65%' })),
    ),
    bone('skeleton-line', { height: '14px', borderRadius: '7px' }),
    h('div', { class: 'stg-skel-rows' }, [92, 74, 60, 48, 36].map((w) => bone('skeleton-line', { width: `${w}%` }))),
  );
}

function errorBox(err, retry) {
  return h(
    'div',
    { class: 'notice bad stg-error', role: 'alert' },
    icon('alert'),
    h('div', { class: 'stg-error-text' }, t('storage.loadError', { error: err?.message || String(err) })),
    retry ? h('button', { type: 'button', class: 'btn sm', onclick: retry }, icon('refresh'), t('common.retry')) : null,
  );
}

// Los paneles no tienen funcion de limpieza: se desuscriben solos cuando salen del documento.
function lifecycle(root, onTick) {
  const disposers = [];
  let seen = false;
  let ticks = 0;
  const dispose = () => {
    clearInterval(timer);
    for (const fn of disposers.splice(0)) {
      try {
        fn();
      } catch {
        /* ya desuscripto */
      }
    }
  };
  const timer = setInterval(() => {
    ticks++;
    if (root.isConnected) {
      seen = true;
      onTick?.(ticks);
    } else if (seen || ticks > 120) dispose();
  }, 1000);
  return { add: (fn) => disposers.push(fn), dispose };
}

function secHead(iconName, title, sub, extra, id) {
  return h(
    'div',
    { class: 'stg-head' },
    h('div', { class: 'stg-head-icon' }, icon(iconName)),
    h('div', { class: 'stg-head-text' }, h('h3', { class: 'stg-head-title', id }, title), sub ? h('p', { class: 'stg-head-sub' }, sub) : null),
    extra ? h('div', { class: 'stg-head-extra' }, extra) : null,
  );
}

// "12.4 GB" -> numero grande + unidad
function bigBytes(n, unitSuffix = '') {
  const [num, unit] = fmtBytes(n).split(' ');
  return h('span', { class: 'stg-big' }, h('span', { class: 'stg-big-num' }, num), h('span', { class: 'stg-big-unit' }, unitSuffix ? t('storage.speed', { size: unit }) : unit));
}

function fmtKbps(k) {
  if (!k) return t('storage.unlimited');
  if (k >= 1024) return t('storage.mbps', { n: Number((k / 1024).toFixed(k % 1024 ? 1 : 0)) });
  return t('storage.kbps', { n: k });
}

function fmtPct(p) {
  return new Intl.NumberFormat(locale(), { maximumFractionDigits: p < 10 ? 1 : 0 }).format(p);
}

const catName = (key) => t(`storage.cat_${key}`);

// "Hace un momento" -> "hace un momento" (va en medio de una frase)
function ago(ts) {
  const s = fmtAgo(ts);
  return s ? s.charAt(0).toLocaleLowerCase(locale()) + s.slice(1) : s;
}

// =====================================================================
// Panel de almacenamiento
// =====================================================================
export function storagePanel() {
  const root = h('div', { class: 'stg-panel stg-storage' }, loading());
  let disposed = false;
  let life = null;
  // Quien lo muestra puede limpiarlo al salir (si no, se limpia solo al salir del documento).
  root.destroy = () => {
    disposed = true;
    life?.dispose();
  };
  (async () => {
    try {
      await ensureUi();
    } catch (err) {
      mount(root, errorBox(err));
      return;
    }
    if (!disposed) life = buildStorage(root);
  })();
  return root;
}

function buildStorage(root) {
  // El texto "Actualizado hace X" se mantiene al dia mientras el panel esta a la vista
  const life = lifecycle(root, (n) => {
    if (n % 30 === 0) usage.tick();
  });
  const ids = { usage: `stg-u-${++uidSeq}`, dup: `stg-d-${uidSeq}`, clean: `stg-c-${uidSeq}` };
  // Tarjetas con título propio: quien las muestra (Ajustes) no repite el título "Espacio en disco" arriba
  const usageSec = h('section', { class: 'card stg-sec stg-usage', 'aria-labelledby': ids.usage });
  const dupSec = h('section', { class: 'card stg-sec stg-dup', 'aria-labelledby': ids.dup });
  const cleanSec = h('section', { class: 'card stg-sec stg-clean', 'aria-labelledby': ids.clean });
  mount(root, usageSec, dupSec, cleanSec);

  let ownOp = false;
  const refreshAll = debounce(() => {
    usage.load(true);
    dup.scan();
    clean.load();
  }, 300);
  const withOp = async (fn) => {
    ownOp = true;
    try {
      await fn();
    } finally {
      ownOp = false;
      refreshAll();
    }
  };

  const usage = usageView(usageSec, ids.usage);
  const dup = dupView(dupSec, ids.dup, withOp);
  const clean = cleanView(cleanSec, ids.clean, withOp);
  usage.load(false);
  dup.init();
  clean.load();

  // Cambios hechos en otro lado (unificacion automatica, otra ventana del panel)
  life.add(
    api.on('storage:changed', () => {
      if (!ownOp) refreshAll();
    }),
  );
  return life;
}

// ---------- Espacio en disco ----------
function usageView(sec, headId) {
  const meta = h('span', { class: 'stg-meta' });
  const refreshBtn = h('button', { type: 'button', class: 'icon-btn sm', title: t('storage.refresh'), 'aria-label': t('storage.refresh'), onclick: () => load(true) }, icon('refresh'));
  const body = h('div', { class: 'stg-usage-body' }, usageSkeleton());
  mount(sec, secHead('drive', t('storage.usageTitle'), t('storage.usageSub'), [meta, refreshBtn], headId), body);
  let data = null;
  let busy = false;
  const open = new Set();

  function drawMeta() {
    if (busy) meta.textContent = t('storage.calculating');
    else meta.textContent = data?.at ? t('storage.updatedAgo', { ago: ago(data.at) }) : '';
  }

  async function load(force) {
    if (busy) return;
    busy = true;
    refreshBtn.disabled = true;
    refreshBtn.classList.add('stg-spinning');
    drawMeta();
    let again = false;
    try {
      const res = await api.invoke('storage:usage', force ? { force: true } : {});
      data = res;
      draw();
      again = !force && res.stale;
    } catch (err) {
      if (!data) mount(body, errorBox(err, () => load(true)));
      else toast('bad', t('storage.loadError', { error: err.message }));
    } finally {
      busy = false;
      refreshBtn.disabled = false;
      refreshBtn.classList.remove('stg-spinning');
      drawMeta();
    }
    if (again) load(true);
  }

  function diskMeter(disk) {
    const used = Math.max(0, disk.total - disk.free);
    const ours = Math.min(data.total, used);
    const pctOurs = disk.total ? (ours / disk.total) * 100 : 0;
    const pctOther = disk.total ? ((used - ours) / disk.total) * 100 : 0;
    const low = disk.total && disk.free / disk.total < 0.1;
    return h(
      'div',
      { class: ['stg-disk', low && 'low'] },
      h(
        'div',
        { class: 'stg-disk-bar', role: 'img', 'aria-label': t('storage.usageDiskAria') },
        // Lo de Venus siempre se ve aunque sea muy poco al lado de un disco grande
        h('i', { class: 'ours', style: { width: `max(4px, ${pctOurs}%)` } }),
        h('i', { class: 'other', style: { width: `${pctOther}%` } }),
      ),
      h('div', { class: 'stg-disk-text' }, icon(low ? 'alert' : 'drive'), t('storage.usageDiskFree', { free: fmtBytes(disk.free), total: fmtBytes(disk.total) })),
    );
  }

  function ownerList(kind) {
    const list = kind === 'instances' ? data.instances : data.servers;
    const max = Math.max(1, ...list.map((o) => o.size));
    return h(
      'div',
      { class: 'stg-owners' },
      list.map((o) =>
        h(
          'div',
          { class: 'stg-owner' },
          h(
            'button',
            {
              type: 'button',
              class: 'stg-owner-name',
              title: t(kind === 'instances' ? 'storage.openInstance' : 'storage.openServer', { name: o.name }),
              onclick: () => navigate(`${kind === 'instances' ? 'instance' : 'server'}/${encodeURIComponent(o.id)}`),
            },
            o.name,
          ),
          h('span', { class: 'stg-owner-bar' }, h('i', { style: { width: `${(o.size / max) * 100}%`, '--c': `var(--stg-${kind})` } })),
          h('span', { class: 'stg-owner-size' }, fmtBytes(o.size), o.logical - o.size > 1048576 ? h('small', {}, t('storage.ownerShared', { size: fmtBytes(o.logical - o.size) })) : null),
        ),
      ),
    );
  }

  function catRow(c, max) {
    const list = c.key === 'instances' ? data.instances : c.key === 'servers' ? data.servers : null;
    const expandable = Boolean(list && list.length);
    const isOpen = expandable && open.has(c.key);
    const row = h(
      'div',
      { class: ['stg-cat', isOpen && 'open'], title: c.key === 'store' ? t('storage.catHint_store') : null },
      h('span', { class: 'stg-swatch', style: { '--c': `var(--stg-${c.key})` } }),
      h('span', { class: 'stg-cat-icon' }, icon(CAT_ICONS[c.key] || 'folder')),
      h('span', { class: 'stg-cat-name' }, catName(c.key), list ? h('span', { class: 'stg-count' }, String(list.length)) : null),
      h('span', { class: 'stg-cat-bar' }, h('i', { style: { width: `${max ? Math.max(1.5, (c.size / max) * 100) : 0}%`, '--c': `var(--stg-${c.key})` } })),
      h('span', { class: 'stg-cat-size' }, fmtBytes(c.size)),
      expandable
        ? h(
            'button',
            {
              type: 'button',
              class: 'icon-btn sm stg-cat-toggle',
              'aria-expanded': String(isOpen),
              title: t('storage.showOwners', { name: catName(c.key) }),
              'aria-label': t('storage.showOwners', { name: catName(c.key) }),
              onclick: () => {
                if (open.has(c.key)) open.delete(c.key);
                else open.add(c.key);
                draw();
              },
            },
            icon('chevronDown'),
          )
        : h('span', { class: 'stg-cat-toggle-space' }),
    );
    return [row, isOpen ? ownerList(c.key) : null];
  }

  function draw() {
    if (!data) return;
    const cats = data.categories.filter((c) => c.size > 0).sort((a, b) => b.size - a.size);
    if (!data.total || !cats.length) {
      mount(body, h('div', { class: 'stg-empty' }, icon('drive'), t('storage.usageEmpty')), data.disk ? diskMeter(data.disk) : null);
      return;
    }
    const max = cats[0].size;
    const shared = data.logical - data.total;
    mount(
      body,
      h('div', { class: 'stg-hero' }, h('div', { class: 'stg-hero-total' }, bigBytes(data.total), h('div', { class: 'stg-hero-label' }, t('storage.usageTotal'))), data.disk ? diskMeter(data.disk) : null),
      h(
        'div',
        { class: 'stg-stack', role: 'img', 'aria-label': t('storage.usageBarAria') },
        cats.map((c) => {
          const pct = (c.size / data.total) * 100;
          return h('i', { style: { width: `${pct}%`, '--c': `var(--stg-${c.key})` }, title: t('storage.usageSegment', { name: catName(c.key), size: fmtBytes(c.size), pct: fmtPct(pct) }) });
        }),
      ),
      h('div', { class: 'stg-cats' }, cats.map((c) => catRow(c, max))),
      shared > 1048576 ? h('div', { class: 'stg-note good' }, icon('link'), t('storage.usageShared', { size: fmtBytes(shared) })) : null,
    );
  }

  return { load, tick: () => !busy && drawMeta() };
}

// ---------- Archivos repetidos ----------
function dupView(sec, headId, withOp) {
  const autoBadge = h('span', { class: 'badge good stg-auto-badge', hidden: true }, icon('zap'), t('storage.autoBadge'));
  const body = h('div', { class: 'stg-dup-body' });
  const autoRow = h('div', { class: 'stg-auto' });
  mount(
    sec,
    secHead('link', t('storage.dupTitle'), t('storage.dupSub'), autoBadge, headId),
    h('div', { class: 'stg-safe' }, icon('shieldCheck'), h('div', {}, t('storage.dupSafe'))),
    body,
    autoRow,
  );
  let summary = null;
  let scanning = false;
  let running = false;
  let expanded = false;

  async function init() {
    loadAuto();
    try {
      const st = await api.invoke('storage:status');
      if (st?.lastScan && st.busy !== 'scan') {
        // Hay un analisis reciente en memoria: se muestra al instante.
        const cached = await api.invoke('storage:scan', { cached: true }).catch(() => null);
        if (cached) {
          summary = cached;
          draw();
          return;
        }
      }
    } catch {
      /* se analiza abajo */
    }
    scan();
  }

  async function scan() {
    if (scanning || running) return;
    scanning = true;
    if (!summary) mount(body, skel(t('storage.dupScanning'), t('storage.dupScanning'), h('div', { class: 'skeleton-list' }, boneRow(), boneRow(), boneRow())));
    else draw();
    try {
      const st = await api.invoke('storage:status').catch(() => null);
      // Otro analisis en curso se comparte; una unificacion o limpieza hay que esperarla.
      if (st?.busy && st.busy !== 'scan') {
        mount(body, h('div', { class: 'notice info' }, icon('clock'), h('div', { class: 'stg-error-text' }, t('storage.dupBusyOp')), h('button', { type: 'button', class: 'btn sm', onclick: () => scan() }, icon('refresh'), t('storage.dupRescan'))));
        return;
      }
      summary = await api.invoke('storage:scan');
      scanning = false;
      draw();
    } catch (err) {
      mount(body, h('div', { class: 'notice bad stg-error' }, icon('alert'), h('div', { class: 'stg-error-text' }, h('strong', {}, t('storage.dupScanError')), h('div', {}, err.message)), h('button', { type: 'button', class: 'btn sm', onclick: () => scan() }, icon('refresh'), t('common.retry'))));
    } finally {
      scanning = false;
    }
  }

  async function run(btn) {
    if (running) return;
    running = true;
    mount(btn, icon('link'), t('storage.dupRunning'));
    setBusy(btn);
    await withOp(async () => {
      try {
        const r = await api.invoke('storage:dedupe');
        if (r.unsupported) toast('bad', t('storage.dupError'), t('storage.dupUnsupported'), 9000);
        else if (r.freed > 0) ok(t('storage.dupDone', { size: fmtBytes(r.freed) }), r.linked ? t('storage.dupDoneLinked', { count: r.linked }) : null);
        else toast('info', t('storage.dupDoneNothing'), r.linked ? t('storage.dupDoneLinked', { count: r.linked }) : null);
      } catch (err) {
        if (!isCancel(err)) fail(t('storage.dupError'), err);
      } finally {
        running = false;
      }
    });
  }

  function owners(files) {
    const map = new Map();
    for (const f of files) {
      const k = `${f.owner.kind}:${f.owner.id}`;
      const cur = map.get(k) || { ...f.owner, busy: false };
      cur.busy = cur.busy || f.busy;
      map.set(k, cur);
    }
    return [...map.values()];
  }

  function groupRow(g) {
    const folder = g.files[0]?.folder;
    return h(
      'li',
      { class: 'stg-group' },
      h('div', { class: 'stg-group-icon' }, icon(FOLDER_ICONS[folder] || 'file')),
      h(
        'div',
        { class: 'stg-group-main' },
        h('div', { class: 'stg-group-name', title: g.name }, g.name),
        h(
          'div',
          { class: 'stg-group-owners' },
          owners(g.files).map((o) =>
            h('span', { class: ['stg-chip', o.busy && 'busy'], title: o.name }, icon(o.kind === 'server' ? 'server' : 'layers'), h('span', { class: 'stg-chip-name' }, o.name), o.busy ? h('em', {}, t('storage.dupBusyChip')) : null),
          ),
        ),
      ),
      h('div', { class: 'stg-group-side' }, g.savings ? h('div', { class: 'stg-group-save' }, `−${fmtBytes(g.savings)}`) : null, h('div', { class: 'stg-group-size' }, t('storage.dupTimes', { size: fmtBytes(g.size), count: g.count }))),
    );
  }

  function kpi(cls, label, value, ...lines) {
    return h('div', { class: ['stg-kpi', cls] }, h('div', { class: 'stg-kpi-label' }, label), h('div', { class: 'stg-kpi-value' }, value), lines.filter(Boolean).map((l) => h('div', { class: 'stg-kpi-sub' }, l)));
  }

  function draw() {
    const s = summary;
    if (!s) return;
    const rescan = h('button', { type: 'button', class: ['btn ghost sm', scanning && 'loading'], disabled: scanning || running, 'aria-busy': scanning ? 'true' : null, onclick: () => scan() }, icon('refresh'), t('storage.dupRescan'));
    if (!s.files) {
      mount(body, h('div', { class: 'stg-empty' }, icon('puzzle'), t('storage.dupNoFiles')), h('div', { class: 'stg-actions' }, rescan));
      return;
    }
    const groups = s.groups.filter((g) => g.replace > 0 || g.busy > 0);
    const shown = expanded ? groups : groups.slice(0, GROUPS_SHORT);
    const parts = [];
    if (s.duplicates > 0) {
      parts.push(
        h(
          'div',
          { class: ['stg-kpis', !s.shared && 'single'] },
          kpi('save', t('storage.dupSavings'), fmtBytes(s.savings), t('storage.dupCopies', { count: s.duplicates }), t('storage.dupGroups', { count: s.groupCount })),
          s.shared ? kpi('', t('storage.dupAlready'), fmtBytes(s.shared), s.sharedFiles ? t('storage.dupAlreadyHint', { count: s.sharedFiles }) : null) : null,
        ),
      );
    } else {
      parts.push(h('div', { class: 'notice good stg-none' }, icon('check'), h('div', {}, t('storage.dupNone'))));
      if (s.shared > 0) parts.push(h('div', { class: 'stg-kpis single' }, kpi('', t('storage.dupAlready'), fmtBytes(s.shared), t('storage.dupAlreadyHint', { count: s.sharedFiles }))));
    }
    if (groups.length) {
      parts.push(h('ul', { class: 'stg-groups' }, shown.map(groupRow)));
      if (groups.length > GROUPS_SHORT) {
        parts.push(
          h(
            'button',
            {
              type: 'button',
              class: 'btn ghost sm stg-more',
              'aria-expanded': String(expanded),
              onclick: () => {
                expanded = !expanded;
                draw();
              },
            },
            icon('chevronDown', expanded ? 'stg-flip' : null),
            expanded ? t('storage.dupLess') : t('storage.dupMore', { count: groups.length - GROUPS_SHORT }),
          ),
        );
      }
    }
    if (s.busy > 0) parts.push(h('div', { class: 'stg-note' }, icon('clock'), t('storage.dupBusyNote', { count: s.busy })));
    const runBtn = h('button', { type: 'button', class: ['btn primary', running && 'loading'], disabled: !s.duplicates || running || scanning, 'aria-busy': running ? 'true' : null }, icon('link'), running ? t('storage.dupRunning') : t('storage.dupRun'));
    runBtn.addEventListener('click', () => run(runBtn));
    parts.push(h('div', { class: 'stg-actions' }, s.duplicates ? runBtn : null, rescan, h('span', { class: 'stg-meta' }, t('storage.updatedAgo', { ago: ago(s.at) }))));
    mount(body, parts);
  }

  async function loadAuto() {
    try {
      drawAuto(await api.invoke('storage:autoDedupe'));
    } catch (err) {
      mount(autoRow, errorBox(err, loadAuto));
    }
  }

  function drawAuto(state) {
    const last = state.lastRun
      ? state.lastRun.freed > 0
        ? t('storage.autoLast', { ago: ago(state.lastRun.at), size: fmtBytes(state.lastRun.freed) })
        : t('storage.autoLastNothing', { ago: ago(state.lastRun.at) })
      : null;
    const sw = switchEl(
      Boolean(state.enabled),
      async (v) => {
        try {
          const next = await api.invoke('storage:autoDedupe', v);
          toast(v ? 'good' : 'info', v ? t('storage.autoOn') : t('storage.autoOff'), null, 2500);
          drawAuto(next);
        } catch (err) {
          fail(t('storage.dlSaveError'), err);
          loadAuto();
        }
      },
      t('storage.autoTitle'),
    );
    mount(
      autoRow,
      h(
        'div',
        { class: 'toggle-row' },
        h('div', { class: 'tr-text' }, h('div', { class: 'tr-title' }, t('storage.autoTitle')), h('div', { class: 'tr-sub' }, t('storage.autoSub')), last ? h('div', { class: 'tr-sub stg-auto-last' }, icon('history'), last) : null),
        sw,
      ),
    );
    autoBadge.hidden = !state.enabled;
  }

  return { init, scan };
}

// ---------- Limpieza ----------
function cleanView(sec, headId, withOp) {
  const calcBtn = h('button', { type: 'button', class: 'icon-btn sm', title: t('storage.cleanCalc'), 'aria-label': t('storage.cleanCalc'), onclick: () => load() }, icon('refresh'));
  const cleanSkeleton = () =>
    skel(t('storage.cleanLoading'), t('storage.cleanLoading'), h('div', { class: 'skeleton-list' }, [0, 1, 2].map(() => boneRow({ width: '18px', height: '18px', borderRadius: '5px' }))));
  const body = h('div', { class: 'stg-clean-body' }, cleanSkeleton());
  mount(sec, secHead('trash', t('storage.cleanTitle'), t('storage.cleanSub'), calcBtn, headId), body);
  const uid = ++uidSeq;
  const chosen = new Set(CLEAN_KINDS);
  const openDetails = new Set();
  let plan = null;
  let loadingNow = false;
  let running = false;

  async function load() {
    if (loadingNow || running) return;
    loadingNow = true;
    calcBtn.disabled = true;
    calcBtn.classList.add('stg-spinning');
    if (!plan) mount(body, cleanSkeleton());
    try {
      plan = await api.invoke('storage:clean', { dryRun: true });
      draw();
    } catch (err) {
      if (!plan) mount(body, errorBox(err, load));
      else toast('bad', t('storage.loadError', { error: err.message }));
    } finally {
      loadingNow = false;
      calcBtn.disabled = false;
      calcBtn.classList.remove('stg-spinning');
    }
  }

  function selectedKinds() {
    return CLEAN_KINDS.filter((k) => chosen.has(k) && plan[k]?.count > 0);
  }

  function detailItem(k, item) {
    const label = k === 'unusedRuntimes' && item.major ? t('storage.cleanRuntime', { major: item.major }) : item.id;
    const tags = [];
    if (k === 'unusedRuntimes' && item.major) tags.push(item.id);
    if (item.leftover) tags.push(t('storage.cleanLeftover'));
    if (item.broken) tags.push(t('storage.cleanBroken'));
    if (k === 'cache' && item.dir) tags.push(t('storage.cleanFolder'));
    return h('li', { class: 'stg-detail' }, h('span', { class: 'stg-detail-name', title: item.id }, label), tags.length ? h('span', { class: 'stg-detail-tags' }, tags.join(' · ')) : null, h('span', { class: 'stg-detail-size' }, fmtBytes(item.size)));
  }

  function row(k) {
    const c = plan[k] || { size: 0, count: 0, items: [] };
    const disabled = !c.count || running;
    const id = `stg-clean-${uid}-${k}`;
    const cb = h('input', { type: 'checkbox', id, class: 'stg-cb', checked: chosen.has(k) && c.count > 0, disabled });
    cb.addEventListener('change', () => {
      if (cb.checked) chosen.add(k);
      else chosen.delete(k);
      draw();
    });
    const canDetail = CLEAN_DETAILS.has(k) && c.items?.length > 0;
    const isOpen = canDetail && openDetails.has(k);
    return h(
      'li',
      { class: ['stg-clean-row', !c.count && 'is-empty', isOpen && 'open'] },
      cb,
      h(
        'label',
        { class: 'stg-clean-text', for: id },
        h('span', { class: 'stg-clean-name' }, t(`storage.clean_${k}`), c.count ? h('span', { class: 'stg-count' }, t('storage.cleanCount', { count: c.count })) : null),
        h('span', { class: 'stg-clean-hint' }, t(`storage.cleanHint_${k}`)),
      ),
      h('span', { class: ['stg-clean-size', !c.count && 'muted'] }, c.count ? fmtBytes(c.size) : t('storage.cleanNothing')),
      canDetail
        ? h(
            'button',
            {
              type: 'button',
              class: 'icon-btn sm stg-cat-toggle',
              'aria-expanded': String(isOpen),
              title: isOpen ? t('storage.cleanHideDetails') : t('storage.cleanDetails'),
              'aria-label': isOpen ? t('storage.cleanHideDetails') : t('storage.cleanDetails'),
              onclick: () => {
                if (openDetails.has(k)) openDetails.delete(k);
                else openDetails.add(k);
                draw();
              },
            },
            icon('chevronDown'),
          )
        : h('span', { class: 'stg-cat-toggle-space' }),
      isOpen ? h('ul', { class: 'stg-details' }, c.items.map((item) => detailItem(k, item))) : null,
    );
  }

  function draw() {
    if (!plan) return;
    const any = CLEAN_KINDS.some((k) => plan[k]?.count > 0);
    const kinds = selectedKinds();
    const total = kinds.reduce((a, k) => a + plan[k].size, 0);
    // Borra definitivamente (con confirmación): botón de peligro, no el principal de la vista
    const runBtn = h('button', { type: 'button', class: ['btn danger', running && 'loading'], disabled: !kinds.length || running, 'aria-busy': running ? 'true' : null }, icon('trash'), running ? t('storage.cleanRunning') : t('storage.cleanRun'));
    runBtn.addEventListener('click', () => run());
    if (!any) {
      mount(body, h('div', { class: 'notice good stg-none' }, icon('sparkles'), h('div', {}, t('storage.cleanAllClean'))));
      return;
    }
    mount(
      body,
      h('ul', { class: 'stg-clean-list' }, CLEAN_KINDS.map(row)),
      h('div', { class: 'stg-clean-foot' }, h('div', { class: 'stg-clean-total' }, kinds.length ? t('storage.cleanTotal', { size: fmtBytes(total) }) : t('storage.cleanTotalNone')), runBtn),
    );
  }

  async function run() {
    const kinds = selectedKinds();
    if (!kinds.length || running) return;
    const total = kinds.reduce((a, k) => a + plan[k].size, 0);
    let what;
    try {
      what = new Intl.ListFormat(locale(), { style: 'long', type: 'conjunction' }).format(kinds.map((k) => t(`storage.clean_${k}`)));
    } catch {
      what = kinds.map((k) => t(`storage.clean_${k}`)).join(', ');
    }
    const yes = await confirmDialog(t('storage.cleanConfirmTitle', { size: fmtBytes(total) }), t('storage.cleanConfirmText', { what }), { okText: t('storage.cleanOk'), danger: true });
    if (!yes) return;
    running = true;
    draw();
    await withOp(async () => {
      try {
        const r = await api.invoke('storage:clean', Object.fromEntries(kinds.map((k) => [k, true])));
        ok(t('storage.cleanDone', { size: fmtBytes(r.freed) }), r.failed ? t('storage.cleanDoneFailed', { count: r.failed }) : null);
      } catch (err) {
        if (!isCancel(err)) fail(t('storage.cleanError'), err);
      } finally {
        running = false;
        plan = null;
      }
    });
  }

  return { load };
}

// =====================================================================
// Panel de descargas
// =====================================================================
export function downloadsPanel() {
  const root = h('div', { class: 'stg-panel stg-dl' }, loading());
  let disposed = false;
  let life = null;
  root.destroy = () => {
    disposed = true;
    life?.dispose();
  };
  (async () => {
    try {
      await ensureUi();
    } catch (err) {
      mount(root, errorBox(err));
      return;
    }
    if (!disposed) life = buildDownloads(root);
  })();
  return root;
}

const SVGNS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs = {}) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

// Grafico de velocidad de los ultimos 60 s (se actualiza en el lugar, sin recrear nodos).
function speedChart() {
  const W = 300;
  const H = 64;
  const gid = `stg-grad-${++uidSeq}`;
  const el = svg('svg', { class: 'stg-spark', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', 'aria-hidden': 'true', focusable: 'false' });
  const defs = svg('defs');
  const grad = svg('linearGradient', { id: gid, x1: '0', y1: '0', x2: '0', y2: '1' });
  grad.append(svg('stop', { offset: '0%', class: 'stg-stop-a' }), svg('stop', { offset: '100%', class: 'stg-stop-b' }));
  defs.append(grad);
  const area = svg('path', { class: 'stg-spark-area', fill: `url(#${gid})` });
  const line = svg('path', { class: 'stg-spark-line' });
  const limit = svg('line', { class: 'stg-spark-limit', x1: '0', x2: String(W) });
  el.append(defs, area, limit, line);
  const label = h('span', { class: 'stg-spark-label' }, t('storage.dlLimitLine'));
  const wrap = h('div', { class: 'stg-spark-wrap', role: 'img', 'aria-label': t('storage.dlChartAria') }, el, label);
  function update(history = [], limitBps = 0) {
    const data = history.length > 1 ? history : [0, 0];
    const max = Math.max(1024, ...data, limitBps) * 1.18;
    const step = W / (data.length - 1);
    const y = (v) => H - 3 - (v / max) * (H - 8);
    const d = data.map((v, i) => `${i ? 'L' : 'M'}${(i * step).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
    line.setAttribute('d', d);
    area.setAttribute('d', `${d} L${W} ${H} L0 ${H} Z`);
    if (limitBps > 0) {
      const ly = y(limitBps);
      limit.setAttribute('y1', ly.toFixed(1));
      limit.setAttribute('y2', ly.toFixed(1));
      limit.style.display = '';
      label.style.display = '';
      label.style.top = `${(ly / H) * 100}%`;
    } else {
      limit.style.display = 'none';
      label.style.display = 'none';
    }
  }
  return { el: wrap, update };
}

function buildDownloads(root) {
  let st = null;
  let pending = false;
  const life = lifecycle(root, (n) => {
    if (n % 5 === 0) poll();
  });
  const uid = ++uidSeq;

  // ---------- Medidor en vivo ----------
  const statusPill = h('span', { class: 'pill stg-status', role: 'status' });
  const speedBox = h('div', { class: 'stg-speed' });
  const statsLine = h('div', { class: 'stg-statline' });
  const pauseBtn = h('button', { type: 'button', class: 'btn sm stg-pause' });
  pauseBtn.addEventListener('click', togglePause);
  const chart = speedChart();
  const files = h('ul', { class: 'stg-files' });
  const pausedNote = h('div', { class: 'notice stg-paused-note', hidden: true }, icon('pause'), h('div', {}, t('storage.dlPausedNote')));
  const meter = h(
    'div',
    { class: 'stg-meter' },
    h('div', { class: 'stg-meter-top' }, h('div', { class: 'stg-meter-main' }, statusPill, speedBox, statsLine), pauseBtn),
    chart.el,
    files,
  );

  // ---------- Limite de velocidad ----------
  const limitValue = h('span', { class: 'stg-limit-value' });
  const range = h('input', { type: 'range', class: 'stg-range', min: '0', max: String(LIMIT_STEPS.length - 1), step: '1', 'aria-label': t('storage.dlLimitAria') });
  // El centro del control no llega a los bordes (mide 20 px): se compensa medio ancho.
  const tickAt = (i) => {
    const p = (i / (LIMIT_STEPS.length - 1)) * 100;
    return h('span', { style: { left: `calc(${p}% + ${(10 - (p / 100) * 20).toFixed(2)}px)` } }, fmtKbps(LIMIT_STEPS[i]));
  };
  const limitSec = h(
    'section',
    { class: 'stg-sec stg-limit', 'aria-labelledby': `stg-l-${uid}` },
    h('div', { class: 'stg-row-head' }, h('div', { class: 'stg-row-text' }, h('h3', { class: 'stg-row-title', id: `stg-l-${uid}` }, icon('gauge'), t('storage.dlLimitTitle')), h('p', { class: 'stg-row-sub' }, t('storage.dlLimitSub'))), limitValue),
    h('div', { class: 'stg-range-wrap' }, range, h('div', { class: 'stg-ticks', 'aria-hidden': 'true' }, [0, 3, 6, LIMIT_STEPS.length - 1].map(tickAt))),
  );
  const stepIndex = (kbps) => {
    if (!kbps) return LIMIT_STEPS.length - 1;
    let best = 0;
    LIMIT_STEPS.forEach((s, i) => {
      if (s && Math.abs(Math.log(s / kbps)) < Math.abs(Math.log((LIMIT_STEPS[best] || 1) / kbps))) best = i;
    });
    return best;
  };
  const paintRange = () => {
    const pct = (Number(range.value) / (LIMIT_STEPS.length - 1)) * 100;
    range.style.setProperty('--p', `${pct}%`);
    const kbps = LIMIT_STEPS[Number(range.value)];
    range.setAttribute('aria-valuetext', fmtKbps(kbps));
    return kbps;
  };
  const saveLimit = debounce(async (kbps) => {
    try {
      apply(await api.invoke('downloads:setLimit', kbps));
    } catch (err) {
      fail(t('storage.dlSaveError'), err);
    } finally {
      pending = false;
    }
  }, 250);
  range.addEventListener('input', () => {
    pending = true;
    const kbps = paintRange();
    limitValue.textContent = fmtKbps(kbps);
    limitValue.classList.toggle('on', kbps > 0);
    saveLimit(kbps);
  });

  // ---------- Descargas simultaneas ----------
  const seg = h('div', { class: 'segmented stg-seg', role: 'radiogroup', 'aria-label': t('storage.dlConcAria') });
  const concSec = h(
    'section',
    { class: 'stg-sec stg-conc', 'aria-labelledby': `stg-c-${uid}` },
    h('div', { class: 'stg-row-head' }, h('div', { class: 'stg-row-text' }, h('h3', { class: 'stg-row-title', id: `stg-c-${uid}` }, icon('sliders'), t('storage.dlConcTitle')), h('p', { class: 'stg-row-sub' }, t('storage.dlConcSub')))),
    seg,
  );
  let concOptions = [...CONCURRENCY];
  const setConcurrency = async (n) => {
    try {
      apply(await api.invoke('downloads:setConcurrency', n));
    } catch (err) {
      fail(t('storage.dlSaveError'), err);
    }
  };
  function drawSeg() {
    const cur = st?.concurrency || 0;
    if (!concOptions.includes(cur)) concOptions = [...CONCURRENCY, cur].sort((a, b) => a - b);
    mount(
      seg,
      concOptions.map((n) => {
        const active = n === cur;
        return h(
          'button',
          {
            type: 'button',
            role: 'radio',
            'aria-checked': String(active),
            tabindex: active ? '0' : '-1',
            class: active ? 'active' : null,
            title: n ? null : t('storage.dlConcAutoHint'),
            dataset: { n: String(n) },
            onclick: () => !active && setConcurrency(n),
          },
          n ? String(n) : h('span', { class: 'stg-auto-opt' }, icon('sparkles'), t('storage.dlConcAuto')),
        );
      }),
    );
  }
  // Flechas para moverse entre las opciones (como un grupo de radios)
  seg.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const cur = concOptions.indexOf(st?.concurrency || 0);
    let next = cur;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = Math.max(0, cur - 1);
    else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = Math.min(concOptions.length - 1, cur + 1);
    else if (e.key === 'Home') next = 0;
    else next = concOptions.length - 1;
    if (next === cur) return;
    setConcurrency(concOptions[next]).then(() => seg.querySelector(`[data-n="${concOptions[next]}"]`)?.focus());
  });

  // ---------- Modo sin conexion ----------
  const offlineSwitch = switchEl(
    false,
    async (v) => {
      try {
        apply(await api.invoke('downloads:setOffline', v));
        toast(v ? 'info' : 'good', t('storage.dlOfflineTitle'), v ? t('storage.dlOfflineOn') : null, 3000);
      } catch (err) {
        fail(t('storage.dlSaveError'), err);
        poll();
      }
    },
    t('storage.dlOfflineTitle'),
  );
  const offlineInput = offlineSwitch.querySelector('input');
  const offlineNote = h('div', { class: 'notice stg-offline-note', hidden: true }, icon('stgWifiOff'), h('div', {}, t('storage.dlOfflineOn')));
  const offlineSec = h(
    'section',
    { class: 'stg-sec stg-offline' },
    h('div', { class: 'toggle-row' }, h('div', { class: 'tr-text' }, h('div', { class: 'tr-title stg-row-title' }, icon('stgWifiOff'), t('storage.dlOfflineTitle')), h('div', { class: 'tr-sub' }, t('storage.dlOfflineSub'))), offlineSwitch),
    offlineNote,
  );

  mount(root, meter, pausedNote, limitSec, concSec, offlineSec, h('div', { class: 'stg-note' }, icon('refresh'), t('storage.dlResumeNote')));

  async function togglePause() {
    pauseBtn.disabled = true;
    try {
      apply(await api.invoke(st?.paused ? 'downloads:resume' : 'downloads:pause'));
    } catch (err) {
      fail(t('storage.dlSaveError'), err);
    } finally {
      pauseBtn.disabled = false;
    }
  }

  function fileRow(f) {
    const pct = f.total ? Math.min(100, (f.received / f.total) * 100) : null;
    return h(
      'li',
      { class: 'stg-file' },
      h('div', { class: 'stg-file-top' }, h('span', { class: 'stg-file-name', title: f.name }, f.name), f.resumed ? h('span', { class: 'badge accent' }, icon('refresh'), t('storage.dlFileResumed')) : null, h('span', { class: 'stg-file-amount' }, f.total ? t('storage.dlFileProgress', { done: fmtBytes(f.received), total: fmtBytes(f.total) }) : fmtBytes(f.received))),
      h('div', { class: ['progress', pct === null && 'indeterminate'] }, h('i', { style: { width: `${pct || 0}%` } })),
    );
  }

  let lastStatus = null;
  let lastConc = null;
  function drawMeter() {
    // Lo que ya estaba bajando sigue aunque se active el modo sin conexion: se muestra como descarga.
    const status = st.paused ? 'paused' : st.active || st.queued ? 'active' : st.offline ? 'offline' : 'idle';
    if (status !== lastStatus) {
      // Solo cuando cambia: es una region "en vivo" para lectores de pantalla.
      lastStatus = status;
      const statusIcon = { offline: 'stgWifiOff', paused: 'pause', active: 'download', idle: 'check' }[status];
      statusPill.className = `pill stg-status s-${status}`;
      mount(statusPill, icon(statusIcon), t(`storage.dlStatus_${status}`));
    }
    mount(speedBox, bigBytes(st.speed, true));
    const bits = [];
    if (st.active) bits.push(t('storage.dlActive', { count: st.active }));
    if (st.queued) bits.push(t('storage.dlQueued', { count: st.queued }));
    if (st.sessionBytes) bits.push(t('storage.dlSession', { size: fmtBytes(st.sessionBytes) }));
    if (st.resumed) bits.push(t('storage.dlResumed', { count: st.resumed }));
    if (st.peak) bits.push(t('storage.dlPeak', { speed: t('storage.speed', { size: fmtBytes(st.peak) }) }));
    mount(statsLine, bits.map((b) => h('span', {}, b)));
    mount(pauseBtn, icon(st.paused ? 'play' : 'pause'), st.paused ? t('storage.dlResume') : t('storage.dlPause'));
    pauseBtn.title = st.paused ? t('storage.dlResumeHint') : t('storage.dlPauseHint');
    pauseBtn.classList.toggle('primary', st.paused);
    chart.update(st.history, st.maxKBps * 1024);
    meter.classList.toggle('live', status === 'active');
    mount(files, (st.current || []).slice(-4).reverse().map(fileRow));
    files.hidden = !(st.current || []).length;
    pausedNote.hidden = !st.paused;
  }

  function drawControls() {
    if (!pending && document.activeElement !== range) {
      range.value = String(stepIndex(st.maxKBps));
      paintRange();
      limitValue.textContent = fmtKbps(st.maxKBps);
      limitValue.classList.toggle('on', st.maxKBps > 0);
    }
    if (lastConc !== (st.concurrency || 0)) {
      lastConc = st.concurrency || 0;
      drawSeg();
    }
    if (offlineInput.checked !== st.offline) offlineInput.checked = st.offline;
    offlineNote.hidden = !st.offline;
    root.classList.toggle('is-offline', st.offline);
  }

  function apply(next) {
    if (!next) return;
    st = next;
    drawMeter();
    drawControls();
  }

  async function poll() {
    try {
      apply(await api.invoke('downloads:status'));
    } catch (err) {
      if (!st) mount(root, errorBox(err, poll));
    }
  }

  life.add(api.on('downloads:stats', apply));
  poll();
  return life;
}
