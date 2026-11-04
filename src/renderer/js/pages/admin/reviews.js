// Panel de administración: reseñas de servidores destacados (3.2). render(root) dibuja admin_reviews_list (0029) con
// los filtros Denunciadas, Ocultas y Todas, y las acciones Ocultar o Mostrar, Descartar denuncias y Borrar, que quedan
// en el registro (admin_log). El texto es de los usuarios: siempre como texto. Lo enchufa pages/admin.js.
import { h, icon, mount, ok, fail, setBusy, skeleton, emptyState, fmtAgo, fmtDate, fmtTime, ensureCss, confirmDialog } from '../../ui.js';
import { t, loadNs } from '../../i18n.js';
import * as backend from '../../features/serverreviews/backend.js';
import { classifyError, cleanBody } from '../../features/serverreviews/logic.js';

const R = (key, vars) => t(`multiplayer.rev_admin_${key}`, vars);
const FILTERS = ['reported', 'hidden', 'all'];

export async function render(root) {
  ensureCss('features/serverremote');
  await loadNs('multiplayer');
  let filter = 'reported';
  let rows = [];
  let req = 0;
  const seg = h('div', { class: 'segmented', role: 'group', 'aria-label': R('filter') });
  const list = h('div', { class: 'stack' });
  const foot = h('div', { class: 'row', style: { justifyContent: 'center' } });
  const reload = h('button', { class: 'btn sm', type: 'button', onclick: () => load() }, icon('refresh'), R('reload'));
  mount(root, h('div', { class: 'page-head' }, h('div', { class: 'ph-text' }, h('h2', { class: 'page-title' }, R('title')), h('p', { class: 'page-sub' }, R('subtitle'))), h('div', { class: 'page-actions' }, reload)), seg, list, foot);

  function drawSeg() {
    mount(seg, FILTERS.map((f) => h('button', { class: [f === filter && 'active'], type: 'button', 'aria-pressed': String(f === filter), onclick: () => { filter = f; drawSeg(); load(); } }, R(`filter_${f}`))));
  }

  const nameOf = (u) => cleanBody(u?.displayName || u?.username || '', 32) || t('multiplayer.rev_someone');

  function row(r) {
    const act = (btn, fn, msg, opts) => async () => {
      if (opts && !(await confirmDialog(opts.title, opts.text, { danger: true, okText: opts.ok }))) return;
      const release = setBusy(btn);
      try {
        await fn();
        ok(msg);
        load();
      } catch (err) {
        console.warn('[admin] reseñas:', err?.message || err);
        fail(R('actionFail'), R(`err_${classifyError(err) === 'admin_only' ? 'forbidden' : 'other'}`));
      } finally {
        release();
      }
    };
    const hide = h('button', { class: 'btn sm', type: 'button' }, icon(r.hidden ? 'eye' : 'eyeOff'), r.hidden ? R('show') : R('hide'));
    hide.addEventListener('click', act(hide, () => backend.adminSetHidden(r.id, !r.hidden), r.hidden ? R('shown') : R('hiddenOk')));
    const dismiss = h('button', { class: 'btn sm ghost', type: 'button', disabled: !r.openReports }, icon('check'), R('dismiss'));
    dismiss.addEventListener('click', act(dismiss, () => backend.adminDismiss(r.id), R('dismissed')));
    const del = h('button', { class: 'btn sm danger', type: 'button' }, icon('trash'), R('delete'));
    del.addEventListener('click', act(del, () => backend.adminDelete(r.id), R('deleted'), { title: R('deleteTitle'), text: R('deleteText'), ok: R('delete') }));
    const at = Date.parse(r.at);
    return h(
      'div',
      { class: ['card', 'srv-admin-row', r.hidden && 'hidden-review'] },
      h(
        'div',
        { class: 'srv-admin-head' },
        r.hidden ? h('span', { class: 'pill warn' }, R('badgeHidden')) : null,
        r.openReports ? h('span', { class: 'pill bad' }, R('badgeReports', { count: r.openReports })) : null,
        h('strong', {}, cleanBody(r.server?.name || '', 64)),
        h('span', { class: 'badge' }, `${Number(r.stars) || 0}/5`),
        h('span', { class: 'spacer' }),
        h('span', { class: 'small muted', title: Number.isFinite(at) ? `${fmtDate(at)} ${fmtTime(at)}` : '' }, Number.isFinite(at) ? fmtAgo(at) : ''),
      ),
      h('div', { class: 'small text-2' }, R('by', { name: nameOf(r.author) })),
      r.body ? h('p', { class: 'srv-body' }, cleanBody(r.body)) : h('p', { class: 'small muted' }, R('noText')),
      r.reports?.length
        ? h('ul', { class: 'srv-admin-reports' }, r.reports.map((x) => h('li', {}, R(`reason_${['spam', 'abuse', 'other'].includes(x.reason) ? x.reason : 'other'}`), x.text ? `: ${cleanBody(x.text)}` : '', ' · ', R('reporter', { name: cleanBody(x.reporter || '', 32) || t('multiplayer.rev_someone') }))))
        : null,
      h('div', { class: 'row wrap' }, hide, dismiss, del),
    );
  }

  function drawFoot(hasMore) {
    if (!hasMore) return mount(foot, null);
    const btn = h('button', { class: 'btn sm', type: 'button' }, icon('chevronDown'), R('more'));
    btn.addEventListener('click', async () => {
      const release = setBusy(btn);
      const before = rows.map((r) => r.at).filter(Boolean).sort()[0];
      try {
        const page = await backend.adminList(filter, before);
        rows = [...rows, ...(Array.isArray(page) ? page : [])];
        mount(list, rows.map(row));
        drawFoot(Array.isArray(page) && page.length >= 50);
      } catch (err) {
        console.warn('[admin] reseñas:', err?.message || err);
        fail(R('loadFail'), R('err_other'));
      } finally {
        release();
      }
    });
    return mount(foot, btn);
  }

  async function load() {
    const mine = ++req;
    mount(list, skeleton('list', { rows: 4, label: R('loading') }));
    mount(foot, null);
    try {
      const data = await backend.adminList(filter);
      if (mine !== req) return;
      rows = Array.isArray(data) ? data : [];
      if (!rows.length) {
        mount(list, emptyState('shield', R(`empty_${filter}`), ''));
        return;
      }
      mount(list, rows.map(row));
      drawFoot(rows.length >= 50);
    } catch (err) {
      if (mine !== req) return;
      console.warn('[admin] reseñas:', err?.message || err);
      mount(list, emptyState('alert', R('loadFail'), ''));
    }
  }

  drawSeg();
  load();
}
