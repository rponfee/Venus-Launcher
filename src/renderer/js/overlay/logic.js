// Logica sin DOM ni imports de features/overlay.js (la prueban src/main/modules/overlay/test/logic.test.js):
// limite de frecuencia, foto del Voice Chat para el overlay, deteccion de cambios y atajos de teclado.

// Junta pedidos y llama a flush como mucho una vez cada `interval` ms (la voz: 200 ms, unas 5 veces por segundo).
// Un pedido suelto se atiende en la proxima vuelta del bucle; los que llegan mientras espera se juntan en uno.
export function createLimiter({ interval = 200, flush, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout }) {
  let last = -Infinity;
  let timer = null;
  const run = () => {
    timer = null;
    last = now();
    flush();
  };
  return {
    mark() {
      if (timer !== null) return;
      timer = setTimer(run, Math.max(0, last + interval - now()));
    },
    cancel() {
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
    get waiting() {
      return timer !== null;
    },
  };
}

// Recuerda lo ultimo que se mando y dice si algo cambio (para no repetir eventos iguales).
export function createChangeGate() {
  let last = null;
  return {
    changed(value) {
      const key = JSON.stringify(value);
      if (key === last) return false;
      last = key;
      return true;
    },
    reset() {
      last = null;
    },
  };
}

// Foto del Voice Chat con la forma del contrato del overlay. room/members/state son los getters de voice.js
// (members ya trae speaking en vivo); avatarUrl convierte el avatar de la sala (uuid o nombre) en una URL.
export function voiceSnapshot({ room, members, state }, { avatarUrl = () => null, max = 16 } = {}) {
  const self = { muted: Boolean(state?.muted), deafened: Boolean(state?.deafened) };
  if (!room) return { kind: 'voice', room: null, self, members: [] };
  return {
    kind: 'voice',
    room: { name: String(room.name || '').slice(0, 64), code: String(room.code || '').slice(0, 32) },
    self,
    members: pickVoiceRows(Array.isArray(members) ? members : [], max).map((m) => {
      const muted = Boolean(m?.muted);
      return {
        id: String(m?.userId ?? m?.id ?? ''),
        name: String(m?.name || '?').slice(0, 48),
        avatar: avatarUrl(m?.avatar) || null,
        speaking: Boolean(m?.speaking) && !muted,
        muted,
        deafened: Boolean(m?.deafened),
        self: Boolean(m?.self),
      };
    }),
  };
}

// Tecla apretada -> atajo con el formato de Electron ("Alt+Shift+O"). null si es solo un modificador, una tecla
// que no sirve o si no tiene modificador (salvo F13 a F24: las demas teclas solas se las robaria al juego).
const NAMED = {
  Space: 'Space', Insert: 'Insert', Delete: 'Delete', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Backquote: '`', Minus: '-', Equal: '=',
  BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\',
};
export function accelFromKey(e) {
  const code = String(e?.code || '');
  let key = null;
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) key = code;
  else if (/^Numpad[0-9]$/.test(code)) key = `num${code.slice(6)}`;
  else if (NAMED[code]) key = NAMED[code];
  if (!key) return null;
  const mods = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Super');
  if (!mods.length && !/^F(1[3-9]|2[0-4])$/.test(key)) return null;
  return [...mods, key].join('+');
}

// Partes de un atajo para mostrarlas como teclas ("Alt+Shift+O" -> ['Alt', 'Shift', 'O']).
export function accelParts(accel) {
  return String(accel || '')
    .split('+')
    .filter(Boolean)
    .map((p) => (p === 'CommandOrControl' || p === 'CmdOrCtrl' || p === 'Control' ? 'Ctrl' : p === 'Super' || p === 'Meta' ? 'Win' : p));
}

// Cola de tareas una detras de otra que nunca se rompe: si una falla, se avisa y la siguiente corre igual. En la pagina del
// overlay un error al dibujar un layout no puede dejar sin atender todo lo que llegue despues.
export function createSerial(onError = () => {}) {
  let tail = Promise.resolve();
  return (fn) => {
    tail = tail
      .then(fn)
      .catch((err) => {
        try {
          onError(err);
        } catch {
          /* el aviso tambien fallo: no se hace nada mas */
        }
      });
    return tail;
  };
}

// Que integrantes de la sala se dibujan cuando no entran todos: primero quien habla, despues uno mismo y despues el resto
// (con el orden de la sala). Si no, alguien que habla puede quedar escondido en "+4 personas mas".
export function pickVoiceRows(members, max) {
  const list = Array.isArray(members) ? members : [];
  if (list.length <= max) return list;
  const rank = (m) => (m?.speaking ? 0 : m?.self ? 1 : 2);
  const chosen = new Set(
    list
      .map((m, i) => [rank(m), i])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1])
      .slice(0, max)
      .map((x) => x[1]),
  );
  return list.filter((m, i) => chosen.has(i));
}
