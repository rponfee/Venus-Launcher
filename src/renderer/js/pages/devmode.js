// Modo desarrollador de plugins: proyecto (Gradle/Maven), build en vivo con compilacion al guardar,
// servidor Paper/Purpur/Folia de prueba con consola y depuracion, despliegue con reinicio, /reload o
// PlugManX, y cliente conectado con Quick Play. La logica vive en src/main/modules/devmode.
import { h, icon, mount, fail, ok, modal, emptyState, debounce, fmtAgo, setBusy } from '../ui.js';
import { store, api } from '../store.js';
import { t } from '../i18n.js';
import { launchInstance } from '../app.js';
import { fmtClock, tryInvoke, failUnlessTask } from './devmode/common.js';
import { projectCard } from './devmode/project.js';
import { buildCard } from './devmode/build.js';
import { serverCard, openCreateServer } from './devmode/server.js';
import { clientCard, createInstanceFor } from './devmode/client.js';
import { eventsCard } from './devmode/events.js';
import { settingsCard } from './devmode/settings.js';

// El proceso principal pide abrir el cliente cuando el servidor queda listo. Se escucha una sola vez
// por sesion (el modulo queda cargado aunque se cambie de pagina).
let autoLaunchBound = false;
function bindAutoLaunch() {
  if (autoLaunchBound) return;
  autoLaunchBound = true;
  api.on('devmode:autoLaunch', async (projectId, info) => {
    if (!info?.instanceId || store.running[info.instanceId]) return;
    const launched = await launchInstance(info.instanceId, { quickPlay: { server: 'localhost', port: Number(info.port) || 25565 } });
    if (launched) api.invoke('devmode:clientLaunched', projectId, info.instanceId).catch(() => {});
  });
}

async function pickProjectFolder() {
  const dir = await api.app.selectFolder({ title: t('devmode.pickFolderTitle') });
  if (!dir) return null;
  return api.invoke('devmode:addProject', dir);
}

// Sesion sin instancia elegida: ofrece crear una vanilla o seguir sin cliente.
function askNoInstance(ctx) {
  const version = ctx.p.server.info?.mcVersion || '';
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      m.close();
      resolve(v);
    };
    const m = modal({
      title: t('devmode.noInstanceTitle'),
      size: 'sm',
      body: h('p', { class: 'text-2 dm-dialog-text' }, t('devmode.noInstanceText', { version })),
      footer: [
        h('button', { class: 'btn ghost', type: 'button', onclick: () => finish('skip') }, t('devmode.withoutClient')),
        h('button', { class: 'btn primary', type: 'button', onclick: () => finish('create') }, icon('plus'), t('devmode.createVanilla', { version })),
      ],
      onClose: () => finish(null),
    });
  });
}

// Forma de la pagina mientras carga: ciclo arriba y dos columnas de tarjetas (un solo aviso "Cargando...")
const bone = (cls, style) => h('span', { class: `skeleton ${cls}`, style });
function skeletonView(headEl) {
  const cardBones = (lines, block) => h('div', { class: 'card dm-card dm-skel-card' }, bone('skeleton-line title'), Array.from({ length: lines }, () => bone('skeleton-line')), block ? bone('skeleton-block', { height: `${block}px` }) : null);
  return h(
    'div',
    { class: 'dm-root' },
    headEl,
    h(
      'div',
      { class: 'skeleton-group', role: 'status', 'aria-live': 'polite', 'aria-busy': 'true' },
      h('span', { class: 'sr-only' }, t('common.loading')),
      h(
        'div',
        { class: 'dm-skel', 'aria-hidden': 'true' },
        bone('skeleton-block dm-skel-flow'),
        h('div', { class: 'dm-grid' }, h('div', { class: 'dm-col dm-col-main' }, cardBones(4, 0), cardBones(2, 120)), h('div', { class: 'dm-col dm-col-side' }, cardBones(3, 0), cardBones(4, 0))),
      ),
    ),
  );
}

// Error de carga: que paso + Reintentar
function errorCard(title, err, onRetry) {
  return h('div', { class: 'card dm-error' }, emptyState('alert', title, err?.message || String(err || ''), h('button', { class: 'btn', type: 'button', onclick: onRetry }, icon('refresh'), t('common.retry'))));
}

