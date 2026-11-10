// Current offers only. Historical assignments keep their original names in user records.
// Precios de lista en USD (PayPal cobra esto; con Mercado Pago el servidor los pasa a pesos con la cotización).
// 6.1: dos familias (docs/implementacion/ia-dos-motores.md §2), cada una con cinco niveles. Los planes de Claude tienen
// id claude_*; los de ChatGPT conservan los de la 6.0 (basic, go, pro, max) y suman ultra. El precio y los límites que
// valen son los del servidor (payments_catalog / billing:catalog): esta lista es el respaldo y el orden.

/** Familias en el orden en que se muestran. Los nombres son marcas: no se traducen. */
export const FAMILIES = Object.freeze([
  Object.freeze({ id: 'anthropic', name: 'Claude' }),
  Object.freeze({ id: 'openai', name: 'ChatGPT' }),
]);
export const TIERS = Object.freeze(['basic', 'go', 'pro', 'max', 'ultra']);
const TIER_NAMES = Object.freeze({ basic: 'Basic', go: 'Go', pro: 'Pro', max: 'Max', ultra: 'Ultra' });
/** Nombre de cada clave de modelo según la familia (respaldo: el servidor manda label en el catálogo y en la cuota). */
export const MODEL_LABELS = Object.freeze({
  anthropic: Object.freeze({ haiku: 'Haiku 5.5', sonnet: 'Sonnet 5.5' }),
  openai: Object.freeze({ haiku: 'GPT-6 Luna', sonnet: 'GPT-5.6 Sol' }),
});

const L = ['low'];
const LM = ['low', 'medium'];
const LMH = ['low', 'medium', 'high'];
const LMHX = ['low', 'medium', 'high', 'xhigh'];
const ALL = ['low', 'medium', 'high', 'xhigh', 'max'];
// [id, familia, nivel, precio, saldo de API, tokens por respuesta, claves de modelo, esfuerzos]
const ROWS = [
  ['claude_basic', 'anthropic', 'basic', 6, 3.5, 12000, ['haiku'], LM],
  ['claude_go', 'anthropic', 'go', 10, 6.75, 32000, ['haiku'], LMH],
  ['claude_pro', 'anthropic', 'pro', 18, 12.5, 44000, ['haiku', 'sonnet'], LMH],
  ['claude_max', 'anthropic', 'max', 32, 26, 78000, ['haiku', 'sonnet'], LMHX],
  ['claude_ultra', 'anthropic', 'ultra', 40, 32, 128000, ['haiku', 'sonnet'], ALL],
  ['basic', 'openai', 'basic', 6, 3.5, 12000, ['haiku'], L],
  ['go', 'openai', 'go', 10, 6.75, 32000, ['haiku'], LMH],
  ['pro', 'openai', 'pro', 18, 12.5, 44000, ['haiku'], LMH],
  ['max', 'openai', 'max', 32, 26, 78000, ['haiku', 'sonnet'], LMH],
  ['ultra', 'openai', 'ultra', 40, 28, 128000, ['haiku', 'sonnet'], LMH],
];

export function familyName(family) {
  return FAMILIES.find((f) => f.id === family)?.name || '';
}

/** 'anthropic' | 'openai' de un plan ({ provider, id | plan }) o de un id. Un plan sin provider (servidor 6.0) es de OpenAI. */
export function familyOf(plan) {
  if (plan && typeof plan === 'object' && FAMILIES.some((f) => f.id === plan.provider)) return plan.provider;
  const id = String((plan && typeof plan === 'object' ? plan.plan ?? plan.id : plan) || '').toLowerCase();
  if (!id) return null;
  return id.startsWith('claude_') ? 'anthropic' : 'openai';
}

/** 'basic' ... 'ultra' de un plan o de un id (claude_pro y pro dan 'pro'); null si no es un plan actual. */
export function tierOf(plan) {
  if (plan && typeof plan === 'object' && TIERS.includes(plan.tier)) return plan.tier;
  const id = String((plan && typeof plan === 'object' ? plan.plan ?? plan.id : plan) || '').toLowerCase().replace(/^claude_/, '');
  return TIERS.includes(id) ? id : null;
}

/** "Claude Pro" / "ChatGPT Pro". Acepta un plan del catálogo, una cuota, un saldo o una orden; sin datos, el nombre que traiga. */
export function planDisplayName(plan) {
  if (!plan) return '';
  const obj = typeof plan === 'object' ? plan : { id: plan };
  const id = obj.plan ?? obj.id;
  const tier = tierOf(obj);
  const family = familyOf(obj);
  const base = (tier && TIER_NAMES[tier]) || obj.planName || obj.name || id || '';
  if (!tier || !family) return String(base);
  return `${familyName(family)} ${base}`;
}

export const PLAN_CATALOG = Object.freeze(ROWS.map(([id, family, tier, price, budget, tokens, models, efforts]) => Object.freeze({
  id,
  family,
  tier,
  name: TIER_NAMES[tier],
  fullName: `${familyName(family)} ${TIER_NAMES[tier]}`,
  price,
  budget,
  tokens,
  modelIds: Object.freeze([...models]),
  models: Object.freeze(models.map((m) => MODEL_LABELS[family][m])),
  efforts: Object.freeze([...efforts]),
})));

/** Planes de una familia, en orden de nivel. */
export const familyPlans = (family) => PLAN_CATALOG.filter((p) => p.family === family);

/** Select current server entries in catalog order without changing their configured limits. */
export function currentPlans(plans) {
  const entries = new Map((Array.isArray(plans) ? plans : []).filter((p) => p && typeof p.id === 'string').map((p) => [p.id, p]));
  return PLAN_CATALOG.filter((p) => entries.has(p.id)).map((p) => ({
    ...entries.get(p.id),
    name: p.fullName,
    tierName: p.name,
    family: p.family,
    tier: p.tier,
    priceUsd: entries.get(p.id).priceUsd ?? p.price,
  }));
}

/** Offer prices are current; confirmed payment totals always come from server records. */
export function planOverviewRows(plans, paymentsReady) {
  const entries = new Map((Array.isArray(plans) ? plans : []).filter((p) => p && typeof (p.plan ?? p.id) === 'string').map((p) => [p.plan ?? p.id, p]));
  return PLAN_CATALOG.map((p) => {
    const entry = entries.get(p.id);
    return {
      ...p, ...entry, id: p.id, name: p.fullName, tierName: p.name, family: p.family, tier: p.tier, priceUsd: entry?.priceUsd ?? p.price,
      active: entry?.active ?? (paymentsReady ? 0 : null),
      planActive: entry?.planActive ?? true,
      paying: paymentsReady ? entry?.support ?? entry?.paying ?? 0 : null,
      manual: paymentsReady ? entry?.manual ?? 0 : null,
      confirmedUsd: paymentsReady ? entry?.confirmedUsd ?? 0 : null,
    };
  });
}
