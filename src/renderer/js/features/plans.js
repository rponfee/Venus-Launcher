// Planes de Venus IA: precios en pesos (Mercado Pago) y en dólares (PayPal) con sus impuestos, y el pago directo.
// El pago se hace en el navegador; el plan se activa solo cuando el medio de pago lo acredita (billing:order).
import { h, icon, mount, modal, ensureCss, fmtDate, fmtNumber, setBusy, fail } from '../ui.js';
import { api } from '../store.js';
import { t, loadNs, locale, getLanguage } from '../i18n.js';
import { navigate } from '../app.js';
import { cloud } from '../cloud.js';
import { PLAN_CATALOG } from './plans-catalog.js';
export { PLAN_CATALOG } from './plans-catalog.js';

const MONEY_LOCALES = { es: 'es-AR', en: 'en-US', pt: 'pt-BR' };
const PROVIDERS = ['mercado_pago', 'paypal'];
let checkoutSeq = 0;
const P = (key, vars) => t(`plans.${key}`, vars);

export function fmtUsd(value) {
  return new Intl.NumberFormat(MONEY_LOCALES[getLanguage()] || locale(), { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value) || 0);
}
/** Pesos: sin centavos cuando el monto es redondo ("$ 11.600"). */
export function fmtArs(value) {
  const n = Number(value) || 0;
  const cents = Math.round(n * 100) % 100 !== 0;
  return new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: 2 }).format(n);
}
export const fmtMoney = (value, currency) => (currency === 'ARS' ? fmtArs(value) : fmtUsd(value));
const fmtRate = (value) => new Intl.NumberFormat(locale(), { maximumFractionDigits: 2 }).format(Number(value) || 0);

export function preparePlans() {
  ensureCss('features/plans');
  return loadNs('plans');
}
function fmtIn(ts) {
  const diff = (new Date(ts).getTime() - Date.now()) / 1000;
  if (!Number.isFinite(diff)) return '';
  const abs = Math.abs(diff);
  const unit = abs < 3600 ? 'minute' : abs < 86400 ? 'hour' : 'day';
  return new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' }).format(Math.round(diff / (unit === 'minute' ? 60 : unit === 'hour' ? 3600 : 86400)), unit);
}
const day = (iso) => fmtDate(Date.parse(iso), { day: 'numeric', month: 'long' });
const providerName = (id) => (id === 'mercado_pago' ? 'Mercado Pago' : id === 'paypal' ? 'PayPal' : String(id || '—'));

// ---------- Catálogo ----------

/** Une el catálogo del servidor con la lista fija (modelos y límites salen de la lista si el servidor no los manda). */
function mergeCatalog(catalog) {
  const server = new Map((catalog?.plans || []).map((p) => [p.id, p]));
  return PLAN_CATALOG.map((base) => {
    const s = server.get(base.id) || {};
    const prices = {};
    for (const id of PROVIDERS) if (catalog?.providers?.[id] && s.prices?.[id]) prices[id] = s.prices[id];
    return {
      ...base,
      price: s.priceUsd ?? base.price,
      budget: s.budgetUsd ?? base.budget,
      tokens: s.maxTokensPerRequest ?? base.tokens,
      prices,
    };
  });
}

function taxLine(q) {
  const included = q.taxes.filter((x) => x.mode === 'included');
  if (included.length) return P('taxIncludedShort', { taxes: included.map((x) => `${x.label} ${fmtMoney(x.amount, q.currency)}`).join(' · '), net: fmtMoney(q.net, q.currency) });
  if (q.taxes.some((x) => x.mode === 'added')) return P('taxAddedShort');
  return P('finalPrice');
}

function priceBlock(p) {
  const ars = p.prices.mercado_pago;
  const usd = p.prices.paypal;
  const main = ars || usd;
  if (!main) {
    return h('div', { class: 'pl-price-box' },
      h('div', { class: 'pl-price' }, h('span', { class: 'pl-amount num' }, fmtUsd(p.price)), h('span', { class: 'pl-per' }, P('listPrice'))));
  }
  return h('div', { class: 'pl-price-box' },
    h('div', { class: 'pl-price' }, h('span', { class: 'pl-amount num' }, fmtMoney(main.total, main.currency)), h('span', { class: 'pl-per' }, main.currency === 'ARS' ? P('perArs') : P('perUsd'))),
    h('p', { class: 'pl-tax' }, taxLine(main)),
    ars && usd ? h('p', { class: 'pl-alt' }, P('orPaypal', { price: fmtUsd(usd.total) })) : null);
}

