# Venus Points, invitaciones, logros, tienda y Venus Premium

Puntos que se ganan con el premio diario, los logros y las invitaciones, y se gastan en cosméticos para el perfil (marcos, efectos del nombre, estilos de la insignia y títulos). Premium es tener un plan de Venus vigente: aplica los multiplicadores de cada regla y trae cosméticos incluidos. El premio de desafíos de 4.5.0 no se duplica.

| Parte | Dónde |
|---|---|
| Esquema y reglas (libro de puntos, invitaciones, logros, tienda) | `supabase/migrations/0021_puntos.sql` |
| Premium, cosméticos y `profile_customize` (equipar) | `supabase/migrations/0020_perfiles.sql` |
| Verificación de la cuenta de Minecraft con Mojang | Edge Function `supabase/functions/mcverify` (usa `../badge/handler.ts`) |
| Página `#/rewards` | `src/renderer/js/pages/rewards.js` (+ `pages/rewards/`: `logic.js`, `backend.js`, `fake.js`), `styles/pages/rewards.css` |
| Logros automáticos, saldo compartido y chip de la barra lateral | `src/renderer/js/features/rewards.js` |
| Premium para el resto del launcher | `src/renderer/js/features/premium.js`, `styles/features/premium.css` |
| Verificar la cuenta (proceso principal) | `src/main/modules/rewards.js` (+ `rewards/verify.js`, `rewards/fake.js`) |
| Textos | `i18n/{es,en}/rewards.js` y `premium.js` (interfaz); `src/main/i18n/{es,en}/rewards.js` (errores de la verificación) |
| Pruebas | `node --test "src/main/modules/rewards/test/"` |

## Logros y misiones de la 3.0

- **Catálogo**: `src/renderer/js/pages/achievements/catalog.js`. No hay tope: se agrega una escalera o un paso, se corre `node scripts/gen-achievements-sql.js supabase/migrations/00NN_logros.sql`, se aplica la migración y se suman los textos `fam_<familia>` y `famDesc_<familia>` en `i18n/<idioma>/achievements.js`. Los ids nunca cambian y los 18 de la 2.x se conservan con sus puntos.
- **Comprobación**: `check_kind = 'client'` lo informa la PC (`achievements_claim`, varios a la vez, tope de 40 por día; se pueden falsear, por eso valen poco: de 5 a 100 puntos) y `'server'` lo comprueba el servidor con `private.achievement_metric` (`achievements_sweep`).
- **Lectura**: `achievements_me` devuelve los desbloqueados, el porcentaje de jugadores de cada uno (la rareza se muestra desde 20 usuarios) y las medidas del servidor. `points_me` sigue devolviendo solo los 18 de la 2.x para que esas versiones no muestren cientos sin nombre.
- **Misiones**: tabla `missions`. `missions_me` elige 3 por período, siempre las mismas por usuario (hash de usuario, período y misión) y con medidas distintas; `mission_claim` paga una vez por período (`points_ledger` con motivo `mission`), y al cobrar las tres da el bono (25 o 100, x2 con Premium). El progreso lo cuenta el launcher (`features/missions.js`, `settings.rewards.missions`, evento `venus:mission`), así que se puede falsear; el tope queda fijo por período.
- Las pruebas del catálogo están en `src/renderer/js/pages/achievements/test/`.

## 1. Reglas de los puntos

Todo pasa por un libro de movimientos (`points_ledger`): cada premio tiene un par `(motivo, ref)` único, así que el mismo premio nunca se da dos veces aunque se pida muchas veces o desde dos PCs a la vez. El saldo es la suma del libro. La interfaz nunca escribe puntos: solo llama a las funciones del servidor.

| Motivo | Cuánto | Cuándo |
|---|---|---|
| `daily` | 10 + 5 por cada día seguido antes de hoy, hasta +25 (máximo 35 por día); **x2 con Premium** | Una vez por día UTC (`points_daily_claim`). `ref` = la fecha |
| `achievement` | Lo que da cada logro (tabla de la sección 3); **x2 con Premium** | Al desbloquearlo (`achievement_claim`) |
| `referral` | 500 para quien invita | Cuando el invitado verifica una cuenta de Minecraft que sirva (sección 2) |
| `referred` | 200 para el invitado | En el mismo momento |
| `shop` | Negativo: el precio | Al comprar en la tienda (`shop_buy`) |
| `admin` | Cualquiera | Ajustes manuales del equipo de Venus |

