// Claude y ChatGPT por MCP. El panel de Ajustes muestra el plan (MCP es de los planes pagos desde Go), el
// interruptor, la conexion con Claude Desktop, Claude Code y ChatGPT/claude.ai (tunel publico opcional), la URL
// local, la seguridad y la "Actividad MCP". startup() escucha aunque Ajustes este cerrado: muestra las
// confirmaciones de acciones destructivas (mcp:approval), el aviso con "Deshacer" de cada cambio y le avisa al
// proceso principal que revise el plan cuando cambia (billing:changed, ai:quota o la sesion de Venus).
// Contrato: mcpPanel() -> Element (con .destroy()), startup(). Canales: mcp:* (docs/mcp.md). "Mejorar plan" abre
// las tarjetas de planes de features/plans.js (las mismas de Ajustes > Plan y del Asistente).
import { h, icon, mount, ok, fail, ensureCss, modal, confirmDialog, copyText, switchEl, setBusy, skeleton, emptyState, fmtAgo, fmtTime, reducedMotion } from '../ui.js';
import { api, store } from '../store.js';
import { t, loadNs, onLanguageChange } from '../i18n.js';
import { navigate } from '../app.js';

const NS = 'mcp';
const DESKTOP_URL = 'https://claude.ai/download';
const CODE_URL = 'https://docs.anthropic.com/en/docs/claude-code/setup';
const MASK = '••••••••••••';
let readyPromise = null;
let panelSeq = 0;

function prepare() {
  ensureCss('features/mcp');
  if (!readyPromise) readyPromise = loadNs(NS).catch((err) => console.warn('[mcp] textos', err));
  return readyPromise;
}

const isMissing = (err) => /No handler registered/i.test(err?.message || '');
const errText = (err) => err?.message || String(err || '');

// ---------- Planes (Mejorar plan) ----------
// Las tarjetas de planes de features/plans.js (pagar, cambiar o administrar la suscripción); si no cargan, la
// sección Ajustes > Plan.
async function openPlans() {
  try {
    const plans = await import('./plans.js');
    await plans.openPlans();
  } catch (err) {
    console.warn('[mcp] planes', err);
    navigate('settings/plan');
  }
}

// ---------- Panel ----------
/**
 * Panel completo de MCP para Ajustes. Se limpia solo cuando sale del documento (o con el.destroy()).
 */
export function mcpPanel() {
  const root = h('section', { class: 'card mcp-panel', 'aria-busy': 'true' }, skeleton('card', { lines: 4 }));
  const offs = [];
  let disposed = false;
  let seen = false;
  const born = Date.now();
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearInterval(watch);
    offs.splice(0).forEach((off) => {
      try {
        off();
      } catch {
        /* ya desuscripto */
      }
    });
  };
  // El contrato no trae limpieza: se suelta cuando el elemento deja de estar en el documento
  const watch = setInterval(() => {
    if (root.isConnected) seen = true;
    else if (seen || Date.now() - born > 60000) dispose();
  }, 2000);
  root.destroy = dispose;
  prepare()
    .then(() => build(root, offs, () => disposed))
    .catch((err) => {
      console.error('[mcp]', err);
      mount(root, h('div', { class: 'notice bad' }, icon('alert'), h('div', {}, errText(err))));
    })
    .finally(() => root.removeAttribute('aria-busy'));
  return root;
}

function pill(kind, iconName, text) {
  return h('span', { class: ['pill', kind] }, iconName ? icon(iconName) : null, text);
}

function copyButton(getText, label = t('mcp.copy'), toastLabel = t('mcp.copied')) {
  return h('button', { class: 'btn sm ghost', type: 'button', title: label, 'aria-label': label, onclick: () => copyText(getText(), toastLabel) }, icon('copy'), label);
}