/** Tarjetas de los planes. onSelect(plan) abre el pago; sin onSelect, abre el diálogo de compra. */
export function planCards({ catalog = null, current = null, onSelect = null } = {}) {
  const plans = mergeCatalog(catalog);
  const canPay = plans.some((p) => Object.keys(p.prices).length);
  return h('div', { class: 'pl-grid', role: 'list', 'aria-label': P('plansTitle') }, plans.map((p) =>
    h('article', { class: ['pl-card', current === p.id && 'current'], role: 'listitem' },
      h('div', { class: 'pl-card-head' }, h('h3', { class: 'pl-name' }, p.name), current === p.id ? h('span', { class: 'badge accent' }, P('current')) : null),
      priceBlock(p),
      h('ul', { class: 'pl-models' },
        h('li', { class: 'pl-model' }, h('strong', {}, P('apiAllowance', { amount: fmtUsd(p.budget) }))),
        h('li', { class: 'pl-model' }, P('responseTokens', { count: new Intl.NumberFormat(locale()).format(p.tokens) })),
        h('li', { class: 'pl-model' }, h('span', { class: 'pl-model-name' }, icon('sparkles'), p.models.join(' · '))),
        h('li', { class: 'pl-model' }, P('reasoning', { levels: p.efforts.map((e) => P(`effort_${e}`)).join(' · ') }))),
      h('div', { class: 'pl-card-foot' }, h('button', {
        type: 'button', class: ['btn', 'tonal', 'pl-cta'], disabled: !canPay,
        onclick: () => (onSelect ? onSelect(p) : openCheckout(p, catalog)),
      }, icon('crown'), P(current === p.id ? 'buyAgain' : 'buy', { plan: p.name }))))));
}

// ---------- Compra ----------

function breakdown(q) {
  // "Precio" solo si después se suma algo: si no, es igual al total.
  const rows = q.taxes.some((x) => x.mode === 'added') ? [h('div', { class: 'pl-row' }, h('span', {}, P('rowPrice')), h('span', { class: 'num' }, fmtMoney(q.subtotal, q.currency)))] : [];
  for (const x of q.taxes) {
    if (x.mode === 'added') rows.push(h('div', { class: 'pl-row' }, h('span', {}, P('rowAdded', { label: x.label, rate: fmtRate(x.rate) })), h('span', { class: 'num' }, `+ ${fmtMoney(x.amount, q.currency)}`)));
  }
  rows.push(h('div', { class: ['pl-row', 'total', !rows.length && 'first'] }, h('span', {}, P('rowTotal')), h('strong', { class: 'num' }, fmtMoney(q.total, q.currency))));
  const included = q.taxes.filter((x) => x.mode === 'included');
  for (const x of included) rows.push(h('div', { class: 'pl-row sub' }, h('span', {}, P('rowIncluded', { label: x.label, rate: fmtRate(x.rate) })), h('span', { class: 'num' }, fmtMoney(x.amount, q.currency))));
  if (included.length) rows.push(h('div', { class: 'pl-row sub' }, h('span', {}, P('rowNet')), h('span', { class: 'num' }, fmtMoney(q.net, q.currency))));
  for (const x of q.taxes.filter((y) => y.mode === 'estimate')) {
    rows.push(h('div', { class: 'pl-row sub' }, h('span', {}, P('rowEstimate', { label: x.label, rate: fmtRate(x.rate) })), h('span', { class: 'num' }, `≈ ${fmtMoney(x.amount, q.currency)}`)));
  }
  if (q.estimatedTotal) rows.push(h('div', { class: 'pl-row sub' }, h('span', {}, P('rowEstimatedTotal')), h('span', { class: 'num' }, `≈ ${fmtMoney(q.estimatedTotal, q.currency)}`)));
  return h('div', { class: 'pl-breakdown', role: 'group', 'aria-label': P('breakdown') }, rows);
}

