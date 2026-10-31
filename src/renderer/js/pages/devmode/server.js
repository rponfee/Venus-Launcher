// Tarjeta del servidor de prueba: crear (con EULA) o vincular, iniciar/detener/reiniciar, progreso,
// fase del despliegue, depuracion remota y consola embebida con historial de comandos.
import { h, icon, mount, modal, fail, ok, copyText, selectEl, switchEl, fmtMb, skeleton, setBusy } from '../../ui.js';
import { store, api } from '../../store.js';
import { t } from '../../i18n.js';
import { navigate } from '../../app.js';
import { typeMeta, typeBadge, tile, statePill, iconBtn, serverTaskFor, taskBar, failUnlessTask, EULA_URL } from './common.js';

const QUICK = ['plugins', 'tps', 'list', 'save-all'];

// ---------- Crear servidor ----------

export function openCreateServer(ctx) {
  const p = ctx.p;
  const acc = store.selectedAccount();
  let type = 'paper';
  let onlineMode = acc?.type === 'msa';

  const typeDesc = h('div', { class: 'field-help' });
  const typeBtns = ['paper', 'purpur', 'folia'].map((ty) =>
    h(
      'button',
      { type: 'button', role: 'radio', 'aria-checked': ty === type ? 'true' : 'false', tabindex: ty === type ? '0' : '-1', class: ty === type ? 'active' : '', dataset: { type: ty }, onclick: () => selectType(ty) },
      h('span', { class: 'dm-type-dot', style: { '--c': typeMeta(ty).color }, 'aria-hidden': 'true' }),
      typeMeta(ty).name,
    ),
  );
  const typeSeg = h('div', { class: 'segmented dm-type-seg', role: 'radiogroup', 'aria-labelledby': 'dm-new-type-label' }, typeBtns);
  // Flechas para cambiar de tipo (patron radiogroup: una sola parada de Tab)
  typeSeg.addEventListener('keydown', (e) => {
    const i = typeBtns.indexOf(document.activeElement);
    if (i < 0) return;
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = typeBtns[(i + step + typeBtns.length) % typeBtns.length];
    selectType(next.dataset.type);
    next.focus();
  });
  const versionSel = h('select', { class: 'select', id: 'dm-new-version', 'aria-describedby': 'dm-new-version-help' });
  const versionHint = h('div', { class: 'field-help', id: 'dm-new-version-help' });
  const portInput = h('input', { class: 'input num', id: 'dm-new-port', type: 'number', min: 1024, max: 65535, step: 1, placeholder: '25565', 'aria-describedby': 'dm-new-port-help' });
  const memSel = selectEl(
    [1024, 2048, 3072, 4096, 6144].map((mb) => ({ value: mb, label: fmtMb(mb) })),
    2048,
  );
  memSel.id = 'dm-new-mem';
  const onlineHint = h('div', { class: 'tr-sub' });
  const drawOnline = () => {
    onlineHint.textContent = onlineMode ? t('devmode.onlineOnHint') : t('devmode.onlineOffHint');
  };
  const onlineRow = h(
    'div',
    { class: 'toggle-row dm-toggle' },
    h('div', { class: 'tr-text' }, h('div', { class: 'tr-title' }, t('devmode.onlineMode')), onlineHint),
    switchEl(onlineMode, (v) => {
      onlineMode = v;
      drawOnline();
    }, t('devmode.onlineMode')),
  );
  drawOnline();
  const eulaCb = h('input', { type: 'checkbox', id: 'dm-eula' });
  const createBtn = h('button', { class: 'btn primary', type: 'button', disabled: true }, icon('server'), t('devmode.createAndInstall'));
  const sync = () => {
    createBtn.disabled = !eulaCb.checked || !versionSel.value || versionSel.disabled;
  };
  eulaCb.addEventListener('change', sync);
  versionSel.addEventListener('change', sync);

  function selectType(ty) {
    type = ty;
    for (const b of typeBtns) {
      const on = b.dataset.type === ty;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    }
    const foliaWarn = ty === 'folia' && p.plugin && !p.plugin.foliaSupported;
    mount(typeDesc, t(`devmode.typeDesc_${ty}`), foliaWarn ? h('span', { class: 'dm-warn-text' }, ` ${t('devmode.foliaNotSupported')}`) : null);
    loadVersions();
  }

  async function loadVersions() {
    versionSel.disabled = true;
    mount(versionSel, h('option', { value: '' }, t('common.loading')));
    versionHint.textContent = '';
    sync();
    const wanted = type;
    try {
      const res = await api.invoke('devmode:serverOptions', p.id, type);
      if (wanted !== type) return;
      if (!res.versions.length) {
        mount(versionSel, h('option', { value: '' }, t('devmode.noVersions')));
        return;
      }
      mount(
        versionSel,
        res.versions.slice(0, 120).map((v) => h('option', { value: v, selected: v === res.suggested }, v === res.suggested ? t('devmode.versionSuggested', { version: v }) : v)),
      );
      versionSel.disabled = false;
      if (!portInput.value) portInput.value = String(res.port || 25565);
      versionHint.textContent =
        res.reason === 'build' ? t('devmode.suggestBuild', { version: res.mcHint }) : res.reason === 'api' ? t('devmode.suggestApi', { version: res.apiVersion }) : t('devmode.suggestLatest');
    } catch (err) {
      if (wanted !== type) return;
      mount(versionSel, h('option', { value: '' }, t('devmode.noVersions')));
      versionHint.textContent = err.message;
    } finally {
      sync();
    }
  }

  const body = h(
    'div',
    { class: 'stack dm-create' },
    h('p', { class: 'text-2 dm-dialog-text' }, t('devmode.createIntro', { name: p.name })),
    h('div', { class: 'field' }, h('span', { class: 'label', id: 'dm-new-type-label' }, t('devmode.serverType')), typeSeg, typeDesc),
    h(
      'div',
      { class: 'form-grid' },
      h('div', { class: 'field' }, h('label', { for: 'dm-new-version' }, t('devmode.mcVersion')), versionSel, versionHint),
      h('div', { class: 'field' }, h('label', { for: 'dm-new-port' }, t('devmode.port')), portInput, h('div', { class: 'field-help', id: 'dm-new-port-help' }, t('devmode.portHint'))),
      h('div', { class: 'field' }, h('label', { for: 'dm-new-mem' }, t('devmode.memory')), memSel),
    ),
    onlineRow,
    h('div', { class: 'notice info' }, icon('sparkles'), h('div', {}, acc ? t('devmode.createInfoOp', { name: acc.name }) : t('devmode.createInfo'))),
    h(
      'div',
      { class: 'dm-eula' },
      h('label', { class: 'dm-check', for: 'dm-eula' }, eulaCb, h('span', {}, t('devmode.eulaAccept'))),
      h('button', { class: 'btn sm ghost', type: 'button', onclick: () => api.app.openExternal(EULA_URL) }, icon('external'), t('devmode.eulaRead')),
    ),
  );

  const m = modal({
    title: t('devmode.createTitle'),
    body,
    footer: [h('button', { class: 'btn ghost', type: 'button', onclick: () => m.close() }, t('common.cancel')), createBtn],
  });
  createBtn.addEventListener('click', async () => {
    const done = setBusy(createBtn);
    try {
      const port = portInput.value.trim() ? Number(portInput.value) : undefined;
      const s = await api.invoke('devmode:createServer', p.id, {
        type,
        mcVersion: versionSel.value,
        port,
        memory: Number(memSel.value),
        onlineMode,
        eula: eulaCb.checked,
        op: acc ? { name: acc.name, uuid: acc.uuid || null } : null,
      });
      done();
      m.close();
      ok(t('devmode.serverCreated', { name: s.name }), t('devmode.serverCreatedText'));
      ctx.refresh();
    } catch (err) {
      done();
      fail(t('devmode.errCreateServer'), err);
      sync();
    }
  });
  selectType('paper');
}

