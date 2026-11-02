# Grupos para jugar y avisos

Dos funciones de la 2.0 que usan la red de amigos de Venus sin tablas nuevas:

- **Grupos para jugar**: armar un grupo con amigos (hasta 8 personas con el líder), elegir qué jugar y dónde, ver quién está listo, crear una sala de voz para todos y "Jugar todos" con un botón.
- **Avisos**: un amigo entra a un servidor o a un mundo, o un servidor favorito vuelve a estar en línea, se llena o se vacía.

| Parte | Dónde |
|---|---|
| Grupos: estado, señales y acciones | `src/renderer/js/features/party.js` |
| Grupos: lógica pura (estado del líder, validación de señales) | `src/renderer/js/features/party/logic.js` |
| Grupos: panel y tarjeta | `src/renderer/js/features/party/panel.js` |
| Grupos: preparar la instancia y entrar | `src/renderer/js/features/party/play.js` |
| Avisos | `src/renderer/js/features/notify.js` |
| Avisos: lógica pura (límites, favoritos, estados de servidores) | `src/renderer/js/features/party/notify-logic.js` |
| Avisos con botones y alertas al overlay (compartido) | `src/renderer/js/features/party/toasts.js` |
| Estilos | `src/renderer/styles/features/party.css` (`pt-`), `notify.css` (`nt-`) |
| Textos | `src/renderer/i18n/{es,en}/party.js`, `notify.js` |
| Pruebas | `src/renderer/js/features/party/test/*.test.js` |

La lógica de los avisos vive en `features/party/` porque es la carpeta auxiliar del mismo dueño (`features/notify/` no existe).

## 1. Grupos para jugar

### Cómo viajan los datos

No hay base de datos ni Realtime propio: todo pasa por las señales entre amigos de `social` (`social.sendSignal` / `social.onSignal`, sección 6.6 de la arquitectura). Esas señales solo viajan entre amigos aceptados, el servidor pone el remitente y el payload es un objeto de hasta 4 KB.

Como dos miembros del grupo pueden no ser amigos entre sí, el grupo es una **estrella**: el líder (quien lo crea) es amigo de todos, tiene el estado y se lo manda a cada miembro; los miembros solo le hablan al líder. Por eso el estado lleva los nombres de todos.

Todo lo que llega se valida en `party/logic.js` (`parseSignal`) antes de usarse: versión del protocolo, id del grupo, ids de usuario, textos sin caracteres de control ni marcas de dirección (máx. 40-60 caracteres), loaders conocidos, versiones de Minecraft con formato, códigos `PACK-XXXXXX`, direcciones `host[:puerto]` (se permiten las de la red local, para amigos en la misma casa), códigos de sala de voz y tamaño. Además se comprueba que quien manda sea quien corresponde (un `party-state` solo vale si viene del líder del grupo en el que estás; un `party-accept` solo si esa persona estaba invitada).

### Señales (`party-*`, protocolo `v: 1`)

| Tipo | Payload | Manda · Recibe |
|---|---|---|
| `party-invite` | `{ v, party, size, game, where }` (`game` y `where`: textos cortos del plan, opcionales) | Líder · invitado (aviso con Aceptar/Rechazar y alerta al overlay) |
| `party-accept` | `{ v, party }` | Invitado · líder (lo suma y responde con el estado; si el grupo ya no existe responde `party-end`) |
| `party-decline` | `{ v, party }` | Invitado · líder |
| `party-leave` | `{ v, party }` | Miembro · líder |
| `party-kick` | `{ v, party }` | Líder · miembro (se le avisa que lo sacaron) |
| `party-ready` | `{ v, party, ready, prep: 'ok', 'update', 'missing' o 'unknown' }` | Miembro · líder. También es el latido del miembro (cada minuto) |
| `party-state` | `{ v, party, rev, leaderName, members: [{ id, name, ready, prep, online }], invited: [{ id, name }], plan, voice, play: { seq } o null }` | Líder · cada miembro, en cada cambio y cada minuto |
| `party-play` | `{ v, party, seq, plan }` (plan completo) | Líder · cada miembro ("Jugar todos") |
| `party-end` | `{ v, party, reason: 'closed', 'leader' o 'timeout' }` | Líder · miembros e invitados (grupo disuelto o invitación cancelada) |

`plan = { pack, target }`:

- `pack = { kind: 'shared', code: 'PACK-XXXXXX', name, revision, mcVersion, loader }` si la instancia del líder está compartida con `features/share.js`, o `{ kind: 'version', name, mcVersion, loader }` si no. `loader` es una clave de `LOADERS` (`iris` = Fabric con el preset de Iris).
- `target = { kind: 'server', address, name }` o `{ kind: 'world', name, address }` (el mundo del líder abierto a amigos; `address` es `null` hasta que e4mc o el túnel la publican).

