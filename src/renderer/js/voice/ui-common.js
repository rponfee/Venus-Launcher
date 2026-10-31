// Piezas compartidas de la pagina de Voice Chat: iconos propios, avatares, estados vacios, medidor de
// nivel, editor de salas y dialogos de contraseña.
import { h, icon, mount, modal, avatarImg, selectEl, fail, ok, setBusy } from '../ui.js';
import { t } from '../i18n.js';
import { navigate } from '../app.js';
import { voice, MAX_MEMBERS } from '../voice.js';

export const VC_ICONS = {
  trendingDown: '<polyline points="22 17 13.5 8.5 8.5 13.5 2 7"/><polyline points="16 17 22 17 22 11"/>',
  lockOpen: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>',
  screenShareOff: '<path d="M13 3H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-3"/><path d="M8 21h8"/><path d="M12 17v4"/><path d="m22 3-5 5"/><path d="m17 3 5 5"/>',
  userX: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="17" x2="22" y1="8" y2="13"/><line x1="22" x2="17" y1="8" y2="13"/>',
  audioLines: '<path d="M2 10v3"/><path d="M6 6v11"/><path d="M10 3v18"/><path d="M14 8v7"/><path d="M18 5v13"/><path d="M22 10v3"/>',
  ear: '<path d="M6 8.5a6.5 6.5 0 1 1 13 0c0 6-6 6-6 10a3.5 3.5 0 1 1-7 0"/><path d="M15 8.5a2.5 2.5 0 0 0-5 0v1a2 2 0 1 1 0 4"/>',
  hand: '<path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2"/><path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2"/><path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>',
  bomb: '<circle cx="11" cy="13" r="9"/><path d="M14.35 4.65 16.3 2.7a2.41 2.41 0 0 1 3.4 0l1.6 1.6a2.4 2.4 0 0 1 0 3.4l-1.95 1.95"/><path d="m22 2-1.5 1.5"/>',
  megaphone: '<path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>',
  drum: '<path d="m2 2 8 8"/><path d="m22 2-8 8"/><ellipse cx="12" cy="9" rx="10" ry="5"/><path d="M7 13.4v7.9"/><path d="M12 14v8"/><path d="M17 13.4v7.9"/><path d="M2 9v8a10 5 0 0 0 20 0V9"/>',
  coins: '<circle cx="8" cy="8" r="6"/><path d="M18.09 10.37A6 6 0 1 1 10.34 18"/><path d="M7 6h1v4"/><path d="m16.71 13.88.7.71-2.82 2.82"/>',
  mouse: '<rect x="5" y="2" width="14" height="20" rx="7"/><path d="M12 6v4"/>',
  door: '<path d="M13 4h3a2 2 0 0 1 2 2v14"/><path d="M2 20h3"/><path d="M13 20h9"/><path d="M10 12v.01"/><path d="M13 4.562v16.157a1 1 0 0 1-1.242.97L5 20V5.562a2 2 0 0 1 1.515-1.94l4-1A2 2 0 0 1 13 4.561Z"/>',
};

let fieldSeq = 0;
// Id unico para enlazar etiquetas, ayudas y errores con su campo
export function fieldId(prefix = 'vc-field') {
  fieldSeq += 1;
  return `${prefix}-${fieldSeq}`;
}

export function personAvatar(avatar, name, size = 64, cls = 'avatar') {
  return avatarImg(avatar || name || 'MHF_Steve', size, cls);
}

// Estado vacio: sin sesion (boton a Ajustes > Cuenta y nube) o la nube del launcher no esta disponible ('config')
export function cloudCta(container, kind) {
  const isConfig = kind === 'config';
  mount(
    container,
    h(
      'section',
      { class: 'card vc-cta', 'aria-labelledby': 'vc-cta-title' },
      h('div', { class: 'vc-cta-art', 'aria-hidden': 'true' }, h('span', { class: 'vc-cta-ring r1' }), h('span', { class: 'vc-cta-ring r2' }), h('span', { class: 'vc-cta-icon' }, icon(isConfig ? 'cloud' : 'logIn'))),
      h(
        'div',
        { class: 'vc-cta-text' },
        h('h2', { class: 'vc-cta-title', id: 'vc-cta-title' }, t(isConfig ? 'voice.ctaUnavailableTitle' : 'voice.ctaSignInTitle')),
        h('p', { class: 'vc-cta-sub' }, t(isConfig ? 'voice.ctaUnavailableText' : 'voice.ctaSignInText')),
        h('ul', { class: 'vc-cta-list' }, ['voice.ctaPoint1', 'voice.ctaPoint2', 'voice.ctaPoint3'].map((k) => h('li', {}, icon('check'), h('span', {}, t(k))))),
        h(
          'div',
          { class: 'vc-cta-actions' },
          isConfig ? null : h('button', { class: 'btn primary', onclick: () => navigate('settings/cloud/venus') }, icon('logIn'), t('voice.ctaSignInBtn')),
          h('button', { class: isConfig ? 'btn' : 'btn ghost', onclick: () => navigate('voice/audio') }, icon('sliders'), t('voice.ctaAudioBtn')),
        ),
      ),
    ),
  );
}

