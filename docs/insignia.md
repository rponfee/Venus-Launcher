# Insignia de Venus

El planeta de Venus antes del nombre de los jugadores que usan Venus Launcher, sobre la cabeza y en la lista de jugadores (Tab), como hacen Lunar o Feather. Lo ven solo quienes también tienen la insignia prendida (hace falta el mod para dibujarla). Es opcional y viene apagada.

| Parte | Dónde |
|---|---|
| Mod de cliente "Venus Badge" (Fabric/Quilt 1.20.1, 1.21 y 1.21.1; NeoForge 1.21 y 1.21.1; Forge 1.20.1) | `mod/venus-badge` |
| Compilación en CI | `.github/workflows/mod.yml` (también lo llama `build.yml`) |
| Lista de cuentas y funciones SQL | `supabase/migrations/0019_insignia.sql` |
| Verificación con Mojang | Edge Function `supabase/functions/badge` |
| Launcher: instalar el mod y anotar la cuenta | `src/main/modules/ingame.js`, `ingame/badgemod.js`, `ingame/badge.js` |
| Interruptor | Ajustes → General → Venus en el juego (`settings.ingame.badge`) |

## 1. Cómo funciona

### Anotarse (launcher)

Al prender el interruptor, y antes de cada partida con una cuenta de Microsoft si esa cuenta todavía no estaba anotada:

1. `badge_mine()` con la sesión de Venus: si el UUID ya está, no se hace nada más (una consulta por partida).
2. `badge_challenge()` devuelve un desafío de 40 caracteres hexadecimales, de un solo uso, que vence a los 2 minutos (uno cada 10 s por usuario).
3. El launcher hace `POST https://sessionserver.mojang.com/session/minecraft/join` con el token de Minecraft de la cuenta y el desafío como `serverId`. Es exactamente lo que hace el juego al entrar a un servidor premium: el token va solo a Mojang.
4. La Edge Function `badge` recibe `{ uuid, name, serverId }` con la sesión de Venus, gasta el desafío (`badge_take_challenge`), le pregunta a Mojang `hasJoined?username=<name>&serverId=<desafío>` y, si Mojang devuelve ese mismo UUID, lo anota (`badge_enroll`).

Por qué nadie puede anotar la cuenta de otro: para que `hasJoined` responda, alguien tiene que haber hecho el paso 3 con el token de esa cuenta de Minecraft y con un desafío que solo conoce la cuenta de Venus que lo pidió. Si la misma cuenta de Minecraft se anota desde otra cuenta de Venus (también probando que es suya), pasa a esa cuenta.

Topes: 5 cuentas de Minecraft por cuenta de Venus; las cuentas baneadas (`moderation_social_block`) no pueden anotarse y sus insignias no se muestran. Las sesiones anónimas de Supabase no pueden anotarse.

Al apagar el interruptor se llama a `badge_remove()` (borra todas las cuentas de quien llama) y el mod sale de cada instancia la próxima vez que se juega. Si falta la sesión de Venus en ese momento, `settings.ingame.badgeEnrolled` queda en `true` y se reintenta al jugar. Borrar la cuenta de Venus borra sus filas (`on delete cascade`).

### Dibujar la insignia (mod)

- Antes de jugar, `ingame/badgemod.js` copia en `mods/` el `.jar` del loader y la versión de la instancia, siempre como `venus-badge.jar`, y escribe `config/venus-badge.json` con la URL y la anon key del proyecto (las de `core/cloud-defaults.js`). En vanilla, OptiFine, otras versiones y un Fabric o Quilt demasiado viejo (ver sección 4) no instala nada (y si estaba, lo quita). Si el jugador lo desactivó desde la lista de mods (`venus-badge.jar.disabled`), no lo toca.

  | Instancia | Minecraft | `.jar` empaquetado en `ingame/mods` |
  |---|---|---|
  | Fabric, Quilt | 1.21, 1.21.1 | `venus-badge-mc1.21.1-fabric.jar` |
  | Fabric, Quilt | 1.20.1 | `venus-badge-mc1.20.1-fabric.jar` |
  | NeoForge | 1.21, 1.21.1 | `venus-badge-mc1.21.1-neoforge.jar` |
  | Forge | 1.20.1 | `venus-badge-mc1.20.1-forge.jar` |

  NeoForge 1.20.1 no está en la lista: es un fork de Forge y podría cargar el `.jar` de Forge, pero no se probó.
