# Retiro de las capas de Venus (4.6)

> **Rama 4.6, sin publicar.** El dueño pidió sacar "las capas que solo ve uno mismo". Se interpretó como quitar **toda** la función de capas de Venus (tienda, mod y launcher). La insignia de Venus y los FPS del mod se quedan. Este documento reemplaza a `docs/implementacion/capas.md`, que se borró.

## Qué cambió para el jugador

- El mod **Venus Badge 1.3.0** ya no dibuja capas ni le pregunta capas al servidor. Sigue dibujando la insignia (sobre la cabeza y en Tab) y sigue informando los FPS.
- El launcher ya no tiene el ajuste "Ver las capas de otros jugadores", ni el aviso de la tienda, ni la vista previa de la capa. `config/venus-badge.json` queda solo con `url` y `anonKey`: si una instancia traía `"showCapes": false` de la 4.5, el launcher la reescribe sin esa clave en la próxima partida.
- Cómo llega el mod nuevo a las instancias: `ingame/badgemod.js` compara el `.jar` por contenido y lo reemplaza en la próxima partida con la insignia prendida (Ajustes → General → Venus en el juego). Hasta entonces una instancia que no se abrió con el launcher nuevo sigue con el 1.2.0 y sigue dibujando las capas que ya estaban puestas.

## Qué se quitó

**Mod (`mod/venus-badge`, las cuatro variantes):**

- `Capes.java` (la lista fija de ids), `CapesTest.java` y `make-capes.js`.
- Las texturas `assets/venusbadge/textures/cape/*.png` (cinco).
- Los mixins de la capa: `AbstractClientPlayerEntityMixin` (Fabric 1.20.1 y 1.21.1) y `AbstractClientPlayerMixin` (Forge y NeoForge), con su entrada en cada `venusbadge.mixins.json`. El refmap de Forge se genera solo y ahora trae únicamente `PlayerTabOverlayMixin`.
- De `BadgeCore`: el segundo `BadgeCache` de capas, `showCapes`, `cape()` y la lectura de `"showCapes"`. De `BadgeClient`: `fetchCapes`, `parseCapes` y la consulta `badge_capes`. De `VenusBadge` y `BadgeGame`: `capeTexture` y el mapa de texturas.
- Las descripciones de `fabric.mod.json`, `mods.toml` y `neoforge.mods.toml` ya no hablan de capas. `mod_version` pasó de 1.2.0 a **1.3.0**.

**Launcher:**

- `renderer/js/features/capes.js`, `features/capes/` (`logic.js`, `textures.js`, `test/logic.test.js`) y `renderer/styles/features/capes.css`.
- `renderer/i18n/<idioma>/capes.js` en los 14 idiomas (namespace `capes` completo).
- La entrada de `features/capes.js` en `STARTUP` de `renderer/js/app.js`.
- En `main/modules/ingame.js`: el ajuste `capes` de `DEFAULTS` y de `prefs()`, y el `showCapes` que le pasaba a `badgemod.apply`. En `ingame/badgemod.js`: el parámetro `showCapes` y su escritura en la config.
- Pruebas: `main/modules/ingame/test/capes.test.js` (borrada). `window.test.js` ya no espera `capes` en `prefs()` y `badge.test.js` suma una prueba de que la config vieja con `showCapes` se reescribe solo con el servidor.

## Lo que se conserva

- **Insignia:** `BadgeCache`, `BadgeClient` (`badge_styles` con respaldo `badge_lookup`), `BadgeCore`, `BadgeText`/`VenusBadge`, los mixins del nombre y de Tab, la fuente `venusbadge:badge`.
- **FPS (`PerfReporter`):** cada 2 s, con un mundo abierto y sin pausa, el mod reescribe `<carpeta del juego>/venus/perf.json` con `{ "fps": 60, "at": <epoch en ms> }`. Lo leen el historial de rendimiento y el widget del overlay con `perfhistory/fps.js`. Al salir del mundo deja de escribir y el lector descarta el dato a los 10 s. Tiene su propio hilo y escribe en un temporal que después renombra. Si se quiere que siga escribiendo en pausa, sacar `client.isPaused()` de `fpsInWorld` en `VenusBadge` y `BadgeGame`.

## Cómo se probó

