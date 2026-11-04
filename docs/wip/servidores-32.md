# Servidores 3.2: control remoto, avisos por Discord y reseñas

Tres funciones de la hoja de ruta para los servidores. Documento de trabajo: cuando se integre, lo que corresponda pasa a [arquitectura.md](../arquitectura.md) y [funciones.md](../funciones.md).

| Función | Dónde se usa | Conexión |
|---|---|---|
| Control remoto desde el celular | Servidor > pestaña **Red** | Solo la red local. Apagado por defecto, por servidor |
| Avisos por Discord | Servidor > pestaña **Ajustes** | `discord.com`, solo si se pega un webhook en ese servidor |
| Reseñas y votos | Multijugador > **Destacados** (la tarjeta y su detalle) y Administración > **Reseñas de servidores** | Supabase, solo con la conexión opcional `featuredServers` |

## 1. Control remoto desde el celular

### Cómo se usa

1. En la pestaña **Red** del servidor, **Prender**. Si la PC tiene más de una red local, se elige cuál.
2. La primera vez, el Firewall de Windows puede preguntar: se acepta solo para redes privadas. No hace falta abrir puertos en el router y no hay que hacerlo.
3. Escanear el QR con el celular, conectado a la misma red, o abrir la dirección en su navegador y escribir el código.
4. Desde la página se ve el estado, los jugadores y las últimas líneas de la consola, y se puede iniciar, detener, reiniciar y mandar comandos. Detener, reiniciar y mandar un comando piden confirmación.
5. En el launcher se ve quién está conectado, con **Cortar**. Se apaga con **Apagar**, a las 12 horas o al cerrar el launcher.

### Archivos

| Archivo | Qué hace |
|---|---|
| `src/main/modules/serverremote.js` | Canales, enlace con `core/servers`, tareas, IP elegibles |
| `src/main/modules/serverremote/host.js` | Servidor HTTP (sin Electron): rutas, autenticación, clientes, vencimiento |
| `src/main/modules/serverremote/security.js` | Token, comparación, Host, Origin, límite de intentos, lista de acciones, limpieza de la consola |
| `src/main/modules/serverremote/qr.js` | Codificador QR propio (modo byte, corrección M, versiones 1 a 10) |
| `src/main/modules/serverremote/page/` | La página del celular: `index.html`, `app.js`, `app.css`, sin dependencias |
| `src/renderer/js/features/serverremote/remote.js` | Tarjeta del launcher |
| `src/renderer/js/features/serverremote.js` | `startup()`: avisa cuando entra un dispositivo o se apaga solo |
| `src/main/i18n/{es,en}/serverremote.js` | Errores, líneas de consola y textos de la página (`page_*`) |
| `src/renderer/i18n/{es,en}/serverremote.js` | Textos de las tarjetas |
| `src/renderer/styles/features/serverremote.css` | Estilos (`.sr-`, y `.srv-` para las reseñas) |

### Canales

| Canal | Devuelve |
|---|---|
| `serverremote:addresses()` | `[{ name, address }]`: IP elegibles |
| `serverremote:status(id)` | `{ on: false }` o `{ on, address, port, baseUrl, url, code, expiresAt, rejected, clients: [{ ip, device: { os, browser }, firstSeen, lastSeen, connected }], qr: { size, rows } }` |
| `serverremote:start(id, { address? })` | Lo mismo. Una `address` que no está en la lista se ignora |
| `serverremote:stop(id)` | `{ on: false }` |
| `serverremote:rotate(id)` | Código nuevo. Todos se tienen que volver a emparejar |
| `serverremote:kick(id, ip)` | Corta esa IP hasta apagar y cambia el código |
| evento `serverremote:changed` | `(id, { on, kind: 'started' \| 'stopped' \| 'connected' \| 'rejected', reason?, device? })`, sin el token |

