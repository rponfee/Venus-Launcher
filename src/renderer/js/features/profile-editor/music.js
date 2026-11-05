// Pestaña "Musica" del editor de perfil (4.6): la cancion del perfil se elige de Openverse (musica libre de Jamendo y
// Wikimedia Commons, solo licencias que permiten uso comercial) en vez de subir un archivo. Buscador por texto, genero,
// duracion y fuente; escucha previa; tramo de 30 s (inicio dentro de la pista) y atribucion siempre a la vista.
// La busqueda la hace el proceso principal (modules/profilemusic.js, canal profilemusic:search); el audio suena directo
// desde Jamendo o Wikimedia, sin pasar por nuestro servidor. Todo lo que llega de la API es texto no confiable: se
// dibuja como texto y las direcciones pasan por music-logic.js antes de usarse.
//   const panel = buildMusicPanel({ getSong, setSong, locked }) -> Element (se pone adentro de un panel del editor)
//   getSong() -> cardStyle.song actual (o null); setSong(song | null) -> lo guarda en el borrador y avisa al editor.
import { h, icon, mount, setBusy } from '../../ui.js';
import { api, store } from '../../store.js';
import {
  GENRES,
  LENGTHS,
  SOURCE_CHOICES,
  LIMITS,
  normalizeSong,
  songFromTrack,
  trackPlayable,
  isSongAudioUrl,
  clampStart,
  clipProgress,
  fmtClock,
  fmtWait,
  errorInfo,
  songSource,
} from './music-logic.js';
import { M, musicEnabled, ensureMusicCss, attributionEl, enableNotice, licenseText, sourceName } from './music-ui.js';

const PREVIEW_VOLUME = 0.7;

