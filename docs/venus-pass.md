# Venus Pass

Pase de temporada de Venus Launcher (3.1). Se compra una vez por temporada con Mercado Pago o PayPal, igual que los planes de Venus IA, y es aparte de la tienda de cosméticos (que se paga con Venus Points). Página: **Venus Pass** en el menú (`#/pass`). Código: `src/renderer/js/pages/pass.js`, `pages/pass/logic.js` (lógica pura, con pruebas), `features/pass.js` (estado, minutos jugados, aviso de nivel), `pages/admin/pass.js` (administración). Base: `supabase/migrations/0026_venus_pass.sql`.

## Cómo funciona para el jugador

- **Temporada**: 8 semanas, 50 niveles, 150 XP por nivel. Una sola activa a la vez. Fuera de temporada la página dice que no hay.
- **XP**: los Venus Points que se ganan durante la temporada (premio diario, misiones, logros e invitaciones) valen 1 XP cada uno; jugar da 1 XP por minuto, hasta 120 por día. Venus Premium multiplica por 1,2. Nada se calcula en la PC: la XP sale de `points_ledger` y de los minutos que el launcher reporta (`pass_playtime`, de a 30 como máximo por llamada, con tope en el servidor).
- **Pistas**: la gratis da puntos en los niveles impares (más en los múltiplos de 10) y dos cosméticos (nivel 20 y 40); la premium da puntos en todos los niveles y cuatro cosméticos exclusivos (niveles 1, 15, 30 y 50). Los premios se reclaman a mano ("Reclamar" o "Reclamar todo"); el punto en el menú avisa cuando hay algo.
- **Ediciones**: Go (US$ 1,99) abre la pista premium; Pro (US$ 4,99) suma 10 niveles al instante y el título Pro; Max (US$ 6,99) suma 25 niveles, +25 % de XP y el marco Max. Pasar a una edición mejor cuesta la diferencia; no se puede volver a una menor.
- **Devoluciones**: si se devuelve la compra, se quita el pase, los cosméticos de la edición y lo reclamado en la pista premium (los puntos se descuentan). Si se devuelve solo el pase a una edición mejor, se vuelve a la anterior y se quita lo que dio la mejor.
- Los cosméticos del pase (`shop_items.source = 'pass'`) no se venden en la tienda ni se pueden comprar con puntos. Se equipan desde Mi perfil como cualquier otro.

## Aspecto del nivel

**Personalizar**, debajo del emblema, permite elegir Venus, Marte o Neptuno, los marcos Órbita, Halo o Nova y los colores del marco y del número. Hay vista previa, restablecimiento y cancelación. El número siempre representa el nivel real del pase. El estilo se guarda en esta PC y también se usa en las miniaturas de la pista. Los números oscuros se rechazan para conservar el contraste.

Los premios de puntos usan el mismo ticket ilustrado que el saldo de Venus Points. Las cifras siguen siendo texto accesible. Assets y prompts: [Arte de Venus](arte-venus.md).

## Para el administrador

Administración → **Venus Pass**:

- Cada temporada: nombre, fechas, niveles, XP por nivel, precio, niveles al instante, multiplicador y cosméticos de cada edición; vendidos, devueltos y lo cobrado en dólares. "Ver y editar premios" abre la tabla nivel por nivel (puntos o id de un cosmético de `shop_items`).
- **Nueva temporada**: se crea desactivada con las ediciones de la última y, si se elige, una copia de sus premios. Activarla desactiva las demás. Los cosméticos exclusivos de una temporada nueva se cargan en `shop_items` con `source = 'pass'` (y su CSS en `profile-style`), como los de la temporada 1.
- **Dar un pase**: una edición sin pago para un usuario (pruebas o regalos). Queda en el registro (`pass.granted`).
- En el registro de administración: `pass.purchased`, `pass.refunded`, `pass.seasonSaved`, `pass.granted`.

## Pagos

- Las ediciones viajan por el mismo camino que los planes de IA: `billing:checkout({ plan: 'pass_go' | 'pass_pro' | 'pass_max', provider })`, la Edge Function `payments` y `payment_orders` con `product = 'pass'`, `season_id` y `pass_tier`. `payments_catalog()` trae `pass` con la temporada activa y los precios completos; el precio de pasar a una edición mejor lo calcula el servidor al crear la orden (`private.pass_quote`).
- `payments_mark_paid` entrega el pase (`private.pass_fulfill`) y `payments_mark_status('refunded')` lo quita (`private.pass_revoke`). Un pago de prueba (sandbox) no entrega nada salvo a los administradores (0025).
- Antes de publicar la versión que trae el pase: aplicar 0025 y 0026 (en ese orden) y volver a desplegar la Edge Function `payments` (el repositorio y lo desplegado coinciden, salvo este cambio).

## Pruebas

- `node --test "src/renderer/js/pages/pass/test/*.test.js"`: niveles, estados de cada premio, ediciones, minutos jugados.
- La migración entera se probó contra la base en una transacción revertida (compra, pase a Max, reclamo, devolución, administración).
- Capturas sin servidor: `VENUS_DEVSHOT=<carpeta> VENUS_REWARDS_FAKE=demo|premium|new VENUS_DEVSHOT_ROUTES="pass"` (la "compra" se acredita sola).
- Sin probar con dinero real: una compra de verdad por Mercado Pago y por PayPal, y su devolución.
