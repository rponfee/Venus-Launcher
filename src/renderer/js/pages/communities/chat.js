// Comunidades: un canal de texto o de anuncios. Historial paginado, tiempo real con Postgres Changes (lo filtra la política de
// community_messages) y una consulta cada 30 s que también trae las reacciones. El texto pasa por el mismo renderizador de Mensajes
// (social/richtext.js): nodos de texto y enlaces, nunca HTML. Los GIFs son de KLIPY o subidos y aprobados (media-view.js). Los
// permisos del servidor mandan: acá solo se ocultan botones y se avisa antes de mandar.
import { h, icon, mount, skeleton, emptyState, setBusy, fail, confirmDialog, fmtTime, fmtDate } from '../../ui.js';
import { t } from '../../i18n.js';
import { errText } from '../../features/communities/backend.js';
import { openGroupReport } from '../../features/communities/report.js';
import { COMMUNITY_LIMITS, validateMessage } from '../../features/communities/logic.js';
import { klipyMedia } from '../../features/communities/greeting.js';
import { renderBody } from '../../social/richtext.js';
import { headImg, openProfile } from '../../social/profile-ui.js';
import { openGifPicker, closeGifPicker } from '../../social/gifpicker.js';
import { canDeleteMessage, canReportMessage, groupMessages, isMuted, mergeMessages, messageFromRow, oldestAt, PAGE_SIZE, personName, canPostIn, canEmbedIn, canReactIn, hasLink, waitSeconds, afterPost, channelIcon, mergeChannelState, REACTIONS, REACTION_GLYPHS, safeReactions } from './logic.js';
import { mediaImage } from './media-view.js';
import { openMediaGallery } from './gallery.js';

const C = (key, vars) => t(`communities.${key}`, vars);
const POLL_MS = 30000;
const NEAR_BOTTOM_PX = 80;

/** Selector de reacciones: ocho fijas, junto al botón que lo abrió. */
function reactionPicker(anchor, onPick) {
  const pop = h('div', { class: 'cm-react-pop', role: 'menu', 'aria-label': C('reactTitle') },
    REACTIONS.map((emoji) => h('button', { class: 'cm-react-opt', type: 'button', role: 'menuitem', title: C(`react_${emoji}`), 'aria-label': C(`react_${emoji}`), onclick: () => { close(); onPick(emoji); } }, REACTION_GLYPHS[emoji])));
  const r = anchor.getBoundingClientRect();
  document.body.append(pop);
  pop.style.left = `${Math.max(8, Math.min(window.innerWidth - pop.offsetWidth - 8, r.right - pop.offsetWidth))}px`;
  pop.style.top = `${r.bottom + pop.offsetHeight + 8 > window.innerHeight ? Math.max(8, r.top - pop.offsetHeight - 6) : r.bottom + 6}px`;
  const onDown = (e) => { if (!pop.contains(e.target)) close(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); anchor.focus?.(); } };
  function close() {
    pop.remove();
    document.removeEventListener('mousedown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
  }
  setTimeout(() => document.addEventListener('mousedown', onDown, true), 0);
  document.addEventListener('keydown', onKey, true);
  pop.querySelector?.('button')?.focus?.();
  return close;
}

