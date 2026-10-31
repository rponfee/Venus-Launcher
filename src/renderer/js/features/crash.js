// Diagnostico de crashes en la interfaz:
// - showCrashDialog(instanceId, state): cuando el juego se cierra, explica que paso en lenguaje humano,
//   ofrece arreglos de un clic, explicacion con IA (si esta configurada) y los detalles tecnicos.
// - openCrashTools(instanceId): analizar cualquier crash guardado o buscar el mod culpable (automatico o
//   con ayuda del usuario), con el progreso en vivo de cada prueba.
import { h, icon, mount, modal, toast, ok, fail, confirmDialog, emptyState, ensureCss, copyText, registerIcons, fmtAgo, fmtDate, fmtTime, instanceIcon, loaderBadge, loaderVersionLabel, instanceLoaderKey, selectEl, skeleton, setBusy } from '../ui.js';
import { store, api } from '../store.js';
import { t, loadNs } from '../i18n.js';
import { navigate, launchInstance, openAccounts } from '../app.js';

registerIcons({
  crSplit: '<path d="M16 3h5v5"/><path d="M8 3H3v5"/><path d="M12 22v-8.3a4 4 0 0 0-1.172-2.872L3 3"/><path d="m15 9 6-6"/>',
  crFlask: '<path d="M10 2v7.527a2 2 0 0 1-.211.896L4.72 20.55a1 1 0 0 0 .9 1.45h12.76a1 1 0 0 0 .9-1.45l-5.069-10.127A2 2 0 0 1 14 9.527V2"/><path d="M8.5 2h7"/><path d="M7 16h10"/>',
  crThumbUp: '<path d="M7 10v12"/><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"/>',
  crThumbDown: '<path d="M17 14V2"/><path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z"/>',
});

const MOD_LOADERS = ['fabric', 'quilt', 'forge', 'neoforge', 'legacyfabric'];
const DRIVER_URLS = {
  NVIDIA: 'https://www.nvidia.com/Download/index.aspx',
  AMD: 'https://www.amd.com/en/support/download/drivers.html',
  Intel: 'https://www.intel.com/content/www/us/en/support/detect.html',
};
const ACTION_ICON = {
  installMod: 'download',
  enableMod: 'power',
  disableMod: 'ban',
  updateMods: 'upCircle',
  searchMod: 'search',
  raiseRam: 'memory',
  lowerRam: 'memory',
  fixRam: 'memory',
  useJava: 'coffee',
  resetJava: 'coffee',
  removeJvmArg: 'terminal',
  resetConfig: 'undo',
  openFolder: 'folderOpen',
  openUrl: 'external',
  repairInstance: 'wrench',
  updateLoader: 'refresh',
  openInstanceSettings: 'sliders',
  openSettings: 'settings',
  restoreSnapshot: 'history',
  startBisect: 'crSplit',
  disableShaders: 'sun',
};
// Acciones que hace el proceso principal (crash:fix)
const MAIN_ACTIONS = new Set(['disableMod', 'enableMod', 'raiseRam', 'lowerRam', 'fixRam', 'useJava', 'resetJava', 'removeJvmArg', 'resetConfig', 'updateLoader', 'disableShaders']);

const bisects = new Map(); // instanceId -> ultimo estado de la busqueda
const views = new Map(); // instanceId -> Set(fn) vistas abiertas que siguen la busqueda
const crashDialogs = new Map();
const toolDialogs = new Map();
const openingTools = new Set();
const autoOpened = new Map();
let listening = false;

const isMissingChannel = (err) => /No handler registered/i.test(err?.message || '');

// Pestanas con teclado (patron ARIA): Izquierda/Derecha/Inicio/Fin cambian de pestana y le pasan el foco.
// Cada pestana lleva data-key; onPick vuelve a dibujar la lista, asi que el foco se busca despues.
function tabKeys(list, onPick) {
  list.addEventListener('keydown', (e) => {
    const tabs = [...list.querySelectorAll('[role="tab"]')];
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    const next = { ArrowRight: (i + 1) % tabs.length, ArrowLeft: (i - 1 + tabs.length) % tabs.length, Home: 0, End: tabs.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    const key = tabs[next].dataset.key;
    onPick(key);
    list.querySelector(`[data-key="${CSS.escape(key)}"]`)?.focus();
  });
}

async function prepare() {
  ensureCss('features/crash');
  try {
    await loadNs('crash');
  } catch {
    /* sin textos se ven las claves, pero no se rompe nada */
  }
  listen();
}

function listen() {
  if (listening) return;
  listening = true;
  api.on('crash:bisect', (id, st) => {
    bisects.set(id, st);
    for (const fn of views.get(id) || []) {
      try {
        fn(st);
      } catch (err) {
        console.error('[crash]', err);
      }
    }
    autoOpen(id, st);
  });
}

// Si la busqueda termina o necesita una respuesta y no hay ninguna ventana abierta, se muestra sola
function autoOpen(id, st) {
  if (toolDialogs.has(id)) return;
  let key = null;
  if (!st.active && st.result && st.status === 'done') key = `done:${st.finishedAt}`;
  else if (st.active && st.waiting && st.current?.game === 'closed') key = `ask:${st.round}`;
  if (!key || autoOpened.get(id) === key) return;
  autoOpened.set(id, key);
  if (key.startsWith('done')) toast('good', t('crash.finishedToast'), st.instanceName || '', 4000);
  openCrashTools(id, { tab: 'bisect' });
}

// Opcional: si app.js lo agrega a STARTUP, los resultados de la busqueda se muestran aunque la interfaz se recargue
export function startup() {
  listen();
}

function watch(id, fn) {
  if (!views.has(id)) views.set(id, new Set());
  views.get(id).add(fn);
  return () => views.get(id)?.delete(fn);
}

async function bisectStatus(id) {
  try {
    const st = await api.invoke('crash:bisectStatus', id);
    if (st) bisects.set(id, st);
    else bisects.delete(id);
    return st;
  } catch {
    return bisects.get(id) || null;
  }
}

async function instanceOf(id) {
  return store.instances.find((i) => i.id === id) || (await api.instances.get(id).catch(() => null));
}

function loadersFor(inst) {
  switch (inst?.loader) {
    case 'fabric':
    case 'legacyfabric':
      return ['fabric'];
    case 'quilt':
      return ['quilt', 'fabric'];
    case 'forge':
      return ['forge'];
    case 'neoforge':
      return inst.mcVersion === '1.20.1' ? ['neoforge', 'forge'] : ['neoforge'];
    default:
      return [];
  }
}

const estimateRounds = (n) => (n > 0 ? 1 + Math.ceil(1.4 * Math.log2(Math.max(2, n))) + 1 : 0);

function clock(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  const h2 = Math.floor(m / 60);
  return h2 ? `${h2}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`;
}

function listText(names) {
  const uniq = [...new Set(names.filter(Boolean))];
  try {
    return new Intl.ListFormat(document.documentElement.lang || 'es', { style: 'long', type: 'conjunction' }).format(uniq);
  } catch {
    return uniq.join(', ');
  }
}

// ---------- Acciones ----------

function openModrinthSearch(query, inst) {
  const params = new URLSearchParams({ q: query || '' });
  if (inst?.mcVersion) params.set('v', inst.mcVersion);
  const loader = loadersFor(inst)[0];
  if (loader) params.set('g', `categories:${loader}`);
  api.app.openExternal(`https://modrinth.com/mods?${params.toString()}`).catch(() => {});
}

async function findProject(p, inst) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const tries = [...new Set([p.slug, p.modId, String(p.modId || '').replace(/_/g, '-')].filter(Boolean))];
  for (const id of tries) {
    try {
      const pr = await api.modrinth.project(id);
      if (pr?.id && (!pr.project_type || pr.project_type === 'mod')) return pr;
    } catch {
      /* no existe con ese slug */
    }
  }
  try {
    const res = await api.modrinth.search({ query: p.name || p.modId, type: 'mod', gameVersion: inst?.mcVersion, loaders: loadersFor(inst), limit: 6 });
    const hits = res?.hits || [];
    const exact = hits.find((x) => [norm(x.slug), norm(x.title)].some((v) => v && (v === norm(p.modId) || v === norm(p.name))));
    if (exact) return await api.modrinth.project(exact.project_id || exact.slug);
    const first = hits[0];
    if (first && (await confirmDialog(t('crash.installConfirmTitle', { name: p.name || p.modId }), t('crash.installConfirmText', { title: first.title, author: first.author || '?' }), { okText: t('common.install') }))) {
      return await api.modrinth.project(first.project_id || first.slug);
    }
  } catch {
    /* sin conexion */
  }
  return null;
}

