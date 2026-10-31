'use strict';
module.exports = {
  downloadLabel: "Java {major}",
  preparing: "Java {major} 준비 중...",
  downloadingAdoptium: "Java {major} 다운로드 중 (Adoptium)...",
  extracting: "Java {major} 압축 푸는 중...",
  errInstall: "Java {major} 설치에 실패했어요: {error}",
  errNoAdoptium: "Adoptium에서 이 시스템용 Java {major} 버전을 제공하지 않아요",
  errNotFound: "Java {major} 버전을 다운로드했지만 이 PC에서 작동하지 않아요. 다시 시도하거나 인스턴스 설정에서 Java를 직접 선택해 주세요.",
  errOffline: "이 버전을 실행하려면 Java {major} 버전이 필요하지만 아직 설치되어 있지 않아요. 인터넷에 연결해서 다운로드해 주세요 (처음 한 번만 하면 돼요).",
  warnBroken: "이 인스턴스에 선택된 Java가 응답하지 않아요 ({path}). 인스턴스 설정에서 Java를 자동으로 되돌려 주세요.",
  warnTooOld: "Minecraft {mc}에는 Java {required} 이상이 필요하지만, 이 인스턴스는 직접 선택한 Java {current} 버전을 사용하고 있어요. 이대로는 실행할 수 없으니 인스턴스 설정에서 Java를 자동으로 되돌려 주세요.",
  warnLegacyModded: "모드를 사용하는 Minecraft {mc} 버전은 Java 8에 맞춰져 있지만, 이 인스턴스는 Java {current} 버전을 사용하고 있어요. 실행되지 않으면 인스턴스 설정에서 Java를 자동으로 되돌려 주세요.",
  spawnFailed: "Java를 실행하지 못했어요: {error}",
};
