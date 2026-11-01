// Estado de los servicios: dice si un problema es la conexión del jugador o un servicio caído (Microsoft/Xbox,
// Mojang, Modrinth, CurseForge o Venus). Nunca consulta por su cuenta: solo cuando el usuario abre el panel o
// justo después de que falló iniciar sesión (y entonces solo los servicios de esa acción). Contratos:
//  - openServiceStatus({ focus?, failed? })   panel completo. focus: 'connection', 'login', 'downloads', 'content' o
//                                    'venus'; failed: { ids, at } servicios que el error ya vio fallar de su lado
//                                    (durante 2 minutos se muestran caídos aunque ahora contesten)
//  - mountVerdict(slot, { source: 'login', code?, text?, ids?, token? })   veredicto corto después de un error
//                                    (comprueba solo si el error lo amerita; si el error ya prueba que un servicio falló
//                                    de su lado, lo dice sin consultar; con ids consulta esos servicios sin clasificar;
//                                    con el mismo token no vuelve a consultar al redibujar)
//  - statusButton({ ids?, focus?, label?, cls?, failed? }) -> botón que abre el panel (con el grupo de esos servicios
//                                    marcado; failed: ids que el error ya vio fallar de su lado)
//  - taskHint(el, task)              botón "Ver estado de los servicios" en una tarea que falló por la red
//  - statusCard() -> Element         tarjeta de Ajustes → Descargas y almacenamiento (con .destroy())
//  - startup()                       comando en la paleta (Ctrl+K); se puede llamar más de una vez
// Canales: svcstatus:check y svcstatus:classify (src/main/modules/svcstatus.js).
import { h, icon, mount, modal, ensureCss, setBusy } from '../ui.js';
import { api } from '../store.js';
import { t, loadNs, locale } from '../i18n.js';
import { navigate } from '../app.js';

const GROUPS = [
  { id: 'connection', icon: 'wifi', ids: ['internet'] },
  { id: 'login', icon: 'logIn', ids: ['microsoft', 'xbox', 'minecraftServices'] },
  { id: 'downloads', icon: 'download', ids: ['mojangMeta', 'mojangLibraries', 'mojangAssets'] },
  { id: 'content', icon: 'package', ids: ['modrinth', 'curseforge'] },
  { id: 'venus', icon: 'cloud', ids: ['venus'] },
];
const GROUP_IDS = GROUPS.map((g) => g.id);
// Dos columnas de alto parecido: lo tuyo (conexión, sesión y Venus) | lo del juego (descargas y contenido).
const COLUMNS = [
  ['connection', 'login', 'venus'],
  ['downloads', 'content'],
];
// Nombres cortos para las frases del veredicto (son marcas: no se traducen).
const BRAND = {
  microsoft: 'Microsoft',
  xbox: 'Xbox Live',
  minecraftServices: 'Minecraft',
  mojangMeta: 'Mojang',
  mojangLibraries: 'Mojang',
  mojangAssets: 'Mojang',
  modrinth: 'Modrinth',
  curseforge: 'CurseForge',
  venus: 'Venus',
};
const TONE = { ok: 'good', offline: 'info', internet: 'bad', dns: 'bad', tls: 'bad', blocked: 'bad', down: 'bad', slow: 'warn', internetSlow: 'warn' };
const VERDICT_ICON = { ok: 'check', offline: 'wifiOff', internet: 'wifiOff', dns: 'globe', tls: 'shieldAlert', blocked: 'shieldAlert', down: 'alert', slow: 'clock', internetSlow: 'clock' };
const STATE_ICON = { ok: 'check', slow: 'clock', down: 'alert', skipped: 'ban', none: 'ban' };
const PILL = { ok: 'good', slow: 'warn', down: 'bad' };
const KINDS = Object.keys(TONE);
const REASONS = ['timeout', 'dns', 'refused', 'reset', 'unreachable', 'tls', 'network', 'http', 'failed'];
const SERVICE_IDS = GROUPS.flatMap((g) => g.ids);
// Lo que el launcher vio fallar de su lado (un 5xx al iniciar sesión o en una descarga) vale para el panel por 2 minutos.
const FAILED_MS = 120000;

