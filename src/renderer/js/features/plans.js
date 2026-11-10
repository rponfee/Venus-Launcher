// Planes de Venus IA: precios en pesos (Mercado Pago) y en dólares (PayPal) con sus impuestos, y el pago directo.
// El pago se hace en el navegador; el plan se activa solo cuando el medio de pago lo acredita (billing:order).
// 6.1: dos familias de planes (Claude y ChatGPT, cinco niveles cada una) con un saldo por familia; el usuario elige qué
// saldo usar (assistant:useWallet) y, cuando el servidor pasa solo al otro, se avisa (switchedText / notifySwitched).
import { h, icon, mount, modal, ensureCss, fmtDate, fmtNumber, setBusy, fail, ok, toast } from '../ui.js';
import { api } from '../store.js';
import { t, loadNs, locale, getLanguage } from '../i18n.js';
import { navigate } from '../app.js';
import { cloud } from '../cloud.js';
import { PLAN_CATALOG, FAMILIES, MODEL_LABELS, familyName, familyOf, planDisplayName } from './plans-catalog.js';
export { PLAN_CATALOG, FAMILIES, familyName, familyOf, tierOf, planDisplayName } from './plans-catalog.js';

const MONEY_LOCALES = { es: 'es-AR', en: 'en-US', pt: 'pt-BR' };
const PROVIDERS = ['mercado_pago', 'paypal'];
const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'];
let checkoutSeq = 0;
let familySeq = 0;
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

/**
 * Une el catálogo del servidor con la lista fija. Precio, saldo, tokens, modelos (label) y esfuerzos valen los del
 * servidor; la lista da el orden y el respaldo. Con un catálogo del servidor solo se muestran los planes que están a la
 * venta (un servidor viejo, de la 6.0, no trae los de Claude).
 */
function mergeCatalog(catalog) {
  const server = new Map((catalog?.plans || []).map((p) => [p.id, p]));
  const fromServer = catalog?.source === 'backend' && server.size > 0;
  return PLAN_CATALOG.filter((base) => !fromServer || server.has(base.id)).map((base) => {
    const s = server.get(base.id) || {};
    // Un plan de un motor que todavía no está habilitado en el servidor se muestra, pero no se puede comprar.
    const available = s.available !== false;
    const prices = {};
    for (const id of PROVIDERS) if (available && catalog?.providers?.[id] && s.prices?.[id]) prices[id] = s.prices[id];
    const serverModels = Array.isArray(s.models) ? s.models.filter((m) => m && typeof m.id === 'string') : [];
    const efforts = serverModels.length ? EFFORT_ORDER.filter((e) => serverModels.some((m) => Array.isArray(m.efforts) && m.efforts.includes(e))) : [];
    return {
      ...base,
      name: base.fullName,
      tierName: base.name,
      price: s.priceUsd ?? base.price,
      budget: s.budgetUsd ?? base.budget,
      tokens: s.maxTokensPerRequest ?? base.tokens,
      models: serverModels.length ? serverModels.map((m) => m.label || MODEL_LABELS[base.family]?.[m.id] || m.id) : base.models,
      efforts: efforts.length ? efforts : base.efforts,
      available,
      prices,
    };
  });
}

/** Texto del aviso de cambio de saldo: { from, to, reason } (reason 'budget' o 'noplan'). */
export function switchedText(sw) {
  return P(sw?.reason === 'noplan' ? 'switchedNoplan' : 'switchedBudget', { from: familyName(sw?.from), to: familyName(sw?.to) });
}

/** Aviso (toast) de que el servidor pasó al otro saldo, para las funciones con IA fuera del chat del Asistente. */
export async function notifySwitched(sw) {
  if (!sw || !familyName(sw.from) || !familyName(sw.to)) return;
  await preparePlans();
  toast('info', P('switchedTitle'), switchedText(sw), 9000);
}

