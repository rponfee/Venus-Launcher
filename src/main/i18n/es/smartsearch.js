'use strict';
// Buscador inteligente (proceso principal): errores y titulos de tareas.
module.exports = {
  errEmptyQuery: 'Escribí qué querés buscar.',
  errTooLong: 'El pedido es demasiado largo (máximo 400 caracteres).',
  errModrinth: 'No se pudo conectar con Modrinth: {error}',
  errCanceled: 'Búsqueda cancelada',
  errInvalid: 'El pedido no es válido.',
  errBadAuthor: 'El autor no es válido: los nombres de usuario de Modrinth no llevan espacios ni símbolos.',
  errNothingToInstall: 'No hay nada para instalar.',
  errTooMany: 'Podés instalar hasta {max} elementos por vez.',
  errNoInstance: 'La instancia ya no existe.',
  errNoServer: 'El servidor ya no existe.',
  errVanillaServer: 'Los servidores vanilla no admiten mods ni plugins.',
  errNoWorld: 'Los data packs necesitan un mundo: elegí uno.',
  taskInstallKit: 'Instalando el kit en {name}',
  taskInstallKitServer: 'Instalando plugins en {name}',
  taskItem: '{title} ({index}/{total})',
  taskPrepare: 'Instalando {name}',
  kitResult: 'Se instalaron {ok} de {total}',
};
