// Venus Pass (#/pass): la temporada, el nivel con su progreso, los premios de las dos pistas (gratis y premium), las
// ediciones del pase (Go, Pro y Max) con la compra, y cómo se sube de nivel. Estado compartido en features/pass.js;
// reglas y RPC en supabase/migrations/0026_venus_pass.sql · guía: docs/venus-pass.md.
import { h, icon, mount, skeleton, emptyState, setBusy, toast, fail, modal, fmtNumber, fmtDate } from '../ui.js';
import { api, store } from '../store.js';
import { t, has } from '../i18n.js';
import { navigate } from '../app.js';
import { getPass, onPass, loadPass, claim, claimAll, passBackend } from '../features/pass.js';
import { itemName } from '../features/rewards.js';
import { fmtMoney, fmtUsd, fmtArs } from '../features/plans.js';
import { pointsTicket, levelBadge } from '../features/cosmic-art.js';
import { openAppearance } from './pass/appearance.js';
import { levelInfo, rewardsByLevel, tierOffers, seasonState, daysLeft, claimableList, xpSources } from './pass/logic.js';

const P = (key, vars) => t(`pass.${key}`, vars);
const PROVIDERS = ['mercado_pago', 'paypal'];
const KIND_ICON = { frame: 'user', name_effect: 'sparkles', title: 'tag', badge_style: 'shield' };
const errText = (err) => (err?.code && has(`pass.err_${err.code}`) ? P(`err_${err.code}`) : err?.message && has(`pass.err_${err.message}`) ? P(`err_${err.message}`) : t('rewards.err_server'));
const tierName = (tier) => P(`tier_${tier}`);
let checkoutSeq = 0;

function pageHead(me) {
  const st = me ? seasonState(me.season) : 'none';
  let when = null;
  if (st === 'active') {
    const d = daysLeft(me.season.endsAt);
    when = d > 0 ? P('daysLeft', { count: d, n: fmtNumber(d) }) : P('endsToday');
  } else if (st === 'ended') when = P('ended');
  else if (st === 'upcoming') when = P('upcoming', { date: fmtDate(Date.parse(me.season.startsAt)) });
  return h('div', { class: 'page-head' },
    h('div', { class: 'ph-text' }, h('h1', { class: 'page-title' }, P('title')), h('p', { class: 'page-sub' }, P('subtitle'))),
    me ? h('div', { class: 'ps-season' }, h('span', { class: 'ps-season-label' }, P('seasonLabel')), h('strong', {}, me.season.name), when ? h('span', { class: ['ps-season-when', `is-${st}`] }, icon('calendar'), when) : null) : null);
}

// ---------- Premios ----------
function rewardFace(r) {
  if (r.kind === 'points') return [pointsTicket(`+${fmtNumber(r.amount)}`, { label: P('points', { n: fmtNumber(r.amount) }), compact: true }), h('span', { class: 'ps-tile-sub' }, P('points', { n: fmtNumber(r.amount) }))];
  return [h('span', { class: 'ps-tile-icon ps-tile-item' }, icon(KIND_ICON[r.kind] || 'gift')), h('span', { class: 'ps-tile-name' }, itemName(r.itemId)), h('span', { class: 'ps-tile-sub' }, has(`pass.kind_${r.kind}`) ? P(`kind_${r.kind}`) : r.kind)];
}

function tile(r, level, onClaim) {
  if (!r) return h('div', { class: 'ps-tile ps-tile-empty', 'aria-hidden': 'true' });
  const el = h('div', { class: ['ps-tile', `is-${r.track}`, `is-${r.state}`], role: 'group', 'aria-label': `${P(`track${r.track === 'free' ? 'Free' : 'Premium'}`)} · ${P('locked', { level: r.level })}` }, ...rewardFace(r));
  if (r.state === 'claimable') {
    const btn = h('button', { type: 'button', class: 'btn primary sm ps-claim' }, icon('gift'), P('claim'));
    btn.addEventListener('click', async () => {
      const done = setBusy(btn);
      try { await onClaim(r); } finally { done(); }
    });
    el.append(btn);
  } else if (r.state === 'claimed') el.append(h('span', { class: 'ps-tile-state' }, icon('check'), P('claimed')));
  else if (r.state === 'needsPass') el.append(h('span', { class: 'ps-tile-state' }, icon('lock'), P('needsPass')));
  else el.append(h('span', { class: 'ps-tile-state' }, icon('lock'), P('locked', { level: r.level })));
  return el;
}