async function installMod(instanceId, p) {
  const inst = await instanceOf(instanceId);
  toast('info', t('crash.installSearching', { name: p.name || p.modId }), null, 2500);
  const project = await findProject(p, inst);
  if (!project) {
    toast('info', t('crash.installNotFound', { name: p.name || p.modId }), t('crash.installNotFoundText'), 6000);
    openModrinthSearch(p.name || p.modId, inst);
    return false;
  }
  // El flujo de instalacion del modulo Modrinth ya revisa compatibilidad y dependencias
  try {
    const m = await import('./install.js');
    await m.openInstallDialog(project, { instanceId, type: 'mod' });
    return false;
  } catch (err) {
    console.warn('[crash] instalar', err);
  }
  // checkBeforeInstall puede elegir otra version u omitir el mod (cambia items en el lugar)
  const items = [{ projectId: project.id, type: 'mod' }];
  let go = true;
  try {
    const c = await import('./compat.js');
    go = await c.checkBeforeInstall({ target: { kind: 'instance', id: instanceId }, items });
  } catch {
    go = true;
  }
  if (!go || !items.length) return false;
  await api.modrinth.install(instanceId, items[0].projectId, items[0].versionId || null);
  ok(t('crash.installStarted', { name: project.title }), t('crash.installStartedText', { instance: inst?.name || '' }));
  return 'done';
}

async function openUpdates(instanceId) {
  try {
    const c = await import('./compat.js');
    await c.openModUpdates(instanceId);
  } catch (err) {
    console.warn('[crash] actualizaciones', err);
    navigate(`instance/${instanceId}/mods`);
  }
}

async function openSnapshotsFor(instanceId) {
  try {
    const s = await import('./snapshots.js');
    await s.openSnapshots(instanceId);
  } catch (err) {
    console.warn('[crash] instantaneas', err);
    toast('info', t('crash.unavailable'));
  }
}

function chooseDrivers() {
  const m = modal({
    title: t('crash.driversTitle'),
    size: 'sm',
    body: h(
      'div',
      { class: 'stack' },
      h('p', { class: 'text-2', style: { margin: 0 } }, t('crash.driversText')),
      h(
        'div',
        { class: 'cr-vendors' },
        Object.entries(DRIVER_URLS).map(([name, url]) =>
          h(
            'button',
            {
              class: 'btn',
              type: 'button',
              onclick: () => {
                api.app.openExternal(url).catch(() => {});
                m.close();
              },
            },
            icon('monitor'),
            name,
          ),
        ),
      ),
    ),
  });
}

// Ruta directa a una seccion de Ajustes (#/settings/<seccion>[/<ancla>], ver pages/settings.js).
// Sin seccion valida va a Java (runtimes y memoria global), que es lo que suele importar en un crash.
const SETTINGS_SECTIONS = new Set(['general', 'appearance', 'a11y', 'cloud', 'privacy', 'ai', 'curseforge', 'discord', 'java', 'storage', 'data', 'about']);
function settingsRoute(section, anchor) {
  const sec = SETTINGS_SECTIONS.has(section) ? section : 'java';
  return typeof anchor === 'string' && /^[a-z]{2,20}$/.test(anchor) ? `settings/${sec}/${anchor}` : `settings/${sec}`;
}

