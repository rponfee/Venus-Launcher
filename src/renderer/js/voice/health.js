// Salud del camino principal del Voice Chat (Realtime de Supabase): decide cuando hay que pasar al respaldo y cuando se
// puede volver. Es una maquina de estados pura, sin timers ni red: el motor le cuenta lo que ve (socket, canal, pruebas)
// y ella dice 'up' o 'down'. Con histeresis: se cae rapido (unos segundos) pero vuelve solo cuando lleva un rato estable,
// asi un servidor que va y viene no hace parpadear el estado ni cambiar de camino cada segundo.
export const HEALTH = {
  SOCKET_GRACE: 2000, // el socket de Realtime sin conexion este tiempo = caido
  CHANNEL_GRACE: 3000, // el canal de la sala sin suscripcion este tiempo = caido
  PROBE_FAILS: 2, // pruebas activas seguidas que fallan = caido
  UP_PROBES: 2, // pruebas buenas seguidas para volver
  UP_STABLE: 4000, // y el canal suscripto sin cortes este tiempo
};

export class Health {
  constructor(cfg = {}) {
    this.cfg = { ...HEALTH, ...cfg };
    this.reset();
  }

  reset() {
    this.state = 'up';
    this.sockDownAt = null;
    this.chanDownAt = null;
    this.chanUpAt = null;
    this.probeFails = 0;
    this.probeOks = 0;
    this.since = 0;
  }

  // El socket de Realtime esta conectado o no
  socket(connected, now) {
    if (connected) this.sockDownAt = null;
    else {
      if (this.sockDownAt === null) this.sockDownAt = now;
      this.chanUpAt = null; // al volver el socket el canal se reabre: hace falta que avise de nuevo que esta suscripto
    }
  }

  // Estado del canal de la sala: 'SUBSCRIBED' o cualquier otro (JOINING, CHANNEL_ERROR, TIMED_OUT, CLOSED)
  channel(status, now) {
    if (status === 'SUBSCRIBED') {
      this.chanDownAt = null;
      if (this.chanUpAt === null) this.chanUpAt = now;
    } else {
      if (this.chanDownAt === null) this.chanDownAt = now;
      this.chanUpAt = null;
    }
  }

  // Resultado de una prueba activa (ida y vuelta al servidor) o de un envio por el canal
  probe(ok) {
    if (ok) {
      this.probeFails = 0;
      this.probeOks++;
    } else {
      this.probeOks = 0;
      this.probeFails++;
    }
  }

  // Llego algo del servidor por el canal: esta vivo (no cuenta como prueba buena para volver, solo evita caer)
  alive() {
    this.probeFails = 0;
  }

  // Devuelve 'up' o 'down' si cambio, o null si sigue igual
  evaluate(now) {
    const c = this.cfg;
    if (this.state === 'up') {
      const down =
        (this.sockDownAt !== null && now - this.sockDownAt >= c.SOCKET_GRACE) ||
        (this.chanDownAt !== null && now - this.chanDownAt >= c.CHANNEL_GRACE) ||
        this.probeFails >= c.PROBE_FAILS;
      if (down) return this.set('down', now);
    } else {
      const up = this.sockDownAt === null && this.chanDownAt === null && this.chanUpAt !== null && now - this.chanUpAt >= c.UP_STABLE && this.probeOks >= c.UP_PROBES;
      if (up) return this.set('up', now);
    }
    return null;
  }

  // Forzar el estado (por ejemplo, el canal no llego a abrirse al entrar)
  force(state, now) {
    return this.state === state ? null : this.set(state, now);
  }

  set(state, now) {
    this.state = state;
    this.since = now;
    this.probeFails = 0;
    this.probeOks = 0;
    return state;
  }
}