function trackView(me, onClaim) {
  const rows = rewardsByLevel(me);
  const scroller = h('div', { class: 'ps-track', role: 'list', 'aria-label': P('trackTitle') });
  for (const row of rows) {
    const isCurrent = row.level === me.level;
    scroller.append(h('div', { class: ['ps-col', row.level <= me.level && 'is-reached', isCurrent && 'is-current'], role: 'listitem' },
      h('div', { class: 'ps-col-level' }, levelBadge(row.level, store.settings?.passAppearance, { compact: true }), isCurrent ? h('span', { class: 'ps-col-tag' }, P('current')) : null),
      tile(row.free, me.level, onClaim),
      tile(row.premium, me.level, onClaim)));
  }
  const legend = h('div', { class: 'ps-legend', 'aria-hidden': 'true' }, h('span', { class: 'ps-legend-spacer' }), h('span', { class: 'ps-legend-row is-free' }, P('trackFree')), h('span', { class: 'ps-legend-row is-premium' }, icon('crown'), P('trackPremium')));
  const wrap = h('section', { class: 'card ps-track-card' },
    h('div', { class: 'card-head' }, h('div', {}, h('h2', { class: 'card-title' }, icon('layers'), P('trackTitle')), h('p', { class: 'card-sub' }, P('trackHint')))),
    h('div', { class: 'ps-track-wrap' }, legend, scroller));
  // Arranca mostrando el nivel actual
  queueMicrotask(() => {
    const cur = scroller.querySelector('.ps-col.is-current') || scroller.querySelector('.ps-col:not(.is-reached)');
    if (cur) scroller.scrollLeft = Math.max(0, cur.offsetLeft - scroller.clientWidth / 2 + cur.offsetWidth / 2);
  });
  return wrap;
}

