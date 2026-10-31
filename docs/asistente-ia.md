# Asistente de IA de Venus Launcher

El asistente es un agente de Claude que vive dentro del launcher: responde dudas y, cuando hace falta, **lee información y hace cambios**, pero **solo** a través de un conjunto cerrado de herramientas. Cada herramienta valida todo en código: lo que el modelo "pide" nunca se ejecuta tal cual.

- Interfaz: página **Asistente IA** (`#/assistant/<conversación>`), panel lateral (botón **Asistente** en la barra de título o **Ctrl+J**) y `openAssistant({ prompt, instanceId, autoSend })` para abrirlo desde otros módulos (por ejemplo, el diálogo de crash).
- Todas las capacidades están en todos los planes; lo que cambia entre planes son los modelos, los niveles de esfuerzo y las preguntas por día y por semana, que decide el backend. Sin plan pago no hay IA: el asistente muestra los planes (`openPlans()` de `features/plans.js`).
- Selector de modelo y esfuerzo en el campo de texto: solo los modelos y esfuerzos que permite el plan, con las preguntas que quedan hoy y en la semana de cada modelo y el presupuesto del mes. La elección se recuerda (`settings.ai.assistantModel` / `assistantEffort`) y viaja en `assistant:send` como `{ model, effort }`. Si respondió el proveedor de respaldo (`served_by.failover`), la respuesta lleva la nota "Respondió el respaldo (OpenAI)".

## 1. Cómo funciona

```
Interfaz (chat)                       Proceso principal                                   Backend / Claude
features/assistant.js  ── IPC ──▶  modules/assistant.js ─▶ assistant/agent.js ─▶ modules/ai.js ─▶ Edge Function ai-assistant
pages/assistant.js     ◀─ eventos ─  (turno, rondas de herramientas)             (con la cuenta de Venus y su plan)
                                        │
                                        └─▶ assistant/tools.js (validación + ejecución) ─▶ núcleo del launcher
```

1. Cada mensaje del usuario es un **turno** con un `turnId` propio: todas las llamadas al modelo de ese turno viajan con el mismo `turn_id` (el backend cuenta una sola consulta).
2. El mensaje del usuario lleva al principio un bloque `<launcher_context>` con el idioma del launcher, la instancia elegida en el chat y notas (por ejemplo, "el usuario deshizo tal cambio"). El **prompt de sistema es fijo** (sin fecha ni instancia) para que el caché de prompts funcione.
3. Si la respuesta trae `tool_use`, se ejecutan **todas** las herramientas pedidas (las de lectura en paralelo, los cambios de a uno y en orden) y se devuelven **todos** los `tool_result` en **un único** mensaje, con `is_error` en las que fallaron.
4. Se repite hasta `end_turn`, con un tope de **24 rondas** y cancelación (botón Detener).
5. El historial es **solo-agregar**: los bloques del asistente se guardan y se reenvían exactamente como llegaron (incluidos los bloques de *thinking* vacíos con firma). Cada conversación congela su prompt y sus definiciones de herramientas (`data/assistant/defs/<hash>.json`) para que el historial siga siendo válido aunque el launcher se actualice.

Casos especiales del bucle:

| Situación | Qué hace |
|---|---|
| `max_tokens` con `tool_use` | No ejecuta esas herramientas (pueden estar cortadas); le devuelve un error al modelo para que reintente. |
| `max_tokens` sin herramientas | Muestra la respuesta con el aviso "La respuesta quedó incompleta". |
| `pause_turn` | Reenvía la conversación tal cual para que el modelo continúe. |
| `model_context_window_exceeded` | Pide empezar una conversación nueva. |
| Firma de *thinking* rechazada (historial alterado) | Una sola vez: reintenta sin los bloques de razonamiento anteriores (recuperación documentada por la API). El archivo guardado no se edita. |
| El launcher se cerró a mitad de un turno | Al abrir la conversación se agregan `tool_result` de error para los `tool_use` sin respuesta y el turno queda "interrumpido". |
| Errores de la IA | Sin sesión → botón a **Ajustes > Cuenta y nube**; IA desactivada → **Ajustes > Inteligencia artificial**; sin plan (`noplan`) o cuota agotada (`quota`) → aviso con el uso del plan y **Ver planes** (las tarjetas de `features/plans.js`, con "Mejorar plan" por Stripe); modelo o esfuerzo fuera del plan (`plan`) → pide elegir otro en el selector. |

## 2. Herramientas y niveles de permiso

Los niveles se definen en `src/main/modules/assistant/permissions.json`. El código nunca baja el nivel mínimo propio de una herramienta (por ejemplo, `remove_mod` siempre pide confirmación aunque el archivo diga otra cosa) y **una herramienta que no figura en el archivo no se ejecuta**.

