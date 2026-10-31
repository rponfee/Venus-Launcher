// Estado compartido de la interfaz + eventos simples.
const api = window.venus;

const listeners = new Map();

export const store = {
  info: null,
  settings: null,
  instances: [],
  accounts: { selected: null, accounts: [] },
  running: {}, // instanceId -> { state, pid, startedAt }
  tasks: new Map(),
  gameLogs: {}, // instanceId -> [{level,text}]
  servers: [],
  update: null,

  on(evt, fn) {
    if (!listeners.has(evt)) listeners.set(evt, new Set());
    listeners.get(evt).add(fn);
    return () => listeners.get(evt)?.delete(fn);
  },

  emit(evt, data) {
    for (const fn of listeners.get(evt) || []) {
      try {
        fn(data);
      } catch (err) {
        console.error(err);
      }
    }
  },

  async refreshInstances() {
    this.instances = await api.instances.list();
    for (const i of this.instances) if (i.running) this.running[i.id] = i.running;
    this.emit('instances', this.instances);
    return this.instances;
  },

  async refreshAccounts() {
    this.accounts = await api.accounts.list();
    this.emit('accounts', this.accounts);
    return this.accounts;
  },

  async refreshSettings() {
    this.settings = await api.settings.get();
    this.emit('settings', this.settings);
    return this.settings;
  },

  async setSettings(patch) {
    this.settings = await api.settings.set(patch);
    this.emit('settings', this.settings);
    return this.settings;
  },

  selectedAccount() {
    return this.accounts.accounts.find((a) => a.id === this.accounts.selected) || this.accounts.accounts[0] || null;
  },

  selectedInstance() {
    const id = this.settings?.selectedInstance;
    return this.instances.find((i) => i.id === id) || this.instances[0] || null;
  },

  // Tarea en curso que tiene ocupada la instancia (instalar, preparar, actualizar...): mientras exista,
  // Inicio, Versiones y la ficha de la instancia la muestran "instalando" y deshabilitan Jugar.
  // Las tareas en segundo plano que no impiden jugar (por ejemplo, traducir mods) pueden asociarse
  // igual a la instancia con meta { instanceId, background: true } o meta { instanceId, blocksPlay: false }:
  // se ven en el panel de tareas pero taskFor() las ignora.
  taskFor(instanceId) {
    for (const t of this.tasks.values()) {
      if (t.state !== 'running' || t.meta?.instanceId !== instanceId) continue;
      if (t.meta.background === true || t.meta.blocksPlay === false) continue;
      return t;
    }
    return null;
  },
};

export { api };
