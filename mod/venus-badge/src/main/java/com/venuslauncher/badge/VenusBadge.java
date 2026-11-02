package com.venuslauncher.badge;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.UUID;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.text.MutableText;
import net.minecraft.text.Style;
import net.minecraft.text.Text;
import net.minecraft.util.Identifier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Insignia de Venus: el planeta de Venus Launcher (un carácter de la fuente venusbadge:badge) antes del nombre
 * de los jugadores que la activaron en el launcher, sobre la cabeza y en la lista de jugadores (Tab).
 * El launcher escribe config/venus-badge.json con el servidor ({"url", "anonKey"}); sin ese archivo usa el de siempre.
 */
public final class VenusBadge implements ClientModInitializer {
	public static final String MOD_ID = "venusbadge";
	static final Logger LOG = LoggerFactory.getLogger("Venus Badge");
	// El proyecto de Supabase del launcher (src/main/core/cloud-defaults.js). La anon key es pública por diseño.
	static final String DEFAULT_URL = "https://dzchklzaxyygbvfpagvx.supabase.co";
	static final String DEFAULT_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR6Y2hrbHpheHl5Z2J2ZnBhZ3Z4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTMxNDA2NDYsImV4cCI6MjEwODcxNjY0Nn0.OwCJ2uTTO0IXECEKhwPk3Qha-NRN7PXd_2v6VPzJyzg";
	// Estilos de la insignia: cada uno es un carácter de uso privado (U+E000 en adelante, en este orden) que la fuente
	// venusbadge:badge dibuja como el planeta (assets/venusbadge/font/badge.json; los genera scripts/make-badge-icon.py).
	// gold = premium; nebula e ice se compran con Venus Points. Un estilo desconocido usa el de siempre.
	static final List<String> STYLES = List.of("default", "gold", "nebula", "ice");
	private static final Style ICON_STYLE = Style.EMPTY.withFont(Identifier.of(MOD_ID, "badge")).withColor(0xFFFFFF);

	static String glyph(String style) {
		int i = STYLES.indexOf(style);
		return String.valueOf((char) (0xE000 + Math.max(i, 0)));
	}

	private static volatile BadgeCache cache;

	@Override
	public void onInitializeClient() {
		Server server = server(FabricLoader.getInstance().getConfigDir().resolve("venus-badge.json"));
		String version = FabricLoader.getInstance().getModContainer(MOD_ID).map(m -> m.getMetadata().getVersion().getFriendlyString()).orElse("?");
		BadgeClient client = new BadgeClient(server.url(), server.anonKey(), "VenusBadge/" + version);
		BadgeCache c = new BadgeCache(client, System::currentTimeMillis);
		Thread worker = new Thread(() -> {
			while (!Thread.currentThread().isInterrupted()) {
				try {
					Thread.sleep(c.tick());
				} catch (InterruptedException err) {
					return;
				} catch (RuntimeException err) {
					LOG.debug("Venus Badge", err);
				}
			}
		}, "Venus Badge");
		worker.setDaemon(true);
		worker.start();
		cache = c;
	}

	record Server(String url, String anonKey) {}

	// https, o http solo a la PC (el stack local de Supabase para probar); si no, el servidor de siempre.
	static Server server(Path file) {
		try {
			if (Files.isRegularFile(file)) {
				JsonObject cfg = JsonParser.parseString(Files.readString(file)).getAsJsonObject();
				String url = cfg.has("url") ? cfg.get("url").getAsString().replaceAll("/+$", "") : "";
				String key = cfg.has("anonKey") ? cfg.get("anonKey").getAsString().trim() : "";
				if (!key.isEmpty() && url.matches("https://[^\\s/]+|http://(127\\.0\\.0\\.1|localhost)(:\\d+)?")) return new Server(url, key);
			}
		} catch (Exception err) {
			LOG.warn("No se pudo leer {}: {}", file, err.toString());
		}
		return new Server(DEFAULT_URL, DEFAULT_KEY);
	}

	/** El nombre con la insignia adelante, o el mismo nombre si el jugador no la tiene (o todavía no se sabe). */
	public static Text decorate(UUID id, Text name) {
		BadgeCache c = cache;
		if (c == null || name == null || hasIcon(name)) return name;
		String style = c.style(id);
		if (style == null) return name;
		MutableText out = Text.empty();
		out.append(Text.literal(glyph(style)).setStyle(ICON_STYLE));
		out.append(Text.literal(" "));
		out.append(name);
		return out;
	}

	private static boolean hasIcon(Text text) {
		return !text.getSiblings().isEmpty() && ICON_STYLE.getFont().equals(text.getSiblings().get(0).getStyle().getFont());
	}
}
