# Capas de Venus y FPS del mod

> **Rama 4.5.0, sin publicar.** Consolidación documental del 3 de noviembre de 2026, reconciliada con el WIP congelado. Los informes de cada frente se conservan como antecedentes; las pruebas posteriores están atribuidas al final o en el estado de integración. Contratos y límites del código local; producción continúa hasta 0027 según la integración principal. Los resultados previos pertenecen a sus informes y no equivalen a pruebas externas repetidas ni a un despliegue. Ver [estado de integración](../estado-4.5.0.md).

Referencia del mod, sus RPC y límites; ver [Venus Points](../venus-points.md), [perfiles](../perfiles.md) y [arquitectura](../arquitectura.md).

## Cómo se usa

**Capas.** En **Venus Points → Tienda → Capas en el juego** se compran con puntos como cualquier cosmético (`shop_buy`) y se equipan o se sacan con un botón (`cape_equip`). La Capa Órbita viene con Premium y no se compra. Al renovarse el Premium vuelve a verse; lo comprado es para siempre.

Para que se vea en el juego hacen falta tres cosas, y la tienda avisa de las dos que dependen del jugador:

1. **El mod.** Se instala solo al activar la insignia (Ajustes → General → Venus en el juego), en Fabric o Quilt 1.20.1, 1.21 y 1.21.1, NeoForge 1.21 y 1.21.1 y Forge 1.20.1. Tanto quien lleva la capa como quien la mira tienen que tener el mod.
2. **La cuenta de Minecraft verificada con Mojang** (`mc_verified`): con la insignia o con el botón de **Invitaciones**. Una cuenta de Venus sin verificar puede equipar una capa, pero `badge_capes` no la devuelve.
3. **No tener capa oficial.** La de Mojang siempre gana: el mod solo actúa cuando el juego no tiene ninguna.

El interruptor **Ver las capas de otros jugadores** (misma pantalla, `settings.ingame.capes`, prendido por defecto) escribe `"showCapes": false` en `config/venus-badge.json` antes de la próxima partida. Apagado, no se pregunta al servidor por nadie más y la capa propia se sigue viendo. El launcher reescribe ese archivo en cada partida: a mano solo dura si el juego se abre por afuera del launcher.

En `#/skins`, el visor 3D muestra la capa de Venus si la cuenta de Microsoft no tiene capa oficial.

**Qué se ve en el juego.** La capa en el modelo del jugador, con la física de siempre; con elytra, la misma textura en las alas. En primera persona el juego no dibuja tu cuerpo, así que la tuya se ve en el inventario, en tercera persona (F5) o con mods que dibujan el cuerpo en primera persona. El ajuste "Capa" de Opciones → Personalización del skin se respeta.

**FPS.** Cada 2 s, con un mundo abierto y sin pausa, el mod reescribe `<carpeta del juego>/venus/perf.json` con `{ "fps": 60, "at": <epoch en ms> }`. Lo leen el historial de rendimiento y el widget del overlay con `perfhistory/fps.js`, sin cambios. Al salir del mundo deja de escribir y el archivo queda: el lector lo descarta a los 10 s. En pausa tampoco escribe, porque el lector lo documenta así ("con el juego en pausa ... se devuelve null"). Para que siga escribiendo en pausa, sacar `client.isPaused()` de `fpsInWorld` en `VenusBadge` y `BadgeGame`.

## Archivos

