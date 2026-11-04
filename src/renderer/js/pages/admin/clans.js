// Pestaña Clanes y comunidades: ver, disolver y quitar, y las denuncias de mensajes, comunidades y clanes. RPC admin_group* de
// 0033 (admin_guard: solo administradores; lo que cambia algo queda en admin_log). Sus textos están en el namespace clans, que
// esta pestaña carga por su cuenta. Lo que escribe la gente va siempre como texto.
import { h, icon, mount, modal, ok, fail, setBusy, confirmDialog, promptDialog, emptyState, ensureCss, debounce, fmtAgo, fmtDate, skeleton } from '../../ui.js';
import { t, loadNs } from '../../i18n.js';
import { groupsBackend, errText } from '../../features/clans/backend.js';
import { emblemBadge, tagChip } from '../../features/clans/tag.js';

const C = (key, vars) => t(`clans.${key}`, vars);
const nameOf = (p) => String(p?.displayName || p?.username || '').trim() || C('someone');
const SECTIONS = [{ id: 'clan', icon: 'shield' }, { id: 'community', icon: 'users' }, { id: 'reports', icon: 'alert' }];

export async function render(root) {
  ensureCss('pages/clans');
  await loadNs('clans');
  const b = await groupsBackend();
  let section = 'clan';
  const seg = h('div', { class: 'segmented cl-seg', role: 'group', 'aria-label': C('adminTitle') });
  const host = h('div', { class: 'stack' });

  const askReason = (title) => promptDialog(title, C('adminReason'), { okText: C('adminConfirm') });

  async function openDetail(kind, row, reload) {
    const body = h('div', { class: 'stack' }, skeleton('list', { rows: 4 }));
    const m = modal({ title: row.name, subtitle: kind === 'clan' ? row.tag : C(row.isPublic ? 'visibility_public' : 'visibility_code'), icon: kind === 'clan' ? 'shield' : 'users', body });
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

  function groupsView(kind) {
    const search = h('input', { class: 'input', type: 'search', placeholder: C('adminSearch'), 'aria-label': C('adminSearch'), maxlength: '40' });
    const list = h('div', { class: 'stack', 'aria-live': 'polite' });
    let seq = 0;
    function row(g) {
      const lead = kind === 'clan' ? g.leader : g.owner;
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
        kind === 'clan' ? emblemBadge(g, { size: 'md' }) : h('span', { class: 'cm-card-icon', 'aria-hidden': 'true' }, icon(g.isPublic ? 'globe' : 'lock')),
        h('div', { class: 'cl-clan-main' },
          h('div', { class: 'cl-clan-name' }, h('strong', { class: 'ellipsis selectable' }, g.name), kind === 'clan' ? tagChip({ tag: g.tag, color: g.color }) : null, g.reports ? h('span', { class: 'badge warn' }, icon('alert'), String(g.reports)) : null),
          h('div', { class: 'cl-muted small' }, C('adminRowSub', { lead: lead ? nameOf(lead) : '—', n: g.memberCount ?? 0, date: fmtDate(Date.parse(g.createdAt)) }))),
        h('div', { class: 'row' }, h('button', { class: 'btn sm', type: 'button', onclick: () => openDetail(kind, g, load) }, icon('eye'), C('view')), dissolve));
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

  function reportsView() {
    const list = h('div', { class: 'stack' }, skeleton('list', { rows: 3 }));
    mount(host, list);
    async function load() {
      try {
        const rows = await b.rpc('admin_group_reports');
        if (!root.isConnected) return;
        if (!rows?.length) return mount(list, emptyState('shield', C('adminReportsEmpty'), ''));
        return mount(list, rows.map((r) => {
          const open = r.status === 'open';
          const close = h('button', { class: 'btn sm', type: 'button', disabled: !open }, icon('check'), C('adminReportClose'));
          const removeMsg = r.kind === 'message' ? h('button', { class: 'btn sm danger', type: 'button', disabled: !open }, icon('trash'), C('adminReportRemove')) : null;
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
            h('div', {}, h('strong', { class: 'selectable' }, snap.name || snap.community || ''), snap.tag ? ` [${snap.tag}]` : '', snap.channel ? ` · #${snap.channel}` : ''),
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
    else groupsView(id);
  }

  mount(root, h('div', { class: 'page-head' }, h('div', { class: 'ph-text' }, h('h2', { class: 'page-title' }, C('adminTitle')), h('p', { class: 'page-sub' }, C('adminSub')))), h('div', { class: 'stack' }, seg, host));
  select(section);
}
