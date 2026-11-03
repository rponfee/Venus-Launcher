'use strict';
// Reglas de los clips automaticos, sin Electron ni temporizadores (se prueban con node:test): que tipos de evento
// estan prendidos, enfriamiento, limite por partida y cuanto esperar antes de cortar. capture.js pone el temporizador
// con la espera que devuelve offer() y guarda el clip con lo que devuelve take().
const { AUTO_REASONS } = require('./logic');

// Cuanto se sigue grabando despues del evento, para que el clip incluya lo que siguio. El dragon tarda ~10 s en morir.
const AFTER_MS = { advancement: 5000, death: 5000, boss: 12000 };

class AutoClipGate {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.reset();
  }

  // Partida nueva
  reset() {
    this.count = 0;
    this.lastAt = -Infinity;
    this.pending = null; // { reason, dueAt, ctx }
    this.limitSeen = false;
  }

  /**
   * Llego un evento (reason) con los ajustes auto ya normalizados. ctx viaja con el clip (por ejemplo, la instancia).
   * Devuelve { action: 'schedule', reason, delay } si hay que (re)programar el corte en delay ms, o
   * { action: 'ignore', why: 'off' | 'pending' | 'cooldown' | 'limit' }.
   * Si ya hay un clip esperando no se abre otro: se usa el mismo y, si este evento es mas importante (muerte sobre
   * logro, jefe sobre todo), el clip queda con ese motivo y la espera se estira si hace falta.
   */
  offer(reason, auto, ctx = null) {
    if (!auto?.enabled || !AUTO_REASONS.includes(reason) || !auto[reason]) return { action: 'ignore', why: 'off' };
    const now = this.now();
    if (this.pending) {
      if (AUTO_REASONS.indexOf(reason) <= AUTO_REASONS.indexOf(this.pending.reason)) return { action: 'ignore', why: 'pending' };
      this.pending.reason = reason;
      this.pending.dueAt = Math.max(this.pending.dueAt, now + AFTER_MS[reason]);
      return { action: 'schedule', reason, delay: this.pending.dueAt - now };
    }
    if (now - this.lastAt < auto.cooldown * 1000) return { action: 'ignore', why: 'cooldown' };
    if (this.count >= auto.maxPerSession) return { action: 'ignore', why: 'limit' };
    this.count++;
    this.lastAt = now;
    this.pending = { reason, dueAt: now + AFTER_MS[reason], ctx };
    return { action: 'schedule', reason, delay: AFTER_MS[reason] };
  }

  // Lo que hay que guardar ahora ({ reason, dueAt, ctx } o null) y deja de estar pendiente
  take() {
    const p = this.pending;
    this.pending = null;
    return p;
  }

  // true la primera vez que se llega al limite en esta partida (para avisarlo una sola vez)
  noteLimit() {
    if (this.limitSeen) return false;
    this.limitSeen = true;
    return true;
  }
}

module.exports = { AutoClipGate, AFTER_MS };
