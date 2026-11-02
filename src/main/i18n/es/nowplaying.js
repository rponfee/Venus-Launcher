'use strict';
// Textos del proceso principal del módulo de Música (nowplaying): errores y avisos del overlay.
module.exports = {
  err_platform: 'El control de música solo está disponible en Windows.',
  err_unsupported: 'Este Windows no tiene los controles multimedia que hacen falta (Windows 10 versión 1809 o posterior).',
  err_unavailable: 'Los controles multimedia de Windows no responden. Probá de nuevo en unos segundos.',
  err_noSession: 'No hay ningún reproductor abierto.',
  err_rejected: 'El reproductor no aceptó la acción.',
  err_noSeek: 'Este reproductor no deja adelantar ni retroceder.',
  err_noAudio: 'No se encontró el volumen de esta app en el mezclador de Windows. Aparece cuando empieza a sonar.',
  err_noSpotify: 'Spotify no está instalado en esta PC.',
  err_badAction: 'Esa acción no es válida.',
  err_timeout: 'El reproductor tardó demasiado en responder.',
  err_failed: 'No se pudo controlar la música.',
  alertVolume: 'Volumen de la música: {value} %',
  alertMuted: 'Música silenciada',
};