/** community: lo que devuelve community_get. people: Map userId -> persona (lo comparte con la lista de miembros). */
export function chatView(host, { b, community, channel, people, onPerson, topic = null, onBack, onPosted }) {
  const me = b.userId();
  let list = [];
  let hasMore = false;
  let live = false;
  let destroyed = false;
  let sending = false;
  let unknownAuthor = false;
  let denied = false;
  let loadingOlder = false;
  const deleting = new Set();
  const reacting = new Set();
  const pageName = topic ? 'community_forum_replies' : 'community_messages_page';
  const pageArgs = () => topic ? { p_topic: topic.id, p_limit: PAGE_SIZE } : { p_channel: channel.id, p_limit: PAGE_SIZE };
  const header = h('header', { class: 'cm-chat-head' });
  const topicBody = h('div', { class: 'cm-topic-root', hidden: !topic });
  const box = h('div', { class: 'cm-msgs', role: 'log', 'aria-live': 'polite', 'aria-label': C('chatLog', { name: channel.name }), tabindex: '0' });
  const older = h('button', { class: 'btn sm ghost cm-older', type: 'button', hidden: true }, icon('history'), C('olderMessages'));
  const input = h('textarea', { class: 'textarea cm-input', rows: '1', maxlength: String(COMMUNITY_LIMITS.message), placeholder: C('chatPlaceholder', { name: channel.name }), 'aria-label': C('chatPlaceholder', { name: channel.name }) });
  const send = h('button', { class: 'btn primary cm-send', type: 'button', title: C('send'), 'aria-label': C('send') }, icon('send'));
  // GIFs: los de KLIPY y los subidos por la comunidad (ya aprobados). Sin el permiso de enlaces y GIFs del canal quedan apagados.
  const gifBtn = h('button', { class: 'icon-btn cm-gif-btn', type: 'button', title: C('gifKlipy'), 'aria-label': C('gifKlipy'), 'aria-haspopup': 'dialog' }, h('span', { class: 'cm-gif-label', 'aria-hidden': 'true' }, 'GIF'));
  const galleryBtn = h('button', { class: 'icon-btn cm-gallery-btn', type: 'button', title: C('gifGallery'), 'aria-label': C('gifGallery'), 'aria-haspopup': 'dialog' }, icon('image'));
  const count = h('span', { class: 'cm-count', hidden: true });
  const banner = h('div', { class: 'cm-banner', hidden: true });

  const remember = (rows) => {
    for (const m of rows) {
      if (m.author?.userId && !people.has(m.author.userId)) {
        people.set(m.author.userId, m.author);
        onPerson?.(m.author);
      }
    }
  };
  const nearBottom = () => box.scrollHeight - box.scrollTop - box.clientHeight < NEAR_BOTTOM_PX;
  const toBottom = () => { box.scrollTop = box.scrollHeight; };

  async function toggleReaction(m, emoji) {
    if (destroyed || denied || reacting.has(m.id + emoji)) return;
    const mine = safeReactions(m.reactions).some((r) => r.emoji === emoji && r.mine);
    reacting.add(m.id + emoji);
    try {
      const res = await b.rpc('community_react', { p_message: m.id, p_emoji: emoji, p_on: !mine });
      if (destroyed) return;
      list = mergeMessages(list, [{ ...m, reactions: safeReactions(res?.reactions) }]);
      draw();
    } catch (err) {
      if (!destroyed && !handleAccessError(err)) fail(C('actionError'), errText(err));
    } finally { reacting.delete(m.id + emoji); }
  }

  function reactionBar(m) {
    const reactions = safeReactions(m.reactions);
    if (!reactions.length) return null;
    return h('div', { class: 'cm-reactions' }, reactions.map((r) => h('button', {
      class: ['cm-reaction', r.mine && 'is-mine'], type: 'button', 'aria-pressed': String(r.mine), disabled: !r.mine && !canReactIn(community, channel) ? true : null,
      title: C(`react_${r.emoji}`), 'aria-label': `${C(`react_${r.emoji}`)}: ${r.count}`, onclick: () => toggleReaction(m, r.emoji),
    }, h('span', { 'aria-hidden': 'true' }, REACTION_GLYPHS[r.emoji]), h('span', { class: 'cm-reaction-n' }, String(r.count)))));
  }

  function messageView(m) {
    const actions = [];
    if (!m.deleted && !m.hidden && canReactIn(community, channel)) {
      actions.push(h('button', { class: 'icon-btn sm cm-react-btn', type: 'button', title: C('reactAdd'), 'aria-label': C('reactAdd'), 'aria-haspopup': 'menu', onclick: (e) => reactionPicker(e.currentTarget, (emoji) => toggleReaction(m, emoji)) }, icon('smile')));
    }
    if (canDeleteMessage(m, me, community.myRole)) {
      actions.push(h('button', { class: 'icon-btn sm', type: 'button', title: C('deleteMessage'), 'aria-label': C('deleteMessage'), onclick: () => removeMessage(m) }, icon('trash')));
    }
    // Un GIF subido ya aprobado se denuncia por separado del mensaje: el equipo de Venus lo revisa de nuevo.
    if (m.media?.kind === 'upload' && m.media.id && !m.media.unavailable && canReportMessage(m, me) && !m.hidden) {
      actions.push(h('button', { class: 'icon-btn sm cm-report-media', type: 'button', title: C('reportMedia'), 'aria-label': C('reportMedia'), onclick: () => openGroupReport({ kind: 'media', id: m.media.id, name: m.media.name || community.name }) }, icon('image')));
    }
    if (canReportMessage(m, me) && !m.hidden) {
      actions.push(h('button', { class: 'icon-btn sm', type: 'button', title: C('reportMessage'), 'aria-label': C('reportMessage'), onclick: () => openGroupReport({ kind: 'message', id: m.id, name: community.name }) }, icon('alert')));
    }
    const hasText = !m.deleted && !m.hidden && m.body;
    const body = m.deleted ? h('span', { class: 'cm-gone' }, C('messageDeleted'))
      : m.hidden ? h('span', { class: 'cm-gone' }, C('messageBlocked'))
        : [hasText ? h('span', { class: 'cm-text selectable' }, renderBody(m.body)) : null,
          m.media ? mediaImage(b, m.media, { size: 'md', alt: m.body || '' }) : null];
    return h('div', { class: 'cm-msg', dataset: { id: m.id } },
      h('div', { class: 'cm-msg-body' }, body, m.deleted || m.hidden ? null : reactionBar(m)), actions.length ? h('div', { class: 'cm-msg-actions' }, actions) : null);
  }

  // Aviso automático de bienvenida o despedida: va centrado y sin nombre, con el GIF si lo tiene.
  function systemView(g) {
    const m = g.items[0];
    const at = Date.parse(m.at);
    const gone = m.deleted || m.hidden;
    return h('article', { class: ['cm-system', `is-${m.system}`], dataset: { id: m.id } },
      h('div', { class: 'cm-system-line' }, icon(m.system === 'join' ? 'logIn' : 'logout'),
        gone ? h('span', { class: 'cm-gone' }, C(m.hidden ? 'messageBlocked' : 'messageDeleted')) : h('span', { class: 'cm-text selectable' }, renderBody(m.body)),
        h('time', { class: 'cl-muted small' }, Number.isFinite(at) ? fmtTime(at) : ''),
        canDeleteMessage(m, me, community.myRole) ? h('button', { class: 'icon-btn sm', type: 'button', title: C('deleteMessage'), 'aria-label': C('deleteMessage'), onclick: () => removeMessage(m) }, icon('trash')) : null),
      !gone && m.media ? mediaImage(b, m.media, { size: 'md', alt: C(`system_${m.system}`) }) : null);
  }

  function groupView(g) {
    if (g.system) return systemView(g);
    const person = g.author || people.get(g.authorId) || null;
    const name = personName(person) || C('someone');
    const at = Date.parse(g.at);
    const role = person?.role;
    return h('article', { class: 'cm-group' },
      headImg(person || { username: name }, 36, 'cl-head'),
      h('div', { class: 'cm-group-main' },
        h('div', { class: 'cm-group-head' },
          h('button', { class: 'cl-link ellipsis', type: 'button', title: C('viewProfile', { name }), onclick: () => openProfile(g.authorId) }, name),
          role === 'owner' || role === 'moderator' ? h('span', { class: 'badge accent' }, C(`role_${role}`)) : null,
          h('time', { class: 'cl-muted small', title: Number.isFinite(at) ? `${fmtDate(at)} ${fmtTime(at)}` : '' }, Number.isFinite(at) ? fmtTime(at) : '')),
        g.items.map(messageView)));
  }

  function draw({ keepBottom = false, keepAnchor = null } = {}) {
    if (destroyed) return;
    const stick = keepBottom || nearBottom();
    const before = box.scrollHeight;
    const top = box.scrollTop;
    older.hidden = !hasMore;
    if (!list.length) {
      mount(box, older, emptyState('hash', C('chatEmpty', { name: channel.name }), C('chatEmptyText')));
      return;
    }
    mount(box, older, groupMessages(list).map(groupView));
    if (keepAnchor) box.scrollTop = top + (box.scrollHeight - before);
    else if (stick) toBottom();
  }

  async function removeMessage(m) {
    if (destroyed || deleting.has(m.id)) return;
    const theirs = m.authorId !== me;
    if (!(await confirmDialog(C(topic?.id === m.id ? 'cmTopicDelete' : 'deleteMessage'), topic?.id === m.id ? C('cmTopicDeleteConfirm') : theirs ? C('deleteTheirsText') : C('deleteMineText'), { okText: C('delete'), danger: true }))) return;
    if (destroyed || deleting.has(m.id)) return;
    deleting.add(m.id);
    try {
      await b.rpc('community_message_delete', { p_id: m.id });
      if (destroyed) return;
      if (topic?.id === m.id) { markThreadDeleted(); return; }
      list = mergeMessages(list, [{ ...m, deleted: true, body: '' }]);
      draw();
    } catch (err) {
      if (!destroyed) fail(C('actionError'), errText(err));
    } finally { deleting.delete(m.id); }
  }

  function markThreadDeleted() {
    if (!topic) return;
    topic = { ...topic, deleted: true, body: '', title: null };
    list = []; hasMore = false;
    drawHeader(); drawMute(); draw();
  }
  function handleAccessError(err) {
    if (err?.code === 'thread_deleted') { markThreadDeleted(); return true; }
    if (!['not_found', 'not_member', 'forbidden', 'noSession', 'user_banned'].includes(err?.code)) return false;
    denied = true; list = []; input.value = ''; drawMute();
    mount(topicBody); mount(box, emptyState('lock', errText(err), ''));
    return true;
  }

  async function loadLatest({ first = false } = {}) {
    if (destroyed || denied || topic?.deleted) return;
    try {
      const page = await b.rpc(pageName, pageArgs());
      if (destroyed || denied || topic?.deleted) return;
      const rows = Array.isArray(page) ? page : [];
      remember(rows);
      if (first) hasMore = rows.length >= PAGE_SIZE;
      list = mergeMessages(list, rows);
      unknownAuthor = false;
      draw({ keepBottom: first });
    } catch (err) {
      if (destroyed || handleAccessError(err) || !first) return;
      mount(box, emptyState('alert', errText(err), '', h('button', { class: 'btn', type: 'button', onclick: () => { mount(box, skeleton('list', { rows: 5 })); loadLatest({ first: true }); } }, icon('refresh'), C('retry'))));
    }
  }

  older.addEventListener('click', async () => {
    if (destroyed || loadingOlder || denied || topic?.deleted) return;
    loadingOlder = true;
    const done = setBusy(older);
    try {
      const page = await b.rpc(pageName, { ...pageArgs(), p_before: oldestAt(list) });
      if (destroyed || denied || topic?.deleted) return;
      const rows = Array.isArray(page) ? page : [];
      remember(rows);
      hasMore = rows.length >= PAGE_SIZE;
      list = mergeMessages(list, rows);
      draw({ keepAnchor: true });
    } catch (err) {
      if (!destroyed && !handleAccessError(err)) fail(C('actionError'), errText(err));
    } finally {
      loadingOlder = false;
      done();
    }
  });

  function afterSent(m) {
    channel = afterPost(community, channel, m?.at);
    onPosted?.(channel);
    if (m?.id) {
      remember([m]);
      list = mergeMessages(list, [m]);
      draw({ keepBottom: true });
    }
  }

  async function submit() {
    if (destroyed || denied || sending || topic?.deleted || !canPostIn(community, channel) || waitSeconds(community, channel)) return;
    const draft = input.value;
    const check = validateMessage(draft);
    if (!check.ok) {
      if (input.value.trim()) fail(C('actionError'), C(`err_${check.error}`));
      return;
    }
    // Un enlace necesita el permiso de enlaces y GIFs del canal; el servidor lo vuelve a comprobar.
    if (hasLink(check.value) && !canEmbedIn(community, channel)) {
      fail(C('actionError'), C('err_embeds_forbidden'));
      return;
    }
    sending = true;
    const done = setBusy(send);
    try {
      const m = await b.rpc(topic ? 'community_forum_reply' : 'community_send', { ...(topic ? { p_topic: topic.id } : { p_channel: channel.id }), p_body: check.value });
      if (destroyed || denied || topic?.deleted) return;
      // Mientras llega la respuesta se puede escribir el siguiente mensaje: no borrar ese borrador.
      if (input.value === draft) input.value = '';
      resize();
      afterSent(m);
    } catch (err) {
      if (!destroyed) {
        if (err?.nextPostAt) channel = { ...channel, nextPostAt: err.nextPostAt };
        if (!handleAccessError(err)) fail(C('sendError'), errText(err));
      }
    } finally {
      done();
      sending = false;
      if (!destroyed) {
        drawMute();
        if (document.activeElement === send && !input.disabled) input.focus();
      }
    }
  }

  // Manda un GIF (solo, sin texto) con community_send_media.
  async function sendMedia(media) {
    if (destroyed || denied || sending || topic || !canEmbedIn(community, channel) || waitSeconds(community, channel)) return;
    sending = true;
    drawMute();
    try {
      const m = await b.rpc('community_send_media', { p_channel: channel.id, p_media: media, p_body: '' });
      if (!destroyed && !denied) afterSent(m);
    } catch (err) {
      if (!destroyed) {
        if (err?.nextPostAt) channel = { ...channel, nextPostAt: err.nextPostAt };
        if (!handleAccessError(err)) fail(C('sendError'), errText(err));
      }
    } finally {
      sending = false;
      if (!destroyed) drawMute();
    }
  }
  gifBtn.addEventListener('click', () => openGifPicker(gifBtn, (gif) => sendMedia(klipyMedia(gif))));
  galleryBtn.addEventListener('click', () => openMediaGallery(b, community, { pick: (item) => sendMedia({ kind: 'upload', id: item.id }) }));

  send.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });
  function resize() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(140, input.scrollHeight + 2)}px`;
    const left = COMMUNITY_LIMITS.message - input.value.length;
    count.hidden = left > 200;
    count.textContent = String(left);
  }
  input.addEventListener('input', resize);

  function drawHeader() {
    mount(header, topic ? h('button', { class: 'icon-btn sm', type: 'button', title: C('cmBackTopics'), 'aria-label': C('cmBackTopics'), onclick: onBack }, icon('arrowLeft')) : null,
      icon(channelIcon(channel)), h('div', { class: 'cm-chat-heading' }, h('strong', {}, topic ? (topic.deleted ? C('cmTopicDeleted') : topic.title) : channel.name),
        !topic && channel.topic ? h('p', { class: 'cm-channel-topic selectable' }, channel.topic) : null),
      channel.isPrivate ? h('span', { title: C('cmPrivate'), 'aria-label': C('cmPrivate') }, icon('lock')) : null);
    if (topic) mount(topicBody, topic.deleted ? h('p', { class: 'cm-gone' }, C('cmTopicDeleted')) : groupView({ authorId: topic.authorId, author: topic.author, at: topic.at, items: [topic] }));
    input.placeholder = C(topic ? 'cmReplyPlaceholder' : 'chatPlaceholder', { name: channel.name });
    input.setAttribute('aria-label', input.placeholder);
  }
  function drawMute() {
    const muted = isMuted(community.mutedUntil);
    const wait = waitSeconds(community, channel);
    const allowed = !denied && !topic?.deleted && canPostIn(community, channel);
    const embeds = allowed && canEmbedIn(community, channel);
    input.disabled = !allowed;
    send.disabled = !allowed || sending || wait > 0;
    // GIFs: no en las respuestas de un foro, y solo con el permiso de enlaces y GIFs.
    gifBtn.hidden = galleryBtn.hidden = !!topic;
    gifBtn.disabled = galleryBtn.disabled = !embeds || sending || wait > 0;
    const why = allowed && !embeds ? C('gifNoPermission') : null;
    gifBtn.title = why || C('gifKlipy');
    galleryBtn.title = why || C('gifGallery');
    banner.hidden = allowed && !wait;
    if (topic?.deleted) mount(banner, icon('lock'), C('cmTopicDeleted'));
    else if (muted) mount(banner, icon('volumeX'), C('mutedUntil', { date: fmtDate(Date.parse(community.mutedUntil)) + ' ' + fmtTime(Date.parse(community.mutedUntil)) }));
    else if (!allowed) mount(banner, icon('lock'), C('cmReadOnly'));
    else if (wait) mount(banner, icon('clock'), C('cmWaitSeconds', { n: wait }));
  }
  mount(host,
    header, topicBody,
    h('p', { class: 'cl-note cm-e2e' }, icon('eye'), h('span', {}, C('chatNotice'))),
    box,
    banner,
    h('div', { class: 'cm-composer' }, gifBtn, galleryBtn, input, count, send));
  mount(box, skeleton('list', { rows: 5, label: C('loading') }));
  drawHeader();
  drawMute();
  loadLatest({ first: true });

  const stop = b.watchChannel(channel.id, {
    onStatus: (status) => {
      if (destroyed) return;
      const was = live;
      live = status === 'SUBSCRIBED';
      if (live && !was) loadLatest(); // lo que llegó mientras no estaba conectado
    },
    onRow: (row) => {
      if (destroyed || denied || row.channel_id !== channel.id) return;
      if (topic && row.id === topic.id) { if (row.deleted) markThreadDeleted(); return; }
      if (topic ? row.parent_id !== topic.id || topic.deleted : !!row.parent_id) return;
      const m = messageFromRow(row, { people, isBlocked: b.isBlocked });
      if (!m) return;
      if (!m.author) unknownAuthor = true;
      list = mergeMessages(list, [m]);
      draw();
      // Un GIF subido llega sin ruta (Realtime no la lleva): se pide la página para tenerla.
      if (unknownAuthor || (m.media?.kind === 'upload' && !m.media.path)) loadLatest();
    },
  });
  // Las reacciones no viajan por Realtime: cada 30 s se refresca la página (con o sin conexión en vivo).
  const timer = setInterval(() => {
    if (document.visibilityState === 'visible') loadLatest();
  }, POLL_MS);

  const clock = setInterval(() => { if (!destroyed) drawMute(); }, 1000);
  return {
    setCommunity(next, nextChannel) {
      if (destroyed) return;
      community = next;
      channel = mergeChannelState(channel, nextChannel);
      drawHeader();
      drawMute();
    },
    destroy() {
      destroyed = true;
      clearInterval(timer);
      clearInterval(clock);
      closeGifPicker();
      stop();
    },
  };
}
