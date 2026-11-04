# Datos y PC (3.2)

Cinco funciones: copias automáticas de mundos, historial de rendimiento, modo familia, llevar todo a otra PC y sincronizar ajustes y temas. Este documento es de trabajo: cuando se publique la 3.2, lo que corresponda pasa a `docs/arquitectura.md` (canales en 6.3, claves en 7.2, archivos en 7.3) y a `docs/funciones.md`.

Las tarjetas de Ajustes se suman desde `features/datatools.js` con `registerSettingsCard`, sin tocar `pages/settings/*`. Todo es de esta PC salvo la sincronización, que es la única conexión nueva y está apagada por defecto.

Pruebas de todo lo de abajo:

```bash
node --test "src/main/modules/worldbackups/test/" "src/main/modules/perfhistory/test/" "src/main/modules/family/test/" "src/main/modules/portability/test/" "src/renderer/js/features/datatools/test/" "src/renderer/js/pages/performance/test/"
```

## 1. Copias automáticas de mundos

**Cómo se usa.** Ajustes → Datos → Copias automáticas de mundos (`settings/data/backups`): frecuencia, cuántas guardar por mundo, qué instancias y "también al cerrar el juego". Las copias se ven en el detalle del mundo (Datos y copias), con Restaurar, marcadas como "Automática". El reloj del panel de copias lleva a esta tarjeta.

**Cómo funciona.**

- Reusa la copia de siempre: `worlds/backups.create(inst, folder, { auto: true })`. Lo único nuevo es la marca en el nombre: `<mundo>-<fecha>.auto.zip`.
- La fecha de la última copia sale de los archivos, sin estado aparte: una copia perdida con el launcher cerrado se hace en la primera revisión (45 s después de abrir, y después cada 10 minutos).
- Nunca copia con el juego abierto en esa instancia. Lo que toca mientras se juega se hace al cerrar (5 s después, para que el juego termine de escribir). Durante la copia, `game.withStoppedInstance` no deja abrir el juego, y la tarea lleva `instanceId`, así que Jugar se ve ocupado. Se puede cancelar desde el panel de tareas.
- Un mundo sin cambios (`level.dat` no más nuevo que la última copia automática) no se vuelve a copiar: si no, varias copias iguales empujarían afuera, por la rotación, a las viejas que sirven.
- La rotación borra solo automáticas (`rotationVictims`). Una manual nunca está en esa lista. Se borran del todo y no a la papelera, a propósito: son copias que el usuario pidió tener N veces y la papelera se llenaría de archivos grandes sin que nadie lo note.
- Las pruebas de la búsqueda del culpable (`quiet`) no cuentan como cerrar el juego. Si la instancia está en esa búsqueda o subiendo a la nube, se vuelve a mirar en la próxima revisión.
- Un mundo que falló no se reintenta durante una hora ni repite el aviso.

**Archivos.** `modules/worldbackups.js`, `modules/worldbackups/plan.js` (cuentas), `modules/worlds/backups.js` (marca `.auto`), `features/datatools/backups.js`, `pages/worlds/dialogs.js`.

**Canales.** `worldbackups:status()`, `worldbackups:runNow()` (botón Copiar ahora: lo que cambió desde la última automática). Evento `worldbackups:done { copied, failed }` (aviso discreto) y el `worlds:updated { kind: 'backups' }` de siempre.

**Ajustes.** `settings.backups.schedule = { enabled (false), frequency ('hours', 'daily' o 'weekly'), everyHours (6, de 1 a 168), keep (5, de 1 a 100), instances ('all' o [ids]), onGameClose (false) }`.

**Límites.** "Diaria" y "semanal" son cada 24 horas y cada 7 días desde la última copia de ese mundo, no a una hora fija. Dos mundos cuyos nombres solo se diferencian en espacios repetidos comparten nombre de copia (ya pasaba) y entrarían en la misma rotación.

## 2. Historial de rendimiento

**Cómo se usa.** Rendimiento → pestaña Historial (`#/performance/history`): lista de partidas, gráfico de RAM, CPU o FPS, y al tildar dos partidas, la comparación (la segunda va punteada, para no depender solo del color). Se puede borrar una partida o vaciar todo.

