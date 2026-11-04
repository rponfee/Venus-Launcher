# App para celular (3.4): amigos, mensajes, clips y avisos

> Borrador del agente de la app. Cuando se publique, lo que sirva para otros módulos pasa a [arquitectura.md](../arquitectura.md), [supabase.md](../supabase.md), [supabase/functions/README.md](../../supabase/functions/README.md), [web/LEEME.md](../../web/LEEME.md) y [funciones.md](../funciones.md).

Es una **PWA**: una aplicación web instalable desde el navegador del celular, en Android y en iPhone, **sin tiendas de aplicaciones** (publicar en tiendas requiere cuentas del dueño y una revisión externa). Vive en `web/app/` y se publica junto con la web. No tiene paso de compilación: HTML, CSS y JS (módulos ES) directos. Para jugar se sigue usando el launcher en la PC.

## 1. Para el usuario

- **Entrar** con la cuenta de Venus: email y contraseña, crear cuenta, confirmar con código y recuperar la contraseña con código. **Salir** corta los avisos de ese celular y borra todo lo guardado.
- **Amigos**: quién está en línea y a qué juega, solicitudes (aceptar, rechazar, cancelar) y agregar por código o nombre.
- **Mensajes**: conversaciones y chat en tiempo real con las mismas tablas que el launcher. Texto, GIF de KLIPY, stickers, "escribiendo..." y "leído".
- **Clips**: lo que te mandaron, lo que compartiste y la galería pública. La lista no descarga nada: el archivo se pide recién al tocarlo.
- **Avisos**: bandeja de mensajes, solicitudes y clips sin ver, y un botón para recibirlos con la app cerrada.
- **Instalar**: en Android, desde el menú del navegador o el botón de Tu cuenta. En iPhone, Safari > Compartir > **Agregar a inicio**; **en iPhone los avisos solo funcionan con la app instalada y con iOS 16.4 o más**.
- Español (voseo) o inglés según el idioma del navegador. Tema claro u oscuro según el celular.

## 2. Archivos

| Archivo | Qué hace |
|---|---|
| `web/app/index.html`, `manifest.webmanifest`, `_headers`, `css/app.css`, `assets/` | Cáscara, CSP, íconos y fuentes (`Outfit` y `Pixelify Sans`, con su licencia OFL) |
| `web/app/sw.js` | Service worker: cáscara en caché y avisos push |
| `web/app/vendor/` | `supabase.js` (el build UMD de `node_modules`, 2.118.0) y su licencia MIT |
| `web/app/js/shared/` | Scripts clásicos que comparten la página y el service worker: `config`, `idb`, `session`, `texts`, `media`, `notify` |
| `web/app/js/logic.js`, `backend.js`, `store.js`, `push.js`, `dom.js`, `main.js` | Lógica pura, datos, estado en memoria, avisos, armado de nodos y arranque |
| `web/app/js/screens/` | `login`, `friends`, `messages`, `chat`, `clips`, `inbox`, `account` |
| `web/app/dev/fake.js` | Cliente falso: solo con `?fake=1` en `localhost`. Parámetros: `login=1`, `gallery=1`, `push=ios_install`, `sw=1` |
| `web/app/test/` | Pruebas `node:test` |
| `supabase/migrations/0035_app_celular.sql` | Suscripciones, límites, clips recibidos, bandeja y disparo |
| `supabase/functions/push-notify/` | `index.ts`, `handler.ts`, `vapid.ts`, `generar-claves.mjs` y `tests/` |

El ícono sale de `src/renderer/assets/logo.png` (640 px), el mismo logo de `web/assets/venus-256.png`, que no alcanza para 512 px.

## 3. Decisiones

**Cuenta.** Todos los métodos de `js/cloud.js` funcionan en un navegador normal, así que se ofrecen todos y ninguno queda afuera. **No hay que autorizar ninguna URL de redirección**: los emails traen códigos (`{{ .Token }}`, ya exigido por el launcher), no se pasa `redirectTo` y `detectSessionInUrl` está apagado.

**Clave.** La misma URL y la misma anon key pública de `src/main/core/cloud-defaults.js`, en `js/shared/config.js`. Una prueba revisa que el JWT sea `role: anon`.

