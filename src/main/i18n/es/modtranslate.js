'use strict';
// Textos del proceso principal de la traducción automática de mods.
module.exports = {
  // Paquete de recursos
  packDescription: 'Traducción automática (puede tener errores)',
  packReadme:
    'Paquete generado por Venus Launcher.\n\nContiene traducciones automáticas de los textos de tus mods hechas con inteligencia artificial: pueden tener errores. Las que corregiste a mano quedan marcadas como revisadas dentro del launcher.\n\nPodés compartir y mejorar estas traducciones desde Venus Launcher (Traducir mods > Compartir). Si encontrás un error, lo ideal es avisarle al autor del mod para que lo corrija en la traducción oficial.',

  // Tarea en segundo plano
  taskTitle: 'Traduciendo mods de {name}',
  taskPreparing: 'Buscando textos sin traducir…',
  taskDetail: '{done} de {total} textos',
  taskDone_one: '{count} texto traducido',
  taskDone_other: '{count} textos traducidos',
  taskCancelled: 'Traducción cancelada: se guardó lo que ya estaba listo',

  // Compartir
  exportJsonTitle: 'Exportar traducción para compartir',
  exportZipTitle: 'Exportar como paquete de recursos',
  exportJsonName: 'traduccion-{locale}-{name}.json',
  exportZipName: 'traduccion-automatica-{locale}-{name}.zip',
  exportNotice:
    'Traducción automática generada con IA por Venus Launcher: puede tener errores. Las entradas con "reviewed": true fueron revisadas por una persona.',
  filterJson: 'Traducción de Venus (JSON)',
  filterZip: 'Paquete de recursos (ZIP)',
  importTitle: 'Importar una traducción',
  filterImport: 'Traducciones (JSON, ZIP o .lang)',

  // Errores
  errNoInstance: 'No se indicó la instancia.',
  errBusy: 'Ya se están traduciendo los mods de esta instancia. Esperá a que termine o cancelala.',
  errUnsupported: 'Esta versión de Minecraft no admite paquetes de recursos, así que no se pueden agregar traducciones.',
  errNoMods: 'Elegí al menos un mod para traducir.',
  errNothingToExport: 'Todavía no hay traducciones para exportar en este idioma.',
  errExportWrite: 'No se pudo guardar el archivo: {error}',
  errImportRead: 'No se pudo leer el archivo elegido.',
  errImportTooBig: 'El archivo es demasiado grande para ser una traducción (máximo 32 MB).',
  errImportFormat: 'El archivo no es una traducción reconocible. Usá un archivo exportado desde Venus, un archivo de idioma (.json o .lang) o un paquete de recursos (.zip).',
  errImportVersion: 'Ese archivo se creó con una versión más nueva de Venus Launcher. Actualizá el launcher para importarlo.',
  errImportEmpty: 'El archivo no tiene textos traducidos.',
  errImportManyLocales: 'El paquete tiene traducciones de varios idiomas: elegí primero el idioma que querés importar.',
  errNoPack: 'Todavía no hay un paquete de traducciones para activar.',
  errLocale: 'Ese idioma no está disponible.',
  errBadPath: 'Ruta no permitida.',
};