// Ejecuta una accion sugerida. Devuelve 'done' si quedo aplicada (el boton pasa a "Hecho").
async function runAction(instanceId, a, ctx = {}) {
  const p = a.payload || {};
  switch (a.type) {
    case 'installMod':
      return installMod(instanceId, p);
    case 'updateMods':
      await openUpdates(instanceId);
      return false;
    case 'searchMod':
      openModrinthSearch(p.query, await instanceOf(instanceId));
      return false;
    case 'openFolder':
      await api.instances.openFolder(instanceId, p.sub || '');
      return false;
    case 'openUrl':
      if (p.chooser || !/^https:\/\//.test(p.url || '')) chooseDrivers();
      else await api.app.openExternal(p.url);
      return false;
    case 'repairInstance':
      api.instances.repair(instanceId).catch((err) => fail(t('crash.actionFailed'), err));
      toast('info', t('crash.repairStarted'), t('crash.repairStartedText'));
      return 'done';
    case 'openInstanceSettings':
      ctx.close?.();
      navigate(`instance/${instanceId}/settings`);
      return false;
    case 'openSettings':
      ctx.close?.();
      navigate(settingsRoute(p.section, p.anchor));
      return false;
    case 'restoreSnapshot':
      await openSnapshotsFor(instanceId);
      return false;
    case 'startBisect':
      ctx.startBisect?.(p.mode);
      return false;
    default:
      break;
  }
  if (!MAIN_ACTIONS.has(a.type)) return false;
  if (a.type === 'resetConfig') {
    const file = String(p.file || '').split('/').pop();
    if (!(await confirmDialog(t('crash.confirmResetTitle', { file }), t('crash.confirmResetText'), { okText: t('crash.confirmResetOk') }))) return false;
  }
  const res = await api.invoke('crash:fix', instanceId, { type: a.type, payload: p });
  ok(a.label, res?.message || '');
  store.refreshInstances().catch(() => {});
  return 'done';
}

function actionButton(instanceId, a, ctx, extra = '') {
  const btn = h('button', { class: ['btn', 'sm', a.primary ? 'primary' : null, extra], type: 'button', title: a.label }, icon(ACTION_ICON[a.type] || 'wrench'), h('span', {}, a.label));
  btn.addEventListener('click', async () => {
    if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') return;
    // Spinner en lugar del icono mientras corre (setBusy de ui.js); al terminar devuelve el foco
    const release = setBusy(btn);
    let res = false;
    try {
      res = await runAction(instanceId, a, ctx);
    } catch (err) {
      fail(t('crash.actionFailed'), err);
    } finally {
      release();
    }
    // Aplicada: queda como confirmacion "Hecho" (sigue enfocable, pero no se puede repetir)
    if (res === 'done' && btn.isConnected) {
      btn.classList.remove('primary');
      btn.classList.add('cr-done');
      btn.setAttribute('aria-disabled', 'true');
      btn.title = `${a.label} · ${t('crash.done')}`;
      mount(btn, icon('check'), h('span', {}, t('crash.done')));
      btn.dispatchEvent(new CustomEvent('cr-applied', { bubbles: true }));
    }
  });
  return btn;
}

// ---------- Piezas del analisis ----------

// Rotulo de seccion (sobre-titulo); para el lector de pantalla es un encabezado debajo del titulo del dialogo
function sectionLabel(text, extra) {
  return h('div', { class: 'cr-label' }, h('span', { role: 'heading', 'aria-level': '4' }, text), extra || null);
}

function modChip(m) {
  return h(
    'span',
    { class: ['cr-modchip', m.enabled === false && 'off'], title: [m.name, m.version, m.file].filter(Boolean).join(' · ') },
    icon('puzzle'),
    h('span', { class: 'cr-modchip-name' }, m.name),
    m.version ? h('span', { class: 'cr-modchip-ver' }, m.version) : null,
    m.library ? h('span', { class: 'cr-tag' }, t('crash.library')) : null,
  );
}

function confidencePill(conf) {
  const cls = conf === 'high' ? 'good' : conf === 'medium' ? 'warn' : '';
  return h('span', { class: ['pill', cls, 'cr-conf'] }, t(`crash.confidence_${conf || 'low'}`));
}

// Cargando el analisis: la misma tarjeta que el resultado, con texto y skeleton (sin saltos al terminar)
function loadingCard() {
  return h(
    'section',
    { class: 'cr-what is-loading', 'aria-busy': 'true' },
    sectionLabel(t('crash.whatHappened')),
    h('div', {}, h('div', { class: 'cr-loading-title' }, t('crash.analyzing')), h('div', { class: 'cr-loading-sub' }, t('crash.analyzingSub'))),
    skeleton(2, { label: t('crash.analyzing') }),
    h('div', { class: 'cr-skel-actions', 'aria-hidden': 'true' }, h('span', { class: 'skeleton', style: { width: '156px' } }), h('span', { class: 'skeleton', style: { width: '128px' } })),
  );
}

function whatCard(f, instanceId, ctx) {
  return h(
    'section',
    { class: ['cr-what', `sev-${f.severity || 'bad'}`] },
    sectionLabel(t('crash.whatHappened'), confidencePill(f.confidence)),
    h('h3', { class: 'cr-what-title' }, f.title),
    h('p', { class: 'cr-what-text selectable' }, f.text),
    f.mods?.length ? h('div', { class: 'cr-mods' }, f.mods.map(modChip)) : null,
    f.actions?.length ? h('div', { class: 'cr-actions' }, f.actions.map((a) => actionButton(instanceId, a, ctx))) : null,
  );
}

function moreFindings(list, instanceId, ctx) {
  if (!list.length) return null;
  return h(
    'section',
    { class: 'cr-more' },
    sectionLabel(t('crash.alsoFound')),
    list.map((f) =>
      h(
        'div',
        { class: 'cr-more-item' },
        h('span', { class: ['cr-more-icon', `sev-${f.severity || 'bad'}`] }, icon(f.severity === 'warn' ? 'info' : 'alert')),
        h(
          'div',
          { class: 'cr-more-main' },
          h('div', { class: 'cr-more-title' }, f.title, ' ', confidencePill(f.confidence)),
          h('div', { class: 'cr-more-text selectable' }, f.text),
          f.actions?.length ? h('div', { class: 'cr-actions' }, f.actions.slice(0, 3).map((a) => actionButton(instanceId, { ...a, primary: false }, ctx))) : null,
        ),
      ),
    ),
  );
}

function suspectsCard(data, instanceId, ctx) {
  const head = data.findings[0];
  const inHead = new Set((head?.mods || []).map((m) => m.file));
  const list = (data.suspects || []).filter((s) => !inHead.has(s.file)).slice(0, 4);
  if (!list.length) return null;
  const max = Math.max(...list.map((s) => s.score), 1);
  return h(
    'section',
    { class: 'cr-suspects' },
    sectionLabel(t('crash.suspectsTitle')),
    h('p', { class: 'cr-suspects-hint' }, t('crash.suspectsHint')),
    list.map((s) =>
      h(
        'div',
        { class: 'cr-suspect' },
        h('div', { class: 'cr-suspect-icon', 'aria-hidden': 'true' }, icon('puzzle')),
        h(
          'div',
          { class: 'cr-suspect-main' },
          h('div', { class: 'cr-suspect-name', title: [s.name, s.version, s.file].filter(Boolean).join(' · ') }, h('span', {}, s.name), s.version ? h('span', { class: 'cr-suspect-ver' }, s.version) : null, s.library ? h('span', { class: 'cr-tag' }, t('crash.library')) : null),
          h('div', { class: 'cr-suspect-why', title: s.reasons.join(' · ') }, s.reasons.join(' · ')),
          h('div', { class: 'cr-meter', 'aria-hidden': 'true' }, h('i', { style: { width: `${Math.round((s.score / max) * 100)}%` } })),
        ),
        actionButton(instanceId, { type: 'disableMod', label: t('crash.disable'), payload: { file: s.file, name: s.name } }, ctx, 'cr-suspect-btn'),
      ),
    ),
  );
}

// Texto de la IA -> parrafos y listas (sin HTML)
function inlineMd(s) {
  const out = [];
  const re = /\*\*(.+?)\*\*|`([^`]+)`/g;
  let last = 0;
  let m;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    out.push(m[1] ? h('strong', {}, m[1]) : h('code', {}, m[2]));
    last = re.lastIndex;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

function aiBody(text) {
  const root = h('div', { class: 'cr-ai-text selectable' });
  let list = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      list = null;
      continue;
    }
    const num = line.match(/^(\d+)[.)]\s+(.*)$/);
    const bullet = line.match(/^[-*•]\s+(.*)$/);
    if (num || bullet) {
      const tag = num ? 'ol' : 'ul';
      if (!list || list.tagName.toLowerCase() !== tag) {
        list = h(tag);
        root.append(list);
      }
      list.append(h('li', {}, inlineMd(num ? num[2] : bullet[1])));
    } else {
      list = null;
      root.append(h('p', {}, inlineMd(line.replace(/^#+\s*/, ''))));
    }
  }
  return root;
}

function aiTool(data, instanceId, ctx) {
  const out = h('div', { class: 'cr-ai-out-slot', 'aria-live': 'polite' });
  const btnSlot = h('div', { class: 'cr-tool-side' });
  const available = Boolean(data.ai?.available);
  // Secundario: el boton principal del dialogo es el arreglo sugerido (o "Volver a jugar")
  const askLabel = h('span', {}, t('crash.aiButton'));
  const askBtn = h('button', { class: 'btn sm', type: 'button' }, icon('sparkles'), askLabel);
  const ask = async () => {
    const hadFocus = document.activeElement === askBtn;
    const release = setBusy(askBtn);
    askLabel.textContent = t('crash.aiWorking');
    mount(out, skeleton(3, { label: t('crash.aiWorking') }));
    try {
      const res = await api.invoke('crash:explainAi', instanceId);
      const copyBtn = h('button', { class: 'icon-btn sm', type: 'button', title: t('crash.aiCopy'), 'aria-label': t('crash.aiCopy'), onclick: () => copyText(res.text) }, icon('copy'));
      mount(
        out,
        h(
          'div',
          { class: 'cr-ai-out' },
          h('div', { class: 'cr-ai-head' }, h('span', { class: 'badge accent' }, icon('sparkles'), t('crash.aiGenerated')), res.model ? h('span', { class: 'cr-ai-model' }, res.model) : null, h('span', { class: 'cr-spacer' }), copyBtn),
          aiBody(res.text),
          h('div', { class: 'cr-ai-note' }, t('crash.aiDisclaimer')),
        ),
      );
      release();
      mount(btnSlot);
      // El boton desaparece: el foco pasa a la explicacion (copiar) para no perderse
      if (hadFocus) copyBtn.focus({ preventScroll: true });
    } catch (err) {
      mount(out);
      release();
      fail(t('crash.aiFailed'), err);
      mount(askBtn, icon('refresh'), askLabel);
      askLabel.textContent = t('common.retry');
    }
  };
  askBtn.addEventListener('click', ask);
  if (available) mount(btnSlot, askBtn);
  else
    mount(
      btnSlot,
      h(
        'button',
        {
          class: 'btn sm',
          type: 'button',
          onclick: () => {
            ctx.close?.();
            navigate('settings/ai');
          },
        },
        icon('settings'),
        t('crash.aiConfigure'),
      ),
    );
  return h(
    'div',
    { class: 'cr-tool' },
    h(
      'div',
      { class: 'cr-tool-row' },
      h('div', { class: 'cr-tool-icon ai', 'aria-hidden': 'true' }, icon('sparkles')),
      h('div', { class: 'cr-tool-main' }, h('div', { class: 'cr-tool-title' }, t('crash.aiTitle')), h('div', { class: 'cr-tool-text' }, available ? t('crash.aiText') : t('crash.aiNotConfigured'))),
      btnSlot,
    ),
    out,
  );
}

function bisectTool(data, instanceId, ctx) {
  const b = data.bisect || {};
  const n = data.mods?.enabled || 0;
  let side;
  if (b.running) side = h('button', { class: 'btn sm', type: 'button', onclick: () => ctx.startBisect?.(b.suggestedMode) }, icon('activity'), t('crash.bisectView'));
  else if (!b.possible) side = h('span', { class: 'cr-tool-why' }, t(b.reason === 'noLoader' ? 'crash.bisectNoLoader' : 'crash.bisectNoMods'));
  else side = h('button', { class: 'btn sm', type: 'button', onclick: () => ctx.startBisect?.(b.suggestedMode) }, icon('crSplit'), t('crash.bisectStart'));
  return h(
    'div',
    { class: 'cr-tool' },
    h(
      'div',
      { class: 'cr-tool-row' },
      h('div', { class: 'cr-tool-icon', 'aria-hidden': 'true' }, icon('crSplit')),
      h(
        'div',
        { class: 'cr-tool-main' },
        h('div', { class: 'cr-tool-title' }, t('crash.bisectTitle')),
        h('div', { class: 'cr-tool-text' }, t('crash.bisectText')),
        b.possible ? h('div', { class: 'cr-tool-facts' }, icon('crFlask'), t('crash.bisectFacts', { count: n, rounds: b.estimate || estimateRounds(n) })) : null,
      ),
      h('div', { class: 'cr-tool-side' }, side),
    ),
  );
}

function lineClass(line) {
  if (/\/(ERROR|FATAL)\]|^\s*(at |Caused by:|Exception in thread)|^[\w.$]+(Exception|Error|Throwable)(:|\s*$)|^#\s/.test(line)) return 'l-ERROR';
  if (/\/WARN\]/.test(line)) return 'l-WARN';
  return 'l-INFO';
}

function consoleOf(text, label, max = 1600) {
  const lines = String(text || '').split(/\r?\n/);
  const shown = lines.length > max ? lines.slice(-max) : lines;
  if (!shown.join('').trim()) return h('div', { class: 'console cr-console' }, h('div', { class: 'muted' }, t('crash.noDetails')));
  // Zona con scroll propia: enfocable con Tab (flechas para leer) y con nombre para el lector de pantalla
  return h(
    'div',
    { class: 'console cr-console', tabindex: 0, role: 'region', 'aria-label': label || t('crash.details') },
    shown.map((l) => h('div', { class: lineClass(l) }, l || ' ')),
  );
}

function buildReport(data, instName) {
  const head = data.findings?.[0];
  const inst = data.instance || {};
  const parts = [
    t('crash.reportHeader', { name: instName || inst.name || '' }),
    t('crash.reportInstance', { mc: inst.mcVersion || '?', loader: `${inst.loader || ''} ${inst.loaderVersion || ''}`.trim() }),
    data.code !== null && data.code !== undefined ? t('crash.reportCode', { code: data.code }) : '',
    head ? t('crash.reportCause', { title: head.title }) : '',
    head ? head.text : '',
    data.exception ? t('crash.reportException', { exception: `${data.exception.cls}: ${data.exception.msg}` }) : '',
    '',
    data.details?.report || data.details?.log || '',
  ];
  return parts.filter((x, i) => x || i === 6).join('\n').trim();
}

function detailsBlock(data, instanceId, instName, logsFallback) {
  const det = data?.details || { report: '', log: (logsFallback || []).map((l) => l.text).join('\n'), hsErr: '' };
  const tabs = [
    det.report ? ['report', t('crash.tabReport'), det.report] : null,
    det.log ? ['log', t('crash.tabLog'), det.log] : null,
    det.hsErr ? ['hsErr', t('crash.tabHsErr'), det.hsErr] : null,
  ].filter(Boolean);
  let current = tabs[0]?.[0] || 'log';
  const consoleSlot = h('div', { class: 'cr-console-slot' });
  const seg = h('div', { class: 'segmented cr-seg', role: 'tablist', 'aria-label': t('crash.details') });
  const draw = () => {
    mount(
      seg,
      tabs.map(([key, label]) =>
        h('button', { type: 'button', role: 'tab', tabindex: current === key ? 0 : -1, dataset: { key }, 'aria-selected': String(current === key), class: current === key ? 'active' : null, onclick: () => ((current = key), draw()) }, label),
      ),
    );
    const tab = tabs.find((x) => x[0] === current);
    const box = consoleOf(tab ? tab[2] : '', tab ? tab[1] : null);
    mount(consoleSlot, box);
    if (current !== 'report') requestAnimationFrame(() => (box.scrollTop = box.scrollHeight));
  };
  draw();
  tabKeys(seg, (key) => {
    current = key;
    draw();
  });
  const exc = data?.exception;
  const excName = exc ? `${exc.root?.cls || exc.cls}`.split('.').pop() : '';
  return h(
    'details',
    { class: 'cr-details' },
    h('summary', {}, icon('chevronRight', 'cr-caret'), h('span', { class: 'cr-details-title' }, t('crash.details')), exc ? h('span', { class: 'cr-exc mono ellipsis', title: excName }, excName) : null),
    h(
      'div',
      { class: 'cr-details-body' },
      exc ? h('div', { class: 'cr-exc-full mono selectable' }, `${exc.cls}: ${exc.msg}`, exc.root ? h('div', { class: 'cr-exc-root' }, `↳ ${exc.root.cls}: ${exc.root.msg}`) : null) : null,
      tabs.length > 1 ? seg : null,
      consoleSlot,
      h(
        'div',
        { class: 'row wrap cr-details-actions' },
        data ? h('button', { class: 'btn sm', type: 'button', onclick: () => copyText(buildReport(data, instName), t('crash.copyReport')) }, icon('copy'), t('crash.copyReport')) : null,
        h('button', { class: 'btn sm ghost', type: 'button', onclick: () => api.instances.openFolder(instanceId, 'crash-reports').catch((err) => fail(t('crash.actionFailed'), err)) }, icon('folderOpen'), t('crash.openCrashFolder')),
      ),
    ),
  );
}

function renderAnalysis(box, data, instanceId, ctx) {
  const [head, ...rest] = data.findings || [];
  mount(
    box,
    head ? whatCard(head, instanceId, ctx) : null,
    moreFindings(rest.slice(0, 4), instanceId, ctx),
    suspectsCard(data, instanceId, ctx),
    sectionLabel(t('crash.moreHelp')),
    h('div', { class: 'cr-tools-list' }, aiTool(data, instanceId, ctx), bisectTool(data, instanceId, ctx)),
    detailsBlock(data, instanceId, ctx.instName),
  );
}

function metaRow(inst, state) {
  const loaderKey = inst ? instanceLoaderKey(inst) : null;
  return h(
    'div',
    { class: 'cr-meta' },
    inst ? instanceIcon(inst, 'cr-inst') : h('div', { class: 'inst-icon cr-inst' }, icon('gamepad')),
    h(
      'div',
      { class: 'cr-meta-main' },
      h('div', { class: 'cr-meta-name ellipsis', title: inst?.name || 'Minecraft' }, inst?.name || 'Minecraft'),
      h(
        'div',
        { class: 'row wrap cr-meta-badges' },
        inst?.mcVersion ? h('span', { class: 'badge' }, icon('box'), `Minecraft ${inst.mcVersion}`) : null,
        loaderKey ? loaderBadge(loaderKey, loaderVersionLabel(inst)) : null,
        state?.code !== undefined && state?.code !== null ? h('span', { class: 'badge bad' }, icon('alert'), t('crash.exitCode', { code: state.code })) : null,
        h('span', { class: 'cr-meta-when' }, fmtAgo(Date.now())),
      ),
    ),
  );
}

// ---------- Dialogo "el juego se cerro" ----------

export async function showCrashDialog(instanceId, state = {}) {
  await prepare();
  // Durante la busqueda del culpable los cierres son parte de las pruebas
  if (bisects.get(instanceId)?.active) return;
  const st = await bisectStatus(instanceId);
  if (st?.active) return;
  crashDialogs.get(instanceId)?.close();
  const inst = await instanceOf(instanceId);
  const name = inst?.name || 'Minecraft';
  const body = h('div', { class: 'cr-body' });
  const ctx = {
    instName: name,
    close: () => m.close(),
    startBisect: (mode) => {
      m.close();
      openCrashTools(instanceId, { tab: 'bisect', mode });
    },
  };
  const playBtn = h(
    'button',
    {
      class: 'btn primary',
      type: 'button',
      onclick: () => {
        m.close();
        launchInstance(instanceId);
      },
    },
    icon('play'),
    t('crash.playAgain'),
  );
  const m = modal({
    // Encabezado comun de herramientas (icono + titulo); en rojo porque avisa un problema
    title: t('crash.dialogTitle'),
    icon: 'skull',
    size: 'wide cr-modal cr-alert',
    body,
    footer: [
      h('button', { class: 'btn ghost', type: 'button', onclick: () => openSnapshotsFor(instanceId) }, icon('history'), t('crash.restoreSnapshot')),
      h('span', { class: 'cr-spacer' }),
      h('button', { class: 'btn ghost', type: 'button', onclick: () => m.close() }, t('common.close')),
      playBtn,
    ],
    onClose: () => crashDialogs.delete(instanceId),
  });
  crashDialogs.set(instanceId, m);
  const content = h('div', { class: 'cr-content' });
  mount(body, metaRow(inst, state), content);
  // Un solo boton principal por vista: si el analisis propone un arreglo, "Volver a jugar" pasa a secundario
  // (y vuelve a ser el principal cuando el arreglo ya se aplico)
  const setPlayPrimary = (on) => playBtn.classList.toggle('primary', on);
  body.addEventListener('cr-applied', () => setPlayPrimary(!content.querySelector('.btn.primary')));
  const analyze = async () => {
    mount(content, loadingCard());
    let data;
    try {
      data = await api.invoke('crash:analyze', instanceId, { logs: state.logs || [], code: state.code });
    } catch (err) {
      if (!m.el.isConnected) return;
      console.warn('[crash] analisis', err);
      const missing = isMissingChannel(err);
      mount(
        content,
        h(
          'section',
          { class: 'cr-what sev-warn' },
          sectionLabel(t('crash.whatHappened')),
          h('h3', { class: 'cr-what-title' }, t('crash.fallbackTitle')),
          h('p', { class: 'cr-what-text' }, t('crash.fallbackText', { error: missing ? t('crash.unavailable') : err.message })),
          missing ? null : h('div', { class: 'cr-actions' }, h('button', { class: 'btn sm', type: 'button', onclick: analyze }, icon('refresh'), t('common.retry'))),
        ),
        detailsBlock(null, instanceId, name, state.logs || []),
      );
      setPlayPrimary(true);
      return;
    }
    if (!m.el.isConnected) return;
    renderAnalysis(content, data, instanceId, ctx);
    setPlayPrimary(!content.querySelector('.btn.primary'));
  };
  await analyze();
}

// ---------- Herramientas: ultimo crash + busqueda del culpable ----------

export async function openCrashTools(instanceId, opts = {}) {
  await prepare();
  const existing = toolDialogs.get(instanceId);
  if (existing) {
    existing.show(opts.tab || null, opts.mode);
    return;
  }
  // Si se pide dos veces seguidas (aviso automatico + clic) se abre una sola ventana
  if (openingTools.has(instanceId)) return;
  openingTools.add(instanceId);
  let inst;
  let bisect;
  try {
    [inst, bisect] = await Promise.all([instanceOf(instanceId), bisectStatus(instanceId)]);
  } finally {
    openingTools.delete(instanceId);
  }
  if (toolDialogs.has(instanceId)) return;
  const name = inst?.name || instanceId;
  let tab = opts.tab || (bisect && (bisect.active || bisect.result || bisect.status === 'recovered') ? 'bisect' : 'last');
  let preferredMode = opts.mode || null;
  let lastSelection = null;
  const offs = [];
  const timers = [];

  const tabsEl = h('div', { class: 'segmented cr-tabs', role: 'tablist', 'aria-label': t('crash.toolsTitle') });
  const tabId = (key) => `cr-tab-${key}-${instanceId.replace(/[^\w-]/g, '_')}`;
  const panel = h('div', { class: 'cr-panel', role: 'tabpanel', tabindex: '-1' });
  // Accion principal de la vista actual (siempre visible en el pie, aunque el contenido tenga scroll)
  const footAction = h('span', { class: 'cr-foot-action' });
  const m = modal({
    title: t('crash.toolsTitle'),
    subtitle: name,
    icon: 'bug',
    size: 'wide cr-modal cr-tools-modal',
    body: h('div', { class: 'cr-body' }, tabsEl, panel),
    footer: [h('span', { class: 'cr-spacer' }), h('button', { class: 'btn ghost', type: 'button', onclick: () => m.close() }, t('common.close')), footAction],
    onClose: () => {
      toolDialogs.delete(instanceId);
      offs.forEach((off) => off());
      timers.forEach((x) => clearInterval(x));
    },
  });
  const ctx = {
    instName: name,
    close: () => m.close(),
    startBisect: (mode) => {
      preferredMode = mode || preferredMode;
      setTab('bisect');
    },
  };

  const drawTabs = () => {
    mount(
      tabsEl,
      [
        ['last', t('crash.tabLast'), 'fileText'],
        ['bisect', t('crash.tabBisect'), 'crSplit'],
      ].map(([key, label, ic]) =>
        h(
          'button',
          { type: 'button', role: 'tab', id: tabId(key), tabindex: tab === key ? 0 : -1, dataset: { key }, 'aria-selected': String(tab === key), class: tab === key ? 'active' : null, onclick: () => setTab(key) },
          icon(ic),
          label,
          key === 'bisect' && bisect?.active ? h('span', { class: 'cr-live-dot', 'aria-hidden': 'true' }) : null,
        ),
      ),
    );
    panel.setAttribute('aria-labelledby', tabId(tab));
  };
  tabKeys(tabsEl, (key) => setTab(key));

  function setTab(key) {
    tab = key;
    mount(footAction);
    timers.forEach((x) => clearInterval(x));
    timers.length = 0;
    drawTabs();
    if (tab === 'last') renderLast();
    else renderBisect();
  }

  // ----- Ultimo crash -----
  async function renderLast() {
    mount(panel, loadingCard());
    let list;
    try {
      list = await api.invoke('crash:reports', instanceId);
    } catch (err) {
      if (tab !== 'last') return;
      // Error: que paso + como seguir (Reintentar); sin el modulo, solo la explicacion
      mount(
        panel,
        isMissingChannel(err)
          ? emptyState('alert', t('crash.unavailable'))
          : emptyState('alert', t('crash.loadFailedTitle'), err.message, h('button', { class: 'btn', type: 'button', onclick: renderLast }, icon('refresh'), t('common.retry'))),
      );
      return;
    }
    if (tab !== 'last') return;
    const reports = (list.reports || []).filter((r) => r.kind === 'report');
    const options = [...reports.map((r) => ({ value: `report:${r.name}`, label: t('crash.reportOption', { date: `${fmtDate(r.mtime)} ${fmtTime(r.mtime)}` }) }))];
    if (list.latest || list.session) options.push({ value: 'latest', label: t('crash.latestOption') });
    if (!options.length) {
      mount(panel, emptyState('shieldCheck', t('crash.noCrashesTitle'), t('crash.noCrashesText')));
      return;
    }
    const pick = lastSelection && options.some((o) => o.value === lastSelection) ? lastSelection : options[0].value;
    const box = h('div', { class: 'cr-content' });
    const analyzeSel = async (value) => {
      lastSelection = value;
      mount(box, loadingCard());
      try {
        const data = await api.invoke('crash:analyze', instanceId, value === 'latest' ? { latestOnly: true } : { report: value.slice(7) });
        if (tab === 'last' && box.isConnected) renderAnalysis(box, data, instanceId, ctx);
      } catch (err) {
        if (box.isConnected) {
          mount(box, h('div', { class: 'notice bad', role: 'alert' }, icon('alert'), h('div', { class: 'cr-error-row' }, h('div', {}, t('crash.loadFailed', { error: err.message })), h('button', { class: 'btn sm', type: 'button', onclick: () => analyzeSel(value) }, icon('refresh'), t('common.retry')))));
        }
      }
    };
    const selId = `cr-pick-${instanceId.replace(/[^\w-]/g, '_')}`;
    const sel = selectEl(options, pick, analyzeSel, 'select cr-select');
    sel.id = selId;
    mount(panel, h('div', { class: 'cr-pick' }, h('label', { class: 'label', for: selId }, t('crash.pickReport')), sel), box);
    analyzeSel(pick);
  }

  // ----- Busqueda del culpable -----
  function renderBisect() {
    mount(footAction);
    if (bisect?.active) return renderLive(bisect);
    if (bisect && (bisect.result || ['cancelled', 'error', 'recovered'].includes(bisect.status))) return renderResult(bisect);
    return renderStart();
  }

  async function renderStart() {
    // Cargando la lista de mods: la forma de la vista de inicio (no la del analisis)
    mount(panel, h('div', { class: 'cr-start' }, skeleton('title', { width: '55%' }), skeleton(2), h('div', { class: 'cr-modes', 'aria-hidden': 'true' }, h('span', { class: 'skeleton', style: { height: '112px' } }), h('span', { class: 'skeleton', style: { height: '112px' } }))));
    const fresh = await instanceOf(instanceId);
    let files = [];
    try {
      files = await api.instances.content(instanceId, 'mods');
    } catch {
      files = [];
    }
    if (tab !== 'bisect' || (bisect?.active ?? false)) return;
    const enabled = files.filter((f) => f.enabled && !f.isDir).length;
    const supports = MOD_LOADERS.includes(fresh?.loader);
    const running = Boolean(store.running[instanceId]);
    const account = store.selectedAccount();
    let mode = preferredMode === 'manual' ? 'manual' : 'crash';
    let snapshot = true;
    const suggested = preferredMode || 'crash';
    const modeBox = h('div', { class: 'cr-modes', role: 'radiogroup', 'aria-label': t('crash.startTitle') });
    const warnBox = h('div');
    const startBtn = h('button', { class: 'btn primary', type: 'button' }, icon('crSplit'), t('crash.startButton'));

    const drawModes = () => {
      mount(
        modeBox,
        [
          ['crash', 'zap', t('crash.modeCrash'), t('crash.modeCrashText')],
          ['manual', 'gamepad', t('crash.modeManual'), t('crash.modeManualText')],
        ].map(([key, ic, title, text]) =>
          h(
            'div',
            {
              class: ['cr-mode', mode === key && 'active'],
              role: 'radio',
              tabindex: mode === key ? 0 : -1,
              'aria-checked': String(mode === key),
              onclick: () => ((mode = key), drawModes()),
              onkeydown: (e) => {
                if (['Enter', ' ', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
                  e.preventDefault();
                  mode = e.key === 'Enter' || e.key === ' ' ? key : key === 'crash' ? 'manual' : 'crash';
                  drawModes();
                  modeBox.querySelector('.cr-mode.active')?.focus();
                }
              },
            },
            h('div', { class: 'cr-mode-top' }, h('span', { class: 'cr-mode-icon', 'aria-hidden': 'true' }, icon(ic)), h('span', { class: 'cr-mode-title' }, title), key === suggested ? h('span', { class: 'badge accent' }, t('crash.suggested')) : null, h('span', { class: 'cr-radio', 'aria-hidden': 'true' })),
            h('div', { class: 'cr-mode-text' }, text),
          ),
        ),
      );
      mount(
        warnBox,
        mode === 'manual'
          ? h(
              'div',
              { class: 'notice cr-notice' },
              icon('alert'),
              h(
                'div',
                { class: 'cr-notice-body' },
                h('div', {}, t('crash.manualWarn')),
                h(
                  'label',
                  { class: 'cr-check' },
                  h('input', { type: 'checkbox', checked: snapshot, onchange: (e) => (snapshot = e.currentTarget.checked) }),
                  h('span', {}, t('crash.snapshotFirstWorlds')),
                ),
              ),
            )
          : null,
      );
    };
    drawModes();

    // Lo que impide empezar, con su explicacion (y la salida, si la hay) justo arriba del boton
    let blocker = null;
    if (!supports) blocker = h('div', { class: 'notice cr-blocker' }, icon('info'), h('div', {}, t('crash.bisectNoLoader')));
    else if (!enabled) blocker = h('div', { class: 'notice cr-blocker' }, icon('info'), h('div', {}, t('crash.bisectNoMods')));
    else if (running) blocker = h('div', { class: 'notice cr-blocker' }, icon('info'), h('div', {}, t('crash.closeGameFirst')));
    else if (!account) blocker = h('div', { class: 'notice cr-blocker' }, icon('user'), h('div', {}, t('crash.needAccount')), h('button', { class: 'btn sm', type: 'button', onclick: () => openAccounts() }, icon('plus'), t('crash.addAccount')));
    startBtn.disabled = Boolean(blocker);

    startBtn.addEventListener('click', async () => {
      const release = setBusy(startBtn);
      if (mode === 'manual' && snapshot) {
        // Con los mundos: en este modo se juega con mods desactivados y el juego borra sus bloques al guardar.
        // Si no se pudo guardar, no se empieza (la casilla prometia poder volver atras).
        try {
          await api.invoke('snapshots:create', instanceId, { kind: 'auto', reason: t('crash.snapshotReason'), worlds: 'all' });
          ok(t('crash.snapshotSaved'), t('crash.snapshotSavedText'));
        } catch (err) {
          fail(t('crash.snapshotFailed'), err);
          release();
          return;
        }
      }
      try {
        bisect = await api.invoke('crash:bisectStart', instanceId, { mode });
        bisects.set(instanceId, bisect);
        autoOpened.delete(instanceId);
        drawTabs();
        renderBisect();
      } catch (err) {
        fail(t('crash.startFailed'), err);
        release();
      }
    });

    mount(
      panel,
      h(
        'div',
        { class: 'cr-start' },
        h('div', { class: 'cr-start-head' }, h('div', { class: 'cr-start-icon', 'aria-hidden': 'true' }, icon('crSplit')), h('div', {}, h('h3', { class: 'cr-start-title' }, t('crash.startTitle')), h('p', { class: 'cr-start-intro' }, t('crash.startIntro')))),
        modeBox,
        // Datos de la busqueda (solo si se puede buscar: "0 mods, unas 0 pruebas" no ayuda)
        supports && enabled
          ? h(
              'div',
              { class: 'cr-facts' },
              h('span', {}, icon('puzzle'), t('crash.factsMods', { count: enabled })),
              h('span', {}, icon('crFlask'), t('crash.factsRounds', { count: estimateRounds(enabled) })),
              h('span', {}, icon('clock'), t('crash.factsTime')),
            )
          : null,
        warnBox,
        h('div', { class: 'notice info cr-notice' }, icon('shieldCheck'), h('div', {}, t('crash.restoreNote'))),
        blocker,
      ),
    );
    if (tab === 'bisect') mount(footAction, startBtn);
  }

  const listScroll = new Map();
  function modList(key, title, files, st) {
    const prev = panel.querySelector(`[data-list="${key}"]`);
    if (prev) listScroll.set(key, prev.scrollTop);
    const sorted = files.map((f) => ({ file: f, ...(st.mods?.[f] || { name: f }) })).sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const box = h(
      'div',
      { class: 'cr-list', dataset: { list: key }, tabindex: 0 },
      sorted.length
        ? sorted.map((x) => h('div', { class: 'cr-list-item', title: x.file }, h('span', { class: ['cr-dot', key], 'aria-hidden': 'true' }), h('span', { class: 'ellipsis' }, x.name), x.library ? h('span', { class: 'cr-tag' }, t('crash.library')) : null))
        : h('div', { class: 'cr-list-empty' }, '—'),
    );
    box.setAttribute('aria-label', title);
    box.setAttribute('role', 'region');
    requestAnimationFrame(() => (box.scrollTop = listScroll.get(key) || 0));
    return h('div', { class: 'cr-col' }, h('div', { class: 'cr-col-title' }, title), box);
  }

  function historyList(st) {
    if (!st.history?.length) return null;
    const items = st.history.slice().reverse();
    return h(
      'div',
      { class: 'cr-history' },
      h('div', { class: 'cr-col-title' }, t('crash.history')),
      items.map((x) =>
        h(
          'div',
          { class: ['cr-hist', `is-${x.result}`] },
          h('span', { class: 'cr-hist-icon', 'aria-hidden': 'true' }, icon(x.result === 'works' ? 'check' : x.result === 'fails' ? 'x' : 'refresh')),
          h('span', { class: 'cr-hist-round' }, t('crash.historyItem', { round: x.round })),
          h('span', { class: 'cr-hist-mods' }, t('crash.modsCount', { count: x.enabled })),
          h('span', { class: 'cr-hist-result' }, t(`crash.result_${x.result}`), x.kind ? h('span', { class: 'cr-hist-kind' }, ` · ${t(`crash.kind_${x.kind}`)}`) : null),
          h('span', { class: 'cr-hist-time' }, clock(x.ms)),
        ),
      ),
    );
  }

  function renderLive(st) {
    const cur = st.current;
    const allFiles = Object.keys(st.mods || {});
    const enabled = cur?.enabled || [];
    const enabledSet = new Set(enabled);
    const disabled = allFiles.filter((f) => !enabledSet.has(f));
    const status = st.status === 'cancelling' ? 'cancelling' : st.waiting && cur ? 'waiting' : cur ? 'running' : 'starting';
    const pct = st.estimate ? Math.min(100, Math.round(((st.round - (cur ? 0.5 : 0)) / st.estimate) * 100)) : 0;
    const done = (st.history || []).filter((x) => x.ms);
    const avg = done.length ? done.reduce((a, x) => a + x.ms, 0) / done.length : 0;
    const left = Math.max(0, (st.estimate || 0) - (st.round || 0)) * avg + (cur && avg ? Math.max(0, avg - (Date.now() - cur.startedAt)) : 0);
    const elapsedEl = h('span', {}, t('crash.elapsed', { time: clock(Date.now() - st.startedAt) }));
    const gameKey = cur ? (cur.game === 'running' ? `game_running_${st.mode}` : `game_${cur.game || 'preparing'}`) : null;
    const phaseKey = cur ? (cur.purpose === 'check' || cur.purpose === 'deps' ? `purpose_${cur.purpose}` : `phase_${cur.phase || st.phase}`) : null;

    const answer = async (works, btn) => {
      const release = setBusy(btn);
      try {
        bisect = await api.invoke('crash:bisectAnswer', instanceId, works);
      } catch (err) {
        fail(t('crash.actionFailed'), err);
        release();
      }
    };
    const ask =
      st.mode === 'manual' && status === 'waiting'
        ? h(
            'div',
            { class: 'cr-ask', role: 'group', 'aria-label': t('crash.askTitle') },
            h('div', { class: 'cr-ask-title' }, t('crash.askTitle')),
            h('p', { class: 'cr-ask-text' }, t('crash.askText')),
            h(
              'div',
              { class: 'cr-ask-btns' },
              h('button', { class: 'btn danger lg', type: 'button', onclick: (e) => answer(false, e.currentTarget) }, icon('crThumbDown'), t('crash.askFails')),
              h('button', { class: 'btn good lg', type: 'button', onclick: (e) => answer(true, e.currentTarget) }, icon('crThumbUp'), t('crash.askWorks')),
            ),
            cur?.game === 'closed'
              ? h(
                  'button',
                  {
                    class: 'btn sm ghost cr-relaunch',
                    type: 'button',
                    onclick: async (e) => {
                      const release = setBusy(e.currentTarget);
                      try {
                        await api.invoke('crash:bisectRelaunch', instanceId);
                      } catch (err) {
                        fail(t('crash.actionFailed'), err);
                        release();
                      }
                    },
                  },
                  icon('play'),
                  t('crash.relaunch'),
                )
              : null,
          )
        : null;

    const cancelBtn = h(
      'button',
      {
        class: 'btn danger sm',
        type: 'button',
        disabled: status === 'cancelling',
        onclick: async (e) => {
          const btn = e.currentTarget;
          if (!(await confirmDialog(t('crash.cancelConfirmTitle'), t('crash.cancelConfirmText'), { okText: t('crash.cancelConfirmOk'), cancelText: t('crash.keepSearching'), danger: true }))) return;
          const release = setBusy(btn);
          try {
            bisect = await api.invoke('crash:bisectCancel', instanceId);
            renderBisect();
          } catch (err) {
            fail(t('crash.actionFailed'), err);
            release();
          }
        },
      },
      icon('x'),
      t('crash.cancel'),
    );

    mount(
      panel,
      h(
        'div',
        { class: 'cr-live' },
        h(
          'div',
          { class: 'cr-live-head' },
          h('div', { class: ['cr-live-icon', status], 'aria-hidden': 'true' }, status === 'waiting' ? icon('gamepad') : h('div', { class: 'spinner' })),
          h(
            'div',
            { class: 'cr-live-main' },
            h('div', { class: 'cr-live-title', role: 'status' }, t(`crash.live_${status}`), h('span', { class: 'badge' }, st.mode === 'manual' ? t('crash.modeBadgeManual') : t('crash.modeBadgeCrash'))),
            h('div', { class: 'cr-live-sub' }, st.round ? t('crash.roundOf', { round: st.round, estimate: st.estimate }) : null, st.round ? h('span', { class: 'cr-sep', 'aria-hidden': 'true' }, '·') : null, elapsedEl, avg ? h('span', { class: 'cr-sep', 'aria-hidden': 'true' }, '·') : null, avg ? h('span', {}, t('crash.eta', { time: clock(left) })) : null),
          ),
          cancelBtn,
        ),
        h('div', { class: 'progress cr-progress', role: 'progressbar', 'aria-label': t(`crash.live_${status}`), 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': pct }, h('i', { style: { width: `${pct}%` } })),
        cur
          ? h(
              'div',
              { class: 'cr-current' },
              h('span', { class: 'cr-current-icon', 'aria-hidden': 'true' }, icon('crFlask')),
              h('div', { class: 'cr-current-main' }, h('div', { class: 'cr-current-title' }, t(`crash.${phaseKey}`)), h('div', { class: 'cr-current-sub' }, t(`crash.${gameKey}`))),
              h('span', { class: 'pill' }, t('crash.modsCount', { count: enabled.length })),
            )
          : null,
        ask,
        cur ? h('div', { class: 'cr-cols' }, modList('on', t('crash.enabledList', { count: enabled.length }), enabled, st), modList('off', t('crash.disabledList', { count: disabled.length }), disabled, st)) : null,
        historyList(st),
      ),
    );
    timers.forEach((x) => clearInterval(x));
    timers.length = 0;
    timers.push(setInterval(() => (elapsedEl.textContent = t('crash.elapsed', { time: clock(Date.now() - st.startedAt) })), 1000));
  }

  function renderResult(st) {
    timers.forEach((x) => clearInterval(x));
    timers.length = 0;
    const r = st.result || {};
    const kind = st.status === 'cancelled' ? 'cancelled' : st.status === 'error' ? 'error' : st.status === 'recovered' ? 'recovered' : r.kind;
    const dismiss = async (nextMode) => {
      try {
        await api.invoke('crash:bisectDismiss', instanceId);
      } catch {
        /* sin canal */
      }
      bisect = null;
      bisects.delete(instanceId);
      preferredMode = nextMode || preferredMode;
      drawTabs();
      renderBisect();
    };
    const fixBtn = (m, primary = true) => actionButton(instanceId, { type: 'disableMod', label: t('crash.disableName', { name: m.name }), payload: { file: m.file, name: m.name }, primary }, ctx);
    const updatesBtn = () => actionButton(instanceId, { type: 'updateMods', label: t('crash.res_updates'), payload: {} }, ctx);
    const altBtn = (m) => actionButton(instanceId, { type: 'searchMod', label: t('crash.res_alternatives'), payload: { query: m.name } }, ctx);
    const modCard = (m) => {
      const file = [m.version, m.file].filter(Boolean).join(' · ');
      return h('div', { class: 'cr-culprit' }, h('div', { class: 'cr-culprit-icon', 'aria-hidden': 'true' }, icon('puzzle')), h('div', { class: 'cr-culprit-main' }, h('div', { class: 'cr-culprit-name' }, m.name), h('div', { class: 'cr-culprit-file ellipsis', title: file }, file)));
    };
    const roundsInfo = r.rounds ? h('div', { class: 'cr-result-sub' }, t('crash.res_rounds', { count: r.rounds, time: clock((st.finishedAt || Date.now()) - st.startedAt) })) : null;

    let icn = 'target';
    let tone = 'good';
    let title = '';
    let body = [];
    let actions = [];
    const groups = r.culprits || [];
    if (kind === 'culprit') {
      const m = groups[0][0];
      title = t('crash.res_culprit_title');
      body = [modCard(m), h('p', { class: 'cr-res-text' }, t('crash.res_culprit_text', { mod: m.name })), r.confirmed ? h('div', { class: 'cr-verified' }, icon('shieldCheck'), t('crash.res_confirmed', { mod: m.name })) : null, r.removedWith?.length ? h('p', { class: 'cr-res-note' }, t('crash.res_withDependents', { mods: listText(r.removedWith.map((x) => x.name)) })) : null];
      actions = [fixBtn(m), updatesBtn(), altBtn(m)];
    } else if (kind === 'conflict') {
      const g = groups[0];
      title = t('crash.res_conflict_title');
      icn = 'swords';
      body = [h('div', { class: 'cr-culprits' }, g.map(modCard)), h('p', { class: 'cr-res-text' }, g.length === 2 ? t('crash.res_conflict_text', { a: g[0].name, b: g[1].name }) : t('crash.res_combo_text', { mods: listText(g.map((x) => x.name)) })), r.confirmed ? h('div', { class: 'cr-verified' }, icon('shieldCheck'), t('crash.res_confirmedGroup')) : null];
      actions = [...g.map((m, i) => fixBtn(m, i === 0)), updatesBtn()];
    } else if (kind === 'multiple') {
      title = t('crash.res_multiple_title');
      body = [h('p', { class: 'cr-res-text' }, t('crash.res_multiple_text')), h('div', { class: 'cr-culprits' }, groups.flat().map(modCard)), r.confirmed ? h('div', { class: 'cr-verified' }, icon('shieldCheck'), t('crash.res_confirmedGroup')) : null];
      actions = [...groups.flat().slice(0, 3).map((m, i) => fixBtn(m, i === 0)), updatesBtn()];
    } else if (kind === 'notReproduced') {
      icn = 'info';
      tone = 'info';
      title = t('crash.res_notReproduced_title');
      body = [h('p', { class: 'cr-res-text' }, st.mode === 'manual' ? t('crash.res_notReproduced_manual') : t('crash.res_notReproduced_crash'))];
      if (st.mode !== 'manual') actions = [h('button', { class: 'btn sm primary', type: 'button', onclick: () => dismiss('manual') }, icon('gamepad'), t('crash.res_tryManual'))];
    } else if (kind === 'notMods') {
      icn = 'info';
      tone = 'info';
      title = t('crash.res_notMods_title');
      body = [h('p', { class: 'cr-res-text' }, t('crash.res_notMods_text'))];
      actions = [h('button', { class: 'btn sm primary', type: 'button', onclick: () => setTab('last') }, icon('fileText'), t('crash.res_seeExplanation'))];
    } else if (kind === 'missingDependency') {
      icn = 'package';
      tone = 'warn';
      const deps = [...new Set((r.missing || []).map((x) => x.dependency))];
      title = t('crash.res_missing_title');
      body = [h('p', { class: 'cr-res-text' }, t('crash.res_missing_text', { mods: listText(deps) }))];
      actions = deps.slice(0, 3).map((d, i) => actionButton(instanceId, { type: 'installMod', label: t('crash.installMissing', { name: d }), payload: { modId: d, name: d }, primary: i === 0 }, ctx));
    } else if (kind === 'cancelled') {
      icn = 'x';
      tone = 'muted';
      title = t('crash.res_cancelled_title');
    } else if (kind === 'error') {
      icn = 'alert';
      tone = 'bad';
      title = t('crash.res_error_title');
      body = [h('p', { class: 'cr-res-text' }, st.error || '')];
    } else if (kind === 'recovered') {
      icn = 'history';
      tone = 'info';
      title = t('crash.recovered_title');
      body = [h('p', { class: 'cr-res-text' }, t('crash.recovered_text', { count: st.restored || 0 }))];
      actions = [h('button', { class: 'btn sm primary', type: 'button', onclick: () => dismiss() }, icon('check'), t('crash.dismiss'))];
    }

    mount(
      panel,
      h(
        'div',
        { class: 'cr-result-wrap' },
        h(
          'section',
          { class: ['cr-result', `tone-${tone}`] },
          h('div', { class: 'cr-result-head' }, h('div', { class: 'cr-result-icon', 'aria-hidden': 'true' }, icon(icn)), h('div', {}, h('h3', { class: 'cr-result-title' }, title), roundsInfo)),
          ...body.filter(Boolean),
          actions.length ? h('div', { class: 'cr-actions' }, actions) : null,
        ),
        kind !== 'recovered' ? h('div', { class: ['notice', st.restoreFailed?.length ? 'bad' : 'good', 'cr-notice'] }, icon(st.restoreFailed?.length ? 'alert' : 'shieldCheck'), h('div', {}, st.restoreFailed?.length ? t('crash.res_restoreFailed', { files: st.restoreFailed.join(', ') }) : t('crash.res_restored'))) : null,
        kind !== 'recovered' ? h('div', { class: 'cr-result-foot' }, h('button', { class: 'btn sm ghost', type: 'button', onclick: () => dismiss() }, icon('refresh'), t('crash.res_newSearch'))) : null,
        historyList(st),
      ),
    );
  }

  offs.push(
    watch(instanceId, (st) => {
      const wasActive = bisect?.active;
      bisect = st;
      if (wasActive !== st.active) drawTabs();
      if (tab === 'bisect') renderBisect();
    }),
  );

  toolDialogs.set(instanceId, {
    show: (nextTab, mode) => {
      if (mode) preferredMode = mode;
      if (nextTab && nextTab !== tab) setTab(nextTab);
      else if (tab === 'bisect') renderBisect();
    },
  });
  drawTabs();
  setTab(tab);
}
