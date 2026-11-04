// Modo familia, lado de la interfaz: tarjeta de Ajustes → General y los avisos en el launcher (cuenta regresiva y servidor no
// permitido). Las reglas y el cierre del juego viven en modules/family.js: esto solo muestra y pide el PIN. Es un control del
// launcher, no una barrera de seguridad, y la tarjeta lo dice así.
import { h, icon, mount, modal, toast, fail, ok, selectEl, switchEl, fmtDuration, fmtTime, setBusy, copyText } from '../../ui.js';
import { api } from '../../store.js';
import { t } from '../../i18n.js';
import { card, note } from '../../pages/settings/shared.js';

const T = (key, vars) => t(`datatools.${key}`, vars);
const MIN = 60000;
const LIMITS = [0, 30, 60, 90, 120, 150, 180, 240, 300, 360, 480, 600, 720];
const EXTENDS = [15, 30, 60, 120];

const empty = () => ({ limitMin: 0, schedule: { enabled: false, from: '08:00', to: '21:00' }, servers: { enabled: false, list: [] } });

// ---------- Piezas ----------
function pinInput(id, placeholder) {
  const input = h('input', { class: 'input dt-pin', type: 'password', inputmode: 'numeric', autocomplete: 'off', maxlength: 8, id, placeholder, 'aria-label': placeholder });
  input.addEventListener('input', () => {
    input.value = input.value.replace(/\D/g, '');
  });
  return input;
}

const errorBox = () => {
  const box = h('div', { class: 'notice bad dt-err', role: 'alert', hidden: true });
  box.show = (msg) => {
    mount(box, icon('alert'), h('div', {}, msg));
    box.hidden = false;
  };
  box.hide = () => {
    box.hidden = true;
  };
  return box;
};

function optionsForm(cfg) {
  const c = { ...empty(), ...(cfg || {}) };
  let limit = c.limitMin || 0;
  const limitSel = selectEl(LIMITS.includes(limit) ? LIMITS.map((m) => ({ value: String(m), label: m ? fmtDuration(m * MIN) : T('familyNoLimit') })) : [...LIMITS, limit].sort((a, b) => a - b).map((m) => ({ value: String(m), label: m ? fmtDuration(m * MIN) : T('familyNoLimit') })), String(limit), (v) => {
    limit = Number(v);
  });
  const from = h('input', { class: 'input dt-time', type: 'time', value: c.schedule.from, 'aria-label': T('familyFrom') });
  const to = h('input', { class: 'input dt-time', type: 'time', value: c.schedule.to, 'aria-label': T('familyTo') });
  const times = h('div', { class: 'dt-row' }, h('label', { class: 'dt-field' }, h('span', {}, T('familyFrom')), from), h('label', { class: 'dt-field' }, h('span', {}, T('familyTo')), to));
  let scheduleOn = c.schedule.enabled;
  times.hidden = !scheduleOn;
  const list = h('textarea', { class: 'textarea dt-servers', rows: 4, spellcheck: 'false', placeholder: 'mc.example.com\n*.hypixel.net', 'aria-label': T('familyServersList') });
  list.value = (c.servers.list || []).join('\n');
  let serversOn = c.servers.enabled;
  const serversBox = h('div', { class: 'dt-stack' }, list, h('div', { class: 'small muted' }, T('familyServersHint')));
  serversBox.hidden = !serversOn;
  const row = (title, sub, checked, onChange) => h('div', { class: 'toggle-row' }, h('div', { class: 'tr-text' }, h('div', { class: 'tr-title' }, title), sub ? h('div', { class: 'tr-sub' }, sub) : null), switchEl(checked, onChange, title));
  return {
    el: h(
      'div',
      { class: 'dt-stack' },
      h('label', { class: 'dt-field' }, h('span', {}, T('familyLimit')), limitSel),
      row(T('familySchedule'), T('familyScheduleSub'), scheduleOn, (v) => {
        scheduleOn = v;
        times.hidden = !v;
      }),
      times,
      row(T('familyServers'), T('familyServersSub'), serversOn, (v) => {
        serversOn = v;
        serversBox.hidden = !v;
      }),
      serversBox,
    ),
    value: () => ({ limitMin: limit, schedule: { enabled: scheduleOn, from: from.value || c.schedule.from, to: to.value || c.schedule.to }, servers: { enabled: serversOn, list: list.value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) } }),
  };
}