| Nivel | Comportamiento | Herramientas |
|---|---|---|
| **Lectura** | Se ejecuta sin confirmación. | `list_instances`, `get_instance_info`, `list_mods`, `get_system_specs`, `run_benchmark`, `search_mods`, `search_resource_packs`, `search_shaders`, `get_mod_versions`, `check_compatibility`, `read_crash_summary`, `list_servers`, `get_server_info`, `read_server_console`, `get_server_properties`, `list_server_plugins`, `search_server_plugins`, `list_server_backups`, `recommend_ram`, `list_snapshots`, `list_worlds` |
| **Reversible** | Antes de ejecutar se guarda una instantánea de la instancia; la tarjeta del cambio muestra **Deshacer**. | `create_instance`, `install_mod`, `install_resource_pack`, `install_shader`, `update_mod` (también baja de versión), `toggle_mod`, `set_ram`, `set_option`, `set_java_version`, `set_jvm_args`, `change_instance_version`, `create_server`, `start_server`, `stop_server`, `restart_server`, `send_server_command`, `set_server_property`, `set_server_ram`, `install_server_plugin`, `update_server_plugin`, `replace_server_plugin`, `toggle_server_plugin`, `backup_server_world`, `duplicate_instance`, `rename_instance`, `create_snapshot`, `backup_world` |
| **Destructiva** | Pide confirmación explícita en la interfaz y espera (sin tiempo límite ni aprobación automática). Si el usuario cancela, el modelo recibe "el usuario no confirmó". | `remove_mod` (el archivo va a la papelera del sistema), `remove_server_plugin`, `restore_server_backup`, `restore_snapshot`, `whitelist_add`, `whitelist_remove`, `op_player` |

Confirmaciones adicionales (también en código):

- **Instalación masiva en una instancia existente** (punto 3 de la especificación): si en una misma pregunta se van a instalar **4 o más** elementos en una instancia que ya existía antes de la conversación, se pide una sola confirmación con la lista. En instancias creadas por el asistente en esa conversación no se pide.
- **Cambiar la versión o el loader de una instancia con mundos** (`change_instance_version`): siempre con confirmación, porque al abrirlos los mundos se actualizan sin vuelta atrás, se pueden dañar (versión más vieja) o pierden para siempre los bloques e ítems de los mods que ya no cargan (otro loader). El aviso dice que Deshacer vuelve la configuración de la instancia pero no recupera los mundos. Cambiar solo la versión del loader no la pide.
- Una confirmación pendiente nunca queda escondida: si nadie está mostrando esa conversación, se abre el panel lateral.


### Servidores locales, RAM, instantáneas y mundos (herramientas agregadas el 28/10)

Código: `assistant/tools-servers.js` (servidores) y `assistant/tools-extra.js` (RAM, duplicar, renombrar, instantáneas, mundos). Reutilizan `core/servers.js`, `modules/serverx.js` y `serverx/**` (propiedades, jugadores, mundo y copias), `core/modrinth.js`, `core/instances.js`, `modules/snapshots`, `modules/worlds/backups` y `modules/perf/memory`: solo validan, aplican las restricciones y registran el Deshacer. Mismas definiciones en el Asistente (planes de Venus IA) y en el MCP.

