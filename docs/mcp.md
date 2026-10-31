# Venus desde Claude y ChatGPT (MCP)

Venus Launcher puede funcionar como **servidor MCP** (*Model Context Protocol*, el estándar abierto con el que las apps de IA usan herramientas externas). Con eso, la IA de **tu** cuenta de Claude (Claude Desktop, Claude Code, claude.ai) o de ChatGPT puede ver y cambiar tus instancias, mods, resource packs, shaders y ajustes de Minecraft con las **mismas herramientas y protecciones que el Asistente IA** del launcher.

Ejemplos de pedidos: "¿qué instancias tengo?", "instalá Sodium y Lithium en mi instancia de 1.21.1", "mi juego crashea al abrir, fijate qué pasa", "armame un pack liviano de tecnología para mi PC", "bajá la distancia de render a 8".

- Panel: **Ajustes → Inteligencia artificial → Claude y ChatGPT (MCP)**. Con un plan, la página del **Asistente IA** también muestra la tarjeta **"Usá el asistente desde Claude o ChatGPT"**: las apps detectadas con su estado, **Conectar** en un clic, la última actividad y, una sola vez, un aviso **Conectar / Ahora no** si hay una app de Claude instalada sin conectar (nunca conecta solo; la respuesta queda en `mcp.offer`). Se resalta cuando Venus IA no está disponible (apagada, sin sesión, sin cuota o con el servicio con problemas).
- La contracara (el usuario habla en Venus y su Claude Code o su Codex prestan la IA, con sus propios límites) está en [asistente-ia.md, sección 11](asistente-ia.md#11-motores-externos-tu-claude-code-o-tu-codex-responden-desde-venus).
- Guía para desarrolladores al final (sección 9). Código: `src/main/modules/mcp.js` y `src/main/modules/mcp/`, interfaz en `src/renderer/js/features/mcp.js`.

## 1. Qué hace falta

| Requisito | Por qué |
|---|---|
| **Un plan de Venus IA, Go o superior** (activo o de prueba) | La conexión MCP es parte de los planes pagos. Sin plan, Claude y ChatGPT ven a Venus pero sin herramientas, y si intentan usar una reciben: "Necesitás un plan de Venus IA (Go o superior) para usar Venus desde Claude o ChatGPT". |
| **Tu cuenta de Venus iniciada** en el launcher | El plan se verifica con tu cuenta (Ajustes → Cuenta y nube). |
| **Venus Launcher abierto** | El servidor MCP vive dentro del launcher: solo funciona mientras está abierto. |
| Una cuenta de Claude o ChatGPT | La IA corre en esa cuenta. **No gasta tu cuota de Venus IA.** |

El plan se revisa al abrir el launcher, cada 10 minutos, cuando cambia algo de tu plan o de tu sesión (por ejemplo, después de pagar) y cada vez que abrís el panel. Si el servidor de Venus no responde un rato (sin internet, mantenimiento), se usa la última verificación de tu cuenta durante 72 horas.

> **Nota técnica:** el control del plan lo hace el propio launcher (del lado del cliente). Las herramientas trabajan sobre tu PC y no pasan por el backend de Venus, así que el servidor no puede impedirlas: el launcher es el que se niega a ofrecerlas sin plan.

## 2. Activar y conectar

1. Abrí **Ajustes → Inteligencia artificial → Claude y ChatGPT (MCP)**.
2. Prendé el interruptor (o tocá directamente **Conectar** en alguna app: lo prende solo).
3. Elegí la app que vas a usar.

### Claude Desktop

1. Tocá **Conectar** en la tarjeta de Claude Desktop. Venus agrega su entrada a `claude_desktop_config.json` (antes guarda una copia `claude_desktop_config.json.venus-backup`).
2. **Cerrá Claude Desktop por completo** (también desde el ícono de la bandeja del sistema) y abrilo de nuevo.
3. En un chat, el menú de herramientas va a mostrar **venus-launcher**.

Dónde está el archivo: Windows `%APPDATA%\Claude\claude_desktop_config.json` (y, si Claude es de la Microsoft Store, también `%LOCALAPPDATA%\Packages\Claude_…\LocalCache\Roaming\Claude\`), macOS `~/Library/Application Support/Claude/claude_desktop_config.json`, Linux `~/.config/Claude/claude_desktop_config.json`.

Configuración manual (el panel la muestra con tus rutas exactas en **Configuración manual** → **Copiar**):

```json
{
  "mcpServers": {
    "venus-launcher": {
      "command": "C:\\Users\\<vos>\\AppData\\Local\\Programs\\Venus Launcher\\Venus Launcher.exe",
      "args": ["C:\\Users\\<vos>\\AppData\\Roaming\\.venuslauncher\\mcp\\venus-mcp-bridge.js"],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

### Claude Code

1. Tocá **Conectar** en la tarjeta de Claude Code. Si el comando `claude` está instalado, Venus ejecuta `claude mcp add` (alcance de usuario, sirve para todos tus proyectos); si no, edita `~/.claude.json` (con copia `.claude.json.venus-backup`).
2. Abrí una sesión nueva de Claude Code y escribí `/mcp` para ver a **venus-launcher**. También podés revisarlo con `claude mcp list` (tiene que decir "Connected").

Comando exacto (el panel lo muestra con tus rutas para copiarlo):

```bash
claude mcp add venus-launcher -s user -e ELECTRON_RUN_AS_NODE=1 -- "C:\Users\<vos>\AppData\Local\Programs\Venus Launcher\Venus Launcher.exe" "C:\Users\<vos>\AppData\Roaming\.venuslauncher\mcp\venus-mcp-bridge.js"
```

### ChatGPT y claude.ai (por la web)

Las versiones web (y las apps de ChatGPT) se conectan desde internet, así que necesitan una **URL pública**. Venus la crea con un **túnel rápido de Cloudflare** solo cuando lo pedís:

1. En la tarjeta **ChatGPT y claude.ai** tocá **Crear URL pública** y confirmá el aviso. La primera vez se descarga `cloudflared` desde los releases oficiales de Cloudflare en GitHub (unos 55 MB) y se verifica antes de usarlo.
2. Copiá la **URL del conector** (`https://<algo>.trycloudflare.com/mcp/<secreto>`).
3. **ChatGPT**: entrá a **chatgpt.com/plugins**, tocá **+** y elegí **Add custom MCP server**; pegá la URL del conector en **Server URL**, elegí **No authentication** y tocá **Create as a plugin**. Instalá el plugin y, en un chat, escribí **@** y elegí Venus Launcher. (La app de escritorio de ChatGPT con Codex también admite servidores locales en `~/.codex/config.toml`, con el mismo comando del puente que Claude Code.)
4. **claude.ai**: Configuración → Conectores → **Agregar conector personalizado**: nombre "Venus Launcher" y la URL. En un chat activalo desde el menú de herramientas.

El túnel se corta al cerrar el launcher (o con **Detener túnel**) y **la URL cambia cada vez que lo creás**: si la cargaste antes, actualizala en ChatGPT o claude.ai. **Cualquiera que tenga esa URL puede controlar el launcher mientras esté abierto**: no la compartas; si se filtró, tocá **Regenerar secreto**.

### Otras apps MCP

Cualquier cliente MCP local puede usar el mismo puente stdio (comando de arriba) o la URL local `http://127.0.0.1:18765/mcp/<secreto>` (Streamable HTTP). La URL local completa está en el panel (con el ojo para mostrar el secreto y **Copiar URL**).

## 3. Qué puede hacer la IA

Las herramientas son **exactamente las del Asistente IA** (mismos nombres, descripciones, esquemas, validaciones y niveles de permiso de `src/main/modules/assistant/permissions.json`; ver [asistente-ia.md](asistente-ia.md)), más dos propias:

| Nivel | Comportamiento | Herramientas |
|---|---|---|
| **Lectura** | Se ejecuta sin preguntar. | `list_instances`, `get_instance_info`, `list_mods`, `get_system_specs`, `run_benchmark`, `search_mods`, `search_resource_packs`, `search_shaders`, `get_mod_versions`, `check_compatibility`, `read_crash_summary`, `list_servers`, `get_server_info`, `read_server_console`, `get_server_properties`, `list_server_plugins`, `search_server_plugins`, `list_server_backups`, `recommend_ram`, `list_snapshots`, `list_worlds`, `launcher_status` |
| **Reversible** | Antes se guarda una instantánea de la instancia; el launcher muestra un aviso con **Deshacer**. | `create_instance`, `install_mod`, `install_resource_pack`, `install_shader`, `update_mod`, `toggle_mod`, `set_ram`, `set_option`, `set_java_version`, `set_jvm_args`, `change_instance_version`, `create_server`, `start_server`, `stop_server`, `restart_server`, `send_server_command`, `set_server_property`, `set_server_ram`, `install_server_plugin`, `update_server_plugin`, `replace_server_plugin`, `toggle_server_plugin`, `backup_server_world`, `duplicate_instance`, `rename_instance`, `create_snapshot`, `backup_world`, `undo_last_action` |
| **Destructiva** | Espera tu confirmación en la ventana de Venus Launcher. | `remove_mod` (el archivo va a la papelera), `remove_server_plugin`, `restore_server_backup`, `restore_snapshot`, `whitelist_add`, `whitelist_remove`, `op_player` |

- `launcher_status`: versión e idioma del launcher, si hay cuenta de Venus iniciada (sin el nombre de usuario) y el plan, la instancia elegida, las instancias con el juego abierto y cuántos cambios hechos por MCP se pueden deshacer.
- `undo_last_action`: deshace el último cambio hecho por MCP (o uno puntual con el `undo_id` que devuelven las herramientas de cambios). Solo deshace cambios hechos desde Claude o ChatGPT. La excepción es deshacer la **creación de una instancia o de un servidor**: la manda entera a la papelera (el servidor, solo si todavía no tiene mundo), con lo que se le cambió después (también desde el Asistente o a mano), así que primero pide tu confirmación en el launcher.

Las herramientas de **servidores locales** (crear, iniciar, apagar, consola, `server.properties`, RAM, plugins y mods, copias del mundo, lista blanca y operadores), `recommend_ram`, instantáneas y mundos se describen en [asistente-ia.md](asistente-ia.md), sección 2. Lo más sensible pide confirmación en el launcher: crear un servidor (acepta el EULA de Minecraft), apagar con jugadores, comandos de consola que no sean `list`/`tps`/`help`/`seed` (con aviso especial para `op`, `deop`, `ban`, `pardon`, `whitelist off` y `stop`), restaurar copias, quitar plugins y las listas de jugadores.

Lo que **no** puede hacer (no existe ninguna herramienta para eso): tocar tu cuenta de Microsoft o de Venus, tokens, contraseñas o pagos; borrar mundos; ejecutar comandos del sistema, scripts o `.jar` (solo escribe comandos de la consola de Minecraft en un servidor encendido); bajar archivos de otro lado que no sea Modrinth o CurseForge; leer o escribir fuera de la carpeta de cada instancia o servidor.

## 4. Confirmaciones y Deshacer

- **Acciones destructivas** (sacar un mod, deshacer la creación de una instancia) y **cambios riesgosos** (cambiar la versión o el loader de una instancia que tiene mundos; el aviso dice que Deshacer no recupera los mundos) abren un diálogo **en la ventana de Venus Launcher**, en cualquier pantalla, con **Cancelar** y el botón de la acción (por ejemplo **Sacar mod**; **Confirmar** si la acción no trae uno propio). Si la ventana estaba minimizada o en segundo plano, titila en la barra de tareas y aparece una notificación. **Si no contestás en 50 segundos, se cancela** (nunca se aprueba solo) y la IA recibe que no se hizo nada.
- **Instalación masiva**: si la IA instala **4 o más** cosas en una instancia que ya tenías (dentro de 15 minutos), se pide una sola confirmación con la lista. En instancias que creó la propia IA no se pide.
- **Deshacer**: cada cambio muestra un aviso "Claude Desktop hizo un cambio" con **Deshacer** y queda en **Actividad MCP** con su botón. Deshacer revierte exactamente ese cambio (el mismo diario de Deshacer del Asistente, `data/assistant/undo.json`, últimas 300 acciones por 30 días).
- La primera vez que la IA cambia una instancia que ya existía, además se guarda una instantánea completa de su configuración (módulo de instantáneas, sin mundos).
- Los cambios van **de a uno** aunque la IA pida varios a la vez, y fallan si el juego de esa instancia está abierto.

**Actividad MCP** (abajo del panel) muestra las últimas 200 acciones con la app que las pidió, el resultado, los errores y los rechazos. Se guarda solo en tu PC (`<datos>/mcp/activity.json`) y se puede limpiar.

## 5. Seguridad

| Medida | Detalle |
|---|---|
| Solo en tu PC | El servidor escucha únicamente en `127.0.0.1` (puerto 18765 por defecto, se cambia en **Opciones avanzadas**; si está ocupado prueba los 9 siguientes) y solo mientras el launcher está abierto y el interruptor prendido. |
| Secreto | La URL lleva un secreto aleatorio de 32 bytes (`/mcp/<secreto>`), guardado cifrado en el almacén seguro del launcher (`mcp.secret`) y comparado en tiempo constante. Una ruta o un secreto equivocados responden 404 sin pistas. **Regenerar secreto** lo cambia al instante. |
| DNS rebinding | Se rechaza (403) cualquier pedido con un encabezado `Host` que no sea `127.0.0.1`/`localhost` con el puerto propio (o el del túnel activo) y cualquier `Origin` que no sea local, el del túnel, `claude.ai` o `chatgpt.com`. |
| Puente stdio | `bridge.json` (puerto y secreto) queda en `<datos>/mcp/`, una carpeta privada del usuario (permisos 0700/0600 en macOS y Linux; en Windows, solo tu usuario con `icacls`). Al cerrar el launcher se borra el secreto del archivo. El puente verifica que el proceso del launcher siga vivo antes de conectarse. |
| Pedidos | Solo `POST` con JSON de hasta 1 MB; sin sesiones; máximo 120 herramientas por minuto (30 de cambios). |
| Herramientas | Las mismas guardas del Asistente (ids de instancia exactos, archivos "pelados" dentro de `mods/`, `resourcepacks/` o `shaderpacks/`, descargas solo de Modrinth/CurseForge con hash, listas blancas de opciones y de argumentos de Java). Todo resultado pasa por la anonimización del Asistente (carpeta del usuario, nombres de jugador, emails, tokens, IPs). |
| Túnel | Solo con tu confirmación, con `cloudflared` oficial verificado (tamaño y SHA-256 del release de GitHub) y sin tu configuración de Cloudflare. Mientras está activo, cualquiera con la URL puede usar las herramientas (por eso lleva el secreto y conviene detenerlo cuando no lo uses). |
| Plan | Sin plan pago no se ofrecen herramientas (control del lado del launcher, ver la nota de la sección 1). |

Las acciones destructivas siempre necesitan tu clic en el launcher: ni Claude ni ChatGPT pueden aprobarlas.

## 6. Solución de problemas

| Problema | Qué hacer |
|---|---|
| Claude Desktop no muestra a Venus | Cerralo del todo (también desde la bandeja) y abrilo de nuevo. Revisá que la tarjeta diga **Conectado**. El registro de Claude está en `%APPDATA%\Claude\logs\mcp-server-venus-launcher.log` (macOS: `~/Library/Logs/Claude/`). |
| "Venus Launcher no está abierto" | Abrí el launcher. Claude sigue viendo las herramientas (las guarda el puente), pero solo funcionan con el launcher abierto. |
| "La conexión con Claude y ChatGPT está apagada" | Prendé el interruptor del panel. |
| "Necesitás un plan de Venus IA (Go o superior)…" | Iniciá sesión en Ajustes → Cuenta y nube y elegí un plan (**Mejorar plan** en el panel). Si ya pagaste, tocá **Reintentar** o esperá unos segundos: el panel revisa el plan solo. |
| "No se pudo abrir el puerto…" | Otra app usa ese puerto: elegí otro en **Opciones avanzadas**. Claude Desktop y Claude Code siguen andando solos (el puente lee el puerto nuevo). |
| "El archivo de configuración no es JSON válido" | Venus no toca un archivo que no entiende. Arreglalo (o restaurá la copia `.venus-backup`) y volvé a tocar **Conectar**. |
| Claude Code: no se encontró `claude` | Venus edita `~/.claude.json` igual. Si Claude Code estaba abierto, reinicialo. Si preferís, copiá el comando de **Configuración manual**. |
| Tarjeta en **Hay que reparar** | El launcher o la carpeta de datos cambiaron de lugar: tocá **Reparar** (la versión instalada lo repara sola al abrirse). |
| Versión portable | La ruta del ejecutable puede cambiar en cada inicio: al abrirse, el launcher actualiza solo la entrada de Claude. Si Claude no encuentra a Venus, abrí el launcher y después reiniciá Claude (o tocá **Reparar**). |
| El túnel no arranca | "Cloudflare está limitando": esperá unos minutos. "No se pudo abrir cloudflared": revisá que el antivirus no lo bloquee. Sin internet o con un proxy que bloquea Cloudflare, el túnel no funciona. |
| ChatGPT o claude.ai dejaron de conectarse | El túnel se corta al cerrar el launcher y la URL cambia cada vez: creá uno nuevo y actualizá la URL del conector. Si regeneraste el secreto, también. |
| La IA dice que una instalación "tardó demasiado" | Algunas apps cortan una herramienta a los 60 segundos. La instalación sigue en el launcher (panel de tareas) y queda en Actividad MCP: preguntale de nuevo para que lo verifique. |
| No aparece el diálogo de confirmación | Mirá la ventana de Venus Launcher (puede estar detrás de Claude). Si pasan 50 segundos se cancela y la IA puede volver a intentarlo. |

## 7. Desactivar o desconectar

- **Interruptor apagado**: cierra el servidor local y el túnel; Claude ve a Venus pero sin poder usarlo.
- **Desconectar** (en cada tarjeta): saca **solo** la entrada `venus-launcher` de la configuración de esa app (con copia `.venus-backup` antes de escribir).
- **Regenerar secreto**: invalida cualquier URL anterior (local y del túnel).

## 8. Privacidad

Las herramientas corren en tu PC. Lo que la IA recibe son los resultados de las herramientas, anonimizados igual que en el Asistente (ver [asistente-ia.md](asistente-ia.md), sección 6), y viajan a Anthropic u OpenAI según la app que uses, con sus propias políticas de privacidad. De tu cuenta de Venus, `launcher_status` solo dice si hay sesión y el plan: nunca el nombre de usuario ni el email. Venus no manda nada de esto a su backend: solo consulta tu plan.

## 9. Para desarrolladores

### Archivos

| Archivo | Qué hace |
|---|---|
| `src/main/modules/mcp.js` | Módulo (se autocarga): canales IPC, arranque, plan, archivos del puente, registro en clientes, túnel y cierre. |
| `mcp/protocol.js` | JSON-RPC 2.0 + MCP "de las dos eras" (sin dependencias): moderna `2026-07-28` (sin handshake, `_meta` por pedido, `server/discover`, `resultType` y las pistas de caché `ttlMs`/`cacheScope`, obligatorias en `server/discover` y en las listas: sin ellas Claude Code 2.1.286 descarta el resultado y se queda sin herramientas) y heredada `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05` (`initialize`). Sin sesiones. |
| `mcp/http-server.js` | Streamable HTTP en `127.0.0.1`: Host/Origin, secreto, solo `POST`, JSON o SSE con progreso (`progressToken`, solo local: el túnel rápido de Cloudflare no admite SSE), cancelación al cortarse la conexión o con `notifications/cancelled`. |
| `mcp/executor.js` | Envuelve las herramientas del asistente (`assistant/tools.js`, `tool-defs.js`, `config.js` + `permissions.json`, `guards.validate`, `undo.js`, `redact.js`, `agent.undoAction`/`BULK_LIMIT`): mismo orden que `agent.runOne`, cola de cambios, guarda de instalación masiva, `launcher_status` y `undo_last_action`. |
| `mcp/gate.js` | Plan: `ai.status().quota` (o `billing.state()` si la IA está apagada en Ajustes), cache de 72 h de la última verificación de la misma cuenta. |
| `mcp/approvals.js` | Confirmaciones con vencimiento (50 s) y diálogo nativo de respaldo si la interfaz todavía no escucha. |
| `mcp/activity.js` | Registro de las últimas 200 acciones. |
| `mcp/installers.js` | Claude Desktop y Claude Code (CLI o archivo), copias `.venus-backup`, idempotente. |
| `mcp/tunnel.js` | `cloudflared` (release oficial de GitHub verificado) + túnel rápido. |
| `mcp/bridge.js` | Puente stdio ↔ HTTP, autónomo (solo módulos de Node). Se copia a `<datos>/mcp/venus-mcp-bridge.js`. |
| `mcp/files.js` | Escrituras privadas y atómicas de `bridge.json`/`tools.json`, carpeta privada y copia del puente. |
| `mcp/client.js` | **Cliente** MCP (el camino inverso: el Asistente IA usando servidores MCP que agregó el usuario): stdio sin shell y Streamable HTTP, era moderna y heredada, plazos y cancelación. Lo usa `assistant/mcp-servers.js`; ver [asistente-ia.md](asistente-ia.md), sección 10. `planState()` de `mcp.js` le presta el control de plan. |
| `src/renderer/js/features/mcp.js` (+ `styles/features/mcp.css`) | `mcpPanel()` (Ajustes) y `startup()` (confirmaciones y avisos con Deshacer en cualquier pantalla). |

### Puente stdio: el comando exacto

Los clientes lanzan el puente con **el propio ejecutable del launcher en modo Node** (no hace falta Node instalado) y el script copiado **afuera del `.asar`**:

```text
command: <process.execPath del launcher>      (instalado: ...\Venus Launcher.exe · desarrollo: node_modules\electron\dist\electron.exe)
args:    ["<datos>/mcp/venus-mcp-bridge.js"]   (<datos> = %APPDATA%\.venuslauncher, VENUS_DATA_DIR o la carpeta elegida)
env:     { "ELECTRON_RUN_AS_NODE": "1" }
```

Probarlo a mano (PowerShell):

```powershell
$env:ELECTRON_RUN_AS_NODE = "1"
'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"prueba","version":"1"}}}' | & "C:\...\Venus Launcher.exe" "$env:APPDATA\.venuslauncher\mcp\venus-mcp-bridge.js"
```

El puente lee `bridge.json` (`{ pid, running, enabled, port, secret, lang }`) en cada pedido, así que sigue funcionando si cambian el puerto o el secreto. Con el launcher cerrado contesta solo (`initialize`, la última lista de herramientas de `tools.json` y, al usar una, "Abrí Venus Launcher"), y avisa con `notifications/tools/list_changed` cuando cambia la lista. Al iniciar, la app instalada actualiza las entradas `venus-launcher` que ya existían si cambió la ruta del ejecutable o de los datos (nunca agrega una nueva).

### Canales IPC y eventos

| Canal | Qué hace |
|---|---|
| `mcp:status({ refresh?: true \| 'quota' \| 'billing' \| 'auth', ui?: true })` | Estado completo (abajo). `refresh` revisa el plan (`'quota'` sin red); `ui: true` registra la interfaz para mostrar confirmaciones. |
| `mcp:setEnabled(bool)` | Prende o apaga el servidor (prender exige plan: `err.code = 'plan'`). |
| `mcp:setPort(número)` | Puerto local (1024-65535; `'port'`). |
| `mcp:installClaudeDesktop()` / `mcp:uninstallClaudeDesktop()` / `mcp:installClaudeCode()` / `mcp:uninstallClaudeCode()` | `{ result: { status: 'added' \| 'updated' \| 'already' \| 'removed' \| 'absent' \| 'notInstalled', method?, results? }, status }`. Conectar exige plan (`'plan'`) y prende el servidor. Errores de archivo: `'config'`. |
| `mcp:tunnelStart({ confirmed: true })` / `mcp:tunnelStop()` | Túnel (`'confirm'` sin la confirmación, `'plan'`, `'tunnel'`). Devuelven el estado. |
| `mcp:regenerateSecret()` | Secreto nuevo. Devuelve el estado. |
| `mcp:activity()` / `mcp:clearActivity()` | Actividad (la más nueva primero). |
| `mcp:approve(requestId, ok)` | Contesta una confirmación. |
| `mcp:undo(undoId)` | Deshace un cambio hecho por MCP (`agent.undoAction`). |

Eventos: `mcp:status` (estado completo), `mcp:activity` (entrada nueva o cambiada, o `{ cleared: true }`), `mcp:approval` (`{ requestId, state: 'pending', tool, kind, title, message, items, okText, danger, client, source, createdAt, expiresAt }` y después `{ requestId, state: 'approved' | 'denied' | 'expired' | 'cancelled' }`).

Estado (`mcp:status`): `{ available, enabled, port, server: { running, port, error: 'busy' | 'start' | null, localUrl }, plan: { entitled, reason: 'ok' | 'checking' | 'noCloud' | 'signedOut' | 'noPlan' | 'freePlan' | 'offline' | 'error', plan, planName, status, source: 'quota' | 'billing' | 'cache', checkedAt, checking }, clients: { claudeDesktop: { installed, registered, outdated, error, configPath, files }, claudeCode: { installed, registered, outdated, error, configPath, cli }, chatgpt: { installed, path, registered, lastSeen } }, tunnel: { state: 'stopped' | 'downloading' | 'starting' | 'running' | 'error', url, host, connectorUrl, progress, error, detail, version, startedAt }, bridge: { command, args, env, script, codeCommand, desktopSnippet }, connections: [{ name, source, era, version, lastSeen }], approvals, tools: { count, names }, approvalTimeoutSec, portable, dataDir }`.

Entrada de actividad: `{ id, at, kind: 'tool' | 'connect' | 'blocked', tool, toolTitle, level, client, source: 'local' | 'remote', state: 'running' | 'pending' | 'ok' | 'error' | 'denied' | 'undone' | 'interrupted', summary, error, warnings, undoId, noChange, input, durationMs }`.

### Ajustes, secretos y archivos

- Ajustes: `mcp: { enabled (false), port (18765), clients: { claudeCode: { registered, method, at } }, offer: { answered: 'connect' | 'later', app, at } }` (`offer`: respuesta al aviso único de la tarjeta del Asistente).
- Secretos (`core/secure`): `mcp.secret` (32 bytes, base64url) y `mcp.entitlement` (última verificación del plan: `{ userId, plan, planName, status, at }`).
- `<datos>/mcp/`: `bridge.json`, `tools.json`, `venus-mcp-bridge.js`, `activity.json`, `.private`, `bin/cloudflared(.exe)` + `bin/cloudflared.json` (`{ tag, asset, sha256, size, binSha256, binSize }`).
- Las acciones reversibles usan el diario del asistente (`data/assistant/undo.json`, `.venus/assistant-undo/<id>/`) con `toolUseId = 'mcp_<id de actividad>'`.

### Integración pendiente (archivos compartidos)

- `src/renderer/js/app.js`: sumar `() => import('./features/mcp.js')` a `STARTUP` (confirmaciones y avisos con Deshacer en cualquier pantalla; reenvía `billing:changed`, `ai:quota` y los cambios de sesión). Sin esto, las confirmaciones usan el diálogo nativo de respaldo y el plan se revisa solo cada minuto (cuota vista por la IA y sesión) y cada 10 minutos.
- Ajustes → Inteligencia artificial: embeber `mcpPanel()` (por ejemplo con `embedPanel(host, { load: () => import('../../features/mcp.js'), fn: 'mcpPanel', ns: ['mcp'] }, ctx)` y el ancla `ai/mcp`).

### Pruebas

```bash
node --test "src/main/modules/mcp/test/*.test.js"
```

Cubren la capa JSON-RPC/MCP (initialize, versiones, server/discover, tools/list con y sin plan, tools/call, errores con su código y estado HTTP, lotes, SSE), las herramientas sobre las reales del asistente en una carpeta temporal (lectura, reversible + Deshacer, destructiva aprobada/rechazada/vencida/cancelada, deshacer una creación solo con confirmación, cambio de loader con mundos, ids de instancia exactos, plan, instalación masiva, cola de cambios, anonimización y `launcher_status` sin el usuario de Venus), el plan, los instaladores contra copias temporales de las configuraciones (y un `claude.cmd` real en Windows), el túnel con un `cloudflared` falso y una prueba de punta a punta: el módulo registrado con un contexto falso de Electron, un cliente MCP crudo por HTTP (heredado y moderno, seguridad, confirmaciones, progreso, plan) y el puente lanzado con Electron en modo Node, también con el launcher cerrado. Además se verificó a mano con el CLI real de Claude Code (`claude mcp list` → "Connected") usando un `CLAUDE_CONFIG_DIR` temporal.

Capturas: `VENUS_MCP_FAKE_PLAN=pro` (o `none`) junto con `VENUS_DEVSHOT` simula un plan (nunca se activa sin `VENUS_DEVSHOT` ni en la app empaquetada).
