'use strict';
// IA falsa SOLO para pruebas y capturas de desarrollo (nunca se usa en la app empaquetada):
//   createScriptedAi(fn)  respuestas programadas por las pruebas (selftest.js)
//   createDemoAi(opts)    conversacion de demostracion para devshot (VENUS_ASSISTANT_FAKE=1), que usa las
//                         herramientas reales sobre los datos de la carpeta temporal. { plan: 'none' }
//                         (VENUS_ASSISTANT_FAKE=noplan) simula una cuenta sin plan; { plan: '<id>' }, ese plan;
//                         { scenario: 'wallets' }, saldo de Claude (en uso) y de ChatGPT; { scenario: 'switch' },
//                         el saldo de Claude se termina en la primera respuesta y el servidor pasa al de ChatGPT
//                         (switched). Un pedido que nombra "respaldo" responde como si lo hubiera atendido el
//                         proveedor de respaldo (el de la otra familia).
// Imita la forma de modules/ai.messages(): { content, stop_reason, usage, model, quota, switched, via } y, como
// modules/ai, cachedQuota() (QuotaV3 conocida), provider() y useWallet().

let sigCounter = 0;
const thinkingBlock = () => ({ type: 'thinking', thinking: '', signature: `fake-signature-${++sigCounter}` });
let toolCounter = 0;
const toolUse = (name, input) => ({ type: 'tool_use', id: `toolu_fake_${++toolCounter}`, name, input });
const text = (s) => ({ type: 'text', text: s });
const MODEL_IDS = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' };
const FAMILY_MODEL_IDS = { anthropic: MODEL_IDS, openai: { haiku: 'gpt-6-luna', sonnet: 'gpt-5.6-sol' } };

// ai.quota (QuotaV2 o null) y ai.via ('backend' o null) los pueden cambiar las pruebas.
function createScriptedAi(script) {
  const ai = {
    calls: [],
    quota: null,
    via: 'backend',
    cachedQuota: () => ai.quota,
    provider: async () => ai.via,
    async messages(opts) {
      ai.calls.push(JSON.parse(JSON.stringify({ ...opts, signal: undefined })));
      if (opts.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      const r = await script(opts, ai.calls.length);
      if (r instanceof Error) throw r;
      return { content: r.content, stop_reason: r.stop_reason || 'end_turn', usage: { input_tokens: 100, output_tokens: 20 }, model: r.model || 'fake', served_by: r.served_by || null, quota: r.quota || null, switched: r.switched || null, via: 'fake' };
    },
  };
  return ai;
}

// ---------- Demo para capturas ----------
function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user' || !Array.isArray(m.content)) continue;
    const texts = m.content.filter((b) => b.type === 'text');
    if (texts.length && !m.content.some((b) => b.type === 'tool_result')) return { index: i, text: texts[texts.length - 1].text, context: texts[0].text };
  }
  return { index: -1, text: '', context: '' };
}

function lastResults(messages) {
  const m = messages[messages.length - 1];
  if (!m || m.role !== 'user' || !Array.isArray(m.content)) return [];
  return m.content
    .filter((b) => b.type === 'tool_result')
    .map((b) => {
      try {
        return JSON.parse(b.content);
      } catch {
        return {};
      }
    });
}

function instanceFromContext(ctx) {
  const m = String(ctx || '').match(/selected_instance: (\{.*\})/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]).id || null;
  } catch {
    return null;
  }
}

