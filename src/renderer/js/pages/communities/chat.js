// Comunidades: un canal de texto. Historial paginado, tiempo real con Postgres Changes (lo filtra la política de
// community_messages) y, si ese canal se cae, una consulta cada 30 s. El texto pasa por el mismo renderizador de Mensajes
// (social/richtext.js): nodos de texto y enlaces, nunca HTML. Los permisos del servidor mandan: acá solo se ocultan botones.
import { h, icon, mount, skeleton, emptyState, setBusy, fail, confirmDialog, fmtTime, fmtDate } from '../../ui.js';
import { t } from '../../i18n.js';
import { errText } from '../../features/clans/backend.js';
import { openGroupReport } from '../../features/clans/report.js';
import { COMMUNITY_LIMITS, validateMessage } from '../../features/clans/logic.js';
import { renderBody } from '../../social/richtext.js';
import { headImg, openProfile } from '../../social/profile-ui.js';
import { canDeleteMessage, canReportMessage, groupMessages, isMuted, mergeMessages, messageFromRow, oldestAt, PAGE_SIZE, personName } from './logic.js';

const C = (key, vars) => t(`clans.${key}`, vars);
const POLL_MS = 30000;
const NEAR_BOTTOM_PX = 80;

/** community: lo que devuelve community_get. people: Map userId -> persona (lo comparte con la lista de miembros). */
export function chatView(host, { b, community, channel, people, onPerson }) {
  const me = b.userId();
  let list = [];
  let hasMore = false;
  let live = false;
  let destroyed = false;
  let unknownAuthor = false;
  const box = h('div', { class: 'cm-msgs', role: 'log', 'aria-live': 'polite', 'aria-label': C('chatLog', { name: channel.name }), tabindex: '0' });
  const older = h('button', { class: 'btn sm ghost cm-older', type: 'button', hidden: true }, icon('history'), C('olderMessages'));
  const input = h('textarea', { class: 'textarea cm-input', rows: '1', maxlength: String(COMMUNITY_LIMITS.message), placeholder: C('chatPlaceholder', { name: channel.name }), 'aria-label': C('chatPlaceholder', { name: channel.name }) });
  const send = h('button', { class: 'btn primary cm-send', type: 'button', title: C('send'), 'aria-label': C('send') }, icon('send'));
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

  function messageView(m) {
    const actions = [];
    if (canDeleteMessage(m, me, community.myRole)) {
      actions.push(h('button', { class: 'icon-btn sm', type: 'button', title: C('deleteMessage'), 'aria-label': C('deleteMessage'), onclick: () => removeMessage(m) }, icon('trash')));
    }
    if (canReportMessage(m, me) && !m.hidden) {
      actions.push(h('button', { class: 'icon-btn sm', type: 'button', title: C('reportMessage'), 'aria-label': C('reportMessage'), onclick: () => openGroupReport({ kind: 'message', id: m.id, name: community.name }) }, icon('alert')));
    }
    const body = m.deleted ? h('span', { class: 'cm-gone' }, C('messageDeleted'))
      : m.hidden ? h('span', { class: 'cm-gone' }, C('messageBlocked'))
        : h('span', { class: 'cm-text selectable' }, renderBody(m.body));
    return h('div', { class: 'cm-msg', dataset: { id: m.id } }, body, actions.length ? h('div', { class: 'cm-msg-actions' }, actions) : null);
  }

  function groupView(g) {
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
    const theirs = m.authorId !== me;
    if (!(await confirmDialog(C('deleteMessage'), theirs ? C('deleteTheirsText') : C('deleteMineText'), { okText: C('delete'), danger: true }))) return;
    try {
      await b.rpc('community_message_delete', { p_id: m.id });
      list = mergeMessages(list, [{ ...m, deleted: true, body: '' }]);
      draw();
    } catch (err) {
      fail(C('actionError'), errText(err));
    }
  }

  async function loadLatest({ first = false } = {}) {
    try {
      const page = await b.rpc('community_messages_page', { p_channel: channel.id, p_limit: PAGE_SIZE });
      if (destroyed) return;
      const rows = Array.isArray(page) ? page : [];
      remember(rows);
      if (first) hasMore = rows.length >= PAGE_SIZE;
      list = mergeMessages(list, rows);
      unknownAuthor = false;
      draw({ keepBottom: first });
    } catch (err) {
      if (destroyed || !first) return;
      mount(box, emptyState('alert', errText(err), '', h('button', { class: 'btn', type: 'button', onclick: () => { mount(box, skeleton('list', { rows: 5 })); loadLatest({ first: true }); } }, icon('refresh'), C('retry'))));
    }
  }

  older.addEventListener('click', async () => {
    const done = setBusy(older);
    try {
      const page = await b.rpc('community_messages_page', { p_channel: channel.id, p_before: oldestAt(list), p_limit: PAGE_SIZE });
      if (destroyed) return;
      const rows = Array.isArray(page) ? page : [];
      remember(rows);
      hasMore = rows.length >= PAGE_SIZE;
      list = mergeMessages(list, rows);
      draw({ keepAnchor: true });
    } catch (err) {
      fail(C('actionError'), errText(err));
    } finally {
      done();
    }
  });

  async function submit() {
    const check = validateMessage(input.value);
    if (!check.ok) {
      if (input.value.trim()) fail(C('actionError'), C(`err_${check.error}`));
      return;
    }
    const done = setBusy(send);
    try {
      const m = await b.rpc('community_send', { p_channel: channel.id, p_body: check.value });
      input.value = '';
      resize();
      if (m?.id) {
        remember([m]);
        list = mergeMessages(list, [m]);
        draw({ keepBottom: true });
      }
    } catch (err) {
      fail(C('sendError'), errText(err));
    } finally {
      done();
      input.focus();
    }
  }
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

  function drawMute() {
    const muted = isMuted(community.mutedUntil);
    banner.hidden = !muted;
    input.disabled = muted;
    send.disabled = muted;
    if (muted) mount(banner, icon('volumeX'), h('span', {}, C('mutedUntil', { date: `${fmtDate(Date.parse(community.mutedUntil))} ${fmtTime(Date.parse(community.mutedUntil))}` })));
  }

  mount(host,
    h('header', { class: 'cm-chat-head' }, icon('hash'), h('strong', { class: 'ellipsis' }, channel.name)),
    h('p', { class: 'cl-note cm-e2e' }, icon('eye'), h('span', {}, C('chatNotice'))),
    box,
    banner,
    h('div', { class: 'cm-composer' }, input, count, send));
  mount(box, skeleton('list', { rows: 5, label: C('loading') }));
  drawMute();
  loadLatest({ first: true });

  const stop = b.watchChannel(channel.id, {
    onStatus: (status) => {
      const was = live;
      live = status === 'SUBSCRIBED';
      if (live && !was) loadLatest(); // lo que llegó mientras no estaba conectado
    },
    onRow: (row) => {
      const m = messageFromRow(row, { people, isBlocked: b.isBlocked });
      if (!m) return;
      if (!m.author) unknownAuthor = true;
      list = mergeMessages(list, [m]);
      draw();
      if (unknownAuthor) loadLatest();
    },
  });
  const timer = setInterval(() => {
    if (!live && document.visibilityState === 'visible') loadLatest();
  }, POLL_MS);

  return {
    setCommunity(next) {
      community = next;
      drawMute();
    },
    destroy() {
      destroyed = true;
      clearInterval(timer);
      stop();
    },
  };
}