- `cd mod/venus-badge && ./gradlew clean build --console=plain --no-daemon --offline` con Temurin 25 (Gradle, Loom y Fabric con `release` 17 y 21), Temurin 21 (NeoForge) y el JDK 17 de `~/.gradle/jdks` (Forge): **BUILD SUCCESSFUL en 53 s**, las cuatro variantes. JUnit: 16 pruebas (`BadgeCacheTest` 9, `BadgeCoreTest` 3, `PerfReporterTest` 4), todas en verde.
- Los cuatro `.jar` (`venus-badge-1.3.0+mc1.20.1-fabric`, `+mc1.20.1-forge`, `+mc1.21.1-fabric`, `+mc1.21.1-neoforge`): `unzip -l` sin ningún nombre con `cape` ni `cloak`; búsqueda binaria de `cape`, `cloak`, `showCapes` y `badge_capes` en todos los archivos propios (clases, JSON, TOML, refmap): cero resultados. `javap` confirma `BadgeCore` (`glyph`, `style`, `start`, `server`), `PerfReporter` (`start`, `tick`, `NO_WORLD`) y `BadgeClient` (`fetch`, `parseStyles`, `parseLookup`) sin ningún método de capas. Los `mixins.json` listan solo `PlayerEntityRendererMixin` y `PlayerListHudMixin` (Fabric) o `PlayerTabOverlayMixin` (Forge y NeoForge). Versión 1.3.0 en los cuatro metadatos. Clases Java 17 (major 61) en 1.20.1 y Java 21 (major 65) en 1.21.1.
- Launcher: `node --test "src/main/modules/ingame/test/*.test.js"` (29 pruebas en verde), `node scripts/contracts-check.js` (0 sin handler) y `node scripts/i18n-check.js en` en verde.
- **No se probó** el mod dentro de Minecraft (la insignia en el juego, Tab y los FPS con el `.jar` nuevo): no hay cuentas de Microsoft ni un servidor de pruebas en este entorno. Las capas no se pueden probar porque ya no existen. La compilación y el contenido de los `.jar` sí se comprobaron.

## Objetos de base de datos que quedan sin uso

Los creó `0034_capas.sql` (aplicada en producción el 4 de noviembre con el nombre `venus_0034_capas`). **No se escribió ninguna migración de limpieza.** Inventario de producción, solo lectura:

| Objeto | Detalle |
|---|---|
| Tabla `public.user_capes` | `user_id` (PK, `auth.users` en cascada) → `item_id` (`shop_items`, en cascada), `equipped_at`. RLS prendida, sin políticas, `revoke all` a `public`, `anon` y `authenticated` |
| Función `public.cape_equip(p_item text)` | `security definer`, ejecutable por `authenticated` |
| Función `public.cape_mine()` | `security definer`, ejecutable por `authenticated` |
| Función `public.badge_capes(p_uuids uuid[])` | `security definer`, ejecutable por `anon` y `authenticated` (la llama el mod 1.2.0) |
| Filas de `public.shop_items` con `kind = 'cape'` | `cape_dawn` (1000), `cape_nebula` (1500), `cape_aurora` (1500), `cape_magma` (2500), `cape_orbit` (0, solo Premium), todas activas |
| Restricción `shop_items_kind_check` | Hoy admite `'cape'`; hay que recrearla sin esa palabra **después** de borrar las filas |
| Restricción `shop_items_cape_data` | `check (kind <> 'cape' or ...)`; se borra |

No hay políticas, triggers, índices (salvo la PK) ni buckets propios de las capas. Ninguna otra función de `public` las nombra (se revisó el cuerpo de todas): `admin_list_users` aparece en una búsqueda por texto solo por la palabra `escape` de un `like`. Tampoco hay filas de capa en `profiles.equipped`, en `pass_rewards` ni en regalos.

**Cuántas cuentas las usaron** (lectura de producción del 5 de noviembre de 2026, solo conteos):

- Cuentas de Venus en total: 9. Cuentas de Minecraft verificadas (`mc_verified`): 1.
- Cuentas que **compraron** al menos una capa: **1** (dos compras: Nebulosa y Aurora, 1500 puntos cada una, 3000 en total; `points_ledger` con `reason = 'shop'`).
- Cuentas con una capa **equipada** (`user_capes`): **1** (Nebulosa, puesta el 4 de noviembre).
- Capas Órbita (Premium) equipadas: 0. Amanecer y Magma: ninguna compra.

