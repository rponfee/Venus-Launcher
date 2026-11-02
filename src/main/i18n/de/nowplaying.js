'use strict';
// Texte des Hauptprozesses für das Musikmodul (nowplaying): Fehler und Overlay-Hinweise.
module.exports = {
  err_platform: "Die Musiksteuerung ist nur unter Windows verfügbar.",
  err_unsupported: "Dieses Windows hat nicht die nötigen Mediensteuerelemente (Windows 10 Version 1809 oder neuer).",
  err_unavailable: "Die Windows-Mediensteuerelemente reagieren nicht. Versuch es in ein paar Sekunden noch einmal.",
  err_noSession: "Es ist kein Player offen.",
  err_rejected: "Der Player hat die Aktion nicht angenommen.",
  err_noSeek: "Dieser Player erlaubt kein Vor- oder Zurückspulen.",
  err_noAudio: "Die Lautstärke dieser App wurde im Windows-Mixer nicht gefunden. Sie erscheint, sobald etwas abgespielt wird.",
  err_noSpotify: "Spotify ist auf diesem PC nicht installiert.",
  err_badAction: "Diese Aktion ist ungültig.",
  err_timeout: "Der Player hat zu lange für die Antwort gebraucht.",
  err_failed: "Die Musik konnte nicht gesteuert werden.",
  alertVolume: "Musiklautstärke: {value} %",
  alertMuted: "Musik stummgeschaltet",
};
