// Pestaña Cupones: crear cupones de Stripe con su código (vista previa en vivo: "20% off por 3 meses"), ver los
// existentes con sus códigos, desactivarlos, agregar códigos y borrar cupones.
import { h, icon, mount, setBusy, ok, confirmDialog, emptyState, copyText } from '../../ui.js';
import { locale } from '../../i18n.js';
import { T, call, fmtCents, fmtDay, fmtInt, card, errorBox, skeletonRows, failAction, field, endOfDayIso, tomorrowInput } from './parts.js';
import { actionDialog } from './dialogs.js';

const CODE = /^[A-Z0-9]{3,40}$/;

function fmtPercent(v) {
  try {
    return new Intl.NumberFormat(locale(), { maximumFractionDigits: 2 }).format(v);
  } catch {
    return String(v);
  }
}

/** "20% off por 3 meses", "US$ 2,00 off en el primer pago"... (null si falta el monto). */
export function discountText({ percentOff, amountOff, duration, durationInMonths }) {
  const percent = percentOff !== null && percentOff !== undefined && percentOff !== '';
  if (!percent && !(amountOff > 0)) return null;
  const kind = percent ? 'percent' : 'amount';
  const value = percent ? fmtPercent(percentOff) : fmtCents(amountOff);
  if (duration === 'repeating') return T(`preview_${kind}_repeating`, { value, count: Number(durationInMonths) || 0 });
  return T(`preview_${kind}_${duration === 'forever' ? 'forever' : 'once'}`, { value });
}

const planNames = (ids, plans) => ids.map((id) => plans.find((p) => p.id === id)?.name || id).join(', ');

// ---------- Formulario de alta ----------

