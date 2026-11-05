# Logros solo de Venus (4.6)

El dueño pidió: *"eliminar la sección de Minecraft en logros; y que los logros que haya en la sección de logros sean SOLO y EXCLUSIVOS de Venus, nada de in-game."* Este documento cuenta qué se hizo, cómo se usa y qué quedó pendiente. Es una nota de trabajo de la 4.6: el resto de la documentación (`docs/venus-points.md`, `docs/arquitectura.md`) todavía describe la versión anterior.

## Cómo se usa

- `#/achievements` tiene dos pestañas: **Logros** y **Misiones**. La pestaña **Minecraft** (los logros y progresos del juego mundo por mundo) ya no existe. `#/achievements/minecraft`, o cualquier pestaña que no exista, abre la lista de Logros y deja la dirección en `#/achievements/list`.
- Un logro vale si se calcula con datos **del launcher o de la cuenta de Venus**: instalar, instancias, mods, perfil, amigos, mensajes, voz, clips, Venus Points, uso diario, horas jugadas **medidas por el launcher** y racha. No vale si sale de lo que pasa dentro del juego: progresos y logros de Minecraft y estadísticas de los mundos (bloques minados, mobs, muertes, distancia, dimensiones, etc.).
- Los que no valen **se desactivan** (`achievements.active = false`). No se borra ningún desbloqueo ni se quita ningún punto: quien ya los tenía los conserva, el saldo y el XP del Venus Pass no cambian. Solo dejan de poder conseguirse y de mostrarse.
- Catálogo nuevo: **189 logros** (37 familias de las que ya había, con 166 pasos y **los mismos puntos de siempre**, más 23 pasos nuevos en 4 familias). Antes eran 421.

## Regla de clasificación

| Dato | ¿Vale? |
|---|---|
| Sesiones del juego que mide el launcher: horas, cantidad, racha, días distintos, sesión más larga, instancias y versiones lanzadas | Sí |
| Hitos de esas sesiones (de madrugada, a primera hora, fin de semana, volver tras un cierre inesperado, un año) | Sí |
| Inventario del launcher: instancias, mods, shaders, resource packs, servidores locales, galería de capturas y clips | Sí |
| Cuenta de Venus: perfil, amigos, mensajes, invitaciones, temas, reseñas, Venus Points, misiones, premios diarios, cosméticos, plan, insignia, cuenta de Minecraft verificada | Sí |
| Eventos de funciones del launcher (grupo, editor de skins, voz, overlay) | Sí |
| `saves/<mundo>/stats` (bloques, mobs, muertes, distancia, objetos...), `advancements/*.json` y `play_time` | **No** |
| Mundos y servidores "distintos" que el launcher deduce leyendo el registro del juego (`game.js`, `detectActivity`) | **No** (ver abajo) |

Dos casos dudosos, decididos del lado estricto: **Colonizador** (`worlds`) y **Multijugador** (`servers`) los calcula el launcher, pero a partir de lo que el juego escribe en su registro (entrar a un mundo o a un servidor), así que son in-game. Para revertirlo basta `update public.achievements set active = true where family in ('worlds', 'servers')` y volver a agregar las dos escaleras al catálogo. **Fotógrafo** (`screenshots`) cuenta los archivos de la galería del launcher, que incluye capturas hechas con F2 en el juego; se dejó porque es la galería de Venus (igual que **Director**, los clips).

## Clasificación de todo el catálogo

Producción tiene 9 cuentas; 6 desbloquearon algo (156 desbloqueos en total). La columna de cuentas sale de `public.user_achievements` (solo conteos). `id=n` es el paso y las cuentas que lo tienen; `0` es que nadie lo desbloqueó.

