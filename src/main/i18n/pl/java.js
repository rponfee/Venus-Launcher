'use strict';
module.exports = {
  downloadLabel: "Java {major}",
  preparing: "Przygotowywanie Java {major}...",
  downloadingAdoptium: "Pobieranie Java {major} (Adoptium)...",
  extracting: "Wyodrębnianie Java {major}...",
  errInstall: "Nie udało się zainstalować Java {major}: {error}",
  errNoAdoptium: "Adoptium nie publikuje Java {major} dla tego systemu",
  errNotFound: "Pobrano Java {major}, ale nie działa ona na tym komputerze. Spróbuj ponownie albo wskaż ręcznie własną wersję Java w ustawieniach instancji.",
  errOffline: "Do tej wersji potrzebna jest Java {major}, a nie jest jeszcze zainstalowana. Połącz się z internetem, aby ją pobrać (robi się to tylko raz).",
  warnBroken: "Wybrana dla tej instancji Java nie odpowiada ({path}). W ustawieniach instancji wróć do automatycznej wersji Java.",
  warnTooOld: "Minecraft {mc} wymaga wersji Java {required} lub nowszej, ale ta instancja używa wersji Java {current} (wybranej ręcznie). Nie uruchomi się: w ustawieniach instancji wróć do automatycznej wersji Java.",
  warnLegacyModded: "Minecraft {mc} z modami jest przeznaczony dla wersji Java 8, ale ta instancja używa wersji Java {current}. Jeśli się nie uruchomi, wróć do automatycznej wersji Java w ustawieniach instancji.",
  spawnFailed: "Nie udało się uruchomić Java: {error}",
};
