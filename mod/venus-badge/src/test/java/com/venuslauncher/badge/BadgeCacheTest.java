package com.venuslauncher.badge;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.Test;

class BadgeCacheTest {
	private final AtomicLong now = new AtomicLong(1_000_000);
	private final List<List<UUID>> calls = new ArrayList<>();

	private BadgeCache cache(Set<UUID> withBadge) {
		return new BadgeCache(batch -> {
			calls.add(List.copyOf(batch));
			Map<UUID, String> out = new HashMap<>();
			for (UUID id : batch) if (withBadge.contains(id)) out.put(id, "default");
			return out;
		}, now::get);
	}

	private static UUID premium(int n) {
		return UUID.fromString(String.format("00000000-0000-4000-8000-%012d", n));
	}

	@Test
	void unknownPlayersAreQueuedAndAnsweredInOneBatch() {
		UUID a = premium(1), b = premium(2);
		BadgeCache c = cache(Set.of(a));
		assertFalse(c.hasBadge(a));
		assertFalse(c.hasBadge(b));
		assertFalse(c.hasBadge(a));
		assertEquals(2, c.pendingCount());
		c.tick();
		assertEquals(1, calls.size());
		assertEquals(2, calls.get(0).size());
		assertTrue(c.hasBadge(a));
		assertFalse(c.hasBadge(b));
		assertEquals(0, c.pendingCount());
	}

	@Test
	void offlineAndNpcUuidsAreNeverSent() {
		BadgeCache c = cache(Set.of());
		UUID offline = UUID.nameUUIDFromBytes("OfflinePlayer:Steve".getBytes());
		UUID npc = UUID.fromString("00000000-0000-2000-8000-000000000001");
		assertFalse(c.hasBadge(offline));
		assertFalse(c.hasBadge(npc));
		assertFalse(c.hasBadge(null));
		assertEquals(0, c.pendingCount());
	}

	@Test
	void requestsAreRateLimitedAndBatched() {
		BadgeCache c = cache(Set.of());
		for (int i = 0; i < 250; i++) c.hasBadge(premium(i));
		assertEquals(BadgeCache.MIN_INTERVAL_MS, c.tick());
		assertEquals(BadgeCache.MAX_BATCH, calls.get(0).size());
		now.addAndGet(1_000);
		assertEquals(BadgeCache.MIN_INTERVAL_MS - 1_000, c.tick());
		assertEquals(1, calls.size());
		now.addAndGet(2_000);
		c.tick();
		now.addAndGet(BadgeCache.MIN_INTERVAL_MS);
		c.tick();
		assertEquals(3, calls.size());
		assertEquals(50, calls.get(2).size());
	}

	@Test
	void networkFailuresBackOffAndKeepPendingPlayers() {
		int[] failures = {3};
		BadgeCache c = new BadgeCache(batch -> {
			calls.add(batch);
			if (failures[0]-- > 0) throw new IOException("sin red");
			return Map.of(batch.get(0), "gold");
		}, now::get);
		UUID a = premium(7);
		assertFalse(c.hasBadge(a));
		assertEquals(BadgeCache.BACKOFF_START_MS, c.tick());
		now.addAndGet(BadgeCache.BACKOFF_START_MS);
		assertEquals(BadgeCache.BACKOFF_START_MS * 2, c.tick());
		now.addAndGet(BadgeCache.BACKOFF_START_MS * 2);
		assertEquals(BadgeCache.BACKOFF_START_MS * 4, c.tick());
		assertFalse(c.hasBadge(a));
		assertEquals(1, c.pendingCount());
		now.addAndGet(BadgeCache.BACKOFF_START_MS * 4);
		c.tick();
		assertTrue(c.hasBadge(a));
	}

	@Test
	void entriesExpireAndAreRefreshedWithoutLosingTheBadgeMeanwhile() {
		UUID a = premium(3);
		BadgeCache c = cache(Set.of(a));
		c.hasBadge(a);
		c.tick();
		now.addAndGet(BadgeCache.TTL_MS + 1);
		assertTrue(c.hasBadge(a));
		assertEquals(1, c.pendingCount());
		c.tick();
		assertEquals(2, calls.size());
	}

	@Test
	void idleWhenNothingIsPending() {
		BadgeCache c = cache(Set.of());
		assertEquals(BadgeCache.IDLE_MS, c.tick());
		assertTrue(calls.isEmpty());
	}

	@Test
	void keepsTheStyleOfEachPlayer() {
		UUID a = premium(4), b = premium(5);
		BadgeCache c = new BadgeCache(batch -> Map.of(a, "gold", b, "ice"), now::get);
		c.style(a);
		c.style(b);
		c.tick();
		assertEquals("gold", c.style(a));
		assertEquals("ice", c.style(b));
		assertEquals(null, c.style(premium(6)));
	}

	@Test
	void parsesServerAnswers() throws IOException {
		UUID a = premium(9), b = premium(10);
		assertEquals(Map.of(a, "gold", b, "default"),
				BadgeClient.parseStyles("[{\"mc_uuid\":\"" + a + "\",\"style\":\"gold\"},{\"mc_uuid\":\"" + b + "\",\"style\":null}]"));
		assertEquals(Map.of(a, "default"), BadgeClient.parseLookup("[\"" + a + "\"]"));
		assertEquals(Map.of(), BadgeClient.parseStyles("[]"));
	}

	@Test
	void unknownStylesUseTheDefaultGlyph() {
		assertEquals(String.valueOf((char) 0xE000), VenusBadge.glyph("default"));
		assertEquals(String.valueOf((char) 0xE001), VenusBadge.glyph("gold"));
		assertEquals(String.valueOf((char) 0xE003), VenusBadge.glyph("ice"));
		assertEquals(String.valueOf((char) 0xE000), VenusBadge.glyph("raro"));
	}
}
