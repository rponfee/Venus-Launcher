package com.venuslauncher.badge.mixin;

import com.venuslauncher.badge.VenusBadge;
import net.minecraft.client.network.AbstractClientPlayerEntity;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.client.util.SkinTextures;
import net.minecraft.util.Identifier;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

// Capa de Venus: el modelo (CapeFeatureRenderer) y el elytra (ElytraFeatureRenderer) leen la textura de getSkinTextures. Solo se
// pone si Mojang no da ninguna (la oficial tiene prioridad) y, sin capa de Venus, devuelve lo mismo de siempre. Como en
// fabric-1.20.1, pero desde 1.20.2 las texturas vienen juntas. require = 0: si otro mod lo impide, falta la capa, pero el juego arranca.
@Mixin(AbstractClientPlayerEntity.class)
abstract class AbstractClientPlayerEntityMixin {
	@Inject(method = "getSkinTextures", at = @At("RETURN"), cancellable = true, require = 0)
	private void venusbadge$cape(CallbackInfoReturnable<SkinTextures> cir) {
		SkinTextures skin = cir.getReturnValue();
		if (skin.capeTexture() != null) return;
		AbstractClientPlayerEntity self = (AbstractClientPlayerEntity) (Object) this;
		Identifier cape = VenusBadge.capeTexture(self.getUuid(), self instanceof ClientPlayerEntity);
		if (cape != null) cir.setReturnValue(new SkinTextures(skin.texture(), skin.textureUrl(), cape, skin.elytraTexture(), skin.model(), skin.secure()));
	}
}
