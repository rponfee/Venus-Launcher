# App para celular: PWA, mensajes, clips y avisos

> **Rama 4.5.0, sin publicar.** Consolidación documental del 3 de noviembre de 2026, reconciliada con el WIP congelado. Los informes de cada frente se conservan como antecedentes; las pruebas posteriores están atribuidas al final o en el estado de integración. Contratos y límites del código local; producción continúa hasta 0027 según la integración principal. Los resultados previos pertenecen a sus informes y no equivalen a pruebas externas repetidas ni a un despliegue. Ver [estado de integración](../estado-4.5.0.md).

Referencia de la PWA. Operación: [web/LEEME.md](../../web/LEEME.md), [Supabase](../supabase.md) y [Edge Functions](../../supabase/functions/README.md).

Es una **PWA**: una aplicación web instalable desde el navegador del celular, en Android y en iPhone, **sin tiendas de aplicaciones** (publicar en tiendas requiere cuentas del dueño y una revisión externa). Vive en `web/app/` y se publica junto con la web. No tiene paso de compilación: HTML, CSS y JS (módulos ES) directos. Para jugar se sigue usando el launcher en la PC.

## 1. Para el usuario

- **Entrar** con la cuenta de Venus: email y contraseña, crear cuenta, confirmar con código y recuperar la contraseña con código. **Salir** corta los avisos de ese celular y borra el almacenamiento propio de la PWA; conserva el de las otras páginas del sitio.
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

**Sesión.** Va con el adaptador `storage` de supabase-js, con la misma clave (`venus-auth`) y el mismo contenido que escribe la librería, pero en IndexedDB y no en `localStorage`. **Es lo único que cambia respecto de "como la guarda supabase-js", y hace falta:** un service worker no puede leer `localStorage`, y el aviso se consulta con esa sesión. Si IndexedDB no contesta en 3 s (Safari a veces no lo hace) queda en memoria hasta recargar y hay que volver a entrar. Una apertura tardía se cierra: no mezcla la sesión en memoria con una persistida anterior. No se usa el candado `lock`: supabase-js 2.118 lo da por obsoleto y coordina la renovación comparando lo guardado.

**Cifrado.** El launcher no cifra nada: `messages.body` es texto plano protegido con RLS. Acá es igual. GIF y sticker son mensajes cuyo cuerpo es solo la dirección; se dibujan como imagen solo si pasan `js/shared/media.js` (las mismas reglas del launcher) y si no, se ven como texto.

**Presencia.** El celular **nunca llama a `social_heartbeat`**. Esa fila es una por usuario: publicar desde el celular pisaría la actividad del launcher y borraría a qué está jugando. Por eso no apareces como jugando ni como conectado desde el celular, y lo dice Tu cuenta.

**Clips recibidos: el dato no existía.** `shared_media` solo la ve su dueño, y lo que se manda a un amigo viaja por la señal `media-share`, efímera: se perdía si el launcher no estaba abierto. Por eso 0035 agrega `media_received` y reemplaza `social_send_signal` (misma firma, mismos límites, una línea más) para anotarlo del lado del servidor, sin tocar el launcher. **Solo aparece lo que se mande después de aplicar 0035.** Quedan guardados links firmados de un año, visibles solo para quien los recibió. "Dejar de compartir" sigue funcionando: borra el archivo y el link deja de andar.

**Disparo: `pg_net`.** La 0035 intenta habilitar la extensión si el entorno la ofrece. En el PostgreSQL local de esta revisión no estaba disponible y se comprobó la degradación prevista; no se habilitó en producción. Se eligió antes que un webhook de base de datos porque el webhook usa `pg_net` igual, necesita pasos en el panel y deja el secreto a la vista en la definición del trigger; así el secreto queda en Vault. Si `pg_net` o la configuración faltan, el trigger no hace nada y el mensaje se guarda igual.

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
- **Antecedente del informe original sobre `pg_net`:** al activarlo, Supabase les da a `anon` y `authenticated` permisos sobre `net.http_*` y sobre las tablas `net.http_request_queue` (donde el secreto queda un instante) y `net._http_response`. Lo probé: `postgres` no se los puede sacar, son de `supabase_admin`. **No se llega desde la API** porque `net` no está expuesto (en aquella comprobación: `public, graphql_public`; no se volvió a consultar el proyecto en este cierre). **No agregues `net` a "Exposed schemas".**

