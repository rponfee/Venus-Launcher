// Traducción automática de mods: detecta los mods que no tienen textos en el idioma elegido, los traduce
// con IA (queda marcado como traducción automática), deja corregir cada texto (queda "revisado") y
// compartir el resultado con la comunidad. Contrato: openModTranslate(instanceId).
import { h, icon, mount, modal, toast, ok, fail, confirmDialog, ensureCss, fmtNumber, fmtAgo, debounce, emptyState } from '../ui.js';
import { store, api } from '../store.js';
import { t, loadNs, locale as uiLocale } from '../i18n.js';
import { navigate } from '../app.js';

const NS = 'modtranslate';
const T = (k, v) => t(`${NS}.${k}`, v);
const PAGE = 40;
const TABS = ['mods', 'review', 'share'];
let dialogSeq = 0;
const SAVE_DELAY = 900;
const EXTRA_NAMES = { en_us: 'English (US)', en_gb: 'English (UK)', es_ec: 'Español (Ecuador)', zh_hk: '繁體中文 (香港)' };

let current = null; // diálogo abierto (uno a la vez)

async function ready() {
  ensureCss('features/modtranslate');
  try {
    await loadNs(NS);
  } catch {
    /* sin textos se ven las claves, pero no se rompe nada */
  }
}

const isMissingChannel = (err) => /No handler registered/i.test(err?.message || '');
const nf = () => new Intl.NumberFormat(uiLocale());
const num = (n) => nf().format(Number(n) || 0);
// Textos con plural: {count} elige la forma y {n} muestra el número con separadores del idioma.
const TC = (k, count, v = {}) => T(k, { ...v, count: Number(count) || 0, n: num(count) });