// { ids, at } con ids conocidos (sin la prueba de conexión) o null.
function failedEvidence(f) {
  const ids = f && Array.isArray(f.ids) ? [...new Set(f.ids.filter((id) => SERVICE_IDS.includes(id) && id !== 'internet'))].slice(0, 10) : [];
  return ids.length ? { ids, at: Number.isFinite(f.at) ? f.at : Date.now() } : null;
}

// ---------- Estado compartido ----------
let lastSummary = null; // último resultado de esta sesión (lo muestra la tarjeta de Ajustes)
const summaryListeners = new Set();
function remember(summary) {
  if (!summary || typeof summary !== 'object') return;
  lastSummary = summary;
  for (const fn of summaryListeners) {
    try {
      fn(summary);
    } catch (err) {
      console.warn('[svcstatus]', err);
    }
  }
}
function onSummary(fn) {
  summaryListeners.add(fn);
  return () => summaryListeners.delete(fn);
}

async function ensureUi() {
  ensureCss('features/svcstatus');
  await loadNs('svcstatus');
  startup();
}

// ---------- Formatos y textos ----------
const capKind = (kind) => kind.charAt(0).toUpperCase() + kind.slice(1);
const validKind = (v) => (v && KINDS.includes(v.kind) ? v : { kind: 'ok', ids: [] });

function fmtMs(ms) {
  const n = Math.max(0, Number(ms) || 0);
  if (n < 1000) return t('svcstatus.msValue', { ms: Math.round(n) });
  const seconds = new Intl.NumberFormat(locale(), { maximumFractionDigits: 1 }).format(n / 1000);
  return t('svcstatus.secValue', { seconds });
}

function fmtClock(ts) {
  try {
    return new Date(ts).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '';
  }
}

// "Microsoft y Xbox Live", "Mojang" (los tres servicios de Mojang cuentan como uno)
function brandsOf(ids) {
  return [...new Set((ids || []).map((id) => BRAND[id]).filter(Boolean))];
}
function namesOf(ids) {
  const names = brandsOf(ids);
  try {
    return new Intl.ListFormat(locale(), { style: 'long', type: 'conjunction' }).format(names);
  } catch {
    return names.join(', ');
  }
}

// part: 'Title', 'Text' o 'Short'. Los de servicios caídos o lentos nombran a quién (con plural).
function verdictText(v, part) {
  const { kind, ids } = validKind(v);
  const key = `svcstatus.v${capKind(kind)}${part}`;
  if ((kind === 'down' || kind === 'slow') && part !== 'Text') return t(key, { names: namesOf(ids), count: Math.max(1, brandsOf(ids).length) });
  return t(key);
}

function rowSub(id, res) {
  if (!res) return t(`svcstatus.svcSub_${id}`);
  // Cloudflare no contestó, pero otros servicios sí: tu conexión anda.
  if (res.inferred && res.state === 'ok') return t('svcstatus.inetInferred');
  if (res.state === 'down') return REASONS.includes(res.reason) ? t(`svcstatus.reason_${res.reason}`, { status: res.httpStatus || '' }) : t('svcstatus.reason_network');
  if (res.state === 'slow') return t('svcstatus.reasonSlow', { time: fmtMs(res.ms) });
  if (res.state === 'skipped' && ['noKey', 'notConfigured', 'offline'].includes(res.reason)) return t(`svcstatus.skip_${res.reason}`);
  return t(`svcstatus.svcSub_${id}`);
}

// ---------- Panel ----------
let panel = null; // un solo panel a la vez
let opening = false; // un doble clic no abre dos

