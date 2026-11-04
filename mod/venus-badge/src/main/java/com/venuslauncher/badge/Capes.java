package com.venuslauncher.badge;

import java.util.List;

/**
 * Las capas de Venus que vienen dentro del mod: una lista fija, con su textura en assets/venusbadge/textures/cape (las
 * dibuja make-capes.js). El servidor solo dice cuál tiene puesta cada jugador: nunca manda una textura ni una URL, y un id que
 * no está en esta lista se ignora (por ejemplo, una capa nueva con un mod viejo).
 */
public final class Capes {
	public static final List<String> IDS = List.of("dawn", "nebula", "aurora", "magma", "orbit");

	private Capes() {}

	public static boolean known(String id) {
		return id != null && IDS.contains(id);
	}

	/** Ruta de la textura dentro de assets/venusbadge, sin el espacio de nombres. */
	public static String texturePath(String id) {
		return "textures/cape/" + id + ".png";
	}
}
