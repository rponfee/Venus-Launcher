# Venus Pass 4.6: solo por tiempo jugado (agente E)

El Venus Pass deja de venderse. Es una progresión **permanente** de **380 niveles**, **60 XP por nivel**, con **una sola pista** de premios. La XP viene solo de los minutos jugados. Reemplaza al pase por temporadas de la 3.1 (`docs/venus-pass.md`, que sigue describiendo la 3.1 hasta que se integre esto).

## Cómo funciona para el jugador

- **XP**: 1 por minuto jugado, hasta 120 minutos por día (el launcher reporta cada 5 minutos con el juego abierto: `pass_playtime`, de a 30 como máximo por llamada). Venus Premium da **+20 %** sobre los minutos que se juegan con Premium: el bono se anota cuando se reporta el minuto (`pass_playtime.premium_minutes`), así que perder Premium no baja el nivel ya ganado. Los Venus Points y las misiones ya no cuentan.
- **Niveles**: 60 XP por nivel = una hora de juego por nivel, 380 horas en total (190 días al tope de 2 h por día; unos 158 con Premium).
- **Premios**: uno por nivel, que se reclama a mano ("Reclamar" o "Reclamar todo"). El punto del menú avisa cuando hay algo y al subir de nivel aparece el aviso de siempre.
- **Sin compra**: no hay ediciones, ni precio, ni checkout, ni pista premium. No hay temporada que termine: la interfaz muestra "Permanente".
- Hay que tener la sesión de Venus iniciada: los minutos y los premios se guardan en la cuenta.

### Premios (plan en `src/renderer/js/pages/pass/plan.js`)

- **Venus Points en cada nivel** que no tiene cosmético: 10 al principio y +2 cada 50 niveles (hasta 24); los múltiplos de 10 valen el triple. En total 359 premios de puntos = **6.800 Venus Points**.
- **21 cosméticos** en niveles clave (un nivel con cosmético no da puntos):

| Nivel | Cosmético (id en `shop_items`) | Tipo |
|---|---|---|
| 10 | `pass_s1_free_title` | título |
| 25 | `pass_frame_1` | marco |
| 35 | `title_explorer` | título |
| 45 | `effect_shimmer` | efecto de nombre |
| 60 | `pass_frame_2` | marco |
| 85 | `pass_s1_title` | título |
| 100 | `pass_frame_3` | marco |
| 110 | `effect_ocean` | efecto de nombre |
| 125 | `title_collector` | título |
| 150 | `pass_frame_4` | marco |
| 165 | `pass_s1_effect` | efecto de nombre |
| 175 | `title_hardcore` | título |
| 200 | `pass_frame_5` | marco |
| 215 | `effect_gold` | efecto de nombre |
| 230 | `title_veteran` | título |
| 260 | `pass_frame_6` | marco |
| 280 | `effect_galaxy` | efecto de nombre |
| 320 | `pass_frame_7` | marco |
| 340 | `title_legend` | título |
| 350 | `effect_glitch` | efecto de nombre |
| 380 | `pass_frame_8` | marco |

- Los 8 **marcos** son ítems nuevos: `pass_frame_1` … `pass_frame_8` (`kind = 'frame'`, `source = 'pass'`, `price = 0`, `data = {"style":"pass1"}` … `{"style":"pass8"}`, `sort` 310 a 317). Los inserta la migración; el dibujo lo hace el agente D (`social/frames.js`). No se usan los marcos viejos (`pass_s1_frame`, `pass_s1_frame_legend`, `pass_s1_free_frame`, `pass_max_frame`).
- Los títulos y efectos `pass_s1_*` son cosméticos propios del pase ya cargados en 0026 (`source = 'pass'`). El resto son ítems de la tienda (0021/0023) que acá se ganan jugando; se pueden seguir comprando con puntos.
- Cambiar un premio de la pista no afecta a quien ya lo reclamó.

## Interfaz

| Archivo | Qué hace |
|---|---|
| `src/renderer/js/pages/pass.js` | La página `#/pass`: nivel y progreso, "Premios especiales" (tira de cosméticos), lista de los 380 niveles por páginas de 50 con "Ir a mi nivel" y "Reclamar todo", y "Cómo subir de nivel". |
| `src/renderer/js/pages/pass/logic.js` | Lógica pura: `normalizeMe`, estados de premio, páginas (`levelRanges`, `rangeStats`), próximo cosmético y tiempos, lotes de minutos. |
| `src/renderer/js/pages/pass/plan.js` | El plan de premios (constantes y `buildRewards()`): lo usan la migración, las capturas y las pruebas. |
| `src/renderer/js/pages/pass/fake.js` | Pase falso para capturas: `VENUS_REWARDS_FAKE=demo` (nivel 74), `premium` (Premium, nivel 180) y `new` (nivel 0). |
| `src/renderer/js/pages/pass/appearance.js` | Sin cambios: el editor local del emblema (planeta, marco, colores). |
| `src/renderer/js/features/pass.js` | Estado compartido, minutos jugados, aviso de nivel y punto del menú. Sin pagos: se fue `billing:changed`, y también los avisos por logros y misiones (ya no dan XP). |
| `src/renderer/js/pages/admin/pass.js` | Pestaña **Administración > Venus Pass**. |
| `src/renderer/styles/pages/pass.css` | Estilos (también las clases `ps-adm-*` de la pestaña de administración). |
| `src/renderer/i18n/{es,en}/pass.js` | Textos (la pestaña de administración usa `admin.pass*`, también solo es/en). |

La lista se pagina de a 50 niveles (8 páginas); la página inicial es la del nivel actual y un punto marca las que tienen premios para reclamar. Al repintar (por ejemplo después de reclamar) se conservan la página elegida, el desplazamiento de la página y el de la tira.

