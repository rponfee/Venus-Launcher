# Marcos de perfil 4.6 (agente D)

El dueño pidió sacar los marcos anteriores y poner marcos nuevos sin nada de copyright. Los marcos son **dibujos SVG originales hechos con código** (sin imágenes, sin marcas ni nombres de juegos), siempre alrededor de un avatar circular. Servidor: `supabase/migrations/0040_marcos_originales.sql` (**sin aplicar**).

## Qué hay

- **36 marcos de la tienda** en 8 categorías (cósmicos, naturaleza, elementos, gemas y cristal, retro y pixel, neón y tecnología, estacionales, fantasía), con rareza (común, raro, épico, legendario) y precio de 400 a 3000 Venus Points. Cuatro son **solo Premium** (`frame_constellation`, `frame_opal`, `frame_hologram`, `frame_wings`; precio 0 en la base).
- **8 marcos del Venus Pass** (`pass_frame_1` … `pass_frame_8`, estilos `pass1` … `pass8`): bronce, plata, oro, platino, amatista, corona carmesí, aurora y estrella de Venus (rareza rara, rara, épica, épica, épica, legendaria, legendaria, mítica). Los inserta 0041.
- Precios y rarezas: `src/renderer/js/social/frames.js` (`FRAME_CATALOG`, la fuente única; la migración repite los precios y una prueba cuida que coincidan).

## Archivos

| Archivo | Qué hace |
|---|---|
| `social/frames.js` | `FRAME_CATALOG`, `frameStyleOf` (id de la tienda, del Pase o estilo → estilo), `registerFrameItems`, `filterFrames`, `frameSections`, `frameSvg`, `drawFrame(el, id)`, `framePreview(id, cabeza, tamaño)`, `frameImageUrl` (marco quieto para el PNG de compartir), `RETIRED_FRAME_IDS`. Puro: no toca el DOM al cargarse. |
| `social/frames/kit.js`, `art-a.js`, `art-b.js`, `art-pass.js` | Las herramientas de dibujo (anillos, destellos, hojas, cristales, llamas…) y la receta de cada marco. |
| `styles/features/frames.css` | Caja del marco, movimientos (solo `transform` y `opacity`), un bloque por estilo y rareza. |
| `social/profile-style.js` | `applyFrame` usa `drawFrame`. Se borró todo el CSS de los marcos viejos de `profile-style.css`. |
| `features/profile-editor.js`, `profile-editor/model.js`, `share.js`, `demo.js` | El editor trae un selector de marcos con categorías y buscador; `model.js` resuelve por `shop_items.data` (`registerItems`): `frameStyle`, `titleStyle` y `effectFromItem` ahora también dibujan los `pass_*`. |
| `pages/rewards.js`, `rewards/logic.js`, `rewards/fake.js` | Tienda: marcos por categoría con buscador, rareza y precio, vista previa circular con **tu cabeza** y una vista grande (128/64/32 px, fondo oscuro y claro). Sin capas. |
| `pages/pass.js` | Los premios que son marcos se ven puestos en tu cabeza. |
| `pages/skins.js` | Sin la capa de Venus (quedan las capas oficiales de la cuenta). |

## Movimiento y rendimiento

El dibujo quieto es el marco completo. Las animaciones mueven solo `transform` y `opacity`; se apagan con *reducir movimiento*, con `prefers-reduced-motion` y con el modo liviano, y se pausan fuera de pantalla (un `IntersectionObserver` le pone `.off` a la caja).

## Cómo agregar un marco

1. Receta en `social/frames/art-a.js` o `art-b.js` (o `art-pass.js`): función que devuelve el interior del SVG (viewBox 100; el avatar es el círculo de radio 40; la animación se pide con la clase, p. ej. `an('tw', { t: 2.6 })`; lo animado nunca lleva `transform` propio: usá `put`/`tr`).
2. Una fila en `SHOP` de `frames.js` (estilo, categoría, rareza, precio, solo Premium).
3. Un bloque `.fr-<estilo> { … }` en `frames.css`.
4. Nombre `item_frame_<estilo>` en `i18n/es/rewards.js` y `en/rewards.js`.
5. La fila en `0040_marcos_originales.sql` (o una migración nueva) con `data: {"style":"<estilo>"}`. `node --test "src/renderer/js/social/test/"` avisa de lo que falte.

## Migración 0040

Probada contra producción en una transacción que termina en `rollback` (no se aplicó nada), **solo la 0040 con datos sembrados**: no se incluyeron 0039 ni 0041 (falta de tiempo; ver "Sin probar"). Resultado: 36 marcos nuevos activos, los 21 anteriores desactivados (ninguno quedó activo ni sobró uno inactivo fuera de la lista), `profiles.equipped` sin el marco retirado (el título se conserva), reintegro de lo pagado (1500 al seed; 3 filas `refund:` en total: las 2 compras reales de producción y la sembrada), segunda corrida del reintegro inserta 0 filas, comprar un marco nuevo anda y cobra, comprarlo dos veces da `owned`, comprar uno viejo `bad_item`, uno Premium `premium_item`, equipar uno nuevo anda y uno viejo o Premium sin plan da `not_owned`.
- `gift_send` se redefine con una sola línea distinta de 0027 (`si.source = 'shop'`): sin eso los marcos del Pase (precio 0) se podían regalar gratis. Los regalos de marcos viejos **no** se reintegran.
- No se redefine `profile_customize` ni `profile_public`.
- Restricción nueva `shop_items_frame_data`: un marco tiene que decir su `style`.

## Sin probar / sin hacer

- 0040 junto con 0039 y 0041 en la misma transacción, el caso Premium real (`venus_is_premium`) y `gift_send` en vivo.
- Las capturas completas (grilla de todos los marcos, editor y tienda en es y en, claro y oscuro, 1300×820 y 1040×680): se vieron la tienda en español oscuro y la hoja de contacto de los 44 marcos; el resto queda pendiente.
- `profile` y `pass`, `rewards`, `skins` y `premium` en los otros 12 idiomas (ver el informe).