// ---------- Nivel ----------
function heroView(me, { onClaimAll, onBuy, onCustomize }) {
  const lv = levelInfo(me);
  const claimable = claimableList(me).length;
  const claimBtn = claimable ? h('button', { type: 'button', class: 'btn primary' }, icon('gift'), P('claimAllCount', { count: claimable })) : null;
  if (claimBtn) claimBtn.addEventListener('click', async () => { const done = setBusy(claimBtn); try { await onClaimAll(); } finally { done(); } });
  const buyBtn = !me.purchase && seasonState(me.season) === 'active' ? h('button', { type: 'button', class: 'btn', onclick: onBuy }, icon('rocket'), P('tiersTitle')) : null;
  return h('section', { class: 'card ps-hero' },
    h('div', { class: 'ps-emblem' }, levelBadge(lv.level, store.settings?.passAppearance, { label: P('level') }), h('button', { type: 'button', class: 'btn sm ghost ps-customize', onclick: onCustomize }, icon('palette'), P('customize'))),
    h('div', { class: 'ps-progress-wrap' },
      h('div', { class: 'ps-progress-head' }, h('strong', {}, lv.maxed ? P('levelMax') : P('levelOf', { level: lv.level, levels: lv.levels })), h('span', { class: 'ps-muted' }, lv.maxed ? P('xpTotal', { n: fmtNumber(me.xp.total) }) : P('xpToNext', { n: fmtNumber(lv.toNext), level: lv.level + 1 }))),
      h('div', { class: 'ps-progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(lv.pct), 'aria-label': P('levelOf', { level: lv.level, levels: lv.levels }) }, h('i', { style: { width: `${lv.pct}%` } })),
      h('div', { class: 'ps-chips' },
        me.purchase ? h('span', { class: ['ps-chip', `is-${me.purchase.tier}`] }, icon('crown'), P('yourTier', { tier: tierName(me.purchase.tier) })) : null,
        me.xp.premiumMult > 1 ? h('span', { class: 'ps-chip' }, icon('sparkles'), P('premiumXp')) : null,
        h('span', { class: 'ps-chip ps-chip-muted' }, icon('star'), P('srcPoints'), ' ', P('xpUnit', { n: fmtNumber(me.xp.fromPoints) })),
        h('span', { class: 'ps-chip ps-chip-muted' }, icon('play'), P('srcPlay'), ' ', P('xpUnit', { n: fmtNumber(me.xp.fromPlay) })),
        me.xp.bonusLevels ? h('span', { class: 'ps-chip ps-chip-muted' }, icon('gift'), P('srcBonus'), ' ', String(me.xp.bonusLevels)) : null)),
    h('div', { class: 'ps-hero-actions' }, claimBtn, buyBtn));
}

// ---------- Ediciones ----------
function perkList(offer, me) {
  const perks = [h('li', {}, icon('check'), P('perkPremium'))];
  if (offer.bonusLevels) perks.push(h('li', {}, icon('check'), P('perkBonus', { count: offer.bonusLevels, n: offer.bonusLevels })));
  if (offer.xpMult > 1) perks.push(h('li', {}, icon('check'), P('perkXp', { n: Math.round((offer.xpMult - 1) * 100) })));
  const lower = me.tiers.filter((x) => x.tier !== offer.tier && me.tiers.indexOf(x) < me.tiers.indexOf(offer)).flatMap((x) => x.perkItems);
  for (const id of offer.perkItems.filter((x) => !lower.includes(x))) perks.push(h('li', {}, icon('check'), P('perkItem', { name: itemName(id) })));
  return h('ul', { class: 'ps-perks' }, perks);
}

function tiersView(me, catalog, onBuy) {
  const offers = tierOffers(me);
  const active = seasonState(me.season) === 'active';
  const cards = offers.map((o) => {
    let action = null;
    if (o.action === 'owned') action = h('span', { class: 'ps-owned' }, icon('check'), o.current ? P('tierOwned') : P('tierIncluded'));
    else if (active) {
      const label = o.action === 'upgrade' ? P('upgrade', { tier: tierName(o.tier), amount: fmtUsd(o.price) }) : P('buy', { amount: fmtUsd(o.price) });
      action = h('button', { type: 'button', class: ['btn', o.tier === 'max' ? 'primary' : ''], onclick: () => onBuy(o) }, icon('rocket'), label);
    }
    return h('article', { class: ['card ps-tier', `is-${o.tier}`, o.current && 'is-current'] },
      h('div', { class: 'ps-tier-head' }, h('span', { class: 'ps-tier-name' }, tierName(o.tier)), h('span', { class: 'ps-tier-price num' }, fmtUsd(o.priceUsd))),
      perkList(o, me),
      h('div', { class: 'ps-tier-foot' }, action));
  });
  const allOwned = offers.every((o) => o.action === 'owned');
  return h('section', { class: 'ps-tiers' },
    h('div', { class: 'ps-section-head' }, h('h2', {}, icon('rocket'), allOwned ? P('tiersOwnedTitle') : P('tiersTitle')), h('p', {}, P('tiersSub'))),
    h('div', { class: 'ps-tier-grid' }, cards));
}

function howView(me) {
  const src = xpSources(me);
  const play = src.find((s) => s.id === 'play');
  const items = [
    [ 'star', P('howPoints') ],
    [ 'play', P('howPlay', { today: fmtNumber(play.today), cap: fmtNumber(play.cap) }) ],
    [ 'crown', P('howPremium') ],
    [ 'sparkles', P('howMax') ],
  ];
  return h('section', { class: 'card ps-how' },
    h('h2', { class: 'card-title' }, icon('info'), P('howTitle')),
    h('ul', { class: 'ps-how-list' }, items.map(([ic, text]) => h('li', {}, icon(ic), h('span', {}, text)))));
}

// ---------- Compra ----------
async function openCheckout(offer, me, catalog) {
  const passCatalog = catalog?.pass;
  const tierCatalog = passCatalog?.tiers?.find((x) => x.tier === offer.tier) || null;
  const fakeMode = !catalog && (await passBackend()).fake;
  const offered = fakeMode ? [...PROVIDERS] : PROVIDERS.filter((id) => catalog?.providers?.[id] && (tierCatalog?.prices?.[id] || offer.action === 'upgrade'));
  if (fakeMode) catalog = { arsPerUsd: 1450 };
  let provider = offered[0] || null;
  let order = null;
  let url = null;
  let off = null;
  const body = h('div', { class: 'pl-co ps-co' });
  let dialog;
  const providerName = (id) => P(id);

  // Precio a mostrar: el del catálogo (precio completo) o, al pasar a una edición mejor, la diferencia estimada.
  function priceFor(id) {
    const q = tierCatalog?.prices?.[id];
    if (offer.action !== 'upgrade' && q) return { total: q.total, currency: q.currency, approx: false };
    if (id === 'paypal') return { total: offer.price, currency: 'USD', approx: false };
    const rate = catalog?.arsPerUsd;
    return rate ? { total: Math.ceil((offer.price * rate) / 100) * 100, currency: 'ARS', approx: true } : null;
  }

  function chooseView() {
    if (!offered.length) return mount(body, h('div', { class: 'notice warn' }, icon('alert'), h('div', {}, P('noProviders'))));
    const pay = h('button', { type: 'button', class: 'btn primary pl-pay' });
    const group = `ps-provider-${++checkoutSeq}`;
    const options = h('div', { class: 'pl-providers', role: 'radiogroup', 'aria-label': P('chooseMethod') }, offered.map((id) => {
      const q = priceFor(id);
      const input = h('input', { type: 'radio', name: group, value: id, checked: id === provider, onchange: () => { provider = id; draw(); } });
      return h('label', { class: 'pl-provider' }, input,
        h('span', { class: 'pl-provider-text' }, h('strong', {}, providerName(id)), h('span', { class: 'pl-muted small' }, id === 'mercado_pago' ? P('mpHint') : P('paypalHint'))),
        h('span', { class: 'pl-provider-price num' }, q ? `${q.approx ? `${P('approx')} ` : ''}${fmtMoney(q.total, q.currency)}` : '—'));
    }));
    const draw = () => {
      const q = priceFor(provider);
      mount(pay, icon('lock'), q ? P('payWith', { amount: fmtMoney(q.total, q.currency), provider: providerName(provider) }) : providerName(provider));
      for (const r of options.querySelectorAll('input')) r.checked = r.value === provider;
    };
    pay.addEventListener('click', async () => {
      const done = setBusy(pay);
      try {
        const b = await passBackend();
        if (b.fake) {
          // Capturas: la "compra" se acredita sola
          await new Promise((r) => setTimeout(r, 800));
          b.grant(offer.tier);
          order = { id: 'fake', status: 'paid', planName: `Venus Pass ${tierName(offer.tier)}` };
          await loadPass({ force: true });
          resultView(order);
          return;
        }
        const res = await api.invoke('billing:checkout', { plan: offer.planId, provider });
        order = res.order;
        url = res.url;
        waitView();
      } catch (err) {
        if (err?.code === 'noSession') { dialog?.close(); navigate('settings/cloud'); return; }
        fail(P('checkoutFailed'), err);
      } finally { done(); }
    });
    mount(body,
      h('p', { class: 'pl-co-sub' }, P('checkoutIntro', { season: me.season.name })),
      offer.action === 'upgrade' && me.purchase ? h('div', { class: 'notice info' }, icon('info'), h('div', {}, P('checkoutUpgrade', { from: tierName(me.purchase.tier) }))) : null,
      options,
      h('p', { class: 'pl-secure' }, icon('shieldCheck'), P('secure')),
      h('div', { class: 'pl-co-foot' }, pay));
    draw();
  }

  function waitView(timedOut = false) {
    const check = h('button', { type: 'button', class: 'btn' }, icon('refresh'), P('checkAgain'));
    check.addEventListener('click', async () => {
      const done = setBusy(check);
      try { onOrder(await api.invoke('billing:order', order.id)); } catch (err) { fail(P('checkFailed'), err); } finally { done(); }
    });
    mount(body,
      h('div', { class: 'pl-wait', role: 'status', 'aria-live': 'polite' },
        timedOut ? icon('clock') : h('div', { class: 'spinner', 'aria-hidden': 'true' }),
        h('div', {}, h('strong', {}, P(timedOut ? 'timeoutTitle' : 'waitingTitle')), h('p', {}, P(timedOut ? 'timeoutText' : 'waitingText', { provider: providerName(order.provider || provider) })))),
      order?.amount ? h('p', { class: 'pl-muted small' }, fmtMoney(order.amount, order.currency)) : null,
      h('div', { class: 'pl-actions' },
        url ? h('button', { type: 'button', class: 'btn', onclick: () => api.invoke('billing:reopen', url).catch((err) => fail(P('checkoutFailed'), err)) }, icon('external'), P('reopen')) : null,
        check));
  }

  function resultView(o) {
    const paid = o.status === 'paid';
    mount(body,
      h('div', { class: ['pl-result', paid ? 'good' : 'bad'], role: 'status' },
        icon(paid ? 'check' : 'x'),
        h('div', {}, h('strong', {}, paid ? P('paidTitle', { tier: tierName(offer.tier) }) : P('failedTitle')), h('p', {}, paid ? P('paidText') : P('failedText')))),
      h('div', { class: 'pl-co-foot' }, paid
        ? h('button', { type: 'button', class: 'btn primary', onclick: () => dialog.close() }, P('done'))
        : h('button', { type: 'button', class: 'btn primary', onclick: () => { order = null; url = null; chooseView(); } }, icon('refresh'), P('tryAgain'))));
  }

  function onOrder(o) {
    if (!order || !o || o.id !== order.id) return;
    if (o.status === 'timeout') return waitView(true);
    order = { ...order, ...o };
    if (o.status === 'paid') { loadPass({ force: true }).catch(() => {}); resultView(order); }
    else if (['failed', 'cancelled', 'expired', 'refunded'].includes(o.status)) resultView(order);
    else waitView();
  }

  off = api.on('billing:order', onOrder);
  dialog = modal({ title: P('checkoutTitle', { tier: tierName(offer.tier) }), icon: 'rocket', size: 'sm', body, onClose: () => off?.() });
  chooseView();
}

// ---------- Página ----------
export default {
  ns: ['pass', 'rewards', 'plans'],
  css: ['pages/pass', 'features/plans', 'features/cosmic-art'],
  async render(root) {
    const b = await passBackend();
    if (!root.isConnected) return null;
    let alive = true;
    const cleanups = [];
    let catalog = null;
    let appearanceDialog = null;
    cleanups.push(() => appearanceDialog?.close());

    if (!b.signedIn()) {
      mount(root, pageHead(null), h('div', { class: 'ps-signed-out' }, emptyState('logIn', P('signInTitle'), P('signInText'),
        h('button', { type: 'button', class: 'btn primary', onclick: () => navigate('settings/cloud') }, icon('logIn'), P('signIn')))));
      return () => { alive = false; };
    }

    const body = h('div', { class: 'ps-body' });
    mount(root, pageHead(null), body);
    mount(body, skeleton(3));

    async function onClaim(r) {
      try {
        const res = await claim(r.level, r.track);
        toast('good', P('claimedOne', { level: r.level }), res?.kind === 'points' ? P('claimedPoints', { n: fmtNumber(res.points) }) : itemName(res?.itemId || r.itemId), 4500);
      } catch (err) {
        fail(P('claimError'), errText(err));
      }
    }
    async function onClaimAll() {
      try {
        const res = await claimAll();
        const items = (res?.claimed || []).filter((x) => x.kind === 'item').length;
        toast('good', P('claimedTitle'), [res?.points ? P('claimedPoints', { n: fmtNumber(res.points) }) : '', items ? P('claimedItems', { count: items }) : ''].filter(Boolean).join(' '), 6000);
      } catch (err) {
        fail(P('claimError'), errText(err));
      }
    }
    const onCustomize = () => {
      const me = getPass().data;
      if (!me) return;
      appearanceDialog?.close();
      appearanceDialog = openAppearance(me.level);
    };
    const onBuy = (offer) => {
      const me = getPass().data;
      if (!me) return;
      const o = offer || tierOffers(me).find((x) => x.action !== 'owned');
      if (o) openCheckout(o, me, catalog).catch((err) => fail(P('checkoutFailed'), err));
    };

    function paint() {
      if (!alive) return;
      const { data: me, error, at } = getPass();
      if (error && !me) {
        mount(body, h('div', { class: 'notice bad' }, icon('alert'), h('div', {}, P('loadError')), h('button', { type: 'button', class: 'btn sm', onclick: () => { mount(body, skeleton(3)); loadPass({ force: true }); } }, icon('refresh'), P('retry'))));
        return;
      }
      if (!at && !me) return;
      if (!me) {
        mount(root, pageHead(null), emptyState('calendar', P('noSeason'), P('noSeasonText')));
        return;
      }
      if (root.firstChild) root.firstChild.replaceWith(pageHead(me));
      mount(body, heroView(me, { onClaimAll, onBuy, onCustomize }), tiersView(me, catalog, onBuy), trackView(me, onClaim), howView(me));
    }

    cleanups.push(onPass(paint));
    cleanups.push(store.on('settings', paint));
    cleanups.push(b.onAuth?.(() => navigate('pass')) || (() => {}));
    try {
      catalog = b.fake ? null : await api.invoke('billing:catalog').catch(() => null);
    } catch { catalog = null; }
    await loadPass({ force: true });
    paint();
    return () => {
      alive = false;
      cleanups.forEach((fn) => fn?.());
    };
  },
};
