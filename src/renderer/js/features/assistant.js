// Asistente de IA en la interfaz: boton en la barra de titulo, atajo Ctrl+J, panel lateral y el
// componente de chat que comparten el panel y la pagina #/assistant.
//   startup()                                       se llama al abrir el launcher (app.js)
//   openAssistant({ prompt?, instanceId?, autoSend? }) abre el chat desde cualquier lugar
//   createChat(opts) / transparencyPanel() / getStatus() / quotaInfo()  para la pagina del asistente
// El chat tiene el selector de modelo y esfuerzo (solo lo que incluye el plan, con las preguntas que quedan), avisa
// cuando respondio el proveedor de respaldo y, sin plan o con la cuota agotada, lleva a los planes (features/plans.js).
import { h, icon, mount, clear, fail, ok, modal, ensureCss, copyText, fmtNumber } from '../ui.js';
import { store, api } from '../store.js';
import { t, loadNs, locale, onLanguageChange } from '../i18n.js';
import { navigate, setNavBadge } from '../app.js';
import { openPlans, preparePlans, fmtUsd } from './plans.js';

const TOOL_ICONS = {
  list_instances: 'layers',
  get_instance_info: 'info',
  list_mods: 'list',
  get_system_specs: 'cpu',
  run_benchmark: 'gauge',
  search_mods: 'search',
  search_resource_packs: 'image',
  search_shaders: 'sun',
  get_mod_versions: 'history',
  check_compatibility: 'shieldCheck',
  read_crash_summary: 'bug',
  create_instance: 'plus',
  install_mod: 'download',
  install_resource_pack: 'download',
  install_shader: 'download',
  update_mod: 'upCircle',
  toggle_mod: 'power',
  set_ram: 'memory',
  set_option: 'sliders',
  set_java_version: 'coffee',
  set_jvm_args: 'terminal',
  change_instance_version: 'refresh',
  remove_mod: 'trash',
  list_servers: 'server',
  get_server_info: 'server',
  create_server: 'plus',
  start_server: 'play',
  stop_server: 'stop',
  restart_server: 'refresh',
  read_server_console: 'terminal',
  send_server_command: 'terminal',
  get_server_properties: 'sliders',
  set_server_property: 'sliders',
  set_server_ram: 'memory',
  list_server_plugins: 'puzzle',
  search_server_plugins: 'search',
  install_server_plugin: 'download',
  remove_server_plugin: 'trash',
  update_server_plugin: 'upCircle',
  replace_server_plugin: 'refresh',
  toggle_server_plugin: 'power',
  backup_server_world: 'archive',
  list_server_backups: 'archive',
  restore_server_backup: 'history',
  whitelist_add: 'userPlus',
  whitelist_remove: 'users',
  op_player: 'shieldCheck',
  recommend_ram: 'memory',
  duplicate_instance: 'copy',
  rename_instance: 'edit',
  list_snapshots: 'history',
  create_snapshot: 'camera',
  restore_snapshot: 'history',
  list_worlds: 'globe',
  backup_world: 'archive',
};
const EXAMPLES = ['ex1', 'ex2', 'ex3', 'ex4', 'ex5'];

const S = {
  ready: null,
  status: null,
  statusAt: 0,
  statusListeners: new Set(),
  drawer: null,
  pageChat: null,
  running: new Set(),
  limits: {}, // motor externo -> ultimos limites del plan del usuario que informo el CLI (evento 'limits')
};

// Termino la deteccion de Claude Code y Codex en el proceso principal: el estado se actualiza sin volver a pedirlo
api.on('assistant:engines', (view) => {
  if (!S.status || !view) return;
  S.status = { ...S.status, engines: view };
  for (const fn of S.statusListeners) fn(S.status);
});

// ---------- Estado de la IA (plan, cuota, disponibilidad) ----------
export async function getStatus(force = false) {
  if (!force && S.status && Date.now() - S.statusAt < 20000) return S.status;
  try {
    S.status = await api.invoke('assistant:status', { refresh: force });
  } catch (err) {
    console.warn('[assistant] estado', err);
    S.status = S.status || { provider: null, enabled: true, signedIn: false, quota: null, tools: [], plans: { plans: [] } };
  }
  S.statusAt = Date.now();
  for (const fn of S.statusListeners) fn(S.status);
  return S.status;
}

export function onStatus(fn) {
  S.statusListeners.add(fn);
  return () => S.statusListeners.delete(fn);
}

// Estado recalculado con la ultima cuota conocida (sin pedirsela al servidor): despues de cada respuesta
let localTimer = null;
function refreshStatusSoon() {
  clearTimeout(localTimer);
  localTimer = setTimeout(async () => {
    try {
      S.status = await api.invoke('assistant:status', {});
      S.statusAt = Date.now();
      for (const fn of S.statusListeners) fn(S.status);
    } catch {
      /* queda el estado anterior */
    }
  }, 250);
}

// "en 9 h", "mañana"... (fmtAgo de ui.js solo sirve para el pasado)
export function fmtIn(ts) {
  const diff = (new Date(ts).getTime() - Date.now()) / 1000;
  if (!Number.isFinite(diff)) return '';
  const rtf = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' });
  const abs = Math.abs(diff);
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  return rtf.format(Math.round(diff / 86400), 'day');
}

// Situacion de uso: { blocked: 'unavailable'|'disabled'|'plan'|'quota'|null, quota, planName, reason, resetAt }
// 'plan' = la cuenta no tiene un plan de Venus IA; 'quota' = todos los modelos del plan agotados (o el presupuesto)
export function quotaInfo(st) {
  if (!st) return { blocked: null };
  if (st.enabled === false) return { blocked: 'disabled' };
  if (!st.provider) return { blocked: 'unavailable' };
  if (st.needsPlan) return { blocked: 'plan' };
  const q = st.quota || null;
  const opts = Array.isArray(st.modelOptions) ? st.modelOptions : [];
  if (opts.length && opts.every((o) => o.blocked)) {
    const resetAt = opts.map((o) => o.resetAt).filter(Boolean).sort()[0] || null;
    const reason = opts.some((o) => o.blocked === 'budget') ? 'budget' : opts[0].blocked;
    return { blocked: 'quota', quota: q, planName: q?.planName || q?.plan || '', reason, resetAt };
  }
  return { blocked: null, quota: q };
}

// Como quotaInfo, pero para el motor que va a responder: con el Claude Code o el Codex del usuario, la cuota de
// Venus IA agotada no bloquea el chat (el plan sigue haciendo falta: sin plan o sin sesion se bloquea igual).
export function blockedFor(st, engine) {
  const info = quotaInfo(st);
  if (!engine || engine === 'venus') return info;
  if (info.blocked === 'quota') return { blocked: null, quota: info.quota };
  return info;
}

// Esfuerzo permitido mas parecido al pedido (el mismo, o el mas alto por debajo, o el mas bajo permitido)
const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh'];
function fitEffort(wanted, allowed) {
  const list = EFFORT_ORDER.filter((e) => Array.isArray(allowed) && allowed.includes(e));
  if (!list.length) return null;
  const w = EFFORT_ORDER.includes(wanted) ? wanted : 'medium';
  if (list.includes(w)) return w;
  const below = list.filter((e) => EFFORT_ORDER.indexOf(e) < EFFORT_ORDER.indexOf(w));
  return below.length ? below[below.length - 1] : list[0];
}

// ---------- Markdown seguro -> DOM (sin innerHTML) ----------
function link(url, children) {
  return h(
    'a',
    {
      href: '#',
      title: url,
      onclick: (e) => {
        e.preventDefault();
        api.app.openExternal(url).catch(() => {});
      },
    },
    children,
  );
}

