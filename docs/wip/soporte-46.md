# Soporte 4.6: formularios, capturas, diagnóstico y cola del equipo

Pedido del dueño: *mejorar la UI y las funcionalidades y formularios de soporte*, para quien pide ayuda y para el equipo que responde. Este documento dice qué hay, cómo se usa, dónde está cada cosa, qué límites pone el servidor y qué decisiones se tomaron. Los pagos y los planes no cambian: se compran desde Planes y se acreditan solos; `support_create_ticket` sigue cerrada como la dejó la migración 0017 y Soporte nunca activa un plan.

## Cómo se usa

### Quien pide ayuda (`#/support`)

- A la izquierda, **Mis consultas**: filtros (todas, abiertas, cerradas, sin leer), estado, prioridad, la última respuesta del equipo y un punto de "Respuesta nueva". A la derecha, el formulario o la conversación.
- **Nueva consulta**:
  1. Tema con campos propios: *Error del launcher*, *Error al jugar*, *Cuenta y pagos*, *Plan de IA*, *Sugerencia* y *Otra consulta*. Cada tema pide lo que necesita el equipo (por ejemplo, versión de Minecraft, loader y cuándo ocurre; o medio de pago, fecha y número de operación).
  2. Asunto (3 a 120) y mensaje (10 a 4000), con contador y errores asociados a cada campo (el primero que falla recibe el foco; el resumen es navegable). Plantilla de mensaje por tema.
  3. **"Quizás esto te ayude"**: preguntas frecuentes locales que se filtran mientras se escribe (inicio de sesión, plan que no se activa, límites del asistente, crash, Java, FPS, actualizaciones, skins, voz). No consulta nada por internet.
  4. **Capturas** (hasta 3 por envío): se eligen, se pegan con Ctrl+V o se arrastran. Antes de salir de la PC se reescriben achicadas (lado mayor 1600 px) y sin metadatos (EXIF con ubicación, textos incrustados).
  5. **Diagnóstico opcional**: arranca apagado. Al activarlo se muestran las partes (launcher y sistema, Java, instancia; nombres de mods y registro del juego quedan destildados) y el texto **exacto** que se va a enviar, ya sin rutas ni datos personales, con el recuento de lo que se tapó. Se puede elegir la instancia y 50, 100 o 200 líneas del registro.
  6. **Borrador**: se guarda solo en este equipo (asunto, mensaje, tema y datos propios) y se ofrece recuperarlo o descartarlo. Las capturas y el diagnóstico no se guardan en el borrador. Las respuestas dentro de una conversación también guardan borrador por consulta.
  7. Casilla "Avisarme cuando el equipo conteste" (ver Avisos).
- **Conversación**: datos de la consulta, diagnóstico adjunto (copiable), mensajes con capturas (miniaturas que se abren en grande), respuesta con contador, `Ctrl+Enter`, capturas y "Agregar diagnóstico" si todavía no hay uno. **Dar por resuelta** cierra la consulta.
- **Cerrada**: valoración de la atención (1 a 5 estrellas y comentario opcional, se puede corregir) y **Reabrir** (con un mensaje, hasta 14 días después del cierre y hasta 3 veces).

### Equipo (`#/support-staff` y la pestaña Soporte de Administración)

- **Cola** con contadores clicables (pendientes, sin responder, sin asignar, mías, promedio de valoraciones de 30 días), filtros por estado, tema, prioridad, asignación y orden, buscador por asunto o usuario, y "Mostrar más". Orden por omisión: pendientes primero, las que esperan al equipo, prioridad y antigüedad de la espera (tonos a las 24 y 72 horas).
- **Conversación del equipo**: tomar o soltar, asignar a otra persona, cambiar prioridad, cerrar con nota y reabrir.
- **Datos de la cuenta, solo lo necesario**: usuario, alta, correo confirmado (sí o no), plan de IA, sanción y cantidad de consultas. No se muestra el correo, ni IP, ni datos de pago.
- **Notas internas**: solo las ve el equipo (tabla sin ningún permiso directo; ni la persona ni el equipo las leen fuera de las funciones).
- **Respuestas guardadas**: seis plantillas de fábrica (en el idioma de la interfaz) y las que cada integrante guarda en la base, privadas o compartidas, con `{name}` reemplazado por el usuario.

### Avisos

Cuando el equipo contesta, la lista marca "Respuesta nueva" y, si el aviso está activo, el launcher pone el número en el menú de Soporte y muestra un aviso con **Ver**. Es una conexión que el launcher hace por su cuenta, así que tiene **su propio interruptor** (casilla del formulario o interruptor al pie de la lista): con el launcher abierto y la ventana visible consulta cada 3 minutos `support_unread_summary`. Se guarda en este equipo (`localStorage`, clave `venus.support.notify`). La primera consulta después de abrir el launcher solo pone el número: no avisa por respuestas que ya estaban.

## Archivos