// ---------- Vincular un servidor existente ----------

export async function openLinkServer(ctx) {
  const p = ctx.p;
  const listBox = h('div', { class: 'dm-pick-list', role: 'radiogroup', 'aria-label': t('devmode.linkTitle') }, skeleton('list', { rows: 3 }));
  const linkBtn = h('button', { class: 'btn primary', type: 'button', disabled: true }, icon('link'), t('devmode.link'));
  let chosen = null;
  const m = modal({
    title: t('devmode.linkTitle'),
    body: h('div', { class: 'stack' }, h('p', { class: 'text-2 dm-dialog-text' }, t('devmode.linkIntro')), listBox),
    footer: [h('button', { class: 'btn ghost', type: 'button', onclick: () => m.close() }, t('common.cancel')), linkBtn],
  });
  let list = [];
  try {
    list = await api.invoke('devmode:linkableServers');
  } catch (err) {
    mount(listBox, h('div', { class: 'notice bad' }, icon('alert'), h('div', {}, err.message)));
    return;
  }
  if (!list.length) {
    mount(
      listBox,
      h(
        'div',
        { class: 'dm-empty-mini' },
        icon('server'),
        h('div', {}, t('devmode.linkNone')),
        h(
          'button',
          {
            class: 'btn sm',
            type: 'button',
            onclick: () => {
              m.close();
              openCreateServer(ctx);
            },
          },
          icon('plus'),
          t('devmode.createServer'),
        ),
      ),
    );
    return;
  }
  mount(
    listBox,
    list.map((s) => {
      const radio = h('input', { type: 'radio', name: 'dm-link', value: s.id, checked: s.id === p.server.id });
      radio.addEventListener('change', () => {
        chosen = s.id;
        linkBtn.disabled = false;
      });
      const meta = typeMeta(s.type);
      return h(
        'label',
        { class: 'dm-pick' },
        radio,
        tile(meta.letter, meta.color),
        h('div', { class: 'dm-pick-main' }, h('div', { class: 'dm-pick-title ellipsis' }, s.name), h('div', { class: 'row wrap dm-pick-meta' }, typeBadge(s.type), h('span', { class: 'small muted' }, `${s.mcVersion} · :${s.port}`))),
        statePill(s.state),
      );
    }),
  );
  linkBtn.addEventListener('click', async () => {
    if (!chosen) return;
    const done = setBusy(linkBtn);
    try {
      await api.invoke('devmode:linkServer', p.id, chosen);
      done();
      m.close();
      ctx.refresh();
    } catch (err) {
      done();
      fail(t('devmode.errLink'), err);
    }
  });
}