Exports: `status`, `start`, `stopFor(id, motivo)`, `stopAll`, `addresses`, `PAGE_KEYS`. `serverx.js` llama a `stopFor(id, 'removed')` al borrar un servidor.

No guarda nada en disco: ni ajustes ni tokens. Cada encendido es nuevo.

### API de la página

Todas las rutas son una lista cerrada; nada del pedido llega a una ruta de archivo.

| Ruta | Pide token | Qué hace |
|---|---|---|
| `GET /`, `/app.js`, `/app.css`, `/strings.json`, `/favicon.ico` | No: no tienen datos del servidor | La página y sus textos |
| `GET /api/state` | Sí | Estado, jugadores y líneas nuevas. Header `X-Venus-After: <seq>` para pedir solo lo nuevo |
| `POST /api/action` | Sí | `{ action, command?, confirm? }`, `application/json`, hasta 2 KB |

Acciones: `start`, `stop`, `restart` y `command`. Las últimas tres exigen `confirm: true`. Respuestas de error: `{ error }` con 400 (`bad_json`, `bad_field`, `unknown_action`, `confirm_required`, `bad_command`), 401 (`bad_token`), 403 (`cut` o texto `forbidden`), 405, 409 (`busy`, `offline`), 410 (vencido), 413, 415, 429 (`too_many`, con `retryAfter` y `Retry-After`).

### Seguridad

| Medida | Cómo |
|---|---|
| Solo la red local | `listen` en una IP de `lanAddresses`: RFC 1918 en un adaptador que no sea VPN ni virtual. Nunca `0.0.0.0`, una IP pública, CGNAT o link-local. Si la PC cambia de red, se apaga |
| Pedidos de afuera | Un pedido cuya IP de origen no sea privada se corta con 403, aunque alguien haya redirigido el puerto en el router |
| Token | 28 caracteres de base32 de Crockford (140 bits) de `crypto.randomBytes`. Se regenera en cada encendido |
| Transporte del token | Viaja en el `#fragmento`: no se manda al servidor ni queda en logs. La página lo saca de la URL con `history.replaceState`, lo guarda en `sessionStorage` y lo manda en el header `X-Venus-Token`. Un pedido con query string recibe 400 sin mirarlo |
| Comparación | `timingSafeEqual` sobre los SHA-256 |
| DNS rebinding | `Host` tiene que ser exactamente `<ip>:<puerto>`, en todas las rutas. Con `Host` repetido, 403 |
| CORS | Ningún `Access-Control-*`. `OPTIONS` recibe 405, así que el header propio nunca pasa el preflight de otro origen. `Origin`, si viene, tiene que ser esta página. `Sec-Fetch-Site` de otro sitio se corta en la API |
| Cabeceras | `Cache-Control: no-store` en todas las respuestas, CSP sin código en línea (`default-src 'none'`), `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Connection: close` |
| Intentos | Por IP: 5 tokens malos en 5 minutos bloquean 10 minutos, aun con el token bueno. General: 40 en 5 minutos frenan 5 minutos a quien no haya entrado todavía. Memoria acotada |
| Tamaños | Cuerpo de 2 KB, URL de 64 caracteres, encabezados de 8 KB, comando de 256 caracteres, hasta 32 conexiones. Timeouts de 5 s para los encabezados y 10 s para el pedido |
| Duración | 12 horas fijas (no se renuevan con el uso). Apagado al cerrar el launcher (`onQuit`) |
| Lista cerrada | `parseAction` rechaza acciones desconocidas y campos de más. No hay `kill`, archivos ni propiedades |
| Datos | Solo pasan nombre, tipo, versión, estado y jugadores (nombre y hora). Sin IP, UUID ni rutas. Las direcciones se sacan de la consola (`redactLine`) |
| Texto no confiable | La página solo usa `textContent`. El User-Agent se reduce a una lista cerrada de sistemas y navegadores antes de llegar al launcher |
| Modo streamer | El QR no se dibuja; la dirección y el código van con `.priv` |
| Cortar | Esa IP recibe 403 hasta apagar y el código cambia, porque quien lo tiene podría entrar desde otra IP. Los demás dispositivos se tienen que volver a emparejar |

