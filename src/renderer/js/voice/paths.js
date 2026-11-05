// Los dos caminos de señalizacion de una sala de voz: el principal (Realtime de Supabase) y el de respaldo
// (voice/backup.js, MQTT cifrado). Decide por cual sale cada mensaje, cuando abrir el respaldo y cuando cerrarlo.
//
//   - Mientras el principal anda, el respaldo esta apagado: no se abre ninguna conexion a brokers publicos.
//   - Si el principal se cae (voice/health.js: socket, canal o pruebas), se abre el respaldo solo, sin que la persona
//     haga nada, y todo sale por los dos (el principal aun puede andar a medias). Se recibe de los dos y el motor
//     descarta lo repetido por su nonce.
//   - Cuando el principal vuelve y lleva un rato estable, el respaldo se mantiene un tiempo (por si alguien tarda en
//     volver) y se cierra, salvo que haga falta (hay gente que solo llega por ahi).
//   - Lo que no pudo salir por ningun camino se guarda (30 s) y sale apenas haya uno; lo que se dijo en los ultimos
//     segundos se reenvia a quien aparece por primera vez en el respaldo (el receptor descarta lo repetido).
//   - Una llamada en curso nunca depende de esto: el audio va directo por WebRTC.
// Sin DOM ni red propia: el motor le da el canal principal, la fabrica del respaldo y los timers; asi se prueba entero.
import { Health } from './health.js';

export const PATHS = {
  POLL_MS: 1000, // mira el socket y evalua la salud
  PROBE_MS: 4000, // prueba activa del servidor
  PROBE_TIMEOUT_MS: 2500,
  BEACON_MS: 10000, // presencia por el respaldo
  BEACON_BURST: [0, 1200, 3000], // al abrir: avisos seguidos para encontrarse enseguida
  BEACON_REPLY_MS: 1500, // minimo entre respuestas a un aviso nuevo
  LINGER_MS: 30000, // cuanto sigue abierto el respaldo despues de que vuelve el principal
  SEND_TIMEOUT_MS: 2500, // un envio por el principal que tarda mas que esto se da por fallido
  QUEUE_MAX: 300, // mensajes que no pudieron salir por ningun camino
  QUEUE_AGE_MS: 30000, // y cuanto se los guarda
  REPLAY_MAX: 40, // lo dicho hace poco, para quien aparece por el respaldo
  REPLAY_AGE_MS: 20000,
};

export class Paths {
  // opts: { clock, health, primary, makeLine, getSecret, backupOnly, needBackup, beacon, onFrame, onChange }
  //   primary: { ready() -> bool, connected() -> bool, send(event, env) -> Promise<'ok'|string>, probe() -> Promise<bool> } | null
  //   makeLine(secret, { onFrame, onState }) -> BackupLine | null
  //   beacon() -> Promise<{ event, env } | null>   (presencia firmada para el respaldo)
  //   needBackup() -> bool   (hay alguien que solo llega por el respaldo)
  constructor(opts) {
    this.clock = opts.clock;
    this.health = opts.health || new Health();
    this.primary = opts.primary || null;
    this.makeLine = opts.makeLine;
    this.getSecret = opts.getSecret;
    this.backupOnly = Boolean(opts.backupOnly);
    this.needBackup = opts.needBackup || (() => false);
    this.beaconFn = opts.beacon;
    this.onFrameCb = opts.onFrame;
    this.onChangeCb = opts.onChange;
    this.line = null;
    this.lineState = 'off';
    this.lineSecret = null;
    this.timers = {};
    this.lingerUntil = 0;
    this.lastBeacon = 0;
    this.lastSendFail = 0;
    this.probing = false;
    this.started = false;
    this.last = '';
    this.noSecretWarned = false;
    this.queue = [];
    this.recent = [];
    this.flushing = false;
    this.opened = false; // el canal principal llego a suscribirse alguna vez (antes, un socket que todavia no conecto no es una falla)
  }

  now() {
    return this.clock.now();
  }

  start() {
    if (this.started) return;
    this.started = true;
    if (this.backupOnly) this.health.force('down', this.now());
    this.timers.poll = this.clock.setInterval(() => this.poll(), PATHS.POLL_MS);
    if (this.primary && !this.backupOnly) this.timers.probe = this.clock.setInterval(() => this.runProbe(), PATHS.PROBE_MS);
    this.poll();
  }

  stop() {
    this.started = false;
    for (const k of Object.keys(this.timers)) {
      this.clock.clearInterval(this.timers[k]);
      this.clock.clearTimeout(this.timers[k]);
    }
    this.timers = {};
    this.closeLine();
  }