function createForm(plans, onCreated) {
  const st = { kind: 'percent', duration: 'once', plans: new Set() };
  const name = h('input', { class: 'input', maxlength: 40, placeholder: T('namePlaceholder') });
  const percent = h('input', { class: 'input num', type: 'number', min: '0.01', max: '100', step: '0.01', value: '20', inputmode: 'decimal' });
  const amount = h('input', { class: 'input num', type: 'number', min: '0.01', max: '1000', step: '0.01', value: '2', inputmode: 'decimal' });
  const months = h('input', { class: 'input num', type: 'number', min: '1', max: '36', step: '1', value: '3' });
  const maxUses = h('input', { class: 'input num', type: 'number', min: '1', step: '1', placeholder: T('unlimited') });
  const redeemBy = h('input', { class: 'input', type: 'date', min: tomorrowInput() });
  const code = h('input', { class: 'input mono adm-code-input', maxlength: 40, placeholder: 'VENUS20', autocomplete: 'off', spellcheck: 'false' });
  const codeExpires = h('input', { class: 'input', type: 'date', min: tomorrowInput() });
  const firstTime = h('input', { type: 'checkbox', id: 'adm-cp-first' });
  const codeMax = h('input', { class: 'input num', type: 'number', min: '1', step: '1', placeholder: T('unlimited') });
  const errors = h('div', { class: 'notice bad', role: 'alert', hidden: true });
  const preview = h('div', { class: 'adm-preview', 'aria-live': 'polite' });

  const kindSeg = h('div', { class: 'segmented', role: 'group', 'aria-label': T('f_kind') });
  const durSeg = h('div', { class: 'segmented adm-seg-wrap', role: 'group', 'aria-label': T('f_duration') });
  const chips = h('div', { class: 'chips', role: 'group', 'aria-label': T('f_appliesTo') });
  const percentField = field(T('f_percent'), percent);
  const amountField = field(T('f_amount'), amount);
  const monthsField = field(T('f_months'), months);

  function seg(host, options, current, onPick) {
    mount(
      host,
      options.map((o) =>
        h('button', { type: 'button', class: o.id === current ? 'active' : null, 'aria-pressed': String(o.id === current), onclick: () => onPick(o.id) }, o.label),
      ),
    );
  }
  function drawControls() {
    seg(kindSeg, [{ id: 'percent', label: T('kind_percent') }, { id: 'amount', label: T('kind_amount') }], st.kind, (id) => ((st.kind = id), update()));
    seg(durSeg, ['once', 'repeating', 'forever'].map((id) => ({ id, label: T(`duration_${id}`) })), st.duration, (id) => ((st.duration = id), update()));
    mount(
      chips,
      h('button', { type: 'button', class: ['chip', st.plans.size === 0 && 'active'], 'aria-pressed': String(st.plans.size === 0), onclick: () => (st.plans.clear(), update()) }, T('appliesAll')),
      plans
        .filter((p) => p.active)
        .map((p) =>
          h(
            'button',
            {
              type: 'button',
              class: ['chip', st.plans.has(p.id) && 'active'],
              'aria-pressed': String(st.plans.has(p.id)),
              onclick: () => {
                if (st.plans.has(p.id)) st.plans.delete(p.id);
                else st.plans.add(p.id);
                update();
              },
            },
            st.plans.has(p.id) ? icon('check') : null,
            p.name,
          ),
        ),
    );
    percentField.hidden = st.kind !== 'percent';
    amountField.hidden = st.kind !== 'amount';
    monthsField.hidden = st.duration !== 'repeating';
  }

  /** Lo que se manda (o un texto de error). */
  function collect() {
    const out = { name: name.value.trim() || null, duration: st.duration };
    if (st.kind === 'percent') {
      const v = Number(percent.value);
      if (!(v > 0 && v <= 100) || Math.abs(Math.round(v * 100) - v * 100) > 1e-6) return { error: T('errPercent') };
      out.percentOff = Math.round(v * 100) / 100;
    } else {
      const v = Number(amount.value);
      if (!(v >= 0.01 && v <= 1000)) return { error: T('errAmount') };
      out.amountOff = Math.round(v * 100);
    }
    if (st.duration === 'repeating') {
      const m = Number(months.value);
      if (!Number.isInteger(m) || m < 1 || m > 36) return { error: T('errMonths') };
      out.durationInMonths = m;
    }
    if (st.plans.size) out.appliesTo = [...st.plans];
    if (maxUses.value) {
      const m = Number(maxUses.value);
      if (!Number.isInteger(m) || m < 1) return { error: T('errMaxUses') };
      out.maxRedemptions = m;
    }
    if (redeemBy.value) out.redeemBy = endOfDayIso(redeemBy.value);
    const c = code.value.trim().toUpperCase();
    if (!CODE.test(c)) return { error: T('errCode') };
    const promo = { code: c, firstTimeOnly: firstTime.checked };
    if (codeExpires.value) promo.expiresAt = endOfDayIso(codeExpires.value);
    if (promo.expiresAt && out.redeemBy && Date.parse(promo.expiresAt) > Date.parse(out.redeemBy)) return { error: T('errCodeAfterCoupon') };
    if (codeMax.value) {
      const m = Number(codeMax.value);
      if (!Number.isInteger(m) || m < 1) return { error: T('errMaxUses') };
      promo.maxRedemptions = m;
    }
    out.promo = promo;
    return { value: out };
  }

  function drawPreview() {
    const text = discountText({
      percentOff: st.kind === 'percent' ? Number(percent.value) || null : null,
      amountOff: st.kind === 'amount' ? Math.round((Number(amount.value) || 0) * 100) : null,
      duration: st.duration,
      durationInMonths: months.value,
    });
    const c = code.value.trim().toUpperCase();
    const lines = [
      st.plans.size ? T('previewPlans', { plans: planNames([...st.plans], plans) }) : T('previewAllPlans'),
      firstTime.checked ? T('previewFirstTime') : null,
      maxUses.value ? T('previewMax', { count: Number(maxUses.value) || 0, value: fmtInt(maxUses.value) }) : null,
      redeemBy.value ? T('previewUntil', { date: fmtDay(endOfDayIso(redeemBy.value)) }) : null,
    ].filter(Boolean);
    mount(
      preview,
      h('div', { class: 'adm-preview-label' }, icon('tag'), T('preview')),
      h('div', { class: 'adm-preview-main' }, text || T('previewEmpty')),
      h('div', { class: 'adm-preview-code' }, c ? h('span', { class: 'mono' }, c) : h('span', { class: 'muted' }, T('previewNoCode'))),
      h('ul', { class: 'adm-preview-lines' }, lines.map((l) => h('li', {}, l))),
    );
  }

  function update() {
    drawControls();
    drawPreview();
    errors.hidden = true;
  }
  for (const el of [name, percent, amount, months, maxUses, redeemBy, code, codeExpires, firstTime, codeMax]) el.addEventListener('input', drawPreview);
  firstTime.addEventListener('change', drawPreview);
  code.addEventListener('blur', () => (code.value = code.value.trim().toUpperCase()));

  const submit = h('button', { class: 'btn primary', type: 'button' }, icon('plus'), T('createCoupon'));
  submit.addEventListener('click', async () => {
    const res = collect();
    if (res.error) {
      errors.hidden = false;
      mount(errors, icon('alert'), h('div', {}, res.error));
      return;
    }
    errors.hidden = true;
    const done = setBusy(submit);
    try {
      const created = await call('coupons.create', res.value);
      ok(T('couponCreated'), created.promotionCode ? T('couponCreatedCode', { code: created.promotionCode.code }) : null);
      code.value = '';
      name.value = '';
      drawPreview();
      onCreated();
    } catch (err) {
      errors.hidden = false;
      mount(errors, icon('alert'), h('div', {}, err?.message || String(err)));
    } finally {
      done();
    }
  });

  update();
  return card(
    { icon: 'plus', title: T('newCoupon'), sub: T('newCouponSub'), cls: 'adm-coupon-form' },
    h(
      'div',
      { class: 'stack' },
      preview,
      field(T('f_name'), name, T('nameHelp')),
      h('div', { class: 'field' }, h('span', { class: 'label' }, T('f_kind')), kindSeg),
      h('div', { class: 'form-grid' }, percentField, amountField, monthsField),
      h('div', { class: 'field' }, h('span', { class: 'label' }, T('f_duration')), durSeg),
      h('div', { class: 'field' }, h('span', { class: 'label' }, T('f_appliesTo')), chips),
      h('div', { class: 'form-grid' }, field(T('f_maxRedemptions'), maxUses), field(T('f_redeemBy'), redeemBy)),
      h('div', { class: 'adm-form-sep', role: 'separator' }),
      field(T('f_code'), code, T('codeHelp')),
      h('div', { class: 'form-grid' }, field(T('f_codeExpires'), codeExpires), field(T('f_codeMax'), codeMax)),
      h('label', { class: 'adm-check', for: 'adm-cp-first' }, firstTime, T('f_firstTime')),
      errors,
      h('div', { class: 'row adm-form-actions' }, submit),
    ),
  );
}

