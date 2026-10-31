// Diálogos de las acciones sobre usuarios (en lote o desde la ficha). Cada uno valida, hace la llamada con el
// botón ocupado y muestra el error adentro del diálogo; devuelve el resultado del servidor o null si se canceló.
import { h, icon, modal, setBusy, confirmDialog, selectEl } from '../../ui.js';
import { T, call, field } from './parts.js';

const DURATIONS = ['1h', '24h', '7d', '30d', 'permanent'];

/**
 * Diálogo con un formulario y una acción. run() devuelve el resultado (o lanza el error que se muestra adentro);
 * validate() devuelve un texto de error o null.
 */
function actionDialog({ title, body, okText, okIcon, danger = false, validate, run, size = '' }) {
  return new Promise((resolve) => {
    let done = false;
    const errorBox = h('div', { class: 'notice bad adm-dialog-error', role: 'alert', hidden: true });
    const okBtn = h('button', { class: `btn ${danger ? 'danger adm-danger-solid' : 'primary'}`, type: 'button' }, okIcon ? icon(okIcon) : null, okText);
    const finish = (value) => {
      if (done) return;
      done = true;
      m.close();
      resolve(value);
    };
    const showError = (text) => {
      errorBox.hidden = !text;
      errorBox.replaceChildren(icon('alert'), h('div', {}, text || ''));
    };
    okBtn.addEventListener('click', async () => {
      const problem = validate ? validate() : null;
      if (problem) return showError(problem);
      showError(null);
      const release = setBusy(okBtn);
      try {
        const res = await run();
        release();
        finish(res);
      } catch (err) {
        release();
        showError(err?.message || String(err));
      }
    });
    const m = modal({
      title,
      size,
      body: h('div', { class: 'stack adm-dialog' }, body, errorBox),
      footer: [h('button', { class: 'btn ghost', type: 'button', onclick: () => finish(null) }, T('cancel')), okBtn],
      onClose: () => finish(null),
    });
    m.el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target instanceof HTMLInputElement && e.target.type !== 'checkbox' && !okBtn.disabled) {
        e.preventDefault();
        okBtn.click();
      }
    });
  });
}

const who = (users) => (users.length === 1 ? users[0].name : null);
const ids = (users) => users.map((u) => u.id);

function targetLine(users) {
  return h('p', { class: 'adm-target' }, users.length === 1 ? T('targetOne', { name: users[0].name }) : T('targetMany', { count: users.length }));
}

function durationSelect(value = '24h') {
  return selectEl(DURATIONS.map((d) => ({ value: d, label: T(`dur_${d}`) })), value, null, 'select');
}

// ---------- Plan ----------

export function removePlanDialog(users) {
  return actionDialog({
    title: T('removePlanTitle', { count: users.length }),
    body: h('div', { class: 'stack' }, h('p', { class: 'text-2' }, who(users) ? T('removePlanTextOne', { name: who(users) }) : T('removePlanTextMany', { count: users.length })), h('div', { class: 'notice info' }, icon('info'), h('div', {}, T('supportActivationHint')))),
    okText: T('act_removePlan'),
    okIcon: 'x',
    danger: true,
    run: () => call('users.removePlan', { ids: ids(users) }),
  });
}

// ---------- Moderación ----------

export function banDialog(users) {
  const duration = durationSelect('7d');
  const reason = h('textarea', { class: 'textarea', rows: 3, maxlength: 500, placeholder: T('reasonPlaceholder') });
  return actionDialog({
    title: T('banTitle', { count: users.length }),
    body: h('div', { class: 'stack' }, targetLine(users), field(T('durationField'), duration), field(T('reasonField'), reason, T('reasonHelp')), h('div', { class: 'notice bad' }, icon('ban'), h('div', {}, T('banHint')))),
    okText: T('act_ban'),
    okIcon: 'ban',
    danger: true,
    validate: () => (reason.value.trim() ? null : T('reasonRequired')),
    run: () => call('users.ban', { ids: ids(users), duration: duration.value, reason: reason.value.trim() }),
  });
}

export function muteDialog(users) {
  const duration = durationSelect('24h');
  const reason = h('textarea', { class: 'textarea', rows: 2, maxlength: 500, placeholder: T('reasonPlaceholder') });
  return actionDialog({
    title: T('muteTitle', { count: users.length }),
    body: h('div', { class: 'stack' }, targetLine(users), field(T('durationField'), duration), field(T('reasonOptional'), reason), h('div', { class: 'notice info' }, icon('volumeX'), h('div', {}, T('muteHint')))),
    okText: T('act_mute'),
    okIcon: 'volumeX',
    run: () => call('users.mute', { ids: ids(users), duration: duration.value, reason: reason.value.trim() || null }),
  });
}

