package com.venuslauncher.badge;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class BadgeCoreTest {
	private static final BadgeCore.Server DEFAULT = new BadgeCore.Server(BadgeCore.DEFAULT_URL, BadgeCore.DEFAULT_KEY);

	@TempDir
	Path dir;

	private BadgeCore.Server read(String json) throws IOException {
		Path file = dir.resolve(BadgeCore.CONFIG_FILE);
		Files.writeString(file, json);
		return BadgeCore.server(file);
	}

	@Test
	void withoutConfigUsesTheUsualServer() {
		assertEquals(DEFAULT, BadgeCore.server(dir.resolve("no-existe.json")));
	}

	@Test
	void readsTheServerTheLauncherWrote() throws IOException {
		assertEquals(new BadgeCore.Server("https://otro.supabase.co", "clave"), read("{\"url\":\"https://otro.supabase.co/\",\"anonKey\":\" clave \"}"));
		assertEquals(new BadgeCore.Server("http://127.0.0.1:54321", "clave"), read("{\"url\":\"http://127.0.0.1:54321\",\"anonKey\":\"clave\"}"));
	}

	@Test
	void rejectsUnsafeOrBrokenConfig() throws IOException {
		assertEquals(DEFAULT, read("{\"url\":\"http://ejemplo.com\",\"anonKey\":\"clave\"}"));
		assertEquals(DEFAULT, read("{\"url\":\"https://ejemplo.com/otra/ruta\",\"anonKey\":\"clave\"}"));
		assertEquals(DEFAULT, read("{\"url\":\"https://ejemplo.com\",\"anonKey\":\"\"}"));
		assertEquals(DEFAULT, read("esto no es json"));
	}
}
