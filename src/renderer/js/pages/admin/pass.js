// Pestaña Venus Pass: temporadas (fechas, precios de las ediciones, activar), ventas y dar un pase sin pago. Todo con
// las RPC admin_pass_* de 0026 (admin_guard: solo administradores). Los premios de cada nivel se ven y se cambian acá
// mismo: puntos o un cosmético de la tienda (id de shop_items).
import { h, icon, mount, setBusy, ok, fail, confirmDialog } from '../../ui.js';
import { cloud } from '../../cloud.js';
import { T, card, errorBox, skeletonRows, field, fmtUsd, fmtInt, fmtDay } from './parts.js';

const TIERS = ['go', 'pro', 'max'];
const toInput = (iso) => (iso ? new Date(iso).toISOString().slice(0, 10) : '');
const fromInput = (v, end = false) => (v ? `${v}T${end ? '23:59:59' : '00:00:00'}Z` : null);

export function render(root) {
  async function rpc(name, args) {
    const { data, error } = await cloud.client.rpc(name, args);
    if (error) throw error;
    return data;
  }

  function seasonCard(s, reload) {
    const name = h('input', { class: 'input', value: s.name, maxlength: '60' });
    const starts = h('input', { class: 'input', type: 'date', value: toInput(s.startsAt) });
    const ends = h('input', { class: 'input', type: 'date', value: toInput(s.endsAt) });
    const active = h('input', { type: 'checkbox', checked: s.active });
    const levels = h('input', { class: 'input num', type: 'number', min: '10', max: '200', value: String(s.levels) });
    const xp = h('input', { class: 'input num', type: 'number', min: '10', max: '100000', value: String(s.xpPerLevel) });
    const tierInputs = TIERS.map((tier) => {
      const t = s.tiers.find((x) => x.tier === tier) || { tier, priceUsd: 0, bonusLevels: 0, xpMult: 1, perkItems: [], sold: 0 };
      return {
        tier,
        price: h('input', { class: 'input num', type: 'number', min: '0.5', max: '999', step: '0.01', value: String(t.priceUsd) }),
        bonus: h('input', { class: 'input num', type: 'number', min: '0', max: '100', value: String(t.bonusLevels) }),
        mult: h('input', { class: 'input num', type: 'number', min: '1', max: '3', step: '0.05', value: String(t.xpMult) }),
        perks: h('input', { class: 'input mono', value: (t.perkItems || []).join(', '), placeholder: 'pass_pro_title, pass_max_frame' }),
        sold: t.sold || 0,
      };
    });
    const save = h('button', { class: 'btn primary sm', type: 'button' }, icon('save'), T('passSave'));
    save.addEventListener('click', async () => {
      const done = setBusy(save);
      try {
        await rpc('admin_pass_season_save', { p: {
          id: s.id, name: name.value.trim(), startsAt: fromInput(starts.value), endsAt: fromInput(ends.value, true), active: active.checked,
          levels: Number(levels.value), xpPerLevel: Number(xp.value),
          tiers: tierInputs.map((x) => ({ tier: x.tier, priceUsd: Number(x.price.value), bonusLevels: Number(x.bonus.value), xpMult: Number(x.mult.value), perkItems: x.perks.value.split(',').map((v) => v.trim()).filter(Boolean) })),
        } });
        ok(T('passSaved'));
        reload();
      } catch (err) {
        fail(T('passSaveError'), err);
      } finally {
        done();
      }
    });
    const stats = h('div', { class: 'adm-kpis' },
      h('span', { class: 'chip' }, icon('users'), T('passSold', { n: fmtInt(s.sold) })),
      h('span', { class: 'chip' }, icon('undo'), T('passRefunded', { n: fmtInt(s.refunded) })),
      h('span', { class: 'chip' }, icon('card'), T('passRevenue', { amount: fmtUsd(s.revenueUsd) })),
      h('span', { class: 'chip' }, icon('gift'), T('passRewards', { n: fmtInt(s.rewards) })));
    const rewardsHost = h('div');
    const rewardsBtn = h('button', { class: 'btn sm', type: 'button' }, icon('layers'), T('passRewardsEdit'));
    rewardsBtn.addEventListener('click', async () => {
      const done = setBusy(rewardsBtn);
      try {
        mount(rewardsHost, rewardsTable(s.id, await rpc('admin_pass_rewards', { p_season: s.id })));
      } catch (err) {
        fail(T('passLoadError'), err);
      } finally {
        done();
      }
    });
    return card({ icon: 'rocket', title: `${s.name} (${s.id})`, sub: `${fmtDay(s.startsAt)} → ${fmtDay(s.endsAt)}${s.active ? ` · ${T('passActive')}` : ''}`, actions: [rewardsBtn, save] },
      stats,
      h('div', { class: 'adm-grid-2' },
        field(T('passName'), name),
        h('label', { class: 'adm-check' }, active, T('passActiveField')),
        field(T('passStarts'), starts),
        field(T('passEnds'), ends),
        field(T('passLevels'), levels),
        field(T('passXpPerLevel'), xp)),
      h('table', { class: 'adm-table' },
        h('thead', {}, h('tr', {}, h('th', {}, T('passTier')), h('th', {}, T('passPrice')), h('th', {}, T('passBonus')), h('th', {}, T('passMult')), h('th', {}, T('passPerks')), h('th', {}, T('passSoldCol')))),
        h('tbody', {}, tierInputs.map((x) => h('tr', {}, h('td', {}, x.tier), h('td', {}, x.price), h('td', {}, x.bonus), h('td', {}, x.mult), h('td', {}, x.perks), h('td', {}, fmtInt(x.sold)))))),
      rewardsHost);
  }

  function rewardsTable(seasonId, rewards) {
    const byLevel = new Map();
    for (const r of rewards) {
      if (!byLevel.has(r.level)) byLevel.set(r.level, {});
      byLevel.get(r.level)[r.track] = r;
    }
    const maxLevel = Math.max(50, ...rewards.map((r) => r.level));
    const rows = [];
    for (let lv = 1; lv <= maxLevel; lv++) {
      const cells = ['free', 'premium'].map((track) => {
        const r = byLevel.get(lv)?.[track];
        const kind = h('select', { class: 'input' }, ['none', 'points', 'item'].map((k) => h('option', { value: k, selected: (r?.kind || 'none') === k }, T(`passKind_${k}`))));
        const value = h('input', { class: 'input', value: r ? (r.kind === 'points' ? String(r.amount) : r.itemId) : '', placeholder: '50 / pass_s1_frame' });
        const saveBtn = h('button', { class: 'icon-btn sm', type: 'button', title: T('passSave'), 'aria-label': T('passSave') }, icon('save'));
        saveBtn.addEventListener('click', async () => {
          const done = setBusy(saveBtn);
          try {
            const k = kind.value;
            await rpc('admin_pass_reward_set', { p_season: seasonId, p: { level: lv, track, kind: k, amount: k === 'points' ? Number(value.value) : null, itemId: k === 'item' ? value.value.trim() : null } });
            ok(T('passSaved'));
          } catch (err) {
            fail(T('passSaveError'), err);
          } finally {
            done();
          }
        });
        return h('td', {}, h('div', { class: 'adm-inline' }, kind, value, saveBtn));
      });
      rows.push(h('tr', {}, h('td', { class: 'num' }, String(lv)), ...cells));
    }
    return h('div', { class: 'adm-scroll' }, h('table', { class: 'adm-table' }, h('thead', {}, h('tr', {}, h('th', {}, T('passLevel')), h('th', {}, T('passTrackFree')), h('th', {}, T('passTrackPremium')))), h('tbody', {}, rows)));
  }

  function newSeasonCard(seasons, reload) {
    const id = h('input', { class: 'input mono', placeholder: 'temporada-2', maxlength: '40' });
    const name = h('input', { class: 'input', maxlength: '60' });
    const starts = h('input', { class: 'input', type: 'date' });
    const ends = h('input', { class: 'input', type: 'date' });
    const copy = h('select', { class: 'input' }, h('option', { value: '' }, T('passCopyNone')), seasons.map((s) => h('option', { value: s.id }, s.name)));
    const btn = h('button', { class: 'btn sm', type: 'button' }, icon('plus'), T('passCreate'));
    btn.addEventListener('click', async () => {
      const done = setBusy(btn);
      try {
        const latest = seasons[0];
        await rpc('admin_pass_season_save', { p: {
          id: id.value.trim(), name: name.value.trim(), startsAt: fromInput(starts.value), endsAt: fromInput(ends.value, true), active: false,
          levels: latest?.levels || 50, xpPerLevel: latest?.xpPerLevel || 150,
          tiers: (latest?.tiers || []).map((t) => ({ tier: t.tier, priceUsd: t.priceUsd, bonusLevels: t.bonusLevels, xpMult: t.xpMult, perkItems: t.perkItems })),
          copyRewardsFrom: copy.value || null,
        } });
        ok(T('passSaved'));
        reload();
      } catch (err) {
        fail(T('passSaveError'), err);
      } finally {
        done();
      }
    });
    return card({ icon: 'plus', title: T('passNew'), sub: T('passNewSub'), actions: [btn] },
      h('div', { class: 'adm-grid-2' }, field(T('passId'), id), field(T('passName'), name), field(T('passStarts'), starts), field(T('passEnds'), ends), field(T('passCopyFrom'), copy)));
  }

  function grantCard() {
    const user = h('input', { class: 'input mono', placeholder: '00000000-0000-0000-0000-000000000000' });
    const tier = h('select', { class: 'input' }, TIERS.map((x) => h('option', { value: x }, x)));
    const btn = h('button', { class: 'btn sm', type: 'button' }, icon('gift'), T('passGrant'));
    btn.addEventListener('click', async () => {
      if (!(await confirmDialog(T('passGrant'), T('passGrantConfirm', { tier: tier.value })))) return;
      const done = setBusy(btn);
      try {
        await rpc('admin_pass_grant', { p_user: user.value.trim(), p_tier: tier.value });
        ok(T('passGranted'));
      } catch (err) {
        fail(T('passSaveError'), err);
      } finally {
        done();
      }
    });
    return card({ icon: 'gift', title: T('passGrantTitle'), sub: T('passGrantSub'), actions: [btn] }, h('div', { class: 'adm-grid-2' }, field(T('passUser'), user), field(T('passTier'), tier)));
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
    mount(root, h('p', { class: 'adm-note' }, T('passNote')), ...seasons.map((s) => seasonCard(s, load)), newSeasonCard(seasons, load), grantCard());
  }
  load();
}