// ---------- Lista ----------

function promoRow(p, onChanged) {
  const toggle = h('button', { class: `btn sm ${p.active ? 'ghost' : ''}`, type: 'button' }, icon(p.active ? 'pause' : 'play'), p.active ? T('deactivate') : T('activate'));
  toggle.addEventListener('click', async () => {
    if (p.active) {
      const yes = await confirmDialog(T('deactivateTitle', { code: p.code }), T('deactivateText'), { okText: T('deactivate'), cancelText: T('cancel'), danger: true });
      if (!yes) return;
    }
    const done = setBusy(toggle);
    try {
      await call(p.active ? 'coupons.deactivatePromo' : 'coupons.activatePromo', { promoId: p.id });
      ok(p.active ? T('promoDeactivated', { code: p.code }) : T('promoActivated', { code: p.code }));
      onChanged();
    } catch (err) {
      failAction(err);
    } finally {
      done();
    }
  });
  const meta = [
    p.expiresAt ? T('promoExpires', { date: fmtDay(p.expiresAt) }) : null,
    p.firstTimeOnly ? T('promoFirstTime') : null,
    p.maxRedemptions ? T('usesOf', { count: p.timesRedeemed, value: fmtInt(p.timesRedeemed), max: fmtInt(p.maxRedemptions) }) : T('uses', { count: p.timesRedeemed, value: fmtInt(p.timesRedeemed) }),
    p.restricted ? T('promoRestricted') : null,
  ].filter(Boolean);
  return h(
    'li',
    { class: ['adm-promo', !p.active && 'off'] },
    h('button', { class: 'adm-promo-code mono', type: 'button', title: T('copyCode'), 'aria-label': T('copyWhat', { what: p.code }), onclick: () => copyText(p.code) }, p.code, icon('copy')),
    h('span', { class: ['pill', p.active ? 'good' : 'warn'] }, p.active ? T('promoActive') : T('promoInactive')),
    h('span', { class: 'small muted adm-promo-meta' }, meta.join(' · ')),
    toggle,
  );
}

