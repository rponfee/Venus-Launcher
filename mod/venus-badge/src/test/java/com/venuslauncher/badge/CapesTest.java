package com.venuslauncher.badge;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.awt.image.BufferedImage;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;
import javax.imageio.ImageIO;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class CapesTest {
	private final UUID a = UUID.fromString("00000000-0000-4000-8000-000000000001");
	private final UUID b = UUID.fromString("00000000-0000-4000-8000-000000000002");

	@TempDir
	Path dir;

	@Test
	void parsesTheServerAnswer() throws IOException {
		assertEquals(Map.of(a, "dawn", b, "orbit"),
				BadgeClient.parseCapes("[{\"mc_uuid\":\"" + a + "\",\"cape\":\"dawn\"},{\"mc_uuid\":\"" + b + "\",\"cape\":\"orbit\"}]"));
		assertEquals(Map.of(), BadgeClient.parseCapes("[]"));
	}

	@Test
	void unknownOrMissingCapesAreIgnored() throws IOException {
		assertEquals(Map.of(b, "nebula"), BadgeClient.parseCapes(
				"[{\"mc_uuid\":\"" + a + "\",\"cape\":\"capa-nueva\"},{\"mc_uuid\":\"" + b + "\",\"cape\":\"nebula\"}]"));
		assertEquals(Map.of(), BadgeClient.parseCapes("[{\"mc_uuid\":\"" + a + "\",\"cape\":null}]"));
		assertEquals(Map.of(), BadgeClient.parseCapes("[{\"mc_uuid\":\"" + a + "\"}]"));
		// Nunca se toma un id como ruta ni como URL
		assertEquals(Map.of(), BadgeClient.parseCapes("[{\"mc_uuid\":\"" + a + "\",\"cape\":\"../../evil\"},{\"mc_uuid\":\"" + b + "\",\"cape\":\"https://ejemplo.com/capa.png\"}]"));
		assertFalse(Capes.known(null));
		assertFalse(Capes.known(""));
	}

	@Test
	void brokenAnswersAreANetworkError() {
		assertThrows(IOException.class, () -> BadgeClient.parseCapes("no es json"));
		assertThrows(IOException.class, () -> BadgeClient.parseCapes("{\"message\":\"error\"}"));
		assertThrows(IOException.class, () -> BadgeClient.parseCapes("[{\"mc_uuid\":\"no-es-uuid\",\"cape\":\"dawn\"}]"));
	}

	@Test
	void everyCapeHasItsTextureInTheMod() throws IOException {
		assertEquals(5, Capes.IDS.size());
		for (String id : Capes.IDS) {
			try (InputStream in = getClass().getResourceAsStream("/assets/venusbadge/" + Capes.texturePath(id))) {
				assertNotNull(in, "falta la textura de " + id);
				BufferedImage img = ImageIO.read(in);
				assertEquals(64, img.getWidth(), id);
				assertEquals(32, img.getHeight(), id);
				// La cara de afuera de la capa es opaca y lo que sobra de la textura, no
				assertEquals(255, img.getRGB(5, 8) >>> 24, id);
				assertEquals(0, img.getRGB(60, 30) >>> 24, id);
			}
		}
	}

	@Test
	void capesUseTheSameRulesAsTheBadge() {
		AtomicLong now = new AtomicLong(1_000_000);
		List<List<UUID>> calls = new ArrayList<>();
		BadgeCache c = new BadgeCache(batch -> {
			calls.add(batch);
			return Map.of(a, "aurora");
		}, now::get);
		assertNull(c.style(a));
		assertNull(c.style(b));
		assertNull(c.style(UUID.nameUUIDFromBytes("OfflinePlayer:Steve".getBytes())));
		c.tick();
		assertEquals(2, calls.get(0).size());
		assertEquals("aurora", c.style(a));
		assertNull(c.style(b));
	}

	@Test
	void theConfigCanHideOtherPlayersCapes() throws IOException {
		Path file = dir.resolve(BadgeCore.CONFIG_FILE);
		assertTrue(BadgeCore.showCapes(file), "sin archivo se ven");
		Files.writeString(file, "{\"url\":\"https://x.supabase.co\",\"anonKey\":\"k\"}");
		assertTrue(BadgeCore.showCapes(file));
		Files.writeString(file, "{\"showCapes\":false}");
		assertFalse(BadgeCore.showCapes(file));
		Files.writeString(file, "{\"showCapes\":true}");
		assertTrue(BadgeCore.showCapes(file));
		Files.writeString(file, "{\"showCapes\":\"no\"}");
		assertTrue(BadgeCore.showCapes(file), "lo raro las deja prendidas");
		Files.writeString(file, "esto no es json");
		assertTrue(BadgeCore.showCapes(file));
	}
}
