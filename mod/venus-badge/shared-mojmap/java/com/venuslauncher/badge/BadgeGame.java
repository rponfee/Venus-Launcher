package com.venuslauncher.badge;

import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import net.minecraft.client.Minecraft;
import net.minecraft.resources.ResourceLocation;

/**
 * La textura de las capas de Venus y los FPS que lee el launcher, para Forge y NeoForge (nombres oficiales de Mojang, los
 * mismos en 1.20.1 y 1.21.1). En Fabric están en VenusBadge. Aparte de BadgeText para que el hilo de los FPS no cargue las
 * clases de texto de Minecraft antes de tiempo.
 */
public final class BadgeGame {
	private static final Map<String, ResourceLocation> CAPES = new HashMap<>();

	static {
		// tryParse se llama igual en 1.20.1 y 1.21.1 (el constructor público de ResourceLocation se fue en 1.21).
		for (String id : Capes.IDS) CAPES.put(id, ResourceLocation.tryParse(BadgeCore.MOD_ID + ":" + Capes.texturePath(id)));
	}

	private BadgeGame() {}

	/** La textura de la capa de Venus del jugador, o null si no tiene (o todavía no se sabe). Sale de la memoria: va en cada cuadro. */
	public static ResourceLocation capeTexture(UUID id, boolean own) {
		String cape = BadgeCore.cape(id, own);
		return cape == null ? null : CAPES.get(cape);
	}

	// Corre en el hilo de PerfReporter: solo lee campos del cliente.
	public static int fpsInWorld() {
		Minecraft client = Minecraft.getInstance();
		return client == null || client.level == null || client.isPaused() ? PerfReporter.NO_WORLD : client.getFps();
	}
}
