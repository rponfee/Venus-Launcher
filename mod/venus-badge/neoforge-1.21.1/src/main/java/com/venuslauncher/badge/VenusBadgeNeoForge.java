package com.venuslauncher.badge;

import net.minecraft.client.player.AbstractClientPlayer;
import net.neoforged.api.distmarker.Dist;
import net.neoforged.bus.api.EventPriority;
import net.neoforged.fml.ModContainer;
import net.neoforged.fml.common.Mod;
import net.neoforged.fml.loading.FMLPaths;
import net.neoforged.neoforge.client.event.RenderNameTagEvent;
import net.neoforged.neoforge.common.NeoForge;

/**
 * Insignia de Venus en NeoForge (1.21 y 1.21.1). Solo de cliente: en un servidor dedicado esta clase ni se carga.
 * La lista de Tab va por PlayerTabOverlayMixin y las capas por AbstractClientPlayerMixin; la lógica común está en {@link BadgeCore}.
 */
@Mod(value = BadgeCore.MOD_ID, dist = Dist.CLIENT)
public final class VenusBadgeNeoForge {
	public VenusBadgeNeoForge(ModContainer container) {
		BadgeCore.start(FMLPaths.CONFIGDIR.get().resolve(BadgeCore.CONFIG_FILE), container.getModInfo().getVersion().toString());
		PerfReporter.start(FMLPaths.GAMEDIR.get(), BadgeGame::fpsInWorld);
		NeoForge.EVENT_BUS.addListener(EventPriority.LOW, VenusBadgeNeoForge::onNameTag);
	}

	// Nombre sobre la cabeza: el evento trae solo la línea del nombre (la del puntaje queda igual). Prioridad baja para
	// sumar el ícono a lo que hayan puesto otros mods.
	private static void onNameTag(RenderNameTagEvent event) {
		if (event.getEntity() instanceof AbstractClientPlayer player) event.setContent(BadgeText.decorate(player.getUUID(), event.getContent()));
	}
}
