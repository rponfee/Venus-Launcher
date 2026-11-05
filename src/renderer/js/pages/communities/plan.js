// Tarjeta "Plan" de una comunidad: qué plan tiene (Clanes Go, Pro, Max o Ultra), hasta cuándo, cuánto de cada cupo usa, qué da cada
// plan y cómo comprarlo o renovarlo con el mismo flujo de pago que los planes de IA (Mercado Pago o PayPal). Cada pago dura 30
// días y se renueva a mano: no hay débito automático. Solo el dueño compra; el resto lo ve. Si el servidor no tiene la migración,
// se muestra "no disponible" y nada se rompe. Lógica pura: features/communities/plan.js · guía: docs/wip/planes-clan-46.md.
import { h, icon, mount, modal, ensureCss, fmtDate, skeleton, emptyState } from '../../ui.js';
import { t, loadNs } from '../../i18n.js';
import { api } from '../../store.js';
import { openCheckout, preparePlans, fmtUsd, fmtMoney } from '../../features/plans.js';
import { normalizePlanState, usageRows, planStatus, daysLeft, offers, checkoutPlan, buyKind, hasRoom } from '../../features/communities/plan.js';
import { notifyLooksChanged } from './looks-view.js';

const P = (key, vars) => t(`communityplans.${key}`, vars);
const day = (iso) => fmtDate(Date.parse(iso), { day: 'numeric', month: 'long', year: 'numeric' });
// El nombre del plan sale del idioma ("Clanes Pro" / "Clans Pro"), no del servidor: así el botón y el pago dicen lo mismo.
const planName = (tier) => P('clanName', { name: String(tier).charAt(0).toUpperCase() + String(tier).slice(1) });

/** Precio final de una oferta: pesos y dólares tal como los cobra cada medio de pago (impuestos incluidos). */
function priceLine(offer) {
  const ars = offer.prices.mercado_pago;
  const usd = offer.prices.paypal;
  if (!ars && !usd) return h('div', { class: 'cp-offer-price' }, h('strong', { class: 'num' }, fmtUsd(offer.priceUsd)), h('span', { class: 'cl-muted small' }, P('listPrice')));
  return h('div', { class: 'cp-offer-price' },
    h('strong', { class: 'num' }, fmtMoney((ars || usd).total, (ars || usd).currency)),
    ars && usd ? h('span', { class: 'cl-muted small num' }, P('orUsd', { price: fmtUsd(usd.total) })) : null,
    h('span', { class: 'cl-muted small' }, P('perPeriod', { days: offer.periodDays })));
}

function limitsList(limits) {
  const rows = [
    ['image', P('perkMedia', { n: limits.media, count: limits.media })],
    limits.backdrops ? ['palette', P('perkBackdrops', { n: limits.backdrops, count: limits.backdrops })] : null,
    limits.stages ? ['headphones', P('perkStages', { n: limits.stages, count: limits.stages })] : null,
    ['sparkles', P(limits.animated ? 'perkAnimated' : 'perkStill')],
    limits.members > 500 ? ['users', P('perkMembers', { n: new Intl.NumberFormat().format(limits.members) })] : null,
    limits.channels > 50 ? ['hash', P('perkChannels', { n: limits.channels })] : null,
    limits.roles > 15 ? ['tag', P('perkRoles', { n: limits.roles })] : null,
    limits.priority ? ['zap', P('perkPriority')] : null,
  ].filter(Boolean);
  return h('ul', { class: 'cp-perks' }, rows.map(([glyph, text]) => h('li', {}, icon(glyph), h('span', {}, text))));
}