// Aviso de error con Reintentar (si el servicio no esta disponible, un texto para el usuario: el detalle va al log)
export function errorBox(err, onRetry) {
  const retry = () => {
    if (!onRetry) return null;
    const btn = h('button', { class: 'btn sm' }, icon('refresh'), t('voice.retry'));
    btn.addEventListener('click', async () => {
      const done = setBusy(btn);
      try {
        await onRetry();
      } finally {
        done();
      }
    });
    return btn;
  };
  if (err?.code === 'not_installed') {
    return h(
      'div',
      { class: 'notice vc-setup', role: 'alert' },
      icon('database'),
      h('div', { class: 'spacer' }, h('strong', {}, t('voice.serviceTitle')), h('div', {}, t('voice.serviceText'))),
      retry(),
    );
  }
  return h('div', { class: 'notice bad vc-error', role: 'alert' }, icon('alert'), h('div', { class: 'spacer' }, err?.message || String(err)), retry());
}

// Medidor de microfono con marca del umbral de deteccion de voz. Se anima solo con transform.
export function levelMeter() {
  const fill = h('i', { class: 'vc-meter-fill' });
  const mark = h('span', { class: 'vc-meter-mark', hidden: true });
  const el = h('div', { class: 'vc-meter', role: 'meter', 'aria-label': t('voice.micLevel'), 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': 0 }, fill, mark);
  let lastPct = -1;
  return {
    el,
    update({ level = 0, threshold = null, open = false }) {
      const pct = Math.round(Math.min(1, Math.max(0, Number(level) || 0)) * 100);
      if (pct !== lastPct) {
        lastPct = pct;
        fill.style.transform = `scaleX(${pct / 100})`;
        el.setAttribute('aria-valuenow', String(pct));
      }
      el.classList.toggle('open', Boolean(open));
      if (threshold === null) mark.hidden = true;
      else {
        mark.hidden = false;
        mark.style.transform = `translateX(${Math.min(100, Math.max(0, ((threshold + 80) / 80) * 100))}%)`;
      }
    },
  };
}

// Grupo de opciones (radiogroup): Tab entra al elegido y las flechas cambian la opcion.
export function segmented(options, value, onChange, label) {
  const el = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': label || null });
  let current = value;
  const draw = (v) => {
    current = v;
    const hadFocus = el.contains(document.activeElement);
    mount(
      el,
      options.map((o) =>
        h(
          'button',
          {
            type: 'button',
            class: o.id === v ? 'active' : null,
            role: 'radio',
            'aria-checked': String(o.id === v),
            tabindex: o.id === v ? 0 : -1,
            dataset: { id: o.id },
            onclick: () => pick(o.id),
          },
          o.icon ? icon(o.icon) : null,
          o.label,
        ),
      ),
    );
    if (hadFocus) [...el.children].find((b) => b.dataset.id === v)?.focus();
  };
  const pick = (id) => {
    draw(id);
    onChange(id);
  };
  el.addEventListener('keydown', (e) => {
    const dir = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!dir) return;
    e.preventDefault();
    const i = Math.max(0, options.findIndex((o) => o.id === current));
    pick(options[(i + dir + options.length) % options.length].id);
  });
  draw(value);
  return { el, set: draw };
}

// Campo de contraseña con boton para mostrarla
export function passwordField({ placeholder = '', value = '', label, id } = {}) {
  const input = h('input', { class: 'input', type: 'password', id: id || null, maxlength: 64, placeholder, value, autocomplete: 'new-password', spellcheck: 'false', 'aria-label': id ? null : label || placeholder });
  const toggle = h('button', { type: 'button', class: 'vc-eye', title: t('voice.showPassword'), 'aria-label': t('voice.showPassword'), 'aria-pressed': 'false' }, icon('eye'));
  toggle.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    mount(toggle, icon(show ? 'eyeOff' : 'eye'));
    const label2 = t(show ? 'voice.hidePassword' : 'voice.showPassword');
    toggle.title = label2;
    toggle.setAttribute('aria-label', label2);
    toggle.setAttribute('aria-pressed', String(show));
  });
  return { el: h('div', { class: 'vc-pass' }, input, toggle), input };
}

