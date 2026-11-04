package com.venuslauncher.badge;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.function.IntSupplier;
import java.util.function.LongSupplier;

/**
 * Los FPS del juego para el launcher (historial de rendimiento y widget del overlay): cada {@value #INTERVAL_MS} ms, mientras
 * hay un mundo abierto y sin pausa, reescribe &lt;carpeta del juego&gt;/venus/perf.json = { "fps": 60, "at": epoch en ms }. Lo
 * lee src/main/modules/perfhistory/fps.js, que descarta un dato viejo: al salir del mundo alcanza con dejar de escribir.
 *
 * <p>Tiene su propio hilo (el hilo de render nunca toca el disco ni espera a la red del caché) y escribe en un temporal que
 * después renombra, así el launcher nunca lee un archivo a medias. Si algo falla, se saltea esa vuelta: nunca molesta al juego.
 */
public final class PerfReporter {
	static final long INTERVAL_MS = 2_000;
	/** Lo que devuelve la fuente de FPS cuando no hay nada que informar (sin mundo abierto, en pausa). */
	public static final int NO_WORLD = -1;

	private final Path dir;
	private final Path file;
	private final Path tmp;
	private final IntSupplier fps;
	private final LongSupplier clock;

	PerfReporter(Path gameDir, IntSupplier fps, LongSupplier clock) {
		this.dir = gameDir.resolve("venus");
		this.file = dir.resolve("perf.json");
		this.tmp = dir.resolve("perf.json.tmp");
		this.fps = fps;
		this.clock = clock;
	}

	/** Arranca el hilo. fps se llama desde ese hilo: solo puede leer campos, sin tocar nada del mundo. */
	public static void start(Path gameDir, IntSupplier fps) {
		PerfReporter reporter = new PerfReporter(gameDir, fps, System::currentTimeMillis);
		Thread worker = new Thread(() -> {
			while (!Thread.currentThread().isInterrupted()) {
				try {
					Thread.sleep(INTERVAL_MS);
				} catch (InterruptedException err) {
					return;
				}
				reporter.tick();
			}
		}, "Venus Badge FPS");
		worker.setDaemon(true);
		worker.start();
	}

	/** Una vuelta: true si escribió el archivo. */
	boolean tick() {
		try {
			int value = fps.getAsInt();
			if (value < 0) return false;
			Files.createDirectories(dir);
			Files.writeString(tmp, "{\"fps\":" + value + ",\"at\":" + clock.getAsLong() + "}");
			Files.move(tmp, file, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
			return true;
		} catch (IOException | RuntimeException err) {
			// En Windows el renombre falla si el launcher justo está leyendo el archivo: la próxima vuelta lo arregla.
			BadgeCore.LOG.debug("perf.json", err);
			return false;
		}
	}
}