| Herramienta | Nivel | Qué hace y qué pide |
|---|---|---|
| `list_servers`, `get_server_info` | Lectura | Tipo, versión, estado, jugadores, RAM, puerto y dirección (`localhost:<puerto>`). Solo por id exacto de la carpeta. |
| `read_server_console` | Lectura | Últimas N líneas (1-200) por el anonimizador; marcadas como contenido no confiable. |
| `get_server_properties` | Lectura | `server.properties` solo de claves conocidas; sin RCON, secretos ni rutas. |
| `list_server_plugins`, `search_server_plugins`, `list_server_backups` | Lectura | Plugins/mods (`plugins/` y/o `mods/` según el tipo), búsqueda en Modrinth con el tipo y la versión del servidor, copias del mundo. |
| `recommend_ram` | Lectura | Con `instance_id` (mods, modpack, shaders: `perf/memory`) o con `server_id` (tipo, plugins/mods, jugadores, distancia de vista) y la RAM del equipo; el tope es el 75% de la RAM (60% y 16 GB en servidores). Se aplica con `set_ram` / `set_server_ram`. |
| `list_snapshots`, `list_worlds` | Lectura | Instantáneas y mundos de una instancia (solo conteo y datos, no se borra nada). |
| `create_server` | Reversible | **Siempre pide confirmación**: crear un servidor acepta el EULA de Minecraft a nombre del usuario. Tipos y versiones que ya soporta el launcher (`servers.TYPES` / `servers.versions`). El software se instala en segundo plano con el mecanismo del launcher; no se enciende solo. Deshacer lo manda a la papelera mientras no tenga mundo. |
| `start_server`, `stop_server`, `restart_server` | Reversible (sin Deshacer) | Usan `servers.start/stop/restart`; nunca se ejecuta un `.jar` ni un comando del sistema. Apagar o reiniciar con jugadores conectados pide confirmación con sus nombres. |
| `send_server_command` | Reversible (sin Deshacer) | Un comando de la **consola de Minecraft** (sin `/`, una línea, hasta 200 caracteres), nunca del sistema. `list`, `tps`, `help` y `seed` van directo; todo lo demás pide confirmación, con aviso especial si menciona `op`, `deop`, `ban`, `ban-ip`, `pardon`, `pardon-ip`, `whitelist off` o `stop` (también dentro de `execute ... run ...`). Devuelve lo que escribió la consola. |
| `set_server_property` | Reversible | Una clave del esquema de la versión, con tipo, rango y valores validados. Bloqueadas: `enable-rcon`, `rcon.*`, `level-name`, `server-ip`, `resource-pack*`, `management-*`, `text-filtering*`, `query*`, `enable-jmx*` y todo lo que tenga password/secret/token. Las de seguridad (`online-mode`, `white-list`, `enforce-whitelist`, `enable-command-block`, `op-permission-level`, `function-permission-level`, `enforce-secure-profile`, `prevent-proxy-connections`) piden confirmación. Se aplica al reiniciar y el resultado lo avisa. |
| `set_server_ram` | Reversible | `max_mb` (y `min_mb`), hasta el 75% de la RAM; avisa que se aplica al reiniciar. |
| `install_server_plugin` | Reversible | Solo Modrinth (`assertDownloadUrl` antes de bajar nada; CurseForge todavía no existe para servidores); solo `.jar`. Con el servidor encendido se puede (archivo nuevo), pero hace falta reiniciar. Deshacer quita lo agregado (a la papelera). |
| `update_server_plugin`, `replace_server_plugin`, `toggle_server_plugin` | Reversible | Con el servidor **apagado** (Windows bloquea los jar abiertos). Actualizar/bajar de versión y reemplazar guardan el jar anterior en `<servidor>/.venus/assistant-undo/<id>/files/`; reemplazar manda el original a la papelera. Activar/desactivar renombra a `.jar.disabled`. |
| `backup_server_world` | Reversible | Zip del mundo en `<servidor>/backups/` (con `save-off`/`save-all` si está encendido). Deshacer manda ese zip a la papelera. |
| `duplicate_instance`, `rename_instance` | Reversible | La copia no trae los mundos salvo `include_worlds: true` (entonces Deshacer ya no puede quitarla). Renombrar cambia solo el nombre, no el id. |
| `create_snapshot` | Reversible | Instantánea manual (mundos solo con `include_worlds`). Deshacer borra esa instantánea. |
| `backup_world` | Reversible | Zip de un mundo de la instancia en `backups/worlds/<instancia>/`. No toca el mundo; Deshacer manda el zip a la papelera. |
| `remove_server_plugin` | Destructiva | Confirmación; el jar va a la papelera; servidor apagado. |
| `restore_server_backup` | Destructiva | Confirmación y servidor apagado. Antes guarda **otra copia** del mundo actual y después lo manda a la **papelera** (nunca se borra). Rechaza zips que traigan carpetas que no son de un mundo (`plugins`, `mods`, `config`, rutas con `..`...). |
| `restore_snapshot` | Destructiva | Confirmación; restaura mods, configuración y opciones (`worlds: 'none'`: **nunca toca los mundos**); antes guarda el estado actual como otra instantánea. |
| `whitelist_add`, `whitelist_remove`, `op_player` | Destructiva | Siempre con confirmación. Usan `serverx.playerAction`: encendido va por la consola de Minecraft, apagado edita `whitelist.json` / `ops.json` (en servidores con `online-mode` busca el UUID en la API pública de Mojang, igual que la pantalla de Servidores). |

Los cambios de un servidor encendido (propiedades, RAM, plugins) solo valen al reiniciar: las herramientas lo avisan en `warnings` y el modelo se lo dice al usuario (`restart_server`, con confirmación si hay jugadores).

**Deshacer de servidores** (`undo.js`): alcance `server` (guarda `venus-server.json`, `server.properties` y el inventario de plugins en `<servidor>/.venus/assistant-undo/<id>/`) y `servercreate`. Operaciones inversas nuevas: `srvRestoreFile`, `srvRemoveFile`, `srvRename`, `srvMeta`, `srvProjects`, `srvProperty`, `removeBackupFile`, `removeSnapshot` y `removeServer` (se niega si el servidor está encendido o ya tiene un mundo). Los cambios de archivos de un servidor encendido no se deshacen hasta apagarlo.

**Costo**: con 55 herramientas las definiciones pesan ~40 KB (~21 KB de esquemas); las nuevas no son `strict` (siguen siendo 12 de las 20 que admite la API) y el código valida todo igual. Pruebas: `selftest-servers.js` (parte de `selftest.js`, con un servidor de prueba sin Java: `test/fixtures/servers-fixture.js`) y `mcp/test/servers.test.js`.

Detalles de cada herramienta: ver las descripciones en `assistant/tool-defs.js` (en inglés, son las que lee el modelo). Las de cambios usan `strict: true` (argumentos siempre válidos según el esquema; la API admite como máximo 20 herramientas strict y 24 parámetros opcionales, por eso las de lectura no lo son). El código vuelve a validar todo igual.

## 3. Restricciones y dónde se aplican

