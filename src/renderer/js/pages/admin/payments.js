// Pestaña Pagos: Mercado Pago (pesos) y PayPal (dólares), cotización, impuestos y últimos pagos. Las claves van
// cifradas al servidor (vault) por la Edge Function "payments" y nunca vuelven completas: solo los últimos 4.
import { h, icon, mount, setBusy, ok, fail, selectEl, switchEl, copyText, confirmDialog } from '../../ui.js';
import { api } from '../../store.js';
import { T, call, fmtUsd, fmtDateTime, card, errorBox, skeletonRows, field } from './parts.js';
import { fmtArs, fmtMoney } from '../../features/plans.js';

const ROUNDING = [1, 10, 50, 100, 500, 1000];
const MODES = ['included', 'added', 'estimate'];
const CURRENCIES = ['ARS', 'USD'];
const STATUS_TONE = { paid: 'good', pending: 'warn', refunded: 'bad', failed: 'bad', cancelled: '', expired: '' };
const clone = (v) => JSON.parse(JSON.stringify(v));

function secretInput(hint, placeholder) {
  const input = h('input', { class: 'input mono', type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: hint ? T('pay_secretSaved', { hint }) : placeholder });
  const eye = h('button', { type: 'button', class: 'icon-btn sm', title: T('pay_show'), 'aria-label': T('pay_show') }, icon('eye'));
  eye.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    mount(eye, icon(show ? 'eyeOff' : 'eye'));
  });
  return { input, el: h('div', { class: 'adm-secret' }, input, eye) };
}

function urlRow(label, url) {
  return h('div', { class: 'adm-url' }, h('span', { class: 'muted small' }, label), h('code', { class: 'adm-url-code' }, url),
    h('button', { type: 'button', class: 'btn sm', onclick: () => copyText(url) }, icon('copy'), T('pay_copy')));
}

function statusPill(p) {
  if (p.ready) return h('span', { class: 'pill good' }, icon('check'), T('pay_ready'));
  if (p.enabled) return h('span', { class: 'pill warn' }, icon('alert'), T('pay_incomplete'));
  return h('span', { class: 'pill' }, T('pay_off'));
}

function taxEditor(taxes, onChange) {
  const host = h('div', { class: 'stack' });
  function draw() {
    mount(host, CURRENCIES.map((cur) => {
      const list = taxes[cur] || (taxes[cur] = []);
      return h('div', { class: 'adm-taxes' },
        h('div', { class: 'label' }, T(`pay_taxes_${cur}`)),
        list.length ? list.map((tax, i) => {
          const label = h('input', { class: 'input', maxlength: 40, value: tax.label, 'aria-label': T('pay_taxLabel') });
          const rate = h('input', { class: 'input num', type: 'number', min: '0', max: '100', step: '0.01', value: String(tax.rate), 'aria-label': T('pay_taxRate') });
          const mode = selectEl(MODES.map((m) => ({ value: m, label: T(`pay_mode_${m}`) })), tax.mode, (v) => { tax.mode = v; onChange(); }, 'select');
          mode.setAttribute('aria-label', T('pay_taxMode'));
          label.addEventListener('input', () => { tax.label = label.value; tax.id = (label.value.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `imp${i + 1}`).slice(0, 24); onChange(); });
          rate.addEventListener('input', () => { tax.rate = rate.value === '' ? NaN : Number(rate.value); onChange(); });
          return h('div', { class: 'adm-tax-row' }, label, h('span', { class: 'adm-tax-pct' }, rate, '%'), mode,
            h('button', { type: 'button', class: 'icon-btn sm danger', title: T('pay_taxRemove'), 'aria-label': T('pay_taxRemove'), onclick: () => { list.splice(i, 1); draw(); onChange(); } }, icon('trash')));
        }) : h('p', { class: 'muted small' }, T('pay_noTaxes')),
        list.length < 5 ? h('button', { type: 'button', class: 'btn sm', onclick: () => { list.push({ id: `imp${list.length + 1}`, label: '', rate: 0, mode: 'included' }); draw(); onChange(); } }, icon('plus'), T('pay_taxAdd')) : null);
    }));
  }
  draw();
  return host;
}

