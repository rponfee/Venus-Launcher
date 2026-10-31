// Registros: consola en vivo del juego (filtrar por nivel, copiar, limpiar) y archivos de logs/crash reports
// (latest.log, logs viejos .gz y crash-reports) con visor, copiar y mostrar en la carpeta.
import { h, icon, mount, ok, fail, emptyState, skeleton, fmtAgo, fmtBytes, fmtDate } from '../../ui.js';
import { store, api } from '../../store.js';
import { t } from '../../i18n.js';
import { iconButton, runFeature, openFolder } from '../versions/common.js';

const LEVELS = ['all', 'warn', 'error'];
const MAX_LINES = 3000;

function passes(level, l) {
  if (level === 'all') return true;
  if (level === 'warn') return l.level === 'WARN' || l.level === 'ERROR' || l.level === 'FATAL';
  return l.level === 'ERROR' || l.level === 'FATAL';
}

// Colorea las lineas de un archivo de registro segun su nivel (texto plano si es enorme).
function renderLogText(text) {
  const lines = text.split(/\r?\n/);
  if (lines.length > 8000) return text;
  const frag = document.createDocumentFragment();
  for (const line of lines) {
    let level = null;
    if (/\/(ERROR|FATAL)\]|\[(SEVERE|ERROR)\]|^\s*(at |Caused by:)|Exception in thread/.test(line)) level = 'ERROR';
    else if (/\/WARN\]|\[(WARN|WARNING)\]/.test(line)) level = 'WARN';
    frag.append(h('div', level ? { class: `l-${level}` } : {}, line || ' '));
  }
  return frag;
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    ok(t('instance.copied'));
  } catch {
    fail(t('instance.copyFailed'));
  }
}

function liveView(container, ctx, showFiles) {
  let level = 'all';
  let autoscroll = true;
  const box = h('div', { class: 'console ih-console', role: 'log', 'aria-live': 'off', tabindex: 0, 'aria-label': t('instance.logsLive') });
  const lineEl = (l) => h('div', { class: `l-${l.level}` }, l.text);
  const all = () => store.gameLogs[ctx.id] || [];
  // Estado vacio de la consola: esperando al juego, filtro sin lineas o juego cerrado (con acceso a los archivos)
  const emptyEl = () => {
    if (store.running[ctx.id] && !all().length) return h('div', { class: 'ih-console-empty ih-console-wait', role: 'status' }, h('div', { class: 'spinner', 'aria-hidden': 'true' }), t('instance.consoleWaiting'));
    if (all().length) return h('div', { class: 'ih-console-empty' }, emptyState('filter', t('instance.consoleNoLevel'), null));
    return h(
      'div',
      { class: 'ih-console-empty' },
      emptyState('terminal', t('instance.consoleEmptyTitle'), t('instance.consoleEmpty'), h('button', { class: 'btn sm', type: 'button', onclick: showFiles }, icon('fileText'), t('instance.seeLogFiles'))),
    );
  };
  const syncButtons = () => {
    const has = all().length > 0;
    copyBtn.disabled = !has;
    clearBtn.disabled = !has;
  };
  const redraw = () => {
    const lines = all().filter((l) => passes(level, l)).slice(-MAX_LINES);
    mount(box, lines.length ? lines.map(lineEl) : emptyEl());
    box.classList.toggle('is-empty', !lines.length);
    if (autoscroll) box.scrollTop = box.scrollHeight;
    syncButtons();
  };
  const copyBtn = h('button', { class: 'btn sm', type: 'button', onclick: () => copy(all().map((l) => l.text).join('\n')) }, icon('copy'), t('instance.copy'));
  const clearBtn = h('button', { class: 'btn sm ghost', type: 'button', onclick: () => ((store.gameLogs[ctx.id] = []), redraw()) }, icon('trash'), t('instance.clear'));
  box.addEventListener('scroll', () => (autoscroll = box.scrollTop + box.clientHeight >= box.scrollHeight - 30));
  api.instances
    .logs(ctx.id)
    .then((lines) => {
      if (lines?.length && !(store.gameLogs[ctx.id] || []).length) store.gameLogs[ctx.id] = lines;
      redraw();
    })
    .catch(() => redraw());

  const chips = h(
    'div',
    { class: 'chips', role: 'group', 'aria-label': t('instance.logLevel') },
    LEVELS.map((v) =>
      h(
        'button',
        {
          type: 'button',
          class: ['chip', level === v && 'active'],
          'aria-pressed': String(level === v),
          dataset: { level: v },
          onclick: () => {
            level = v;
            chips.querySelectorAll('.chip').forEach((c) => {
              const on = c.dataset.level === v;
              c.classList.toggle('active', on);
              c.setAttribute('aria-pressed', String(on));
            });
            redraw();
          },
        },
        t(`instance.level_${v}`),
      ),
    ),
  );

  mount(
    container,
    h(
      'div',
      { class: 'stack' },
      h(
        'div',
        { class: 'ih-toolbar' },
        chips,
        h('span', { class: 'spacer' }),
        h('div', { class: 'ih-actions-row' }, copyBtn, h('button', { class: 'btn sm', type: 'button', onclick: () => runFeature('crash', 'openCrashTools', ctx.id) }, icon('bug'), t('instance.tool_crash')), clearBtn),
      ),
      box,
    ),
  );
  redraw();
  const off = store.on('game:log', ({ id, lines }) => {
    if (id !== ctx.id) return;
    const fresh = lines.filter((l) => passes(level, l));
    if (box.querySelector('.ih-console-empty')) {
      if (!fresh.length) return redraw();
      mount(box);
      box.classList.remove('is-empty');
    }
    for (const l of fresh) box.append(lineEl(l));
    while (box.childNodes.length > MAX_LINES) box.firstChild.remove();
    if (autoscroll) box.scrollTop = box.scrollHeight;
    syncButtons();
    return undefined;
  });
  const offRun = store.on('running', () => {
    if (box.querySelector('.ih-console-empty')) redraw();
  });
  return () => {
    off();
    offRun();
  };
}