function createDemoAi({ plan = 'claude_ultra', scenario = null } = {}) {
  // Capturas de desarrollo con el mismo catálogo de planes que usa el launcher.
  const catalog = require('./plans.json').plans;
  const find = (id) => catalog.find((p) => p.id === id);
  // Saldos de ejemplo: uno por familia. El que tiene active: true es el que se usa.
  let wallets;
  if (scenario === 'wallets') wallets = [{ provider: 'anthropic', plan: 'claude_pro', usedUsd: 1.2, active: true }, { provider: 'openai', plan: 'go', usedUsd: 3.55, active: false }];
  else if (scenario === 'switch') wallets = [{ provider: 'anthropic', plan: 'claude_go', usedUsd: 6.7, active: true }, { provider: 'openai', plan: 'pro', usedUsd: 0.8, active: false }];
  else if (plan === 'none') wallets = [];
  else {
    const p = find(plan) || find('claude_ultra');
    wallets = [{ provider: p.provider, plan: p.id, usedUsd: Math.round(p.budgetUsd * 18) / 100, active: true }];
  }
  let pendingSwitch = scenario === 'switch';
  const used = { haiku: 3, sonnet: 2 };
  const activeWallet = () => wallets.find((w) => w.active) || null;
  const selectedPlan = () => (activeWallet() ? find(activeWallet().plan) : null);
  let lastModel = selectedPlan()?.models.at(-1).id || 'haiku';
  const noPlan = !wallets.length;
  const emptyQuota = () => ({
    plan: null,
    planName: null,
    priceUsd: null,
    status: 'none',
    models: [],
    budget: { usedUsd: 0, limitUsd: 0 },
    wallets: [],
    resets: { daily: null, weekly: null, monthly: null },
    timezone: 'America/Argentina/Buenos_Aires',
  });
  const walletView = (w) => {
    const p = find(w.plan);
    const usedUsd = Math.round(w.usedUsd * 100) / 100;
    return { provider: w.provider, plan: p.id, planName: p.name, tier: p.tier, usedUsd, limitUsd: p.budgetUsd, remainingUsd: Math.max(0, Math.round((p.budgetUsd - usedUsd) * 100) / 100), active: w.active };
  };
  const quota = () => {
    if (noPlan) return emptyQuota();
    const selected = selectedPlan();
    const w = activeWallet();
    return {
      plan: selected.id,
      planName: selected.name,
      priceUsd: selected.priceUsd,
      provider: selected.provider,
      tier: selected.tier,
      maxTokensPerRequest: selected.maxTokensPerRequest,
      status: 'active',
      models: selected.models.map((m) => ({ ...m, model: MODEL_IDS[m.id], providerModel: FAMILY_MODEL_IDS[selected.provider][m.id], daily: { used: used[m.id] || 0, limit: null }, weekly: { used: used[m.id] || 0, limit: null } })),
      budget: { usedUsd: Math.round(w.usedUsd * 100) / 100, limitUsd: selected.budgetUsd },
      wallets: wallets.map(walletView),
      resets: { daily: null, weekly: null, monthly: null },
      timezone: 'America/Argentina/Buenos_Aires',
      lastModel: selected.models.some((m) => m.id === lastModel) ? lastModel : selected.models[0].id,
    };
  };
  // Elegir a mano qué saldo usar (como la RPC ai_use_wallet): solo uno con saldo.
  async function useWallet(family) {
    const next = wallets.find((w) => w.provider === family);
    if (!next || walletView(next).remainingUsd <= 0) {
      const { t } = require('../../core/i18n');
      throw Object.assign(new Error(t('ai.errWallet')), { code: 'error' });
    }
    for (const w of wallets) w.active = w === next;
    return quota();
  }
  const wait = (ms, signal) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    });

  async function messages({ messages: msgs, model, signal }) {
    await wait(350, signal);
    if (noPlan) {
      const { t } = require('../../core/i18n');
      throw Object.assign(new Error(t('ai.errNoPlan')), { code: 'noplan' });
    }
    const user = lastUserText(msgs);
    const step = msgs.slice(user.index + 1).filter((m) => m.role === 'assistant').length;
    const q = user.text.toLowerCase();
    const inst = instanceFromContext(user.context);
    const results = lastResults(msgs);
    // Escenario "switch": la primera llamada agota el saldo de Claude y el servidor pasa al de ChatGPT
    let switched = null;
    if (pendingSwitch) {
      pendingSwitch = false;
      const from = activeWallet();
      const to = wallets.find((w) => w !== from);
      from.usedUsd = find(from.plan).budgetUsd;
      from.active = false;
      to.active = true;
      switched = { from: from.provider, to: to.provider, reason: 'budget' };
    }
    const selected = selectedPlan();
    const family = selected.provider;
    const other = family === 'anthropic' ? 'openai' : 'anthropic';
    const alias = selected.models.some((m) => m.id === model) ? model : selected.models[0].id;
    // "respaldo": como si el proveedor del plan hubiera fallado y respondiera el otro (served_by.failover del backend)
    const failover = /respaldo|backup/.test(q);
    const servedBy = failover ? { provider: other, model: FAMILY_MODEL_IDS[other].haiku, failover: true } : { provider: family, model: FAMILY_MODEL_IDS[family][alias], failover: false };
    const reply = (content, stop = 'end_turn') => ({
      content: failover || family === 'openai' ? content : [thinkingBlock(), ...content],
      stop_reason: stop,
      usage: { input_tokens: 2400, output_tokens: 180, cache_read_input_tokens: 2000 },
      model: servedBy.model,
      served_by: servedBy,
      quota: quota(),
      switched,
      via: 'fake',
    });
    if (step === 0) {
      used[alias] = (used[alias] || 0) + 1;
      lastModel = alias;
      const w = activeWallet();
      if (w) w.usedUsd = Math.min(find(w.plan).budgetUsd, w.usedUsd + (alias === 'sonnet' ? 0.09 : 0.02));
    }

    if (!inst && step === 0 && !/hola|hello|qué podés|que podes/.test(q)) return reply([toolUse('list_instances', {})], 'tool_use');
    const instId = inst || results[0]?.instances?.[0]?.id || null;

    if (/crash|crashea|se cierra|se cae/.test(q) && instId) {
      if (step <= 1 && !results.some((r) => r.found !== undefined)) return reply([toolUse('read_crash_summary', { instance_id: instId }), toolUse('list_mods', { instance_id: instId })], 'tool_use');
      const crash = results.find((r) => r.found !== undefined) || {};
      const suspect = crash.suspected_mods?.[0]?.file || 'un mod';
      return reply([
        text(
          `Encontré el problema.\n\n**Qué pasa:** el juego se cierra al cargar el mundo por un error de *mixin* en **${suspect}**. Ese mod no es compatible con la versión de Minecraft de esta instancia.\n\n**Cómo lo arreglo:**\n1. Desactivo \`${suspect}\` (no lo borro, queda como \`.disabled\`).\n2. Abrís el juego para confirmar que ya no crashea.\n\n¿Querés que lo desactive?`,
        ),
      ]);
    }
    if (/optimiz|fps|lag|rendimiento|performance/.test(q) && instId) {
      if (step === 0 || (step === 1 && !inst)) return reply([text('Primero miro tu equipo y la instancia.'), toolUse('get_system_specs', {}), toolUse('get_instance_info', { instance_id: instId })], 'tool_use');
      if (!results.some((r) => r.before !== undefined || r.changed !== undefined || r.scope)) {
        return reply(
          [
            toolUse('set_option', { instance_id: instId, key: 'renderDistance', value: '8' }),
            toolUse('set_option', { instance_id: instId, key: 'particles', value: 'decreased' }),
            toolUse('set_ram', { scope: 'instance', instance_id: instId, max_mb: 2048 }),
          ],
          'tool_use',
        );
      }
      return reply([
        text(
          'Listo, ajusté la instancia para que vaya más fluida:\n\n- **Distancia de render: 8 chunks** — es lo que más pesa en la GPU.\n- **Partículas: reducidas** — menos caídas de FPS en explosiones y lluvia.\n- **RAM: 2 GB** — suficiente para esta instancia sin dejar a Windows sin memoria.\n\nSi algo no te convence, tocá **Deshacer** en cada cambio. Para ganar todavía más FPS te recomiendo **Sodium**; ¿lo instalo?',
        ),
      ]);
    }
    if (/sac|quit|borr|elimin|remove/.test(q) && instId) {
      if (!results.some((r) => r.files || r.removed || r.error)) return reply([toolUse('list_mods', { instance_id: instId })], 'tool_use');
      const list = results.find((r) => r.files)?.files || [];
      if (list.length && !results.some((r) => r.removed || r.error)) return reply([toolUse('remove_mod', { instance_id: instId, file: list[list.length - 1].file })], 'tool_use');
      const r = results.find((x) => x.removed || x.error) || {};
      return reply([text(r.removed ? `Listo: mandé **${r.removed}** a la papelera.` : 'Perfecto, no saqué nada. Si cambiás de idea, avisame.')]);
    }
    return reply([
      text(
        '¡Hola! Soy el asistente de **Venus Launcher**. Puedo:\n\n- Diagnosticar **crashes** y proponerte el arreglo.\n- **Buscar e instalar** mods, resource packs y shaders compatibles.\n- Armar un **modpack** nuevo según lo que quieras.\n- **Optimizar** tu instancia para tener más FPS.\n\nContame qué necesitás. Por ejemplo: `Mi juego crashea, ¿qué pasa?`',
      ),
    ]);
  }

  return {
    messages,
    useWallet,
    cachedQuota: () => quota(),
    provider: async () => 'backend',
    async status() {
      const q = quota();
      const selected = selectedPlan();
      return { provider: 'fake', enabled: true, cloudConfigured: true, signedIn: true, configured: true, model: noPlan ? null : FAMILY_MODEL_IDS[selected.provider][q.lastModel], models: [], efforts: noPlan ? [] : selected.models.find((m) => m.id === q.lastModel).efforts, quota: q, planFamily: noPlan ? null : selected.provider, planTier: noPlan ? null : selected.tier, plans: catalog };
    },
  };
}

module.exports = { createScriptedAi, createDemoAi, toolUse, text, thinkingBlock };
