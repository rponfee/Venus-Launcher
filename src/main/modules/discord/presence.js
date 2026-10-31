'use strict';
// Conexión con Discord para Rich Presence: conecta con la aplicación del usuario, reintenta cuando
// Discord se abre más tarde o se cierra, respeta el límite de Discord (5 cambios cada 20 s) y borra
// la actividad al salir. Sin Electron: se puede probar con un servidor IPC falso.
const { EventEmitter } = require('events');
const { DiscordIpc } = require('./ipc');
const { validClientId } = require('./activity');

const MIN_INTERVAL = 4100; // ms entre SET_ACTIVITY
const TEST_HOLD = 15000; // cuánto queda la actividad de prueba
const RETRY_MIN = 8000;
const RETRY_MAX = 60000;
const RETRY_INVALID = 120000;

function avatarUrl(user) {
  if (!user?.id) return null;
  if (user.avatar) return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${String(user.avatar).startsWith('a_') ? 'gif' : 'png'}?size=64`;
  let idx = 0;
  try {
    idx = Number((BigInt(user.id) >> 22n) % 6n);
  } catch {
    idx = 0;
  }
  return `https://cdn.discordapp.com/embed/avatars/${idx}.png`;
}

class PresenceManager extends EventEmitter {
  /**
   * opts: { t, paths?: rutas del IPC (pruebas), IpcClass?, minInterval?, retryMin? }
   */
  constructor({ t, paths, IpcClass = DiscordIpc, minInterval = MIN_INTERVAL, retryMin = RETRY_MIN } = {}) {
    super();
    this.t = t || ((k) => k);
    this.paths = paths;
    this.IpcClass = IpcClass;
    this.minInterval = minInterval;
    this.retryMin = retryMin;
    this.cfg = { enabled: false, clientId: '' };
    this.state = 'off';
    this.error = null;
    this.activityError = null;
    this.client = null;
    this.clientId = null;
    this.connecting = null;
    this.user = null;
    this.desired = null;
    this.sentKey = undefined;
    this.lastSendAt = 0;
    this.pushTimer = null;
    this.retryTimer = null;
    this.retryDelay = 0;
    this.testUntil = 0;
    this.testTimer = null;
    this.stopped = false;
    this.generation = 0;
  }

  status() {
    return {
      enabled: Boolean(this.cfg.enabled),
      configured: validClientId(this.cfg.clientId),
      state: this.state,
      error: this.error,
      activityError: this.activityError,
      user: this.user ? { id: this.user.id, username: this.user.username || '', globalName: this.user.global_name || this.user.globalName || null, avatarUrl: avatarUrl(this.user) } : null,
      testing: this.testUntil > Date.now(),
      lastSendAt: this.lastSendAt || null,
      activitySynced: Boolean(this.client?.connected && !this.activityError && !this.testUntil && this.sentKey === JSON.stringify(this.desired)),
    };
  }

  setState(state, error = null) {
    const changed = state !== this.state || error !== this.error;
    this.state = state;
    this.error = error;
    if (changed) this.emit('status', this.status());
  }

  configure(cfg) {
    this.cfg = { ...cfg };
    this.apply();
  }

  // Actividad que se quiere mostrar (null = nada)
  setDesired(activity) {
    this.desired = activity || null;
    this.schedulePush();
  }

  apply() {
    if (this.stopped) return;
    const { enabled, clientId } = this.cfg;
    if (!enabled) {
      this.disconnect('off');
      return;
    }
    if (!validClientId(clientId)) {
      this.disconnect('unconfigured');
      return;
    }
    if (this.client && this.clientId !== clientId) {
      this.disconnect('connecting').then(() => this.connect());
      return;
    }
    if (this.client) this.schedulePush();
    else if (!this.connecting) this.connect();
  }

  connect() {
    if (this.connecting) return this.connecting;
    if (this.stopped || !this.cfg.enabled || !validClientId(this.cfg.clientId)) return Promise.resolve(false);
    clearTimeout(this.retryTimer);
    const clientId = this.cfg.clientId;
    const generation = this.generation;
    this.setState('connecting');
    const client = new this.IpcClass({ clientId, paths: this.paths });
    this.connecting = client
      .connect()
      .then((ready) => {
        if (this.stopped || generation !== this.generation || this.cfg.clientId !== clientId || !this.cfg.enabled) {
          client.close().catch(() => {});
          return false;
        }
        this.client = client;
        this.clientId = clientId;
        this.user = ready?.user || null;
        this.retryDelay = 0;
        this.sentKey = undefined;
        this.activityError = null;
        client.on('close', () => {
          if (this.client !== client) return;
          this.client = null;
          this.user = null;
          this.sentKey = undefined;
          this.setState('waiting');
          this.scheduleRetry(5000);
        });
        this.setState('connected');
        this.schedulePush(0);
        return true;
      })
      .catch((err) => {
        if (this.stopped || generation !== this.generation || this.cfg.clientId !== clientId || !this.cfg.enabled) return false;
        if (err.code === 'INVALID_CLIENT') {
          this.setState('error', this.t('discord.errInvalidClient'));
          this.scheduleRetry(RETRY_INVALID);
        } else if (err.code === 'NO_DISCORD' || err.code === 'CLOSED' || err.code === 'TIMEOUT') {
          this.setState('waiting');
          this.scheduleRetry();
        } else {
          this.setState('error', this.t('discord.errConnect', { error: err.message }));
          this.scheduleRetry();
        }
        return false;
      })
      .finally(() => {
        this.connecting = null;
        // Si los ajustes cambiaron mientras se conectaba, aplicar los nuevos
        if (!this.stopped && (generation !== this.generation || this.cfg.clientId !== clientId || !this.cfg.enabled)) setTimeout(() => this.apply(), 0);
      });
    return this.connecting;
  }

