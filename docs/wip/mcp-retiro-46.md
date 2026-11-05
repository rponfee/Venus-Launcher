# Retiro del MCP (4.6)

El dueño pidió quitar el MCP de todos los planes y eligió **borrar el MCP entero** del launcher. Esta nota dice qué se borró, qué se conservó y qué queda en las PC de la gente.

## Qué se borró

- **Venus como servidor MCP** (Claude Desktop, Claude Code, ChatGPT, claude.ai): `src/main/modules/mcp.js` y toda `src/main/modules/mcp/` (puente stdio, servidor HTTP local, protocolo, ejecutor, aprobaciones, actividad, túnel de Cloudflare, instaladores en las apps, control de plan).
- **Servidores MCP del asistente** (el asistente como cliente MCP): `assistant/mcp-servers.js`, sus herramientas en `agent.js`, el aviso de confirmación con "Permitir siempre" y las tarjetas de herramienta MCP del chat.
- **Motores externos del asistente** (que tu Claude Code o tu Codex respondan desde la ventana de Venus): `assistant/engines.js` y su turno en `agent.js`. Eran un tercer uso del mismo servidor MCP (el CLI usaba las herramientas de Venus por MCP), así que sin MCP no pueden andar.
- Canales `mcp:*` (13) y `assistant:mcpServers`, `mcpSave`, `mcpRemove`, `mcpSetEnabled`, `mcpTest`, `mcpTools`, `mcpAllowAlways`, `mcpImportPreview`, `mcpImport`, `assistant:engines`, `assistant:setEngine` y el evento `assistant:engines`. El evento del chat `limits` y el campo `engine` de `assistant:send` ya no existen; `assistant:confirm` ya no recibe `{ always }`.
- Interfaz: `features/mcp.js`, `features/mcpservers.js`, `features/engines.js`, los estilos `mcp.css`, `mcpservers.css`, `engines.css`, la tarjeta de la página del Asistente, los paneles de Ajustes → IA (anclas `mcp`, `mcpservers`, `engines`), el selector "Responde" del chat, la entrada de `STARTUP` en `js/app.js` y el alias `mcp` de `settings.js`. Las rutas viejas `#/settings/ai/mcp` y `#/settings/ai/engines` no se rompen: abren Ajustes → IA sin ancla.
- Textos: `i18n/*/mcp.js` (main y renderer, 14 idiomas) y las claves `mcp*`, `canMcp`, `cannotDataMcp`, `permMcp`, `levelMcp*`, `engine*`, `eng*`, `confirmApprovedAlways` de `assistant.js` del renderer y `mcp*`, `errEngine*`, `engineMcpFailed` de `assistant.js` del main (14 idiomas). En `plans.js` (es y en) se sacó "la conexión con Claude y ChatGPT" y la mención del panel MCP.
- Web (`web/index.html`): las dos tarjetas del MCP y de los motores, y "MCP incluido" en los planes Go, Pro y Max.
- `docs/mcp.md`, su enlace en `docs/README.md` y las menciones del `README.md`.
- Conversaciones del asistente: se quitaron `engine` y `external` de `store.js`. Una conversación vieja hecha con un motor externo se abre igual (como Venus IA).

## Qué se conservó y por qué

- Las herramientas propias del asistente (`tools*.js`, permisos, Deshacer, `tool-defs.js`, `selftest-servers.js`, `servers-fixture.js`): son del asistente y se usan con Venus IA. Las "herramientas de servidores" son de servidores de Minecraft, no de MCP.
- **IA local del Buscador inteligente** (tu Claude Code o Codex, sin herramientas): usaba piezas de los motores y del MCP. Lo que necesita se juntó en **`src/main/modules/smartsearch/cli.js`** (buscar `claude` y `codex`, ver si tienen sesión, lanzarlos sin shell, leer su salida JSON, carpeta privada). `local-ai.js` y `smartsearch.js` apuntan ahí. Sigue pasando `--strict-mcp-config` al `claude` del usuario para que no cargue SUS servidores MCP.
- La condición "plan Go o superior" de la fuente local del buscador salía del control de plan del MCP (que en el código dejaba pasar también a Basic). Ahora sale del plan de `ai.status().quota`: cualquier plan de pago menos `basic` (`smartsearch.js`, `aiView`), como dicen los textos.
- La lista negra de ajustes `assistantMcp` y `mcp` en `portability/filter.js` queda: es defensiva para archivos exportados por versiones anteriores.
- `supabase/functions/ai-assistant` no se tocó (si recibe definiciones MCP, nunca las va a recibir). No hay nada de MCP en `supabase/migrations`.

## Lo que queda en las PC de las personas

Nada se borra solo. El launcher dejó:

- **Claude Desktop**: una entrada `venus-launcher` en `claude_desktop_config.json` (`%APPDATA%\Claude\`, y en la versión de la Microsoft Store `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\`), con copia `.venus-backup` al lado. Apunta a `venus-mcp-bridge.js`: ahora falla sin hacer nada.
- **Claude Code**: una entrada `venus-launcher` en `~/.claude.json` (o `$CLAUDE_CONFIG_DIR`), puesta con `claude mcp add -s user` o editando el archivo.
- **ChatGPT y Codex**: nunca se escribió nada (ChatGPT se conecta a mano con la URL del túnel; Codex recibía el servidor por `-c` en cada turno). Si alguien agregó la URL pública del túnel en ChatGPT o claude.ai, esa URL ya no responde.
- En la carpeta de datos del launcher: `mcp/` (`bridge.json`, `tools.json`, `venus-mcp-bridge.js`, `activity.json`, `bin/cloudflared`) y `assistant/engines/`. En el almacén cifrado: `mcp.secret`, `mcp.entitlement` y las claves de token y variables de cada servidor MCP del asistente. En `settings.json`: `mcp`, `assistantMcp` y `ai.engine`/`ai.engineChoice`.

Convenía limpiar esas entradas **al desinstalar** (un paso del desinstalador) o con un aviso de una sola vez al abrir la 4.6; esta tarea no lo hace.

## Pendiente fuera de esta tarea

- `package.json` tiene el fuse `runAsNode: true` solo por el puente MCP. Se puede apagar (y quitar `checkRunAsNode` y el chequeo del fuse en `scripts/smoke-packaged.js`). No se tocó.
- Otros documentos que todavía hablan del MCP o de los motores externos: `docs/arquitectura.md` (canales `mcp:*`, tabla de módulos), `docs/asistente-ia.md` (sección 11 y MCP del asistente), `docs/backend-ia.md`, `docs/funciones.md`, `docs/pagos.md`, `docs/implementacion/datos.md`.
- `plans.noPlanText` y la primera línea (comentario) de `plans.js` siguen nombrando "Claude y ChatGPT" en de, fr, it, ja, ko, nl, pl, pt, ru, tr, uk, zh.

## Pruebas

`node src/main/modules/assistant/selftest.js`: 54/56. Las 2 que fallan (`ai.js: status() con GET…` y `assistant:status (modo demostración)…`, de esfuerzos por plan) fallan igual en el commit `4bec89d` sin mis cambios. Además: `smartsearch/test` (146, verdes, con la prueba de la IA local actualizada a `cli.js`), `overlay/test`, `check.js`, `contracts-check.js` (0 sin handler) e `i18n-check.js en` (0 faltantes).