## 7. Publicar

Los pasos exactos están en orden. Los archivos de configuración de los pasos 3 y 5 ya están preparados localmente; esta revisión no generó claves, no aplicó migraciones ni desplegó nada.

1. **Claves.** `node supabase/functions/push-notify/generar-claves.mjs` imprime el `supabase secrets set` y el `select` del paso 4. Corré el `secrets set`. Opcional: `supabase secrets set VENUS_PUSH_SUBJECT=mailto:<tu mail>` (si no, usa la dirección del repositorio).
2. **Migración.** Aplicá el SQL explícito de `0035_app_celular.sql` mediante SQL Editor cuando esté autorizado. No usar `supabase db push` para seleccionar solo esa migración: intentaría aplicar también otras pendientes. Puede funcionar sin 0028–0034, pero la integración de 4.5.0 prepara el conjunto en orden y debe conservar `media-share`. Nunca agregar `net` a los esquemas expuestos.
3. **Función.** `supabase functions deploy push-notify --no-verify-jwt --project-ref dzchklzaxyygbvfpagvx`. Va sin verificación de JWT porque la llama la base con su secreto y la app pide la clave pública sin sesión. `supabase/config.toml` ya incluye `[functions.push-notify]` con `verify_jwt = false`, junto con la configuración previa de `stripe-webhook`. Esto solo prepara un despliegue futuro.
4. **Disparo.** En el SQL Editor: `select private.push_configure('https://dzchklzaxyygbvfpagvx.supabase.co/functions/v1/push-notify', '<el mismo VENUS_PUSH_SECRET>');`
5. **Cabeceras.** `web/_headers` y `web/_redirects` ya están integrados localmente. Netlify solo lee los de la raíz de lo publicado (`web/app/_headers` vale únicamente si `web/app` se publica como sitio aparte):

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

## 8. El launcher

No hace falta cambiar nada para que convivan: leer en un lado marca como leído en el otro, y lo que se manda de un lado llega al otro.

Estado coordinado con la integración principal:

- **Decisión confirmada:** `cloud.signOut()` ya usa `signOut({ scope: 'local' })`. Salir del launcher afecta solo ese dispositivo y deja abierta la sesión del celular; el usuario debe salir allí para cerrar esa sesión.
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
- Un aviso real de punta a punta: FCM y Apple recibiendo el JWT, y tocar la notificación. `notificationclick` ahora tiene una prueba en VM, pero todavía no se verificó en un celular.
- Entrar con una cuenta real, y Realtime contra el servidor real (el código de suscripción es el mismo del launcher).

## 10. Límites

- Desde el celular no se edita, no se borra, no se reacciona ni se responde citando. Los cambios que llegan se ven, salvo las reacciones y las citas. Los `:nombre:` de emojis propios quedan como texto. Quitar amigos y bloquear siguen en el launcher.
- La galería se ve, pero sin likes, publicar ni denunciar, y sin miniaturas (la CSP no permite `data:`).
- **Videos en iPhone:** los clips son WebM y Safari puede no reproducirlos, según la versión. En ese caso el visor lo explica y ofrece abrirlo en otra pestaña. Si molesta, hay que convertir a MP4 al compartir, y eso es del launcher.
- Lo que se escribe sin conexión queda en memoria: si se cierra la app antes de que salga, se pierde.
- Los avatares son la inicial del nombre, para no pedir imágenes a terceros.
- Con la app abierta en segundo plano el celular corta el WebSocket: al volver se sincroniza y, si hace falta, rehace el canal.

## 11. Informe final de la revisión local (3 de noviembre de 2026)