async function build(root, offs, isDisposed) {
  const uid = `mcp-${++panelSeq}`;
  let st = null;
  let acts = [];
  const ui = { revealed: false, limit: 30, tab: 'chatgpt', wasEntitled: null, tunnelWas: null };

  try {
    st = await api.invoke('mcp:status', { ui: true });
  } catch (err) {
    mount(root, h('div', { class: 'notice bad' }, icon('alert'), h('div', {}, isMissing(err) ? t('mcp.unavailable') : t('mcp.loadFailed'))));
    return;
  }
  if (isDisposed()) return;
  if (!st?.available) {
    mount(root, h('div', { class: 'notice bad' }, icon('alert'), h('div', {}, st?.error ? `${t('mcp.unavailable')} (${st.error})` : t('mcp.unavailable'))));
    return;
  }
  acts = await api.invoke('mcp:activity').catch(() => []);

  // ---------- Estructura ----------
  const enableSlot = h('div', { class: 'mcp-switch' });
  const head = h(
    'div',
    { class: 'mcp-head' },
    h('div', { class: 'mcp-logo', 'aria-hidden': 'true' }, icon('plug')),
    h('div', { class: 'mcp-head-text' }, h('div', { class: 'card-title' }, t('mcp.title')), h('p', { class: 'mcp-sub' }, t('mcp.subtitle'))),
    enableSlot,
  );
  const gateBox = h('div', { class: 'mcp-gate', 'aria-live': 'polite' });
  const serverBox = h('div', { class: 'mcp-server' });
  const clientsBox = h('div', { class: 'mcp-clients' });
  const connectionsBox = h('div', { class: 'mcp-connections' });
  const securityBox = h('div', { class: 'mcp-security' });
  const advancedBox = h('details', { class: 'mcp-advanced' });
  const activityList = h('div', { class: 'mcp-activity-list' });
  const clearBtn = h('button', { class: 'btn sm ghost', type: 'button', onclick: () => clearActivity() }, icon('trash'), t('mcp.clear'));
  const activityBox = h(
    'section',
    { class: 'mcp-activity', 'aria-labelledby': `${uid}-act`, dataset: { fkg: 'activity' } },
    h('div', { class: 'mcp-section-head' }, h('div', {}, h('h3', { class: 'mcp-h3', id: `${uid}-act` }, icon('activity'), t('mcp.activityTitle')), h('p', { class: 'mcp-muted' }, t('mcp.activitySub'))), clearBtn),
    activityList,
  );
  mount(root, head, gateBox, serverBox, h('h3', { class: 'mcp-h3' }, icon('link'), t('mcp.clientsTitle')), clientsBox, connectionsBox, securityBox, advancedBox, activityBox);

  // ---------- Interruptor ----------
  function drawSwitch() {
    const entitled = st.plan?.entitled === true;
    const sw = switchEl(st.enabled, async (v) => {
      input.disabled = true;
      try {
        st = await api.invoke('mcp:setEnabled', v);
        ok(v ? t('mcp.enabledToast') : t('mcp.disabledToast'));
      } catch (err) {
        fail(t('mcp.toggleFailed'), err);
      }
      if (!isDisposed()) drawAll();
    }, t('mcp.enableAria'));
    const input = sw.querySelector('input');
    input.dataset.fk = 'switch';
    if (!entitled && !st.enabled) input.disabled = true;
    mount(enableSlot, sw);
  }

  // ---------- Plan ----------
  function drawGate() {
    const p = st.plan || {};
    if (p.entitled) {
      const name = p.planName || p.plan || '';
      mount(gateBox, h('div', { class: 'mcp-plan-ok' }, pill('good', 'shieldCheck', p.status === 'trialing' ? t('mcp.planOkTrial', { plan: name }) : t('mcp.planOk', { plan: name })), p.source === 'cache' ? h('span', { class: 'mcp-muted' }, t('mcp.planCached')) : null));
      return;
    }
    if (p.reason === 'checking' || (p.checking && !p.reason)) {
      mount(gateBox, h('div', { class: 'mcp-plan-ok' }, h('div', { class: 'spinner', 'aria-hidden': 'true' }), h('span', { class: 'mcp-muted' }, t('mcp.planChecking'))));
      return;
    }
    if (p.reason === 'signedOut' || p.reason === 'noCloud') {
      mount(
        gateBox,
        h(
          'div',
          { class: 'notice info mcp-notice' },
          icon('logIn'),
          h('div', {}, h('b', {}, t('mcp.gateSignedOutTitle')), h('div', {}, t('mcp.gateSignedOutText')), h('div', { class: 'mcp-actions' }, h('button', { class: 'btn sm tonal', type: 'button', onclick: () => navigate('settings/cloud/venus') }, icon('logIn'), t('mcp.signIn')))),
        ),
      );
      return;
    }
    if (p.reason === 'offline' || p.reason === 'error') {
      const retry = h('button', { class: 'btn sm', type: 'button', onclick: (e) => refresh(e.currentTarget) }, icon('refresh'), t('mcp.retry'));
      mount(gateBox, h('div', { class: 'notice bad mcp-notice' }, icon('wifiOff'), h('div', {}, h('b', {}, t('mcp.gateOfflineTitle')), h('div', {}, t('mcp.gateOfflineText')), h('div', { class: 'mcp-actions' }, retry))));
      return;
    }
    mount(
      gateBox,
      h(
        'div',
        { class: 'notice mcp-notice' },
        icon('crown'),
        h(
          'div',
          {},
          h('b', {}, t('mcp.gateTitle')),
          h('div', {}, t('mcp.gateText')),
          h(
            'div',
            { class: 'mcp-actions' },
            h('button', { class: 'btn sm tonal', type: 'button', onclick: () => openPlans() }, icon('crown'), t('mcp.upgrade')),
            h('button', { class: 'btn sm ghost', type: 'button', onclick: () => navigate('settings/plan') }, t('mcp.seePlans')),
          ),
        ),
      ),
    );
  }

  async function refresh(btn) {
    const done = btn ? setBusy(btn) : () => {};
    try {
      st = await api.invoke('mcp:status', { refresh: true });
    } catch (err) {
      fail(t('mcp.loadFailed'), err);
    }
    done();
    if (!isDisposed()) drawAll();
  }

  // ---------- Servidor local ----------
  function drawServer() {
    const s = st.server || {};
    let status;
    if (s.running) status = pill('good', 'check', t('mcp.serverOn', { port: s.port }));
    else if (st.enabled && s.error === 'busy') status = pill('bad', 'alert', t('mcp.serverBusy', { port: st.port }));
    else if (st.enabled && s.error) status = pill('bad', 'alert', t('mcp.serverError'));
    else status = pill('', 'power', t('mcp.serverOff'));
    if (!s.localUrl) {
      mount(serverBox, h('div', { class: 'mcp-server-row' }, status));
      return;
    }
    const cut = s.localUrl.lastIndexOf('/') + 1;
    const shown = ui.revealed ? s.localUrl : `${s.localUrl.slice(0, cut)}${MASK}`;
    const reveal = h(
      'button',
      { class: 'icon-btn sm', type: 'button', title: ui.revealed ? t('mcp.hideSecret') : t('mcp.showSecret'), 'aria-label': ui.revealed ? t('mcp.hideSecret') : t('mcp.showSecret'), 'aria-pressed': String(ui.revealed), dataset: { fk: 'reveal' }, onclick: () => ((ui.revealed = !ui.revealed), drawServer()) },
      icon(ui.revealed ? 'eyeOff' : 'eye'),
    );
    mount(
      serverBox,
      h('div', { class: 'mcp-server-row' }, status),
      h('div', { class: 'mcp-url-row' }, h('span', { class: 'mcp-label' }, t('mcp.localUrl')), h('code', { class: 'mcp-url mono wrap-anywhere selectable' }, shown), reveal, copyButton(() => s.localUrl, t('mcp.copyUrl'), t('mcp.urlCopied'))),
    );
  }

  // ---------- Clientes ----------
  function clientState(c) {
    if (!c) return pill('', null, t('mcp.stateNotInstalled'));
    if (c.error && !c.registered) return pill('bad', 'alert', t('mcp.stateBadConfig'));
    if (c.registered && c.outdated) return pill('warn', 'alert', t('mcp.stateOutdated'));
    if (c.registered) return pill('good', 'check', t('mcp.stateConnected'));
    if (!c.installed) return pill('', null, t('mcp.stateNotInstalled'));
    return pill('', null, t('mcp.stateNotConnected'));
  }

  // Canales escritos completos (los cruza scripts/contracts-check.js)
  const CLIENT_CALLS = {
    'desktop:install': () => api.invoke('mcp:installClaudeDesktop'),
    'desktop:uninstall': () => api.invoke('mcp:uninstallClaudeDesktop'),
    'code:install': () => api.invoke('mcp:installClaudeCode'),
    'code:uninstall': () => api.invoke('mcp:uninstallClaudeCode'),
  };

  async function runClient(btn, action, kind) {
    const done = setBusy(btn);
    try {
      const r = await CLIENT_CALLS[`${kind}:${action}`]();
      st = r.status || st;
      const status = r.result?.status;
      const desktop = kind === 'desktop';
      if (status === 'notInstalled') fail(desktop ? t('mcp.missingDesktop') : t('mcp.missingCode'), '');
      else if (status === 'already') ok(desktop ? t('mcp.alreadyDesktop') : t('mcp.alreadyCode'));
      else if (status === 'added' || status === 'updated') ok(desktop ? t('mcp.connectedDesktop') : t('mcp.connectedCode'), desktop ? t('mcp.connectedDesktopText') : t('mcp.connectedCodeText'));
      else if (status === 'removed') ok(desktop ? t('mcp.disconnectedDesktop') : t('mcp.disconnectedCode'));
      else if (status === 'absent') ok(t('mcp.notConnectedYet'));
    } catch (err) {
      if (err?.code === 'plan') openPlans();
      else fail(action === 'uninstall' ? t('mcp.disconnectFailed') : t('mcp.connectFailed'), err);
    }
    done();
    if (!isDisposed()) drawAll();
  }

  function manualBlock(kind) {
    const b = st.bridge || {};
    const text = kind === 'desktop' ? b.desktopSnippet : b.codeCommand;
    const file = kind === 'desktop' ? st.clients?.claudeDesktop?.configPath : st.clients?.claudeCode?.configPath;
    return h(
      'details',
      { class: 'mcp-manual' },
      h('summary', {}, icon('chevronRight'), t('mcp.manualTitle')),
      h('p', { class: 'mcp-muted' }, kind === 'desktop' ? t('mcp.manualDesktop') : t('mcp.manualCode')),
      h('pre', { class: 'mcp-snippet mono selectable' }, text || ''),
      h('div', { class: 'mcp-actions' }, copyButton(() => text || '')),
      file ? h('p', { class: 'mcp-muted wrap-anywhere' }, t('mcp.configFile', { file })) : null,
    );
  }

  function clientCard(kind) {
    const desktop = kind === 'desktop';
    const c = desktop ? st.clients?.claudeDesktop : st.clients?.claudeCode;
    const entitled = st.plan?.entitled === true;
    const actions = [];
    if (c && !c.installed && !c.registered) {
      actions.push(h('button', { class: 'btn sm', type: 'button', dataset: { fk: `${kind}:get` }, onclick: () => api.app.openExternal(desktop ? DESKTOP_URL : CODE_URL).catch(() => {}) }, icon('external'), desktop ? t('mcp.getDesktop') : t('mcp.getCode')));
    } else if (c?.registered) {
      if (c.outdated) actions.push(h('button', { class: 'btn sm', type: 'button', disabled: !entitled, dataset: { fk: `${kind}:repair` }, onclick: (e) => runClient(e.currentTarget, 'install', kind) }, icon('wrench'), t('mcp.repair')));
      actions.push(h('button', { class: 'btn sm ghost', type: 'button', dataset: { fk: `${kind}:uninstall` }, onclick: (e) => runClient(e.currentTarget, 'uninstall', kind) }, icon('x'), t('mcp.disconnect')));
    } else {
      actions.push(h('button', { class: 'btn sm', type: 'button', disabled: !entitled, dataset: { fk: `${kind}:install` }, onclick: (e) => runClient(e.currentTarget, 'install', kind) }, icon('plug'), t('mcp.connect')));
    }
    return h(
      'div',
      { class: 'card flat mcp-client', dataset: { fkg: kind } },
      h('div', { class: 'mcp-client-head' }, h('div', { class: 'mcp-client-icon', 'aria-hidden': 'true' }, icon(desktop ? 'monitor' : 'terminal')), h('div', { class: 'mcp-client-name' }, desktop ? t('mcp.desktopName') : t('mcp.codeName')), clientState(c)),
      h('p', { class: 'mcp-client-text' }, desktop ? t('mcp.desktopText') : t('mcp.codeText')),
      h('div', { class: 'mcp-actions' }, actions),
      !c?.registered && c?.installed ? h('p', { class: 'mcp-muted' }, t('mcp.restartHint')) : null,
      st.portable ? h('p', { class: 'mcp-muted' }, t('mcp.portableNote')) : null,
      manualBlock(kind),
    );
  }

  function tunnelSteps(url) {
    const tabs = [
      ['chatgpt', t('mcp.stepsChatgpt'), ['chatgptStep1', 'chatgptStep2', 'chatgptStep3', 'chatgptStep4']],
      ['claude', t('mcp.stepsClaudeAi'), ['claudeStep1', 'claudeStep2', 'claudeStep3']],
    ];
    const current = tabs.find((x) => x[0] === ui.tab) || tabs[0];
    return h(
      'div',
      { class: 'mcp-steps' },
      h(
        'div',
        { class: 'segmented', role: 'tablist', 'aria-label': t('mcp.connectorUrl') },
        tabs.map(([id, label]) => h('button', { type: 'button', role: 'tab', class: id === current[0] ? 'active' : '', 'aria-selected': String(id === current[0]), onclick: () => ((ui.tab = id), drawClients()) }, label)),
      ),
      h('ol', { class: 'mcp-step-list' }, current[2].map((k) => h('li', {}, t(`mcp.${k}`)))),
      url ? h('p', { class: 'mcp-muted' }, t('mcp.tunnelChanges')) : null,
    );
  }

  async function startTunnel(btn) {
    const yes = await confirmDialog(t('mcp.tunnelConfirmTitle'), t('mcp.tunnelConfirmText'), { okText: t('mcp.tunnelConfirmOk') });
    if (!yes) return;
    const done = setBusy(btn);
    try {
      st = await api.invoke('mcp:tunnelStart', { confirmed: true });
    } catch (err) {
      if (err?.code === 'plan') openPlans();
      else fail(t('mcp.tunnelFailed'), err);
    }
    done();
    if (!isDisposed()) drawAll();
  }

  async function stopTunnel(btn) {
    const done = setBusy(btn);
    try {
      st = await api.invoke('mcp:tunnelStop');
      ok(t('mcp.tunnelStopped'));
    } catch (err) {
      fail(t('mcp.tunnelFailed'), err);
    }
    done();
    if (!isDisposed()) drawAll();
  }

  function remoteCard() {
    const tn = st.tunnel || { state: 'stopped' };
    const entitled = st.plan?.entitled === true;
    const parts = [];
    let state;
    if (tn.state === 'running') state = pill('good', 'check', t('mcp.tunnelRunning'));
    else if (tn.state === 'downloading') state = pill('info', 'download', t('mcp.tunnelDownloading', { pct: Math.round((tn.progress || 0) * 100) }));
    else if (tn.state === 'starting') state = pill('info', 'clock', t('mcp.tunnelStarting'));
    else if (tn.state === 'error') state = pill('bad', 'alert', t('mcp.tunnelFailed'));
    else state = pill('', null, t('mcp.stateNotConnected'));
    if (tn.state === 'running' && tn.connectorUrl) {
      parts.push(
        h('div', { class: 'mcp-url-row' }, h('span', { class: 'mcp-label' }, t('mcp.connectorUrl')), h('code', { class: 'mcp-url mono wrap-anywhere selectable' }, tn.connectorUrl), copyButton(() => tn.connectorUrl, t('mcp.copyUrl'), t('mcp.urlCopied'))),
        h('div', { class: 'notice mcp-notice' }, icon('shieldAlert'), h('div', {}, t('mcp.tunnelWarn'))),
        tunnelSteps(tn.connectorUrl),
        h('div', { class: 'mcp-actions' }, h('button', { class: 'btn sm ghost', type: 'button', dataset: { fk: 'tunnel:stop' }, onclick: (e) => stopTunnel(e.currentTarget) }, icon('stop'), t('mcp.tunnelStop'))),
      );
    } else if (tn.state === 'downloading' || tn.state === 'starting') {
      parts.push(
        tn.state === 'downloading'
          ? h('div', { class: 'progress mcp-progress', role: 'progressbar', 'aria-label': t('mcp.tunnelDownloading', { pct: Math.round((tn.progress || 0) * 100) }), 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round((tn.progress || 0) * 100)) }, h('i', { style: { width: `${Math.round((tn.progress || 0) * 100)}%` } }))
          : h('div', { class: 'progress indeterminate mcp-progress', 'aria-hidden': 'true' }, h('i')),
        h('div', { class: 'mcp-actions' }, h('button', { class: 'btn sm ghost', type: 'button', dataset: { fk: 'tunnel:cancel' }, onclick: (e) => stopTunnel(e.currentTarget) }, icon('x'), t('mcp.approvalCancel'))),
      );
    } else {
      if (tn.state === 'error' && tn.error === 'exited') parts.push(h('div', { class: 'notice bad mcp-notice' }, icon('alert'), h('div', {}, t('mcp.tunnelBroke'))));
      parts.push(h('div', { class: 'mcp-actions' }, h('button', { class: 'btn sm', type: 'button', disabled: !entitled, dataset: { fk: 'tunnel:start' }, onclick: (e) => startTunnel(e.currentTarget) }, icon('globe'), t('mcp.tunnelStart'))), tunnelSteps(null));
    }
    return h(
      'div',
      { class: 'card flat mcp-client mcp-remote', dataset: { fkg: 'tunnel' } },
      h('div', { class: 'mcp-client-head' }, h('div', { class: 'mcp-client-icon', 'aria-hidden': 'true' }, icon('globe')), h('div', { class: 'mcp-client-name' }, t('mcp.remoteName')), state),
      h('p', { class: 'mcp-client-text' }, t('mcp.remoteText')),
      ...parts,
    );
  }

  function drawClients() {
    mount(clientsBox, clientCard('desktop'), clientCard('code'), remoteCard());
  }

  function drawConnections() {
    const list = Array.isArray(st.connections) ? st.connections.slice(0, 4) : [];
    if (!list.length) {
      mount(connectionsBox);
      return;
    }
    mount(
      connectionsBox,
      h('div', { class: 'mcp-label' }, t('mcp.connections')),
      h('div', { class: 'chips mcp-conn-chips' }, list.map((c) => h('span', { class: 'chip', title: new Date(c.lastSeen).toLocaleString() }, icon(c.source === 'remote' ? 'globe' : 'monitor'), `${c.name} · ${c.source === 'remote' ? t('mcp.sourceRemote') : t('mcp.sourceLocal')} · ${fmtAgo(c.lastSeen)}`))),
    );
  }

  function drawSecurity() {
    const btn = h(
      'button',
      {
        class: 'btn sm ghost',
        type: 'button',
        dataset: { fk: 'regen' },
        onclick: async (e) => {
          const yes = await confirmDialog(t('mcp.regenerateTitle'), t('mcp.regenerateText'), { okText: t('mcp.regenerateOk'), danger: true });
          if (!yes) return;
          const done = setBusy(e.currentTarget);
          try {
            st = await api.invoke('mcp:regenerateSecret');
            ok(t('mcp.regenerated'));
          } catch (err) {
            fail(t('mcp.regenerate'), err);
          }
          done();
          if (!isDisposed()) drawAll();
        },
      },
      icon('key'),
      t('mcp.regenerate'),
    );
    mount(securityBox, btn, h('p', { class: 'mcp-muted' }, t('mcp.regenerateHint')));
  }

  function drawAdvanced() {
    const open = advancedBox.open;
    const input = h('input', { class: 'input mcp-port-input num', id: `${uid}-port`, type: 'number', min: '1024', max: '65535', step: '1', inputmode: 'numeric', value: String(st.port || 18765), 'aria-describedby': `${uid}-port-help` });
    const save = h(
      'button',
      {
        class: 'btn sm',
        type: 'button',
        dataset: { fk: 'port' },
        onclick: async (e) => {
          const p = Number(input.value);
          if (!Number.isInteger(p) || p < 1024 || p > 65535) {
            input.setAttribute('aria-invalid', 'true');
            fail(t('mcp.portInvalid'), '');
            return;
          }
          input.removeAttribute('aria-invalid');
          const done = setBusy(e.currentTarget);
          try {
            st = await api.invoke('mcp:setPort', p);
            ok(t('mcp.portSaved'));
          } catch (err) {
            fail(t('mcp.portInvalid'), err);
          }
          done();
          if (!isDisposed()) drawAll();
        },
      },
      icon('save'),
      t('mcp.portSave'),
    );
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') save.click();
    });
    mount(
      advancedBox,
      h('summary', {}, icon('chevronRight'), t('mcp.advanced')),
      h('div', { class: 'mcp-advanced-body' }, h('div', { class: 'field' }, h('label', { for: `${uid}-port` }, t('mcp.port')), h('div', { class: 'mcp-port-row' }, input, save), h('div', { class: 'field-help', id: `${uid}-port-help` }, t('mcp.portHelp'))), h('p', { class: 'mcp-muted' }, t('mcp.approvalInfo', { seconds: st.approvalTimeoutSec || 50 })), st.bridge?.script ? h('p', { class: 'mcp-muted wrap-anywhere' }, t('mcp.bridgeFolder', { path: st.bridge.script })) : null),
    );
    advancedBox.open = open;
  }

  // ---------- Actividad ----------
  const STATE_PILL = { ok: ['good', 'check'], error: ['bad', 'alert'], denied: ['warn', 'ban'], pending: ['info', 'clock'], running: ['info', 'clock'], undone: ['', 'undo'], interrupted: ['warn', 'alert'] };
  const LEVEL_ICON = { read: 'eye', reversible: 'edit', destructive: 'trash' };

  async function undoEntry(btn, e) {
    const done = setBusy(btn);
    try {
      const r = await api.invoke('mcp:undo', e.undoId);
      ok(t('mcp.undoDone'), r?.warnings?.length ? r.warnings.join(' · ') : r?.message);
    } catch (err) {
      fail(t('mcp.undoFailed'), err);
      done();
    }
  }

  function activityRow(e) {
    const [kind, iconName] = STATE_PILL[e.state] || ['', 'info'];
    const title = e.kind === 'connect' ? t('mcp.kind_connect') : e.toolTitle || e.tool || '?';
    const iconFor = e.kind === 'connect' ? 'link' : e.kind === 'blocked' ? 'ban' : LEVEL_ICON[e.level] || 'zap';
    const detail = e.state === 'error' || e.state === 'denied' ? e.error || e.summary : e.summary;
    const canUndo = e.undoId && e.state === 'ok' && !e.noChange;
    return h(
      'div',
      { class: ['list-item', 'mcp-act', `mcp-act-${e.state}`], role: 'listitem' },
      h('div', { class: ['li-icon', 'mcp-act-icon', e.level === 'destructive' && 'danger'], 'aria-hidden': 'true' }, icon(iconFor)),
      h(
        'div',
        { class: 'li-main' },
        h('div', { class: 'li-title' }, h('span', { class: 'ellipsis', title }, title), e.level && e.kind === 'tool' ? h('span', { class: 'badge' }, t(`mcp.level_${e.level}`)) : null),
        h('div', { class: 'li-sub' }, h('span', { class: 'num' }, fmtTime(e.at)), ' · ', e.client || '—', e.source === 'remote' ? ` · ${t('mcp.sourceRemote')}` : ''),
        detail ? h('div', { class: ['mcp-act-detail', (e.state === 'error' || e.state === 'denied') && 'bad'] }, detail) : null,
        e.noChange ? h('div', { class: 'mcp-muted' }, t('mcp.noChange')) : null,
      ),
      h('div', { class: 'mcp-act-side' }, pill(kind, iconName, t(`mcp.state_${e.state}`) || e.state), canUndo ? h('button', { class: 'btn sm', type: 'button', dataset: { fk: `activity:${e.id}` }, title: t('mcp.undoTitle'), 'aria-label': `${t('mcp.undoTitle')}: ${title}`, onclick: (ev) => undoEntry(ev.currentTarget, e) }, icon('undo'), t('mcp.undo')) : null),
    );
  }

  function drawActivity() {
    clearBtn.disabled = !acts.length;
    if (!acts.length) {
      mount(activityList, emptyState('activity', t('mcp.activityEmptyTitle'), t('mcp.activityEmptyText')));
      return;
    }
    const shown = acts.slice(0, ui.limit);
    mount(
      activityList,
      h('div', { class: 'list mcp-act-list', role: 'list' }, shown.map(activityRow)),
      acts.length > ui.limit ? h('button', { class: 'btn sm ghost mcp-more', type: 'button', dataset: { fk: 'activity:more' }, onclick: () => ((ui.limit += 50), keepFocus(drawActivity)) }, icon('chevronDown'), t('mcp.showMore')) : null,
    );
  }

  async function clearActivity() {
    try {
      await api.invoke('mcp:clearActivity');
      acts = acts.filter((e) => e.state === 'running' || e.state === 'pending');
      ok(t('mcp.cleared'));
    } catch (err) {
      fail(t('mcp.clear'), err);
    }
    drawActivity();
  }

  // Al redibujar se devuelve el foco al mismo control (data-fk) o al primero de su grupo (data-fkg).
  function keepFocus(draw) {
    const active = document.activeElement;
    const fk = active && root.contains(active) ? active.closest('[data-fk]')?.dataset.fk || null : null;
    draw();
    if (!fk) return;
    const group = fk.split(':')[0];
    const el = root.querySelector(`[data-fk="${CSS.escape(fk)}"]`) || root.querySelector(`[data-fkg="${CSS.escape(group)}"] button:not([disabled]), [data-fkg="${CSS.escape(group)}"] input:not([disabled])`);
    el?.focus({ preventScroll: true });
  }

  function drawAll() {
    if (ui.wasEntitled === false && st.plan?.entitled) ok(t('mcp.planActivated'));
    ui.wasEntitled = st.plan?.entitled === true;
    keepFocus(() => {
      drawSwitch();
      drawGate();
      drawServer();
      drawClients();
      drawConnections();
      drawSecurity();
      drawAdvanced();
      drawActivity();
    });
  }

  drawAll();

  offs.push(
    api.on('mcp:status', (s) => {
      if (isDisposed() || !s || !s.available) return;
      st = s;
      drawAll();
    }),
  );
  offs.push(
    api.on('mcp:activity', (e) => {
      if (isDisposed() || !e) return;
      if (e.cleared) acts = acts.filter((x) => x.state === 'running' || x.state === 'pending');
      else {
        const i = acts.findIndex((x) => x.id === e.id);
        if (i >= 0) acts[i] = e;
        else acts.unshift(e);
        if (acts.length > 200) acts.length = 200;
      }
      keepFocus(drawActivity);
    }),
  );
  offs.push(onLanguageChange(() => loadNs(NS).then(() => !isDisposed() && drawAll())));
  // Al abrir el panel se revisa el plan (por si se pago o se vencio)
  api
    .invoke('mcp:status', { refresh: true, ui: true })
    .then((s) => {
      if (!isDisposed() && s?.available) {
        st = s;
        drawAll();
      }
    })
    .catch(() => {});
}

