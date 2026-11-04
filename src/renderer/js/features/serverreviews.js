// Reseñas y votos de los servidores destacados: el resumen en la tarjeta y el detalle con estrellas, votos, formulario y
// lista paginada. Sin sesión se ve pero no se opina. Todo lo que escriben otros se muestra como texto, nunca como HTML.
// Textos: multiplayer.rev_*. Base: 0029_resenas_servidores.sql (features/serverreviews/backend.js).
//   reviewChip(server) -> { el, update(stats) }   loadSummaries(servers) -> Promise<Map(id -> stats)>
//   openServerReviews(server, { onChange? })      useDemo(escenario) (solo capturas)
import { h, icon, mount, modal, ok, fail, setBusy, confirmDialog, skeleton, emptyState, avatarImg, fmtAgo, selectEl } from '../ui.js';
import { t, locale } from '../i18n.js';
import { navigate } from '../app.js';
import * as backend from './serverreviews/backend.js';
import { MAX_BODY, canReview, bodyLength, cleanBody, canVoteAt, hoursLeft, filledStars, normalizeList, normalizeEntry, normalizeStats, classifyError } from './serverreviews/logic.js';

export { useDemo } from './serverreviews/backend.js';
export { canReview };

const R = (key, vars) => t(`multiplayer.rev_${key}`, vars);
const errorText = (err) => {
  const code = classifyError(err);
  return R(`err_${code}`);
};

