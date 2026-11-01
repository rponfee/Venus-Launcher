// Piezas de la pagina de skins: iconos propios, miniaturas, cabeza de la cuenta, dialogo de confirmacion
// con copia de seguridad, lectura de archivos soltados y mensajes de error por codigo.
import { h, icon, modal, registerIcons } from '../../ui.js';
import { t } from '../../i18n.js';
import { drawFlat, drawCapeFront } from './texture.js';

registerIcons({
  skRotateCcw: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  skRotateCw: '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>',
  skShirt: '<path d="M20.38 3.46 16 2a4 4 0 0 1-8 0L3.62 3.46a2 2 0 0 0-1.34 2.23l.58 3.47a1 1 0 0 0 .99.84H6v10c0 1.1.9 2 2 2h8a2 2 0 0 0 2-2V10h2.15a1 1 0 0 0 .99-.84l.58-3.47a2 2 0 0 0-1.34-2.23z"/>',
  skCape: '<path d="M6 3h12l1 4-2 14-5-3-5 3L5 7z"/><path d="M9 3v3a3 3 0 0 0 6 0V3"/>',
  skNoCape: '<path d="M8.5 3H18l1 4-1.2 8.5"/><path d="M16.6 20.3 12 18l-5 3L5 7l.6-2.3"/><path d="m2 2 20 20"/>',
});

export const variantLabel = (v) => t(v === 'slim' ? 'skins.variantSlim' : 'skins.variantClassic');

// Miniatura plana (frente) de una skin ya normalizada.
export function skinThumb(skin, variant, cls = 'sk-thumb') {
  const c = h('canvas', { class: cls, 'aria-hidden': 'true' });
  if (skin) drawFlat(c, skin, variant, { side: 'front', scale: 1 });
  return c;
}

// Cara de la cuenta (cabeza + sombrero) dibujada desde su propia skin: sin pedirle nada a nadie.
export function headThumb(skin) {
  const c = h('canvas', { class: 'sk-head', width: 8, height: 8, 'aria-hidden': 'true' });
  if (!skin) return c;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(skin, 8, 8, 8, 8, 0, 0, 8, 8);
  ctx.drawImage(skin, 40, 8, 8, 8, 0, 0, 8, 8);
  return c;
}

export function capeThumb(cape) {
  const c = h('canvas', { class: 'sk-cape-canvas', 'aria-hidden': 'true' });
  if (cape) drawCapeFront(c, cape, 1);
  return c;
}

// Confirmacion con la opcion de guardar antes la skin actual. Resuelve { backup } o null si se cancela.
export function confirmChange({ title, text, okText, offerBackup = false, note = null }) {
  return new Promise((resolve) => {
    let done = false;
    let backup = offerBackup;
    const finish = (v) => {
      if (done) return;
      done = true;
      m.close();
      resolve(v);
    };
    const okBtn = h('button', { class: 'btn primary', type: 'button', onclick: () => finish({ backup: offerBackup && backup }) }, okText);
    const m = modal({
      title,
      size: 'sm',
      body: h(
        'div',
        { class: 'sk-confirm' },
        h('p', { class: 'text-2' }, text),
        offerBackup
          ? h(
              'label',
              { class: 'sk-check' },
              h('input', { type: 'checkbox', checked: true, onchange: (e) => (backup = e.currentTarget.checked) }),
              h('span', {}, t('skins.backupFirst')),
            )
          : null,
        note ? h('p', { class: 'sk-note' }, icon('info'), h('span', {}, note)) : null,
      ),
      footer: [h('button', { class: 'btn ghost', type: 'button', onclick: () => finish(null) }, t('common.cancel')), okBtn],
      onClose: () => finish(null),
    });
  });
}

// Archivos soltados: [{ name, bytes }] (como mucho 20). Los de mas de 64 KB no se leen: van marcados con
// tooBig y el proceso principal responde el error. Los que no se pueden leer (una carpeta, un archivo que
// ya no esta) van con unreadable. Todo se vuelve a revisar alla.
export async function readDropped(fileList) {
  const files = [...(fileList || [])].slice(0, 20);
  const out = [];
  for (const f of files) {
    if (f.size > 64 * 1024) {
      out.push({ name: f.name, tooBig: true });
      continue;
    }
    try {
      out.push({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
    } catch {
      out.push({ name: f.name, unreadable: true });
    }
  }
  return out;
}

// Tipo de problema de la cuenta segun el codigo del error (los textos ya vienen traducidos).
export function problemOf(err) {
  const code = String(err?.code || '');
  if (code === 'skins:sessionExpired' || code === 'skins:accountError') return 'login';
  if (code === 'skins:launcherOffline') return 'offlineMode';
  if (code === 'skins:noProfile' || code === 'skins:forbidden') return 'noGame';
  if (code === 'skins:offline') return 'offlineAccount';
  if (code === 'skins:accountChanged' || code === 'skins:noAccount') return 'changed';
  return 'error';
}
