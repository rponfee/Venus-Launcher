'use strict';
module.exports = {
  downloadLabel: "Java {major}",
  preparing: "Java {major} hazırlanıyor...",
  downloadingAdoptium: "Java {major} indiriliyor (Adoptium)...",
  extracting: "Java {major} çıkarılıyor...",
  errInstall: "Java {major} yüklenemedi: {error}",
  errNoAdoptium: "Adoptium bu sistem için Java {major} yayınlamıyor",
  errNotFound: "Java {major} indirildi ama bu bilgisayarda çalışmıyor. Tekrar dene ya da örnek ayarlarından elle bir Java seç.",
  errOffline: "Bu sürüm için Java {major} gerekli ve henüz yüklü değil. İndirmek için internete bağlan (yalnızca bir kez yapılır).",
  warnBroken: "Bu örnek için seçilen Java yanıt vermiyor ({path}). Örnek ayarlarından otomatik Java'ya dön.",
  warnTooOld: "Minecraft {mc}, Java {required} veya daha yenisini gerektiriyor ama bu örnek Java {current} kullanıyor (elle seçilmiş). Başlayamaz: örnek ayarlarından otomatik Java'ya dön.",
  warnLegacyModded: "Modlu Minecraft {mc}, Java 8 için tasarlanmış ama bu örnek Java {current} kullanıyor. Açılmazsa örnek ayarlarından otomatik Java'ya dön.",
  spawnFailed: "Java başlatılamadı: {error}",
  errRosetta: "Minecraft'ın bu sürümünün Apple Silicon sürümü yok, bu yüzden Rosetta 2 üzerinden Intel için Java {major} ile çalışır; ancak Rosetta 2 bu Mac'te kurulu değil. Terminal'i aç, softwareupdate --install-rosetta --agree-to-license komutunu çalıştır ve tekrar oyna.",
};
