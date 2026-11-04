package com.venuslauncher.badge.mixin;

import com.venuslauncher.badge.BadgeGame;
import net.minecraft.client.player.AbstractClientPlayer;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.client.resources.PlayerSkin;
import net.minecraft.resources.ResourceLocation;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

// Capa de Venus: el modelo (CapeLayer) y el elytra (ElytraLayer) leen la textura de getSkin. Solo se pone si Mojang no da
// ninguna (la oficial tiene prioridad) y, sin capa de Venus, devuelve lo mismo de siempre.
@Mixin(AbstractClientPlayer.class)
abstract class AbstractClientPlayerMixin {
	@Inject(method = "getSkin", at = @At("RETURN"), cancellable = true)
	private void venusbadge$cape(CallbackInfoReturnable<PlayerSkin> cir) {
		PlayerSkin skin = cir.getReturnValue();
		if (skin.capeTexture() != null) return;
		AbstractClientPlayer self = (AbstractClientPlayer) (Object) this;
		ResourceLocation cape = BadgeGame.capeTexture(self.getUUID(), self instanceof LocalPlayer);
		if (cape != null) cir.setReturnValue(new PlayerSkin(skin.texture(), skin.textureUrl(), cape, skin.elytraTexture(), skin.model(), skin.secure()));
	}
}