// ---------- Confirmaciones (en cualquier pantalla) ----------
const approvalQueue = [];
let currentApproval = null;

function finishApproval(state) {
  if (!currentApproval) return;
  const a = currentApproval;
  a.answered = true;
  clearInterval(a.timer);
  a.dialog.close();
  if (state === 'expired') fail(t('mcp.approvalGone'), '');
}

function showApproval(p) {
  let answered = false;
  const remaining = () => Math.max(0, Math.ceil((p.expiresAt - Date.now()) / 1000));
  const countdown = h('div', { class: 'mcp-approval-countdown', 'aria-live': 'off' });
  const bar = h('div', { class: 'progress mcp-approval-bar', 'aria-hidden': 'true' }, h('i'));
  const total = Math.max(1, p.expiresAt - (p.createdAt || Date.now()));
  const tick = () => {
    countdown.textContent = t('mcp.approvalCountdown', { count: remaining() });
    bar.firstChild.style.width = `${Math.max(0, Math.min(100, ((p.expiresAt - Date.now()) / total) * 100))}%`;
  };
  const answer = (okv) => {
    if (answered) return;
    answered = true;
    api.invoke('mcp:approve', p.requestId, okv).catch(() => {});
  };
  const body = h(
    'div',
    { class: 'mcp-approval' },
    h('div', { class: 'mcp-approval-from' }, icon('plug'), t('mcp.approvalFrom', { client: p.client || 'MCP' })),
    p.message ? h('p', { class: 'mcp-approval-text' }, p.message) : null,
    p.items?.length ? h('ul', { class: 'mcp-approval-items' }, p.items.slice(0, 12).map((x) => h('li', { class: 'wrap-anywhere' }, x))) : null,
    p.source === 'remote' ? h('div', { class: 'notice mcp-notice' }, icon('globe'), h('div', {}, t('mcp.approvalRemote'))) : null,
    bar,
    countdown,
  );
  const cancel = h('button', { class: 'btn ghost', type: 'button', 'data-autofocus': '', onclick: () => (answer(false), dialog.close()) }, t('mcp.approvalCancel'));
  const confirm = h('button', { class: ['btn', p.danger ? 'danger' : 'primary'], type: 'button', onclick: () => (answer(true), dialog.close()) }, p.danger ? icon('trash') : icon('check'), p.okText || t('mcp.approvalConfirm'));
  const dialog = modal({
    title: p.title || t('mcp.approvalFallbackTitle'),
    size: 'sm',
    body,
    footer: [cancel, confirm],
    onClose: () => {
      answer(false);
      clearInterval(entry.timer);
      currentApproval = null;
      setTimeout(pump, reducedMotion() ? 0 : 200);
    },
  });
  dialog.el.classList.add('mcp-approval-modal');
  const entry = { payload: p, dialog, timer: null, get answered() {
    return answered;
  }, set answered(v) {
    answered = v;
  } };
  tick();
  entry.timer = setInterval(() => {
    tick();
    if (Date.now() >= p.expiresAt) finishApproval('expired');
  }, 500);
  currentApproval = entry;
}

