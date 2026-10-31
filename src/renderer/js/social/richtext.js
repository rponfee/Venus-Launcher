// Texto de los mensajes: links que se abren en el navegador, emojis grandes y el selector de emojis.
// Nunca se usa innerHTML con texto de otros usuarios: todo se arma con nodos de texto.
import { h } from '../ui.js';
import { api } from '../store.js';

export const EMOJIS = [
  '😀', '😄', '😁', '😂', '🤣', '😊', '😉', '😍', '😘', '😎', '🤩', '🥳', '😅', '😇', '🙂', '🙃',
  '😐', '🤔', '🤨', '😴', '😮', '😱', '😢', '😭', '😡', '🤯', '🥺', '😏', '🤝', '👍', '👎', '👏',
  '🙌', '🙏', '💪', '👋', '✌️', '🤞', '❤️', '🧡', '💛', '💚', '💙', '💜', '🔥', '✨', '⭐', '🎉',
  '💯', '✅', '❌', '⚔️', '🛡️', '⛏️', '🪓', '🏹', '💎', '🧱', '🌲', '🐷', '🐺', '🐔', '🧟', '💀',
  '👾', '🎮', '🕹️', '🏠', '🌋', '🌙', '☀️', '🍰', '🍕', '🍪', '🎵', '🚀', '📦', '🗺️', '🏆', '💤',
];

export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥'];

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const TRAILING = /[.,;:!?'"»)\]}]$/;
const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})?(?:‍\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})?)*\s*){1,3}$/u;

// true si el mensaje son solo 1 a 3 emojis (se muestran grandes, sin globo).
export function isJumbo(text) {
  const s = String(text || '').trim();
  return s.length > 0 && s.length <= 40 && EMOJI_ONLY.test(s);
}

function trimUrl(url) {
  let out = url;
  while (TRAILING.test(out)) {
    // un ")" final es parte del link si abre un "(" adentro (p. ej. wikipedia)
    if (out.endsWith(')') && (out.match(/\(/g) || []).length >= (out.match(/\)/g) || []).length) break;
    out = out.slice(0, -1);
  }
  return out;
}

export function linkEl(url) {
  return h(
    'a',
    {
      class: 'msg-link',
      href: url,
      title: url,
      rel: 'noreferrer noopener',
      onclick: (e) => {
        e.preventDefault();
        e.stopPropagation();
        api.app.openExternal(url).catch(() => {});
      },
    },
    url,
  );
}

// Nodos del cuerpo de un mensaje (texto plano + links http/https).
export function renderBody(text) {
  const s = String(text || '');
  const out = [];
  let last = 0;
  for (const m of s.matchAll(URL_RE)) {
    const url = trimUrl(m[0]);
    if (!url || url.length < 10) continue;
    if (m.index > last) out.push(s.slice(last, m.index));
    out.push(linkEl(url));
    last = m.index + url.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

// Inserta texto en un <textarea> donde esta el cursor.
export function insertAtCursor(input, text) {
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  input.value = input.value.slice(0, start) + text + input.value.slice(end);
  const pos = start + text.length;
  input.setSelectionRange(pos, pos);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.focus();
}

/**
 * Selector de emojis flotante junto a un boton.
 * openEmojiPicker(anchor, onPick, { label }) -> { close }
 */
let openPicker = null;
export function openEmojiPicker(anchor, onPick, { label = '', set = EMOJIS } = {}) {
  if (openPicker) {
    const same = openPicker.anchor === anchor;
    openPicker.close();
    if (same) return null;
  }
  const grid = h(
    'div',
    { class: 'msg-emoji-grid', role: 'listbox', 'aria-label': label },
    set.map((e) =>
      h(
        'button',
        {
          class: 'msg-emoji',
          type: 'button',
          role: 'option',
          title: e,
          'aria-label': e,
          onclick: (ev) => {
            ev.stopPropagation();
            onPick(e);
            close();
          },
        },
        e,
      ),
    ),
  );
  const pop = h('div', { class: 'msg-emoji-pop', role: 'dialog', 'aria-label': label }, grid);
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  const pr = pop.getBoundingClientRect();
  const left = Math.max(8, Math.min(window.innerWidth - pr.width - 8, r.left + r.width / 2 - pr.width / 2));
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
    } else if (['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(e.key)) {
      const items = [...grid.children];
      const i = items.indexOf(document.activeElement);
      const cols = Math.max(1, Math.round(grid.clientWidth / (items[0]?.offsetWidth || 32)));
      const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols }[e.key];
      const next = items[Math.max(0, Math.min(items.length - 1, (i < 0 ? 0 : i + step)))];
      next?.focus();
      e.preventDefault();
    }
  };
  function close() {
    pop.remove();
    document.removeEventListener('mousedown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', close);
    if (openPicker?.pop === pop) openPicker = null;
  }
  setTimeout(() => {
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('resize', close);
  }, 0);
  document.addEventListener('keydown', onKey, true);
  grid.firstChild?.focus();
  openPicker = { pop, anchor, close };
  return openPicker;
}

export function closeEmojiPicker() {
  openPicker?.close();
}