// ---------- Consola ----------

function serverConsole(ctx) {
  let sid = null;
  let lines = [];
  let autoscroll = true;
  const history = [];
  let hIndex = -1;
  const box = h('div', { class: 'console dm-console dm-srv-console', role: 'log', 'aria-live': 'off', 'aria-label': t('devmode.console'), tabindex: 0 });
  const input = h('input', { class: 'input', autocomplete: 'off', spellcheck: 'false', 'aria-label': t('devmode.consoleInput') });
  const sendBtn = h('button', { class: 'btn primary', type: 'button', title: t('devmode.send'), 'aria-label': t('devmode.send') }, icon('send'));
  const quick = h(
    'div',
    { class: 'chips dm-quick' },
    QUICK.map((c) => h('button', { class: 'chip', type: 'button', title: `/${c}`, onclick: () => run(c) }, h('span', { class: 'mono' }, c))),
  );
  box.addEventListener('scroll', () => {
    autoscroll = box.scrollTop + box.clientHeight >= box.scrollHeight - 24;
  });
  const lineEl = (l) => h('div', { class: `dm-line l-${l.level || 'INFO'}` }, l.text);
  const empty = () => h('div', { class: 'dm-console-empty' }, icon('terminal'), h('div', {}, ctx.serverState === 'offline' ? t('devmode.consoleOffline') : t('devmode.consoleWaiting')));
  const redraw = () => {
    if (!lines.length) {
      mount(box, empty());
      return;
    }
    const frag = document.createDocumentFragment();
    for (const l of lines.slice(-2000)) frag.append(lineEl(l));
    mount(box, frag);
    if (autoscroll) box.scrollTop = box.scrollHeight;
  };
  const run = (cmd) => {
    const text = String(cmd || '').trim().replace(/^\//, '');
    if (!text) return;
    if (ctx.serverState === 'offline') {
      fail(t('devmode.errOffline'));
      return;
    }
    if (history[0] !== text) history.unshift(text);
    history.splice(60);
    hIndex = -1;
    api.invoke('devmode:command', ctx.id, text).catch((e) => fail(t('devmode.errCommand'), e));
  };
  const submit = () => {
    const v = input.value;
    input.value = '';
    run(v);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    } else if (e.key === 'ArrowUp' && history.length) {
      e.preventDefault();
      hIndex = Math.min(history.length - 1, hIndex + 1);
      input.value = history[hIndex];
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      hIndex = Math.max(-1, hIndex - 1);
      input.value = hIndex >= 0 ? history[hIndex] : '';
    }
  });
  sendBtn.addEventListener('click', submit);

  const el = h('div', { class: 'dm-console-wrap' }, box, h('div', { class: 'dm-cmd' }, h('span', { class: 'dm-cmd-prompt', 'aria-hidden': 'true' }, '>'), input, sendBtn), quick);

  const updateState = () => {
    const off = ctx.serverState === 'offline';
    input.disabled = off;
    sendBtn.disabled = off;
    quick.querySelectorAll('button').forEach((b) => {
      b.disabled = ctx.serverState !== 'online';
    });
    input.placeholder = off ? t('devmode.consoleInputOff') : t('devmode.consoleInputHint');
    if (!lines.length) redraw();
  };

  const load = (newSid) => {
    if (newSid === sid) return;
    sid = newSid;
    lines = [];
    mount(box, h('div', { class: 'loading-box' }, h('div', { class: 'spinner' })));
    api
      .invoke('devmode:serverLogs', ctx.id)
      .then((l) => {
        if (sid !== newSid) return;
        lines = [...(l || []), ...lines];
        redraw();
      })
      .catch(() => redraw());
  };

  const onLog = (line) => {
    if (!line) return;
    const wasEmpty = !lines.length;
    lines.push(line);
    if (lines.length > 4000) lines.splice(0, lines.length - 3000);
    if (wasEmpty || box.querySelector('.dm-console-empty, .loading-box')) {
      redraw();
      return;
    }
    box.append(lineEl(line));
    while (box.childNodes.length > 2000) box.firstChild.remove();
    if (autoscroll) box.scrollTop = box.scrollHeight;
  };

  return { el, load, onLog, updateState, focus: () => input.focus() };
}

