# Venus Pass

Progresión **permanente** de Venus Launcher (4.6). Reemplaza al pase por temporadas de la 3.1: ya no se vende (no hay ediciones, precio ni pista premium) y no termina. La XP viene solo de los minutos jugados. Servidor: `supabase/migrations/0041_venus_pass_tiempo.sql`, aplicada en producción. Es aparte de la tienda de cosméticos (que se paga con Venus Points).

## Cómo funciona para el jugador

- **XP**: 1 por minuto jugado, hasta 120 minutos por día. El launcher reporta cada 5 minutos con el juego abierto (`pass_playtime`, de a 30 como máximo por llamada). Venus Premium da **+20 %** sobre los minutos que se juegan con Premium: el bono se anota cuando se reporta el minuto (`pass_playtime.premium_minutes`), así que perder Premium no baja el nivel ya ganado. Los Venus Points y las misiones ya no cuentan.
- **Niveles**: **380**, 60 XP por nivel (una hora de juego por nivel; 190 días al tope de 2 horas por día, unos 158 con Premium). Hay que tener la sesión de Venus iniciada: los minutos y los premios se guardan en la cuenta.
- **Premios**: uno por nivel, que se reclama a mano (**Reclamar** o **Reclamar todo**). El punto del menú avisa cuando hay algo y al subir de nivel aparece el aviso de siempre. Cambiar un premio de la pista no afecta a quien ya lo reclamó.
  - **Venus Points** en cada nivel sin cosmético: 10 al principio y +2 cada 50 niveles (hasta 24); los múltiplos de 10 valen el triple. En total 359 premios de puntos, **6.800 Venus Points**.
  - **21 cosméticos** en niveles clave (un nivel con cosmético no da puntos): ocho marcos (`pass_frame_1` a `pass_frame_8`, niveles 25, 60, 100, 150, 200, 260, 320 y 380), títulos (10, 35, 85, 125, 175, 230 y 340) y efectos de nombre (45, 110, 165, 215, 280 y 350). Los marcos son ítems nuevos con `source = 'pass'` y precio 0, dibujados por `social/frames.js`; los demás se pueden seguir comprando con puntos en la tienda. Los cosméticos del pase se equipan desde Mi perfil.
- **Página** (`#/pass`): nivel y progreso, "Premios especiales", la lista de los 380 niveles de a 50 con **Ir a mi nivel** y **Reclamar todo**, y "Cómo subir de nivel". La interfaz muestra "Permanente".

## Aspecto del nivel

**Personalizar**, debajo del emblema, permite elegir Venus, Marte o Neptuno, los marcos Órbita, Halo o Nova y los colores del marco y del número. Hay vista previa, restablecimiento y cancelación. El número siempre representa el nivel real del pase. El estilo se guarda en esta PC y también se usa en las miniaturas de la pista. Los números oscuros se rechazan para conservar el contraste.

Los premios de puntos usan el mismo ticket ilustrado que el saldo de Venus Points. Las cifras siguen siendo texto accesible. Assets y prompts: [Arte de Venus](arte-venus.md).

## Para el administrador

Administración → **Venus Pass** (`pages/admin/pass.js`): por cada temporada, nombre, fechas, "Permanente", si está activa, niveles y XP por nivel (cambiarlos mueve de nivel a todos), con jugadores, horas jugadas y premios reclamados. "Ver y editar premios" abre el editor de a 50 niveles: un tipo (nada, puntos o cosmético) y el valor (puntos o id de `shop_items`). Se quitaron ventas, ingresos, ediciones, "Nueva temporada" y "Dar un pase". Una temporada nueva se sigue pudiendo crear con `admin_pass_season_save` (desde SQL), pero la pestaña ya no tiene el formulario. Registro: `pass.seasonSaved` y `pass.rewardSet`.

## Servidor (0041)

- Sube el tope de `pass_seasons.levels` y `pass_rewards.level` a 1000; agrega `pass_seasons.permanent` y `pass_playtime.premium_minutes`.
- Temporada `venus-pass` (380 niveles, 60 XP por nivel, permanente, `ends_at` en 2099) **activa**; `temporada-1` queda **desactivada** con su compra de prueba y sus 80 reclamos (historial, sin dinero real).
- El bloque `premios-generados` de la migración (los 8 marcos y los 380 premios) lo genera `node scripts/gen-pass-rewards-sql.js` desde `pages/pass/plan.js`; `--check` verifica que coincida.
- RPC (`security definer`, para `authenticated` y `service_role`): `pass_me()`, `pass_playtime(p_minutes)` (1 a 30 por llamada, tope de 120 por día), `pass_claim(p_level, p_track default 'free')` y `pass_claim_all()` (errores `no_season`, `bad_reward`, `locked`, `already`; `user_banned`), y de administración `admin_pass_seasons`, `admin_pass_season_save`, `admin_pass_rewards`, `admin_pass_reward_set`. `admin_pass_grant` se eliminó. La columna `track` se conserva: los premios nuevos van en `'free'`.
- Los minutos los reporta el launcher; el servidor solo pone el tope: una llamada directa a la RPC suma como mucho lo mismo que jugar 2 horas por día.

## Pagos: lo que quedó sin uso

Sin ediciones a la venta, `private.pass_quote` devuelve `null` y una orden `pass_*` se rechaza con `unknown_plan`: el pase no se puede comprar aunque la Edge Function `payments` y `modules/billing*` sigan nombrando los planes `pass_go`, `pass_pro` y `pass_max`. Siguen en la base, sin uso: las tablas `pass_tiers` y `pass_purchases`, las funciones `private.pass_quote`, `pass_fulfill`, `pass_revoke`, `pass_tier_rank` y `pass_purchase`, el trigger `payment_orders_check` y las ramas `pass` de `payments_create_order`, `payments_mark_paid`, `payments_mark_status` y `payments_catalog()` (que devuelve la temporada permanente con `tiers: []`). `pass_xp` conserva la clave `total` porque `pass_revoke` la lee. Esa limpieza **no** está en la 0048: pertenece al trabajo de planes y pagos.

## Pruebas

- `node --test "src/renderer/js/pages/pass/test/*.test.js"`: normalización, páginas, tiempos, plan de premios y su coincidencia con la migración, y el pase falso.
- `node scripts/gen-pass-rewards-sql.js --check`.
- Capturas sin servidor: `VENUS_DEVSHOT=<carpeta> VENUS_REWARDS_FAKE=demo|premium|new VENUS_DEVSHOT_ROUTES="pass"` (nivel 74, Premium en el 180 y nivel 0).
- La migración se probó en transacciones revertidas contra producción y contra un PostgreSQL local. Sin probar con jugadores reales de varios días.