function filesView(container, ctx, initial) {
  let alive = true;
  let files = [];
  let current = null;
  let text = '';
  const listBox = h('div', { class: 'ih-logfiles', role: 'listbox', 'aria-label': t('instance.logFiles') });
  const viewHead = h('div', { class: 'ih-logview-head' });
  const viewer = h('div', { class: 'console ih-logview', tabindex: 0, 'aria-label': t('instance.logFiles') });

  // Flechas arriba/abajo entre archivos (Inicio/Fin al primero y al ultimo)
  listBox.addEventListener('keydown', (e) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const rows = [...listBox.querySelectorAll('.ih-logfile')];
    const i = rows.indexOf(document.activeElement);
    const n = e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
    e.preventDefault();
    if (rows[n] && n !== i) {
      rows[n].focus();
      open(files[n]);
    }
  });

  async function open(f) {
    current = f;
    drawList();
    mount(viewHead, h('div', { class: 'ih-logview-title vs-dots' }, h('strong', { title: f.file }, f.name), h('span', { class: 'small muted num' }, fmtBytes(f.size))));
    mount(viewer, skeleton(10, { label: t('common.loading') }));
    try {
      const r = await api.instances.content(ctx.id, `@log:${f.file}`);
      if (!alive || current !== f) return;
      text = r.text || '';
      mount(
        viewHead,
        h('div', { class: 'ih-logview-title' }, h('strong', { title: f.file }, f.name), h('span', { class: 'small muted num' }, fmtBytes(f.size)), r.truncated ? h('span', { class: 'badge warn' }, t('instance.logTruncated')) : null),
        h(
          'div',
          { class: 'ih-actions-row' },
          iconButton('copy', t('instance.copy'), () => copy(text)),
          iconButton('folderOpen', t('instance.showInFolder'), () => api.app.showItem(`${ctx.inst.dir}/${f.file}`).catch((err) => fail(t('instance.openFailed'), err))),
          f.gz ? null : iconButton('external', t('instance.open'), () => api.app.openPath(`${ctx.inst.dir}/${f.file}`).catch((err) => fail(t('instance.openFailed'), err))),
        ),
      );
      mount(viewer, text ? renderLogText(text) : h('span', { class: 'muted' }, t('instance.logEmpty')));
      viewer.scrollTop = f.crash ? 0 : viewer.scrollHeight;
    } catch (err) {
      if (!alive || current !== f) return;
      mount(viewHead, h('div', { class: 'ih-logview-title' }, h('strong', { title: f.file }, f.name)));
      mount(
        viewer,
        h(
          'div',
          { class: 'notice bad ih-error', role: 'alert' },
          icon('alert'),
          h('div', {}, h('strong', {}, t('instance.logOpenFailed')), h('div', { class: 'small' }, err.message)),
          h('button', { class: 'btn sm', type: 'button', onclick: () => open(f) }, icon('refresh'), t('common.retry')),
        ),
      );
    }
  }

  function drawList() {
    const focusedIndex = [...listBox.children].indexOf(document.activeElement);
    mount(
      listBox,
      files.map((f) =>
        h(
          'button',
          {
            type: 'button',
            role: 'option',
            class: ['ih-logfile', current?.file === f.file && 'active', f.crash && 'crash'],
            'aria-selected': String(current?.file === f.file),
            tabindex: current?.file === f.file ? 0 : -1,
            onclick: () => open(f),
          },
          icon(f.crash ? 'bug' : 'fileText'),
          h('span', { class: 'ih-logfile-main' }, h('span', { class: 'ih-logfile-name ellipsis', title: f.file }, f.name), h('span', { class: 'ih-logfile-sub', title: fmtDate(f.mtime, { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }) }, f.crash ? t('instance.crashReportAgo', { ago: fmtAgo(f.mtime) }) : fmtAgo(f.mtime))),
        ),
      ),
    );
    if (focusedIndex >= 0) listBox.children[focusedIndex]?.focus({ preventScroll: true });
  }

  const load = () => {
    mount(container, h('div', { class: 'ih-logs' }, h('div', { class: 'card flat ih-logs-side' }, skeleton('list', { rows: 4 })), h('div', { class: 'card flat ih-logs-main' }, skeleton(10))));
    api.instances
      .content(ctx.id, 'logs')
      .then((list) => {
        if (!alive) return;
        files = list || [];
        if (!files.length) {
          mount(
            container,
            h('div', { class: 'card flat' }, emptyState('fileText', t('instance.noLogs'), t('instance.noLogsText'), h('button', { class: 'btn sm', type: 'button', onclick: () => openFolder(ctx.inst, 'logs') }, icon('folder'), t('instance.openLogsFolder')))),
          );
          return;
        }
        mount(
          container,
          h(
            'div',
            { class: 'ih-logs' },
            h(
              'div',
              { class: 'card flat ih-logs-side' },
              h('div', { class: 'ih-logs-sidehead' }, h('span', { class: 'small muted num' }, t('instance.logFilesCount', { count: files.length })), iconButton('folder', t('instance.openLogsFolder'), () => openFolder(ctx.inst, 'logs'))),
              listBox,
            ),
            h('div', { class: 'card flat ih-logs-main' }, viewHead, viewer),
          ),
        );
        const first = (initial && files.find((f) => f.file === initial)) || files.find((f) => f.name === 'latest.log') || files[0];
        drawList();
        open(first);
      })
      .catch((err) => {
        if (!alive) return;
        mount(
          container,
          h(
            'div',
            { class: 'notice bad ih-error', role: 'alert' },
            icon('alert'),
            h('div', {}, h('strong', {}, t('instance.loadFailed')), h('div', { class: 'small' }, err.message)),
            h('button', { class: 'btn sm', type: 'button', onclick: load }, icon('refresh'), t('common.retry')),
          ),
        );
      });
  };
  load();
  return () => {
    alive = false;
  };
}

