// Soundboard de la sala: el pack incluido, hasta 8 sonidos propios (guardados en la PC), volumen y atajos. Los sonidos se
// mezclan en tu microfono (voice.playSound): los escucha toda la sala y no se manda ningun archivo.
import { h, icon, mount, fail, ok, confirmDialog, promptDialog } from '../ui.js';
import { t } from '../i18n.js';
import { voice } from '../voice.js';
import { acceleratorFromEvent, acceleratorParts } from './keys.js';
import { CUSTOM_MAX, CUSTOM_SECONDS, cleanSoundName, customSoundId, needsReencode } from './soundboard.js';

const SOUND_ERRORS = new Set(['too_many', 'too_big', 'bad_type', 'bad_name', 'type', 'decode', 'unsupported']);

// Archivo elegido -> { name, bytes }: lo que pasa de 5 s o 200 KB se recorta y se vuelve a codificar en la PC
async function prepareSound(file) {
  const { decodeAudio, clipBuffer, encodeWebm } = await import('./audio-tools.js');
  const buffer = await decodeAudio(file);
  const blob = needsReencode({ bytes: file.size, duration: buffer.duration }) ? await encodeWebm(clipBuffer(buffer, 0, CUSTOM_SECONDS)) : file;
  return { name: cleanSoundName(file.name) || t('voice.boardCustomName'), bytes: new Uint8Array(await blob.arrayBuffer()), clipped: buffer.duration > CUSTOM_SECONDS };
}

