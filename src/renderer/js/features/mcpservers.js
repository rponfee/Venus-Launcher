// Servidores MCP del asistente (Ajustes > IA > "Servidores MCP del asistente"): el asistente del launcher como
// cliente MCP. El usuario agrega servidores remotos (URL Streamable HTTP + token opcional) o locales (comando,
// argumentos y variables de entorno: ejecutan un programa en la PC), o los importa de Claude Desktop; los activa
// o desactiva, prueba la conexion y ve sus herramientas con "Permitir siempre". Solo con plan Go o superior.
// Las herramientas se ejecutan en el launcher, asi que andan con Claude y con ChatGPT.
// Contrato: mcpServersPanel() -> Element (con .destroy()). Canales: assistant:mcp* (docs/asistente-ia.md).
import { h, icon, mount, ok, fail, ensureCss, modal, confirmDialog, switchEl, setBusy, skeleton, emptyState, fmtNumber } from '../ui.js';
import { api } from '../store.js';
import { t, loadNs, locale } from '../i18n.js';
import { navigate } from '../app.js';

const NS = 'assistant';
let readyPromise = null;
let seq = 0;

function prepare() {
  ensureCss('features/mcpservers');
  if (!readyPromise) readyPromise = loadNs(NS).catch((err) => console.warn('[mcpservers] textos', err));
  return readyPromise;
}

const isMissing = (err) => /No handler registered/i.test(err?.message || '');
const errText = (err) => err?.message || String(err || '');
const pill = (kind, iconName, text) => h('span', { class: ['pill', kind] }, iconName ? icon(iconName) : null, text);
const note = (kind, iconName, ...children) => h('div', { class: ['notice', kind, 'ams-notice'] }, icon(iconName), h('div', {}, ...children));

// Las tarjetas de planes de features/plans.js; si no cargan, Ajustes > Plan.
async function openPlans() {
  try {
    const plans = await import('./plans.js');
    await plans.openPlans({ reason: 'needsPlan' });
  } catch (err) {
    console.warn('[mcpservers] planes', err);
    navigate('settings/plan');
  }
}

function where(s) {
  return s.type === 'http' ? s.url || '' : [s.command, ...(s.args || [])].filter(Boolean).join(' ');
}

function field(label, control, hint, extra = null) {
  const id = control.id || `ams-f-${++seq}`;
  control.id = id;
  if (hint) control.setAttribute('aria-describedby', `${id}-help`);
  return h('div', { class: 'field' }, h('label', { for: id }, label), control, extra, hint ? h('div', { class: 'field-help', id: `${id}-help` }, hint) : null);
}

/**
 * Panel de Ajustes. Se limpia solo cuando sale del documento (o con el.destroy()).
 */
export function mcpServersPanel() {
  const root = h('section', { class: 'card ams-panel', 'aria-busy': 'true' }, skeleton('card', { lines: 4 }));
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
  const watch = setInterval(() => {
    if (root.isConnected) seen = true;
    else if (seen || Date.now() - born > 60000) dispose();
  }, 2000);
  root.destroy = dispose;
  prepare()
    .then(() => build(root, offs, () => disposed))
    .catch((err) => {
      console.error('[mcpservers]', err);
      mount(root, note('bad', 'alert', errText(err)));
    })
    .finally(() => root.removeAttribute('aria-busy'));
  return root;
}

