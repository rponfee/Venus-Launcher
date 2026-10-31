'use strict';
module.exports = {
  downloadLabel: "Java {major}",
  preparing: "正在准备 Java {major}...",
  downloadingAdoptium: "正在下载 Java {major}（Adoptium）...",
  extracting: "正在解压 Java {major}...",
  errInstall: "无法安装 Java {major}：{error}",
  errNoAdoptium: "Adoptium 没有为此系统发布 Java {major}",
  errNotFound: "已下载 Java {major}，但它无法在这台电脑上运行。请重试，或在实例设置中手动选择一个 Java。",
  errOffline: "这个版本需要 Java {major}，而它尚未安装。请联网下载（只需下载一次）。",
  warnBroken: "为这个实例选择的 Java 没有响应（{path}）。请在实例设置中改回自动 Java。",
  warnTooOld: "Minecraft {mc} 需要 Java {required} 或更高版本，但这个实例使用的是 Java {current}（手动选择的）。它将无法启动：请在实例设置中改回自动 Java。",
  warnLegacyModded: "带模组的 Minecraft {mc} 是为 Java 8 设计的，但这个实例使用的是 Java {current}。如果无法启动，请在实例设置中改回自动 Java。",
  spawnFailed: "无法启动 Java：{error}",
};