// failed (opcional): { ids, at } servicios que el error acaba de ver fallar de su lado. La consulta de ahora puede
// contestar bien igual (la raíz anda y lo de atrás no): el panel los muestra caídos para no contradecir al error.
export async function openServiceStatus({ focus = null, failed = null } = {}) {
  const focusId = GROUP_IDS.includes(focus) ? focus : null;
  const evidence = failedEvidence(failed);
  if (panel) {
    panel.focusGroup(focusId);
    if (evidence) panel.setFailed(evidence);
    return;
  }
  if (opening) return;
  opening = true;
  try {
    await ensureUi();
  } catch (err) {
    console.warn('[svcstatus]', err?.message || err);
    return;
  } finally {
    opening = false;
  }
  if (panel) {
    panel.focusGroup(focusId);
    if (evidence) panel.setFailed(evidence);
    return;
  }
  let closed = false;
  let busy = false;
  let summary = null;
  let waitTimer = null;
  let failedNow = evidence;
  const groupEls = new Map();

  const verdictBox = h('div', { class: 'svc-verdict-slot', 'aria-live': 'polite' });
  for (const g of GROUPS) {
    const list = h('ul', { class: 'svc-rows' });
    const badge = h('span', { class: 'badge accent svc-focus-badge', hidden: true }, t('svcstatus.focusBadge'));
    const el = h(
      'section',
      { class: 'svc-group', dataset: { group: g.id }, 'aria-labelledby': `svc-g-${g.id}` },
      h('h4', { class: 'svc-group-head' }, icon(g.icon), h('span', { id: `svc-g-${g.id}`, class: 'svc-group-title' }, t(`svcstatus.group_${g.id}`)), badge),
      list,
    );
    groupEls.set(g.id, { el, list, badge, group: g });
  }
  const cols = h('div', { class: 'svc-cols' }, COLUMNS.map((col) => h('div', { class: 'svc-col' }, col.map((id) => groupEls.get(id).el))));
  const when = h('span', { class: 'svc-when' });
  const recheck = h('button', { type: 'button', class: 'btn primary svc-recheck', onclick: () => run() }, icon('refresh'), t('svcstatus.recheck'));
  const body = h('div', { class: 'svc-panel' }, verdictBox, cols, h('p', { class: 'svc-privacy' }, icon('shieldCheck'), h('span', {}, t('svcstatus.privacyNote'))));

  const m = modal({
    title: t('svcstatus.title'),
    subtitle: t('svcstatus.subtitle'),
    icon: 'activity',
    size: 'wide',
    body,
    footer: [when, recheck],
    onClose: () => {
      closed = true;
      clearInterval(waitTimer);
      panel = null;
    },
  });
  m.el.classList.add('svc-modal');

  function focusGroup(id) {
    for (const [gid, g] of groupEls) {
      const on = gid === id;
      g.el.classList.toggle('is-focus', on);
      g.badge.hidden = !on;
    }
    if (id) requestAnimationFrame(() => groupEls.get(id)?.el.scrollIntoView({ block: 'nearest' }));
  }

  // kind: veredicto. Si la causa es general (sin internet, DNS, certificados, red bloqueada o modo sin conexión),
  // cada fila muestra para qué sirve en vez de repetir el mismo motivo: lo explica el aviso de arriba.
  function paintRows(results, pending, kind = null) {
    const byId = new Map((results || []).map((r) => [r.id, r]));
    const general = ['offline', 'internet', 'dns', 'tls', 'blocked'].includes(kind);
    for (const { list, group } of groupEls.values()) {
      mount(
        list,
        group.ids.map((id) => {
          const res = byId.get(id) || null;
          const st = pending ? 'pending' : res ? res.state : 'none';
          const shown = st === 'skipped' && res?.reason === 'offline' ? 'none' : st;
          const plain = pending || (general && id !== 'internet' && (st === 'down' || res?.reason === 'offline'));
          const sub = rowSub(id, plain ? null : res);
          // Código técnico (ENOTFOUND, CERT_HAS_EXPIRED...) para soporte; el 5xx y el tiempo agotado ya los dice el texto.
          const code = !plain && st === 'down' && res?.detail && !['network', 'timeout'].includes(res.detail) && res.reason !== 'http' ? res.detail : null;
          return h(
            'li',
            { class: ['svc-row', `is-${shown}`, plain && 'is-plain', !plain && res?.inferred && 'is-inferred'] },
            h('span', { class: 'svc-row-icon', 'aria-hidden': 'true' }, st === 'pending' ? h('span', { class: 'spinner' }) : icon(STATE_ICON[shown] || 'ban')),
            h(
              'div',
              { class: 'svc-row-main' },
              h('div', { class: 'svc-row-name', title: t(`svcstatus.svc_${id}`) }, t(`svcstatus.svc_${id}`)),
              h('div', { class: 'svc-row-sub', title: code ? `${sub} (${code})` : sub }, sub, code ? h('span', { class: 'svc-code' }, code) : null),
            ),
            h(
              'div',
              { class: 'svc-row-side' },
              h('span', { class: ['pill', PILL[shown], 'svc-pill'] }, t(`svcstatus.state_${shown}`)),
              (st === 'ok' || st === 'slow') && Number.isFinite(res?.ms) ? h('span', { class: 'svc-ms' }, fmtMs(res.ms)) : null,
            ),
          );
        }),
      );
    }
  }

  function verdictNotice(v) {
    const kind = validKind(v).kind;
    const tone = TONE[kind];
    const actions = [];
    if (kind === 'offline' && !document.body.classList.contains('onboarding')) {
      actions.push(
        h(
          'button',
          {
            type: 'button',
            class: 'btn sm primary',
            onclick: () => {
              m.close();
              navigate('settings/storage/downloads');
            },
          },
          icon('settings'),
          t('svcstatus.goToDownloads'),
        ),
      );
    }
    return h(
      'div',
      { class: ['notice', tone !== 'warn' && tone, 'svc-verdict'] },
      icon(VERDICT_ICON[kind]),
      h(
        'div',
        { class: 'svc-verdict-body' },
        h('div', { class: 'svc-verdict-title' }, verdictText(v, 'Title')),
        h('div', { class: 'svc-verdict-text' }, verdictText(v, 'Text')),
        actions.length ? h('div', { class: 'svc-verdict-actions' }, actions) : null,
      ),
    );
  }

  function paintWhen() {
    clearInterval(waitTimer);
    if (!summary) {
      mount(when);
      recheck.removeAttribute('aria-disabled');
      recheck.removeAttribute('title');
      return;
    }
    const tick = () => {
      const left = Math.ceil(((summary.nextCheckAt || 0) - Date.now()) / 1000);
      const time = fmtClock(summary.checkedAt);
      if (left > 0 && !summary.offlineMode) {
        const text = t('svcstatus.checkedAtWait', { time, seconds: left });
        mount(when, text);
        recheck.setAttribute('aria-disabled', 'true');
        recheck.title = text;
        return true;
      }
      mount(when, t('svcstatus.checkedAt', { time }));
      recheck.removeAttribute('aria-disabled');
      recheck.removeAttribute('title');
      return false;
    };
    if (tick()) {
      waitTimer = setInterval(() => {
        if (closed || !tick()) clearInterval(waitTimer);
      }, 1000);
    }
  }

  async function run() {
    if (busy || closed || recheck.getAttribute('aria-disabled') === 'true') return;
    busy = true;
    const done = setBusy(recheck);
    paintRows(null, true);
    mount(verdictBox, h('div', { class: 'notice info svc-verdict svc-checking' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('div', { class: 'svc-verdict-body' }, h('div', { class: 'svc-verdict-title' }, t('svcstatus.checking')))));
    try {
      const fresh = failedNow && Date.now() - failedNow.at < FAILED_MS;
      const s = await api.invoke('svcstatus:check', fresh ? { failed: failedNow.ids } : {});
      if (closed) return;
      summary = s;
      remember(s);
      const kind = validKind(s.verdict).kind;
      paintRows(s.results, false, kind);
      mount(verdictBox, verdictNotice(s.verdict));
      // Con el modo sin conexión, lo principal es ir a desactivarlo (un solo botón primario por vista).
      recheck.classList.toggle('primary', kind !== 'offline' || document.body.classList.contains('onboarding'));
    } catch (err) {
      console.warn('[svcstatus] check', err?.message || err);
      if (closed) return;
      summary = null;
      paintRows(null, false);
      recheck.classList.add('primary');
      mount(verdictBox, h('div', { class: 'notice bad svc-verdict' }, icon('alert'), h('div', { class: 'svc-verdict-body' }, h('div', { class: 'svc-verdict-title' }, t('svcstatus.errorTitle')), h('div', { class: 'svc-verdict-text' }, t('svcstatus.errorText')))));
    } finally {
      busy = false;
      done();
      if (!closed) paintWhen();
    }
  }

  panel = {
    focusGroup,
    setFailed: (ev) => {
      failedNow = ev;
    },
  };
  paintRows(null, true);
  focusGroup(focusId);
  run();
}

// ---------- Botón y pistas para otros lugares ----------
// Grupo del panel para una lista de ids de servicios (el del primero que se conozca).
function focusForIds(ids) {
  for (const id of Array.isArray(ids) ? ids : []) {
    const g = GROUPS.find((gr) => gr.ids.includes(id));
    if (g) return g.id;
  }
  return null;
}

// ids (opcional): servicios involucrados; el panel abre con su grupo marcado (focus manda si vienen los dos).
// failed (opcional): ids que el error ya vio fallar de su lado (known de svcstatus:classify).
export function statusButton({ ids = null, focus = null, label = null, cls = 'btn sm tonal svc-status-btn', failed = null } = {}) {
  const target = GROUP_IDS.includes(focus) ? focus : focusForIds(ids);
  const evidence = failedEvidence({ ids: failed, at: Date.now() });
  return h('button', { type: 'button', class: cls, onclick: () => openServiceStatus({ focus: target, failed: evidence }) }, icon('activity'), label || t('svcstatus.openPanel'));
}

// Veredicto corto (una línea) con enlace al panel (link: false en la tarjeta de Ajustes, que ya tiene su botón).
function inlineVerdict(summary, focus, { link = true, failed = null } = {}) {
  const v = validKind(summary?.verdict);
  const tone = TONE[v.kind];
  return h(
    'div',
    { class: ['svc-inline', `is-${tone}`], role: 'status' },
    icon(VERDICT_ICON[v.kind]),
    h('span', { class: 'svc-inline-text' }, verdictText(v, 'Short')),
    link ? h('button', { type: 'button', class: 'svc-link', onclick: () => openServiceStatus({ focus, failed }) }, t('svcstatus.openPanel'), icon('chevronRight')) : null,
  );
}

const inlineJobs = new Map(); // token -> trabajo (para no volver a consultar si la vista se redibuja)

// Primero se clasifica el error (local, sin red); solo si lo amerita se consultan los servicios de esa acción.
// Con ids (los servicios que usó la acción que falló) no hace falta clasificar: se consultan esos.
function startInline({ source, code, text, ids }) {
  const job = { done: false, cls: null, summary: null };
  job.cls = ids
    ? Promise.resolve({ network: true, offline: false, autoCheck: true, ids, focus: focusForIds(ids) })
    : api.invoke('svcstatus:classify', { source, code, text });
  job.summary = job.cls
    .then(async (cls) => {
      if (!cls?.autoCheck) return null;
      const summary = await api.invoke('svcstatus:check', { ids: cls.ids, connectivity: 'auto' });
      remember(summary);
      return summary;
    })
    .finally(() => {
      job.done = true;
    });
  job.summary.catch(() => {});
  return job;
}

// El hueco recuerda qué error está mostrando (data-svc-token): si quien lo puso lo borra (otro intento de iniciar
// sesión) o lo reusa para otro error, un resultado viejo que llega tarde no se dibuja.
export async function mountVerdict(slot, { source = 'login', code = null, text = null, ids = null, token = null } = {}) {
  if (!(slot instanceof Element)) return;
  const validIds = new Set(GROUPS.flatMap((g) => g.ids));
  const svcIds = Array.isArray(ids) ? [...new Set(ids.filter((id) => validIds.has(id)))] : [];
  const key = token ? String(token) : `${source}:${code || ''}:${svcIds.join(',')}:${Date.now()}`;
  slot.dataset.svcToken = key;
  const current = () => slot.dataset.svcToken === key;
  const hide = () => {
    if (!current()) return;
    mount(slot);
    slot.hidden = true;
  };
  try {
    await ensureUi();
  } catch (err) {
    console.warn('[svcstatus]', err?.message || err);
    hide();
    return;
  }
  let job = inlineJobs.get(key);
  if (!job) {
    job = startInline({ source: source === 'task' ? 'task' : 'login', code: typeof code === 'string' ? code : null, text: typeof text === 'string' ? text : null, ids: svcIds.length ? svcIds : null });
    inlineJobs.set(key, job);
    while (inlineJobs.size > 8) inlineJobs.delete(inlineJobs.keys().next().value);
  }
  let cls = null;
  let summary = null;
  try {
    cls = await job.cls;
    // El error ya prueba qué servicio falló de su lado (por ejemplo, un 503 de Microsoft): no se consulta nada y
    // el veredicto no contradice al error ("Todo responde bien" justo abajo de "Microsoft no responde").
    const known = cls?.known && cls.known.kind === 'down' && brandsOf(cls.known.ids).length ? cls.known : null;
    if (known) {
      if (!current()) return;
      slot.hidden = false;
      mount(slot, inlineVerdict({ verdict: { kind: 'down', ids: known.ids } }, cls.focus || 'login', { failed: failedEvidence({ ids: known.ids, at: Date.now() }) }));
      return;
    }
    if (!cls?.autoCheck) {
      hide();
      return;
    }
    if (!job.done && current()) {
      slot.hidden = false;
      mount(slot, h('div', { class: 'svc-inline is-info', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('span', { class: 'svc-inline-text' }, t('svcstatus.inlineChecking'))));
    }
    summary = await job.summary;
  } catch (err) {
    console.warn('[svcstatus] verdict', err?.message || err);
    summary = null;
  }
  if (!summary) {
    hide();
    return;
  }
  if (!current()) return;
  slot.hidden = false;
  mount(slot, inlineVerdict(summary, cls?.focus || 'login'));
}

// Panel de tareas: una tarea que terminó con un error de red o de descarga suma el botón del panel.
export async function taskHint(el, task) {
  if (!(el instanceof Element) || !task || el.querySelector('.svc-task-hint')) return;
  let cls = null;
  try {
    cls = await api.invoke('svcstatus:classify', { source: 'task', text: String(task.detail || '').slice(0, 2000) });
  } catch (err) {
    console.warn('[svcstatus] classify', err?.message || err);
    return;
  }
  if (!cls?.network || !el.isConnected || el.querySelector('.svc-task-hint')) return;
  try {
    await ensureUi();
  } catch {
    return;
  }
  if (!el.isConnected || el.querySelector('.svc-task-hint')) return;
  // Un "HTTP 5xx en <url>" de la tarea viaja al panel: ese servicio falló de su lado aunque ahora conteste.
  const failed = cls.known?.kind === 'down' && Array.isArray(cls.known.ids) ? cls.known.ids : null;
  el.append(h('div', { class: 'svc-task-hint' }, statusButton({ focus: cls.focus || 'downloads', failed })));
}

// ---------- Ajustes → Descargas y almacenamiento ----------
export function statusCard() {
  ensureCss('features/svcstatus');
  startup();
  const titleId = 'svc-card-title';
  const last = h('div', { class: 'svc-card-last' });
  const paintLast = () => {
    if (!lastSummary) {
      mount(last);
      last.hidden = true;
      return;
    }
    last.hidden = false;
    mount(last, h('div', { class: 'svc-card-when' }, t('svcstatus.cardLast', { time: fmtClock(lastSummary.checkedAt) })), inlineVerdict(lastSummary, null, { link: false }));
  };
  const el = h(
    'section',
    { class: 'card svc-card', 'aria-labelledby': titleId },
    h(
      'div',
      { class: 'svc-card-head' },
      h('div', { class: 'svc-card-icon', 'aria-hidden': 'true' }, icon('activity')),
      h('div', { class: 'svc-card-text' }, h('h3', { class: 'svc-card-title', id: titleId }, t('svcstatus.cardTitle')), h('p', { class: 'svc-card-sub' }, t('svcstatus.cardSub'))),
      h('button', { type: 'button', class: 'btn tonal svc-card-btn', onclick: () => openServiceStatus() }, icon('activity'), t('svcstatus.cardCheck')),
    ),
    last,
  );
  const off = onSummary(paintLast);
  el.destroy = () => off();
  paintLast();
  return el;
}

// ---------- Paleta de comandos ----------
let started = false;
export function startup() {
  if (started) return;
  started = true;
  (async () => {
    await loadNs('svcstatus');
    const { registerCommands } = await import('../a11y.js');
    registerCommands(() => [
      {
        id: 'svcstatus.open',
        title: t('svcstatus.cmdTitle'),
        sub: t('svcstatus.cmdSub'),
        group: 'actions',
        icon: 'activity',
        keywords: t('svcstatus.cmdKeywords'),
        run: () => openServiceStatus(),
      },
    ]);
  })().catch((err) => console.warn('[svcstatus] paleta', err?.message || err));
}
