// Capas de Venus: lógica pura (sin DOM ni imports). La lista es la misma que trae el mod (mod/venus-badge: Capes.java): solo se
// muestra y se vende lo que el mod puede dibujar. Guía: docs/wip/capas-34.md.
export const CAPE_IDS = ['dawn', 'nebula', 'aurora', 'magma', 'orbit'];

/** El id de la textura de un ítem de la tienda, o null si no es una capa conocida. */
export function capeIdOf(item) {
  const id = item?.kind === 'cape' ? item.data?.cape : null;
  return CAPE_IDS.includes(id) ? id : null;
}

/** Saca las capas que este launcher no sabe dibujar (una capa nueva en el servidor con un launcher viejo). */
export function knownCapes(items) {
  return (Array.isArray(items) ? items : []).filter((it) => it?.kind !== 'cape' || capeIdOf(it));
}