function pump() {
  if (currentApproval) return;
  while (approvalQueue.length) {
    const p = approvalQueue.shift();
    if (p.expiresAt > Date.now()) {
      showApproval(p);
      return;
    }
  }
}

function onApproval(p) {
  if (!p || typeof p.requestId !== 'string') return;
  if (p.state && p.state !== 'pending') {
    if (currentApproval?.payload.requestId === p.requestId) finishApproval(p.state);
    const i = approvalQueue.findIndex((x) => x.requestId === p.requestId);
    if (i >= 0) approvalQueue.splice(i, 1);
    return;
  }
  if (currentApproval?.payload.requestId === p.requestId || approvalQueue.some((x) => x.requestId === p.requestId)) return;
  approvalQueue.push(p);
  prepare().then(pump);
}

// ---------- Aviso "Deshacer" de cada cambio ----------
const toasted = new Set();
const liveToasts = [];

function undoToast(e) {
  const host = document.getElementById('toasts');
  if (!host) return;
  const client = e.client || 'MCP';
  let timer = null;
  const btn = h('button', { class: 'btn sm mcp-toast-undo', type: 'button', 'aria-label': t('mcp.toastUndoAria', { client }) }, icon('undo'), t('mcp.toastUndo'));
  const el = h('div', { class: 'toast good mcp-toast', role: 'status' }, icon('check'), h('div', { class: 'mcp-toast-body' }, h('div', { class: 't-title' }, t('mcp.toastChanged', { client })), h('div', { class: 't-msg' }, e.summary || e.toolTitle || e.tool), btn));
  const leave = () => {
    clearTimeout(timer);
    const i = liveToasts.indexOf(el);
    if (i >= 0) liveToasts.splice(i, 1);
    if (!el.isConnected || el.classList.contains('leaving')) return;
    if (reducedMotion()) {
      el.remove();
      return;
    }
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 180);
  };
  const arm = (ms) => {
    clearTimeout(timer);
    timer = setTimeout(leave, ms);
  };
  btn.addEventListener('click', async () => {
    const done = setBusy(btn);
    try {
      const r = await api.invoke('mcp:undo', e.undoId);
      leave();
      ok(t('mcp.undoDone'), r?.warnings?.length ? r.warnings.join(' · ') : e.summary);
    } catch (err) {
      done();
      fail(t('mcp.undoFailed'), err);
    }
  });
  el.addEventListener('mouseenter', () => clearTimeout(timer));
  el.addEventListener('mouseleave', () => arm(4000));
  el.addEventListener('focusin', () => clearTimeout(timer));
  host.append(el);
  liveToasts.push(el);
  while (liveToasts.length > 3) {
    const old = liveToasts.shift();
    old.remove();
  }
  arm(10000);
}