El premio diario vuelve a la medianoche UTC. La racha se cuenta en el servidor hasta 30 días hacia atrás; la página la reconstruye con los últimos 30 movimientos de `points_me` (`logic.js: dailyStreak`), y si el historial está lleno de premios diarios puede mostrar menos días de los reales (el bono ya está al máximo desde el quinto día).

## 2. Invitaciones y anti-trampa

1. Cada cuenta tiene un código `VP-XXXXXX` (`referral_my_code`, se crea la primera vez; alfabeto sin 0, O, 1 ni I). La página lo muestra con **Copiar código** y un mensaje listo para compartir con el link de descarga (`https://github.com/rponfee/Venus-Launcher/releases/latest`).
2. El invitado lo canjea en **Venus Points → Invitaciones** en sus primeros 14 días (`referral_claim`). Errores: `bad_code`, `own_code`, `already_referred`, `too_late`, `loop` (canjear el código de alguien que se unió con el tuyo).
3. Canjear no paga nada todavía. **Los puntos llegan recién cuando el invitado verifica una cuenta de Minecraft real** con el botón **Verificar mi cuenta de Minecraft** (o al activar la insignia de Venus, que hace la misma prueba).

La verificación es la misma de la insignia (`docs/insignia.md`): `badge_challenge` da un desafío de un solo uso, el launcher "entra" al servidor de sesiones de Mojang con el token de la cuenta de Microsoft elegida (como el juego al entrar a un servidor premium) y la Edge Function `mcverify` le pregunta a Mojang si esa cuenta entró con ese desafío. El token de Minecraft va **solo a Mojang**; a Venus llegan el UUID, el nombre y el desafío. Lo hace el proceso principal (`rewards:verifyMinecraft` → `ingame.badgeClient().enroll(cuenta, { fn: 'mcverify' })`).

Por qué no se puede hacer trampa creando cuentas:

- Una cuenta de Venus nueva sin una cuenta de Minecraft comprada no da nada: sin verificar, la invitación queda pendiente para siempre.
- Cada cuenta de Minecraft sirve para **una sola invitación** (`referrals.mc_uuid` es único) y nunca una que el que invita haya verificado alguna vez (`mc_verify_log` guarda quién verificó cada cuenta y sobrevive a borrar cuentas).
- Tope de 100 invitaciones pagadas por cuenta; las cuentas suspendidas no cobran.
- El código solo se canjea en los primeros 14 días de la cuenta del invitado.

Errores de la verificación (`err.code`, texto en `src/main/i18n/<idioma>/rewards.js`): `noAccount`, `offlineAccount` y `accountSession` (la página ofrece **Cuentas de Minecraft**), `noSession` (lleva a Ajustes → Cuenta y nube), `noCloud`, `network`, `unavailable`, `multiplayerDisabled` (cuentas sin multijugador por la privacidad de Xbox o cuentas infantiles), `mojangSession`, `mojang`, `notVerified`, `tooManyAccounts`, `banned`, `rateLimited`, `server`. Dos clics seguidos comparten la misma verificación.

## 3. Logros

| Id | Puntos | Lo comprueba |
|---|---|---|
| `first_launch` | 50 | PC: al abrir el juego por primera vez (`game:state` running) o si las estadísticas ya tienen partidas |
| `playtime_10h` · `playtime_100h` | 100 · 400 | PC: `stats:summary` (`totalMs`) |
| `instances_5` | 50 | PC: `store.instances` |
| `first_screenshot` · `first_clip` | 25 · 50 | PC: los avisa la función de capturas |
| `first_party` | 75 | PC: lo avisa la función de grupos |
| `skin_created` | 50 | PC: lo avisa el editor de skins |
| `profile_complete` | 100 | Servidor: biografía, pronombres o colores, y banner |
| `first_friend` · `five_friends` | 50 · 150 | Servidor: amistades aceptadas |
| `mc_verified` | 100 | Servidor: una cuenta de Minecraft verificada |
| `badge_on` | 50 | Servidor: la insignia activada |
| `first_share` | 50 | Servidor: una captura o un clip compartido |
| `first_referral` · `five_referrals` | 200 · 1000 | Servidor: invitaciones pagadas |
| `theme_published` | 100 | Servidor: un tema publicado |
| `premium` | 300 | Servidor: plan de Venus vigente |

