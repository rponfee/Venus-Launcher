package com.venuslauncher.badge;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Lo que la insignia hace igual en todos los loaders, sin una sola clase de Minecraft: el servidor (config/venus-badge.json,
 * que escribe el launcher; sin ese archivo usa el de siempre), el hilo que le pregunta y los estilos. Cada loader solo
 * llama a {@link #start} al iniciar y a {@link #style} y {@link #glyph} para armar el nombre con sus propias clases, y a
 * {@link #cape} para saber qué capa dibujar.
 */
public final class BadgeCore {
	public static final String MOD_ID = "venusbadge";
	public static final String CONFIG_FILE = "venus-badge.json";
	static final Logger LOG = LoggerFactory.getLogger("Venus Badge");
	// El proyecto de Supabase del launcher (src/main/core/cloud-defaults.js). La anon key es pública por diseño.
	static final String DEFAULT_URL = "https://dzchklzaxyygbvfpagvx.supabase.co";
	static final String DEFAULT_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR6Y2hrbHpheHl5Z2J2ZnBhZ3Z4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTMxNDA2NDYsImV4cCI6MjEwODcxNjY0Nn0.OwCJ2uTTO0IXECEKhwPk3Qha-NRN7PXd_2v6VPzJyzg";
	// Estilos de la insignia: cada uno es un carácter de uso privado (U+E000 en adelante, en este orden) que la fuente
	// venusbadge:badge dibuja como el planeta (assets/venusbadge/font/badge.json; los genera scripts/make-badge-icon.py).
	// gold = premium; nebula e ice se compran con Venus Points. Un estilo desconocido usa el de siempre.
	static final List<String> STYLES = List.of("default", "gold", "nebula", "ice");

	private static volatile BadgeCache cache;
	private static volatile BadgeCache capes;
	private static volatile boolean showOtherCapes = true;

	private BadgeCore() {}

	/** El carácter de la fuente venusbadge:badge para este estilo. */
	public static String glyph(String style) {
		int i = STYLES.indexOf(style);
		return String.valueOf((char) (0xE000 + Math.max(i, 0)));
	}

	/** El estilo de la insignia del jugador, o null si no la tiene, todavía no se sabe o el mod no arrancó. */
	public static String style(UUID id) {
		BadgeCache c = cache;
		return c == null ? null : c.style(id);
	}

	/**
	 * La capa de Venus del jugador (un id de {@link Capes}) o null. Con las capas ajenas apagadas (own = false) ni se pregunta
	 * al servidor por ese jugador. Solo se llama si Mojang no le da una capa: la oficial tiene prioridad.
	 */
	public static String cape(UUID id, boolean own) {
		BadgeCache c = capes;
		return c == null || (!own && !showOtherCapes) ? null : c.style(id);
	}

	/** Arranca el hilo que consulta al servidor. No toca Minecraft: se puede llamar desde cualquier hilo al cargar el mod. */
	public static void start(Path configFile, String modVersion) {
		Server server = server(configFile);
		BadgeClient client = new BadgeClient(server.url(), server.anonKey(), "VenusBadge/" + modVersion);
		BadgeCache c = new BadgeCache(client, System::currentTimeMillis);
		BadgeCache k = new BadgeCache(client::fetchCapes, System::currentTimeMillis);
		Thread worker = new Thread(() -> {
			while (!Thread.currentThread().isInterrupted()) {
				try {
					Thread.sleep(Math.min(c.tick(), k.tick()));
				} catch (InterruptedException err) {
					return;
				} catch (RuntimeException err) {
					LOG.debug("Venus Badge", err);
				}
			}
		}, "Venus Badge");
		worker.setDaemon(true);
		worker.start();
		showOtherCapes = showCapes(configFile);
		capes = k;
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

	// "showCapes": false en el mismo archivo apaga las capas de los demás (la propia se sigue viendo). Lo escribe el launcher:
	// Venus Points → Tienda → Capas. Cualquier otra cosa, o el archivo roto, las deja prendidas.
	static boolean showCapes(Path file) {
		try {
			if (!Files.isRegularFile(file)) return true;
			JsonElement value = JsonParser.parseString(Files.readString(file)).getAsJsonObject().get("showCapes");
			return value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isBoolean() || value.getAsBoolean();
		} catch (Exception err) {
			return true;
		}
	}
}
