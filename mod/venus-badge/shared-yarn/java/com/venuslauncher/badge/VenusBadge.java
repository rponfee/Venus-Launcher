package com.venuslauncher.badge;

import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.client.MinecraftClient;
import net.minecraft.text.MutableText;
import net.minecraft.text.Style;
import net.minecraft.text.Text;
import net.minecraft.util.Identifier;

/**
 * Insignia de Venus en Fabric y Quilt: el planeta de Venus Launcher (un carácter de la fuente venusbadge:badge) antes del
 * nombre de los jugadores que la activaron en el launcher, sobre la cabeza y en la lista de jugadores (Tab). También da la
 * textura de las capas de Venus y los FPS que lee el launcher.
 * El resto de la lógica, común a todos los loaders, está en {@link BadgeCore}.
 */
public final class VenusBadge implements ClientModInitializer {
	// tryParse se llama igual en 1.20.1 y 1.21.1 (Identifier.of todavía no existe en 1.20.1).
	private static final Style ICON_STYLE = Style.EMPTY.withFont(Identifier.tryParse(BadgeCore.MOD_ID + ":badge")).withColor(0xFFFFFF);
	private static final Map<String, Identifier> CAPES = new HashMap<>();

	static {
		for (String id : Capes.IDS) CAPES.put(id, Identifier.tryParse(BadgeCore.MOD_ID + ":" + Capes.texturePath(id)));
	}

	@Override
	public void onInitializeClient() {
		String version = FabricLoader.getInstance().getModContainer(BadgeCore.MOD_ID).map(m -> m.getMetadata().getVersion().getFriendlyString()).orElse("?");
		BadgeCore.start(FabricLoader.getInstance().getConfigDir().resolve(BadgeCore.CONFIG_FILE), version);
		PerfReporter.start(FabricLoader.getInstance().getGameDir(), VenusBadge::fpsInWorld);
	}

	/** El nombre con la insignia adelante, o el mismo nombre si el jugador no la tiene (o todavía no se sabe). */
	public static Text decorate(UUID id, Text name) {
		if (name == null || hasIcon(name)) return name;
		String style = BadgeCore.style(id);
		if (style == null) return name;
		MutableText out = Text.empty();
		out.append(Text.literal(BadgeCore.glyph(style)).setStyle(ICON_STYLE));
		out.append(Text.literal(" "));
		out.append(name);
		return out;
	}

	private static boolean hasIcon(Text text) {
		return !text.getSiblings().isEmpty() && ICON_STYLE.getFont().equals(text.getSiblings().get(0).getStyle().getFont());
	}

	/** La textura de la capa de Venus del jugador, o null si no tiene (o todavía no se sabe). Sale de la memoria: va en cada cuadro. */
	public static Identifier capeTexture(UUID id, boolean own) {
		String cape = BadgeCore.cape(id, own);
		return cape == null ? null : CAPES.get(cape);
	}

	// Corre en el hilo de PerfReporter: solo lee campos del cliente.
	private static int fpsInWorld() {
		MinecraftClient client = MinecraftClient.getInstance();
		return client == null || client.world == null || client.isPaused() ? PerfReporter.NO_WORLD : client.getCurrentFps();
	}
}
