'use strict';
// Datos de ejemplo del panel de administración SOLO para capturas de desarrollo (VENUS_DEVSHOT + VENUS_ADMIN_FAKE=1,
// nunca en la app empaquetada; lo decide ../admin.js). Todo vive en memoria: no habla con Supabase ni con Stripe,
// así que no puede dar ni usar permisos reales de admin. Las formas son las mismas que devuelve la Edge Function.

const ADMIN_ID = '00000000-0000-4000-8000-00000000a001';
const NOW = Date.UTC(2026, 9, 27, 18, 0, 0);
const DAY = 86400000;
const iso = (ms) => (ms === null || ms === undefined ? null : new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const PLANS = require('../assistant/plans.json').plans.map((p) => ({
  id: p.id, name: p.name, price: Math.round(p.priceUsd * 100), budget: p.budgetUsd,
  tokens: p.maxTokensPerRequest, calls: 60, rpm: 60,
  models: p.models.map((m) => [m.id, m.efforts, 2147483647, 2147483647]),
}));
const MODELS = [
  { id: 'haiku', label: 'Haiku 5.5', active: true },
  { id: 'sonnet', label: 'Sonnet 5.5', active: true },
];

// [email, usuario, plan, origen, estado heredado, gasto, preguntas, días desde el alta, extra]
const PEOPLE = [
  ['admin@venus.test', 'VenusAdmin', 'max', 'support', null, 4.1234, 212, 240, { admin: true }],
  ['lucia.mc@gmail.com', 'LuSkyBuilder', 'pro', 'support', null, 2.3121, 88, 120],
  ['tomi_pvp@hotmail.com', 'TomiPvP', 'basic', 'support', null, 0.8410, 61, 64],
  ['creeperking@yahoo.com', 'CreeperKing', null, null, null, 0, 0, 33, { banned: 7, banReason: 'Spam de links en los mensajes' }],
  ['sofi.redstone@gmail.com', 'SofiRedstone', 'pro', 'support', null, 7.9020, 196, 210],
  ['mateo.builds@outlook.com', 'MateoBuilds', 'max', 'support', null, 3.0012, 140, 180],
  ['nico.mods@gmail.com', 'NicoMods', null, null, null, 0, 0, 12, { muted: 1, muteReason: 'Insultos en el chat de voz' }],
  ['valen.speedrun@gmail.com', 'ValenSpeedrun', 'pro', 'support', null, 4.4800, 120, 95],
  ['agus.server@gmail.com', 'AgusServer', 'go', 'support', null, 5.1205, 151, 150],
  ['juli.pixel@gmail.com', 'JuliPixel', null, null, null, 0, 0, 2, { unconfirmed: true }],
  ['bauti.farm@gmail.com', 'BautiFarm', 'basic', 'support', null, 1.2210, 140, 70],
  ['emma.shaders@gmail.com', 'EmmaShaders', 'max', 'support', null, 18.9031, 402, 260],
];
const FIRST = ['Luna', 'Kai', 'Thiago', 'Mia', 'Dante', 'Zoe', 'Benja', 'Cami', 'Lola', 'Facu'];
const LAST = ['Craft', 'Miner', 'Builder', 'Blaze', 'Pixel', 'Ender', 'Redstone'];

function uuidFor(i) {
  return `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`;
}

function buildUsers() {
  const users = [];
  const plans = ['basic', 'pro', null, null, 'go', null, 'pro', null, 'go', 'max'];
  PEOPLE.forEach(([email, username, plan, source, stripeStatus, usd, q, ageDays, extra = {}], i) => {
    users.push({ id: i === 0 ? ADMIN_ID : uuidFor(i), email, username, plan, source, stripeStatus, usd, q, ageDays, extra });
  });
  for (let i = 0; i < 31; i++) {
    const name = `${FIRST[i % FIRST.length]}${LAST[(i * 3) % LAST.length]}${i > 9 ? i : ''}`;
    const plan = plans[i % plans.length];
    users.push({
      id: uuidFor(100 + i),
      email: `${name.toLowerCase()}@example.com`,
      username: name,
      plan,
      source: plan ? 'support' : null,
      stripeStatus: null,
      usd: plan ? Math.round(((i * 37) % 90) / 100 * PLANS.find((p) => p.id === plan).budget * 100) / 100 : 0,
      q: plan ? (i * 13) % 160 : 0,
      ageDays: 3 + ((i * 11) % 300),
      extra: {},
    });
  }
  return users.map((u, i) => ({
    ...u,
    createdAt: NOW - u.ageDays * DAY - i * 3600000,
    lastSignInAt: u.extra.unconfirmed ? null : NOW - ((i * 7) % 20) * 3600000 - i * 60000,
    friendCode: `VENUS-${(u.username.toUpperCase().replace(/[^A-Z]/g, '') + 'XYZWQK').slice(0, 6)}`,
    moderation: {
      bannedUntil: u.extra.banned ? NOW + u.extra.banned * DAY : null,
      banReason: u.extra.banReason || null,
      mutedUntil: u.extra.muted ? NOW + u.extra.muted * DAY : null,
      muteReason: u.extra.muteReason || null,
      notes: u.extra.banned ? 'Avisado dos veces antes del baneo.' : null,
    },
    periodEnd: null,
  }));
}

function createFakeAdmin() {
  let users = buildUsers();
  let seq = 0;
  const plans = PLANS.map((p, i) => ({
    id: p.id,
    name: p.name,
    active: true,
    sort: (i + 1) * 10,
    priceUsd: p.price / 100,
    currency: 'USD',
    monthlyBudgetUsd: p.budget,
    maxTokensPerRequest: p.tokens,
    maxCallsPerTurn: p.calls,
    requestsPerMinute: p.rpm,
    subscribers: 0,
    models: p.models.map(([id, efforts, daily, weekly], j) => ({ id, label: MODELS.find((m) => m.id === id).label, modelActive: true, efforts, daily, weekly, sort: (j + 1) * 10 })),
    prices: [],
  }));
  const coupons = [
    {
      id: 'Ab12Cd34',
      name: 'Lanzamiento Pro',
      percentOff: 20,
      amountOff: null,
      currency: null,
      duration: 'repeating',
      durationInMonths: 3,
      maxRedemptions: 200,
      timesRedeemed: 41,
      redeemBy: '2026-12-31T23:59:59Z',
      valid: true,
      createdAt: '2026-10-02T15:00:00Z',
      appliesTo: { products: ['venus_ai_pro', 'venus_ai_max'], plans: ['pro', 'max'] },
      venus: true,
      promotionCodes: [{ id: 'promo_1', code: 'VENUS20', active: true, couponId: 'Ab12Cd34', expiresAt: null, maxRedemptions: null, timesRedeemed: 41, firstTimeOnly: false, restricted: false, createdAt: '2026-10-02T15:00:00Z' }],
    },
    {
      id: 'Ef56Gh78',
      name: 'Bienvenida',
      percentOff: null,
      amountOff: 200,
      currency: 'usd',
      duration: 'once',
      durationInMonths: null,
      maxRedemptions: null,
      timesRedeemed: 12,
      redeemBy: null,
      valid: true,
      createdAt: '2026-09-20T12:00:00Z',
      appliesTo: null,
      venus: true,
      promotionCodes: [{ id: 'promo_2', code: 'BIENVENIDA', active: true, couponId: 'Ef56Gh78', expiresAt: '2026-11-30T23:59:59Z', maxRedemptions: 500, timesRedeemed: 12, firstTimeOnly: true, restricted: false, createdAt: '2026-09-20T12:00:00Z' }],
    },
    {
      id: 'Ij90Kl12',
      name: 'Beta testers',
      percentOff: 50,
      amountOff: null,
      currency: null,
      duration: 'once',
      durationInMonths: null,
      maxRedemptions: 30,
      timesRedeemed: 30,
      redeemBy: null,
      valid: false,
      createdAt: '2026-08-01T12:00:00Z',
      appliesTo: null,
      venus: true,
      promotionCodes: [{ id: 'promo_3', code: 'BETA50', active: false, couponId: 'Ij90Kl12', expiresAt: null, maxRedemptions: 30, timesRedeemed: 30, firstTimeOnly: false, restricted: false, createdAt: '2026-08-01T12:00:00Z' }],
    },
  ];
  const audit = [
    ['users.ban', 3, { duration: '7d', reason: 'Spam de links en los mensajes' }, 2],
    ['users.mute', 6, { duration: '24h', reason: 'Insultos en el chat de voz' }, 0.2],
    ['users.setPlan', 5, { planId: 'max', until: null, note: 'Creador de contenido' }, 4],
    ['coupons.create', null, { couponId: 'Ab12Cd34', name: 'Lanzamiento Pro', kind: 'percent', value: 20, duration: 'repeating', months: 3, promoCode: 'VENUS20' }, 25],
    ['coupons.deactivatePromo', null, { promoId: 'promo_3', code: 'BETA50' }, 9],
    ['plans.update', null, { planId: 'pro', changes: { monthly_budget_usd: 10 } }, 12],
    ['users.resetUsage', 1, { scope: 'today', rows: 2 }, 1],
  ].map(([action, userIndex, details, daysAgo], i) => ({
    id: 100 - i,
    action,
    adminId: ADMIN_ID,
    adminEmail: 'admin@venus.test',
    targetUser: userIndex === null ? null : users[userIndex].id,
    details,
    createdAt: iso(NOW - daysAgo * DAY),
  })).sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const planOf = (id) => plans.find((p) => p.id === id);
  const banned = (u) => Boolean(u.moderation.bannedUntil && u.moderation.bannedUntil > NOW);
  const muted = (u) => Boolean(u.moderation.mutedUntil && u.moderation.mutedUntil > NOW);
  const hasAccess = (u) => Boolean(u.plan && u.source === 'support' && (u.periodEnd === null || u.periodEnd > NOW));

  function row(u) {
    return {
      id: u.id,
      email: u.email,
      emailConfirmed: !u.extra.unconfirmed,
      createdAt: iso(u.createdAt),
      lastSignInAt: iso(u.lastSignInAt),
      username: u.username,
      displayName: u.username,
      friendCode: u.friendCode,
      mcName: u.username.slice(0, 16),
      isAdmin: Boolean(u.extra.admin),
      plan: u.plan
        ? {
            id: u.plan,
            name: planOf(u.plan)?.name || u.plan,
            status: u.planStatus || 'active',
            active: hasAccess(u) && u.planStatus !== 'canceled',
            source: u.source,
            currentPeriodEnd: iso(u.periodEnd),
            cancelAtPeriodEnd: Boolean(u.extra.canceling),
            stripeStatus: u.stripeStatus,
            managedByStripe: u.source === 'stripe',
          }
        : null,
      usage: { monthUsd: u.usd, monthQuestions: u.q },
      moderation: {
        banned: banned(u),
        bannedUntil: banned(u) ? iso(u.moderation.bannedUntil) : null,
        banReason: banned(u) ? u.moderation.banReason : null,
        muted: muted(u),
        mutedUntil: muted(u) ? iso(u.moderation.mutedUntil) : null,
      },
    };
  }

  function overview() {
    const active = users.filter((u) => hasAccess(u) && u.planStatus !== 'canceled');
    const paying = active.filter((u) => u.source === 'support');
    const byPlan = plans.map((p) => {
      const on = active.filter((u) => u.plan === p.id);
      const pay = on.filter((u) => u.source === 'support');
      return { plan: p.id, name: p.name, planActive: p.active, priceUsd: p.priceUsd, active: on.length, paying: pay.length, support: pay.length, manual: on.length - pay.length, legacy: 0, confirmedUsd: Math.round(pay.length * p.priceUsd * 100) / 100, confirmedPayments: pay.length, mrrUsd: 0 };
    });
    return {
      users: {
        total: users.length,
        new7d: users.filter((u) => NOW - u.createdAt < 7 * DAY).length,
        new30d: users.filter((u) => NOW - u.createdAt < 30 * DAY).length,
        confirmed: users.filter((u) => !u.extra.unconfirmed).length,
        banned: users.filter(banned).length,
        muted: users.filter(muted).length,
        admins: 1,
      },
      subscriptions: {
        active: active.length,
        paying: paying.length,
        support: paying.length,
        legacy: 0,
        trialing: 0,
        manual: active.length - paying.length,
        pastDue: users.filter((u) => u.stripeStatus === 'past_due').length,
        canceling: users.filter((u) => u.extra.canceling).length,
        byPlan,
      },
      revenue: { mode: 'one_time', currency: 'usd', confirmedUsd: Math.round(byPlan.reduce((s, p) => s + p.confirmedUsd, 0) * 100) / 100, confirmedPayments: paying.length, monthUsd: Math.round(byPlan.reduce((s, p) => s + p.confirmedUsd, 0) * 100) / 100, monthPayments: paying.length, mrrUsd: 0 },
      ai: {
        monthUsd: Math.round(users.reduce((s, u) => s + u.usd, 0) * 10000) / 10000,
        monthQuestions: users.reduce((s, u) => s + u.q, 0),
        monthCalls: users.reduce((s, u) => s + u.q * 3, 0),
        activeUsers: users.filter((u) => u.q > 0).length,
        since: '2026-10-01',
        byModel: [
          { model: 'haiku', label: 'Haiku 5.5', usd: 21.4402, questions: 2110, calls: 6020 },
          { model: 'sonnet', label: 'Sonnet 5.5', usd: 38.9113, questions: 402, calls: 1180 },
        ],
      },
      generatedAt: iso(NOW),
      stripe: { configured: false, mode: null },
    };
  }

  function list(p) {
    const q = String(p.search || '').trim().toLowerCase();
    let out = users.filter((u) => !q || [u.email, u.username, u.friendCode, u.id].some((v) => String(v).toLowerCase().includes(q)));
    if (p.plan === 'none') out = out.filter((u) => !hasAccess(u));
    else if (p.plan) out = out.filter((u) => u.plan === p.plan && hasAccess(u));
    if (p.status === 'active') out = out.filter(hasAccess);
    if (p.status === 'none') out = out.filter((u) => !u.plan);
    if (p.status === 'past_due') out = out.filter((u) => u.stripeStatus === 'past_due');
    if (p.status === 'canceling') out = out.filter((u) => u.extra.canceling);
    if (p.status === 'stripe') out = out.filter((u) => hasAccess(u) && u.source === 'stripe');
    if (p.status === 'manual') out = out.filter((u) => hasAccess(u) && u.source !== 'stripe');
    if (p.status === 'inactive') out = out.filter((u) => u.plan && !hasAccess(u));
    if (p.banned === true) out = out.filter(banned);
    if (p.banned === false) out = out.filter((u) => !banned(u));
    if (p.muted === true) out = out.filter(muted);
    if (p.muted === false) out = out.filter((u) => !muted(u));
    const sort = p.sort || 'created';
    out.sort((a, b) =>
      sort === 'email' ? a.email.localeCompare(b.email) : sort === 'spend' ? b.usd - a.usd : sort === 'lastSignIn' ? (b.lastSignInAt || 0) - (a.lastSignInAt || 0) : b.createdAt - a.createdAt,
    );
    const page = Math.max(1, p.page || 1);
    const perPage = Math.min(100, Math.max(1, p.perPage || 25));
    return { total: out.length, page, perPage, users: out.slice((page - 1) * perPage, page * perPage).map(row) };
  }

  function detail(id) {
    const u = users.find((x) => x.id === id);
    if (!u) {
      const err = new Error('Ese usuario no existe (o ya se borró).');
      err.code = 'notFound';
      throw err;
    }
    const r = row(u);
    const plan = u.plan ? planOf(u.plan) : null;
    const models = (plan ? plan.models : []).map((m, i) => {
      const share = i === 0 ? 0.6 : i === 1 ? 0.3 : 0.1;
      const q = Math.round(u.q * share);
      return {
        model: m.id,
        label: m.label,
        today: { usd: Math.round(u.usd * share * 8) / 100, questions: Math.min(m.daily, Math.round(q / 9)), calls: Math.round(q / 3) },
        week: { usd: Math.round(u.usd * share * 30) / 100, questions: Math.round(q / 3), calls: q },
        month: { usd: Math.round(u.usd * share * 10000) / 10000, questions: q, calls: q * 3, tokens: q * 41000 },
      };
    });
    const sum = (k) => ({
      usd: Math.round(models.reduce((s, m) => s + m[k].usd, 0) * 10000) / 10000,
      questions: models.reduce((s, m) => s + m[k].questions, 0),
      calls: models.reduce((s, m) => s + m[k].calls, 0),
    });
    return {
      account: { id: u.id, email: u.email, emailConfirmed: r.emailConfirmed, emailConfirmedAt: r.emailConfirmed ? r.createdAt : null, createdAt: r.createdAt, lastSignInAt: r.lastSignInAt, bannedUntil: r.moderation.bannedUntil, providers: ['email'], isAdmin: r.isAdmin },
      profile: { username: u.username, displayName: u.username, friendCode: u.friendCode, mcName: r.mcName, mcUuid: null, bio: null, badges: [], status: 'online', statusText: null, lastSeen: r.lastSignInAt, createdAt: r.createdAt },
      subscription: u.plan
        ? {
            planId: u.plan,
            planName: plan?.name || u.plan,
            status: u.planStatus || 'active',
            active: r.plan.active,
            source: u.source,
            currentPeriodEnd: iso(u.periodEnd),
            cancelAtPeriodEnd: Boolean(u.extra.canceling),
            graceUntil: u.stripeStatus === 'past_due' ? iso(NOW + 2 * DAY) : null,
            stripeStatus: u.stripeStatus,
            stripeCustomerId: u.source === 'stripe' ? `cus_test${u.id.slice(-6)}` : null,
            stripeSubscriptionId: u.source === 'stripe' ? `sub_test${u.id.slice(-6)}` : null,
            stripePriceId: u.source === 'stripe' ? `price_test_${u.plan}1` : null,
            managedByStripe: u.source === 'stripe',
            lastSyncedAt: u.source === 'stripe' ? iso(NOW - 3 * 3600000) : null,
            createdAt: r.createdAt,
            updatedAt: iso(NOW - DAY),
          }
        : null,
      stripeCustomer: u.source === 'stripe' ? { customerId: `cus_test${u.id.slice(-6)}`, livemode: false } : null,
      usage: {
        models,
        totals: { today: sum('today'), week: sum('week'), month: sum('month') },
        quota: plan ? { plan: plan.id, planName: plan.name, budget: { usedUsd: u.usd, limitUsd: plan.monthlyBudgetUsd }, models: plan.models.map((m, i) => ({ id: m.id, label: m.label, daily: { used: models[i]?.today.questions || 0, limit: m.daily }, weekly: { used: models[i]?.week.questions || 0, limit: m.weekly } })) } : null,
      },
      moderation: { ...r.moderation, banReason: u.moderation.banReason, muteReason: u.moderation.muteReason, notes: u.moderation.notes, updatedByEmail: u.moderation.banReason || u.moderation.muteReason ? 'admin@venus.test' : null, updatedAt: iso(NOW - DAY) },
      actions: audit.filter((a) => a.targetUser === id),
      stripe: { configured: false, mode: null },
    };
  }

  function log(action, targetUser, details) {
    audit.unshift({ id: 1000 + ++seq, action, adminId: ADMIN_ID, adminEmail: 'admin@venus.test', targetUser, details, createdAt: iso(Date.now()) });
  }

  function bulk(ids, action, protect, fn, details = {}) {
    const results = [];
    const warnings = [];
    for (const id of ids || []) {
      const u = users.find((x) => x.id === id);
      if (!u) results.push({ id, ok: false, error: 'not_found' });
      else if (protect && id === ADMIN_ID) results.push({ id, ok: false, error: 'self' });
      else if (protect && u.extra.admin) results.push({ id, ok: false, error: 'target_admin' });
      else {
        const extra = fn(u) || {};
        if (extra.warning) warnings.push({ id, email: u.email, ...extra.warning });
        results.push({ id, ok: true, ...(extra.result || {}) });
        log(action, id, details);
      }
    }
    const ok = results.filter((r) => r.ok).length;
    return { results, summary: { ok, failed: results.length - ok }, warnings, stripe: { configured: false, mode: null } };
  }

  const untilFor = (d) => Date.now() + ({ '1h': 3600000, '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY, permanent: 36500 * DAY }[d] || DAY);
  const couponList = () => ({ configured: true, mode: 'test', coupons, hasMore: false, checkoutAcceptsCodes: true });

  // Pagos (Mercado Pago y PayPal): configuración y órdenes de ejemplo, sin claves reales.
  const payConfig = {
    mercadoPago: { enabled: true, ready: true, tokenHint: '…a1b2', tokenKind: 'app', webhookSecret: false },
    paypal: { enabled: false, ready: false, env: 'sandbox', clientIdHint: null, secret: false, webhookId: false },
    arsPerUsd: 1450, arsRounding: 100, rateUpdatedAt: new Date(Date.now() - 86400000).toISOString(),
    taxes: { ARS: [{ id: 'iva', label: 'IVA', rate: 21, mode: 'included' }], USD: [{ id: 'percepcion', label: 'Percepción RG 5617', rate: 30, mode: 'estimate' }] },
    statementDescriptor: 'VENUS LAUNCHER', updatedAt: new Date().toISOString(), updatedBy: 'admin@venus.test',
  };
  const payUrls = { mercadoPagoNotification: 'https://proyecto.supabase.co/functions/v1/payments?provider=mercado_pago&source_news=webhooks', paypalWebhook: 'https://proyecto.supabase.co/functions/v1/payments?provider=paypal' };
  const payOrders = [
    { id: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001', email: 'nico@venus.test', plan: 'go', planName: 'Go', provider: 'mercado_pago', currency: 'ARS', amount: 11600, status: 'paid', live: true, createdAt: new Date(Date.now() - 3600000).toISOString() },
    { id: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002', email: 'sofi@venus.test', plan: 'pro', planName: 'Pro', provider: 'mercado_pago', currency: 'ARS', amount: 21800, status: 'pending', providerStatus: 'in_process', live: true, createdAt: new Date(Date.now() - 600000).toISOString() },
    { id: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000003', email: 'admin@venus.test', plan: 'basic', planName: 'Basic', provider: 'paypal', currency: 'USD', amount: 4, status: 'paid', live: false, createdAt: new Date(Date.now() - 86400000).toISOString() },
  ];

  const actions = {
    me: () => ({ userId: ADMIN_ID, email: 'admin@venus.test', isAdmin: true, protocol: 1, stripe: { configured: false, mode: null }, storage: true }),
    'payments.get': () => ({ config: payConfig, urls: payUrls }),
    'payments.save': (p) => {
      const s = p.settings || {};
      if ('mercadoPagoEnabled' in s) payConfig.mercadoPago.enabled = s.mercadoPagoEnabled;
      if ('paypalEnabled' in s) payConfig.paypal.enabled = s.paypalEnabled;
      if (s.paypalEnv) payConfig.paypal.env = s.paypalEnv;
      if ('arsPerUsd' in s) payConfig.arsPerUsd = s.arsPerUsd;
      if (s.arsRounding) payConfig.arsRounding = s.arsRounding;
      if (s.taxes) payConfig.taxes = s.taxes;
      if (s.statementDescriptor) payConfig.statementDescriptor = s.statementDescriptor;
      return { config: payConfig, urls: payUrls };
    },
    'payments.test': (p) => (p.provider === 'mercado_pago' ? { ok: true, mode: 'test', nickname: 'TESTUSER123' } : { ok: false, reason: 'missing' }),
    'payments.orders': () => ({ orders: payOrders }),
    'payments.sync': () => ({ order: payOrders[1] }),
    overview,
    'users.list': list,
    'users.get': (p) => detail(p.id),
    'users.setPlan': (p) =>
      bulk(p.ids, 'users.setPlan', false, (u) => {
        const stripeActive = u.source === 'stripe' && u.stripeStatus === 'active';
        Object.assign(u, { plan: p.planId, source: 'admin', stripeStatus: null, planStatus: 'active', periodEnd: p.until ? Date.parse(p.until) : null });
        return stripeActive ? { warning: { code: 'stripe_active', subscriptionId: `sub_test${u.id.slice(-6)}` }, result: { stripeActive } } : null;
      }, { planId: p.planId }),
    'users.removePlan': (p) => bulk(p.ids, 'users.removePlan', false, (u) => Object.assign(u, { planStatus: 'canceled', source: 'admin', stripeStatus: null }) && null),
    'users.ban': (p) =>
      bulk(p.ids, 'users.ban', true, (u) => {
        u.moderation.bannedUntil = untilFor(p.duration);
        u.moderation.banReason = p.reason;
        return { result: { bannedUntil: iso(u.moderation.bannedUntil), sessionsRevoked: 1 } };
      }, { duration: p.duration, reason: p.reason }),
    'users.unban': (p) => bulk(p.ids, 'users.unban', false, (u) => Object.assign(u.moderation, { bannedUntil: null, banReason: null }) && null),
    'users.mute': (p) =>
      bulk(p.ids, 'users.mute', true, (u) => {
        u.moderation.mutedUntil = untilFor(p.duration);
        u.moderation.muteReason = p.reason || null;
        return { result: { mutedUntil: iso(u.moderation.mutedUntil) } };
      }, { duration: p.duration }),
    'users.unmute': (p) => bulk(p.ids, 'users.unmute', false, (u) => Object.assign(u.moderation, { mutedUntil: null, muteReason: null }) && null),
    'users.signOut': (p) => bulk(p.ids, 'users.signOut', true, () => ({ result: { sessionsRevoked: 1 } })),
    'users.resetUsage': (p) => bulk(p.ids, 'users.resetUsage', false, (u) => ((u.q = 0), { result: { rows: 2 } }), { scope: p.scope }),
    'users.delete': (p) => {
      const out = bulk(p.ids, 'users.delete', true, () => ({ result: { canceledSubscriptions: [], filesRemoved: 0 } }));
      const gone = new Set(out.results.filter((r) => r.ok).map((r) => r.id));
      users = users.filter((u) => !gone.has(u.id));
      return out;
    },
    'users.setNotes': (p) => {
      const u = users.find((x) => x.id === p.id);
      if (u) u.moderation.notes = p.notes || null;
      log('users.setNotes', p.id, { length: (p.notes || '').length });
      return { moderation: u ? u.moderation : null, warnings: [] };
    },
    'stripe.cancelSubscription': (p) => {
      const u = users.find((x) => x.id === p.userId);
      if (u && u.source === 'stripe') u.extra.canceling = true;
      log('stripe.cancelSubscription', p.userId, { when: p.when || 'now' });
      return { userId: p.userId, when: p.when || 'now', canceled: u && u.source === 'stripe' ? [{ id: `sub_test${u.id.slice(-6)}`, status: 'active', cancelAtPeriodEnd: true }] : [], warnings: [] };
    },
    'coupons.list': couponList,
    'coupons.create': (p) => {
      const id = `Cp${String(++seq).padStart(6, '0')}`;
      const promo = p.promo ? { id: `promo_n${seq}`, code: String(p.promo.code).toUpperCase(), active: true, couponId: id, expiresAt: p.promo.expiresAt || null, maxRedemptions: p.promo.maxRedemptions || null, timesRedeemed: 0, firstTimeOnly: Boolean(p.promo.firstTimeOnly), restricted: false, createdAt: iso(Date.now()) } : null;
      const coupon = { id, name: p.name || null, percentOff: p.percentOff ?? null, amountOff: p.amountOff ?? null, currency: p.amountOff ? 'usd' : null, duration: p.duration, durationInMonths: p.durationInMonths ?? null, maxRedemptions: p.maxRedemptions ?? null, timesRedeemed: 0, redeemBy: p.redeemBy || null, valid: true, createdAt: iso(Date.now()), appliesTo: p.appliesTo && p.appliesTo.length ? { products: p.appliesTo.map((x) => `venus_ai_${x}`), plans: p.appliesTo } : null, venus: true, promotionCodes: promo ? [promo] : [] };
      coupons.unshift(coupon);
      log('coupons.create', null, { couponId: id, promoCode: promo ? promo.code : null });
      return { coupon, promotionCode: promo, warnings: [] };
    },
    'coupons.addPromo': (p) => {
      const c = coupons.find((x) => x.id === p.couponId);
      const promo = { id: `promo_n${++seq}`, code: String(p.code).toUpperCase(), active: true, couponId: p.couponId, expiresAt: p.expiresAt || null, maxRedemptions: p.maxRedemptions || null, timesRedeemed: 0, firstTimeOnly: Boolean(p.firstTimeOnly), restricted: false, createdAt: iso(Date.now()) };
      if (c) c.promotionCodes.push(promo);
      log('coupons.addPromo', null, { couponId: p.couponId, code: promo.code });
      return { promotionCode: promo, warnings: [] };
    },
    'coupons.deactivatePromo': (p) => setPromo(p.promoId, false),
    'coupons.activatePromo': (p) => setPromo(p.promoId, true),
    'coupons.delete': (p) => {
      const i = coupons.findIndex((x) => x.id === p.couponId);
      if (i >= 0) coupons.splice(i, 1);
      log('coupons.delete', null, { couponId: p.couponId });
      return { deleted: true, couponId: p.couponId, warnings: [] };
    },
    'plans.list': () => ({ plans: plans.map((pl) => ({ ...pl, subscribers: users.filter((u) => u.plan === pl.id && hasAccess(u)).length })), models: MODELS, stripe: { configured: false, mode: null } }),
    'plans.update': (p) => {
      const pl = planOf(p.planId);
      const patch = p.patch || {};
      if (pl) {
        if ('monthlyBudgetUsd' in patch) pl.monthlyBudgetUsd = patch.monthlyBudgetUsd;
        if ('maxTokensPerRequest' in patch) pl.maxTokensPerRequest = patch.maxTokensPerRequest;
        if ('maxCallsPerTurn' in patch) pl.maxCallsPerTurn = patch.maxCallsPerTurn;
        if ('requestsPerMinute' in patch) pl.requestsPerMinute = patch.requestsPerMinute;
        if ('active' in patch) pl.active = patch.active;
        for (const m of patch.models || []) {
          const i = pl.models.findIndex((x) => x.id === m.id);
          if (m.remove) pl.models.splice(i, 1);
          else if (i >= 0) Object.assign(pl.models[i], { efforts: m.efforts, daily: m.daily, weekly: m.weekly });
          else pl.models.push({ id: m.id, label: MODELS.find((x) => x.id === m.id)?.label || m.id, modelActive: true, efforts: m.efforts, daily: m.daily, weekly: m.weekly, sort: 90 });
        }
      }
      log('plans.update', null, { planId: p.planId });
      return { plan: pl, warnings: [] };
    },
    'plans.setPrice': (p) => {
      const pl = planOf(p.planId);
      const prev = pl.prices.find((x) => x.active);
      const priceId = `price_test_${pl.id}${++seq + 1}`;
      if (prev) prev.active = false;
      pl.prices.unshift({ priceId, amount: p.amount, currency: 'usd', interval: 'month', livemode: false, active: true, lookupKey: `venus_ai_${pl.id}_monthly`, createdAt: iso(Date.now()) });
      pl.priceUsd = p.amount / 100;
      log('plans.setPrice', null, { planId: pl.id, amount: p.amount, previousAmount: prev ? prev.amount : null });
      return { planId: pl.id, priceId, previousPriceId: prev ? prev.priceId : null, amount: p.amount, previousAmount: prev ? prev.amount : null, livemode: false, product: `venus_ai_${pl.id}`, portal: 'updated', warnings: [], plan: pl };
    },
    'audit.list': (p) => {
      let out = audit;
      if (p.action) out = out.filter((a) => (p.action.endsWith('.') ? a.action.startsWith(p.action) : a.action === p.action));
      if (p.targetUser) out = out.filter((a) => a.targetUser === p.targetUser);
      const page = Math.max(1, p.page || 1);
      const perPage = Math.min(200, Math.max(1, p.perPage || 50));
      return {
        total: out.length,
        page,
        perPage,
        actions: out.slice((page - 1) * perPage, page * perPage).map((a) => {
          const u = users.find((x) => x.id === a.targetUser);
          return { ...a, targetEmail: u ? u.email : null, targetUsername: u ? u.username : null };
        }),
      };
    },
  };

  function setPromo(promoId, active) {
    for (const c of coupons) {
      const promo = c.promotionCodes.find((x) => x.id === promoId);
      if (promo) {
        promo.active = active;
        log(active ? 'coupons.activatePromo' : 'coupons.deactivatePromo', null, { promoId, code: promo.code });
        return { promotionCode: promo, warnings: [] };
      }
    }
    return { promotionCode: null, warnings: [] };
  }

  return {
    async me() {
      return { isAdmin: true, email: 'admin@venus.test', userId: ADMIN_ID, reason: null, fake: true, checkedAt: new Date().toISOString() };
    },
    async call(action, payload) {
      await wait(120);
      const fn = actions[action];
      if (!fn) {
        const err = new Error(`Acción desconocida: ${action}`);
        err.code = 'badRequest';
        throw err;
      }
      return JSON.parse(JSON.stringify(fn(payload || {})));
    },
  };
}

module.exports = { createFakeAdmin, FAKE_ADMIN_ID: ADMIN_ID };
