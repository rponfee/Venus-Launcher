// Current offers only. Historical assignments keep their original names in user records.
// Precios de lista en USD (PayPal cobra esto; con Mercado Pago el servidor los pasa a pesos con la cotización).
export const PLAN_CATALOG = Object.freeze([
  { id: 'basic', name: 'Basic', price: 4, budget: 2, tokens: 12000, models: ['Haiku 5.5'], efforts: ['low', 'medium'] },
  { id: 'go', name: 'Go', price: 8, budget: 4.5, tokens: 16000, models: ['Haiku 5.5'], efforts: ['low', 'medium', 'high'] },
  { id: 'pro', name: 'Pro', price: 15, budget: 8.5, tokens: 24000, models: ['Haiku 5.5', 'Sonnet 5.5'], efforts: ['low', 'medium', 'high'] },
  { id: 'max', name: 'Max', price: 35, budget: 20, tokens: 36000, models: ['Haiku 5.5', 'Sonnet 5.5'], efforts: ['low', 'medium', 'high', 'xhigh'] },
].map((plan) => Object.freeze({ ...plan, models: Object.freeze(plan.models), efforts: Object.freeze(plan.efforts) })));

/** Select current server entries in catalog order without changing their configured limits. */
export function currentPlans(plans) {
  const entries = new Map((Array.isArray(plans) ? plans : []).filter((p) => p && typeof p.id === 'string').map((p) => [p.id, p]));
  return PLAN_CATALOG.filter((p) => entries.has(p.id)).map((p) => ({ ...entries.get(p.id), name: p.name, priceUsd: entries.get(p.id).priceUsd ?? p.price }));
}

/** Offer prices are current; confirmed payment totals always come from server records. */
export function planOverviewRows(plans, paymentsReady) {
  const entries = new Map((Array.isArray(plans) ? plans : []).filter((p) => p && typeof (p.plan ?? p.id) === 'string').map((p) => [p.plan ?? p.id, p]));
  return PLAN_CATALOG.map((p) => {
    const entry = entries.get(p.id);
    return {
      ...p, ...entry, id: p.id, name: p.name, priceUsd: entry?.priceUsd ?? p.price,
      active: entry?.active ?? (paymentsReady ? 0 : null),
      planActive: entry?.planActive ?? true,
      paying: paymentsReady ? entry?.support ?? entry?.paying ?? 0 : null,
      manual: paymentsReady ? entry?.manual ?? 0 : null,
      confirmedUsd: paymentsReady ? entry?.confirmedUsd ?? 0 : null,
    };
  });
}