| Familia (pasos) | Id(s) | De qué dato sale | Cuentas de 9 que lo desbloquearon | Decisión |
|---|---|---|---|---|
| Jugador `playtime` (12) | playtime_1 … playtime_10000 | Horas de juego que mide el launcher (sesiones del juego) | playtime_1=4, playtime_5=2, playtime_10h=1 | Se queda |
| De vuelta al juego `sessions` (11) | first_launch … sessions_5000 | Veces que el launcher abrió el juego | first_launch=6, sessions_5=4, sessions_10=3, sessions_25=1 | Se queda |
| Racha `streak` (8) | streak_3 … streak_365 | Racha de días seguidos jugando (sesiones del launcher) | streak_3=3 | Se queda |
| Maratón `marathon` (6) | marathon_2 … marathon_12 | Sesión más larga medida por el launcher | marathon_2=1, marathon_3=1 | Se queda |
| Vida en el bloque `gametime` (7) | gametime_1 … gametime_5000 | Estadística play_time de los archivos de los mundos | gametime_1=1 | Se desactiva |
| Minero `blocks` (9) | blocks_100 … blocks_5000000 | Estadísticas de los mundos (bloques rotos) | blocks_100=1 | Se desactiva |
| Carbonero `coal` (4) | coal_10 … coal_5000 | Estadísticas de los mundos (menas y troncos minados) | 0 | Se desactiva |
| Herrero `iron` (4) | iron_10 … iron_5000 | Estadísticas de los mundos (menas y troncos minados) | iron_10=1 | Se desactiva |
| Buscador de oro `gold` (4) | gold_10 … gold_2500 | Estadísticas de los mundos (menas y troncos minados) | 0 | Se desactiva |
| Ingeniero `redstone` (4) | redstone_10 … redstone_5000 | Estadísticas de los mundos (menas y troncos minados) | 0 | Se desactiva |
| Encantado de minar `lapis` (4) | lapis_10 … lapis_2500 | Estadísticas de los mundos (menas y troncos minados) | 0 | Se desactiva |
| Diamantes `diamond` (7) | diamond_1 … diamond_5000 | Estadísticas de los mundos (menas y troncos minados) | 0 | Se desactiva |
| Esmeraldas `emerald` (4) | emerald_1 … emerald_250 | Estadísticas de los mundos (menas y troncos minados) | 0 | Se desactiva |
| Restos antiguos `debris` (5) | debris_1 … debris_500 | Estadísticas de los mundos (menas y troncos minados) | 0 | Se desactiva |
| Cuarzo del Nether `quartz` (4) | quartz_10 … quartz_5000 | Estadísticas de los mundos (menas y troncos minados) | 0 | Se desactiva |
| Leñador `woodcut` (4) | woodcut_50 … woodcut_25000 | Estadísticas de los mundos (menas y troncos minados) | 0 | Se desactiva |
| Artesano `crafted` (6) | crafted_50 … crafted_500000 | Estadísticas de los mundos (objetos fabricados) | crafted_50=1 | Se desactiva |
| Se gastó `broken` (5) | broken_1 … broken_1000 | Estadísticas de los mundos (herramientas rotas) | 0 | Se desactiva |
| Cazador `mobs` (8) | mobs_10 … mobs_100000 | Estadísticas de los mundos (criaturas muertas) | mobs_10=1 | Se desactiva |
| Sin cerebro `zombies` (4) | zombies_10 … zombies_5000 | Estadísticas de los mundos (criaturas y jefes muertos) | zombies_10=1 | Se desactiva |
| Huesos `skeletons` (4) | skeletons_10 … skeletons_5000 | Estadísticas de los mundos (criaturas y jefes muertos) | 0 | Se desactiva |
| Sss... `creepers` (4) | creepers_1 … creepers_1000 | Estadísticas de los mundos (criaturas y jefes muertos) | 0 | Se desactiva |
| Aracnofobia `spiders` (3) | spiders_10 … spiders_1000 | Estadísticas de los mundos (criaturas y jefes muertos) | 0 | Se desactiva |
| Teletransporte `endermen` (4) | endermen_1 … endermen_2500 | Estadísticas de los mundos (criaturas y jefes muertos) | 0 | Se desactiva |
| Bajo el fuego `blazes` (4) | blazes_1 … blazes_1000 | Estadísticas de los mundos (criaturas y jefes muertos) | 0 | Se desactiva |
| Caza de brujas `witches` (3) | witches_1 … witches_250 | Estadísticas de los mundos (criaturas y jefes muertos) | 0 | Se desactiva |
| Matadragones `dragon` (3) | dragon_1 … dragon_25 | Estadísticas de los mundos (criaturas y jefes muertos) | 0 | Se desactiva |
| Marchitador `wither` (3) | wither_1 … wither_25 | Estadísticas de los mundos (criaturas y jefes muertos) | 0 | Se desactiva |
| Guardián anciano `elder` (3) | elder_1 … elder_10 | Estadísticas de los mundos (criaturas y jefes muertos) | 0 | Se desactiva |
| Silencio `warden` (3) | warden_1 … warden_10 | Estadísticas de los mundos (criaturas y jefes muertos) | 0 | Se desactiva |
| Duelista `pvp` (5) | pvp_1 … pvp_5000 | Estadísticas de los mundos (jugadores muertos) | 0 | Se desactiva |
| Otra vez será `deaths` (7) | deaths_1 … deaths_5000 | Estadísticas de los mundos (muertes) | deaths_1=1 | Se desactiva |
| Golpe duro `damage` (4) | damage_1000 … damage_1000000 | Estadísticas de los mundos (daño causado) | 0 | Se desactiva |
| Aguantador `tanked` (4) | tanked_100 … tanked_100000 | Estadísticas de los mundos (daño) | tanked_100=1 | Se desactiva |
| Escudero `blocked` (3) | blocked_100 … blocked_10000 | Estadísticas de los mundos (daño) | 0 | Se desactiva |
| Segunda oportunidad `totems` (4) | totems_1 … totems_100 | Estadísticas de los mundos (tótems usados) | 0 | Se desactiva |
| Héroe de la aldea `raids` (4) | raids_1 … raids_100 | Estadísticas de los mundos (acciones dentro del juego) | 0 | Se desactiva |
| Trotamundos `distance` (8) | distance_1 … distance_10000 | Estadísticas de los mundos (distancia recorrida) | distance_1=1 | Se desactiva |
| Caminante `walking` (5) | walking_1 … walking_2000 | Estadísticas de los mundos (distancia recorrida) | walking_1=1 | Se desactiva |
| Piloto `flying` (5) | flying_1 … flying_5000 | Estadísticas de los mundos (distancia recorrida) | 0 | Se desactiva |
| Nadador `swimming` (4) | swimming_1 … swimming_500 | Estadísticas de los mundos (distancia recorrida) | 0 | Se desactiva |
| Capitán `boating` (4) | boating_1 … boating_500 | Estadísticas de los mundos (distancia recorrida) | 0 | Se desactiva |
| Jinete `riding` (4) | riding_1 … riding_500 | Estadísticas de los mundos (distancia recorrida) | 0 | Se desactiva |
| Maquinista `rails` (4) | rails_1 … rails_500 | Estadísticas de los mundos (distancia recorrida) | 0 | Se desactiva |
| Saltarín `jumps` (6) | jumps_1000 … jumps_1000000 | Estadísticas de los mundos (saltos) | jumps_1000=1 | Se desactiva |
| Colonizador `worlds` (6) | worlds_1 … worlds_100 | Mundos distintos que el launcher deduce leyendo el registro del juego | worlds_1=2 | Se desactiva |
| Multijugador `servers` (6) | servers_1 … servers_100 | Servidores distintos que el launcher deduce leyendo el registro del juego | servers_1=4 | Se desactiva |
| Progreso `advancements` (8) | advancements_1 … advancements_500 | Logros (advancements) de Minecraft de los mundos | advancements_1=1, advancements_10=1 | Se desactiva |
| Criador `breeder` (5) | breeder_1 … breeder_2500 | Estadísticas de los mundos (acciones dentro del juego) | 0 | Se desactiva |
| Pescador `fisher` (5) | fisher_1 … fisher_2500 | Estadísticas de los mundos (acciones dentro del juego) | 0 | Se desactiva |
| Comerciante `trader` (5) | trader_1 … trader_2500 | Estadísticas de los mundos (acciones dentro del juego) | 0 | Se desactiva |
| Encantador `enchanter` (5) | enchanter_1 … enchanter_1000 | Estadísticas de los mundos (acciones dentro del juego) | 0 | Se desactiva |
| Dormilón `sleeper` (5) | sleeper_1 … sleeper_1000 | Estadísticas de los mundos (acciones dentro del juego) | 0 | Se desactiva |
| Curioso `chests` (4) | chests_10 … chests_10000 | Estadísticas de los mundos (acciones dentro del juego) | 0 | Se desactiva |
| La torta no es mentira `cake` (3) | cake_1 … cake_100 | Estadísticas de los mundos (acciones dentro del juego) | 0 | Se desactiva |
| DJ `records` (3) | records_1 … records_100 | Estadísticas de los mundos (acciones dentro del juego) | 0 | Se desactiva |
| Músico `notes` (3) | notes_1 … notes_1000 | Estadísticas de los mundos (acciones dentro del juego) | 0 | Se desactiva |
| Campanero `bells` (3) | bells_1 … bells_250 | Estadísticas de los mundos (acciones dentro del juego) | 0 | Se desactiva |
| Generoso `shared` (3) | shared_100 … shared_10000 | Estadísticas de los mundos (objetos soltados) | 0 | Se desactiva |
| Coleccionista de instancias `instances` (7) | instances_1 … instances_100 | Instancias creadas en el launcher | instances_1=6, instances_3=2, instances_5=2 | Se queda |
| Viajero del tiempo `versions` (6) | versions_2 … versions_80 | Versiones de Minecraft que lanzó el launcher | versions_2=2, versions_5=1 | Se queda |
| Todoterreno `loaders` (5) | loaders_2 … loaders_9 | Loaders que lanzó el launcher | loaders_2=2, loaders_3=1 | Se queda |
| Modder `mods` (8) | mods_1 … mods_2500 | Mods en las carpetas de las instancias (inventario del launcher) | mods_1=6, mods_10=6, mods_50=4, mods_100=4, mods_250=2, mods_500=2, mods_1000=1 | Se queda |
| Luz y sombra `shaders` (4) | shaders_1 … shaders_25 | Shaders en las carpetas de las instancias (inventario del launcher) | shaders_1=5, shaders_5=2, shaders_10=1 | Se queda |
| Nuevo look `packs` (4) | packs_1 … packs_25 | Resource packs en las carpetas de las instancias (inventario del launcher) | packs_1=4, packs_5=3, packs_10=2, packs_25=1 | Se queda |
| Anfitrión `localservers` (5) | localservers_1 … localservers_25 | Servidores locales creados en el launcher | localservers_1=2 | Se queda |
| Fotógrafo `screenshots` (7) | first_screenshot … screenshots_5000 | Galería de capturas del launcher | first_screenshot=2 | Se queda |
| Director `clips` (7) | first_clip … clips_500 | Galería de clips del launcher | first_clip=1 | Se queda |
| Amistades `friends` (6) | first_friend … friends_100 | Amistades aceptadas (cuenta de Venus) | first_friend=5 | Se queda |
| Embajador `referrals` (6) | first_referral … referrals_100 | Invitaciones pagadas (cuenta de Venus) | 0 | Se queda |
| Charlatán `messages` (7) | messages_10 … messages_50000 | Mensajes enviados (cuenta de Venus) | messages_10=1 | Se queda |
| Compartidor `shares` (4) | first_share … shares_100 | Capturas y clips compartidos (cuenta de Venus) | 0 | Se queda |
| Diseñador `themes` (3) | theme_published … themes_10 | Temas publicados (cuenta de Venus) | 0 | Se queda |
| De la casa `member` (7) | member_7 … member_1825 | Antigüedad de la cuenta de Venus | member_7=1 | Se queda |
| Ahorrista `earned` (7) | earned_100 … earned_100000 | Venus Points ganados (libro de puntos) | earned_100=6, earned_500=2, earned_1000=1, earned_5000=1 | Se queda |
| En misión `missions` (7) | missions_1 … missions_5000 | Misiones cobradas (libro de puntos) | missions_1=2 | Se queda |
| Coleccionista `collector` (6) | collector_1 … collector_50 | Cosméticos de la tienda que tenés (cuenta de Venus) | collector_1=1, collector_5=1, collector_10=1 | Se queda |
| Cazalogros `achiever` (7) | achiever_10 … achiever_400 | Logros de Venus desbloqueados | achiever_10=5, achiever_25=2 | Se queda (4 de 7 pasos; se desactivan los pasos fuera de alcance) |
| Constancia `dailies` (6) | dailies_7 … dailies_1000 | Premios diarios reclamados (libro de puntos) | 0 | Se queda |
| En grupo `first_party` (1) | first_party | Evento de una función del launcher (venus:achievement) | 0 | Se queda |
| Con estilo `skin_created` (1) | skin_created | Evento de una función del launcher (venus:achievement) | 0 | Se queda |
| Te escucho `first_voice` (1) | first_voice | Evento de una función del launcher (venus:achievement) | first_voice=3 | Se queda |
| Sobre el juego `first_overlay` (1) | first_overlay | Evento de una función del launcher (venus:achievement) | first_overlay=5 | Se queda |
| Noctámbulo `night_owl` (1) | night_owl | Hito de sesiones del launcher (de madrugada) | 0 | Se queda |
| Madrugador `early_bird` (1) | early_bird | Hito de sesiones del launcher (a primera hora) | 0 | Se queda |
| Finde largo `weekend_warrior` (1) | weekend_warrior | Hito de sesiones del launcher (sábado y domingo) | weekend_warrior=1 | Se queda |
| Sobreviviente `crash_survivor` (1) | crash_survivor | Hito de sesiones del launcher (volver a jugar tras un cierre inesperado) | crash_survivor=4 | Se queda |
| Un año juntos `anniversary` (1) | anniversary | Hito de sesiones del launcher (un año usando Venus) | 0 | Se queda |
| Perfil completo `profile_complete` (1) | profile_complete | Perfil completo (cuenta de Venus) | profile_complete=2 | Se queda |
| Verificado `mc_verified` (1) | mc_verified | Cuenta de Minecraft verificada con Venus (cuenta de Venus) | mc_verified=1 | Se queda |
| Con insignia `badge_on` (1) | badge_on | Insignia de Venus activada (cuenta de Venus) | badge_on=1 | Se queda |
| Venus Premium `premium` (1) | premium | Plan de Venus vigente (cuenta de Venus) | premium=1 | Se queda |
| (nuevo) `days` (8) | days_5 … days_500 | Días distintos con el juego abierto (sesiones del launcher) | 0 | Se suma |
| (nuevo) `rotation` (5) | rotation_2 … rotation_20 | Instancias distintas que el launcher lanzó | 0 | Se suma |
| (nuevo) `reviews` (4) | reviews_1 … reviews_25 | Reseñas de servidores publicadas (cuenta de Venus) | 0 | Se suma |
| (nuevo) `spent` (6) | spent_100 … spent_10000 | Venus Points gastados en la tienda (libro de puntos) | 0 | Se suma |

