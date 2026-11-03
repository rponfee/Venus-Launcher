package com.venuslauncher.badge.mixin;

import com.venuslauncher.badge.BadgeText;
import net.minecraft.client.gui.components.PlayerTabOverlay;
import net.minecraft.client.multiplayer.PlayerInfo;
import net.minecraft.network.chat.Component;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

// Lista de jugadores (Tab). El ancho de las columnas también sale de getNameForDisplay, así que el ícono entra.
// Es el único mixin en Forge y NeoForge: ninguno de los dos tiene un evento para este nombre.
@Mixin(PlayerTabOverlay.class)
abstract class PlayerTabOverlayMixin {
	@Inject(method = "getNameForDisplay", at = @At("RETURN"), cancellable = true)
	private void venusbadge$tabName(PlayerInfo entry, CallbackInfoReturnable<Component> cir) {
		Component name = cir.getReturnValue();
		Component decorated = BadgeText.decorate(entry.getProfile().getId(), name);
		if (decorated != name) cir.setReturnValue(decorated);
	}
}
