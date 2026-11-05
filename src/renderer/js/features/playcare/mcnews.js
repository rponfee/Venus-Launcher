// Aviso de version nueva de Minecraft (3.1): el proceso principal (modules/mcnews.js) manda mcnews:new
// ({ id, type: 'release' | 'snapshot', releaseTime }) cuando el manifiesto trae algo que no se vio. Aca se muestra un
// toast con "Crear instancia" (va a #/versions/new/vanilla/<id>) y "Ya vi" (mcnews:seen).
import { h, icon, toast } from '../../ui.js';
import { api } from '../../store.js';
import { t, loadNs } from '../../i18n.js';
import { navigate } from '../../app.js';

const T = (key, vars) => t(`playcare.${key}`, vars);
const TOAST_MS = 25000;
const shown = new Set();
let started = false;

function markSeen(v) {
  api.invoke('mcnews:seen', { id: v.id, type: v.type }).catch(() => {});
}

export function showNewVersion(v) {
  const id = typeof v?.id === 'string' ? v.id.slice(0, 64) : '';
  if (!id || shown.has(id)) return;
  shown.add(id);
  const type = v.type === 'snapshot' ? 'snapshot' : 'release';
  const create = h(
    'button',
    {
      type: 'button',
      class: 'btn sm primary',
      onclick: (e) => {
        markSeen({ id, type });
        e.currentTarget.closest('.toast')?.remove();
        navigate(`versions/new/vanilla/${encodeURIComponent(id)}`);
      },
    },
    icon('plus'),
    T('newVersionCreate'),
  );
  const seen = h(
    'button',
    {
      type: 'button',
      class: 'btn sm ghost',
      onclick: (e) => {
        markSeen({ id, type });
        e.currentTarget.closest('.toast')?.remove();
      },
    },
    icon('check'),
    T('newVersionSeen'),
  );
  toast('info', T('newVersionTitle', { id }), h('div', { class: 'pc-toast' }, h('div', {}, T(type === 'snapshot' ? 'newVersionSnapshot' : 'newVersionRelease', { id })), h('div', { class: 'row wrap pc-toast-actions' }, create, seen)), TOAST_MS);
}

export function startup() {
  if (started) return;
  started = true;
  api.on('mcnews:new', (v) => loadNs('playcare').then(() => showNewVersion(v)).catch((err) => console.warn('[playcare] version nueva', err)));
}
