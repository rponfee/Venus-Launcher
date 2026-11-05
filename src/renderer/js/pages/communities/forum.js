// Foro: temas paginados y respuestas reales. Cada hilo reutiliza el chat con las RPC específicas de foro.
import { h, icon, mount, modal, emptyState, skeleton, fail, fmtAgo } from '../../ui.js';
import { t } from '../../i18n.js';
import { errText } from '../../features/clans/backend.js';
import { validateMessage } from '../../features/clans/logic.js';
import { chatView } from './chat.js';
import { canPostIn, waitSeconds, afterPost, validateTopicTitle, TOPIC_PAGE_SIZE, mergeMessages, channelIcon, personName, mergeChannelState } from './logic.js';

const C = (key, vars) => t('clans.' + key, vars);
export function forumView(host, { b, community, channel, people, onPerson }) {
  let topics = [], hasMore = false, loading = false, destroyed = false, live = false, request = 0;
  let thread = null, composer = null, denied = false;
  const header = h('header', { class: 'cm-chat-head' });
  const list = h('div', { class: 'cm-topics', 'aria-live': 'polite' });
  const note = h('p', { class: 'cm-forum-note' });
  const more = h('button', { class: 'btn ghost cm-topics-more', type: 'button', hidden: true }, C('cmMoreTopics'));
  const create = h('button', { class: 'btn primary sm cm-new-topic', type: 'button', onclick: compose }, icon('plus'), C('cmNewTopic'));

  function drawPermissions() {
    if (destroyed) return;
    const wait = waitSeconds(community, channel);
    create.disabled = (denied || !canPostIn(community, channel)) || wait > 0;
    note.textContent = (denied || !canPostIn(community, channel)) ? C('cmReadOnly') : wait ? C('cmWaitSeconds', { n: wait }) : C('cmForumHint');
  }
  function drawHeader() {
    mount(header, icon(channelIcon(channel)), h('div', { class: 'cm-chat-heading' }, h('strong', {}, channel.name),
      channel.topic ? h('p', { class: 'cm-channel-topic selectable' }, channel.topic) : null), create);
    drawPermissions();
  }
  function draw() {
    if (destroyed || thread) return;
    more.hidden = !hasMore;
    more.disabled = loading;
    mount(list, topics.length ? topics.map((topic) => {
      const unavailable = topic.deleted || topic.hidden;
      return h('button', { class: 'cm-topic-card', type: 'button', disabled: unavailable, onclick: () => open(topic) },
        h('strong', { class: 'cm-topic-title' }, topic.deleted ? C('cmTopicDeleted') : topic.hidden ? C('messageBlocked') : topic.title),
        unavailable ? null : h('p', { class: 'cm-topic-excerpt' }, topic.body),
        h('span', { class: 'cm-topic-meta' }, personName(topic.author) || C('someone'), ' · ', fmtAgo(Date.parse(topic.at)), ' · ', C('cmRepliesCount', { n: topic.replyCount || 0 })));
    }) : emptyState('message', C('cmForumEmpty'), C('cmForumHint')));
  }
  async function load({ morePage = false, first = false } = {}) {
    if (destroyed || thread || (morePage && loading)) return;
    const own = ++request;
    loading = true; more.disabled = true;
    try {
      const page = await b.rpc('community_forum_topics', { p_channel: channel.id, p_limit: TOPIC_PAGE_SIZE,
        ...(morePage && topics.length ? { p_before: topics.at(-1).at } : {}) });
      if (destroyed || thread || own !== request) return;
      const rows = Array.isArray(page) ? page : [];
      for (const topic of rows) if (topic.author?.userId) { people.set(topic.author.userId, topic.author); onPerson?.(topic.author); }
      if (morePage || first || !topics.length) hasMore = rows.length >= TOPIC_PAGE_SIZE;
      topics = mergeMessages(topics, rows).reverse();
      draw();
    } catch (err) {
      if (destroyed || thread || own !== request) return;
      if (['not_member', 'forbidden', 'not_found', 'noSession'].includes(err?.code)) {
        denied = true; topics = []; create.disabled = true; hasMore = false;
      }
      if (first || !topics.length) mount(list, emptyState('alert', errText(err), '',
        h('button', { class: 'btn', type: 'button', onclick: () => load({ first: true }) }, icon('refresh'), C('retry'))));
      else fail(C('actionError'), errText(err));
    } finally {
      if (own === request) { loading = false; more.disabled = false; more.hidden = !hasMore; }
    }
  }
  function showList() {
    if (destroyed) return;
    thread?.destroy(); thread = null;
    mount(host, header, note, list, more);
    drawHeader(); draw();
    load({ first: !topics.length });
  }
  function open(topic) {
    if (destroyed || topic.deleted || topic.hidden) return;
    ++request; loading = false;
    thread?.destroy();
    thread = chatView(host, { b, community, channel, people, onPerson, topic, onBack: showList, onPosted: (nextChannel) => { channel = nextChannel; } });
  }
  function compose() {
    if (destroyed || composer || (denied || !canPostIn(community, channel)) || waitSeconds(community, channel)) return;
    let pending = false, closed = false;
    const title = h('input', { class: 'input', id: 'cm-topic-title', maxlength: '120', autocomplete: 'off' });
    const body = h('textarea', { class: 'textarea', id: 'cm-topic-body', rows: '6', maxlength: '2000' });
    const error = h('p', { class: 'field-error', role: 'alert', hidden: true });
    const save = h('button', { class: 'btn primary cm-topic-publish', type: 'button' }, icon('send'), C('cmPublishTopic'));
    const m = modal({ title: C('cmNewTopic'), icon: 'message', body: h('div', { class: 'stack' },
      h('div', { class: 'field' }, h('label', { for: title.id }, C('cmTopicTitle')), title),
      h('div', { class: 'field' }, h('label', { for: body.id }, C('cmTopicBody')), body), error),
    footer: [h('button', { class: 'btn ghost', type: 'button', onclick: () => m.close() }, C('cancel')), save],
    onClose: () => { closed = true; composer = null; } });
    composer = m;
    save.addEventListener('click', async () => {
      if (pending || closed || destroyed) return;
      if ((denied || !canPostIn(community, channel)) || waitSeconds(community, channel)) { error.textContent = C('cmReadOnly'); error.hidden = false; return; }
      const a = validateTopicTitle(title.value), z = validateMessage(body.value);
      if (!a.ok || !z.ok) { error.textContent = C('err_' + (!a.ok ? a.error : z.error)); error.hidden = false; return; }
      pending = true; save.disabled = title.disabled = body.disabled = true; error.hidden = true;
      try {
        const topic = await b.rpc('community_forum_topic_create', { p_channel: channel.id, p_title: a.value, p_body: z.value });
        if (destroyed) return;
        channel = afterPost(community, channel, topic?.at);
        topics = mergeMessages(topics, [topic]).reverse();
        if (!closed) { m.close(); open(topic); }
      } catch (err) {
        if (err?.nextPostAt) channel = { ...channel, nextPostAt: err.nextPostAt };
        if (!closed && !destroyed) { error.textContent = errText(err); error.hidden = false; }
      } finally {
        pending = false; save.disabled = title.disabled = body.disabled = false;
        drawPermissions();
      }
    });
  }
  more.addEventListener('click', () => load({ morePage: true }));
  mount(list, skeleton('list', { rows: 4 }));
  showList();
  const stop = b.watchChannel(channel.id, {
    onStatus: (status) => { const before = live; live = status === 'SUBSCRIBED'; if (live && !before) load(); },
    onRow: (row) => { if (!destroyed && !thread && row.channel_id === channel.id) load(); },
  });
  const poll = setInterval(() => { if (!live && document.visibilityState === 'visible') load(); }, 30000);
  const clock = setInterval(drawPermissions, 1000);
  return {
    setCommunity(next, nextChannel) {
      community = next;
      channel = mergeChannelState(channel, nextChannel);
      if (thread) thread.setCommunity(next, channel);
      else drawHeader();
    },
    destroy() {
      destroyed = true; ++request;
      thread?.destroy(); composer?.close(); stop();
      clearInterval(poll); clearInterval(clock);
    },
  };
}