export function render(root) {
  let alive = true;

  async function load() {
    mount(root, skeletonRows(14));
    let data;
    let catalog = null;
    try {
      [data, catalog] = await Promise.all([call('payments.get'), api.invoke('billing:catalog').catch(() => null)]);
    } catch (err) {
      if (alive && root.isConnected) mount(root, errorBox(err, load));
      return;
    }
    if (!alive || !root.isConnected) return;
    draw(data, catalog);
    loadOrders();
  }

  const ordersHost = h('div');

  async function loadOrders() {
    mount(ordersHost, skeletonRows(4));
    try {
      const { orders } = await call('payments.orders');
      if (!alive) return;
      mount(ordersHost, ordersTable(Array.isArray(orders) ? orders : []));
    } catch (err) {
      if (alive) mount(ordersHost, errorBox(err, loadOrders));
    }
  }

  function ordersTable(orders) {
    if (!orders.length) return h('p', { class: 'muted' }, T('pay_noOrders'));
    return h('div', { class: 'adm-table-wrap' }, h('table', { class: 'table adm-table' },
      h('thead', {}, h('tr', {}, ['pay_colDate', 'pay_colUser', 'pay_colPlan', 'pay_colMethod', 'pay_colAmount', 'pay_colStatus', 'pay_colActions'].map((k) => h('th', { scope: 'col' }, k === 'pay_colActions' ? h('span', { class: 'sr-only' }, T(k)) : T(k))))),
      h('tbody', {}, orders.map((o) => {
        const check = h('button', { type: 'button', class: 'btn sm', title: T('pay_checkHint') }, icon('refresh'), T('pay_check'));
        check.addEventListener('click', async () => {
          const done = setBusy(check);
          try { await call('payments.sync', { orderId: o.id }); ok(T('pay_checked')); loadOrders(); }
          catch (err) { fail(T('actionFailed'), err); }
          finally { done(); }
        });
        return h('tr', {},
          h('td', { class: 'small' }, fmtDateTime(o.createdAt)),
          h('td', { class: 'ellipsis', title: o.email || '' }, o.email || '—'),
          h('td', {}, o.planName || o.plan),
          h('td', {}, o.provider === 'paypal' ? 'PayPal' : 'Mercado Pago', o.live ? null : h('span', { class: 'badge warn adm-test' }, T('pay_test'))),
          h('td', { class: 'num' }, fmtMoney(o.amount, o.currency)),
          h('td', {}, h('span', { class: ['badge', STATUS_TONE[o.status] || ''], title: o.providerStatus || '' }, T(`pay_status_${o.status}`))),
          h('td', {}, o.status === 'pending' || o.status === 'expired' || o.status === 'paid' ? check : null));
      }))));
  }

  function draw({ config, urls }, catalog) {
    const original = clone(config);
    const s = clone(config);
    const secrets = {};
    const errors = h('div', { class: 'notice bad', role: 'alert', hidden: true });
    const saveBtn = h('button', { type: 'button', class: 'btn', disabled: true }, icon('save'), T('pay_save'));
    const dirtyNote = h('span', { class: 'small adm-dirty', hidden: true }, icon('edit'), T('unsaved'));

    const patch = () => {
      const out = {};
      if (s.mercadoPago.enabled !== original.mercadoPago.enabled) out.mercadoPagoEnabled = s.mercadoPago.enabled;
      if (s.paypal.enabled !== original.paypal.enabled) out.paypalEnabled = s.paypal.enabled;
      if (s.paypal.env !== original.paypal.env) out.paypalEnv = s.paypal.env;
      if (Number(s.arsPerUsd) !== Number(original.arsPerUsd)) out.arsPerUsd = s.arsPerUsd === '' || s.arsPerUsd === null ? null : Number(s.arsPerUsd);
      if (Number(s.arsRounding) !== Number(original.arsRounding)) out.arsRounding = Number(s.arsRounding);
      if (JSON.stringify(s.taxes) !== JSON.stringify(original.taxes)) out.taxes = s.taxes;
      if (s.statementDescriptor !== original.statementDescriptor) out.statementDescriptor = s.statementDescriptor;
      return out;
    };
    const filledSecrets = () => Object.fromEntries(Object.entries(secrets).map(([k, input]) => [k, input.value.trim()]).filter(([, v]) => v));
    const sync = () => {
      const dirty = Object.keys(patch()).length > 0 || Object.keys(filledSecrets()).length > 0;
      saveBtn.disabled = !dirty;
      saveBtn.classList.toggle('primary', dirty);
      dirtyNote.hidden = !dirty;
    };

    function validate() {
      const rate = s.arsPerUsd;
      if (rate !== null && rate !== '' && (!Number.isFinite(Number(rate)) || Number(rate) < 1)) return T('pay_errRate');
      if (s.mercadoPago.enabled && (rate === null || rate === '')) return T('pay_errRateNeeded');
      for (const cur of CURRENCIES) for (const x of s.taxes[cur] || []) {
        if (!x.label.trim() || !Number.isFinite(x.rate) || x.rate < 0 || x.rate > 100) return T('pay_errTax');
      }
      if (!/^[A-Za-z0-9 .-]{3,22}$/.test(s.statementDescriptor)) return T('pay_errDescriptor');
      return null;
    }

    async function testProvider(provider, btn, out) {
      const done = setBusy(btn);
      try {
        const r = await call('payments.test', { provider });
        mount(out, r.ok
          ? h('span', { class: 'pill good' }, icon('check'), provider === 'mercado_pago'
            ? T(r.mode === 'test' ? 'pay_testOkMpTest' : 'pay_testOkMp', { nick: r.nickname || r.id || '—' })
            : T(r.env === 'live' ? 'pay_testOkPpLive' : 'pay_testOkPpSandbox'))
          : h('span', { class: 'pill bad' }, icon('alert'), T(`pay_testFail_${['missing', 'auth'].includes(r.reason) ? r.reason : 'unreachable'}`)));
      } catch (err) {
        fail(T('actionFailed'), err);
      } finally { done(); }
    }

    // ---------- Mercado Pago ----------
    const mpToken = secretInput(config.mercadoPago.tokenHint, 'APP_USR-…');
    const mpSecret = secretInput(config.mercadoPago.webhookSecret ? '••••' : null, T('pay_optional'));
    secrets.mpAccessToken = mpToken.input;
    secrets.mpWebhookSecret = mpSecret.input;
    const mpTestOut = h('span', { 'aria-live': 'polite' });
    const mpTest = h('button', { type: 'button', class: 'btn sm', disabled: !config.mercadoPago.tokenHint }, icon('link'), T('pay_test_btn'));
    mpTest.addEventListener('click', () => testProvider('mercado_pago', mpTest, mpTestOut));
    const mpCard = card({ icon: 'card', title: 'Mercado Pago', sub: h('span', { class: 'row wrap' }, statusPill(config.mercadoPago), h('span', { class: 'small muted' }, T('pay_mpSub'))) },
      h('div', { class: 'toggle-row' }, h('div', { class: 'tr-text' }, h('div', { class: 'tr-title' }, T('pay_mpEnable')), h('div', { class: 'tr-sub' }, T('pay_mpEnableHelp'))),
        switchEl(s.mercadoPago.enabled, (on) => { s.mercadoPago.enabled = on; sync(); }, T('pay_mpEnable'))),
      h('div', { class: 'form-grid' },
        field(T('pay_mpToken'), mpToken.el, T('pay_mpTokenHelp')),
        field(T('pay_mpSecret'), mpSecret.el, T('pay_mpSecretHelp'))),
      urlRow(T('pay_mpNotifyUrl'), urls.mercadoPagoNotification),
      h('div', { class: 'row wrap' }, mpTest, mpTestOut));
    for (const i of [mpToken.input, mpSecret.input]) i.addEventListener('input', sync);

    // ---------- PayPal ----------
    const ppId = secretInput(config.paypal.clientIdHint, 'Client ID');
    const ppSecret = secretInput(config.paypal.secret ? '••••' : null, 'Secret');
    const ppHook = secretInput(config.paypal.webhookId ? '••••' : null, T('pay_optional'));
    secrets.paypalClientId = ppId.input;
    secrets.paypalSecret = ppSecret.input;
    secrets.paypalWebhookId = ppHook.input;
    const env = selectEl([{ value: 'sandbox', label: T('pay_envSandbox') }, { value: 'live', label: T('pay_envLive') }], s.paypal.env, (v) => { s.paypal.env = v; sync(); }, 'select');
    const ppTestOut = h('span', { 'aria-live': 'polite' });
    const ppTest = h('button', { type: 'button', class: 'btn sm', disabled: !(config.paypal.clientIdHint && config.paypal.secret) }, icon('link'), T('pay_test_btn'));
    ppTest.addEventListener('click', () => testProvider('paypal', ppTest, ppTestOut));
    const ppCard = card({ icon: 'globe', title: 'PayPal', sub: h('span', { class: 'row wrap' }, statusPill(config.paypal), h('span', { class: 'small muted' }, T('pay_ppSub'))) },
      h('div', { class: 'toggle-row' }, h('div', { class: 'tr-text' }, h('div', { class: 'tr-title' }, T('pay_ppEnable')), h('div', { class: 'tr-sub' }, T('pay_ppEnableHelp'))),
        switchEl(s.paypal.enabled, (on) => { s.paypal.enabled = on; sync(); }, T('pay_ppEnable'))),
      h('div', { class: 'form-grid' },
        field(T('pay_ppEnv'), env, T('pay_ppEnvHelp')),
        field(T('pay_ppClientId'), ppId.el, T('pay_ppKeysHelp')),
        field(T('pay_ppSecret'), ppSecret.el),
        field(T('pay_ppWebhookId'), ppHook.el, T('pay_ppWebhookHelp'))),
      urlRow(T('pay_ppWebhookUrl'), urls.paypalWebhook),
      h('div', { class: 'row wrap' }, ppTest, ppTestOut));
    for (const i of [ppId.input, ppSecret.input, ppHook.input]) i.addEventListener('input', sync);

    // ---------- Precio en pesos e impuestos ----------
    const rate = h('input', { class: 'input num', type: 'number', min: '1', step: '0.01', value: s.arsPerUsd ?? '', placeholder: '1450' });
    rate.addEventListener('input', () => { s.arsPerUsd = rate.value === '' ? null : Number(rate.value); sync(); });
    const rounding = selectEl(ROUNDING.map((r) => ({ value: r, label: r === 1 ? T('pay_roundNone') : T('pay_roundTo', { amount: fmtArs(r) }) })), s.arsRounding, (v) => { s.arsRounding = Number(v); sync(); }, 'select');
    const descriptor = h('input', { class: 'input', maxlength: 22, value: s.statementDescriptor });
    descriptor.addEventListener('input', () => { s.statementDescriptor = descriptor.value; sync(); });
    s.taxes = { ARS: [], USD: [], ...s.taxes };
    const priceCard = card({ icon: 'layers', title: T('pay_pricesTitle'), sub: config.rateUpdatedAt ? T('pay_rateUpdated', { date: fmtDateTime(config.rateUpdatedAt) }) : T('pay_rateNever') },
      h('div', { class: 'form-grid' },
        field(T('pay_rate'), rate, T('pay_rateHelp')),
        field(T('pay_rounding'), rounding, T('pay_roundingHelp')),
        field(T('pay_descriptor'), descriptor, T('pay_descriptorHelp'))),
      h('div', { class: 'notice info' }, icon('info'), h('div', {}, T('pay_taxesHelp'))),
      taxEditor(s.taxes, sync));

    // Precios que ven los usuarios (los arma el servidor con lo guardado).
    const plans = Array.isArray(catalog?.plans) ? catalog.plans : [];
    const preview = card({ icon: 'eye', title: T('pay_previewTitle'), sub: T('pay_previewSub') },
      h('div', { class: 'adm-table-wrap' }, h('table', { class: 'table adm-table' },
        h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, T('pay_colPlan')), h('th', { scope: 'col' }, T('pay_colList')), h('th', { scope: 'col' }, 'Mercado Pago'), h('th', { scope: 'col' }, 'PayPal'))),
        h('tbody', {}, plans.map((p) => h('tr', {},
          h('td', {}, p.name),
          h('td', { class: 'num' }, fmtUsd(p.priceUsd)),
          h('td', { class: 'num' }, p.prices?.mercado_pago ? fmtArs(p.prices.mercado_pago.total) : '—'),
          h('td', { class: 'num' }, p.prices?.paypal ? fmtUsd(p.prices.paypal.total) : '—')))))),
      catalog?.providers && !catalog.providers.mercado_pago && !catalog.providers.paypal ? h('p', { class: 'muted small' }, T('pay_previewOff')) : null);

    saveBtn.addEventListener('click', async () => {
      const problem = validate();
      if (problem) {
        errors.hidden = false;
        mount(errors, icon('alert'), h('div', {}, problem));
        return;
      }
      const goingLive = patch().paypalEnv === 'live';
      if (goingLive && !(await confirmDialog(T('pay_liveTitle'), T('pay_liveText'), { okText: T('pay_liveOk'), cancelText: T('cancel') }))) return;
      errors.hidden = true;
      const done = setBusy(saveBtn);
      try {
        const next = await call('payments.save', { settings: patch(), secrets: filledSecrets() });
        ok(T('pay_saved'));
        const fresh = await api.invoke('billing:catalog').catch(() => null);
        if (alive) draw(next, fresh);
      } catch (err) {
        errors.hidden = false;
        mount(errors, icon('alert'), h('div', {}, err?.field ? T('pay_errField', { field: T(`pay_field_${err.field}`) }) : err?.message || String(err)));
      } finally { done(); }
    });

    const clearBtn = h('button', { type: 'button', class: 'btn ghost danger' }, icon('trash'), T('pay_clear'));
    clearBtn.addEventListener('click', async () => {
      if (!(await confirmDialog(T('pay_clearTitle'), T('pay_clearText'), { okText: T('pay_clearOk'), cancelText: T('cancel'), danger: true }))) return;
      const done = setBusy(clearBtn);
      try {
        const next = await call('payments.save', { settings: { mercadoPagoEnabled: false, paypalEnabled: false }, secrets: { mpAccessToken: '', mpWebhookSecret: '', paypalClientId: '', paypalSecret: '', paypalWebhookId: '' } });
        ok(T('pay_cleared'));
        if (alive) draw(next, await api.invoke('billing:catalog').catch(() => null));
      } catch (err) { fail(T('actionFailed'), err); }
      finally { done(); }
    });

    mount(root,
      h('div', { class: 'notice warn' }, icon('shieldAlert'), h('div', {}, T('pay_adultNote'))),
      h('div', { class: 'adm-pay-grid' }, mpCard, ppCard),
      priceCard,
      errors,
      h('div', { class: 'adm-plan-foot' }, clearBtn, dirtyNote, h('div', { class: 'spacer' }), saveBtn),
      preview,
      card({ icon: 'history', title: T('pay_ordersTitle'), sub: T('pay_ordersSub'), actions: [h('button', { type: 'button', class: 'btn sm', onclick: loadOrders }, icon('refresh'), T('refresh'))] }, ordersHost));
  }

  load();
  return { refresh: load, destroy: () => { alive = false; } };
}