  scheduleRetry(ms) {
    clearTimeout(this.retryTimer);
    if (this.stopped) return;
    let delay = ms;
    if (delay === undefined) {
      this.retryDelay = Math.min(RETRY_MAX, this.retryDelay ? this.retryDelay * 2 : this.retryMin);
      delay = this.retryDelay;
    }
    this.retryTimer = setTimeout(() => this.apply(), delay);
    this.retryTimer.unref?.();
  }

  async disconnect(nextState) {
    clearTimeout(this.retryTimer);
    clearTimeout(this.pushTimer);
    this.generation++;
    clearTimeout(this.testTimer);
    this.testUntil = 0;
    const client = this.client;
    this.client = null;
    this.clientId = null;
    this.user = null;
    this.sentKey = undefined;
    this.retryDelay = 0;
    if (nextState) this.setState(nextState);
    if (client) await client.close({ clear: true }).catch(() => {});
  }

  async reconnect() {
    if (!this.cfg.enabled) throw new Error(this.t('discord.errDisabled'));
    if (!validClientId(this.cfg.clientId)) throw new Error(this.t('discord.errNoClientId'));
    const pending = this.connecting;
    await this.disconnect('connecting');
    if (pending) await pending;
    if (this.stopped || !this.cfg.enabled) return false;
    return this.connect();
  }

  schedulePush(delay = 900) {
    clearTimeout(this.pushTimer);
    if (!this.client) return;
    const now = Date.now();
    const wait = Math.max(delay, this.lastSendAt + this.minInterval - now, this.testUntil - now, 0);
    this.pushTimer = setTimeout(() => this.push(), wait);
    this.pushTimer.unref?.();
  }

  async push() {
    const client = this.client;
    if (!client?.connected) return;
    if (this.testUntil > Date.now()) {
      this.schedulePush(0);
      return;
    }
    const activity = this.desired;
    const key = JSON.stringify(activity);
    if (key === this.sentKey) return;
    this.lastSendAt = Date.now();
    try {
      await client.setActivity(activity);
      if (this.client !== client) return;
      this.sentKey = key;
      this.activityError = null;
      this.emit('status', this.status());
    } catch (err) {
      if (this.client !== client) return;
      if (err.code === 'RPC_ERROR') {
        // Discord rechazó la actividad (por ejemplo, un botón con un enlace inválido): no reintentar lo mismo
        this.sentKey = key;
        this.activityError = this.t('discord.errActivity', { error: err.message });
        this.emit('status', this.status());
      }
    }
  }

  // Muestra una actividad de prueba un rato y después vuelve a la normal
  async test(activity) {
    if (!this.cfg.enabled) throw new Error(this.t('discord.errDisabled'));
    if (!validClientId(this.cfg.clientId)) throw new Error(this.t('discord.errNoClientId'));
    if (!this.client) await this.connect();
    if (!this.client) throw new Error(this.state === 'error' && this.error ? this.error : this.t('discord.errNoDiscord'));
    const client = this.client;
    const generation = this.generation;
    const wait = this.lastSendAt + this.minInterval - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (!this.cfg.enabled) throw new Error(this.t('discord.errDisabled'));
    if (!this.client || this.client !== client || generation !== this.generation) throw new Error(this.t('discord.errNoDiscord'));
    this.lastSendAt = Date.now();
    try {
      await client.setActivity(activity);
      if (this.client !== client || generation !== this.generation) throw new Error(this.t('discord.errNoDiscord'));
    } catch (err) {
      throw new Error(this.t('discord.errActivity', { error: err.message }));
    }
    this.sentKey = JSON.stringify(activity);
    this.activityError = null;
    this.testUntil = Date.now() + TEST_HOLD;
    clearTimeout(this.testTimer);
    this.testTimer = setTimeout(() => {
      this.testUntil = 0;
      this.sentKey = undefined;
      this.emit('status', this.status());
      this.schedulePush(0);
    }, TEST_HOLD);
    this.testTimer.unref?.();
    this.emit('status', this.status());
    return this.status();
  }

  // Al cerrar el launcher: borrar la actividad y cortar (máximo ~1,5 s)
  async shutdown() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearTimeout(this.pushTimer);
    clearTimeout(this.testTimer);
    const client = this.client;
    this.client = null;
    if (client) await client.close({ clear: true }).catch(() => {});
  }
}

module.exports = { PresenceManager, avatarUrl, MIN_INTERVAL };