| Parte | Archivos |
|---|---|
| Páginas | `src/renderer/js/pages/support.js`, `pages/support-staff.js`, `pages/admin/support.js` (sin cambios de contrato: sigue usando `ticketDesk({ admin: true })`) |
| Fachada | `src/renderer/js/features/support.js` (conserva `S`, `supportCall`, `CATEGORIES`, `isPendingTicket`, `ticketStatus`, `ticketDesk`), `features/support-staff.js` (acceso del equipo; ahora también arranca el aviso) |
| Interfaz | `src/renderer/js/features/support/`: `logic.js` (lógica pura), `common.js`, `form.js`, `thread.js`, `desk.js`, `staffbar.js`, `media.js`, `diagnostic.js`, `faq.js`, `notify.js` |
| Estilos | `src/renderer/styles/pages/support.css` (prefijo `sp-`, solo tokens del tema) |
| Textos | `src/renderer/i18n/{es,en}/support.js` (namespace `support`) |
| Proceso principal | `src/main/modules/support.js`, `src/main/modules/support/`: `client.js`, `rules.js`, `redact.js`, `diagnostics.js`, `images.js`, `fake.js` |
| Servidor | `supabase/migrations/0045_soporte_mejoras.sql`, `supabase/tests/soporte-local.sql`, `scripts/run-support-local.ps1` |

## Canales (IPC)

`support:call (action, payload)` con las acciones: `staffState`, `list`, `queue`, `create`, `detail`, `reply`, `resolve`, `closeOwn`, `reopen`, `rate`, `markSeen`, `unread`, `diagnostic`, `attach`, `attachmentInfo`, `assign`, `priority`, `note`, `staffPanel`, `staffList`, `macros`, `macroSave`, `macroDelete`. Además `support:diagnostic` (arma el diagnóstico), `support:upload` (sube una captura), `support:attachment` (baja una captura como `data:`), `support:fakeMode` y los viejos `support:list|create|detail|reply|resolve`. Evento `support:changed`.

El cliente valida lo mismo que el servidor antes de llamar (`rules.js`) y los errores salen con `.code` (los avisos de la base viajan en `hint`), que la interfaz traduce a `support.err_<code>`.

## Servidor: migración `0045_soporte_mejoras.sql`

Parte de las funciones desplegadas, leídas con `pg_get_functiondef` en producción (0016 + 0017): conserva firmas y mensajes en español (los launchers viejos siguen andando) y **suma** campos al JSON y un `hint` legible por máquina.

- **Columnas** de `support_tickets`: `priority`, `assigned_to`, `assigned_at`, `details`, `diagnostic`, `diagnostic_at`, `last_user_message_at`, `last_staff_reply_at`, `user_seen_at`, `rating`, `rating_comment`, `rated_at`, `reopen_count`; temas nuevos `game` y `suggestion`; `support_messages.code` (`closed`, `closed_self`, `reopened`) para mostrar los cierres y reaperturas en el idioma de cada persona (el texto en español de siempre se conserva).
- **Tablas**: `support_attachments` (legible por la dueña y el equipo con RLS), `support_notes` y `support_macros` (RLS activa y ninguna política).
- **Bucket** `support-attachments`: privado, 4 MiB, PNG, JPEG y WebP. Ruta `<quien sube>/<consulta>/<uuid>.<ext>`; escribe quien sube en una consulta abierta propia (o el equipo en cualquiera abierta) y sin baneo; leen la dueña de la consulta y el equipo; sin políticas de UPDATE ni DELETE. Trigger propio `venus_support_attach_quota` (60 archivos por persona y 15 por consulta) sin tocar `private.storage_quota_before` de 0014.
- **Funciones nuevas**: `support_submit_ticket`, `support_queue`, `support_staff_panel`, `support_staff_list`, `support_assign`, `support_set_priority`, `support_add_note`, `support_macros_list`, `support_macro_save`, `support_macro_delete`, `support_mark_seen`, `support_unread_summary`, `support_reopen_ticket`, `support_close_own_ticket`, `support_rate_ticket`, `support_set_diagnostic`, `support_register_attachments`, `support_attachment_info`. Redefinidas (misma firma): `support_open_ticket`, `support_list_tickets`, `support_ticket_detail`, `support_add_message`, `support_resolve_ticket`, `private.support_ticket_json`, `private.support_message_json`.
- **Cuando quien atiende es también la dueña de la consulta**, sus mensajes se guardan como de la persona (antes quedaban como del equipo).

### Límites y antiabuso (los pone el servidor)