- **Los de la PC** los avisa cualquier parte del launcher con `window.dispatchEvent(new CustomEvent('venus:achievement', { detail: { id } }))` (contrato 3). `features/rewards.js` además detecta solo `first_launch`, `playtime_10h`, `playtime_100h` e `instances_5`. El servidor los acepta una sola vez y como mucho 10 por día (`too_many_today`); por eso valen pocos puntos.
- **Los del servidor** se comprueban de verdad (`not_met` si todavía no se cumplen). La interfaz los prueba cuando pueden haberse cumplido: después de verificar la cuenta, con un amigo nuevo (`social` `'friends'`), al activar la insignia (`ingame:badgeStatus`), al volverse premium, con invitaciones pagadas, y una vez por sesión al abrir la página. Un `not_met` no se vuelve a probar antes de un minuto.
- Cada logro se pide **una sola vez por cuenta**: los reclamados se recuerdan en `settings.rewards.claimed[<userId>]` (también los que `points_me` ya trae como ganados). Los de la PC que se cumplen sin sesión, sin servicio o con el tope del día esperan en `settings.rewards.pending` y se reclaman después. Si el servicio no está (`unavailable`) o la cuenta está suspendida, no se insiste por 10 minutos.
- Al desbloquear uno: aviso del launcher y `overlay:push` `{ kind: 'alert', icon: 'achievement', title, body, ttl: 6 }` para verlo dentro del juego.

## 4. Tienda

Catálogo en `shop_items` (lo carga 0021; se lee con un select). Tipos y casillero de `profiles.equipped`: `frame` → `frame`, `name_effect` → `nameEffect`, `badge_style` → `badgeStyle`, `title` → `title`.

| Ítem | Precio |
|---|---|
| Marcos: pixel, neón, dorado | 500, 800, 1500 |
| Efectos del nombre: brillo, arcoíris, fuego | 1200, 2000, 2500 |
| Estilos de la insignia: nebulosa, hielo | 1000 cada uno |
| Títulos: Explorador, Constructor, Redstoner, Leyenda | 300, 300, 600, 3000 |
| Incluidos con Premium (no se compran): Marco Venus, Insignia dorada, título Supporter | — |

- **Comprar** pide confirmación con el precio y lo que queda (`shop_buy`; errores `bad_item`, `premium_item`, `owned`, `not_enough_points`). Lo comprado es para siempre, aunque se pierda premium.
- **Equipar / Sacar** usa `profile_customize({ equipped })`. El servidor reemplaza el objeto entero y rechaza lo que no se tiene (`not_owned:<ítem>`), así que la página manda los cuatro casilleros y descarta lo que ya no corresponde (por ejemplo, lo premium sin premium): `logic.js: equipPatch`.
- Las vistas previas usan `social/profile-style.js` (`styledName`, `applyFrame`) si existe; si no, las de `rewards.css`. La insignia del juego se muestra en una placa como la del nombre en Minecraft. En el juego, la insignia dorada se ve cuando el jugador es premium y no equipó otro estilo (`badge_styles()`).

## 5. Venus Premium

Premium = `venus_is_premium(usuario)` (0020): tener un plan de Venus vigente, el mismo que habilita la IA. Se compra con los planes de siempre (`features/plans.js`, `openPlans()`).

| Beneficio | Dónde se aplica |
|---|---|
| Puntos x2 en el premio diario y en los logros (no en las invitaciones) | Servidor (`points_mult`) |
| Insignia dorada en el juego | Servidor (`badge_styles`) y el mod |
| Banners animados (GIF) en el perfil | Servidor (`profile_customize`, bucket `profile-media`) |
| Efectos de nombre premium (brillo, arcoíris, fuego) sin comprarlos | Servidor (`profile_customize`) |
| Marco Venus y título Supporter | Tienda (`premium_only`) |
| Repetición instantánea de 5 minutos en vez de 60 s | Capturas (consulta `isPremium()`) |
| Venus IA con los modelos del plan | Asistente |

