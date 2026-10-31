// Ajustes > Inteligencia artificial (estado de la IA con tu cuenta de Venus y tu plan, uso del plan, prueba,
// Claude y ChatGPT por MCP, servidores MCP del asistente y privacidad) y Plan (planes de Venus IA, en features/plans.js).
// La IA va siempre por el servidor del launcher con el plan de la cuenta: no hay API key propia ni elección de
// modelo acá (el modelo y el esfuerzo se eligen en el Asistente).
import { h, icon, mount, fail, skeleton } from '../../ui.js';
import { store, api } from '../../store.js';
import { t } from '../../i18n.js';
import { cloud } from '../../cloud.js';
import { sectionHead, card, note, errorNote, withBusy, toggleRow, iconList, isMissing, errMsg, embedPanel } from './shared.js';

const pill = (kind, iconName, text) => h('span', { class: ['pill', kind] }, iconName ? icon(iconName) : null, text);

// ---------------- Inteligencia artificial ----------------

export function renderAi(body, ctx) {
  let status = null;
  let state = 'loading'; // loading | ready | missing | error
  let loadError = '';
  let testResult = null;
  let plans = null; // features/plans.js (uso del plan)

  const statusPill = h('span', { class: 'cfg-pill-slot' });
  const statusBody = h('div', { class: 'cfg-ai-status' }, skeleton(3));
  const testBox = h('div', { class: 'cfg-test-result', 'aria-live': 'polite' });
  const mcpHost = h('div', { class: 'cfg-embed-host', dataset: { anchor: 'mcp' } });
  const mcpServersHost = h('div', { class: 'cfg-embed-host', dataset: { anchor: 'mcpservers' } });
  const enginesHost = h('div', { class: 'cfg-embed-host', dataset: { anchor: 'engines' } });

  async function load(opts) {
    try {
      // assistant:status = ai:status + uso del plan (preguntas que quedan por modelo, presupuesto) y needsPlan
      status = await api.invoke('assistant:status', opts).catch((err) => (isMissing(err) ? api.invoke('ai:status', opts) : Promise.reject(err)));
      state = 'ready';
      ctx.setDot('ai', status?.provider && !status?.needsPlan ? 'good' : null);
      if (!plans) {
        plans = await import('../../features/plans.js').catch(() => null);
        await plans?.preparePlans?.();
      }
    } catch (err) {
      state = isMissing(err) ? 'missing' : 'error';
      loadError = errMsg(err);
    }
    if (ctx.alive()) drawStatus();
  }

  async function saveAi(patch) {
    try {
      await store.setSettings({ ai: patch });
    } catch (err) {
      fail(t('settings.saveError'), err);
    }
    await load({ refresh: true });
  }

  function drawTest() {
    mount(testBox, testResult ? note(testResult.kind, testResult.kind === 'good' ? 'check' : 'alert', testResult.text) : null);
  }

  function drawStatus() {
    if (state === 'loading') {
      mount(statusPill);
      mount(statusBody, skeleton(3));
      return;
    }
    if (state === 'missing') {
      mount(statusPill, pill('', 'ban', t('settings.aiPillMissing')));
      mount(statusBody, note('info', 'info', t('settings.aiMissing')));
      return;
    }
    if (state === 'error') {
      mount(statusPill, pill('bad', 'alert', t('settings.aiPillError')));
      mount(statusBody, errorNote(t('settings.aiLoadError', { error: loadError }), () => load({ refresh: true })));
      return;
    }
    const s = status || {};
    const enabled = s.enabled !== false;
    const ready = Boolean(s.provider);
    const planName = s.quota?.planName || s.quota?.plan || '';
    let summary;
    let action = null;
    if (!enabled) {
      mount(statusPill, pill('', 'power', t('settings.aiPillOff')));
      summary = t('settings.aiOffText');
    } else if (!ready) {
      mount(statusPill, pill('warn', 'alert', t('settings.aiPillSignedOut')));
      summary = t('settings.aiSignedOutText');
      action = h('button', { type: 'button', class: 'btn sm primary', onclick: () => ctx.go('cloud', 'venus') }, icon('logIn'), t('settings.aiGoAccount'));
    } else if (s.needsPlan) {
      mount(statusPill, pill('warn', 'crown', t('settings.aiPillNoPlan')));
      summary = t('settings.aiNoPlanText');
      action = h('button', { type: 'button', class: 'btn sm primary', onclick: () => ctx.go('plan') }, icon('crown'), t('settings.aiGoPlans'));
    } else {
      mount(statusPill, pill('good', 'check', planName ? t('settings.aiPillPlan', { plan: planName }) : t('settings.aiPillActive')));
      summary = t('settings.aiViaPlan');
      action = h('button', { type: 'button', class: 'btn sm ghost', onclick: () => ctx.go('plan') }, icon('crown'), t('settings.aiSeePlan'));
    }

    const usage = enabled && ready && !s.needsPlan && plans?.usageView && (s.modelOptions?.length || s.budget) ? h('div', { class: 'cfg-ai-usage' }, plans.usageView(s)) : null;

    const testBtn = h('button', { type: 'button', class: 'btn sm', disabled: !enabled || !ready || Boolean(s.needsPlan) }, icon('zap'), t('settings.aiTest'));
    testBtn.addEventListener('click', () =>
      withBusy(testBtn, async () => {
        testResult = null;
        drawTest();
        try {
          const r = await api.invoke('ai:test');
          testResult = r?.ok ? { kind: 'good', text: t('settings.aiTestOk') } : { kind: 'warn', text: t('settings.aiTestOdd', { reply: String(r?.reply || '').slice(0, 140) }) };
        } catch (err) {
          testResult = { kind: 'bad', text: errMsg(err) };
        }
        if (ctx.alive()) drawTest();
      }),
    );

    mount(
      statusBody,
      h('p', { class: 'cfg-text' }, summary),
      action ? h('div', { class: 'row wrap cfg-ai-actions' }, action) : null,
      usage,
      toggleRow({ title: t('settings.aiEnable'), sub: t('settings.aiEnableSub'), checked: enabled, onChange: (v) => saveAi({ enabled: v }) }),
      h('div', { class: 'cfg-test-row' }, testBtn, h('span', { class: 'small muted' }, t('settings.aiTestHint'))),
      testBox,
    );
    drawTest();
  }

  const privacy = card(
    { title: t('settings.aiPrivacyTitle'), iconName: 'shield', sub: t('settings.aiPrivacySub'), anchor: 'privacy' },
    h(
      'div',
      { class: 'cfg-cols' },
      h(
        'div',
        { class: 'cfg-col' },
        h('div', { class: 'cfg-mini-title' }, t('settings.aiWhereTitle')),
        iconList([
          ['wand', t('settings.aiWhereAssistant'), t('settings.aiWhereAssistantSub')],
          ['bug', t('settings.aiWhereCrash'), t('settings.aiWhereCrashSub')],
          ['search', t('settings.aiWhereSearch'), t('settings.aiWhereSearchSub')],
          ['languages', t('settings.aiWhereTranslate'), t('settings.aiWhereTranslateSub')],
        ]),
      ),
      h(
        'div',
        { class: 'cfg-col' },
        h('div', { class: 'cfg-mini-title' }, t('settings.aiWhatTitle')),
        iconList([
          ['message', t('settings.aiWhatQuestions'), t('settings.aiWhatQuestionsSub')],
          ['fileText', t('settings.aiWhatLogs'), t('settings.aiWhatLogsSub')],
          ['search', t('settings.aiWhatSearch'), t('settings.aiWhatSearchSub')],
          ['package', t('settings.aiWhatMods'), t('settings.aiWhatModsSub')],
        ]),
      ),
    ),
    note('good', 'shieldCheck', t('settings.aiNeverSent')),
    h('p', { class: 'small muted cfg-hint' }, t('settings.aiRouteText')),
  );

  mount(body, sectionHead('ai', 'sparkles'), card({ title: t('settings.aiStatusTitle'), iconName: 'activity', extra: statusPill, anchor: 'status' }, statusBody), mcpHost, enginesHost, mcpServersHost, privacy);
  // Claude y ChatGPT por MCP: panel propio del módulo mcp (docs/mcp.md)
  embedPanel(mcpHost, { load: () => import('../../features/mcp.js'), fn: 'mcpPanel', ns: ['mcp'] }, ctx);
  // Servidores MCP del asistente (el asistente como cliente MCP): panel propio del módulo assistant
  embedPanel(mcpServersHost, { load: () => import('../../features/mcpservers.js'), fn: 'mcpServersPanel', ns: ['assistant'] }, ctx);
  // Tu Claude y tu ChatGPT en el Asistente (motores externos): panel propio del módulo assistant (features/engines.js)
  embedPanel(enginesHost, { load: () => import('../../features/engines.js'), fn: 'enginesPanel', ns: ['assistant'] }, ctx);
  drawStatus();
  load();

  ctx.onCleanup(
    api.on('ai:quota', () => {
      if (ctx.alive()) load();
    }),
  );
  ctx.onCleanup(api.on('billing:changed', () => ctx.alive() && load({ refresh: true })));
  // Iniciar o cerrar sesión cambia lo que puede usar la IA.
  let lastUser = cloud.user?.id || null;
  ctx.onCleanup(
    cloud.on('auth', () => {
      const id = cloud.user?.id || null;
      if (id === lastUser) return;
      lastUser = id;
      load({ refresh: true });
    }),
  );
}

// ---------------- Plan ----------------

// Planes de Venus IA (tarjetas, plan actual, pago y suscripción): features/plans.js
export function renderPlan(body, ctx) {
  const host = h('div', { class: 'cfg-embed-host', dataset: { anchor: 'plans' } });
  body.append(sectionHead('plan', 'crown'), host);
  embedPanel(host, { load: () => import('../../features/plans.js'), fn: 'plansPanel', ns: ['plans'] }, ctx);
}