### HTTP sin TLS: qué implica

La conexión es HTTP dentro de la LAN. Un certificado para una IP local no sería de confianza en el celular sin instalar algo a mano, y la opción sería una advertencia que enseña a ignorarlas.

Quien pueda ver el tráfico de esa red (otro equipo en un WiFi abierto, un AP comprometido, ataques de ARP spoofing) puede leer el token del primer pedido, la consola y los comandos, y con ese token manejar el servidor hasta que se apague o cambie el código. Por eso:

- Hay que usarlo solo en una red de confianza. El launcher lo avisa siempre que está prendido.
- Todo lo sensible está acotado: no se expone el disco, solo la consola y los comandos del servidor. Los comandos sí tienen permisos de operador en el servidor (por ejemplo, `op`).
- Dura como mucho 12 horas, avisa cada dispositivo nuevo y muestra los intentos rechazados.
- El QR o el enlace copiado pueden quedar en el historial de la app que lo leyó. Dejan de servir al apagar.

La protección frente a sitios web (rebinding, CORS, token en header) no depende de TLS y sigue valiendo.

### Límites

- "Conectado" significa que pidió el estado en los últimos 30 s. Los que no piden nada se olvidan a los 10 minutos.
- La página consulta cada 3 s y se detiene con la pestaña en segundo plano. Si el navegador descarta la pestaña, el token sigue en `sessionStorage` mientras ese navegador la recupere.
- En redes con aislamiento de clientes (WiFi de invitados, algunos routers) el celular no llega a la PC.
- La consola muestra las últimas 200 líneas.
- Dos dispositivos detrás de la misma IP cuentan como uno.

### Pruebas

```bash
node --test "src/main/modules/serverremote/test/*.test.js"
```

`host.test.js` hace pedidos HTTP reales (`Host` falso, repetido o ausente, query string, preflight, intentos, tamaños, vencimiento, cortar). `qr.test.js` decodifica el QR con un lector escrito aparte. `module.test.js` usa `core/servers` con una carpeta temporal.

Para capturas: `VENUS_REMOTE_FAKE_LAN=1` junto con `VENUS_DEVSHOT` y sin empaquetar hace que la única "red local" sea `127.0.0.1`. Así no aparece el aviso del firewall.

## 2. Avisos por Discord

### Cómo se usa

En la pestaña **Ajustes** del servidor, tarjeta **Avisos por Discord**: pegar el webhook del canal (Ajustes del canal > Integraciones > Webhooks), elegir qué avisar y **Probar**. Por defecto avisa se prendió, se apagó y se cayó. Entró o salió un jugador y copia lista se activan a mano. Los avisos salen mientras el launcher está abierto.

### Archivos y canales

`src/main/modules/serverdiscord.js` (canales y eventos), `serverdiscord/webhook.js` (validación, mensaje y cola, sin Electron), `src/renderer/js/features/serverremote/discord.js` (tarjeta). Comparte los namespaces `serverremote`.

| Canal | Devuelve |
|---|---|
| `serverdiscord:get(id)` | `{ configured, masked, enabled, events, canEncrypt, lastError, lastSentAt, queued }` |
| `serverdiscord:set(id, { url?, enabled?, events? })` | Lo mismo. Con una dirección inválida lanza un error con `code: 'invalid'` |
| `serverdiscord:remove(id)` | Borra el webhook y apaga los avisos |
| `serverdiscord:test(id)` | `{ ok: true }` o un error traducido con `code`: `none`, `offline`, `invalid`, `rejected`, `limit`, `overflow`, `retries` |
| evento `serverdiscord:changed` | `(id)` |

Export: `forget(id)`, que `serverx.js` llama al borrar un servidor.

