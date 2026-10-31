// Compatibilidad: revisión antes de instalar (checkBeforeInstall) y actualizaciones de mods con changelog,
// pistas de riesgo e historial con vuelta atrás por mod (openModUpdates).
import { h, icon, mount, modal, toast, ok, confirmDialog, ensureCss, fmtBytes, fmtAgo, fmtDate, fmtTime, emptyState, switchEl, loaderBadge, LOADERS, skeleton } from '../ui.js';
import { store, api } from '../store.js';
import { t, loadNs } from '../i18n.js';

const CHECK_TIMEOUT = 45000;
const SHOW_LOADING_AFTER = 350;
const INFO_LIMIT = 4;
const HIDDEN_INFOS = new Set(['willAddDependency', 'optionalSuggestion', 'betterVersion', 'betterVersionPre']);
const CONFLICT = /^(jarBreaks|jarNeeds|incompatible|installedIncompatible)/;
const TYPE_ICON = { mod: 'puzzle', resourcepack: 'palette', shader: 'sun', datapack: 'database', plugin: 'plug', modpack: 'package' };
const TYPE_KEY = { mod: 'typeMod', resourcepack: 'typeResourcepack', shader: 'typeShader', datapack: 'typeDatapack', plugin: 'typePlugin', modpack: 'typeModpack' };
const FOLDER_TYPE = { mods: 'mod', resourcepacks: 'resourcepack', shaderpacks: 'shader', plugins: 'plugin' };
const SEV_ICON = { error: 'shieldAlert', warning: 'alert', info: 'info' };
const LEVEL = { high: 3, medium: 2, low: 1, info: 0 };

async function ready() {
  ensureCss('features/compat');
  try {
    await loadNs('compat');
  } catch {
    /* sin textos se ven las claves, pero no se rompe nada */
  }
}

const isMissingChannel = (err) => /No handler registered/i.test(err?.message || '');

// Redibuja sin perder el foco del teclado: los controles llevan data-fk con una clave estable.
function keepFocus(container, fn) {
  const key = document.activeElement?.closest?.('[data-fk]')?.dataset.fk;
  fn();
  if (!key) return;
  const el = container.querySelector(`[data-fk="${CSS.escape(key)}"]`);
  if (el) el.focus({ preventScroll: true });
}

// Pestanas con teclado (patron ARIA): Izquierda/Derecha/Inicio/Fin cambian de pestana y le pasan el foco
function tabKeys(list, onPick) {
  list.addEventListener('keydown', (e) => {
    const tabs = [...list.querySelectorAll('[role="tab"]')];
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    const next = { ArrowRight: (i + 1) % tabs.length, ArrowLeft: (i - 1 + tabs.length) % tabs.length, Home: 0, End: tabs.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    onPick(tabs[next].dataset.key);
  });
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { timeout: true })), ms);
    }),
  ]);
}

// Ventana propia sobre modal() de ui.js: permite cambiar titulo, cuerpo y pie sin cerrarla.
function createDialog({ title, subtitle, icon: iconName, size = '', body, footer }) {
  const ctl = { onClose: null, cleanup: null, silent: false };
  const m = modal({
    title,
    subtitle,
    icon: iconName,
    size: `${size} cpt-modal`,
    body,
    footer: footer && footer.length ? footer : [h('span', { class: 'cpt-foot-spacer' })],
    onClose: () => {
      try {
        ctl.cleanup?.();
      } finally {
        if (!ctl.silent) ctl.onClose?.();
      }
    },
  });
  ctl.el = m.el;
  ctl.body = m.el.querySelector('.modal-body');
  ctl.foot = m.el.querySelector('.modal-foot');
  ctl.setTitle = (text) => {
    const el = m.el.querySelector('.modal-head h3');
    if (el) el.textContent = text;
  };
  ctl.setSize = (s) => {
    m.el.className = `modal ${s} cpt-modal`;
  };
  ctl.close = () => {
    ctl.silent = true;
    m.close();
  };
  return ctl;
}

function thumb(src, fallback) {
  const box = h('div', { class: 'cpt-thumb' });
  if (typeof src === 'string' && /^https:\/\//i.test(src)) {
    const img = h('img', { src, alt: '', loading: 'lazy' });
    img.addEventListener('error', () => mount(box, icon(fallback)), { once: true });
    box.append(img);
  } else box.append(icon(fallback));
  return box;
}

const typeLabel = (type) => t(`compat.${TYPE_KEY[type] || 'typeMod'}`);
const vtLabel = (vt) => t(vt === 'alpha' ? 'compat.vtAlpha' : vt === 'beta' ? 'compat.vtBeta' : 'compat.vtRelease');

function vtBadge(vt) {
  if (!vt || vt === 'release') return null;
  return h('span', { class: ['badge', vt === 'alpha' ? 'bad' : 'warn'] }, vtLabel(vt));
}

function targetBadge(loader, name) {
  return LOADERS[loader] ? loaderBadge(loader) : h('span', { class: 'badge' }, name || loader);
}