export function soundboardPanel() {
  const lib = voice.customSounds;
  const offs = [];
  const btns = new Map();
  let editing = false;
  let recording = null; // { id, stop() } mientras se graba un atajo
  let adding = false;
  let disposed = false;

  const hint = h('div', { class: 'vc-board-note' }, icon('info'), h('span', {}, t('voice.boardHowHeard')));
  const packGrid = h('div', { class: 'vc-board-grid' });
  const customGrid = h('div', { class: 'vc-board-grid vc-board-custom' });
  const customHead = h('div', { class: 'vc-board-sub' });
  const message = h('div', { class: 'vc-board-msg', role: 'status', hidden: true });
  const fileInput = h('input', { type: 'file', accept: 'audio/*', hidden: true });
  const editBtn = h('button', { class: 'btn ghost sm', type: 'button', 'aria-pressed': 'false' }, icon('keyboard'), t('voice.boardEdit'));
  editBtn.addEventListener('click', () => setEditing(!editing));

  function setEditing(on) {
    recording?.stop();
    editing = on;
    editBtn.setAttribute('aria-pressed', String(on));
    editBtn.classList.toggle('active', on);
    draw();
  }

  function say(text, kind = '') {
    message.hidden = !text;
    message.className = `vc-board-msg ${kind}`;
    message.textContent = text || '';
  }

  function play(id, b) {
    if (voice.playSound(id)) return;
    b.classList.remove('nope');
    void b.offsetWidth;
    b.classList.add('nope');
    const st = voice.state;
    if (st.muted || st.deafened) say(t('voice.boardMuted'), 'warn');
  }

  // Graba un atajo global para un sonido (con modificadores, o F1 a F24). Escape cancela y Supr lo saca.
  function recordShortcut(id, b) {
    recording?.stop();
    voice.capturingKeys = true;
    say(t('voice.boardShortcutPress'));
    b.classList.add('recording');
    const onKey = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') return stop();
      if (e.key === 'Delete' || e.key === 'Backspace') {
        stop();
        return saveShortcut(id, '');
      }
      const r = acceleratorFromEvent(e);
      if (!r) return;
      if (r.error) return say(t(r.error === 'needsModifier' ? 'voice.shortcutNeedsModifier' : 'voice.shortcutUnsupported'), 'warn');
      stop();
      saveShortcut(id, r.accel);
    };
    const onBlur = () => stop();
    function stop() {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onBlur);
      voice.capturingKeys = false;
      b.classList.remove('recording');
      recording = null;
      say('');
    }
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onBlur);
    recording = { id, stop };
  }

  async function saveShortcut(id, accel) {
    try {
      await lib.setShortcut(id, accel);
      draw();
      if (accel) say(t('voice.boardShortcutSaved', { keys: acceleratorParts(accel).join(' + ') }), 'good');
    } catch (err) {
      console.warn('[voice] atajo del soundboard', err?.code || err?.message);
      say(t(err?.code === 'in_use' ? 'voice.boardShortcutInUse' : 'voice.shortcutUnsupported'), 'warn');
    }
  }

  function shortcutChip(id) {
    const parts = acceleratorParts(lib.shortcuts[id]);
    return parts.length ? h('kbd', { class: 'kbd vc-sfx-key', title: t('voice.boardShortcutOf', { keys: parts.join(' + ') }) }, parts.join('+')) : null;
  }

  function soundBtn(id, iconName, label) {
    const b = h('button', { class: ['vc-sfx', editing && 'editing'], type: 'button', title: editing ? t('voice.boardShortcutFor', { name: label }) : label }, icon(iconName), h('span', {}, label), shortcutChip(id));
    b.addEventListener('click', () => (editing ? recordShortcut(id, b) : play(id, b)));
    btns.set(id, b);
    return b;
  }

  async function renameCustom(item) {
    const name = await promptDialog(t('voice.boardRename'), t('voice.boardRenameLabel'), { value: item.name, okText: t('voice.save') });
    if (!name) return;
    try {
      await lib.rename(item.id, name);
      draw();
    } catch (err) {
      fail(t('voice.saveFailed'), err?.message);
    }
  }

  async function removeCustom(item) {
    if (!(await confirmDialog(t('voice.boardRemove'), t('voice.boardRemoveText', { name: item.name }), { okText: t('voice.boardRemove'), danger: true }))) return;
    try {
      await lib.remove(item.id);
      draw();
    } catch (err) {
      fail(t('voice.boardFailed'), err?.message);
    }
  }

  function customTile(item) {
    const id = customSoundId(item.id);
    const b = soundBtn(id, 'audioLines', item.name);
    b.classList.add('priv');
    if (!editing) return b;
    return h(
      'div',
      { class: 'vc-sfx-wrap' },
      b,
      h('button', { class: 'icon-btn sm', type: 'button', title: t('voice.boardRename'), 'aria-label': t('voice.boardRenameNamed', { name: item.name }), onclick: () => renameCustom(item) }, icon('edit')),
      h('button', { class: 'icon-btn sm danger', type: 'button', title: t('voice.boardRemove'), 'aria-label': t('voice.boardRemoveNamed', { name: item.name }), onclick: () => removeCustom(item) }, icon('trash')),
    );
  }

  function draw() {
    if (disposed) return;
    btns.clear();
    mount(packGrid, voice.SOUNDS.map((s) => soundBtn(s.id, s.icon, t(`voice.sfx_${s.id}`))));
    const full = lib.items.length >= CUSTOM_MAX;
    const addBtn = h('button', { class: 'btn tonal sm', type: 'button', disabled: full || adding, onclick: () => fileInput.click() }, icon('plus'), t(adding ? 'voice.boardAdding' : 'voice.boardAdd'));
    mount(customHead, h('span', { class: 'vc-board-subtitle' }, t('voice.boardCustom', { count: lib.items.length, max: CUSTOM_MAX })), h('span', { class: 'spacer' }), addBtn);
    mount(customGrid, lib.items.map(customTile));
    customGrid.hidden = !lib.items.length;
  }

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    adding = true;
    say(t('voice.boardPreparing'));
    draw();
    try {
      const sound = await prepareSound(file);
      await lib.add(sound);
      say(sound.clipped ? t('voice.boardClipped', { seconds: CUSTOM_SECONDS }) : '', 'good');
      ok(t('voice.boardAdded'), sound.name);
    } catch (err) {
      const code = err?.code;
      if (!SOUND_ERRORS.has(code)) console.warn('[voice] sonido propio', code, err?.message);
      say(t(SOUND_ERRORS.has(code) ? `voice.boardErr_${code}` : 'voice.boardFailed', { max: CUSTOM_MAX }), 'warn');
    } finally {
      adding = false;
      draw();
    }
  });

  // Volumen propio del soundboard: lo que suena en tu microfono y lo que escuchas vos
  const st = voice.settings;
  const volVal = h('span', { class: 'vc-pop-val' }, `${Math.round((st.soundboardVolume ?? 0.7) * 100)}%`);
  const vol = h('input', { type: 'range', class: 'range', min: 0, max: 100, step: 5, value: Math.round((st.soundboardVolume ?? 0.7) * 100), 'aria-label': t('voice.soundboardVolume') });
  vol.addEventListener('input', () => {
    volVal.textContent = `${vol.value}%`;
    vol.setAttribute('aria-valuetext', `${vol.value}%`);
  });
  vol.addEventListener('change', () => voice.saveSettings({ soundboardVolume: Number(vol.value) / 100 }));

  const el = h(
    'div',
    { class: 'vc-board', role: 'region', 'aria-label': t('voice.soundboard'), hidden: true },
    h('div', { class: 'vc-board-head' }, h('span', { class: 'vc-board-title' }, icon('audioLines'), t('voice.soundboard')), h('span', { class: 'vc-board-hint' }, t('voice.boardLimit')), h('span', { class: 'spacer' }), editBtn),
    packGrid,
    customHead,
    customGrid,
    fileInput,
    message,
    h('div', { class: 'vc-board-foot' }, h('div', { class: 'vc-board-vol' }, icon('volume'), vol, volVal)),
    hint,
  );

  function flash(id) {
    const b = btns.get(id);
    if (!b) return;
    b.classList.remove('flash');
    void b.offsetWidth;
    b.classList.add('flash');
  }

  // Sonó (con un clic o con un atajo): la barra que muestra cuanto falta para poder tocar otro
  offs.push(
    voice.on('soundPlayed', ({ id }) => {
      flash(id);
      say('');
      for (const g of [packGrid, customGrid]) {
        g.classList.remove('cooling');
        void g.offsetWidth;
        g.classList.add('cooling');
      }
    }),
  );
  for (const g of [packGrid, customGrid]) {
    g.addEventListener('animationend', (e) => {
      if (e.animationName === 'vc-cool') g.classList.remove('cooling');
    });
  }

  draw();
  lib
    .load()
    .then(draw)
    .catch((err) => console.warn('[voice] sonidos propios', err?.message || err));

  return {
    el,
    flash,
    show(on) {
      el.hidden = !on;
      if (!on) {
        recording?.stop();
        if (editing) setEditing(false);
      }
      // Al abrirlo con el teclado, el foco entra al primer sonido
      if (on && el.closest('.vc-controls')?.contains(document.activeElement)) packGrid.querySelector('button')?.focus({ preventScroll: true });
    },
    destroy() {
      disposed = true;
      recording?.stop();
      offs.forEach((off) => off());
    },
  };
}