## Base de datos (`supabase/migrations/0041_venus_pass_tiempo.sql`)

- Sube el tope de `pass_seasons.levels` y `pass_rewards.level` a 1000; agrega `pass_seasons.permanent` y `pass_playtime.premium_minutes`.
- Temporada `venus-pass` (380 niveles, 60 XP por nivel, permanente, `ends_at` en 2099) **activa**; `temporada-1` queda **desactivada** con su compra de prueba y sus 80 reclamos (historial, sin dinero real).
- El bloque entre `-- >>> premios-generados` y `-- <<< premios-generados` (los 8 marcos y los 380 premios) lo genera `node scripts/gen-pass-rewards-sql.js` desde `plan.js`. `--check` verifica que coincida (`plan.test.js` también). Antes de insertar los premios comprueba que cada cosmético exista en `shop_items`; si falta uno se detiene y dice cuál.
- RPC (todas `security definer`, `search_path = ''`, para `authenticated` y `service_role`):
  - `pass_me()`: `{ season: { …, permanent }, xp: { xp, fromPlay, fromBonus, premiumMult, total }, level, levelXp, playToday, playCap, claimable, rewards: [{ level, kind, amount, itemId, claimed }] }` (unos 31 KB con los 380 premios).
  - `pass_playtime(p_minutes)`: de 1 a 30 minutos por llamada, tope de 120 por día; suma `premium_minutes` si la cuenta es Premium en ese momento.
  - `pass_claim(p_level, p_track default 'free')` y `pass_claim_all()`: errores (22023) `no_season`, `bad_reward`, `locked`, `already`; `user_banned` (42501). `pass_claim_all` calcula el nivel una vez y entrega todo en una pasada (también 380 premios). Nuevo `private.pass_grant` entrega un premio.
  - Administración: `admin_pass_seasons()` (con jugadores, minutos y reclamos), `admin_pass_season_save(p)`, `admin_pass_rewards(p_season)`, `admin_pass_reward_set(p_season, p)` y el registro `pass.seasonSaved` / `pass.rewardSet`.
  - Se elimina `admin_pass_grant` (ya no se regalan ediciones).
- La columna `track` se conserva: todos los premios nuevos van en `'free'`.

## Administración

Pestaña **Venus Pass**: por cada temporada, nombre, fechas, "Permanente", si está activa, niveles y XP por nivel (cambiarlos mueve de nivel a todos), con jugadores, horas jugadas y premios reclamados. "Ver y editar premios" abre el editor de a 50 niveles: un tipo (nada, puntos o cosmético) y el valor (puntos o id de `shop_items`, con la lista de ids sugerida). Se quitaron ventas, ingresos, ediciones, "Nueva temporada" y "Dar un pase". Una temporada nueva se sigue pudiendo crear con `admin_pass_season_save` (desde SQL o con una herramienta), pero la pestaña ya no tiene el formulario.

## Cómo se prueba

- `node --test "src/renderer/js/pages/pass/test/*.test.js"` (15 pruebas): normalización, páginas, tiempos, plan de premios, coincidencia con la migración y el pase falso.
- `node scripts/gen-pass-rewards-sql.js --check`.
- Migración: probada en una transacción revertida, en un PostgreSQL local con 0001 a 0037 (71 comprobaciones: nivel 0, subida por minutos con tope diario, Premium +20 %, perder Premium, reclamo doble, bloqueado antes del nivel, nivel 379 y 380, administración, permisos, que lo de pagos siga compilando e idempotencia) y contra producción con rollback (sin la segunda pasada).
- Capturas: `VENUS_DEVSHOT=<carpeta> VENUS_REWARDS_FAKE=demo|premium|new VENUS_DEVSHOT_ROUTES="pass"`.

## Lo que queda sin uso (pagos, lo limpia el agente M)

- Tablas `pass_tiers` y `pass_purchases`, y `payment_orders.product = 'pass'` con `season_id` y `pass_tier`.
- Funciones `private.pass_quote`, `private.pass_fulfill`, `private.pass_revoke`, `private.pass_tier_rank`, `private.pass_purchase`, el trigger `payment_orders_check` y las ramas `pass` de `payments_create_order`, `payments_mark_paid`, `payments_mark_status` y `payments_catalog()` (que ahora devuelve la temporada permanente con `tiers: []`). No se tocó ninguna.
- Sin ediciones a la venta, `private.pass_quote` devuelve `null` y una orden `pass_*` se rechaza con `unknown_plan`: el pase no se puede comprar aunque la Edge Function `payments` y `modules/billing*` sigan con los planes `pass_go`, `pass_pro` y `pass_max`.
- `pass_xp` conserva la clave `total` porque `pass_revoke` la lee.

## Límites y notas

- Los minutos los reporta el launcher (el servidor solo pone el tope de 120 por día y de 30 por llamada): una llamada directa a la RPC suma como mucho lo mismo que jugar 2 horas por día.
- No hay vista previa de los marcos en la lista: se agrega cuando el agente D tenga `social/frames.js`.
- Los cosméticos del pase se equipan por el id del ítem (`pass_frame_3`), pero `frameStyle()` / `titleStyle()` / `effectFromItem()` de `features/profile-editor/model.js` solo entienden ids con prefijo `frame_`, `title_` y `effect_`: los `pass_*` (los `pass_s1_*` de 0026 también) no se dibujan hasta que se resuelvan por `shop_items.data` (agentes C y D).
- Textos viejos que quedan en los otros 12 idiomas de `pass.js` (claves sin uso) y la entrada de novedades de la 3.1 (`whatsnew.v31pass_*`: ediciones Go, Pro y Max, 50 niveles) están desactualizados.