// Diálogo que pide el PIN y corre una acción: un PIN mal no lo cierra, avisa cuántos intentos quedan.
function askPin({ title, text, okText, danger = false, extra = null, run, forgot = true }) {
  const input = pinInput('dt-pin-ask', T('familyPinPlaceholder'));
  const err = errorBox();
  const okBtn = h('button', { class: ['btn', danger ? 'danger' : 'primary'], type: 'button' }, okText);
  let m;
  const submit = async () => {
    err.hide();
    if (!input.value) return input.focus();
    const done = setBusy(okBtn);
    try {
      await run(input.value);
      done();
      m.close();
    } catch (e) {
      done();
      err.show(e.message);
      input.value = '';
      input.focus();
    }
    return undefined;
  };
  okBtn.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
  m = modal({
    title,
    icon: 'lock',
    size: 'sm',
    body: h('div', { class: 'dt-stack' }, text ? h('p', { class: 'text-2' }, text) : null, extra, h('label', { class: 'dt-field', for: 'dt-pin-ask' }, h('span', {}, T('familyPinLabel')), input), err),
    footer: [
      forgot ? h('button', { class: 'btn ghost', type: 'button', onclick: () => (m.close(), openRecover()) }, T('familyForgot')) : null,
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn ghost', type: 'button', onclick: () => m.close() }, T('cancel')),
      okBtn,
    ],
  });
  setTimeout(() => input.focus(), 30);
  return m;
}

// El código se muestra una sola vez y no se puede cerrar sin querer.
function showRecoveryCode(code) {
  const m = modal({
    title: T('familyCodeTitle'),
    icon: 'key',
    size: 'sm',
    closable: false,
    body: h(
      'div',
      { class: 'dt-stack' },
      h('p', { class: 'text-2' }, T('familyCodeText')),
      h('div', { class: 'dt-code selectable' }, code),
      h('button', { class: 'btn sm', type: 'button', onclick: () => copyText(code, T('familyCodeCopied')) }, icon('copy'), T('familyCodeCopy')),
      note('warn', 'alert', T('familyCodeOnce')),
    ),
    footer: [h('button', { class: 'btn primary', type: 'button', onclick: () => m.close() }, T('familyCodeDone'))],
  });
}

function openRecover() {
  const code = h('input', { class: 'input mono', autocomplete: 'off', spellcheck: 'false', placeholder: 'XXXX-XXXX-XXXX-XXXX', 'aria-label': T('familyCodeLabel') });
  const pin1 = pinInput('dt-pin-rec1', T('familyNewPin'));
  const pin2 = pinInput('dt-pin-rec2', T('familyRepeatPin'));
  const err = errorBox();
  const okBtn = h('button', { class: 'btn primary', type: 'button' }, T('familyRecoverOk'));
  const m = modal({
    title: T('familyRecoverTitle'),
    icon: 'key',
    size: 'sm',
    body: h('div', { class: 'dt-stack' }, h('p', { class: 'text-2' }, T('familyRecoverText')), code, pin1, pin2, err),
    footer: [h('button', { class: 'btn ghost', type: 'button', onclick: () => m.close() }, T('cancel')), okBtn],
  });
  okBtn.addEventListener('click', async () => {
    err.hide();
    if (pin1.value !== pin2.value) return err.show(T('familyPinMismatch'));
    const done = setBusy(okBtn);
    try {
      const res = await api.invoke('family:recover', code.value, pin1.value);
      done();
      m.close();
      showRecoveryCode(res.recoveryCode);
    } catch (e) {
      done();
      err.show(e.message);
    }
    return undefined;
  });
}

function openSetup(onDone) {
  const form = optionsForm(empty());
  const pin1 = pinInput('dt-pin-new1', T('familyNewPin'));
  const pin2 = pinInput('dt-pin-new2', T('familyRepeatPin'));
  const err = errorBox();
  const okBtn = h('button', { class: 'btn primary', type: 'button' }, icon('lock'), T('familyActivate'));
  const m = modal({
    title: T('familySetupTitle'),
    icon: 'shield',
    body: h('div', { class: 'dt-stack' }, note('info', 'info', T('familyHonest')), form.el, h('div', { class: 'dt-label' }, T('familyChoosePin')), h('div', { class: 'dt-row' }, pin1, pin2), h('div', { class: 'small muted' }, T('familyPinRule')), err),
    footer: [h('button', { class: 'btn ghost', type: 'button', onclick: () => m.close() }, T('cancel')), okBtn],
  });
  okBtn.addEventListener('click', async () => {
    err.hide();
    if (pin1.value !== pin2.value) return err.show(T('familyPinMismatch'));
    const done = setBusy(okBtn);
    try {
      const res = await api.invoke('family:enable', pin1.value, form.value());
      done();
      m.close();
      showRecoveryCode(res.recoveryCode);
      onDone?.();
    } catch (e) {
      done();
      err.show(e.message);
    }
    return undefined;
  });
}

