// Buscador de GIF de KLIPY para Mensajes (3.1). Reusa features/profile-editor/klipy.js y sigue sus condiciones:
// resultados en su propia grilla y en su orden, "Search KLIPY" en el buscador, "Powered by KLIPY" visible y
// reportShare al mandar. El mensaje lleva solo la direccion del GIF (isKlipyUrl del modelo).
//   openGifPicker(anchor, (gif) => ...) -> { close } | null (si no hay clave cargada, avisa y devuelve null)
import { h, icon, mount, skeleton, toast } from '../ui.js';
import { t, getLanguage } from '../i18n.js';
import { cloud } from '../cloud.js';
import { searchGifs, reportShare } from '../features/profile-editor/klipy.js';

let open = null;

export function closeGifPicker() {
  open?.close();
}

export function openGifPicker(anchor, onPick) {
  if (open) {
    const same = open.anchor === anchor;
    open.close();
    if (same) return null;
  }
  // La clave de KLIPY se pide con la sesion de Venus: sin sesion (o con datos falsos) no hay GIF
  if (!cloud.client || !cloud.isSignedIn()) {
    toast('info', t('messages.gifUnavailable'), t('messages.gifUnavailableText'));
    return null;
  }
  const st = { query: '', page: 1, items: [], hasNext: false, loading: false, error: null, req: 0 };
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Search KLIPY', maxlength: 100, spellcheck: 'false', 'aria-label': 'Search KLIPY' });
  const grid = h('div', { class: 'msg-gif-grid', role: 'listbox', 'aria-label': t('messages.gifPicker') });
  const foot = h('div', { class: 'msg-gif-foot' });
  const pop = h('div', { class: 'msg-gif-pop', role: 'dialog', 'aria-label': t('messages.gifPicker') }, search, grid, foot);
  let timer = null;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => load(search.value, 1), 350);
  });

  async function load(query, page) {
    const req = ++st.req;
    Object.assign(st, { query, page, loading: true, error: null });
    draw();
    try {
      const res = await searchGifs(query, { page, lang: getLanguage() });
      if (req !== st.req) return;
      st.items = page > 1 ? [...st.items, ...res.items] : res.items;
      st.hasNext = res.hasNext;
    } catch (err) {
      if (req !== st.req) return;
      if (err?.code !== 'no_key') console.warn('[klipy]', err?.code || '', err?.message || err);
      st.error = err?.code || 'server';
      if (st.error === 'no_key') {
        // Sin clave cargada en el servidor: el boton avisa y se cierra
        toast('info', t('messages.gifUnavailable'), t('messages.gifUnavailableText'));
        close();
        return;
      }
    } finally {
      if (req === st.req) {
        st.loading = false;
        draw();
      }
    }
  }

  function draw() {
    mount(
      grid,
      st.items.map((g) =>
        h(
          'button',
          {
            type: 'button',
            role: 'option',
            class: 'msg-gif-item',
            title: g.title || t('messages.gifSendTitle'),
            'aria-label': g.title || t('messages.gifSendTitle'),
            onclick: () => {
              close();
              reportShare(g.slug);
              onPick(g);
            },
          },
          h('img', { src: g.thumb, alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' }),
        ),
      ),
    );
    const more = st.hasNext && !st.loading ? h('button', { class: 'btn ghost sm', type: 'button', onclick: () => load(st.query, st.page + 1) }, icon('chevronDown'), t('messages.gifMore')) : null;
    let status = null;
    if (st.loading) status = skeleton('line', { width: 140, label: t('messages.gifLoading') });
    else if (st.error) status = h('span', { class: 'msg-gif-status' }, icon('alert'), t(st.error === 'network' ? 'messages.gifNetwork' : 'messages.gifError'));
    else if (!st.items.length) status = h('span', { class: 'msg-gif-status' }, t('messages.gifEmpty'));
    mount(foot, status, more, h('span', { class: 'msg-gif-mark' }, 'Powered by KLIPY'));
  }

  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  const pr = pop.getBoundingClientRect();
  const left = Math.max(8, Math.min(window.innerWidth - pr.width - 8, r.left));
  const above = r.top - pr.height - 8;
  pop.style.left = `${left}px`;
  pop.style.top = `${above >= 8 ? above : Math.min(window.innerHeight - pr.height - 8, r.bottom + 8)}px`;
  const onDown = (e) => {
    if (!pop.contains(e.target) && !anchor.contains(e.target)) close();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
      anchor.focus?.();
    }
  };
  function close() {
    clearTimeout(timer);
    st.req++;
    pop.remove();
    document.removeEventListener('mousedown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', close);
    if (open?.pop === pop) open = null;
  }
  setTimeout(() => {
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('resize', close);
  }, 0);
  document.addEventListener('keydown', onKey, true);
  open = { pop, anchor, close };
  load('', 1);
  search.focus();
  return open;
}