// Error debajo de un campo (enlazado con aria-describedby). set('') lo oculta.
export function fieldError(input) {
  const id = fieldId('vc-err');
  const el = h('div', { class: 'field-error', id, role: 'alert', hidden: true });
  return {
    el,
    set(text) {
      el.hidden = !text;
      mount(el, text ? [icon('alert'), h('span', {}, text)] : []);
      if (text) {
        input.setAttribute('aria-invalid', 'true');
        input.setAttribute('aria-describedby', id);
      } else {
        input.removeAttribute('aria-invalid');
        if (input.getAttribute('aria-describedby') === id) input.removeAttribute('aria-describedby');
      }
    },
  };
}

// Pide la contraseña de una sala. Devuelve el texto o null.
export function askPassword({ roomName, wrong = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const id = fieldId('vc-askpw');
    const pw = passwordField({ placeholder: t('voice.password'), label: t('voice.password'), id });
    const err = fieldError(pw.input);
    const enter = h('button', { class: 'btn primary', disabled: true }, icon('logIn'), t('voice.enter'));
    const finish = (v) => {
      if (done) return;
      done = true;
      m.close();
      resolve(v);
    };
    pw.input.addEventListener('input', () => {
      enter.disabled = !pw.input.value;
      err.set('');
    });
    pw.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && pw.input.value) finish(pw.input.value);
    });
    enter.addEventListener('click', () => pw.input.value && finish(pw.input.value));
    const m = modal({
      title: t('voice.passwordTitle'),
      size: 'sm',
      body: h(
        'div',
        { class: 'stack' },
        h('p', { class: 'text-2 vc-modal-text' }, roomName ? t('voice.passwordText', { name: roomName }) : t('voice.passwordTextGeneric')),
        h('div', { class: 'field' }, h('label', { for: id }, t('voice.password')), pw.el, err.el),
      ),
      footer: [h('button', { class: 'btn ghost', onclick: () => finish(null) }, t('voice.cancel')), enter],
      onClose: () => finish(null),
    });
    if (wrong) err.set(t('voice.err_bad_password'));
    setTimeout(() => pw.input.focus(), 30);
  });
}

// Entra a una sala pidiendo la contraseña si hace falta. Devuelve true si entro.
export async function joinWithPassword(code, { roomName, password } = {}) {
  try {
    await voice.joinRoom(code, { password });
    return true;
  } catch (err) {
    if (err?.code === 'password_required' || err?.code === 'bad_password') {
      const pw = await askPassword({ roomName, wrong: err.code === 'bad_password' });
      if (pw) return joinWithPassword(code, { roomName, password: pw });
      return false;
    }
    fail(t('voice.joinFailed'), err);
    return false;
  }
}

export function maxOptions() {
  const out = [];
  for (let n = 2; n <= MAX_MEMBERS; n++) out.push({ value: n, label: t('voice.maxPeople', { count: n }) });
  return out;
}

