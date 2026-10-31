'use strict';
module.exports = {
  downloadLabel: "Java {major}",
  preparing: "Java {major}を準備中...",
  downloadingAdoptium: "Java {major}（Adoptium）をダウンロード中...",
  extracting: "Java {major}を展開中...",
  errInstall: "Java {major}をインストールできませんでした：{error}",
  errNoAdoptium: "Adoptiumは、このシステム向けのJava {major}を公開していません",
  errNotFound: "Java {major}をダウンロードしましたが、このPCでは動作しません。もう一度お試しいただくか、インスタンスの設定でJavaを手動で選択してください。",
  errOffline: "このバージョンにはJava {major}が必要ですが、まだインストールされていません。インターネットに接続してダウンロードしてください（一度だけで済みます）。",
  warnBroken: "このインスタンスで選択されているJavaが応答しません（{path}）。インスタンスの設定で、自動Javaに戻してください。",
  warnTooOld: "Minecraft {mc}にはJava {required}以降が必要ですが、このインスタンスはJava {current}（手動で選択）を使用しています。起動できません。インスタンスの設定で、自動Javaに戻してください。",
  warnLegacyModded: "Modを入れたMinecraft {mc}はJava 8向けですが、このインスタンスはJava {current}を使用しています。起動しない場合は、インスタンスの設定で自動Javaに戻してください。",
  spawnFailed: "Javaを起動できませんでした：{error}",
};