```
supabase/migrations/0034_capas.sql         kind 'cape', user_capes, catálogo, RPC
mod/venus-badge/
  make-capes.js                            Dibuja las texturas (arte propio con código, sin dependencias)
  src/main/java/.../Capes.java             Lista fija de capas
  src/main/java/.../PerfReporter.java      FPS: hilo propio, temporal y renombrar
  src/main/java/.../BadgeClient.java       fetchCapes y parseCapes (badge_capes)
  src/main/java/.../BadgeCore.java         Segundo BadgeCache para las capas, showCapes, cape(uuid, propia)
  src/main/resources/assets/venusbadge/textures/cape/*.png
  shared-yarn/.../VenusBadge.java          capeTexture y fpsInWorld en Fabric
  shared-mojmap/.../BadgeGame.java         capeTexture y fpsInWorld en Forge y NeoForge
  fabric-1.20.1/.../mixin/AbstractClientPlayerEntityMixin.java   getCapeTexture
  fabric-1.21.1/.../mixin/AbstractClientPlayerEntityMixin.java   getSkinTextures
  forge-1.20.1/.../mixin/AbstractClientPlayerMixin.java          getCloakTextureLocation
  neoforge-1.21.1/.../mixin/AbstractClientPlayerMixin.java       getSkin
  src/test/java/.../CapesTest.java, PerfReporterTest.java
src/main/modules/ingame.js, ingame/badgemod.js   settings.ingame.capes -> showCapes en la config del mod
src/main/modules/ingame/test/capes.test.js
src/renderer/js/features/capes.js          capeArt, capesNotice, equippedCapeCanvas
src/renderer/js/features/capes/logic.js    CAPE_IDS, capeIdOf, knownCapes (sin DOM)
src/renderer/js/features/capes/textures.js Generado por make-capes.js: los mismos PNG como data:
src/renderer/js/features/capes/test/logic.test.js
src/renderer/js/pages/rewards.js, rewards/logic.js, rewards/fake.js
src/renderer/js/pages/skins.js             La capa de Venus en el visor
src/renderer/i18n/{es,en}/capes.js, kind_cape e item_cape_* en {es,en}/rewards.js
src/renderer/styles/features/capes.css
```

Puntos de enganche del mod: el renderer de la capa y el del elytra le piden la textura al jugador, así que un solo mixin cubre los dos. Son los métodos de la tabla de arriba, comprobados con `javap` en los `.jar` de Minecraft de cada variante. Hasta 1.20.1 hay un método para la capa; desde 1.20.2 todas las texturas vienen en un record (`SkinTextures` en Yarn, `PlayerSkin` en Mojang) y hay que devolver una copia con la capa. El mixin de Fabric lleva `require = 0` y en Forge y NeoForge manda `defaultRequire: 0`: si otro mod lo impide falta la capa, pero el juego arranca.

## RPC

| Función | Quién | Qué hace |
|---|---|---|
| `shop_buy(p_item)` (0026, sin cambios) | sesión | Compra la capa. `premium_item` si es premium_only |
| `cape_equip(p_item text)` | sesión | Se la pone, o se la saca con `null`. Devuelve `{ ok, item }`. Errores: `not_authenticated` y `user_banned` (42501); `bad_item`, `premium_required`, `not_owned:<ítem>` (22023) |
| `cape_mine()` | sesión | `{ item, cape, active }` o `null`. `active = false`: ya no se ve (venció Premium, ítem retirado o perdido) |
| `badge_capes(p_uuids uuid[])` | anon y sesión | `[{ mc_uuid, cape }]`: hasta 100 UUID, solo cuentas en `mc_verified`, sin banear, con capa puesta que sigan teniendo. Los silenciados aparecen, como en la insignia |

`user_capes` tiene RLS y no se lee ni se escribe directo. Baja lo mismo que la cuenta de Venus (`on delete cascade`). No se redefinen `profile_public`, `profile_customize` ni `points_ledger_reason_check`: la capa no vive en `profiles.equipped` porque `profile_customize` reemplaza ese objeto entero y la 3.1 lo mandaría sin ella.

**Hay que aplicar la migración.** Sin ella la tienda sigue igual, sin grupo de capas, y el mod recibe 404 de `badge_capes` y reintenta con espera (hasta cada 10 minutos), sin afectar a la insignia.

## Agregar una capa

