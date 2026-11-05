package com.venuslauncher.badge;

import net.minecraft.client.Minecraft;

/**
 * Los FPS que lee el launcher, para Forge y NeoForge (nombres oficiales de Mojang, los mismos en 1.20.1 y 1.21.1). En Fabric
 * están en VenusBadge. Aparte de BadgeText para que el hilo de los FPS no cargue las clases de texto de Minecraft antes de tiempo.
 */
public final class BadgeGame {
	private BadgeGame() {}

	// Corre en el hilo de PerfReporter: solo lee campos del cliente.
	public static int fpsInWorld() {
		Minecraft client = Minecraft.getInstance();
		return client == null || client.level == null || client.isPaused() ? PerfReporter.NO_WORLD : client.getFps();
	}
}
