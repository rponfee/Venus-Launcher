# Servidor de voz (TURN) del Voice Chat

El Voice Chat conecta a los jugadores directo entre sí (WebRTC; Supabase Realtime solo los presenta). Un servidor **TURN** hace falta en dos casos: redes que no dejan la conexión directa (CGNAT, algunas redes móviles o de empresas) y la opción **Ocultar mi IP** del Voice Chat, que solo aparece si el launcher tiene un servidor TURN.

## Cómo está armado

- **Servidor**: coturn en el VPS de Vultr (`64.176.3.21`, Ubuntu 22.04), puerto 3478 (UDP y TCP) y relays en 49152–65535/UDP. Usa `use-auth-secret`: no tiene usuarios fijos, solo acepta claves temporales firmadas con un secreto (`static-auth-secret`).
- **Edge Function `voice-turn`** (`supabase/functions/voice-turn/`, JWT verificado): a cada sesión de Venus le entrega `{ iceServers: [{ urls, username, credential }], expiresAt }`, con `username = "<vence en segundos Unix>:<id del usuario>"` y `credential = base64(HMAC-SHA1(secreto, username))`. Sin sesión responde 401; sin secreto, una lista vacía.
- **Launcher** (`src/renderer/js/voice.js`, `refreshTurn()`): pide la clave al iniciar sesión y, si vence en menos de una hora, otra vez antes de entrar a una sala (espera hasta 4 s; si no llega, entra solo con STUN). Al cambiar de cuenta la descarta. Los TURN fijos de `core/app-config.js` siguen sumándose si los hay.

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
