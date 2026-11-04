package com.venuslauncher.badge.mixin;

import com.venuslauncher.badge.VenusBadge;
import net.minecraft.client.network.AbstractClientPlayerEntity;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.util.Identifier;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

// Capa de Venus: el modelo (CapeFeatureRenderer) y el elytra (ElytraFeatureRenderer) le piden la textura a getCapeTexture. Solo
// se pone si Mojang no da ninguna (la oficial tiene prioridad) y, sin capa de Venus, todo queda igual. require = 0: si otro mod
// lo impide, falta la capa, pero el juego arranca.
@Mixin(AbstractClientPlayerEntity.class)
abstract class AbstractClientPlayerEntityMixin {
	@Inject(method = "getCapeTexture", at = @At("RETURN"), cancellable = true, require = 0)
	private void venusbadge$cape(CallbackInfoReturnable<Identifier> cir) {
		if (cir.getReturnValue() != null) return;
		AbstractClientPlayerEntity self = (AbstractClientPlayerEntity) (Object) this;
		Identifier cape = VenusBadge.capeTexture(self.getUuid(), self instanceof ClientPlayerEntity);
		if (cape != null) cir.setReturnValue(cape);
	}
}
