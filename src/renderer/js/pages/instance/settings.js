// Ajustes de la instancia: nombre, memoria (panel del modulo de rendimiento + "Optimizar" y
// "Packs de contenido"), Java (ejecutable, recolector de basura, argumentos), ventana del juego y mantenimiento.
import { h, icon, mount, ok, fail, fmtMb, debounce, switchEl, selectEl, skeleton } from '../../ui.js';
import { store, api } from '../../store.js';
import { t } from '../../i18n.js';
import { navigate } from '../../app.js';
import { feature, runFeature, repairInstance, duplicateInstance, deleteInstance } from '../versions/common.js';

// Sliders propios: solo si el panel del modulo de rendimiento no se puede cargar.
function fallbackMemory(ctx, save) {
  const box = h('div', { class: 'stack' });
  const draw = async () => {
    const inst = ctx.inst;
    const sys = await api.system.info().catch(() => ({ totalMem: 8 * 1024 ** 3 }));
    const maxMb = Math.max(1024, Math.floor(sys.totalMem / 1048576 / 512) * 512);
    const mem = inst.memory || { override: false, min: 1024, max: 4096 };
    const maxLabel = h('span', { class: 'kbd num' }, fmtMb(mem.max));
    const minLabel = h('span', { class: 'kbd num' }, fmtMb(mem.min));
    const maxRange = h('input', { type: 'range', class: 'range', min: 512, max: maxMb, step: 256, value: mem.max, disabled: !mem.override, 'aria-label': t('instance.memMax') });
    const minRange = h('input', { type: 'range', class: 'range', min: 256, max: maxMb, step: 256, value: mem.min, disabled: !mem.override, 'aria-label': t('instance.memMin') });
    const sync = (changed) => {
      if (+minRange.value > +maxRange.value) {
        if (changed === maxRange) minRange.value = maxRange.value;
        else maxRange.value = minRange.value;
      }
      maxLabel.textContent = fmtMb(+maxRange.value);
      minLabel.textContent = fmtMb(+minRange.value);
      maxRange.setAttribute('aria-valuetext', fmtMb(+maxRange.value));
      minRange.setAttribute('aria-valuetext', fmtMb(+minRange.value));
      save({ memory: { max: +maxRange.value, min: +minRange.value } });
    };
    maxRange.addEventListener('input', () => sync(maxRange));
    minRange.addEventListener('input', () => sync(minRange));
    mount(
      box,
      h(
        'div',
        { class: 'toggle-row' },
        h('div', { class: 'tr-text' }, h('div', { class: 'tr-title' }, t('instance.memCustom')), h('div', { class: 'tr-sub' }, mem.override ? t('instance.memCustomOn') : t('instance.memCustomOff', { size: fmtMb(store.settings?.memory?.max || 4096) }))),
        switchEl(
          mem.override,
          async (v) => {
            try {
              ctx.setInstance(await api.instances.update(inst.id, { memory: { override: v } }));
            } catch (err) {
              fail(t('instance.saveFailed'), err);
            }
            draw();
          },
          t('instance.memCustom'),
        ),
      ),
      h(
        'div',
        { class: ['stack', !mem.override && 'ih-dim'] },
        h('div', { class: 'row' }, h('span', { class: 'label spacer' }, t('instance.memMax')), maxLabel),
        maxRange,
        h('div', { class: 'row' }, h('span', { class: 'label spacer' }, t('instance.memMin')), minLabel),
        minRange,
      ),
    );
  };
  draw();
  return box;
}

function cardHead(ic, title, sub, extra, cls = '') {
  return h('div', { class: ['card-head', cls] }, h('div', {}, h('h2', { class: 'card-title' }, icon(ic), title), sub ? h('p', { class: 'card-sub' }, sub) : null), extra || null);
}