export function buildMusicPanel({ getSong, setSong, locked = false } = {}) {
  ensureMusicCss();
  const root = h('div', { class: 'pm' });
  const st = {
    text: '',
    genre: '',
    length: 'any',
    source: 'jamendo',
    items: [],
    page: 0,
    pageCount: 0,
    total: 0,
    loading: false,
    attempt: 1, // pagina del ultimo pedido (para reintentar)
    searched: false,
    error: null, // { code, retryAfter }
    note: '', // 'cache' | 'stale' | ''
    duration: new Map(), // id de pista -> duracion en segundos (la de la busqueda o la del archivo)
  };
  let token = 0;
  let waitTimer = 0;
  let destroyed = false;

  // ---------- Escucha previa (una sola a la vez) ----------
  const preview = { audio: null, key: null, start: 0, len: 0 };
  function stopPreview() {
    if (preview.audio) {
      preview.audio.pause();
      preview.audio.removeAttribute('src');
      preview.audio.load();
    }
    preview.audio = null;
    preview.key = null;
    paintPreview();
  }
  function paintPreview() {
    for (const btn of root.querySelectorAll('[data-pm-key]')) {
      const on = btn.dataset.pmKey === preview.key;
      mount(btn, icon(on ? 'pause' : 'play'));
      btn.title = btn.ariaLabel = M(on ? 'previewStop' : 'previewPlay');
      btn.closest('.pm-row, .pm-current')?.classList.toggle('playing', on);
      const bar = btn.closest('.pm-row, .pm-current')?.querySelector('.pm-bar > i');
      if (bar && !on) bar.style.width = '0%';
    }
  }
  function playPreview(key, url, start, len) {
    if (preview.key === key) return stopPreview();
    stopPreview();
    if (!isSongAudioUrl(url)) return;
    const a = new Audio();
    a.preload = 'auto';
    a.volume = PREVIEW_VOLUME;
    a.src = url;
    preview.audio = a;
    preview.key = key;
    preview.start = start;
    preview.len = len;
    const seek = () => {
      try {
        a.currentTime = start;
      } catch {
        /* todavia no se puede mover */
      }
    };
    seek();
    a.addEventListener('loadedmetadata', seek, { once: true });
    a.addEventListener('timeupdate', () => {
      if (preview.audio !== a) return;
      const k = clipProgress(a.currentTime, start, len);
      const bar = root.querySelector(`[data-pm-key="${CSS.escape(key)}"]`)?.closest('.pm-row, .pm-current')?.querySelector('.pm-bar > i');
      if (bar) bar.style.width = `${Math.round(k * 100)}%`;
      if (a.currentTime >= start + len) stopPreview();
    });
    a.addEventListener('ended', () => preview.audio === a && stopPreview());
    a.addEventListener('error', () => {
      if (preview.audio !== a) return;
      const row = root.querySelector(`[data-pm-key="${CSS.escape(key)}"]`)?.closest('.pm-row, .pm-current');
      stopPreview();
      row?.classList.add('failed');
      row?.querySelector('.pm-failed')?.removeAttribute('hidden');
    });
    paintPreview();
    a.play().catch(() => preview.audio === a && stopPreview());
  }

  // ---------- Cancion elegida ----------
  const currentBox = h('section', { class: 'pfe-group pm-section' });
  let probe = null; // duracion del archivo de una cancion ya guardada (se lee del audio, una vez)
  const failedProbe = new Set();

  // Solo cuando la pestaña se ve: abrir el editor no contacta a nadie si no hace falta
  const visible = () => root.isConnected && !root.closest('[hidden]');
  function ensureDuration(song) {
    if (st.duration.has(song.id) || failedProbe.has(song.id) || !musicEnabled() || probe?.id === song.id || !visible()) return;
    const a = new Audio();
    a.preload = 'metadata';
    probe = { id: song.id, a };
    a.addEventListener('loadedmetadata', () => {
      if (Number.isFinite(a.duration) && a.duration > 0) st.duration.set(song.id, Math.floor(a.duration));
      a.removeAttribute('src');
      a.load();
      probe = null;
      if (!destroyed && getSong()?.id === song.id) drawCurrent();
    });
    a.addEventListener('error', () => {
      probe = null;
      failedProbe.add(song.id);
      if (!destroyed && getSong()?.id === song.id) drawCurrent();
    });
    a.src = song.url;
  }

  function drawCurrent() {
    const song = normalizeSong(getSong());
    const parts = [h('div', { class: 'pfe-group-head' }, h('h4', { class: 'pfe-group-title' }, M('currentTitle')), h('p', { class: 'pfe-group-sub' }, M('currentHint')))];
    if (!song) {
      parts.push(h('div', { class: 'pm-empty' }, icon('music'), h('span', {}, M('currentNone'))));
      mount(currentBox, parts);
      return;
    }
    ensureDuration(song);
    const duration = st.duration.get(song.id) || 0;
    const key = `current:${song.id}`;
    const playBtn = h('button', { class: 'icon-btn pm-play', type: 'button', 'data-pm-key': key, disabled: !musicEnabled() }, icon('play'));
    playBtn.addEventListener('click', () => {
      const s = normalizeSong(getSong());
      if (s) playPreview(key, s.url, s.start, s.len);
    });
    const maxStart = duration ? Math.max(0, duration - song.len) : 0;
    const range = h('input', { type: 'range', class: 'pfe-range pm-range', min: 0, max: maxStart, step: 1, value: Math.min(song.start, maxStart), disabled: locked || !duration || maxStart === 0, 'aria-label': M('startLabel') });
    const out = h('output', { class: 'pfe-range-value num' }, `${fmtClock(song.start)} – ${fmtClock(song.start + song.len)}`);
    range.addEventListener('input', () => {
      const s = Number(range.value);
      out.textContent = `${fmtClock(s)} – ${fmtClock(s + song.len)}`;
    });
    range.addEventListener('change', () => {
      const cur = normalizeSong(getSong());
      if (!cur) return;
      const start = clampStart(range.value, cur.len, duration || cur.start + cur.len);
      stopPreview();
      setSong({ ...cur, start });
      drawCurrent();
    });
    const removeBtn = h('button', { class: 'btn ghost', type: 'button', disabled: locked }, icon('trash'), M('remove'));
    removeBtn.addEventListener('click', () => {
      stopPreview();
      setSong(null);
      drawCurrent();
    });
    const hint = !duration && musicEnabled() ? h('div', { class: 'field-help' }, M(failedProbe.has(song.id) ? 'startFailed' : 'startLoading')) : !musicEnabled() ? h('div', { class: 'field-help' }, M('startNeedsEnable')) : maxStart === 0 ? h('div', { class: 'field-help' }, M('startShort')) : null;
    parts.push(
      h(
        'div',
        { class: 'pm-current' },
        h('div', { class: 'pm-current-main' }, playBtn, h('div', { class: 'pm-current-text' }, attributionEl(song), h('div', { class: 'pm-bar', 'aria-hidden': 'true' }, h('i')))),
        h('div', { class: 'pm-failed notice bad', role: 'status', hidden: true }, icon('alert'), M('previewFailed')),
        h('label', { class: 'pfe-range-field' }, h('span', {}, M('startLabel')), range, out),
        hint,
        h('div', { class: 'pm-current-foot' }, h('span', { class: 'pm-len' }, icon('clock'), M('clipLen', { s: song.len })), removeBtn),
      ),
    );
    mount(currentBox, parts);
    paintPreview();
  }

  function choose(track) {
    if (locked || !trackPlayable(track)) return;
    const song = songFromTrack(track, { start: 0 });
    if (!song) return;
    st.duration.set(song.id, track.duration);
    stopPreview();
    setSong(song);
    drawCurrent();
    drawResults();
    currentBox.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }

  // ---------- Buscador ----------
  const input = h('input', { class: 'input', type: 'search', maxlength: 100, placeholder: M('searchPlaceholder'), 'aria-label': M('searchLabel'), autocomplete: 'off', spellcheck: 'false', disabled: locked });
  const searchBtn = h('button', { class: 'btn primary', type: 'button', disabled: locked }, icon('search'), M('search'));
  const genreBox = h('div', { class: 'pm-chips', role: 'group', 'aria-label': M('genreLabel') });
  const lengthSel = h('select', { class: 'select', 'aria-label': M('lengthLabel'), disabled: locked }, LENGTHS.map((id) => h('option', { value: id }, M(`length_${id}`))));
  const sourceSel = h('select', { class: 'select', 'aria-label': M('sourceLabel'), disabled: locked }, SOURCE_CHOICES.map((id) => h('option', { value: id }, M(`source_${id}`))));
  const status = h('div', { class: 'pm-status', role: 'status', 'aria-live': 'polite' });
  const list = h('ul', { class: 'pm-list', 'aria-label': M('resultsLabel') });
  const moreBtn = h('button', { class: 'btn', type: 'button', hidden: true }, icon('plus'), M('more'));
  const errorBox = h('div', { class: 'pm-error', hidden: true });

  function drawGenres() {
    mount(
      genreBox,
      GENRES.map((id) =>
        h('button', { type: 'button', class: ['pm-chip', st.genre === id && 'active'], 'aria-pressed': String(st.genre === id), disabled: locked || st.loading, onclick: () => ((st.genre = st.genre === id ? '' : id), drawGenres(), run(1)) }, M(`genre_${id}`)),
      ),
    );
  }

  function clearWait() {
    clearInterval(waitTimer);
    waitTimer = 0;
  }
  function drawError() {
    clearWait();
    if (!st.error) {
      errorBox.hidden = true;
      mount(errorBox, []);
      return;
    }
    const { code } = st.error;
    let left = st.error.retryAfter;
    const text = h('span', {});
    const retry = h('button', { class: 'btn sm', type: 'button' }, icon('refresh'), M('retry'));
    retry.addEventListener('click', () => run(st.attempt, { keep: true }));
    const paint = () => {
      const w = fmtWait(left);
      text.textContent = M(`err_${code}`, { wait: M(`wait_${w.unit}`, { n: w.n }) });
      retry.disabled = left > 0;
    };
    errorBox.hidden = false;
    const waiting = code === 'rate_limited' || code === 'daily_limit';
    mount(errorBox, h('div', { class: 'notice bad', role: 'alert' }, icon('alert'), text, code === 'bad_query' || code === 'disabled' ? null : retry));
    if (waiting && left > 0) {
      paint();
      waitTimer = setInterval(() => {
        left = Math.max(0, left - 1);
        paint();
        if (left <= 0) clearWait();
      }, 1000);
    } else {
      left = 0;
      paint();
    }
  }

  function trackRow(track) {
    const key = `result:${track.id}`;
    const chosen = getSong()?.id === track.id;
    const playBtn = h('button', { class: 'icon-btn pm-play', type: 'button', 'data-pm-key': key, title: M('previewPlay'), 'aria-label': M('previewPlay') }, icon('play'));
    playBtn.addEventListener('click', () => playPreview(key, track.url, 0, Math.min(LIMITS.seconds, track.duration)));
    const pick = h('button', { class: ['btn', 'sm', chosen ? 'tonal' : 'primary'], type: 'button', disabled: locked || chosen }, icon(chosen ? 'check' : 'music'), chosen ? M('chosen') : M('choose'));
    pick.addEventListener('click', () => choose(track));
    const source = songSource(track.url);
    return h(
      'li',
      { class: ['pm-row', chosen && 'chosen'] },
      playBtn,
      h(
        'div',
        { class: 'pm-row-main' },
        h('div', { class: 'pm-row-title ellipsis', title: track.title }, track.title),
        h(
          'div',
          { class: 'pm-row-meta' },
          h('span', { class: 'ellipsis', title: track.creator }, track.creator || M('creatorUnknown')),
          h('span', { class: 'pm-badge', title: M('licenseHint') }, licenseText(track.license, track.licenseVersion)),
          h('span', { class: 'pm-dur num' }, fmtClock(track.duration)),
          h('span', { class: 'pm-src' }, sourceName(source)),
        ),
        h('div', { class: 'pm-bar', 'aria-hidden': 'true' }, h('i')),
        h('div', { class: 'pm-failed small', hidden: true }, icon('alert'), M('previewFailed')),
      ),
      pick,
    );
  }

  function drawResults() {
    if (st.loading && !st.items.length) {
      mount(list, [h('li', { class: 'pm-loading', role: 'status' }, h('div', { class: 'spinner', 'aria-hidden': 'true' }), M('searching'))]);
    } else if (!st.items.length) {
      mount(list, st.searched && !st.error ? h('li', { class: 'pm-empty' }, icon('search'), h('span', {}, M('noResults'))) : !st.searched ? h('li', { class: 'pm-empty' }, icon('music'), h('span', {}, M('startHint'))) : []);
    } else {
      mount(list, st.items.map(trackRow));
    }
    moreBtn.hidden = !(st.items.length && st.page < st.pageCount);
    moreBtn.disabled = st.loading || locked;
    mount(status, st.searched && !st.error ? [st.total ? M('resultCount', { count: st.total }) : '', st.note ? h('span', { class: 'pm-note' }, icon('info'), M(`note_${st.note}`)) : null] : []);
    paintPreview();
  }

  // Ejecuta la busqueda (pagina 1 la reemplaza; las siguientes se suman)
  async function run(page = 1, { keep = false } = {}) {
    if (locked || destroyed) return;
    const my = ++token;
    if (!keep) {
      st.text = input.value.trim();
    }
    st.length = lengthSel.value;
    st.source = sourceSel.value;
    if (!st.text && !st.genre) {
      st.error = { code: 'bad_query', retryAfter: 0 };
      drawError();
      return;
    }
    st.loading = true;
    st.error = null;
    st.attempt = page;
    if (page === 1) {
      st.items = [];
      st.page = 0;
      stopPreview();
    }
    drawError();
    drawResults();
    drawGenres();
    const release = setBusy(searchBtn);
    let res;
    try {
      res = await api.invoke('profilemusic:search', { text: st.text, genre: st.genre, length: st.length, source: st.source, page });
    } catch (err) {
      console.warn('[profilemusic] buscar:', err?.message || err);
      res = { error: 'network' };
    }
    release();
    if (my !== token || destroyed) return;
    st.loading = false;
    st.searched = true;
    if (!res || res.error || !Array.isArray(res.items)) {
      st.error = errorInfo(res);
      if (st.error.code === 'disabled') return draw(); // se apago desde Ajustes mientras tanto
    } else {
      const known = new Set(st.items.map((t) => t.id));
      st.items = [...st.items, ...res.items.filter((t) => trackPlayable(t) && !known.has(t.id))];
      st.page = res.page;
      st.pageCount = res.pageCount;
      st.total = res.total;
      st.note = res.stale ? 'stale' : res.fromCache ? 'cache' : '';
      for (const t of res.items) if (Number.isFinite(t.duration)) st.duration.set(t.id, t.duration);
    }
    drawError();
    drawResults();
    drawGenres();
  }

  searchBtn.addEventListener('click', () => run(1));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      run(1);
    }
  });
  lengthSel.addEventListener('change', () => (st.searched || input.value.trim() || st.genre) && run(1));
  sourceSel.addEventListener('change', () => (st.searched || input.value.trim() || st.genre) && run(1));
  moreBtn.addEventListener('click', () => run(st.page + 1, { keep: true }));

  const searchBox = h(
    'section',
    { class: 'pfe-group pm-section' },
    h('div', { class: 'pfe-group-head' }, h('h4', { class: 'pfe-group-title' }, M('searchTitle')), h('p', { class: 'pfe-group-sub' }, M('searchHint'))),
    h('div', { class: 'pm-search' }, input, searchBtn),
    genreBox,
    h('div', { class: 'pm-filters' }, h('label', { class: 'pm-filter' }, h('span', {}, M('lengthLabel')), lengthSel), h('label', { class: 'pm-filter' }, h('span', {}, M('sourceLabel')), sourceSel)),
    errorBox,
    status,
    list,
    h('div', { class: 'pm-more' }, moreBtn),
  );

  const credits = h(
    'p',
    { class: 'pm-credits small' },
    icon('shieldCheck'),
    h('span', {}, M('creditsText')),
  );

  let drawnEnabled = musicEnabled();
  function draw() {
    drawnEnabled = musicEnabled();
    stopPreview();
    drawCurrent();
    if (!musicEnabled()) {
      mount(root, [currentBox, enableNotice(() => draw()), credits]);
      return;
    }
    mount(root, [currentBox, searchBox, credits]);
    drawGenres();
    drawResults();
    drawError();
  }
  draw();

  // La escucha se corta sola al cerrar el editor o cambiar de pestaña (el panel queda oculto o fuera de la pagina)
  let wasVisible = false;
  const observer = new MutationObserver(() => {
    if (!root.isConnected) return destroy();
    if (!visible()) {
      if (preview.audio) stopPreview();
      wasVisible = false;
      return;
    }
    if (wasVisible) return;
    wasVisible = true; // recien se mostro la pestaña: ahora si se lee la duracion de la cancion guardada
    const song = normalizeSong(getSong());
    if (song && !st.duration.has(song.id) && !probe) drawCurrent();
  });
  // El interruptor tambien se puede mover desde la tarjeta de la vista previa o desde Ajustes
  const offSettings = store.on('settings', () => {
    if (!destroyed && musicEnabled() !== drawnEnabled) draw();
  });
  function destroy() {
    destroyed = true;
    offSettings();
    observer.disconnect();
    clearWait();
    stopPreview();
    if (probe) {
      probe.a.removeAttribute('src');
      probe = null;
    }
  }
  setTimeout(() => root.isConnected && observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] }), 0);
  root.destroy = destroy;
  return root;
}