Total: 421 logros de la 4.5 = 166 que se quedan + 255 que se desactivan (252 de dentro del juego y los 3 últimos pasos de Cazalogros, que con un catálogo más corto no se pueden alcanzar). Los desbloqueos que quedan guardados de los retirados son 19 (15 logros distintos, en 14 familias); ninguno se borra.

## Archivos

- `src/renderer/js/pages/achievements.js`: sin la pestaña Minecraft, sin `stats:ingame`, sin el modal de mundos, sin el CSS de Estadísticas (`ns: ['achievements']`).
- `src/renderer/js/pages/achievements/minecraft.js`: **borrado**.
- `src/renderer/js/pages/achievements/catalog.js`: catálogo de 189 logros. Grupos: `time`, `collection`, `capture`, `social`, `venus`, `special` (se fueron `mining`, `combat`, `explore`, `life`). `metricsFrom({ report, local, instances, localServers })` ya no recibe `ingame`. Una escalera puede fijar el nivel de cada paso con `tiers` (Cazalogros conserva el nivel y los puntos de siempre).
- `src/renderer/js/features/achievements.js`: ya no pide `stats:ingame`.
- `src/renderer/js/pages/rewards/fake.js` (solo el bloque `achievements_me` del modo de capturas): ids de Venus en lugar de los del juego.
- `src/main/modules/statsplus/ingame.js`: se sacó `PICKS` y `totals.picks` (los conteos de menas, troncos y mobs que solo servían a los logros). El resto de `stats:ingame` sigue igual: lo usa la página de Estadísticas y el editor del perfil.
- `src/renderer/styles/pages/stats.css`: se sacaron las reglas `.st-adv-*` (solo las usaba la pestaña Minecraft).
- `src/renderer/i18n/{es,en}/achievements.js`: se sacaron 55 familias (`fam_*`, `famDesc_*`, `famDesc_*_one`), `tab_minecraft` y `group_mining|combat|explore|life`; el subtítulo ya no nombra a Minecraft; claves nuevas `fam_days`, `famDesc_days`, `fam_rotation`, `famDesc_rotation`, `fam_reviews`, `famDesc_reviews`, `famDesc_reviews_one`, `fam_spent`, `famDesc_spent`.
- `scripts/gen-achievements-sql.js`: nueva opción `--since <migración>` (se puede repetir). Genera solo los logros y suma el `update ... set active = false` de los ids que esas migraciones definieron y el catálogo ya no tiene.
- `supabase/migrations/0043_logros_venus.sql`: ver abajo.
- `src/renderer/js/pages/achievements/test/catalog.test.js`: pruebas actualizadas.

