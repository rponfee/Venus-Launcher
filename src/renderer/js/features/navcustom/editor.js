// Editor "Personalizar menu" (lo abre el engranaje al pie del menu o el comando de Ctrl+K): ordena cada seccion
// con flechas o arrastrando, fija entradas arriba de todo, oculta las que no se usan y elige el pack de iconos.
// Los cambios se aplican en vivo: se guardan en settings.nav con un retraso de 300 ms y app.js rearma el menu
// cuando cambian los ajustes. `home` nunca se oculta y Ajustes vive al pie de la barra, fuera del menu.
import { h, icon, mount, modal, fail, debounce } from '../../ui.js';
import { store } from '../../store.js';
import { t } from '../../i18n.js';
import { navEntries } from '../../app.js';
import { ICON_PACKS, normalizeNav, sections, sortByOrder, orderFromSections, moveInSection, dropInSection, toggleIn, canHide } from './logic.js';
import { navIconName } from './icons.js';

let current = null;

// Mantiene el foco del teclado al redibujar (los botones llevan data-fk)
function keepFocus(container, fn) {
  const active = document.activeElement;
  const key = active && container.contains(active) ? active.dataset?.fk : null;
  fn();
  if (key) container.querySelector(`[data-fk="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
}

export function openNavEditor() {
  if (current) {
    current.focus();
    return current;
  }
  const entries = navEntries();
  const ids = entries.filter((e) => e.id).map((e) => e.id);
  const byId = new Map(entries.filter((e) => e.id).map((e) => [e.id, e]));
  let prefs = normalizeNav(store.settings?.nav, ids);
  // Listas tal como se editan: los fijados primero (en su orden) y despues cada seccion del menu, con las
  // entradas ocultas incluidas (atenuadas) para poder volver a mostrarlas.
  let lists = [];
  let drag = null; // { id, list } mientras se arrastra una fila

  const rebuild = () => {
    const pinnedSet = new Set(prefs.pinned);
    lists = [
      { key: 'pinned', group: 'pinned', items: prefs.pinned.map((id) => byId.get(id)).filter(Boolean) },
      ...sections(entries).map((s) => ({ key: s.group || 'other', group: s.group, items: sortByOrder(s.items.filter((e) => !pinnedSet.has(e.id)), prefs.order) })),
    ];
  };
  const save = debounce(() => {
    store.setSettings({ nav: prefs }).catch((err) => fail(t('nav.menuSaveFailed'), err));
  }, 300);
  // prefs a partir de las listas. El orden global empieza por los fijados: si uno se suelta, vuelve arriba de su seccion.
  const commit = () => {
    const pinned = lists.find((l) => l.key === 'pinned').items.map((e) => e.id);
    prefs = { ...prefs, pinned, order: [...pinned, ...orderFromSections(lists.filter((l) => l.key !== 'pinned'))] };
    save();
    draw();
  };
  const move = (id, dir) => {
    lists = moveInSection(lists, id, dir);
    commit();
  };
  const togglePin = (id) => {
    prefs = { ...prefs, pinned: toggleIn(prefs.pinned, id) };
    rebuild();
    commit();
  };
  const toggleHidden = (id) => {
    if (!canHide(id)) return;
    prefs = { ...prefs, hidden: toggleIn(prefs.hidden, id) };
    save();
    draw();
  };
  const setPack = (pack) => {
    if (!ICON_PACKS.includes(pack)) return;
    prefs = { ...prefs, iconPack: pack };
    save();
    draw();
  };
  const reset = () => {
    prefs = normalizeNav({}, ids);
    rebuild();
    save();
    draw();
  };
  const clearMarks = () => secsEl.querySelectorAll('.drop-before, .drop-after, .is-dragging').forEach((el) => el.classList.remove('drop-before', 'drop-after', 'is-dragging'));

  function actionBtn(name, title, onclick, { on = false, disabled = false, fk } = {}) {
    return h(
      'button',
      { class: ['icon-btn', 'sm', on && 'on'], type: 'button', title, 'aria-label': title, 'aria-pressed': onclick ? String(on) : null, disabled, dataset: { fk }, onclick: onclick || undefined },
      icon(name),
    );
  }

  function row(list, e) {
    const hidden = prefs.hidden.includes(e.id);
    const pinned = list.key === 'pinned';
    const idx = list.items.indexOf(e);
    const label = e.label || e.id;
    const el = h(
      'div',
      { class: ['nc-row', hidden && 'is-hidden'], role: 'listitem', draggable: 'true', dataset: { id: e.id }, title: t('nav.dragItem', { item: label }) },
      h('span', { class: 'nc-grip', 'aria-hidden': 'true' }, icon('ncGrip')),
      h('span', { class: 'nc-ic', 'aria-hidden': 'true' }, e.img ? h('img', { src: e.img, alt: '' }) : icon(navIconName(e.icon || 'puzzle', prefs.iconPack))),
      h('span', { class: 'nc-label' }, h('span', { class: 'ellipsis' }, label), hidden ? h('span', { class: 'nc-tag' }, t('nav.hiddenTag')) : null),
      h(
        'span',
        { class: 'nc-acts' },
        actionBtn(pinned ? 'ncPinOff' : 'ncPin', t(pinned ? 'nav.unpinItem' : 'nav.pinItem', { item: label }), () => togglePin(e.id), { on: pinned, fk: `pin-${e.id}` }),
        canHide(e.id)
          ? actionBtn(hidden ? 'eyeOff' : 'eye', t(hidden ? 'nav.showItem' : 'nav.hideItem', { item: label }), () => toggleHidden(e.id), { on: hidden, fk: `eye-${e.id}` })
          : actionBtn('eye', t('nav.alwaysShown'), null, { disabled: true, fk: `eye-${e.id}` }),
        actionBtn('ncUp', t('nav.moveItemUp', { item: label }), () => move(e.id, -1), { disabled: idx <= 0, fk: `up-${e.id}` }),
        actionBtn('ncDown', t('nav.moveItemDown', { item: label }), () => move(e.id, 1), { disabled: idx >= list.items.length - 1, fk: `down-${e.id}` }),
      ),
    );
    el.addEventListener('dragstart', (ev) => {
      drag = { id: e.id, list: list.key };
      el.classList.add('is-dragging');
      if (ev.dataTransfer) {
        ev.dataTransfer.effectAllowed = 'move';
        try {
          ev.dataTransfer.setData('text/plain', e.id);
        } catch {
          /* sin datos: alcanza con `drag` */
        }
      }
    });
    el.addEventListener('dragend', () => {
      drag = null;
      clearMarks();
    });
    el.addEventListener('dragover', (ev) => {
      if (!drag || drag.list !== list.key || drag.id === e.id) return;
      ev.preventDefault();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
      const r = el.getBoundingClientRect();
      const before = ev.clientY < r.top + r.height / 2;
      el.classList.toggle('drop-before', before);
      el.classList.toggle('drop-after', !before);
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-before', 'drop-after'));
    el.addEventListener('drop', (ev) => {
      if (!drag || drag.list !== list.key || drag.id === e.id) return;
      ev.preventDefault();
      const before = el.classList.contains('drop-before');
      const id = drag.id;
      drag = null;
      lists = dropInSection(lists, id, e.id, before);
      commit();
    });
    return el;
  }

  const packsEl = h('div', { class: 'nc-ed-packs' });
  const secsEl = h('div', { class: 'nc-ed-secs' });
  const body = h('div', { class: 'nc-ed' }, h('p', { class: 'nc-ed-text' }, t('nav.customizeMenuText')), packsEl, secsEl);
  let box = body;

  function draw() {
    keepFocus(box, () => {
      mount(
        packsEl,
        h('span', { class: 'nc-ed-packs-label' }, t('nav.iconPack')),
        h(
          'div',
          { class: 'segmented nc-ed-seg', role: 'radiogroup', 'aria-label': t('nav.iconPack') },
          ICON_PACKS.map((p) =>
            h('button', { type: 'button', class: p === prefs.iconPack && 'active', role: 'radio', 'aria-checked': String(p === prefs.iconPack), dataset: { fk: `pack-${p}` }, onclick: () => setPack(p) }, icon(navIconName('home', p)), t(`nav.iconPack_${p}`)),
          ),
        ),
      );
      mount(
        secsEl,
        lists
          .filter((l) => l.key !== 'pinned' || l.items.length)
          .map((l) =>
            h(
              'div',
              { class: ['nc-sec', `nc-sec-${l.key}`] },
              l.group ? h('div', { class: 'nc-sec-title' }, t(`nav.group_${l.group}`)) : null,
              h('div', { class: 'nc-list', role: 'list' }, l.items.map((e) => row(l, e))),
            ),
          ),
      );
    });
  }

  const m = modal({
    title: t('nav.customizeMenu'),
    icon: 'sliders',
    body,
    footer: [h('button', { class: 'btn ghost', onclick: reset }, icon('undo'), t('nav.resetMenu')), h('button', { class: 'btn primary', onclick: () => m.close() }, t('nav.done'))],
    onClose: () => {
      current = null;
    },
  });
  box = m.el;
  rebuild();
  draw();
  current = { close: m.close, focus: () => m.el.focus() };
  return current;
}
