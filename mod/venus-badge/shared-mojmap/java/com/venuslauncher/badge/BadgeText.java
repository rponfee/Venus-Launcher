package com.venuslauncher.badge;

import java.util.UUID;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.MutableComponent;
import net.minecraft.network.chat.Style;
import net.minecraft.resources.ResourceLocation;

/**
 * El nombre con el planeta de Venus adelante, para Forge y NeoForge (nombres oficiales de Mojang, los mismos en 1.20.1 y
 * 1.21.1). Es lo mismo que VenusBadge.decorate en Fabric, que usa los nombres de Yarn. Lo llaman el evento del nombre
 * sobre la cabeza de cada loader y PlayerTabOverlayMixin.
 */
public final class BadgeText {
	// tryParse se llama igual en 1.20.1 y 1.21.1 (el constructor público de ResourceLocation se fue en 1.21).
	private static final Style ICON_STYLE = Style.EMPTY.withFont(ResourceLocation.tryParse(BadgeCore.MOD_ID + ":badge")).withColor(0xFFFFFF);

	private BadgeText() {}

	/** El nombre con la insignia adelante, o el mismo nombre si el jugador no la tiene (o todavía no se sabe). */
	public static Component decorate(UUID id, Component name) {
		if (name == null || hasIcon(name)) return name;
		String style = BadgeCore.style(id);
		if (style == null) return name;
		MutableComponent out = Component.empty();
		out.append(Component.literal(BadgeCore.glyph(style)).setStyle(ICON_STYLE));
		out.append(Component.literal(" "));
		out.append(name);
		return out;
	}

	private static boolean hasIcon(Component text) {
		return !text.getSiblings().isEmpty() && ICON_STYLE.getFont().equals(text.getSiblings().get(0).getStyle().getFont());
	}
}