Cosas a tener en cuenta al armar la limpieza:

- Borrar las filas de `shop_items` borra en cascada `user_items` y `user_capes` de esas capas, pero **no** deshace el cobro: el gasto queda en `points_ledger`. Si querés devolverle los 3000 puntos a esa cuenta, tiene que ser una fila nueva de reintegro antes de borrar el catálogo.
- `pass_rewards.item_id` referencia `shop_items` sin `on delete cascade`, pero hoy ninguna recompensa del Pass es una capa (se verificó); si el agente del Pass suma alguna, el `delete` falla.
- Orden sugerido: funciones, tabla `user_capes`, filas `kind = 'cape'` de `shop_items`, recrear `shop_items_kind_check` sin `'cape'` y borrar `shop_items_cape_data`. Mientras haya instancias con el mod 1.2.0, `badge_capes` desaparecida da 404 y el mod reintenta con espera creciente (hasta cada 10 minutos); no afecta a la insignia, pero conviene limpiar después de publicar el launcher 4.6.
- Quedan referencias en `supabase/tests/migrations-0028-0036-preflight-readonly.sql` y `migrations-0028-0036-rollback.sql`, y en `docs/implementacion/revision-sql-0028-0036.md`. Son historia de la 4.5 y no se tocaron.

## Pendiente de otros agentes

`pages/rewards.js`, `pages/rewards/logic.js`, `pages/rewards/fake.js` y `pages/skins.js` (agente D) todavía usan lo que se borró:

- `pages/skins.js` importa `equippedCapeCanvas` de `features/capes.js` (línea 11) y lo llama al final; usa además `venusCape` y la clave `skins.venusCape`.
- `pages/rewards.js` importa `capeArt`, `capesNotice` y `knownCapes` (líneas 16 y 17), carga el namespace `capes` y el CSS `features/capes` (líneas 59 y 60), y trae `equipCape`, `cape_mine` y `cape_equip`. `rewards/logic.js` tiene `CAPE_SLOT` y `'cape'` en `KIND_ORDER`; `rewards/fake.js`, los cinco ítems y los RPC falsos.
- Claves viejas en los namespaces de D: `kind_cape` e `item_cape_{dawn,nebula,aurora,magma,orbit}` en `rewards`, y `venusCape` en `skins`, en los 14 idiomas.

**Mientras D no los edite, las páginas Venus Points (tienda) y Skins no cargan: el `import` de un archivo que ya no existe falla.**

Textos que quedaron huérfanos sin tocar: `v45worlds_b2` y `v45worlds_b3` de `whatsnew` (hablan de capas; su diapositiva ya no está en `SLIDES`).

## CI y documentos que apuntan a lo borrado

- `.github/workflows/mod.yml`, línea 65: en el `for archivo in ...` de "Revisar los .jar" hay que sacar ` assets/venusbadge/textures/cape/dawn.png`. Con la línea tal cual, el paso falla en las cuatro variantes porque la textura ya no está en el `.jar`.
- `.github/workflows/build.yml`, línea 86: la lista de `node --test` incluye `"src/renderer/js/features/capes/test/*.test.js"`; hay que sacarla (la carpeta se borró).
- Enlaces rotos a `implementacion/capas.md` en `docs/arquitectura.md` (tabla de migraciones), `docs/supabase.md`, `docs/implementacion/README.md` (dos líneas), `docs/perfiles.md` y `docs/venus-points.md`. Y menciones de la función en `docs/funciones.md`, `docs/hoja-de-ruta.md`, `docs/estado-4.5.0.md`, `docs/continuar-con-chatgpt.md`, `docs/activacion-backend-4.5.0.md`, `docs/venus-points.md` y `docs/perfiles.md`. No se editaron (solo se escribe este documento).
- El comentario de la migración `0034_capas.sql` sigue nombrando `make-capes.js` y `capas.md`; las migraciones aplicadas no se tocan.

## Ajustes

`settings.ingame.capes` ya no se lee. Si un `settings.json` viejo lo trae, queda como dato inerte (no hay migración de ajustes).
