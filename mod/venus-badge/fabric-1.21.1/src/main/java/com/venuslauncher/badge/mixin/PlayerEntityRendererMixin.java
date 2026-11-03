package com.venuslauncher.badge.mixin;

import com.venuslauncher.badge.VenusBadge;
import net.minecraft.client.network.AbstractClientPlayerEntity;
import net.minecraft.client.render.VertexConsumerProvider;
import net.minecraft.client.render.entity.PlayerEntityRenderer;
import net.minecraft.client.util.math.MatrixStack;
import net.minecraft.text.Text;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.ModifyVariable;

// Nombre sobre la cabeza. Solo cambia la línea del nombre: la del puntaje (debajo del nombre) queda igual.
@Mixin(PlayerEntityRenderer.class)
abstract class PlayerEntityRendererMixin {
	@ModifyVariable(
			method = "renderLabelIfPresent(Lnet/minecraft/client/network/AbstractClientPlayerEntity;Lnet/minecraft/text/Text;Lnet/minecraft/client/util/math/MatrixStack;Lnet/minecraft/client/render/VertexConsumerProvider;IF)V",
			at = @At("HEAD"),
			argsOnly = true)
	private Text venusbadge$nameTag(Text text, AbstractClientPlayerEntity player, Text original, MatrixStack matrices, VertexConsumerProvider consumers, int light, float tickDelta) {
		return VenusBadge.decorate(player.getUuid(), text);
	}
}
