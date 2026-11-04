// Marcadores del Mapa del mundo: panel con la lista, el buscador y el formulario, y los codigos para compartir (ver
// src/main/modules/mapviewer/markers.js). features/worldmap.js lo crea y dibuja los marcadores sobre el mapa.
//   const tools = createMarkerTools({ instanceId, world, stage, getDim, getCenter, dimLabel, goTo, onChange })
//   tools.button (boton de la barra del mapa), tools.markers() (los de este mundo), tools.addAt(x, z), tools.edit(id),
//   tools.handleEscape() (true si cerro algo), tools.destroy()
// El nombre de un marcador (propio o de un codigo que mando otro) es texto no confiable: va siempre como nodo de texto.
import { h, icon, mount, ok, fail, confirmDialog, copyText, registerIcons } from '../../ui.js';
import { api } from '../../store.js';
import { t, locale } from '../../i18n.js';

// Trazos fijos, nunca datos de afuera (estilo Lucide). Solo este panel y el mapa los usan.
registerIcons({
  mk_pin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
  mk_home: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
  mk_star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
  mk_flag: '<path d="M4 22V4a1 1 0 0 1 .4-.8A6 6 0 0 1 8 2c3 0 5 2 7.333 2q2 0 3.067-.8A1 1 0 0 1 20 4v10a1 1 0 0 1-.4.8A6 6 0 0 1 16 16c-3 0-5-2-8-2a6 6 0 0 0-4 1.528"/>',
  mk_skull: '<circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><path d="M8 20v2h8v-2"/><path d="m12.5 17-.5-1-.5 1h1z"/><path d="M16 20a2 2 0 0 0 1.56-3.25 8 8 0 1 0-11.12 0A2 2 0 0 0 8 20"/>',
  mk_gem: '<path d="M6 3h12l4 6-10 13L2 9Z"/><path d="M11 3 8 9l4 13 4-13-3-6"/><path d="M2 9h20"/>',
  mk_pickaxe: '<path d="M14.531 12.469 6.619 20.38a1 1 0 1 1-3-3l7.912-7.912"/><path d="M15.686 4.314A12.5 12.5 0 0 0 5.461 2.958 1 1 0 0 0 5.58 4.71a22 22 0 0 1 6.318 3.393"/><path d="M17.7 3.7a1 1 0 0 0-1.4 0l-4.6 4.6a1 1 0 0 0 0 1.4l2.6 2.6a1 1 0 0 0 1.4 0l4.6-4.6a1 1 0 0 0 0-1.4z"/><path d="M19.686 8.314a12.501 12.501 0 0 1 1.356 10.225 1 1 0 0 1-1.751-.119 22 22 0 0 0-3.393-6.319"/>',
  mk_castle: '<path d="M22 20v-9H2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2Z"/><path d="M18 11V4H6v7"/><path d="M15 22v-4a3 3 0 0 0-3-3a3 3 0 0 0-3 3v4"/><path d="M22 11V9"/><path d="M2 11V9"/><path d="M6 4V2"/><path d="M18 4V2"/><path d="M10 4V2"/><path d="M14 4V2"/>',
  mk_tree: '<path d="m17 14 3 3.3a1 1 0 0 1-.7 1.7H4.7a1 1 0 0 1-.7-1.7L7 14h-.3a1 1 0 0 1-.7-1.7L9 9h-.2A1 1 0 0 1 8 7.3L12 3l4 4.3a1 1 0 0 1-.8 1.7H15l3 3.3a1 1 0 0 1-.7 1.7H17Z"/><path d="M12 22v-3"/>',
  mk_portal: '<ellipse cx="12" cy="12" rx="7" ry="10"/><ellipse cx="12" cy="12" rx="3" ry="6"/>',
});

// Los mismos que acepta markers.js (lo que venga de otro lado se corrige alla)
export const MARKER_COLORS = ['#f29a2e', '#e5544b', '#ec6fb4', '#a374f0', '#4f8df7', '#3cc4c8', '#54c26a', '#e8c547', '#f4efe6'];
export const MARKER_ICONS = ['pin', 'home', 'star', 'flag', 'skull', 'gem', 'pickaxe', 'castle', 'tree', 'portal'];
const MAX_NAME = 48;
const MAX_CODE = 12000;

export const markerIcon = (name) => icon(`mk_${MARKER_ICONS.includes(name) ? name : 'pin'}`);