| Restricción de la especificación | Dónde se aplica |
|---|---|
| Solo herramientas de la lista | `assistant/agent.js` (`runOne`): herramienta desconocida o ausente de `permissions.json` → error. Las de servidores MCP (`mcp__…`, sección 10) solo si son de un servidor que el usuario agregó y activó, y de la lista de ese turno (`runMcp`). |
| Sin acceso a la cuenta de Microsoft, tokens, contraseñas o pagos | No existe ninguna herramienta que los lea. `assistant/redact.js` además borra tokens, claves, emails y nombres de jugador de todo lo que sale hacia el modelo. |
| Nada fuera de la carpeta de la instancia o del servidor | Servidores: `tools-servers.js` `getServer` (solo el id exacto de la carpeta), nombres de archivo pelados y `insideDir` dentro del servidor, solo `plugins/` y `mods/`. Instancias: `assistant/tools.js` `getInstance` (solo ids de instancia existentes y con el nombre exacto de la carpeta: en Windows `SURVIVAL` abriría `survival` y saltearía los controles por id, como el de juego abierto). `assistant/guards.js`: `assertBareFileName` (sin rutas, separadores ni unidades), `insideDir` (la ruta resuelta tiene que quedar adentro), `existingContent` (solo `mods/`, `resourcepacks/`, `shaderpacks/`, sin enlaces simbólicos). Las opciones solo tocan `options.txt` de esa instancia. |
| No borrar mundos ni partidas | No hay herramienta para eso. Restaurar la copia de un servidor manda el mundo actual a la papelera (tras otra copia); `restore_snapshot` no toca los mundos; `backup_world`/`backup_server_world` solo crean copias. `saves/` solo se cuenta (cantidad de mundos). Las descargas a `saves/<mundo>/datapacks` están bloqueadas (`assertFolder`). Cambiar la versión o el loader de una instancia con mundos pide confirmación. Deshacer la creación de una instancia que ya tiene mundos se niega. |
| Descargas solo de Modrinth/CurseForge | `assistant/sources.js`: cada URL se verifica con `assertDownloadUrl` (https y host `cdn.modrinth.com` o `*.forgecdn.net`) al armar el plan **y otra vez justo antes de descargar**; los archivos se validan con el hash que publica la fuente. |
| No ejecutar comandos, scripts ni .jar | No hay herramienta que ejecute programas. Arrancar un servidor usa `servers.start` (el mecanismo del launcher) y `send_server_command` solo escribe en la **consola de Minecraft** de un servidor encendido (confirmación salvo `list`, `tps`, `help` y `seed`). Para saber la versión de Java de una instancia no se ejecuta ningún binario (se lee el marcador del runtime de Venus). |
| No cambiar cuenta, plan ni suscripción | No hay herramienta para eso. |
| No mandar datos a otros servicios | El modelo solo se usa a través de `modules/ai.js` (siempre el backend del launcher, que usa Anthropic y, de respaldo, OpenAI). Las herramientas propias solo consultan Modrinth/CurseForge con los términos de búsqueda e ids de proyectos. **Excepción**: las herramientas de los servidores MCP que el usuario agregó a mano (sección 10), con su confirmación en cada llamada salvo las de solo lectura o las que marcó "Permitir siempre". |
| Argumentos de JVM solo de una lista blanca | `assistant/jvm-args.json` + `set_jvm_args` en `assistant/tools.js`: solo ids; nunca texto libre; un solo recolector de basura; versión mínima de Java por flag. |
| Opciones solo de una lista blanca | `assistant/options-whitelist.json` + `assistant/options.js`: tipo, rango y versión mínima de Minecraft por clave. |
| Modpacks siempre en una instancia nueva | Prompt de sistema + la confirmación de instalación masiva en instancias existentes. |
| Juego abierto | Los cambios sobre una instancia en ejecución se rechazan ("Cerrá el juego…"). |

## 4. Deshacer

- Antes de cada cambio reversible (`assistant/undo.js`) se guarda en `<instancia>/.venus/assistant-undo/<id>/`:
  - `snapshot.json`: `venus-instance.json`, `options.txt` y la lista de mods, resource packs y shaders con su **sha1**.
  - `files/`: copias de cada archivo que la acción va a reemplazar o quitar.
- La acción registra además sus **operaciones inversas exactas** (restaurar archivo, quitar el archivo agregado si sigue siendo el mismo por sha1, renombrar, restaurar campos de la instancia, registros de Modrinth/CurseForge, una clave de `options.txt`, ajustes globales, borrar la instancia creada). **Deshacer revierte solo esa acción**: no pisa cambios posteriores ajenos.
- Si un cambio posterior del asistente tocó lo mismo, primero hay que deshacer ese (se avisa cuál). Deshacer la creación de una instancia se lleva también los cambios posteriores sobre ella (y no se hace si ya tiene mundos).
- Si una acción falla a mitad de camino, se revierte sola con las mismas operaciones.
- El índice está en `data/assistant/undo.json` (últimas 300 acciones, hasta 30 días).
- La primera vez que el asistente cambia una instancia existente en una conversación, también le pide al módulo de instantáneas (`./snapshots`, si existe) una instantánea completa de la configuración (`worlds: 'none'`).
- Cuando el usuario deshace algo, el modelo se entera en el turno siguiente (nota en `<launcher_context>`) y no lo vuelve a aplicar salvo que se lo pidan.

## 5. Archivos de configuración