export function settingsTab(container, ctx) {
  let alive = true;
  const inst0 = ctx.inst;
  const pending = {};

  // Estado del guardado automatico (se anuncia sin mover el foco)
  const saveState = h('div', { class: 'ih-savestate', role: 'status' });
  let saveTimer = 0;
  const showSave = (kind) => {
    clearTimeout(saveTimer);
    saveState.className = `ih-savestate ${kind || ''}`;
    if (kind === 'saved') mount(saveState, icon('check'), t('instance.saved'));
    else if (kind === 'error') mount(saveState, icon('alert'), t('instance.saveFailed'));
    else mount(saveState, icon('info'), t('instance.autoSaveHint'));
    if (kind === 'saved') saveTimer = setTimeout(() => alive && showSave(null), 2500);
  };
  showSave(null);

  const flush = debounce(async () => {
    const patch = { ...pending };
    for (const k of Object.keys(pending)) delete pending[k];
    try {
      const next = await api.instances.update(ctx.id, patch);
      if (alive) {
        ctx.setInstance(next);
        showSave('saved');
      }
      store.refreshInstances();
    } catch (err) {
      if (alive) showSave('error');
      fail(t('instance.saveFailed'), err);
    }
  }, 350);
  // Junta los cambios (incluso de objetos anidados) y los guarda juntos.
  const save = (patch) => {
    for (const [k, v] of Object.entries(patch)) {
      pending[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...(pending[k] || {}), ...v } : v;
    }
    flush();
  };

  // General
  const nameInput = h('input', { class: 'input', id: 'ih-name', value: inst0.name, maxlength: 60, autocomplete: 'off', 'aria-describedby': 'ih-name-help' });
  nameInput.addEventListener('input', () => nameInput.value.trim() && save({ name: nameInput.value.trim() }));
  nameInput.addEventListener('blur', () => {
    if (!nameInput.value.trim()) nameInput.value = ctx.inst.name;
  });

  // Memoria (modulo de rendimiento)
  const memBox = h('div', { class: 'ih-mem' }, skeleton(2, { label: t('common.loading') }));
  feature('perf')
    .then((mod) => {
      if (!alive) return;
      const el = typeof mod.instanceMemoryPanel === 'function' ? mod.instanceMemoryPanel(ctx.inst) : null;
      if (!(el instanceof Node)) throw new Error('instanceMemoryPanel');
      mount(memBox, el);
    })
    .catch((err) => {
      console.warn('[versions] panel de memoria', err);
      if (alive) mount(memBox, fallbackMemory(ctx, save));
    });

  // Java
  const javaInput = h('input', { class: 'input', id: 'ih-java', value: inst0.java?.path || '', placeholder: t('instance.javaAutoPlaceholder'), readonly: true, 'aria-describedby': 'ih-java-help' });
  const chooseJava = async () => {
    const files = await api.app.selectFiles({ title: t('instance.javaPick'), filters: [{ name: 'Java', extensions: ['exe', ''] }] });
    if (!files.length) return;
    const info = await api.java.test(files[0]).catch(() => null);
    if (!info) return fail(t('instance.javaInvalid'));
    javaInput.value = files[0];
    javaInput.title = files[0];
    save({ java: { path: files[0] } });
    ok(t('instance.javaSet'), t('instance.javaVersion', { version: info.version }));
    return undefined;
  };
  if (inst0.java?.path) javaInput.title = inst0.java.path;
  const presetSel = selectEl(
    [
      { value: '', label: t('instance.gcGlobal') },
      { value: 'auto', label: t('instance.gcAuto') },
      { value: 'aikar', label: t('instance.gcAikar') },
      { value: 'zgc', label: t('instance.gcZgc') },
      { value: 'g1', label: t('instance.gcG1') },
      { value: 'none', label: t('instance.gcNone') },
    ],
    inst0.java?.preset || '',
    (v) => save({ java: { preset: v || null } }),
  );
  presetSel.id = 'ih-gc';
  const argsInput = h('input', { class: 'input mono', id: 'ih-args', value: inst0.java?.args || '', placeholder: '-Dejemplo=true', spellcheck: 'false', autocomplete: 'off', 'aria-describedby': 'ih-args-help' });
  argsInput.addEventListener('input', () => save({ java: { args: argsInput.value } }));

  // Ventana
  const win = inst0.window || {};
  const wInput = h('input', { class: 'input num', id: 'ih-w', type: 'number', min: 320, max: 7680, value: win.width || '', placeholder: '854', 'aria-describedby': 'ih-win-help' });
  const hInput = h('input', { class: 'input num', id: 'ih-h', type: 'number', min: 240, max: 4320, value: win.height || '', placeholder: '480', 'aria-describedby': 'ih-win-help' });
  const saveWin = () => save({ window: { override: true, width: Math.max(0, +wInput.value || 0), height: Math.max(0, +hInput.value || 0) } });
  wInput.addEventListener('input', saveWin);
  hInput.addEventListener('input', saveWin);

  mount(
    container,
    h(
      'div',
      { class: 'ih-settings-wrap' },
      saveState,
      h(
        'div',
        { class: 'grid ih-settings' },
        h(
          'div',
          { class: 'stack' },
          h(
            'section',
            { class: 'card' },
            cardHead('edit', t('instance.general')),
            h(
              'div',
              { class: 'field' },
              h('label', { for: 'ih-name' }, t('instance.nameLabel')),
              nameInput,
              h('div', { class: 'field-help', id: 'ih-name-help' }, inst0.versionId ? t('instance.installedVersionIs', { version: inst0.versionId }) : t('instance.installedOnFirstPlay')),
            ),
          ),
          h(
            'section',
            { class: 'card' },
            cardHead(
              'memory',
              t('instance.memory'),
              null,
              h(
                'div',
                { class: 'ih-actions-row' },
                h('button', { class: 'btn sm ghost', type: 'button', title: t('instance.contentPacksHint'), onclick: () => runFeature('perf', 'openPacks', ctx.id) }, icon('layers'), t('instance.contentPacks')),
                h('button', { class: 'btn sm', type: 'button', onclick: () => runFeature('perf', 'openOptimize', ctx.id) }, icon('gauge'), t('instance.optimize')),
              ),
              'ih-memhead',
            ),
            memBox,
          ),
          h(
            'section',
            { class: 'card' },
            cardHead('monitor', t('instance.window')),
            h('div', { class: 'form-grid' }, h('div', { class: 'field' }, h('label', { for: 'ih-w' }, t('instance.width')), wInput), h('div', { class: 'field' }, h('label', { for: 'ih-h' }, t('instance.height')), hInput)),
            h('div', { class: 'field-help ih-gap', id: 'ih-win-help' }, t('instance.windowHint')),
            h('div', { class: 'toggle-row' }, h('div', { class: 'tr-text' }, h('div', { class: 'tr-title' }, t('instance.fullscreen'))), switchEl(Boolean(win.fullscreen), (v) => save({ window: { override: true, fullscreen: v } }), t('instance.fullscreen'))),
          ),
        ),
        h(
          'div',
          { class: 'stack' },
          h(
            'section',
            { class: 'card' },
            cardHead('coffee', 'Java'),
            h(
              'div',
              { class: 'stack' },
              h(
                'div',
                { class: 'field' },
                h('label', { for: 'ih-java' }, t('instance.javaExecutable')),
                h(
                  'div',
                  { class: 'row' },
                  javaInput,
                  h('button', { class: 'btn', type: 'button', onclick: chooseJava }, t('instance.choose')),
                  h(
                    'button',
                    {
                      class: 'btn ghost',
                      type: 'button',
                      title: t('instance.javaResetAuto'),
                      onclick: () => {
                        javaInput.value = '';
                        javaInput.removeAttribute('title');
                        save({ java: { path: '' } });
                      },
                    },
                    t('instance.auto'),
                  ),
                ),
                h('div', { class: 'field-help', id: 'ih-java-help' }, t('instance.javaHint')),
              ),
              h('div', { class: 'field' }, h('label', { for: 'ih-gc' }, t('instance.gcLabel')), presetSel),
              h('div', { class: 'field' }, h('label', { for: 'ih-args' }, t('instance.jvmArgs')), argsInput, h('div', { class: 'field-help', id: 'ih-args-help' }, t('instance.jvmArgsHint'))),
            ),
          ),
          h(
            'section',
            { class: 'card' },
            cardHead('shield', t('instance.maintenance'), t('instance.maintenanceText')),
            h(
              'div',
              { class: 'row wrap ih-maint-actions' },
              h('button', { class: 'btn', type: 'button', onclick: () => repairInstance(ctx.inst) }, icon('wrench'), t('instance.repair')),
              h(
                'button',
                {
                  class: 'btn',
                  type: 'button',
                  onclick: async () => {
                    const copy = await duplicateInstance(ctx.inst);
                    if (copy) navigate(`instance/${encodeURIComponent(copy.id)}`);
                  },
                },
                icon('copy'),
                t('instance.duplicate'),
              ),
            ),
            h(
              'div',
              { class: 'ih-danger' },
              h('div', { class: 'ih-danger-text' }, h('div', { class: 'ih-danger-title' }, t('instance.deleteTitle')), h('div', { class: 'ih-danger-sub' }, t('instance.deleteHint'))),
              h(
                'button',
                {
                  class: 'btn danger',
                  type: 'button',
                  onclick: async () => {
                    if (await deleteInstance(ctx.inst)) navigate('versions');
                  },
                },
                icon('trash'),
                t('instance.delete'),
              ),
            ),
          ),
        ),
      ),
    ),
  );

  return () => {
    alive = false;
    clearTimeout(saveTimer);
  };
}
