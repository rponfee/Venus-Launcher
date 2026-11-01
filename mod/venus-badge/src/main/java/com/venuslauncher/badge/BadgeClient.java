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
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;

/**
 * Consulta badge_lookup en el servidor de Venus (Supabase, migración 0019_insignia.sql). Solo manda los UUID de los
 * jugadores que se ven en pantalla (ni nombres, ni servidor, ni nada de la cuenta) y recibe cuáles de esos tienen
 * la insignia. La clave es la "anon key" pública del proyecto: no da acceso a nada más que a esta consulta.
 */
final class BadgeClient implements BadgeCache.Fetcher {
	private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
	private final URI endpoint;
	private final String apiKey;
	private final String userAgent;

	BadgeClient(URI endpoint, String apiKey, String userAgent) {
		this.endpoint = endpoint;
		this.apiKey = apiKey;
		this.userAgent = userAgent;
	}

	@Override
	public Set<UUID> fetch(List<UUID> batch) throws IOException {
		JsonArray ids = new JsonArray();
		for (UUID id : batch) ids.add(id.toString());
		JsonObject body = new JsonObject();
		body.add("p_uuids", ids);
		HttpRequest req = HttpRequest.newBuilder(endpoint)
				.timeout(Duration.ofSeconds(8))
				.header("Content-Type", "application/json")
				.header("User-Agent", userAgent)
				.header("apikey", apiKey)
				.header("Authorization", "Bearer " + apiKey)
				.POST(HttpRequest.BodyPublishers.ofString(body.toString()))
				.build();
		HttpResponse<String> res;
		try {
			res = http.send(req, HttpResponse.BodyHandlers.ofString());
		} catch (InterruptedException err) {
			Thread.currentThread().interrupt();
			throw new IOException("interrumpido", err);
		}
		if (res.statusCode() != 200) throw new IOException("HTTP " + res.statusCode());
		return parse(res.body());
	}

	static Set<UUID> parse(String json) throws IOException {
		Set<UUID> out = new HashSet<>();
		try {
			for (JsonElement el : JsonParser.parseString(json).getAsJsonArray()) out.add(UUID.fromString(el.getAsString()));
		} catch (RuntimeException err) {
			throw new IOException("respuesta inválida", err);
		}
		return out;
	}
}