function couponItem(c, plans, onChanged) {
  const title = c.name || c.id;
  const summary = discountText(c) || '—';
  const addBtn = h('button', { class: 'btn sm', type: 'button', disabled: !c.valid }, icon('plus'), T('addCode'));
  addBtn.addEventListener('click', async () => {
    const code = h('input', { class: 'input mono', maxlength: 40, placeholder: 'AMIGOS' });
    const expires = h('input', { class: 'input', type: 'date', min: tomorrowInput() });
    const first = h('input', { type: 'checkbox', id: 'adm-np-first' });
    const max = h('input', { class: 'input num', type: 'number', min: '1', step: '1', placeholder: T('unlimited') });
    const res = await actionDialog({
      title: T('addCodeTitle', { name: title }),
      body: h('div', { class: 'stack' }, h('p', { class: 'text-2' }, summary), field(T('f_code'), code, T('codeHelp')), h('div', { class: 'form-grid' }, field(T('f_codeExpires'), expires), field(T('f_codeMax'), max)), h('label', { class: 'adm-check', for: 'adm-np-first' }, first, T('f_firstTime'))),
      okText: T('addCode'),
      okIcon: 'plus',
      validate: () => (CODE.test(code.value.trim().toUpperCase()) ? (max.value && !(Number.isInteger(Number(max.value)) && Number(max.value) >= 1) ? T('errMaxUses') : null) : T('errCode')),
      run: () =>
        call('coupons.addPromo', {
          couponId: c.id,
          code: code.value.trim().toUpperCase(),
          expiresAt: expires.value ? endOfDayIso(expires.value) : null,
          firstTimeOnly: first.checked,
          maxRedemptions: max.value ? Number(max.value) : null,
        }),
    });
    if (res) {
      ok(T('codeAdded', { code: res.promotionCode?.code || '' }));
      onChanged();
    }
  });
  const delBtn = h('button', { class: 'btn sm danger', type: 'button' }, icon('trash'), T('deleteCoupon'));
  delBtn.addEventListener('click', async () => {
    const yes = await confirmDialog(T('deleteCouponTitle', { name: title }), T('deleteCouponText'), { okText: T('deleteCoupon'), cancelText: T('cancel'), danger: true });
    if (!yes) return;
    const done = setBusy(delBtn);
    try {
      await call('coupons.delete', { couponId: c.id });
      ok(T('couponDeleted', { name: title }));
      onChanged();
    } catch (err) {
      failAction(err);
    } finally {
      done();
    }
  });
  const meta = [
    c.appliesTo?.plans?.length ? T('couponPlans', { plans: planNames(c.appliesTo.plans, plans) }) : c.appliesTo ? T('couponProducts') : T('previewAllPlans'),
    c.maxRedemptions ? T('usesOf', { count: c.timesRedeemed, value: fmtInt(c.timesRedeemed), max: fmtInt(c.maxRedemptions) }) : T('uses', { count: c.timesRedeemed, value: fmtInt(c.timesRedeemed) }),
    c.redeemBy ? T('couponUntil', { date: fmtDay(c.redeemBy) }) : null,
    c.createdAt ? T('couponCreatedAt', { date: fmtDay(c.createdAt) }) : null,
  ].filter(Boolean);
  return h(
    'li',
    { class: ['adm-coupon', !c.valid && 'off'] },
    h(
      'div',
      { class: 'adm-coupon-head' },
      h('div', { class: 'adm-coupon-icon', 'aria-hidden': 'true' }, icon('tag')),
      h('div', { class: 'adm-coupon-text' }, h('div', { class: 'adm-coupon-title ellipsis', title }, title, c.venus ? null : h('span', { class: 'badge adm-plan-none' }, T('couponExternal'))), h('div', { class: 'adm-coupon-summary' }, summary)),
      h('span', { class: ['pill', c.valid ? 'good' : 'warn'] }, c.valid ? T('couponValid') : T('couponInvalid')),
    ),
    h('div', { class: 'small muted adm-coupon-meta' }, meta.join(' · ')),
    c.promotionCodes?.length ? h('ul', { class: 'adm-promos' }, c.promotionCodes.map((p) => promoRow(p, onChanged))) : h('p', { class: 'small muted' }, T('noCodes')),
    h('div', { class: 'adm-coupon-actions' }, addBtn, h('div', { class: 'spacer' }), delBtn),
  );
}

