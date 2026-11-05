# Servidor de voz (TURN) del Voice Chat

El Voice Chat conecta a los jugadores directo entre sí (WebRTC; Supabase Realtime solo los presenta). Un servidor **TURN** hace falta en dos casos: redes que no dejan la conexión directa (CGNAT, algunas redes móviles o de empresas) y la opción **Ocultar mi IP** del Voice Chat, que solo aparece si el launcher tiene un servidor TURN.

## Cómo está armado

- **Servidor**: coturn en el VPS de Vultr (`64.176.3.21`, Ubuntu 22.04), puerto 3478 (UDP y TCP) y relays en 49152–65535/UDP. Usa `use-auth-secret`: no tiene usuarios fijos, solo acepta claves temporales firmadas con un secreto (`static-auth-secret`).
- **Edge Function `voice-turn`** (`supabase/functions/voice-turn/`, JWT verificado): a cada sesión de Venus le entrega `{ iceServers: [{ urls, username, credential }], expiresAt }`, con `username = "<vence en segundos Unix>:<id del usuario>"` y `credential = base64(HMAC-SHA1(secreto, username))`. Sin sesión responde 401; sin secreto, una lista vacía.
- **Launcher** (`src/renderer/js/voice.js`, `refreshTurn()`): pide la clave al iniciar sesión y, si vence en menos de una hora, otra vez antes de entrar a una sala (espera hasta 4 s; si no llega, entra solo con STUN). Antes de cada reinicio de ICE la renueva si hace falta y actualiza la lista de servidores de esa conexión, así una llamada que empezó sin TURN puede recuperarse por el relay. Al cambiar de cuenta la descarta. Los TURN fijos de `core/app-config.js` siguen sumándose si los hay.

El secreto vive solo en el servidor y en Supabase: nunca en el código, el instalador ni el chat.

## Configurar o cambiar el secreto

1. En el servidor: `openssl rand -hex 32` y ponelo en `/etc/turnserver.conf` (`static-auth-secret=...`), después `systemctl restart coturn`.
2. En Supabase: **Edge Functions → Secrets** (o Project Settings → Edge Functions), secreto `TURN_SECRET` con el mismo valor.
3. Opcionales: `TURN_URLS` (separadas por coma; por defecto `turn:64.176.3.21:3478?transport=udp,turn:64.176.3.21:3478?transport=tcp`) si el servidor cambia de IP, y `TURN_TTL_SECONDS` (600 a 172800; por defecto 86400) para cuánto dura cada clave.

Las claves que ya se entregaron siguen valiendo hasta que vencen solo si el secreto no cambió: al rotarlo, las salas que estaban usando el relay pierden la conexión por TURN y se recuperan al volver a entrar.

## Configuración de coturn

```text
listening-port=3478
external-ip=64.176.3.21
min-port=49152
max-port=65535
realm=venus-launcher
use-auth-secret
static-auth-secret=<TURN_SECRET>
fingerprint
no-cli
no-multicast-peers
no-tlsv1
no-tlsv1_1
user-quota=12
total-quota=200
stale-nonce=600
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
log-file=/var/log/turnserver.log
simple-log
```

Firewall (ufw): `22/tcp`, `3478/tcp`, `3478/udp` y `49152:65535/udp`. Los `denied-peer-ip` impiden usar el relay para llegar a redes privadas.

## Probar

- **Sin clave** (desde cualquier PC): un STUN Binding a `64.176.3.21:3478` tiene que responder y un TURN Allocate sin usuario tiene que dar **401** con realm `venus-launcher` (si lo acepta, es un relay abierto).
- **Con clave**: en el servidor, `u="$(( $(date +%s) + 3600 )):prueba"; echo -n "$u" | openssl dgst -sha1 -hmac "<TURN_SECRET>" -binary | base64` y probar `turn:64.176.3.21:3478` con ese usuario y clave en la [prueba Trickle ICE](https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/): tiene que aparecer un candidato **relay**.
- **En el launcher**: con la sesión de Venus iniciada, en Voice Chat → Ajustes aparece la tarjeta de red con **Ocultar mi IP** (solo se muestra si llegó una clave TURN).
- Errores de la función: panel de Supabase → **Edge Functions → voice-turn → Logs** (nunca incluyen claves).

## Respaldo cuando el servidor de Venus no responde (4.6)

El audio de una llamada ya iba directo entre las personas por WebRTC, así que una llamada en curso no se corta si cae el servidor. Lo que dependía del servidor era coordinarla (crear y abrir salas, ofertas y respuestas, candidatos ICE, chat, quién está). Desde la 4.6, si Realtime o las RPC dejan de responder, esa coordinación pasa sola a un canal cifrado y firmado sobre **brokers MQTT públicos**. Está **siempre activo y no tiene interruptor**; vale para el Voice Chat, las salas de voz de Comunidades y todo lo que use `js/voice.js`. Servidor: `0047_voz_respaldo.sql`, aplicada en producción.