// Editor de una sala propia (nombre, visibilidad, cupo y contraseña)
export function openRoomEditor(room, onSaved) {
  const ids = { name: fieldId('vc-ed-name'), max: fieldId('vc-ed-max'), pw: fieldId('vc-ed-pw') };
  const name = h('input', { class: 'input', id: ids.name, maxlength: 40, value: room.name });
  const nameErr = fieldError(name);
  name.addEventListener('input', () => nameErr.set(''));
  let isPrivate = room.isPrivate;
  const vis = segmented(
    [
      { id: 'friends', icon: 'users', label: t('voice.visFriends') },
      { id: 'private', icon: 'eyeOff', label: t('voice.visPrivate') },
    ],
    isPrivate ? 'private' : 'friends',
    (v) => (isPrivate = v === 'private'),
    t('voice.visibility'),
  );
  let maxMembers = room.maxMembers;
  const max = selectEl(maxOptions(), maxMembers, (v) => (maxMembers = Number(v)));
  max.id = ids.max;
  let pwMode = 'keep';
  const pw = passwordField({ placeholder: t('voice.newPassword'), label: t('voice.newPassword'), id: ids.pw });
  const pwErr = fieldError(pw.input);
  pw.input.addEventListener('input', () => pwErr.set(''));
  const pwBox = h('div', { class: 'vc-pw-box', hidden: true }, h('label', { class: 'sr-only', for: ids.pw }, t('voice.newPassword')), pw.el, pwErr.el, h('div', { class: 'field-help' }, t('voice.newPasswordHint')));
  const pwSeg = segmented(
    [
      { id: 'keep', label: t(room.hasPassword ? 'voice.pwKeep' : 'voice.pwNone') },
      { id: 'set', label: t(room.hasPassword ? 'voice.pwChange' : 'voice.pwSet') },
      room.hasPassword ? { id: 'clear', label: t('voice.pwRemove') } : null,
    ].filter(Boolean),
    'keep',
    (v) => {
      pwMode = v;
      pwBox.hidden = v !== 'set';
      pwErr.set('');
    },
    t('voice.password'),
  );
  const save = h('button', { class: 'btn primary' }, icon('save'), t('voice.save'));
  const m = modal({
    title: t('voice.editRoomTitle'),
    size: 'vc-editor',
    body: h(
      'div',
      { class: 'stack vc-form' },
      h('div', { class: 'field' }, h('label', { for: ids.name }, t('voice.roomName')), name, nameErr.el),
      h('div', { class: 'field' }, h('span', { class: 'label' }, t('voice.visibility')), vis.el, h('div', { class: 'field-help' }, t('voice.visHint'))),
      h('div', { class: 'field' }, h('label', { for: ids.max }, t('voice.maxMembers')), max),
      h('div', { class: 'field' }, h('span', { class: 'label' }, t('voice.password')), pwSeg.el, pwBox),
    ),
    footer: [h('button', { class: 'btn ghost', onclick: () => m.close() }, t('voice.cancel')), save],
  });
  save.addEventListener('click', async () => {
    const patch = {};
    const n = name.value.trim();
    if (!n) {
      nameErr.set(t('voice.err_bad_name'));
      name.focus();
      return;
    }
    if (n !== room.name) patch.name = n;
    if (isPrivate !== room.isPrivate) patch.isPrivate = isPrivate;
    if (maxMembers !== room.maxMembers) patch.maxMembers = maxMembers;
    if (pwMode === 'set') {
      if (pw.input.value.length < 4) {
        pwErr.set(t('voice.err_bad_password_format'));
        pw.input.focus();
        return;
      }
      patch.password = pw.input.value;
    } else if (pwMode === 'clear') patch.password = '';
    if (!Object.keys(patch).length) {
      m.close();
      return;
    }
    const done = setBusy(save);
    try {
      const updated = await voice.updateRoom(room.id, patch);
      ok(t('voice.roomSaved'), updated?.name || room.name);
      m.close();
      onSaved?.(updated);
    } catch (err) {
      fail(t('voice.saveFailed'), err);
    } finally {
      done();
    }
  });
  setTimeout(() => name.focus(), 30);
  return m;
}

export function fmtPing(ms) {
  return ms === null || ms === undefined ? '' : t('voice.pingMs', { ms });
}

// Frase traducida con un elemento adentro (por ejemplo una tecla): tSlot('voice.hintPtt', 'key', nodo)
// Asi cada idioma ubica la tecla donde corresponde, sin armar la oracion por pedazos.
export function tSlot(key, slot, nodes, vars = {}) {
  const marker = '\u0001';
  const list = [].concat(nodes);
  const out = [];
  t(key, { ...vars, [slot]: marker })
    .split(marker)
    .forEach((part, i) => {
      if (i) out.push(...(i === 1 ? list : list.map((n) => (n instanceof Node ? n.cloneNode(true) : n))));
      if (part) out.push(part);
    });
  return out;
}

// ['Ctrl', 'Shift', 'M'] -> <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>M</kbd>
export function kbdKeys(parts) {
  const out = [];
  parts.forEach((p, i) => {
    if (i) out.push(h('span', { class: 'vc-plus', 'aria-hidden': 'true' }, '+'));
    out.push(h('kbd', { class: 'kbd' }, p));
  });
  return out;
}
