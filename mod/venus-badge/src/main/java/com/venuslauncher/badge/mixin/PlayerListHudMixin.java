package com.venuslauncher.badge.mixin;

import com.venuslauncher.badge.VenusBadge;
import net.minecraft.client.gui.hud.PlayerListHud;
import net.minecraft.client.network.PlayerListEntry;
import net.minecraft.text.Text;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

// Lista de jugadores (Tab). El ancho de las columnas también sale de getPlayerName, así que el ícono entra.
@Mixin(PlayerListHud.class)
abstract class PlayerListHudMixin {
	@Inject(method = "getPlayerName", at = @At("RETURN"), cancellable = true)
	private void venusbadge$tabName(PlayerListEntry entry, CallbackInfoReturnable<Text> cir) {
		Text name = cir.getReturnValue();
		Text decorated = VenusBadge.decorate(entry.getProfile().getId(), name);
		if (decorated != name) cir.setReturnValue(decorated);
	}
}
