// Pagina del asistente de IA (#/assistant/<conversacion?>): conversaciones, chat, plan y uso (preguntas que quedan
// por modelo y presupuesto del mes) y el panel de transparencia "Que puede hacer / Que no puede hacer".
import { h, icon, mount, confirmDialog, ok, fail, fmtAgo, debounce, skeleton, emptyState } from '../ui.js';
import { api } from '../store.js';
import { t } from '../i18n.js';
import { navigate } from '../app.js';
import { createChat, registerPageChat, getStatus, onStatus, quotaInfo, openTransparency } from '../features/assistant.js';
import { openPlans, usageView } from '../features/plans.js';

export default {
  ns: ['assistant', 'plans'],
  css: ['pages/assistant', 'features/assistant', 'features/plans'],
  async render(root, params) {
    let activeId = null;
    let alive = true;
    const listBox = h('div', { class: 'as-conv-list' }, skeleton('list', { rows: 3 }));
    const planBox = h('div', { class: 'as-plan-body' }, skeleton(3));
    const chatTitle = h('div', { class: 'as-main-title ellipsis' }, t('assistant.newChat'));
    const setChatTitle = (text) => {
      chatTitle.textContent = text;
      chatTitle.title = text;
    };

    const chat = createChat({
      variant: 'page',
      onConversation: (id, title) => {
        activeId = id;
        setChatTitle(id ? title || t('assistant.untitled') : t('assistant.newChat'));
        if (alive) history.replaceState(null, '', id ? `#/assistant/${encodeURIComponent(id)}` : '#/assistant');
        refreshSoon();
      },
      onTitle: (title) => setChatTitle(title),
    });
    const unregister = registerPageChat(chat);

    // ----- Conversaciones -----
    async function remove(c) {
      const yes = await confirmDialog(t('assistant.deleteConfirmTitle'), t('assistant.deleteConfirmText', { title: c.title || t('assistant.untitled') }), { okText: t('common.delete'), danger: true });
      if (!yes) return;
      try {
        await api.invoke('assistant:deleteConversation', c.id);
        if (c.id === activeId) await chat.load(null);
        ok(t('assistant.deleted'));
      } catch (err) {
        fail(t('assistant.errorTitle'), err);
      }
      refreshList();
    }

    // Cada fila: un boton que abre la conversacion y, al lado, el de borrar (nunca un boton dentro de otro)
    function convRow(c) {
      const title = c.title || t('assistant.untitled');
      const active = c.id === activeId;
      return h(
        'div',
        { class: ['as-conv', active && 'active', c.running && 'running'] },
        h(
          'button',
          {
            class: 'as-conv-open',
            type: 'button',
            title,
            'aria-current': active ? 'true' : undefined,
            onclick: () => {
              if (c.id !== activeId) chat.load(c.id);
            },
          },
          h('span', { class: 'as-conv-ic', 'aria-hidden': 'true' }, c.running ? h('span', { class: 'spinner' }) : icon('message')),
          h(
            'span',
            { class: 'as-conv-main' },
            h('span', { class: 'as-conv-title ellipsis' }, title),
            h('span', { class: 'as-conv-sub' }, c.running ? t('assistant.running') : `${fmtAgo(c.updatedAt)} · ${t('assistant.turns', { count: c.turns || 0 })}`),
          ),
        ),
        h(
          'button',
          {
            class: 'icon-btn sm danger as-conv-del',
            type: 'button',
            title: t('assistant.deleteConversation'),
            'aria-label': t('assistant.deleteConversationOf', { title }),
            onclick: () => remove(c),
          },
          icon('trash'),
        ),
      );
    }

    async function refreshList() {
      let convs = [];
      try {
        convs = await api.invoke('assistant:conversations');
      } catch (err) {
        console.warn('[assistant] conversaciones:', err?.message || err);
        if (!alive) return;
        mount(
          listBox,
          h(
            'div',
            { class: 'as-conv-error', role: 'alert' },
            h('div', { class: 'as-conv-error-text' }, icon('alert'), h('span', {}, t('assistant.convsError'))),
            h(
              'button',
              {
                class: 'btn sm',
                type: 'button',
                onclick: () => {
                  mount(listBox, skeleton('list', { rows: 2 }));
                  refreshList();
                },
              },
              icon('refresh'),
              t('assistant.retry'),
            ),
          ),
        );
        return;
      }
      if (!alive) return;
      if (!convs.length) {
        mount(listBox, h('div', { class: 'as-conv-empty' }, emptyState('message', t('assistant.convsEmptyTitle'), t('assistant.convsEmptyText'))));
        return;
      }
      // Conserva el foco del teclado al redibujar la lista (cambia con cada respuesta)
      const focusedId = listBox.contains(document.activeElement) ? document.activeElement.closest('.as-conv')?.dataset.id : null;
      const focusDel = document.activeElement?.classList.contains('as-conv-del');
      mount(
        listBox,
        convs.map((c) => {
          const row = convRow(c);
          row.dataset.id = c.id;
          return row;
        }),
      );
      if (focusedId) listBox.querySelector(`.as-conv[data-id="${CSS.escape(focusedId)}"] ${focusDel ? '.as-conv-del' : '.as-conv-open'}`)?.focus({ preventScroll: true });
    }
    const refreshSoon = debounce(refreshList, 250);

    // ----- Claude y ChatGPT por MCP -----
    // Tarjeta del modulo mcp (features/mcp.js): sin plan, o si el modulo falta, no muestra nada. Se resalta
    // cuando Venus IA no esta disponible (apagada, sin sesion, sin cuota o con el servicio con problemas).
    const mcpHost = h('div', { class: 'as-mcp-host' });
    let mcpCard = null;
    let lastStatus = null;
    const aiDown = (st) => Boolean(st) && Boolean(quotaInfo(st).blocked) && quotaInfo(st).blocked !== 'plan';
    import('../features/mcp.js')
      .then((m) => {
        if (!alive || typeof m.assistantCard !== 'function') return;
        mcpCard = m.assistantCard();
        mount(mcpHost, mcpCard);
        mcpCard.setHighlight(aiDown(lastStatus));
      })
      .catch((err) => console.warn('[assistant] tarjeta MCP:', err?.message || err));
    // ----- Tu Claude y tu ChatGPT en el Asistente (motores externos) -----
    // Tarjeta de features/engines.js: sin plan no muestra nada. Deteccion de Claude Code y Codex y motor por defecto.
    const enginesHost = h('div', { class: 'as-eng-host' });
    let engCard = null;
    import('../features/engines.js')
      .then((m) => {
        if (!alive || typeof m.engineCard !== 'function') return;
        engCard = m.engineCard();
        mount(enginesHost, engCard);
      })
      .catch((err) => console.warn('[assistant] tarjeta de motores:', err?.message || err));

    // ----- Plan y uso -----
    function renderPlan(st) {
      if (!alive) return;
      lastStatus = st;
      mcpCard?.setHighlight(aiDown(st));
      if (!st) {
        mount(planBox, skeleton(3));
        return;
      }
      const info = quotaInfo(st);
      if (st.enabled === false) {
        mount(
          planBox,
          h('div', { class: 'as-plan-state' }, h('span', { class: 'pill' }, icon('power'), t('assistant.disabledTitle'))),
          h('p', { class: 'as-plan-text' }, t('assistant.disabledText')),
          h('button', { class: 'btn sm', type: 'button', onclick: () => navigate('settings/ai') }, icon('settings'), t('assistant.goAiSettings')),
        );
        return;
      }
      if (!st.provider) {
        // Sin sesion: el boton principal esta en el aviso del chat; aca queda como acceso secundario
        mount(
          planBox,
          h('div', { class: 'as-plan-state' }, h('span', { class: 'pill' }, icon('lock'), t('assistant.notConnected'))),
          h('p', { class: 'as-plan-text' }, t('assistant.notConnectedText')),
          h('button', { class: 'btn sm', type: 'button', onclick: () => navigate('settings/cloud/venus') }, icon('logIn'), t('assistant.goCloud')),
        );
        return;
      }
      if (st.needsPlan) {
        // Sin plan: el boton principal ("Ver planes") esta en el aviso del chat
        mount(
          planBox,
          h('div', { class: 'as-plan-state' }, h('span', { class: 'pill warn' }, icon('crown'), t('assistant.noPlan'))),
          h('p', { class: 'as-plan-text' }, t('assistant.planNeededText')),
          h('button', { class: 'btn sm tonal', type: 'button', onclick: () => openPlans({ reason: 'needsPlan' }) }, icon('crown'), t('assistant.seePlans')),
        );
        return;
      }
      const q = st.quota || {};
      const planLabel = q.planName || q.plan || '?';
      mount(
        planBox,
        h(
          'div',
          { class: 'as-plan-name' },
          h('span', { class: ['badge', info.blocked === 'quota' ? 'bad' : 'accent'] }, icon('crown'), t('assistant.planName', { plan: planLabel })),
          st.fake ? h('span', { class: 'badge warn' }, t('assistant.demoMode')) : null,
        ),
        usageView(st),
        h(
          'div',
          { class: 'row wrap as-plan-actions' },
          h('button', { class: 'btn sm tonal', type: 'button', onclick: () => openPlans({ reason: info.blocked === 'quota' ? 'quota' : undefined }) }, icon('crown'), t('assistant.seePlans')),
          h('button', { class: 'btn sm ghost', type: 'button', onclick: () => navigate('settings/plan') }, t('assistant.yourPlan')),
        ),
      );
    }

    mount(
      root,
      h(
        'div',
        { class: 'page-head' },
        h('div', { class: 'ph-text' }, h('h1', { class: 'page-title' }, t('assistant.title')), h('p', { class: 'page-sub' }, t('assistant.subtitle'))),
        h('div', { class: 'page-actions' }, h('button', { class: 'btn', type: 'button', onclick: () => chat.load(null).then(() => chat.focus()) }, icon('plus'), t('assistant.newChat'))),
      ),
      h(
        'div',
        { class: 'as-layout' },
        h(
          'aside',
          { class: 'as-side', 'aria-label': t('assistant.conversations') },
          h('section', { class: 'card as-plan' }, h('h2', { class: 'card-title' }, icon('crown'), t('assistant.planTitle')), planBox),
          mcpHost,
          enginesHost,
          h('section', { class: 'card as-convs' }, h('h2', { class: 'card-title' }, icon('history'), t('assistant.conversations')), listBox),
        ),
        h(
          'section',
          { class: 'card as-main', 'aria-label': t('assistant.title') },
          h(
            'div',
            { class: 'as-main-head' },
            icon('message'),
            chatTitle,
            h(
              'button',
              { class: 'btn ghost sm as-main-what', type: 'button', title: t('assistant.whatCanDo'), 'aria-label': t('assistant.whatCanDo'), onclick: openTransparency },
              icon('info'),
              h('span', { class: 'as-main-what-label' }, t('assistant.whatCanDo')),
            ),
          ),
          chat.el,
        ),
      ),
    );

    const offStatus = onStatus(renderPlan);
    const offEvents = api.on('assistant:event', (convId, ev) => {
      if (ev.type === 'turn-start' || ev.type === 'done') refreshSoon();
      // El servicio de IA no respondio: Claude o ChatGPT son la alternativa (con la cuenta del usuario)
      if (ev.type === 'error' && ['backend', 'unavailable', 'network', 'ratelimit', 'quota'].includes(ev.code)) mcpCard?.setHighlight(true);
    });

    refreshList();
    await chat.load(params[0] || null);
    getStatus(true).then(renderPlan);
    chat.focus();

    return () => {
      alive = false;
      mcpCard?.destroy();
      engCard?.destroy();
      offStatus();
      offEvents();
      unregister();
      chat.destroy();
    };
  },
};
