// Efectos de voz del microfono saliente. Se arman con Web Audio y van despues del supresor de ruido y la compuerta:
//   compuerta -> [efecto] -> lo que reciben los demas
// Con 'none' no se crea ningun nodo: la cadena queda igual que sin efectos (voice/mic.js).
//   robot    modulador de anillo: un oscilador maneja la ganancia de la voz (OscillatorNode + GainNode)
//   echo     DelayNode con realimentacion
//   villager tono un poco mas grave y una resonancia nasal (filtros), sin sonidos de ningun juego
//   deep     tono mas grave
//   high     tono mas agudo
// El cambio de tono es un AudioWorklet (voice/pitch-worklet.js); si no carga, buildVoiceFx tira error y queda sin efecto.
export const VOICE_EFFECTS = ['none', 'robot', 'echo', 'villager', 'deep', 'high'];

export const FX_PARAMS = {
  robot: { ringHz: 70, dry: 0.12, wet: 1 },
  echo: { delay: 0.26, feedback: 0.38, wet: 0.5, trim: 0.8 },
  villager: { ratio: 0.86, highpass: 240, peak: 1150, peakQ: 1.3, peakDb: 10, lowpass: 3400, trim: 0.7 },
  deep: { ratio: 0.72 },
  high: { ratio: 1.42 },
};

export const normalizeEffect = (id) => (VOICE_EFFECTS.includes(id) ? id : 'none');

// El efecto necesita el worklet de tono
export const fxNeedsPitch = (id) => Boolean(FX_PARAMS[id]?.ratio);

const PITCH_URL = new URL('./pitch-worklet.js', import.meta.url);
const pitchLoads = new WeakMap();

function loadPitch(ctx) {
  if (!pitchLoads.has(ctx)) {
    const load = ctx.audioWorklet.addModule(PITCH_URL);
    pitchLoads.set(ctx, load);
    load.catch(() => pitchLoads.delete(ctx));
  }
  return pitchLoads.get(ctx);
}

function pitchNode(ctx, ratio) {
  return new AudioWorkletNode(ctx, 'venus-pitch', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCount: 1,
    channelCountMode: 'explicit',
    processorOptions: { ratio },
  });
}

function filter(ctx, type, frequency, q, gain) {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = frequency;
  if (q !== undefined) f.Q.value = q;
  if (gain !== undefined) f.gain.value = gain;
  return f;
}

// Cadena de un efecto: { input, output, stop() }. Conectar input y output es trabajo de quien llama.
export async function buildVoiceFx(ctx, id) {
  const p = FX_PARAMS[id];
  if (!p) throw new Error(`efecto desconocido: ${id}`);
  if (fxNeedsPitch(id)) await loadPitch(ctx);
  const input = ctx.createGain();
  const output = ctx.createGain();
  output.gain.value = p.trim ?? 1; // los que suman volumen bajan un poco, asi no saturan lo que se envia
  const nodes = [input, output];
  const sources = [];
  let worklet = null;
  if (id === 'robot') {
    const ring = ctx.createGain();
    ring.gain.value = 0; // la ganancia la manda el oscilador: la voz se multiplica por la onda
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = p.ringHz;
    const depth = ctx.createGain();
    depth.gain.value = p.wet;
    osc.connect(depth);
    depth.connect(ring.gain);
    const dry = ctx.createGain();
    dry.gain.value = p.dry;
    input.connect(ring);
    ring.connect(output);
    input.connect(dry);
    dry.connect(output);
    osc.start();
    sources.push(osc);
    nodes.push(ring, depth, dry);
  } else if (id === 'echo') {
    const delay = ctx.createDelay(1);
    delay.delayTime.value = p.delay;
    const feedback = ctx.createGain();
    feedback.gain.value = p.feedback;
    const wet = ctx.createGain();
    wet.gain.value = p.wet;
    input.connect(output);
    input.connect(delay);
    delay.connect(feedback);
    feedback.connect(delay);
    delay.connect(wet);
    wet.connect(output);
    nodes.push(delay, feedback, wet);
  } else {
    worklet = pitchNode(ctx, p.ratio);
    input.connect(worklet);
    nodes.push(worklet);
    let last = worklet;
    if (id === 'villager') {
      for (const f of [filter(ctx, 'highpass', p.highpass), filter(ctx, 'peaking', p.peak, p.peakQ, p.peakDb), filter(ctx, 'lowpass', p.lowpass)]) {
        last.connect(f);
        nodes.push(f);
        last = f;
      }
    }
    last.connect(output);
  }
  return {
    id,
    input,
    output,
    stop() {
      for (const s of sources) {
        try {
          s.stop();
        } catch {
          /* ya detenido */
        }
      }
      worklet?.port.postMessage({ type: 'stop' });
      for (const n of nodes) {
        try {
          n.disconnect();
        } catch {
          /* ya desconectado */
        }
      }
    },
  };
}
