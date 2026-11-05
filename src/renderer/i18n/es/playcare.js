// Cuidado del juego (features/playcare): aviso de versión nueva, recordatorio de descansos, resumen al cerrar el juego
// y descargas programadas.
export default {
  // Aviso de version nueva (features/playcare/mcnews.js)
  newVersionTitle: 'Nueva versión de Minecraft: {id}',
  newVersionRelease: 'Ya salió la {id}. ¿Creamos una instancia?',
  newVersionSnapshot: 'Hay una snapshot nueva: {id}.',
  newVersionCreate: 'Crear instancia',
  newVersionSeen: 'Ya vi',

  // Descansos (features/playcare/breaks.js)
  breakTitle: 'Hora de un descanso',
  breakBody_one: 'Llevás {count} minuto seguido jugando. Estirá un poco y tomá agua.',
  breakBody_other: 'Llevás {count} minutos seguidos jugando. Estirá un poco y tomá agua.',
  limitTitle: 'Llegaste a tu tope de hoy',
  limitBody: 'Hoy jugaste {minutes} minutos y tu tope es de {limit}. Venus no cierra el juego: lo decidís vos.',

  // Resumen al cerrar el juego (features/playcare/recap.js)
  recapTitle: 'Resumen de la sesión',
  recapDuration: 'Jugaste {time}',
  recapInstance: 'Instancia',
  recapCaptures: 'Capturas',
  recapClips: 'Clips',
  recapAchievements: 'Logros desbloqueados',
  recapMissions: 'Misiones completadas',
  recapNone: 'Ninguno en esta sesión',
  recapStats: 'Ver estadísticas',
  recapClose: 'Cerrar',

  // Descargas programadas (features/playcare/schedule.js)
  schedTitle: 'Descargas programadas',
  schedSub: 'Elegí una franja horaria: fuera de ella las descargas quedan en pausa y adentro se reanudan solas. Sirve para no ocupar la conexión mientras jugás o para aprovechar la noche.',
  schedEnable: 'Activar la franja',
  schedFrom: 'Desde',
  schedTo: 'Hasta',
  schedCrosses: 'La franja cruza la medianoche.',
  schedStatusOff: 'Apagado: las descargas bajan en cualquier momento.',
  schedStatusIn: 'Dentro de la franja: las descargas bajan ahora, hasta las {to}.',
  schedStatusOut: 'Fuera de la franja: las descargas esperan hasta las {from}.',
  schedStatusOverride: 'Bajando ahora porque lo pediste, hasta las {until}; después vuelve a respetar la franja.',
  schedStatusManualPause: 'Las descargas están en pausa porque las pausaste vos desde Descargas.',
  schedNow: 'Bajar ahora',
  schedNowHint: 'Levanta la pausa durante 2 horas.',
  schedReset: 'Volver a la franja',
  schedNoticeTitle: 'Descargas en espera',
  schedNoticeText: 'Por la franja de descargas programadas, las descargas esperan hasta las {from}.',
  schedSaveError: 'No se pudo guardar la franja',
  schedUnavailable: 'Las descargas programadas no están disponibles.',
};
