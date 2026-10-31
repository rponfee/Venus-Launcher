// Textos del proceso principal del módulo de compartir modpacks (manifiestos, diferencias y aplicar revisiones).
module.exports = {
  errModrinth: 'No se pudo consultar Modrinth para identificar los mods: {error}',
  errBadManifest: 'El modpack compartido está dañado o no es válido.',
  errNewerFormat: 'Este modpack se compartió con una versión más nueva de Venus Launcher. Actualizá el launcher para usarlo.',
  errTooLarge: 'El modpack es demasiado grande para compartirlo (demasiadas configs). Desactivá "Incluir configs" o sacá archivos grandes de config/.',
  errGameRunning: 'Cerrá el juego antes de sincronizar esta instancia.',
  errBusyLaunch: 'Se está actualizando el modpack compartido de esta instancia. Esperá a que termine y volvé a jugar.',

  taskApply: 'Sincronizando {name}',
  taskCreate: 'Creando {name}',
  stepCompare: 'Comparando con el modpack compartido...',
  stepDownload_one: 'Descargando {count} archivo...',
  stepDownload_other: 'Descargando {count} archivos...',
  progressLabel: 'Mods',
  stepApply: 'Aplicando cambios...',
  stepDone: 'Listo',

  warnUnavailable: '{name} ya no se puede descargar: agregalo a mano.',
  warnRemove: 'No se pudo quitar {name}: {error}',
  warnToggle: 'No se pudo activar o desactivar {name}: {error}',
  warnConfig: 'No se pudo escribir {name}: {error}',
  warnPrepare: 'Los mods quedaron listos, pero no se pudo instalar el juego todavía ({error}). Se reintenta al jugar.',
  errBadPath: 'El modpack compartido tiene una ruta de archivo no permitida.',
};