/** Elige qué saldo usa la IA (Claude u OpenAI). Devuelve el estado nuevo del asistente o null si falló. */
export async function useWallet(family) {
  await preparePlans();
  try {
    const st = await api.invoke('assistant:useWallet', family);
    ok(P('walletChanged', { family: familyName(family) }));
    return st;
  } catch (err) {
    fail(P('walletFailed'), err);
    return null;
  }
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

/**
 * Tarjetas de los planes. onSelect(plan) abre el pago; sin onSelect, abre el diálogo de compra. family: solo los planes de
 * esa familia ('anthropic' | 'openai'). current: id (o lista de ids) de los planes con saldo de la cuenta.
 */
export function planCards({ catalog = null, current = null, onSelect = null, family = null } = {}) {
  const plans = mergeCatalog(catalog).filter((p) => !family || p.family === family);
  const mine = new Set((Array.isArray(current) ? current : [current]).filter(Boolean));
  return h('div', { class: 'pl-grid', role: 'list', 'aria-label': family ? P('familyPlans', { family: familyName(family) }) : P('plansTitle') }, plans.map((p) =>
    h('article', { class: ['pl-card', mine.has(p.id) && 'current', `pl-tier-${p.tier}`], role: 'listitem', dataset: { plan: p.id, family: p.family } },
      h('div', { class: 'pl-card-head' },
        h('h3', { class: 'pl-name' }, h('span', { class: 'pl-name-family' }, familyName(p.family)), ' ', h('span', { class: 'pl-name-tier' }, p.tierName)),
        mine.has(p.id) ? h('span', { class: 'badge accent' }, P('current')) : null),
      priceBlock(p),
      h('ul', { class: 'pl-models' },
        h('li', { class: 'pl-model' }, h('strong', {}, P('apiAllowance', { amount: fmtUsd(p.budget) }))),
        h('li', { class: 'pl-model' }, P('responseTokens', { count: new Intl.NumberFormat(locale()).format(p.tokens) })),
        h('li', { class: 'pl-model' }, h('span', { class: 'pl-model-name' }, icon('sparkles'), p.models.join(' · '))),
        h('li', { class: 'pl-model' }, P('reasoning', { levels: p.efforts.map((e) => P(`effort_${e}`)).join(' · ') }))),
      h('div', { class: 'pl-card-foot' }, h('button', {
        type: 'button', class: ['btn', 'tonal', 'pl-cta'], disabled: !Object.keys(p.prices).length,
        // Visible corto ("Comprar Pro": la familia ya está arriba); el lector de pantalla oye el nombre completo
        'aria-label': mine.has(p.id) ? `${P('buyAgain')} · ${p.name}` : P('buy', { plan: p.name }),
        onclick: () => (onSelect ? onSelect(p) : openCheckout(p, catalog)),
      }, icon('crown'), mine.has(p.id) ? P('buyAgain') : P('buy', { plan: p.tierName }))))));
}

/**
 * Selector de familia "Claude | ChatGPT" (pestañas con flechas, Inicio y Fin). onPick(family) cambia la familia;
 * panelId es el id del panel de tarjetas que controla.
 */
function familySwitch(selected, onPick, panelId) {
  const seg = h('div', { class: 'segmented pl-family-seg', role: 'tablist', 'aria-label': P('familiesLabel') });
  const ids = FAMILIES.map((f) => f.id);
  const pick = (id, focus) => {
    onPick(id);
    if (focus) seg.querySelector(`[data-family="${id}"]`)?.focus();
  };
  mount(seg, FAMILIES.map((f) => h('button', {
    type: 'button', role: 'tab', id: `${panelId}-tab-${f.id}`, 'aria-controls': panelId, 'aria-selected': String(selected === f.id),
    tabindex: selected === f.id ? 0 : -1, class: ['pl-family-tab', selected === f.id && 'active'], dataset: { family: f.id },
    onclick: () => pick(f.id, false),
  }, h('span', { class: 'pl-family-name' }, f.name), h('span', { class: 'pl-family-maker' }, P(`maker_${f.id}`)))));
  seg.addEventListener('keydown', (e) => {
    const i = ids.indexOf(document.activeElement?.dataset?.family);
    if (i < 0) return;
    const next = { ArrowRight: (i + 1) % ids.length, ArrowLeft: (i - 1 + ids.length) % ids.length, Home: 0, End: ids.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    pick(ids[next], true);
  });
  return seg;
}

/** Notas debajo del selector: el saldo que ya tenés en esa familia y que comprar la otra no lo toca. */
function familyNotes(family, wallets) {
  const mine = wallets.find((w) => w.provider === family);
  const other = wallets.find((w) => w.provider !== family);
  const notes = [];
  if (mine) {
    notes.push(h('p', { class: 'pl-family-note' }, icon('card'), h('span', {}, P('walletSame', { family: familyName(family), left: fmtUsd(mine.remainingUsd), limit: fmtUsd(mine.limitUsd) }))));
  }
  if (other) notes.push(h('p', { class: 'pl-family-note' }, icon('info'), h('span', {}, P('walletOther', { family: familyName(family), other: familyName(other.provider) }))));
  if (!notes.length) notes.push(h('p', { class: 'pl-family-note' }, icon('info'), h('span', {}, P(`familyAbout_${family}`))));
  return h('div', { class: 'pl-family-notes' }, notes);
}

// ---------- Compra ----------// ---------- Compra ----------

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

/**
 * Diálogo de compra: elegir medio de pago, ver impuestos, pagar y esperar la acreditación.
 */
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
      plan.carry?.remainingUsd > 0 ? h('p', { class: 'pl-muted small' }, P('checkoutCarry', { family: familyName(plan.family), amount: fmtUsd(plan.carry.remainingUsd) })) : null,
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

/** Saldos de la cuenta (uno por familia) con el que está en uso y, si el otro tiene saldo, el botón para usarlo. */
export function walletList(wallets) {
  const list = Array.isArray(wallets) ? wallets : [];
  if (!list.length) return null;
  return h('div', { class: 'pl-wallets', role: 'list', 'aria-label': P('walletsTitle') }, list.map((w) => {
    const name = familyName(w.provider);
    const out = !(w.remainingUsd > 0);
    const use = !w.active && !out ? h('button', { type: 'button', class: 'btn sm ghost pl-wallet-use', 'aria-label': P('walletUseOf', { family: name }), onclick: async (e) => {
      const done = setBusy(e.currentTarget);
      try { await useWallet(w.provider); } finally { done(); }
    } }, icon('refresh'), P('walletUse')) : null;
    return h('div', { class: ['pl-use-row', 'pl-wallet', w.active && 'active', out && 'blocked'], role: 'listitem', dataset: { family: w.provider } },
      h('div', { class: 'pl-use-top' },
        h('span', { class: 'pl-use-name' }, P('walletRow', { family: name }), w.planName || w.plan ? h('span', { class: 'pl-wallet-plan' }, ` · ${w.planName || planDisplayName(w)}`) : null),
        w.active ? h('span', { class: 'pill good pl-wallet-pill' }, icon('check'), P('walletInUse')) : out ? h('span', { class: 'pill warn pl-wallet-pill' }, P('walletEmpty')) : use),
      h('div', { class: 'pl-use-vals' }, h('span', { class: 'num' }, P('walletLeft', { left: fmtUsd(w.remainingUsd ?? 0), limit: fmtUsd(w.limitUsd ?? 0) }))),
      w.limitUsd ? bar(P('walletRow', { family: name }), w.usedUsd, w.limitUsd) : null);
  }));
}

export function usageView(st) {
  const options = Array.isArray(st?.modelOptions) ? st.modelOptions : [];
  const budget = st?.budget;
  const resets = st?.resets || {};
  const wallets = Array.isArray(st?.wallets) ? st.wallets : [];
  if (!options.length && !budget && !wallets.length) return h('p', { class: 'pl-muted' }, P('noUsage'));
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
  // Con saldos (servidor de la 6.1) cada uno muestra su barra; con una cuota vieja, el presupuesto de siempre
  if (wallets.length) budgetRow = walletList(wallets);
  else if (budget && budget.limitUsd) {
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
  return h('div', { class: 'pl-usage' }, budgetRow, rows, notes);
}

// ---------- Historial de pagos ----------

function ordersView(list) {
  if (!list.length) return null;
  const tone = { paid: 'good', pending: 'warn', refunded: 'bad', failed: 'bad', cancelled: '', expired: '' };
  return h('section', { class: 'pl-history' },
    h('h3', { class: 'pl-section-title' }, P('historyTitle')),
    h('ul', { class: 'pl-history-list' }, list.slice(0, 8).map((o) => h('li', { class: 'pl-history-row' },
      h('span', { class: 'pl-history-main' }, h('strong', {}, planDisplayName({ plan: o.plan, planName: o.planName }) || o.plan), h('span', { class: 'pl-muted small' }, `${providerName(o.provider)} · ${o.createdAt ? fmtDate(Date.parse(o.createdAt), { day: 'numeric', month: 'short', year: 'numeric' }) : '—'}${o.live ? '' : ` · ${P('testPayment')}`}`)),
      h('span', { class: 'num' }, o.amount ? fmtMoney(o.amount, o.currency) : '—'),
      h('span', { class: ['badge', tone[o.status] || ''] }, P(`order_${['paid', 'pending', 'refunded', 'failed', 'cancelled', 'expired'].includes(o.status) ? o.status : 'pending'}`))))));
}

export function plansPanel({ variant = 'page', go = navigate } = {}) {
  const stateBox = h('div', { class: 'pl-state', 'aria-live': 'polite' });
  const familyBox = h('div', { class: 'pl-family' });
  const cards = h('div');
  const history = h('div');
  const panelId = `pl-family-panel-${++familySeq}`;
  const cardsPanel = h('div', { class: 'pl-family-panel', role: 'tabpanel', id: panelId }, cards);
  const root = h('div', { class: ['pl-panel', `pl-${variant}`] }, stateBox, familyBox, cardsPanel, history);
  let alive = true;
  let seq = 0;
  // Lo último que se leyó: se redibuja sin volver a pedir nada al cambiar de familia
  const view = { catalog: null, state: null, wallets: [], family: null, chosen: false };
  const helpLink = () => h('p', { class: 'pl-secure', style: { marginTop: '16px' } }, icon('message'), P('helpText'), ' ',
    h('button', { type: 'button', class: 'btn sm ghost', onclick: () => go('support') }, P('goSupport')));
  const walletOf = (family) => view.wallets.find((w) => w.provider === family) || null;
  // Familia que se muestra: la que eligió el usuario; si no, la del saldo en uso o la del plan; si no, la primera que
  // se puede comprar (con un servidor 6.0, sin la clave de un motor o con su familia desactivada, no se abre vacía)
  function defaultFamily() {
    const mine = view.wallets.find((w) => w.active)?.provider || (view.state?.active && view.state.plan ? familyOf(view.state.plan) : null);
    if (mine) return mine;
    const plans = mergeCatalog(view.catalog);
    const first = (test) => FAMILIES.find((f) => plans.some((p) => p.family === f.id && test(p)))?.id;
    return first((p) => Object.keys(p.prices).length > 0) || first((p) => p.available) || FAMILIES[0].id;
  }

  function drawState() {
    const s = view.state;
    if (!s) return;
    const twoWallets = view.wallets.length > 1;
    // El nombre sale del saldo en uso (se relee con cada ai:quota): billing:state queda viejo después de un cambio de saldo
    const inUse = view.wallets.find((w) => w.active);
    // Con un saldo en uso hay plan, diga lo que diga billing:state (puede llegar más tarde o venir de otra consulta)
    const active = Boolean(s.active || inUse);
    mount(stateBox, h('div', { class: ['pl-current', active && 'active'] },
      h('div', { class: 'pl-current-icon' }, icon('crown')),
      h('div', { class: 'pl-current-main' }, h('div', { class: 'pl-current-label' }, P(twoWallets ? 'yourWallets' : 'yourPlan')),
        h('div', { class: 'pl-current-name' }, active ? planDisplayName(inUse || { plan: s.plan, planName: s.planName }) : P('noPlanTitle')),
        h('p', { class: 'pl-current-text' }, P(active ? (twoWallets ? 'activeBalanceTwo' : 'activeBalance') : 'noPlanText')),
        view.wallets.length ? walletList(view.wallets) : null)));
  }

  function drawFamily() {
    const family = view.family || defaultFamily();
    const focusInTabs = familyBox.contains(document.activeElement);
    mount(familyBox,
      familySwitch(family, (next) => {
        view.family = next;
        drawFamily();
      }, panelId),
      familyNotes(family, view.wallets));
    cardsPanel.setAttribute('aria-labelledby', `${panelId}-tab-${family}`);
    if (focusInTabs) familyBox.querySelector(`[data-family="${family}"]`)?.focus({ preventScroll: true });
    const catalog = view.catalog;
    const ready = catalog && Object.values(catalog.providers || {}).some(Boolean);
    const open = (p) => openCheckout({ ...p, carry: walletOf(p.family) }, catalog);
    const current = view.wallets.length ? view.wallets.map((w) => w.plan) : view.state?.active ? [view.state.plan] : [];
    const list = planCards({ catalog, current, onSelect: open, family });
    // Toda la familia sin habilitar (falta su clave en el servidor): las tarjetas se ven igual, con el aviso arriba.
    const familyOff = mergeCatalog(catalog).filter((p) => p.family === family).every((p) => !p.available);
    const notForSale = () => h('div', { class: 'notice info', style: { marginBottom: '12px' } }, icon('clock'), h('div', {}, P('familyNotForSale', { family: familyName(family) })));
    mount(cards,
      list.childNodes.length ? (familyOff ? [notForSale(), list] : list) : notForSale(),
      ready ? null : h('div', { class: 'notice info', style: { marginTop: '12px' } }, icon('info'), h('div', {}, P('paymentsSoon'))),
      helpLink());
  }

  async function loadWallets() {
    const st = await api.invoke('assistant:status').catch(() => null);
    view.wallets = Array.isArray(st?.wallets) ? st.wallets : [];
  }

  async function reload() {
    const request = ++seq;
    await preparePlans();
    if (!alive || request !== seq) return;
    view.catalog = await api.invoke('billing:catalog').catch(() => null);
    if (!alive || request !== seq) return;
    drawFamily();
    try {
      const [s] = await Promise.all([api.invoke('billing:state'), loadWallets()]);
      if (!alive || request !== seq) return;
      view.state = s;
      drawState();
      drawFamily();
      if (variant === 'page') {
        const list = await api.invoke('billing:orders').catch(() => []);
        if (alive && request === seq) mount(history, ordersView(list));
      }
    } catch (err) {
      if (!alive || request !== seq) return;
      const signedOut = ['noSession', 'noCloud'].includes(err?.code);
      // Sin sesión: fuera el plan y los saldos de la cuenta anterior (insignias y notas de las tarjetas)
      if (signedOut) {
        view.state = null;
        view.wallets = [];
        drawFamily();
      }
      mount(stateBox, h('div', { class: 'notice', role: signedOut ? 'status' : 'alert' }, icon('info'),
        h('div', { class: 'spacer' }, signedOut ? P('signInText') : P('loadError', { error: err?.message || String(err) })),
        h('button', { type: 'button', class: 'btn sm', onclick: signedOut ? () => go('settings/cloud/venus') : reload }, P(signedOut ? 'signIn' : 'retry'))));
    }
  }
  // Cambió el saldo (respuesta de la IA, cambio de saldo a mano): solo se vuelven a leer los saldos
  let quotaTimer = null;
  const offQuota = api.on('ai:quota', () => {
    clearTimeout(quotaTimer);
    quotaTimer = setTimeout(async () => {
      if (!alive || !view.state) return;
      await loadWallets();
      if (!alive) return;
      drawState();
      drawFamily();
    }, 300);
  });
  const offBilling = api.on('billing:changed', reload);
  const offAuth = cloud.on('auth', reload);
  root.destroy = () => { alive = false; seq++; clearTimeout(quotaTimer); offBilling?.(); offAuth?.(); offQuota?.(); };
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
