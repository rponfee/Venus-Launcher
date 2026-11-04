// Panel de administracion: stickers de los usuarios (3.3). render(root) dibuja la lista de admin_stickers (0030) con
// busqueda y Borrar (admin_sticker_delete, que lo anota en admin_log; el archivo se borra con la sesion del admin). Lo
// enchufa pages/admin.js. Las denuncias de stickers llegan a la pestaña Denuncias con "sticker:<id>" en el texto.
import { h, icon, mount, ok, fail, setBusy, skeleton, emptyState, fmtAgo, fmtBytes, ensureCss, debounce, promptDialog } from '../../ui.js';
import { t, loadNs } from '../../i18n.js';
import { cloud } from '../../cloud.js';
import { STICKER_BUCKET, stickerUrl, parseStickerUrl } from '../../social/stickers.js';

const S = (k, vars) => t(`socialplus.${k}`, vars);
const PAGE = 60;

export async function render(root) {
  ensureCss('features/socialplus');
  await loadNs('socialplus');
  const st = { query: '', items: [], total: 0, loading: false, req: 0 };
  const search = h('input', { class: 'input', type: 'search', placeholder: S('adminSearch'), 'aria-label': S('adminSearch'), maxlength: 80 });
  const reload = h('button', { class: 'btn sm', type: 'button' }, icon('refresh'), S('adminReload'));
  const list = h('div', { class: 'spx-admin-list' });
  const foot = h('div', { class: 'row wrap spx-admin-foot' });
  mount(root, h('div', { class: 'page-head' }, h('div', { class: 'ph-text' }, h('h2', { class: 'page-title' }, S('adminTitle')), h('p', { class: 'page-sub' }, S('adminSub'))), h('div', { class: 'page-actions' }, reload)), h('div', { class: 'spx-admin-search' }, search), list, foot);

  async function load(more = false) {
    const req = ++st.req;
    if (!more) mount(list, skeleton('list', { rows: 4, label: S('adminLoading') }));
    st.loading = true;
    try {
      const { data, error } = await cloud.client.rpc('admin_stickers', { p_query: st.query || null, p_limit: PAGE, p_offset: more ? st.items.length : 0 });
      if (error) throw error;
      if (req !== st.req) return;
      const rows = Array.isArray(data?.items) ? data.items : [];
      st.items = more ? [...st.items, ...rows] : rows;
      st.total = Number(data?.total) || 0;
      draw();
    } catch (err) {
      if (req !== st.req) return;
      console.warn('[admin] stickers:', err?.message || err);
      mount(list, emptyState('alert', S('adminFailed'), ''));
      mount(foot);
    } finally {
      st.loading = false;
    }
  }

  function draw() {
    mount(list, st.items.length ? st.items.map(row) : emptyState('smile', S('adminEmpty'), ''));
    const more = st.items.length < st.total ? h('button', { class: 'btn ghost sm', type: 'button', onclick: () => load(true) }, icon('chevronDown'), S('adminMore')) : null;
    mount(foot, h('span', { class: 'muted small' }, S('adminCount', { shown: st.items.length, total: st.total })), more);
  }

  function row(r) {
    const base = cloud.config?.url;
    const url = stickerUrl(r.path, base);
    const safe = parseStickerUrl(url, base);
    const who = String(r.displayName || r.username || '').slice(0, 32) || t('social.someone');
    const del = h('button', { class: 'btn sm danger', type: 'button' }, icon('trash'), S('adminDelete'));
    del.addEventListener('click', async () => {
      const note = await promptDialog(S('adminDeleteTitle', { name: r.name }), S('adminDeleteNote'), { okText: S('adminDelete'), hint: S('adminDeleteHint') });
      if (note === null) return;
      const release = setBusy(del);
      try {
        const { data, error } = await cloud.client.rpc('admin_sticker_delete', { p_id: r.id, p_note: String(note).trim().slice(0, 300) || null });
        if (error) throw error;
        const removed = await cloud.client.storage.from(STICKER_BUCKET).remove([data?.path || r.path]);
        if (removed.error) console.warn('[admin] archivo del sticker:', removed.error.message);
        ok(S('adminDeleted'), `:${r.name}:`);
        st.items = st.items.filter((x) => x.id !== r.id);
        st.total = Math.max(0, st.total - 1);
        draw();
      } catch (err) {
        release();
        fail(S('adminDeleteFailed'), err);
      }
    });
    const at = Date.parse(r.createdAt);
    return h(
      'div',
      { class: 'card spx-admin-row' },
      // Solo se dibuja si la direccion es del bucket propio
      safe ? h('img', { class: 'spx-admin-img', src: url, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', draggable: 'false' }) : h('span', { class: 'spx-admin-img' }),
      h(
        'div',
        { class: 'spx-admin-main' },
        h('div', { class: 'spx-admin-name selectable' }, `:${r.name}:`),
        h('div', { class: 'muted small' }, S('adminBy', { name: who }), r.username ? ` · @${String(r.username).slice(0, 32)}` : ''),
        h('div', { class: 'muted small' }, [String(r.mime || '').replace('image/', '').toUpperCase(), fmtBytes(r.bytes), Number.isFinite(at) ? fmtAgo(at) : ''].filter(Boolean).join(' · ')),
        h('div', { class: 'spx-admin-id selectable' }, r.id),
      ),
      del,
    );
  }

  const searchSoon = debounce(() => {
    st.query = search.value.trim();
    load();
  }, 350);
  search.addEventListener('input', searchSoon);
  reload.addEventListener('click', () => load());
  load();
}
