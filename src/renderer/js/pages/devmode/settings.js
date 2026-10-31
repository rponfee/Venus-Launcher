// Ajustes del proyecto: como se recarga el plugin (reinicio, /reload o PlugManX), opciones del build,
// JDK, depuracion remota para IntelliJ y online-mode del servidor de prueba.
import { h, icon, mount, fail, ok, copyText, setBusy } from '../../ui.js';
import { api } from '../../store.js';
import { t } from '../../i18n.js';
import { store } from '../../store.js';
import { toggleRow, iconBtn, failUnlessTask } from './common.js';

const MODES = ['restart', 'reload', 'plugman'];
// Grupos plegables que el usuario abrio o cerro (se recuerdan mientras la app esta abierta)
const foldState = new Map();

export function settingsCard(ctx) {
  const el = h('section', { class: 'card dm-card dm-settings', 'aria-label': t('devmode.settingsCard') });
  let jdks = null;
  let dirty = false;

  const loadJdks = async (force = false) => {
    try {
      jdks = await api.invoke('devmode:jdks', force);
    } catch {
      jdks = [];
    }
    draw();
  };

  const save = async (patch, okMsg) => {
    try {
      await ctx.update(patch);
      if (okMsg) ok(okMsg);
    } catch {
      /* ctx.update ya avisa */
    }
  };

  // Grupo de ajustes: el rotulo es un encabezado de nivel 3 (debajo del titulo de la tarjeta)
  const section = (title, ...children) => h('div', { class: 'dm-sec' }, h('h3', { class: 'dm-sec-title' }, title), ...children);
  // Grupo avanzado plegable (revelado progresivo): la tarjeta no se vuelve eterna en la columna angosta.
  // Abierto por defecto solo si tiene algo activo; despues manda lo que eligio el usuario.
  const foldSection = (key, title, defaultOpen, ...children) => {
    const open = foldState.has(key) ? foldState.get(key) : defaultOpen;
    const summary = h('summary', { class: 'dm-sec-sum' }, h('h3', { class: 'dm-sec-title' }, title), icon('chevronDown', 'dm-sec-chev'));
    const d = h('details', { class: 'dm-sec dm-sec-fold', open, dataset: { fold: key } }, summary, h('div', { class: 'dm-sec-body' }, ...children));
    // La entrada animada es solo cuando el usuario lo abre (no en cada redibujo por cambios del proyecto)
    let byUser = false;
    summary.addEventListener('click', () => {
      byUser = true;
    });
    d.addEventListener('toggle', () => {
      foldState.set(key, d.open);
      d.classList.toggle('dm-opening', byUser && d.open);
      byUser = false;
    });
    return d;
  };

  const installPlugman = async (btn) => {
    const done = setBusy(btn);
    try {
      const r = await api.invoke('devmode:installPlugman', ctx.id);
      ok(t('devmode.plugmanInstalled', { version: r.version }), r.restartNeeded ? t('devmode.plugmanRestart') : null);
      ctx.refresh();
    } catch (err) {
      failUnlessTask(store, t('devmode.errPlugman'), err);
    } finally {
      done();
    }
  };

  function reloadOption(mode, p) {
    const checked = p.server.reload === mode;
    const input = h('input', { type: 'radio', name: `dm-reload-${p.id}`, value: mode, checked });
    input.addEventListener('change', () => input.checked && save({ server: { reload: mode } }));
    const extra = [];
    if (mode === 'restart') extra.push(h('span', { class: 'badge good' }, t('devmode.recommended')));
    if (mode === 'reload') extra.push(h('span', { class: 'badge warn' }, t('devmode.discouraged')));
    let foot = null;
    if (mode === 'plugman') {
      if (p.plugin?.paper) foot = h('div', { class: 'dm-radio-foot warn' }, icon('alert'), t('devmode.plugmanPaperPlugin'));
      else if (!p.server.info) foot = h('div', { class: 'dm-radio-foot' }, icon('info'), t('devmode.plugmanNeedsServer'));
      else if (p.plugman?.installed) foot = h('div', { class: 'dm-radio-foot good' }, icon('check'), t('devmode.plugmanReady', { version: p.plugman.version || '' }));
      else {
        const btn = h('button', { class: 'btn sm', type: 'button' }, icon('download'), t('devmode.installPlugman'));
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          installPlugman(btn);
        });
        foot = h('div', { class: 'dm-radio-foot' }, h('span', { class: 'spacer' }, t('devmode.plugmanMissing')), btn);
      }
    }
    return h(
      'label',
      { class: ['dm-radio', checked && 'active'] },
      input,
      h('div', { class: 'dm-radio-body' }, h('div', { class: 'dm-radio-title' }, t(`devmode.reload_${mode}`), ...extra), h('div', { class: 'dm-radio-desc' }, t(`devmode.reloadDesc_${mode}`)), foot),
    );
  }

  function draw() {
    const active = document.activeElement;
    if (active && el.contains(active) && /^(INPUT|SELECT|TEXTAREA)$/.test(active.tagName) && active.type !== 'radio' && active.type !== 'checkbox') {
      dirty = true;
      return;
    }
    dirty = false;
    // Al redibujar, cada grupo plegable queda como lo estaba viendo el usuario
    for (const sec of el.querySelectorAll('details.dm-sec-fold')) foldState.set(sec.dataset.fold, sec.open);
    const p = ctx.p;
    const d = p.detect;

    // Build
    const fields = [];
    if (d.tools.length > 1) {
      const toolSel = h(
        'select',
        { class: 'select', id: 'dm-set-tool' },
        h('option', { value: '', selected: !p.build.tool }, t('devmode.toolAuto', { tool: d.tools[0] === 'maven' ? 'Maven' : 'Gradle' })),
        d.tools.map((x) => h('option', { value: x, selected: p.build.tool === x }, x === 'maven' ? 'Maven' : 'Gradle')),
      );
      toolSel.addEventListener('change', () => save({ build: { tool: toolSel.value || null } }));
      fields.push(h('div', { class: 'field' }, h('label', { for: 'dm-set-tool' }, t('devmode.tool')), toolSel));
    }
    const listId = `dm-tasks-${p.id}`;
    const taskInput = h('input', { class: 'input mono', id: 'dm-set-task', list: listId, value: p.build.task || '', placeholder: d.task || (d.tool === 'maven' ? 'package' : 'build'), spellcheck: 'false', autocomplete: 'off' });
    taskInput.addEventListener('change', () => save({ build: { task: taskInput.value.trim() || null } }));
    fields.push(
      h(
        'div',
        { class: 'field' },
        h('label', { for: 'dm-set-task' }, d.tool === 'maven' ? t('devmode.goal') : t('devmode.task')),
        taskInput,
        h('datalist', { id: listId }, (d.tasks || []).map((x) => h('option', { value: x }))),
        h('div', { class: 'hint' }, t('devmode.taskHint', { task: d.task || '-' })),
      ),
    );
    const argsInput = h('input', { class: 'input mono', id: 'dm-set-args', value: p.build.args || '', placeholder: d.tool === 'maven' ? '-Pdev -o' : '--offline -Pdev=true', spellcheck: 'false', autocomplete: 'off' });
    argsInput.addEventListener('change', () => save({ build: { args: argsInput.value.trim() } }));
    fields.push(h('div', { class: 'field' }, h('label', { for: 'dm-set-args' }, t('devmode.args')), argsInput));
    const debounce = h('input', { class: 'input', id: 'dm-set-debounce', type: 'number', min: 300, max: 10000, step: 100, value: String(p.build.debounceMs) });
    debounce.addEventListener('change', () => save({ build: { debounceMs: Number(debounce.value) } }));
    fields.push(h('div', { class: 'field' }, h('label', { for: 'dm-set-debounce' }, t('devmode.debounce')), debounce, h('div', { class: 'hint' }, t('devmode.debounceHint'))));

    const jdkSel = h('select', { class: 'select', id: 'dm-set-jdk' });
    const autoLabel = p.jdk?.auto && p.jdk.major ? t('devmode.jdkAutoOption', { major: p.jdk.major }) : t('devmode.jdkAutoNone');
    mount(
      jdkSel,
      h('option', { value: '', selected: !p.build.jdk }, autoLabel),
      (jdks || []).map((j) => h('option', { value: j.home, selected: p.build.jdk && p.build.jdk.toLowerCase() === j.home.toLowerCase() }, `Java ${j.major || '?'} · ${j.vendor || 'JDK'} · ${j.home}`)),
    );
    if (p.build.jdk && !(jdks || []).some((j) => j.home.toLowerCase() === p.build.jdk.toLowerCase())) jdkSel.append(h('option', { value: p.build.jdk, selected: true }, p.build.jdk));
    jdkSel.addEventListener('change', () => save({ build: { jdk: jdkSel.value } }));
    fields.push(
      h(
        'div',
        { class: 'field' },
        h('label', { for: 'dm-set-jdk' }, 'JDK'),
        h('div', { class: 'dm-inline' }, jdkSel, iconBtn('refresh', t('devmode.rescanJdks'), () => loadJdks(true))),
        h('div', { class: 'hint' }, d.java?.major ? t(d.java.toolchain ? 'devmode.jdkHintToolchain' : 'devmode.jdkHintRelease', { major: d.java.major }) : t('devmode.jdkHint')),
      ),
    );

    // Depuracion
    const portInput = h('input', { class: 'input', id: 'dm-set-dport', type: 'number', min: 1024, max: 65535, value: String(p.server.debugPort), disabled: !p.server.debug });
    portInput.addEventListener('change', () => save({ server: { debugPort: Number(portInput.value) } }));
    const flag = `-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=${p.server.debugAnyHost ? '*' : '127.0.0.1'}:${p.server.debugPort}`;

    // Servidor
    const srv = p.server.info;
    const serverSec = srv
      ? foldSection(
          'server',
          t('devmode.secServer'),
          false,
          toggleRow(t('devmode.onlineMode'), srv.onlineMode ? t('devmode.onlineOnHint') : t('devmode.onlineOffHint'), srv.onlineMode !== false, async (v) => {
            try {
              const r = await api.invoke('devmode:setOnlineMode', p.id, v);
              ok(v ? t('devmode.onlineOnDone') : t('devmode.onlineOffDone'), r.restartNeeded ? t('devmode.restartToApply') : null);
              ctx.refresh();
            } catch (err) {
              fail(t('devmode.errOnline'), err);
            }
          }),
          h(
            'div',
            { class: 'row wrap dm-sec-actions' },
            h(
              'button',
              {
                class: 'btn sm ghost',
                type: 'button',
                onclick: async () => {
                  try {
                    await api.invoke('devmode:unlinkServer', p.id);
                    ctx.refresh();
                  } catch (err) {
                    fail(t('devmode.errLink'), err);
                  }
                },
              },
              icon('x'),
              t('devmode.unlinkServer'),
            ),
          ),
        )
      : null;

    mount(
      el,
      h('div', { class: 'card-head' }, h('h2', { class: 'card-title' }, icon('sliders'), t('devmode.settingsCard'))),
      section(
        t('devmode.secReload'),
        h('div', { class: 'dm-radios', role: 'radiogroup', 'aria-label': t('devmode.secReload') }, MODES.map((m) => reloadOption(m, p))),
        toggleRow(t('devmode.autoDeploy'), t('devmode.autoDeploySub'), p.build.autoDeploy, (v) => save({ build: { autoDeploy: v } })),
      ),
      foldSection(
        'build',
        t('devmode.secBuild'),
        false,
        h('div', { class: 'dm-fields' }, fields),
        toggleRow(t('devmode.skipTests'), d.tool === 'maven' ? t('devmode.skipTestsMaven') : t('devmode.skipTestsGradle'), p.build.skipTests, (v) => save({ build: { skipTests: v } })),
      ),
      foldSection(
        'debug',
        t('devmode.secDebug'),
        Boolean(p.server.debug),
        toggleRow(t('devmode.debug'), t('devmode.debugSub'), p.server.debug, (v) => save({ server: { debug: v } })),
        h('div', { class: 'dm-fields' }, h('div', { class: 'field' }, h('label', { for: 'dm-set-dport' }, t('devmode.debugPort')), portInput)),
        toggleRow(t('devmode.debugAnyHost'), t('devmode.debugAnyHostSub'), p.server.debugAnyHost, (v) => save({ server: { debugAnyHost: v } }), { disabled: !p.server.debug }),
        p.server.debug && p.server.debugAnyHost ? h('div', { class: 'notice' }, icon('shieldAlert'), h('div', {}, t('devmode.debugAnyHostWarn'))) : null,
        h(
          'div',
          { class: 'dm-ide' },
          h('div', { class: 'dm-ide-title' }, icon('bug'), t('devmode.ideTitle')),
          h('ol', { class: 'steps' }, h('li', {}, t('devmode.ideStep1')), h('li', {}, t('devmode.ideStep2', { port: p.server.debugPort })), h('li', {}, t('devmode.ideStep3'))),
          h('div', { class: 'dm-flag' }, h('code', { class: 'mono selectable' }, flag), iconBtn('copy', t('devmode.copyFlag'), () => copyText(flag, t('devmode.flagCopied')))),
        ),
      ),
      serverSec,
    );
  }

  el.addEventListener('focusout', () => {
    setTimeout(() => {
      if (dirty && !el.contains(document.activeElement)) draw();
    }, 0);
  });

  draw();
  loadJdks(false);
  const offs = [ctx.on('project', draw)];
  return { el, destroy: () => offs.forEach((o) => o()) };
}