**Cómo funciona.**

- Una muestra cada 10 s por partida: RAM y CPU del proceso con `pidusage` (la CPU dividida por los núcleos, igual que `system:usage`) y FPS con `readFps(gameDir)` de `perfhistory/fps.js`.
- Sin FPS (hoy el mod no los informa todavía) se muestra "FPS: sin datos" y por qué. Una muestra sin FPS no cuenta como cero.
- Al cerrar se resume en promedio, mínimo, 1 % bajo y máximo, y la serie se reduce a 240 puntos como mucho. El 1 % bajo es el promedio del 1 % de muestras más bajas: con una muestra cada 10 s es una referencia del peor momento, no el 1 % low por cuadro de un programa de medición.
- Cada 5 minutos se guarda lo que va, marcado como incompleto: si el launcher se cierra de golpe no se pierde la partida. Las partidas `quiet` no se registran.
- Un archivo por mes, 90 días de vida y 2 MB por archivo: al pasarse se pierden primero las series de las partidas más viejas y después partidas enteras. Con 4 meses vivos como mucho, el total no pasa de 8 MB. Es JSON compacto a propósito: con sangría, cada número de la serie ocuparía una línea.

**Archivos.** `modules/perfhistory.js`, `modules/perfhistory/{summary,store}.js`, `pages/performance.js` (pestañas), `pages/performance/{history,chart-math}.js`, `styles/features/datatools.css`.

**Canales.** `perfhistory:list({ instanceId?, limit? })`, `perfhistory:get(id)`, `perfhistory:remove(id)`, `perfhistory:clear()`. Evento `perfhistory:updated`.

**Datos.** `data/perfhistory/AAAA-MM.json`.

**Límites.** `pidusage` en Windows abre un proceso en cada medición (tarda cerca de un segundo y cuesta algo de CPU): una vez cada 10 s no se nota, pero vale saberlo en una PC muy justa. Si se quiere, se puede sumar un interruptor.

## 3. Modo familia

**Cómo se usa.** Ajustes → General → Modo familia (`settings/general/family`). Al activarlo se elige un PIN de 4 a 8 números y aparece una sola vez un código de recuperación. Opciones: tope de horas por día, horario permitido (puede cruzar la medianoche) y lista de servidores (`mc.example.com`, `b.net:25566` o `*.hypixel.net`; sin puerto vale cualquiera). El PIN se pide para cambiar o apagar el modo y para extender el tiempo.

**Qué hace.**

- Tocar el tope o el horario: aviso a los 10 minutos, cuenta regresiva de 60 s y se cierra el juego. Con PIN se extiende (15 minutos a 2 horas desde ahora, por encima del tope y del horario).
- Fuera de horario, o con el tope agotado, `addBeforeLaunch` no deja arrancar y dice desde cuándo se puede.
- Servidor fuera de la lista: se avisa y se cierra a los 15 s. Con PIN se deja seguir (y opcionalmente se agrega a la lista). Se detecta por el registro del juego, con la línea `Connecting to <host>, <puerto>`, y solo si es el mensaje entero: una línea de chat con ese texto no cuenta (la puede escribir cualquiera en el servidor).
- Los avisos salen en el launcher, en el overlay y como notificación del sistema si la ventana no tiene el foco. Todo corre en el proceso principal: recargar la interfaz o tener la ventana escondida no cambia nada.

**Cómo funciona.**

- El tiempo se cuenta una sola vez aunque haya dos juegos abiertos y por día local: lo jugado antes de medianoche es de ayer y el tope vuelve a cero. Un hueco de más de 2 minutos (PC suspendida) o un reloj atrasado no suman. Se guarda cada 30 s jugando y al cerrar: reabrir el launcher no lo reinicia.
- Las partidas `quiet` no cuentan ni se cierran.
- Para cerrar, primero se le pide a la ventana que se cierre (`taskkill` sin `/F`, así Minecraft guarda el mundo) y a los 10 s `game.stop` corta del todo.
- PIN y código: solo un hash con sal (`crypto.scrypt`, N = 32768). 5 intentos compartidos entre los dos y 5 minutos de espera; los intentos se guardan antes de contestar y van en fila, así que reiniciar o probar en paralelo no da intentos de más. Un reloj movido no bloquea más de 5 minutos. Usar el código deja de valer y da otro.
- `data/family.json` está fuera de `settings.json`: no viaja con Exportar ni con la nube. Apagar el modo borra el hash, las opciones y el tiempo jugado.