### Estados y tiempos

- Un grupo tiene como máximo **8 personas con el líder** (igual que una sala de voz): integrantes + invitaciones pendientes ≤ 8. Solo se puede invitar a amigos conectados (las señales no se guardan si el amigo no está conectado).
- Una invitación vence a los **5 minutos**. Las que llegan se filtran como las de `share` y `netplay`: la misma de un amigo se ignora durante 30 s y cada amigo abre como mucho 3 avisos por minuto.
- Después de aceptar, el miembro espera el primer `party-state` **20 s**; si no llega, avisa que el grupo no respondió.
- El líder reenvía el estado **cada minuto**; el miembro manda `party-ready` cada minuto como latido.
- **Líder caído**: el grupo se disuelve en el miembro con un aviso claro ("Se perdió la conexión con el líder") si pasan **200 s** sin estado, o si la presencia del líder pasa a "desconectado" y además no llegó un estado en los últimos **90 s** (un líder en Invisible se ve desconectado pero sigue mandando el estado). Al cerrar el launcher el líder intenta mandar `party-end` a todos.
- **Miembro caído**: el líder lo saca si pasan 200 s sin latido; se muestra "Desconectado" si no latió en los últimos ~2 minutos.
- Cambiar la instancia o el destino pone a todos en "no listo" (tienen que revisar su instancia otra vez); que el mundo del líder consiga o pierda su dirección no.
- Cerrar sesión en Venus (o cambiar de cuenta) termina el grupo en esa PC. Un corte de red pasajero no: si dura, lo resuelven los tiempos de arriba.
- El grupo vive en memoria (no hay archivos de datos): recargar la interfaz lo pierde y los demás lo notan por los tiempos.

### Qué hace cada uno

**Líder**: crea el grupo, invita amigos desde el panel (o con `inviteToParty(userId)` desde otra pantalla), elige una de sus instancias (si no está compartida y tiene loader, el panel ofrece "Compartir", que abre `openShareDialog`) y el destino: un servidor (guardados del Multijugador con `serverlist:saved`, favoritos de su perfil con `profile_public` o una dirección escrita, con el ping de Multijugador como vista previa) o "Mi mundo" (`openWorldToFriends` de `features/netplay.js`; la dirección se toma de `netplay:worldStatus` y de los eventos `netplay:world`, `netplay:e4mcDomain` y `netplay:tunnel` y viaja en el estado). Puede crear una sala de voz privada para el grupo (`voice.createRoom` + `voice.inviteFriend` a cada miembro; los que entran después también reciben la invitación si el líder sigue en esa sala), sacar a alguien, cancelar invitaciones, disolver el grupo y tocar **Jugar todos** (necesita un plan completo y al menos un miembro): manda `party-play` a todos y entra él también (servidor: `joinServer`; mundo: abre el diálogo de netplay).

**Miembro**: ve integrantes, plan y voz; el panel le dice si tiene la instancia (`prepFor`: la vinculada al código del modpack al día, atrasada o ninguna; o una con la misma versión y loader) con un botón para prepararla, y un interruptor **Estoy listo** (se habilita con la instancia lista). Al llegar "Jugar todos":

- si estaba listo, entra solo a los 5 s (con "Ahora no" para cancelar); si no, un aviso le pregunta;
- modpack compartido atrasado: se aplica la última revisión con los mismos canales que usa `share.js` (`get_shared_pack` → `share:diff` → instantánea con `snapshotBefore` → `share:applyManifest` → `instances.update` y, si es de un grupo de share, `mark_pack_synced`); si falla, juega con la copia que tiene;
- sin la instancia: diálogo con **Importar con el código** (`openImportCode` de share; al terminar se toca **Unirme a la partida**), **Crear una compatible** (`instances.create` con la versión y el loader) o, en un servidor, **Elegir otra instancia** (que Multijugador elija o arme una);
- entra con `joinServer(dirección, { instanceId })` de `features/serverlist.js` (elige cuenta, espera la preparación y usa Quick Play); si esa feature no carga, `launchInstance(id, { quickPlay: { server, port } })`;
- con el mundo del líder todavía sin dirección, queda esperando y entra solo cuando llega.

El primer "Jugar todos" de la sesión despacha el logro `first_party` (`venus:achievement`, contrato 3) en el líder y en cada miembro que entra. Los avisos del grupo (invitación, alguien entró o salió, a jugar, grupo disuelto) también van al overlay (`overlay:push`, `kind: 'alert'`, `icon: 'party'`).

### Interfaz

