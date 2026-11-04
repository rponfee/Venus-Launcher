# Competir: rankings, desafíos y eventos

Página **Competir** del menú (`#/compete[/rankings|challenges|events]`; `#/compete/events/<id>` abre ese evento). Base: `supabase/migrations/0031_competencia.sql` (**todavía sin aplicar**; hasta que se aplique, la página dice que el servicio no está disponible y los envíos se pausan una hora por vez).

## Cómo se usa

### Rankings

Por semana (de lunes a domingo, UTC) y solo entre amigos y vos: horas jugadas, diamantes, mobs matados, bloques minados y muertes. Se pueden mirar hasta 12 semanas atrás.

- **Compartir está apagado hasta que el usuario lo prende**, en Competir → Rankings o en Ajustes → Privacidad. Las dos tarjetas explican qué se manda, quién lo ve y qué no se manda.
- Al prenderlo se anota lo que ya hay como punto de partida: lo jugado antes no se cuenta nunca. Al apagarlo la PC deja de mandar y los amigos dejan de verte. **Borrar lo que envié** borra todas las semanas y apaga compartir.
- Compartir apagado desde otra PC también apaga esta (`ranking_report` responde `share_off`).
- **Los números los informa la PC**: sirve para jugar entre amigos, no como competencia oficial. La página lo dice.

De dónde sale cada número:

| Medida | Fuente |
|---|---|
| Horas | Registro de partidas del launcher (`core/stats`) más las partidas abiertas. Dos instancias a la vez no cuentan doble |
| Diamantes | `mined` de `minecraft:diamond_ore` y `minecraft:deepslate_diamond_ore` |
| Mobs | `custom` `minecraft:mob_kills` |
| Bloques | Suma de `mined` |
| Muertes | `custom` `minecraft:deaths` |

Las estadísticas se leen de `saves/*/stats/<uuid>.json`, solo de las cuentas de Minecraft de este launcher, y se manda la diferencia con el último envío aceptado. Si el servidor no responde, no se pierde: se calcula de nuevo. Se envía a los 20 s de abrir, cada 5 minutos de juego, 15 s después de cerrar el juego y antes de crear o aceptar un desafío.

### Desafíos

1. Elegís amigo, métrica, plazo (24 h, 3 días o 7 días) y objetivo o "el que más haga".
2. El amigo acepta o rechaza (48 horas para responder). El plazo empieza al aceptar. Para desafiar o aceptar hay que compartir.
3. Decide el servidor con lo informado durante el plazo y paga 25 Venus Points al ganador (motivo `challenge`, `ref` = el desafío).

| Caso | Resultado |
|---|---|
| "El que más haga" | Cierra al terminar el plazo. Gana el mayor; iguales, `tie` |
| Objetivo | Gana el primero en llegar, aunque el otro termine con más. Cierra antes del plazo si alguien llegó y los dos ya jugaron 10 minutos |
| Alguno con menos de 10 minutos informados en el plazo | `no_activity`: nadie gana |
| Objetivo que nadie alcanzó | `no_target` |

**Para que no sea una fábrica de puntos** (el que gana sin cobrar ve el motivo, `prizeNote`):

- Premio fijo de 25, sin multiplicador de Premium. `pass_xp` no cuenta este motivo.
- Hasta 3 premios por semana por cuenta (`week_cap`) y 1 por semana con el mismo amigo, gane quien gane (`friend_cap`). La semana es la del cierre.
- Baneados afuera: no reportan ni desafían ni aceptan, y si alguno de los dos está baneado al cerrar no hay premio (`banned`). Si ya no son amigos, tampoco (`not_friends`).
- Un solo desafío abierto por pareja, hasta 10 abiertos por cuenta y 10 creados por día.
- Cierre sin doble pago: fila bloqueada, `points_ledger` único por `(motivo, ref)` y un índice único por pareja y semana. Lo pueden pedir los dos a la vez y las veces que sea.

Avisos con toast al recibir, al aceptar, al rechazar, al vencer y al terminar. Consulta `challenges_me` a los 20 s de abrir y cada 15 minutos, al recibir la señal de un amigo y al terminar el plazo más próximo. Lo ya avisado se recuerda en `settings.compete.seen`.

### Eventos y torneos