**Alcance:** PWA y revisión defensiva de `web/app` y de la función `push-notify`, con datos inventados y sin conexiones a producción. Implementación local lista para continuar la validación visual y en dispositivos; no equivale a una publicación ni a una validación de punta a punta. Ese frente no modificó el cierre de sesión; después el dueño decidió el alcance local y la integración principal lo aplicó en `cloud.signOut()`.

### Cambios comprobados en código

- Configuración local: cabeceras estrictas únicamente para `/app/*` y redirección exacta de `/app` a `/app/` (301). No hay regla global que cambie la portada o la galería. La CSP conserva la del HTML y agrega `frame-ancestors` por cabecera. `push-notify` usa `verify_jwt = false` en el archivo local porque GET ofrece la clave pública y POST conserva la comprobación de su secreto; `stripe-webhook` sigue igual.
- Service worker: conserva los cambios previos de actualización de la cáscara por ETag. Al activar borra solo cachés viejas con el prefijo `venus-app-`. Al recibir avisos considera solo ventanas de la PWA: una pestaña de la web no suprime el aviso ni recibe mensajes internos. La renovación no borra la suscripción anterior si falla guardar la nueva. Se limpian los temporizadores de espera.
- Sesión: salir de la PWA ya no ejecuta `localStorage.clear()` ni `sessionStorage.clear()` del origen entero. Se ignoran cambios de autenticación mientras se está saliendo. La recuperación espera a `USER_UPDATED`, porque `PASSWORD_RECOVERY` llega antes de guardar la contraseña. Si guardar falla, el formulario permite reintentar sin consumir de nuevo el código; el cliente falso reproduce esos eventos. IndexedDB que llega tarde se cierra y no reemplaza la sesión en memoria.
- Mensajes y clips: la marca de lectura se confirma cuando responde la base para poder reintentarlo después de un fallo de red. Un visor pendiente no se abre después de abandonar su pantalla y un video se detiene cuando el router cierra el diálogo.
- Avisos: si registrar el navegador en la base falla, se da de baja la suscripción del navegador para que la tarjeta no muestre una activación inexistente.
- `push-notify`: límite de 400 bytes aplicado mientras se lee el cuerpo, respuesta controlada ante una lectura interrumpida, tiempo máximo de la consulta a la base, sin seguir redirecciones con credenciales, validación de la respuesta de la base y tope de cinco destinos. Los fallos no vuelcan el texto de excepciones al registro. GET conserva CORS incluso cuando responde 503 por configuración incompleta. La firma y los envíos se probaron con claves efímeras y fetch simulado.

### Rutas de este frente

- `web/_headers`; `web/_redirects`; `supabase/config.toml`.
- `web/app/sw.js`; `web/app/js/main.js`; `web/app/js/push.js`; `web/app/js/store.js`; `web/app/js/shared/idb.js`.
- `web/app/js/screens/login.js`; `web/app/js/screens/clips.js`; `web/app/dev/fake.js`.
- `web/app/test/shell.test.js`; `web/app/test/push.test.js`; `web/app/test/store.test.js`; nuevos `web/app/test/sw.test.js`, `web/app/test/login.test.js` y `web/app/test/idb.test.js`.
- `supabase/functions/push-notify/handler.ts`; `supabase/functions/push-notify/tests/push-notify.test.ts`.
- Este documento: `docs/implementacion/app-celular.md`.

### Evidencia de esta ejecución

Repositorio: `C:/Users/ringo/Downloads/Venus Launcher`. Comandos con directorio explícito y `login:false`. Se preservaron los cambios previos y CRLF. El historial avanzó desde otro frente durante el trabajo; este frente no ejecutó commit, push ni release.

