package com.venuslauncher.badge;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.LongSupplier;

/**
 * Quién tiene la insignia de Venus y con qué estilo, sin Minecraft de por medio (se prueba con JUnit). La capa de cada
 * jugador usa otra instancia, con otro {@link Fetcher} y las mismas reglas.
 *
 * <p>Los mixins preguntan {@link #style} en cada cuadro: la respuesta sale siempre de la memoria y, si el
 * jugador no está o venció, queda anotado para la próxima consulta. El hilo del mod llama a {@link #tick} y
 * pregunta al servidor en lotes de hasta {@value #MAX_BATCH} jugadores, con un pedido cada
 * {@value #MIN_INTERVAL_MS} ms como mucho. Si falla la red espera cada vez más (hasta 10 minutos) y mientras
 * tanto no se dibuja ninguna insignia nueva: nunca bloquea el juego.
 */
public final class BadgeCache {
	/** Pregunta al servidor cuáles de estos jugadores tienen la insignia: UUID → estilo ("default", "gold"...), o UUID → capa. */
	@FunctionalInterface
	public interface Fetcher {
		Map<UUID, String> fetch(List<UUID> batch) throws IOException;
	}

	static final int MAX_BATCH = 100;
	static final long MIN_INTERVAL_MS = 3_000;
	static final long TTL_MS = 30 * 60_000L;
	static final long BACKOFF_START_MS = 5_000;
	static final long BACKOFF_MAX_MS = 10 * 60_000L;
	static final int MAX_ENTRIES = 4_096;
	static final int MAX_PENDING = 1_000;
	static final long IDLE_MS = 1_000;

	/** style null = sin insignia. */
	private record Entry(String style, long expiresAt) {}

	private final Map<UUID, Entry> known = new ConcurrentHashMap<>();
	private final Set<UUID> pending = ConcurrentHashMap.newKeySet();
	private final Fetcher fetcher;
	private final LongSupplier clock;
	private long nextRequestAt;
	private long backoff;

	public BadgeCache(Fetcher fetcher, LongSupplier clock) {
		this.fetcher = fetcher;
		this.clock = clock;
	}

	/**
	 * Solo los UUID de cuentas premium (versión 4) pueden tener la insignia: los de servidores sin
	 * verificación (versión 3) y los de NPC (versión 2, p. ej. Citizens) no se consultan.
	 */
	public static boolean eligible(UUID id) {
		return id != null && id.version() == 4;
	}

	/** El estilo de la insignia del jugador (o su capa), o null si no la tiene (o todavía no se sabe). */
	public String style(UUID id) {
		if (!eligible(id)) return null;
		Entry e = known.get(id);
		if ((e == null || e.expiresAt <= clock.getAsLong()) && pending.size() < MAX_PENDING) pending.add(id);
		return e == null ? null : e.style;
	}

	public boolean hasBadge(UUID id) {
		return style(id) != null;
	}

	/** Hace como mucho un pedido y devuelve cuántos ms esperar hasta la próxima llamada. */
	public synchronized long tick() {
		long now = clock.getAsLong();
		if (now < nextRequestAt) return nextRequestAt - now;
		if (pending.isEmpty()) return IDLE_MS;
		List<UUID> batch = new ArrayList<>(MAX_BATCH);
		for (Iterator<UUID> it = pending.iterator(); it.hasNext() && batch.size() < MAX_BATCH; ) batch.add(it.next());
		Map<UUID, String> badges;
		try {
			badges = fetcher.fetch(batch);
		} catch (IOException | RuntimeException err) {
			backoff = backoff == 0 ? BACKOFF_START_MS : Math.min(backoff * 2, BACKOFF_MAX_MS);
			nextRequestAt = now + backoff;
			return backoff;
		}
		backoff = 0;
		nextRequestAt = now + MIN_INTERVAL_MS;
		if (known.size() + batch.size() > MAX_ENTRIES) prune(now);
		long expiresAt = now + TTL_MS;
		for (UUID id : batch) {
			known.put(id, new Entry(badges.get(id), expiresAt));
			pending.remove(id);
		}
		return MIN_INTERVAL_MS;
	}

	private void prune(long now) {
		known.values().removeIf(e -> e.expiresAt <= now);
		if (known.size() + MAX_BATCH > MAX_ENTRIES) known.clear();
	}

	int pendingCount() {
		return pending.size();
	}

	int knownCount() {
		return known.size();
	}
}