/** Desbanear, quitar el silencio o cerrar sesiones: una confirmación y la llamada. */
export async function simpleAction(users, action) {
  const keys = { 'users.unban': 'unban', 'users.unmute': 'unmute', 'users.signOut': 'signOut' };
  const k = keys[action];
  const yes = await confirmDialog(T(`${k}Title`, { count: users.length }), who(users) ? T(`${k}TextOne`, { name: who(users) }) : T(`${k}TextMany`, { count: users.length }), {
    okText: T(`act_${k}`),
    cancelText: T('cancel'),
  });
  if (!yes) return null;
  return call(action, { ids: ids(users) });
}

export function resetUsageDialog(users) {
  const scope = selectEl([{ value: 'today', label: T('scope_today') }, { value: 'week', label: T('scope_week') }], 'today', null, 'select');
  return actionDialog({
    title: T('resetTitle', { count: users.length }),
    body: h('div', { class: 'stack' }, targetLine(users), field(T('scopeField'), scope), h('div', { class: 'notice info' }, icon('info'), h('div', {}, T('resetHint')))),
    okText: T('act_resetUsage'),
    okIcon: 'refresh',
    run: () => call('users.resetUsage', { ids: ids(users), scope: scope.value }),
  });
}

// ---------- Eliminar (doble confirmación) ----------

export async function deleteDialog(users) {
  const word = T('deleteWord');
  const typed = h('input', { class: 'input mono', autocomplete: 'off', spellcheck: 'false', 'aria-label': T('deleteTypeLabel', { word }) });
  const purge = h('input', { type: 'checkbox', checked: true, id: 'adm-del-files' });
  const list =
    users.length > 1
      ? h(
          'ul',
          { class: 'adm-del-list' },
          users.slice(0, 8).map((u) => h('li', { class: 'ellipsis' }, u.name)),
          users.length > 8 ? h('li', { class: 'muted' }, T('andMore', { count: users.length - 8 })) : null,
        )
      : null;
  const body = h(
    'div',
    { class: 'stack' },
    h('div', { class: 'notice bad' }, icon('alert'), h('div', {}, h('b', {}, T('deleteWarnTitle')), h('div', {}, T('deleteText')))),
    targetLine(users),
    list,
    h('div', { class: 'notice info' }, icon('info'), h('div', {}, T('deleteStripe'))),
    h('label', { class: 'adm-check', for: 'adm-del-files' }, purge, T('deleteFiles')),
    h('div', { class: 'field' }, h('label', { class: 'label', for: 'adm-del-type' }, T('deleteTypeLabel', { word })), typed),
  );
  typed.id = 'adm-del-type';
  return actionDialog({
    title: T('deleteTitle', { count: users.length }),
    body,
    okText: T('confirmDelete'),
    okIcon: 'trash',
    danger: true,
    validate: () => (typed.value.trim().toUpperCase() === word.toUpperCase() ? null : T('deleteTypeError', { word })),
    run: async () => {
      // Segunda confirmación, aparte: es lo único que no se puede deshacer.
      const sure = await confirmDialog(
        T('deleteSecondTitle'),
        who(users) ? T('deleteSecondTextOne', { name: who(users) }) : T('deleteSecondTextMany', { count: users.length }),
        { okText: T('confirmDelete'), cancelText: T('cancel'), danger: true },
      );
      if (!sure) throw new Error(T('deleteAborted'));
      return call('users.delete', { ids: ids(users), confirm: true, cancelStripe: true, purgeFiles: purge.checked });
    },
  });
}

// ---------- Stripe ----------

export function cancelStripeDialog(user) {
  const when = selectEl([{ value: 'now', label: T('when_now') }, { value: 'period_end', label: T('when_period_end') }], 'now', null, 'select');
  return actionDialog({
    title: T('cancelStripeTitle'),
    body: h('div', { class: 'stack' }, targetLine([user]), field(T('cancelWhen'), when), h('div', { class: 'notice' }, icon('alert'), h('div', {}, T('cancelStripeText')))),
    okText: T('act_cancelStripe'),
    okIcon: 'x',
    danger: true,
    run: () => call('stripe.cancelSubscription', { userId: user.id, when: when.value }),
  });
}

export { actionDialog };