/** Diálogo de compra: elegir medio de pago, ver impuestos, pagar y esperar la acreditación. */
export async function openCheckout(plan, catalog) {
  await preparePlans();
  const offered = PROVIDERS.filter((id) => plan.prices?.[id]);
  let provider = offered[0] || null;
  let order = null;
  let url = null;
  let off = null;
  const body = h('div', { class: 'pl-co' });
  let dialog;

  function chooseView() {
    if (!offered.length) return mount(body, h('div', { class: 'notice warn' }, icon('alert'), h('div', {}, P('noProviders'))));
    const pay = h('button', { type: 'button', class: 'btn primary pl-pay' });
    const detail = h('div');
    const draw = () => {
      const q = plan.prices[provider];
      mount(detail, breakdown(q),
        provider === 'mercado_pago' && catalog?.arsPerUsd ? h('p', { class: 'pl-muted small' }, catalog.rateUpdatedAt
          ? P('rateNote', { rate: fmtArs(catalog.arsPerUsd), date: day(catalog.rateUpdatedAt) })
          : P('rateNoteNoDate', { rate: fmtArs(catalog.arsPerUsd) })) : null,
        provider === 'paypal' ? h('p', { class: 'pl-muted small' }, P('paypalNote')) : null);
      mount(pay, icon('lock'), P('payWith', { amount: fmtMoney(q.total, q.currency), provider: providerName(provider) }));
      for (const r of options.querySelectorAll('input')) r.checked = r.value === provider;
    };
    const group = `pl-provider-${++checkoutSeq}`;
    const options = h('div', { class: 'pl-providers', role: 'radiogroup', 'aria-label': P('chooseMethod') }, offered.map((id) => {
      const q = plan.prices[id];
      const input = h('input', { type: 'radio', name: group, value: id, checked: id === provider, onchange: () => { provider = id; draw(); } });
      return h('label', { class: 'pl-provider' }, input,
        h('span', { class: 'pl-provider-text' }, h('strong', {}, providerName(id)), h('span', { class: 'pl-muted small' }, id === 'mercado_pago' ? P('mpHint') : P('paypalHint'))),
        h('span', { class: 'pl-provider-price num' }, fmtMoney(q.total, q.currency)));
    }));
    pay.addEventListener('click', async () => {
      const done = setBusy(pay);
      try {
        const res = await api.invoke('billing:checkout', { plan: plan.id, provider });
        order = res.order;
        url = res.url;
        waitView();
      } catch (err) {
        if (err?.code === 'noSession') { dialog?.close(); navigate('settings/cloud/venus'); return; }
        fail(P('checkoutFailed'), err);
      } finally { done(); }
    });
    mount(body,
      h('p', { class: 'pl-co-sub' }, P('checkoutIntro', { plan: plan.name, amount: fmtUsd(plan.budget) })),
      options, detail,
      h('p', { class: 'pl-secure' }, icon('shieldCheck'), P('secure')),
      h('div', { class: 'pl-co-foot' }, pay));
    draw();
  }

  function statusNote(o) {
    const ps = String(o?.providerStatus || '');
    if (/^rejected/.test(ps)) return h('div', { class: 'notice warn' }, icon('alert'), h('div', {}, P('rejectedText')));
    if (/^capture_PENDING/.test(ps)) return h('div', { class: 'notice warn' }, icon('clock'), h('div', {}, P('heldText')));
    if (/^(in_process|pending)/.test(ps)) return h('div', { class: 'notice info' }, icon('clock'), h('div', {}, P('processingText')));
    if (ps === 'amount_mismatch') return h('div', { class: 'notice bad' }, icon('alert'), h('div', {}, P('mismatchText')));
    return null;
  }

  function waitView(o = order, timedOut = false) {
    const check = h('button', { type: 'button', class: 'btn' }, icon('refresh'), P('checkAgain'));
    check.addEventListener('click', async () => {
      const done = setBusy(check);
      try { onOrder(await api.invoke('billing:order', order.id)); }
      catch (err) { fail(P('checkFailed'), err); }
      finally { done(); }
    });
    mount(body,
      h('div', { class: 'pl-wait', role: 'status', 'aria-live': 'polite' },
        timedOut ? icon('clock') : h('div', { class: 'spinner', 'aria-hidden': 'true' }),
        h('div', {}, h('strong', {}, P(timedOut ? 'timeoutTitle' : 'waitingTitle')), h('p', {}, P(timedOut ? 'timeoutText' : 'waitingText', { provider: providerName(order.provider) })))),
      statusNote(o),
      h('div', { class: 'pl-actions' },
        url ? h('button', { type: 'button', class: 'btn', onclick: () => api.invoke('billing:reopen', url).catch((err) => fail(P('checkoutFailed'), err)) }, icon('external'), P('openAgain')) : null,
        check));
  }

  function resultView(o) {
    const paid = o.status === 'paid';
    mount(body,
      h('div', { class: ['pl-result', paid ? 'good' : 'bad'], role: 'status' },
        icon(paid ? 'check' : 'x'),
        h('div', {}, h('strong', {}, paid ? P('activatedTitle', { plan: o.planName || plan.name }) : P(`ended_${o.status}`)),
          h('p', {}, paid ? (o.carriedUsd > 0 ? P('activatedCarry', { amount: fmtUsd(o.carriedUsd) }) : P('activatedText')) : P('endedText')))),
      h('div', { class: 'pl-co-foot' }, paid
        ? h('button', { type: 'button', class: 'btn primary', onclick: () => dialog.close() }, P('done'))
        : h('button', { type: 'button', class: 'btn primary', onclick: () => { order = null; url = null; chooseView(); } }, icon('refresh'), P('tryAgain'))));
  }

  function onOrder(o) {
    if (!order || !o || o.id !== order.id) return;
    if (o.status === 'timeout') return waitView(order, true);
    order = { ...order, ...o };
    if (o.status === 'pending') waitView(order);
    else resultView(order);
  }

  off = api.on('billing:order', onOrder);
  dialog = modal({ title: P('buyTitle', { plan: plan.name }), subtitle: P('buySub'), icon: 'crown', body, size: 'wide', onClose: () => off?.() });
  chooseView();
  return dialog;
}