- El mod pregunta `badge_lookup(p_uuids)` por PostgREST (`POST /rest/v1/rpc/badge_lookup` con la anon key): manda solo UUID y recibe cuáles tienen la insignia. Nunca la lista completa.
- Caché en memoria (`BadgeCache`): 30 minutos por jugador; lotes de hasta 100 UUID; como mucho un pedido cada 3 s; si falla la red, espera 5 s, 10 s, 20 s… hasta 10 minutos; hasta 4096 jugadores recordados. Solo consulta UUID versión 4 (cuentas premium): los de servidores sin verificación y los NPC no se mandan.
- El hilo "Venus Badge" hace los pedidos: el juego nunca espera a la red. Sin red no se dibuja ninguna insignia nueva y nada se rompe.
- El ícono es un carácter de uso privado (`U+E000`) de la fuente `venusbadge:badge` (bitmap de 8×8, `assets/venusbadge/textures/font/badge.png`, generado desde `src/renderer/assets/logo-64.png` con `python scripts/make-badge-icon.py`). Se agrega antes del nombre en dos lugares:

  | | Nombre sobre la cabeza (la línea de puntaje queda igual) | Lista de jugadores (Tab; el ancho de las columnas lo tiene en cuenta) |
  |---|---|---|
  | Fabric, Quilt | mixin en `PlayerEntityRenderer.renderLabelIfPresent` | mixin en `PlayerListHud.getPlayerName` |
  | NeoForge, Forge | evento `RenderNameTagEvent` | mixin en `PlayerTabOverlay.getNameForDisplay` |

Por qué una función SQL y no una Edge Function para consultar: las Edge Functions tienen un cupo mensual de invocaciones y cada jugador con el mod hace varias consultas por hora de juego; PostgREST no tiene ese cupo.

## 2. Desplegar

1. Aplicá `supabase/migrations/0019_insignia.sql` (después de 0012; en el proyecto de Venus va como `venus_0019_insignia`).
2. Desplegá la función con la verificación de JWT activada:

   ```bash
   supabase functions deploy badge
   ```

   No tiene secretos propios: `SUPABASE_URL`, `SUPABASE_ANON_KEY` y `SUPABASE_SERVICE_ROLE_KEY` los pone Supabase.
3. El mod se compila solo en las releases (`build.yml` llama a `mod.yml`): los cuatro `.jar` van dentro del launcher (`src/main/modules/ingame/mods/venus-badge-mc<minecraft>-<loader>.jar`) y como archivos de la release. Para probar en la PC: `npm run mod:badge` (Gradle y Loom necesitan Java 25 o más nuevo; cada `.jar` sale para el Java de su Minecraft, 17 o 21, y Gradle baja esos Java si faltan).

Sin la migración o sin la función, el interruptor muestra "El servidor de Venus todavía no tiene activada la insignia" y el mod no dibuja nada (`badge_lookup` responde 404 y el mod reintenta con espera).

## 3. Probar

- Pruebas sin red: `node --test "src/main/modules/ingame/test/*.test.js" supabase/functions/badge/tests/badge.test.ts` y, en `mod/venus-badge`, `./gradlew test` (caché, lotes, límite de pedidos y espera).
- De punta a punta hacen falta **dos cuentas de Microsoft con Minecraft** (cada una con su cuenta de Venus o la misma) y un servidor con `online-mode=true` (por ejemplo uno local de Venus):
  1. En cada launcher, prendé la insignia y esperá "Listo: <nombre> tiene la insignia de Venus".
  2. Abrí una instancia compatible en cada PC (Fabric 1.21.1, NeoForge 1.21.1, Forge 1.20.1...) y entrá al mismo servidor. Para probar Forge o NeoForge, las dos instancias tienen que poder entrar al servidor: un servidor vanilla les sirve a todas si es de su misma versión.
  3. Cada jugador tiene que ver el planeta antes del nombre del otro (sobre la cabeza y con Tab) y antes del suyo en Tab. Apagá la insignia en uno: después de 30 minutos (o al volver a abrir el juego del otro) deja de verse.
