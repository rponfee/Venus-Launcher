// Soundboard de la sala: lo que no depende de la interfaz. Los sonidos (el pack sintetizado de voice/sfx.js y hasta 8
// propios guardados en la PC) se mezclan en el microfono saliente (voice/mic.js: soundInput), asi los escucha toda la sala
// sin mandar archivos. Tope: uno cada 2 s.
export const SOUND_GAP_MS = 2000;
export const CUSTOM_MAX = 8;
export const CUSTOM_SECONDS = 5;
export const CUSTOM_BYTES = 200 * 1024;
export const CUSTOM_NAME_MAX = 24;

// Los propios se identifican con este prefijo: "custom:<id del archivo>"
const CUSTOM_PREFIX = 'custom:';
export const customSoundId = (id) => `${CUSTOM_PREFIX}${id}`;
export const isCustomSound = (id) => typeof id === 'string' && id.startsWith(CUSTOM_PREFIX) && id.length > CUSTOM_PREFIX.length;
export const customFileId = (id) => (isCustomSound(id) ? id.slice(CUSTOM_PREFIX.length) : null);

// Limite de frecuencia: el reloj lo pasa quien llama, asi se puede probar sin esperar
export class SoundLimiter {
  constructor(gapMs = SOUND_GAP_MS) {
    this.gapMs = gapMs;
    this.lastAt = -Infinity;
  }

  remaining(now) {
    return Math.max(0, this.gapMs - (now - this.lastAt));
  }

  // true si se puede tocar ahora (y lo anota)
  tryPlay(now) {
    if (this.remaining(now) > 0) return false;
    this.lastAt = now;
    return true;
  }
}

// Nombre de un sonido propio: sin controles ni espacios de mas
export function cleanSoundName(name) {
  return String(name ?? '')
    .trim()
    .replace(/\.[A-Za-z0-9]{1,5}$/, '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, CUSTOM_NAME_MAX);
}

// Hay que recortar y volver a codificar el archivo antes de guardarlo
export const needsReencode = ({ bytes, duration }) => bytes > CUSTOM_BYTES || duration > CUSTOM_SECONDS + 0.05;

// Toca un sonido ya decodificado hacia dest. Devuelve la duracion en segundos.
export function playBuffer(ctx, buffer, dest) {
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(dest);
  src.start();
  return Math.min(buffer.duration, CUSTOM_SECONDS);
}

// Biblioteca de sonidos propios: lista, bytes y buffers decodificados (se decodifican una vez por contexto de audio).
// invoke = api.invoke, para poder probarla sin Electron.
export class CustomSounds {
  constructor(invoke) {
    this.invoke = invoke;
    this.items = [];
    this.shortcuts = {};
    this.buffers = new Map();
    this.loaded = null;
  }

  apply(res) {
    this.items = Array.isArray(res?.items) ? res.items : [];
    this.shortcuts = res?.shortcuts && typeof res.shortcuts === 'object' ? res.shortcuts : {};
    const alive = new Set(this.items.map((x) => x.id));
    for (const id of this.buffers.keys()) if (!alive.has(id)) this.buffers.delete(id);
    return this.items;
  }

  load(force = false) {
    if (!this.loaded || force) {
      this.loaded = this.invoke('soundboard:list')
        .then((res) => this.apply(res))
        .catch((err) => {
          this.loaded = null;
          throw err;
        });
    }
    return this.loaded;
  }

  async add({ name, bytes }) {
    this.apply(await this.invoke('soundboard:add', { name: cleanSoundName(name), bytes }));
    this.loaded = Promise.resolve(this.items);
    return this.items;
  }

  async rename(id, name) {
    this.apply(await this.invoke('soundboard:rename', id, cleanSoundName(name)));
  }

  async remove(id) {
    this.apply(await this.invoke('soundboard:remove', id));
  }

  async setShortcut(soundId, accel) {
    const res = await this.invoke('soundboard:setShortcut', soundId, accel || '');
    this.apply(res);
    return res;
  }

  async buffer(ctx, id) {
    const hit = this.buffers.get(id);
    if (hit?.ctx === ctx) return hit.buffer;
    const bytes = await this.invoke('soundboard:read', id);
    const copy = bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const buffer = await ctx.decodeAudioData(copy);
    this.buffers.set(id, { ctx, buffer });
    return buffer;
  }
}