**Sesión.** Va con el adaptador `storage` de supabase-js, con la misma clave (`venus-auth`) y el mismo contenido que escribe la librería, pero en IndexedDB y no en `localStorage`. **Es lo único que cambia respecto de "como la guarda supabase-js", y hace falta:** un service worker no puede leer `localStorage`, y el aviso se consulta con esa sesión. Si IndexedDB no contesta en 3 s (Safari a veces no lo hace) queda en memoria y hay que volver a entrar. No se usa el candado `lock`: supabase-js 2.118 lo da por obsoleto y coordina la renovación comparando lo guardado.

**Cifrado.** El launcher no cifra nada: `messages.body` es texto plano protegido con RLS. Acá es igual. GIF y sticker son mensajes cuyo cuerpo es solo la dirección; se dibujan como imagen solo si pasan `js/shared/media.js` (las mismas reglas del launcher) y si no, se ven como texto.

**Presencia.** El celular **nunca llama a `social_heartbeat`**. Esa fila es una por usuario: publicar desde el celular pisaría la actividad del launcher y borraría a qué está jugando. Por eso no apareces como jugando ni como conectado desde el celular, y lo dice Tu cuenta.

**Clips recibidos: el dato no existía.** `shared_media` solo la ve su dueño, y lo que se manda a un amigo viaja por la señal `media-share`, efímera: se perdía si el launcher no estaba abierto. Por eso 0035 agrega `media_received` y reemplaza `social_send_signal` (misma firma, mismos límites, una línea más) para anotarlo del lado del servidor, sin tocar el launcher. **Solo aparece lo que se mande después de aplicar 0035.** Quedan guardados links firmados de un año, visibles solo para quien los recibió. "Dejar de compartir" sigue funcionando: borra el archivo y el link deja de andar.

**Disparo: `pg_net`.** Está disponible en el proyecto pero apagado, y 0035 lo prende. Se eligió antes que un webhook de base de datos porque el webhook usa `pg_net` igual, necesita pasos en el panel y deja el secreto a la vista en la definición del trigger; así el secreto queda en Vault. Si `pg_net` o la configuración faltan, el trigger no hace nada y el mensaje se guarda igual.

**Sin clave en el repositorio.** La página pide la clave pública a `GET /functions/v1/push-notify`. Si cambia, la app se vuelve a suscribir sola.

**Service worker.** Script clásico, no módulo, para funcionar en todos los navegadores con Web Push. Solo intercepta GET del mismo origen de la lista `SHELL`; Supabase y KLIPY ni pasan por él. La cáscara abre siempre desde la caché y se actualiza sola: al abrir, como mucho cada 6 horas, pregunta por cada archivo y reescribe solo lo que cambió (por `ETag`, que Netlify manda), todo junto al final para no dejar dos versiones mezcladas. **No hace falta cambiar `VERSION` al publicar**; se cambia solo para forzar una caché nueva. Por eso una versión nueva puede tardar hasta 6 horas y una apertura más en verse.

## 4. Cómo funciona un aviso

```
INSERT en messages o friendships, o social_send_signal('media-share')
  -> private.push_dispatch: ¿el destinatario tiene celular? ¿pasaron 2 minutos? ¿hay configuración?
  -> net.http_post a push-notify con { user, kind, key } y x-venus-push-secret. Nunca el texto.
  -> push-notify: verifica el secreto y llama a push_claim (decide de verdad, con un candado por usuario)
  -> POST vacío a cada endpoint, con JWT de VAPID (ES256, 1 hora) y TTL de un día
  -> 404 o 410: push_drop borra ese celular
  -> el celular despierta al service worker, que llama a app_inbox con la sesión guardada y muestra el aviso
```

- **Sin sesión**, sin red o con la API caída: aviso genérico ("Tenés novedades en Venus."), sin nombres ni texto.
- **El texto** solo aparece porque lo pide el celular con la sesión (`app_inbox(true)`), y se puede apagar en Avisos. Un GIF o un sticker dicen "GIF" o "Sticker", nunca la dirección.
- **Permiso**: se pide únicamente al tocar **Activar avisos**, y es lo primero que hace ese toque (Safari lo exige).
- **Con la app a la vista** no se muestra nada, salvo en iPhone: Safari puede cancelar la suscripción si un aviso no muestra nada.
- **Límites**: uno cada 2 minutos por conversación o remitente, y 30 por hora por cuenta. Si el destinatario lee y le escriben otra vez dentro de esos 2 minutos, no hay aviso nuevo.