No hay canales IPC nuevos ni ajustes nuevos. `achievements:localCounts` (mods, shaders, resource packs) sigue igual. `stats:ingame` sigue existiendo para Estadísticas y el perfil.

## Logros nuevos (originales, con datos de Venus)

| Familia | Pasos | Medida | Dato |
|---|---|---|---|
| Día a día (`days`) | 5, 10, 25, 50, 100, 200, 365, 500 | `daysPlayed` (PC) | Días distintos con el juego abierto (`stats:report`, `totals.daysPlayed`) |
| Cambio de aires (`rotation`) | 2, 3, 5, 10, 20 | `instancesPlayed` (PC) | Instancias distintas que lanzó el launcher (`totals.instancesPlayed`) |
| Crítico (`reviews`) | 1, 3, 10, 25 | `reviews` (servidor) | Reseñas de servidores publicadas y no ocultas (`featured_server_reviews`, 0029) |
| De compras (`spent`) | 100, 500, 1000, 2500, 5000, 10000 | `pointsSpent` (servidor) | Venus Points gastados en la tienda (`points_ledger`, motivo `shop`, delta negativo) |

Los de la PC valen de 5 a 100 puntos y los del servidor de 15 a 250, como el resto (tope de 40 por día para los de la PC).

## Servidor: 0043_logros_venus.sql