export function render(root, ctx) {
  const listHost = h('div', { class: 'adm-coupon-list-host' });
  let plans = [];

  async function loadList(preloaded) {
    let data = preloaded && Array.isArray(preloaded.coupons) ? preloaded : null;
    if (!data) {
      mount(listHost, skeletonRows(8));
      try {
        data = await call('coupons.list');
      } catch (err) {
        if (root.isConnected) mount(listHost, errorBox(err, () => loadList()));
        return;
      }
    }
    if (!root.isConnected) return;
    const coupons = Array.isArray(data.coupons) ? data.coupons : [];
    mount(
      listHost,
      card(
        { icon: 'tag', title: T('couponsTitle'), sub: T('couponsListSub', { mode: data.mode === 'live' ? T('modeLive') : T('modeTest') }), actions: [h('button', { class: 'icon-btn', type: 'button', title: T('refresh'), 'aria-label': T('refresh'), onclick: () => loadList() }, icon('refresh'))] },
        coupons.length ? h('ul', { class: 'adm-coupons' }, coupons.map((c) => couponItem(c, plans, () => loadList()))) : emptyState('tag', T('couponsEmptyTitle'), T('couponsEmptyText')),
        data.hasMore ? h('p', { class: 'tiny muted' }, T('moreCoupons')) : null,
      ),
    );
  }

  async function load() {
    mount(root, skeletonRows(10));
    let first;
    try {
      [first, plans] = await Promise.all([call('coupons.list'), ctx.plans().catch(() => [])]);
    } catch (err) {
      if (root.isConnected) mount(root, errorBox(err, load));
      return;
    }
    if (!root.isConnected) return;
    if (!first.configured) {
      mount(root, h('section', { class: 'card adm-card' }, emptyState('tag', T('notConfiguredTitle'), T('notConfiguredText'))));
      return;
    }
    mount(
      root,
      h('div', { class: 'notice info adm-checkout-note' }, icon('info'), h('div', {}, T('checkoutNote'))),
      h('div', { class: 'adm-coupons-grid' }, createForm(plans, () => loadList()), listHost),
    );
    loadList(first);
  }

  load();
  return { refresh: load };
}
