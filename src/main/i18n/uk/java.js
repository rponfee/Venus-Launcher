'use strict';
module.exports = {
  downloadLabel: "Java {major}",
  preparing: "Підготовка Java {major}...",
  downloadingAdoptium: "Завантаження Java {major} (Adoptium)...",
  extracting: "Розпакування Java {major}...",
  errInstall: "Не вдалося встановити Java {major}: {error}",
  errNoAdoptium: "Adoptium не публікує Java {major} для цієї системи",
  errNotFound: "Java {major} завантажено, але вона не працює на цьому ПК. Спробуйте ще раз або виберіть Java вручну в налаштуваннях екземпляра.",
  errOffline: "Ця версія потребує Java {major}, а її ще не встановлено. Підключіться до інтернету, щоб завантажити її (це робиться лише один раз).",
  warnBroken: "Java, вибрана для цього екземпляра, не відповідає ({path}). У налаштуваннях екземпляра поверніться до автоматичного вибору Java.",
  warnTooOld: "Minecraft {mc} потребує Java {required} або новішої, але цей екземпляр використовує Java {current} (вибрану вручну). Гра не зможе запуститися: у налаштуваннях екземпляра поверніться до автоматичного вибору Java.",
  warnLegacyModded: "Minecraft {mc} з модами розрахований на Java 8, але цей екземпляр використовує Java {current}. Якщо гра не запускається, поверніться до автоматичного вибору Java в налаштуваннях екземпляра.",
  spawnFailed: "Не вдалося запустити Java: {error}",
};
