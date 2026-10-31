'use strict';
// Textos del núcleo del proceso principal (ipc.js, main.js y core/game.js): errores, diálogos, tareas y registro.
module.exports = {
  // Rutas, enlaces y almacén cifrado
  errPathNotAllowed: 'Ruta no permitida',
  errUrlNotAllowed: 'URL no permitida',
  errBadPath: 'Ruta inválida',
  errBadKey: 'Clave inválida',

  // Diálogos del sistema
  selectFiles: 'Elegir archivos',
  selectFolder: 'Elegir carpeta',

  // Equipo
  gpuUnknown: 'Desconocida',

  // Instancias y contenido
  errCloseGameToDelete: 'Cerrá el juego antes de borrar la instancia',
  taskAddOptifine: 'Agregando OptiFine a {name}',
  taskInstallInto: 'Instalando en {name}',
  taskModpack: 'Instalando modpack',
  errNoModpack: 'No se indicó el modpack',

  // Juego
  errAlreadyRunning: 'Esta instancia ya se está ejecutando',
  errLaunchBlocked: 'Lanzamiento cancelado',
  logStarting: 'Iniciando {name} ({version}) con Java {java}',
  logMemoryMicrosoft: 'Memoria: {min} MB - {max} MB · Cuenta: {account} (Microsoft)',
  logMemoryOffline: 'Memoria: {min} MB - {max} MB · Cuenta: {account} (sin conexión)',

  // Inicio de sesión
  loginWindowTitle: 'Iniciar sesión con Microsoft',
};
