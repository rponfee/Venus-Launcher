// Textos de CurseForge en la interfaz (catálogo y prueba de Administración). Usar t('curseforge.<clave>').
export default {
  offText: 'Todavía no hay una clave de CurseForge cargada en el servidor de Venus. Un administrador la configura en Administración → Integraciones. Mientras tanto podés seguir buscando e instalando desde Modrinth.',
  signInTitle: 'Iniciá sesión para usar CurseForge',
  signInText: 'El catálogo de CurseForge se consulta con tu cuenta de Venus: la clave vive en el servidor y nunca llega a tu PC. Iniciá sesión y se carga solo.',
  signIn: 'Iniciar sesión',
  errorTitle: 'No se pudo preparar CurseForge',
  errorText: 'El launcher no pudo comprobar el estado de CurseForge. Revisá tu conexión y probá de nuevo.',
  checkAgain: 'Revisar de nuevo',
  // Prueba de búsqueda de Administración → Integraciones: un mensaje por cada cosa que puede haber pasado
  testBlocked: 'CurseForge cortó la consulta del servidor antes de revisar la clave. La clave puede estar bien: es un bloqueo del borde de CurseForge. Probá de nuevo en unos minutos.',
  testNotConfigured: 'El servidor de Venus no tiene ninguna clave cargada. Guardá la clave y volvé a probar.',
  testUnavailable: 'El servicio de Venus no está disponible ahora. Probá de nuevo en un rato.',
  testUpstream: 'CurseForge respondió con un error propio, no relacionado con la clave. Probá de nuevo en un rato.',
};