- `partyButton()`: botón chico "Grupo" (con la cantidad de integrantes y un punto si hay invitaciones). Sin sesión de Venus lleva a `settings/cloud`. Sirve en la barra de título (estilo propio para `.titlebar`) o en el menú lateral (`.sidebar .pt-btn` ocupa el ancho).
- `openParty()`: el panel (diálogo ancho). Sin grupo: "Armá tu grupo" + invitaciones recibidas. Con grupo: integrantes e invitar amigos a la izquierda; qué juegan y voz a la derecha; pie con Disolver/Salir y Jugar todos/Unirme a la partida. En ventanas chicas pasa a una columna.
- `partyCard()`: tarjeta "Jugar en grupo" para Multijugador o Inicio (amigos conectados y Crear grupo; o integrantes con quién está listo, el plan y Abrir grupo / Jugar todos).
- Sin servicio (`social.state` en `missingSchema` o `error`): "El servicio no está disponible en este momento" con Reintentar; el detalle va a la consola.

## 2. Avisos

`features/notify.js` arranca con `startup()` y guarda todo en `settings.notify`:

| Clave | Por defecto | Qué hace |
|---|---|---|
| `friendServers` | `true` | Aviso cuando un amigo entra a un servidor (con **Unirme**: `joinServer` con una instancia de la misma versión y loader si hay) |
| `friendWorlds` | `true` | Aviso cuando un amigo entra a un mundo de un jugador (sin botón: no se puede entrar) |
| `serverOnline` | `true` | Un favorito vuelve a estar en línea |
| `serverFull` | `false` | Un favorito se llena (jugadores ≥ máximo, con máximo conocido) |
| `serverEmpty` | `false` | Un favorito se queda sin jugadores |
| `profileServers` | `false` | Vigilar también los favoritos del perfil de Venus (`profile_public(p_user)` → `favoriteServers`). Viene apagado: lo que el launcher hace por su cuenta arranca apagado (README, Privacy policy) |
| `quietWhilePlaying` | `true` | Sin avisos en el launcher mientras hay una partida abierta (el overlay sigue) |
| `overlay` | `true` | Mandar los avisos al overlay (`overlay:push`, `icon: 'friend'` o `'server'`) |
| `muted` | `[]` | Ids de amigos silenciados (también desde el botón **Silenciar** del aviso) |
| `watch` | `[]` | `[{ address, name }]` servidores marcados en esta PC (hasta 20) |

- **Amigos**: se escucha el evento `'presence'` de `social`. La primera vez que se ve a cada amigo solo se anota su actividad (al abrir el launcher no se avisa de lo que ya estaba pasando). Hay aviso cuando entra a un servidor distinto (por dirección, sin el puerto por defecto) o a un mundo distinto; volver al menú o desconectarse no avisa. Como mucho **un aviso por amigo cada 10 minutos**. Solo llegan direcciones públicas: `social` ya descarta IPs privadas y nombres de red local.
- **Servidores favoritos**: la primera revisión es al minuto de abrir el launcher y después **cada 5 minutos**, solo mientras está abierto, con `pingServer` de `features/serverlist.js` (el `serverlist:ping` de Multijugador, con su caché de 20 s). El primer resultado de cada servidor solo se anota. Un servidor se da por caído recién después de **2 fallos seguidos** (un ping perdido no cuenta), y "volvió a estar en línea" se avisa al responder después de eso. Cada evento de cada servidor se avisa como mucho una vez cada 10 minutos. Los favoritos del perfil se vuelven a pedir cada 30 minutos o al cambiar de sesión; sin la migración de perfiles se vigilan solo los de esta PC.
- `notifyPanel()`: tarjeta para Ajustes con los interruptores, amigos silenciados, la lista de servidores vigilados (con su último estado, de dónde vienen y Quitar los de esta PC), agregar una dirección y **Revisar ahora**.
- `watchButton(address, name)`: campana para las tarjetas de servidores (marca o desmarca en `settings.notify.watch`).

## 3. Pruebas

```bash
node --test "src/renderer/js/features/party/test/*.test.js"
```

Cubren la máquina de estados del grupo (invitar, aceptar, rechazar, salir, echar, listo, plan, jugar todos, vencimientos, líder caído, miembros sin latido), lo que ve el miembro (`applyState`), la preparación de la instancia, la validación de cada señal y de las direcciones, el tamaño del estado (entra en 4 KB con 8 nombres largos) y los avisos (primer avistaje, límite de 10 minutos, silenciados, silencio mientras se juega, transiciones de los servidores, favoritos sin repetir). Node avisa que los archivos son módulos ES sin `"type"` en `package.json` (es el mismo aviso de `i18n-check`): no es un error.
