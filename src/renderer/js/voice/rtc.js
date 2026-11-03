// Conexion WebRTC con otro miembro de la sala (malla: una conexion por par).
// Usa el patron "perfect negotiation": los dos lados pueden renegociar (compartir pantalla, reinicio de
// ICE) y los choques de ofertas se resuelven solos (el lado "polite" cede).
//
// Audio: Opus se ajusta en el SDP (voice/sdp.js) y el bitrate se adapta a la perdida de paquetes (voice/net.js).
// Si la conexion se cae: reinicio de ICE con reintentos y, si no alcanza, onStuck para rearmarla desde cero.
import { tuneOpusSdp, readOpusParams } from './sdp.js';
import { MIN_BITRATE, newBitrateState, nextBitrate, readAudioStats, lossSample, worstLoss, newQualityState, nextQuality } from './net.js';

const DISCONNECT_GRACE_MS = 3000; // un corte breve de ICE suele volver solo
const RESTART_WATCHDOG_MS = 20000; // reiniciado y sin volver (sin señalizacion, por ejemplo): se prueba otra vez
const MAX_QUICK_RESTARTS = 4;

export class Peer {
  // opts: { id, session, polite, rtcConfig, audioTrack, audioStream, screen: { track, stream }|null,
  //         videoBitrate, audioBitrate (tope de lo que mandamos), maxAverageBitrate (lo que le pedimos al otro),
  //         send(kind, data), onTrack(peer, track, streams), onChange(peer),
  //         beforeRestart(peer) (actualizar servidores ICE), onStuck(peer) (los reinicios de ICE no alcanzaron) }
  constructor(opts) {
    this.id = opts.id;
    this.session = opts.session;
    this.polite = opts.polite;
    this.send = opts.send;
    this.onTrackCb = opts.onTrack;
    this.onChangeCb = opts.onChange;
    this.beforeRestart = opts.beforeRestart;
    this.onStuck = opts.onStuck;
    this.videoBitrate = opts.videoBitrate || 1500000;
    this.audioCap = opts.audioBitrate || 64000;
    this.maxAverageBitrate = opts.maxAverageBitrate || this.audioCap;
    this.remoteMax = null; // lo mas que el otro pidio recibir (los clientes 2.x no dicen nada)
    this.rate = newBitrateState(this.audioCap);
    this.qualityState = newQualityState();
    this.lossPct = null;
    this.lastAudio = null;
    this.makingOffer = false;
    this.ignoreOffer = false;
    this.answerPending = false;
    this.queue = Promise.resolve();
    this.pendingCandidates = [];
    this.outCandidates = [];
    this.flushTimer = null;
    this.discTimer = null;
    this.retryTimer = null;
    this.failures = 0;
    this.closed = false;
    this.state = 'connecting';
    this.ping = null;
    this.relay = false;
    this.screenTrack = null;
    this.screenStream = null;
    this.videoTx = null;
    this.encoding = null;
    this.encodingAgain = false;

    this.pc = new RTCPeerConnection(opts.rtcConfig);
    this.audioSender = this.pc.addTrack(opts.audioTrack, opts.audioStream);
    if (opts.screen) this.setScreen(opts.screen.track, opts.screen.stream);

    this.pc.onnegotiationneeded = () => this.negotiate();
    this.pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      this.outCandidates.push(e.candidate.toJSON());
      if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flushCandidates(), 120);
    };
    this.pc.ontrack = (e) => this.onTrack(e);
    this.pc.oniceconnectionstatechange = () => this.onIceState();
    this.pc.onconnectionstatechange = () => {
      // ICE anda pero se rompio lo de arriba (DTLS): un reinicio de ICE no lo arregla, hay que rearmar la conexion
      if (this.pc.connectionState === 'failed' && ['connected', 'completed'].includes(this.pc.iceConnectionState)) this.onStuck?.(this);
      this.updateState();
    };
    this.pc.onsignalingstatechange = () => {
      if (this.pc.signalingState === 'stable') this.applyEncodings();
    };
  }

  // Los candidatos se agrupan para no saturar el canal de Realtime
  flushCandidates() {
    this.flushTimer = null;
    if (this.closed || !this.outCandidates.length) return;
    const list = this.outCandidates.splice(0, 40);
    this.send('ice', { list });
    if (this.outCandidates.length) this.flushTimer = setTimeout(() => this.flushCandidates(), 60);
  }

  async negotiate() {
    if (this.closed) return;
    try {
      this.makingOffer = true;
      await this.pc.setLocalDescription();
      this.send('desc', { description: this.outgoingDescription() });
    } catch (err) {
      console.warn('[voice] negociacion', err);
    } finally {
      this.makingOffer = false;
    }
  }

  // Lo que se le manda al otro pide Opus para voz; la descripcion local no cambia (no hace falta y asi nada puede fallar)
  outgoingDescription() {
    const d = this.pc.localDescription;
    return { type: d.type, sdp: tuneOpusSdp(d.sdp, { maxAverageBitrate: this.maxAverageBitrate }) };
  }

  // Lo que manda el otro se ajusta antes de aplicarlo para que nuestro encoder use FEC y DTX aunque sea un cliente 2.x
  incomingSdp(sdp) {
    const asked = Number(readOpusParams(sdp)?.params.maxaveragebitrate);
    this.remoteMax = Number.isFinite(asked) && asked > 0 ? asked : null;
    return tuneOpusSdp(sdp, { maxAverageBitrate: Math.min(this.audioCap, this.remoteMax ?? Infinity) });
  }

  // Las señales se procesan en orden (llegan verificadas desde el motor)
  handle(kind, data) {
    this.queue = this.queue.then(() => this.process(kind, data)).catch((err) => console.warn('[voice] señal', err));
    return this.queue;
  }

  async process(kind, data) {
    if (this.closed) return;
    if (kind === 'desc') {
      const d = data?.description;
      if (!d || !['offer', 'answer'].includes(d.type) || typeof d.sdp !== 'string' || d.sdp.length > 60000) return;
      const readyForOffer = !this.makingOffer && (this.pc.signalingState === 'stable' || this.answerPending);
      const collision = d.type === 'offer' && !readyForOffer;
      this.ignoreOffer = !this.polite && collision;
      if (this.ignoreOffer) return;
      if (d.type === 'answer' && this.pc.signalingState !== 'have-local-offer') return;
      this.answerPending = d.type === 'answer';
      await this.pc.setRemoteDescription({ type: d.type, sdp: this.incomingSdp(d.sdp) });
      this.answerPending = false;
      for (const c of this.pendingCandidates.splice(0)) await this.addCandidate(c);
      if (d.type === 'offer') {
        await this.pc.setLocalDescription();
        this.send('desc', { description: this.outgoingDescription() });
      }
    } else if (kind === 'ice') {
      const list = Array.isArray(data?.list) ? data.list.slice(0, 60) : [];
      for (const c of list) {
        if (!c || typeof c.candidate !== 'string' || c.candidate.length > 1024) continue;
        const cand = { candidate: c.candidate, sdpMid: c.sdpMid ?? null, sdpMLineIndex: c.sdpMLineIndex ?? null, usernameFragment: c.usernameFragment ?? null };
        if (!this.pc.remoteDescription) this.pendingCandidates.push(cand);
        else await this.addCandidate(cand);
      }
    }
  }

  async addCandidate(c) {
    try {
      await this.pc.addIceCandidate(c);
    } catch (err) {
      if (!this.ignoreOffer) console.warn('[voice] candidato ICE', err?.message || err);
    }
  }

  onTrack(e) {
    const track = e.track;
    if (track.kind === 'video') {
      this.screenTrack = track;
      this.screenStream = e.streams?.[0] || new MediaStream([track]);
      const changed = () => this.onChangeCb?.(this);
      track.addEventListener('mute', changed);
      track.addEventListener('unmute', changed);
      track.addEventListener('ended', () => {
        if (this.screenTrack === track) {
          this.screenTrack = null;
          this.screenStream = null;
        }
        changed();
      });
    }
    this.onTrackCb?.(this, track, e.streams || []);
    this.onChangeCb?.(this);
  }

  // Hay pantalla compartida visible de este miembro
  get sharingVideo() {
    return Boolean(this.screenTrack && this.screenTrack.readyState === 'live' && !this.screenTrack.muted);
  }

  onIceState() {
    const s = this.pc.iceConnectionState;
    clearTimeout(this.discTimer);
    if (s === 'connected' || s === 'completed') {
      this.failures = 0;
      clearTimeout(this.retryTimer);
    } else if (s === 'disconnected') {
      // Corte breve: si no vuelve solo en unos segundos, reiniciar ICE
      this.discTimer = setTimeout(() => {
        if (!this.closed && this.pc.iceConnectionState === 'disconnected') this.restartIce();
      }, DISCONNECT_GRACE_MS);
    } else if (s === 'failed') {
      this.noteFailure(600 * (this.failures + 1));
    }
    this.updateState();
  }

  noteFailure(delay) {
    this.failures++;
    if (this.failures > MAX_QUICK_RESTARTS) this.onStuck?.(this);
    if (this.closed) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.restartIce(), this.failures > MAX_QUICK_RESTARTS ? RESTART_WATCHDOG_MS : delay);
  }

  async restartIce() {
    if (this.closed) return;
    try {
      await this.beforeRestart?.(this);
    } catch {
      /* se reinicia con los servidores que haya */
    }
    if (this.closed) return;
    try {
      this.pc.restartIce();
    } catch (err) {
      console.warn('[voice] reinicio ICE', err);
    }
    // Si no vuelve ni llega a 'failed' (por ejemplo, la señalizacion tambien esta caida), se vuelve a intentar
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      if (this.closed || ['connected', 'completed'].includes(this.pc.iceConnectionState)) return;
      this.noteFailure(0);
      this.updateState();
    }, RESTART_WATCHDOG_MS);
  }

  updateState() {
    const c = this.pc.connectionState;
    const ice = this.pc.iceConnectionState;
    let next = 'connecting';
    if (c === 'connected' || ice === 'connected' || ice === 'completed') next = 'connected';
    else if (c === 'failed' || ice === 'failed') next = this.failures > MAX_QUICK_RESTARTS ? 'failed' : 'reconnecting';
    else if (c === 'disconnected' || ice === 'disconnected') next = 'reconnecting';
    else if (c === 'closed') next = 'closed';
    if (next !== this.state) {
      this.state = next;
      if (next === 'connected') this.applyEncodings();
      this.onChangeCb?.(this);
    }
  }

  // Compartir pantalla: un transceptor de video propio que se reutiliza
  setScreen(track, stream) {
    if (this.closed) return;
    if (!this.videoTx) {
      this.videoTx = this.pc.addTransceiver(track, { direction: 'sendonly', streams: [stream] });
    } else {
      this.videoTx.sender.replaceTrack(track).catch(() => {});
      try {
        this.videoTx.sender.setStreams?.(stream);
      } catch {
        /* sin soporte */
      }
      this.videoTx.direction = 'sendonly';
    }
    this.applyEncodings();
  }

  clearScreen() {
    if (this.closed || !this.videoTx) return;
    this.videoTx.sender.replaceTrack(null).catch(() => {});
    this.videoTx.direction = 'inactive';
  }

  setVideoBitrate(bps) {
    this.videoBitrate = bps;
    this.applyEncodings();
  }

  // Nuevo tope de bitrate (cambio la calidad elegida o la cantidad de personas)
  setAudioCap(bps) {
    if (bps === this.audioCap) return;
    this.rate = bps > this.audioCap ? newBitrateState(bps) : { ...this.rate, bps: Math.min(this.rate.bps, bps) };
    this.audioCap = bps;
    this.applyEncodings();
  }

  // El bitrate adaptativo, sin pasarse de lo que el otro pidio recibir
  get audioBitrate() {
    return Math.max(MIN_BITRATE, Math.min(this.rate.bps, this.remoteMax ?? Infinity));
  }

  // Estado de la conexion segun las estadisticas: 'good' | 'fair' | 'bad'
  get quality() {
    return this.qualityState.level;
  }

  // De a uno: dos setParameters a la vez chocan y se perderia el valor mas nuevo
  applyEncodings() {
    if (this.encoding) {
      this.encodingAgain = true;
      return this.encoding;
    }
    this.encoding = (async () => {
      do {
        this.encodingAgain = false;
        await this.writeEncodings();
      } while (this.encodingAgain);
      this.encoding = null;
    })();
    return this.encoding;
  }

  async writeEncodings() {
    if (this.closed) return;
    // La voz tiene prioridad sobre la pantalla compartida cuando no alcanza la conexion
    await setEncoding(this.audioSender, { maxBitrate: this.audioBitrate, priority: 'high', networkPriority: 'high' });
    const vs = this.videoTx?.sender;
    if (vs?.track) await setEncoding(vs, { maxBitrate: this.videoBitrate, maxFramerate: 15 }, 'maintain-resolution');
  }

  async updateStats() {
    if (this.closed || this.state !== 'connected') return;
    try {
      const stats = await this.pc.getStats();
      this.updateAudioQuality(stats);
      let pair = null;
      stats.forEach((r) => {
        if (r.type === 'transport' && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId) || pair;
      });
      if (!pair) {
        stats.forEach((r) => {
          if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r;
        });
      }
      const ping = pair && typeof pair.currentRoundTripTime === 'number' ? Math.round(pair.currentRoundTripTime * 1000) : null;
      const local = pair ? stats.get(pair.localCandidateId) : null;
      const relay = local?.candidateType === 'relay';
      if (ping !== this.ping || relay !== this.relay) {
        this.ping = ping;
        this.relay = relay;
        this.onChangeCb?.(this);
      }
    } catch {
      /* conexion cerrandose */
    }
  }

  // Con las estadisticas de esta vuelta: ajusta el bitrate segun la perdida y actualiza el estado de calidad
  updateAudioQuality(stats) {
    const list = [];
    stats.forEach((r) => list.push(r));
    const cur = readAudioStats(list);
    const sample = lossSample(this.lastAudio, cur);
    this.lastAudio = cur;
    const before = this.audioBitrate;
    this.rate = nextBitrate(this.rate, { lossPct: sample.upLossPct, cap: this.audioCap });
    if (this.audioBitrate !== before) this.applyEncodings();
    const level = this.quality;
    this.qualityState = nextQuality(this.qualityState, sample);
    const loss = worstLoss(sample);
    if (loss !== null) this.lossPct = Math.round(loss);
    if (this.quality !== level) this.onChangeCb?.(this);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.flushTimer);
    clearTimeout(this.discTimer);
    clearTimeout(this.retryTimer);
    this.pc.onnegotiationneeded = null;
    this.pc.onicecandidate = null;
    this.pc.ontrack = null;
    this.pc.oniceconnectionstatechange = null;
    this.pc.onconnectionstatechange = null;
    this.pc.onsignalingstatechange = null;
    try {
      this.pc.close();
    } catch {
      /* ya cerrada */
    }
    this.state = 'closed';
  }
}

async function setEncoding(sender, values, degradation) {
  if (!sender) return;
  try {
    const p = sender.getParameters();
    if (!p.encodings || !p.encodings.length) return; // todavia sin negociar
    let changed = false;
    for (const [k, v] of Object.entries(values)) {
      if (p.encodings[0][k] !== v) {
        p.encodings[0][k] = v;
        changed = true;
      }
    }
    if (degradation && p.degradationPreference !== degradation) {
      p.degradationPreference = degradation;
      changed = true;
    }
    if (changed) await sender.setParameters(p);
  } catch {
    /* el navegador no acepta el cambio ahora: se reintenta en la proxima negociacion */
  }
}