// ---------- Uso del plan (preguntas que quedan y presupuesto de API) ----------

function bar(label, used, limit) {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return h('div', { class: ['progress', 'pl-bar', pct >= 90 && 'full', pct >= 70 && pct < 90 && 'high'], role: 'progressbar', 'aria-label': label, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': pct }, h('i', { style: { width: `${pct}%` } }));
}

export function usageView(st) {
  const options = Array.isArray(st?.modelOptions) ? st.modelOptions : [];
  const budget = st?.budget;
  const resets = st?.resets || {};
  if (!options.length && !budget) return h('p', { class: 'pl-muted' }, P('noUsage'));
  const hasCap = (counter) => Number.isFinite(counter?.limit) && counter.limit < 2147483647;
  const rows = options.map((o) => {
    const d = o.daily;
    const w = o.weekly;
    const lines = [];
    if (hasCap(d)) lines.push(h('span', { class: 'num' }, P('useDay', { count: d.remaining, limit: fmtNumber(d.limit) })));
    if (hasCap(w)) lines.push(h('span', { class: 'num' }, P('useWeek', { count: w.remaining, limit: fmtNumber(w.limit) })));
    return h(
      'div',
      { class: ['pl-use-row', o.blocked && 'blocked'] },
      h(
        'div',
        { class: 'pl-use-top' },
        h('span', { class: 'pl-use-name' }, o.label || o.id),
        o.blocked ? h('span', { class: 'pill warn', title: o.blocked !== 'budget' && o.resetAt ? fmtIn(o.resetAt) : null }, icon('clock'), P('exhausted')) : null,
      ),
      h('div', { class: 'pl-use-vals' }, lines),
      hasCap(d) && d.limit > 0 ? bar(`${o.label || o.id}: ${P('useDay', { count: d.remaining, limit: d.limit })}`, d.used, d.limit) : null,
    );
  });
  let budgetRow = null;
  if (budget && budget.limitUsd) {
    const out = budget.remainingUsd !== null && budget.remainingUsd <= 0;
    budgetRow = h(
      'div',
      { class: ['pl-use-row', 'pl-budget', out && 'blocked'] },
      h('div', { class: 'pl-use-top' }, h('span', { class: 'pl-use-name' }, P('budget'))),
      h('div', { class: 'pl-use-vals' }, h('span', { class: 'num' }, P('budgetValue', { used: fmtUsd(budget.usedUsd), limit: fmtUsd(budget.limitUsd) }))),
      bar(P('budget'), budget.usedUsd, budget.limitUsd),
      out ? h('div', { class: 'pl-use-note' }, P('budgetOut')) : null,
    );
  }
  const notes = [];
  if (resets.daily && options.some((o) => hasCap(o.daily))) notes.push(h('div', { class: 'pl-reset' }, icon('clock'), h('span', {}, P('resetsDay', { when: fmtIn(resets.daily) }))));
  if (resets.weekly && options.some((o) => hasCap(o.weekly))) notes.push(h('div', { class: 'pl-reset' }, icon('calendar'), h('span', {}, P('resetsWeekOn', { date: day(resets.weekly) }))));
  return h('div', { class: 'pl-usage' }, rows, budgetRow, notes);
}

// ---------- Historial de pagos ----------

function ordersView(list) {
  if (!list.length) return null;
  const tone = { paid: 'good', pending: 'warn', refunded: 'bad', failed: 'bad', cancelled: '', expired: '' };
  return h('section', { class: 'pl-history' },
    h('h3', { class: 'pl-section-title' }, P('historyTitle')),
    h('ul', { class: 'pl-history-list' }, list.slice(0, 8).map((o) => h('li', { class: 'pl-history-row' },
      h('span', { class: 'pl-history-main' }, h('strong', {}, o.planName || o.plan), h('span', { class: 'pl-muted small' }, `${providerName(o.provider)} · ${o.createdAt ? fmtDate(Date.parse(o.createdAt), { day: 'numeric', month: 'short', year: 'numeric' }) : '—'}${o.live ? '' : ` · ${P('testPayment')}`}`)),
      h('span', { class: 'num' }, o.amount ? fmtMoney(o.amount, o.currency) : '—'),
      h('span', { class: ['badge', tone[o.status] || ''] }, P(`order_${['paid', 'pending', 'refunded', 'failed', 'cancelled', 'expired'].includes(o.status) ? o.status : 'pending'}`))))));
}

export function plansPanel({ variant = 'page', go = navigate } = {}) {
  const stateBox = h('div', { class: 'pl-state', 'aria-live': 'polite' });
  const cards = h('div');
  const history = h('div');
  const root = h('div', { class: ['pl-panel', `pl-${variant}`] }, stateBox, cards, history);
  let alive = true;
  let seq = 0;
  const helpLink = () => h('p', { class: 'pl-secure', style: { marginTop: '16px' } }, icon('message'), P('helpText'), ' ',
    h('button', { type: 'button', class: 'btn sm ghost', onclick: () => go('support') }, P('goSupport')));
  async function reload() {
    const request = ++seq;
    await preparePlans();
    if (!alive || request !== seq) return;
    const catalog = await api.invoke('billing:catalog').catch(() => null);
    if (!alive || request !== seq) return;
    const open = (p) => openCheckout(p, catalog);
    const ready = catalog && Object.values(catalog.providers || {}).some(Boolean);
    mount(cards, planCards({ catalog, onSelect: open }), ready ? null : h('div', { class: 'notice info', style: { marginTop: '12px' } }, icon('info'), h('div', {}, P('paymentsSoon'))), helpLink());
    try {
      const s = await api.invoke('billing:state');
      if (!alive || request !== seq) return;
      mount(stateBox, h('div', { class: ['pl-current', s?.active && 'active'] },
        h('div', { class: 'pl-current-icon' }, icon('crown')),
        h('div', { class: 'pl-current-main' }, h('div', { class: 'pl-current-label' }, P('yourPlan')),
          h('div', { class: 'pl-current-name' }, s?.active ? (s.planName || s.plan) : P('noPlanTitle')),
          h('p', { class: 'pl-current-text' }, P(s?.active ? 'activeBalance' : 'noPlanText')))));
      mount(cards, planCards({ catalog, current: s?.active ? s.plan : null, onSelect: open }), ready ? null : h('div', { class: 'notice info', style: { marginTop: '12px' } }, icon('info'), h('div', {}, P('paymentsSoon'))), helpLink());
      if (variant === 'page') {
        const list = await api.invoke('billing:orders').catch(() => []);
        if (alive && request === seq) mount(history, ordersView(list));
      }
    } catch (err) {
      if (!alive || request !== seq) return;
      const signedOut = ['noSession', 'noCloud'].includes(err?.code);
      mount(stateBox, h('div', { class: 'notice', role: signedOut ? 'status' : 'alert' }, icon('info'),
        h('div', { class: 'spacer' }, signedOut ? P('signInText') : P('loadError', { error: err?.message || String(err) })),
        h('button', { type: 'button', class: 'btn sm', onclick: signedOut ? () => go('settings/cloud/venus') : reload }, P(signedOut ? 'signIn' : 'retry'))));
    }
  }
  const offBilling = api.on('billing:changed', reload);
  const offAuth = cloud.on('auth', reload);
  root.destroy = () => { alive = false; seq++; offBilling?.(); offAuth?.(); };
  reload();
  return root;
}
export async function openPlans({ reason } = {}) {
  await preparePlans();
  let dialog;
  const panel = plansPanel({ variant: 'modal', go: (route) => { dialog?.close(); navigate(route); } });
  dialog = modal({ title: P('title'), subtitle: P(reason === 'needsPlan' ? 'modalSubPlan' : reason === 'quota' ? 'modalSubQuota' : 'modalSub'), icon: 'crown', body: panel, size: 'wide', onClose: () => panel.destroy() });
  return dialog;
}
