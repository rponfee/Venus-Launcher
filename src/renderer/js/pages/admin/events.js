// Pestaña Eventos: el calendario que ve la gente en Competir. Crear, cambiar y borrar eventos y torneos con las RPC admin_event*
// de 0031 (admin_guard: solo administradores; cada cambio queda en el registro). Sus textos están en el namespace compete,
// que esta pestaña carga por su cuenta. Las fechas se escriben en la hora de la PC y se guardan en UTC.
import { h, icon, mount, setBusy, ok, fail, confirmDialog, ensureCss, emptyState } from '../../ui.js';
import { t, loadNs } from '../../i18n.js';
import { competeBackend, errText } from '../../features/compete.js';
import { eventRange, signupsText } from '../compete/format.js';
import { normalizeEvent, toLocalInput, validateEventForm } from '../compete/logic.js';
import { card, errorBox, skeletonRows, field } from './parts.js';

const C = (key, vars) => t(`compete.${key}`, vars);

export function render(root) {
  let b = null;
  let editing = null;
  const formHost = h('div');
  const listHost = h('div');

  function form() {
    const ev = editing;
    const title = h('input', { class: 'input', maxlength: '80', value: ev?.title || '' });
    const description = h('textarea', { class: 'textarea', rows: '4', maxlength: '2000' }, ev?.description || '');
    const kind = h('select', { class: 'select' }, ['event', 'tournament'].map((k) => h('option', { value: k, selected: (ev?.kind || 'event') === k }, C(`kind_${k}`))));
    const startsAt = h('input', { class: 'input', type: 'datetime-local', value: ev ? toLocalInput(ev.startsAt) : '' });
    const endsAt = h('input', { class: 'input', type: 'datetime-local', value: ev ? toLocalInput(ev.endsAt) : '' });
    const capacity = h('input', { class: 'input num', type: 'number', min: '1', max: '100000', value: ev?.capacity ?? '' });
    const server = h('input', { class: 'input mono', maxlength: '126', placeholder: 'mc.ejemplo.com:25565', value: ev?.server || '' });
    const link = h('input', { class: 'input mono', maxlength: '308', placeholder: 'https://', value: ev?.link || '' });
    const error = h('div', { class: 'field-error', role: 'alert', hidden: true });
    const showError = (text) => {
      mount(error, icon('alert'), h('span', {}, text));
      error.hidden = false;
    };
    const save = h('button', { class: 'btn primary sm', type: 'button' }, icon('save'), C('admSave'));
    save.addEventListener('click', async () => {
      error.hidden = true;
      const check = validateEventForm({ id: ev?.id, title: title.value, description: description.value, kind: kind.value, startsAt: startsAt.value, endsAt: endsAt.value, capacity: capacity.value, server: server.value, link: link.value });
      if (!check.ok) return showError(C(`admError_${check.error}`));
      const done = setBusy(save);
      try {
        await b.rpc('admin_event_save', { p: check.payload });
        ok(C('admSaved'));
        editing = null;
        drawForm();
        loadList();
      } catch (err) {
        showError(errText(err));
      } finally {
        done();
      }
      return undefined;
    });
    const cancel = ev ? h('button', { class: 'btn sm ghost', type: 'button', onclick: () => { editing = null; drawForm(); } }, C('admCancelEdit')) : null;
    return card({ icon: ev ? 'edit' : 'plus', title: ev ? C('admEdit') : C('admNew'), sub: C('admHint'), actions: [cancel, save] },
      h('div', { class: 'cp-adm-grid' },
        field(C('admTitle'), title),
        field(C('admKind'), kind),
        field(C('admStarts'), startsAt),
        field(C('admEnds'), endsAt),
        field(C('admCapacity'), capacity, C('admCapacityHint')),
        field(C('admServer'), server, C('admOptional')),
        field(C('admLink'), link, C('admLinkHint'))),
      field(C('admDescription'), description, C('admDescriptionHint')),
      error);
  }

  const drawForm = () => mount(formHost, form());

  function rowView(ev) {
    const del = h('button', { class: 'icon-btn sm', type: 'button', title: C('admDelete'), 'aria-label': C('admDelete') }, icon('trash'));
    del.addEventListener('click', async () => {
      if (!(await confirmDialog(C('admDelete'), C('admDeleteText', { title: ev.title, n: ev.signups }), { danger: true }))) return;
      const done = setBusy(del);
      try {
        await b.rpc('admin_event_delete', { p_id: ev.id });
        ok(C('admDeleted'));
        if (editing?.id === ev.id) {
          editing = null;
          drawForm();
        }
        loadList();
      } catch (err) {
        fail(C('actionError'), errText(err));
      } finally {
        done();
      }
    });
    const edit = h('button', { class: 'icon-btn sm', type: 'button', title: C('admEdit'), 'aria-label': C('admEdit'), onclick: () => { editing = ev; drawForm(); formHost.scrollIntoView({ block: 'nearest' }); } }, icon('edit'));
    return h('tr', {},
      h('td', {}, h('strong', {}, ev.title)),
      h('td', {}, C(`kind_${ev.kind}`)),
      h('td', {}, eventRange(ev)),
      h('td', { class: 'num' }, signupsText(ev)),
      h('td', {}, h('div', { class: 'cp-adm-actions' }, edit, del)));
  }

  async function loadList() {
    mount(listHost, skeletonRows(4));
    let rows;
    try {
      rows = await b.rpc('admin_events');
    } catch (err) {
      if (root.isConnected) mount(listHost, errorBox({ message: errText(err) }, loadList));
      return;
    }
    if (!root.isConnected) return;
    const list = (rows || []).map(normalizeEvent).filter(Boolean);
    mount(listHost, card({ icon: 'calendar', title: C('admList') },
      list.length
        ? h('div', { class: 'adm-scroll' }, h('table', { class: 'adm-table' },
          h('thead', {}, h('tr', {}, h('th', {}, C('admTitle')), h('th', {}, C('admKind')), h('th', {}, C('evWhen')), h('th', {}, C('evSignups')), h('th', {}))),
          h('tbody', {}, list.map(rowView))))
        : emptyState('calendar', C('admEmpty'), null)));
  }

  (async () => {
    mount(root, skeletonRows(4));
    try {
      await loadNs('compete');
      ensureCss('pages/compete');
      b = await competeBackend();
    } catch (err) {
      if (root.isConnected) mount(root, errorBox(err));
      return;
    }
    if (!root.isConnected) return;
    mount(root, h('p', { class: 'adm-note' }, C('admNote')), formHost, listHost);
    drawForm();
    loadList();
  })();

  return { refresh: () => (b ? loadList() : null) };
}
