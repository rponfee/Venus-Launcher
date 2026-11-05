// Tarjeta de Ajustes para la integracion con OBS (Ajustes > En el juego). Apagada por defecto. La contraseña va directo al
// proceso principal, que la guarda cifrada y nunca la devuelve. Canales: obs:status, obs:test, obs:setPassword.
import { h, icon, mount, ok, fail, switchEl, selectEl, setBusy, loading } from '../../ui.js';
import { store, api } from '../../store.js';
import { t } from '../../i18n.js';
import './icons.js';

const C = (key, vars) => t(`clipstudio.${key}`, vars);
const STATE_CLASS = { connected: 'good', connecting: '', waiting: 'warn', authFailed: 'bad', off: '' };

const obsSettings = () => {
  const o = store.settings?.obs || {};
  return { enabled: o.enabled === true, host: o.host || '127.0.0.1', port: o.port || 4455, sceneOnOpen: o.sceneOnOpen || '', sceneOnClose: o.sceneOnClose || '' };
};

export function obsPanel() {
  const root = h('section', { class: 'card cs-obs', dataset: { anchor: 'obs' } }, loading());
  let st = null;
  let tested = null; // resultado de Probar conexion: { ok, version, scenes } o { error }
  let disposed = false;
  let seen = false;
  const off = api.on('obs:state', (s) => {
    st = s;
    if (!disposed) draw();
  });
  const watch = setInterval(() => {
    if (root.isConnected) seen = true;
    else if (seen) dispose();
  }, 2000);
  function dispose() {
    if (disposed) return;
    disposed = true;
    clearInterval(watch);
    off();
  }
  root.destroy = dispose;

  const save = async (patch) => {
    try {
      await store.setSettings({ obs: patch });
    } catch (err) {
      fail(C('saveFailed'), err);
    }
    draw();
  };

  function statusPill() {
    const state = st?.state || 'off';
    let text = C(`obsState_${state}`);
    if (state === 'connected' && (st.streaming || st.recording)) text = st.streaming ? C('obsStreaming') : C('obsRecording');
    if (state === 'authFailed' && st.error === 'authRequired') text = C('errObsNeedPassword');
    return h('span', { class: ['pill', STATE_CLASS[state]] }, h('span', { class: 'cap-dot', 'aria-hidden': 'true' }), text);
  }

  function sceneSelect(key, label) {
    const c = obsSettings();
    const scenes = st?.scenes?.length ? st.scenes : tested?.scenes || [];
    const value = c[key];
    const options = [{ value: '', label: C('obsNoScene') }, ...scenes.map((s) => ({ value: s, label: s }))];
    if (value && !scenes.includes(value)) options.push({ value, label: C('obsSceneMissing', { name: value }) });
    const sel = selectEl(options, value, (v) => save({ [key]: v }));
    sel.setAttribute('aria-label', label);
    return h('div', { class: 'cs-field' }, h('label', { class: 'cs-label' }, label), sel);
  }

  function draw() {
    if (disposed) return;
    const c = obsSettings();
    const hostIn = h('input', { class: 'input', type: 'text', value: c.host, maxlength: 120, 'aria-label': C('obsHost'), spellcheck: 'false' });
    const portIn = h('input', { class: 'input', type: 'number', min: 1, max: 65535, value: String(c.port), 'aria-label': C('obsPort') });
    const passIn = h('input', { class: 'input', type: 'password', autocomplete: 'off', placeholder: st?.hasPassword ? C('obsPasswordSaved') : C('obsPasswordEmpty'), maxlength: 256, 'aria-label': C('obsPassword') });
    hostIn.addEventListener('change', () => save({ host: hostIn.value.trim() }));
    portIn.addEventListener('change', () => save({ port: Number(portIn.value) }));
    passIn.addEventListener('change', async () => {
      try {
        st = await api.invoke('obs:setPassword', passIn.value);
        ok(passIn.value ? C('obsPasswordStored') : C('obsPasswordRemoved'));
      } catch (err) {
        fail(C('saveFailed'), err);
      }
      draw();
    });
    const testBtn = h('button', { class: 'btn sm', type: 'button' }, icon('plug'), C('obsTest'));
    testBtn.addEventListener('click', async () => {
      const done = setBusy(testBtn);
      try {
        tested = await api.invoke('obs:test', { host: hostIn.value.trim(), port: Number(portIn.value), password: passIn.value || undefined });
      } catch (err) {
        tested = { error: err?.message || String(err) };
      } finally {
        done();
      }
      draw();
    });
    const clearBtn = st?.hasPassword
      ? h(
          'button',
          {
            class: 'btn sm ghost',
            type: 'button',
            onclick: async () => {
              try {
                st = await api.invoke('obs:setPassword', null);
                ok(C('obsPasswordRemoved'));
              } catch (err) {
                fail(C('saveFailed'), err);
              }
              draw();
            },
          },
          icon('x'),
          C('obsPasswordClear'),
        )
      : null;
    const result = tested
      ? tested.error
        ? h('div', { class: 'notice bad', role: 'status' }, icon('alert'), h('div', {}, tested.error))
        : h('div', { class: 'notice good', role: 'status' }, icon('check'), h('div', {}, C('obsTestOk', { version: tested.version || '?', count: tested.scenes?.length || 0 })))
      : null;
    mount(
      root,
      h('div', { class: 'cap-head' }, h('div', { class: 'cap-logo', 'aria-hidden': 'true' }, icon('csObs')), h('div', { class: 'cap-head-text' }, h('div', { class: 'card-title' }, C('obsTitle')), h('div', { class: 'cap-sub' }, C('obsSubtitle'))), statusPill()),
      h('div', { class: 'toggle-row' }, h('div', { class: 'tr-text' }, h('div', { class: 'tr-title' }, C('obsEnable')), h('div', { class: 'tr-sub' }, C('obsEnableSub'))), switchEl(c.enabled, (v) => save({ enabled: v }), C('obsEnable'))),
      h('div', { class: 'cs-obs-grid' }, h('div', { class: 'cs-field' }, h('label', { class: 'cs-label' }, C('obsHost')), hostIn), h('div', { class: 'cs-field' }, h('label', { class: 'cs-label' }, C('obsPort')), portIn), h('div', { class: 'cs-field' }, h('label', { class: 'cs-label' }, C('obsPassword')), passIn)),
      h('p', { class: 'cs-help' }, C('obsHelp')),
      h('div', { class: 'row wrap' }, testBtn, clearBtn),
      result,
      h('h3', { class: 'cs-subtitle' }, C('obsRules')),
      h('div', { class: 'cs-obs-grid two' }, sceneSelect('sceneOnOpen', C('obsSceneOpen')), sceneSelect('sceneOnClose', C('obsSceneClose'))),
    );
  }

  api
    .invoke('obs:status')
    .then((s) => {
      st = s;
    })
    .catch((err) => console.warn('[clipstudio] obs:', err?.message || err))
    .finally(() => draw());
  return root;
}