  // ---------- Estado ----------
  get primaryState() {
    return this.backupOnly ? 'down' : this.health.state;
  }

  get wantBackup() {
    if (this.backupOnly) return true;
    if (this.primaryState === 'down') return true;
    return this.now() < this.lingerUntil || this.needBackup();
  }

  // 'primary' (todo normal) | 'both' (principal sano, respaldo todavia abierto) | 'backup' (principal caido)
  get route() {
    if (this.primaryState === 'down') return 'backup';
    return this.lineState === 'off' ? 'primary' : 'both';
  }

  snapshot() {
    return { primary: this.primaryState, backup: this.lineState, route: this.route, backupOnly: this.backupOnly, canBackup: Boolean(this.getSecret?.()), queued: this.queue.length };
  }

  emit(force = false) {
    const snap = this.snapshot();
    const key = `${snap.primary}|${snap.backup}|${snap.route}|${snap.canBackup}`;
    if (!force && key === this.last) return;
    this.last = key;
    try {
      this.onChangeCb?.(snap);
    } catch (err) {
      console.warn('[voice] caminos', err);
    }
  }

  // ---------- Entradas del motor ----------
  channelStatus(status) {
    if (status === 'SUBSCRIBED') this.opened = true;
    this.health.channel(status, this.now());
    this.evaluate();
  }

  // Llego algo por el canal principal
  heardPrimary() {
    this.health.alive();
  }

  // El principal quedo listo (canal suscripto): se acaba de reabrir o es la primera vez
  primaryOpened() {
    this.emit();
    this.flush();
  }

  // Un envio por el principal salio mal (como mucho una vez por segundo cuenta como prueba fallida)
  sendFailed() {
    const now = this.now();
    if (now - this.lastSendFail < 1000) return;
    this.lastSendFail = now;
    this.health.probe(false);
    this.evaluate();
  }

  setBackupOnly(on) {
    this.backupOnly = Boolean(on);
    this.evaluate();
  }

  // El motor se dio cuenta de que no entra al principal (no abrio el canal): pasar al respaldo ya
  forceDown() {
    if (this.health.force('down', this.now())) this.evaluate(true);
  }

  // ---------- Evaluacion ----------
  poll() {
    if (!this.started) return;
    const now = this.now();
    if (this.opened && this.primary && !this.backupOnly) this.health.socket(Boolean(this.primary.connected()), now);
    this.evaluate();
  }

  async runProbe() {
    if (!this.started || this.probing || !this.opened || !this.primary || this.backupOnly) return;
    this.probing = true;
    let ok = false;
    try {
      ok = await Promise.race([this.primary.probe(), new Promise((r) => this.clock.setTimeout(() => r(false), PATHS.PROBE_TIMEOUT_MS))]);
    } catch {
      ok = false;
    } finally {
      this.probing = false;
    }
    if (!this.started) return;
    this.health.probe(Boolean(ok));
    this.evaluate();
  }

  evaluate(force = false) {
    if (!this.started) return;
    const now = this.now();
    const changed = this.health.evaluate(now);
    if (changed === 'up') {
      this.lingerUntil = now + PATHS.LINGER_MS;
      this.flush();
    }
    this.syncLine();
    this.emit(force || Boolean(changed));
  }

  // Abre o cierra el respaldo segun haga falta
  syncLine() {
    const secret = this.getSecret?.() || null;
    if (this.line && secret !== this.lineSecret) this.closeLine(); // la sala cambio de clave (bloqueo, contraseña): se reabre con la nueva
    if (this.wantBackup) {
      if (!secret) {
        if (!this.noSecretWarned) {
          this.noSecretWarned = true;
          this.emit(true);
        }
        return;
      }
      this.noSecretWarned = false;
      if (!this.line) this.openLine(secret);
    } else if (this.line) this.closeLine();
  }

  openLine(secret) {
    const line = this.makeLine(secret, {
      onFrame: (f) => this.frame(f),
      onState: (st) => this.lineChanged(line, st),
    });
    if (!line) return;
    this.line = line;
    this.lineSecret = secret;
    this.lineState = 'connecting';
    line.start().catch((err) => {
      console.warn('[voice] respaldo', err?.message || err);
      if (this.line === line) this.closeLine();
    });
    this.emit(true);
  }

  closeLine() {
    const line = this.line;
    this.line = null;
    this.lineSecret = null;
    this.lineState = 'off';
    this.clearBeacons();
    if (line) {
      try {
        line.stop();
      } catch {
        /* ya detenido */
      }
    }
    if (this.started) this.emit(true);
  }

  lineChanged(line, st) {
    if (this.line !== line) return;
    this.lineState = st;
    if (st === 'on') {
      this.scheduleBeacons();
      this.flush();
    } else this.clearBeacons();
    this.emit(true);
  }

