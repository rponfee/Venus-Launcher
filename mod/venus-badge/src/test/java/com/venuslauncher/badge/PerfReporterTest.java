package com.venuslauncher.badge;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class PerfReporterTest {
	@TempDir
	Path game;

	private Path file() {
		return game.resolve("venus").resolve("perf.json");
	}

	@Test
	void writesTheFormatTheLauncherReads() throws IOException {
		PerfReporter r = new PerfReporter(game, () -> 144, () -> 1_700_000_000_123L);
		assertTrue(r.tick());
		JsonObject json = JsonParser.parseString(Files.readString(file())).getAsJsonObject();
		assertEquals(144, json.get("fps").getAsInt());
		assertEquals(1_700_000_000_123L, json.get("at").getAsLong());
		assertFalse(Files.exists(game.resolve("venus").resolve("perf.json.tmp")), "no deja el temporal");
	}

	@Test
	void replacesTheFileAndStopsWritingWhenLeavingTheWorld() throws IOException {
		AtomicInteger fps = new AtomicInteger(60);
		PerfReporter r = new PerfReporter(game, fps::get, () -> 1000);
		assertTrue(r.tick());
		fps.set(61);
		assertTrue(r.tick());
		assertEquals("{\"fps\":61,\"at\":1000}", Files.readString(file()));
		fps.set(PerfReporter.NO_WORLD);
		assertFalse(r.tick());
		assertEquals("{\"fps\":61,\"at\":1000}", Files.readString(file()), "queda el último: el launcher lo descarta por viejo");
	}

	@Test
	void withoutAWorldNothingIsCreated() {
		assertFalse(new PerfReporter(game, () -> PerfReporter.NO_WORLD, () -> 1000).tick());
		assertFalse(Files.exists(game.resolve("venus")));
	}

	@Test
	void problemsDoNotReachTheGame() throws IOException {
		// La carpeta venus es un archivo: no se puede escribir
		Files.writeString(game.resolve("venus"), "");
		assertFalse(new PerfReporter(game, () -> 60, () -> 1000).tick());
		// La fuente de FPS falla
		assertFalse(new PerfReporter(game, () -> {
			throw new IllegalStateException("sin cliente");
		}, () -> 1000).tick());
	}
}
