// RNNoise compilado a WebAssembly (vendor/rnnoise). Se instancia a mano, sin el pegamento de Emscripten: en un
// AudioWorklet no hay fetch ni DOM, y el modulo ya compilado llega desde el hilo principal.
// Es codigo puro: las pruebas lo corren en Node con el mismo binario que usa el launcher.
export const RNNOISE_FRAME = 480; // 10 ms a 48 kHz: lo unico que acepta RNNoise
export const RNNOISE_RATE = 48000;

const SCALE = 32768; // RNNoise trabaja con muestras en el rango de 16 bits

// module: WebAssembly.Module de rnnoise.wasm. Tira error si el binario no tiene la forma esperada.
export function createRnnoise(module) {
  let memory = null;
  const instance = new WebAssembly.Instance(module, {
    a: {
      // emscripten_resize_heap
      a(size) {
        try {
          memory.grow(Math.ceil(((size >>> 0) - memory.buffer.byteLength) / 65536));
          return 1;
        } catch {
          return 0;
        }
      },
      // emscripten_memcpy_big
      b(dest, src, num) {
        new Uint8Array(memory.buffer).copyWithin(dest, src, src + num);
      },
    },
  });
  // Nombres minificados por Emscripten: c = memoria, d = constructores, e = malloc, f = free, h = rnnoise_create,
  // i = rnnoise_destroy, j = rnnoise_process_frame
  const x = instance.exports;
  memory = x.c;
  x.d();
  const state = x.h(0);
  const inPtr = x.e(RNNOISE_FRAME * 4);
  const outPtr = x.e(RNNOISE_FRAME * 4);
  if (!state || !inPtr || !outPtr) throw new Error('RNNoise: sin memoria');
  let heap = new Float32Array(memory.buffer);
  const view = () => (heap.buffer === memory.buffer ? heap : (heap = new Float32Array(memory.buffer)));
  let alive = true;
  return {
    // Limpia frame (480 muestras de -1 a 1) en el lugar y devuelve la probabilidad de que haya voz (0 a 1)
    process(frame) {
      let h = view();
      const inAt = inPtr >> 2;
      const outAt = outPtr >> 2;
      for (let i = 0; i < RNNOISE_FRAME; i++) h[inAt + i] = frame[i] * SCALE;
      const prob = x.j(state, outPtr, inPtr);
      h = view();
      for (let i = 0; i < RNNOISE_FRAME; i++) frame[i] = h[outAt + i] / SCALE;
      return prob;
    },
    destroy() {
      if (!alive) return;
      alive = false;
      x.i(state);
      x.f(inPtr);
      x.f(outPtr);
    },
  };
}