export function logsTab(container, ctx, sub = []) {
  let mode = sub[0] === 'files' ? 'files' : 'live';
  let cleanup = null;
  const view = h('div');
  const seg = h('div', { class: 'segmented', role: 'tablist', 'aria-label': t('instance.tab_logs') });
  const MODES = [
    ['live', 'activity', t('instance.logsLive')],
    ['files', 'fileText', t('instance.logsFiles')],
  ];
  const setMode = (m) => {
    if (mode === m) return;
    mode = m;
    history.replaceState(null, '', `#/${['instance', ctx.id, 'logs', ...(m === 'files' ? ['files'] : [])].map(encodeURIComponent).join('/')}`);
    draw();
  };
  seg.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    setMode(mode === 'live' ? 'files' : 'live');
    seg.querySelector('.active')?.focus();
  });
  const draw = () => {
    mount(
      seg,
      MODES.map(([m, ic, label]) =>
        h(
          'button',
          {
            type: 'button',
            role: 'tab',
            class: mode === m ? 'active' : '',
            'aria-selected': String(mode === m),
            tabindex: mode === m ? 0 : -1,
            onclick: () => setMode(m),
          },
          icon(ic),
          label,
        ),
      ),
    );
    if (cleanup) cleanup();
    cleanup = mode === 'files' ? filesView(view, ctx, sub[1] ? `${sub[1]}${sub[2] ? `/${sub[2]}` : ''}` : null) : liveView(view, ctx, () => setMode('files'));
  };
  mount(container, h('div', { class: 'stack' }, h('div', { class: 'ih-subbar' }, seg), view));
  draw();
  return () => {
    if (cleanup) cleanup();
  };
}