**Archivos.** `modules/family.js`, `modules/family/{logic,pin,engine}.js`, `features/datatools/family.js`.

**Canales.** `family:status()`, `family:enable(pin, config)`, `family:update(pin, config)`, `family:disable(pin)`, `family:changePin(pin, nuevo)`, `family:recover(codigo, nuevo)`, `family:extend(pin, minutos)`, `family:allowServer(pin, instanceId, { save })`. Errores con `err.code`: `badPin`, `locked`, `badInput`, `notEnabled`, `alreadyEnabled`. Evento `family:event { kind: 'warn' | 'countdown' | 'cancelled' | 'closing' | 'server' | 'serverClosing' | 'serverAllowed' | 'changed' }`.

**Límites, con honestidad (también lo dice la tarjeta).** Es un control del launcher, no una barrera de seguridad del sistema. Quien pueda abrir Minecraft por otro lado, cambiar la hora de la PC o borrar `data/family.json` lo saltea, y el archivo es del mismo usuario de Windows que juega. Un PIN de 4 a 8 números con el hash a mano se puede adivinar con tiempo. Para algo estricto están los controles parentales de Windows. Además:

- La lista se compara con la dirección que escribió el jugador, antes de resolverla. Si un servidor tiene otra dirección que apunta al mismo lugar, hay que agregarla. Las partidas LAN entran también por "Connecting to" y cuentan como servidores.
- Un mod que cambie el mensaje del registro saltea la detección de servidores.
- No hay horarios distintos por día de la semana.

## 4. Llevar todo a otra PC

**Cómo se usa.** Ajustes → Datos → Llevar todo a otra PC (`settings/data/portability`): **Exportar todo** deja elegir instancias, mundos, servidores locales, ajustes y temas, y capturas y clips, muestra lo que ocupa y guarda un `.venusbackup`. **Importar** muestra qué trae, cuánto espacio hace falta y qué va a entrar con otro nombre. Los dos muestran el progreso y dejan cancelar.

**Formato** (un ZIP con otra extensión; se abre con cualquier programa):

```
manifest.json                       { format: 'venusbackup', version: 1, createdAt, appVersion, categories, instances, servers, settings }
instances/<clave>/meta.json         venus-instance.json saneado
instances/<clave>/files/...         mods, configs, paquetes, opciones
instances/<clave>/saves/<mundo>/... mundos
instances/<clave>/media/...         capturas y clips
servers/<clave>/meta.json           venus-server.json saneado
servers/<clave>/files/...           mundos, plugins, configuración
settings/settings.json              lista blanca
```

Se escribe por streaming con `worlds/zip.zipFiles` (se agregó a ese módulo, y `zipDirectory` ahora lo usa). **No se usa `cloudsync/zipstream.js`**, a propósito: no tiene ZIP64 y corta en 4 GB y 65.535 archivos, y un "todo" pasa eso fácil. `worlds/zip` escribe y lee ZIP64 (probado con 66.000 archivos; no con más de 4 GB reales).

**Qué nunca viaja** (`portability/filter.js`, y se aplica también al importar):

