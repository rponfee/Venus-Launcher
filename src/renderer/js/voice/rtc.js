// Conexion WebRTC con otro miembro de la sala (malla: una conexion por par).
// Usa el patron "perfect negotiation": los dos lados pueden renegociar (compartir pantalla, reinicio de
// ICE) y los choques de ofertas se resuelven solos (el lado "polite" cede).
const AUDIO_BITRATE = 64000;

export class Peer {
  // opts: { id, session, polite, rtcConfig, audioTrack, audioStream, screen: { track, stream }|null,
  //         videoBitrate, send(kind, data), onTrack(peer, track, streams), onChange(peer) }
  constructor(opts) {
    this.id = opts.id;
    this.session = opts.session;
    this.polite = opts.polite;
    this.send = opts.send;
    this.onTrackCb = opts.onTrack;
    this.onChangeCb = opts.onChange;
    this.videoBitrate = opts.videoBitrate || 1500000;
    this.makingOffer = false;
    this.ignoreOffer = false;
    this.answerPending = false;
    this.queue = Promise.resolve();
    this.pendingCandidates = [];
    this.outCandidates = [];
    this.flushTimer = null;
    this.discTimer = null;
    this.failures = 0;
    this.closed = false;
    this.state = 'connecting';
    this.ping = null;
    this.relay = false;
    this.screenTrack = null;
    this.screenStream = null;
    this.videoTx = null;

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
    this.pc.onconnectionstatechange = () => this.updateState();
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
      this.send('desc', { description: this.pc.localDescription.toJSON() });
    } catch (err) {
      console.warn('[voice] negociacion', err);
    } finally {
      this.makingOffer = false;
    }
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
      await this.pc.setRemoteDescription({ type: d.type, sdp: d.sdp });
      this.answerPending = false;
      for (const c of this.pendingCandidates.splice(0)) await this.addCandidate(c);
      if (d.type === 'offer') {
        await this.pc.setLocalDescription();
        this.send('desc', { description: this.pc.localDescription.toJSON() });
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
    if (s === 'connected' || s === 'completed') this.failures = 0;
    else if (s === 'disconnected') {
      // Corte breve: si no vuelve solo en unos segundos, reiniciar ICE
      this.discTimer = setTimeout(() => {
        if (!this.closed && this.pc.iceConnectionState === 'disconnected') this.restartIce();
      }, 4000);
    } else if (s === 'failed') {
      this.failures++;
      if (this.failures <= 4) setTimeout(() => this.restartIce(), 600 * this.failures);
    }
    this.updateState();
  }

  restartIce() {
    if (this.closed) return;
    try {
      this.pc.restartIce();
    } catch (err) {
      console.warn('[voice] reinicio ICE', err);
    }
  }

  updateState() {
    const c = this.pc.connectionState;
    const ice = this.pc.iceConnectionState;
    let next = 'connecting';
    if (c === 'connected' || ice === 'connected' || ice === 'completed') next = 'connected';
    else if (c === 'failed' || ice === 'failed') next = this.failures > 4 ? 'failed' : 'reconnecting';
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

  async applyEncodings() {
    if (this.closed) return;
    await setEncoding(this.audioSender, { maxBitrate: AUDIO_BITRATE });
    const vs = this.videoTx?.sender;
    if (vs?.track) await setEncoding(vs, { maxBitrate: this.videoBitrate, maxFramerate: 15 }, 'maintain-resolution');
  }

  async updateStats() {
    if (this.closed || this.state !== 'connected') return;
    try {
      const stats = await this.pc.getStats();
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

  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.flushTimer);
    clearTimeout(this.discTimer);
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
