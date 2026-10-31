// Tu Claude y tu ChatGPT en el Asistente (assistant/engines.js): el Claude Code o el Codex del usuario responden las
// preguntas del asistente desde la ventana de Venus, con su propia cuenta y sus limites (no la cuota de Venus IA), con
// las herramientas de Venus por el servidor MCP local. Desde el plan Go. Muestra que se detecto de cada app
// (instalada, con sesion, plan), como iniciar sesion si falta, y deja elegir con que responden las conversaciones
// nuevas (en cada chat se puede elegir otro antes de la primera pregunta).
// Contrato: engineCard() -> Element con .destroy() (tarjeta de la pagina del Asistente; sin plan no muestra nada);
//           enginesPanel() -> Element con .destroy() (Ajustes > Inteligencia artificial, ancla "engines").
// Canales: assistant:engines({ refresh }), assistant:setEngine(id). Eventos: assistant:engines, assistant:settingsChanged.
import { h, icon, mount, ok, fail, ensureCss, setBusy, fmtAgo } from '../ui.js';
import { api } from '../store.js';
import { t, loadNs } from '../i18n.js';
import { navigate } from '../app.js';

const NS = 'assistant';
const APPS = [
  { id: 'claude', icon: 'terminal', install: 'https://claude.com/product/claude-code', loginCmd: 'claude auth login' },
  { id: 'chatgpt', icon: 'code', install: 'https://chatgpt.com/codex', loginCmd: 'codex login' },
];
let readyPromise = null;

function prepare() {
  ensureCss('features/engines');
  if (!readyPromise) readyPromise = loadNs(NS).catch((err) => console.warn('[engines] textos', err));
  return readyPromise;
}

const pill = (kind, iconName, text) => h('span', { class: ['pill', kind] }, iconName ? icon(iconName) : null, text);
const engineName = (id) => (id === 'venus' ? t('assistant.engineVenus') : t(`assistant.engine_${id}`));
const planLabel = (p) => (typeof p === 'string' && p ? p.charAt(0).toUpperCase() + p.slice(1) : '');
// "Detectado hace 2 min": fmtAgo empieza en mayuscula ("Justo ahora"), como en cloudsync se baja la primera letra
const agoText = (ts) => {
  const s = fmtAgo(ts);
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
};

// Texto con un comando resaltado: t(key, { cmd }) con un marcador que se reemplaza por <code>
function withCode(key, cmd) {
  const [a, b] = t(key, { cmd: '\u0001' }).split('\u0001');
  return h('span', {}, a, h('code', {}, cmd), b ?? '');
}

// Las tarjetas de planes de features/plans.js; si no cargan, Ajustes > Plan.
async function openPlans() {
  try {
    const plans = await import('./plans.js');
    await plans.openPlans({ reason: 'needsPlan' });
  } catch (err) {
    console.warn('[engines] planes', err);
    navigate('settings/plan');
  }
}

