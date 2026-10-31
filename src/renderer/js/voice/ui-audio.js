// Ajustes de audio del Voice Chat: microfono (con prueba y medidor), modo de transmision (deteccion de
// voz o pulsar para hablar), salida, atajo global para silenciar y red ("Ocultar mi IP", solo si el launcher trae
// un servidor TURN en core/app-config.js: los servidores no se configuran desde aca).
import { h, icon, mount, fail, ok, switchEl, setBusy } from '../ui.js';
import { t } from '../i18n.js';
import { voice } from '../voice.js';
import { acceleratorFromEvent, acceleratorParts, keyLabel } from './keys.js';
import { levelMeter, segmented, fieldId, tSlot, kbdKeys } from './ui-common.js';

export function audioView(container) {
  const offs = [];
  let stopTest = null;
  let recording = null; // { stop() } mientras se graba una tecla
  let disposed = false;
  const cfg = () => voice.settings;
  const save = (patch) => voice.saveSettings(patch).catch((err) => fail(t('voice.saveFailed'), err));

  // ---------- Microfono ----------
  const ids = { in: fieldId('vc-in'), out: fieldId('vc-out'), inVol: fieldId('vc-in-vol'), thr: fieldId('vc-thr'), rel: fieldId('vc-rel'), sbVol: fieldId('vc-sb-vol'), test: fieldId('vc-test') };
  const inSel = h('select', { class: 'select', id: ids.in });
  const outSel = h('select', { class: 'select', id: ids.out });
  const devRefresh = h('button', { class: 'icon-btn', type: 'button', title: t('voice.refreshDevices'), 'aria-label': t('voice.refreshDevices') }, icon('refresh'));
  devRefresh.addEventListener('click', async () => {
    devRefresh.classList.add('vc-spin');
    try {
      await loadDevices(true);
    } finally {
      devRefresh.classList.remove('vc-spin');
    }
  });
  inSel.addEventListener('change', () => save({ inputDevice: inSel.value }));
  outSel.addEventListener('change', () => save({ outputDevice: outSel.value }));

  const inVolVal = h('span', { class: 'vc-val', 'aria-hidden': 'true' });
  const inVol = h('input', { type: 'range', class: 'range', id: ids.inVol, min: 0, max: 200, step: 5 });
  inVol.addEventListener('input', () => setRangeText(inVol, inVolVal, `${inVol.value}%`));
  inVol.addEventListener('change', () => save({ inputVolume: Number(inVol.value) / 100 }));

  const meter = levelMeter();
  const meterState = h('span', { class: 'vc-meter-state' });
  const testBtn = h('button', { class: 'btn sm', type: 'button' });
  const monitorSwitch = switchEl(false, (v) => voice.setMonitor(v), t('voice.hearMyself'));
  const monitorRow = h('label', { class: 'vc-inline-opt' }, monitorSwitch, h('span', {}, icon('ear'), t('voice.hearMyself')));
  testBtn.addEventListener('click', () => toggleTest());

  const toggles = ['noiseSuppression', 'echoCancellation', 'autoGainControl'].map((key) => ({
    key,
    el: switchEl(cfg()[key] !== false, (v) => save({ [key]: v }), t(`voice.opt_${key}`)),
  }));
  const toggleRows = toggles.map(({ key, el }) => toggleRow(t(`voice.opt_${key}`), t(`voice.opt_${key}Hint`), el));

  const micCard = h(
    'section',
    { class: 'card vc-set-card' },
    cardHead('mic', t('voice.inputTitle'), t('voice.inputSub')),
    h('div', { class: 'field' }, h('label', { for: ids.in }, t('voice.inputDevice')), h('div', { class: 'vc-device-row' }, inSel, devRefresh)),
    h('div', { class: 'field' }, h('div', { class: 'vc-label-row' }, h('label', { for: ids.inVol }, t('voice.inputVolume')), inVolVal), inVol),
    h(
      'div',
      { class: 'vc-test', role: 'group', 'aria-labelledby': ids.test },
      h('div', { class: 'vc-test-top' }, h('span', { class: 'label', id: ids.test }, t('voice.micTest')), meterState, h('span', { class: 'spacer' }), monitorRow, testBtn),
      meter.el,
      h('div', { class: 'field-help' }, t('voice.micTestHint')),
    ),
    h('div', { class: 'vc-toggles' }, toggleRows),
  );

  // ---------- Modo de transmision ----------
  const modeSeg = segmented(
    [
      { id: 'vad', icon: 'activity', label: t('voice.modeVad') },
      { id: 'ptt', icon: 'keyboard', label: t('voice.modePtt') },
    ],
    cfg().pushToTalk ? 'ptt' : 'vad',
    (v) => save({ pushToTalk: v === 'ptt' }),
    t('voice.modeTitle'),
  );
  const autoSwitch = switchEl(cfg().vadAuto !== false, (v) => save({ vadAuto: v }), t('voice.vadAuto'));
  const thrVal = h('span', { class: 'vc-val', 'aria-hidden': 'true' });
  const thr = h('input', { type: 'range', class: 'range', id: ids.thr, min: -80, max: -10, step: 1 });
  thr.addEventListener('input', () => setRangeText(thr, thrVal, t('voice.dbValue', { db: thr.value })));
  thr.addEventListener('change', () => save({ vadThreshold: Number(thr.value) }));
  const vadBox = h(
    'div',
    { class: 'vc-mode-box' },
    toggleRow(t('voice.vadAuto'), t('voice.vadAutoHint'), autoSwitch),
    h('div', { class: 'field' }, h('div', { class: 'vc-label-row' }, h('label', { for: ids.thr }, t('voice.vadSensitivity')), thrVal), thr, h('div', { class: 'field-help' }, t('voice.vadSensitivityHint'))),
  );
  const pttBtn = h('button', { class: 'btn sm vc-keybtn', type: 'button' });
  pttBtn.addEventListener('click', () => recordPtt());
  const relVal = h('span', { class: 'vc-val', 'aria-hidden': 'true' });
  const rel = h('input', { type: 'range', class: 'range', id: ids.rel, min: 0, max: 1000, step: 50 });
  rel.addEventListener('input', () => setRangeText(rel, relVal, t('voice.msValue', { ms: rel.value })));
  rel.addEventListener('change', () => save({ pttReleaseDelay: Number(rel.value) }));
  const pttState = h('span', { class: 'vc-ptt-state' });
  const pttBox = h(
    'div',
    { class: 'vc-mode-box' },
    h('div', { class: 'field' }, h('span', { class: 'label' }, t('voice.pttKey')), h('div', { class: 'row wrap' }, pttBtn, pttState), h('div', { class: 'field-help' }, t('voice.pttKeyHint'))),
    h('div', { class: 'field' }, h('div', { class: 'vc-label-row' }, h('label', { for: ids.rel }, t('voice.pttRelease')), relVal), rel, h('div', { class: 'field-help' }, t('voice.pttReleaseHint'))),
  );
  const modeCard = h('section', { class: 'card vc-set-card' }, cardHead('activity', t('voice.modeTitle'), t('voice.modeSub')), modeSeg.el, vadBox, pttBox);

  // ---------- Salida ----------
  const testSound = h('button', { class: 'btn sm', type: 'button' }, icon('volume'), t('voice.testSound'));
  testSound.addEventListener('click', () => voice.playTestSound());
  const notify = switchEl(cfg().notifySounds !== false, (v) => save({ notifySounds: v }), t('voice.notifySounds'));
  const sbEnabled = switchEl(cfg().soundboardEnabled !== false, (v) => save({ soundboardEnabled: v }), t('voice.hearOthersSounds'));
  const sbVolVal = h('span', { class: 'vc-val', 'aria-hidden': 'true' });
  const sbVol = h('input', { type: 'range', class: 'range', id: ids.sbVol, min: 0, max: 100, step: 5 });
  sbVol.addEventListener('input', () => setRangeText(sbVol, sbVolVal, `${sbVol.value}%`));
  sbVol.addEventListener('change', () => save({ soundboardVolume: Number(sbVol.value) / 100 }));
  const outCard = h(
    'section',
    { class: 'card vc-set-card' },
    cardHead('headphones', t('voice.outputTitle'), t('voice.outputSub')),
    h('div', { class: 'field' }, h('label', { for: ids.out }, t('voice.outputDevice')), h('div', { class: 'vc-device-row' }, outSel, testSound)),
    h('div', { class: 'vc-toggles' }, toggleRow(t('voice.notifySounds'), t('voice.notifySoundsHint'), notify), toggleRow(t('voice.hearOthersSounds'), t('voice.hearOthersSoundsHint'), sbEnabled)),
    h('div', { class: 'field' }, h('div', { class: 'vc-label-row' }, h('label', { for: ids.sbVol }, t('voice.soundboardVolume')), sbVolVal), sbVol),
  );

  // ---------- Atajo global ----------
  const scKeys = h('div', { class: 'vc-shortcut-keys' });
  const scBtn = h('button', { class: 'btn sm', type: 'button' }, icon('keyboard'), t('voice.changeShortcut'));
  const scClear = h('button', { class: 'btn ghost sm', type: 'button' }, icon('x'), t('voice.removeShortcut'));
  const scMsg = h('div', { class: 'field-help', role: 'status' }, t('voice.shortcutHint'));
  scBtn.addEventListener('click', () => recordShortcut());
  scClear.addEventListener('click', async () => {
    await voice.setShortcut('');
    drawShortcut();
  });
  const scCard = h('section', { class: 'card vc-set-card' }, cardHead('keyboard', t('voice.shortcutTitle'), t('voice.shortcutSub')), h('div', { class: 'vc-shortcut' }, scKeys, h('span', { class: 'spacer' }), scBtn, scClear), scMsg);

  // ---------- Red y privacidad (solo con el servidor TURN del launcher) ----------
  const relaySwitch = switchEl(Boolean(cfg().relayOnly), (v) => save({ relayOnly: v }), t('voice.relayOnly'));
  const relayRow = toggleRow(t('voice.relayOnly'), t('voice.relayOnlyText'), relaySwitch);
  const netCard = h('section', { class: 'card vc-set-card', hidden: true }, cardHead('network', t('voice.netTitle'), t('voice.netSubText')), h('div', { class: 'vc-toggles' }, relayRow));

  mount(container, h('div', { class: 'vc-settings' }, h('div', { class: 'vc-set-col' }, micCard, modeCard), h('div', { class: 'vc-set-col' }, outCard, scCard, netCard)));

  // ---------- Estado ----------
  function cardHead(iconName, title, sub) {
    return h('div', { class: 'vc-card-head' }, h('div', { class: 'vc-card-icon', 'aria-hidden': 'true' }, icon(iconName)), h('div', { class: 'vc-card-titles' }, h('h2', { class: 'card-title' }, title), h('p', { class: 'card-sub' }, sub)));
  }

  function toggleRow(title, sub, sw) {
    return h('div', { class: 'toggle-row' }, h('div', { class: 'tr-text' }, h('div', { class: 'tr-title' }, title), h('div', { class: 'tr-sub' }, sub)), sw);
  }

  // Valor visible de un deslizador (y el que lee el lector de pantalla)
  function setRangeText(range, valEl, text) {
    valEl.textContent = text;
    range.setAttribute('aria-valuetext', text);
  }

  function drawValues() {
    const c = cfg();
    const inV = Math.round((c.inputVolume ?? 1) * 100);
    inVol.value = inV;
    setRangeText(inVol, inVolVal, `${inV}%`);
    thr.value = c.vadThreshold;
    setRangeText(thr, thrVal, t('voice.dbValue', { db: c.vadThreshold }));
    thr.disabled = c.vadAuto !== false;
    rel.value = c.pttReleaseDelay;
    setRangeText(rel, relVal, t('voice.msValue', { ms: c.pttReleaseDelay }));
    sbVol.value = Math.round((c.soundboardVolume ?? 0.7) * 100);
    setRangeText(sbVol, sbVolVal, `${sbVol.value}%`);
    vadBox.hidden = Boolean(c.pushToTalk);
    pttBox.hidden = !c.pushToTalk;
    modeSeg.set(c.pushToTalk ? 'ptt' : 'vad');
    if (!recording) mount(pttBtn, icon(/^Mouse/.test(c.pttKey) ? 'mouse' : 'keyboard'), h('span', { class: 'vc-keybtn-text' }, tSlot('voice.pttKeyIs', 'key', h('kbd', { class: 'kbd' }, keyLabel(c.pttKey)))));
    drawShortcut();
    drawNet();
  }

  function drawShortcut() {
    if (recording?.kind === 'shortcut') return;
    const parts = acceleratorParts(cfg().muteShortcut);
    mount(scKeys, parts.length ? kbdKeys(parts) : h('span', { class: 'muted small' }, t('voice.noShortcut')));
    scClear.classList.toggle('hidden', !parts.length);
  }

  function drawNet() {
    netCard.hidden = !voice.hasTurn;
  }

  function drawTest() {
    const st = voice.state;
    // El motor puede cortar la prueba solo (por ejemplo al entrar a una sala)
    if (stopTest && !st.testing && !st.inRoom) stopTest = null;
    const active = Boolean(stopTest) || st.inRoom;
    mount(testBtn, icon(stopTest ? 'stop' : 'mic'), t(stopTest ? 'voice.stopTest' : 'voice.startTest'));
    testBtn.classList.toggle('hidden', st.inRoom);
    monitorRow.classList.toggle('vc-disabled', !active);
    monitorSwitch.querySelector('input').disabled = !active;
    if (!active) {
      monitorSwitch.querySelector('input').checked = false;
      meter.update({ level: 0, threshold: cfg().pushToTalk ? null : cfg().vadThreshold });
      meterState.textContent = '';
    }
  }

  async function loadDevices(unlock = false) {
    try {
      const { inputs, outputs } = await voice.listDevices({ unlock });
      if (disposed) return;
      const c = cfg();
      const opts = (list, selected, kind) => {
        const items = list.length ? list : [{ id: 'default', label: '' }];
        const hasSel = items.some((d) => d.id === selected);
        return [
          ...items.map((d, i) => h('option', { value: d.id, selected: d.id === selected || (!hasSel && d.id === 'default') }, deviceLabel(d, i, kind))),
          !hasSel && selected && selected !== 'default' ? h('option', { value: selected, selected: true }, t('voice.deviceMissing')) : null,
        ];
      };
      mount(inSel, opts(inputs, c.inputDevice, 'in'));
      mount(outSel, opts(outputs, c.outputDevice, 'out'));
    } catch (err) {
      console.warn('[voice] dispositivos', err);
    }
  }

  function deviceLabel(d, i, kind) {
    if (d.id === 'default') return d.label ? t('voice.deviceDefaultNamed', { name: d.label.replace(/^(Default|Predeterminado)\s*-\s*/i, '') }) : t('voice.deviceDefault');
    return d.label || t(kind === 'in' ? 'voice.micN' : 'voice.outN', { n: i + 1 });
  }

  async function toggleTest() {
    if (stopTest) {
      stopTest();
      stopTest = null;
      drawTest();
      return;
    }
    const done = setBusy(testBtn);
    try {
      stopTest = await voice.startMicTest({ monitor: monitorSwitch.querySelector('input').checked });
      loadDevices();
    } catch (err) {
      fail(t('voice.micTestFailed'), err);
    } finally {
      done();
      drawTest();
    }
  }

  function onLevels(lv) {
    const c = cfg();
    const vad = !c.pushToTalk;
    meter.update({ level: lv.self, threshold: vad ? lv.threshold : null, open: lv.open });
    if (!stopTest && !voice.state.inRoom) return;
    // Solo se toca el DOM cuando cambia el texto (los niveles llegan muchas veces por segundo)
    const stateText = vad ? t(lv.open ? 'voice.meterOpen' : 'voice.meterClosed') : t(lv.open ? 'voice.meterPttOn' : 'voice.meterPttOff');
    meterState.classList.toggle('on', Boolean(lv.open));
    if (meterState.textContent !== stateText) meterState.textContent = stateText;
    if (vad && c.vadAuto !== false && document.activeElement !== thr) {
      const db = Math.round(lv.threshold);
      if (Number(thr.value) !== db) thr.value = db;
      const autoText = t('voice.dbAuto', { db });
      if (thrVal.textContent !== autoText) setRangeText(thr, thrVal, autoText);
    }
  }

  // Grabar la tecla (o boton del mouse) de pulsar para hablar
  function recordPtt() {
    if (recording) recording.stop();
    voice.capturingKeys = true;
    mount(pttBtn, icon('keyboard'), h('span', {}, t('voice.pressKey')));
    pttBtn.classList.add('recording');
    const onKey = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') return stop();
      save({ pttKey: e.code });
      stop();
    };
    const onMouse = (e) => {
      if (![1, 3, 4].includes(e.button)) return;
      e.preventDefault();
      e.stopPropagation();
      save({ pttKey: `Mouse${e.button}` });
      stop();
    };
    const onBlur = () => stop();
    function stop() {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('mousedown', onMouse, true);
      window.removeEventListener('blur', onBlur);
      pttBtn.classList.remove('recording');
      voice.capturingKeys = false;
      recording = null;
      drawValues();
    }
    setTimeout(() => {
      window.addEventListener('keydown', onKey, true);
      window.addEventListener('mousedown', onMouse, true);
      window.addEventListener('blur', onBlur);
    }, 0);
    recording = { kind: 'ptt', stop };
  }

  // Grabar el atajo global (con modificadores)
  function recordShortcut() {
    if (recording) recording.stop();
    voice.capturingKeys = true;
    mount(scKeys, h('span', { class: 'vc-recording' }, t('voice.pressShortcut')));
    scMsg.textContent = t('voice.shortcutRecordingHint');
    const onKey = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') return stop();
      const r = acceleratorFromEvent(e);
      if (!r) {
        const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift'].filter(Boolean);
        mount(scKeys, mods.length ? kbdKeys(mods) : h('span', { class: 'vc-recording' }, t('voice.pressShortcut')));
        return;
      }
      if (r.error) {
        scMsg.textContent = t(r.error === 'needsModifier' ? 'voice.shortcutNeedsModifier' : 'voice.shortcutUnsupported');
        return;
      }
      stop();
      await voice.setShortcut(r.accel);
      ok(t('voice.shortcutSaved'), acceleratorParts(r.accel).join(' + '));
      drawShortcut();
    };
    const onBlur = () => stop();
    function stop() {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onBlur);
      voice.capturingKeys = false;
      recording = null;
      scMsg.textContent = t('voice.shortcutHint');
      drawShortcut();
    }
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onBlur);
    recording = { kind: 'shortcut', stop };
  }

  function drawPttState() {
    const st = voice.state;
    pttState.className = `vc-ptt-state ${st.pttDown ? 'on' : ''}`;
    pttState.textContent = st.pttDown ? t('voice.pttPressed') : '';
  }

  drawValues();
  drawTest();
  loadDevices(true);
  offs.push(
    voice.on('levels', onLevels),
    voice.on('settings', () => {
      drawValues();
      for (const { key, el } of toggles) el.querySelector('input').checked = cfg()[key] !== false;
      notify.querySelector('input').checked = cfg().notifySounds !== false;
      sbEnabled.querySelector('input').checked = cfg().soundboardEnabled !== false;
      relaySwitch.querySelector('input').checked = Boolean(cfg().relayOnly);
      autoSwitch.querySelector('input').checked = cfg().vadAuto !== false;
      loadDevices();
    }),
    voice.on('state', () => {
      drawTest();
      drawPttState();
    }),
    voice.on('devices', () => loadDevices()),
  );

  return () => {
    disposed = true;
    offs.forEach((off) => off());
    recording?.stop();
    if (stopTest) stopTest();
    stopTest = null;
    voice.setMonitor(false);
  };
}