- Consultar a mano (la anon key es la de `core/cloud-defaults.js`):

  ```bash
  curl -X POST "$SUPABASE_URL/rest/v1/rpc/badge_lookup" -H "apikey: $ANON" -H "Authorization: Bearer $ANON" \
    -H "Content-Type: application/json" -d '{"p_uuids":["<uuid>"]}'
  ```

## 4. Cómo está armado el mod

Un solo proyecto de Gradle (`mod/venus-badge`) con un subproyecto por `.jar`; `gradlew build` compila todo y junta los `.jar` en `build/libs` (la tarea `collectJars` de la raíz). De ahí los toman `mod.yml` y `scripts/build-badge-mod.js`.

- **La lógica común se comparte como fuentes.** `src/main/java` (`BadgeCache`, `BadgeClient`, `BadgeCore`: nada de Minecraft) y los recursos entran como carpetas de fuentes en cada subproyecto. Así cada `.jar` sale para el Java de su Minecraft y queda solo, sin un jar común que haya que meter adentro.
- **Lo que depende de los nombres de Minecraft se comparte por familia de nombres**: `shared-yarn` (Fabric) y `shared-mojmap` (NeoForge y Forge). Fabric usa Yarn y NeoForge/Forge los nombres de Mojang, así que `Text` y `Component` no se pueden unificar sin una capa de abstracción que para dos llamadas no vale la pena.
- **Sin Architectury ni Unimined.** Harían falta para compartir código que toca Minecraft entre Yarn y Mojang, y acá ese código son unas 40 líneas. Agregarían un plugin más que tiene que seguirle el ritmo a Gradle y a Loom.
- **Un único Gradle**: ModDevGradle (también su plugin `legacyforge`, para Forge 1.20.1) corre en la misma versión de Gradle que Loom, así que alcanza con un wrapper y un `gradlew build`. `disableRecompilation` evita descompilar y recompilar Minecraft: el mod no necesita sus fuentes.
- **Forge 1.20.1 juega con nombres SRG**: el `.jar` final es el de `reobfJar` (`build/libs`, el de `build/devlibs` no sirve para jugar) y el procesador de Mixin escribe `venusbadge.refmap.json`. También lleva `pack.mcmeta`: sin ese archivo Forge descarta los recursos del mod y avisa al cargar. El manifiesto (`MixinConfigs`) es el que le dice a Forge dónde está el mixin; en NeoForge lo dice `neoforge.mods.toml`.
- **En Forge y NeoForge el mixin no puede romper un modpack**: el nombre sobre la cabeza va por un evento público y el único mixin (Tab) tiene `"required": false` y `"defaultRequire": 0`. Si otro mod lo impide, falta la insignia en Tab, pero el juego arranca.
- **Fabric lleva adentro `fabric-resource-loader-v0` y `fabric-api-base`** (jar-in-jar). Sin el módulo de recursos de Fabric API, Fabric no carga los assets de ningún mod: la fuente no existiría y se vería un cuadradito en vez del planeta. Si la instancia tiene Fabric API, Fabric Loader se queda con la versión más nueva de cada módulo. Ese módulo pide un loader mínimo y sin él el juego no arranca, así que el launcher no instala el mod con uno más viejo (`minLoader` en `BUILDS`): Fabric Loader 0.15.11 o Quilt Loader 0.26.0 en 1.21.x; 0.14.21 o Quilt 0.19.0 en 1.20.1.

## 5. Agregar otra versión de Minecraft

1. Otro subproyecto en `mod/venus-badge` (y en `settings.gradle`) con su `gradle.properties`, sus metadatos y lo que cambie (ver [mod/venus-badge/README.md](../mod/venus-badge/README.md)). Desde la 1.21.2 los nombres se dibujan con `EntityRenderState`, así que el mixin del nombre de Fabric cambia y `RenderNameTagEvent` de NeoForge también; desde 26.1 el juego no viene ofuscado y se usa el plugin de Loom sin mappings.
2. Que el subproyecto diga cuál es su `.jar` final (`ext.finalJar`): `collectJars` lo deja como `venus-badge-<versión>+mc<minecraft>-<loader>.jar` y `mod.yml` lo copia como `venus-badge-mc<minecraft>-<loader>.jar`. Sumalo también al paso "Revisar los .jar" de `mod.yml`.
3. Una fila más en `BUILDS` de `src/main/modules/ingame/badgemod.js` y en `BADGE_BUILDS` de `src/renderer/js/pages/settings/general.js`.