Todos en `src/main/modules/assistant/`. Se validan al leerlos: lo que no cumple el formato se ignora.

**`permissions.json`** — nivel de cada herramienta:

```json
{ "tools": { "list_instances": "read", "install_mod": "reversible", "remove_mod": "destructive" } }
```

**`jvm-args.json`** — lista blanca de argumentos de JVM:

```json
{ "flags": [
  { "id": "gc_aikar", "group": "gc", "preset": "aikar", "minJava": 8, "label": { "es": "...", "en": "..." }, "description": "texto para el modelo" },
  { "id": "always_pretouch", "args": ["-XX:+AlwaysPreTouch"], "minJava": 8, "label": { "es": "...", "en": "..." }, "description": "..." }
] }
```

- `group: "gc"` elige el recolector con el preset de la instancia (`java.preset`: `g1`, `aikar`, `zgc`), que `core/launch.js` ya adapta a la versión de Java. Como máximo uno a la vez.
- `args` se suman a los argumentos de la instancia. Solo se aceptan flags `-XX:` que se prenden o apagan (`-XX:+Nombre`, `-XX:-Nombre`) o que llevan solo un número (`-XX:Nombre=200`, con `k`/`m`/`g`) y `-Xss`. Nunca `-D` ni opciones que ejecutan comandos o leen o escriben archivos (`On…` como `OnError`, `…File`, `…Path`, `VMOptionsFile`, `Flags`): un flag con un argumento así se ignora entero (`config.jvmArgAllowed`).
- `set_jvm_args` recibe el conjunto **completo** de ids: reemplaza los de la lista blanca y conserva los argumentos que el usuario escribió a mano.

**`options-whitelist.json`** — opciones de `options.txt`:

```json
{ "keys": { "renderDistance": { "type": "int", "min": 2, "max": 32, "label": { "es": "...", "en": "..." } },
            "graphicsMode": { "type": "enumInt", "values": { "fast": 0, "fancy": 1, "fabulous": 2 }, "since": "1.16", "legacy": "fancyGraphics" } } }
```

Tipos: `int`, `float`, `bool`, `enum`, `enumInt` (nombre → número) y `fov` (grados → valor interno). `since` = primera versión de Minecraft que la tiene; `quotedSince`/`numericBefore` resuelven los cambios de formato entre versiones.

**`plans.json`** — catálogo de planes de respaldo (sin conexión): Go, Pro, Super, Ultra, Max y Supreme con sus modelos, esfuerzos, preguntas por día y por semana y presupuesto. El catálogo vigente lo manda el backend y tiene prioridad; el plan real y la cuota de cada usuario llegan en `quota`. Las tarjetas de planes y el pago ("Mejorar plan", "Administrar suscripción") son de `features/plans.js` (canales `billing:*`, ver [pagos.md](pagos.md)).

## 6. Privacidad

Al backend del launcher (que los pasa a Anthropic o, de respaldo, a OpenAI) se envían:

- el prompt de sistema y las definiciones de herramientas (fijos),
- los mensajes que escribe el usuario, con el bloque `<launcher_context>` (idioma, instancia elegida y notas),
- los resultados de las herramientas, en JSON compacto.

Todo resultado de herramienta y el bloque de contexto pasan por `assistant/redact.js`, que reemplaza la carpeta del usuario (`~`), el nombre de usuario del sistema y del equipo, los nombres de jugador de las cuentas del launcher, UUIDs, emails, tokens/claves (JWT, `sk-ant-…`, `accessToken=…`, `Bearer …`) e IPs. Los números de versión (`1.20.1`, `0.6.0+1.21.1`) no se tocan. El resumen de crash se recorta a ~6 KB en el cliente antes de anonimizarlo.

En el bloque `<launcher_context>`, los `<` y `>` de datos ajenos se neutralizan: el nombre de la instancia (que puede venir de un pack importado) va en JSON con `<`/`>`, y las notas (que llevan títulos de mods y nombres de instancias) van sin esos caracteres. Así nada puede cerrar el bloque y agregar texto que el modelo lea como del usuario.

Las conversaciones se guardan solo en la PC del usuario (`data/assistant/conversations/<id>.json`). Cada una queda a nombre de la cuenta de Venus que la empezó (`userId`, o `null` sin sesión): otra cuenta que use el launcher en la misma PC no la ve en la lista, no la abre, no la borra y no la continúa. Al cambiar de cuenta, el chat abierto pasa a una conversación nueva. Las conversaciones guardadas antes de este control (sin `userId`) las adopta la primera cuenta que abre el asistente.

## 7. Canales IPC y eventos

