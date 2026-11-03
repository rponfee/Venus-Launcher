// Libro de visitas (3.1): seccion de la tarjeta publica con las ultimas 10 entradas, "ver mas", escribir (solo los
// amigos del dueño, 5 por dia) y borrar (el autor o el dueño). RPC de 0027: guestbook_list, guestbook_post,
// guestbook_delete y guestbook_set (en el editor).
//   guestbookSection(ownerId, { isMe, isFriend, preview }) -> Element
import { h, icon, mount, ok, fail, skeleton, setBusy, confirmDialog, fmtAgo } from '../ui.js';
import { t } from '../i18n.js';
import { cloud } from '../cloud.js';
import { social } from '../social.js';
import { LIMITS, cleanText } from '../features/profile-editor/model.js';
import { headImg } from './profile-ui.js';
import { styledName } from './profile-style.js';
import { canPostGuestbook, mergeGuestbook, oldestGuestbookAt, GUESTBOOK_PAGE } from './logic.js';

const P = (k, vars) => t(`profile.${k}`, vars);
const errorKey = (err) => {
  const m = /\b(not_friends|too_many_today|guestbook_off|blocked|bad_body)\b/.exec(String(err?.message || err?.code || ''));
  return m ? `err_gb_${m[1]}` : null;
};

export function guestbookSection(ownerId, { isMe = false, isFriend = false, preview = false } = {}) {
  const list = h('div', { class: 'pf-gb-list' });
  const more = h('button', { class: 'btn ghost sm', type: 'button', hidden: true }, icon('chevronDown'), P('guestbookMore'));
  const me = social.userId || cloud.user?.id || null;
  let entries = [];
  let done = false;

  function row(e) {
    const author = e.author || {};
    const name = author.displayName || author.username || t('social.someone');
    const mine = me && author.id === me;
    return h(
      'div',
      { class: 'pf-gb-item', dataset: { id: e.id } },
      headImg({ mc_name: author.mcName, mc_uuid: author.mcUuid, username: author.username }, 28),
      h(
        'div',
        { class: 'pf-gb-main' },
        h('div', { class: 'pf-gb-head' }, h('span', { class: 'pf-gb-name ellipsis' }, styledName({ id: author.id, username: author.username, displayName: name }, { size: 'sm' })), h('time', { class: 'pf-gb-time', datetime: e.at, title: e.at }, fmtAgo(Date.parse(e.at)))),
        h('div', { class: 'pf-gb-body selectable' }, cleanText(e.body, LIMITS.guestbook)),
      ),
      (mine || isMe) && !preview
        ? h('button', { class: 'icon-btn sm danger', type: 'button', title: P('guestbookDelete'), 'aria-label': P('guestbookDelete'), onclick: () => remove(e) }, icon('trash'))
        : null,
    );
  }
  function draw() {
    mount(list, entries.length ? entries.map(row) : h('div', { class: 'pf-gb-empty' }, P('guestbookEmpty')));
    more.hidden = done || entries.length < GUESTBOOK_PAGE;
  }
  async function load(before = null) {
    if (preview) {
      draw();
      return;
    }
    if (!before) mount(list, skeleton('list', { rows: 2, label: P('guestbook') }));
    try {
      const { data, error } = await cloud.client.rpc('guestbook_list', { p_owner: ownerId, p_before: before });
      if (error) throw error;
      const page = Array.isArray(data) ? data : [];
      entries = mergeGuestbook(entries, page);
      if (page.length < GUESTBOOK_PAGE) done = true;
    } catch (err) {
      console.warn('[profile] libro de visitas:', err?.message || err);
      mount(list, h('div', { class: 'pf-gb-empty' }, icon('alert'), P('guestbookLoadFailed')));
      more.hidden = true;
      return;
    }
    draw();
  }
  more.addEventListener('click', async () => {
    const release = setBusy(more);
    try {
      await load(oldestGuestbookAt(entries));
    } finally {
      release();
    }
  });
  async function remove(e) {
    if (!(await confirmDialog(P('guestbookDelete'), cleanText(e.body, 80), { okText: P('guestbookDelete'), danger: true }))) return;
    try {
      const { error } = await cloud.client.rpc('guestbook_delete', { p_id: e.id });
      if (error) throw error;
      entries = entries.filter((x) => x.id !== e.id);
      draw();
      ok(P('guestbookDeleted'));
    } catch (err) {
      fail(P('guestbookFailed'), err);
    }
  }

  // Escribir
  const canPost = canPostGuestbook({ isOwner: isMe, isFriend, enabled: true, moderation: social.moderation }) && !preview;
  const input = h('textarea', { class: 'textarea pf-gb-input', rows: 2, maxlength: LIMITS.guestbook, placeholder: P('guestbookPlaceholder'), 'aria-label': P('guestbook') });
  const count = h('span', { class: 'pf-gb-count num', 'aria-hidden': 'true' }, P('guestbookCount', { count: 0, max: LIMITS.guestbook }));
  const send = h('button', { class: 'btn tonal sm', type: 'button', disabled: true }, icon('send'), P('guestbookSend'));
  input.addEventListener('input', () => {
    count.textContent = P('guestbookCount', { count: input.value.length, max: LIMITS.guestbook });
    send.disabled = !input.value.trim();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      send.click();
    }
  });
  send.addEventListener('click', async () => {
    const body = input.value.trim();
    if (!body) return;
    const release = setBusy(send);
    try {
      const { data, error } = await cloud.client.rpc('guestbook_post', { p_owner: ownerId, p_body: body });
      if (error) throw error;
      entries = mergeGuestbook([data], entries);
      input.value = '';
      input.dispatchEvent(new Event('input'));
      draw();
      ok(P('guestbookPosted'));
    } catch (err) {
      const key = errorKey(err);
      fail(P('guestbookFailed'), key ? P(key) : err);
    } finally {
      release();
    }
  });
  const compose = canPost
    ? h('div', { class: 'pf-gb-compose' }, input, h('div', { class: 'pf-gb-compose-row' }, count, h('span', { class: 'spacer' }), send))
    : isMe || preview
      ? null
      : h('div', { class: 'pf-gb-empty' }, icon('lock'), P('guestbookFriendsOnly'));
  const el = h('div', { class: 'pf-gb' }, list, more, compose);
  load();
  return el;
}
