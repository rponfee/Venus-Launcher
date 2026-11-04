// Tarjeta de Inicio de la extensión de ejemplo: muestra el comienzo de las notas guardadas.
(function () {
  var note = document.getElementById('note');
  window.venusBridge.ready.then(function () {
    window.venusBridge
      .call('storage.get', { key: 'notes' })
      .then(function (saved) {
        note.textContent = typeof saved === 'string' && saved ? saved.slice(0, 180) : 'Todavía no anotaste nada.';
      })
      .catch(function () {
        note.textContent = 'No se pudieron leer las notas.';
      });
  });
})();
