'use strict';
module.exports = {
  downloadLabel: "Java {major}",
  preparing: "Preparando o Java {major}...",
  downloadingAdoptium: "Baixando o Java {major} (Adoptium)...",
  extracting: "Extraindo o Java {major}...",
  errInstall: "Não foi possível instalar o Java {major}: {error}",
  errNoAdoptium: "A Adoptium não publica o Java {major} para este sistema",
  errNotFound: "O Java {major} foi baixado, mas não funciona neste PC. Tente de novo ou escolha um Java manualmente nas configurações da instância.",
  errOffline: "Esta versão precisa do Java {major}, que ainda não está instalado. Conecte-se à internet para baixá-lo (isso só é feito uma vez).",
  warnBroken: "O Java escolhido para esta instância não responde ({path}). Nas configurações da instância, volte para o Java automático.",
  warnTooOld: "O Minecraft {mc} precisa do Java {required} ou mais recente, mas esta instância usa o Java {current} (escolhido manualmente). Ela não vai conseguir iniciar: nas configurações da instância, volte para o Java automático.",
  warnLegacyModded: "O Minecraft {mc} com mods foi pensado para o Java 8, mas esta instância usa o Java {current}. Se ela não iniciar, volte para o Java automático nas configurações da instância.",
  spawnFailed: "Não foi possível iniciar o Java: {error}",
};
