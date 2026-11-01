# Insignia de Venus

El planeta de Venus antes del nombre de los jugadores que usan Venus Launcher, sobre la cabeza y en la lista de jugadores (Tab), como hacen Lunar o Feather. Lo ven solo quienes también tienen la insignia prendida (hace falta el mod para dibujarla). Es opcional y viene apagada.

| Parte | Dónde |
|---|---|
| Mod de cliente "Venus Badge" (Fabric, sin Fabric API) | `mod/venus-badge` |
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

- Antes de jugar, `ingame/badgemod.js` copia `venus-badge.jar` en `mods/` de las instancias **Fabric o Quilt de Minecraft 1.21 y 1.21.1** y escribe `config/venus-badge.json` con la URL y la anon key del proyecto (las de `core/cloud-defaults.js`). En vanilla, Forge, NeoForge, OptiFine y otras versiones no instala nada (y si estaba, lo quita). Si el jugador lo desactivó desde la lista de mods (`venus-badge.jar.disabled`), no lo toca.
- El mod pregunta `badge_lookup(p_uuids)` por PostgREST (`POST /rest/v1/rpc/badge_lookup` con la anon key): manda solo UUID y recibe cuáles tienen la insignia. Nunca la lista completa.
- Caché en memoria (`BadgeCache`): 30 minutos por jugador; lotes de hasta 100 UUID; como mucho un pedido cada 3 s; si falla la red, espera 5 s, 10 s, 20 s… hasta 10 minutos; hasta 4096 jugadores recordados. Solo consulta UUID versión 4 (cuentas premium): los de servidores sin verificación y los NPC no se mandan.
- El hilo "Venus Badge" hace los pedidos: el juego nunca espera a la red. Sin red no se dibuja ninguna insignia nueva y nada se rompe.
- El ícono es un carácter de uso privado (`U+E000`) de la fuente `venusbadge:badge` (bitmap de 8×8, `assets/venusbadge/textures/font/badge.png`, generado desde `src/renderer/assets/logo-64.png` con `python scripts/make-badge-icon.py`). Se agrega antes del nombre en `PlayerEntityRenderer.renderLabelIfPresent` (nombre sobre la cabeza; la línea de puntaje queda igual) y en `PlayerListHud.getPlayerName` (Tab; el ancho de las columnas lo tiene en cuenta).

Por qué una función SQL y no una Edge Function para consultar: las Edge Functions tienen un cupo mensual de invocaciones y cada jugador con el mod hace varias consultas por hora de juego; PostgREST no tiene ese cupo.

## 2. Desplegar

1. Aplicá `supabase/migrations/0019_insignia.sql` (después de 0012; en el proyecto de Venus va como `venus_0019_insignia`).
2. Desplegá la función con la verificación de JWT activada:

   ```bash
   supabase functions deploy badge
   ```

   No tiene secretos propios: `SUPABASE_URL`, `SUPABASE_ANON_KEY` y `SUPABASE_SERVICE_ROLE_KEY` los pone Supabase.
3. El mod se compila solo en las releases (`build.yml` llama a `mod.yml`): va dentro del launcher (`src/main/modules/ingame/mods/venus-badge-mc1.21.1.jar`) y como archivo de la release. Para probar en la PC: `npm run mod:badge` (Java 21 o más nuevo).

Sin la migración o sin la función, el interruptor muestra "El servidor de Venus todavía no tiene activada la insignia" y el mod no dibuja nada (`badge_lookup` responde 404 y el mod reintenta con espera).

## 3. Probar

- Pruebas sin red: `node --test "src/main/modules/ingame/test/*.test.js" supabase/functions/badge/tests/badge.test.ts` y, en `mod/venus-badge`, `./gradlew test` (caché, lotes, límite de pedidos y espera).
- De punta a punta hacen falta **dos cuentas de Microsoft con Minecraft** (cada una con su cuenta de Venus o la misma) y un servidor con `online-mode=true` (por ejemplo uno local de Venus):
  1. En cada launcher, prendé la insignia y esperá "Listo: <nombre> tiene la insignia de Venus".
  2. Abrí una instancia Fabric 1.21.1 en cada PC y entrá al mismo servidor.
  3. Cada jugador tiene que ver el planeta antes del nombre del otro (sobre la cabeza y con Tab) y antes del suyo en Tab. Apagá la insignia en uno: después de 30 minutos (o al volver a abrir el juego del otro) deja de verse.
- Consultar a mano (la anon key es la de `core/cloud-defaults.js`):

  ```bash
  curl -X POST "$SUPABASE_URL/rest/v1/rpc/badge_lookup" -H "apikey: $ANON" -H "Authorization: Bearer $ANON" \
    -H "Content-Type: application/json" -d '{"p_uuids":["<uuid>"]}'
  ```

## 4. Agregar otra versión de Minecraft

1. Otra carpeta de compilación (o un subproyecto) en `mod/` con la versión de Minecraft y los mappings que correspondan. Desde la 1.21.2 los nombres se dibujan con `EntityRenderState`, así que el mixin del nombre cambia; desde 26.1 el juego no viene ofuscado y se usa el plugin de Loom sin mappings.
2. Que `mod.yml` copie el `.jar` como `venus-badge-mc<versión>.jar`.
3. Una fila más en `BUILDS` de `src/main/modules/ingame/badgemod.js` y en `BADGE_VERSIONS` de `src/renderer/js/pages/settings/general.js`.