- **Detección.** Cuatro señales sobre el camino principal: el socket de Realtime, el estado del canal de la sala, una prueba activa cada 4 s (`GET /auth/v1/health`, 2,5 s de tope) y el resultado de cada envío. Se declara caído si el socket lleva 2 s sin conexión, el canal 3 s sin suscripción o fallan 2 pruebas seguidas.
- **Mientras el principal anda, el respaldo está apagado**: no se abre ninguna conexión a un broker (el broker ve la IP y no hace falta en cada llamada). Una vez en el respaldo, cada mensaje sale por los dos caminos que haya y se descartan los repetidos por nonce; sin ningún camino se guarda hasta 30 s. Al volver el servidor se renuevan claves y presencia sin tocar las conexiones WebRTC y el respaldo se cierra a los 30 s, salvo que alguien en la sala solo llegue por ahí.
- **Clave de cada sala (0047).** Los brokers son de cualquiera, así que el tema (`vv1/<hash HKDF del secreto>`) y el cifrado AES-GCM salen de un **secreto de sala de 120 bits** que solo conocen sus miembros. Lo guarda la tabla `voice_room_secrets` (sin políticas ni permisos) y lo entrega `voice_fallback_secret(p_room)` a quien es miembro admitido. Se rota cuando bloquean a alguien, cuando el dueño cierra la sala o cuando cambia la contraseña (disparadores sobre `voice_members` y `voice_rooms`). Sin la 0047, la llamada anda igual pero esa sala no tiene respaldo.
- **Qué ve el broker**: la IP de cada conexión, el tema, el momento y el tamaño de cada marco (redondeado a múltiplos de 128 bytes); **no** el contenido, ni quién habla, ni la sala. Con "Ocultar mi IP", el audio sigue por el relevo TURN pero la conexión al broker no: el broker ve la IP real mientras dure la caída. Los marcos viejos o con el reloj corrido más de ±5 minutos se descartan (hace falta la hora bien puesta), hay un tope de 400 marcos por segundo y el contenido es el mismo sobre firmado con la clave de sesión ECDSA (`sign.js`, `envelope.js`).
- **Verificados y sin verificar.** Quien ya estaba cuando cayó el servidor sigue verificado. Quien entra *durante* la caída se presenta con su clave pública firmada y los demás lo ven **Sin verificar**; el menú de anfitrión no ofrece expulsarlo ni bloquearlo. En salas de comunidad, mientras no haya servidor nadie aplica "hablar" ni los demás permisos del canal.
- **Salas sin servidor.** *Salas guardadas* (cada vez que entrás con servidor queda su clave; también las de comunidad) y *Sala de emergencia* (código de respaldo de 30 caracteres que se comparte como una contraseña, sin anfitrión, contraseña, cupo ni bloqueos; se crea desde el lobby o sola si `voice_create_room` falla por red). No se puede listar salas, invitar por mensaje, usar contraseñas ni bloquear.
- **STUN y TURN.** Entran `stun.l.google.com:19302` y `stun.cloudflare.com:3478`; después de dos reinicios de ICE fallidos o con el respaldo activo se suman `global.stun.twilio.com`, `stun.nextcloud.com`, `stun1.l.google.com` y `stun.sipgate.net`. La última clave TURN se guarda cifrada y sigue valiendo hasta que vence. Límite honesto: sin TURN, dos personas detrás de NAT simétrico o CGNAT no se pueden conectar directo.
- **Brokers** (verificados el 5/11/2026 con `voice/test/probe-brokers.js`): `wss://broker.emqx.io:8084/mqtt`, `wss://broker.hivemq.com:8884/mqtt`, `wss://public.cloud.shiftr.io` (usuario y clave abiertos `public`) y, de reserva, `wss://broker-cn.emqx.io:8084/mqtt`. Cada sala usa dos conexiones a la vez a brokers distintos, elegidos por un hash del tema. `test.mosquitto.org` y `mqtt.eclipseprojects.io` no responden y `broker.mqttdashboard.com` tiene el certificado de otro nombre.
- **Archivos** (`src/renderer/js/voice/`): `mqtt.js` (cliente MQTT 3.1.1 mínimo), `seal.js`, `backup.js`, `health.js`, `paths.js`, `rescue.js`, `roster.js`. La API suma `voice.createRoom({ emergency: true })`, `voice.joinRoom(códigoDeRespaldo)`, `voice.savedRooms()`, `voice.joinSaved(código)`, `voice.forgetSaved(código)` y el evento `server`.
- **Pruebas**: `node --test "src/renderer/js/voice/test/*.test.js"` y la prueba de ventana `voice/test/window-failover.js` (cinco motores con WebRTC real, una nube falsa que se corta y brokers falsos); la prueba de salud y los brokers se probaron contra los reales con dos clientes. **Sin probar**: una llamada real entre dos PC con NAT de por medio, NAT simétrico real, una caída real del servidor de Supabase (se simuló), la clave TURN guardada contra un coturn real y la 0047 sobre salas de comunidad en producción.
