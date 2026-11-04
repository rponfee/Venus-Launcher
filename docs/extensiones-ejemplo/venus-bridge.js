// Ayudante para hablar con el launcher: copialo tal cual a tu extensión. Es un script común, no un módulo.
//   venusBridge.ready            promesa con { extension, permissions, surface, locale }
//   venusBridge.call(método, parámetros)   promesa con el resultado; si falla, rechaza con un Error cuyo .code es el motivo
(function () {
  var seq = 0;
  var pending = new Map();
  var resolveReady;
  var ready = new Promise(function (resolve) {
    resolveReady = resolve;
  });

  window.addEventListener('message', function (event) {
    if (event.source !== window.parent) return;
    var msg = event.data;
    if (!msg || msg.venus !== 1) return;
    if (msg.type === 'hello') {
      resolveReady(msg);
      return;
    }
    var waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    if (msg.ok) waiter.resolve(msg.result);
    else waiter.reject(Object.assign(new Error(msg.error), { code: msg.error }));
  });

  window.venusBridge = {
    ready: ready,
    call: function (method, params) {
      return new Promise(function (resolve, reject) {
        var id = ++seq;
        pending.set(id, { resolve: resolve, reject: reject });
        window.parent.postMessage({ venus: 1, id: id, method: method, params: params || {} }, '*');
      });
    },
  };
})();