async function build(root, offs, isDisposed) {
  let st = null; // { plan, servers, limits, claudeDesktop }
  const results = new Map(); // id -> ultimo resultado de "Probar"

  try {
    st = await api.invoke('assistant:mcpServers');
  } catch (err) {
    mount(root, note('bad', 'alert', isMissing(err) ? t('assistant.mcpUnavailable') : t('assistant.mcpLoadFailed')));
    return;
  }
  if (isDisposed()) return;

  const head = h(
    'div',
    { class: 'ams-head' },
    h('div', { class: 'ams-logo', 'aria-hidden': 'true' }, icon('plug')),
    h('div', { class: 'ams-head-text' }, h('div', { class: 'card-title' }, t('assistant.mcpTitle')), h('p', { class: 'ams-sub' }, t('assistant.mcpSubtitle'))),
  );
  const gateBox = h('div', { class: 'ams-gate', 'aria-live': 'polite' });
  const listBox = h('div', { class: 'ams-list' });
  const actionsBox = h('div', { class: 'ams-actions' });
  const foot = h(
    'div',
    { class: 'ams-foot' },
    h('p', { class: 'ams-muted' }, icon('shield'), h('span', {}, t('assistant.mcpPrivacy'))),
    h('p', { class: 'ams-muted' }, icon('info'), h('span', {}, t('assistant.mcpLimitNote', { max: st.limits?.tools || 40, chars: new Intl.NumberFormat(locale()).format(st.limits?.resultChars || 20000) }))),
  );
  mount(root, head, gateBox, listBox, actionsBox, foot);

  const entitled = () => st?.plan?.entitled === true;

  async function reload(refresh = false) {
    try {
      const next = await api.invoke('assistant:mcpServers', refresh ? { refresh: true } : undefined);
      if (!isDisposed()) {
        st = next;
        drawAll();
      }
    } catch (err) {
      console.warn('[mcpservers]', errText(err));
    }
  }

  // ---------- Plan ----------
  function drawGate() {
    const p = st.plan || {};
    if (p.entitled) {
      mount(gateBox);
      return;
    }
    if (p.checking || p.reason === 'checking') {
      mount(gateBox, h('div', { class: 'ams-checking' }, h('div', { class: 'spinner', 'aria-hidden': 'true' }), h('span', { class: 'ams-muted' }, t('assistant.mcpChecking'))));
      return;
    }
    if (p.reason === 'signedOut' || p.reason === 'noCloud') {
      mount(gateBox, note('info', 'logIn', h('b', {}, t('assistant.mcpGateSignedOutTitle')), h('div', {}, t('assistant.mcpGateSignedOut')), h('div', { class: 'ams-row' }, h('button', { class: 'btn sm tonal', type: 'button', onclick: () => navigate('settings/cloud/venus') }, icon('logIn'), t('assistant.mcpSignIn')))));
      return;
    }
    mount(
      gateBox,
      note(
        '',
        'crown',
        h('b', {}, t('assistant.mcpGateTitle')),
        h('div', {}, t('assistant.mcpGateText')),
        h(
          'div',
          { class: 'ams-row' },
          h('button', { class: 'btn sm tonal', type: 'button', onclick: () => openPlans() }, icon('crown'), t('assistant.mcpUpgrade')),
          p.reason === 'offline' || p.reason === 'error' ? h('button', { class: 'btn sm ghost', type: 'button', onclick: (e) => retryPlan(e.currentTarget) }, icon('refresh'), t('assistant.retry')) : null,
        ),
      ),
    );
  }

  async function retryPlan(btn) {
    const done = setBusy(btn);
    await reload(true);
    done();
  }

  // ---------- Lista ----------
  function statePill(s) {
    const res = results.get(s.id);
    const stt = s.status || {};
    if (!s.enabled) return pill('', 'power', t('assistant.mcpStateOff'));
    if ((res && !res.ok) || stt.state === 'error') return pill('bad', 'alert', t('assistant.mcpStateError'));
    if (stt.state === 'connecting') return pill('info', 'clock', t('assistant.mcpStateConnecting'));
    const count = res?.ok ? res.tools.length : stt.toolCount;
    if (Number.isInteger(count)) return pill('good', 'check', t('assistant.mcpStateReady', { count }));
    return pill('', 'plug', t('assistant.mcpStateIdle'));
  }

  function resultLine(s) {
    const res = results.get(s.id);
    if (res?.ok) {
      const name = res.info?.server?.title || res.info?.server?.name;
      const meta = [name ? `«${name}»` : null, res.info?.version ? t('assistant.mcpVersion', { version: res.info.version }) : null, `${fmtNumber(res.ms)} ms`].filter(Boolean).join(' · ');
      return h('div', { class: 'ams-result good' }, icon('check'), h('span', {}, t('assistant.mcpTestOk', { count: res.tools.length }), meta ? h('span', { class: 'ams-result-meta' }, ` · ${meta}`) : null));
    }
    const error = res && !res.ok ? res.error : s.enabled && s.status?.state === 'error' ? s.status.error : null;
    return error ? h('div', { class: 'ams-result bad' }, icon('alert'), h('span', {}, error)) : null;
  }

  async function toggle(s, on, input) {
    input.disabled = true;
    try {
      const r = await api.invoke('assistant:mcpSetEnabled', s.id, on);
      st.servers = r.servers;
      if (!on) results.delete(s.id);
    } catch (err) {
      if (err?.code === 'plan') openPlans();
      else fail(t('assistant.mcpToggleFailed'), err);
    }
    if (!isDisposed()) drawList();
  }

  async function runTest(btn, s) {
    const done = setBusy(btn);
    let r;
    try {
      r = await api.invoke('assistant:mcpTest', s.id);
    } catch (err) {
      if (err?.code === 'plan') openPlans();
      r = { ok: false, error: errText(err) };
    }
    done();
    if (isDisposed()) return;
    results.set(s.id, r);
    if (r.server) st.servers = st.servers.map((x) => (x.id === r.server.id ? r.server : x));
    drawList();
    if (!r.ok) root.querySelector(`[data-id="${s.id}"] .ams-result`)?.focus?.();
  }

  async function removeServer(s) {
    const yes = await confirmDialog(t('assistant.mcpRemoveTitle'), t('assistant.mcpRemoveText', { name: s.name }), { okText: t('assistant.mcpRemove'), danger: true });
    if (!yes) return;
    try {
      const r = await api.invoke('assistant:mcpRemove', s.id);
      st.servers = r.servers;
      results.delete(s.id);
      ok(t('assistant.mcpRemoved'));
    } catch (err) {
      fail(t('assistant.mcpSaveFailed'), err);
    }
    if (!isDisposed()) drawList();
  }

  function serverRow(s) {
    const remote = s.type === 'http';
    const sw = switchEl(s.enabled, (v) => toggle(s, v, input), t('assistant.mcpEnableAria', { name: s.name }));
    const input = sw.querySelector('input');
    if (!entitled() && !s.enabled) input.disabled = true;
    const count = results.get(s.id)?.ok ? results.get(s.id).tools.length : s.status?.toolCount;
    return h(
      'div',
      { class: ['ams-server', !s.enabled && 'off'], dataset: { id: s.id } },
      h(
        'div',
        { class: 'ams-server-head' },
        h('div', { class: 'ams-server-icon', 'aria-hidden': 'true' }, icon(remote ? 'globe' : 'terminal')),
        h(
          'div',
          { class: 'ams-server-main' },
          h('div', { class: 'ams-server-name' }, h('span', { class: 'ams-server-title' }, s.name), h('span', { class: 'badge' }, remote ? t('assistant.mcpRemote') : t('assistant.mcpLocal')), s.source === 'claudeDesktop' ? h('span', { class: 'badge accent' }, t('assistant.mcpFromClaude')) : null),
          h('code', { class: 'ams-where mono', title: where(s) }, where(s)),
        ),
        h('div', { class: 'ams-server-side' }, statePill(s), sw),
      ),
      h(
        'div',
        { class: 'ams-server-actions' },
        h('button', { class: 'btn sm', type: 'button', disabled: !entitled() || !s.enabled, dataset: { act: 'test' }, onclick: (e) => runTest(e.currentTarget, s) }, icon('zap'), t('assistant.mcpTest')),
        h('button', { class: 'btn sm ghost', type: 'button', disabled: !entitled() || !s.enabled, dataset: { act: 'tools' }, onclick: () => openTools(s) }, icon('list'), Number.isInteger(count) ? t('assistant.mcpToolsCount', { count }) : t('assistant.mcpTools')),
        h('button', { class: 'btn sm ghost', type: 'button', disabled: !entitled(), dataset: { act: 'edit' }, onclick: () => openForm(s.type, s) }, icon('edit'), t('assistant.mcpEdit')),
        h('button', { class: 'icon-btn sm danger', type: 'button', title: t('assistant.mcpRemove'), 'aria-label': t('assistant.mcpRemoveOf', { name: s.name }), dataset: { act: 'remove' }, onclick: () => removeServer(s) }, icon('trash')),
      ),
      h('div', { class: 'ams-server-result', 'aria-live': 'polite', tabindex: '-1' }, resultLine(s)),
    );
  }

  function drawList() {
    const list = st.servers || [];
    if (!list.length) {
      mount(listBox, emptyState('plug', t('assistant.mcpEmptyTitle'), t('assistant.mcpEmptyText')));
      return;
    }
    mount(listBox, list.map(serverRow));
  }

  function drawActions() {
    const can = entitled();
    const full = (st.servers || []).length >= (st.limits?.servers || 20);
    mount(
      actionsBox,
      h('button', { class: 'btn sm primary', type: 'button', disabled: !can || full, dataset: { act: 'addRemote' }, onclick: () => openForm('http') }, icon('globe'), t('assistant.mcpAddRemote')),
      h('button', { class: 'btn sm tonal', type: 'button', disabled: !can || full, dataset: { act: 'addLocal' }, onclick: () => openForm('stdio') }, icon('terminal'), t('assistant.mcpAddLocal')),
      h(
        'button',
        { class: 'btn sm ghost', type: 'button', disabled: !can || full, dataset: { act: 'import' }, title: st.claudeDesktop?.found ? null : t('assistant.mcpImportNotFound'), onclick: () => openImport() },
        icon('download'),
        t('assistant.mcpImport'),
      ),
    );
  }

  function drawAll() {
    drawGate();
    drawList();
    drawActions();
  }

  // ---------- Agregar o editar ----------
  function envEditor(keys = []) {
    const rows = h('div', { class: 'ams-env-rows' });
    const addRow = (name = '', keep = false) => {
      const nameIn = h('input', { class: 'input mono', type: 'text', value: name, placeholder: 'API_KEY', spellcheck: 'false', autocomplete: 'off', 'aria-label': t('assistant.mcpEnvName') });
      const valueIn = h('input', { class: 'input mono', type: 'password', placeholder: keep ? t('assistant.mcpEnvKeep') : t('assistant.mcpEnvValue'), autocomplete: 'off', 'aria-label': t('assistant.mcpEnvValueOf', { name: name || '—' }) });
      const row = h('div', { class: 'ams-env-row' }, nameIn, valueIn, h('button', { class: 'icon-btn sm', type: 'button', title: t('assistant.mcpEnvRemove'), 'aria-label': t('assistant.mcpEnvRemove'), onclick: () => row.remove() }, icon('x')));
      row._get = () => ({ name: nameIn.value.trim(), value: valueIn.value, keep: keep && !valueIn.value && nameIn.value.trim() === name });
      rows.append(row);
      return nameIn;
    };
    keys.forEach((k) => addRow(k, true));
    const add = h('button', { class: 'btn sm ghost', type: 'button', onclick: () => addRow().focus() }, icon('plus'), t('assistant.mcpEnvAdd'));
    const el = h('div', { class: 'ams-env' }, rows, h('div', {}, add));
    el.collect = () => [...rows.children].map((r) => r._get()).filter((r) => r.name);
    return el;
  }

  function openForm(type, s = null) {
    const remote = type === 'http';
    const errBox = h('div', { class: 'ams-form-error', 'aria-live': 'assertive' });
    const nameIn = h('input', { class: 'input', type: 'text', maxlength: '60', value: s?.name || '', placeholder: remote ? 'GitHub' : t('assistant.mcpNamePlaceholder'), autocomplete: 'off', spellcheck: 'false' });
    const parts = [];
    let urlIn = null;
    let tokenIn = null;
    let clearToken = null;
    let cmdIn = null;
    let argsIn = null;
    let env = null;
    let acceptIn = null;
    if (!remote) parts.push(note('bad', 'shieldAlert', h('b', {}, t('assistant.mcpLocalWarnTitle')), h('div', {}, t('assistant.mcpLocalWarn'))));
    parts.push(field(t('assistant.mcpName'), nameIn, t('assistant.mcpNameHint')));
    if (remote) {
      urlIn = h('input', { class: 'input mono', type: 'url', value: s?.url || '', placeholder: 'https://example.com/mcp', spellcheck: 'false', autocomplete: 'off' });
      tokenIn = h('input', { class: 'input mono', type: 'password', value: '', placeholder: s?.hasToken ? t('assistant.mcpTokenKeep') : t('assistant.mcpTokenPlaceholder'), autocomplete: 'off', spellcheck: 'false' });
      parts.push(field(t('assistant.mcpUrl'), urlIn, t('assistant.mcpUrlHint')), field(t('assistant.mcpToken'), tokenIn, t('assistant.mcpTokenHint')));
      if (s?.hasToken) {
        clearToken = h('input', { type: 'checkbox' });
        parts.push(h('label', { class: 'ams-check' }, clearToken, h('span', {}, t('assistant.mcpTokenClear'))));
      }
    } else {
      cmdIn = h('input', { class: 'input mono', type: 'text', value: s?.command || '', placeholder: 'npx', spellcheck: 'false', autocomplete: 'off' });
      argsIn = h('textarea', { class: 'textarea mono ams-args', rows: '3', spellcheck: 'false', placeholder: '-y\n@modelcontextprotocol/server-memory' });
      argsIn.value = (s?.args || []).join('\n');
      env = envEditor(s?.envKeys || []);
      parts.push(field(t('assistant.mcpCommand'), cmdIn, t('assistant.mcpCommandHint')), field(t('assistant.mcpArgs'), argsIn, t('assistant.mcpArgsHint')), h('div', { class: 'field' }, h('div', { class: 'label' }, t('assistant.mcpEnv')), env, h('div', { class: 'field-help' }, t('assistant.mcpEnvHint'))));
      if (!s) {
        acceptIn = h('input', { type: 'checkbox' });
        parts.push(h('label', { class: 'ams-check ams-accept' }, acceptIn, h('span', {}, t('assistant.mcpAccept'))));
      }
    }
    parts.push(errBox);
    const saveBtn = h('button', { class: 'btn primary', type: 'button' }, icon('check'), s ? t('assistant.mcpSave') : t('assistant.mcpSaveTest'));
    const m = modal({
      title: s ? t('assistant.mcpEditTitle', { name: s.name }) : remote ? t('assistant.mcpRemoteTitle') : t('assistant.mcpLocalTitle'),
      subtitle: remote ? t('assistant.mcpRemoteSub') : t('assistant.mcpLocalSub'),
      icon: remote ? 'globe' : 'terminal',
      body: h('div', { class: 'ams-form' }, parts),
      footer: [h('button', { class: 'btn ghost', type: 'button', onclick: () => m.close() }, t('assistant.cancel')), saveBtn],
    });
    saveBtn.addEventListener('click', async () => {
      mount(errBox);
      if (acceptIn && !acceptIn.checked) {
        mount(errBox, h('div', { class: 'field-error' }, icon('alert'), t('assistant.mcpAcceptNeeded')));
        acceptIn.focus();
        return;
      }
      const payload = { id: s?.id, type: remote ? 'http' : 'stdio', name: nameIn.value };
      if (remote) {
        payload.url = urlIn.value;
        payload.token = tokenIn.value;
        payload.clearToken = clearToken?.checked === true;
      } else {
        payload.command = cmdIn.value;
        payload.args = argsIn.value.split('\n').map((x) => x.replace(/\r$/, '')).filter((x) => x.length);
        payload.env = env.collect();
        if (acceptIn) payload.accepted = acceptIn.checked;
      }
      const done = setBusy(saveBtn);
      try {
        const r = await api.invoke('assistant:mcpSave', payload);
        st.servers = r.servers;
        results.delete(r.server.id);
        m.close();
        ok(t('assistant.mcpSaved'));
        if (!isDisposed()) {
          drawAll();
          // Recien agregado: se prueba enseguida
          const btn = root.querySelector(`[data-id="${r.server.id}"] [data-act="test"]`);
          if (btn && !s) runTest(btn, r.server);
        }
      } catch (err) {
        if (err?.code === 'plan') {
          m.close();
          openPlans();
        } else mount(errBox, h('div', { class: 'field-error' }, icon('alert'), errText(err)));
      }
      done();
    });
    queueMicrotask(() => nameIn.focus());
  }

  // ---------- Herramientas ----------
  function toolRow(s, tool) {
    const read = tool.readOnly === true;
    let control;
    if (read) control = h('span', { class: 'ams-tool-auto' }, t('assistant.mcpToolReadHint'));
    else {
      const sw = switchEl(tool.alwaysAllowed, async (v) => {
        input.disabled = true;
        try {
          await api.invoke('assistant:mcpAllowAlways', s.id, tool.name, v);
          tool.alwaysAllowed = v;
          ok(v ? t('assistant.mcpAllowedAlways', { tool: tool.title || tool.name }) : t('assistant.mcpAskAgain', { tool: tool.title || tool.name }));
        } catch (err) {
          input.checked = !v;
          fail(t('assistant.mcpSaveFailed'), err);
        }
        input.disabled = false;
      }, t('assistant.mcpAlwaysAllowOf', { tool: tool.title || tool.name }));
      const input = sw.querySelector('input');
      control = h('label', { class: 'ams-tool-allow' }, h('span', {}, t('assistant.mcpAllowAlways')), sw);
    }
    return h(
      'div',
      { class: ['ams-tool', tool.problem && 'problem'] },
      h(
        'div',
        { class: 'ams-tool-main' },
        h('div', { class: 'ams-tool-name' }, h('span', { class: 'ams-tool-title' }, tool.title || tool.name), read ? pill('good', 'eye', t('assistant.mcpToolRead')) : pill('warn', 'shield', t('assistant.mcpToolAsk')), tool.problem ? pill('bad', 'alert', t('assistant.mcpToolProblem')) : null),
        tool.description ? h('p', { class: 'ams-tool-desc' }, tool.description) : null,
        h('code', { class: 'ams-tool-id mono', title: t('assistant.mcpToolIdHint') }, tool.exposedName || tool.name),
      ),
      control,
    );
  }

  function openTools(s) {
    const body = h('div', { class: 'ams-tools' }, skeleton('list', { rows: 3 }));
    const refreshBtn = h('button', { class: 'btn ghost', type: 'button' }, icon('refresh'), t('assistant.mcpRefresh'));
    const m = modal({
      title: t('assistant.mcpToolsTitle', { name: s.name }),
      subtitle: where(s),
      icon: 'plug',
      size: 'wide',
      body,
      footer: [refreshBtn, h('button', { class: 'btn primary', type: 'button', onclick: () => m.close() }, t('assistant.mcpClose'))],
    });
    async function load(refresh) {
      const done = refresh ? setBusy(refreshBtn) : () => {};
      mount(body, skeleton('list', { rows: 3 }));
      let r;
      try {
        r = await api.invoke('assistant:mcpTools', s.id, refresh ? { refresh: true } : undefined);
      } catch (err) {
        r = { ok: false, error: errText(err), code: err?.code };
      }
      done();
      if (r.code === 'plan') {
        mount(body, note('', 'crown', h('b', {}, t('assistant.mcpGateTitle')), h('div', {}, t('assistant.mcpGateText'))));
        return;
      }
      if (!r.ok) {
        mount(body, note('bad', 'alert', h('b', {}, t('assistant.mcpToolsLoadFailed')), h('div', {}, r.error || '')));
        return;
      }
      if (r.server) st.servers = st.servers.map((x) => (x.id === r.server.id ? r.server : x));
      // Primero las que piden permiso (las que tienen "Permitir siempre"); despues las de lectura
      const list = [...(r.tools || [])].sort((a, b) => Number(a.readOnly === true) - Number(b.readOnly === true));
      if (!list.length) {
        mount(body, emptyState('plug', t('assistant.mcpToolsEmpty'), s.enabled ? null : t('assistant.mcpToolsOff')));
        return;
      }
      const reads = list.filter((x) => x.readOnly).length;
      mount(
        body,
        h('p', { class: 'ams-muted' }, icon('info'), h('span', {}, t('assistant.mcpToolsSummary', { count: list.length, reads }))),
        list.length > (st.limits?.tools || 40) ? note('warn', 'alert', t('assistant.mcpToolsOver', { max: st.limits?.tools || 40 })) : null,
        h('div', { class: 'ams-tool-list' }, list.map((tool) => toolRow(s, tool))),
      );
      if (!isDisposed()) drawList();
    }
    refreshBtn.addEventListener('click', () => load(true));
    load(false);
  }

  // ---------- Importar de Claude Desktop ----------
  async function openImport() {
    const body = h('div', { class: 'ams-import' }, skeleton('list', { rows: 2 }));
    const importBtn = h('button', { class: 'btn primary', type: 'button', disabled: true }, icon('download'), t('assistant.mcpImportBtn', { count: 0 }));
    const m = modal({ title: t('assistant.mcpImportTitle'), subtitle: t('assistant.mcpImportSub'), icon: 'download', size: 'wide', body, footer: [h('button', { class: 'btn ghost', type: 'button', onclick: () => m.close() }, t('assistant.cancel')), importBtn] });
    let preview;
    try {
      preview = await api.invoke('assistant:mcpImportPreview');
    } catch (err) {
      mount(body, note('bad', 'alert', errText(err)));
      return;
    }
    if (!preview?.found) {
      mount(body, emptyState('monitor', t('assistant.mcpImportNotFound'), t('assistant.mcpImportNotFoundText')));
      return;
    }
    const checks = [];
    const update = () => {
      const n = checks.filter((c) => c.checked).length;
      importBtn.disabled = n === 0;
      mount(importBtn, icon('download'), t('assistant.mcpImportBtn', { count: n }));
    };
    const rows = (preview.servers || []).map((c) => {
      const box = h('input', { type: 'checkbox', checked: !c.problem && !c.duplicate, disabled: Boolean(c.problem), 'aria-label': c.name });
      box.dataset.name = c.name;
      box.addEventListener('change', update);
      if (!c.problem) checks.push(box);
      const remote = c.type === 'http';
      const text = remote ? c.url : [c.command, ...(c.args || [])].filter(Boolean).join(' ');
      return h(
        'label',
        { class: ['ams-import-row', c.problem && 'problem'] },
        box,
        h('span', { class: 'ams-server-icon', 'aria-hidden': 'true' }, icon(remote ? 'globe' : 'terminal')),
        h(
          'span',
          { class: 'ams-import-main' },
          h('span', { class: 'ams-server-name' }, h('span', { class: 'ams-server-title' }, c.name), c.type ? h('span', { class: 'badge' }, remote ? t('assistant.mcpRemote') : t('assistant.mcpLocal')) : null, c.duplicate ? h('span', { class: 'badge warn' }, t('assistant.mcpImportDuplicate')) : null),
          text ? h('code', { class: 'ams-where mono', title: text }, text) : null,
          c.envKeys?.length ? h('span', { class: 'ams-muted' }, t('assistant.mcpImportEnv', { count: c.envKeys.length, names: c.envKeys.slice(0, 4).join(', ') })) : null,
          c.hasToken ? h('span', { class: 'ams-muted' }, t('assistant.mcpImportToken')) : null,
          c.problem ? h('span', { class: 'ams-import-problem' }, icon('alert'), t('assistant.mcpImportProblem', { reason: c.problem })) : null,
        ),
      );
    });
    const badFiles = (preview.files || []).filter((f) => f.error);
    mount(
      body,
      h('p', { class: 'ams-muted' }, icon('info'), h('span', {}, t('assistant.mcpImportText'))),
      badFiles.map((f) => note('bad', 'alert', t('assistant.mcpImportBadFile', { file: f.file }))),
      rows.length ? h('div', { class: 'ams-import-list' }, rows) : emptyState('plug', t('assistant.mcpImportNone')),
      (preview.servers || []).some((c) => c.type === 'stdio') ? note('bad', 'shieldAlert', h('b', {}, t('assistant.mcpLocalWarnTitle')), h('div', {}, t('assistant.mcpImportLocalWarn'))) : null,
    );
    update();
    importBtn.addEventListener('click', async () => {
      const names = checks.filter((c) => c.checked).map((c) => c.dataset.name);
      if (!names.length) return;
      const done = setBusy(importBtn);
      try {
        const r = await api.invoke('assistant:mcpImport', names);
        st.servers = r.servers;
        m.close();
        ok(t('assistant.mcpImportOk', { count: r.imported }));
        if (!isDisposed()) drawAll();
      } catch (err) {
        if (err?.code === 'plan') {
          m.close();
          openPlans();
        } else fail(t('assistant.mcpImportFailed'), err);
      }
      done();
    });
  }

  drawAll();

  // El plan puede cambiar mientras el panel esta abierto (pago, sesion, cuota)
  offs.push(api.on('billing:changed', () => reload(true)));
  offs.push(api.on('ai:quota', () => reload(false)));
  offs.push(
    api.on('mcp:status', (s) => {
      if (s?.plan && Boolean(s.plan.entitled) !== entitled()) reload(false);
    }),
  );
}
