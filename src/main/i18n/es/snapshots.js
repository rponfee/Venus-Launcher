// Textos del proceso principal de las instantáneas (tareas y errores que ve el usuario).
module.exports = {
  taskCreate: 'Guardando una instantánea de {name}',
  taskRestore: 'Restaurando {name}',
  stepScan: 'Revisando archivos…',
  stepSaving: 'Guardando {done} de {total}',
  stepSafety: 'Guardando el estado actual por las dudas…',
  stepCompare: 'Comparando con la instantánea…',
  stepRestoring: 'Restaurando {done} de {total}',

  errNoInstance: 'La instancia no existe o fue eliminada.',
  errNotFound: 'Esa instantánea ya no existe.',
  errRunning: 'Cerrá el juego antes de restaurar una instantánea.',
  errRunningWorlds: 'Cerrá el juego para incluir mundos en la instantánea: el juego los está escribiendo.',
  errBadWorld: 'No se encontró ese mundo en la instancia.',
  errTooMany: 'Hay demasiados archivos para guardar (más de {count}).',
  errNoSpace: 'No hay espacio en el disco para guardar la instantánea.',
  errDamaged: 'El archivo {file} de la instantánea está dañado. Tu estado anterior quedó guardado en la instantánea «Antes de restaurar».',
  errMissingObjects: 'Faltan archivos de esta instantánea en el almacén: no se puede restaurar. No se tocó nada.',
  errLocked: 'No se pudo usar {file}: otro programa lo tiene abierto. Cerralo y probá de nuevo.',
};