Idempotente, sin `drop` ni `delete`. Qué hace:

1. `private.achievement_metric`: parte de la definición de producción (idéntica a 0023). Suma `reviews` y `pointsSpent`, y `achievements` (los pasos de Cazalogros) pasa a contar **solo los logros activos**.
2. `public.achievements_me`: parte de la de producción. `unlocked` y `rarity` solo traen los logros activos, así la página y el editor del perfil no ven los retirados. Mismo formato de respuesta, mismos permisos (`authenticated`).
3. Catálogo (generado con el script): `update public.achievements set active = false` de los 255 retirados y `insert ... on conflict do update` de los 189 del catálogo (mismos puntos que antes en los 166 que siguen; `sort` reordenado).

`achievement_claim`, `achievements_claim` y `achievements_sweep` no se tocan: ya filtraban por `active`, así que un cliente viejo que pida un logro retirado recibe `bad_achievement` o simplemente se saltea.

### Prueba

Contra producción (`dzchklzaxyygbvfpagvx`) con `execute_sql` en una transacción que termina en `rollback` (después se comprobó que producción sigue con 421 logros activos y sin `days_5`):

- Antes: 421 logros, 421 activos, 156 desbloqueos, 256 movimientos del libro. Después de aplicar la migración **dos veces** (idempotencia): 444 filas, 189 activos, 255 inactivos.
- Los 156 desbloqueos y los 256 movimientos del libro siguen idénticos (mismas filas, mismas fechas, mismos saldos por cuenta). Ningún logro que sigue cambió de puntos ni de tipo.
- Con una cuenta simulada (`request.jwt.claims` + `set local role authenticated`): `achievements_me` devuelve 33 desbloqueos activos de 47 que tiene la cuenta (los 14 restantes son de logros retirados y no se ven); `unlocked` y `rarity` sin ningún retirado; `metrics` trae `pointsSpent` y `reviews`; la medida `achievements` da 33. `achievements_claim` con `blocks_100`, `diamond_1` y `gametime_1` no otorga nada y con `days_5` otorga 5 puntos; `achievement_claim('mobs_10')` falla con `bad_achievement`. `achievements_sweep` de una cuenta con 6200 puntos gastados desbloquea `spent_100` a `spent_5000`, justo los esperados.
- Permisos: `achievements_me` ejecutable por `authenticated`, no por `anon`; `private.achievement_metric` no ejecutable por `authenticated`.