- Los crea el equipo en Administración → Eventos: título, descripción, tipo, inicio, fin, cupo, servidor opcional y enlace opcional `https`. En un torneo el cupo es obligatorio; en un evento, vacío es sin límite.
- Los usuarios ven el mes y lo que viene, se anotan y se dan de baja. Un torneo muestra la lista de anotados y se cierra al llegar al cupo o al empezar. Un evento admite anotarse hasta que termina.
- Con un servidor, el detalle ofrece **Entrar** (`joinServer`). El enlace se abre recién al hacer clic.
- **Aviso 15 minutos antes de lo que anotaste**: toast, overlay si estás jugando y notificación de Windows si la ventana no tiene el foco. **No hay push: llega solo con el launcher abierto**, y la página lo dice. Si el launcher se abre faltando menos de 15 minutos, avisa igual.
- Las fechas se ven en la zona horaria de la PC y se guardan en UTC. El texto de un evento es siempre texto: `h()` lo pone con `textContent` y el HTML se ve tal cual.

## Archivos

| Parte | Dónde |
|---|---|
| Esquema y reglas | `supabase/migrations/0031_competencia.sql` |
| Envíos, avisos, recordatorios y tarjeta de Ajustes | `src/renderer/js/features/compete.js` |
| Página | `src/renderer/js/pages/compete.js` y `pages/compete/rankings.js`, `challenges.js`, `events.js` |
| Lógica pura y textos armados | `pages/compete/logic.js`, `pages/compete/format.js` |
| Datos de ejemplo | `pages/compete/fake.js` |
| Administración | `pages/admin/events.js` |
| Diferencias y semanas (proceso principal) | `src/main/modules/compete.js`, `compete/logic.js`, `compete/scan.js` |
| Estilos | `styles/pages/compete.css` (prefijo `cp-`) |
| Textos | `i18n/{es,en}/compete.js`; `hist_challenge` en `i18n/{es,en}/rewards.js` |
| Pruebas | `src/main/modules/compete/test/`, `pages/compete/test/` |

## Canales, señal y datos locales

- `compete:collect({ userId })` → `{ off: true, reports: [] }`, `{ first: true, reports: [] }` o `{ token?, reports: [{ week, minutes, diamonds, mobs, blocks, deaths }] }`. Con compartir apagado no lee nada.
- `compete:commit(token, week)` → `true`/`false`: el servidor aceptó esa semana y pasa a ser el nuevo punto de partida.
- `compete:reset()`: olvida el punto de partida (al prender o apagar compartir).
- Señal `compete-update` (`{}`), por `social.sendSignal`: un amigo cambió un desafío, volver a preguntar. La escucha `features/compete.js`.
- `data/compete.json`: `{ version, userId, cursor, files: { '<instancia>|<mundo>|<uuid>': { mtimeMs, size, diamonds, mobs, blocks, deaths, play } } }`. Con otra cuenta de Venus empieza de cero.

## Ajustes

`settings.compete`: `{ share (false), seen: { <userId>: ['id:estado'] }, reminded: ['id:inicio'] }`.

## Tablas y RPC

Tablas con RLS y sin acceso directo: `ranking_prefs`, `ranking_weekly`, `ranking_reports` (se guarda 30 días), `challenges`, `calendar_events`, `calendar_signups`. Motivo nuevo `challenge` en `points_ledger_reason_check`.

| RPC | Para qué |
|---|---|
| `ranking_set_share(p_on)`, `ranking_forget()` | Compartir y borrar lo enviado |
| `ranking_report(p_minutes, p_diamonds, p_mobs, p_blocks, p_deaths, p_week?)` | Lo jugado. `p_week`: semana actual o anterior. Devuelve `{ week, accepted, clamped }` |
| `ranking_friends(p_metric, p_week?)` | Ranking: solo amigos que comparten, sin baneados. `hours` va en minutos |
| `challenge_create(p_friend, p_metric, p_hours, p_target?)`, `challenge_respond(p_id, p_accept)`, `challenge_cancel(p_id)` | Desafiar, responder y retirar |
| `challenge_settle(p_id?)`, `challenges_me()` | Cerrar lo que corresponda; `challenges_me` además devuelve la lista |
| `events_list(p_from?, p_to?)`, `events_mine()`, `event_signups(p_id)`, `event_join(p_id)`, `event_leave(p_id)` | Agenda, lo mío, anotados de un torneo, anotarse y darse de baja |
| `admin_events()`, `admin_event_save(p)`, `admin_event_delete(p_id)` | Administración (`admin_guard`; quedan en el registro como `event.saved` y `event.deleted`) |