function fmtAvg(avg) {
  try {
    return new Intl.NumberFormat(locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(avg);
  } catch {
    return avg.toFixed(1);
  }
}

function fmtCount(n) {
  try {
    return new Intl.NumberFormat(locale()).format(n);
  } catch {
    return String(n);
  }
}

function starsView(value, label) {
  const on = filledStars(value);
  return h('span', { class: 'srv-stars', role: 'img', 'aria-label': label || R('starsLabel', { count: on }) }, [1, 2, 3, 4, 5].map((i) => h('span', { class: i <= on ? 'on' : '' }, icon('star'))));
}

// ---------- En la tarjeta ----------
export function reviewChip(server) {
  const el = h('button', { class: 'srv-chip', type: 'button', onclick: () => openServerReviews(server, { onChange: update }) });
  function update(stats) {
    const s = normalizeStats(stats);
    el.setAttribute('aria-label', R('chipLabel', { name: server.name, reviews: R('reviewsCount', { count: s.count }), votes: R('votesCount', { count: s.votes }) }));
    el.title = R('chipTitle');
    mount(
      el,
      icon('star', s.avg ? 'srv-star-on' : ''),
      s.avg ? h('span', { class: 'srv-num' }, fmtAvg(s.avg)) : null,
      h('span', {}, s.count ? `(${fmtCount(s.count)})` : R('none')),
      h('span', { class: 'srv-chip-sep', 'aria-hidden': 'true' }, '·'),
      h('span', {}, R('votesCount', { count: s.votes })),
    );
  }
  update({});
  return { el, update };
}

export async function loadSummaries(servers) {
  const ids = servers.filter(canReview).map((s) => s.id);
  const raw = await backend.summary(ids);
  return new Map(Object.entries(raw || {}).map(([id, stats]) => [id, normalizeStats(stats)]));
}

// ---------- Selector de estrellas: radio con flechas, como manda la accesibilidad del launcher ----------
function starPicker(initial, onChange) {
  let value = initial;
  const box = h('div', { class: 'srv-picker', role: 'radiogroup', 'aria-label': R('yourStars') });
  const paint = () => {
    [...box.children].forEach((btn, i) => {
      const n = i + 1;
      btn.classList.toggle('on', n <= value);
      btn.setAttribute('aria-checked', String(n === value));
      btn.tabIndex = n === value || (!value && n === 1) ? 0 : -1;
    });
  };
  const set = (n, focus) => {
    value = n;
    paint();
    onChange(n);
    if (focus) box.children[n - 1].focus();
  };
  for (let n = 1; n <= 5; n++) box.append(h('button', { type: 'button', role: 'radio', 'aria-label': R('starsLabel', { count: n }), title: R('starsLabel', { count: n }), onclick: () => set(n) }, icon('star')));
  box.addEventListener('keydown', (e) => {
    const move = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
    if (!move) return;
    e.preventDefault();
    set(Math.max(1, Math.min(5, (value || 0) + move)), true);
  });
  paint();
  return box;
}

// ---------- Denunciar ----------
function openReport(entry) {
  let reason = 'spam';
  const sel = selectEl(['spam', 'abuse', 'other'].map((v) => ({ value: v, label: R(`reason_${v}`) })), reason, (v) => (reason = v));
  sel.id = 'srv-report-reason';
  const text = h('textarea', { class: 'textarea', id: 'srv-report-text', rows: 3, maxlength: MAX_BODY, placeholder: R('reportPlaceholder') });
  const send = h('button', { class: 'btn danger', type: 'button' }, icon('alert'), R('reportSend'));
  let dialog = null;
  send.addEventListener('click', async () => {
    const release = setBusy(send);
    try {
      await backend.report(entry.id, reason, cleanBody(text.value));
      ok(R('reportDone'));
      dialog.close();
    } catch (err) {
      fail(R('reportFail'), errorText(err));
    } finally {
      release();
    }
  });
  dialog = modal({
    title: R('reportTitle'),
    size: 'sm',
    body: h('div', { class: 'stack' }, h('div', { class: 'field' }, h('label', { for: 'srv-report-reason' }, R('reportReason')), sel), h('div', { class: 'field' }, h('label', { for: 'srv-report-text' }, R('reportText')), text)),
    footer: [h('button', { class: 'btn ghost', type: 'button', onclick: () => dialog.close() }, t('common.cancel')), send],
  });
}

// ---------- Una reseña ----------
function itemView(entry) {
  const signedIn = backend.signedIn();
  return h(
    'article',
    { class: 'srv-item' },
    avatarImg(entry.author.mcName || 'MHF_Steve', 32),
    h(
      'div',
      { class: 'srv-item-main' },
      h(
        'div',
        { class: 'srv-item-top' },
        h('span', { class: 'srv-author' }, entry.author.name || R('someone')),
        starsView(entry.stars),
        h('span', { class: 'srv-time' }, entry.at ? fmtAgo(entry.at) : '', entry.edited ? ` · ${R('edited')}` : ''),
        h('span', { class: 'spacer' }),
        signedIn && !entry.mine ? h('button', { class: 'btn ghost sm', type: 'button', title: R('reportTitle'), onclick: () => openReport(entry) }, icon('alert'), R('report')) : null,
      ),
      entry.body ? h('p', { class: 'srv-body' }, entry.body) : null,
    ),
  );
}

// ---------- Detalle ----------
export function openServerReviews(server, { onChange } = {}) {
  const head = h('div', { class: 'srv-head' });
  const form = h('div', {});
  const listBox = h('div', { class: 'srv-list' });
  const more = h('div', { class: 'srv-more' });
  const body = h('div', { class: 'stack' }, head, form, h('div', { class: 'label' }, R('listTitle')), listBox, more);
  let data = null;
  let items = [];
  let alive = true;
  const dialog = modal({ title: server.name, subtitle: R('title'), icon: 'star', size: 'wide', body, onClose: () => (alive = false) });

  const emit = () => data && onChange?.({ avg: data.avg, count: data.count, votes: data.votes });

  function drawHead() {
    const signedIn = backend.signedIn();
    const canVote = canVoteAt(data.vote);
    const voteBtn = h('button', { class: 'btn primary', type: 'button', disabled: !signedIn || !canVote, title: signedIn ? null : R('signInToVote') }, icon('upCircle'), R('vote'));
    voteBtn.addEventListener('click', async () => {
      const release = setBusy(voteBtn);
      try {
        const res = await backend.vote(server.id);
        data.votes = normalizeStats(res).votes;
        data.vote = { total: res?.total || 0, nextAt: Date.parse(res?.nextAt) || null };
        if (res?.ok) ok(R('voted'));
        emit();
        drawHead();
      } catch (err) {
        fail(R('voteFail'), errorText(err));
      } finally {
        release();
      }
    });
    mount(
      head,
      h('span', { class: 'srv-avg' }, data.avg ? fmtAvg(data.avg) : '–'),
      h('div', { class: 'srv-head-text' }, starsView(data.avg, data.avg ? R('avgLabel', { avg: fmtAvg(data.avg) }) : R('none')), h('span', { class: 'small muted' }, R('reviewsCount', { count: data.count }), ' · ', R('votesCount', { count: data.votes }))),
      h('span', { class: 'spacer' }),
      h('div', { class: 'stack srv-vote' }, voteBtn, !canVote ? h('div', { class: 'srv-vote-note' }, R('voteAgain', { count: hoursLeft(data.vote) })) : null),
    );
  }

  function drawForm() {
    if (!backend.signedIn()) {
      mount(form, h('div', { class: 'notice info' }, icon('logIn'), h('div', { class: 'spacer' }, R('signIn')), h('button', { class: 'btn sm', type: 'button', onclick: () => { dialog.close(); navigate('settings/cloud'); } }, R('signInButton'))));
      return;
    }
    const mine = data.mine;
    let stars = mine?.stars || 0;
    const area = h('textarea', { class: 'textarea', id: 'srv-body', rows: 3, maxlength: MAX_BODY, placeholder: R('placeholder'), 'aria-label': R('yourText') });
    area.value = mine?.body || '';
    const counter = h('span', { class: 'srv-count', 'aria-live': 'off' });
    const saveBtn = h('button', { class: 'btn sm', type: 'button' }, icon('save'), mine ? R('update') : R('publish'));
    const refreshCounter = () => {
      const n = bodyLength(area.value);
      counter.textContent = `${n}/${MAX_BODY}`;
      counter.classList.toggle('over', n > MAX_BODY);
      saveBtn.disabled = !stars || n > MAX_BODY;
    };
    area.addEventListener('input', refreshCounter);
    const picker = starPicker(stars, (n) => {
      stars = n;
      refreshCounter();
    });
    saveBtn.addEventListener('click', async () => {
      const release = setBusy(saveBtn);
      try {
        const res = await backend.save(server.id, stars, cleanBody(area.value));
        data.mine = normalizeEntry(res);
        Object.assign(data, normalizeStats(res?.stats));
        ok(R('saved'));
        emit();
        drawHead();
        drawForm();
      } catch (err) {
        fail(R('saveFail'), errorText(err));
      } finally {
        release();
      }
    });
    const delBtn = mine ? h('button', { class: 'btn sm ghost', type: 'button' }, icon('trash'), R('delete')) : null;
    delBtn?.addEventListener('click', async () => {
      if (!(await confirmDialog(R('deleteTitle'), R('deleteText'), { danger: true, okText: R('delete') }))) return;
      const release = setBusy(delBtn);
      try {
        await backend.remove(mine.id);
        ok(R('deleted'));
        await load();
      } catch (err) {
        fail(R('deleteFail'), errorText(err));
      } finally {
        release();
      }
    });
    mount(
      form,
      h(
        'div',
        { class: 'srv-form' },
        h('div', { class: 'row' }, h('span', { class: 'small text-2 spacer' }, mine ? R('yourReview') : R('writeReview')), picker),
        mine?.hidden ? h('div', { class: 'notice' }, icon('alert'), h('div', {}, R('hiddenNote'))) : null,
        area,
        h('div', { class: 'row wrap' }, counter, h('span', { class: 'spacer' }), delBtn, saveBtn),
      ),
    );
    refreshCounter();
  }

  function drawList() {
    mount(listBox, items.length ? items.map(itemView) : emptyState('star', R('empty'), R('emptyText')));
    if (data.next) {
      const btn = h('button', { class: 'btn sm', type: 'button' }, icon('chevronDown'), R('more'));
      btn.addEventListener('click', async () => {
        const release = setBusy(btn);
        try {
          const page = normalizeList(await backend.list(server.id, data.next));
          if (!alive) return;
          data.next = page.next;
          items = [...items, ...page.items];
          drawList();
        } catch (err) {
          fail(R('loadFail'), errorText(err));
        } finally {
          release();
        }
      });
      mount(more, btn);
    } else mount(more, null);
  }

  async function load() {
    try {
      data = normalizeList(await backend.list(server.id));
    } catch (err) {
      if (!alive) return;
      mount(body, emptyState('alert', R('loadFail'), errorText(err), h('button', { class: 'btn', type: 'button', onclick: () => { mount(body, head, form, h('div', { class: 'label' }, R('listTitle')), listBox, more); load(); } }, icon('refresh'), R('retry'))));
      return;
    }
    if (!alive) return;
    items = data.items;
    emit();
    drawHead();
    drawForm();
    drawList();
  }

  mount(listBox, skeleton('list', { rows: 3, label: R('loading') }));
  load();
}