La migración **no está aplicada**: el dueño decide cuándo. Hasta entonces el cliente nuevo funciona igual (la página filtra por su catálogo), pero los 23 logros nuevos no se pueden registrar (el servidor los saltea porque todavía no existen) y los retirados se siguen pudiendo reclamar desde clientes viejos.

## Misiones

No se cambió ninguna. Las 24 misiones usan estas medidas (`features/missions.js`):

| Misión(es) | Medida | De dónde sale |
|---|---|---|
| `d_play_*`, `w_play_*` | `playMinutes` | Reloj del launcher con el juego abierto |
| `d_launch_*`, `w_launch_*` | `launches` | El launcher abre el juego |
| `d_shot_1`, `w_shot_5`, `d_clip_1`, `w_clip_3` | `screenshots`, `clips` | Evento `capture:saved` de las capturas de Venus |
| `d_message_1`, `w_message_10`, `d_voice_1`, `w_voice_3`, `d_reward_1`, `w_reward_5`, `w_ach_3` | `messages`, `voiceJoins`, `dailyRewards`, `achievements` | Cuenta de Venus |
| **`d_server_1`, `w_server_3`** | `serverJoins` | **`game:activity`: el launcher lee el registro del juego para saber que entraste a un servidor** |
| **`d_world_1`** | `worldVisits` | **`game:activity`: ídem, para saber que abriste un mundo** |