const INLINE = [
  { re: /`([^`\n]+)`/, fn: (m) => h('code', {}, m[1]) },
  { re: /\*\*(?=\S)([\s\S]*?\S)\*\*/, fn: (m) => h('strong', {}, inline(m[1])) },
  { re: /__(?=\S)([^_\n]*?\S)__/, fn: (m) => h('strong', {}, inline(m[1])) },
  { re: /~~(?=\S)([^~\n]*?\S)~~/, fn: (m) => h('del', {}, inline(m[1])) },
  { re: /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/, fn: (m) => link(m[2], inline(m[1])) },
  { re: /(?<![\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/, fn: (m) => h('em', {}, inline(m[1])) },
  { re: /(?<![\w_])_(?=\S)([^_\n]*?\S)_(?![\w_])/, fn: (m) => h('em', {}, inline(m[1])) },
  { re: /\bhttps?:\/\/[^\s<>()]*[^\s<>().,;:!?'"]/, fn: (m) => link(m[0], m[0]) },
];

function inline(text) {
  const out = [];
  let rest = String(text);
  while (rest) {
    let best = null;
    for (const r of INLINE) {
      const m = r.re.exec(rest);
      if (m && (!best || m.index < best.m.index)) best = { m, r };
    }
    if (!best) {
      out.push(rest);
      break;
    }
    if (best.m.index > 0) out.push(rest.slice(0, best.m.index));
    out.push(best.r.fn(best.m));
    rest = rest.slice(best.m.index + best.m[0].length);
  }
  return out;
}

const FENCE = /^\s*(```|~~~)\s*([\w+-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^\s*([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s*>\s?(.*)$/;
const LIST = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const indentOf = (l) => l.match(/^\s*/)[0].replace(/\t/g, '  ').length;
const isTable = (lines, i) => lines[i].includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]);
const isBlockStart = (lines, i) => FENCE.test(lines[i]) || HEADING.test(lines[i]) || HR.test(lines[i]) || QUOTE.test(lines[i]) || LIST.test(lines[i]) || isTable(lines, i);

function parseList(lines, start) {
  const base = indentOf(lines[start]);
  const first = lines[start].match(LIST);
  const ordered = /\d/.test(first[2]);
  const list = h(ordered ? 'ol' : 'ul', ordered && parseInt(first[2], 10) !== 1 ? { start: parseInt(first[2], 10) } : {});
  let li = null;
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      const next = lines[i + 1];
      if (next && LIST.test(next) && indentOf(next) >= base) {
        i++;
        continue;
      }
      break;
    }
    const m = line.match(LIST);
    const ind = indentOf(line);
    if (m && ind <= base + 1) {
      if (/\d/.test(m[2]) !== ordered && ind <= base) break;
      li = h('li', {}, inline(m[3]));
      list.append(li);
      i++;
    } else if (m && li) {
      const [sub, next] = parseList(lines, i);
      li.append(sub);
      i = next;
    } else if (!m && li && ind > base) {
      li.append(' ', ...inline(line.trim()));
      i++;
    } else break;
  }
  return [list, i];
}