- Base inicial: **66/66 pruebas** de PWA y push. El primer intento bajo sandbox falló con `spawn EPERM`; la repetición con escalación pasó. No se ejecutó la suite global del frente principal.
- Verificación final: **83/83 pruebas**, cero fallos, omisiones o cancelaciones, con Node **v25.9.0**, `--test-concurrency=4` y `VENUS_DATA_DIR` temporal. Son las pruebas de `web/app/test/*.test.js` y `supabase/functions/push-notify/tests/push-notify.test.ts`. Incluyen los nuevos casos de convivencia de cachés/ventanas, ETag, clic de aviso en VM, fallos de registro/renovación, reintento de lectura, recuperación e IndexedDB.
- `node scripts/check.js web/app`: **30/30 archivos** sin errores de sintaxis. `git diff --check` del alcance no informó errores. Los **19 archivos de código/configuración/pruebas** escritos por este frente quedaron con CRLF; el WIP también se guarda con CRLF.
- Los tests imprimen el aviso preexistente de Node `MODULE_TYPELESS_PACKAGE_JSON` y el aviso esperado `[app] cuenta same_password` en la regresión de recuperación. No se cambió el tipo de módulo del proyecto para ocultarlos.
- Primer intento visual de este frente **no completado** (superado después por la integración principal; ver la actualización final): se preparó un helper con servidor local, ventana oculta, perfil temporal y bloqueo del tráfico externo, previsto para capturar solo con `capturePage`. Electron falló antes de arrancar con `Invalid file descriptor to ICU data received`. En ese intento faltaba `node_modules/electron/dist/icudtl.dat`; tampoco se encontró un ejecutable completo en la carpeta temporal indicada para dependencias en ese momento. Ese intento no produjo capturas válidas ni evidencia de consola de la interfaz. El helper quedó en `%TEMP%/venus-pwa-smoke-db08d973df124d4b85ad81815ea7a44c/smoke.cjs` para retomar cuando el runtime esté completo. No se ejecutó npm ni se cerraron aplicaciones del usuario.

### Límites y decisiones pendientes

- La integración principal luego verificó el worker, el modo sin conexión y siete pantallas en español en Chromium/Electron 44. Siguen pendientes otros idiomas de la PWA, instalación en Android/iPhone, teclado y áreas seguras en dispositivos reales.
- Falta login/recuperación contra un servidor de prueba, Realtime entre sesiones y Web Push real con FCM/Apple. Las pruebas actuales son locales; no prueban los permisos efectivos de producción, el servicio de correo ni la entrega de avisos. Si el navegador bloquea su almacenamiento persistente, solo se puede verificar la limpieza de la memoria accesible en ese contexto.
- No se probó ni desplegó la configuración en Netlify. El alcance de cabeceras y redirecciones se verificó en archivos y regresiones locales. El pie de `web/index.html` incluye un enlace relativo `app/`, sin fijar un dominio ni afirmar que el sitio ya esté publicado.
- Según la coordinación del frente principal, producción sigue con migraciones hasta 0027. Este frente no consultó ni modificó producción, Vault, credenciales o migraciones. Quedan pendientes la 0035 y los pasos de despliegue autorizados por el dueño.
- El cierre de sesión ya fue decidido e integrado con alcance local al dispositivo. El acceso a la app se añadió al pie de la web con el enlace relativo `app/`; su disponibilidad pública depende del despliegue conjunto.
- Sin dependencias nuevas, cambios en workflows, traducciones ajenas ni documentos generales. Las restricciones funcionales de la sección 10 siguen vigentes.

## Actualización posterior de integración

La integración principal recuperó ICU/dependencias y **completó una prueba real del navegador Chromium/Electron 44**: service worker en estado activated y controlando la página, 33 archivos en caché, carga de HTML/login sin red y siete capturas a 410×870, tema claro, español, con backend falso. `console.json` quedó en `[]`. Artefactos: `%TEMP%/venus-codex-review-20261103/pwa-browser/`. El fallo ICU del intento anterior es histórico y ya fue superado.

Esto comprueba el worker y el shell en ese navegador; no un celular físico, el backend real ni Web Push real. Esas comprobaciones siguen pendientes. Las pruebas Electron con micrófono simulado y permiso Notification corresponden a permisos de escritorio, no a push móvil.

El cierre de sesión local es una decisión del dueño y ya está aplicado: la app móvil conserva su propia sesión. El estado definitivo de publicación, dispositivos y pruebas finales se sigue en [estado-4.5.0.md](../estado-4.5.0.md).