| Canal | Qué hace |
|---|---|
| `assistant:send(conversationId \| null, texto, { instanceId, model, effort })` | Empieza un turno en segundo plano con el modelo y el esfuerzo elegidos (solo los del plan; sin ellos, lo último de la conversación o la última elección). Devuelve `{ conversationId, turnId, model, effort }`. |
| `assistant:confirm(requestId, aprobado, { always }?)` | Responde una confirmación pendiente. `always: true` ("Permitir siempre") solo vale en las de herramientas MCP. |
| `assistant:mcp*` | Servidores MCP del asistente (sección 10). |
| `assistant:cancel(conversationId)` | Cancela el turno (y las confirmaciones pendientes). |
| `assistant:undo(undoId)` | Deshace exactamente esa acción. |
| `assistant:conversations()` / `assistant:conversation(id)` / `assistant:deleteConversation(id)` | Historial de la cuenta de Venus con la sesión abierta (las de otra cuenta responden "No se encontró esa conversación"). |
| `assistant:status({ refresh }?)` | Estado de la IA (`ai.status()`), modelos del plan con sus esfuerzos y las preguntas que quedan (`modelOptions`), elección actual (`selection`), presupuesto del mes (`budget`), renovaciones (`resets`), `needsPlan`, catálogo de planes, herramientas con su nivel, flags de JVM y límites. |

Evento `assistant:event (conversationId, evento)`; cada evento tiene `seq` (orden) y `at`:
`turn-start` (texto del usuario), `thinking` (transitorio), `text` y `done` (`stopReason`; los dos con `failover: true` si respondió el proveedor de respaldo), `tool-start`, `tool-result` (`summary`, `warnings`, `undoId`), `confirm` (`state: pending → approved | denied | cancelled`), `undo`, `error` (`code`: `unavailable`, `session`, `noplan`, `plan`, `quota`, `network`, `rounds`, `context`…), `quota` (transitorio).

## 8. Pruebas y capturas

- `node src/main/modules/assistant/selftest.js`: pruebas del bucle con una IA falsa sobre una carpeta temporal (sin red ni Electron): lecturas en paralelo, cambio reversible + Deshacer, destructiva aceptada y rechazada, instalación masiva, errores, hosts bloqueados, `max_tokens`, tope de rondas, cancelación, persistencia, recuperación de firmas, anonimización, JVM (y la validación de `jvm-args.json`), versión de Java, cambio de versión o de loader con mundos, ids de instancia exactos, nombres con etiquetas que no cierran el bloque de contexto, conversaciones por cuenta de Venus, instancia nueva y más.
- Modo demostración para capturas: `VENUS_ASSISTANT_FAKE=1` (junto con `VENUS_DEVSHOT`) reemplaza la IA por una conversación de ejemplo (plan Ultra) que usa las herramientas reales sobre la carpeta de datos temporal; un pedido que nombra "respaldo" responde como si lo hubiera atendido OpenAI. `VENUS_ASSISTANT_FAKE=noplan` simula una cuenta sin plan. Nunca se activa en la app empaquetada sin `VENUS_DEVSHOT`.

## 9. Integración con otros módulos (opcionales)

El asistente los usa si existen y tiene su propio camino si no:

| Módulo | Para qué | Sin el módulo |
|---|---|---|
| `./compat` (`check`) | Compatibilidad antes de instalar y `check_compatibility`. | Chequeo propio: versión para el juego y el loader, dependencias e incompatibilidades declaradas en Modrinth (en los dos sentidos). |
| `./crash` (`analyzeInstance(instanceId)`) | Se suma como `launcher_analysis` al resumen de crash. | Resumen propio (crash report, `latest.log`, `hs_err_pid`, mods sospechosos). |
| `./perf` (`system({ rerun })`) | Datos del equipo y prueba de rendimiento. | Prueba de CPU propia y gama de GPU por nombre. |
| `./snapshots` (`create(instanceId, { reason, worlds: 'none' })`) | Instantánea completa en el primer cambio de cada instancia. | Solo las instantáneas propias del asistente. |
| `./curseforge` (`available`, `search`, `getMod`, `getModFiles`…) | Búsqueda e instalación desde CurseForge (ids `cf:<número>`). | Solo Modrinth. |

## 10. Servidores MCP del asistente (el asistente como cliente MCP)

El usuario puede sumarle al asistente herramientas de otros servicios con servidores MCP. Las herramientas se ejecutan **en el launcher** (no en el backend), así que funcionan igual con Claude y con ChatGPT: el backend solo ve definiciones de herramientas y `tool_use`/`tool_result`, que ya traduce para los dos proveedores. Solo con plan Go o superior (el mismo control que Venus como servidor MCP: `require('./mcp').planState()`, con `VENUS_MCP_FAKE_PLAN` para las capturas).

**Ajustes > IA > "Servidores MCP del asistente"** (`features/mcpservers.js`, ancla `ai/mcpservers`). Solo el usuario agrega servidores: la IA no tiene ninguna herramienta para eso.

