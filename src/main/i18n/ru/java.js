'use strict';
module.exports = {
  downloadLabel: "Java {major}",
  preparing: "Подготовка Java {major}...",
  downloadingAdoptium: "Загрузка Java {major} (Adoptium)...",
  extracting: "Распаковка Java {major}...",
  errInstall: "Не удалось установить Java {major}: {error}",
  errNoAdoptium: "Adoptium не публикует Java {major} для этой системы",
  errNotFound: "Java {major} скачана, но не работает на этом ПК. Попробуйте снова или выберите Java вручную в настройках экземпляра.",
  errOffline: "Для этой версии нужна Java {major}, а она ещё не установлена. Подключитесь к интернету, чтобы скачать её (это делается один раз).",
  warnBroken: "Java, выбранная для этого экземпляра, не отвечает ({path}). В настройках экземпляра вернитесь к автоматической Java.",
  warnTooOld: "Для Minecraft {mc} нужна Java {required} или новее, но этот экземпляр использует Java {current} (выбрана вручную). Он не сможет запуститься: в настройках экземпляра вернитесь к автоматической Java.",
  warnLegacyModded: "Minecraft {mc} с модами рассчитан на Java 8, но этот экземпляр использует Java {current}. Если игра не запускается, вернитесь к автоматической Java в настройках экземпляра.",
  spawnFailed: "Не удалось запустить Java: {error}",
};