/** Abre la tarjeta Plan de la comunidad. onChange: se avisa cuando el plan cambia (para recargar la comunidad). */
export async function openPlanDialog(b, community, { onChange } = {}) {
  await Promise.all([loadNs('communityplans'), preparePlans()]);
  ensureCss('features/communityplans');
  let state = null;
  let catalog = null;
  let closed = false;
  let seq = 0;
  const body = h('div', { class: 'stack cp-plan' }, skeleton('card', { lines: 5 }));
  const off = api.on?.('billing:changed', (e) => { if (e?.kind === 'clan' && (!e.community || e.community === community.id)) load(); });
  const m = modal({ title: P('planTitle'), subtitle: community.name, icon: 'crown', size: 'wide', body, onClose: () => { closed = true; off?.(); } });

  function currentCard() {
    const status = planStatus(state);
    const days = daysLeft(state.plan.endsAt);
    return h('section', { class: ['card', 'cp-current', `is-${status}`] },
      h('div', { class: 'cp-current-head' },
        h('span', { class: 'cp-crown', 'aria-hidden': 'true' }, icon('crown')),
        h('div', { class: 'cp-current-main' },
          h('div', { class: 'cl-muted small' }, P('currentLabel')),
          h('strong', { class: 'cp-current-name' }, state.plan.id === 'free' ? P('freeName') : planName(state.plan.id)),
          h('div', { class: 'cp-status', role: 'status' }, status === 'free' ? P('statusFree') : P(status === 'soon' ? 'statusSoon' : 'statusActive', { date: day(state.plan.endsAt), days, count: days }))),
        status === 'soon' ? h('span', { class: 'badge warn' }, icon('clock'), P('renewSoon')) : null),
      h('p', { class: 'cp-manual' }, icon('info'), h('span', {}, P('manualNote', { days: state.plan.periodDays }))));
  }

  function usageCard() {
    const rows = usageRows(state);
    return h('section', { class: 'card cp-usage' }, h('h3', { class: 'cl-h4' }, P('usageTitle')),
      h('ul', { class: 'cp-usage-list' }, rows.map((r) => h('li', { class: ['cp-usage-row', r.full && 'is-full', !r.included && 'is-off'] },
        h('span', {}, P(`usage_${r.key}`)),
        h('span', { class: 'num' }, r.included ? P('usageOf', { used: r.used, max: r.max }) : P('usageNone')),
        r.included ? h('div', { class: ['progress', 'cp-bar', r.full && 'full'], role: 'progressbar', 'aria-label': P(`usage_${r.key}`), 'aria-valuemin': 0, 'aria-valuemax': r.max, 'aria-valuenow': Math.min(r.used, r.max) }, h('i', { style: { width: `${r.pct}%` } })) : null))),
      state.hiddenMedia > 0 ? h('div', { class: 'notice warn' }, icon('eyeOff'), h('div', {}, P('hiddenNote', { n: state.hiddenMedia, count: state.hiddenMedia }))) : null,
      !hasRoom(state, 'backdrops') && state.plan.limits.backdrops === 0 ? h('p', { class: 'cl-muted small' }, P('noLooksNote')) : null);
  }

  function offerCard(raw) {
    const offer = { ...raw, name: planName(raw.tier) };
    const kind = buyKind(offer);
    const canPay = state.isOwner && Boolean(offer.prices.mercado_pago || offer.prices.paypal);
    const buy = h('button', { class: ['btn', offer.current ? 'tonal' : 'primary'], type: 'button', disabled: !canPay,
      title: !state.isOwner ? P('ownerOnly') : !canPay ? P('paymentsOff') : null,
      onclick: () => openCheckout(checkoutPlan({ ...offer, name: offer.name }, community.id, { onPaid: () => { load(); onChange?.(); notifyLooksChanged(community.id); } }), catalog) }, icon('crown'), P(`cta_${kind}`, { plan: offer.name }));
    return h('article', { class: ['card', 'cp-offer', offer.current && 'is-current', offer.tier === 'ultra' && 'is-top'], role: 'listitem' },
      h('div', { class: 'cp-offer-head' }, h('h3', { class: 'cp-offer-name' }, offer.name), offer.current ? h('span', { class: 'badge accent' }, P('current')) : null),
      priceLine(offer), limitsList(offer.limits),
      offer.lower ? h('p', { class: 'cl-muted small' }, P('queueNote')) : null,
      h('div', { class: 'cp-offer-foot' }, buy));
  }

  function draw() {
    const list = offers(catalog, state);
    mount(body, currentCard(), usageCard(),
      h('h3', { class: 'cl-h4' }, P('plansTitle')),
      !state.isOwner ? h('div', { class: 'notice info' }, icon('lock'), h('div', {}, P('ownerOnly'))) : null,
      list.length
        ? h('div', { class: 'cp-offers', role: 'list', 'aria-label': P('plansTitle') }, list.map(offerCard))
        : h('div', { class: 'notice info' }, icon('info'), h('div', {}, P('noOffers'))),
      h('p', { class: 'cl-muted small' }, icon('shieldCheck'), ' ', P('refundNote')));
  }

  async function load() {
    const mine = ++seq;
    try {
      const [raw, cat] = await Promise.all([b.rpc('community_plan_get', { p_community: community.id }), api.invoke('billing:catalog').catch(() => null)]);
      if (closed || mine !== seq) return;
      state = normalizePlanState(raw);
      catalog = cat;
      if (!state) throw new Error('unavailable');
      draw();
    } catch {
      if (closed || mine !== seq) return;
      mount(body, emptyState('alert', P('unavailable'), P('unavailableText'), h('button', { class: 'btn', type: 'button', onclick: () => { mount(body, skeleton('card', { lines: 5 })); load(); } }, icon('refresh'), P('retry'))));
    }
  }
  load();
  return m;
}