export function renderMarkdown(src) {
  const root = h('div', { class: 'as-md selectable' });
  const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    let m = line.match(FENCE);
    if (m) {
      const body = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s*${m[1]}\\s*$`).test(lines[i])) body.push(lines[i++]);
      i++;
      root.append(h('pre', { class: 'as-code' }, h('code', {}, body.join('\n'))));
      continue;
    }
    if ((m = line.match(HEADING))) {
      root.append(h(`h${Math.min(6, m[1].length + 2)}`, {}, inline(m[2])));
      i++;
      continue;
    }
    if (HR.test(line)) {
      root.append(h('hr'));
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const body = [];
      while (i < lines.length && QUOTE.test(lines[i])) body.push(lines[i++].match(QUOTE)[1]);
      root.append(h('blockquote', {}, [...renderMarkdown(body.join('\n')).childNodes]));
      continue;
    }
    if (isTable(lines, i)) {
      const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      root.append(
        h(
          'div',
          { class: 'as-table-wrap' },
          h('table', {}, h('thead', {}, h('tr', {}, head.map((c) => h('th', {}, inline(c))))), h('tbody', {}, rows.map((r) => h('tr', {}, r.map((c) => h('td', {}, inline(c))))))),
        ),
      );
      continue;
    }
    if (LIST.test(line)) {
      const [list, next] = parseList(lines, i);
      root.append(list);
      i = next;
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && (para.length === 0 || !isBlockStart(lines, i))) para.push(lines[i++].trim());
    const p = h('p');
    para.forEach((l, k) => {
      if (k) p.append(h('br'));
      p.append(...inline(l).map((n) => (typeof n === 'string' ? document.createTextNode(n) : n)));
    });
    root.append(p);
  }
  return root;
}

// ---------- Paneles informativos ----------
export function transparencyPanel({ compact = false } = {}) {
  const list = (prefix, n, ic, cls, extra = []) =>
    h(
      'ul',
      { class: `as-tlist ${cls}` },
      Array.from({ length: n }, (_, k) => h('li', {}, icon(ic), h('span', {}, t(`assistant.${prefix}${k + 1}`)))),
      extra.map((text) => h('li', {}, icon(ic), h('span', {}, text))),
    );
  return h(
    'div',
    { class: ['as-trans', compact && 'compact'] },
    h('div', { class: 'as-tcard can' }, h('div', { class: 'as-tcard-title' }, icon('check'), t('assistant.canTitle')), list('can', 7, 'check', 'good', [t('assistant.canMcp')])),
    // El ultimo "no puede" tiene la excepcion de los servidores MCP que agrega el usuario
    h('div', { class: 'as-tcard cannot' }, h('div', { class: 'as-tcard-title' }, icon('ban'), t('assistant.cannotTitle')), list('cannot', 6, 'x', 'bad', [t('assistant.cannotDataMcp')])),
    h(
      'div',
      { class: 'as-tcard perms' },
      h('div', { class: 'as-tcard-title' }, icon('shield'), t('assistant.permsTitle')),
      h(
        'ul',
        { class: 'as-tlist' },
        h('li', {}, h('span', { class: 'as-lvl read' }, icon('eye')), h('span', {}, t('assistant.permRead'))),
        h('li', {}, h('span', { class: 'as-lvl reversible' }, icon('undo')), h('span', {}, t('assistant.permReversible'))),
        h('li', {}, h('span', { class: 'as-lvl destructive' }, icon('alert')), h('span', {}, t('assistant.permDestructive'))),
        h('li', {}, h('span', { class: 'as-lvl reversible' }, icon('package')), h('span', {}, t('assistant.permBulk'))),
        h('li', {}, h('span', { class: 'as-lvl reversible' }, icon('plug')), h('span', {}, t('assistant.permMcp'))),
      ),
      h('p', { class: 'as-privacy' }, icon('lock'), h('span', {}, t('assistant.privacyNote'))),
    ),
  );
}

export function openTransparency() {
  // El titulo no repite el de la primera tarjeta ("Que puede hacer")
  modal({ title: t('assistant.transparencyTitle'), size: 'wide', body: transparencyPanel() });
}

// ---------- Componente de chat ----------
// opts: { variant: 'page'|'drawer', onConversation(id), onTitle(title), emptyExtra() -> Element }
export function createChat(opts = {}) {
  const variant = opts.variant || 'page';
  const st = {
    convId: null,
    lastSeq: 0,
    running: false,
    awaitingNew: false,
    buffer: [],
    groups: new Map(), // turnId -> cuerpo del grupo del asistente
    tools: new Map(), // toolUseId -> tarjeta
    undoCards: new Map(), // undoId -> tarjeta
    confirms: new Map(), // requestId -> tarjeta
    undoStates: {},
    pending: new Set(),
    lastUserText: '',
    instanceId: null,
    title: '',
    loadToken: 0,
    blocked: null,
    choice: null, // { model, effort } que viaja con cada pregunta (lo recuerda el proceso principal)
    noted: new Set(), // turnos con la nota del respaldo
    engine: null, // 'venus' | 'claude' | 'chatgpt' elegido para esta conversacion (null = el de Ajustes)
    engineLocked: false, // la conversacion ya empezo: el motor no se cambia
  };

  const thread = h('div', { class: 'as-thread' });
  const scroller = h('div', { class: 'as-scroll', role: 'log', 'aria-live': 'polite', 'aria-label': t('assistant.title') }, thread);
  const typing = h('div', { class: 'as-typing', role: 'status' }, h('span', { class: 'as-dots' }, h('i'), h('i'), h('i')), h('span', {}, t('assistant.thinking')));
  const textarea = h('textarea', { class: 'as-textarea', rows: 1, placeholder: t('assistant.placeholder'), 'aria-label': t('assistant.placeholder'), maxlength: 8000, spellcheck: 'true' });
  const sendBtn = h('button', { class: 'as-send', type: 'button', title: t('assistant.send'), 'aria-label': t('assistant.send') }, icon('send'));
  const stopBtn = h('button', { class: 'as-send stop hidden', type: 'button', title: t('assistant.stop'), 'aria-label': t('assistant.stop') }, icon('stop'));
  const instSelect = h('select', { class: 'as-ctx-select', 'aria-label': t('assistant.instance'), title: t('assistant.contextHint') });
  // Modelo y esfuerzo: solo los que incluye el plan (assistant:status -> modelOptions)
  const modelSelect = h('select', { class: 'as-ctx-select as-model-select', 'aria-label': t('assistant.modelLabel'), title: t('assistant.modelHint') });
  const effortSelect = h('select', { class: 'as-ctx-select as-effort-select', 'aria-label': t('assistant.effortLabel'), title: t('assistant.effortHint') });
  const modelBox = h(
    'div',
    { class: 'as-ctx-group as-model-box hidden' },
    icon('cpu'),
    h('span', { class: 'as-ctx-label' }, t('assistant.modelLabel')),
    modelSelect,
    h('span', { class: 'as-ctx-label' }, t('assistant.effortLabel')),
    effortSelect,
  );
  // Motor: Venus IA con el plan, o el Claude Code / Codex del usuario con su cuenta (desde el plan Go). Fijo por
  // conversacion: se elige antes de la primera pregunta.
  const engineSelect = h('select', { class: 'as-ctx-select as-engine-select', 'aria-label': t('assistant.engineLabel'), title: t('assistant.engineHint') });
  const engineBox = h('div', { class: 'as-ctx-group as-engine-box hidden' }, icon('sparkles'), h('span', { class: 'as-ctx-label' }, t('assistant.engineLabel')), engineSelect);
  const usageLine = h('div', { class: 'as-usage-line hidden' });
  // "Enter para enviar": en la fila de los selectores o, con el selector de modelo, a la derecha del uso del plan
  const enterHint = h('span', { class: 'as-ctx-hint' }, t('assistant.enterHint'));
  const ctxRow = h(
    'div',
    { class: 'as-ctx' },
    h('div', { class: 'as-ctx-group' }, icon('layers'), h('span', { class: 'as-ctx-label' }, t('assistant.instance')), instSelect),
    engineBox,
    modelBox,
    enterHint,
  );
  const blockedBox = h('div', { class: 'as-blocked hidden' });
  const composer = h('div', { class: 'as-composer' }, blockedBox, ctxRow, usageLine, h('div', { class: 'as-input-row' }, textarea, sendBtn, stopBtn));
  const el = h('div', { class: ['as-chat', `as-chat-${variant}`] }, scroller, composer);

  // ----- Instancia de contexto -----
  function fillInstances() {
    const current = st.instanceId;
    mount(
      instSelect,
      h('option', { value: '' }, t('assistant.noInstance')),
      store.instances.map((i) => h('option', { value: i.id, selected: i.id === current }, String(i.name).includes(i.mcVersion) ? i.name : `${i.name} · ${i.mcVersion}`)),
    );
    instSelect.value = current && store.instances.some((i) => i.id === current) ? current : '';
  }
  st.instanceId = store.selectedInstance()?.id || null;
  fillInstances();
  instSelect.addEventListener('change', () => {
    st.instanceId = instSelect.value || null;
  });
  const offInst = store.on('instances', fillInstances);

  // ----- Modelo y esfuerzo -----
  function optionLabel(o) {
    if (o.blocked) return t('assistant.modelOptionOut', { model: o.label || o.id });
    if (o.daily && Number.isFinite(o.daily.remaining)) return t('assistant.modelOption', { model: o.label || o.id, count: o.daily.remaining });
    return o.label || o.id;
  }

  // ----- Motor (quien responde) -----
  // El elegido en esta conversacion o el de Ajustes; un motor externo que no se puede usar (sin plan, sin instalar,
  // sin sesion) vuelve a Venus IA, salvo en una conversacion ya empezada con el.
  function currentEngine(s = S.status) {
    const eng = s?.engines;
    const want = st.engine || eng?.current || 'venus';
    if (want === 'venus') return 'venus';
    if (st.engineLocked) return want;
    return eng?.entitled && eng[want]?.usable ? want : 'venus';
  }

  function engineName(id) {
    return t(`assistant.engine_${id}`);
  }

  function switchEngine(id) {
    if (st.engineLocked) return;
    st.engine = id;
    st.choice = null;
    drawModels(S.status);
    renderBlocked(blockedFor(S.status, currentEngine()));
  }

  function drawEngine(s) {
    const eng = s?.engines;
    const cur = currentEngine(s);
    const anyExternal = Boolean(eng && (eng.claude?.installed || eng.chatgpt?.installed));
    const show = Boolean(eng?.entitled && (anyExternal || cur !== 'venus')) && !(st.blocked && st.blocked !== 'quota');
    engineBox.classList.toggle('hidden', !show);
    if (!show) return;
    const q = s?.quota || {};
    const planName = q.planName || q.plan || '';
    const options = [h('option', { value: 'venus', selected: cur === 'venus' }, planName ? t('assistant.engineVenusPlan', { plan: planName }) : t('assistant.engineVenus'))];
    for (const id of ['claude', 'chatgpt']) {
      const e = eng[id] || {};
      if (!e.installed && cur !== id) continue;
      const usable = Boolean(e.usable) || cur === id;
      options.push(h('option', { value: id, selected: cur === id, disabled: !usable }, usable ? engineName(id) : t('assistant.engineUnavailable', { app: engineName(id) })));
    }
    mount(engineSelect, options);
    engineSelect.value = cur;
    engineSelect.disabled = st.engineLocked;
    engineSelect.title = st.engineLocked ? t('assistant.engineLocked') : t('assistant.engineHint');
  }

  // Modelo y esfuerzo de un motor externo: los que ofrece el CLI del usuario; el uso es el de SU plan (los
  // limites de Claude Code llegan con cada respuesta, evento 'limits'), no la cuota de Venus IA.
  function drawExternalModels(s, engine) {
    const eng = s?.engines || {};
    const models = Array.isArray(eng.models?.[engine]) && eng.models[engine].length ? eng.models[engine] : [{ id: 'default' }];
    const efforts = Array.isArray(eng.efforts) && eng.efforts.length ? eng.efforts : ['low', 'medium', 'high', 'xhigh'];
    const want = st.choice || eng.choice?.[engine] || {};
    const model = models.some((m) => m.id === want.model) ? want.model : 'default';
    const effort = efforts.includes(want.effort) ? want.effort : 'medium';
    modelBox.classList.remove('hidden');
    mount(
      modelSelect,
      models.map((m) => h('option', { value: m.id, selected: m.id === model }, m.id === 'default' ? t('assistant.engineModelDefault', { app: engineName(engine) }) : m.label || m.id)),
    );
    modelSelect.value = model;
    mount(
      effortSelect,
      efforts.map((e) => h('option', { value: e, selected: e === effort }, t(`assistant.effort_${e}`))),
    );
    effortSelect.value = effort;
    st.choice = { model, effort };
    const parts = [h('span', { class: 'as-usage-stat' }, t('assistant.engineUsage', { app: engineName(engine) }))];
    const lim = S.limits[engine];
    if (lim && Number.isFinite(lim.fiveHour)) parts.push(h('span', { class: 'as-usage-stat num' }, t('assistant.engineLimit5h', { pct: lim.fiveHour })));
    if (lim && Number.isFinite(lim.sevenDay)) parts.push(h('span', { class: 'as-usage-stat num' }, t('assistant.engineLimit7d', { pct: lim.sevenDay })));
    mount(usageLine, parts, enterHint);
    usageLine.classList.remove('hidden');
  }

  function drawModels(s) {
    drawEngine(s);
    const engine = currentEngine(s);
    if (engine !== 'venus' && !(st.blocked && st.blocked !== 'quota')) {
      drawExternalModels(s, engine);
      return;
    }
    const options = Array.isArray(s?.modelOptions) ? s.modelOptions : [];
    const show = options.length > 0 && !st.blocked;
    modelBox.classList.toggle('hidden', !show);
    if (!show) {
      usageLine.classList.add('hidden');
      ctxRow.append(enterHint);
      return;
    }
    const want = st.choice || s.selection || {};
    const opt = options.find((o) => o.id === want.model && !o.blocked) || options.find((o) => !o.blocked) || options[0];
    const effort = fitEffort(want.effort || 'medium', opt.efforts) || opt.efforts[0];
    mount(
      modelSelect,
      options.map((o) => h('option', { value: o.id, disabled: Boolean(o.blocked) && o.id !== opt.id, selected: o.id === opt.id }, optionLabel(o))),
    );
    modelSelect.value = opt.id;
    mount(
      effortSelect,
      opt.efforts.map((e) => h('option', { value: e, selected: e === effort }, t(`assistant.effort_${e}`))),
    );
    effortSelect.value = effort;
    st.choice = { model: opt.id, effort };
    // Preguntas de la semana del modelo elegido y presupuesto del mes (las de hoy van en el selector)
    const parts = [];
    if (opt.weekly && Number.isFinite(opt.weekly.remaining) && opt.weekly.limit !== null) parts.push(h('span', { class: 'as-usage-stat num' }, t('assistant.weekLeft', { count: opt.weekly.remaining, limit: fmtNumber(opt.weekly.limit) })));
    if (s.budget && s.budget.limitUsd) parts.push(h('span', { class: 'as-usage-stat num' }, t('assistant.budgetLine', { used: fmtUsd(s.budget.usedUsd), limit: fmtUsd(s.budget.limitUsd) })));
    mount(usageLine, parts, enterHint);
    usageLine.classList.remove('hidden');
  }
  modelSelect.addEventListener('change', () => {
    st.choice = { model: modelSelect.value, effort: effortSelect.value };
    drawModels(S.status);
  });
  effortSelect.addEventListener('change', () => {
    st.choice = { model: modelSelect.value, effort: effortSelect.value };
  });
  engineSelect.addEventListener('change', () => switchEngine(engineSelect.value || 'venus'));

  // ----- Composer -----
  const autosize = () => {
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 168)}px`;
  };
  textarea.addEventListener('input', autosize);
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });
  sendBtn.addEventListener('click', () => submit());
  stopBtn.addEventListener('click', () => {
    if (st.convId) api.invoke('assistant:cancel', st.convId).catch(() => {});
  });

  function setRunning(on) {
    st.running = on;
    sendBtn.classList.toggle('hidden', on);
    stopBtn.classList.toggle('hidden', !on);
    el.classList.toggle('busy', on);
    if (!on) typing.remove();
  }

  function nearBottom() {
    return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 90;
  }
  function scrollDown(force = false) {
    if (force || nearBottom()) requestAnimationFrame(() => (scroller.scrollTop = scroller.scrollHeight));
  }

  // ----- Estado vacio y bloqueos -----
  function examples() {
    return h(
      'div',
      { class: 'as-examples' },
      h('div', { class: 'as-examples-title' }, t('assistant.examplesTitle')),
      h(
        'div',
        { class: 'chips' },
        // Sin asistente disponible los ejemplos quedan deshabilitados (tambien para el teclado)
        EXAMPLES.map((k) => h('button', { class: 'chip', type: 'button', disabled: Boolean(st.blocked), onclick: () => send(t(`assistant.${k}`)) }, icon('sparkles'), t(`assistant.${k}`))),
      ),
    );
  }

  function renderEmpty() {
    mount(
      thread,
      h(
        'div',
        { class: 'as-welcome' },
        h('div', { class: 'as-welcome-icon' }, icon('wand')),
        h('h2', { class: 'as-welcome-title' }, t('assistant.welcomeTitle')),
        h('p', { class: 'as-welcome-text' }, t('assistant.welcomeText')),
        examples(),
        variant === 'page' ? transparencyPanel() : h('button', { class: 'btn ghost sm as-what', type: 'button', onclick: openTransparency }, icon('info'), t('assistant.whatCanDo')),
        opts.emptyExtra ? opts.emptyExtra() : null,
      ),
    );
  }

  function ctaButtons(code) {
    const out = [];
    if (code === 'unavailable' || code === 'session') {
      out.push(h('button', { class: 'btn sm primary', type: 'button', onclick: () => go('settings/cloud/venus') }, icon('logIn'), t('assistant.goCloud')));
    } else if (code === 'plan' || code === 'noplan') {
      // Sin plan (o el plan no incluye lo pedido): las tarjetas de planes
      const reason = code === 'noplan' ? 'needsPlan' : 'quota';
      out.push(h('button', { class: 'btn sm primary', type: 'button', onclick: () => openPlans({ reason }) }, icon('crown'), code === 'noplan' ? t('assistant.seePlans') : t('assistant.upgrade')));
    } else if (code === 'quota') {
      out.push(h('button', { class: 'btn sm primary', type: 'button', onclick: () => openPlans({ reason: 'quota' }) }, icon('crown'), t('assistant.upgrade')));
      // Con el plan agotado, el Claude Code o el Codex del usuario pueden seguir respondiendo (conversacion nueva)
      const eng = S.status?.engines;
      if (eng?.entitled && !st.engineLocked) for (const id of ['claude', 'chatgpt']) if (eng[id]?.usable) out.push(h('button', { class: 'btn sm', type: 'button', onclick: () => switchEngine(id) }, icon('sparkles'), t('assistant.engineUse', { app: engineName(id) })));
    } else if (['engine', 'engineLogin', 'engineLimit', 'engineMissing', 'engineTimeout'].includes(code)) {
      out.push(h('button', { class: 'btn sm', type: 'button', onclick: () => go('settings/ai/engines') }, icon('settings'), t('assistant.engineSettings')));
    } else if (code === 'disabled') {
      out.push(h('button', { class: 'btn sm primary', type: 'button', onclick: () => go('settings/ai') }, icon('settings'), t('assistant.goAiSettings')));
    }
    return out;
  }

  function go(route) {
    if (variant === 'drawer') closeDrawer();
    navigate(route);
  }

  function renderBlocked(info) {
    st.blocked = info.blocked;
    const blocked = Boolean(info.blocked);
    // Si el foco estaba en el aviso (por ejemplo en "Volver a comprobar"), no se pierde al redibujarlo:
    // vuelve al boton que ocupa el mismo lugar
    const hadFocus = blockedBox.contains(document.activeElement);
    const focusIndex = hadFocus ? [...blockedBox.querySelectorAll('button')].indexOf(document.activeElement) : -1;
    el.classList.toggle('blocked', blocked);
    blockedBox.classList.toggle('hidden', !blocked);
    textarea.disabled = blocked;
    sendBtn.disabled = blocked;
    textarea.placeholder = blocked ? t('assistant.placeholderBlocked') : t('assistant.placeholder');
    thread.querySelectorAll('.as-examples .chip').forEach((c) => (c.disabled = blocked));
    if (!blocked) {
      clear(blockedBox);
      if (hadFocus) textarea.focus();
      return null;
    }
    let title;
    let text;
    if (info.blocked === 'disabled') {
      title = t('assistant.disabledTitle');
      text = t('assistant.disabledText');
    } else if (info.blocked === 'plan') {
      title = t('assistant.planNeededTitle');
      text = t('assistant.planNeededText');
    } else if (info.blocked === 'quota') {
      title = t('assistant.quotaTitle');
      const plan = info.planName || '?';
      if (info.reason === 'budget') text = t('assistant.quotaBudgetText', { plan });
      else if (!info.resetAt) text = t('assistant.quotaTextNoDate', { plan });
      else text = t('assistant.quotaAllText', { plan, when: fmtIn(info.resetAt) });
    } else {
      title = t('assistant.blockedTitle');
      text = t('assistant.blockedText');
    }
    // "Volver a comprobar" es un boton de icono en la esquina: gira mientras consulta el estado
    const refresh = h('button', { class: 'icon-btn sm as-blocked-refresh', type: 'button', title: t('assistant.checkAgain'), 'aria-label': t('assistant.checkAgain') }, icon('refresh'));
    refresh.addEventListener('click', async () => {
      if (refresh.getAttribute('aria-busy') === 'true') return;
      refresh.setAttribute('aria-busy', 'true');
      mount(refresh, h('span', { class: 'spinner', 'aria-hidden': 'true' }));
      try {
        await getStatus(true);
      } finally {
        // con el estado nuevo el aviso se vuelve a dibujar; si sigue este mismo boton, se restablece
        if (refresh.isConnected) {
          refresh.removeAttribute('aria-busy');
          mount(refresh, icon('refresh'));
        }
      }
    });
    const ctas = ctaButtons(info.blocked === 'plan' ? 'noplan' : info.blocked);
    mount(
      blockedBox,
      h('div', { class: 'as-blocked-icon', 'aria-hidden': 'true' }, icon(info.blocked === 'quota' ? 'clock' : info.blocked === 'plan' ? 'crown' : 'lock')),
      h(
        'div',
        { class: 'as-blocked-main' },
        h('div', { class: 'as-blocked-title' }, title),
        h('div', { class: 'as-blocked-text' }, text),
        ctas.length ? h('div', { class: 'row wrap as-blocked-actions' }, ctas) : null,
      ),
      refresh,
    );
    if (hadFocus) (blockedBox.querySelectorAll('button')[focusIndex] || refresh).focus({ preventScroll: true });
    return null;
  }
  const offStatus = onStatus((s) => {
    renderBlocked(blockedFor(s, currentEngine(s)));
    drawModels(s);
  });

  // ----- Elementos del hilo -----
  function userBubble(ev) {
    const inst = ev.instanceName ? h('div', { class: 'as-user-ctx' }, icon('layers'), ev.instanceName) : null;
    return h('div', { class: 'as-user' }, h('div', { class: 'as-user-bubble selectable' }, ev.text), inst);
  }

  function groupFor(turnId) {
    if (st.groups.has(turnId)) return st.groups.get(turnId);
    const body = h('div', { class: 'as-turn-body' });
    const group = h('div', { class: 'as-turn' }, h('div', { class: 'as-avatar', 'aria-hidden': 'true' }, icon('wand')), body);
    thread.append(group);
    st.groups.set(turnId, body);
    return body;
  }

  function instName(id) {
    return store.instances.find((i) => i.id === id)?.name || id;
  }

  function toolDetail(name, input = {}) {
    switch (name) {
      case 'search_mods':
      case 'search_resource_packs':
      case 'search_shaders':
        return input.query ? `«${input.query}»` : '';
      case 'install_mod':
      case 'install_resource_pack':
      case 'install_shader':
      case 'get_mod_versions':
        return input.project_id || '';
      case 'check_compatibility':
        return (input.project_ids || []).join(', ');
      case 'update_mod':
      case 'toggle_mod':
      case 'remove_mod':
        return input.file || '';
      case 'set_option':
        return input.key ? `${input.key} = ${input.value}` : '';
      case 'set_ram':
        return input.max_mb ? t('assistant.ramValue', { mb: input.max_mb }) : '';
      case 'set_java_version':
        return input.major ? `Java ${input.major}` : '';
      case 'set_jvm_args':
        return (input.flag_ids || []).join(', ') || '—';
      case 'change_instance_version':
        return [input.mc_version, input.loader].filter(Boolean).join(' · ');
      case 'create_instance':
        return [input.name, input.mc_version, input.loader].filter(Boolean).join(' · ');
      case 'create_server':
        return [input.name, input.type, input.mc_version].filter(Boolean).join(' · ');
      case 'send_server_command':
        return input.command ? `/${input.command}` : '';
      case 'set_server_property':
        return input.key ? `${input.key} = ${input.value}` : '';
      case 'set_server_ram':
        return input.max_mb ? t('assistant.ramValue', { mb: input.max_mb }) : '';
      case 'search_server_plugins':
        return input.query ? `«${input.query}»` : '';
      case 'install_server_plugin':
        return input.project_id || '';
      case 'update_server_plugin':
      case 'replace_server_plugin':
      case 'toggle_server_plugin':
      case 'remove_server_plugin':
        return input.file || '';
      case 'restore_server_backup':
        return input.name || '';
      case 'whitelist_add':
      case 'whitelist_remove':
      case 'op_player':
        return input.player || '';
      case 'rename_instance':
        return input.name || '';
      case 'backup_world':
        return input.folder || '';
      case 'restore_snapshot':
        return input.snapshot_id || '';
      default:
        if (input.server_id) return input.server_id;
        return input.instance_id ? instName(input.instance_id) : '';
    }
  }

  // Argumentos de una herramienta MCP en una linea ("clave: valor · ...").
  function mcpArgs(input = {}) {
    return Object.entries(input)
      .slice(0, 3)
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`)
      .join(' · ');
  }

  // Herramienta de un servidor MCP que agrego el usuario: servidor, herramienta y estado
  function mcpToolCard(ev) {
    const m = ev.mcp || {};
    const read = m.readOnly === true || ev.level === 'read';
    const label = m.title || m.tool || ev.name;
    const detail = mcpArgs(ev.input) || t('assistant.toolRunning');
    const sub = h('div', { class: 'as-tool-sub', title: detail }, detail);
    const side = h('div', { class: 'as-tool-side' }, h('div', { class: 'spinner' }));
    const warn = h('ul', { class: 'as-tool-warn hidden' });
    const card = h(
      'div',
      { class: 'as-tool as-tool-mcp', dataset: { state: 'running', level: read ? 'read' : 'mcp', tool: ev.name }, title: t(read ? 'assistant.levelMcpRead' : 'assistant.levelMcp') },
      h('div', { class: 'as-tool-ic' }, icon('plug')),
      h(
        'div',
        { class: 'as-tool-main' },
        h('div', { class: 'as-tool-title' }, h('span', { class: 'as-mcp-tool' }, label), m.server ? h('span', { class: 'as-mcp-server', title: t('assistant.mcpServerOf', { server: m.server }) }, t('assistant.mcpServerChip', { server: m.server })) : null),
        sub,
        warn,
      ),
      side,
    );
    card._sub = sub;
    card._side = side;
    card._warn = warn;
    return card;
  }

  function toolCard(ev) {
    if (ev.mcp || /^mcp__/.test(ev.name || '')) return mcpToolCard(ev);
    const level = ev.level || 'read';
    const titleKey = `assistant.tool_${ev.name}`;
    const label = TOOL_ICONS[ev.name] ? t(titleKey) : t('assistant.toolUnknown');
    const detail = toolDetail(ev.name, ev.input) || t('assistant.toolRunning');
    const sub = h('div', { class: 'as-tool-sub', title: detail }, detail);
    const side = h('div', { class: 'as-tool-side' }, h('div', { class: 'spinner' }));
    const warn = h('ul', { class: 'as-tool-warn hidden' });
    const card = h(
      'div',
      { class: ['as-tool', level === 'read' && 'compact'], dataset: { state: 'running', level, tool: ev.name }, title: t(level === 'read' ? 'assistant.levelRead' : level === 'destructive' ? 'assistant.levelDestructive' : 'assistant.levelReversible') },
      h('div', { class: 'as-tool-ic' }, icon(TOOL_ICONS[ev.name] || 'box')),
      h('div', { class: 'as-tool-main' }, h('div', { class: 'as-tool-title' }, label), sub, warn),
      side,
    );
    card._sub = sub;
    card._side = side;
    card._warn = warn;
    return card;
  }

  function setUndoState(card, state, undoId) {
    const side = card._side;
    card.dataset.undo = state;
    if (state === 'active') {
      const btn = h('button', { class: 'btn sm as-undo-btn', type: 'button', title: t('assistant.undoTitle'), 'aria-label': t('assistant.undoTitle') }, icon('undo'), t('assistant.undo'));
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        mount(btn, h('div', { class: 'spinner' }), t('assistant.undoing'));
        try {
          const r = await api.invoke('assistant:undo', undoId);
          setUndoState(card, 'undone', undoId);
          ok(t('assistant.undoToast'), r?.warnings?.length ? r.warnings.join(' · ') : r?.message);
        } catch (err) {
          fail(t('assistant.undoFailed'), err);
          mount(btn, icon('undo'), t('assistant.undo'));
          btn.disabled = false;
        }
      });
      mount(side, icon('check', 'as-ok'), btn);
    } else if (state === 'undone') {
      mount(side, h('span', { class: 'badge as-undone' }, icon('undo'), t('assistant.undone')));
    } else if (state) {
      mount(side, icon('check', 'as-ok'), h('span', { class: 'as-muted-note' }, t('assistant.undoExpired')));
    }
  }

  function toolResult(card, ev) {
    card.dataset.state = ev.ok ? (ev.noChange ? 'nochange' : 'done') : ev.declined ? 'declined' : 'error';
    card._sub.textContent = ev.summary || ev.error || '';
    card._sub.title = ev.summary || ev.error || '';
    const warnings = ev.warnings || [];
    card._warn.classList.toggle('hidden', !warnings.length);
    mount(card._warn, warnings.map((w) => h('li', {}, icon('alert'), w)));
    if (!ev.ok && ev.declined) mount(card._side, icon('x', 'as-muted-ic'));
    else if (!ev.ok) mount(card._side, icon('alert', 'as-bad'));
    else if (ev.undoId) {
      st.undoCards.set(ev.undoId, card);
      setUndoState(card, st.undoStates[ev.undoId] || 'active', ev.undoId);
    } else if (ev.noChange) mount(card._side, h('span', { class: 'as-muted-note' }, t('assistant.toolNoChange')));
    else mount(card._side, icon('check', 'as-ok'));
  }

  function confirmCard(ev, live) {
    const actions = h('div', { class: 'as-confirm-actions' });
    const mcp = ev.kind === 'mcp';
    const card = h(
      'div',
      { class: 'as-confirm', dataset: { kind: ev.kind || 'destructive', state: 'pending', ...(mcp && ev.danger ? { danger: 'true' } : {}) }, role: 'group', tabindex: -1, 'aria-label': ev.title || t('assistant.confirmNeeded') },
      h('div', { class: 'as-confirm-head' }, icon(ev.kind === 'bulk' ? 'package' : mcp ? 'plug' : 'alert'), h('div', { class: 'as-confirm-title' }, ev.title || t('assistant.confirmNeeded'))),
      ev.message ? h('div', { class: 'as-confirm-text' }, ev.message) : null,
      ev.items?.length ? h('ul', { class: 'as-confirm-items' }, ev.items.slice(0, 12).map((x) => h('li', {}, x))) : null,
      mcp ? h('div', { class: 'as-confirm-hint' }, icon('shield'), t('assistant.mcpConfirmHint')) : null,
      actions,
    );
    card._actions = actions;
    const isPending = live || st.pending.has(ev.requestId);
    if (isPending) {
      const answer = async (approved, always = false) => {
        actions.querySelectorAll('button').forEach((b) => (b.disabled = true));
        try {
          await api.invoke('assistant:confirm', ev.requestId, approved, always ? { always: true } : undefined);
        } catch (err) {
          fail(t('assistant.errorTitle'), err);
          resolveConfirm(card, 'expired');
        }
      };
      mount(
        actions,
        h('button', { class: 'btn sm ghost', type: 'button', onclick: () => answer(false) }, t('assistant.cancel')),
        // Herramientas MCP: "Permitir siempre" guarda el permiso de esa herramienta (se quita en Ajustes > IA)
        ev.allowAlways ? h('button', { class: 'btn sm tonal', type: 'button', title: t('assistant.mcpAllowAlwaysHint'), onclick: () => answer(true, true) }, icon('shieldCheck'), t('assistant.mcpAllowAlways')) : null,
        h('button', { class: ['btn sm', ev.danger ? 'danger' : 'primary'], type: 'button', onclick: () => answer(true) }, ev.danger ? icon(mcp ? 'alert' : 'trash') : icon('check'), ev.okText || t('assistant.confirm')),
      );
    } else resolveConfirm(card, 'expired');
    return card;
  }

  function resolveConfirm(card, state, always = false) {
    card.dataset.state = state;
    const label = always && state === 'approved' ? 'confirmApprovedAlways' : { approved: 'confirmApproved', denied: 'confirmDenied', cancelled: 'confirmCancelled', expired: 'confirmExpired' }[state] || 'confirmExpired';
    mount(card._actions, h('span', { class: ['badge', state === 'approved' ? 'good' : ''] }, icon(state === 'approved' ? 'check' : 'x'), t(`assistant.${label}`)));
  }

  function errorNotice(ev) {
    const actions = ctaButtons(ev.code);
    if (!['unavailable', 'session', 'quota', 'noplan', 'plan', 'disabled', 'context'].includes(ev.code) && st.lastUserText) {
      actions.push(
        h(
          'button',
          {
            class: 'btn sm ghost',
            type: 'button',
            onclick: () => {
              textarea.value = st.lastUserText;
              autosize();
              textarea.focus();
            },
          },
          icon('refresh'),
          t('assistant.retry'),
        ),
      );
    }
    return h('div', { class: 'notice bad as-error' }, icon('alert'), h('div', { class: 'as-error-main' }, h('div', {}, ev.message), actions.length ? h('div', { class: 'row wrap as-error-actions' }, actions) : null));
  }

  function textBlock(ev) {
    const copyBtn = h('button', { class: 'icon-btn sm as-copy', type: 'button', title: t('assistant.copy'), 'aria-label': t('assistant.copy'), onclick: () => copyText(ev.text) }, icon('copy'));
    return h('div', { class: 'as-text' }, renderMarkdown(ev.text), ev.truncated ? h('div', { class: 'as-note' }, icon('alert'), t('assistant.truncated')) : null, copyBtn);
  }

  // ----- Aplicar eventos -----
  function apply(ev, live) {
    if (ev.type !== 'thinking' && ev.type !== 'quota') typing.remove();
    switch (ev.type) {
      case 'turn-start': {
        thread.querySelector('.as-welcome')?.remove();
        thread.append(userBubble(ev));
        st.lastUserText = ev.text;
        groupFor(ev.turnId);
        // La conversacion ya tiene un motor: no se cambia
        st.engine = ev.engine && ev.engine !== 'venus' ? ev.engine : 'venus';
        st.engineLocked = true;
        drawEngine(S.status);
        if (live) setRunning(true);
        break;
      }
      case 'thinking':
        if (live && st.running) {
          groupFor(ev.turnId).append(typing);
        }
        break;
      case 'text':
        groupFor(ev.turnId).append(textBlock(ev));
        break;
      case 'tool-start': {
        if (st.tools.has(ev.toolUseId)) break;
        const card = toolCard(ev);
        st.tools.set(ev.toolUseId, card);
        groupFor(ev.turnId).append(card);
        break;
      }
      case 'tool-result': {
        let card = st.tools.get(ev.toolUseId);
        if (!card) {
          card = toolCard({ ...ev, level: ev.undoId ? 'reversible' : 'read' });
          st.tools.set(ev.toolUseId, card);
          groupFor(ev.turnId).append(card);
        }
        toolResult(card, ev);
        break;
      }
      case 'confirm': {
        const existing = st.confirms.get(ev.requestId);
        if (ev.state === 'pending' && !existing) {
          const card = confirmCard(ev, live);
          st.confirms.set(ev.requestId, card);
          groupFor(ev.turnId).append(card);
          if (live) {
            card.focus({ preventScroll: true });
            scrollDown(true);
          }
        } else if (existing && ev.state !== 'pending') resolveConfirm(existing, ev.state, ev.always === true);
        break;
      }
      case 'notice':
        // Aviso del turno (por ejemplo, un servidor MCP que no respondio)
        groupFor(ev.turnId).append(h('div', { class: 'as-note as-notice', title: (ev.details || []).map((d) => `${d.name}: ${d.error}`).join('\n') || null }, icon(ev.kind === 'mcp' ? 'plug' : 'info'), ev.text));
        break;
      case 'undo': {
        const card = st.undoCards.get(ev.undoId);
        st.undoStates[ev.undoId] = ev.state;
        if (card) setUndoState(card, ev.state, ev.undoId);
        break;
      }
      case 'error':
        (ev.turnId ? groupFor(ev.turnId) : thread).append(errorNotice(ev));
        if (['quota', 'unavailable', 'session', 'noplan', 'plan'].includes(ev.code)) getStatus(true);
        break;
      case 'done': {
        const note = { cancelled: 'cancelled', interrupted: 'interrupted' }[ev.stopReason];
        if (note) groupFor(ev.turnId).append(h('div', { class: 'as-note' }, icon('info'), t(`assistant.${note}`)));
        if (ev.stopReason === 'max_tokens') groupFor(ev.turnId).append(h('div', { class: 'as-note' }, icon('alert'), t('assistant.truncated')));
        // Respondio el proveedor de respaldo (OpenAI) porque el principal fallo: una nota discreta
        if (ev.failover && !st.noted.has(ev.turnId)) {
          st.noted.add(ev.turnId);
          groupFor(ev.turnId).append(h('div', { class: 'as-note as-failover' }, icon('info'), t('assistant.failoverNote')));
        }
        // Respondio el Claude Code o el Codex del usuario: una nota discreta, una vez por conversacion
        if (ev.engine && ev.engine !== 'venus' && !st.noted.has(`engine:${ev.engine}`)) {
          st.noted.add(`engine:${ev.engine}`);
          groupFor(ev.turnId).append(h('div', { class: 'as-note as-engine' }, icon('sparkles'), t('assistant.engineNote', { app: engineName(ev.engine) })));
        }
        const body = st.groups.get(ev.turnId);
        if (body && !body.childNodes.length) body.closest('.as-turn')?.remove();
        if (live) setRunning(false);
        break;
      }
      case 'limits':
        // Limites del plan del usuario en su Claude Code (ventana de 5 h y semana): se muestran junto al modelo
        if (ev.engine) {
          S.limits[ev.engine] = { fiveHour: ev.fiveHour, sevenDay: ev.sevenDay, at: ev.at };
          if (live) drawModels(S.status);
        }
        break;
      case 'quota':
        refreshStatusSoon();
        break;
      default:
        break;
    }
  }

  function onEvent(convId, ev) {
    if (st.awaitingNew && convId !== st.convId) {
      st.buffer.push({ convId, ev });
      return;
    }
    if (convId !== st.convId || ev.seq <= st.lastSeq) return;
    st.lastSeq = ev.seq;
    const stick = nearBottom();
    apply(ev, true);
    if (stick) scrollDown(true);
    if (ev.type === 'turn-start' && !st.title) {
      st.title = ev.text;
      opts.onTitle?.(ev.text);
    }
  }
  const offEvents = api.on('assistant:event', onEvent);

  function reset() {
    st.groups.clear();
    st.tools.clear();
    st.undoCards.clear();
    st.confirms.clear();
    st.undoStates = {};
    st.pending = new Set();
    st.noted = new Set();
    st.lastSeq = 0;
    st.title = '';
    st.engine = null;
    st.engineLocked = false;
    clear(thread);
    setRunning(false);
  }

  // ----- API del componente -----
  async function load(id) {
    const token = ++st.loadToken;
    reset();
    st.convId = id || null;
    st.awaitingNew = false;
    if (!id) {
      // Conversacion nueva: la ultima eleccion global (selection)
      st.choice = null;
      drawModels(S.status);
      renderEmpty();
      opts.onConversation?.(null);
      return;
    }
    let data;
    try {
      data = await api.invoke('assistant:conversation', id);
    } catch (err) {
      if (token !== st.loadToken) return;
      st.convId = null;
      renderEmpty();
      fail(t('assistant.errorTitle'), err);
      opts.onConversation?.(null);
      return;
    }
    if (token !== st.loadToken) return;
    st.undoStates = data.undoStates || {};
    st.pending = new Set(data.pendingConfirms || []);
    st.title = data.title || '';
    st.engine = data.engine && data.engine !== 'venus' ? data.engine : 'venus';
    st.engineLocked = Boolean(data.events?.length);
    // Cada conversacion sigue con el modelo y el esfuerzo de su ultima pregunta (si el plan los incluye)
    if (data.model) {
      st.choice = { model: data.model, effort: data.effort || st.choice?.effort || null };
      drawModels(S.status);
    }
    for (const ev of data.events || []) apply(ev, false);
    st.lastSeq = data.seq || 0;
    setRunning(Boolean(data.running));
    if (data.running && !st.pending.size) groupFor(lastTurnId(data.events)).append(typing);
    if (!thread.childNodes.length) renderEmpty();
    opts.onConversation?.(id, data.title);
    scrollDown(true);
  }

  function lastTurnId(events) {
    for (let i = events.length - 1; i >= 0; i--) if (events[i].turnId) return events[i].turnId;
    return 'x';
  }

  async function send(text) {
    const body = String(text ?? textarea.value).trim();
    if (!body || st.running || st.blocked) return false;
    const isNew = !st.convId;
    if (isNew) {
      st.awaitingNew = true;
      st.buffer = [];
    }
    textarea.value = '';
    autosize();
    setRunning(true);
    try {
      const choice = st.choice && !modelBox.classList.contains('hidden') ? { model: st.choice.model, effort: st.choice.effort } : {};
      const engine = currentEngine();
      const r = await api.invoke('assistant:send', st.convId, body, { instanceId: st.instanceId, ...choice, ...(isNew ? { engine } : {}) });
      if (isNew) {
        reset();
        setRunning(true);
        st.convId = r.conversationId;
        st.engine = r.engine || engine;
        st.engineLocked = true;
        st.awaitingNew = false;
        for (const b of st.buffer.filter((x) => x.convId === r.conversationId).sort((a, c) => a.ev.seq - c.ev.seq)) onEvent(b.convId, b.ev);
        st.buffer = [];
        opts.onConversation?.(r.conversationId, body);
      }
      scrollDown(true);
      return true;
    } catch (err) {
      st.awaitingNew = false;
      setRunning(false);
      textarea.value = body;
      autosize();
      fail(t('assistant.sendFailed'), err);
      return false;
    }
  }

  function submit() {
    if (!st.running) send();
  }

  getStatus().then((s) => {
    renderBlocked(blockedFor(s, currentEngine(s)));
    drawModels(s);
  });

  return {
    el,
    get conversationId() {
      return st.convId;
    },
    get running() {
      return st.running;
    },
    hasMessages: () => Boolean(st.convId),
    load,
    send,
    newConversation: () => load(null),
    setInstance(id) {
      if (!id) return;
      st.instanceId = id;
      fillInstances();
    },
    setDraft(text) {
      textarea.value = String(text || '');
      autosize();
    },
    focus() {
      if (!textarea.disabled) textarea.focus();
    },
    destroy() {
      offEvents();
      offInst();
      offStatus();
    },
  };
}

// ---------- Panel lateral ----------
function closeDrawer() {
  if (!S.drawer?.open) return;
  S.drawer.open = false;
  S.drawer.el.classList.remove('open');
  S.drawer.el.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('as-drawer-open');
  document.querySelector('.as-tb-btn')?.classList.remove('active');
  if (S.drawer.returnFocus?.isConnected) S.drawer.returnFocus.focus({ preventScroll: true });
}

function ensureDrawer() {
  if (S.drawer) return S.drawer;
  const sub = h('div', { class: 'as-dr-sub ellipsis' }, t('assistant.newChat'));
  // El titulo de la conversacion se corta con "..." y queda completo en el tooltip
  const setSub = (text) => {
    sub.textContent = text;
    sub.title = text;
  };
  const chat = createChat({
    variant: 'drawer',
    onConversation: (id, title) => setSub(id ? title || t('assistant.untitled') : t('assistant.newChat')),
    onTitle: (title) => setSub(title),
  });
  const el = h(
    'aside',
    { class: 'as-drawer', 'aria-label': t('assistant.title'), 'aria-hidden': 'true' },
    h(
      'div',
      { class: 'as-dr-head' },
      h('div', { class: 'as-dr-icon' }, icon('wand')),
      h('div', { class: 'as-dr-titles' }, h('div', { class: 'as-dr-title' }, t('assistant.title')), sub),
      h('button', { class: 'icon-btn sm', type: 'button', title: t('assistant.newChat'), 'aria-label': t('assistant.newChat'), onclick: () => chat.newConversation().then(() => chat.focus()) }, icon('plus')),
      h(
        'button',
        {
          class: 'icon-btn sm',
          type: 'button',
          title: t('assistant.openPage'),
          'aria-label': t('assistant.openPage'),
          onclick: () => {
            const id = chat.conversationId;
            closeDrawer();
            navigate(id ? `assistant/${id}` : 'assistant');
          },
        },
        icon('maximize'),
      ),
      h('button', { class: 'icon-btn sm', type: 'button', title: t('common.close'), 'aria-label': t('common.close'), onclick: closeDrawer }, icon('x')),
    ),
    chat.el,
  );
  document.body.append(el);
  S.drawer = { el, chat, open: false, loaded: false, returnFocus: null };
  return S.drawer;
}

async function openDrawer({ conversationId } = {}) {
  const d = ensureDrawer();
  if (!d.open) {
    d.returnFocus = document.activeElement;
    d.open = true;
    d.el.classList.add('open');
    d.el.setAttribute('aria-hidden', 'false');
    document.body.classList.add('as-drawer-open');
    document.querySelector('.as-tb-btn')?.classList.add('active');
  }
  if (conversationId && conversationId !== d.chat.conversationId) {
    await d.chat.load(conversationId);
    d.loaded = true;
  } else if (!d.loaded) {
    d.loaded = true;
    // Retoma la conversacion reciente (ultimas 6 horas) o empieza una nueva
    let recent = null;
    try {
      const list = await api.invoke('assistant:conversations');
      recent = list.find((c) => c.running) || (list[0] && Date.now() - list[0].updatedAt < 6 * 3600 * 1000 ? list[0] : null);
    } catch {
      recent = null;
    }
    await d.chat.load(recent?.id || null);
  }
  setTimeout(() => d.chat.focus(), 60);
  return d.chat;
}

function toggleDrawer() {
  if (S.drawer?.open) closeDrawer();
  else if (S.pageChat) S.pageChat.focus();
  else openDrawer();
}

// La pagina #/assistant se registra para que Ctrl+J y openAssistant usen su chat en lugar del panel.
export function registerPageChat(chat) {
  S.pageChat = chat;
  closeDrawer();
  return () => {
    if (S.pageChat === chat) S.pageChat = null;
  };
}

function ready() {
  if (!S.ready) S.ready = Promise.all([loadNs('assistant'), Promise.resolve(ensureCss('features/assistant')), preparePlans()]);
  return S.ready;
}

export async function openAssistant({ prompt, instanceId, autoSend } = {}) {
  await ready();
  if (document.body.classList.contains('onboarding')) return;
  const chat = S.pageChat || (await openDrawer());
  if (instanceId) chat.setInstance(instanceId);
  if (prompt) {
    if (autoSend && !chat.running) {
      if (chat.hasMessages()) await chat.newConversation();
      await chat.send(String(prompt));
    } else chat.setDraft(String(prompt));
  }
  chat.focus();
}

// ---------- Inicio ----------
function titlebarButton() {
  const bar = document.querySelector('.titlebar');
  const btns = bar?.querySelector('.tb-btns');
  if (!bar || !btns) return;
  let btn = bar.querySelector('.as-tb-btn');
  if (!btn) {
    btn = h('button', { class: 'as-tb-btn', type: 'button' });
    btn.addEventListener('click', toggleDrawer);
    btn.addEventListener('dblclick', (e) => e.stopPropagation());
    bar.insertBefore(btn, btns);
  }
  btn.title = t('assistant.openDrawer');
  btn.setAttribute('aria-label', t('assistant.openDrawer'));
  mount(btn, icon('wand'), h('span', { class: 'as-tb-label' }, t('assistant.short')), h('span', { class: 'as-tb-dot', 'aria-hidden': 'true' }));
}

function setBusy(convId, running) {
  if (running) S.running.add(convId);
  else S.running.delete(convId);
  const busy = S.running.size > 0;
  document.querySelector('.as-tb-btn')?.classList.toggle('busy', busy);
  try {
    setNavBadge('assistant', busy ? 1 : 0, 'dot');
  } catch {
    /* menu no listo */
  }
}

export async function startup() {
  await ready();
  titlebarButton();
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === 'j') {
      if (document.body.classList.contains('onboarding')) return;
      e.preventDefault();
      toggleDrawer();
    } else if (e.key === 'Escape' && S.drawer?.open && !document.querySelector('.modal-backdrop')) {
      closeDrawer();
    }
  });
  onLanguageChange(async () => {
    await loadNs('assistant');
    titlebarButton();
    // El panel cerrado se vuelve a armar con los textos del idioma nuevo la proxima vez que se abra
    if (S.drawer && !S.drawer.open) {
      S.drawer.chat.destroy();
      S.drawer.el.remove();
      S.drawer = null;
    }
  });
  api.on('assistant:settingsChanged', () => store.refreshSettings().catch(() => {}));
  api.on('ai:quota', () => refreshStatusSoon());
  // Pago confirmado o suscripcion cambiada: el plan nuevo (modelos, preguntas) se lee del servidor
  api.on('billing:changed', () => getStatus(true));
  api.on('assistant:event', (convId, ev) => {
    if (ev.type === 'turn-start') setBusy(convId, true);
    else if (ev.type === 'done') setBusy(convId, false);
    // Una confirmacion pendiente nunca queda escondida: si nadie muestra esa conversacion, se abre el panel.
    if (ev.type === 'confirm' && ev.state === 'pending') {
      const shown = (S.pageChat && S.pageChat.conversationId === convId) || (S.drawer?.open && S.drawer.chat.conversationId === convId);
      if (!shown) openDrawer({ conversationId: convId }).catch((err) => console.warn('[assistant]', err));
    }
  });
  try {
    const { cloud } = await import('../cloud.js');
    // Cada cuenta de Venus ve solo sus conversaciones: si cambia la cuenta (o se cierra la sesion), el chat
    // abierto pasa a una conversacion nueva y el panel vuelve a buscar la reciente de la cuenta nueva.
    let userId = cloud.user?.id || null;
    cloud.on('auth', (session) => {
      getStatus(true);
      const next = session?.user?.id || null;
      if (next === userId) return;
      userId = next;
      if (S.drawer) {
        S.drawer.loaded = false;
        S.drawer.chat.load(null);
      }
      S.pageChat?.load(null);
    });
  } catch {
    /* sin nube */
  }
  try {
    const list = await api.invoke('assistant:conversations');
    for (const c of list) if (c.running) setBusy(c.id, true);
  } catch {
    /* modulo no disponible */
  }
}
