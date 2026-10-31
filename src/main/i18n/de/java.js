'use strict';
module.exports = {
  downloadLabel: "Java {major}",
  preparing: "Java {major} wird vorbereitet...",
  downloadingAdoptium: "Java {major} (Adoptium) wird heruntergeladen...",
  extracting: "Java {major} wird entpackt...",
  errInstall: "Java {major} konnte nicht installiert werden: {error}",
  errNoAdoptium: "Adoptium veröffentlicht Java {major} nicht für dieses System",
  errNotFound: "Java {major} wurde heruntergeladen, läuft aber nicht auf diesem PC. Versuche es erneut oder wähle in den Instanzeinstellungen manuell eine Java-Version aus.",
  errOffline: "Diese Version benötigt Java {major}, das noch nicht installiert ist. Verbinde dich mit dem Internet, um es herunterzuladen (das ist nur einmal nötig).",
  warnBroken: "Die für diese Instanz gewählte Java-Version reagiert nicht ({path}). Wechsle in den Instanzeinstellungen wieder zu automatischem Java.",
  warnTooOld: "Minecraft {mc} benötigt Java {required} oder neuer, aber diese Instanz verwendet Java {current} (manuell gewählt). Sie kann so nicht starten: Wechsle in den Instanzeinstellungen wieder zu automatischem Java.",
  warnLegacyModded: "Minecraft {mc} mit Mods ist für Java 8 ausgelegt, aber diese Instanz verwendet Java {current}. Falls sie nicht startet, wechsle in den Instanzeinstellungen wieder zu automatischem Java.",
  spawnFailed: "Java konnte nicht gestartet werden: {error}",
};