## 5. Tablas y RPC (0035)

Tablas con RLS y `revoke all`, sin acceso directo: `push_subscriptions` (solo el endpoint: sin carga no hay claves de cifrado; hasta 5 por cuenta, se cae el que hace más que no se usa), `push_throttle` y `media_received` (hasta 200 por cuenta).

| RPC | Quién | Para qué |
|---|---|---|
| `push_subscribe(p_endpoint, p_label?)` | authenticated | Guarda el celular. Solo `https` de FCM, Mozilla, Apple o Windows; si no, `bad_endpoint`. Un endpoint que estaba en otra cuenta pasa a esta |
| `push_unsubscribe(p_endpoint)` | authenticated | Borra un celular propio |
| `app_inbox(p_preview?)` | authenticated | `{ at, messages, requests, clips }`. El texto solo con `p_preview` |
| `media_received_list(p_before?, p_limit?)` · `media_received_seen(p_ids?)` · `media_received_remove(p_id)` | authenticated | Lo recibido. Lo de quien bloqueaste no aparece. Sacarlo de la lista no borra el archivo |
| `push_claim(p_user, p_kind, p_key)` · `push_drop(p_ids)` | service role | Los usa la Edge Function |
| `private.push_configure(p_url, p_secret)` | solo el SQL Editor | Guarda la dirección y el secreto en Vault |

Ayudantes en `private`: `push_endpoint_ok`, `media_share_url_ok` (link firmado del Storage y en la carpeta del que lo manda), `push_dispatch`, `media_share_note`, `push_on_message`, `push_on_friend_request`.

**Si otra migración reemplaza `social_send_signal`, tiene que conservar la línea de `media-share`.**

## 6. Seguridad

- Texto ajeno siempre como nodos de texto; `dom.js` no tiene forma de usar `innerHTML` y una prueba revisa todos los archivos.
- CSP sin `unsafe-*`: `default-src 'none'`, y medios solo del proyecto y de `*.klipy.com`. Está en un `<meta>`, que vale siempre. `frame-ancestors` no se puede poner en un `<meta>`: para eso están las cabeceras de abajo.
- Los registros de `push-notify` llevan el host y el estado, nunca un endpoint ni un usuario. Antes de llamar, vuelve a validar que el endpoint sea de un servicio conocido.
- El aviso que viaja por los servicios de push no lleva contenido.
- **Atención con `pg_net`:** al activarlo, Supabase les da a `anon` y `authenticated` permisos sobre `net.http_*` y sobre las tablas `net.http_request_queue` (donde el secreto queda un instante) y `net._http_response`. Lo probé: `postgres` no se los puede sacar, son de `supabase_admin`. **No se llega desde la API** porque `net` no está expuesto (hoy: `public, graphql_public`, comprobado contra el proyecto). **No agregues `net` a "Exposed schemas".**

## 7. Publicar

Los pasos exactos están en orden; nada de esto se hizo todavía.

1. **Claves.** `node supabase/functions/push-notify/generar-claves.mjs` imprime el `supabase secrets set` y el `select` del paso 4. Corré el `secrets set`. Opcional: `supabase secrets set VENUS_PUSH_SUBJECT=mailto:<tu mail>` (si no, usa la dirección del repositorio).
2. **Migración.** Aplicá `0035_app_celular.sql` (SQL Editor o `supabase db push`). No depende de 0028 a 0034.
3. **Función.** `supabase functions deploy push-notify --no-verify-jwt --project-ref dzchklzaxyygbvfpagvx`. Va sin verificación de JWT porque la llama la base con su secreto y la app pide la clave pública sin sesión. Sumá `[functions.push-notify]` con `verify_jwt = false` a `supabase/config.toml`, así un despliegue futuro no la rompe.
4. **Disparo.** En el SQL Editor: `select private.push_configure('https://dzchklzaxyygbvfpagvx.supabase.co/functions/v1/push-notify', '<el mismo VENUS_PUSH_SECRET>');`
5. **Cabeceras.** Creá `web/_headers` y `web/_redirects`, porque Netlify solo lee los de la raíz de lo publicado (`web/app/_headers` vale únicamente si `web/app` se publica como sitio aparte):

   `web/_headers`:
   ```
   /app/*
     Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' https://dzchklzaxyygbvfpagvx.supabase.co https://*.klipy.com; media-src https://dzchklzaxyygbvfpagvx.supabase.co; font-src 'self'; connect-src 'self' https://dzchklzaxyygbvfpagvx.supabase.co wss://dzchklzaxyygbvfpagvx.supabase.co; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
     X-Content-Type-Options: nosniff
     X-Frame-Options: DENY
     Referrer-Policy: no-referrer
     Permissions-Policy: camera=(), microphone=(), geolocation=()
   ```
   `web/_redirects` (sin la barra final fallarían las rutas relativas):
   ```
   /app  /app/  301
   ```
