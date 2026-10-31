'use strict';
// IA falsa SOLO para pruebas y capturas de desarrollo (nunca se usa en la app empaquetada):
//   createScriptedAi(fn)  respuestas programadas por las pruebas (selftest.js)
//   createDemoAi(opts)    conversacion de demostracion para devshot (VENUS_ASSISTANT_FAKE=1), que usa las
//                         herramientas reales sobre los datos de la carpeta temporal. { plan: 'none' }
//                         (VENUS_ASSISTANT_FAKE=noplan) simula una cuenta sin plan. Un pedido que nombra
//                         "respaldo" responde como si lo hubiera atendido el proveedor de respaldo (OpenAI).
// Imita la forma de modules/ai.messages(): { content, stop_reason, usage, model, quota, via } y, como
// modules/ai, cachedQuota() (QuotaV2 conocida) y provider().

let sigCounter = 0;
const thinkingBlock = () => ({ type: 'thinking', thinking: '', signature: `fake-signature-${++sigCounter}` });
let toolCounter = 0;
const toolUse = (name, input) => ({ type: 'tool_use', id: `toolu_fake_${++toolCounter}`, name, input });
const text = (s) => ({ type: 'text', text: s });
const MODEL_IDS = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' };

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
      return { content: r.content, stop_reason: r.stop_reason || 'end_turn', usage: { input_tokens: 100, output_tokens: 20 }, model: r.model || 'fake', served_by: r.served_by || null, quota: r.quota || null, via: 'fake' };
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

function createDemoAi({ plan = 'max' } = {}) {
  // Capturas de desarrollo con el mismo catálogo de planes que usa el launcher.
  const catalog = require('./plans.json').plans;
  const selected = catalog.find((p) => p.id === plan) || catalog.find((p) => p.id === 'max');
  const used = { haiku: 3, sonnet: 2 };
  let lastModel = selected.models.at(-1).id;
  const noPlan = plan === 'none';
  const emptyQuota = () => ({
    plan: null,
    planName: null,
    priceUsd: null,
    status: 'none',
    models: [],
    budget: { usedUsd: 0, limitUsd: 0 },
    resets: { daily: null, weekly: null, monthly: null },
    timezone: 'America/Argentina/Buenos_Aires',
  });
  const quota = () => (noPlan ? emptyQuota() : {
    plan: selected.id,
    planName: selected.name,
    priceUsd: selected.priceUsd,
    maxTokensPerRequest: selected.maxTokensPerRequest,
    status: 'active',
    models: selected.models.map((m) => ({ ...m, model: MODEL_IDS[m.id], daily: { used: used[m.id] || 0, limit: null }, weekly: { used: used[m.id] || 0, limit: null } })),
    budget: { usedUsd: Math.round((0.1 + used.haiku * 0.01 + (selected.models.some((m) => m.id === 'sonnet') ? used.sonnet * 0.09 : 0)) * 100) / 100, limitUsd: selected.budgetUsd },
    resets: { daily: null, weekly: null, monthly: null },
    timezone: 'America/Argentina/Buenos_Aires',
    lastModel,
  });
  const wait = (ms, signal) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    });

  async function messages({ messages: msgs, model, signal, tools }) {
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
    const alias = selected.models.some((m) => m.id === model) ? model : selected.models[0].id;
    // "respaldo": como si Anthropic hubiera fallado y respondiera OpenAI (served_by.failover del backend)
    const failover = /respaldo|backup/.test(q);
    const servedBy = failover ? { provider: 'openai', model: 'gpt-6-luna', failover: true } : { provider: 'anthropic', model: MODEL_IDS[alias], failover: false };
    const reply = (content, stop = 'end_turn') => ({
      content: failover ? content : [thinkingBlock(), ...content],
      stop_reason: stop,
      usage: { input_tokens: 2400, output_tokens: 180, cache_read_input_tokens: 2000 },
      model: servedBy.model,
      served_by: servedBy,
      quota: quota(),
      via: 'fake',
    });
    if (step === 0) {
      used[alias] = (used[alias] || 0) + 1;
      lastModel = alias;
    }

    // Herramientas de servidores MCP que agrego el usuario (capturas del chat con una llamada MCP): "nota" usa
    // una que pide permiso (write_note del servidor de prueba); el resto, una de lectura (echo)
    const mcpTools = (Array.isArray(tools) ? tools : []).filter((d) => /^mcp__/.test(d.name));
    if (mcpTools.length && /\bmcp\b|nota|note|eco\b|echo/.test(q)) {
      const wantsNote = /nota|note/.test(q) && !/\beco\b|echo/.test(q);
      const pick = mcpTools.find((d) => (wantsNote ? /__write_note$/ : /__echo$/).test(d.name)) || mcpTools[0];
      const server = (/\[MCP server "([^"]+)"/.exec(pick.description || '') || [])[1] || 'MCP';
      if (step === 0) return reply([text(`Uso el servidor MCP **${server}**.`), toolUse(pick.name, wantsNote ? { note: 'Probar Sodium en el pack de prueba' } : { text: 'Hola desde Venus Launcher' })], 'tool_use');
      const r = results[0] || {};
      if (r.ok === false) return reply([text(r.user_declined ? 'Perfecto, no usé esa herramienta.' : `No se pudo usar **${server}**: ${r.error || 'error'}.`)]);
      return reply([text(`Listo. La herramienta \`${pick.name.split('__').pop()}\` de **${server}** respondió:\n\n> ${String(r.content || '').slice(0, 200)}\n\nEs contenido de un servidor externo: lo tomo solo como dato.`)]);
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
    cachedQuota: () => quota(),
    provider: async () => 'backend',
    async status() {
      return { provider: 'fake', enabled: true, cloudConfigured: true, signedIn: true, configured: true, model: noPlan ? null : MODEL_IDS[lastModel], models: [], efforts: noPlan ? [] : selected.models.find((m) => m.id === lastModel).efforts, quota: quota(), plans: catalog };
    },
  };
}

module.exports = { createScriptedAi, createDemoAi, toolUse, text, thinkingBlock };