- Cuentas, tokens y secretos: por nombre de archivo (`accounts.json`, `launcher_*`, `token.json`, `*.key`, `forwarding.secret`, `command_history.txt`...) y, en configuraciones de hasta 1 MB, se vacía el valor de las claves que parecen contraseñas o tokens (`rcon.password`, `velocity.secret`, `BotToken`...). El nombre solo cuenta en archivos de configuración: `secret-rooms.jar` viaja.
- Caché, registros y temporales: `logs/`, `crash-reports/`, `cache/`, `.venus/`, `natives/`, `essential/`, `*.log`, `*.part`...
- Programas: `.exe`, `.bat`, `.ps1`, `.dll`, `.sh`... Los `.js` quedan: son scripts de KubeJS, parte del modpack.
- Rutas de esta PC: `venus-instance.json` y `venus-server.json` no se copian; se escribe un `meta.json` con una lista blanca de campos. Nunca `java.path`, argumentos, `flags`, `automation`, `launch`, `share` ni `mcimport`. En las configuraciones de texto, la carpeta de datos y la del usuario se borran.
- Ajustes: solo una lista blanca de gustos. Afuera `privacy` (las conexiones opcionales las decide cada PC), `analysis` (un archivo no puede apagar el análisis de seguridad), `assistantMcp` y `mcp` (comandos), `jvmArgs`, `memory`, `ai`, `voice`, `discord`, `settingsSync`. El fondo con imagen propia pasa a estrellas y la música se apaga: son archivos de esta PC.
- Un servidor no lleva su `.jar`: queda sin instalar y el launcher lo baja de su fuente la primera vez, verificado.

**Al importar.**

- Valida el manifiesto (formato y versión) y **todas** las entradas antes de escribir nada. Una sola ruta rara (`..`, absoluta, unidad, nombre de dispositivo, `.venus/`, `venus-instance.json`, carpetas que no son del formato) rechaza el archivo entero.
- Tamaños absurdos: hasta 3 millones de entradas, 500 GB en total y 100 GB por archivo. Una entrada que dice comprimir más de 1100:1 se rechaza (DEFLATE no llega a tanto) y al extraer se corta si infla más de lo que declara.
- Avisa cuánto espacio hace falta y no empieza si no alcanza.
- Extrae todo a `<datos>/portability/staging-*` y recién al final lo mueve a su lugar: cancelar o fallar no deja nada a medias. Esa carpeta se limpia también al abrir el launcher.
- Nunca pisa: lo repetido entra con otro nombre (`Survival (2)`, `Mundo (2)`). Los ajustes son lo único que reemplaza algo, por eso van destildados, se confirman y lo anterior queda en `data/settings-before-import-<fecha>.json`.
- Solo mundos, sin instancias: entran en la instancia que coincide (mismo id o nombre, y misma versión) o en una nueva sin contenido. Una instancia con el juego abierto se saltea y se informa.
- No se ejecuta nada de lo que trae el archivo. Las instancias y los servidores traen mods y plugins, que corren al jugar: el diálogo lo avisa, y el análisis de seguridad antes de jugar sigue activo.

**Archivos.** `modules/portability.js`, `modules/portability/{filter,manifest,archive}.js`, `modules/worlds/zip.js`, `features/datatools/portability.js`.

**Canales.** `portability:estimate(seleccion)`, `portability:export(seleccion)`, `portability:pickImport()`, `portability:import(token, opciones)`, `portability:reveal(ruta)`. Errores con `err.code`: `notBackup`, `badFile`, `badPath`, `badManifest`, `newerVersion`, `tooBig`, `noSpace`, `gameRunning`. Evento `portability:imported`. Tareas con `meta.kind = 'portability'`. En capturas (`VENUS_DEVSHOT`, sin empaquetar) no abre diálogos: guarda y lee en la carpeta de las capturas.

**Límites.** Mientras se exporta no se pueden abrir las instancias elegidas; un servidor local no tiene ese seguro, solo se revisa al empezar. La limpieza de secretos es por nombres de clave: un plugin que guarde una contraseña con otro nombre, o en un archivo de más de 1 MB, la deja en el archivo (por eso el aviso de "solo tuyos o de alguien en quien confíes"). El idioma importado se aplica del todo al reabrir el launcher. Una imagen de fondo propia no viaja.

## 5. Sincronizar ajustes y temas

**Cómo se usa.** Ajustes → Cuenta y nube → Sincronizar ajustes y temas (`settings/cloud/settingssync`): interruptor apagado por defecto y solo con la cuenta de Venus. La primera vez en una PC con esta cuenta, si la nube ya tiene algo, pregunta "Traer de la nube" o "Subir esto"; cerrar sin elegir apaga el interruptor. **Borrar de la nube** quita la copia y apaga.