| Qué | Tope |
|---|---|
| Consultas abiertas por persona | 3 |
| Consultas nuevas por día | 5 |
| Mensajes | 10 por minuto, 150 por día (el equipo no tiene el diario) y 500 por consulta |
| Asunto / mensaje / nota / diagnóstico | 3 a 120 / 1 a 4000 / 2000 / 12000 caracteres |
| Capturas | 3 por envío, 12 por consulta, 15 por día, 4 MiB cada una; el tamaño y el tipo salen de lo que Storage guardó, no de lo que dice el cliente |
| Archivos en el bucket | 60 por persona y 15 por consulta |
| Reabrir | dentro de 14 días del cierre y hasta 3 veces (el equipo no tiene esos topes) |
| Diagnóstico agregado después | uno cada 30 segundos |
| Respuestas guardadas / notas | 40 por integrante / 100 por consulta y 20 por minuto |
| Cola | 100 filas por página; filtros validados contra listas |

Baneos: con baneo de Auth no se usa ninguna función de Soporte (como hoy). Con baneo solo de moderación se puede leer y responder en una consulta que ya estaba abierta, pero no abrir consultas nuevas, reabrir, valorar ni adjuntar. El silencio del chat no afecta a Soporte.

### Cómo se probó

`supabase/tests/soporte-local.sql` arma `BEGIN; <0045>; <escenarios>; ROLLBACK;` (156 comprobaciones): permisos entre personas y con el equipo, tablas sin acceso directo, baneos y silencio, todos los topes, adjuntos (carpeta, extensión, consulta ajena, consulta cerrada, tamaño y tipo desde Storage), reapertura y valoración, asignación, notas, respuestas guardadas, filtros de la cola y permisos de ejecución. Se corre contra el PostgreSQL local descartable (`scripts/run-support-local.ps1 -PgBin ...`, que además comprueba que el esquema vuelve a quedar igual) y contra producción con `execute_sql`, siempre en una transacción que termina en ROLLBACK (en producción los conteos de la cola se comparan contra las consultas reales que ya hay, sin leerlas ni copiarlas). Resultado de las dos: 156 de 156. La migración también corre dos veces seguidas sin error (idempotente) y después del ensayo en producción no quedó ningún objeto nuevo.

## Pruebas y datos locales

- `node --test "src/main/modules/support/test/*.test.js"` (48: cliente, anonimizador, diagnóstico, imágenes y datos de ejemplo; ya está en el flujo de CI) y `node --test "src/renderer/js/features/support/test/*.test.js"` (25: validación, tarjetas, borradores, preguntas frecuentes, filtros, capturas y respuestas guardadas; **carpeta nueva que todavía no está en el flujo de CI**).
- Este equipo guarda solo en `localStorage`: `venus.support.draft.<usuario>` (borrador del formulario), `venus.support.reply.<usuario>.<consulta>` (borrador de una respuesta), `venus.support.notify` (aviso de respuestas: `1` o `0`) y `venus.support.queue` (estado y orden elegidos en la cola del equipo).

## Orden de despliegue

1. Aplicar `0045` (el launcher nuevo la necesita para temas con campos propios, capturas, valoración, cola y avisos; con un servidor sin ella, las consultas de los temas de siempre siguen yendo por `support_open_ticket`, y lo demás avisa que el servidor no tiene activada esa parte).
2. Publicar el launcher. Los launchers 3.x/4.x ya instalados siguen funcionando con el servidor nuevo.

## Modo de capturas

Solo con `VENUS_DEVSHOT` y sin empaquetar: `VENUS_SUPPORT_FAKE=customer|staff|empty`. Consultas, cola, diagnóstico (con un sistema inventado, para mostrar el tapado de rutas) y capturas de ejemplo, todo en memoria y sin servidor ni cuenta.

## Decisiones

- **Hecho**: categorías con campos propios, diagnóstico opcional con vista previa exacta y redacción, capturas (bucket privado), sugerencias locales y plantillas, borradores, contadores y validación asociada a cada campo, mis consultas con estado, prioridad y última respuesta, aviso de respuesta nueva, hilo, cerrar, reabrir, valoración, cola con filtros, asignación, notas internas, respuestas guardadas y contexto mínimo de la cuenta.
- **Número de tarjeta**: el formulario detecta un número de tarjeta (Luhn) en el asunto, el mensaje y los campos, y no deja enviarlo. El servidor no lo comprueba.
- **Diagnóstico**: el proceso principal lo arma y lo vuelve a pasar por el anonimizador antes de enviarlo (idempotente), aunque la interfaz lo haya mostrado limpio. Reutiliza el anonimizador del asistente (usuario del sistema, equipo, cuentas del launcher, correos, UUID, IP, claves) y suma rutas de cualquier disco, chat y nombres del registro, y también usuario y equipo de 3 letras (el del asistente llega a 4). Se comprobó con una instancia de prueba cuyo registro traía el usuario, el equipo y la carpeta reales de la PC: no quedó ninguno. Del nombre de la instancia solo se manda el id de la carpeta, que tapa `<instancia>`.
- **No se hizo**: adjuntar capturas desde el panel de administración ni borrar capturas ya enviadas (quedan como evidencia); notificaciones al equipo por consultas nuevas; borrar archivos huérfanos de Storage (están acotados a 60 por persona).