function build(root, variant) {
  let st = null; // vista de assistant:engines
  let error = null;
  let disposed = false;
  let lastCheck = 0;
  const offs = [];

  async function load({ refresh = false } = {}) {
    try {
      await prepare();
      const v = await api.invoke('assistant:engines', { refresh });
      if (disposed) return;
      st = v;
      error = null;
    } catch (err) {
      if (disposed) return;
      error = err;
    }
    draw();
  }

  async function setDefault(sel) {
    const id = sel.value || 'venus';
    sel.disabled = true;
    try {
      st = await api.invoke('assistant:setEngine', id);
      ok(t('assistant.engDefaultSaved', { app: engineName(id) }));
    } catch (err) {
      fail(t('assistant.engSaveFailed'), err);
    }
    sel.disabled = false;
    if (!disposed) draw();
  }

  function appRow(app) {
    const e = st[app.id] || {};
    let state;
    let action = null;
    let hint = null;
    if (st.checking) state = pill('', null, t('assistant.engChecking'));
    else if (!e.installed) {
      state = pill('', null, t('assistant.engStateMissing'));
      action = h('button', { class: 'btn sm ghost', type: 'button', onclick: () => api.app.openExternal(app.install).catch(() => {}) }, icon('external'), t('assistant.engInstall'));
    } else if (e.error) state = pill('warn', 'alert', t('assistant.engStateError'));
    else if (e.loggedIn === false) {
      state = pill('warn', 'alert', t('assistant.engStateLoggedOut'));
      hint = h('div', { class: 'eng-hint' }, icon('info'), withCode(`assistant.engLoginHint_${app.id}`, app.loginCmd));
    } else if (e.loggedIn) state = pill('good', 'check', e.plan ? t('assistant.engStatePlan', { plan: planLabel(e.plan) }) : e.method === 'apiKey' ? t('assistant.engStateApiKey') : t('assistant.engStateReady'));
    else state = pill('', 'check', t('assistant.engStateInstalled'));
    return h(
      'div',
      { class: 'eng-app' },
      h('span', { class: 'eng-ic', 'aria-hidden': 'true' }, icon(app.icon)),
      h('span', { class: 'eng-name' }, engineName(app.id)),
      h('span', { class: 'eng-side' }, state, action),
      h('div', { class: 'eng-sub' }, t(`assistant.engSub_${app.id}`)),
      hint,
    );
  }

  // Con que responden las conversaciones nuevas (settings.ai.engine)
  function defaultChoice() {
    const sel = h('select', { class: 'eng-select', 'aria-label': t('assistant.engDefaultLabel') });
    const options = [h('option', { value: 'venus', selected: st.current === 'venus' }, t('assistant.engineVenus'))];
    for (const app of APPS) {
      const e = st[app.id] || {};
      const usable = Boolean(e.usable) || st.current === app.id;
      options.push(h('option', { value: app.id, selected: st.current === app.id, disabled: !usable }, usable ? engineName(app.id) : t('assistant.engineUnavailable', { app: engineName(app.id) })));
    }
    mount(sel, options);
    sel.value = st.current || 'venus';
    sel.addEventListener('change', () => setDefault(sel));
    return h('div', { class: 'eng-choice' }, h('span', { class: 'eng-choice-label' }, t('assistant.engDefaultLabel')), sel, h('p', { class: 'eng-choice-hint' }, t('assistant.engDefaultHint')));
  }

  function recheckButton() {
    const btn = h('button', { class: 'btn sm ghost', type: 'button' }, icon('refresh'), t('assistant.engRecheck'));
    btn.addEventListener('click', async () => {
      const done = setBusy(btn);
      lastCheck = Date.now();
      await load({ refresh: true });
      done();
    });
    return btn;
  }

  function gate() {
    const signedOut = st.planReason === 'signedOut';
    const cta = signedOut
      ? h('button', { class: 'btn sm primary', type: 'button', onclick: () => navigate('settings/cloud/venus') }, icon('logIn'), t('assistant.engSignIn'))
      : h('button', { class: 'btn sm primary', type: 'button', onclick: openPlans }, icon('crown'), t('assistant.engSeePlans'));
    return h('div', { class: 'notice info eng-gate' }, icon('crown'), h('div', {}, h('b', {}, t('assistant.engGateTitle')), h('div', {}, signedOut ? t('assistant.engGateSignedOut') : t('assistant.engGateText')), h('div', { class: 'eng-actions' }, cta)));
  }

  function draw() {
    if (disposed) return;
    // En la pagina del Asistente la tarjeta solo aparece con plan (como la de Claude y ChatGPT por MCP)
    if (variant === 'card' && !error && (!st || !st.entitled)) {
      root.classList.add('hidden');
      mount(root);
      return;
    }
    root.classList.remove('hidden');
    const title = h('h2', { class: 'card-title' }, icon('sparkles'), t('assistant.engCardTitle'));
    if (error) {
      const retry = h('button', { class: 'btn sm', type: 'button', onclick: () => load({ refresh: true }) }, icon('refresh'), t('assistant.engRecheck'));
      mount(root, title, h('div', { class: 'notice bad eng-gate' }, icon('alert'), h('div', {}, h('div', {}, t('assistant.engRecheckFailed')), h('div', { class: 'eng-actions' }, retry))));
      return;
    }
    if (!st) {
      mount(root, title, h('p', { class: 'eng-muted' }, t('assistant.engChecking')));
      return;
    }
    if (!st.entitled) {
      mount(root, title, h('p', { class: 'eng-muted' }, t('assistant.engCardText')), gate());
      return;
    }
    mount(
      root,
      title,
      h('p', { class: 'eng-muted' }, t('assistant.engCardText')),
      h('div', { class: 'eng-apps' }, APPS.map(appRow)),
      defaultChoice(),
      h('div', { class: 'eng-actions' }, recheckButton(), st.at ? h('span', { class: 'eng-last' }, t('assistant.engLast', { when: agoText(st.at) })) : null),
      variant === 'panel' ? h('p', { class: 'eng-muted' }, t('assistant.engHow')) : null,
      h('p', { class: 'eng-privacy' }, icon('shield'), h('span', {}, t('assistant.engPrivacy'))),
    );
  }

  // Volver a detectar al volver a la ventana (por ejemplo, despues de instalar o iniciar sesion), cada 15 s como mucho
  const onFocus = () => {
    if (Date.now() - lastCheck < 15000) return;
    lastCheck = Date.now();
    load({ refresh: true });
  };
  window.addEventListener('focus', onFocus);
  offs.push(() => window.removeEventListener('focus', onFocus));
  offs.push(
    api.on('assistant:engines', (v) => {
      if (!v) return;
      st = v;
      error = null;
      if (!disposed) draw();
    }),
  );
  offs.push(api.on('assistant:settingsChanged', () => load()));
  offs.push(api.on('billing:changed', () => load({ refresh: true })));
  root.destroy = () => {
    disposed = true;
    offs.splice(0).forEach((off) => {
      try {
        off();
      } catch {
        /* ya desuscripto */
      }
    });
  };
  draw();
  load();
  return root;
}

export function engineCard() {
  return build(h('section', { class: 'card eng-card hidden', 'aria-live': 'polite' }), 'card');
}

export function enginesPanel() {
  return build(h('section', { class: 'card eng-card' }), 'panel');
}
