// Administración de comunidades: buscar y disolver, cola de GIFs subidos (aprobar, rechazar con motivo, retirar) y denuncias de
// mensajes, comunidades y GIFs ya aprobados. RPC admin_group* de 0033 y admin_community_media* de 0038 (admin_guard: solo
// administradores; lo que cambia algo queda en admin_log). Sus textos están en el namespace communities, que esta pestaña carga por
// su cuenta. Lo que escribe la gente va siempre como texto.
import { h, icon, mount, modal, ok, fail, setBusy, confirmDialog, promptDialog, emptyState, ensureCss, debounce, fmtAgo, fmtDate, skeleton } from '../../ui.js';
import { t, loadNs } from '../../i18n.js';
import { groupsBackend, errText } from '../../features/communities/backend.js';
import { mediaImage } from '../communities/media-view.js';

const C = (key, vars) => t(`communities.${key}`, vars);
const nameOf = (p) => String(p?.displayName || p?.username || '').trim() || C('someone');
const SECTIONS = [{ id: 'media', icon: 'image' }, { id: 'community', icon: 'users' }, { id: 'reports', icon: 'alert' }];
const MEDIA_FILTERS = ['pending', 'approved', 'rejected', 'removed'];

export async function render(root) {
  ensureCss('pages/communities');
  await loadNs('communities');
  const b = await groupsBackend();
  let section = 'media';
  let mediaFilter = 'pending';
  let pendingCount = null;
  const seg = h('div', { class: 'segmented cl-seg', role: 'group', 'aria-label': t('nav.communities') });
  const host = h('div', { class: 'stack' });

  const askReason = (title) => promptDialog(title, C('adminReason'), { okText: C('adminConfirm') });
  const preview = (item, size = 'md') => mediaImage(b, { kind: 'upload', path: item.path, name: item.name, width: item.width, height: item.height }, { size, alt: item.name });

  async function openDetail(row, reload) {
    const kind = 'community';
    const body = h('div', { class: 'stack' }, skeleton('list', { rows: 4 }));
    const m = modal({ title: row.name, subtitle: C(row.isPublic ? 'visibility_public' : 'visibility_code'), icon: 'users', body });
    async function load() {
      try {
        const detail = await b.rpc('admin_group_detail', { p_kind: kind, p_id: row.id });
        mount(body,
          detail.description ? h('p', { class: 'cl-desc selectable' }, detail.description) : null,
          detail.channels ? h('div', { class: 'cl-chips' }, detail.channels.map((c) => h('span', { class: 'badge' }, icon(c.kind === 'voice' ? 'volume' : 'hash'), c.name))) : null,
          h('h4', { class: 'cl-h4' }, C('membersTotal', { n: detail.memberCount ?? detail.members.length })),
          h('ul', { class: 'cl-list' }, (detail.members || []).map((p) => {
            const remove = h('button', { class: 'btn sm danger', type: 'button' }, icon('ban'), C('adminRemove'));
            remove.addEventListener('click', async () => {
              const reason = await askReason(C('adminRemoveTitle', { name: nameOf(p) }));
              if (reason === null) return;
              const done = setBusy(remove);
              try {
                await b.rpc('admin_group_remove', { p_kind: kind, p_id: row.id, p_user: p.userId, p_reason: reason || null });
                ok(C('adminRemoved'));
                load();
                reload();
              } catch (err) {
                fail(C('actionError'), errText(err));
              } finally {
                done();
              }
            });
            return h('li', { class: 'cl-row' }, h('span', { class: 'cl-row-name ellipsis selectable' }, nameOf(p)), h('span', { class: 'badge' }, C(`role_${p.role}`)), remove);
          })));
      } catch (err) {
        mount(body, emptyState('alert', errText(err), ''));
        if (err?.code === 'not_found') m.close();
      }
    }
    load();
  }

  function groupsView() {
    const kind = 'community';
    const search = h('input', { class: 'input', type: 'search', placeholder: C('adminSearch'), 'aria-label': C('adminSearch'), maxlength: '40' });
    const list = h('div', { class: 'stack', 'aria-live': 'polite' });
    let seq = 0;
    function row(g) {
      const lead = g.owner;
      const dissolve = h('button', { class: 'btn sm danger', type: 'button' }, icon('trash'), C('adminDissolve'));
      dissolve.addEventListener('click', async () => {
        if (!(await confirmDialog(C('adminDissolveTitle'), C('adminDissolveText', { name: g.name, n: g.memberCount ?? 0 }), { okText: C('adminDissolve'), danger: true }))) return;
        const reason = await askReason(C('adminDissolveTitle'));
        if (reason === null) return;
        const done = setBusy(dissolve);
        try {
          await b.rpc('admin_group_dissolve', { p_kind: kind, p_id: g.id, p_reason: reason || null });
          ok(C('adminDissolved'));
          load();
        } catch (err) {
          fail(C('actionError'), errText(err));
        } finally {
          done();
        }
      });
      return h('article', { class: 'card cl-clan-row' },
        h('span', { class: 'cm-card-icon', 'aria-hidden': 'true' }, icon(g.isPublic ? 'globe' : 'lock')),
        h('div', { class: 'cl-clan-main' },
          h('div', { class: 'cl-clan-name' }, h('strong', { class: 'ellipsis selectable' }, g.name), g.reports ? h('span', { class: 'badge warn' }, icon('alert'), String(g.reports)) : null),
          h('div', { class: 'cl-muted small' }, C('adminRowSub', { lead: lead ? nameOf(lead) : '—', n: g.memberCount ?? 0, date: fmtDate(Date.parse(g.createdAt)) }))),
        h('div', { class: 'row' }, h('button', { class: 'btn sm', type: 'button', onclick: () => openDetail(g, load) }, icon('eye'), C('view')), dissolve));
    }
    async function load() {
      const my = ++seq;
      mount(list, skeleton('list', { rows: 4 }));
      try {
        const rows = await b.rpc('admin_groups', { p_kind: kind, p_query: search.value.trim() });
        if (my !== seq || !root.isConnected) return;
        mount(list, rows?.length ? rows.map(row) : emptyState('search', C('adminEmpty'), ''));
      } catch (err) {
        if (my === seq && root.isConnected) mount(list, emptyState('alert', errText(err), ''));
      }
    }
    search.addEventListener('input', debounce(load, 300));
    mount(host, h('div', { class: 'input-icon cl-search' }, icon('search'), search), list);
    load();
  }

  // Cola de GIFs subidos por las comunidades: nada se ve para otros hasta que alguien de Venus lo aprueba.
  function mediaView() {
    const filters = h('div', { class: 'segmented cl-seg', role: 'group', 'aria-label': C('adminMediaFilter') });
    const note = h('p', { class: 'cl-note' }, icon('shieldCheck'), h('span', {}, C('adminMediaNote')));
    const list = h('div', { class: 'cm-admin-media', 'aria-live': 'polite' });
    let seq = 0;
    const drawFilters = () => mount(filters, MEDIA_FILTERS.map((s) => h('button', { type: 'button', class: s === mediaFilter ? 'active' : null, 'aria-pressed': String(s === mediaFilter), onclick: () => { mediaFilter = s; drawFilters(); load(); } },
      C(`mediaStatus_${s}`), s === 'pending' && pendingCount ? h('span', { class: 'badge warn' }, String(pendingCount)) : null)));
    function card(item) {
      const act = (btn, decision, needReason) => async () => {
        let reason = null;
        if (needReason) {
          reason = await askReason(C(decision === 'reject' ? 'adminMediaRejectTitle' : 'adminMediaRemoveTitle', { name: item.name }));
          if (reason === null) return;
        }
        const done = setBusy(btn);
        try {
          await b.rpc('admin_community_media_review', { p_id: item.id, p_decision: decision, p_reason: reason });
          ok(C(`adminMedia_${decision}`));
          load();
        } catch (err) {
          fail(C('actionError'), errText(err));
        } finally {
          done();
        }
      };
      const approve = item.status === 'pending' ? h('button', { class: 'btn sm primary cm-admin-approve', type: 'button' }, icon('check'), C('adminMediaApprove')) : null;
      const reject = item.status === 'pending' ? h('button', { class: 'btn sm danger cm-admin-reject', type: 'button' }, icon('x'), C('adminMediaReject')) : null;
      const remove = item.status === 'approved' ? h('button', { class: 'btn sm danger', type: 'button' }, icon('trash'), C('adminMediaRemove')) : null;
      approve?.addEventListener('click', act(approve, 'approve', false));
      reject?.addEventListener('click', act(reject, 'reject', true));
      remove?.addEventListener('click', act(remove, 'remove', true));
      return h('article', { class: 'card cm-admin-media-card', dataset: { id: item.id, status: item.status } },
        h('div', { class: 'cm-admin-media-preview' }, preview(item, 'lg')),
        h('div', { class: 'cm-admin-media-main' },
          h('div', { class: 'row wrap' }, h('strong', { class: 'selectable' }, item.name), item.reports ? h('span', { class: 'badge warn' }, icon('alert'), C('adminMediaReports', { n: item.reports })) : null),
          h('div', { class: 'cl-muted small selectable' }, C('adminMediaFrom', { community: item.community || '—', user: item.uploadedBy ? nameOf(item.uploadedBy) : '—' })),
          h('div', { class: 'cl-muted small' }, `${item.width}×${item.height} · ${Math.max(1, Math.round((item.bytes || 0) / 1024))} KB · ${item.mime} · ${fmtAgo(Date.parse(item.createdAt))}`),
          item.rejectReason ? h('p', { class: 'cl-quote selectable' }, item.rejectReason === 'report' ? C('mediaRemovedReport') : item.rejectReason) : null,
          h('div', { class: 'row wrap' }, approve, reject, remove)));
    }
    async function load() {
      const my = ++seq;
      mount(list, skeleton('grid', { items: 2, min: 320, lines: 3 }));
      try {
        const res = await b.rpc('admin_community_media_queue', { p_status: mediaFilter, p_limit: 50, p_offset: 0 });
        if (my !== seq || !root.isConnected) return;
        pendingCount = Number(res?.pending) || 0;
        drawFilters();
        const rows = Array.isArray(res?.items) ? res.items : [];
        mount(list, rows.length ? rows.map(card) : emptyState(mediaFilter === 'pending' ? 'check' : 'image', C(mediaFilter === 'pending' ? 'adminMediaEmptyPending' : 'adminMediaEmpty'), ''));
      } catch (err) {
        if (my === seq && root.isConnected) mount(list, emptyState('alert', errText(err), ''));
      }
    }
    drawFilters();
    mount(host, filters, note, list);
    load();
  }

  function reportsView() {
    const list = h('div', { class: 'stack' }, skeleton('list', { rows: 3 }));
    mount(host, list);
    async function load() {
      try {
        const rows = (await b.rpc('admin_group_reports'))?.filter((row) => ['community', 'message', 'media'].includes(row.kind));
        if (!root.isConnected) return;
        if (!rows?.length) return mount(list, emptyState('shield', C('adminReportsEmpty'), ''));
        return mount(list, rows.map((r) => {
          const open = r.status === 'open';
          const close = h('button', { class: 'btn sm', type: 'button', disabled: !open }, icon('check'), C('adminReportClose'));
          const removable = r.kind === 'message' || r.kind === 'media';
          const removeMsg = removable ? h('button', { class: 'btn sm danger', type: 'button', disabled: !open }, icon('trash'), C(r.kind === 'media' ? 'adminReportRemoveMedia' : 'adminReportRemove')) : null;
          const act = (btn, remove) => async () => {
            const done = setBusy(btn);
            try {
              await b.rpc('admin_group_report_close', { p_id: r.id, p_remove: remove });
              ok(C('adminReportClosed'));
              load();
            } catch (err) {
              fail(C('actionError'), errText(err));
            } finally {
              done();
            }
          };
          close.addEventListener('click', act(close, false));
          removeMsg?.addEventListener('click', act(removeMsg, true));
          const snap = r.snapshot || {};
          return h('article', { class: ['card', 'cl-card', !open && 'cl-closed'] },
            h('div', { class: 'cl-chips' },
              h('span', { class: ['pill', open ? 'warn' : 'good'] }, open ? C('adminReportOpen') : C('adminReportDone')),
              h('span', { class: 'badge' }, C(`reportKind_${r.kind}`)),
              h('span', { class: 'badge' }, C(`reason_${r.reason}`)),
              h('span', { class: 'cl-muted small' }, fmtAgo(Date.parse(r.at)))),
            h('div', {}, h('strong', { class: 'selectable' }, snap.name || snap.community || ''), snap.tag ? ` [${snap.tag}]` : '', snap.channel ? ` · #${snap.channel}` : '', r.kind === 'media' && snap.community ? ` · ${snap.community}` : ''),
            r.kind === 'media' && snap.path ? preview({ path: snap.path, name: snap.name, width: snap.width, height: snap.height }, 'md') : null,
            snap.body ? h('blockquote', { class: 'cl-quote selectable' }, snap.body) : null,
            r.text ? h('p', { class: 'selectable' }, r.text) : null,
            h('div', { class: 'cl-muted small' }, C('adminReportWho', { by: nameOf(r.reporter), target: r.targetUser ? nameOf(r.targetUser) : '—' })),
            h('div', { class: 'row wrap' }, close, removeMsg));
        }));
      } catch (err) {
        return mount(list, emptyState('alert', errText(err), ''));
      }
    }
    load();
  }

  function select(id) {
    section = id;
    mount(seg, SECTIONS.map((s) => h('button', { type: 'button', class: s.id === section ? 'active' : null, 'aria-pressed': String(s.id === section), onclick: () => select(s.id) }, icon(s.icon), C(`adminTab_${s.id}`))));
    if (id === 'reports') reportsView();
    else if (id === 'media') mediaView();
    else groupsView();
  }

  mount(root, h('div', { class: 'page-head' }, h('div', { class: 'ph-text' }, h('h2', { class: 'page-title' }, t('nav.communities')), h('p', { class: 'page-sub' }, C('adminSub')))), h('div', { class: 'stack' }, seg, host));
  select(section);
}
