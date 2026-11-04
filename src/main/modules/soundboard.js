'use strict';
// Soundboard del Voice Chat: los sonidos propios (guardados en la PC, no se mandan a nadie) y sus atajos globales.
// Canales: soundboard:list -> { items: [{ id, name, bytes, mime, addedAt }], shortcuts: { <sonido>: acelerador } },
//          :read(id) -> bytes, :add({ name, bytes }), :rename(id, nombre), :remove(id), :setShortcut(sonido, acelerador),
//          :arm(bool) (los atajos se registran solo con una sala abierta). Evento: soundboard:trigger (sonido).
// <sonido> es el id de un sonido del pack ('ding') o 'custom:<id>'. Errores con err.code (soundboard/store.js e in_use).
const path = require('path');
const paths = require('../core/paths');
const { SoundStore } = require('./soundboard/store');

function register({ handle, send, onQuit }) {
  const store = new SoundStore(path.join(paths.root(), 'soundboard'));
  const registered = new Map(); // acelerador -> sonido
  let armed = false;
  // Se pide recien al usarlo: la lógica de arriba se puede probar sin Electron
  const shortcuts = () => require('electron').globalShortcut;

  function disarm() {
    for (const accel of registered.keys()) {
      try {
        shortcuts().unregister(accel);
      } catch {
        /* ya no estaba registrado */
      }
    }
    registered.clear();
  }

  async function arm() {
    disarm();
    const { shortcuts: map } = await store.list();
    for (const [soundId, accel] of Object.entries(map)) {
      try {
        // Un atajo que ya usa otra cosa (el de silenciar, otra aplicacion) no se pisa
        if (!shortcuts().isRegistered(accel) && shortcuts().register(accel, () => send('soundboard:trigger', soundId))) registered.set(accel, soundId);
      } catch (err) {
        console.warn('[soundboard] atajo inválido:', err?.message || err);
      }
    }
  }

  handle('soundboard:list', () => store.list());
  handle('soundboard:read', (id) => store.read(id));
  handle('soundboard:add', (p) => store.add(p && typeof p === 'object' ? p : {}));
  handle('soundboard:rename', (id, name) => store.rename(id, name));
  handle('soundboard:remove', async (id) => {
    const data = await store.remove(id);
    if (armed) await arm();
    return data;
  });

  // Prueba el atajo antes de guardarlo: si lo usa otra aplicacion o el launcher, avisa con err.code = 'in_use'
  handle('soundboard:setShortcut', async (soundId, accel) => {
    const value = typeof accel === 'string' ? accel.trim() : '';
    if (value && registered.get(value) !== soundId) {
      const taken = () => Object.assign(new Error('in_use'), { code: 'in_use' });
      let free = false;
      try {
        free = !shortcuts().isRegistered(value) && shortcuts().register(value, () => {});
      } catch {
        throw Object.assign(new Error('bad_shortcut'), { code: 'bad_shortcut' });
      }
      if (!free) throw taken();
      shortcuts().unregister(value);
    }
    const data = await store.setShortcut(soundId, value);
    if (armed) await arm();
    return data;
  });

  handle('soundboard:arm', async (on) => {
    armed = Boolean(on);
    if (armed) await arm();
    else disarm();
    return armed;
  });

  onQuit(() => disarm());
}

module.exports = { register };