// ---------- Markdown seguro (changelogs): se construye con nodos, nunca con innerHTML ----------
function openLink(url) {
  if (/^https?:\/\//i.test(url)) api.app.openExternal(url).catch(() => {});
}

function inline(text) {
  const out = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*|__[^_]+__)|(\*[^*\s][^*]*\*|\b_[^_\s][^_]*_\b)|(!?\[[^\]]*\]\([^)\s]+(?:\s+"[^"]*")?\))|(https?:\/\/[^\s)<>\]]+)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (m[1]) out.push(h('code', {}, tok.slice(1, -1)));
    else if (m[2]) out.push(h('strong', {}, inline(tok.slice(2, -2))));
    else if (m[3]) out.push(h('em', {}, inline(tok.slice(1, -1))));
    else if (m[4]) {
      const lm = /^(!?)\[([^\]]*)\]\(([^)\s]+)/.exec(tok);
      if (lm[1]) out.push(lm[2] || ''); // imagenes: solo el texto alternativo
      else out.push(h('a', { href: '#', title: lm[3], onclick: (e) => (e.preventDefault(), openLink(lm[3])) }, lm[2] || lm[3]));
    } else if (m[5]) out.push(h('a', { href: '#', title: tok, onclick: (e) => (e.preventDefault(), openLink(tok)) }, tok));
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function markdown(src) {
  const lines = String(src || '')
    .replace(/\r\n?/g, '\n')
    .replace(/<\/?(details|summary|br|p|div|span|b|i|u|strong|em|sup|sub|center|img|a|ul|ol|li|h\d)[^>]*>/gi, ' ')
    .split('\n');
  const root = h('div', { class: 'rich cpt-md selectable' });
  let list = null;
  let para = [];
  let code = null;
  const flushPara = () => {
    if (para.length) root.append(h('p', {}, inline(para.join(' '))));
    para = [];
  };
  const closeList = () => {
    list = null;
  };
  for (const raw of lines) {
    if (code) {
      if (/^\s*```/.test(raw)) {
        root.append(h('pre', {}, h('code', {}, code.join('\n'))));
        code = null;
      } else code.push(raw);
      continue;
    }
    if (/^\s*```/.test(raw)) {
      flushPara();
      closeList();
      code = [];
      continue;
    }
    const line = raw.trimEnd();
    if (!line.trim()) {
      flushPara();
      closeList();
      continue;
    }
    const hm = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line);
    if (hm) {
      flushPara();
      closeList();
      root.append(h(hm[1].length <= 2 ? 'h3' : 'h4', {}, inline(hm[2].replace(/\s*#+\s*$/, ''))));
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushPara();
      closeList();
      root.append(h('hr', { class: 'cpt-hr' }));
      continue;
    }
    const lm = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (lm) {
      flushPara();
      const ordered = /\d/.test(lm[2]);
      if (!list || list.ordered !== ordered) {
        list = { ordered, el: h(ordered ? 'ol' : 'ul') };
        root.append(list.el);
      }
      list.el.append(h('li', { class: lm[1].length >= 2 ? 'cpt-li-sub' : null }, inline(lm[3])));
      continue;
    }
    const qm = /^\s*>\s?(.*)$/.exec(line);
    if (qm) {
      flushPara();
      closeList();
      root.append(h('blockquote', {}, inline(qm[1])));
      continue;
    }
    if (list && /^\s{2,}\S/.test(raw)) {
      const li = list.el.lastElementChild;
      if (li) li.append(' ', ...inline(line.trim()));
      continue;
    }
    closeList();
    para.push(line.trim());
  }
  if (code) root.append(h('pre', {}, h('code', {}, code.join('\n'))));
  flushPara();
  return root;
}

// =====================================================================
// Revision antes de instalar
// =====================================================================

// Devuelve true para seguir con la instalacion. Nunca queda colgada: si la revision no esta disponible o
// falla, sigue (true). Puede cambiar "items" en el lugar: versionId elegido y sin los items omitidos.
export async function checkBeforeInstall({ target, items } = {}) {
  try {
    await ready();
  } catch {
    /* seguir */
  }
  if (!target || !Array.isArray(items) || !items.length) return true;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      resolve(Boolean(v));
    };
    runCheck(target, items, finish).catch((err) => {
      console.warn('[compat]', err);
      finish(true);
    });
  });
}

function toRequest(list) {
  return list.map((i) => ({ projectId: i.projectId, versionId: i.versionId || undefined, type: i.type || undefined }));
}

function verifiedToast(res) {
  const deps = (res.toInstall || []).filter((p) => p.reason === 'required').length;
  const already = (res.items || []).length && res.items.every((i) => i.installed?.same);
  toast('good', t('compat.verified'), already ? t('compat.verifiedAlready') : deps ? t('compat.verifiedDeps', { count: deps }) : null, 2600);
}

async function runCheck(target, items, finish) {
  let dlg = null;
  let abandoned = false;
  const showLoading = () => {
    const cancelBtn = h('button', { class: 'btn ghost', onclick: () => ((abandoned = true), dlg.close(), finish(false)) }, t('compat.cancel'));
    const skipBtn = h('button', { class: 'btn', onclick: () => ((abandoned = true), dlg.close(), finish(true)) }, icon('skipForward'), t('compat.skipCheck'));
    // Espera corta: ventana angosta, el titulo dice que pasa y el cuerpo, contra que se compara
    dlg = createDialog({
      title: t('compat.checking'),
      size: 'sm',
      body: h('div', { class: 'cpt-checking', role: 'status', 'aria-live': 'polite' }, h('div', { class: 'spinner', 'aria-hidden': 'true' }), h('div', { class: 'cpt-checking-text' }, t('compat.checkingText'))),
      footer: [cancelBtn, skipBtn],
    });
    dlg.onClose = () => {
      abandoned = true;
      finish(false);
    };
  };
  const timer = setTimeout(showLoading, SHOW_LOADING_AFTER);
  let res;
  try {
    res = await withTimeout(api.invoke('compat:check', { target, items: toRequest(items) }), CHECK_TIMEOUT);
  } catch (err) {
    clearTimeout(timer);
    if (abandoned) return;
    dlg?.close();
    if (isMissingChannel(err)) console.warn('[compat] compat:check no disponible');
    else toast('info', t('compat.checkFailed'), err.timeout ? t('compat.checkTimeout') : err.message);
    finish(true);
    return;
  }
  clearTimeout(timer);
  if (abandoned) return;
  if (res.ok) {
    dlg?.close();
    if (res.adopt?.length) await api.invoke('compat:prepare', { target, adopt: res.adopt }).catch((err) => console.warn('[compat] adopt', err));
    verifiedToast(res);
    finish(true);
    return;
  }
  openReview({ target, items, result: res, finish, dlg });
}

function openReview({ target, items, result, finish, dlg: existing }) {
  const state = {
    entries: items.map((ref) => ({ ref, projectId: ref.projectId, versionId: ref.versionId || null, type: ref.type || null, skipped: false, userVersion: false })),
    result,
    suggestionsOn: new Set(),
    fixSeen: new Set(),
    replaceOff: new Set(),
    enableOff: new Set(),
    showAllInfos: false,
    busy: false,
    preparing: false,
    seq: 0,
  };
  // Recordar nombre, icono y tipo de cada item (al omitirlo deja de venir en el resultado)
  const remember = (res) => {
    for (const e of state.entries) {
      const it = res?.items?.find((i) => i.projectId === e.projectId || i.requestedId === e.projectId);
      if (it) e.info = { title: it.title, icon: it.icon, type: it.type };
    }
  };
  const markFixes = (res) => {
    remember(res);
    for (const s of res?.suggestions || []) {
      if (s.reason === 'fix' && !state.fixSeen.has(s.projectId)) {
        state.fixSeen.add(s.projectId);
        state.suggestionsOn.add(s.projectId);
      }
    }
  };
  markFixes(result);

  const dlg = existing || createDialog({ title: t('compat.reviewTitle'), size: 'wide', body: h('div') });
  dlg.setTitle(t('compat.reviewTitle'));
  dlg.setSize('wide');
  dlg.onClose = () => finish(false);

  const resultItem = (pid) => state.result?.items?.find((i) => i.projectId === pid || i.requestedId === pid) || null;
  const entryFor = (pid) => state.entries.find((e) => e.projectId === pid || resultItem(e.projectId)?.projectId === pid) || null;
  const fileKey = (x) => `${x.folder}/${x.file}`;

  let recheckTimer = null;
  const recheck = () => {
    clearTimeout(recheckTimer);
    recheckTimer = setTimeout(doRecheck, 250);
    state.busy = true;
    renderFoot();
  };
  async function doRecheck() {
    const active = state.entries.filter((e) => !e.skipped);
    const seq = ++state.seq;
    if (!active.length) {
      state.busy = false;
      render();
      return;
    }
    state.busy = true;
    renderFoot();
    try {
      const res = await api.invoke('compat:check', { target, items: toRequest(active) });
      if (seq !== state.seq) return;
      state.result = res;
      markFixes(res);
    } catch (err) {
      if (seq === state.seq) toast('bad', t('compat.checkFailed'), err.message);
    } finally {
      if (seq === state.seq) {
        state.busy = false;
        render();
      }
    }
  }

  const toggleSkip = (entry) => {
    entry.skipped = !entry.skipped;
    render();
    recheck();
  };
  const useVersion = (entry, versionId) => {
    entry.versionId = versionId;
    entry.userVersion = true;
    render();
    recheck();
  };
  const focusVersion = (entry) => {
    const sel = dlg.body.querySelector(`select[data-pid="${CSS.escape(entry.projectId)}"]`);
    if (sel) {
      sel.scrollIntoView({ block: 'center', behavior: 'smooth' });
      sel.focus();
    }
  };
  const toggleSet = (set, key) => {
    if (set.has(key)) set.delete(key);
    else set.add(key);
    render();
  };

  function actionBtn(label, iconName, onclick, { primary = false, pressed, fk } = {}) {
    return h('button', { class: ['btn sm', primary ? 'cpt-btn-fix' : 'ghost', pressed && 'is-on'], 'aria-pressed': pressed === undefined ? null : String(Boolean(pressed)), disabled: state.preparing, dataset: fk ? { fk } : undefined, onclick }, iconName ? icon(iconName) : null, label);
  }

  function issueRow(issue, offered) {
    const entry = issue.projectId ? entryFor(issue.projectId) : null;
    const item = issue.projectId ? resultItem(issue.projectId) : null;
    const actions = [];
    const sv = item?.suggestedVersion;
    if (issue.severity === 'error' && CONFLICT.test(issue.code) && sv && entry && !offered.has(item.projectId) && entry.versionId !== sv.id) {
      offered.add(item.projectId);
      actions.push(actionBtn(t('compat.useVersion', { version: sv.number }), 'wand', () => useVersion(entry, sv.id), { primary: true, fk: `use|${item.projectId}` }));
    }
    for (const a of issue.actions || []) {
      if (a === 'pickVersion' && entry && (item?.alternatives?.length || 0) > 1) actions.push(actionBtn(t('compat.pickVersion'), 'chevronDown', () => focusVersion(entry), { fk: `pick|${issue.code}|${entry.projectId}` }));
      else if (a === 'skip' && entry && state.entries.length > 0) actions.push(actionBtn(entry.skipped ? t('compat.unskip') : t('compat.skip'), entry.skipped ? 'undo' : 'x', () => toggleSkip(entry), { fk: `skip|${issue.code}|${entry.projectId}|${issue.file || ''}` }));
      else if (a === 'addFix' && issue.fix) {
        const s = state.result.suggestions.find((x) => x.projectId === issue.fix);
        if (s) {
          const on = state.suggestionsOn.has(s.projectId);
          actions.push(actionBtn(on ? t('compat.addedFix', { name: s.title }) : t('compat.addFix', { name: s.title }), on ? 'check' : 'plus', () => toggleSet(state.suggestionsOn, s.projectId), { primary: !on, pressed: on, fk: `fix|${s.projectId}` }));
        }
      } else if (a === 'replace' && issue.file) {
        const r = state.result.replace.find((x) => x.file === issue.file);
        if (r) {
          const on = !state.replaceOff.has(fileKey(r));
          actions.push(actionBtn(on ? t('compat.replaceOn') : t('compat.replaceOff'), on ? 'archive' : 'x', () => toggleSet(state.replaceOff, fileKey(r)), { pressed: on, fk: `rep|${fileKey(r)}` }));
        }
      } else if (a === 'enable' && issue.file) {
        const x = state.result.enable.find((e) => e.file === issue.file);
        if (x) {
          const on = !state.enableOff.has(fileKey(x));
          actions.push(actionBtn(on ? t('compat.enableOn') : t('compat.enableOff'), on ? 'check' : 'x', () => toggleSet(state.enableOff, fileKey(x)), { pressed: on, fk: `en|${fileKey(x)}` }));
        }
      }
    }
    return h(
      'div',
      { class: ['cpt-issue', `is-${issue.severity}`] },
      h('div', { class: 'cpt-issue-icon', 'aria-hidden': 'true' }, icon(SEV_ICON[issue.severity])),
      h(
        'div',
        { class: 'cpt-issue-main' },
        h('div', { class: 'cpt-issue-text' }, issue.message),
        issue.detail ? h('div', { class: 'cpt-issue-detail' }, issue.detail) : null,
        actions.length ? h('div', { class: 'cpt-issue-actions' }, actions) : null,
      ),
    );
  }

  function issueGroup(kind, list, offered) {
    if (!list.length) return null;
    const label = { error: 'groupErrors', warning: 'groupWarnings', info: 'groupInfos' }[kind];
    const hint = { error: 'groupErrorsHint', warning: 'groupWarningsHint' }[kind];
    let shown = list;
    let more = null;
    if (kind === 'info' && list.length > INFO_LIMIT) {
      shown = state.showAllInfos ? list : list.slice(0, INFO_LIMIT);
      more = h(
        'button',
        { class: 'btn sm ghost cpt-more', dataset: { fk: 'more-infos' }, onclick: () => ((state.showAllInfos = !state.showAllInfos), render()) },
        icon(state.showAllInfos ? 'chevronDown' : 'chevronRight'),
        state.showAllInfos ? t('compat.showLess') : t('compat.showMore', { count: list.length - INFO_LIMIT }),
      );
    }
    return h(
      'section',
      { class: ['cpt-group', `is-${kind}`], 'aria-label': t(`compat.${label}`) },
      h('div', { class: 'cpt-group-head' }, icon(SEV_ICON[kind]), h('span', { class: 'cpt-group-title', role: 'heading', 'aria-level': '4' }, t(`compat.${label}`)), h('span', { class: 'cpt-count' }, String(list.length)), hint ? h('span', { class: 'cpt-group-hint' }, t(`compat.${hint}`)) : null),
      h('div', { class: 'cpt-group-list' }, shown.map((i) => issueRow(i, offered))),
      more,
    );
  }

  function versionSelect(entry, item) {
    const alts = item?.alternatives || [];
    if (!alts.length) return h('span', { class: 'cpt-ver-text' }, item?.versionNumber || '—');
    const compatibleIds = new Set(alts.filter((a) => !a.incompatible).map((a) => a.id));
    const sel = h(
      'select',
      { class: 'select cpt-select', dataset: { pid: entry.projectId, fk: `ver|${entry.projectId}` }, 'aria-label': t('compat.versionLabel', { name: item.title }), disabled: state.preparing },
      alts.map((a) => {
        let label = `${a.number} · ${vtLabel(a.type)}`;
        if (!compatibleIds.has(a.id)) label = t('compat.versionNotCompatible', { version: a.number });
        else if (item.installed?.same && a.id === item.versionId) label = t('compat.versionInstalled', { version: a.number });
        return h('option', { value: a.id, selected: a.id === item.versionId }, label);
      }),
    );
    sel.addEventListener('change', () => useVersion(entry, sel.value));
    return sel;
  }

  function statusPill(status) {
    const map = { ok: ['good', 'statusOk', 'check'], info: ['good', 'statusInfo', 'check'], warning: ['warn', 'statusWarning', 'alert'], error: ['bad', 'statusError', 'shieldAlert'], skipped: ['', 'statusSkipped', 'x'] };
    const [cls, key, ic] = map[status] || map.ok;
    return h('span', { class: ['pill', cls, 'cpt-status'] }, icon(ic), t(`compat.${key}`));
  }

  function itemRow(entry) {
    const item = resultItem(entry.projectId);
    const status = entry.skipped ? 'skipped' : item?.status || 'ok';
    const info = item || entry.info || null;
    const title = info?.title || entry.projectId;
    return h(
      'div',
      { class: ['cpt-item', entry.skipped && 'is-skipped', `st-${status}`] },
      thumb(info?.icon, TYPE_ICON[info?.type] || 'puzzle'),
      h(
        'div',
        { class: 'cpt-item-main' },
        h('div', { class: 'cpt-item-title' }, h('span', { class: 'ellipsis', title }, title), info?.type ? h('span', { class: 'badge cpt-type' }, typeLabel(info.type)) : null),
        h('div', { class: 'cpt-item-sub' }, entry.skipped ? h('span', { class: 'cpt-skipped-text' }, t('compat.statusSkipped')) : versionSelect(entry, item)),
      ),
      statusPill(status),
      h('button', { class: 'btn sm ghost', 'aria-pressed': String(entry.skipped), disabled: state.preparing, dataset: { fk: `item-skip|${entry.projectId}` }, onclick: () => toggleSkip(entry) }, icon(entry.skipped ? 'undo' : 'x'), entry.skipped ? t('compat.unskip') : t('compat.skip')),
    );
  }

  function titleOf(pid) {
    return resultItem(pid)?.title || state.result.toInstall.find((p) => p.projectId === pid)?.title || pid;
  }

  function planBlock(titleKey, hintKey, rows) {
    if (!rows.length) return null;
    return h('div', { class: 'cpt-plan-block' }, h('div', { class: 'cpt-plan-head' }, h('span', { class: 'cpt-plan-title' }, t(`compat.${titleKey}`)), hintKey ? h('span', { class: 'cpt-plan-hint' }, t(`compat.${hintKey}`)) : null), h('div', { class: 'cpt-plan-list' }, rows));
  }

  function checkRow({ on, onToggle, img, ic, title, sub, label, fk }) {
    const id = `cpt-cb-${fk.replace(/[^\w-]/g, '_')}`;
    return h(
      'div',
      { class: ['cpt-line', on && 'is-on'] },
      h('input', { type: 'checkbox', class: 'cpt-cb', id, checked: on, disabled: state.preparing, dataset: { fk }, onchange: onToggle }),
      thumb(img, ic),
      h('label', { class: 'cpt-line-main', for: id }, h('span', { class: 'cpt-line-title ellipsis', title }, title), sub ? h('span', { class: 'cpt-line-sub ellipsis', title: sub }, sub) : null),
      label ? h('span', { class: 'cpt-line-tag' }, label) : null,
    );
  }

  function buildBody() {
    const res = state.result;
    const active = state.entries.filter((e) => !e.skipped);
    const offered = new Set();
    const tg = res?.target || {};
    const errors = res?.errors || [];
    const warnings = res?.warnings || [];
    const infos = (res?.infos || []).filter((i) => !HIDDEN_INFOS.has(i.code));
    const head = h(
      'div',
      { class: 'cpt-target' },
      h('div', { class: 'cpt-target-icon', 'aria-hidden': 'true' }, icon(target.kind === 'server' ? 'server' : 'layers')),
      h(
        'div',
        { class: 'cpt-target-main' },
        h('div', { class: 'cpt-target-name ellipsis', title: tg.name || '' }, tg.name || ''),
        h('div', { class: 'cpt-target-meta' }, h('span', { class: 'badge' }, icon('box'), `Minecraft ${tg.mcVersion || '?'}`), targetBadge(tg.loader, tg.loaderName)),
      ),
      h(
        'div',
        { class: 'cpt-summary' },
        errors.length ? h('span', { class: 'pill bad' }, icon('shieldAlert'), t('compat.errors', { count: errors.length })) : null,
        warnings.length ? h('span', { class: 'pill warn' }, icon('alert'), t('compat.warnings', { count: warnings.length })) : null,
      ),
    );
    const intro = h('p', { class: 'cpt-intro' }, t('compat.reviewSub', { name: tg.name || '' }));
    if (!active.length) {
      return [head, h('div', { class: 'notice info cpt-notice' }, icon('info'), h('div', {}, t('compat.allSkipped'))), h('section', { class: 'cpt-section' }, h('div', { class: 'cpt-section-title', role: 'heading', 'aria-level': '4' }, t('compat.planTitle')), h('div', { class: 'cpt-plan' }, state.entries.map(itemRow)))];
    }
    const deps = (res?.toInstall || []).filter((p) => p.reason === 'required');
    const sugg = res?.suggestions || [];
    const depRows = deps.map((p) => {
      const name = `${p.title} ${p.versionNumber}`;
      const why = t('compat.reasonRequired', { name: p.requiredBy.map(titleOf).join(', ') });
      return h(
        'div',
        { class: 'cpt-line is-locked' },
        h('span', { class: 'cpt-lock', title: t('compat.depsHint') }, icon('lock')),
        thumb(p.icon, 'puzzle'),
        h('div', { class: 'cpt-line-main' }, h('span', { class: 'cpt-line-title ellipsis', title: name }, name), h('span', { class: 'cpt-line-sub ellipsis', title: why }, why)),
        p.size ? h('span', { class: 'cpt-line-tag' }, fmtBytes(p.size)) : null,
      );
    });
    const suggRows = sugg.map((s) =>
      checkRow({
        on: state.suggestionsOn.has(s.projectId),
        onToggle: () => toggleSet(state.suggestionsOn, s.projectId),
        img: s.icon,
        ic: 'puzzle',
        title: `${s.title} ${s.versionNumber}`,
        sub:
          s.reason === 'fix'
            ? [t('compat.reasonFix', { name: s.requiredBy.map(titleOf).join(', ') }), s.deps?.length ? t('compat.reasonFixDeps', { names: s.deps.map((d) => d.title).join(', ') }) : null].filter(Boolean).join(' · ')
            : t('compat.reasonOptional', { name: s.requiredBy.map(titleOf).join(', ') }),
        label: t('compat.add'),
        fk: `sug|${s.projectId}`,
      }),
    );
    const replaceRows = (res?.replace || []).map((r) =>
      checkRow({ on: !state.replaceOff.has(fileKey(r)), onToggle: () => toggleSet(state.replaceOff, fileKey(r)), img: r.icon, ic: 'archive', title: r.file, sub: r.title, label: t('compat.move'), fk: `repl|${fileKey(r)}` }),
    );
    const enableRows = (res?.enable || []).map((x) => checkRow({ on: !state.enableOff.has(fileKey(x)), onToggle: () => toggleSet(state.enableOff, fileKey(x)), ic: 'power', title: x.title || x.file, sub: x.file, label: t('compat.activate'), fk: `enl|${fileKey(x)}` }));
    return [
      head,
      intro,
      issueGroup('error', errors, offered),
      issueGroup('warning', warnings, offered),
      issueGroup('info', infos, offered),
      h(
        'section',
        { class: 'cpt-section' },
        h('div', { class: 'cpt-section-title', role: 'heading', 'aria-level': '4' }, t('compat.planTitle')),
        h('div', { class: 'cpt-plan' }, state.entries.map(itemRow)),
        planBlock('depsTitle', 'depsHint', depRows),
        planBlock('suggestedTitle', 'suggestedHint', suggRows),
        planBlock('replaceTitle', 'replaceHint', replaceRows),
        planBlock('enableTitle', 'enableHint', enableRows),
      ),
    ];
  }

  function renderFoot() {
    const active = state.entries.filter((e) => !e.skipped);
    const hasErrors = active.length && (state.result?.errors || []).length > 0;
    const status = state.preparing
      ? h('div', { class: 'cpt-foot-status', role: 'status' }, h('div', { class: 'spinner', 'aria-hidden': 'true' }), h('span', {}, t('compat.preparing')))
      : state.busy
        ? h('div', { class: 'cpt-foot-status', role: 'status' }, h('div', { class: 'spinner', 'aria-hidden': 'true' }), h('span', {}, t('compat.rechecking')))
        : h('div', { class: 'cpt-foot-status' });
    const installBtn = h(
      'button',
      { class: ['btn', hasErrors ? 'danger' : 'primary'], disabled: state.busy || state.preparing || !active.length, onclick: confirmInstall },
      icon(hasErrors ? 'alert' : 'download'),
      hasErrors ? t('compat.installAnyway') : t('compat.install'),
    );
    mount(dlg.foot, status, h('button', { class: 'btn ghost', disabled: state.preparing, onclick: () => (dlg.close(), finish(false)) }, t('compat.cancel')), installBtn);
  }

  function render() {
    keepFocus(dlg.el, () => {
      const scroll = dlg.body.scrollTop;
      mount(dlg.body, h('div', { class: 'cpt-review' }, buildBody()));
      dlg.body.scrollTop = scroll;
      renderFoot();
    });
  }

  async function confirmInstall() {
    const res = state.result;
    if (!res || state.busy || state.preparing) return;
    // Aplicar lo elegido a la lista del que llamo: version elegida y sin lo omitido
    for (const e of state.entries) if (!e.skipped && e.userVersion && e.versionId) e.ref.versionId = e.versionId;
    for (let i = items.length - 1; i >= 0; i--) {
      if (state.entries.find((e) => e.ref === items[i])?.skipped) items.splice(i, 1);
    }
    if (!items.length) {
      dlg.close();
      finish(false);
      return;
    }
    const install = (res.suggestions || []).filter((s) => state.suggestionsOn.has(s.projectId)).map((s) => ({ projectId: s.projectId, versionId: s.versionId, type: s.type, title: s.title }));
    const replace = (res.replace || []).filter((r) => !state.replaceOff.has(fileKey(r)));
    const enable = (res.enable || []).filter((x) => !state.enableOff.has(fileKey(x)));
    const adopt = res.adopt || [];
    if (install.length || replace.length || enable.length || adopt.length) {
      state.preparing = true;
      render();
      try {
        const out = await api.invoke('compat:prepare', { target, adopt, replace, enable, install });
        if (out?.failed?.length) toast('info', t('compat.prepareSomeFailed', { names: out.failed.map((f) => f.title).join(', ') }), out.failed[0].error, 8000);
      } catch (err) {
        state.preparing = false;
        render();
        if (!isMissingChannel(err)) {
          const go = await confirmDialog(t('compat.prepareFailed'), t('compat.prepareFailedAsk', { error: err.message }), { okText: t('compat.installAnyway'), cancelText: t('compat.cancel'), danger: true });
          if (!go) return;
        }
      }
    }
    dlg.close();
    finish(true);
  }

  render();
}

// =====================================================================
// Actualizaciones de mods + historial
// =====================================================================

const short = (s) => String(s || '');

function riskVars(r) {
  return { from: r.from || '?', to: r.to || '?', names: (r.names || r.projects || []).join(', ') };
}

function riskBadge(r) {
  return h('span', { class: ['cpt-risk', `lv-${r.level}`], title: t(`compat.risk_${r.code}Text`, riskVars(r)) }, t(`compat.risk_${r.code}`));
}

function riskLine(r) {
  return h(
    'div',
    { class: ['cpt-risk-line', `lv-${r.level}`] },
    riskBadge(r),
    h(
      'div',
      { class: 'cpt-risk-text' },
      h('div', {}, t(`compat.risk_${r.code}Text`, riskVars(r))),
      r.snippet ? h('blockquote', { class: 'cpt-quote selectable' }, r.snippet) : null,
      r.versions?.length ? h('div', { class: 'tiny muted' }, t('compat.riskInVersions', { versions: r.versions.join(', ') })) : null,
    ),
  );
}

export async function openModUpdates(instanceId) {
  try {
    await ready();
  } catch {
    /* seguir */
  }
  const known = store.instances.find((i) => i.id === instanceId);
  const inst = known || (await api.instances.get(instanceId).catch(() => null));
  const name = inst?.name || instanceId;
  const state = {
    tab: 'updates',
    data: null,
    error: null,
    loading: false,
    progress: null,
    selected: new Set(),
    expanded: new Set(),
    filter: 'all',
    includeBeta: undefined,
    applying: null,
    applyError: null,
    history: null,
    historyError: null,
    historyLoading: false,
    busyEntry: null,
  };
  // Mismo encabezado que las demas herramientas de una instancia: icono + titulo + nombre debajo
  const dlg = createDialog({ title: t('compat.updatesHeading'), subtitle: name, icon: 'upCircle', size: 'xwide', body: h('div') });
  const offs = [];
  dlg.cleanup = () => offs.splice(0).forEach((off) => off());

  const running = () => Boolean(store.running[instanceId]);
  const items = () => state.data?.items || [];
  const shown = () => items().filter((i) => state.filter === 'all' || i.type === state.filter);
  const selectedItems = () => items().filter((i) => state.selected.has(i.key));
  const historyCount = () => (state.history?.batches || []).reduce((n, b) => n + b.entries.length, 0);

  try {
    offs.push(
      api.on('compat:progress', (p) => {
        if (p?.instanceId !== instanceId || !state.loading) return;
        state.progress = p;
        const el = dlg.body.querySelector('.cpt-progress-text');
        const bar = dlg.body.querySelector('.cpt-scan .progress');
        if (el) el.textContent = progressText();
        if (bar) {
          const frac = p.total ? p.done / p.total : null;
          bar.classList.toggle('indeterminate', frac === null || p.phase === 'check');
          bar.firstChild.style.width = `${Math.round((frac || 0) * 100)}%`;
        }
      }),
    );
  } catch {
    /* sin eventos de progreso */
  }
  offs.push(
    store.on('task', (task) => {
      if (task.meta?.kind !== 'compat:update' || task.meta?.instanceId !== instanceId) return;
      if (task.state === 'running') {
        state.applying = task;
        renderFoot();
      }
    }),
  );
  offs.push(store.on('running', () => render()));

  function progressText() {
    const p = state.progress;
    if (!p) return t('compat.phaseCheck');
    if (p.phase === 'hash') return t('compat.phaseHash', { done: p.done, total: p.total });
    if (p.phase === 'changelog') return t('compat.phaseChangelog', { done: p.done, total: p.total });
    return t('compat.phaseCheck');
  }

  async function loadUpdates() {
    state.loading = true;
    state.error = null;
    state.progress = null;
    render();
    try {
      const data = await api.invoke('compat:updates', instanceId, state.includeBeta === undefined ? {} : { includeBeta: state.includeBeta });
      state.data = data;
      state.includeBeta = Boolean(data.includeBeta);
      state.selected = new Set(data.items.filter((i) => !i.risks.some((r) => r.code === 'newWorld' || r.code === 'conflict')).map((i) => i.key));
      state.expanded = new Set([...state.expanded].filter((k) => data.items.some((i) => i.key === k)));
    } catch (err) {
      state.error = err.message;
    } finally {
      state.loading = false;
      render();
    }
  }

  async function loadHistory() {
    state.historyLoading = true;
    render();
    try {
      state.history = await api.invoke('compat:history', instanceId);
      state.historyError = null;
    } catch (err) {
      state.historyError = err.message;
    } finally {
      state.historyLoading = false;
      render();
    }
  }

  function switchTab(tab) {
    if (state.tab === tab) return;
    state.tab = tab;
    if (tab === 'history' && !state.history && !state.historyLoading) loadHistory();
    else if (tab === 'updates' && !state.data && !state.loading) loadUpdates();
    else render();
  }

  function tabs() {
    const n = items().length;
    const hc = historyCount();
    const tab = (id, ic, label, count) =>
      h(
        'button',
        { type: 'button', class: ['tab', state.tab === id && 'active'], role: 'tab', id: `cpt-tab-${id}`, tabindex: state.tab === id ? 0 : -1, 'aria-selected': String(state.tab === id), 'aria-controls': 'cpt-upd-panel', dataset: { fk: `tab|${id}`, key: id }, onclick: () => switchTab(id) },
        icon(ic),
        label,
        count ? h('span', { class: 'count' }, String(count)) : null,
      );
    const list = h('div', { class: 'tabs cpt-tabs', role: 'tablist', 'aria-label': t('compat.updatesTitle', { name }) }, tab('updates', 'upCircle', t('compat.tabUpdates'), n), tab('history', 'history', t('compat.tabHistory'), hc));
    tabKeys(list, (id) => {
      switchTab(id);
      dlg.el.querySelector(`[data-fk="tab|${id}"]`)?.focus();
    });
    return list;
  }

  function toggleSelect(key, on) {
    if (on) state.selected.add(key);
    else state.selected.delete(key);
    render();
  }

  function updateRow(it) {
    const checked = state.selected.has(it.key);
    const open = state.expanded.has(it.key);
    const disabled = Boolean(state.applying) || running();
    const detailId = `cpt-detail-${it.key.replace(/[^\w-]/g, '_')}`;
    const cb = h('input', { type: 'checkbox', class: 'cpt-cb', checked, disabled, dataset: { fk: `sel|${it.key}` }, 'aria-label': t('compat.selectItem', { name: it.title }), onchange: (e) => toggleSelect(it.key, e.currentTarget.checked) });
    const risks = [...it.risks].filter((r) => r.level !== 'info').sort((a, b) => LEVEL[b.level] - LEVEL[a.level]);
    const head = h(
      'div',
      { class: 'cpt-row-head' },
      cb,
      thumb(it.icon, TYPE_ICON[it.type] || 'puzzle'),
      h(
        'div',
        { class: 'cpt-row-main' },
        h('div', { class: 'cpt-row-title' }, h('span', { class: 'ellipsis', title: it.title }, it.title), it.type !== 'mod' ? h('span', { class: 'badge cpt-type' }, typeLabel(it.type)) : null, it.disabled ? h('span', { class: 'badge' }, t('compat.disabledBadge')) : null),
        h(
          'div',
          { class: 'cpt-row-sub' },
          h('span', { class: 'cpt-ver cpt-ver-old', title: it.current.versionNumber }, short(it.current.versionNumber)),
          icon('arrowRight'),
          h('span', { class: 'cpt-ver cpt-ver-new', title: it.latest.versionNumber }, short(it.latest.versionNumber)),
          vtBadge(it.latest.type),
          h('span', { class: 'cpt-meta', title: fmtDate(Date.parse(it.latest.date)) }, `${fmtBytes(it.latest.size)} · ${t('compat.publishedAgo', { ago: fmtAgo(Date.parse(it.latest.date)) })}`),
        ),
      ),
      h('div', { class: 'cpt-risks' }, risks.slice(0, 3).map(riskBadge), risks.length > 3 ? h('span', { class: 'cpt-risk lv-low' }, `+${risks.length - 3}`) : null),
      h(
        'button',
        {
          class: ['icon-btn sm cpt-expand', open && 'open'],
          dataset: { fk: `exp|${it.key}` },
          'aria-expanded': String(open),
          'aria-controls': detailId,
          title: t('compat.showChanges', { name: it.title }),
          'aria-label': t('compat.showChanges', { name: it.title }),
          onclick: () => {
            if (open) state.expanded.delete(it.key);
            else state.expanded.add(it.key);
            render();
          },
        },
        icon('chevronDown'),
      ),
    );
    return h('div', { class: ['cpt-row', checked && 'is-selected', open && 'is-open', it.riskLevel && `risk-${it.riskLevel}`] }, head, open ? updateDetail(it, detailId) : null);
  }

  function updateDetail(it, id) {
    const risks = [...it.risks].sort((a, b) => LEVEL[b.level] - LEVEL[a.level]);
    return h(
      'div',
      { class: 'cpt-detail', id },
      risks.length ? h('div', { class: 'cpt-detail-block' }, h('div', { class: 'cpt-detail-title' }, t('compat.risksTitle')), risks.map(riskLine)) : null,
      h(
        'div',
        { class: 'cpt-detail-block' },
        h('div', { class: 'cpt-detail-title' }, t('compat.changesTitle')),
        h(
          'div',
          { class: 'cpt-changelog' },
          it.changelog.map((c) =>
            h(
              'article',
              { class: 'cpt-cl' },
              h('div', { class: 'cpt-cl-head' }, h('span', { class: 'cpt-cl-ver' }, c.number), vtBadge(c.type), h('span', { class: 'muted small' }, fmtDate(Date.parse(c.date)))),
              c.body ? markdown(c.body) : h('div', { class: 'muted small' }, t('compat.noChangelog')),
              c.truncated ? h('div', { class: 'tiny muted' }, t('compat.truncated')) : null,
            ),
          ),
        ),
        it.moreVersions ? h('div', { class: 'small muted cpt-more-versions' }, t('compat.moreVersions', { count: it.moreVersions })) : null,
        it.slug ? h('button', { class: 'btn sm ghost cpt-link', onclick: () => openLink(`https://modrinth.com/project/${encodeURIComponent(it.slug)}/changelog`) }, icon('external'), t('compat.openModrinth')) : null,
      ),
    );
  }

  function updatesToolbar() {
    const list = shown();
    const allOn = list.length > 0 && list.every((i) => state.selected.has(i.key));
    const someOn = list.some((i) => state.selected.has(i.key));
    const all = h('input', {
      type: 'checkbox',
      class: 'cpt-cb',
      id: 'cpt-select-all',
      dataset: { fk: 'select-all' },
      checked: allOn,
      disabled: !list.length || Boolean(state.applying) || running(),
      onchange: (e) => {
        for (const i of list) {
          if (e.currentTarget.checked) state.selected.add(i.key);
          else state.selected.delete(i.key);
        }
        render();
      },
    });
    all.indeterminate = someOn && !allOn;
    const counts = { all: items().length, mod: 0, resourcepack: 0, shader: 0 };
    for (const i of items()) counts[i.type] = (counts[i.type] || 0) + 1;
    const chip = (id, key) =>
      counts[id] || id === 'all'
        ? h('button', { class: ['chip', state.filter === id && 'active'], 'aria-pressed': String(state.filter === id), dataset: { fk: `filter|${id}` }, onclick: () => ((state.filter = id), render()) }, t(`compat.${key}`), h('span', { class: 'cpt-chip-count' }, String(counts[id] || 0)))
        : null;
    const betaSwitch = switchEl(Boolean(state.includeBeta), async (v) => {
      state.includeBeta = v;
      api.invoke('compat:settings', { includeBeta: v }).catch(() => {});
      await loadUpdates();
    }, t('compat.includeBeta'));
    return h(
      'div',
      { class: 'cpt-toolbar' },
      items().length ? h('label', { class: 'cpt-select-all', for: 'cpt-select-all' }, all, h('span', {}, t('compat.selectAll'))) : null,
      items().length > 1 ? h('div', { class: 'chips cpt-filters' }, chip('all', 'filterAll'), chip('mod', 'filterMods'), chip('resourcepack', 'filterPacks'), chip('shader', 'filterShaders')) : null,
      h('span', { class: 'spacer' }),
      h('div', { class: 'cpt-beta' }, betaSwitch, h('span', { 'aria-hidden': 'true' }, t('compat.includeBeta'))),
      h('button', { class: 'icon-btn sm', title: t('compat.refresh'), 'aria-label': t('compat.refresh'), disabled: state.loading || Boolean(state.applying), onclick: loadUpdates }, icon('refresh')),
    );
  }

  function updatesView() {
    if (state.loading) {
      const frac = state.progress?.total ? state.progress.done / state.progress.total : null;
      return h(
        'div',
        { class: 'cpt-scan', role: 'status', 'aria-live': 'polite' },
        h('div', { class: 'spinner lg', 'aria-hidden': 'true' }),
        h('div', { class: 'cpt-scan-title' }, t('compat.scanning')),
        h('div', { class: 'cpt-progress-text' }, progressText()),
        h('div', { class: ['progress', (frac === null || state.progress?.phase === 'check') && 'indeterminate'], role: 'progressbar', 'aria-label': t('compat.scanning') }, h('i', { style: { width: `${Math.round((frac || 0) * 100)}%` } })),
      );
    }
    if (state.error) return h('div', { class: 'cpt-error', role: 'alert' }, emptyState('alert', t('compat.loadFailed'), state.error, h('button', { class: 'btn', type: 'button', onclick: loadUpdates }, icon('refresh'), t('compat.retry'))));
    if (!state.data) return null;
    const d = state.data;
    const notes = [
      running() ? h('div', { class: 'notice cpt-notice' }, icon('alert'), h('div', {}, t('compat.gameRunning'))) : null,
      state.applyError ? h('div', { class: 'notice bad cpt-notice', role: 'alert' }, icon('alert'), h('div', {}, state.applyError)) : null,
    ];
    const footNotes = [
      d.unknown ? h('div', { class: 'cpt-footnote' }, icon('info'), h('span', {}, t('compat.unknownFiles', { count: d.unknown }))) : null,
      d.prereleaseHidden && !state.includeBeta ? h('div', { class: 'cpt-footnote' }, icon('info'), h('span', {}, t('compat.prereleaseHidden', { count: d.prereleaseHidden }))) : null,
    ];
    if (!d.items.length) {
      return [updatesToolbar(), notes, h('div', { class: 'cpt-empty is-good' }, emptyState('shieldCheck', t('compat.upToDate'), t('compat.upToDateText', { mc: d.instance?.mcVersion || '' }))), footNotes];
    }
    return [
      updatesToolbar(),
      notes,
      h('div', { class: 'notice info cpt-notice' }, icon('shield'), h('div', {}, t('compat.safetyNote'))),
      h('div', { class: 'cpt-list' }, shown().map(updateRow)),
      footNotes,
    ];
  }

  // ---------- Historial ----------
  const verOf = (side) => side?.versionNumber || side?.file || t('compat.unknownVersion');

  async function rollbackEntry(e) {
    state.busyEntry = e.id;
    render();
    try {
      const out = await api.invoke('compat:rollback', instanceId, e.id);
      const ne = out?.entry;
      if (ne?.new) ok(t('compat.rollbackDone'), t('compat.rollbackDoneText', { name: e.title, version: verOf(ne.new) }));
      else ok(t('compat.rollbackDone'), t('compat.rollbackRemovedText', { name: e.title }));
      state.data = null;
      store.refreshInstances?.().catch?.(() => {});
    } catch (err) {
      toast('bad', t('compat.rollbackFailed'), err.message, 7000);
    } finally {
      state.busyEntry = null;
      await loadHistory();
    }
  }

  function entryRow(e) {
    const type = FOLDER_TYPE[e.folder] || 'mod';
    const change = e.old && e.new ? t('compat.entryChange', { from: verOf(e.old), to: verOf(e.new) }) : e.new ? t('compat.entryAdded', { version: verOf(e.new) }) : t('compat.entryRemoved', { version: verOf(e.old) });
    let action;
    if (e.rolledBack) action = h('span', { class: 'pill' }, icon('undo'), t('compat.rolledBack'));
    else if (!e.available) action = h('span', { class: 'pill' }, t('compat.unavailable'));
    else {
      const [label, tip, ic] = e.old && e.new && e.kind === 'rollback' ? [t('compat.redo'), t('compat.redoTitle', { version: verOf(e.old) }), 'refresh'] : e.old && e.new ? [t('compat.rollback'), t('compat.rollbackTitle', { version: verOf(e.old) }), 'undo'] : e.old ? [t('compat.restore'), t('compat.restoreTitle', { name: e.title }), 'undo'] : [t('compat.removeAdded'), t('compat.removeAddedTitle', { name: e.title }), 'trash'];
      const busy = state.busyEntry === e.id;
      // Revirtiendo: spinner en lugar del icono (mismo estilo que setBusy de ui.js)
      action = h('button', { type: 'button', class: ['btn sm', busy && 'loading'], title: tip, 'aria-label': tip, 'aria-busy': busy ? 'true' : null, dataset: { fk: `rb|${e.id}` }, disabled: Boolean(state.busyEntry) || running(), onclick: () => rollbackEntry(e) }, icon(ic), label);
    }
    const entryTitle = e.title || e.new?.file || e.old?.file;
    return h(
      'div',
      { class: ['cpt-entry', e.rolledBack && 'is-done'] },
      thumb(e.icon, TYPE_ICON[type]),
      h('div', { class: 'cpt-entry-main' }, h('div', { class: 'cpt-entry-title' }, h('span', { class: 'ellipsis', title: entryTitle }, entryTitle), h('span', { class: 'badge cpt-kind' }, t(`compat.kind_${e.kind}`))), h('div', { class: 'cpt-entry-sub', title: change }, change)),
      action,
    );
  }

  function historyView() {
    // Cargando: la forma de un lote del historial
    if (state.historyLoading && !state.history) return h('div', { class: 'cpt-batch cpt-batch-skel' }, h('div', { class: 'cpt-batch-head' }, skeleton('line', { width: '40%', label: t('compat.tabHistory') })), skeleton('list', { rows: 3 }));
    if (state.historyError) return h('div', { class: 'cpt-error', role: 'alert' }, emptyState('alert', t('compat.historyLoadFailed'), state.historyError, h('button', { class: 'btn', type: 'button', onclick: loadHistory }, icon('refresh'), t('compat.retry'))));
    const hist = state.history;
    if (!hist) return null;
    const batches = hist.batches.filter((b) => b.entries.length);
    // Sin cambios guardados no hay nada que abrir ni vaciar: solo el estado vacio
    if (!batches.length) return [h('div', { class: 'cpt-empty' }, emptyState('history', t('compat.historyEmpty'), t('compat.historyEmptyText')))];
    const head = h(
      'div',
      { class: 'cpt-toolbar' },
      h('span', { class: 'cpt-history-size' }, t('compat.historySize', { size: fmtBytes(hist.size || 0) })),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn sm', type: 'button', onclick: () => api.instances.openFolder(instanceId, '.venus/mod-history').catch(() => {}) }, icon('folder'), t('compat.openFolder')),
      h(
        'button',
        {
          class: 'btn sm danger',
          type: 'button',
          disabled: running(),
          onclick: async () => {
            if (!(await confirmDialog(t('compat.clearHistory'), t('compat.clearHistoryConfirm'), { okText: t('compat.clearHistory'), cancelText: t('compat.cancel'), danger: true }))) return;
            try {
              await api.invoke('compat:clearHistory', instanceId);
              ok(t('compat.clearHistoryDone'));
            } catch (err) {
              toast('bad', t('compat.historyLoadFailed'), err.message);
            }
            loadHistory();
          },
        },
        icon('trash'),
        t('compat.clearHistory'),
      ),
    );
    return [
      head,
      running() ? h('div', { class: 'notice cpt-notice' }, icon('alert'), t('compat.gameRunning')) : null,
      h(
        'div',
        { class: 'cpt-history' },
        batches.map((b) =>
          h(
            'section',
            { class: 'cpt-batch' },
            h('div', { class: 'cpt-batch-head' }, icon(b.reason === 'rollback' ? 'undo' : b.reason === 'install' ? 'download' : 'upCircle'), h('span', { class: 'cpt-batch-title' }, t(`compat.reason_${b.reason}`)), h('span', { class: 'muted small' }, `${fmtDate(b.createdAt)} · ${fmtTime(b.createdAt)}`)),
            h('div', { class: 'cpt-batch-list' }, b.entries.map(entryRow)),
          ),
        ),
      ),
    ];
  }

  async function applySelected() {
    const sel = selectedItems().map((i) => ({ folder: i.folder, file: i.file, versionId: i.latest.versionId }));
    if (!sel.length || state.applying || running()) return;
    state.applying = { state: 'running', progress: null, detail: t('compat.updating') };
    state.applyError = null;
    render();
    try {
      const out = await api.invoke('compat:applyUpdates', instanceId, sel);
      if (out?.updated) ok(t('compat.updateDone'), t('compat.updateDoneText', { count: out.updated }));
      if (out?.failed?.length) toast('bad', t('compat.updatePartial', { count: out.failed.length, names: out.failed.map((f) => f.file).join(', ') }), out.failed[0].error, 9000);
      state.applying = null;
      state.history = null;
      store.refreshInstances?.().catch?.(() => {});
      await loadUpdates();
    } catch (err) {
      // La tarea fallida ya avisa con su propio toast: aca se muestra el detalle en la ventana
      state.applying = null;
      state.applyError = `${t('compat.updateFailed')}: ${err.message}`;
      render();
    }
  }

  function renderFoot() {
    const closeBtn = h('button', { class: 'btn ghost', onclick: () => dlg.close() }, t('compat.close'));
    if (state.tab !== 'updates') {
      mount(dlg.foot, h('div', { class: 'cpt-foot-status' }), closeBtn);
      return;
    }
    const sel = selectedItems();
    let status;
    if (state.applying) {
      const pct = state.applying.progress === null || state.applying.progress === undefined ? null : Math.round(state.applying.progress * 100);
      status = h(
        'div',
        { class: 'cpt-foot-status cpt-applying', role: 'status' },
        h('div', { class: 'spinner' }),
        h('div', { class: 'cpt-applying-main' }, h('div', { class: 'ellipsis', title: state.applying.detail || '' }, state.applying.detail || t('compat.updating')), h('div', { class: ['progress', pct === null && 'indeterminate'], role: 'progressbar', 'aria-label': t('compat.updating'), 'aria-valuenow': pct === null ? null : pct }, h('i', { style: { width: `${pct || 0}%` } }))),
      );
    } else if (state.data?.items.length) {
      status = h('div', { class: 'cpt-foot-status', role: 'status' }, h('span', {}, sel.length ? t('compat.selected', { count: sel.length, size: fmtBytes(sel.reduce((n, i) => n + (i.latest.size || 0), 0)) }) : t('compat.noneSelected')));
    } else status = h('div', { class: 'cpt-foot-status' });
    const updateBtn = state.data?.items.length
      ? h(
          'button',
          { type: 'button', class: ['btn primary', state.applying && 'loading'], 'aria-busy': state.applying ? 'true' : null, disabled: !sel.length || Boolean(state.applying) || state.loading || running(), onclick: applySelected },
          icon('download'),
          state.applying ? t('compat.updating') : t('compat.updateSelected'),
        )
      : null;
    mount(dlg.foot, status, closeBtn, updateBtn);
  }

  function render() {
    keepFocus(dlg.el, () => {
      const scroll = dlg.body.scrollTop;
      mount(dlg.body, h('div', { class: 'cpt-upd' }, h('div', { class: 'cpt-upd-top' }, tabs(), inst ? h('div', { class: 'cpt-upd-meta' }, h('span', { class: 'badge' }, icon('box'), `Minecraft ${inst.mcVersion}`), targetBadge(inst.loader)) : null), h('div', { class: 'cpt-upd-body', role: 'tabpanel', id: 'cpt-upd-panel', 'aria-labelledby': `cpt-tab-${state.tab}` }, state.tab === 'updates' ? updatesView() : historyView())));
      dlg.body.scrollTop = scroll;
      renderFoot();
    });
  }

  render();
  loadUpdates();
  // El contador del historial se carga aparte para mostrarlo en la pestaña
  api
    .invoke('compat:history', instanceId)
    .then((hist) => {
      if (!state.history) {
        state.history = hist;
        render();
      }
    })
    .catch(() => {});
}