**Lista blanca** (`SYNC_KEYS` en `features/datatools/sync-logic.js`): `appearance.{accent, customColor, tint, background, wallpaperId, bgDim, bgBlur, uiRadius, uiDensity, uiSidebar, uiFont, uiGlass, palette, scheme, autoLightFrom, autoLightTo, seasonal, rotation, playButton}`, `looks`, `decor.{particles, density, seasonalParticles, sounds, splash, cursor}`, `nav.{order, hidden, pinned, iconPack}`, `home.layout`. Jamás rutas, tokens ni nada de la PC: un valor con una ruta no se sube ni se aplica, y lo que llega pasa por la lista y por los tipos.

No viajan por ahora, según la PC:

- Con una temporada activa, el acento y el fondo (son los de Halloween o Navidad, no los elegidos).
- Con fondos rotativos, `wallpaperId` (cambia solo cada tantos minutos).
- Con imagen propia, `background` (es un archivo de esta PC).
- Los looks viajan sin logo (pesa hasta 200 KB y no entra en el tope) ni imagen propia. Al llegar, un look que ya está acá conserva los suyos.

**Cómo funciona.**

- Corre en la interfaz: usa la sesión de Supabase y `store.setSettings` (así el tema se aplica en vivo; `settings.set` desde el proceso principal no le avisa a la interfaz). Por eso no hay módulo `settingssync` en el proceso principal.
- Fusión por clave, gana la fecha más nueva. Una fecha en el futuro (reloj adelantado en otra PC) vale como ahora.
- Debounce de 5 s al guardar. Además se revisa al abrir, al iniciar sesión, cada 15 minutos y al volver a la ventana (como mucho cada 5 minutos). En modo sin conexión no sale nada.
- Sin bucle: se compara el contenido con lo último visto, no se usa una marca de "estoy aplicando". Después de aplicar se guarda lo que quedó tras normalizar, así dos versiones del launcher que normalizan distinto tampoco se pisan.
- Conflicto de versión (otra PC guardó en el medio): la RPC devuelve lo que hay, se fusiona y se reintenta. Si no entra en 64 KB se sueltan los looks más viejos y se avisa.
- Otra cuenta en la misma PC vuelve a preguntar: lo anterior no vale.

**Archivos.** `features/datatools/{sync-logic,settingssync}.js`, `supabase/migrations/0028_sync_ajustes.sql`.

**Ajustes.** `settings.settingsSync = { enabled (false), decided, userId, version, entries: [[clave, { h, at }]], lastAt, trimmed }`. Las marcas van como lista porque `settings.set` mezcla los objetos y una clave vieja volvería a aparecer.

**Tablas y RPC** (0028, **sin aplicar**; va después de 0027 e incluye la tabla):

- `public.settings_sync(user_id, data jsonb, version bigint, updated_at)`. RLS activado, `revoke all` a `anon` y `authenticated`, 64 KB como máximo y `data` tiene que ser un objeto.
- `settings_sync_get()` → `{ data, version, updatedAt }` (`{ data: null, version: 0 }` si no hay nada).
- `settings_sync_save(p_data, p_version)` → `{ ok: true, version }` o `{ ok: false, conflict: true, data, version }`. Errores `bad_data` y `too_big` (22023) y `not_authenticated` (42501).
- `settings_sync_delete()` → boolean.
- `grant execute` solo a `authenticated`.

Mientras la migración no esté aplicada, la tarjeta dice "El servicio no está disponible en este momento" y el detalle queda en la consola.

**Límites.** Las fechas son del reloj de cada PC: dos relojes muy distintos pueden hacer ganar a la que no se tocó última. `looks` se fusiona como una sola clave: dos PCs que agregan un look distinto a la vez se quedan con la lista de la más nueva. Esta conexión tiene su propio interruptor, como Discord, y no figura en el aviso de conexiones opcionales de `features/netprefs.js` (ese archivo no es de este módulo).
