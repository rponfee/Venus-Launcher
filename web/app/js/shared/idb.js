// Almacén local de la app: una sola base de IndexedDB que comparten la página y el service worker. El service worker no puede
// leer localStorage; por eso la sesión de supabase-js va acá, con el adaptador `storage` que trae la propia librería (mismo
// contenido y misma clave que guardaría ella). Sin IndexedDB (ventana privada, por ejemplo) queda en memoria.
(function (root) {
  'use strict';
  const DB = 'venus-app';
  const STORE = 'kv';
  const OPEN_MS = 3000;
  const memory = new Map();
  let opening = null;
  let unavailable = false;

  function open() {
    if (!root.indexedDB || unavailable) return Promise.resolve(null);
    if (opening) return opening;
    const attempt = new Promise((resolve) => {
      let req;
      let timer;
      let settled = false;
      const finish = (db) => {
        if (settled) {
          db?.close(); // una apertura tardía no puede reemplazar la sesión en memoria
          return;
        }
        settled = true;
        clearTimeout(timer);
        unavailable = !db; // hasta recargar: no mezclar datos persistidos viejos con la memoria
        resolve(db);
      };
      try {
        req = root.indexedDB.open(DB, 1);
      } catch {
        finish(null);
        return;
      }
      // Safari a veces no contesta nunca: la app no se puede quedar colgada esperando
      timer = setTimeout(() => finish(null), OPEN_MS);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => {
        clearTimeout(timer);
        const db = req.result;
        db.onclose = () => (opening = null);
        db.onversionchange = () => {
          db.close();
          opening = null;
        };
        finish(db);
      };
      req.onerror = () => finish(null);
      req.onblocked = () => finish(null);
    }).then((db) => {
      if (!db) opening = null;
      return db;
    });
    opening = attempt;
    return attempt;
  }

  async function run(mode, action, fallback) {
    const db = await open();
    if (!db) return fallback();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = action(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  const idb = {
    get: (key) => run('readonly', (s) => s.get(key), () => memory.get(key)).then((v) => (v === undefined ? null : v)),
    set: (key, value) => run('readwrite', (s) => s.put(value, key), () => void memory.set(key, value)).then(() => undefined),
    remove: (key) => run('readwrite', (s) => s.delete(key), () => void memory.delete(key)).then(() => undefined),
    // Salir borra todo lo de la cuenta. La cáscara de la app queda en Cache Storage: no tiene datos.
    async clear() {
      memory.clear();
      await run('readwrite', (s) => s.clear(), () => undefined);
    },
    // Lo que le pasa supabase-js: guarda y lee texto, como en localStorage
    storage: {
      getItem: (key) => idb.get(key),
      setItem: (key, value) => idb.set(key, value),
      removeItem: (key) => idb.remove(key),
    },
  };

  root.VenusApp = Object.assign(root.VenusApp || {}, { idb });
  if (typeof module === 'object' && module.exports) module.exports = idb;
})(globalThis);
