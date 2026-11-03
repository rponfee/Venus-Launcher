// navcustom (3.1): menu lateral a gusto, packs de iconos y modo mini.
//   - El menu lo dibuja app.js con settings.nav (features/navcustom/logic.js + icons.js); aca vive el editor
//     "Personalizar menu" (features/navcustom/editor.js) que abre el engranaje al pie del menu.
//   - Modo mini (settings.window.mini): boton en la barra de titulo, Ctrl+M y comando de Ctrl+K; la vista
//     compacta esta en features/navcustom/mini.js y el tamano de la ventana lo maneja modules/miniwindow.js.
import { h, icon, mount, ensureCss } from '../ui.js';
import { store } from '../store.js';
import { t, loadNs, onLanguageChange } from '../i18n.js';
import './navcustom/icons.js';

let started = false;

export async function openNavEditor() {
  await loadNs('nav', 'navcustom');
  const m = await import('./navcustom/editor.js');
  return m.openNavEditor();
}

export function isMini() {
  return document.documentElement.hasAttribute('data-mini');
}

export async function setMini(on) {
  await loadNs('navcustom');
  const m = await import('./navcustom/mini.js');
  const result = await m.setMini(on);
  syncButton();
  return result;
}

export const toggleMini = () => setMini(!isMini());

// Boton de la barra de titulo (al lado de los botones de la ventana; index.html no se toca)
function titlebarButton() {
  const bar = document.querySelector('.titlebar');
  const btns = bar?.querySelector('.tb-btns');
  if (!bar || !btns) return;
  if (!bar.querySelector('.nc-tb-btn')) {
    const btn = h('button', { class: 'nc-tb-btn', type: 'button', onclick: () => toggleMini().catch((err) => console.warn('[navcustom]', err)) });
    btn.addEventListener('dblclick', (e) => e.stopPropagation());
    bar.insertBefore(btn, btns);
  }
  syncButton();
}

export function syncButton() {
  const btn = document.querySelector('.nc-tb-btn');
  if (!btn) return;
  const on = isMini();
  btn.classList.toggle('active', on);
  btn.title = t(on ? 'navcustom.miniExit' : 'navcustom.miniEnter');
  btn.setAttribute('aria-label', btn.title);
  mount(btn, icon(on ? 'ncMiniOff' : 'ncMini'));
}

const inField = (el) => el instanceof Element && Boolean(el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'));

function keyboard() {
  window.addEventListener('keydown', (e) => {
    if (!e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.repeat || String(e.key).toLowerCase() !== 'm') return;
    if (inField(e.target) || document.body.classList.contains('onboarding')) return;
    e.preventDefault();
    toggleMini().catch((err) => console.warn('[navcustom]', err));
  });
}

async function commands() {
  try {
    const { registerCommands } = await import('../a11y.js');
    registerCommands(() => [
      {
        id: 'navcustom.mini',
        title: t('navcustom.cmdMini'),
        sub: t('navcustom.cmdMiniSub'),
        group: 'actions',
        icon: 'ncMini',
        keywords: t('navcustom.cmdMiniKeywords'),
        hint: 'Ctrl+M',
        run: () => toggleMini(),
      },
      {
        id: 'navcustom.menu',
        title: t('navcustom.cmdMenu'),
        sub: t('navcustom.cmdMenuSub'),
        group: 'actions',
        icon: 'sliders',
        keywords: t('navcustom.cmdMenuKeywords'),
        run: () => openNavEditor(),
      },
    ]);
  } catch (err) {
    console.warn('[navcustom] paleta', err?.message || err);
  }
}

export async function startup() {
  if (started) return;
  started = true;
  ensureCss('features/navcustom');
  await loadNs('navcustom', 'nav');
  titlebarButton();
  keyboard();
  commands();
  onLanguageChange(async () => {
    await loadNs('navcustom', 'nav');
    syncButton();
    if (isMini()) import('./navcustom/mini.js').then((m) => m.redraw()).catch(() => {});
  });
  // Quedo en mini la ultima vez: app.js ya puso html[data-mini] y modules/miniwindow.js achico la ventana;
  // aca se monta la vista (sin volver a guardar nada).
  if (store.settings?.window?.mini) {
    try {
      const m = await import('./navcustom/mini.js');
      await m.setMini(true, { persist: false });
      syncButton();
    } catch (err) {
      console.warn('[navcustom] mini', err);
    }
  }
}
