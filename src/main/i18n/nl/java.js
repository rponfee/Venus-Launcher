'use strict';
module.exports = {
  downloadLabel: "Java {major}",
  preparing: "Java {major} voorbereiden...",
  downloadingAdoptium: "Java {major} downloaden (Adoptium)...",
  extracting: "Java {major} uitpakken...",
  errInstall: "Java {major} kon niet worden geïnstalleerd: {error}",
  errNoAdoptium: "Adoptium publiceert geen Java {major} voor dit systeem",
  errNotFound: "Java {major} is gedownload, maar werkt niet op deze pc. Probeer het opnieuw of kies zelf een Java in de instellingen van de instantie.",
  errOffline: "Deze versie heeft Java {major} nodig en die is nog niet geïnstalleerd. Maak verbinding met internet om die te downloaden (dat hoeft maar één keer).",
  warnBroken: "De Java die voor deze instantie is gekozen reageert niet ({path}). Schakel in de instellingen van de instantie terug naar automatische Java.",
  warnTooOld: "Minecraft {mc} heeft Java {required} of nieuwer nodig, maar deze instantie gebruikt Java {current} (handmatig gekozen). De instantie kan zo niet starten: schakel in de instellingen van de instantie terug naar automatische Java.",
  warnLegacyModded: "Minecraft {mc} met mods is bedoeld voor Java 8, maar deze instantie gebruikt Java {current}. Als de instantie niet start, schakel dan in de instellingen van de instantie terug naar automatische Java.",
  spawnFailed: "Java kon niet worden gestart: {error}",
};