| Tipo | Qué se guarda | Reglas |
|---|---|---|
| Remoto (Streamable HTTP) | URL y token opcional (`Authorization: Bearer`, cifrado en `assistant.mcpToken.<id>`) | Solo `https://` o `http://localhost` (`127.0.0.1`, `[::1]`); sin usuario ni contraseña en la URL; sin seguir redirecciones. |
| Local (stdio) | Comando, argumentos (uno por línea) y variables de entorno (valores cifrados en `assistant.mcpEnv.<id>`) | Aviso claro y casilla obligatoria al agregarlo ("ejecuta un programa en tu PC"). Se lanza **sin shell** (`spawn` con argumentos, nunca `shell: true`), con un entorno mínimo (carpetas del usuario, PATH, temporales) más las variables del usuario, y se cierra al salir del launcher o tras 10 minutos sin uso. En Windows, un `.cmd` de npm (`npx`) se lanza como `node.exe` + su script; cualquier otro `.cmd`/`.bat` se rechaza. |
| Importar de Claude Desktop | Lo mismo, desde `mcpServers` de `claude_desktop_config.json` (las rutas de `mcp/installers.js`) | Solo se **lee** el archivo. Se salta la entrada del propio Venus; las del transporte SSE viejo, con URLs no permitidas o con encabezados que no sean un token Bearer se muestran pero no se importan. |

Cada servidor se puede activar o desactivar, **Probar** (conecta de cero y lista las herramientas) y ver sus **Herramientas** con su permiso y el interruptor **"Permitir siempre"**.

**En cada turno** (`assistant/mcp-servers.js` → `toolsForTurn`):
- `tools/list` de cada servidor activo (caché de 1 minuto; se invalida con `notifications/tools/list_changed`). Un servidor que no responde en 15 s queda afuera de esa pregunta: el chat muestra un aviso (`notice`) y el modelo recibe una nota en `<launcher_context>`; el servidor sigue conectándose para la próxima.
- Hasta **40 herramientas MCP** en total (de a una por servidor, para repartirlas) y 96 KB de definiciones. Van **después** de las propias, sin `strict`, con la descripción `[MCP server "<nombre>"] …` (recortada a 1000 caracteres) y el esquema sin `$schema`/`$id` (uno de más de 16 KB no se usa).
- Nombres `mcp__<servidor>__<herramienta>`: `<servidor>` es un identificador fijo del servidor (`[a-z0-9-]`, hasta 20, no cambia al renombrarlo) y `<herramienta>` el nombre con los caracteres inválidos cambiados por `_`. Hasta 64 caracteres en total (el límite de OpenAI); si hay que recortar, un pedazo del hash del nombre original lo mantiene único y estable.

**Permisos** (`agent.js` → `runMcp`): cada llamada pide confirmación en el chat (la misma tarjeta que las destructivas, con **Cancelar**, **Permitir siempre** y **Permitir una vez**), salvo las que el servidor marca con `readOnlyHint` (cuentan como lectura y van en paralelo) y las que el usuario marcó "Permitir siempre" (`assistantMcp.servers[].alwaysAllow`; se quita en el diálogo de herramientas). Las que piden permiso van de a una.

**Resultado**: el texto de la respuesta (las imágenes y otros contenidos se reemplazan por una marca) se recorta a **20 000 caracteres**, va marcado como contenido no confiable (`untrusted_content: true` + aviso) y pasa por `redact.js` como cualquier resultado. Plazo de 90 s por llamada; cancelar el turno corta la llamada y le avisa al servidor (`notifications/cancelled`). En el chat, cada llamada muestra la herramienta, un chip con el servidor y su estado.

**Cliente MCP** (`modules/mcp/client.js`, sin dependencias): JSON-RPC por stdio y Streamable HTTP (JSON o SSE, sesión `Mcp-Session-Id` en la era heredada). Primero la versión moderna `2026-07-28` (`server/discover`, `_meta` en cada pedido y los encabezados `MCP-Protocol-Version`, `Mcp-Method` y `Mcp-Name`); si el servidor no la conoce, `initialize` con `2025-11-25` … `2024-11-05`.

**Backend**: `ai-assistant` acepta, además de las propias, hasta 48 herramientas `mcp__…` (128 KB en total, sin `strict`), y su política explica que son la única excepción a "no mandar datos a servicios externos" (ver [backend-ia.md](backend-ia.md)).

Pruebas: `node --test "src/main/modules/mcp/test/*.test.js"` (`client.test.js`: el cliente contra un servidor stdio de prueba, `mcp/test/fixtures/stdio-server.js`, uno HTTP heredado falso y el servidor MCP real del launcher; `assistant-tools.test.js`: herramientas por turno, límite de 40, permisos, "Permitir siempre", recorte, anonimización, plan, servidor caído, validaciones e importación de Claude Desktop).


## 11. Motores externos: tu Claude Code o tu Codex responden desde Venus

Desde el plan Go, el asistente puede responder con la app de IA del propio usuario en vez del backend de Venus: **Claude Code** (el comando `claude`, con su cuenta de Claude: Pro, Max, Team o Enterprise) o **Codex** (el comando `codex`, con su cuenta de ChatGPT: Plus, Pro, Business o Enterprise). La conversación sigue en la ventana de Venus, pero la IA corre en la cuenta del usuario y gasta **sus** límites, no la cuota de Venus IA. Es la contracara de [mcp.md](mcp.md): allá el usuario habla en Claude Desktop o ChatGPT y Venus presta sus herramientas; acá habla en Venus y su app presta la IA.

Cómo funciona (`assistant/engines.js`, integrado en `agent.js` como `runExternalTurn`):