## 6. Capas retiradas y FPS del mod (1.3.0)

El dueño pidió sacar "las capas que solo ve uno mismo" y se retiró **toda** la función de capas de Venus (tienda, mod y launcher). La insignia y los FPS del mod se quedan.

- **Para el jugador.** El mod **Venus Badge 1.3.0** ya no dibuja capas ni las pide al servidor: sigue dibujando la insignia (sobre la cabeza y en Tab) y informando los FPS. El launcher ya no tiene "Ver las capas de otros jugadores", el aviso de la tienda ni la vista previa de la capa. `config/venus-badge.json` queda solo con `url` y `anonKey`: si una instancia traía `"showCapes": false` de la 4.5, el launcher la reescribe sin esa clave en la próxima partida. `ingame/badgemod.js` compara el `.jar` por contenido y lo reemplaza en la próxima partida con la insignia prendida; hasta entonces una instancia sin abrir con el launcher nuevo sigue con el 1.2.0 y dibuja las capas que ya estaban.
- **Qué se quitó del mod.** `Capes.java`, `CapesTest.java`, `make-capes.js`, las cinco texturas `assets/venusbadge/textures/cape/*.png`, los mixins de la capa (`AbstractClientPlayerEntityMixin` en Fabric y `AbstractClientPlayerMixin` en Forge y NeoForge, con su entrada en cada `venusbadge.mixins.json`), y de `BadgeCore`, `BadgeClient`, `VenusBadge` y `BadgeGame` todo lo de capas (`showCapes`, `cape()`, `fetchCapes`, `parseCapes`, la consulta `badge_capes`). `mod_version` pasó de 1.2.0 a 1.3.0.
- **Qué se quitó del launcher.** `features/capes.js`, `features/capes/` y `styles/features/capes.css`, el namespace `capes` en los 14 idiomas, su entrada de `STARTUP`, y en `modules/ingame.js` el ajuste `capes` y el `showCapes` que le pasaba a `badgemod.apply`. `settings.ingame.capes` queda como dato inerte.
- **Se conserva: la insignia.** `BadgeCache`, `BadgeClient` (`badge_styles` con respaldo `badge_lookup`), `BadgeCore`, `BadgeText`/`VenusBadge`, los mixins del nombre y de Tab y la fuente `venusbadge:badge`.
- **Se conserva: los FPS (`PerfReporter`).** Cada 2 s, con un mundo abierto y sin pausa, el mod reescribe `<carpeta del juego>/venus/perf.json` con `{ "fps": 60, "at": <epoch en ms> }`. Lo leen el historial de rendimiento y el widget del overlay con `perfhistory/fps.js`. Al salir del mundo deja de escribir y el lector descarta el dato a los 10 s. Tiene su propio hilo y escribe en un temporal que después renombra. Para que siga escribiendo en pausa, hay que sacar `client.isPaused()` de `fpsInWorld` en `VenusBadge` y `BadgeGame`.
- **Servidor.** Los objetos de la 0034 (`user_capes`, `cape_equip`, `cape_mine`, `badge_capes` y las filas `kind = 'cape'` de `shop_items`) los elimina la 0048. Mientras queden instancias con el mod 1.2.0, `badge_capes` borrada da 404 y el mod reintenta con espera creciente (hasta cada 10 minutos) sin afectar a la insignia: conviene aplicar la 0048 después de publicar el launcher 4.6.
- **Cómo se probó.** `cd mod/venus-badge && ./gradlew clean build --console=plain --no-daemon --offline` con Temurin 25 (Fabric), Temurin 21 (NeoForge) y el JDK 17 de `~/.gradle/jdks` (Forge): las cuatro variantes compilan y pasan las 16 pruebas de JUnit (`BadgeCacheTest` 9, `BadgeCoreTest` 3, `PerfReporterTest` 4). En los cuatro `.jar` no queda ningún nombre ni cadena con `cape`, `cloak`, `showCapes` o `badge_capes`. **No se probó** el mod dentro de Minecraft con el `.jar` nuevo.