Escucha `servers.events`: `state`, `player` y **`backup`**, un evento nuevo que emite `serverx/world.js` al terminar una copia (`(id, { auto })`, sin la ruta).

### Datos

- Webhook: `core/secure`, clave `serverdiscord.webhook.<id>` (safeStorage). Sin almacén del sistema queda solo en memoria hasta cerrar y la tarjeta lo avisa. Nunca vuelve a la interfaz: solo una máscara con el id. La interfaz no llega a esa clave (`secure:*` solo admite `ui:*`).
- Ajustes: `discordNotify: { enabled, events }` en `venus-server.json`, sin el webhook.

### Reglas

- Solo `https://discord.com/api/webhooks/<id>/<token>` o `discordapp.com` (se normaliza a `discord.com`), sin puerto, usuario, query ni fragmento. `redirect: 'error'`: el secreto no sigue a otro lado.
- Los mensajes llevan solo el nombre del servidor y el del jugador, los dos limpios: sin controles ni caracteres invisibles, con Markdown escapado y menciones y enlaces neutralizados. `allowed_mentions: { parse: [] }` siempre. `buildMessage` no lee otros campos: nunca la consola, una IP ni una ruta.
- Cola por webhook: uno por vez, cada 2,1 s (Discord admite unos 30 mensajes por minuto en un canal), hasta 30 pendientes. Con el tope lleno se pierde lo más viejo, nunca lo que está en camino ni una prueba.
- 429: espera lo que pide Discord (`Retry-After` o `retry_after`), entre 1 s y 15 minutos, y reintenta el mismo mensaje. También frena si `X-RateLimit-Remaining` llega a 0.
- Red caída o 5xx: hasta 4 reintentos, con espera de 2, 4, 8 y 16 s. 401, 403 y 404: el webhook no sirve, se descarta lo pendiente y la tarjeta lo muestra. Otro 4xx: se pierde ese mensaje.
- No bloquea al servidor: `enqueue` vuelve al instante y los eventos no esperan a la red.
- Es una conexión a internet opcional con su propio interruptor por servidor, como Discord Rich Presence. Respeta el modo sin conexión de `core/http`.

### Límites

- Sin launcher abierto no hay avisos, y al cerrarlo puede perderse el último ("se apagó").
- El tope de 30 pendientes puede perder entradas y salidas en un servidor muy concurrido.
- Quitar el webhook del launcher no lo invalida en Discord.

### Pruebas

```bash
node --test "src/main/modules/serverdiscord/test/*.test.js"
```

## 3. Reseñas y votos de servidores destacados

### Cómo se usa

En Multijugador > Destacados, cada tarjeta que viene de la nube muestra promedio, cantidad de reseñas y votos. Un clic abre el detalle: estrellas, votos, botón **Votar**, formulario y lista paginada. Sin sesión se ve todo pero no se opina. Los destacados de la lista incluida con el launcher no tienen reseñas, porque no tienen fila en la base.

Las reseñas solo se piden con la conexión opcional `featuredServers` activada, la misma que ya controla esa lista.

### Archivos

`src/renderer/js/features/serverreviews.js` (chip y detalle), `features/serverreviews/logic.js` (normalización, sin DOM), `backend.js` (RPC), `fake.js` (datos de ejemplo), `pages/multiplayer.js`, `pages/admin/reviews.js`, `supabase/migrations/0029_resenas_servidores.sql`. Textos: `multiplayer.rev_*` y `multiplayer.rev_admin_*`.

Capturas sin red: `import('./js/features/serverreviews.js').then((m) => m.useDemo('signedIn'))`, también con `'signedOut'`, `'hidden'` o `'voted'`.

### Base de datos (0029)

Se aplica después de 0006, 0012, 0014 y 0020. **Todavía no está aplicada.** Hasta entonces, las tarjetas muestran "Sin reseñas" y el detalle avisa que el servicio no está disponible.