function createPage(root) {
  const listeners = new Map();
  const ctx = {
    id: null,
    p: null,
    projects: [],
    serverState: 'offline',
    players: [],
    status: null,
    on(evt, fn) {
      if (!listeners.has(evt)) listeners.set(evt, new Set());
      listeners.get(evt).add(fn);
      return () => listeners.get(evt)?.delete(fn);
    },
    emit(evt, data) {
      for (const fn of listeners.get(evt) || []) {
        try {
          fn(data);
        } catch (err) {
          console.error('[devmode]', err);
        }
      }
    },
    async refresh() {
      if (!ctx.id) return;
      try {
        const p = await api.invoke('devmode:project', ctx.id);
        if (p.id !== ctx.id) return;
        ctx.p = p;
        ctx.status = p.status;
        ctx.serverState = p.server.info?.state || 'offline';
        if (p.server.info && p.server.info.players) ctx.players = p.server.info.players;
        ctx.emit('project');
      } catch (err) {
        console.warn('[devmode] refresh', err);
      }
    },
    async update(patch) {
      try {
        await api.invoke('devmode:update', ctx.id, patch);
        await ctx.refresh();
      } catch (err) {
        fail(t('devmode.errSave'), err);
        await ctx.refresh();
        throw err;
      }
    },
    reload: () => load(),
  };
  const refreshSoon = debounce(() => ctx.refresh(), 150);
  let cards = [];
  let ticker = null;
  const offs = [];

  const destroyCards = () => {
    for (const c of cards) {
      try {
        c.destroy?.();
      } catch (err) {
        console.error('[devmode]', err);
      }
    }
    cards = [];
    listeners.clear();
  };

  // ---------- Cabecera ----------
  function head(withProjects) {
    const actions = [];
    if (withProjects && ctx.projects.length > 1) {
      const sel = h(
        'select',
        { class: 'select dm-proj-select', 'aria-label': t('devmode.projectSelect') },
        ctx.projects.map((x) => h('option', { value: x.id, selected: x.id === ctx.id }, x.name)),
      );
      sel.addEventListener('change', async () => {
        await api.invoke('devmode:select', sel.value).catch(() => {});
        ctx.id = sel.value;
        renderProject();
      });
      actions.push(sel);
    }
    if (withProjects) {
      actions.push(
        h(
          'button',
          {
            class: 'btn',
            type: 'button',
            onclick: async (e) => {
              const done = setBusy(e.currentTarget);
              try {
                const p = await pickProjectFolder();
                if (!p) return;
                if (p.existing) ok(t('devmode.alreadyAdded', { name: p.name }));
                ctx.id = p.id;
                load();
              } catch (err) {
                fail(t('devmode.errAdd'), err);
              } finally {
                done();
              }
            },
          },
          icon('plus'),
          t('devmode.addProject'),
        ),
      );
    }
    return h(
      'div',
      { class: 'page-head' },
      h('div', { class: 'ph-text' }, h('h1', { class: 'page-title' }, t('devmode.title')), h('p', { class: 'page-sub' }, t('devmode.subtitle'))),
      actions.length ? h('div', { class: 'page-actions' }, actions) : null,
    );
  }

  // ---------- Sin proyectos ----------
  function renderEmpty() {
    destroyCards();
    const steps = [
      ['folderOpen', 'step1'],
      ['hammer', 'step2'],
      ['server', 'step3'],
      ['gamepad', 'step4'],
    ];
    const addBtn = h('button', { class: 'btn primary lg', type: 'button' }, icon('folderOpen'), t('devmode.pickFolder'));
    addBtn.addEventListener('click', async () => {
      const done = setBusy(addBtn);
      try {
        const p = await pickProjectFolder();
        if (p) {
          ctx.id = p.id;
          await load();
        }
      } catch (err) {
        fail(t('devmode.errAdd'), err);
      } finally {
        done();
      }
    });
    mount(
      root,
      h(
        'div',
        { class: 'dm-root' },
        head(false),
        h(
          'section',
          { class: 'dm-hero', 'aria-labelledby': 'dm-hero-title' },
          h('div', { class: 'dm-hero-glow', 'aria-hidden': 'true' }),
          h('div', { class: 'dm-hero-kicker' }, icon('code'), t('devmode.heroKicker')),
          h('h2', { class: 'dm-hero-title', id: 'dm-hero-title' }, t('devmode.emptyTitle')),
          h('p', { class: 'dm-hero-text' }, t('devmode.emptyText')),
          h(
            'ol',
            { class: 'dm-hero-steps' },
            steps.map(([ic, k], i) =>
              h('li', { class: 'dm-hero-step' }, h('div', { class: 'dm-hero-num', 'aria-hidden': 'true' }, String(i + 1)), h('div', { class: 'dm-hero-icon' }, icon(ic)), h('div', { class: 'dm-hero-step-title' }, t(`devmode.${k}Title`)), h('div', { class: 'dm-hero-step-text' }, t(`devmode.${k}Text`))),
            ),
          ),
          h('div', { class: 'dm-hero-actions' }, addBtn, h('span', { class: 'small muted' }, t('devmode.emptyHint'))),
        ),
      ),
    );
  }

  // ---------- Flujo (proyecto -> build -> servidor -> cliente) ----------
  const flowEl = h('section', { class: 'dm-flow', 'aria-label': t('devmode.flowLabel') });

  function step(ic, label, sub, state, badge) {
    return h(
      'div',
      { class: ['dm-step', state], title: badge ? `${sub} · ${badge.title}` : sub },
      h('div', { class: 'dm-step-icon' }, state === 'work' ? h('div', { class: 'spinner' }) : icon(ic)),
      h(
        'div',
        { class: 'dm-step-text' },
        h('div', { class: 'dm-step-label' }, label, badge ? h('span', { class: 'dm-step-badge', role: 'img', 'aria-label': badge.title }, icon(badge.icon)) : null),
        h('div', { class: 'dm-step-sub' }, sub),
      ),
    );
  }

  async function startSession(btn) {
    const p = ctx.p;
    let client = true;
    if (!p.client.instanceId) {
      const choice = await askNoInstance(ctx);
      if (!choice) return;
      if (choice === 'create') {
        try {
          await createInstanceFor(ctx);
        } catch (err) {
          fail(t('devmode.errInstance'), err);
          return;
        }
      } else client = false;
    }
    const done = setBusy(btn);
    try {
      const r = await api.invoke('devmode:startSession', ctx.id, { client });
      // Build fallido: el panel de tareas ya avisa; se lleva la vista a la tarjeta del build con la salida abierta.
      if (r && r.ok === false) {
        const card = root.querySelector('.dm-build');
        const out = card?.querySelector('.dm-output');
        if (out) out.open = true;
        card?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    } catch (err) {
      failUnlessTask(store, t('devmode.errSession'), err);
    } finally {
      done();
      ctx.refresh();
    }
  }

  function drawFlow() {
    const p = ctx.p;
    if (!p) return;
    const st = ctx.status || {};
    const d = p.detect;
    // Proyecto
    let projState = 'good';
    let projSub;
    if (!d.exists) {
      projState = 'bad';
      projSub = t('devmode.flowMissing');
    } else if (p.jar?.manual) projSub = t('devmode.flowManualJar');
    else if (d.tool) {
      projSub = `${d.tool === 'maven' ? 'Maven' : 'Gradle'} · ${d.task || ''}`;
      if (!d.runner) projState = 'warn';
    } else {
      projState = p.jar ? 'good' : 'warn';
      projSub = p.jar ? t('devmode.flowJarOnly') : t('devmode.flowNoTool');
    }
    // Build
    const last = p.last?.build;
    let buildState = '';
    let buildSub = t('devmode.flowNoBuild');
    if (st.building) {
      buildState = 'work';
      buildSub = t('devmode.flowBuilding', { time: fmtClock(Date.now() - (st.buildStartedAt || Date.now())) });
    } else if (last?.ok) {
      buildState = 'good';
      buildSub = t('devmode.flowBuildOk', { ago: fmtAgo(last.at) });
    } else if (last && !last.cancelled) {
      buildState = 'bad';
      buildSub = t('devmode.flowBuildFail');
    } else if (p.jar && !p.jar.missing) {
      buildState = 'good';
      buildSub = t('devmode.flowJarReady');
    }
    const watching = p.build.auto || p.build.watchJar ? { icon: 'eye', title: t('devmode.flowWatching') } : null;
    // Servidor
    const srv = p.server.info;
    let srvState = '';
    let srvSub = t('devmode.flowNoServer');
    if (srv) {
      if (st.deploying) {
        srvState = 'work';
        srvSub = t(`devmode.phase_${st.phase || 'copying'}`);
      } else if (ctx.serverState === 'online') {
        srvState = 'good';
        srvSub = t('devmode.flowOnline', { port: srv.port });
      } else if (ctx.serverState === 'starting' || ctx.serverState === 'stopping') {
        srvState = 'work';
        srvSub = t(`devmode.state_${ctx.serverState}`);
      } else srvSub = t('devmode.state_offline');
    } else if (p.server.missing) {
      srvState = 'bad';
      srvSub = t('devmode.flowServerMissing');
    }
    // Cliente
    const inst = (store.instances || []).find((i) => i.id === p.client.instanceId);
    const run = inst ? store.running[inst.id] : null;
    let cliState = '';
    let cliSub = t('devmode.flowNoInstance');
    if (run) {
      cliState = run.state === 'running' ? 'good' : 'work';
      cliSub = run.state === 'running' ? t('devmode.clientRunning') : t('devmode.clientPreparing');
    } else if (inst) cliSub = inst.name;

    // Accion principal
    let action;
    if (!srv) {
      action = h('button', { class: 'btn primary', type: 'button', onclick: () => openCreateServer(ctx) }, icon('server'), t('devmode.createServer'));
    } else if (ctx.serverState === 'offline') {
      action = h('button', { class: 'btn primary', type: 'button', disabled: st.building || st.deploying }, icon('play'), t('devmode.startTesting'));
      action.addEventListener('click', () => startSession(action));
    } else {
      const canBuild = Boolean(d.exists && d.tool && d.runner);
      action = h('button', { class: 'btn primary', type: 'button', disabled: st.building || st.deploying || !canBuild, title: canBuild ? t('devmode.buildReloadHint', { mode: t(`devmode.reload_${p.server.reload}`) }) : t('devmode.cantBuild') }, icon('dmCycle'), t('devmode.buildReload'));
      action.addEventListener('click', async () => {
        const done = setBusy(action);
        try {
          await api.invoke('devmode:build', ctx.id, { deploy: 'force' });
        } catch (err) {
          fail(t('devmode.errBuild'), err);
        } finally {
          done();
          ctx.refresh();
        }
      });
    }

    mount(
      flowEl,
      step('folder', t('devmode.flowProject'), projSub, projState),
      step('hammer', t('devmode.flowBuild'), buildSub, buildState, watching),
      step('server', t('devmode.flowServer'), srvSub, srvState),
      step('gamepad', t('devmode.flowClient'), cliSub, cliState),
      h('div', { class: 'dm-flow-action' }, action),
    );
  }

  // ---------- Proyecto ----------
  async function renderProject() {
    destroyCards();
    mount(root, skeletonView(head(true)));
    try {
      ctx.p = await api.invoke('devmode:project', ctx.id);
    } catch (err) {
      mount(root, h('div', { class: 'dm-root' }, head(true), errorCard(t('devmode.errLoadProject'), err, () => renderProject())));
      return;
    }
    ctx.status = ctx.p.status;
    ctx.serverState = ctx.p.server.info?.state || 'offline';
    ctx.players = ctx.p.server.info?.players || [];
    cards = [projectCard(ctx), buildCard(ctx), serverCard(ctx), clientCard(ctx), eventsCard(ctx), settingsCard(ctx)];
    const [proj, build, server, client, events, settings] = cards.map((c) => c.el);
    // Columna principal: el ciclo de trabajo (proyecto, build, servidor y lo que paso). Al costado: cliente y ajustes.
    mount(
      root,
      h(
        'div',
        { class: 'dm-root' },
        head(true),
        flowEl,
        h('div', { class: 'dm-grid' }, h('div', { class: 'dm-col dm-col-main' }, proj, build, server, events), h('div', { class: 'dm-col dm-col-side' }, client, settings)),
      ),
    );
    drawFlow();
    for (const evt of ['project', 'status', 'server', 'running', 'instances', 'tick']) ctx.on(evt, drawFlow);
  }

  async function load() {
    let state;
    try {
      state = await tryInvoke('devmode:state', [], null);
    } catch (err) {
      destroyCards();
      mount(root, h('div', { class: 'dm-root' }, head(false), errorCard(t('devmode.errLoad'), err, () => load())));
      return;
    }
    if (!state) {
      destroyCards();
      mount(root, h('div', { class: 'dm-root' }, head(false), h('div', { class: 'card dm-error' }, emptyState('code', t('devmode.unavailable'), t('devmode.unavailableText'), h('button', { class: 'btn', type: 'button', onclick: () => load() }, icon('refresh'), t('common.retry'))))));
      return;
    }
    ctx.projects = state.projects || [];
    if (!ctx.projects.length) {
      ctx.id = null;
      ctx.p = null;
      renderEmpty();
      return;
    }
    if (!ctx.projects.some((x) => x.id === ctx.id)) ctx.id = state.selected || ctx.projects[0].id;
    await renderProject();
  }

  // ---------- Eventos ----------
  function subscribe() {
    const mine = (id) => ctx.id && id === ctx.id;
    offs.push(
      api.on('devmode:changed', (id) => {
        if (!id) {
          tryInvoke('devmode:state', [], null)
            .then((s) => {
              const ids = (s?.projects || []).map((x) => x.id).join();
              if (ids !== ctx.projects.map((x) => x.id).join()) load();
            })
            .catch(() => {});
          return;
        }
        if (mine(id)) refreshSoon();
      }),
      api.on('devmode:status', (id, st) => {
        if (!mine(id)) return;
        ctx.status = st;
        ctx.emit('status');
      }),
      api.on('devmode:buildLog', (id, lines) => mine(id) && ctx.emit('buildLog', lines)),
      api.on('devmode:event', (id, entry) => mine(id) && ctx.emit('event', entry)),
      api.on('server:state', (sid, st) => {
        if (!ctx.p?.server?.id || sid !== ctx.p.server.id) return;
        const changed = st?.state !== ctx.serverState;
        ctx.serverState = st?.state || 'offline';
        ctx.players = st?.players || [];
        if (ctx.p.server.info) ctx.p.server.info.state = ctx.serverState;
        ctx.emit('server');
        if (changed && (ctx.serverState === 'offline' || ctx.serverState === 'online')) refreshSoon();
      }),
      api.on('server:log', (sid, line) => {
        if (ctx.p?.server?.id && sid === ctx.p.server.id) ctx.emit('serverLog', line);
      }),
      api.on('servers:changed', () => ctx.p?.server?.id && refreshSoon()),
      store.on('running', () => ctx.emit('running')),
      store.on('instances', () => ctx.emit('instances')),
      store.on('accounts', () => ctx.emit('accounts')),
      store.on('task', (task) => {
        if (!ctx.p) return;
        const sid = ctx.p.server?.id;
        if ((sid && task.meta?.serverId === sid) || task.meta?.devmode === ctx.id) {
          ctx.emit('task', task);
          if (task.state !== 'running') refreshSoon();
        }
      }),
    );
    // Reloj del build y "hace X min"
    let n = 0;
    ticker = setInterval(() => {
      n++;
      if (ctx.status?.building || n % 30 === 0) ctx.emit('tick');
    }, 1000);
  }

  return {
    async start() {
      mount(root, skeletonView(head(false)));
      subscribe();
      await load();
    },
    destroy() {
      clearInterval(ticker);
      offs.forEach((o) => {
        try {
          o();
        } catch {
          /* nada */
        }
      });
      destroyCards();
    },
  };
}

// Para la lista STARTUP de app.js: escucha el pedido de abrir el cliente desde que arranca el launcher
// (sin esto, se empieza a escuchar la primera vez que se abre la pagina).
export function startup() {
  bindAutoLaunch();
}

export default {
  ns: ['devmode'],
  css: ['pages/devmode'],
  async render(root) {
    bindAutoLaunch();
    const page = createPage(root);
    await page.start();
    return () => page.destroy();
  },
};