function onActivity(e) {
  if (!e || e.cleared || e.kind !== 'tool' || e.state !== 'ok' || !e.undoId || e.noChange || toasted.has(e.id)) return;
  toasted.add(e.id);
  if (toasted.size > 500) toasted.clear();
  prepare().then(() => undoToast(e));
}

// ---------- Arranque ----------
let started = false;
let recheckTimer = null;

function recheck(reason) {
  clearTimeout(recheckTimer);
  recheckTimer = setTimeout(() => api.invoke('mcp:status', { refresh: reason }).catch(() => {}), reason === 'quota' ? 2500 : 600);
}

export async function startup() {
  if (started) return;
  started = true;
  api.on('mcp:approval', onApproval);
  api.on('mcp:activity', onActivity);
  api.on('billing:changed', () => recheck('billing'));
  api.on('ai:quota', () => recheck('quota'));
  onLanguageChange(() => loadNs(NS).catch(() => {}));
  try {
    const { cloud } = await import('../cloud.js');
    cloud.on('auth', () => recheck('auth'));
  } catch {
    /* sin nube */
  }
  // La interfaz queda registrada para mostrar las confirmaciones; las que ya estaban pendientes se muestran
  try {
    const st = await api.invoke('mcp:status', { ui: true });
    for (const a of st?.approvals || []) onApproval(a);
  } catch {
    /* modulo MCP no disponible */
  }
}

