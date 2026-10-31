// Tarjeta del build: estado, compilar/cancelar/desplegar, compilacion automatica y salida en vivo.
import { h, icon, mount, fmtAgo, copyText, fail, setBusy } from '../../ui.js';
import { api } from '../../store.js';
import { t } from '../../i18n.js';
import { fmtSecs, fmtClock, toggleRow, ADOPTIUM_URL } from './common.js';

const MAX_DOM_LINES = 2500;

export function buildCard(ctx) {
  const el = h('section', { class: 'card dm-card dm-build', 'aria-label': t('devmode.buildCard') });
  const headPill = h('span', { class: 'dm-head-pill' });
  const statusBox = h('div', { class: 'dm-build-status', role: 'status', 'aria-live': 'polite' });
  const errorsBox = h('div', { class: 'dm-errors-wrap' });
  const actions = h('div', { class: 'dm-actions' });
  const toggles = h('div', { class: 'dm-toggles' });
  const out = h('div', { class: 'console dm-console dm-build-out', role: 'log', 'aria-label': t('devmode.buildOutput'), tabindex: 0 });
  const countEl = h('span', { class: 'dm-out-count' });
  const copyBtn = h(
    'button',
    {
      class: 'icon-btn sm',
      type: 'button',
      title: t('devmode.copyOutput'),
      'aria-label': t('devmode.copyOutput'),
      onclick: (e) => {
        e.preventDefault();
        e.stopPropagation();
        copyText(lines.map((l) => l.text).join('\n'), t('devmode.outputCopied'));
      },
    },
    icon('copy'),
  );
  const details = h('details', { class: 'dm-output' }, h('summary', {}, icon('chevronRight', 'dm-sum-chev'), icon('terminal'), h('span', {}, t('devmode.buildOutput')), countEl, h('span', { class: 'spacer' }), copyBtn), out);
  let lines = [];
  let autoscroll = true;
  let lastBuilding = false;

  out.addEventListener('scroll', () => {
    autoscroll = out.scrollTop + out.clientHeight >= out.scrollHeight - 24;
  });

  const lineEl = (l) => h('div', { class: `dm-line l-${l.level || 'INFO'}` }, l.text);
  const drawOut = () => {
    if (!lines.length) {
      mount(out, h('div', { class: 'dm-console-empty' }, icon('terminal'), h('div', {}, t('devmode.noOutput'))));
    } else {
      const frag = document.createDocumentFragment();
      for (const l of lines.slice(-MAX_DOM_LINES)) frag.append(lineEl(l));
      mount(out, frag);
      if (autoscroll) out.scrollTop = out.scrollHeight;
    }
    countEl.textContent = lines.length ? t('devmode.linesCount', { count: lines.length }) : '';
  };

  const appendOut = (batch) => {
    if (!batch?.length) return;
    if (!lines.length) out.textContent = '';
    lines.push(...batch);
    if (lines.length > 4000) lines.splice(0, lines.length - 3000);
    for (const l of batch) out.append(lineEl(l));
    while (out.childNodes.length > MAX_DOM_LINES) out.firstChild.remove();
    countEl.textContent = t('devmode.linesCount', { count: lines.length });
    if (autoscroll) out.scrollTop = out.scrollHeight;
  };

  const doBuild = async (btn) => {
    const done = setBusy(btn);
    try {
      lines = [];
      drawOut();
      details.open = true;
      autoscroll = true;
      // Un build fallido resuelve { ok: false } (el panel de tareas ya avisa); solo se capturan errores de configuracion.
      await api.invoke('devmode:build', ctx.id, { deploy: 'force' });
    } catch (err) {
      fail(t('devmode.errBuild'), err);
    } finally {
      done();
      ctx.refresh();
    }
  };

  const drawStatus = () => {
    const p = ctx.p;
    const st = ctx.status || {};
    const last = p.last?.build;
    const tool = p.detect.tool === 'maven' ? 'Maven' : 'Gradle';
    let pill;
    if (st.building) {
      pill = h('span', { class: 'pill warn' }, h('span', { class: 'status-dot starting' }), t('devmode.pillBuilding'));
      mount(
        statusBox,
        h('div', { class: 'dm-big-icon work' }, h('div', { class: 'spinner' })),
        h(
          'div',
          { class: 'dm-status-text' },
          h('div', { class: 'dm-status-title' }, t('devmode.buildingWith', { tool, task: p.detect.task || '' })),
          h('div', { class: 'small muted' }, st.buildAuto ? t('devmode.buildingAuto') : t('devmode.buildingManual'), st.queued ? ` · ${t('devmode.buildQueued')}` : ''),
        ),
        h('div', { class: 'dm-clock mono', 'aria-label': t('devmode.elapsed') }, fmtClock(Date.now() - (st.buildStartedAt || Date.now()))),
      );
    } else if (last) {
      const okBuild = last.ok;
      pill = okBuild
        ? h('span', { class: 'pill good' }, icon('check'), t('devmode.pillOk'))
        : last.cancelled
          ? h('span', { class: 'pill' }, t('devmode.pillCancelled'))
          : h('span', { class: 'pill bad' }, icon('alert'), t('devmode.pillFailed'));
      const title = okBuild ? t('devmode.lastOk', { duration: fmtSecs(last.ms) }) : last.cancelled ? t('devmode.lastCancelled') : t('devmode.lastFailed', { duration: fmtSecs(last.ms) });
      mount(
        statusBox,
        h('div', { class: ['dm-big-icon', okBuild ? 'good' : last.cancelled ? '' : 'bad'] }, icon(okBuild ? 'check' : last.cancelled ? 'x' : 'alert')),
        h(
          'div',
          { class: 'dm-status-text' },
          h('div', { class: 'dm-status-title' }, title),
          h('div', { class: 'small muted' }, t('devmode.lastWhen', { ago: fmtAgo(last.at), task: last.task || '' }), last.auto ? ` · ${t('devmode.lastAuto')}` : ''),
        ),
      );
    } else {
      pill = h('span', { class: 'pill' }, t('devmode.pillNever'));
      mount(statusBox, h('div', { class: 'dm-big-icon' }, icon('hammer')), h('div', { class: 'dm-status-text' }, h('div', { class: 'dm-status-title' }, t('devmode.neverBuilt')), h('div', { class: 'small muted' }, t('devmode.neverBuiltHint'))));
    }
    mount(headPill, pill);

    // Resumen de errores del ultimo build fallido
    if (!st.building && last && !last.ok && !last.cancelled) {
      const hint = last.hint
        ? h(
            'div',
            { class: 'notice dm-hint' },
            icon('info'),
            h('div', { class: 'spacer' }, t(`devmode.hint_${last.hint}`)),
            last.hint === 'noJava' ? h('button', { class: 'btn sm', type: 'button', onclick: () => api.app.openExternal(ADOPTIUM_URL) }, icon('external'), t('devmode.getJdk')) : null,
          )
        : null;
      mount(
        errorsBox,
        last.summary?.length ? h('div', { class: 'dm-errors', role: 'list', 'aria-label': t('devmode.errorsTitle') }, last.summary.map((s) => h('div', { class: 'dm-err-line mono', role: 'listitem' }, s))) : null,
        hint,
      );
    } else mount(errorsBox);

    // Acciones
    const p2 = ctx.p;
    const canBuild = Boolean(p2.detect.exists && p2.detect.tool && p2.detect.runner);
    const hasServer = Boolean(p2.server.info);
    const hasJar = Boolean(p2.jar && !p2.jar.missing && p2.jar.plugin?.kind === 'plugin');
    if (st.building) {
      mount(
        actions,
        h(
          'button',
          {
            class: 'btn danger',
            type: 'button',
            onclick: (e) => {
              const done = setBusy(e.currentTarget);
              api.invoke('devmode:cancelBuild', ctx.id).catch((err) => {
                done();
                fail(t('devmode.errCancel'), err);
              });
            },
          },
          icon('x'),
          t('devmode.cancelBuild'),
        ),
      );
    } else {
      // La accion principal de la pagina esta en el ciclo de arriba: aca los botones son secundarios
      const buildBtn = h('button', { class: 'btn', type: 'button', disabled: !canBuild, title: canBuild ? (hasServer ? t('devmode.buildDeployHint') : t('devmode.buildHint')) : t('devmode.cantBuild') }, icon('hammer'), hasServer ? t('devmode.buildDeploy') : t('devmode.build'));
      buildBtn.addEventListener('click', () => doBuild(buildBtn));
      const deployBtn = hasServer
        ? h(
            'button',
            {
              class: 'btn ghost',
              type: 'button',
              disabled: !hasJar || st.deploying,
              title: hasJar ? t('devmode.deployNowHint') : t('devmode.noJarYet'),
              onclick: async (e) => {
                const done = setBusy(e.currentTarget);
                try {
                  await api.invoke('devmode:deploy', ctx.id);
                } catch (err) {
                  fail(t('devmode.errDeploy'), err);
                } finally {
                  done();
                }
              },
            },
            icon('upload'),
            t('devmode.deployNow'),
          )
        : null;
      mount(actions, buildBtn, deployBtn);
    }
    if (lastBuilding !== Boolean(st.building)) {
      if (st.building) details.open = true;
      lastBuilding = Boolean(st.building);
    }
  };

  const drawToggles = () => {
    const p = ctx.p;
    const canWatch = Boolean(p.detect.exists && p.detect.tool && p.detect.runner);
    mount(
      toggles,
      toggleRow(t('devmode.autoBuild'), canWatch ? t('devmode.autoBuildSub', { ms: p.build.debounceMs }) : t('devmode.autoBuildNoTool'), p.build.auto, (v) => ctx.update({ build: { auto: v } }), { disabled: !canWatch }),
      toggleRow(t('devmode.watchJar'), t('devmode.watchJarSub'), p.build.watchJar, (v) => ctx.update({ build: { watchJar: v } })),
    );
  };

  mount(
    el,
    h('div', { class: 'card-head' }, h('h2', { class: 'card-title' }, icon('hammer'), t('devmode.buildCard')), headPill),
    statusBox,
    errorsBox,
    actions,
    toggles,
    details,
  );

  const draw = () => {
    drawStatus();
    drawToggles();
  };
  draw();
  drawOut();
  api
    .invoke('devmode:buildLog', ctx.id)
    .then((r) => {
      lines = [...(r?.lines || []), ...lines];
      drawOut();
      const last = ctx.p.last?.build;
      if (lines.length && last && !last.ok && !last.cancelled) details.open = true;
    })
    .catch(() => {});

  const offs = [
    ctx.on('project', draw),
    ctx.on('status', drawStatus),
    ctx.on('tick', () => ctx.status?.building && drawStatus()),
    ctx.on('buildLog', appendOut),
  ];
  return { el, destroy: () => offs.forEach((o) => o()) };
}
