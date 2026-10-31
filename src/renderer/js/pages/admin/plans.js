// Configuración de límites y modelos. Los pagos se confirman en Soporte.
import { h, icon, mount, setBusy, ok, confirmDialog, emptyState, selectEl, switchEl } from '../../ui.js';
import { T, call, fmtUsd, fmtInt, card, errorBox, skeletonRows, field } from './parts.js';
import { currentPlans } from '../../features/plans-catalog.js';

const UNLIMITED = 2147483647;
const EFFORTS = ['low', 'medium', 'high', 'xhigh'];
const LIMITS = {
  monthlyBudgetUsd: [0, 1000],
  maxTokensPerRequest: [1000, 36000],
  maxCallsPerTurn: [1, 200],
  requestsPerMinute: [1, 600],
  daily: [0, 100000],
  weekly: [0, 1000000],
};

const clone = (v) => JSON.parse(JSON.stringify(v));

function numInput(value, [min, max], { step = '1', label }) {
  return h('input', { class: 'input num', type: 'number', min: String(min), max: String(max), step, value: String(value ?? ''), 'aria-label': label });
}

function planCard(original, models, onSaved) {
  let plan = clone(original);
  const errors = h('div', { class: 'notice bad', role: 'alert', hidden: true });
  const dirtyNote = h('span', { class: 'small adm-dirty', hidden: true }, icon('edit'), T('unsaved'));
  const saveBtn = h('button', { class: 'btn', type: 'button', disabled: true }, icon('save'), T('savePlan'));
  const discardBtn = h('button', { class: 'btn ghost', type: 'button', disabled: true }, T('discard'));
  const body = h('div', { class: 'stack' });

  const inputs = {};
  const modelRows = h('tbody', {});
  const addHost = h('div', { class: 'adm-add-model' });

  function patch() {
    const out = {};
    for (const key of ['monthlyBudgetUsd', 'maxTokensPerRequest', 'maxCallsPerTurn', 'requestsPerMinute']) {
      if (Number(plan[key]) !== Number(original[key])) out[key] = Number(plan[key]);
    }
    if (plan.active !== original.active) out.active = plan.active;
    const sig = (list) => JSON.stringify((list || []).map((m) => [m.id, [...m.efforts].sort(), Number(m.daily), Number(m.weekly)]).sort());
    if (sig(plan.models) !== sig(original.models)) {
      const keep = new Set(plan.models.map((m) => m.id));
      out.models = [
        ...plan.models.map((m) => ({ id: m.id, efforts: EFFORTS.filter((e) => m.efforts.includes(e)), daily: Number(m.daily), weekly: Number(m.weekly) })),
        ...original.models.filter((m) => !keep.has(m.id)).map((m) => ({ id: m.id, remove: true })),
      ];
    }
    return out;
  }

  function validate() {
    for (const key of ['monthlyBudgetUsd', 'maxTokensPerRequest', 'maxCallsPerTurn', 'requestsPerMinute']) {
      const v = Number(plan[key]);
      const [min, max] = LIMITS[key];
      if (!Number.isFinite(v) || v < min || v > max || (key !== 'monthlyBudgetUsd' && !Number.isInteger(v))) return T('errField', { field: T(`p_${key}`), min, max });
    }
    if (Math.abs(Math.round(plan.monthlyBudgetUsd * 100) - plan.monthlyBudgetUsd * 100) > 1e-6) return T('errBudgetDecimals');
    if (!plan.models.length) return T('errNoModels');
    for (const m of plan.models) {
      if (!m.efforts.length) return T('errEfforts', { model: m.label || m.id });
      for (const k of ['daily', 'weekly']) {
        const v = Number(m[k]);
        if (v !== UNLIMITED && (!Number.isInteger(v) || v < LIMITS[k][0] || v > LIMITS[k][1])) return T('errQuota', { model: m.label || m.id });
      }
    }
    return null;
  }

  function sync() {
    const dirty = Object.keys(patch()).length > 0;
    saveBtn.disabled = !dirty;
    discardBtn.disabled = !dirty;
    saveBtn.classList.toggle('primary', dirty);
    dirtyNote.hidden = !dirty;
  }

  function effortBox(m, e) {
    const id = `adm-eff-${plan.id}-${m.id}-${e}`;
    const cb = h('input', { type: 'checkbox', id, checked: m.efforts.includes(e) });
    cb.addEventListener('change', () => {
      m.efforts = cb.checked ? [...new Set([...m.efforts, e])] : m.efforts.filter((x) => x !== e);
      sync();
    });
    return h('label', { class: 'adm-effort', for: id }, cb, T(`effort_${e}`));
  }

  function drawModels() {
    mount(
      modelRows,
      plan.models.map((m) => {
        const daily = numInput(m.daily === UNLIMITED ? '' : m.daily, LIMITS.daily, { label: T('m_dailyFor', { model: m.label || m.id }) });
        const weekly = numInput(m.weekly === UNLIMITED ? '' : m.weekly, LIMITS.weekly, { label: T('m_weeklyFor', { model: m.label || m.id }) });
        for (const input of [daily, weekly]) { input.placeholder = T('unlimited'); input.title = T('unlimitedHint'); }
        daily.addEventListener('input', () => ((m.daily = daily.value === '' ? UNLIMITED : Number(daily.value)), sync()));
        weekly.addEventListener('input', () => ((m.weekly = weekly.value === '' ? UNLIMITED : Number(weekly.value)), sync()));
        return h(
          'tr',
          {},
          h('td', { class: 'adm-model-name' }, m.label || m.id),
          h('td', {}, h('div', { class: 'adm-efforts', role: 'group', 'aria-label': T('m_effortsFor', { model: m.label || m.id }) }, EFFORTS.map((e) => effortBox(m, e)))),
          h('td', {}, daily),
          h('td', {}, weekly),
          h(
            'td',
            { class: 'adm-col-remove' },
            h('button', { class: 'icon-btn sm danger', type: 'button', title: T('m_remove', { model: m.label || m.id }), 'aria-label': T('m_remove', { model: m.label || m.id }), disabled: plan.models.length <= 1, onclick: () => ((plan.models = plan.models.filter((x) => x !== m)), drawModels(), sync()) }, icon('trash')),
          ),
        );
      }),
    );
    const missing = models.filter((x) => !plan.models.some((m) => m.id === x.id));
    if (!missing.length) return mount(addHost);
    const sel = selectEl(missing.map((x) => ({ value: x.id, label: x.label })), missing[0].id, null, 'select adm-select');
    sel.setAttribute('aria-label', T('addModel'));
    mount(
      addHost,
      sel,
      h('button', { class: 'btn sm', type: 'button', onclick: () => {
        const info = models.find((x) => x.id === sel.value);
        plan.models.push({ id: info.id, label: info.label, efforts: ['low', 'medium'], daily: 5, weekly: 20 });
        drawModels();
        sync();
      } }, icon('plus'), T('addModel')),
    );
  }

  function draw() {
    for (const key of ['monthlyBudgetUsd', 'maxTokensPerRequest', 'maxCallsPerTurn', 'requestsPerMinute']) {
      const input = numInput(plan[key], LIMITS[key], { step: key === 'monthlyBudgetUsd' ? '0.01' : '1' });
      input.addEventListener('input', () => {
        plan[key] = input.value === '' ? NaN : Number(input.value);
        sync();
      });
      inputs[key] = field(T(`p_${key}`), input);
    }
    drawModels();
    const activeSwitch = switchEl(plan.active, async (on) => {
      if (!on && original.subscribers > 0) {
        const yes = await confirmDialog(T('deactivatePlanTitle', { name: plan.name }), T('deactivatePlanText', { count: original.subscribers }), { okText: T('deactivatePlanOk'), cancelText: T('cancel'), danger: true });
        if (!yes) {
          activeSwitch.querySelector('input').checked = true;
          return;
        }
      }
      plan.active = on;
      sync();
    }, T('p_activeLabel', { name: plan.name }));
    mount(
      body,
      h(
        'div',
        { class: 'adm-plan-price' },
        h('div', {}, h('div', { class: 'muted small' }, T('p_price')), h('div', { class: 'adm-plan-price-value num' }, Number.isFinite(plan.priceUsd) ? T('perPayment', { price: fmtUsd(plan.priceUsd) }) : '—')),
        h('div', { class: 'spacer' }),
        null,
      ),
      h('div', { class: 'toggle-row' }, h('div', { class: 'tr-text' }, h('div', { class: 'tr-title' }, T('p_active')), h('div', { class: 'tr-sub' }, T('p_activeHelp'))), activeSwitch),
      h('div', { class: 'form-grid' }, inputs.monthlyBudgetUsd, inputs.maxTokensPerRequest, inputs.maxCallsPerTurn, inputs.requestsPerMinute),
      h('div', { class: 'label' }, T('p_models')),
      h('div', { class: 'adm-table-wrap' }, h('table', { class: 'table adm-table adm-models' }, h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, T('colModel')), h('th', { scope: 'col' }, T('m_efforts')), h('th', { scope: 'col' }, T('m_daily')), h('th', { scope: 'col' }, T('m_weekly')), h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, T('m_removeCol'))))), modelRows)),
      addHost,
      errors,
      h('div', { class: 'adm-plan-foot' }, dirtyNote, h('div', { class: 'spacer' }), discardBtn, saveBtn),
    );
    sync();
  }

  discardBtn.addEventListener('click', () => {
    plan = clone(original);
    errors.hidden = true;
    draw();
  });
  saveBtn.addEventListener('click', async () => {
    const problem = validate();
    if (problem) {
      errors.hidden = false;
      mount(errors, icon('alert'), h('div', {}, problem));
      return;
    }
    errors.hidden = true;
    const done = setBusy(saveBtn);
    try {
      await call('plans.update', { planId: plan.id, patch: patch() });
      ok(T('planSaved', { name: plan.name }));
      onSaved();
    } catch (err) {
      errors.hidden = false;
      mount(errors, icon('alert'), h('div', {}, err?.message || String(err)));
    } finally {
      done();
    }
  });

  draw();
  return card(
    {
      icon: 'layers',
      title: plan.name,
      sub: h('span', { class: 'row wrap' }, h('span', { class: 'badge mono' }, plan.id), h('span', { class: ['pill', original.active ? 'good' : 'warn'] }, original.active ? T('p_onSale') : T('p_offSale')), h('span', { class: 'small muted' }, T('subscribers', { count: original.subscribers || 0, value: fmtInt(original.subscribers || 0) }))),
      cls: 'adm-plan',
    },
    body,
  );
}

export function render(root, ctx = {}) {
  async function load() {
    ctx.invalidatePlans?.(); // los planes del filtro de usuarios se vuelven a pedir
    mount(root, skeletonRows(12));
    let data;
    try {
      data = await call('plans.list');
    } catch (err) {
      if (root.isConnected) mount(root, errorBox(err, load));
      return;
    }
    if (!root.isConnected) return;
    const plans = currentPlans(data.plans);
    if (!plans.length) {
      mount(root, h('section', { class: 'card adm-card' }, emptyState('layers', T('plansEmpty'), T('plansEmptyText'))));
      return;
    }
    mount(
      root,
      h('div', { class: 'notice info' }, icon('info'), h('div', {}, T('plansNote'))),
      h('div', { class: 'notice info' }, icon('message'), T('supportPaymentsNote')),
      h('div', { class: 'adm-plans' }, plans.map((p) => planCard(p, (data.models || []).filter((m) => ['haiku', 'sonnet'].includes(m.id)), load))),
    );
  }
  load();
  return { refresh: load };
}