1. En `mod/venus-badge/make-capes.js`: una entrada en `CAPES` y su semilla en `seeds`. Después `node make-capes.js` (desde esa carpeta), que deja el PNG en el mod y lo agrega a `features/capes/textures.js`.
2. El id en `Capes.IDS` (`Capes.java`) y en `CAPE_IDS` (`features/capes/logic.js`). `CapesTest` cuenta las capas: actualizá el número.
3. Una fila en una migración nueva con `data.cape` = ese id (como en `0034_capas.sql`). Sale recién cuando los jugadores tengan un mod con esa textura: uno viejo ignora los ids que no conoce.
4. `item_cape_<id>` en `i18n/{es,en}/rewards.js`, y la fila en `pages/rewards/fake.js`.

`features/capes/test/logic.test.js` falla si la lista no coincide entre el mod, la migración y las texturas, si el PNG de la tienda no es el del mod o si falta un nombre.

**La textura** es un PNG de 64×32 con la disposición estándar: capa en (0,0) con caras de 10×16×1 (cara de afuera en (1,1), forro en (12,1)) y elytra en (22,0) con caras de 10×20×2 (cara de atrás en (36,2), frente en (24,2)). El elytra se recorta por transparencia.

## Límites

- **Solo una lista fija incluida en el mod.** Ni URLs ni texturas subidas: el servidor solo dice un id, y `parseCapes` descarta lo que no esté en `Capes.IDS`. El check `shop_items_cape_data` tampoco deja guardar otra cosa que `[a-z0-9_]{1,24}`.
- **Mismo caché que la insignia** (una segunda instancia de `BadgeCache`): 30 minutos por jugador, lotes de 100, un pedido cada 3 s como mucho, espera de 5 s a 10 minutos si falla la red, 4096 jugadores recordados, solo UUID versión 4. Se manda solo el UUID. Por eso un cambio de capa tarda hasta 30 minutos en verse en el juego de los demás, o hasta que reabran el juego.
- **Una capa por cuenta de Venus**, compartida por todas sus cuentas de Minecraft verificadas.
- **La capa no depende de la insignia:** quien apaga la insignia sigue con la capa puesta para los demás hasta sacársela, aunque deja de tener el mod y ya no la ve.
- La capa no se puede regalar desde la interfaz (`social/gifts.js` lista solo marcos, efectos, estilos y títulos), aunque `gift_send` lo aceptaría.

## Probar

```bash
node --test "src/renderer/js/features/capes/test/*.test.js" "src/main/modules/ingame/test/*.test.js"
cd mod/venus-badge && ./gradlew build     # compila las cuatro variantes y corre CapesTest y PerfReporterTest
VENUS_REWARDS_FAKE=demo    # o premium, con VENUS_DEVSHOT: la tienda con capas, sin servidor
```

De punta a punta hacen falta **dos cuentas de Microsoft con Minecraft**, la migración aplicada y un servidor con `online-mode=true`, como la insignia (`docs/insignia.md`, sección 3): uno equipa una capa y el otro lo mira en tercera persona, con elytra y sin ella. Revisar también que:

- Una cuenta con capa oficial siga mostrando la oficial.
- Con el interruptor apagado no se vean las capas ajenas y sí la propia.
- `venus/perf.json` se actualice en un mundo, se frene en pausa y al salir, y el widget de FPS del overlay muestre el número.

## Precios confirmados para 4.5.0

| Capa | Venus Points | Condición |
|---|---:|---|
| Amanecer | 1000 | Compra permanente |
| Nebulosa | 1500 | Compra permanente |
| Aurora | 1500 | Compra permanente |
| Magma | 2500 | Compra permanente |
| Órbita | — | Incluida sólo con Premium vigente |

Estos precios fueron confirmados por el dueño. No implican que la migración 0034 ya esté publicada.

## Validación posterior de integración · 3 de noviembre de 2026

La integración principal ejecutó `gradlew clean build`: **BUILD SUCCESSFUL**, **29 tareas** en 19 s; se empaquetaron **cuatro JAR**. Los logs están en `%TEMP%/venus-codex-review-20261103/mod-build.log` y `mod-package.log`. Esto acredita compilación y empaquetado del mod, no capas, elytra o FPS con Minecraft real. Las pruebas de punta a punta de la sección anterior siguen pendientes.
