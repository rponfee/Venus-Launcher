// Pestaña Venus Pass: la progresión (nombre, niveles, XP por nivel, activar) con su actividad y el editor de premios
// nivel por nivel. Todo con las RPC admin_pass_* de 0041 (admin_guard: solo administradores). El pase se gana jugando:
// no hay ventas, ingresos ni ediciones que regalar. Cada premio es puntos o un cosmético de la tienda (id de shop_items).
import { h, icon, mount, setBusy, ok, fail, ensureCss } from '../../ui.js';
import { cloud } from '../../cloud.js';
import { T, card, errorBox, skeletonRows, field, fmtInt, fmtDay } from './parts.js';

const PAGE = 50; // niveles por página del editor de premios
const toInput = (iso) => (iso ? new Date(iso).toISOString().slice(0, 10) : '');
const fromInput = (v, end = false) => (v ? `${v}T${end ? '23:59:59' : '00:00:00'}Z` : null);

export function render(root) {
  ensureCss('pages/pass'); // clases ps-adm-* de esta pestaña
  async function rpc(name, args) {
    const { data, error } = await cloud.client.rpc(name, args);
    if (error) throw error;
    return data;
  }

  // Ids de los cosméticos de la tienda, para completar el campo de un premio (si no responde, se escribe a mano).
  let itemList = null;
  function itemsDatalist() {
    if (!itemList) {
      itemList = h('datalist', { id: 'adm-pass-items' });
      cloud.client.from('shop_items').select('id').order('id').then(({ data }) => {
        for (const r of data || []) itemList.append(h('option', { value: r.id }));
      }, () => {});
    }
    return itemList;
  }

  function seasonCard(s, reload) {
    const name = h('input', { class: 'input', value: s.name, maxlength: '60' });
    const starts = h('input', { class: 'input', type: 'date', value: toInput(s.startsAt) });
    const ends = h('input', { class: 'input', type: 'date', value: toInput(s.endsAt), disabled: s.permanent });
    const permanent = h('input', { type: 'checkbox', checked: s.permanent });
    permanent.addEventListener('change', () => { ends.disabled = permanent.checked; });
    const active = h('input', { type: 'checkbox', checked: s.active });
    const levels = h('input', { class: 'input num', type: 'number', min: '10', max: '1000', value: String(s.levels) });
    const xp = h('input', { class: 'input num', type: 'number', min: '10', max: '100000', value: String(s.xpPerLevel) });
    const save = h('button', { class: 'btn primary sm', type: 'button' }, icon('save'), T('passSave'));
    save.addEventListener('click', async () => {
      const done = setBusy(save);
      try {
        await rpc('admin_pass_season_save', { p: {
          id: s.id, name: name.value.trim(), startsAt: fromInput(starts.value), endsAt: permanent.checked ? null : fromInput(ends.value, true), active: active.checked,
          permanent: permanent.checked, levels: Number(levels.value), xpPerLevel: Number(xp.value),
        } });
        ok(T('passSaved'));
        reload();
      } catch (err) {
        fail(T('passSaveError'), err);
      } finally {
        done();
      }
    });
    const stats = h('div', { class: 'ps-adm-chips' },
      h('span', { class: 'chip' }, icon('users'), T('passPlayers', { n: fmtInt(s.players) })),
      h('span', { class: 'chip' }, icon('clock'), T('passHours', { n: fmtInt(Math.round(s.minutes / 60)) })),
      h('span', { class: 'chip' }, icon('gift'), T('passClaims', { n: fmtInt(s.claims) })),
      h('span', { class: 'chip' }, icon('layers'), T('passRewards', { n: fmtInt(s.rewards) })));
    const rewardsHost = h('div');
    const rewardsBtn = h('button', { class: 'btn sm', type: 'button' }, icon('layers'), T('passRewardsEdit'));
    rewardsBtn.addEventListener('click', async () => {
      const done = setBusy(rewardsBtn);
      try {
        mount(rewardsHost, rewardsEditor(s, await rpc('admin_pass_rewards', { p_season: s.id })));
      } catch (err) {
        fail(T('passLoadError'), err);
      } finally {
        done();
      }
    });
    return card({ icon: 'rocket', title: `${s.name} (${s.id})`, sub: `${fmtDay(s.startsAt)}${s.permanent ? ` · ${T('passPermanent')}` : ` → ${fmtDay(s.endsAt)}`}${s.active ? ` · ${T('passActive')}` : ''}`, actions: [rewardsBtn, save] },
      stats,
      h('div', { class: 'adm-grid-2' },
        field(T('passName'), name),
        h('div', { class: 'ps-adm-stack' }, h('label', { class: 'adm-check' }, active, T('passActiveField')), h('label', { class: 'adm-check' }, permanent, T('passPermanentField'))),
        field(T('passStarts'), starts),
        field(T('passEnds'), ends),
        field(T('passLevels'), levels),
        field(T('passXpPerLevel'), xp, T('passLevelsNote'))),
      rewardsHost);
  }

  // Editor de premios: de a 50 niveles por página (son 380), un guardado por fila.
  function rewardsEditor(s, rewards) {
    const byLevel = new Map(rewards.map((r) => [r.level, r]));
    const pages = Math.max(1, Math.ceil(s.levels / PAGE));
    let page = 0;
    const host = h('div');
    const pageSel = h('select', { class: 'input', 'aria-label': T('passRewardsPage') }, Array.from({ length: pages }, (_, i) => h('option', { value: String(i) }, T('passPageRange', { from: i * PAGE + 1, to: Math.min(s.levels, (i + 1) * PAGE) }))));
    pageSel.addEventListener('change', () => { page = Number(pageSel.value); paint(); });

    function row(lv) {
      const r = byLevel.get(lv);
      const kind = h('select', { class: 'input', 'aria-label': T('passKind') }, ['none', 'points', 'item'].map((k) => h('option', { value: k, selected: (r?.kind || 'none') === k }, T(`passKind_${k}`))));
      const value = h('input', { class: 'input', value: r ? (r.kind === 'points' ? String(r.amount) : r.itemId) : '', placeholder: '25 / pass_frame_1', list: 'adm-pass-items', 'aria-label': T('passValue') });
      const saveBtn = h('button', { class: 'icon-btn sm', type: 'button', title: T('passSave'), 'aria-label': T('passSave') }, icon('save'));
      saveBtn.addEventListener('click', async () => {
        const done = setBusy(saveBtn);
        try {
          const k = kind.value;
          const out = await rpc('admin_pass_reward_set', { p_season: s.id, p: { level: lv, kind: k, amount: k === 'points' ? Number(value.value) : null, itemId: k === 'item' ? value.value.trim() : null } });
          byLevel.clear();
          for (const x of out) byLevel.set(x.level, x);
          ok(T('passSaved'));
        } catch (err) {
          fail(T('passSaveError'), err);
        } finally {
          done();
        }
      });
      return h('tr', {}, h('td', { class: 'num' }, String(lv)), h('td', {}, h('div', { class: 'ps-adm-inline' }, kind, value, saveBtn)));
    }

    function paint() {
      const from = page * PAGE + 1;
      const to = Math.min(s.levels, from + PAGE - 1);
      const rows = [];
      for (let lv = from; lv <= to; lv++) rows.push(row(lv));
      mount(host, h('div', { class: 'adm-table-wrap' }, h('table', { class: 'adm-table adm-table-compact' }, h('thead', {}, h('tr', {}, h('th', {}, T('passLevel')), h('th', {}, T('passReward')))), h('tbody', {}, rows))));
    }
    paint();
    return h('div', { class: 'ps-adm-stack' }, h('p', { class: 'ps-adm-note' }, T('passRewardsNote')), pageSel, itemsDatalist(), host);
  }

  async function load() {
    mount(root, skeletonRows(4));
    let seasons;
    try {
      seasons = await rpc('admin_pass_seasons');
    } catch (err) {
      if (root.isConnected) mount(root, errorBox(err, load));
      return;
    }
    if (!root.isConnected) return;
    mount(root, h('p', { class: 'ps-adm-note' }, T('passNote')), ...seasons.map((s) => seasonCard(s, load)));
  }
  load();
}