Las tres últimas dependen de lo que pasa dentro del juego (aunque las detecta el launcher). Se dejaron como estaban hasta que el dueño decida. Aparte, `w_ach_3` ("Desbloqueá 3 logros") queda más difícil: ya no hay logros del juego fáciles de sumar.

## Pendientes y ganchos para otros

- **`profile_public.achievementCount`** (la tarjeta del perfil muestra "N de M logros") cuenta todos los `user_achievements`, retirados incluidos, mientras `achievementTotal` cuenta solo los activos. No se redefinió porque la función la modifican otros (migración 0039). Cuando se aplique 0043, `achievementCount` tendría que contar solo logros activos (`join public.achievements a on a.id = ua.achievement_id and a.active`). Hoy ninguna cuenta tiene logros retirados fijados en el perfil (se comprobó en producción).
- **`src/renderer/js/features/profile-editor/demo.js`** (modo de demostración del editor del perfil) todavía usa ids retirados (`diamond_1`, `dragon_1`, `mobs_100`, `blocks_1000`). Solo se ve en capturas con `demo`.
- **Idiomas**: los otros 12 idiomas de `achievements.js` tienen claves viejas que ya no se usan (151 en de, fr, it, nl, pl, pt, ru, tr y uk; 115 en ja, ko y zh), les faltan las 9 claves nuevas y su `subtitle` todavía nombra a Minecraft. Hay que borrar lo que sobra y traducir lo nuevo.
- **Namespace `stats`**: quedaron sin uso `advSub`, `advDoneShort`, `advRingAria`, `advNone`, `advNoTotal`, `advReference`, `advMods`, `advRecent`, `advNoRecent`, `advMissing`, `advMissingHide`, `advAllDone`, `advPickWorld`, `advPerWorld`, `advHidden`, `advHiddenDesc` y `cat_story`, `cat_nether`, `cat_end`, `cat_adventure`, `cat_husbandry`, `cat_mods` (los usaba solo la pestaña Minecraft). No se tocaron porque el namespace no es de Logros.
- **Documentación**: `docs/venus-points.md` (sección "Logros y misiones de la 3.0") y `docs/arquitectura.md` (fila `achievements` de la tabla, que nombra `minecraft.js`) hay que ponerlos al día.

## Cómo probarlo

```
node --test "src/renderer/js/pages/achievements/test/*.test.js"
node scripts/gen-achievements-sql.js salida.sql --since supabase/migrations/0024_logros_catalogo.sql   # debe dar lo mismo que 0043
VENUS_DATA_DIR=<temporal> VENUS_DEVSHOT=<carpeta> VENUS_SKIP_ONBOARDING=1 VENUS_REWARDS_FAKE=demo \
  VENUS_DEVSHOT_ROUTES="achievements;;achievements/missions;;achievements/minecraft" ./node_modules/.bin/electron.cmd .
```

Para ver el idioma, poner `language` y `privacy.decided: true` en `<temporal>/data/settings.json` antes de abrir.