**Topes por semana:** 168 horas, 5.000 diamantes, 100.000 mobs, 1.000.000 de bloques y 5.000 muertes. Lo que se pasa se descarta. Además, un envío no puede sumar más minutos que el tiempo transcurrido desde el último envío de esa semana (con 10 de margen), y hay un envío por minuto por semana (`too_soon`).

## Límites

- **Se puede falsear.** Un cliente modificado puede informar lo que quiera dentro de los topes. Por eso el premio es chico y limitado: como mucho 75 puntos por semana.
- Diamantes, mobs, bloques y muertes salen de los mundos de la PC. En un servidor ajeno el juego no los guarda en la PC: **ahí solo suman horas**.
- Lo jugado con el launcher cerrado no suma horas. Si además suma más de 15 minutos de tiempo de juego por encima de lo registrado, se toma como un mundo importado o duplicado y no se envía nada de ese archivo. Lo mismo pasa con lo que tenga más de una semana sin enviar.
- Lo jugado justo antes de que empiece un desafío y enviado después cuenta para el desafío. Se reduce mandando antes de crear y de aceptar, pero al que desafió le queda el tramo desde su último envío (hasta 5 minutos mientras juega).
- Lo jugado antes de que termine el plazo y enviado después no cuenta.
- Muertes es una métrica como las otras: "el que más haga" gana el que más se murió.
- Si un amigo borra lo enviado en pleno desafío, queda sin actividad y el desafío termina en `no_activity`.
- Borrar un evento no avisa a los anotados.
- Con la misma cuenta en dos PC, el interruptor es de cada PC y apagarlo vale para las dos. Si otra PC comparte y esta no, la página lo aclara.

## Pendiente para quien integra

- `pages/rewards/logic.js`: sumar `challenge` a `REASON_ICONS`. Hasta entonces, `historyEntry` muestra el premio como "Ajuste del equipo de Venus" aunque `hist_challenge` ya exista. A `mission`, `pass` y `pass_refund` les pasa lo mismo hoy.
- Una migración posterior que vuelva a definir `points_ledger_reason_check` tiene que conservar `challenge`.
- Pasar este documento a `docs/arquitectura.md` (canales, `settings.compete`, `data/compete.json`, señal `compete-update`) y a `docs/venus-points.md` (motivo `challenge`).

## Pruebas

- `node --test "src/main/modules/compete/test/*.test.js"`: diferencias, cambios de semana, mundos importados, lectura de los dos formatos de estadísticas y el circuito completo contra una carpeta temporal.
- `node --test "src/renderer/js/pages/compete/test/*.test.js"`: vista de mes en la zona horaria de la PC, recordatorios, avisos de desafíos y formularios.
- La migración se probó contra la base en transacciones revertidas: una corrida completa de 180 comprobaciones (rankings, permisos, desafíos, topes, cierre sin doble pago, baneados y eventos), donde lo único que falló de verdad fue la validación del enlace, y, ya corregida, otra de 39 de eventos, todas bien. La corrida completa no se repitió después de esa corrección. Antes de esa corrección también se ejecutó dos veces seguidas para comprobar que es idempotente.
- Capturas sin servidor: `VENUS_DEVSHOT=<carpeta> VENUS_DATA_DIR=<carpeta-temporal> VENUS_SKIP_ONBOARDING=1 VENUS_REWARDS_FAKE=demo|new|signedOut|unavailable VENUS_ADMIN_FAKE=1 VENUS_DEVSHOT_ROUTES="compete/rankings;;compete/challenges;;compete/events;;admin/events"`.
- **Sin probar:** dos launchers de verdad contra la base con la migración aplicada (señal, avisos entre PC y RPC por la API), una partida real de Minecraft, concurrencia real de dos cierres o del último lugar de un cupo (la transacción de prueba es una sola) y la notificación de Windows.
