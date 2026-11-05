// Piezas del respaldo del Voice Chat en el lobby: aviso de servidor caido, salas guardadas (con su clave, para entrar
// sin servidor) y la sala de emergencia (crear una o entrar con un codigo de respaldo).
import { h, icon, mount, fail, copyText, setBusy, confirmDialog, sectionTitle } from '../ui.js';
import { t } from '../i18n.js';
import { voice } from '../voice.js';
import { parseBackupCode } from './rescue.js';
import { fieldId } from './ui-common.js';

export function serverDownNotice() {
  return h('div', { class: 'notice vc-down', role: 'status' }, icon('cloud'), h('div', {}, h('strong', {}, t('voice.serverDownTitle')), h('div', {}, t('voice.serverDownText'))));
}

// Salas guardadas en este equipo con su clave de respaldo. Con el servidor andando solo se ven las de emergencia (las
// demas ya estan en "mis salas" y "recientes"); con el servidor caido, todas.
export function savedRoomsSection(onChange) {
  const list = h('div', { class: 'vc-rooms' });
  const el = h('div', { class: 'vc-section', hidden: true }, sectionTitle(t('voice.savedRoomsTitle')), h('p', { class: 'vc-saved-hint' }, t('voice.savedRoomsHint')), list);

  function row(r) {
    const enter = h('button', { class: 'btn sm good', type: 'button' }, icon('logIn'), t('voice.enter'));
    enter.addEventListener('click', async () => {
      const done = setBusy(enter);
      try {
        await voice.joinSaved(r.code);
      } catch (err) {
        fail(t('voice.joinFailed'), err);
      } finally {
        done();
      }
    });
    const actions = [enter];
    if (r.backupCode) actions.push(h('button', { class: 'icon-btn sm', type: 'button', title: t('voice.copyBackupCode'), 'aria-label': t('voice.copyBackupCode'), onclick: () => copyText(r.backupCode, t('voice.backupCodeCopied')) }, icon('copy')));
    actions.push(
      h(
        'button',
        {
          class: 'icon-btn sm',
          type: 'button',
          title: t('voice.forgetSavedRoom'),
          'aria-label': t('voice.forgetSavedRoom'),
          onclick: async () => {
            if (!(await confirmDialog(t('voice.forgetRoomTitle'), t('voice.forgetRoomText', { name: r.name }), { okText: t('voice.forgetRoom') }))) return;
            voice.forgetSaved(r.code);
            onChange?.();
          },
        },
        icon('x'),
      ),
    );
    return h(
      'div',
      { class: 'vc-room-item' },
      h('div', { class: 'vc-room-icon', 'aria-hidden': 'true' }, icon(r.emergency ? 'shield' : 'mic')),
      h(
        'div',
        { class: 'vc-room-main' },
        h('div', { class: 'vc-room-title' }, h('span', { class: 'ellipsis', title: r.name }, r.name), h('span', { class: 'kbd vc-room-code priv', title: t('voice.roomCode') }, r.code)),
        h('div', { class: 'vc-room-sub' }, r.emergency ? h('span', { class: 'badge warn' }, icon('shield'), t('voice.savedRoomEmergency')) : null),
      ),
      h('div', { class: 'vc-room-actions' }, actions),
    );
  }

  return {
    el,
    refresh({ all = false } = {}) {
      const rooms = voice.savedRooms().filter((r) => all || r.emergency);
      el.hidden = !rooms.length;
      mount(list, rooms.map(row));
    },
  };
}

// Tarjeta plegable: crear una sala de emergencia o entrar con un codigo de respaldo. Sirve sin cuenta y sin servidor.
export function emergencyCard({ open = false } = {}) {
  const ids = { name: fieldId('vc-em-name'), code: fieldId('vc-em-code'), hint: fieldId('vc-em-hint') };
  const name = h('input', { class: 'input', id: ids.name, maxlength: 40, placeholder: t('voice.emergencyRoomName'), autocomplete: 'off' });
  const create = h('button', { class: 'btn', type: 'button' }, icon('shield'), t('voice.emergencyCreate'));
  create.addEventListener('click', async () => {
    const done = setBusy(create);
    try {
      await voice.createRoom({ emergency: true, name: name.value.trim() || undefined });
    } catch (err) {
      fail(t('voice.createFailed'), err);
    } finally {
      done();
    }
  });
  const code = h('input', { class: 'input vc-backup-input', id: ids.code, maxlength: 90, placeholder: t('voice.emergencyJoinPlaceholder'), autocomplete: 'off', spellcheck: 'false', 'aria-describedby': ids.hint });
  const join = h('button', { class: 'btn', type: 'button', disabled: true }, icon('logIn'), t('voice.joinBtn'));
  const sync = () => {
    const ok = Boolean(parseBackupCode(code.value));
    join.disabled = !ok;
    join.classList.toggle('good', ok);
  };
  const submit = async () => {
    if (join.disabled) return;
    const done = setBusy(join);
    try {
      await voice.joinRoom(code.value);
    } catch (err) {
      fail(t('voice.joinFailed'), err);
    } finally {
      done();
      sync();
    }
  };
  code.addEventListener('input', sync);
  code.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
  join.addEventListener('click', submit);
  const details = h(
    'details',
    { class: 'card vc-emergency' },
    h('summary', {}, icon('shield'), h('span', { class: 'vc-em-title' }, t('voice.emergencyTitle')), h('span', { class: 'vc-em-sub' }, t('voice.emergencySub'))),
    h(
      'div',
      { class: 'vc-em-body' },
      h('div', { class: 'vc-em-col' }, h('div', { class: 'field' }, h('label', { for: ids.name }, t('voice.roomName')), name), h('div', { class: 'vc-card-foot' }, create)),
      h('div', { class: 'vc-em-col' }, h('div', { class: 'field' }, h('label', { for: ids.code }, t('voice.backupCodeLabel')), code, h('div', { class: 'field-help', id: ids.hint }, t('voice.emergencyJoinHint'))), h('div', { class: 'vc-card-foot' }, join)),
    ),
  );
  details.open = open;
  return {
    el: details,
    open(on = true) {
      details.open = on;
    },
  };
}
