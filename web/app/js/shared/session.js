// El cliente de supabase-js, igual para la página y el service worker: misma clave de almacenamiento. Si los dos renuevan el
// token a la vez, supabase-js se da cuenta (compara lo guardado antes y después) y se queda con la sesión más nueva.
(function (root) {
  'use strict';

  function createClient({ autoRefresh = true } = {}) {
    const { config, idb } = root.VenusApp;
    const auth = {
      storage: idb.storage,
      storageKey: config.storageKey,
      persistSession: true,
      autoRefreshToken: autoRefresh,
      detectSessionInUrl: false, // los mails traen códigos, como en el launcher: nunca vuelve nada por la URL
      flowType: 'pkce',
    };
    return root.supabase.createClient(config.url, config.anonKey, { auth, realtime: { params: { eventsPerSecond: 20 } } });
  }

  const session = { createClient };
  root.VenusApp = Object.assign(root.VenusApp || {}, { session });
  if (typeof module === 'object' && module.exports) module.exports = session;
})(globalThis);
