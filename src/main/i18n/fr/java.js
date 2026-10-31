'use strict';
module.exports = {
  downloadLabel: "Java {major}",
  preparing: "Préparation de Java {major}...",
  downloadingAdoptium: "Téléchargement de Java {major} (Adoptium)...",
  extracting: "Extraction de Java {major}...",
  errInstall: "Impossible d'installer Java {major} : {error}",
  errNoAdoptium: "Adoptium ne publie pas Java {major} pour ce système",
  errNotFound: "Java {major} a été téléchargé, mais ne fonctionne pas sur ce PC. Réessayez ou choisissez un Java manuellement dans les paramètres de l'instance.",
  errOffline: "Cette version nécessite Java {major}, qui n'est pas encore installé. Connectez-vous à internet pour le télécharger (une seule fois).",
  warnBroken: "Le Java choisi pour cette instance ne répond pas ({path}). Dans les paramètres de l'instance, revenez à Java automatique.",
  warnTooOld: "Minecraft {mc} nécessite Java {required} ou plus récent, mais cette instance utilise Java {current} (choisi manuellement). Elle ne pourra pas démarrer : dans les paramètres de l'instance, revenez à Java automatique.",
  warnLegacyModded: "Minecraft {mc} avec des mods est conçu pour Java 8, mais cette instance utilise Java {current}. Si elle ne démarre pas, revenez à Java automatique dans les paramètres de l'instance.",
  spawnFailed: "Impossible de démarrer Java : {error}",
};
