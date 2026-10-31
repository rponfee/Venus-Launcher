'use strict';
// Textos del proceso principal: descargas (core/http.js) y almacenamiento (modules/storage).
module.exports = {
  // Descargas
  errCancelled: 'Cancelado por el usuario',
  errOffline: 'El modo sin conexión está activado: no se puede conectar con {host}. Podés desactivarlo en los ajustes de descargas.',
  errTimeout: '{host} dejó de responder (30 s sin recibir datos).',
  errNetwork: 'No se pudo conectar con {host} ({error}).',
  errHttp: 'HTTP {status} en {url}',
  errHttpBody: 'HTTP {status} en {url}: {body}',
  errNoUrl: 'Sin URL de descarga para {name}',
  errRange: 'El servidor no permitió retomar {name}; se descarga de nuevo.',
  errSize: 'Tamaño inválido para {name}',
  errHash: 'Hash {algo} inválido para {name}',
  errSomeFailed_one: 'No se pudo descargar {count} archivo: {name} ({error})',
  errSomeFailed_other: 'No se pudieron descargar {count} archivos. Primero: {name} ({error})',
  errBadJson: '{host} respondió algo que no se pudo leer. Probá de nuevo en un rato.',
  errNoSpace: 'No hay espacio en el disco para guardar {name}. Liberá espacio y probá de nuevo.',
  errDiskAccess: 'No se pudo guardar {name}: el archivo está en uso o no hay permiso para escribirlo ({error}). Cerrá el juego o el antivirus que lo esté usando y probá de nuevo.',
  errDisk: 'No se pudo guardar {name} en el disco ({error}).',

  // Almacenamiento
  errBusy: 'Ya hay una operación de almacenamiento en curso. Esperá a que termine.',
  errTasksRunning: 'Hay tareas en curso (instalaciones o descargas). Esperá a que terminen y probá de nuevo.',
  errGameRunning: 'Cerrá los juegos y servidores abiertos antes de borrar versiones o Java.',
  errNothingChosen: 'Elegí al menos una categoría para limpiar.',
  taskDedupe: 'Unificando archivos repetidos',
  taskScanning: 'Buscando archivos repetidos...',
  taskLinking: 'Reemplazando copias por enlaces al almacén...',
  taskClean: 'Liberando espacio en disco',
  taskCleaning: 'Borrando lo que ya no se usa...',
};