function openOptions(status, onDone) {
  const form = optionsForm(status.config);
  askPin({
    title: T('familyOptionsTitle'),
    okText: T('familySave'),
    extra: form.el,
    run: async (pin) => {
      await api.invoke('family:update', pin, form.value());
      ok(T('familySaved'));
      onDone?.();
    },
  });
}

function minutesPicker() {
  let minutes = 30;
  const sel = selectEl(EXTENDS.map((m) => ({ value: String(m), label: fmtDuration(m * MIN) })), '30', (v) => {
    minutes = Number(v);
  });
  return { el: h('label', { class: 'dt-field' }, h('span', {}, T('familyExtendBy')), sel), value: () => minutes };
}

function openExtend(onDone) {
  const pick = minutesPicker();
  askPin({
    title: T('familyExtendTitle'),
    text: T('familyExtendText'),
    okText: T('familyExtendOk'),
    extra: pick.el,
    run: async (pin) => {
      await api.invoke('family:extend', pin, pick.value());
      onDone?.();
    },
  });
}

function openChangePin() {
  const pin1 = pinInput('dt-pin-ch1', T('familyNewPin'));
  const pin2 = pinInput('dt-pin-ch2', T('familyRepeatPin'));
  askPin({
    title: T('familyChangePin'),
    okText: T('familySave'),
    extra: h('div', { class: 'dt-row' }, pin1, pin2),
    run: async (pin) => {
      if (pin1.value !== pin2.value) throw new Error(T('familyPinMismatch'));
      await api.invoke('family:changePin', pin, pin1.value);
      ok(T('familyPinChanged'));
    },
  });
}

// ---------- Tarjeta ----------
export function familyCard(ctx) {
  const body = h('div', { class: 'dt-stack' }, h('div', { class: 'small muted' }, T('loading')));

  function line(ic, text, cls) {
    return h('div', { class: ['dt-line', cls] }, icon(ic), h('span', {}, text));
  }

  function drawOn(s) {
    const c = s.config;
    const lines = [];
    if (c.limitMin > 0) lines.push(line('clock', T('familyUsed', { used: fmtDuration(s.usedMs || 0), limit: fmtDuration(c.limitMin * MIN) })));
    if (c.schedule.enabled) lines.push(line('calendar', T('familyWindow', { from: c.schedule.from, to: c.schedule.to }), s.insideWindow ? null : 'warn'));
    if (c.servers.enabled) lines.push(line('server', c.servers.list.length ? T('familyServersCount', { count: c.servers.list.length }) : T('familyServersNone')));
    if (!lines.length) lines.push(line('info', T('familyNothingOn')));
    if (s.extendUntil) lines.push(line('zap', T('familyExtended', { time: fmtTime(s.extendUntil) }), 'good'));
    if (s.lock?.locked) lines.push(line('lock', T('familyLockedNow', { minutes: Math.max(1, Math.ceil(s.lock.retryInMs / MIN)) }), 'warn'));
    return [
      h('div', { class: 'dt-lines' }, lines),
      h(
        'div',
        { class: 'dt-actions' },
        h('button', { class: 'btn sm', type: 'button', onclick: () => openOptions(s, refresh) }, icon('sliders'), T('familyChange')),
        h('button', { class: 'btn sm', type: 'button', onclick: () => openExtend(refresh) }, icon('clock'), T('familyExtend')),
        h('button', { class: 'btn sm ghost', type: 'button', onclick: openChangePin }, icon('key'), T('familyChangePin')),
        h('span', { class: 'spacer' }),
        h(
          'button',
          {
            class: 'btn sm danger',
            type: 'button',
            onclick: () =>
              askPin({
                title: T('familyDisableTitle'),
                text: T('familyDisableText'),
                okText: T('familyDisable'),
                danger: true,
                run: async (pin) => {
                  await api.invoke('family:disable', pin);
                  ok(T('familyDisabled'));
                  refresh();
                },
              }),
          },
          T('familyDisable'),
        ),
      ),
    ];
  }

  async function refresh() {
    let s;
    try {
      s = await api.invoke('family:status');
    } catch (err) {
      if (ctx?.alive?.() !== false) mount(body, note('bad', 'alert', err.message));
      return;
    }
    if (ctx?.alive?.() === false) return;
    mount(
      body,
      note('info', 'info', T('familyHonest')),
      s.enabled ? drawOn(s) : h('div', { class: 'dt-actions' }, h('button', { class: 'btn', type: 'button', onclick: () => openSetup(refresh) }, icon('shield'), T('familyEnable'))),
    );
  }

  refresh();
  const off = api.on('family:event', (ev) => ['changed', 'cancelled', 'closing'].includes(ev?.kind) && refresh());
  const timer = setInterval(refresh, 30000);
  ctx?.onCleanup?.(() => {
    off();
    clearInterval(timer);
  });
  return card({ title: T('familyTitle'), iconName: 'shield', sub: T('familySub'), anchor: 'family-card' }, body);
}

