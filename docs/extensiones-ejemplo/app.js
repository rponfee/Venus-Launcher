// Página de la extensión de ejemplo: notas guardadas (storage), aviso (notify), lista de instancias (read.instances),
// si hay un juego abierto (read.gameState), abrir una página (action.openPage) y abrir una instancia (action.launchInstance).
(function () {
  var bridge = window.venusBridge;
  var notes = document.getElementById('notes');
  var list = document.getElementById('instances');
  var state = document.getElementById('state');

  function showError(err) {
    state.textContent = 'No se pudo: ' + (err.code || err.message);
  }

  function drawInstances(instances) {
    list.textContent = '';
    instances.forEach(function (inst) {
      var li = document.createElement('li');
      var label = document.createElement('span');
      label.textContent = inst.name + ' · ' + inst.version + ' · ' + inst.loader;
      var play = document.createElement('button');
      play.type = 'button';
      play.className = 'ghost';
      play.textContent = 'Abrir';
      play.addEventListener('click', function () {
        // El launcher siempre le pregunta a la persona antes de abrir el juego.
        bridge.call('launcher.launchInstance', { instanceId: inst.id }).catch(showError);
      });
      li.append(label, play);
      list.append(li);
    });
    if (!instances.length) list.textContent = 'Todavía no tenés instancias.';
  }

  function refreshState() {
    return bridge.call('game.state').then(function (game) {
      state.textContent = game.running ? 'Hay un juego abierto.' : 'No hay ningún juego abierto.';
    });
  }

  document.getElementById('save').addEventListener('click', function () {
    bridge
      .call('storage.set', { key: 'notes', value: notes.value })
      .then(function () {
        return bridge.call('notify.show', { title: 'Notas guardadas', text: 'Quedaron en esta PC.' });
      })
      .catch(showError);
  });

  document.getElementById('stats').addEventListener('click', function () {
    bridge.call('launcher.openPage', { route: 'stats' }).catch(showError);
  });

  bridge.ready.then(function () {
    bridge
      .call('storage.get', { key: 'notes' })
      .then(function (saved) {
        if (typeof saved === 'string') notes.value = saved;
      })
      .catch(showError);
    bridge.call('instances.list').then(drawInstances).catch(showError);
    refreshState().catch(showError);
    setInterval(function () {
      refreshState().catch(showError);
    }, 15000);
  });
})();
