package com.venuslauncher.badge;

import net.minecraft.client.player.AbstractClientPlayer;
import net.minecraftforge.api.distmarker.Dist;
import net.minecraftforge.client.event.RenderNameTagEvent;
import net.minecraftforge.common.MinecraftForge;
import net.minecraftforge.eventbus.api.EventPriority;
import net.minecraftforge.fml.ModList;
import net.minecraftforge.fml.common.Mod;
import net.minecraftforge.fml.loading.FMLEnvironment;
import net.minecraftforge.fml.loading.FMLPaths;

/**
 * Insignia de Venus en Forge 1.20.1. Solo de cliente: en esta versión @Mod no se puede limitar al cliente, así que en un
 * servidor dedicado la clase carga y no hace nada (lo que toca clases de cliente está aparte, en {@link Client}).
 * La lista de Tab va por PlayerTabOverlayMixin; la lógica común está en {@link BadgeCore}.
 */
@Mod(BadgeCore.MOD_ID)
public final class VenusBadgeForge {
	public VenusBadgeForge() {
		if (FMLEnvironment.dist == Dist.CLIENT) Client.init();
	}

	private static final class Client {
		static void init() {
			String version = ModList.get().getModContainerById(BadgeCore.MOD_ID).map(m -> m.getModInfo().getVersion().toString()).orElse("?");
			BadgeCore.start(FMLPaths.CONFIGDIR.get().resolve(BadgeCore.CONFIG_FILE), version);
			PerfReporter.start(FMLPaths.GAMEDIR.get(), BadgeGame::fpsInWorld);
			MinecraftForge.EVENT_BUS.addListener(EventPriority.LOW, Client::onNameTag);
		}

		// Nombre sobre la cabeza: el evento trae solo la línea del nombre (la del puntaje queda igual). Prioridad baja para
		// sumar el ícono a lo que hayan puesto otros mods.
		private static void onNameTag(RenderNameTagEvent event) {
			if (event.getEntity() instanceof AbstractClientPlayer player) event.setContent(BadgeText.decorate(player.getUUID(), event.getContent()));
		}
	}
}