- Venus lanza el CLI **tal cual lo instaló el usuario** (lo busca en el PATH y en las carpetas habituales: `installers.findClaudeCli` y `findCodexCli`, que también mira la app de escritorio de Codex en `%LOCALAPPDATA%\OpenAI\Codex\bin`), sin modificarlo y sin tocar ni guardar sus credenciales: la sesión se inicia en la propia app (`claude auth login`, `codex login`). Detección: `claude auth status` (JSON con `loggedIn`, `authMethod`, `subscriptionType`) y `codex login status`; se guarda 60 s y se avisa con el evento `assistant:engines` cuando cambia.
- Le conecta como **única herramienta** el servidor MCP local del launcher (`mcp.localEndpoint()`: arranca el servidor aunque el interruptor de Ajustes esté apagado, solo para esto; `bridge.json` sigue diciendo `enabled: false`, así que el puente de Claude Desktop y el túnel siguen apagados). Las herramientas son las mismas del asistente, con el mismo control de plan, las confirmaciones en la ventana de Venus, Deshacer y la Actividad MCP (`mcp.activitySince`: de ahí salen el resumen, los avisos y el `undoId` de cada tarjeta de herramienta). Las herramientas propias del CLI (archivos, shell, web) quedan apagadas.
- **Claude Code**: `claude -p --output-format stream-json --verbose` sin herramientas propias, con `--setting-sources ""` (sin ajustes ni CLAUDE.md del usuario), `--strict-mcp-config --mcp-config <archivo>` (solo nuestro servidor, por HTTP), `--allowedTools mcp__venus-launcher` (las confirmaciones las hace Venus, no el CLI), `--permission-prompts none`, `--system-prompt-file`, `--max-turns 24`, `--model` y `--effort` si se eligieron, y la sesión elegida por Venus: `--session-id` en la primera pregunta y `--resume` en las siguientes. El prompt (contexto + pregunta) va por stdin. El CLI informa los límites del plan del usuario (ventana de 5 h y semana) en cada respuesta: la interfaz los muestra junto al modelo. Las banderas exactas están en `engines.claudeArgs`.
- **Codex**: `codex exec --json --skip-git-repo-check --ignore-user-config --sandbox read-only --disable shell_tool --disable unified_exec -c mcp_servers.venus-launcher.url=<url> -c model_reasoning_effort=<nivel>` con el prompt por stdin (`-`); `AGENTS.md` en la carpeta de trabajo lleva el prompt de sistema; `codex exec … resume <hilo> -` continúa la conversación. No se toca `~/.codex/config.toml`.
- Carpeta de trabajo vacía por motor: `data/assistant/engines/<motor>/` (las sesiones del CLI quedan asociadas a ella). Los archivos del turno (prompt de sistema y configuración MCP con el secreto) se borran al terminar.
- El motor es fijo por conversación (`conv.engine` y `conv.external.sessionId`): se elige antes de la primera pregunta (selector **Responde** del chat) o por defecto en Ajustes → IA (`settings.ai.engine`). Modelo y esfuerzo por motor en `settings.ai.engineChoice`.
- Eventos: `turn-start` y `done` traen `engine`; `limits` (transitorio: `fiveHour` y `sevenDay` en %, `engine`); `notice` con `kind: 'engine'` si el CLI no pudo conectar las herramientas. Errores: `engineLogin` (sin sesión), `engineLimit` (límite del plan del usuario), `engineMissing`, `engineTimeout` (20 min), `engine`, y `noplan` o `session` si falta el plan o la sesión de Venus.

Canales: `assistant:engines({ refresh })` → `{ current, entitled, planReason, checking, at, claude: { app, provider, installed, loggedIn, method, plan, error, usable }, chatgpt: { … }, models, efforts, choice }`; `assistant:setEngine(id)`. `assistant:status` incluye lo mismo en `engines`. `assistant:send` acepta `engine` en la primera pregunta de una conversación y devuelve `engine`.

Interfaz: selector **Responde** en el chat (`features/assistant.js`: `blockedFor` no bloquea por la cuota de Venus IA cuando responde un motor externo), tarjeta **Tu Claude y tu ChatGPT en el Asistente** en la página del Asistente y panel en Ajustes → Inteligencia artificial (`features/engines.js`, ancla `settings/ai/engines`).

Condiciones de uso (para el dueño): Anthropic permite que el usuario final inicie sesión con su suscripción en el binario **sin modificar** de Claude Code, también cuando otra app lo ejecuta, siempre que la app no pague ni intermedie el uso y no toque las credenciales ([legal-and-compliance](https://code.claude.com/docs/en/legal-and-compliance)); el Agent SDK con login de suscripción no está permitido, por eso se usa el CLI. OpenAI ofrece "Sign in with ChatGPT" para apps locales y de código abierto a través del app-server de Codex; lanzar el Codex del usuario con su propia sesión es la misma idea, pero OpenAI no publicó una respuesta explícita para apps de terceros: revisarlo antes de cobrar por esta función.

Pruebas: `node --test "src/main/modules/assistant/test/*.test.js"` (argumentos de cada CLI, salida → eventos, detección con un `runCli` falso, turnos completos contra `fixtures/fake-cli.js`, cancelación y tiempo máximo, errores de sesión y de límite).