// ---------- Tarjeta del Asistente: "Usá el asistente desde Claude o ChatGPT" ----------
// Para quien tiene plan (desde Go): las apps detectadas con su estado, "Conectar" en un clic (los mismos
// instaladores del panel), la ultima actividad y, una sola vez, un aviso "Conectar / Ahora no" cuando hay una app
// de Claude instalada sin conectar (la respuesta queda en settings.mcp.offer; nunca conecta solo). setHighlight(true)
// la resalta cuando Venus IA no esta disponible (por ejemplo, sin cuota o con el servicio caido).
// Contrato: assistantCard() -> Element con .destroy() y .setHighlight(bool). Sin plan no muestra nada.
const OFFER_APPS = [
  { id: 'desktop', key: 'claudeDesktop', name: () => t('mcp.desktopName'), icon: 'monitor', install: () => api.invoke('mcp:installClaudeDesktop') },
  { id: 'code', key: 'claudeCode', name: () => t('mcp.codeName'), icon: 'terminal', install: () => api.invoke('mcp:installClaudeCode') },
];

export function assistantCard() {
  const root = h('section', { class: 'card mcp-assist hidden', 'aria-live': 'polite' });
  let st = null;
  let last = null;
  let offered = null; // respuesta guardada del aviso unico (settings.mcp.offer)
  let highlight = false;
  let disposed = false;
  let lastCheck = 0;
  const offs = [];

  async function load() {
    try {
      await prepare();
      offered = store.settings?.mcp?.offer?.answered || offered;
      const [status, acts] = await Promise.all([api.invoke('mcp:status'), api.invoke('mcp:activity').catch(() => [])]);
      st = status;
      last = (Array.isArray(acts) ? acts : []).find((a) => a && (a.kind === 'tool' || a.kind === 'connect')) || null;
    } catch {
      st = null;
    }
    if (!disposed) draw();
  }

  async function offerAnswer(answer, app) {
    offered = answer;
    try {
      await store.setSettings({ mcp: { offer: { answered: answer, app: app || null, at: Date.now() } } });
    } catch (err) {
      console.warn('[mcp] aviso', err?.message || err);
    }
  }

  async function connect(btn, app, fromOffer = false) {
    const done = setBusy(btn);
    try {
      const r = await app.install();
      st = r.status || st;
      const s = r.result?.status;
      const desktop = app.id === 'desktop';
      if (s === 'notInstalled') fail(desktop ? t('mcp.missingDesktop') : t('mcp.missingCode'), '');
      else if (s === 'already') ok(desktop ? t('mcp.alreadyDesktop') : t('mcp.alreadyCode'));
      else ok(desktop ? t('mcp.connectedDesktop') : t('mcp.connectedCode'), desktop ? t('mcp.connectedDesktopText') : t('mcp.connectedCodeText'));
      if (fromOffer) await offerAnswer('connect', app.id);
    } catch (err) {
      if (err?.code === 'plan') openPlans();
      else fail(t('mcp.connectFailed'), err);
    }
    done();
    if (!disposed) load();
  }

  function stateOf(c) {
    if (!c) return pill('', null, t('mcp.stateNotInstalled'));
    if (c.registered && c.outdated) return pill('warn', 'alert', t('mcp.stateOutdated'));
    if (c.registered) return pill('good', 'check', t('mcp.stateConnected'));
    if (!c.installed) return pill('', null, t('mcp.stateNotInstalled'));
    return pill('', null, t('mcp.stateNotConnected'));
  }

  function appRow(app) {
    const c = st.clients?.[app.key];
    const action =
      c?.registered && !c.outdated
        ? null
        : h(
            'button',
            { class: 'btn sm', type: 'button', disabled: Boolean(c && !c.installed && !c.registered), dataset: { fk: `assist:${app.id}` }, onclick: (e) => connect(e.currentTarget, app) },
            icon(c?.outdated ? 'wrench' : 'plug'),
            c?.outdated ? t('mcp.repair') : t('mcp.connect'),
          );
    // Con el boton "Conectar" a la vista, el estado "Sin conectar" sobra (columna angosta)
    const state = action && c?.installed && !c?.registered ? null : stateOf(c);
    return h('div', { class: 'mcp-assist-app' }, h('span', { class: 'mcp-assist-ic', 'aria-hidden': 'true' }, icon(app.icon)), h('span', { class: 'mcp-assist-name' }, app.name()), h('span', { class: 'mcp-assist-side' }, state, action));
  }

  // ChatGPT se conecta desde chatgpt.com con la URL publica: "Configurar" lleva al panel completo
  function chatgptRow() {
    const c = st.clients?.chatgpt;
    return h(
      'div',
      { class: 'mcp-assist-app' },
      h('span', { class: 'mcp-assist-ic', 'aria-hidden': 'true' }, icon('globe')),
      h('span', { class: 'mcp-assist-name' }, t('mcp.assistChatgpt')),
      h(
        'span',
        { class: 'mcp-assist-side' },
        c?.registered ? pill('good', 'check', t('mcp.stateConnected')) : null,
        c?.registered ? null : h('button', { class: 'btn sm ghost', type: 'button', dataset: { fk: 'assist:chatgpt' }, onclick: () => navigate('settings/ai/mcp') }, icon('settings'), t('mcp.assistSetup')),
      ),
    );
  }

  // Aviso unico: una app de Claude instalada, ninguna conectada y nunca se contesto
  function offer() {
    if (offered) return null;
    const app = OFFER_APPS.find((a) => st.clients?.[a.key]?.installed && !st.clients?.[a.key]?.registered);
    if (!app || OFFER_APPS.some((a) => st.clients?.[a.key]?.registered)) return null;
    const yes = h('button', { class: 'btn sm primary', type: 'button', dataset: { fk: 'assist:offer' }, onclick: (e) => connect(e.currentTarget, app, true) }, icon('plug'), t('mcp.connect'));
    const no = h(
      'button',
      {
        class: 'btn sm ghost',
        type: 'button',
        dataset: { fk: 'assist:later' },
        onclick: async () => {
          await offerAnswer('later', app.id);
          if (!disposed) draw();
        },
      },
      t('mcp.assistLater'),
    );
    return h('div', { class: 'notice info mcp-assist-offer' }, icon('sparkles'), h('div', {}, h('b', {}, t('mcp.assistOfferTitle', { app: app.name() })), h('div', {}, t('mcp.assistOfferText')), h('div', { class: 'mcp-actions' }, yes, no)));
  }

  function draw() {
    if (!st?.available || st.plan?.entitled !== true) {
      root.classList.add('hidden');
      mount(root);
      return;
    }
    root.classList.remove('hidden');
    root.classList.toggle('highlight', highlight);
    mount(
      root,
      h('h2', { class: 'card-title' }, icon('plug'), t('mcp.assistTitle')),
      highlight ? h('div', { class: 'notice mcp-assist-down' }, icon('alert'), h('div', {}, t('mcp.assistDown'))) : h('p', { class: 'mcp-muted' }, t('mcp.assistText')),
      offer(),
      h('div', { class: 'mcp-assist-apps' }, OFFER_APPS.map(appRow), chatgptRow()),
      h('p', { class: 'mcp-muted mcp-assist-last' }, icon('activity'), h('span', {}, last ? t('mcp.assistLast', { when: fmtAgo(last.at), client: last.client || '—' }) : t('mcp.assistNoActivity'))),
      h('button', { class: 'btn sm ghost mcp-assist-more', type: 'button', onclick: () => navigate('settings/ai/mcp') }, icon('settings'), t('mcp.assistMore')),
    );
  }

  // Volver a detectar al volver a la ventana (por ejemplo, despues de instalar Claude), como mucho cada 15 s
  const onFocus = () => {
    if (Date.now() - lastCheck < 15000) return;
    lastCheck = Date.now();
    load();
  };
  window.addEventListener('focus', onFocus);
  offs.push(() => window.removeEventListener('focus', onFocus));
  offs.push(
    api.on('mcp:status', (s) => {
      st = s;
      if (!disposed) draw();
    }),
  );
  offs.push(
    api.on('mcp:activity', (a) => {
      if (a?.cleared) last = null;
      else if (a && (a.kind === 'tool' || a.kind === 'connect')) last = a;
      if (!disposed && st) draw();
    }),
  );
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
  root.setHighlight = (on) => {
    if (highlight === Boolean(on)) return;
    highlight = Boolean(on);
    if (st && !disposed) draw();
  };
  lastCheck = Date.now();
  load();
  return root;
}