`features/premium.js` exporta `isPremium({ force }) → Promise<boolean>` (caché de 5 minutos por cuenta; sin sesión o con el servicio caído, `false` o el último valor conocido de esa cuenta), `onPremiumChange(fn) → off` (avisa cuando cambia el valor conocido; se revisa al cambiar la sesión y con `billing:changed`) y `perksPanel() → Element` (beneficios con el botón a `openPlans()`; tiene `.destroy()`). El servidor vuelve a comprobar premium en cada acción: lo de la interfaz solo decide qué se muestra.

## 6. Página y chip

- `#/rewards[/<achievements, shop, invite, history o premium>]`: saldo grande, premio diario con racha (y cuándo vuelve), pestañas Logros (ganados y por ganar, con lo que da cada uno y el progreso de los medibles), Tienda ("Así te ven" + catálogo), Invitaciones (tu código, canjear el de quien te invitó solo si `canClaimReferral`, estado de la invitación y la verificación), Historial (últimos 30 movimientos) y Premium (`perksPanel`).
- Sin sesión: explicación y botón a Ajustes → Cuenta y nube. Servicio caído o sin la migración: "no está disponible en este momento" con Reintentar y el detalle en la consola (`[rewards]`).
- `pointsChip()` (de `features/rewards.js`): saldo en la barra lateral, con un punto cuando el premio diario está para reclamar; lleva a `#/rewards`. Oculto sin sesión. También marca con un punto la entrada `rewards` del menú (`setNavBadge`).

## 7. Capturas de desarrollo

Con `VENUS_DEVSHOT` y sin empaquetar, `VENUS_REWARDS_FAKE=<escenario>` usa datos de ejemplo en memoria (`pages/rewards/fake.js`) y una verificación que responde sola (`rewards/fake.js`): `demo` (puntos, racha, invitación pendiente de verificar), `premium`, `new` (cuenta nueva que puede canjear un código), `signedOut` y `unavailable`. `VENUS_REWARDS_FAKE_VERIFY_ERROR=<código>` hace fallar la verificación con ese código. No habla con ningún servidor.

## Venus Pass (3.1)

Los premios en puntos del pase entran a `points_ledger` con `reason = 'pass'` (`ref` = temporada:nivel:pista) y una devolución los descuenta con `'pass_refund'`. Los regalos entre amigos usan `'gift_in'` y `'gift_out'`. La XP del pase se calcula a partir de este libro: ver [venus-pass.md](venus-pass.md).

## Desafíos y capas en la rama 4.5.0

Implementados en la rama, **sin publicar ni aplicar 0031/0034 en producción**. [Estado de integración](estado-4.5.0.md).

### Desafíos entre amigos

0031 agrega el motivo `challenge` al libro de puntos. Un desafío válido paga **25 Venus Points**, sin multiplicador Premium y sin XP del Venus Pass. El límite es de tres premios por semana, uno contra el mismo amigo (hasta 75 puntos por semana). Ambos participantes deben informar al menos diez minutos durante el plazo; los estados de empate, abandono y actividad insuficiente se detallan en [Competir](implementacion/competir.md).

Las estadísticas provienen del launcher y mundos locales; no son una prueba independiente de lo jugado. El límite de premios se controla en el servidor. Toda migración posterior que reemplace `points_ledger_reason_check` debe conservar `challenge` y los motivos anteriores.

### Capas de Venus

Precios confirmados por el dueño para 4.5.0:

| Capa | Venus Points / requisito |
|---|---|
| Amanecer | 1000 |
| Nebulosa | 1500 |
| Aurora | 1500 |
| Magma | 2500 |
| Órbita | Incluida solo con Premium |

0034 agrega los ítems y `user_capes`; `cape_equip` valida compra o Premium y `badge_capes` entrega solo identificadores de texturas incluidas en el mod, hasta 100 UUID por consulta. Requiere Minecraft verificado y el mod Venus; no sustituye capas oficiales. No modifica los motivos contables ni `profiles.equipped`. [RPC, caché y límites](implementacion/capas.md).

El build del mod terminó con cuatro JAR, según la integración principal. Eso no demuestra renderizado de capas/elytra en Minecraft; esa prueba sigue pendiente.