// ---------- Marcadores (misma regla que el proceso principal, para avisar mientras se escribe) ----------
const PH = [
  ['keybind', /%[a-z_]+(?:\.[a-z0-9_]+)+%/g],
  ['printf', /%(?:(\d+)\$)?[-#+0,(]*\d*(?:\.\d+)?([bBhHsScCdoxXeEfgGaAn%])/g],
  ['section', /§[0-9a-fk-orA-FK-ORxX]/g],
  ['amp', /(?<![A-Za-z0-9&])&[0-9a-fk-or](?=[A-Za-z0-9 [(])/g],
  ['brace', /\{[A-Za-z0-9_.:-]*\}/g],
  ['macro', /\$\([^()\s]*\)/g],
  ['tag', /<\/?[A-Za-z][\w:.-]*(?:\s[^<>]*)?\/?>/g],
  ['newline', /\r?\n|\\n/g],
];

function tokens(text) {
  const s = String(text ?? '');
  const taken = new Uint8Array(s.length);
  const out = [];
  for (const [kind, re] of PH) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(s))) {
      if (!m[0]) {
        re.lastIndex++;
        continue;
      }
      let busy = false;
      for (let i = m.index; i < m.index + m[0].length; i++) if (taken[i]) busy = true;
      if (busy) continue;
      for (let i = m.index; i < m.index + m[0].length; i++) taken[i] = 1;
      let token = m[0];
      if (kind === 'newline') token = '\\n';
      else if (kind === 'tag') {
        const tm = /^<(\/?)([A-Za-z][\w:.-]*)/.exec(token);
        token = tm ? `<${tm[1]}${tm[2].toLowerCase()}${/\/>$/.test(m[0]) ? '/' : ''}>` : token;
      } else if (kind === 'section' || kind === 'amp') token = token.toLowerCase();
      out.push({ kind, token, raw: m[0], index: m.index, positional: kind === 'printf' && Boolean(m[1]) });
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

function checkText(source, text) {
  if (String(source).trim() && !String(text).trim()) return { ok: false, reason: 'empty', missing: [], extra: [] };
  const a = tokens(source);
  const b = tokens(text);
  const count = (list) => list.reduce((m, p) => m.set(p.token, (m.get(p.token) || 0) + 1), new Map());
  const ca = count(a);
  const cb = count(b);
  const missing = [];
  const extra = [];
  for (const [k, n] of ca) for (let i = cb.get(k) || 0; i < n; i++) missing.push(k);
  for (const [k, n] of cb) for (let i = ca.get(k) || 0; i < n; i++) extra.push(k);
  if (missing.length || extra.length) return { ok: false, reason: 'placeholders', missing, extra };
  const seq = (list) => list.filter((p) => p.kind === 'printf' && !p.positional && p.token !== '%%').map((p) => p.token).join('\u0000');
  if (seq(a) !== seq(b)) return { ok: false, reason: 'order', missing: [], extra: [] };
  return { ok: true };
}

// Texto original con los marcadores resaltados (sin innerHTML: los textos vienen de mods de terceros).
function sourceNodes(text) {
  const s = String(text ?? '');
  const out = [];
  let last = 0;
  for (const p of tokens(s)) {
    if (p.index > last) out.push(s.slice(last, p.index));
    if (p.kind === 'newline') out.push(h('span', { class: 'mtr-ph nl', title: T('tokenNewline') }, '↵'), h('br'));
    else out.push(h('span', { class: 'mtr-ph', title: T('tokenKeep') }, p.raw));
    last = p.index + p.raw.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

function problemText(res) {
  if (!res || res.ok) return '';
  if (res.reason === 'empty') return T('invalidEmpty');
  if (res.reason === 'order') return T('invalidOrder');
  if (res.reason === 'unknown') return T('invalidUnknown');
  const parts = [];
  if (res.missing?.length) parts.push(T('invalidMissing', { list: [...new Set(res.missing)].join('  ') }));
  if (res.extra?.length) parts.push(T('invalidExtra', { list: [...new Set(res.extra)].join('  ') }));
  return parts.join(' · ') || T('invalidGeneric');
}

// ---------- Utilidades de la interfaz ----------

function localeName(scan, code) {
  if (!code) return '';
  const hit = scan?.locales?.find((l) => l.code === code);
  return hit?.name || EXTRA_NAMES[code.toLowerCase()] || code;
}

function modIcon(mod) {
  const box = h('div', { class: 'mtr-mod-icon', 'aria-hidden': 'true' });
  if (typeof mod.icon === 'string' && mod.icon.startsWith('data:image/png;base64,')) {
    const img = h('img', { src: mod.icon, alt: '' });
    img.addEventListener('error', () => mount(box, (mod.name || '?').trim().charAt(0).toUpperCase()), { once: true });
    box.append(img);
  } else box.append((mod.name || '?').trim().charAt(0).toUpperCase());
  return box;
}

function coverageBar(mod) {
  const total = mod.total || 0;
  const pct = (n) => (total ? `${(n / total) * 100}%` : '0%');
  return h(
    'div',
    { class: 'mtr-bar', role: 'img', 'aria-label': T('coverageAria', { native: num(mod.native), ours: num(mod.ours), missing: num(mod.missing) }) },
    h('i', { class: 'nat', style: { width: pct(mod.native) } }),
    h('i', { class: 'ours', style: { width: pct(mod.ours) } }),
  );
}

function coveragePct(mod) {
  return mod.total ? Math.floor(((mod.native + mod.ours) / mod.total) * 100) : 0;
}

function statusBadge(mod) {
  if (mod.broken) return h('span', { class: 'badge bad' }, T('statusBroken'));
  switch (mod.status) {
    case 'complete':
      return h('span', { class: 'badge good' }, icon('check'), T('statusComplete'));
    case 'auto':
      return h('span', { class: 'badge accent' }, icon('sparkles'), T('statusAuto'));
    case 'partial':
      return h('span', { class: 'badge warn' }, T('statusPartial'));
    case 'none':
      return h('span', { class: 'badge bad' }, T('statusNone'));
    default:
      return h('span', { class: 'badge' }, T('statusEmpty'));
  }
}

const needsWork = (m) => !m.broken && m.total > 0 && m.missing > 0;

// ---------- Diálogo ----------

export async function openModTranslate(instanceId) {
  await ready();
  if (current) {
    if (current.instanceId === instanceId) return;
    current.close();
  }
  const inst = store.instances.find((i) => i.id === instanceId) || (await api.instances.get(instanceId).catch(() => null));
  const S = {
    instanceId,
    inst,
    locale: null,
    scan: null,
    scanning: false,
    scanProgress: null,
    error: null,
    tab: 'mods',
    modFilter: 'needs',
    query: '',
    selected: new Set(),
    touched: false,
    setLanguage: true,
    job: null,
    result: null,
    closed: false,
    share: null,
    ed: { mod: '', filter: 'all', query: '', offset: 0, data: null, loading: false, error: null, pending: new Map(), invalid: new Map(), saving: false, saved: 0, lastSaveAt: 0 },
  };

  const uid = `mtr-${++dialogSeq}`;
  const headEl = h('div', { class: 'mtr-head' });
  const panelEl = h('div', { class: 'mtr-panel', role: 'tabpanel', id: `${uid}-panel`, tabindex: '-1' });
  const footEl = h('div', { class: 'mtr-foot' });
  const body = h('div', { class: 'mtr-body' }, headEl, panelEl);

  const offs = [];
  const m = modal({
    title: T('title'),
    subtitle: inst?.name || null,
    icon: 'languages',
    size: 'xwide mtr-modal',
    body,
    footer: [footEl],
    onClose: () => {
      S.closed = true;
      offs.forEach((f) => f());
      document.removeEventListener('mousedown', closeMenuOutside, true);
      flushEdits(true);
      if (current?.S === S) current = null;
    },
  });
  current = { instanceId, S, close: m.close };

  // ---------- Eventos del proceso principal ----------
  try {
    offs.push(
      api.on('modtranslate:progress', (id, job) => {
        if (id !== instanceId || S.closed || !job) return;
        if (job.state === 'running') {
          S.job = job;
          if (S.tab === 'mods') drawRun();
        }
      }),
    );
    offs.push(
      api.on('modtranslate:scanProgress', (id, p) => {
        if (id !== instanceId || S.closed || !S.scanning) return;
        S.scanProgress = p;
        const label = panelEl.querySelector('.mtr-scan-progress');
        if (label && p?.total) label.textContent = T('scanningCount', { done: num(Math.min(p.done + 1, p.total)), total: num(p.total) });
        const bar = panelEl.querySelector('.mtr-scan-bar');
        if (bar && p?.total) {
          bar.classList.remove('indeterminate');
          bar.firstElementChild.style.width = `${Math.round((Math.min(p.done + 1, p.total) / p.total) * 100)}%`;
        }
      }),
    );
  } catch (err) {
    console.warn('[modtranslate]', err);
  }

  // ---------- Escaneo ----------
  async function scan({ locale, quiet = false } = {}) {
    S.scanning = true;
    S.error = null;
    S.scanProgress = null;
    if (!quiet || !S.scan) drawAll();
    try {
      const res = await api.invoke('modtranslate:scan', instanceId, locale ? { locale } : {});
      if (S.closed) return;
      S.scan = res;
      S.locale = res.locale;
      if (res.job && res.job.state === 'running') S.job = res.job;
      // Selección: lo que necesita traducción (salvo que el jugador ya haya elegido)
      const ids = new Set(res.mods.map((m) => m.id));
      if (!S.touched) S.selected = new Set(res.mods.filter((m) => needsWork(m) && m.enabled).map((m) => m.id));
      else S.selected = new Set([...S.selected].filter((id) => ids.has(id)));
      if (S.modFilter === 'needs' && !res.mods.some(needsWork)) S.modFilter = 'all';
    } catch (err) {
      if (S.closed) return;
      S.error = isMissingChannel(err) ? T('errNotReady') : err.message;
    } finally {
      S.scanning = false;
    }
    if (quiet && S.tab === 'review') {
      drawHead();
      drawFoot();
    } else drawAll();
    if (S.job && !S.result) watchJob();
  }

  // Si se reabre el diálogo con una traducción en curso, se sigue su avance.
  let watching = false;
  async function watchJob() {
    if (watching) return;
    watching = true;
    try {
      while (!S.closed) {
        await new Promise((r) => setTimeout(r, 1500));
        const st = await api.invoke('modtranslate:status', instanceId).catch(() => null);
        if (S.closed) return;
        if (!st) {
          if (S.job && !S.result) {
            S.job = null;
            await scan({ quiet: true });
          }
          return;
        }
        S.job = st;
        if (S.tab === 'mods') drawRun();
      }
    } finally {
      watching = false;
    }
  }

  // ---------- Dibujo general ----------
  function drawAll() {
    drawHead();
    drawPanel();
    drawFoot();
  }

  function tabBtn(id, iconName, label, count) {
    return h(
      'button',
      {
        class: ['tab', S.tab === id && 'active'],
        type: 'button',
        role: 'tab',
        id: `${uid}-tab-${id}`,
        'aria-selected': S.tab === id ? 'true' : 'false',
        'aria-controls': `${uid}-panel`,
        tabindex: S.tab === id ? '0' : '-1',
        onclick: () => switchTab(id),
      },
      icon(iconName),
      label,
      count ? h('span', { class: 'count' }, num(count)) : null,
    );
  }

  // Pestañas con teclado: flechas, Inicio y Fin (la pestaña elegida es la única con Tab)
  function onTabKey(e) {
    const i = TABS.indexOf(S.tab);
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: TABS.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    switchTab(TABS[(next + TABS.length) % TABS.length]);
    headEl.querySelector(`#${uid}-tab-${S.tab}`)?.focus();
  }

  function switchTab(id) {
    if (S.tab === id) return;
    if (S.tab === 'review') {
      flushEdits().then(() => {
        if (S.staleScan && !S.closed) {
          S.staleScan = false;
          scan({ locale: S.locale, quiet: true });
        }
      });
    }
    S.tab = id;
    if (id === 'review') {
      S.ed.offset = 0;
      loadEntries();
    }
    drawAll();
  }

  function drawHead() {
    const sc = S.scan;
    const tabs = h(
      'div',
      { class: 'tabs mtr-tabs', role: 'tablist', 'aria-label': T('tabsLabel'), onkeydown: onTabKey },
      tabBtn('mods', 'puzzle', T('tabMods'), sc?.totals ? sc.mods.filter(needsWork).length : 0),
      tabBtn('review', 'edit', T('tabReview'), sc?.totals?.ours || 0),
      tabBtn('share', 'share', T('tabShare')),
    );
    panelEl.setAttribute('aria-labelledby', `${uid}-tab-${S.tab}`);
    const select = h('select', { class: 'select mtr-locale', 'aria-label': T('localeLabel'), title: T('localeHint'), disabled: !sc || S.scanning || isRunning() });
    if (sc?.locales?.length) {
      const sug = sc.locales.filter((l) => l.suggested);
      const rest = sc.locales.filter((l) => !l.suggested);
      const done = new Set((sc.produced || []).map((p) => p.locale));
      const opt = (l) => h('option', { value: l.code, selected: l.code === S.locale }, done.has(l.code) ? T('localeOptionDone', { name: l.name, code: l.code }) : `${l.name} · ${l.code}`);
      if (sug.length) select.append(h('optgroup', { label: T('localeSuggested') }, sug.map(opt)), h('optgroup', { label: T('localeOthers') }, rest.map(opt)));
      else rest.forEach((l) => select.append(opt(l)));
    } else select.append(h('option', {}, T('loadingShort')));
    select.addEventListener('change', async () => {
      await flushEdits();
      S.locale = select.value;
      S.result = null;
      S.share = null;
      S.ed = { ...S.ed, data: null, offset: 0, pending: new Map(), invalid: new Map() };
      await scan({ locale: select.value });
      if (S.tab === 'review') loadEntries();
    });
    let pill = null;
    if (sc?.pack?.exists) {
      pill = sc.pack.enabled
        ? h('span', { class: 'pill good mtr-pill', title: T('packOnHint') }, icon('check'), T('packOn'))
        : h('span', { class: 'pill warn mtr-pill', title: T('packOffHint') }, icon('alert'), T('packOff'));
    }
    const moreBtn = h(
      'button',
      { class: 'icon-btn sm mtr-more', type: 'button', title: T('moreActions'), 'aria-label': T('moreActions'), 'aria-haspopup': 'menu', 'aria-expanded': 'false', disabled: !sc || !sc.supported, onclick: (e) => toggleMenu(e.currentTarget) },
      icon('more'),
    );
    mount(headEl, tabs, h('div', { class: 'mtr-spacer' }), h('label', { class: 'mtr-locale-wrap' }, icon('languages'), select), pill, moreBtn);
  }

  // ---------- Menú de acciones ----------
  let menuEl = null;
  function closeMenu() {
    if (!menuEl) return;
    menuEl.remove();
    menuEl = null;
    headEl.querySelector('.mtr-more')?.setAttribute('aria-expanded', 'false');
    document.removeEventListener('mousedown', closeMenuOutside, true);
  }
  function closeMenuOutside(e) {
    if (menuEl && !menuEl.contains(e.target) && !e.target.closest?.('.mtr-more')) closeMenu();
  }
  function toggleMenu(anchor) {
    if (menuEl) return closeMenu();
    const sc = S.scan;
    if (!sc) return undefined;
    const item = (iconName, label, fn, opts = {}) =>
      h(
        'button',
        {
          class: ['mtr-menu-item', opts.danger && 'danger'],
          type: 'button',
          role: 'menuitem',
          disabled: opts.disabled,
          onclick: () => {
            closeMenu();
            fn();
          },
        },
        icon(iconName),
        h('span', {}, label),
      );
    const langName = localeName(sc, S.locale);
    menuEl = h(
      'div',
      { class: 'mtr-menu', role: 'menu' },
      item('folderOpen', T('menuOpenFolder'), openFolder),
      sc.pack?.exists ? item(sc.pack.enabled ? 'eyeOff' : 'eye', sc.pack.enabled ? T('menuDisable') : T('menuEnable'), () => setEnabled(!sc.pack.enabled)) : null,
      item('globe', T('menuGameLanguage', { name: langName }), setGameLanguage, { disabled: sc.gameLanguage === S.locale }),
      item('refresh', T('menuRescan'), () => scan({ locale: S.locale })),
      h('div', { class: 'mtr-menu-sep' }),
      item('trash', T('menuClear', { name: langName }), clearAll, { danger: true, disabled: !(sc.totals?.ours > 0) || isRunning() }),
    );
    menuEl.addEventListener('keydown', (e) => {
      const items = [...menuEl.querySelectorAll('.mtr-menu-item:not(:disabled)')];
      const i = items.indexOf(document.activeElement);
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeMenu();
        anchor.focus();
      } else if (e.key === 'Tab') {
        // Tab sale del menú: se cierra y el foco sigue su camino desde el botón
        closeMenu();
        anchor.focus();
      } else if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        (e.key === 'Home' ? items[0] : items[items.length - 1])?.focus();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        items[(i + 1) % items.length]?.focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        items[(i - 1 + items.length) % items.length]?.focus();
      }
    });
    headEl.append(menuEl);
    anchor.setAttribute('aria-expanded', 'true');
    document.addEventListener('mousedown', closeMenuOutside, true);
    menuEl.querySelector('.mtr-menu-item:not(:disabled)')?.focus();
    return undefined;
  }

  async function openFolder() {
    try {
      await api.invoke('modtranslate:openPack', instanceId);
    } catch (err) {
      fail(T('openFolderFailed'), err);
    }
  }

  async function setEnabled(on) {
    try {
      const r = await api.invoke('modtranslate:setEnabled', instanceId, on);
      ok(on ? T('enabledToast') : T('disabledToast'), r?.gameRunning ? T('restartHint') : null);
    } catch (err) {
      fail(T('actionFailed'), err);
    }
    scan({ locale: S.locale, quiet: true });
  }

  async function setGameLanguage() {
    try {
      const r = await api.invoke('modtranslate:setGameLanguage', instanceId, S.locale);
      ok(T('gameLanguageToast', { name: localeName(S.scan, S.locale) }), r?.gameRunning ? T('restartHint') : null);
    } catch (err) {
      fail(T('actionFailed'), err);
    }
    scan({ locale: S.locale, quiet: true });
  }

  async function clearAll() {
    const sc = S.scan;
    const yes = await confirmDialog(T('clearTitle'), TC('clearText', sc?.totals?.ours || 0, { name: localeName(sc, S.locale) }), { okText: T('clearOk'), cancelText: T('cancel'), danger: true });
    if (!yes) return;
    try {
      const r = await api.invoke('modtranslate:clear', instanceId, { locale: S.locale });
      ok(TC('clearedToast', r?.removed || 0), r?.packRemoved ? T('clearedPackRemoved') : null);
    } catch (err) {
      fail(T('actionFailed'), err);
    }
    S.result = null;
    S.ed = { ...S.ed, data: null, offset: 0, pending: new Map(), invalid: new Map() };
    await scan({ locale: S.locale, quiet: true });
    if (S.tab === 'review') loadEntries();
  }

  // ---------- Avisos (aviso honesto sobre la calidad + IA sin configurar) ----------
  function notices() {
    const sc = S.scan;
    const list = [];
    if (sc?.supported) {
      list.push(h('div', { class: 'notice info mtr-notice' }, icon('info'), h('div', {}, h('strong', {}, T('honestTitle')), ' ', T('honestText'))));
      if (!sc.ai?.available) {
        list.push(
          h(
            'div',
            { class: 'notice mtr-notice' },
            icon('sparkles'),
            h('div', { class: 'mtr-notice-text' }, T('aiMissing')),
            h(
              'button',
              {
                class: 'btn sm',
                type: 'button',
                onclick: () => {
                  m.close();
                  navigate('settings/ai');
                },
              },
              icon('settings'),
              T('aiConfigure'),
            ),
          ),
        );
      }
    }
    return list.length ? h('div', { class: 'mtr-notices' }, list) : null;
  }

  // ---------- Panel ----------
  function drawPanel() {
    if (S.tab === 'review') return drawReview();
    if (S.tab === 'share') return drawShare();
    return drawMods();
  }

  // Revisando los mods: cuánto falta (barra determinada en cuanto se sabe el total) y una vista previa de la lista.
  function scanningView() {
    const p = S.scanProgress;
    const pct = p?.total ? Math.round((Math.min(p.done + 1, p.total) / p.total) * 100) : null;
    const bone = (cls, style) => h('span', { class: `skeleton ${cls}`, style });
    const row = () => h('div', { class: 'skeleton-row' }, bone('skeleton-icon'), h('div', { class: 'skeleton-lines' }, bone('skeleton-line'), bone('skeleton-line')));
    return [
      h(
        'div',
        { class: 'mtr-loading', role: 'status', 'aria-live': 'polite' },
        h('div', { class: 'mtr-run-icon', 'aria-hidden': 'true' }, icon('languages')),
        h('div', { class: 'mtr-loading-title' }, T('scanningTitle')),
        h('div', { class: 'mtr-scan-progress muted small' }, p?.total ? T('scanningCount', { done: num(Math.min(p.done + 1, p.total)), total: num(p.total) }) : T('scanningText')),
        h('div', { class: ['progress', 'mtr-scan-bar', pct === null && 'indeterminate'], 'aria-hidden': 'true' }, h('i', { style: { width: `${pct || 0}%` } })),
      ),
      h('div', { class: 'skeleton-shapes mtr-skel', 'aria-hidden': 'true' }, h('div', { class: 'skeleton-list' }, row(), row(), row())),
    ];
  }

  function errorView(text, retry) {
    return emptyState('alert', T('errorTitle'), text, retry ? h('button', { class: 'btn', type: 'button', onclick: retry }, icon('refresh'), T('retry')) : null);
  }

  const isRunning = () => Boolean(S.job && S.job.state === 'running');

  function drawMods() {
    const sc = S.scan;
    if (isRunning() || S.result) return S.result ? drawResult() : drawRun();
    if (!sc) return mount(panelEl, S.error ? errorView(S.error, () => scan({ locale: S.locale })) : scanningView());
    if (!sc.supported) return mount(panelEl, emptyState('languages', T('unsupportedTitle'), T('unsupportedText', { version: sc.instance?.mcVersion || '?' })));
    if (S.scanning && !sc.mods.length) return mount(panelEl, scanningView());
    if (!sc.mods.length) {
      const browse = h(
        'button',
        {
          class: 'btn primary',
          type: 'button',
          onclick: () => {
            m.close();
            navigate(`modrinth/${encodeURIComponent(instanceId)}/mod`);
          },
        },
        icon('search'),
        T('browseMods'),
      );
      return mount(panelEl, emptyState('puzzle', T('noModsTitle'), T('noModsText'), browse));
    }
    if (!sc.totals?.withText) return mount(panelEl, emptyState('fileText', T('noTextTitle'), T('noTextText')));

    const tot = sc.totals;
    const natPct = tot.total ? Math.round((tot.native / tot.total) * 100) : 0;
    const kpi = (iconName, label, value, foot, cls) => h('div', { class: ['mtr-kpi', cls] }, h('div', { class: 'mtr-kpi-label' }, icon(iconName), label), h('div', { class: 'mtr-kpi-value' }, value), h('div', { class: 'mtr-kpi-foot' }, foot));
    const kpis = h(
      'div',
      { class: 'mtr-kpis' },
      kpi('puzzle', T('kpiMods'), num(tot.withText), TC('kpiModsFoot', tot.mods)),
      kpi('check', T('kpiNative'), `${natPct}%`, TC('kpiNativeFoot', tot.native)),
      kpi('sparkles', T('kpiOurs'), num(tot.ours), TC('kpiOursFoot', tot.reviewed), 'ours'),
      kpi('alert', T('kpiMissing'), num(tot.missing), tot.identical ? TC('kpiMissingIdentical', tot.identical) : T('kpiMissingFoot'), tot.missing ? 'missing' : ''),
    );

    const mods = sc.mods;
    const needs = mods.filter(needsWork);
    const q = S.query.trim().toLowerCase();
    const shown = (S.modFilter === 'needs' ? needs : mods).filter((m) => !q || `${m.name} ${m.file} ${m.modId || ''} ${m.includes.join(' ')}`.toLowerCase().includes(q));

    const search = h('input', { class: 'input', type: 'search', placeholder: T('searchMods'), value: S.query, 'aria-label': T('searchMods') });
    search.addEventListener(
      'input',
      debounce(() => {
        S.query = search.value;
        drawList();
      }, 160),
    );
    const chip = (id, label, count) =>
      h(
        'button',
        {
          class: ['chip', S.modFilter === id && 'active'],
          type: 'button',
          'aria-pressed': S.modFilter === id ? 'true' : 'false',
          onclick: () => {
            S.modFilter = id;
            drawMods();
          },
        },
        label,
        h('span', { class: 'mtr-chip-count' }, num(count)),
      );
    const selectable = shown.filter(needsWork);
    const toolbar = h(
      'div',
      { class: 'mtr-toolbar sticky' },
      h('div', { class: 'chips' }, chip('needs', T('filterNeeds'), needs.length), chip('all', T('filterAll'), mods.length)),
      h('div', { class: 'input-icon mtr-search' }, icon('search'), search),
      h(
        'button',
        {
          class: 'btn sm ghost',
          type: 'button',
          disabled: !selectable.length,
          onclick: () => {
            S.touched = true;
            const allOn = selectable.every((m) => S.selected.has(m.id));
            for (const m of selectable) allOn ? S.selected.delete(m.id) : S.selected.add(m.id);
            drawMods();
            drawFoot();
          },
        },
        icon('check'),
        selectable.length && selectable.every((m) => S.selected.has(m.id)) ? T('selectNone') : T('selectAll'),
      ),
    );

    const listEl = h('div', { class: 'mtr-list', role: 'list', 'aria-label': T('modsListLabel') });
    const drawList = () => {
      const qq = S.query.trim().toLowerCase();
      const items = (S.modFilter === 'needs' ? needs : mods).filter((m) => !qq || `${m.name} ${m.file} ${m.modId || ''} ${m.includes.join(' ')}`.toLowerCase().includes(qq));
      if (!items.length) {
        mount(listEl, h('div', { class: 'mtr-list-empty' }, S.modFilter === 'needs' && !qq ? emptyState('check', T('allDoneTitle'), T('allDoneText'), h('button', { class: 'btn sm', type: 'button', onclick: () => ((S.modFilter = 'all'), drawMods()) }, T('showAll'))) : emptyState('search', T('noMatchTitle'), T('noMatchText'))));
        return;
      }
      mount(listEl, items.map(modRow));
    };
    const modRow = (mod) => {
      const can = needsWork(mod);
      const cb = h('input', { type: 'checkbox', checked: can && S.selected.has(mod.id), disabled: !can, 'aria-label': T('selectMod', { name: mod.name }) });
      cb.addEventListener('change', () => {
        S.touched = true;
        if (cb.checked) S.selected.add(mod.id);
        else S.selected.delete(mod.id);
        row.classList.toggle('on', cb.checked);
        drawFoot();
      });
      const sub = [mod.version ? `v${mod.version}` : null, mod.file].filter(Boolean).join(' · ');
      const pct = coveragePct(mod);
      const row = h(
        'label',
        { class: ['mtr-mod', can && S.selected.has(mod.id) && 'on', !can && 'off', !mod.enabled && 'disabled'], role: 'listitem', title: mod.file },
        h('span', { class: 'mtr-check' }, cb),
        modIcon(mod),
        h(
          'div',
          { class: 'mtr-mod-main' },
          h('div', { class: 'mtr-mod-name' }, h('span', { class: 'ellipsis' }, mod.name), !mod.enabled ? h('span', { class: 'badge mtr-tiny-badge' }, T('modDisabled')) : null),
          h('div', { class: 'mtr-mod-sub ellipsis' }, sub),
          mod.includes?.length ? h('div', { class: 'mtr-mod-inc ellipsis', title: mod.includes.join(', ') }, T('includes', { list: mod.includes.length > 3 ? `${mod.includes.slice(0, 3).join(', ')} +${mod.includes.length - 3}` : mod.includes.join(', ') })) : null,
        ),
        mod.total
          ? h(
              'div',
              { class: 'mtr-cov' },
              coverageBar(mod),
              h('div', { class: 'mtr-cov-label' }, h('strong', {}, `${pct}%`), ' ', mod.missing ? TC('missingCount', mod.missing) : T('missingNone')),
            )
          : h('div', { class: 'mtr-cov muted small' }, mod.broken ? T('brokenText') : T('emptyText')),
        h('div', { class: 'mtr-mod-status' }, statusBadge(mod)),
      );
      return row;
    };
    drawList();

    const extra = [];
    if (sc.packsCovering?.length) extra.push(h('div', { class: 'mtr-hint small muted' }, icon('layers'), TC('packsCovering', sc.packsCovering.length, { list: sc.packsCovering.map((p) => p.name).join(', ') })));
    const langWarn = sc.pack?.exists && (sc.gameLanguage || 'en_us') !== S.locale;
    if (langWarn) {
      extra.push(
        h(
          'div',
          { class: 'mtr-hint small' },
          icon('globe'),
          h('span', {}, T('gameLanguageWarn', { current: localeName(sc, sc.gameLanguage || 'en_us'), name: localeName(sc, S.locale) })),
          h('button', { class: 'btn sm ghost', type: 'button', onclick: setGameLanguage }, T('gameLanguageFix')),
        ),
      );
    }
    if (sc.gameRunning) extra.push(h('div', { class: 'mtr-hint small' }, icon('play'), h('span', {}, T('gameRunningHint'))));
    const others = (sc.produced || []).filter((p) => p.locale !== S.locale).slice(0, 3);
    if (others.length) {
      extra.push(
        h(
          'div',
          { class: 'mtr-hint small inline' },
          icon('languages'),
          h('span', {}, T('otherLocales')),
          others.map((p) =>
            h(
              'button',
              {
                class: 'btn sm ghost',
                type: 'button',
                title: TC('otherLocaleHint', p.entries, { name: localeName(sc, p.locale) }),
                onclick: async () => {
                  await flushEdits();
                  S.result = null;
                  S.share = null;
                  S.ed = { ...S.ed, data: null, offset: 0, pending: new Map(), invalid: new Map() };
                  await scan({ locale: p.locale });
                },
              },
              localeName(sc, p.locale),
            ),
          ),
        ),
      );
    }
    mount(panelEl, notices(), kpis, extra.length ? h('div', { class: 'mtr-hints' }, extra) : null, toolbar, listEl);
  }

  // ---------- Traducción en curso ----------
  function drawRun() {
    const job = S.job || { done: 0, total: 0 };
    const pct = job.total ? Math.round((job.done / job.total) * 100) : null;
    const stat = (cls, label, value) => h('div', { class: ['mtr-stat', cls] }, h('div', { class: 'mtr-stat-value' }, num(value)), h('div', { class: 'mtr-stat-label' }, label));
    mount(
      panelEl,
      h(
        'div',
        { class: 'mtr-run', 'aria-live': 'polite' },
        h('div', { class: 'mtr-run-icon' }, icon('languages')),
        h('div', { class: 'mtr-run-title' }, job.phase === 'prepare' || !job.total ? T('runPreparing') : T('runTitle', { name: localeName(S.scan, job.locale || S.locale) })),
        h('div', { class: ['progress', 'mtr-run-bar', pct === null && 'indeterminate'] }, h('i', { style: { width: `${pct || 0}%` } })),
        h('div', { class: 'mtr-run-meta' }, job.total ? T('runCount', { done: num(job.done), total: num(job.total) }) : T('runCounting'), pct !== null ? h('strong', {}, `${pct}%`) : null),
        job.current ? h('div', { class: 'mtr-run-current ellipsis' }, T('runCurrent', { name: job.current })) : null,
        h('div', { class: 'mtr-stats' }, stat('ai', T('statAi'), job.translated || 0), stat('reuse', T('statReuse'), (job.copied || 0) + (job.cached || 0)), stat('failed', T('statFailed'), job.failed || 0)),
        h('div', { class: 'mtr-run-hint small muted' }, icon('info'), T('runBackground')),
      ),
    );
    drawFoot();
  }

  function drawResult() {
    const r = S.result;
    const done = r.status === 'done';
    const cancelled = r.status === 'cancelled';
    const total = (r.translated || 0) + (r.copied || 0) + (r.cached || 0);
    const notes = [];
    if (r.status === 'error' && r.error) notes.push(h('div', { class: 'notice bad' }, icon('alert'), h('div', {}, r.error)));
    if (r.failed) notes.push(h('div', { class: 'notice' }, icon('alert'), h('div', {}, TC('resultFailed', r.failed))));
    if (r.skipped) notes.push(h('div', { class: 'notice' }, icon('sparkles'), h('div', {}, TC('resultSkipped', r.skipped))));
    if (total && r.gameRunning) notes.push(h('div', { class: 'notice info' }, icon('play'), h('div', {}, T('resultGameRunning'))));
    if (total && !r.gameRunning) notes.push(h('div', { class: 'notice good' }, icon('check'), h('div', {}, r.setLanguage ? T('resultReadyLang', { name: localeName(S.scan, r.locale) }) : T('resultReady'))));
    const stat = (cls, label, value) => h('div', { class: ['mtr-stat', cls] }, h('div', { class: 'mtr-stat-value' }, num(value)), h('div', { class: 'mtr-stat-label' }, label));
    mount(
      panelEl,
      h(
        'div',
        { class: 'mtr-run mtr-result' },
        h('div', { class: ['mtr-run-icon', done ? 'good' : cancelled ? '' : 'bad'] }, icon(done ? 'check' : cancelled ? 'stop' : 'alert')),
        h('div', { class: 'mtr-run-title' }, done ? T('resultTitle') : cancelled ? T('resultCancelled') : T('resultError')),
        h('div', { class: 'mtr-run-meta' }, TC('resultText', total)),
        h('div', { class: 'mtr-stats' }, stat('ai', T('statAi'), r.translated || 0), stat('reuse', T('statReuse'), (r.copied || 0) + (r.cached || 0)), stat('failed', T('statFailed'), r.failed || 0)),
        h('div', { class: 'mtr-result-notes' }, notes),
        h(
          'div',
          { class: 'row mtr-result-actions' },
          total || r.failed
            ? h(
                'button',
                {
                  class: 'btn primary',
                  type: 'button',
                  onclick: () => {
                    S.result = null;
                    S.ed.filter = r.failed && !total ? 'problems' : 'auto';
                    switchTab('review');
                  },
                },
                icon('edit'),
                T('resultReview'),
              )
            : null,
          h(
            'button',
            {
              class: 'btn',
              type: 'button',
              onclick: () => {
                S.result = null;
                drawAll();
              },
            },
            icon('arrowLeft'),
            T('resultBack'),
          ),
        ),
      ),
    );
    drawFoot();
  }

  async function startRun() {
    const sc = S.scan;
    if (!sc || isRunning()) return;
    const mods = sc.mods.filter((m) => S.selected.has(m.id) && needsWork(m)).map((m) => m.id);
    if (!mods.length) return;
    const setLanguage = S.setLanguage && (sc.gameLanguage || 'en_us') !== S.locale;
    S.result = null;
    S.job = { state: 'running', phase: 'prepare', locale: S.locale, done: 0, total: 0, translated: 0, copied: 0, cached: 0, failed: 0 };
    drawAll();
    try {
      const res = await api.invoke('modtranslate:run', instanceId, { locale: S.locale, mods, setLanguage });
      if (S.closed) return;
      S.result = res;
      if (res.status === 'done') toast('good', T('toastDone'), TC('resultText', (res.translated || 0) + (res.copied || 0) + (res.cached || 0)));
    } catch (err) {
      if (S.closed) return;
      S.result = { status: 'error', error: isMissingChannel(err) ? T('errNotReady') : err.message, locale: S.locale };
    }
    S.job = null;
    await scan({ locale: S.locale, quiet: true });
  }

  async function cancelRun() {
    try {
      await api.invoke('modtranslate:cancel', instanceId);
    } catch (err) {
      fail(T('actionFailed'), err);
    }
  }

  // ---------- Revisar y corregir ----------
  async function loadEntries() {
    const ed = S.ed;
    ed.loading = true;
    ed.error = null;
    if (S.tab === 'review') drawReview();
    try {
      const res = await api.invoke('modtranslate:get', instanceId, { locale: S.locale, mod: ed.mod || null, filter: ed.filter, query: ed.query, offset: ed.offset, limit: PAGE });
      if (S.closed) return;
      ed.data = res;
      if (ed.mod && !res.mods.some((x) => x.id === ed.mod)) ed.mod = '';
      if (res.total && ed.offset >= res.total) {
        ed.offset = Math.max(0, Math.floor((res.total - 1) / PAGE) * PAGE);
        return loadEntries();
      }
    } catch (err) {
      if (S.closed) return;
      ed.error = isMissingChannel(err) ? T('errNotReady') : err.message;
    } finally {
      ed.loading = false;
    }
    if (S.tab === 'review') {
      drawReview();
      drawFoot();
    }
    return undefined;
  }

  const rowId = (r) => `${r.ns}\u0000${r.key}`;
  const rowApi = new Map(); // id -> { showCheck, setBadge } de las filas visibles

  function drawReview() {
    const ed = S.ed;
    const sc = S.scan;
    if (!sc) return mount(panelEl, S.error ? errorView(S.error, () => scan({ locale: S.locale })) : scanningView());
    if (!sc.supported) return mount(panelEl, emptyState('languages', T('unsupportedTitle'), T('unsupportedText', { version: sc.instance?.mcVersion || '?' })));
    rowApi.clear();
    const data = ed.data;
    const modSel = h('select', { class: 'select mtr-ed-mod', 'aria-label': T('reviewModLabel') }, h('option', { value: '' }, T('reviewAllMods', { n: num(data ? data.mods.reduce((a, x) => a + x.count, 0) : 0) })), (data?.mods || []).map((x) => h('option', { value: x.id, selected: x.id === ed.mod }, `${x.name} (${num(x.count)})`)));
    modSel.addEventListener('change', async () => {
      await flushEdits();
      ed.mod = modSel.value;
      ed.offset = 0;
      loadEntries();
    });
    const search = h('input', { class: 'input', type: 'search', placeholder: T('reviewSearch'), value: ed.query, 'aria-label': T('reviewSearch') });
    search.addEventListener(
      'input',
      debounce(async () => {
        await flushEdits();
        ed.query = search.value;
        ed.offset = 0;
        loadEntries();
      }, 280),
    );
    const counts = data?.counts || {};
    const fchip = (id, label) =>
      h(
        'button',
        {
          class: ['chip', ed.filter === id && 'active'],
          type: 'button',
          'aria-pressed': ed.filter === id ? 'true' : 'false',
          onclick: async () => {
            await flushEdits();
            ed.filter = id;
            ed.offset = 0;
            loadEntries();
          },
        },
        label,
        h('span', { class: 'mtr-chip-count' }, num(counts[id] || 0)),
      );
    const toolbar = h(
      'div',
      { class: 'mtr-ed-toolbar' },
      modSel,
      h('div', { class: 'input-icon mtr-search' }, icon('search'), search),
      h('div', { class: 'chips mtr-ed-filters' }, fchip('all', T('fAll')), fchip('auto', T('fAuto')), fchip('reviewed', T('fReviewed')), fchip('untranslated', T('fUntranslated')), fchip('problems', T('fProblems'))),
    );
    let content;
    if (ed.error) content = errorView(ed.error, () => loadEntries());
    else if (!data) {
      // Esqueleto con la forma de la tabla (clave, original, traducción, revisado)
      const bone = (cls, style) => h('span', { class: `skeleton ${cls}`, style });
      const row = (i) =>
        h(
          'div',
          { class: 'mtr-ed-row' },
          h('div', { class: 'skeleton-lines' }, bone('skeleton-line', { width: `${70 + ((i * 13) % 25)}%` }), bone('skeleton-line', { width: '45%' })),
          h('div', { class: 'skeleton-lines' }, bone('skeleton-line'), bone('skeleton-line', { width: `${40 + ((i * 17) % 40)}%` })),
          bone('skeleton-block'),
          h('div', { class: 'mtr-ed-rev' }, bone('skeleton-line', { width: '42px', height: '24px', borderRadius: '999px' })),
        );
      content = h(
        'div',
        { class: 'mtr-ed' },
        h(
          'div',
          { class: 'mtr-ed-table skeleton-group mtr-ed-skel', role: 'status', 'aria-live': 'polite', 'aria-busy': 'true' },
          h('span', { class: 'sr-only' }, T('loadingEntries')),
          h('div', { 'aria-hidden': 'true' }, [0, 1, 2, 3, 4].map(row)),
        ),
      );
    }
    else if (!data.total) {
      content =
        data.counts?.all || ed.query
          ? emptyState('search', T('reviewNoMatchTitle'), T('reviewNoMatchText'))
          : emptyState('fileText', T('reviewEmptyTitle'), T('reviewEmptyText'), h('button', { class: 'btn sm', type: 'button', onclick: () => switchTab('mods') }, icon('puzzle'), T('tabMods')));
    } else {
      const head = h('div', { class: 'mtr-ed-row mtr-ed-headrow', 'aria-hidden': 'true' }, h('div', {}, T('colKey')), h('div', {}, T('colSource')), h('div', {}, T('colTranslation')), h('div', { class: 'mtr-ed-revhead' }, T('colReviewed')));
      const rows = h('div', { class: ['mtr-ed-rows', ed.loading && 'busy'] }, data.rows.map(editorRow));
      const from = data.offset + 1;
      const to = Math.min(data.offset + data.rows.length, data.total);
      const pager = h(
        'div',
        { class: 'mtr-pager' },
        h('span', { class: 'small muted' }, T('pageInfo', { from: num(from), to: num(to), total: num(data.total) })),
        h(
          'button',
          {
            class: 'icon-btn sm',
            type: 'button',
            title: T('pagePrev'),
            'aria-label': T('pagePrev'),
            disabled: data.offset <= 0 || ed.loading,
            onclick: async () => {
              await flushEdits();
              ed.offset = Math.max(0, ed.offset - PAGE);
              await loadEntries();
              panelEl.querySelector('.mtr-ed-table')?.scrollTo(0, 0);
            },
          },
          icon('chevronLeft'),
        ),
        h(
          'button',
          {
            class: 'icon-btn sm',
            type: 'button',
            title: T('pageNext'),
            'aria-label': T('pageNext'),
            disabled: to >= data.total || ed.loading,
            onclick: async () => {
              await flushEdits();
              ed.offset += PAGE;
              await loadEntries();
              panelEl.querySelector('.mtr-ed-table')?.scrollTo(0, 0);
            },
          },
          icon('chevronRight'),
        ),
      );
      content = h('div', { class: 'mtr-ed' }, h('div', { class: 'mtr-ed-table' }, head, rows), pager);
    }
    const keepFocus = document.activeElement === panelEl.querySelector('.mtr-ed-toolbar input[type=search]');
    mount(panelEl, toolbar, content);
    if (keepFocus) {
      search.focus();
      search.setSelectionRange(search.value.length, search.value.length);
    }
    return undefined;
  }

  function badgeFor(r, pend) {
    if (pend && pend.text !== undefined) return h('span', { class: 'badge accent' }, icon('edit'), T('badgeEdited'));
    if (r.stale) return h('span', { class: 'badge warn', title: r.oldSource ? T('staleHint', { old: r.oldSource }) : '' }, icon('alert'), T('badgeStale'));
    if (r.reviewed) return h('span', { class: 'badge good' }, icon('check'), T('badgeReviewed'));
    if (r.kind === 'auto') {
      if (r.origin === 'copy') return h('span', { class: 'badge', title: T('badgeCopyHint', { from: r.from || '' }) }, T('badgeCopy', { from: r.from || '' }));
      if (r.origin === 'import') return h('span', { class: 'badge' }, T('badgeImport'));
      if (r.origin === 'cache') return h('span', { class: 'badge accent', title: T('badgeAiHint') }, icon('sparkles'), T('badgeAi'));
      return h('span', { class: 'badge accent', title: T('badgeAiHint') }, icon('sparkles'), T('badgeAi'));
    }
    if (r.failed) return h('span', { class: 'badge bad', title: T('badgeFailedHint') }, T('badgeFailed'));
    if (r.identical) return h('span', { class: 'badge warn', title: T('badgeIdenticalHint') }, T('badgeIdentical'));
    return h('span', { class: 'badge' }, T('badgeMissing'));
  }

  function editorRow(r) {
    const ed = S.ed;
    const id = rowId(r);
    const pend = ed.pending.get(id);
    const value = pend && pend.text !== undefined ? pend.text : r.text;
    const reviewed = pend && pend.reviewed !== undefined ? pend.reviewed : r.reviewed;
    const ta = h('textarea', { class: 'textarea mtr-ta', rows: 1, spellcheck: 'false', placeholder: T('taPlaceholder'), 'aria-label': T('taLabel', { key: r.key }) });
    ta.value = value || '';
    const msg = h('div', { class: 'mtr-ta-msg' });
    const badgeSlot = h('span', { class: 'mtr-badge-slot' }, badgeFor(r, pend));
    const sw = h('input', { type: 'checkbox', checked: reviewed, disabled: !value, 'aria-label': T('reviewedLabel', { key: r.key }) });
    const swWrap = h('label', { class: 'switch', title: T('reviewedHint') }, sw, h('span', { class: 'track' }));
    const autosize = () => {
      ta.style.height = 'auto';
      ta.style.height = `${Math.min(ta.scrollHeight + 2, 168)}px`;
    };
    const showCheck = () => {
      const txt = ta.value;
      const res = txt.trim() ? checkText(r.source, txt) : { ok: true };
      const server = ed.invalid.get(id);
      const bad = !res.ok ? res : server && txt === server.text ? server : null;
      rowEl.classList.toggle('invalid', Boolean(bad));
      ta.setAttribute('aria-invalid', bad ? 'true' : 'false');
      mount(msg, bad ? [icon('alert'), h('span', {}, problemText(bad))] : null);
      return !bad;
    };
    ta.addEventListener('input', () => {
      autosize();
      const txt = ta.value;
      const prev = ed.pending.get(id) || { ns: r.ns, key: r.key };
      const changed = txt !== (r.text || '');
      if (!changed && prev.reviewed === undefined) ed.pending.delete(id);
      else ed.pending.set(id, { ...prev, text: changed ? txt : undefined, reviewed: changed ? Boolean(txt.trim()) : prev.reviewed });
      sw.disabled = !txt.trim();
      sw.checked = changed ? Boolean(txt.trim()) : r.reviewed;
      ed.invalid.delete(id);
      mount(badgeSlot, badgeFor(r, ed.pending.get(id)));
      if (showCheck()) scheduleSave();
      drawFoot();
    });
    sw.addEventListener('change', () => {
      const prev = ed.pending.get(id) || { ns: r.ns, key: r.key };
      ed.pending.set(id, { ...prev, reviewed: sw.checked });
      scheduleSave();
      drawFoot();
    });
    const sugg = r.suggestion && !value
      ? h(
          'button',
          {
            class: 'mtr-sugg',
            type: 'button',
            title: r.suggestion.from === 'cache' ? T('suggestionCacheHint') : T('suggestionCopyHint', { from: r.suggestion.from }),
            onclick: () => {
              ta.value = r.suggestion.text;
              ta.dispatchEvent(new Event('input'));
              sugg.remove();
              ta.focus();
            },
          },
          icon('wand'),
          h('span', { class: 'ellipsis' }, T('suggestionUse', { text: r.suggestion.text })),
        )
      : null;
    const rowEl = h(
      'div',
      { class: ['mtr-ed-row', r.kind === 'missing' && 'missing', r.stale && 'stale'], dataset: { id } },
      h(
        'div',
        { class: 'mtr-ed-key' },
        h('div', { class: 'mtr-ed-keytext selectable', title: `${r.ns} · ${r.key}` }, r.key),
        h('div', { class: 'mtr-ed-keymeta' }, h('span', { class: 'mtr-ns ellipsis', title: r.modName }, r.modName), badgeSlot),
      ),
      h('div', { class: 'mtr-ed-src selectable', lang: 'en' }, sourceNodes(r.source), r.stale && r.oldSource ? h('div', { class: 'mtr-old tiny' }, T('staleOld', { old: r.oldSource })) : null),
      h('div', { class: 'mtr-ed-tr' }, ta, msg, sugg),
      h('div', { class: 'mtr-ed-rev' }, swWrap),
    );
    rowApi.set(id, { showCheck, setBadge: () => mount(badgeSlot, badgeFor(r, ed.pending.get(id))) });
    requestAnimationFrame(autosize);
    if (ed.invalid.has(id)) requestAnimationFrame(showCheck);
    else if (value && !checkText(r.source, value).ok) requestAnimationFrame(showCheck);
    return rowEl;
  }

  // Guardado automático de lo editado (solo lo que tiene los marcadores bien).
  let saveTimer = null;
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => flushEdits(), SAVE_DELAY);
  }

  let flushing = null;
  async function flushEdits(closing = false) {
    clearTimeout(saveTimer);
    if (flushing) await flushing.catch(() => {});
    const ed = S.ed;
    const rows = ed.data?.rows || [];
    const byId = new Map(rows.map((r) => [rowId(r), r]));
    const changes = [];
    let invalidLocal = 0;
    for (const [id, p] of ed.pending) {
      const r = byId.get(id);
      if (p.text !== undefined && p.text.trim() && r && !checkText(r.source, p.text).ok) {
        invalidLocal++;
        continue;
      }
      changes.push({ ns: p.ns, key: p.key, ...(p.text !== undefined ? { text: p.text } : {}), ...(p.reviewed !== undefined ? { reviewed: p.reviewed } : {}) });
    }
    if (closing && invalidLocal) toast('bad', TC('unsavedInvalid', invalidLocal), T('unsavedInvalidText'), 7000);
    if (!changes.length) return;
    const sent = new Map(changes.map((c) => [`${c.ns}\u0000${c.key}`, ed.pending.get(`${c.ns}\u0000${c.key}`)]));
    ed.saving = true;
    if (!closing) drawFoot();
    flushing = (async () => {
      try {
        const res = await api.invoke('modtranslate:save', instanceId, { locale: S.locale, changes });
        const rejected = new Map((res?.rejected || []).map((x) => [`${x.ns}\u0000${x.key}`, x]));
        for (const [id, p] of sent) {
          if (ed.pending.get(id) !== p) continue; // se volvió a editar mientras se guardaba
          const rej = rejected.get(id);
          if (rej) {
            ed.invalid.set(id, { ...rej, ok: false, text: p.text });
            continue;
          }
          ed.pending.delete(id);
          const r = byId.get(id);
          if (r) {
            if (p.text !== undefined) {
              r.text = p.text;
              r.reviewed = Boolean(p.text.trim()) && (p.reviewed ?? true);
              r.kind = p.text.trim() ? (r.reviewed ? 'reviewed' : 'auto') : 'missing';
              r.origin = 'user';
              r.stale = false;
              r.failed = false;
            }
            if (p.reviewed !== undefined && r.text) {
              r.reviewed = p.reviewed;
              r.stale = false;
              r.kind = p.reviewed ? 'reviewed' : 'auto';
            }
          }
        }
        ed.saved += res?.saved || 0;
        ed.lastSaveAt = Date.now();
        ed.gameRunning = Boolean(res?.gameRunning);
        if (!S.closed && S.tab === 'review') {
          for (const id of sent.keys()) {
            const row = rowApi.get(id);
            if (!row) continue;
            row.setBadge();
            if (ed.invalid.has(id)) row.showCheck();
          }
        }
      } catch (err) {
        if (!closing) fail(T('saveFailed'), err);
        else toast('bad', T('saveFailed'), err.message, 7000);
      } finally {
        ed.saving = false;
        flushing = null;
        if (!S.closed) drawFoot();
      }
    })();
    await flushing;
    S.staleScan = true;
  }

  // ---------- Compartir ----------
  function drawShare() {
    const sc = S.scan;
    if (!sc) return mount(panelEl, S.error ? errorView(S.error, () => scan({ locale: S.locale })) : scanningView());
    if (!sc.supported) return mount(panelEl, emptyState('languages', T('unsupportedTitle'), T('unsupportedText', { version: sc.instance?.mcVersion || '?' })));
    const ours = sc.totals?.ours || 0;
    const reviewed = sc.totals?.reviewed || 0;
    const card = (iconName, title, text, action) => h('div', { class: 'mtr-share-card' }, h('div', { class: 'mtr-share-icon' }, icon(iconName)), h('div', { class: 'mtr-share-main' }, h('div', { class: 'mtr-share-title' }, title), h('div', { class: 'mtr-share-text' }, text)), action);
    const exportBtn = (format, label) => h('button', { class: 'btn sm', type: 'button', disabled: !ours, onclick: () => doExport(format) }, icon('download'), label);
    const last = S.share;
    mount(
      panelEl,
      h(
        'div',
        { class: 'mtr-share' },
        h('div', { class: 'mtr-share-summary' }, icon('languages'), h('div', {}, h('strong', {}, localeName(sc, S.locale)), ' · ', ours ? TC('shareSummary', ours, { reviewed: num(reviewed) }) : T('shareNothing'))),
        h(
          'div',
          { class: 'mtr-share-grid' },
          card('fileText', T('shareJsonTitle'), T('shareJsonText'), exportBtn('json', T('shareJsonBtn'))),
          card('package', T('shareZipTitle'), T('shareZipText'), exportBtn('zip', T('shareZipBtn'))),
          card('upload', T('shareImportTitle'), T('shareImportText'), h('button', { class: 'btn sm', type: 'button', onclick: doImport }, icon('upload'), T('shareImportBtn'))),
        ),
        last ? h('div', { class: ['notice', last.kind === 'error' ? 'bad' : 'good'] }, icon(last.kind === 'error' ? 'alert' : 'check'), h('div', { class: 'mtr-notice-text' }, last.text), last.path ? h('button', { class: 'btn sm ghost', type: 'button', onclick: () => api.invoke('modtranslate:reveal', last.path).catch((err) => fail(T('actionFailed'), err)) }, icon('folderOpen'), T('showInFolder')) : null) : null,
        sc.pack?.exists ? h('div', { class: 'mtr-hint small' }, icon('folder'), h('span', {}, T('sharePackHere', { path: 'resourcepacks/venus-auto-translations' })), h('button', { class: 'btn sm ghost', type: 'button', onclick: openFolder }, icon('folderOpen'), T('menuOpenFolder'))) : null,
        h('div', { class: 'notice info' }, icon('heart'), h('div', {}, h('strong', {}, T('shareCommunityTitle')), ' ', T('shareCommunityText'))),
      ),
    );
    return undefined;
  }

  async function doExport(format) {
    await flushEdits();
    try {
      const r = await api.invoke('modtranslate:export', instanceId, { locale: S.locale, format });
      if (!r) return;
      S.share = { kind: 'good', text: TC('exportDone', r.count, { file: r.path.split(/[\\/]/).pop() }), path: r.path };
      ok(T('exportToast'), r.path);
    } catch (err) {
      S.share = { kind: 'error', text: err.message };
    }
    if (S.tab === 'share') drawShare();
  }

  async function doImport() {
    await flushEdits();
    try {
      const r = await api.invoke('modtranslate:import', instanceId, { locale: S.locale });
      if (!r) return;
      const skipped = (r.unknown || 0) + (r.invalid || 0) + (r.native || 0) + (r.kept || 0);
      S.share = { kind: 'good', text: [TC('importDone', (r.added || 0) + (r.updated || 0), { name: localeName(S.scan, r.locale) }), skipped ? TC('importSkipped', skipped) : null, r.kept ? TC('importKept', r.kept) : null].filter(Boolean).join(' ') };
      ok(T('importToast'), TC('importDone', (r.added || 0) + (r.updated || 0), { name: localeName(S.scan, r.locale) }));
      S.ed = { ...S.ed, data: null, offset: 0, pending: new Map(), invalid: new Map() };
      await scan({ locale: r.locale || S.locale, quiet: true });
    } catch (err) {
      S.share = { kind: 'error', text: err.message };
    }
    if (S.tab === 'share') drawShare();
  }

  // ---------- Pie ----------
  function drawFoot() {
    const sc = S.scan;
    const closeBtn = h('button', { class: 'btn ghost', type: 'button', onclick: () => m.close() }, T('close'));
    if (S.tab === 'review') {
      const ed = S.ed;
      const pendingInvalid = [...ed.pending.entries()].filter(([id, p]) => {
        const r = ed.data?.rows.find((x) => rowId(x) === id);
        return p.text !== undefined && p.text.trim() && r && !checkText(r.source, p.text).ok;
      }).length + ed.invalid.size;
      let status;
      if (ed.saving) status = h('span', { class: 'mtr-save' }, h('div', { class: 'spinner' }), T('saving'));
      else if (pendingInvalid) status = h('span', { class: 'mtr-save warn' }, icon('alert'), TC('invalidPending', pendingInvalid));
      else if (ed.pending.size) status = h('span', { class: 'mtr-save' }, icon('edit'), TC('pendingChanges', ed.pending.size));
      else if (ed.lastSaveAt) status = h('span', { class: 'mtr-save good' }, icon('check'), ed.gameRunning ? T('savedReload') : T('saved'));
      else status = h('span', { class: 'mtr-save muted' }, icon('info'), T('autosaveHint'));
      mount(footEl, status, h('div', { class: 'mtr-spacer' }), closeBtn);
      return;
    }
    // Sin nada para traducir (sin mods o sin textos) el pie no ofrece traducir ni configurar la IA
    if (S.tab === 'share' || !sc || !sc.supported || !sc.mods.length || !sc.totals?.withText) {
      mount(footEl, h('div', { class: 'mtr-spacer' }), closeBtn);
      return;
    }
    if (isRunning()) {
      mount(footEl, h('span', { class: 'mtr-est muted' }, T('runFootHint')), h('div', { class: 'mtr-spacer' }), h('button', { class: 'btn danger', type: 'button', onclick: cancelRun }, icon('x'), T('cancelRun')), closeBtn);
      return;
    }
    if (S.result) {
      mount(footEl, h('div', { class: 'mtr-spacer' }), closeBtn);
      return;
    }
    const sel = sc.mods.filter((x) => S.selected.has(x.id) && needsWork(x));
    const sum = (k) => sel.reduce((a, x) => a + (x[k] || 0), 0);
    const pending = sum('pending');
    const reuse = sum('copies') + sum('cached');
    const tokens = sum('tokens');
    const aiOn = Boolean(sc.ai?.available);
    const count = (aiOn ? pending : 0) + reuse;
    let est;
    if (!sel.length) est = h('div', { class: 'mtr-est muted' }, T('estNone'));
    else {
      const parts = [];
      if (aiOn && pending) parts.push(TC('estAi', pending, { tokens: fmtNumber(tokens) }));
      if (reuse) parts.push(TC('estReuse', reuse));
      if (!aiOn && pending) parts.push(TC('estNoAi', pending));
      est = h('div', { class: 'mtr-est' }, h('div', { class: 'mtr-est-main' }, TC('estMods', sel.length)), h('div', { class: 'mtr-est-sub', title: T('estHint') }, parts.join(' · ') || T('estNothing')));
    }
    const langOpt = (sc.gameLanguage || 'en_us') !== S.locale && sel.length
      ? h(
          'label',
          { class: 'mtr-setlang', title: T('setLanguageHint') },
          (() => {
            const cb = h('input', { type: 'checkbox', checked: S.setLanguage });
            cb.addEventListener('change', () => (S.setLanguage = cb.checked));
            return cb;
          })(),
          h('span', {}, T('setLanguage', { name: localeName(sc, S.locale) })),
        )
      : null;
    let action;
    if (!aiOn && !reuse) action = h('button', { class: 'btn primary', type: 'button', onclick: () => (m.close(), navigate('settings/ai')) }, icon('settings'), T('aiConfigure'));
    else action = h('button', { class: 'btn primary', type: 'button', disabled: !count || S.scanning, onclick: startRun }, icon(aiOn ? 'sparkles' : 'check'), aiOn ? TC('translateBtn', count) : TC('applyBtn', count));
    mount(footEl, est, langOpt, h('div', { class: 'mtr-spacer' }), closeBtn, action);
  }

  drawAll();
  await scan();
}