// ---------- Tarjeta ----------

export function serverCard(ctx) {
  const el = h('section', { class: 'card dm-card dm-server', 'aria-label': t('devmode.serverCard') });
  const headPill = h('span', { class: 'dm-head-pill' });
  // La consola se monta una sola vez (no pierde el scroll ni el foco al redibujar el resto).
  const body = h('div', { class: 'dm-server-body' });
  const con = serverConsole(ctx);
  const consoleSlot = h('div', { class: 'dm-console-slot' }, con.el);
  mount(el, h('div', { class: 'card-head' }, h('h2', { class: 'card-title' }, icon('server'), t('devmode.serverCard')), headPill), body, consoleSlot);

  const act = async (e, fn, errKey) => {
    const done = setBusy(e.currentTarget);
    try {
      await fn();
    } catch (err) {
      failUnlessTask(store, t(`devmode.${errKey}`), err);
    } finally {
      done();
    }
  };

  const draw = () => {
    const p = ctx.p;
    const srv = p.server.info;
    if (!p.server.id || p.server.missing) {
      mount(headPill);
      consoleSlot.hidden = true;
      mount(
        body,
        p.server.missing ? h('div', { class: 'notice bad' }, icon('alert'), h('div', {}, t('devmode.serverMissing'))) : null,
        h(
          'div',
          { class: 'dm-empty-mini dm-server-empty' },
          icon('server'),
          h('div', { class: 'dm-empty-title' }, t('devmode.noServerTitle')),
          h('div', { class: 'small muted dm-empty-text' }, t('devmode.noServerText')),
          h(
            'div',
            { class: 'row wrap dm-center' },
            // El boton primario de la pagina es el del ciclo de arriba (tambien crea el servidor)
            h('button', { class: 'btn', type: 'button', onclick: () => openCreateServer(ctx) }, icon('plus'), t('devmode.createServer')),
            h('button', { class: 'btn ghost', type: 'button', onclick: () => openLinkServer(ctx) }, icon('link'), t('devmode.linkExisting')),
            p.server.missing ? h('button', { class: 'btn ghost', type: 'button', onclick: (e) => act(e, async () => { await api.invoke('devmode:unlinkServer', p.id); ctx.refresh(); }, 'errLink') }, icon('x'), t('devmode.unlink')) : null,
          ),
        ),
      );
      return;
    }
    const state = ctx.serverState;
    const meta = typeMeta(srv.type);
    const players = ctx.players?.length || 0;
    mount(headPill, statePill(state, state === 'online' ? t('devmode.playersCount', { count: players }) : null));
    const task = serverTaskFor(store, srv.id, p.id);
    const st = ctx.status || {};
    const buttons = [];
    if (state === 'offline') {
      buttons.push(h('button', { class: 'btn good', type: 'button', disabled: Boolean(task) || srv.busy, onclick: (e) => act(e, () => api.invoke('devmode:startServer', p.id, {}), 'errStart') }, icon('play'), t('devmode.start')));
    } else if (state === 'stopping') {
      buttons.push(h('button', { class: 'btn danger', type: 'button', title: t('devmode.killHint'), onclick: (e) => act(e, () => api.invoke('devmode:killServer', p.id), 'errStop') }, icon('zap'), t('devmode.kill')));
    } else {
      if (state === 'online') buttons.push(h('button', { class: 'btn', type: 'button', disabled: st.deploying, onclick: (e) => act(e, () => api.invoke('devmode:restartServer', p.id), 'errRestart') }, icon('dmCycle'), t('devmode.restart')));
      buttons.push(h('button', { class: 'btn danger', type: 'button', onclick: (e) => act(e, () => api.invoke('devmode:stopServer', p.id), 'errStop') }, icon('stop'), t('devmode.stop')));
    }
    const address = `localhost:${srv.port}`;
    mount(
      body,
      h(
        'div',
        { class: 'dm-srv-row' },
        tile(meta.letter, meta.color),
        h(
          'div',
          { class: 'dm-srv-main' },
          h('button', { class: 'dm-srv-name ellipsis', type: 'button', title: t('devmode.openInServers'), onclick: () => navigate(`server/${srv.id}`) }, srv.name),
          h(
            'div',
            { class: 'row wrap dm-srv-meta' },
            typeBadge(srv.type, srv.build ? `#${srv.build}` : null),
            h('span', { class: 'badge' }, icon('box'), `Minecraft ${srv.mcVersion}`),
            h('button', { class: 'badge dm-addr', type: 'button', title: t('devmode.copyAddress'), onclick: () => copyText(address) }, icon('copy'), address),
            srv.onlineMode === false ? h('span', { class: 'badge warn', title: t('devmode.offlineModeHint') }, t('devmode.offlineModeBadge')) : null,
            !srv.installed && !task ? h('span', { class: 'badge warn', title: t('devmode.notInstalledHint') }, icon('download'), t('devmode.notInstalled')) : null,
          ),
        ),
        h(
          'div',
          { class: 'dm-head-actions' },
          iconBtn('folderOpen', t('devmode.openPlugins'), () => api.invoke('devmode:open', p.id, 'plugins').catch((err) => fail(t('devmode.errOpen'), err))),
          iconBtn('external', t('devmode.openInServers'), () => navigate(`server/${srv.id}`)),
        ),
      ),
      h('div', { class: 'dm-actions' }, buttons),
      task ? taskBar(task) : null,
      st.deploying ? h('div', { class: 'dm-phase', role: 'status' }, h('div', { class: 'spinner' }), h('span', {}, t(`devmode.phase_${st.phase || 'copying'}`))) : null,
      p.server.debug && p.server.debugFlag
        ? h(
            'div',
            { class: 'notice info dm-debug' },
            icon('bug'),
            h(
              'div',
              { class: 'spacer' },
              h('div', {}, t(p.server.debugAnyHost ? 'devmode.debugOnAny' : 'devmode.debugOn', { port: p.server.debugPort })),
              h('div', { class: 'small dm-debug-hint' }, t('devmode.debugIdeHint', { port: p.server.debugPort })),
            ),
            h('button', { class: 'btn sm', type: 'button', title: p.server.debugFlag, onclick: () => copyText(p.server.debugFlag, t('devmode.flagCopied')) }, icon('copy'), t('devmode.copyFlag')),
          )
        : null,
    );
    consoleSlot.hidden = false;
    con.load(srv.id);
    con.updateState();
  };

  draw();
  const offs = [
    ctx.on('project', draw),
    ctx.on('server', draw),
    ctx.on('status', draw),
    ctx.on('task', draw),
    ctx.on('serverLog', (line) => con.onLog(line)),
  ];
  return { el, destroy: () => offs.forEach((o) => o()) };
}