// ---------- Avisos ----------
let started = false;
let countdown = null; // diálogo abierto de la cuenta regresiva
const serverDialogs = new Map(); // instancia -> diálogo del servidor no permitido

function liveSeconds(endsAt, el, key, vars) {
  const paint = () => {
    el.textContent = T(key, { ...vars, count: Math.max(0, Math.ceil((endsAt - Date.now()) / 1000)) });
  };
  paint();
  return setInterval(paint, 500);
}

function closeCountdown() {
  if (!countdown) return;
  clearInterval(countdown.timer);
  countdown.modal.close();
  countdown = null;
}

function showCountdown(ev) {
  closeCountdown();
  const secs = h('div', { class: 'dt-countdown', role: 'timer', 'aria-live': 'off' });
  const timer = liveSeconds(ev.endsAt, secs, 'familySeconds');
  const m = modal({
    title: T('familyCountdownTitle'),
    icon: 'clock',
    size: 'sm',
    body: h('div', { class: 'dt-stack' }, h('p', { class: 'text-2' }, T(ev.reason === 'schedule' ? 'familyCountdownSchedule' : 'familyCountdownLimit')), secs),
    footer: [h('button', { class: 'btn', type: 'button', onclick: () => openExtend() }, icon('lock'), T('familyExtendWithPin')), h('button', { class: 'btn ghost', type: 'button', onclick: () => closeCountdown() }, T('close'))],
    onClose: () => clearInterval(timer),
  });
  countdown = { modal: m, timer };
}

function closeServerDialog(instanceId) {
  const d = serverDialogs.get(instanceId);
  if (!d) return;
  serverDialogs.delete(instanceId);
  clearInterval(d.timer);
  d.modal.close();
}

function showServer(ev) {
  closeServerDialog(ev.instanceId);
  const secs = h('div', { class: 'dt-countdown', role: 'timer', 'aria-live': 'off' });
  const timer = liveSeconds(ev.endsAt, secs, 'familySeconds');
  let keep = false;
  const allow = () =>
    askPin({
      title: T('familyAllowTitle'),
      text: T('familyAllowText', { address: ev.address }),
      okText: T('familyAllowOk'),
      extra: h('div', { class: 'toggle-row' }, h('div', { class: 'tr-text' }, h('div', { class: 'tr-title' }, T('familyAllowSave'))), switchEl(false, (v) => (keep = v), T('familyAllowSave'))),
      run: (pin) => api.invoke('family:allowServer', pin, ev.instanceId, { save: keep }),
    });
  const m = modal({
    title: T('familyServerTitle'),
    icon: 'server',
    size: 'sm',
    body: h('div', { class: 'dt-stack' }, h('p', { class: 'text-2' }, T('familyServerBody', { address: ev.address })), secs),
    footer: [h('button', { class: 'btn', type: 'button', onclick: allow }, icon('lock'), T('familyAllowWithPin')), h('button', { class: 'btn ghost', type: 'button', onclick: () => closeServerDialog(ev.instanceId) }, T('close'))],
    onClose: () => clearInterval(timer),
  });
  serverDialogs.set(ev.instanceId, { modal: m, timer });
}

export function showFamilyEvent(ev) {
  switch (ev?.kind) {
    case 'warn':
      toast('info', T('familyWarnTitle'), T(ev.reason === 'schedule' ? 'familyWarnSchedule' : 'familyWarnLimit', { count: ev.minutes }), 12000);
      break;
    case 'countdown':
      showCountdown(ev);
      break;
    case 'cancelled':
      closeCountdown();
      break;
    case 'closing':
      closeCountdown();
      toast('info', T('familyClosingTitle'), T(ev.reason === 'schedule' ? 'familyCountdownSchedule' : 'familyCountdownLimit'), 8000);
      break;
    case 'server':
      showServer(ev);
      break;
    case 'serverAllowed':
      closeServerDialog(ev.instanceId);
      break;
    case 'serverClosing':
      closeServerDialog(ev.instanceId);
      toast('info', T('familyClosingTitle'), T('familyServerClosed', { address: ev.address }), 8000);
      break;
    default:
  }
}

export function startFamilyNotices() {
  if (started) return;
  started = true;
  api.on('family:event', showFamilyEvent);
  // Si se recargó la interfaz en medio de una cuenta regresiva, vuelve a verse.
  api
    .invoke('family:status')
    .then((s) => {
      if (s?.phase === 'countdown' && s.countdownEndsAt) showCountdown({ endsAt: s.countdownEndsAt, reason: s.reason });
      for (const x of s?.servers || []) showServer(x);
    })
    .catch(() => {});
}