| Tabla | Contenido |
|---|---|
| `featured_server_reviews` | Una por `(server_id, user_id)`: `stars` de 1 a 5, `body` de hasta 300, `hidden`, `hidden_at`, `hidden_by` |
| `featured_server_votes` | Una por `(server_id, user_id)`: `total` y `last_at`. No crece con el tiempo |
| `featured_review_reports` | Una por `(review_id, reporter)`: `reason` (`spam`, `abuse`, `other`), `text`, `status` |

Las tres con RLS, sin políticas y con `revoke all` a `anon` y `authenticated`: todo pasa por RPC `security definer set search_path = ''`.

| RPC | Quién | Qué hace |
|---|---|---|
| `featured_reviews_summary(p_servers)` | `anon`, `authenticated` | `{ "<id>": { avg, count, votes } }`, hasta 100 ids |
| `featured_reviews_list(p_server, p_before?, p_limit?)` | `anon`, `authenticated` | `{ avg, count, votes, mine, vote, items, next }`. De 1 a 30 por página. Sin ids de usuario ni mails |
| `featured_review_save(p_server, p_stars, p_body?)` | `authenticated` | Crea o edita. 20 nuevas por día; editar, una vez cada 5 s |
| `featured_review_delete(p_id)` | `authenticated` | Solo el autor, aun silenciado o baneado |
| `featured_server_vote(p_server)` | `authenticated` | `{ ok, votes, total, nextAt }`. `ok: false` si no pasaron 24 h |
| `featured_review_report(p_id, p_reason, p_text?)` | `authenticated` | 10 por día. Repetir no hace nada. Un silenciado puede denunciar |
| `admin_reviews_list(p_filter?, p_before?)` | admins | `reported`, `hidden` o `all`, de a 50, con las denuncias abiertas |
| `admin_review_set_hidden(p_id, p_hidden)` | admins | `review.hide` o `review.show` en `admin_log`. Ocultar cierra las denuncias |
| `admin_review_delete(p_id)` | admins | `review.delete` en `admin_log`, con el texto |
| `admin_review_dismiss(p_id)` | admins | `review.dismiss` en `admin_log` |

Errores (el mensaje es el código). 42501: `not_authenticated` (también cuentas anónimas), `user_banned`, `user_muted`, `admin_only`. 22023: `bad_server`, `bad_stars`, `bad_body`, `too_many_today`, `too_fast`, `bad_review`, `own_review`, `bad_reason`, `bad_text`, `not_found`, `bad_filter`.

Lo escrito por un usuario baneado no se muestra ni se cuenta mientras dure el baneo. Borrar el servidor o la cuenta borra sus reseñas y votos.

### Límites

- Una reseña oculta sigue oculta al editarla, pero su autor puede borrarla y escribir otra: para un caso repetido está el baneo.
- La paginación usa la fecha de creación: dos reseñas con la misma marca de tiempo al borde de una página podrían saltearse (en la práctica no se da: tendrían que caer en la misma transacción).
- El promedio se calcula al pedirlo. Con muchas reseñas convendría guardarlo aparte.
- La foto del autor usa `mc-heads.net` solo con la conexión opcional `playerHeads`; si no, el logo de Venus.

### Pruebas

```bash
node --test "src/renderer/js/features/serverreviews/test/*.test.js"
```

`contract.test.js` cruza las llamadas de la interfaz con la migración: nombres, parámetros, errores con su texto y permisos. El SQL se probó además en Postgres con una transacción que termina en `rollback`, con usuarios de prueba.

## Para integrar

- Sumar las tres carpetas de pruebas de arriba a `.github/workflows/build.yml`.
- Aplicar `0029_resenas_servidores.sql` (después de la 0028, si existe).
- Pasar a `arquitectura.md`: los canales, los exports, las claves `discordNotify` y `serverdiscord.webhook.<id>`, el evento `backup` y `VENUS_REMOTE_FAKE_LAN`.
- Mencionar en la política de privacidad del README los avisos por Discord y el control remoto.