// Sin mayusculas ni acentos, como el buscador de recetas
const fold = (s) => String(s || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

const errText = (err) => {
  const key = `overlaytools.mk_err_${err?.code}`;
  const text = t(key);
  return text === key ? err?.message || t('overlaytools.mk_err_save') : text;
};

export function createMarkerTools({ instanceId, world, stage, getDim, getCenter, dimLabel, goTo, onChange }) {
  let list = [];
  let mode = 'list'; // 'list' | 'form' | 'share' | 'import'
  let open = false;
  let query = '';
  let form = null;
  let share = null;
  let preview = null;
  let destroyed = false;

  const button = h('button', { class: 'wm-tool', type: 'button', title: t('overlaytools.mk_tool'), 'aria-label': t('overlaytools.mk_tool'), 'aria-expanded': 'false', onclick: () => toggle() }, icon('mk_pin'));
  const panel = h('aside', { class: 'wm-panel wmk-panel', hidden: true, 'aria-label': t('overlaytools.mk_title') });
  stage.append(panel);

  async function load() {
    try {
      const r = await api.invoke('mapviewer:markers', instanceId, world);
      if (destroyed) return;
      list = r.markers || [];
      onChange?.();
      if (open) draw();
    } catch (err) {
      console.warn('[worldmap] marcadores', err?.message || err);
    }
  }

  function setOpen(next) {
    open = next;
    panel.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    if (open) {
      if (mode === 'list') draw();
    } else {
      mode = 'list';
      form = null;
    }
  }

  function toggle() {
    setOpen(!open);
    if (open) requestAnimationFrame(() => panel.querySelector('input')?.focus());
  }

  function header(title, back) {
    return h(
      'div',
      { class: 'wmk-head' },
      back ? h('button', { class: 'icon-btn sm', type: 'button', title: t('overlaytools.mk_back'), 'aria-label': t('overlaytools.mk_back'), onclick: back }, icon('arrowLeft')) : null,
      h('h4', { class: 'wmk-title' }, title),
      h('button', { class: 'icon-btn sm', type: 'button', title: t('common.close'), 'aria-label': t('common.close'), onclick: () => setOpen(false) }, icon('x')),
    );
  }

  const coordsText = (m) => t('overlaytools.mk_coords', { x: m.x.toLocaleString(locale()), z: m.z.toLocaleString(locale()) });

  // ---------- Lista ----------
  function visible() {
    const q = fold(query);
    const dim = getDim();
    const out = q ? list.filter((m) => fold(`${m.name} ${dimLabel(m.dimension)}`).includes(q)) : [...list];
    // Primero los de la dimension que se esta viendo
    return out.sort((a, b) => (b.dimension === dim) - (a.dimension === dim) || a.name.localeCompare(b.name, locale()));
  }

  function row(m) {
    const other = m.dimension !== getDim();
    return h(
      'div',
      { class: 'wmk-row' },
      h(
        'button',
        { class: 'wmk-open', type: 'button', title: t('overlaytools.mk_go'), onclick: () => goTo(m) },
        h('span', { class: 'wmk-mark', style: { '--mk': m.color }, 'aria-hidden': 'true' }, markerIcon(m.icon)),
        h('span', { class: 'wmk-main' }, h('span', { class: 'wmk-name ellipsis' }, m.name), h('span', { class: 'wmk-sub' }, other ? `${dimLabel(m.dimension)} · ${coordsText(m)}` : coordsText(m))),
      ),
      h('button', { class: 'icon-btn sm', type: 'button', title: t('overlaytools.mk_share'), 'aria-label': t('overlaytools.mk_shareOf', { name: m.name }), onclick: () => startShare([m]) }, icon('share')),
      h('button', { class: 'icon-btn sm', type: 'button', title: t('overlaytools.mk_edit'), 'aria-label': t('overlaytools.mk_editOf', { name: m.name }), onclick: () => edit(m.id) }, icon('edit')),
    );
  }

  function draw() {
    if (destroyed) return;
    if (mode === 'form') return drawForm();
    if (mode === 'share') return drawShare();
    if (mode === 'import') return drawImport();
    const search = h('input', { class: 'input wmk-search', type: 'search', placeholder: t('overlaytools.mk_search'), 'aria-label': t('overlaytools.mk_search'), value: query, maxlength: 60 });
    const box = h('div', { class: 'wmk-list', role: 'list' });
    const count = h('div', { class: 'wmk-count', role: 'status' });
    const fill = () => {
      const items = visible();
      count.textContent = list.length ? t('overlaytools.mk_count', { count: items.length }) : '';
      if (items.length) mount(box, items.map((m) => row(m)));
      else mount(box, h('div', { class: 'wmk-empty' }, list.length ? t('overlaytools.mk_noMatch') : t('overlaytools.mk_empty')));
      shareAll.disabled = !items.length;
    };
    search.addEventListener('input', () => {
      query = search.value;
      fill();
    });
    const shareAll = h('button', { class: 'btn sm ghost', type: 'button', title: t('overlaytools.mk_shareListHint'), onclick: () => startShare(visible()) }, icon('share'), t('overlaytools.mk_shareList'));
    mount(
      panel,
      header(t('overlaytools.mk_title')),
      h('div', { class: 'wmk-tools' }, search, h('button', { class: 'btn sm primary', type: 'button', onclick: () => addAtCenter() }, icon('plus'), t('overlaytools.mk_add'))),
      count,
      box,
      h('div', { class: 'wmk-foot' }, shareAll, h('button', { class: 'btn sm ghost', type: 'button', onclick: () => startImport() }, icon('download'), t('overlaytools.mk_import'))),
    );
    fill();
  }

  // ---------- Formulario ----------
  function addAtCenter() {
    const c = getCenter();
    addAt(c.x, c.z);
  }

  function addAt(x, z) {
    form = { name: '', color: MARKER_COLORS[0], icon: MARKER_ICONS[0], dimension: getDim(), x: Math.floor(x), y: null, z: Math.floor(z) };
    mode = 'form';
    setOpen(true);
    draw();
  }

  function edit(id) {
    const m = list.find((x) => x.id === id);
    if (!m) return;
    form = { ...m };
    mode = 'form';
    setOpen(true);
    draw();
  }

  function drawForm() {
    const f = form;
    const isNew = !f.id;
    const name = h('input', { class: 'input', id: 'wmk-name', value: f.name, maxlength: MAX_NAME, placeholder: t('overlaytools.mk_namePlaceholder') });
    const num = (key, label, placeholder) => {
      const input = h('input', { class: 'input', type: 'number', step: 1, value: f[key] ?? '', placeholder: placeholder || '', 'aria-label': label });
      return { input, el: h('label', { class: 'wmk-num' }, h('span', {}, label), input) };
    };
    const x = num('x', 'X');
    const y = num('y', 'Y', t('overlaytools.mk_yOptional'));
    const z = num('z', 'Z');
    const error = h('div', { class: 'field-error', role: 'alert', hidden: true }, icon('alert'), h('span', {}));
    const showError = (text) => {
      error.hidden = false;
      error.querySelector('span').textContent = text;
    };
    const swatches = MARKER_COLORS.map((c) =>
      h('button', { class: ['wmk-swatch', c === f.color && 'on'], type: 'button', role: 'radio', 'aria-checked': String(c === f.color), 'aria-label': t('overlaytools.mk_colorOption', { color: t(`overlaytools.mk_color_${c.slice(1)}`) }), title: t(`overlaytools.mk_color_${c.slice(1)}`), style: { '--mk': c }, onclick: (e) => pick(swatches, e.currentTarget, () => (f.color = c)) }),
    );
    const icons = MARKER_ICONS.map((n) =>
      h('button', { class: ['wmk-icon', n === f.icon && 'on'], type: 'button', role: 'radio', 'aria-checked': String(n === f.icon), 'aria-label': t(`overlaytools.mk_icon_${n}`), title: t(`overlaytools.mk_icon_${n}`), onclick: (e) => pick(icons, e.currentTarget, () => (f.icon = n)) }, markerIcon(n)),
    );
    function pick(all, el, set) {
      set();
      for (const b of all) {
        const on = b === el;
        b.classList.toggle('on', on);
        b.setAttribute('aria-checked', String(on));
      }
    }
    const save = async () => {
      f.name = name.value;
      const marker = { ...f, x: x.input.value, y: y.input.value, z: z.input.value };
      if (!name.value.trim()) return showError(t('overlaytools.mk_err_noName'));
      if (x.input.value === '' || z.input.value === '') return showError(t('overlaytools.mk_err_badMarker'));
      try {
        const r = await api.invoke('mapviewer:markerSave', instanceId, world, marker);
        list = r.markers;
        mode = 'list';
        form = null;
        onChange?.();
        ok(isNew ? t('overlaytools.mk_added') : t('overlaytools.mk_saved'), r.marker.name);
        draw();
      } catch (err) {
        showError(errText(err));
      }
    };
    const remove = async () => {
      const yes = await confirmDialog(t('overlaytools.mk_deleteTitle'), t('overlaytools.mk_deleteText', { name: f.name }), { okText: t('common.delete'), danger: true });
      if (!yes) return;
      try {
        const r = await api.invoke('mapviewer:markerDelete', instanceId, world, f.id);
        list = r.markers;
        mode = 'list';
        form = null;
        onChange?.();
        draw();
      } catch (err) {
        showError(errText(err));
      }
    };
    name.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        save();
      }
    });
    mount(
      panel,
      header(isNew ? t('overlaytools.mk_newTitle') : t('overlaytools.mk_editTitle'), () => {
        mode = 'list';
        form = null;
        draw();
      }),
      h(
        'div',
        { class: 'wmk-form' },
        h('div', { class: 'field' }, h('label', { for: 'wmk-name' }, t('overlaytools.mk_name')), name),
        h('div', { class: 'wmk-nums' }, x.el, y.el, z.el),
        h('div', { class: 'wmk-sub' }, dimLabel(f.dimension)),
        h('div', { class: 'field' }, h('span', { class: 'wmk-label' }, t('overlaytools.mk_color')), h('div', { class: 'wmk-swatches', role: 'radiogroup', 'aria-label': t('overlaytools.mk_color') }, swatches)),
        h('div', { class: 'field' }, h('span', { class: 'wmk-label' }, t('overlaytools.mk_icon')), h('div', { class: 'wmk-icons', role: 'radiogroup', 'aria-label': t('overlaytools.mk_icon') }, icons)),
        error,
      ),
      h(
        'div',
        { class: 'wmk-foot' },
        isNew ? null : h('button', { class: 'btn sm danger', type: 'button', onclick: remove }, icon('trash'), t('common.delete')),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn sm primary', type: 'button', onclick: save }, icon('check'), t('overlaytools.mk_save')),
      ),
    );
    requestAnimationFrame(() => name.focus());
  }

  // ---------- Compartir ----------
  async function startShare(markers) {
    if (!markers.length) return;
    try {
      share = { ...(await api.invoke('mapviewer:markersEncode', markers)), markers };
      mode = 'share';
      draw();
    } catch (err) {
      fail(t('overlaytools.mk_shareTitle'), Object.assign(new Error(errText(err)), { code: err?.code }));
    }
  }

  // Mandar por Mensajes: elige un amigo y lo manda como un mensaje comun. Sin sesion de Mensajes, solo se copia.
  async function sendToFriend(select, status) {
    const userId = select.value;
    if (!userId) return;
    try {
      const { social } = await import('../../social.js');
      const friend = social.friends.find((f) => f.id === userId);
      const chatId = friend?.chatId || (await social.ensureChat(userId));
      if (!chatId) throw new Error(t('overlaytools.mk_sendFailed'));
      await social.sendMessage(chatId, share.code);
      status.textContent = t('overlaytools.mk_sent', { name: friend?.name || '' });
    } catch (err) {
      status.textContent = err?.message || t('overlaytools.mk_sendFailed');
    }
  }

  function drawShare() {
    const s = share;
    const code = h('textarea', { class: 'input wmk-code', readonly: true, rows: 5, 'aria-label': t('overlaytools.mk_shareTitle') }, s.code);
    code.addEventListener('focus', () => code.select());
    const status = h('div', { class: 'wmk-sub', role: 'status' });
    const friends = h('div', { class: 'wmk-send', hidden: true });
    mount(
      panel,
      header(t('overlaytools.mk_shareTitle'), () => {
        mode = 'list';
        share = null;
        draw();
      }),
      h(
        'div',
        { class: 'wmk-form' },
        h('p', { class: 'wmk-help' }, t('overlaytools.mk_shareHint', { count: s.count })),
        code,
        h('button', { class: 'btn sm primary', type: 'button', onclick: () => copyText(s.code, t('overlaytools.mk_copied')) }, icon('copy'), t('overlaytools.mk_copy')),
        friends,
        s.fitsMessage ? null : h('p', { class: 'wmk-help' }, t('overlaytools.mk_tooLongMessage')),
        status,
      ),
    );
    if (!s.fitsMessage) return;
    import('../../social.js')
      .then(({ social }) => {
        if (destroyed || mode !== 'share' || social.state !== 'ready' || !social.friends.length) return;
        const select = h('select', { class: 'input', 'aria-label': t('overlaytools.mk_pickFriend') }, h('option', { value: '' }, t('overlaytools.mk_pickFriend')), social.friends.map((f) => h('option', { value: f.id }, f.name)));
        const send = h('button', { class: 'btn sm', type: 'button', onclick: () => sendToFriend(select, status) }, icon('send'), t('overlaytools.mk_send'));
        mount(friends, select, send);
        friends.hidden = false;
      })
      .catch(() => {});
  }

  // ---------- Importar ----------
  function startImport() {
    mode = 'import';
    preview = null;
    draw();
  }

  function drawImport() {
    const input = h('textarea', { class: 'input wmk-code', rows: 4, maxlength: MAX_CODE * 2, placeholder: t('overlaytools.mk_importPlaceholder'), 'aria-label': t('overlaytools.mk_importPlaceholder') });
    const out = h('div', { class: 'wmk-preview' });
    const error = h('div', { class: 'field-error', role: 'alert', hidden: true }, icon('alert'), h('span', {}));
    const addBtn = h('button', { class: 'btn sm primary', type: 'button', disabled: true }, icon('download'), t('overlaytools.mk_importDo'));
    const check = async () => {
      preview = null;
      addBtn.disabled = true;
      error.hidden = true;
      mount(out);
      const text = input.value.trim();
      if (!text) return;
      try {
        preview = await api.invoke('mapviewer:markersDecode', text);
        addBtn.disabled = false;
        mount(
          out,
          h('div', { class: 'wmk-sub' }, t('overlaytools.mk_importFound', { count: preview.markers.length })),
          preview.dropped ? h('div', { class: 'wmk-sub' }, t('overlaytools.mk_importDropped', { count: preview.dropped })) : null,
          h(
            'ul',
            { class: 'wmk-preview-list' },
            preview.markers.slice(0, 40).map((m) => h('li', {}, h('span', { class: 'wmk-mark', style: { '--mk': m.color }, 'aria-hidden': 'true' }, markerIcon(m.icon)), h('span', { class: 'ellipsis' }, m.name), h('span', { class: 'wmk-sub' }, `${dimLabel(m.dimension)} · ${coordsText(m)}`))),
          ),
        );
      } catch (err) {
        error.hidden = false;
        error.querySelector('span').textContent = errText(err);
      }
    };
    input.addEventListener('input', check);
    addBtn.addEventListener('click', async () => {
      if (!preview) return;
      try {
        const r = await api.invoke('mapviewer:markersImport', instanceId, world, input.value.trim());
        list = r.markers;
        mode = 'list';
        onChange?.();
        ok(t('overlaytools.mk_imported', { count: r.added }), r.skipped ? t('overlaytools.mk_importSkipped', { count: r.skipped }) : '');
        draw();
      } catch (err) {
        error.hidden = false;
        error.querySelector('span').textContent = errText(err);
      }
    });
    mount(
      panel,
      header(t('overlaytools.mk_importTitle'), () => {
        mode = 'list';
        draw();
      }),
      h('div', { class: 'wmk-form' }, h('p', { class: 'wmk-help' }, t('overlaytools.mk_importHint')), input, error, out),
      h('div', { class: 'wmk-foot' }, h('span', { class: 'spacer' }), addBtn),
    );
    requestAnimationFrame(() => input.focus());
  }

  load();

  return {
    button,
    panel,
    markers: () => list,
    addAt,
    edit,
    reload: load,
    // Escape: primero vuelve a la lista, despues cierra el panel; true si hizo algo (el visor no se cierra)
    handleEscape() {
      if (!open) return false;
      if (mode !== 'list') {
        mode = 'list';
        form = null;
        draw();
      } else setOpen(false);
      button.focus();
      return true;
    },
    destroy() {
      destroyed = true;
      panel.remove();
    },
  };
}
