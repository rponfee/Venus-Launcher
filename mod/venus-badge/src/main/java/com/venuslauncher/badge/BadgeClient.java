package com.venuslauncher.badge;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Consulta badge_styles en el servidor de Venus (Supabase, migraciones 0019 y 0021). Solo manda los UUID de los
 * jugadores que se ven en pantalla (ni nombres, ni servidor, ni nada de la cuenta) y recibe cuáles de esos tienen
 * la insignia y con qué estilo. Si el servidor todavía no tiene badge_styles (404), usa badge_lookup (todas con el
 * estilo de siempre). La clave es la "anon key" pública del proyecto: no da acceso a nada más que a estas consultas.
 */
final class BadgeClient implements BadgeCache.Fetcher {
	private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
	private final String baseUrl;
	private final String apiKey;
	private final String userAgent;
	private volatile boolean legacy;

	BadgeClient(String baseUrl, String apiKey, String userAgent) {
		this.baseUrl = baseUrl;
		this.apiKey = apiKey;
		this.userAgent = userAgent;
	}

	@Override
	public Map<UUID, String> fetch(List<UUID> batch) throws IOException {
		JsonObject body = body(batch);
		if (!legacy) {
			HttpResponse<String> res = post("badge_styles", body);
			if (res.statusCode() == 200) return parseStyles(res.body());
			if (res.statusCode() != 404) throw new IOException("HTTP " + res.statusCode());
			legacy = true;
		}
		HttpResponse<String> res = post("badge_lookup", body);
		if (res.statusCode() != 200) throw new IOException("HTTP " + res.statusCode());
		return parseLookup(res.body());
	}

	private static JsonObject body(List<UUID> batch) {
		JsonArray ids = new JsonArray();
		for (UUID id : batch) ids.add(id.toString());
		JsonObject body = new JsonObject();
		body.add("p_uuids", ids);
		return body;
	}

	private HttpResponse<String> post(String rpc, JsonObject body) throws IOException {
		HttpRequest req = HttpRequest.newBuilder(URI.create(baseUrl + "/rest/v1/rpc/" + rpc))
				.timeout(Duration.ofSeconds(8))
				.header("Content-Type", "application/json")
				.header("User-Agent", userAgent)
				.header("apikey", apiKey)
				.header("Authorization", "Bearer " + apiKey)
				.POST(HttpRequest.BodyPublishers.ofString(body.toString()))
				.build();
		try {
			return http.send(req, HttpResponse.BodyHandlers.ofString());
		} catch (InterruptedException err) {
			Thread.currentThread().interrupt();
			throw new IOException("interrumpido", err);
		}
	}

	/** [{ "mc_uuid": "...", "style": "gold" }, ...] */
	static Map<UUID, String> parseStyles(String json) throws IOException {
		Map<UUID, String> out = new HashMap<>();
		try {
			for (JsonElement el : JsonParser.parseString(json).getAsJsonArray()) {
				JsonObject o = el.getAsJsonObject();
				String style = o.has("style") && !o.get("style").isJsonNull() ? o.get("style").getAsString() : "default";
				out.put(UUID.fromString(o.get("mc_uuid").getAsString()), style);
			}
		} catch (RuntimeException err) {
			throw new IOException("respuesta inválida", err);
		}
		return out;
	}

	/** ["uuid", ...] (badge_lookup de 0019) */
	static Map<UUID, String> parseLookup(String json) throws IOException {
		Map<UUID, String> out = new HashMap<>();
		try {
			for (JsonElement el : JsonParser.parseString(json).getAsJsonArray()) out.put(UUID.fromString(el.getAsString()), "default");
		} catch (RuntimeException err) {
			throw new IOException("respuesta inválida", err);
		}
		return out;
	}
}