6. **Subir** `web/` como siempre ([web/LEEME.md](../../web/LEEME.md)): con los fondos conviene `npx netlify-cli deploy --dir web --prod`. La app queda en `https://<tu sitio>/app/`. Tiene que ser HTTPS. `web/app/dev/` y `web/app/test/` se pueden borrar de lo que se sube; si quedan, no pasa nada (el cliente falso no se carga fuera de `localhost`).
7. **Probar** con un Android y un iPhone (sección 9).

El orden importa poco: sin la función, sin la migración o sin el paso 4, la app sigue andando y los avisos dicen "todavía no están disponibles"; sin 0035, la bandeja se arma con lo que hay y Recibidos lo avisa.

**Para cerrar el borrador:** agregar el paso a [web/LEEME.md](../../web/LEEME.md), la fila de 0035 a [supabase.md](../supabase.md), la función a [supabase/functions/README.md](../../supabase/functions/README.md), y al workflow `node --test "web/app/test/"` y `node --test "supabase/functions/push-notify/tests/*.test.ts"`. No los toqué porque son de otros módulos.

## 8. El launcher

No hace falta cambiar nada para que convivan: leer en un lado marca como leído en el otro, y lo que se manda de un lado llega al otro.

Dos cosas para decidir:

- **`cloud.signOut()` usa el alcance global de supabase-js**: cerrar sesión en el launcher también cierra la del celular. Si se prefiere que no, es `signOut({ scope: 'local' })`. En ese caso el celular sigue recibiendo avisos genéricos hasta que vuelva a entrar o salga.
- Falta un botón o un link a la app en Ajustes o en la web, cuando esté publicada.

## 9. Cómo verificar

```bash
node --test "web/app/test/"
node --test "supabase/functions/push-notify/tests/*.test.ts"
node scripts/check.js web/app
```

Para verla sin servidor: servir `web/app` en `localhost` y abrir `/?fake=1`. Con `?fake=1`, `__venusFake` simula lo que hacen los demás (`receive`, `typing`, `share`, `request`, `activity`).

**Falta probar con el mundo real, y es lo primero al publicar:**

- Un celular de verdad, Android y iPhone: instalar, teclado sobre el chat, área segura.
- Un aviso real de punta a punta: FCM y Apple recibiendo el JWT, y tocar la notificación (`notificationclick` no se pudo simular).
- Entrar con una cuenta real, y Realtime contra el servidor real (el código de suscripción es el mismo del launcher).

## 10. Límites

- Desde el celular no se edita, no se borra, no se reacciona ni se responde citando. Los cambios que llegan se ven, salvo las reacciones y las citas. Los `:nombre:` de emojis propios quedan como texto. Quitar amigos y bloquear siguen en el launcher.
- La galería se ve, pero sin likes, publicar ni denunciar, y sin miniaturas (la CSP no permite `data:`).
- **Videos en iPhone:** los clips son WebM y Safari puede no reproducirlos, según la versión. En ese caso el visor lo explica y ofrece abrirlo en otra pestaña. Si molesta, hay que convertir a MP4 al compartir, y eso es del launcher.
- Lo que se escribe sin conexión queda en memoria: si se cierra la app antes de que salga, se pierde.
- Los avatares son la inicial del nombre, para no pedir imágenes a terceros.
- Con la app abierta en segundo plano el celular corta el WebSocket: al volver se sincroniza y, si hace falta, rehace el canal.