  // ---------- Presencia por el respaldo ----------
  scheduleBeacons() {
    this.clearBeacons();
    PATHS.BEACON_BURST.forEach((ms, i) => {
      this.timers[`b${i}`] = this.clock.setTimeout(() => this.sendBeacon(), ms);
    });
    this.timers.beacon = this.clock.setInterval(() => this.sendBeacon(), PATHS.BEACON_MS);
  }

  clearBeacons() {
    for (const k of Object.keys(this.timers)) {
      if (k === 'beacon') this.clock.clearInterval(this.timers[k]);
      else if (/^b\d+$/.test(k)) this.clock.clearTimeout(this.timers[k]);
      else continue;
      delete this.timers[k];
    }
  }

  async sendBeacon(force = false) {
    if (!this.line || this.lineState !== 'on' || !this.beaconFn) return;
    const now = this.now();
    if (!force && now - this.lastBeacon < 300) return;
    this.lastBeacon = now;
    try {
      const b = await this.beaconFn();
      if (b) await this.line.send(b.event, b.env);
    } catch (err) {
      console.warn('[voice] presencia de respaldo', err?.message || err);
    }
  }

  // Aparecio por el respaldo alguien que no habiamos escuchado por ahi: se le contesta enseguida (con tope) y se le
  // reenvia lo dicho hace poco para todos o para esa persona, por si salio antes de que estuviera escuchando.
  peerAppeared(userId) {
    if (this.now() - this.lastBeacon >= PATHS.BEACON_REPLY_MS) this.sendBeacon(true);
    const now = this.now();
    const items = this.recent.filter((m) => now - m.at < PATHS.REPLAY_AGE_MS && (!m.env.to || m.env.to === userId));
    if (this.line && this.lineState === 'on') for (const m of items) this.line.send(m.event, m.env).catch(() => {});
  }

  // ---------- Recibir y enviar ----------
  frame(f) {
    this.onFrameCb?.({ path: 'backup', event: f.event, env: f.env });
  }

  // Un mensaje ya firmado por el motor. Sale por el principal si anda y por el respaldo si esta abierto; si no salio por
  // ninguno se guarda y sale apenas haya uno. Devuelve { primary: 'ok'|'fail'|'skip', backup: n }.
  async send(event, env) {
    const out = await this.deliver(event, env);
    if (event !== 'pres') {
      this.recent.push({ event, env, at: this.now() });
      if (this.recent.length > PATHS.REPLAY_MAX) this.recent.shift();
    }
    if (!Paths.delivered(out)) this.enqueue(event, env);
    return out;
  }

  enqueue(event, env) {
    this.queue.push({ event, env, at: this.now() });
    if (this.queue.length > PATHS.QUEUE_MAX) this.queue.shift();
  }

  // Vacia la cola por lo que haya disponible ahora (en orden); lo que sigue sin poder salir se queda
  async flush() {
    if (this.flushing || !this.queue.length || !this.started) return;
    this.flushing = true;
    try {
      const items = this.queue.splice(0).filter((m) => this.now() - m.at < PATHS.QUEUE_AGE_MS);
      for (const m of items) {
        const out = await this.deliver(m.event, m.env);
        if (!Paths.delivered(out)) this.queue.push(m);
      }
    } finally {
      this.flushing = false;
    }
  }

  async deliver(event, env) {
    const out = { primary: 'skip', backup: 0 };
    const jobs = [];
    if (this.primary?.ready() && !this.backupOnly) {
      // Un envio por el principal que no contesta no frena al respaldo (ni a los mensajes que siguen)
      let timer;
      const late = new Promise((resolve) => {
        timer = this.clock.setTimeout(() => resolve('timed out'), PATHS.SEND_TIMEOUT_MS);
      });
      jobs.push(
        Promise.race([this.primary.send(event, env), late])
          .finally(() => this.clock.clearTimeout(timer))
          .then((r) => {
            out.primary = r === 'ok' ? 'ok' : 'fail';
            if (r !== 'ok') this.sendFailed();
          })
          .catch(() => {
            out.primary = 'fail';
            this.sendFailed();
          }),
      );
    }
    if (this.line && this.lineState === 'on') {
      jobs.push(
        this.line
          .send(event, env)
          .then((n) => {
            out.backup = n;
          })
          .catch((err) => console.warn('[voice] envio de respaldo', err?.message || err)),
      );
    }
    await Promise.all(jobs);
    return out;
  }

  // Salio por algun lado
  static delivered(r) {
    return r.primary === 'ok' || r.backup > 0;
  }
}
