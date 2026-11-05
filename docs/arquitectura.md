# Venus Launcher · Arquitectura y reglas para desarrollar

> **Documento vivo para desarrolladores.** Describe cómo está armado el launcher hoy: estructura, canales IPC, contratos entre módulos, rutas, ajustes y archivos de datos. Si cambiás algo de lo que figura acá (un canal, un export, una ruta, una clave de ajustes o un archivo de datos), actualizá este documento en el mismo cambio. Guía para usuarios: [funciones.md](funciones.md) · Índice de la documentación: [README.md](README.md).

Launcher de Minecraft hecho con **Electron 44 + JavaScript sin frameworks ni build** (Node 24 en el proceso principal, módulos ES en la interfaz). Todo el texto de la interfaz está en **español rioplatense con voseo** ("Creá", "Elegí", "Jugá") y se traduce a 14 idiomas.

## 1. Mapa del proyecto

```
src/main/                     Proceso principal (CommonJS)
  main.js                     Ventana, permisos, ciclo de vida, salida ordenada        [compartido]
  ipc.js                      Canales del núcleo + registro de módulos                [compartido]
  preload.js                  Puente seguro: window.venus.invoke/on + API vieja       [compartido]
  modules-loader.js           Autocarga de src/main/modules/*.js                      [compartido]
  core/                       Núcleo: paths, util, settings, secure, i18n, nbt, tasks, game, http,
                              minecraft, instances, launch, java, rules, modrinth, search-filters, servers,
                              server-properties, accounts, stats, cloud-defaults, app-config, loaders/
  modules/<modulo>.js         Un archivo por función (se autocarga). Auxiliares en modules/<modulo>/...
  i18n/<idioma>/<ns>.js       Textos del proceso principal (module.exports = { clave: 'texto' })
src/renderer/                 Interfaz (módulos ES, sin bundler)
  index.html                                                                          [compartido]
  js/app.js                   Shell: menú, router, cuentas, tareas, eventos globales  [compartido]
  js/store.js                 Estado compartido (store) y api = window.venus          [compartido]
  js/ui.js                    h(), icon(), modal, toast, formatos, ensureCss...       [compartido]
  js/i18n.js                  t(), loadNs(), idiomas                                  [compartido]
  js/cloud.js                 Cliente de Supabase + cuenta de Venus                   [compartido]
  js/social.js (+ social/)    Amigos, presencia, mensajes y señales (Supabase)
  js/voice.js (+ voice/)      Motor del Voice Chat (WebRTC + Supabase Realtime)
  js/a11y.js (+ a11y/)        Accesibilidad, paleta de comandos (Ctrl+K) y navegación con control
  js/appearance.js            Tema, fondo, música de fondo y marca propia
  js/pages/<pagina>.js        Una página por ruta (#/<pagina>/<params>). Auxiliares en pages/<pagina>/
  js/features/<funcion>.js    Diálogos y paneles reutilizables (contratos de la sección 6)
  styles/main.css             Sistema de diseño                                       [compartido]
  styles/a11y.css             Estilos de accesibilidad y apariencia
  styles/pages/<pagina>.css   Estilos de cada página
  styles/features/<f>.css     Estilos de cada feature
  i18n/<idioma>/<ns>.js       Textos de la interfaz (export default { clave: 'texto' })
  vendor/                     Librerías empaquetadas (supabase-js)
supabase/migrations/NNNN_<modulo>.sql   Esquema de la base (aplicar en orden; ver docs/supabase.md)
supabase/functions/ai-assistant/        Edge Function de la IA (ver docs/backend-ia.md)
supabase/functions/billing/, stripe-webhook/   Pagos de Venus IA con Stripe (ver docs/pagos.md)
supabase/functions/admin/               Panel de administración (ver docs/admin.md)
src/renderer/overlay.html     Overlay del juego (ventana transparente; preload propio de modules/overlay/)
src/renderer/recorder.html    Grabadora oculta de clips (preload propio de modules/capture/)
mod/venus-badge/              Mod de la insignia de Venus para Fabric, NeoForge y Forge (Gradle; ver docs/insignia.md)
scripts/check.js              Chequeo de sintaxis de todo el proyecto
scripts/i18n-check.js         Traducciones contra el español (claves y {variables})
scripts/contracts-check.js    Canales que usa la interfaz contra los que registra el proceso principal
scripts/devshot.js            Capturas automáticas de páginas + consola
docs/                         Documentación (índice en docs/README.md)
design-system/venus-launcher/MASTER.md  Sistema de diseño (tokens, componentes y checklist visual)
```

**Archivos compartidos** (`[compartido]`): no son de ningún módulo. Se tocan solo para integrar y cuidando que siga andando todo lo que los usa. Si tu módulo necesita algo de ellos, resolvelo primero desde tus archivos (por ejemplo `registerIcons`, tu propio namespace de textos, tu propia clave de ajustes) y anotá el pedido para quien integra.

## 2. Proceso principal

### Módulos (`src/main/modules/<modulo>.js`)

```js
'use strict';
const { t } = require('../core/i18n');
const settings = require('../core/settings');

function register({ app, handle, send, getWindow, safePath, onQuit }) {
  handle('mimodulo:hacerAlgo', async (arg) => { ... return datos; }); // throw new Error(t('mimodulo.errX')) para errores
  send('mimodulo:evento', datos);                                        // evento hacia la interfaz
  onQuit(async () => { ... });                                           // limpieza al cerrar (máx. 4 s)
}
module.exports = { register /*, funciones para otros módulos */ };
```

- Se carga solo: no hay que tocar `ipc.js` ni `main.js`. `preReady({ app })` (opcional) corre antes de `app.whenReady` (por ejemplo `protocol.registerSchemesAsPrivileged`). Electron respeta **una sola** llamada a `registerSchemesAsPrivileged`: hoy la usa solo `modules/extensions.js` (esquema `venus-ext`).
- Canales: `"<modulo>:<accion>"` en camelCase. El handler devuelve datos o lanza un `Error` con mensaje traducido (la interfaz lo muestra tal cual). Si la interfaz tiene que distinguir el tipo de error, agregale `err.code` (ver 6.7).
- Para usar otro módulo desde el proceso principal: `require('./otro')` y llamar a sus funciones exportadas (sección 6.4), siempre tolerando que falte o falle.
- No requerir `electron` en el nivel superior si el archivo tiene lógica que se quiera probar con Node puro: hacerlo dentro de las funciones.

### Núcleo disponible

| Módulo | Para qué |
|---|---|
| `core/paths` | `root()`, `data('x.json')`, `cache(...)`, `instance(id)`, `instances()`, `server(id)`, `servers()`, `versions()`, `versionDir/versionJson/versionJar(id)`, `libraries()`, `assets()`, `runtime()`, `natives(id)`, `logs()`. Carpetas nuevas: `path.join(paths.root(), '<modulo>')` |
| `core/util` | `readJson` (reintenta si el archivo está ocupado), `writeJson` (atómico, en orden por archivo y con fsync; si el archivo no se pudo leer, antes lo guarda como `<archivo>.corrupt-<fecha>`), `exists`, `fileSize`, `hashFile(p, 'sha1')`, `uid`, `offlineUUID`, `sanitizeFileName`, `rmrf`, `dirSize`, `sleep`, `compareSemver`, `compareNumeric` |
| `core/settings` | `get()`, `set(patch)` (merge profundo), `onChange(fn)`, `recommendedMemory()`. **Cada módulo usa su propia clave**: `(await settings.get()).discord ?? {}` con sus valores por defecto (claves en 7.2) |
| `core/cipher` | `createCipher(safeStorage)` → `{ encrypt, decrypt }` para `core/secure` y `core/accounts`: un secreto nunca se escribe sin cifrar. Sin almacén del sistema queda solo en memoria (`mem:<id>`) y hay que volver a iniciar sesión al reabrir |
| `core/secure` | Secretos cifrados (DPAPI/Keychain): `get(k)`, `set(k, v)`, `remove(k)`, `has(k)`. Clave = `"<modulo>.<nombre>"`. La interfaz solo llega a las claves `ui:*` (canales `secure:get/set/remove`) |
| `core/i18n` | `t('ns.clave', vars)` con el idioma elegido |
| `core/tasks` | `tasks.run(titulo, async (task) => { task.update({ title, detail, progress }); task.signal }, meta)` → aparece en el panel de tareas con barra y botón de cancelar. `new tasks.Task(titulo, meta)` para manejarla a mano. Qué poner en `meta`: 6.7 |
| `core/http` | `getJson(url, { cacheFile, cacheMaxAge, signal })`, `getText`, `getBuffer`, `request`, `download(item, { onBytes, verify, signal })`, `downloadAll(items, { concurrency, onProgress, verify, signal })`. Descargas en `<archivo>.part` que se retoman (Range/If-Range), se verifican y se renombran de forma atómica. Control global: `configure({ maxKBps, concurrency, offline })`, `getConfig`, `pause`, `resume`, `isPaused`, `isOffline`, `isLocalUrl`, `stats()`, `events` (`'stats'`). El límite de velocidad y el modo sin conexión solo afectan lo que pasa por este módulo |
| `core/nbt` | `read(buffer)`, `readFile(ruta)`, `readTyped`, `write(raiz, { gzip })`, builders `T.*` (level.dat, servers.dat, playerdata, chunks) |
| `core/game` | `events`: `'state'` (id, { state, ... }), `'log'` (id, líneas), `'session'` (fin de partida), `'activity'` (id, actividad), `'warnings'`; `start`, `stop`, `status()`, `logs(id)`, `activity(id)`, `pids()`, `addBeforeLaunch(fn)`. Partidas silenciosas: 6.7 |
| `core/instances` | `list`, `get`, `create`, `update` (escrituras en serie por instancia), `remove`, `dir(id)`, `contentDir`, `prepare` (arranque rápido con `.venus/prepared.json`), `readPrepared`, `clearPrepared`, `preparedFresh`, `installProject`, `content`, `toggleFile`, `deleteFile`, `addFiles`, `duplicate`, `LOADER_KINDS`, `LOADER_NAMES` |
| `core/minecraft` | `getManifest`, `getVersionJson`, `resolveVersion`, `resolveVersionLocal` (solo disco), `installVersion`, `installAssets`, `quickVerify`, `mergeChain`, `validVersionId`, `listInstalledVersions`... |
| `core/search-filters` | Filtros extra de la búsqueda de contenido (Modrinth, CurseForge y Buscador inteligente), sin Electron: `normalize(params)` → `{ phrase, exclude[], author, authorInvalid, minDownloads, updatedDays, openSource, environment }`, `modrinthFacets(f)` (autor, `downloads>=`, `modified_timestamp>=`, `open_source` y `environment`: lo que la API de Modrinth sí admite, verificado en docs.modrinth.com), `matcher(f, { source })` y `needsClient(f, source)` (frase exacta y palabras excluidas, que ninguna API admite; en CurseForge además autor, descargas, fecha y código fuente), `apiQuery`, `splitTerms`, `normalizeText` y `collect({ fetchPage, offset, limit, rawSize, accept, stop, reachable })` (junta resultados pidiendo páginas de la API alineadas a `rawSize` hasta llenar la pedida; devuelve `{ hits, next, exhausted, capped, total, scanned, requests }`) |
| `core/modrinth` | `search` (facetas, `gameVersions[]`, `environment`, `license`, `openSource`, `author`, `minDownloads`, `updatedDays`, `phrase`, `exclude`; devuelve además `next_offset`, `exhausted` y `filtered`), `buildFacets`, `getProject(s)`, `getVersions`, `getVersion`, `getVersionsByIds`, `getTeam`, `getMembers`, `getOrganization`, `getDependencies`, `getTags`, `resolveInstall`, `executePlan`, `identify`, `checkUpdates`, `listFolder`, `readMrpack`, `installPackContents`, `folderFor`, `modLoadersFor`, `shaderLoadersFor`, `api`, `rateLimit`... |
| `core/java` | `ensureRuntime`, `findJava`, `getJavaVersion`, `listInstalledRuntimes`, `detectSystemJava`, `checkJavaFor`, `majorForMinecraft`, `compatibleMajors`, `MAJOR_COMPONENT` (Java 8, 16, 17, 21 y 25 de Mojang, con Adoptium de respaldo) |
| `core/launch` | `buildCommand`, `spawnGame`, `LogParser`, `gcArgs`, `sanitizeForJava`, `AIKAR_FLAGS`, `VANILLA_G1` |
| `core/servers` | Servidores locales (13 tipos): `list`, `get`, `create`, `update` (solo name, port, memory, flags, java, automation, proxy, notes, loaderVersion) y `patchMeta`, `install`, `start`, `stop`, `kill`, `restart`, `command`, `logs`, `readProperties`, `writeProperties`, `installProject`, `content`, `versions(type, { snapshots })`, `loaderVersions`, `suggestPort`, `types`, `typeInfo`, `isProxy`, `dir`, `events` (`'log'`, `'state'`, `'player'`) |
| `core/server-properties` | Esquema de las propiedades vanilla (`SCHEMA`, `schemaFor(mcVersion)`), lector y escritor que respetan comentarios, orden y escapes |
| `core/stats` | `recordSession`, `annotateSession`, `countFailedLaunch`, `get`, `reset`, `summary`, `report`, `events`, `MILESTONES` |
| `core/accounts` | `list` (con `needsLogin`), `select`, `remove`, `addOffline`, `loginMicrosoft`, `getLaunchAccount(id?)` (incluye `xuid`), `refreshAccount`. Cliente de Microsoft por cuenta (`msClient`): [login-microsoft.md](login-microsoft.md) |
| `core/cloud-defaults` | Proyecto de Supabase del launcher, fijo al compilar: `config()` → `{ url, anonKey, configured }` (lo que usan todos los módulos y la interfaz por `cloud:config`). Un proyecto guardado en los ajustes por versiones anteriores (`settings.cloud`) se ignora. Solo en desarrollo (sin empaquetar): `VENUS_SUPABASE_URL` + `VENUS_SUPABASE_ANON_KEY` |
| `core/app-config` | Claves y servidores de servicios externos que **completa el dueño antes de compilar** (los usuarios no ven ni cargan claves): `get()` → `{ curseforgeApiKey, msClientId, discordClientId, turn: { urls, username, credential }, bore: { host, secret } }` normalizado; la clave de CurseForge entra al compilar por `build-config.json` (`scripts/write-build-config.js`, no se sube); un valor vacío apaga Discord Rich Presence/TURN o usa bore.pub; CurseForge usa la configuración central de Administración y conserva la clave compilada como respaldo. Solo en desarrollo (`devEnv()`: sin empaquetar) se pisan con `VENUS_CURSEFORGE_API_KEY`, `VENUS_DISCORD_CLIENT_ID`, `VENUS_TURN_URLS` (separadas por coma), `VENUS_TURN_USERNAME`, `VENUS_TURN_CREDENTIAL`, `VENUS_BORE_HOST` y `VENUS_BORE_SECRET`. Todo lo de acá se puede extraer del instalador: nunca claves secretas de servidores (Stripe, `service_role`, Anthropic, OpenAI), que viven en las Edge Functions |
| `modules/ai` | IA (Claude) siempre por el backend del launcher: Edge Function `ai-assistant`, con la cuenta de Venus y un plan pago (sin plan no hay IA; respaldo en OpenAI). `available()`, `provider()` (`'backend'` o `null`), `status()`, `cachedQuota()`, `text({ system, prompt, model?, effort? })`, `json({ system, prompt, schema, model?, effort? })`, `messages({ system, messages, tools, turnId, model?, effort? })`. `model`: `'haiku'`, `'sonnet'` u `'opus'` (sin `model`, `text`/`json` usan Haiku); `effort`: `'low'`, `'medium'` o `'high'` (si el plan no lo permite, las tareas internas se reintentan con el más parecido). Errores con `err.code` y regla del `turnId`: 6.7. Ver `docs/backend-ia.md`. Siempre tener un camino sin IA |

**Actividad del jugador** (`game.activity(id)` / evento `activity`): `{ type: 'menu' }`, `{ type: 'singleplayer', world: '<carpeta>' }`, `{ type: 'server', address: 'host[:puerto]' }` o `null` cuando el juego se cierra. En la interfaz llega como `api.on('game:activity', (id, act) => ...)`.

**Chequeos antes de jugar**: `game.addBeforeLaunch(async ({ id, instance, resolved, settings, quiet, account }) => ({ warnings: ['...'] }))` (`account` es la cuenta de la partida con su token: solo la usa `ingame` para anotar la insignia). Devolver `{ block: true, message }` solo si jugar sería dañino (por ejemplo, un mod con malware confirmado; el error llega con `err.code = 'blocked'`) y `{ memory: { min, max } }` para elegir la memoria de esa partida (detalle en 6.7). `settings` es una copia para esa partida: cambiarla no toca los ajustes guardados. Los chequeos tienen que ser rápidos: nada de red ni análisis largos (usá cachés).

## 3. Interfaz

### Páginas (`src/renderer/js/pages/<pagina>.js`)

```js
import { h, icon, mount } from '../ui.js';
import { store, api } from '../store.js';
import { t } from '../i18n.js';

export default {
  ns: ['mipagina'],            // namespaces de textos que se cargan antes de render
  css: ['pages/mipagina'],     // hojas de estilo que se cargan una vez
  async render(root, params) {  // #/mipagina/a/b -> params = ['a', 'b']
    mount(root, h('div', { class: 'page-head' }, h('div', { class: 'ph-text' },
      h('h1', { class: 'page-title' }, t('mipagina.title')), h('p', { class: 'page-sub' }, t('mipagina.subtitle')))));
    const off = api.on('modulo:evento', () => { ... });
    return () => off();         // limpieza al salir de la página
  },
};
```

- `api.invoke('modulo:accion', ...args)` llama al proceso principal (lanza el error traducido). `api.on(canal, fn)` devuelve la función para desuscribirse. Siempre desuscribirse en la limpieza.
- Si un canal de otro módulo no existe, la llamada falla con "No handler registered": **capturar el error y mostrar un estado vacío o degradado**, nunca romper la página.
- `app.js` exporta: `navigate(ruta)`, `launchInstance(id, { quickPlay: { world: '<carpeta>' } | { server: 'host', port: 25565 } })` (Quick Play en 1.20+, `--server/--port` en versiones viejas), `openAccounts()`, `playtimeLabel(inst)`, `setNavBadge(ruta, valor, 'badge'|'dot')`, `finishOnboarding()`, `registerPage(id, loader, navItem)` (`navItem = { label, icon, cls }`; `label` puede ser una función que se vuelve a evaluar al cambiar el idioma; registrar el mismo id reemplaza la página), `unregisterPage(id)` (solo páginas registradas, no las propias del launcher), `setNavHidden(id, hidden)` y, desde la 3.1, `navEntries()` (grupos y entradas del menú con la etiqueta ya traducida, para el editor "Personalizar menú" de `features/navcustom`). El menú se dibuja según `settings.nav` (orden, fijados, ocultos y pack de íconos, con `navLayout` y `navIconName` de `features/navcustom/`), se rearma solo cuando esa clave cambia (`store.on('settings')`) y `app.js` pone `html[data-mini]` apenas lee los ajustes si quedó activado el modo mini; `registerPage`/`unregisterPage`/`setNavHidden`/`setNavBadge` no cambian (los badges se pintan por `data-for`).
- `store`: `settings`, `instances`, `accounts`, `running`, `servers`, `info`, `tasks`; `on/emit`; `refreshInstances()`, `refreshSettings()`, `setSettings(patch)`, `selectedAccount()`, `selectedInstance()`, `taskFor(id)` (tarea que impide jugar esa instancia; ver 6.7).
- `ui.js`: `h`, `mount`, `clear`, `icon`, `registerIcons`, `toast`/`ok`/`fail`, `modal({ title, subtitle?, icon?, body, footer, size: 'sm' | '' | 'wide' | 'xwide', onClose, closable })` (con `icon` o `subtitle` la cabecera lleva el ícono en un recuadro de acento y una línea de contexto debajo del título), `confirmDialog`, `promptDialog`, `loading`, `skeleton(forma, opciones)` (carga de más de 300 ms: `3` líneas, `'line'`, `'title'`, `'circle'`, `'block'`, `'list'`, `'card'`, `'grid'`; se anuncia una sola vez como "Cargando..."), `setBusy(botón)` (acción asíncrona: spinner en lugar del primer ícono, `disabled` y `aria-busy`; devuelve la función que lo libera y le devuelve el foco), `reducedMotion()`, `emptyState`, `switchEl`, `selectEl`, `sectionTitle`, `safeHtml`, `copyText`, `ensureCss`, formatos `fmtBytes`, `fmtMb`, `fmtDuration`, `fmtNumber`, `fmtAgo`, `fmtDate`, `fmtTime`, `debounce`, `LOADERS`, `loaderBadge`, `instanceIcon`, `avatarImg`, `showTip`/`hideTip`.
- Módulos que arrancan solos al abrir el launcher (cada uno exporta un `startup()` que se puede llamar más de una vez): `appearance.js` y `a11y.js` arrancan antes de dibujar la primera página (`EARLY_STARTUP`, se esperan como mucho 1,5 s para que no se vea el tema por defecto); después, la lista `STARTUP` de `app.js` arranca `features/share.js`, `features/cloudsync.js`, `features/assistant.js`, `features/netplay.js`, `features/crash.js`, `features/admin.js` (agrega `#/admin` al menú solo para los administradores), `features/mcp.js` (confirmaciones y avisos con Deshacer de lo que piden Claude o ChatGPT por MCP) y `features/svcstatus.js` (solo registra el comando "Estado de los servicios" de Ctrl+K; no consulta nada). Desde la 2.0 también `features/nowplaying.js` (comandos de Música en Ctrl+K), `features/overlay.js` (manda voz y mensajes al overlay), `features/capture.js` (avisos de capturas y la señal `media-share`), `features/rewards.js` (logros automáticos y saldo de Venus Points), `features/party.js` (señales `party-*`), `features/notify.js` (avisos de amigos y favoritos) y `features/whatsnew.js` (recorrido de la 2.0); desde la 3.1, también `features/pass.js` (Venus Pass), `features/decor.js` (partículas, sonidos, cursores y pantalla de inicio), `features/navcustom.js` (menú lateral a gusto, packs de íconos y modo mini), `features/tools.js` (caja de herramientas, descansos, resumen al cerrar y aviso de versión nueva) y `social/gifts.js` (`startGiftWatch()`: el aviso cuando un amigo te regala). `app.js` además monta, con `mountShellExtras()`, el mini reproductor (`miniPlayer()`) y el saldo (`pointsChip()`) arriba del botón de Discord de la barra lateral, y el botón **Grupo** (`partyButton()`) en la barra de título.

### Diseño

Las reglas visuales completas (tokens, componentes, layout y checklist antes de entregar una pantalla) están en `design-system/venus-launcher/MASTER.md`. En resumen:

- Respetar el estilo actual: espacio cálido naranja/dorado, títulos con fuente pixel (`var(--pixel)`), tarjetas `.card`, botones `.btn` (`primary` uno solo por vista, `tonal` para acciones secundarias con tinte de acento que no compiten con el primario, `modrinth.soft` para la versión secundaria del verde de Modrinth, `ghost`, `danger`, `sm`; `.loading` con `setBusy`), `.icon-btn` (`.loading`: el ícono gira mientras dura la acción), `.count` (contador redondo dentro de `.tab`, `.chip` o un botón de `.segmented`; vacío no se ve), `.badge`, `.pill` (`good`/`warn`/`bad`), `.notice` (`info`/`good`/`bad`), `.tabs`/`.tab`, `.segmented`, `.chips`/`.chip`, `.grid` (`cols-2`, `cols-3`), `.stack`, `.row`, `.list`/`.list-item`, `.kbd`, `.console`, `.progress`, `.empty`. Usar las variables de color de `:root` (nunca colores sueltos salvo acentos de marca). El módulo de apariencia reescribe en vivo los colores fijos de todas las hojas para aplicar el tema; una hoja se puede excluir con `data-ax-skip`.
- Estilos nuevos solo en tu archivo `styles/pages/<pagina>.css` o `styles/features/<feature>.css`, con un prefijo propio de clases (por ejemplo `.wl-` para la bienvenida) para no pisar otras páginas.
- La ventana mínima es 1040×680: todo tiene que verse bien en ese tamaño sin scroll horizontal.
- Íconos: los de `ui.js` (estilo Lucide). Para uno nuevo, `registerIcons({ nombre: '<path d="..."/>' })` en tu módulo.
- Accesibilidad: botones con `title`/`aria-label`, foco visible, navegación con teclado (Enter/Escape) y nada que dependa solo del color. Clases globales que pone a11y: `body.reduce-motion`, `body.gamepad-mode`, y en `<html>` `ax-hc`, `ax-shapes`, `ax-focus`, `ax-couch`, `ax-zoomed`, `ax-cvd-<tipo>` y `data-ax-input=mouse|keyboard|gamepad`.

## 4. Textos e idiomas

- Idiomas: es, en, pt, fr, de, it, nl, pl, ru, uk, tr, ja, ko, zh. **Cada módulo escribe `es` y `en`** de sus namespaces; las demás traducciones se generan a partir de esos dos (`node scripts/i18n-check.js` muestra lo que falta).
- Interfaz: `src/renderer/i18n/es/<ns>.js` y `en/<ns>.js` → `export default { title: 'Mundos', count_one: '{count} mundo', count_other: '{count} mundos' }`.
- Proceso principal: `src/main/i18n/es/<ns>.js` y `en/<ns>.js` → `module.exports = { ... }`.
- Uso: `t('ns.clave', { variable })`. Plurales con `count` y claves `_one` / `_other`. Nada de armar oraciones concatenando pedazos: una clave por frase completa con `{variables}`.
- Namespaces: cada módulo usa solo los suyos (ver la tabla de la sección 7). `common.*` y `nav.*` son compartidos y de solo lectura.
- Fechas y números: usar los formatos de `ui.js` (ya usan el idioma elegido).

## 5. Nube (Supabase)

- Proyecto: siempre el del launcher (`core/cloud-defaults.js`, canal `cloud:config`). No se configura desde la interfaz ni desde los ajustes; para desarrollo, las variables de 2 (`core/cloud-defaults`).
- Cliente: `import { cloud } from '../cloud.js'` → `await cloud.ready()`; `cloud.isConfigured()`, `cloud.isSignedIn()`, `cloud.client` (supabase-js v2), `cloud.user`, `cloud.profile`, `cloud.on('auth' | 'profile' | 'config', fn)`, `cloud.requireSession()`. Cuenta: `signUp`, `signIn`, `signOut`, `verifyEmailCode(email, código, 'signup' o 'recovery')`, `resendSignupCode(email)`, `resetPassword(email)`, `updatePassword(contraseña)`, `updateProfile(patch)`, `loadProfile()` y `forgetSession()`. La sesión se guarda cifrada en el proceso principal (`secure`, claves `ui:sb.venus-auth*`), nunca en `localStorage`.
- Sin sesión, mostrar un estado claro con botón a **Ajustes → Cuenta y nube** (`navigate('settings/cloud')`), nunca un error. Si el servicio no responde o le falta una migración, un mensaje para el usuario sin detalles técnicos ("El servicio no está disponible en este momento. Probá más tarde.") y el detalle en la consola (`console.warn('[modulo] ...')`): nunca pedirle al usuario que configure Supabase, aplique migraciones o cargue claves.
- Esquema: un archivo `supabase/migrations/NNNN_<modulo>.sql` por módulo (0001 a 0012, qué crea cada una en `docs/supabase.md`). **RLS activado en todas las tablas**, políticas que limiten cada fila a sus dueños o participantes; nada de `using (true)` en escrituras. Tablas, buckets y políticas idempotentes (`if not exists`, `drop policy if exists`). Las escrituras sensibles van por funciones RPC `security definer`.
- Perfiles (0001): `profiles(id, username, display_name, friend_code 'VENUS-XXXXXX', mc_name, mc_uuid, bio, banner, badges, status, status_text, last_seen)`. Desde 0020 además `pronouns`, `theme`, `name_style`, `banner_style`, `favorite_servers`, `public_stats`, `featured`, `equipped` y `customized_at`: se leen como el resto (o con `profile_public(usuario)`, en camelCase y con `premium`) y se escriben **solo** con `profile_customize(patch)`. Premium = `venus_is_premium(usuario)` (plan de Venus vigente).
- Realtime con canales privados (políticas sobre `realtime.messages`): el buzón personal `inbox:<userId>` lo maneja **solo** `social.js`; otros módulos mandan y reciben señales con `social.sendSignal(userId, tipo, datos)` y `social.onSignal(tipo, fn)` (tipos en 6.6). Las salas de voz usan `voice:<código>` y las maneja solo `voice.js`.
- Archivos grandes: Supabase Storage con buckets privados y rutas `<userId>/...`: `world-saves` (0004, mundos en partes de 45 MB), `screenshots` y `clips` (0005, se comparten con links firmados). Bucket **público** `profile-media` (0020): banners y capturas destacadas del perfil, 12 archivos de 4 MB por usuario en su carpeta, GIF solo con premium. Bucket **público** `profile-audio` (0027): la canción de perfil, un solo archivo `<userId>/song.webm` de hasta 1 MB (`audio/webm`); la tarjeta la ofrece solo a los amigos, pero el archivo es público por URL.
- Venus Points (0021: `points_me`, `points_daily_claim`, `achievement_claim`, `shop_buy`, `referral_my_code`, `referral_claim`), temas de la comunidad (0022: `theme_list`, `theme_publish`, `theme_use`, `theme_delete`) e insignia (0019: `badge_challenge`, `badge_mine`, `badge_remove`; el mod usa `badge_styles` con la anon key). Verificar una cuenta de Minecraft con Mojang: Edge Functions `badge` y `mcverify` (las llama el proceso principal; ver [insignia.md](insignia.md) y [venus-points.md](venus-points.md)).
- Perfil y social de la 3.1 (`0027_perfil_social.sql`; se aplica después de 0025 y 0026): columna `profiles.status_until` (vencimiento del estado: `profile_public` y el listado de amigos mandan `statusText` vacío si venció) y RPC `profile_set_status(p_emoji, p_text, p_until)`; `profile_customize` y `profile_public` reemplazadas (`cardStyle.theme/bubble/entry/song/guestbook` y `showcase.skinPose/skinBg/rareBadges`; `song` solo para los amigos y el dueño); tablas `profile_guestbook`, `profile_gifts` y `profile_reports` con RLS y sin acceso directo (todo por RPC `security definer`: `guestbook_list`, `guestbook_post`, `guestbook_delete`, `guestbook_set`, `gift_send`, `gifts_received`, `profile_report`, y `admin_profile_reports` / `admin_profile_report_close` con `admin_guard()`); `points_ledger.reason` admite `gift_in` y `gift_out`; marcos `frame_pulse`, `frame_orbit`, `frame_halloween` y `frame_xmas` en `shop_items`; bucket `profile-audio` (arriba). Ver [perfiles.md](perfiles.md). Las otras migraciones de la 3.1 son 0025 (pagos y permisos, [pagos.md](pagos.md)) y 0026 (Venus Pass, [venus-pass.md](venus-pass.md)).

**Integración 4.5.0.** Producción tiene aplicadas **0028–0037** desde el 4 de noviembre de 2026; ver [activación y límites](activacion-backend-4.5.0.md). La configuración de CurseForge del panel ya tiene 0037 aplicada (versión **`20261104170221`**) y la Edge Function `curseforge` **v1 ACTIVE**, **`verify_jwt = true`**, con autorización específica del dueño. No se reemplazó `admin`. El estado público devuelve HTTP 200, `configured: false`: falta que el dueño cargue la clave; no se probó el proveedor ni una cuenta real. El cierre de sesión del launcher usa `cloud.signOut()` con `scope: 'local'`: no cierra las sesiones de otros dispositivos. Las credenciales del escritorio siguen en `secure`; la PWA guarda su propia sesión en IndexedDB, con alternativa en memoria si el almacenamiento falla.

| Migración | Contratos nuevos | Referencia completa |
|---|---|---|
| 0028 | Preferencias sincronizadas por cuenta, lista de campos admitidos y marcas por clave | [Datos](implementacion/datos.md) |
| 0029 | Reseñas, votos y denuncias de servidores destacados | [Servidores](implementacion/servidores.md) |
| 0030 | Stickers propios y bucket público `stickers` | [Mensajes y voz](implementacion/mensajes-voz.md) |
| 0031 | Rankings, desafíos y calendario; conserva el motivo contable `challenge` | Retirada en la 4.6; sus tablas las limpia la 0048 (sin aplicar) |
| 0032 | Galería, me gusta y moderación sobre clips compartidos | [Clips](implementacion/clips.md) |
| 0033 | Clanes (retirados en la 4.6, los limpia la 0048), comunidades y canales | [Clanes y comunidades](implementacion/clanes-comunidades.md) |
| 0034 | Capas de Venus (retiradas en la 4.6; las limpia la 0048) | [Retirada de funciones](retirada-funciones.md) |
| 0035 | Suscripciones push, bandeja móvil y persistencia de `media-share` | [App para celular](implementacion/app-celular.md) |
| 0036 | Extensiones (retiradas en la 4.6; las limpia la 0048) | [Retirada de funciones](retirada-funciones.md) |
| 0037 | Configuración administrativa de CurseForge en Vault y estado público | [CurseForge](curseforge.md) |
| 0038 | Comunidades: roles propios, permisos por canal, reacciones, bienvenida y despedida, GIFs con aprobación (`community_media`, bucket `community-media`) | [Clanes y comunidades](implementacion/clanes-comunidades.md) |
| 0039 | Avatar siempre `round`, banners `none` / `image` quieta / `klipy`, `profile-media` sin GIF | [Perfiles](perfiles.md) |
| 0040 | 36 marcos originales, los anteriores desactivados y reintegrados, `gift_send` solo para lo de la tienda | [Perfiles](perfiles.md) |
| 0041 | Venus Pass permanente de 380 niveles por tiempo jugado | [Venus Pass](venus-pass.md) |
| 0042 | `private.card_song_ok` para canciones de Openverse; `profile-audio` sin subidas | [Perfiles](perfiles.md) |
| 0043 | Desactiva los logros que dependían del juego (189 activos) | [Venus Points](venus-points.md) |
| 0045 | Soporte: temas con campos, capturas, cola del equipo, notas, respuestas guardadas, valoración y avisos | [Estado de la base](supabase.md) |
| 0047 | Secretos de sala para el respaldo de la voz | [Voz](voice-turn.md) |
| 0048 | **Sin aplicar.** Limpieza de Competir, Extensiones, capas y Clanes; `profile_public` con logros activos | [Estado de la base](supabase.md) |

La 0044 (planes de clan y pagos) la prepara otra sesión y la 0046 no se usó. Producción tiene aplicadas hasta la 0047 (menos la 0044); la 0048 está sin aplicar. Los contratos de las tablas enlazadas incluyen permisos, errores y cuotas. La prueba conjunta de las migraciones y la verificación real de Realtime siguen pendientes. Reemplazar `social_send_signal` debe conservar la persistencia de `media-share` incorporada en 0035; reemplazar `points_ledger_reason_check` debe conservar `challenge`. No agregar `net` a los esquemas expuestos de la API.

## 6. Contratos entre módulos

Estos son los nombres que usa cada módulo hoy. Quien consume algo de otro módulo lo hace con `import()` dinámico o `require` dentro de `try/catch` y tiene un camino alternativo si falta. Los agregados a un contrato tienen que ser compatibles hacia atrás (parámetros opcionales nuevos, campos extra en las respuestas).

### 6.1 Features de la interfaz (`src/renderer/js/features/*.js` y módulos de `js/`)

| Archivo | Contrato | Exports extra | Dueño |
|---|---|---|---|
| `crash.js` | `showCrashDialog(instanceId, state)` (lo llama `app.js` cuando el juego crashea; no muestra nada si hay una búsqueda del culpable en curso), `openCrashTools(instanceId, { tab: 'last' o 'bisect', mode: 'crash' o 'manual' }?)` | `startup()` (escucha `crash:bisect`) | crash |
| `snapshots.js` | `openSnapshots(instanceId)`, `snapshotBefore(instanceId, reason) → Promise<id o null>` (instantánea antes de un cambio riesgoso; `reason` es texto libre o `'modUpdate'`, `'packUpdate'`, `'beforePlay'`, `'crash'`, `'import'`) | — | snapshots |
| `packs.js` | `openModpackUpdate(instanceId)`, `openExport(instanceId)`, `openImportPack(filePath?)` (sin ruta abre el selector) | — | snapshots |
| `share.js` | `startup()` (sincroniza los grupos, escucha la señal `'pack-invite'`, abre la importación al pegar un código con Ctrl+V y arranca `cloudsync.startup()`), `openShareDialog(instanceId)`, `openImportCode(code?)`, `groupBadge(instance) → Element o null` | `normalizeCode(code)` | share |
| `cloudsync.js` | `openCloudSync(instanceId)` | `startup()` (idempotente; sube al cerrar el juego y baja al abrir el launcher) | share |
| `compat.js` | `checkBeforeInstall({ target: { kind: 'instance' o 'server', id }, items: [{ projectId, versionId?, type? }] }) → Promise<boolean>`, `openModUpdates(instanceId)`. **Modifica `items` en el lugar**: deja el `versionId` elegido y quita los ítems omitidos, así que hay que instalar con `items` después de la llamada. `type` opcional: `'resourcepack'`, `'shader'`, `'datapack'`, `'plugin'`. Si el canal falta, falla o tarda más de 45 s, resuelve `true` | — | compat |
| `install.js` | `openInstallDialog(project, { type?, instanceId?, serverId?, versionId?, fileId? }) → Promise<resultado o null>`. `project` puede ser un resultado de búsqueda, un proyecto o `{ id }`/`{ slug }`; con `project.source === 'curseforge'` usa CurseForge | — | modrinth |
| `searchfilters.js` | Panel "Más filtros" del catálogo y del Buscador inteligente (frase exacta, palabras a excluir, autor, descargas mínimas, actualizado en los últimos N días, solo código abierto y entorno): `createMoreFilters({ state, caps, idPrefix, onChange, extra }) → { el, refresh }` (`state` = objeto con las claves de `emptyMore()`; `caps` = `() => { environment: false/true/'locked', authorMode: 'username'/'name', openSourceMode: 'license'/'source' }`), `morePayload(state, caps)` (parámetros para `modrinth:search`, `curseforge:search` y `smartsearch:run`), `morePills(state, caps)`, `moreCount`, `clearMore`, `radioKeys` (flechas en un `role="radiogroup"`) | `emptyMore`, `splitTerms`, `joinTerms`, `compactNumber`, `DOWNLOAD_PRESETS`, `DAYS_PRESETS` | modrinth |
| `netplay.js` | `openWorldToFriends(instanceId)`, `serverNetPanel(serverId) → Element` (se adapta si va dentro de otra `.card`; se desuscribe al salir del DOM o con `el.destroy()`) | `startup()` (registra la señal `'join-world'`), `showWorldInvite(payload, fromId)` | netplay |
| `analysis.js` | `openSecurityScan(instanceId o { instanceId } o { serverId })`, `openMixinReport(instanceId)` | — | analysis |
| `perf.js` | `instanceMemoryPanel(instance) → Element` (sin tarjeta ni título; guarda `memory: { override, min, max }`), `openOptimize(instanceId, { tab? })` | `openPacks(instanceId)`, `openOptimizePicker()`, `ramSlider`, `bigValue`, `zoneOf`, `deriveMin`, `tierPill`, `ensurePerfUi`, `GC_PRESETS` | performance |
| `worldmap.js` | `openWorldMap(instanceId, worldFolder)` (carga solo sus textos y CSS; si ya hay un mapa abierto lo reemplaza) | — | mapviewer |
| `modtranslate.js` | `openModTranslate(instanceId)` | — | modtranslate |
| `storage.js` | `storagePanel() → Element`, `downloadsPanel() → Element` (los dos con `.destroy()`) | — | storage |
| `discord.js` | `discordPanel() → Element` (con `.destroy()`) | — | discord |
| `serverlist.js` | `joinServer(address, { instanceId? }) → Promise<boolean>` (sin `instanceId` elige una instancia compatible o pregunta), `openBuildFromServer(address?)` | `motdView`, `parseMotd`, `stripMotd`, `latencyBars`, `serverIcon`, `pingServer`, `openSaveDialog`, `cleanAddress`, `sampleView`, `ensureUi` y formatos | multiplayer |
| `assistant.js` | `startup()` (botón **Asistente** en la barra de título + Ctrl+J), `openAssistant({ prompt?, instanceId?, autoSend? })` | `createChat`, `registerPageChat`, `transparencyPanel`, `openTransparency`, `getStatus(force)`, `onStatus(fn)`, `quotaInfo`, `fmtIn`, `renderMarkdown` | assistant |
| `engines.js` | `engineCard() → Element` (con `.destroy()`; tarjeta de la página del Asistente: sin plan no muestra nada), `enginesPanel() → Element` (con `.destroy()`; Ajustes → IA, ancla `engines`) | — | assistant (`assistant:engines`, `assistant:setEngine`) |
| `plans.js` | `plansPanel({ variant?: 'page' o 'modal', go? }) → Element` (con `.destroy()`: plan actual con pago fallido, gracia o cancelación, las 6 tarjetas de planes con precio, modelos y preguntas por día y por semana, "Mejorar plan" y "Administrar suscripción"; se actualiza con `billing:changed`), `openPlans({ reason?: 'needsPlan' o 'quota' })` (las mismas tarjetas en un diálogo). Es la única interfaz de pagos: Ajustes > Plan, el Asistente y el panel de MCP la reutilizan | `usageView(status)` (preguntas que quedan por modelo y presupuesto del mes, de `assistant:status`), `preparePlans()` (textos y CSS antes de usar `usageView` en otra pantalla), `fmtUsd(n)` | billing |
| `mcp.js` | `mcpPanel() → Element` (con `.destroy()`; va en Ajustes > IA, ancla `ai/mcp`), `assistantCard() → Element` (con `.destroy()` y `.setHighlight(bool)`: tarjeta "Usá el asistente desde Claude o ChatGPT" de la página del Asistente; sin plan no muestra nada), `startup()` (confirmaciones de acciones destructivas `mcp:approval`, avisos con Deshacer y revisar el plan cuando cambia la sesión, `billing:changed` o `ai:quota`). "Mejorar plan" abre `openPlans()` de `plans.js` | — | mcp |
| `mcpservers.js` | `mcpServersPanel() → Element` (con `.destroy()`; va en Ajustes > IA, ancla `ai/mcpservers`): servidores MCP del asistente (agregar remoto o local, importar de Claude Desktop, activar, probar, herramientas con "Permitir siempre"). Sin plan lleva a `openPlans()` | — | assistant |
| `admin.js` | `startup()` (pregunta `admin:me` y registra la página `#/admin` en el menú solo si la cuenta es admin; vuelve a revisar al cambiar la sesión) | — | admin |
| `recap.js` | `openRecap() → Promise` (diálogo "Tu resumen de Venus": vista previa, período, formato, nombre, Copiar imagen y Guardar PNG; carga solo sus textos y su CSS; la promesa se resuelve apenas se abre el diálogo y los datos cargan después; si ya está abierto le pasa el foco y dos clics seguidos no abren dos). Lo abren el botón **Compartir mi resumen** del encabezado de `pages/stats.js` (primario solo si hay tiempo jugado; si no, tonal) y la tarjeta Tu actividad de `pages/home.js`, que cargan además el namespace `recap`. El dibujo está en `features/recap/card.js`: `drawCard(canvas, view, { format, palette, images })` y `FORMATS` (`landscape` 1600×900, `portrait` 1080×1920) | — | recap |
| `mcimport.js` | `openOfficialImport({ dir?, from?: 'welcome', onImported?(ids, resultado) })` (diálogo; lo abre el ítem **Del launcher oficial de Minecraft** de `importMenuItems()` en `pages/versions/common.js`, cabecera y estado vacío de Versiones; `pages/versions.js` carga el namespace `mcimport`), `welcomeSuggestion(slot, { onImported })` (tarjeta "¿Venís del launcher oficial?" del paso Primera instancia de `pages/welcome.js`: llena un contenedor oculto solo si detecta perfiles propios (`custom`) o usados, o mundos; si algo falla, queda oculto) | `detectOfficial({ force? })` (detección rápida con `mcimport:detect`, sin red; se guarda en memoria) | mcimport |
| `svcstatus.js` | `openServiceStatus({ focus?, failed? })` (panel; `focus`: `'connection'`, `'login'`, `'downloads'`, `'content'` o `'venus'`; `failed = { ids, at }`: servicios que el error ya vio fallar de su lado, que durante 2 minutos se muestran caídos aunque ahora contesten), `mountVerdict(slot, { source: 'login', code?, text?, ids?, token? })` (veredicto corto después de un error al iniciar sesión, en `openAccounts()` de `app.js` y en el paso de la cuenta de `pages/welcome.js`; `text` = `err.message`: clasifica el error y, si lo amerita, consulta solo los servicios de Microsoft; si el error ya prueba que el servicio falló de su lado, lo dice sin consultar; con `ids` consulta esos sin clasificar; maneja el `hidden` del hueco; con el mismo `token` no vuelve a consultar al redibujar y un resultado viejo no se dibuja si se borró `slot.dataset.svcToken`), `taskHint(el, task)` (botón **Ver estado de los servicios** en una tarea que falló por la red; lo llama `renderTask` de `app.js`), `statusCard() → Element` (con `.destroy()`; Ajustes → Descargas y almacenamiento, ancla `storage/services`) | `statusButton({ ids?, focus?, label?, cls?, failed? })`, `startup()` (comando de la paleta Ctrl+K; idempotente, está en `STARTUP`) | svcstatus |
| `../appearance.js` | `startup()`, `appearancePanel() → Element` | `PRESETS`, `APPEARANCE_DEFAULTS`, `BRANDING_DEFAULTS`, `appearanceSettings()`, `accentColor()`, `brandingView()`, `fileUrl(path)`, `validServer(addr)`, `musicPlaying()`, `toggleMusicPause()`, `openAppearanceModal()`, `currentWallpaperId()` (id del fondo de la galería elegido o `null`), `useWallpaper(id)` (lo pone de fondo; `false` si no existe), `useStars()`, `onAppearanceChange(fn) → off`, `registerAppearanceCard(fn)` (tarjeta de otro módulo en Ajustes → Apariencia; la usa decor). Desde la 3.1: `savedLooks()` y `applyLook(look)` (Mis looks: `save({ appearance, branding })`, el modo liviano se conserva; códigos `VENUS-LOOK:<base64 del JSON>` en `features/themes/looks.js`, que valida con `normalizeAppearance`/`normalizeBranding` y nunca deja viajar rutas de la PC), `currentScheme()` (`'dark'` o `'light'`: el que se ve ahora), `currentSeason()` (`'halloween'`, `'christmas'`, `'newyear'` o `null`), `rotateWallpaper()`; lógica pura en `a11y/appearance-logic.js` (`SEASONS`, `seasonFor(date)`, `nextRotation(ids, actual)`). Motor `a11y/engine.js`: `setTheme({ accent, tint, scheme, palette })` (con `palette` deriva las variables `--bg-1`, `--surface-2/3/4`, `--card-bg`, `--text-2`, `--muted`, `--faint`, `--border-2/3`, `--cream`… y re-ancla los colores fijos de las hojas entre el fondo y el texto nuevos; `palette.accent` manda sobre el acento), `LIGHT_VARS` (misma copia que `styles/a11y.css`; `light-palette.test.js` comprueba que coincidan), `baseTokens(scheme)`, `currentScheme()`, `legibleAccent(hex, light)`. Eventos en `window`: `venus:season` (`{ detail: { id } }`, al arrancar —aunque sea `null`— y en cada cambio) y `venus:ui-sound` (`{ detail: { id } }`: clic en un `.play-btn` que no sea Detener ni esté deshabilitado; otro módulo lo hace sonar). En `<html>`: `data-scheme="light"`, `--play-color`/`--play-ink` + `data-play-color`, `--play-label` + `data-play-label` y `data-play-anim` (estilos en `styles/a11y.css`; el texto cambia solo en `.play-btn[data-fk="play"]`) | a11y |
| `../a11y.js` | `startup()`, `accessibilityPanel() → Element` | `registerCommands(provider)` y `openCommandPalette(query?)` (paleta Ctrl+K; un comando es `{ id, title, run, group?, icon?, sub?, keywords?, hint? }`), `openControlifyInstaller()`, `openAccessibilityModal()`, `setA11y(patch)`, `a11ySettings()`, `A11Y_DEFAULTS`, `motionReduced()`, `scaleInfo()` | a11y |
| `../social.js` | `social` (6.2) | `MAX_MESSAGE` | social |
| `../voice.js` | `voice` (6.2) | `normalizeCode`, `VOICE_DEFAULTS`, `MAX_MEMBERS`, `SVC_PROJECT`, `SOUNDS`, `VoiceError` (con `.code`), `VoiceEngine` | voice |
| `pages/skins.js` | página `#/skins` (sin exports para otros módulos: el visor 3D `createViewer` de `pages/skins/viewer.js` y el resto de `pages/skins/` son internos) | — | skins |
| `nowplaying.js` | `startup()` (comandos de Ctrl+K), `miniPlayer() → Element` (con `.destroy()`; barra lateral, oculto si no suena nada), `nowPlayingPanel() → Element` (con `.destroy()`; Ajustes → En el juego, ancla `ingame/music`) | `nowPlaying` (subscribe, refresh, control, setVolume, sources, openSpotify, view), `runAction`, `fmtClock`, `positionNow`, `paintArt`, `safeArt`, `accelParts`, `prepare`, `NP_ICONS` | nowplaying |
| `overlay.js` | `startup()` (manda la voz y los mensajes al overlay con límite de frecuencia), `overlayPanel() → Element` (con `.destroy()`; Ajustes → En el juego, ancla `ingame/overlay`) | — | overlay |
| `capture.js` | `startup()` (escucha `capture:saved`, avisos, logros y la señal `media-share`), `capturePanel() → Element` (con `.destroy()`; Ajustes → En el juego, ancla `ingame/capture`) | — | capture |
| `premium.js` | `isPremium({ force }) → Promise<boolean>` (caché de 5 min), `onPremiumChange(fn) → off`, `perksPanel() → Element` (con `.destroy()`; Ajustes → Plan y Venus Points) | — | rewards |
| `rewards.js` | `startup()` (escucha `venus:achievement` y reclama los logros de la PC una vez por cuenta), `pointsChip() → Element` (con `.destroy()`; barra lateral) | `claimAchievement(id, { force?, silent? })`, `loadSummary`, `getSummary`, `onSummary`, `sweepServerAchievements`, `achievementName`, `achievementDesc`, `itemName` | rewards |
| `party.js` | `startup()` (señales `party-*`, líder caído, mundo del líder), `openParty()`, `partyButton() → Element` (con `.destroy()`; barra de título), `partyCard() → Element` (con `.destroy()`; Multijugador → Amigos jugando) | `onPartyChange(fn) → off`, `partySnapshot()`, `inviteToParty(userId)`, `controller` | party |
| `notify.js` | `startup()` (presencia de amigos y favoritos cada 5 min), `notifyPanel() → Element` (con `.destroy()`; Ajustes → Privacidad, ancla `privacy/notify`) | `watchButton(address, name) → Element`, `isWatched`, `toggleWatchServer`, `muteFriend(userId, muted)`, `serverStatus(address)`, `checkServers({ manual })` | party |
| `themes.js` | `themesPanel() → Element` (con `.destroy()`; Ajustes → Apariencia, ancla `appearance/themes`) | `currentTheme()`, `applyTheme(theme)`, `themePreview(theme, { compact })`, `accentOf` | themes |
| `whatsnew.js` | `startup()` (recorrido la primera vez que se abre la 2.0.0; comando de Ctrl+K), `openWhatsNew({ start? })`, `whatsNewButton({ className? })` (Ajustes → Acerca de) | `shouldShow`, `compareVersions`, `TOUR_VERSION` | whatsnew |
| `profile-editor.js` | `openProfileEditor({ tab? })`, `openShareProfile({ profile? })`, `featureCapture({ src, title? }) → Promise<boolean>` (destacar una captura en el perfil; lo usa Clips) | `features/profile-editor/audio.js` (canción de perfil, 3.1): `audioSupported()`, `decodeAudio(file)`, `clipBuffer(buffer, start, seconds)`, `encodeWebm(buffer, { onProgress, signal })`, `prepareSong(file, { start, onProgress, signal })` (30 s recodificados con `MediaRecorder`, `audio/webm;codecs=opus` a 96 kbps), `uploadSong(blob)` (`<uid>/song.webm` al bucket `profile-audio`), `removeSong()` | perfiles |
| `../social/profile-style.js` | `ensureProfileStyle() → Promise`, `styledName(profile, { size?, title? }) → Element`, `applyFrame(el, profile)`, `bannerEl(profile) → Element`, `gradientCss(profile)`, `titleLabel(titleId)` (acepta el perfil en camelCase de `profile_public` o la fila de `profiles`). Desde la 3.1: `cardStyleAttrs(profile)` (tema de la tarjeta: clases `pf-themed pf-theme-<id>` y `pf-particles`), `bubbleAttrs(profile)` (burbujas de chat: clases `msg-bub-*` y variables `--msg-bub-*`, con texto oscuro o claro según el fondo; si ningún texto llega a 4.5:1 corre el fondo hasta que se lea), `entryEffectOf(profile)` (efecto de entrada en voz), `fetchStyle(id)` | `premiumChip`, `rankChip`, `normalize`, `nameColor`, `primeStyles`, `setStyleCache`, `FONT_STACKS` | perfiles |
| `pages/skins/editor.js` | `openSkinEditor({ libraryId?, start?, onSaved? })` (editor de skins de 64×64 con vista 3D; lo abre el botón de Skins) | — | skineditor |
| `decor.js` | `startup()` (idempotente, en `STARTUP`: partículas sobre el fondo, sonidos de la interfaz, pantalla de inicio y cursores; registra su tarjeta en Ajustes → Apariencia con `registerAppearanceCard`), `playUiSound(id)` (`'click'`, `'whoosh'` o `'bell'`; suena aunque los sonidos de la interfaz estén apagados) | `decorSettings()`, `saveDecor(patch, delay)` (escritura en serie), `onDecorChange(fn) → off`, `currentSeason()`, `previewSplash()`, `previewSound(pack, id)`. Escucha en `window` `venus:season` (`{ detail: { id: 'halloween' \| 'christmas' \| 'newyear' \| null } }`; otro id se trata como `null`; la temporada vigente no se guarda, vive en memoria) y `venus:ui-sound` (`{ detail: { id } }`). Usa `registerAppearanceCard` y `brandingView()` de `appearance.js` y respeta `html[data-ui-lite]` y `reducedMotion()` de `ui.js` (sin partículas ni fundidos). Clases globales que agrega: `html[data-dc-cursor="<id>"]` (+ variables `--dc-cursor` y `--dc-cursor-pointer`), `canvas.dc-particles` dentro de `.space-bg`, `.dc-splash` en `body`; un botón con `data-dc-silent` (o adentro de uno) no hace el clic genérico. Lógica sin DOM en `features/decor/settings.js` (`normalizeDecor`, `mergeDecor`, `cleanSplashText`, `seasonId`, `seasonParticles`, `resolveParticles`, `particleBudget`), `packs.js` (`soundSpec`, `uiSoundSpec`, `soundLength`, `volumeGain`) y `cursors.js` (`cursorSvg`, `cursorDataUrl`, `cursorCss`, `cursorGrid`, `applyCursor(id)`) | decor |
| `navcustom.js` | `startup()` (en `STARTUP`: botón `.nc-tb-btn` en la barra de título antes de los botones de la ventana, **Ctrl+M** —no en campos de texto ni en la bienvenida— y los comandos "Modo mini" y "Personalizar menú" de Ctrl+K), `openNavEditor()` (editor "Personalizar menú"; también lo abre el engranaje `.nav-gear` que dibuja `buildNav` de `app.js`), `setMini(on)`, `toggleMini()`, `isMini()` | `syncButton()`. Lógica pura en `features/navcustom/logic.js` (`normalizeNav`, `navLayout(NAV, prefs)`), packs de íconos en `features/navcustom/packs.js` (`pixel` y `filled` para todos los íconos del menú) e `icons.js` (`navIconName(icono, pack)`; registra `px-<icono>` y `fi-<icono>` con `registerIcons` al importarse desde `app.js`; solo el menú los usa), vista del modo mini en `features/navcustom/mini.js` (`setMini(on, { persist })`, `redraw()`: cuenta con `openAccounts()`, instancia elegida con selector y `launchInstance` con los mismos estados que el héroe del Inicio, amigos de `social.friends` + `presenceOf`, y `miniPlayer()` de `nowplaying.js`; esconde la barra lateral y la página, que sigue dibujada debajo). El menú lo dibuja `app.js` (`navEntries()`, sección 3); el tamaño de la ventana lo cambia `modules/miniwindow.js` (`window:mini`, 6.3) | navcustom |
| `playcare.js` | `startup()` (en `STARTUP`: ya no registra ninguna página: arranca `features/playcare/{mcnews,breaks,recap,schedule}.js`) | `features/playcare/schedule.js`: `schedulePanel() → Element` (Ajustes → Descargas y almacenamiento, ancla `storage/schedule`) y la tarjeta "Descargas en espera" al principio del panel de tareas mientras hay tareas con la franja cerrada; `features/playcare/recap.js`: `previewRecap(instanceId)` (resumen de ejemplo desde la consola); `features/playcare/mcnews.js`: `showNewVersion(v)`; `features/playcare/breaks.js`: `todayMinutesPlayed()`. Lógica sin DOM en `features/playcare/breaks-logic.js` (`tick(state, cfg, { now, playing, day })`). Avisos de descansos y tope: toast en el launcher y `overlay:push({ kind: 'alert', icon: 'info', ttl: 12 })`; nunca cierra el juego. El resumen al cerrar escucha `game:state` (no `quiet`, no `crashed`, al menos 1 minuto) y cuenta `capture:saved`, `venus:achievement` y las misiones de `features/missions.js`. La tarjeta "Descansos y resumen" de Ajustes → General la dibuja `pages/settings/general.js` con `settings.play.*` y `news.newVersions` (7.2) | playcare |
| `../social/gifts.js` | `openGiftDialog(friend)` (botón **Regalar** de la tarjeta de un amigo: pestañas Puntos / Cosmético, confirmación y errores traducidos; RPC `gift_send(p_to, 'points' \| 'item', p_value)`: puntos de 10 a 500 y hasta 1000 por día, ítems al precio normal, no premium ni repetidos), `startGiftWatch()` (en `STARTUP`; también lo arrancan Mensajes y las tarjetas: escucha `onSummary` de `features/rewards.js` y, con un `gift_in` nuevo, pide `gifts_received(p_since)` y avisa con un toast; guarda hasta dónde se vio en `settings.rewards.lastGiftSeen`). El historial de Venus Points muestra `hist_gift_in` / `hist_gift_out` | — | perfiles |
| `../social/guestbook.js` | `guestbookSection(ownerId, { isMe?, isFriend?, preview? }) → Element` (libro de visitas de la tarjeta: últimas 10, Ver más, escribir si son amigos, borrar el autor o el dueño; RPC `guestbook_list`, `guestbook_post` —5 por día, sin bloqueados ni baneados—, `guestbook_delete`, `guestbook_set`) | — | perfiles |
| `../social/song.js` | `songPlayer(song, { name?, autoplay? }) → Element` (reproductor de la canción de perfil: play/pausa, volumen, silenciar), `songsAllowed()`, `setSongsAllowed(on)` ("No reproducir canciones de perfil" → `settings.social.profileSongs`), `stopSongs()` | — | perfiles |
| `../social/report.js` | `openReportDialog({ id, name?, hasSong? })` (**Denunciar** un perfil: motivo canción o contenido y texto opcional; RPC `profile_report`, 10 por día). El panel las lee en `pages/admin/reports.js` (`render(root)`, pestaña "Denuncias" de `#/admin`: `admin_profile_reports` y `admin_profile_report_close(p_id, p_remove_song)`) | — | perfiles |
| `../social/gifpicker.js` | `openGifPicker(anchor, onPick)`, `closeGifPicker()` (botón GIF del cuadro de escribir de Mensajes; reusa `features/profile-editor/klipy.js`: "Search KLIPY", grilla propia, "Powered by KLIPY" y `reportShare` al mandar; sin clave de KLIPY —`no_key`— el botón avisa que no está disponible). El mensaje es solo la URL del GIF y Mensajes lo dibuja como `<img>` si es una URL de KLIPY (`isKlipyUrl`); cualquier otra URL sigue como texto | — | perfiles |
| `../social/logic.js` | Lógica pura de lo social de la 3.1 (sin DOM): `joinedMembers(prev, next, { selfId, initial })` (quién entró a la sala de voz: `voice/ui-room.js` pide su estilo con `fetchStyle` y pone 1,5 s `vc-entry vc-entry-<fx>` más la etiqueta `voice.entryJoined`; nada con movimiento reducido), `canPostGuestbook`, `mergeGuestbook`, `oldestGuestbookAt`, `newGifts`, `latestGiftAt`, `hasNewGiftIn`, `shouldAutoplaySong`, `volumeStep`, `ENTRY_EFFECT_MS` (1500), `GUESTBOOK_PAGE` (10) | — | perfiles |

Ayudantes de social reutilizables en `js/social/profile-ui.js`: `openProfile(userId)` (se completa con `profile_public`), `openMyProfile()` (abre el editor de perfil), `previewProfile(profile)`, `fetchPublicProfile`, `forgetPublicProfile`, `profileCard(perfil, { full, preview })`, `joinFriend(friend)`, `inviteToVoice(friend)`, `presenceDot`, `headImg`, `headWithDot`, `badgeChips`, `profileCard`, `activityBlock`, `statusMenu`, `popMenu` (cargan solos su CSS y sus textos).

**Features incorporadas para 4.5.0.** Sus contratos completos se conservan en [implementacion/](implementacion/README.md).

| Área | Integración entre módulos |
|---|---|
| Instancias | Apariencia por instancia, `sharedoptions`, `modsets`, `deeplink` y `modchangelog`; los sets conservan sus entradas al duplicar, pero se limpia `lastApply`. |
| Datos | Programación de copias, `perfhistory`, `family` y `portability` en main; sincronización de ajustes desde la interfaz con la sesión de `cloud` y `store.setSettings`. |
| Overlay | `features/overlaytools.js` conecta paneles, rutas y eventos del asistente; recetas y estadísticas se leen localmente. |
| Social | Stickers y traducción, soundboard y efectos; `social/preview.js` ofrece texto de aviso para stickers/GIF, sin mostrar su URL como mensaje. |
| Retiradas en la 4.6 | Competir, Extensiones, el visor de semillas, el modo streamer con OBS, la página Herramientas, las capas de Venus y los Clanes viejos se borraron del árbol (módulos, páginas, textos en los 14 idiomas, estilos, pruebas y rutas). Lo que sobrevivía de Herramientas pasó a `features/playcare`. [Alcance](retirada-funciones.md). |
| Clips | `features/clipstudio/` coordina montaje, timelapse y subida;
| PWA | `web/app/` usa la misma cuenta y las RPC sociales, sin latido de presencia de escritorio. Su sesión y permiso de push son propios del dispositivo. |

### 6.2 `social` y `voice`

**`social`** (`js/social.js`):

- `init()` no espera a la red. `state`: `'idle'`, `'disabled'` (sin nube), `'signedOut'`, `'loading'`, `'ready'`, `'missingSchema'` (el servicio no tiene el esquema de 0002; la interfaz lo muestra como servicio no disponible) o `'error'`. `status`: `'offline'`, `'connecting'` u `'online'`.
- `on(evt, fn) → off`. Eventos: `'ready'` ({ state }), `'unread'` (n = mensajes sin leer + solicitudes recibidas; por separado `social.unreadMessages` y `social.unreadTotal`), `'message'` ({ chatId, from, fromId, text, id, message }, solo mensajes entrantes), `'friends'`, `'presence'` ({ userId, presence, activity, lastSeen }), `'requests'` ({ incoming, outgoing }), `'moderation'` (cambió `social.moderation`) y, para la página, `'state'`, `'status'`, `'chat'`, `'typing'`, `'profile'`, `'outbox'`.
- `moderation`: `{ muted, mutedUntil, banned, bannedUntil }` de la cuenta (RPC `my_moderation` de 0012; se vuelve a pedir al conectar y cuando el servidor rechaza con `user_muted` o `user_banned`) o `null` si no se sabe. Mensajes avisa y bloquea el campo de texto antes de que el usuario escriba; sin 0012 no hay aviso previo y el servidor igual rechaza.
- `friends`: `[{ id, userId, friendshipId, since, profile, name, presence ('online', 'away', 'busy' u 'offline'), activity, lastSeen, statusText, chatId, unread, lastMessage, lastAt, typing }]`. `activity` = `{ type, instanceName, mcVersion, loader, address o world, since }`.
- `presenceOf(userId) → { presence, activity, lastSeen, statusText }`, `activeChat`, `openChat(userId) → Promise<chatId>` (navega a `#/messages/<userId>`), `sendMessage(chatId, text, { replyTo }?)` (cola cifrada si no hay conexión).
- Señales: `sendSignal(userId, type, payload)` y `onSignal(type o '*', fn)` con `fn({ type, from, fromId, profile, payload, at })` (6.6).
- Métodos extra: `addFriend`, `acceptRequest`, `declineRequest`, `cancelRequest`, `removeFriend`, `blockUser`, `unblockUser`, `ensureChat`, `chat`, `chatIdFor`, `loadMessages`, `loadOlder`, `editMessage`, `deleteMessage`, `toggleReaction`, `reactionsOf`, `markRead`, `isRead`, `quoted`, `sendTyping`, `isTyping`, `setActive`, `updateProfile`, `setStatus`, `setPrefs`, `prefs`, `friendById`, `isFriend`, `profileOf`, `nameOf`, `retryMessage`, `discardMessage`, `retry`, `connect` (alias de `retry`).
- RPC de 0002: `social_send_friend_request`, `social_respond_friend_request`, `social_remove_friend`, `social_block_user`, `social_unblock_user`, `social_get_or_create_conversation`, `social_mark_read`, `social_conversations`, `social_heartbeat`, `social_send_signal`, `are_friends`.

**`voice`** (`js/voice.js`, instancia de `VoiceEngine`):

- `init()`, `on(evt) → off`. Eventos: `'room'` (sala o null), `'invite'` ({ name, room, from }), `'members'`, `'state'`, `'levels'`, `'chat'`, `'screens'`, `'sound'`, `'settings'`, `'devices'`.
- Getters: `room`, `members`, `state`, `chat`, `screens`, `settings`, `levels`.
- Salas: `createRoom({ name, private, password, maxMembers, join = true })`, `joinRoom(code, { password }?)`, `leaveRoom()`, `inviteFriend(userId)` (si no estás en una sala crea una privada, la abre en `#/voice` y devuelve el código), `listRooms`, `roomInfo(code)`, `updateRoom(id, patch)`, `deleteRoom`, `forgetRoom`.
- Audio: `setMuted`/`toggleMute`, `setDeafened`/`toggleDeafen`, `setVolume(userId, 0..2)`, `setLocalMute(userId, bool)`, `listDevices`, `startMicTest`/`stopMicTest`, `setMonitor`, `playTestSound`, `saveSettings(patch)`, `setShortcut(accel)`. `hasTurn` dice si el launcher trae un servidor TURN (entonces `relayOnly` oculta la IP).
- Sala: `sendChat(text)`, `playSound(id)`, `previewSound(id)`, `startScreenShare(opts?)`/`stopScreenShare()`; moderación del anfitrión: `requestMute`, `kick(userId, { ban })`, `setLocked`, `endRoom`.
- Los errores son `VoiceError` con `.code` (por ejemplo `'password_required'` o `'bad_password'`; con esos, mandar a `#/voice/join/<código>`).
- Usa los canales `voice:setShortcut` (main.js; devuelve si el atajo global quedó registrado, `false` si es inválido o lo usa otra aplicación), `voice:iceServers` (los servidores TURN del launcher, de `core/app-config.js`; no se configuran desde la interfaz) y el evento `voice:toggle-mute` (atajo global). RPC de 0003: `voice_create_room`, `voice_room_by_code`, `voice_join`, `voice_heartbeat`, `voice_leave`, `voice_member_keys`, `voice_invite`, `voice_kick`, `voice_set_password`, `voice_list_rooms`.

### 6.3 Canales del proceso principal

Todos se llaman con `api.invoke(canal, ...args)`; los eventos se escuchan con `api.on(canal, fn)`. "Tarea" = corre con `core/tasks` y se ve en el panel de tareas.

**Núcleo** (`ipc.js`, `main.js`, `modules/ai.js`)

- `app:*` (info, window, openExternal, openPath, showItem, selectFiles, selectFolder, setDataDir, relaunch, dataUsage, clearCache), `settings:get`, `settings:set`, `i18n:available`, `secure:get/set/remove` (solo claves `ui:*`), `cloud:config` (→ { url, anonKey, configured }: siempre el proyecto del launcher), `voice:iceServers` (→ [{ urls, username, credential }] de `core/app-config.js`, o `[]`), `system:info`, `system:usage`, `java:runtimes/detect/test`, `accounts:list/addOffline/loginMicrosoft/select/remove`, `versions:manifest/patchNotes/patchNote`, `loaders:gameVersions/versions`, `instances:*` (list, get, create, update, remove, duplicate, repair, content, toggleFile, deleteFile, addFiles, openFolder, addOptifine, launch, stop, status, logs, latestLog), `game:activity`, `modrinth:search/project/versions/tags/install/installModpack/identify/updates`, `servers:*` básicos, `stats:get`, `stats:reset`, `tasks:list`, `tasks:cancel`, `voice:setShortcut`.
- `instances:content(id, folder)`: además de `mods`, `resourcepacks`, `shaderpacks` y `saves`, acepta `saves/<mundo>/datapacks`, `screenshots`, `logs` (registros + crash reports), `config`, `@overview` ({ size, sizes, counts, prepared }) y `@log:<logs o crash-reports>/<archivo>` (texto, hasta 512 KB, lee `.gz`). Nunca sale de la carpeta de la instancia.
- `loaders:gameVersions(kind)` y `loaders:versions(kind, mcVersion)`: `kind` = cualquier tipo de `fabric.KINDS` (`fabric`, `quilt`, `legacyfabric`, `babric`), `forge`, `neoforge`, `optifine` o `iris`. `versions:manifest(opts)`: booleano (forzar) o `{ force, loaders: ['babric'] }` (suma `venus.loaders.babric`).
- IA: `ai:status({ refresh }?)` → { provider ('backend' o null), enabled, cloudConfigured, signedIn, configured, model, models, efforts, quota (QuotaV2 del plan), plans (catálogo del backend) }, `ai:test()`. No hay API key propia ni elección de modelo en Ajustes: el modelo y el esfuerzo los elige el usuario en el Asistente, entre los que permite su plan.
- Eventos: `task:update`, `instances:changed` (también lo mandan varios módulos después de cambiar archivos de una instancia), `game:state`, `game:log`, `game:warnings`, `game:activity`, `server:state`, `server:log`, `window:maximized`, `voice:toggle-mute`, `ai:quota` (cuota del plan), `cloud:refreshSession` (el proceso principal le pide a `cloud.js` que renueve la sesión de Supabase). `servers:changed` lo mandan `serverx`, `worlds` y `devmode`.

**performance** (`modules/perf.js`, `modules/catalog.js`)

- `perf:system()` → { totalMem, freeMem, cpuModel, cores, threads, gpu, gpuTier, cpuScore, tier ('low', 'mid', 'high' o 'ultra'), gpus, tiers, benchmarkedAt, platform, arch }, `perf:benchmark()`, `perf:memoryPlan({ instanceId }?)`, `perf:recommend({ mcVersion, loader, instanceId?, lowEnd? })` → { memory, jvmPreset, reason, mods, options, tier, ... }, `perf:applyRecommended(instanceId, { memory, jvmPreset, mods, options, lowEnd })` (tarea), `perf:readOptions(instanceId)`.
- `catalog:packs({ mcVersion, loader, preset?, instanceId? })` → packs `performance`, `shaders`, `minimap`, `qol`, `pvp-hud`, `controller`, `voice`, `multiplayer`; `catalog:installPacks(instanceId, packIds)` (tarea).

**compat** (`modules/compat.js`)

- `compat:check({ target, items })` → { ok, target, items, toInstall, suggestions, replace, enable, adopt, errors, warnings, infos, checkedAt }, `compat:prepare({ target, adopt?, replace?, enable?, install? })` (aplica lo confirmado en la revisión), `compat:updates(instanceId, { includeBeta? })`, `compat:applyUpdates(instanceId, items)` (tarea con meta `{ instanceId, kind: 'compat:update' }`), `compat:history(instanceId o { kind, id })`, `compat:rollback(target, entryId)`, `compat:clearHistory(target)`, `compat:settings(patch?)` → { includeBeta }.
- Evento `compat:progress` { instanceId, phase: 'hash', 'check' o 'changelog', done, total }.

**snapshots** (`modules/snapshots.js`, `modules/packs.js`)

- `snapshots:create(instanceId, { reason, reasonCode, label, kind, worlds: 'none', 'all' o [carpetas], pinned })` → resumen { id, createdAt, kind, reason, ..., reused }, `snapshots:list(instanceId)` → { items, running, settings }, `snapshots:compare`, `snapshots:restore(instanceId, id, { worlds })`, `snapshots:delete`, `snapshots:update(instanceId, id, patch)`, `snapshots:prune`, `snapshots:usage`, `snapshots:gc`, `snapshots:cleanOrphans`, `snapshots:worlds`, `snapshots:settings`.
- `packs:diff(instanceId, versionId)` (avisos `worldOverrides`, de nivel medium, con las carpetas de mundos que trae el pack y no se tocan, y `keptFiles`, informativo; en `changes.overrides`, `kept` y `keptWorlds`), `packs:update(instanceId, versionId, { snapshot, worlds })` (el resultado trae `keptWorlds` y `keptFiles`: un mundo que ya es del jugador nunca se pisa), `packs:exportPreview`, `packs:export`, `packs:reveal`, `packs:pickFile`, `packs:inspect(file)`, `packs:import(filePath?, { name })`.
- Eventos: `snapshots:changed` (instanceId), `instances:changed`.

**share** (`modules/share.js`, `modules/cloudsync.js`)

- `share:buildManifest(instanceId, { includeConfigs, includeOptions, folders })`, `share:encode`, `share:preview`, `share:diff(instanceId, manifest, { fresh })`, `share:compare`, `share:applyManifest(instanceId, manifest, { removeMissing, applyOptions, fresh, revision, share })` (tarea), `share:createFromManifest(manifest, { name, applyOptions, revision, share })`, `share:state`, `share:forget`.
- `cloudsync:status(instanceId, auth)`, `cloudsync:upload(instanceId, world o '@config', auth, { force })`, `cloudsync:download(...)` (con conflicto devuelven { conflict: true, remote }), `cloudsync:remove`, `cloudsync:autoSync`, `cloudsync:settings(instanceId?, patch)`. `auth = { accessToken }`.
- Bloquea jugar (con `addBeforeLaunch`) solo mientras esa instancia aplica una revisión o sube o baja un mundo.

**multiplayer** (`modules/serverlist.js`)

- `serverlist:ping(address, { force?, remember? })` → { online, latency, version, protocol, players, motd (códigos §), motdText, favicon, loader, mods, mcVersion, ... }, `serverlist:featured({ force? })` → array (cada servidor con `source`: 'cloud', 'cache' o 'bundled'), `serverlist:saved(instanceId?)`, `serverlist:addSaved`, `serverlist:updateSaved`, `serverlist:removeSaved` (aceptan una instancia o un array), `serverlist:pickInstance(address, { details? })`, `serverlist:join(address, { instanceId?, remember?, name?, launch? })`, `serverlist:buildInstance(address, { loader?, mcVersion?, name?, mods?, prepare? })` (tarea; { instanceId, installed, missing }), `serverlist:versionOptions`, `serverlist:history`, `serverlist:clearHistory`, `serverlist:setPreferred(address, instanceId o null)`.

**netplay** (`modules/netplay.js`)

- `netplay:addresses(opts?)` → { lan, primary, vpn, publicIp, routerExternalIp, cgnat, ... }, `netplay:upnpStatus`, `netplay:upnpOpen(port, { protocol, description })`, `netplay:upnpClose(port, protocol)`, `netplay:serverPrefs`, `netplay:setServerPrefs`, `netplay:tunnelStart({ port?, provider: 'bore' o 'playit', serverId?, instanceId?, remotePort? })`, `netplay:tunnelStop(id)`, `netplay:tunnels()`, `netplay:tunnelVerify`, `netplay:test` (Server List Ping con SRV), `netplay:boreConfig` (→ { host }: el servidor de túneles del launcher, de `core/app-config.js`; el secreto nunca sale del proceso principal), `netplay:playitInfo`, `netplay:e4mcStatus(instanceId)`, `netplay:e4mcSetup(instanceId)`, `netplay:worldStatus`, `netplay:worldTunnel`.
- Eventos: `netplay:upnp`, `netplay:tunnel`, `netplay:world`, `netplay:e4mcDomain` (instanceId, dominio o null), `netplay:lan` (instanceId, { port } o null).

**worlds** (`modules/worlds.js`)

- `worlds:list({ instanceId? })`, `worlds:get(instanceId, folder)`, `worlds:recent(limit)` → [{ instanceId, instanceName, folder, name, version, lastPlayed, icon, gameMode, hardcore, playtime, playing }], `worlds:timeline(instanceId, folder)`, `worlds:screenshots({ instanceId?, world?, limit?, offset? })` (con `thumb`), `worlds:clips`, `worlds:media`, `worlds:thumbs`, `worlds:stats`, `worlds:backup(instanceId, folder)`, `worlds:backups`, `worlds:allBackups`, `worlds:restoreBackup`, `worlds:deleteBackup`, `worlds:showBackup`, `worlds:openBackups`, `worlds:copyTargets`, `worlds:copy(instanceId, folder, { instanceId } o { serverId, replace?, player? })`, `worlds:rename`, `worlds:delete` (papelera), `worlds:openFolder`, `worlds:openMedia`, `worlds:showMedia`, `worlds:copyImage`, `worlds:deleteMedia`, `worlds:readMedia`, `worlds:shared`, `worlds:setShared`.
- Evento `worlds:updated` ({ kind: 'sizes', 'timeline', 'list', 'media' o 'backups', ... }). También manda `servers:changed` después de copiar un mundo a un servidor.

**mapviewer** (`modules/mapviewer.js`)

- `mapviewer:info(instanceId, world)` → { world, dimensions, regions, spawn, players }, `mapviewer:tile(instanceId, world, dimension, rx, rz)` → { url, empty, chunks, legacy, unsupported, cached }, `mapviewer:renderAll(instanceId, world, dimension, { force }?)` (tarea con meta `{ mapviewer: { instanceId, world, dimension } }`), `mapviewer:saveImage(bytesPng, nombre)`, `mapviewer:reveal(ruta)`.
- Evento `mapviewer:tileReady` ({ instanceId, world, dimension, rx, rz, url, empty }). Ids de dimensión: `minecraft:overworld`, `minecraft:the_nether`, `minecraft:the_end`, `<ns>:<ruta>` (datapacks) y `folder:DIMn` (mods de 1.12).

**stats** (`ipc.js` + `modules/statsplus.js`)

- `stats:get()` → { version, firstUse, sessions, archived, milestones, milestonesSeen, counters }, `stats:reset()`, `stats:summary()` → { totalMs, weekMs, todayMs, monthMs, streak, longestStreak, playedToday, sessions, avgSessionMs, lastPlayed, firstPlay, favoriteInstance: { id, name, ms, sessions } o null, favoriteInstanceId }, `stats:report()`, `stats:places()`, `stats:world(instanceId, folder)`, `stats:ingame({ instanceId?, world? })`, `stats:export('csv' o 'json')` (diálogo de guardado), `stats:reveal(path)`, `stats:milestonesSeen(ids)`.
- Eventos: `stats:updated` ({ kind: 'session', 'places' o 'reset' }), `stats:milestone` ([{ id, icon, group, target, achievedAt }]).

**crash** (`modules/crash.js`)

- `crash:analyze(instanceId, { logs, code?, report?, latestOnly? })` → { findings[{ id, title, text, confidence, severity, mods, actions }], suspects, bisect, ai, details, ... }, `crash:reports`, `crash:explainAi(instanceId)` → { text, model, at }, `crash:fix(instanceId, { type, payload })`, `crash:bisectStart(instanceId, { mode })` (tarea), `crash:bisectStatus`, `crash:bisectAnswer(id, works)`, `crash:bisectCancel`, `crash:bisectRelaunch`, `crash:bisectDismiss`.
- Evento `crash:bisect` (instanceId, estado). Durante la búsqueda del culpable bloquea jugar esa instancia.

**analysis** (`modules/security.js`, `modules/mixins.js`)

- `security:scan(target, { force?, deep? })` (tarea), `security:results(target)`, `security:quarantine(target, 'mods/x.jar' o 'x.jar')`, `security:restore(target, quarantineId)`, `security:discard(target, quarantineId)` (papelera), `security:remove(target, file)`, `security:quarantined(target)`, `security:system()`. `target` = instanceId, `{ instanceId }` o `{ serverId }`.
- `mixins:analyze(instanceId, { deep? })` (tarea), `mixins:results(instanceId)`.
- Eventos: `security:progress` ({ target: `'instance:<id>'` o `'server:<id>'`, taskId, phase, done, total, file }), `mixins:progress` ({ instanceId, taskId, phase, done, total, file }), `instances:changed`.
- Tareas con meta `{ kind: 'analysis:security' o 'analysis:mixins', analysisTarget }` (sin `instanceId`, a propósito).

**modtranslate** (`modules/modtranslate.js`)

- `modtranslate:scan(instanceId, { locale? })`, `modtranslate:run(instanceId, { locale, mods, setLanguage? })` (tarea cancelable; un `turnId` por ejecución), `modtranslate:cancel`, `modtranslate:status`, `modtranslate:get(instanceId, { locale, mod?, filter, query, offset, limit })`, `modtranslate:save(instanceId, { locale, changes })`, `modtranslate:export(instanceId, { locale, format: 'json' o 'zip', mods? })`, `modtranslate:import(instanceId, { locale })`, `modtranslate:clear`, `modtranslate:setEnabled`, `modtranslate:setGameLanguage`, `modtranslate:openPack`, `modtranslate:reveal(path)`.
- Eventos: `modtranslate:progress` (instanceId, job), `modtranslate:scanProgress` (instanceId, { done, total }).

**smartsearch** (`modules/smartsearch.js`)

- `smartsearch:context`, `smartsearch:plan(query, filters)`, `smartsearch:run(query, filters)` → { runId, query, plan, groups, warnings, target, recommended, versionSuggestion, stats, aiReasons: 'pending' u 'off', filters }, `smartsearch:cancel`, `smartsearch:history`, `smartsearch:removeHistory`, `smartsearch:clearHistory`, `smartsearch:savePrefs`, `smartsearch:createInstance({ name, mcVersion, loader, preset })`, `smartsearch:installKit({ target, items, world, prepare, jobId })` (tarea).
- `filters` = { instanceId, serverId, mcVersion: 'auto' o versión, loader: 'auto' o loader, types, perType (1 a 12; la página ofrece 3, 5, 8 y 12 y se guarda en `settings.smartsearch.prefs` con `smartsearch:savePrefs`), compatibleOnly, useAi, runId, phrase, exclude (texto o arreglo), author, minDownloads, updatedDays, openSource, environment: 'client' o 'server' }. Los filtros extra son los de `core/search-filters`: autor, descargas, fecha, código abierto y entorno (solo mods y modpacks) viajan como facets de Modrinth; la frase exacta y las palabras excluidas se filtran en el motor (se piden 60 candidatos por búsqueda en lugar de 20 y la frase se busca además por su cuenta en cada tipo). Un `author` con espacios o símbolos se rechaza con un error. `run` devuelve en `filters` los ya saneados.
- Eventos: `smartsearch:progress`, `smartsearch:reasons`, `smartsearch:installProgress`.

**modrinth** (`core/modrinth.js` por `ipc.js` + `modules/curseforge.js`)

- Extras de Modrinth: `modrinth:projects`, `modrinth:team`, `modrinth:version`, `modrinth:versionsByIds`, `modrinth:facets` (los registra `modules/curseforge.js`).
- Búsqueda del catálogo: `modrinth:search({ query, type, sort, offset, limit (hasta 100), gameVersions[], loaders[], categories[], environment, license, openSource, author, minDownloads, updatedDays, phrase, exclude })` → `{ hits, total_hits, capped, next_offset, exhausted, filtered }` y `curseforge:search({ query, type, sort, categoryId, gameVersion, loader, index, pageSize (hasta 50), phrase, exclude, author, minDownloads, updatedDays, openSource })` → `{ hits, total, capped, next_index, exhausted, filtered }`. Los parámetros nuevos son opcionales: sin ellos la respuesta es la de siempre (una sola consulta a la API). Con `phrase` o `exclude` (en CurseForge, con cualquiera de los extra) el proceso principal filtra y recorre las páginas de la API (de a 100 en Modrinth y de a 50 en CurseForge, hasta 8 o 12 pedidos y 6 s por llamada) hasta juntar `limit` resultados: `next_offset` / `next_index` es desde donde pedir lo que sigue, `exhausted` dice que no queda nada y `filtered: true` que `total_hits` / `total` es el de la API sin ese filtro (no el real). Si el presupuesto de una llamada se acaba antes de llenar la página, devuelve lo juntado con `exhausted: false` y la interfaz sigue pidiendo. CurseForge corta antes cuando el orden es por descargas o por actualización y el criterio ya no se puede cumplir.
- `curseforge:status` → { configured (configuración central de CurseForge o clave de respaldo en `core/app-config.js`), classIds, maxResults }; sin key la pestaña CurseForge muestra "no disponible" y vuelve a Modrinth. `curseforge:search`, `curseforge:project`, `curseforge:files`, `curseforge:install`, `curseforge:fingerprints`, `curseforge:categories`, `curseforge:changelog`.

**servers** (`core/servers.js` + `modules/serverx.js`)

- `servers:types()` → [{ id, name, kind ('vanilla', 'plugins', 'mods', 'hybrid' o 'proxy'), plugins, mods, proxy, eula, folder, folders, snapshots, ... }], `servers:versions(type, { snapshots })`, `servers:loaderVersions`, `servers:suggestPort`, `servers:checkUpdate`, `servers:restart`, `servers:clearLogs`, `servers:openPath`, `servers:propertiesState`, `servers:gamerules`, `servers:setGamerules`, `servers:playerLists`, `servers:playerAction`, `servers:lookupPlayer`, `servers:worldInfo`, `servers:importWorld`, `servers:backupWorld`, `servers:backups`, `servers:deleteBackup`, `servers:restoreBackup`, `servers:regenerateWorld`, `servers:datapacks`, `servers:addDatapacks`, `servers:toggleDatapack`, `servers:removeDatapack`, `servers:icon`, `servers:icons`, `servers:setIcon`, `servers:removeIcon`, `servers:toggleFile`, `servers:addFiles`, `servers:files`, `servers:readFile`, `servers:writeFile`, `servers:mirrorPreview`, `servers:createFromInstance(instanceId, opts)` (servidor espejo).
- `servers:versions`, `servers:create`, `servers:start`, `servers:reinstall`, `servers:installProject` y `servers:remove` los registra `modules/serverx.js` (con tareas traducidas y los 13 tipos); el resto de los `servers:*` básicos (list, get, update, stop, kill, command, logs, properties, setProperties, addresses, openFolder, content, deleteFile) están en `ipc.js`.
- Eventos: `servers:changed`, `server:log`, `server:state` (con `crashed` y `playerInfo`).

**storage** (`modules/storage.js` + `core/http.js`)

- `downloads:status`, `downloads:pause`, `downloads:resume`, `downloads:setLimit(kbps)`, `downloads:setConcurrency`, `downloads:setOffline`.
- `storage:usage({ force })`, `storage:scan({ cached })`, `storage:dedupe()` (tarea), `storage:autoDedupe(enabled?)`, `storage:clean({ dryRun })` (vista previa) o `storage:clean({ cache, unusedVersions, unusedRuntimes, orphanStore, partials })` (tarea; borra sin papelera), `storage:status()`.
- Eventos: `downloads:stats` (cada 1 s mientras hay descargas), `storage:changed` ({ reason: 'dedupe', 'auto' o 'clean', result }).

**discord** (`modules/discord.js`)

- `discord:status`, `discord:test` (con el Application ID del launcher, `discordClientId` de `core/app-config.js`; sin él, Rich Presence no está disponible y el panel lo dice). Evento `discord:statusChanged`.

**assistant** (`modules/assistant.js`)

- `assistant:send(conversationId o null, text, { instanceId, model?, effort? })` → { conversationId, turnId, model, effort } (`model` `'haiku'`, `'sonnet'` u `'opus'` y `effort` `'low'`, `'medium'` o `'high'`, solo los que permite el plan; sin ellos, lo último de la conversación o la última elección, `settings.ai.assistantModel`/`assistantEffort`), `assistant:confirm(requestId, approved)`, `assistant:cancel(conversationId)`, `assistant:undo(undoId)`, `assistant:conversations()`, `assistant:conversation(id)`, `assistant:deleteConversation(id)`, `assistant:status({ refresh }?)` → lo de `ai:status` + `modelOptions` (modelos del plan con sus esfuerzos y las preguntas que quedan hoy y en la semana), `selection`, `budget` (gasto del mes), `resets`, `needsPlan` (con sesión y sin plan) y `plans`.
- `assistant:confirm(requestId, aprobado, { always }?)` (`always`: "Permitir siempre", solo en confirmaciones de herramientas MCP). Servidores MCP del asistente (plan Go o superior; sin plan `err.code = 'plan'`): `assistant:mcpServers({ refresh }?)` → { plan, servers, limits, claudeDesktop: { found } }, `assistant:mcpSave(servidor)` → { server, servers }, `assistant:mcpRemove(id)`, `assistant:mcpSetEnabled(id, bool)`, `assistant:mcpTest(id)` → { ok, tools, info, ms } o { ok: false, error, code }, `assistant:mcpTools(id, { refresh }?)`, `assistant:mcpAllowAlways(id, herramienta, bool)`, `assistant:mcpImportPreview()` (lee, nunca escribe, `claude_desktop_config.json`), `assistant:mcpImport(nombres)`. Detalle: [asistente-ia.md](asistente-ia.md), sección 10.
- Eventos: `assistant:event` (conversationId, { type: 'turn-start', 'thinking', 'text', 'tool-start', 'tool-result', 'confirm', 'undo', 'done', 'error', 'notice' o 'quota', seq, at, ... }; `text` y `done` traen `failover: true` si respondió el proveedor de respaldo, y la interfaz muestra "Respondió el respaldo (OpenAI)"), `assistant:settingsChanged`, `instances:changed`. Detalle: [asistente-ia.md](asistente-ia.md).
- Motores externos (docs/asistente-ia.md, sección 11): `assistant:engines({ refresh }?)` → { current ('venus', 'claude' o 'chatgpt'), entitled, planReason, checking, at, claude: { app, provider, installed, loggedIn, method, plan, error, usable }, chatgpt: {…}, models, efforts, choice }, `assistant:setEngine(id)`. `assistant:send` acepta `engine` en la primera pregunta y lo devuelve; `assistant:status` trae lo mismo en `engines`. Eventos: `assistant:engines` (terminó la detección de Claude Code y Codex), y en `assistant:event` los tipos `limits` (transitorio: límites del plan del usuario en Claude Code) y `turn-start`/`done` con `engine`.

**billing** (`modules/billing.js` + `modules/billing/`)

- `billing:state({ sync? })` → estado del plan del usuario (plan, active, currentPeriodEnd, cancelAtPeriodEnd, paymentFailed, inGrace, graceUntil, managedByStripe...), `billing:catalog()` → { plans: [{ id, name, sort, price: { amount, currency, interval, formatted, perMonth } }], source, mode }, `billing:checkout(planId)` → { kind: 'checkout' o 'portal', plan, url, opened, alreadySubscribed } (abre Stripe en el navegador; si ya paga una suscripción manda al portal), `billing:portal()` → { kind: 'portal', url, opened }.
- Evento `billing:changed` ({ reason: 'activated', 'changed' o 'timeout', kind, plan, state, quota }) cuando el webhook de Stripe confirma el cambio. Errores con `err.code`: `noCloud`, `noSession`, `unknownPlan`, `stripe`, `network`, `unavailable`, `noSubscription`, `error`. Formas exactas: [pagos.md](pagos.md), sección 16. La interfaz es `features/plans.js` (6.1).

**admin** (`modules/admin.js` + `modules/admin/`)

- `admin:me({ force? })` → { isAdmin, email, userId, reason, checkedAt } (se guarda 5 minutos por usuario), `admin:call(action, payload?)` (acciones de la Edge Function `admin`: `users.list`, `users.ban`, `coupons.create`, `plans.setPrice`...). El servidor verifica al admin en cada acción. Errores con `err.code`: `noCloud`, `noSession`, `forbidden`, `notFound`, `unavailable`, `badRequest`, `conflict`, `stripeNotConfigured`, `stripe`, `server`, `network`, `error`. Detalle: [admin.md](admin.md).

**mcp** (`modules/mcp.js` + `modules/mcp/`)

- `mcp:status({ refresh?: true, 'quota', 'billing' o 'auth', ui? })` → estado completo (servidor, plan, clientes, túnel, puente, conexiones; forma en [mcp.md](mcp.md)), `mcp:setEnabled(bool)`, `mcp:setPort(número)`, `mcp:installClaudeDesktop`, `mcp:uninstallClaudeDesktop`, `mcp:installClaudeCode`, `mcp:uninstallClaudeCode`, `mcp:tunnelStart({ confirmed: true })`, `mcp:tunnelStop`, `mcp:regenerateSecret`, `mcp:activity()` (la más nueva primero), `mcp:clearActivity()`, `mcp:approve(requestId, ok)`, `mcp:undo(undoId)`.
- Eventos: `mcp:status` (estado completo), `mcp:activity` (entrada nueva o cambiada; `{ cleared: true }` al limpiar), `mcp:approval` ({ requestId, state: 'pending', title, message, items, okText, danger, client, expiresAt } y después { requestId, state: 'approved', 'denied', 'expired' o 'cancelled' }). Errores con `err.code`: `plan` (sin plan pago), `confirm`, `port`, `disabled`, `config`, `tunnel`, `unavailable`.

**recap** (`modules/recap.js` + `modules/recap/`)

- `recap:data()` → { generatedAt, hasPlaytime, firstPlay, streak: { current, longest, playedToday }, milestones: { achieved, total }, collection: { instances, mods, worlds }, periods: { week, month, all } }. Cada período: { id, days (7, 30 o null), from, to, ms, sessions, daysPlayed, longestMs, favorite: { id, name, mcVersion, loader, ms, sessions, exists, mods } o null, top: { kind: 'world' o 'server', name, instanceName, ms } o null, worldsVisited, serversVisited, figures: [{ id, value, total? }] }. "Esta semana" y "Este mes" son los últimos 7 y 30 días con hoy incluido (como `stats:summary`); `sessions` cuenta toda partida que suma tiempo al período (también una que empezó la noche anterior). `figures` son las cifras de la tarjeta por prioridad (semana y mes: `daysPlayed`, `streak`, `longest`, `worlds`, `servers`, `avg`; desde siempre: `bestStreak`, `longest`, `milestones`, `totalDays`, `avg`), solo las que tienen sentido. Solo devuelve servidores con dominio público: ni direcciones IP (tampoco abreviadas, como `10.1.5`) ni de la red local, de túneles o con DNS dinámico. `mods` cuenta los archivos de `mods/` (activos y desactivados) de todas las instancias; `worlds`, las carpetas de `saves/` con `level.dat`. Sin red y nunca falla con estadísticas vacías o rotas.
- `recap:copy(dataUrlPng)` → { width, height } (portapapeles), `recap:save(dataUrlPng, nombreSugerido)` → { path, bytes, width, height } o null si se cancela (diálogo en Imágenes, escritura atómica), `recap:reveal(ruta)` (solo imágenes guardadas en esta sesión). La imagen tiene que ser un PNG `data:image/png;base64,...` de hasta 4096 px de lado y con el data URL de hasta 24 MB (unos 18 MB de PNG). Errores con `err.code`: `badImage`, `tooBig`, `clipboard`, `save`, `reveal`.

**skins** (`modules/skins.js` + `modules/skins/`)

- `skins:account()` → { id, type ('msa' u 'offline'), name, needsLogin } (nunca el token) o null si no hay cuenta elegida. `skins:profile(accountId, { force }?)` → { accountId, name, skin: { id, variant ('classic' o 'slim'), textureUrl, alias } o null, capes: [{ id, alias, active, textureUrl }], activeCapeId, fetchedAt } (GET a `/minecraft/profile` de Minecraft Services, con caché de 60 s por cuenta). `skins:texture(url, 'skin' o 'cape')` → { url, kind, width, height, pixelHash, dataUrl }: solo `https://textures.minecraft.net/texture/<hex>` (http se pasa a https), sin redirecciones, hasta 256 KB y con el PNG validado. La interfaz nunca dibuja imágenes de la red en un canvas.
- Biblioteca: `skins:library()` → { items: [{ id, name, variant, width, height, legacy, size, addedAt, updatedAt, source ('file', 'account' o 'catalog'), sha1, pixelHash, broken, image (data:) }], max }. `skins:add()` (diálogo, hasta 20 PNG; null si se cancela) y `skins:addData(lista)` (PNG soltados; cada ítem es `{ name, bytes }`, `{ name, tooBig: true }` o `{ name, unreadable: true }`: la interfaz manda bytes, nunca rutas) → { added, duplicates, failed: [{ name, code, message }], skipped }. También `skins:rename(id, nombre)`, `skins:setVariant(id, variant)` (las de 64×32 solo `classic`), `skins:remove(id)` (papelera; si falla, lo borra), `skins:export(id)` → { path, name } o null y `skins:saveCurrent(accountId)` → { item, duplicate }.
- Catálogo incluido (`renderer/assets/skins`, solo lectura; `catalog.json` se valida una vez y las entradas malas se descartan con un aviso): `skins:catalog({ query, category, model, onlyFavorites, offset, limit })` → { items: [{ id, name, category, model, legacy, width, height, favorite, broken, pixelHash, image (data:) }], total, offset, limit (0 a 96, 48 por defecto; 0 = solo totales), categories: [{ id, count }] (con los demás filtros), favoriteCount, catalogTotal }; búsqueda sin tildes por nombre, categoría e id; cada PNG se revisa (sha256, encabezado y píxeles) al leerlo. `skins:catalogFavorite(id, enabled)` → { id, favorite, favoriteCount }. `skins:catalogSave(id, variant?)` → { item, duplicate } (a la biblioteca con `source: 'catalog'`, respeta el límite). `skins:catalogApply(id, accountId, variant?)` → perfil nuevo o null (mismo candado, revisión de cuenta y errores que `skins:apply`, sin pasar por la biblioteca). `skins:catalogExport(id)` → { path, name } o null. Errores nuevos: `catalogUnavailable`, `catalogNotFound`, `catalogDamaged` (favoritas que no se pueden guardar: `diskError`).
- Cambios en la cuenta: uno a la vez por cuenta, y antes y después de renovar el token se revisa que la cuenta elegida siga siendo `accountId`. Son `skins:apply(libraryId, accountId, variant?)` (POST multipart a `/minecraft/profile/skins`), `skins:reset(accountId)` (DELETE `/minecraft/profile/skins/active`) y `skins:cape(capeId o null, accountId)` (PUT o DELETE `/minecraft/profile/capes/active`). Devuelven el perfil nuevo (igual que `skins:profile`) o null. La interfaz no los habilita hasta que carga el perfil de Microsoft, así siempre puede ofrecer guardar antes una copia de la skin actual. El token sale de `core/accounts` y nunca llega a la interfaz ni a la consola.
- Errores con `err.code = 'skins:<código>'`: `noAccount`, `accountChanged`, `offline` (cuenta sin conexión), `sessionExpired` y `accountError` (con los dos la interfaz ofrece `openAccounts()`), `noProfile`, `forbidden`, `rateLimited`, `serviceUnavailable`, `network`, `timeout`, `busy`, `launcherOffline` (modo sin conexión de Descargas), `skinRejected`, `capeRejected`, `rejected`, `invalidPng`, `wrongSize`, `tooBig`, `libraryFull`, `notFound`, `fileDamaged`, `badName`, `badVariant`, `legacyVariant`, `exportFailed`, `readFailed`, `diskError` (no se pudo escribir en la carpeta de datos), `noSkin`, `textureInvalid`, `textureMissing`, `textureUnavailable`, `badTextureUrl`, `tooLarge`.

**mcimport** (`modules/mcimport.js` + `modules/mcimport/`)

- `mcimport:detect()` → { found, dir, profiles, worlds } (rápido, sin red, sin tamaños ni bloqueos; lo usa la bienvenida; ante cualquier error, `{ found: false }`). `mcimport:scan(dir?)` → { dir, defaultDir, isDefault, found, reason ('notFound', 'notMinecraft', 'empty', 'network', 'unsafe', 'venus' o null), files, errors, latest, links, partial, profiles: [{ id, type, name, suggestedName, versionId, latestType, synthetic, source ('official', 'store' o, en el perfil sintético "Mundos sin perfil", 'venus'), icon, lastUsed, selected, groupId, version: { ok, mcVersion, loader, loaderVersion } o { ok: false, reason, loaderName }, modded, imported }], groups: [{ id, dir, label, isRoot, exists, problem, shared, profileIds, hasContent, content }] }. `content` tiene `worlds`, `mods`, `resourcepacks`, `shaderpacks`, `config`, `options` y `servers`, cada uno con { count, bytes } (`worlds` además con `items: [{ folder, name, bytes, files, lastPlayed, locked }]`, `options` con `files` (los nombres) y `mods`, `resourcepacks`, `shaderpacks` y `config`, si no están vacías, con `files` (cuántos archivos)). Sin `dir` escanea la carpeta por defecto; otra tiene que venir de `pickFolder` o de un escaneo anterior (si no, `notAllowed`). El manifiesto de Mojang (el que ya guardó Venus, el de la carpeta oficial o, si no hay ninguno, lo baja: como mucho 8 s) sirve para reconocer las versiones vanilla y para "Última versión", que toma la más nueva entre el manifiesto y las versiones vanilla que ya instaló el launcher oficial.
- `mcimport:pickFolder()` → ruta o null (si se elige la carpeta de arriba, por ejemplo Roaming, usa la `.minecraft` de adentro). `mcimport:import({ dir, profiles: [id], groups: { [groupId]: { target, categories: { worlds: true, false o [carpetas], mods, resourcepacks, shaderpacks, config, options, servers } } } })` → tarea con meta `{ kind: 'mcimport' }`; devuelve { instances: [{ id, name, profileId, mcVersion, loader }], stats: { files, bytes, links, outside, skipped }, bytes, worlds }. `mcimport:cancel()` → booleano, `mcimport:status()` → { running, taskId }.
- Errores con `err.code`: `busy`, `notAllowed`, `nothing`, `changed`, `tooMany`, `gameRunning`, `worldOpen`, `noSpace`, `cancelled`, `failed`. Manda `instances:changed` al terminar, fallar o cancelar. Copia primero a `<datos>/mcimport/staging-*` y recién al final crea las instancias: ninguna a medias aparece en Versiones ni se puede jugar mientras se copia. De la carpeta oficial solo lee `launcher_profiles.json`, `launcher_profiles_microsoft_store.json`, `versions/` y las carpetas de contenido (`saves/`, `mods/`, `resourcepacks/`, `shaderpacks/`, `config/`, las opciones y `servers.dat`; nunca `launcher_accounts.json`), y saltea los enlaces y uniones.

**svcstatus** (`modules/svcstatus.js` + `modules/svcstatus/`)

- `svcstatus:check({ ids?, connectivity?: 'always' o 'auto', failed? })` → { offlineMode, internet ('ok', 'down' o 'unknown'), internetReason, internetSlow, dns ('ok', 'down' o 'unknown'), checkedAt, nextCheckAt, cached, results: [{ id, group, state ('ok', 'slow', 'down' o 'skipped'), ms, httpStatus?, reason? ('timeout', 'dns', 'refused', 'reset', 'unreachable', 'tls', 'network', 'http' o 'failed'; en `skipped`: 'noKey', 'notConfigured' u 'offline'), detail? (código técnico como 'ENOTFOUND' o 'HTTP 503', nunca el texto del error), dns? e inferred? (solo la fila de la conexión), at? }], verdict: { kind ('offline', 'internet', 'dns', 'tls', 'internetSlow', 'blocked', 'down', 'slow' u 'ok'), ids } }.
  - Ids: `internet` (Cloudflare por nombre y por IP: `www.cloudflare.com` y `1.1.1.1`, para notar cuando falla solo el DNS), `microsoft`, `xbox`, `minecraftServices`, `mojangMeta`, `mojangLibraries`, `mojangAssets`, `modrinth`, `curseforge`, `venus`. Grupos: `connection`, `login`, `downloads`, `content`, `venus`. Los ids desconocidos se ignoran; sin `ids`, todos.
  - Un HEAD por servicio (dos en la prueba de conexión; Venus: GET a `<proyecto>/auth/v1/health` con la anon key), sin seguir redirecciones ni leer el cuerpo. Tiempo límite de 6 s y lento a partir de 2,5 s. Cualquier respuesta que no sea 5xx cuenta como "responde" (el 501 también); un 5xx, un error de red o el tiempo agotado cuentan como caído. En la prueba de conexión cualquier respuesta HTTP, aunque sea un 5xx, prueba que internet anda, y si Cloudflare no contesta pero otro servicio sí, la conexión va como deducida (`inferred: true`) y el veredicto no culpa a internet.
  - Reusa resultados de menos de 20 s y nunca corre dos rondas a la vez. Con el modo sin conexión no consulta nada (`offlineMode: true`). Sin clave compilada se comprueba por GET la conectividad con `curseforge_status` en Venus, sin sesión ni clave de CurseForge; no comprueba la validez de la configuración. Con clave compilada se mantiene la consulta directa a `api.curseforge.com`. `connectivity: 'auto'` (después de un error) prueba la conexión con Cloudflare solo si ningún servicio pedido contestó. `failed`: ids que el launcher acaba de ver fallar de su lado; si ahora contestan bien igual, en esa respuesta van como caídos con `reason: 'failed'`.
- `svcstatus:classify({ source: 'login' o 'task', code?, text? })` → { network, offline, autoCheck, ids, focus, known? }. Es local, sin red (`code` hasta 64 caracteres y `text` hasta 2000). Con `login` mira el `err.code` de `core/accounts`: los errores de la cuenta no consultan nada, y si el error ya prueba que el servicio falló de su lado (`msUnavailable`, o `msRejected`, `xblFailed`, `xstsFailed`, `mcLoginFailed` o `profileFailed` con un 5xx, `server_error` o `temporarily_unavailable` en el texto) devuelve `known: { kind: 'down', ids }` y tampoco se consulta. Con `task` reconoce códigos de red, 5xx, excepciones de red de Java y los textos traducidos de los errores de red y de descarga de `storage`, `packs`, `loaders`, `accounts`, `modrinth`, `compat`, `smartsearch`, `curseforge`, `cloudsync`, `ai` y `java` (idioma actual, inglés y español, con todos los plurales); los errores de disco no cuentan. Un "HTTP 5xx en <url>" de un host conocido da `known` (el panel lo recibe como `failed`).
- Solo en el modo de capturas (sección 9): `svcstatus:devFailTask({ kind? })` → { id } (crea una tarea que falla por la red; con `kind: 'http'`, por un 503 de la CDN de Modrinth).

**ingame** (`modules/ingame.js`, + `ingame/`)

- `ingame:badgeStatus()` → `{ state ('idle', 'working', 'ok', 'removed' o 'error'), code, account, at, enabled, signedIn, bundled, versions }` (insignia de Venus; ver [insignia.md](insignia.md)). Evento `ingame:badgeStatus`.

**nowplaying** (`modules/nowplaying.js`, + `nowplaying/`; solo Windows)

- `nowplaying:state({ retry? })` → `{ available, state, sources, volume, error? }`, `nowplaying:control(acción, valor?)` (`toggle`, `play`, `pause`, `next`, `prev`, `seek`, `skip`, `mute`), `nowplaying:setVolume(0..1)`, `nowplaying:sources()`, `nowplaying:openSpotify()`. Evento `nowplaying:update`. Errores con `err.code`: `platform`, `unsupported`, `unavailable`, `noSession`, `rejected`, `noSeek`, `noAudio`, `noSpotify`, `badAction`, `timeout`. Detalle: [musica.md](musica.md).

**overlay** (`modules/overlay.js`, + `overlay/`)

- `overlay:push(evento)` (contrato de eventos en [overlay.md](overlay.md): `alert`, `message`, `voice`, `music`, `capture` y, desde la 3.1, `perf`), `overlay:status()`, `overlay:edit(bool)`, `overlay:test([eventos])`, `overlay:reset`, `overlay:setShortcut(accel)` → `{ ok, shortcut, code? }`, `overlay:accent('#rrggbb')`. Eventos `overlay:state` y `overlay:config`. La página del overlay habla solo por `ipcMain.on('overlay:page')` y el módulo revisa que venga de su ventana.
- Widget `perf` (3.1, rendimiento): evento `{ kind: 'perf', ram? (MB), cpu? (0 a 100), ping? (ms), session? (segundos) }`, cada medida puede ser `null` (`overlay/events.js`); un evento con todo en `null` esconde el widget y sin muestras nuevas se esconde solo a los 6 s. Mientras el overlay y el widget están activados y hay un juego abierto, `modules/overlay.js` arranca el muestreo de `modules/overlay/perf.js` (`createSampler`): en Windows, un ayudante de PowerShell que queda vivo y escribe una línea JSON cada 2 s (`Get-Process`: WorkingSet64 y TotalProcessorTime, sin WMI); fuera de Windows, o si el ayudante no abre, `pidusage`. El ping se mide con `modules/serverlist.ping` cada 10 s, solo si `core/game.activity(id)` dice que entró a un servidor (la dirección no viaja a la página); la sesión sale de `startedAt` del juego. No hay FPS: no se pueden medir desde afuera del juego. Dibujo en `js/overlay/perf.js` (`draw_perf` en `widgets.js`); la vista previa y "Probar overlay" usan una muestra de ejemplo (2048 MB, 23 %, 48 ms, 44:54).

**capture** (`modules/capture.js`, + `capture/`)

- `capture:status`, `capture:saveReplay`, `capture:screenshot`, `capture:startRecording`, `capture:stopRecording`, `capture:toggleRecording`, `capture:setPremium`, `capture:testShortcut`, `capture:openFolder`, `capture:saveExport`, `capture:aiStatus`, `capture:aiIndex`, `capture:aiDescribe`. Eventos `capture:saved` (`{ type: 'screenshot', 'clip' o 'recording', path, instanceId?, duration? }`), `capture:state`, `capture:notice` (y `worlds:updated { kind: 'media' }`). La grabadora oculta habla por `capture:recorderCmd` / `capture:recorderMsg` y solo se aceptan mensajes de su ventana. Detalle: [clips.md](clips.md).

**rewards** (`modules/rewards.js`, + `rewards/`)

- `rewards:verifyMinecraft()` → `{ uuid, name, rewarded }`: verifica con Mojang la cuenta de Microsoft elegida (Edge Function `mcverify`) para que se pague la invitación. Errores con `err.code`: `noAccount`, `offlineAccount`, `accountSession`, `noCloud`, `noSession`, `network`, `unavailable`, `multiplayerDisabled`, `mojangSession`, `mojang`, `notVerified`, `tooManyAccounts`, `banned`, `rateLimited`, `server`. `rewards:fakeMode()` solo para capturas.

**instancemeta** (`modules/instancemeta.js`, + `instancemeta/meta.js`; carátulas, etiquetas, favoritos y notas de la 3.1)

- `instancemeta:setCover(id, { file })` (imagen elegida: ruta absoluta, PNG/JPG/WebP de hasta 8 MB), `instancemeta:setCover(id, { screenshot })` (una captura de esa instancia: tiene que estar en `<instancia>/screenshots`) e `instancemeta:setCover(id, { dataUrl })` (imagen ya decodificada por la interfaz, `data:image/png;base64,…`: es el camino para WebP, que `nativeImage` no lee) → la instancia actualizada; recortan al centro en 16:9, guardan `cover.png` de 640×360 en la carpeta de la instancia y mandan `instances:changed`. `instancemeta:readImage(file)` → `{ dataUrl }` (los bytes de una imagen de hasta 8 MB, para que la interfaz decodifique WebP con un `<img>` y un canvas). `instancemeta:removeCover(id)` borra `cover.png` del todo (no va a la papelera), deja `cover: null` y manda `instances:changed`. Exports: `setCover`, `removeCover`, `COVER_FILE`, `MAX_BYTES`.
- Etiquetas, favorito y notas no tienen canal propio: la interfaz llama `instances:update(id, { tags | favorite | notes })` y `core/instances.update` los normaliza y valida con `instancemeta/meta.js`, venga el parche de donde venga (campos y reglas en 7.5).
- Errores con `err.code`: `badImage`, `tooBig`, `notScreenshot`, `writeFailed`. El `message` es el propio código (el módulo no tiene textos en `src/main/i18n`): la interfaz los muestra siempre con `metaError(err, prefijo)` de `pages/versions/meta.js` (`versions.coverErr_*`).

**shortcuts** (`modules/shortcuts.js`, + `shortcuts/args.js`; accesos directos en el escritorio, solo Windows)

- `shortcuts:create(id)` → `{ path, name }`: escribe `<Escritorio>\<nombre>.lnk` con `shell.writeShortcutLink` (`target`, `cwd`, `args`, `description`, `icon`, `iconIndex`, `appUserModelId`) apuntando al launcher con `--play-instance=<id>` (en la portable, al `.exe` portable; sin empaquetar, a Electron con la carpeta de la app). Si ya hay un `.lnk` con ese nombre que apunta a **otra** instancia, usa `<nombre> (<id>).lnk`. Errores con `err.code`: `unsupported` (no es Windows), `notFound`, `writeFailed`; el `message` es el código y la interfaz usa `versions.shortcutErr_*`.
- Abrir el launcher con `--play-instance=<id>` (o `--play-instance <id>`, con comillas si hace falta): el módulo lee `process.argv` en `register` y escucha `app.on('venus:argv', argv)`, que `main.js` emite en `second-instance` cuando otra copia recibe los argumentos. El id tiene que ser un segmento de ruta seguro (mismo criterio que `core/instances`). Espera hasta 20 s a que exista la ventana y `#main` tenga contenido, y lanza como `instances:launch` (`accounts.getLaunchAccount`, `settings.selectedInstance`, `game.start`). Si la instancia no existe, falta una cuenta o falla el inicio, lo avisa con una tarea fallida (`tasks.run` que lanza el error: aviso rojo y panel de tareas). Con la partida ya abierta no hace nada (la ventana ya se trajo al frente). Los pedidos se encolan de a uno.
- Lógica sin Electron en `modules/shortcuts/args.js`: `parsePlayArg(argv | cadena)`, `splitArgs`, `safeLinkName` (sin `<>:"/\|?*`, sin puntos finales, sin nombres de dispositivo, máximo 60 caracteres) y `buildShortcut({ id, name, desktopDir, execPath, portableExe, appPath, isPackaged, icon, description })`. Exports: `createShortcut`, `waitUiReady`.

**miniwindow** (`modules/miniwindow.js`; el modo mini de `features/navcustom`)

- `window:mini(on)` → `{ mini, restore }`. Al entrar guarda el tamaño actual (y si estaba maximizada), sale de pantalla completa o maximizado y pone `setMinimumSize(420, 640)` y `setSize(420, 640)`; al salir vuelve al mínimo 1040×680 y al tamaño guardado (o `settings.window.miniRestore`, o 1300×820) y maximiza si correspondía. Al abrir con `settings.window.mini` en `true`, espera la ventana (se crea después de registrar los módulos) y la achica antes de que se muestre. `window.mini` y `window.miniRestore` no afectan la ventana del juego (`core/game.js` solo lee `width`, `height` y `fullscreen`). Exports: `isMini()`, `MINI`, `NORMAL_MIN`.

**mcnews** (`modules/mcnews.js`, + `mcnews/versions.js`; aviso de versión nueva de Minecraft)

- `mcnews:status()` → `{ enabled, allowed, latest, seen, pending, lastCheck, error }`, `mcnews:check()` (fuerza la consulta), `mcnews:seen({ id, type })`. Evento `mcnews:new { id, type ('release' o 'snapshot'), releaseTime }` → `features/tools/mcnews.js` muestra un toast de 25 s con **Crear instancia** (`#/versions/new/vanilla/<id>`) y **Ya vi**; los dos marcan la versión como vista y en la misma sesión no se repite un aviso por la misma versión.
- Consulta solo con `settings.news.newVersions` y la conexión opcional **Novedades de Minecraft** (`settings.privacy.news`): a los 20 s de arrancar y cada 6 h lee el manifiesto con `core/minecraft.getManifest()` (caché de 10 min) y compara `latest.release` y `latest.snapshot` con `settings.news.seenVersions` (`mcnews/versions.js`: `newVersions`, `isBaseline`, `seenPatch`). La primera vez (sin nada visto) guarda lo de hoy como base, sin avisar; una release nueva que además es la última snapshot se avisa una sola vez. Exports: `check`, `status`, `markSeen`, `CHECK_MS`. Capturas: `VENUS_MCNEWS_FAKE=1.21.9` (con `VENUS_DEVSHOT`, sin empaquetar) manda el aviso a los 3 s sin consultar nada.

**downloadschedule** (`modules/downloadschedule.js`, + `downloadschedule/window.js`; descargas programadas)

- `downloads:scheduleStatus()` → `{ enabled, from, to, inWindow, allowed, override, nextChangeAt, pausedBySchedule, overrideUntil, paused }`, `downloads:scheduleNow()` (**Bajar ahora**: levanta la pausa por 2 horas), `downloads:scheduleReset()` (vuelve a la franja). Evento `downloads:schedule` con lo mismo al cambiar.
- Lee `settings.downloads.schedule` (hora local; `to < from` cruza la medianoche; iguales = todo el día; lógica pura `inWindow`, `nextChange` y `decide` en `downloadschedule/window.js`). Cada minuto, al arrancar y al cambiar el ajuste: fuera de la franja `http.pause()` (y anota `pausedBySchedule`); adentro `http.resume()` **solo si la pausa la puso el módulo**. Una pausa manual desde Descargas no se toca; si el usuario reanuda a mano fuera de la franja (`http.events 'stats'`), vale como "Bajar ahora". El indicador "Descargas en pausa" de la barra de título lo sigue mostrando `app.js` (`downloads:stats`). Exports: `status`, `check`, `downloadNow`, `reset`, `OVERRIDE_MS`, `CHECK_MS`.

**Familias IPC de 4.5.0.** Esta tabla orienta; los documentos enlazados conservan cada firma, respuesta, evento, error y límite. Los nombres abreviados de sus tablas heredan el prefijo indicado.

| Familia | Responsabilidad | Contrato |
|---|---|---|
| `sharedoptions:*`, `modsets:*`, `deeplink:ready` / `deeplink:open`, `modchangelog:*` | Ajustes de Minecraft, selección de mods, enlaces externos y explicación de novedades | [Instancias](implementacion/instancias.md) |
| `worldbackups:*`, `perfhistory:*`, `family:*`, `portability:*` | Copias programadas, mediciones, límites familiares y transferencia entre PC | [Datos](implementacion/datos.md) |
| `overlay:*`, `recipes:*`, `mapviewer:markers*` / `markerSave` / `markerDelete` | Paneles, recetas y marcadores; `overlay:assistantEvent` y evento `overlay:route` | [Overlay](implementacion/overlay.md) |
| `serverremote:*`, `serverdiscord:*` | Control HTTP LAN y avisos opcionales por webhook | [Servidores](implementacion/servidores.md) |
| Traducción y soundboard | Consentimiento, caché cifrada, importación y reproducción; efectos en la cadena de audio de voz | [Mensajes y voz](implementacion/mensajes-voz.md) |
| `clipstudio:*`, `clipupload:*` | Trabajos de vídeo y conexión/cancelación OAuth | [Clips](implementacion/clips.md) |
| `profilemusic:status`, `profilemusic:search`, `profilemusic:clearCache` | Música de perfil (Openverse): estado y cupos, búsqueda con caché, vaciar caché. Sin pedidos si `settings.profileMusic.enabled` es falso | [Perfiles](perfiles.md) |
| `support:call(action, payload)`, `support:detail`, `support:diagnostic`, `support:upload`, `support:attachment`, `support:fakeMode` | Soporte. Acciones de `call`: `staffState`, `list`, `queue`, `create`, `detail`, `reply`, `resolve`, `closeOwn`, `reopen`, `rate`, `markSeen`, `unread`, `diagnostic`, `attach`, `attachmentInfo`, `assign`, `priority`, `note`, `staffPanel`, `staffList`, `macros`, `macroSave`, `macroDelete`. El cliente valida lo mismo que el servidor (`modules/support/rules.js`) y los errores salen con `.code` que la interfaz traduce a `support.err_<code>` | [Estado de la base](supabase.md) |
| `smartsearch:ai({ refresh? })`, `smartsearch:aiSet({ useAi?, source?, consent? })` | Estado de la IA del buscador (plan, fuentes, aviso aceptado) y cambio de interruptor, fuente (`venus` o `local`) y aviso. `smartsearch:context` devuelve `ai` como objeto y `smartsearch:savePrefs` ya no guarda la IA | [Funciones](funciones.md) |
| `overlay:status`, `overlay:setShortcut`, `overlay:setPanelShortcut` | `status` suma `tracker`, `pageFailed`, `shortcutIssue` y `panelShortcutIssues`; los atajos devuelven `minecraft`, `system`, `altgr`, `venus` (con `who`), `taken` o `invalid`. La página manda `tweak { id, patch }` por `overlay:page` | [Overlay](overlay.md) |

Comunidades, reseñas, galería y Soporte consumen RPC desde la interfaz; no crear un IPC paralelo para duplicar esas llamadas. Los tokens OAuth y el webhook de Discord no regresan al renderer.

### 6.4 Exports del proceso principal para otros módulos

| `require('./...')` | Funciones |
|---|---|
| `admin` | `me(opts)`, `call(action, payload)` |
| `ai` | `available`, `provider`, `status`, `request`, `messages`, `text`, `json`, `textOf`, `cachedQuota`, `modelAlias`, `modelId`, `modelLabel`, `normalizeEffort`, `bestEffort`, `MODELS`, `MODEL_ALIASES`, `EFFORTS` |
| `assistant` | `status`, `send(conversationId, text, opts)` |
| `billing` | `state(opts)`, `catalog()`, `checkout(planId)`, `portal()`, `PLANS` (lista fija de respaldo: id, nombre y precio) |
| `capture` | `status`, `saveReplay`, `screenshot`, `startRecording`, `stopRecording` |
| `catalog` | `packs`, `installPacks`, `PACKS` |
| `cloudsync` | `status`, `upload`, `download`, `autoSync`, `isBusy` |
| `compat` | `check(input)`, `listUpdates(instanceId, opts)`, `history(instanceId)` |
| `ingame` | `prefs(settings)`, `venusToken()` (token de la sesión de Venus o null), `badgeClient()` (cliente de la insignia: `ensure`, `enroll(account, { fn: 'badge' o 'mcverify' })`, `mine`, `remove`) |
| `crash` | `analyzeInstance(instanceId)`, `bisectStatus`, `isBisecting(instanceId)`, `assertNotBisecting(instanceId)` (error con `code: 'bisect'`: mientras se busca el mod culpable, nadie más toca la carpeta mods; lo usan compat, share, packs, snapshots e `instances:*File`) |
| `curseforge` | `available`, `search`, `getMod`, `getMods`, `getModFiles`, `getFiles`, `getDownloadUrl`, `fingerprintMatches`, `computeFingerprint(buffer)`, `fingerprintFile(ruta)`, `installToInstance`, `installModpack`, `normalizeMod`, `normalizeFile`, `CLASS_IDS` |
| `mapviewer` | `info`, `tile`, `renderAll`, `discoverDimensions`, `flushIndexes`, `getPool`, `configure`, `RENDER_VERSION` |
| `mcimport` | `defaultDir()` (carpeta del launcher oficial; sin empaquetar la pisa `VENUS_MC_DIR`) |
| `mcp` | `status()` (el mismo estado de `mcp:status`), `planState({ refresh?, wait? })` (el control de plan del MCP: lo usan los servidores MCP del asistente y los motores externos), `localEndpoint()` (URL local con el secreto para los motores externos del asistente; arranca el servidor solo para eso si el interruptor está apagado; `err.code 'plan'`), `activitySince(desde)` (entradas de la Actividad MCP desde ese momento), `INSTRUCTIONS` (instrucciones para el modelo de Claude o ChatGPT) |
| `mixins` | `analyze`, `lastReport`, `beforeLaunch` |
| `netplay` | `addresses`, `openPort`, `closePort`, `startTunnel`, `stopTunnel`, `testAddress`, `e4mcStatus`, `worldSnapshot`, `shutdown` |
| `packs` | `recordInstall(instanceId, rutaMrpack, { projectId, versionId })`, `diff`, `update`, `inspect`, `importPack`, `exportPreview` |
| `packs/safety` (ayudante, no se autocarga) | Rutas que vienen de afuera: `safeRelPath`, `resolveInside`, `validSegment`, `isReservedTop`; URLs de un `.mrpack`: `isAllowedPackUrl`, `allowedPackUrls`, `firstHost`, `packHashes`, `PACK_HOSTS`; escrituras sin romper enlaces duros: `writeFileAtomic`, `copyFileAtomic`, `moveFile`, `replaceFile`, `tempPathFor`; archivos bloqueados: `isLockError`, `isSharedFile`. Lo usan el núcleo y varios módulos |
| `perf` | `memoryPlan`, `applyRecommended`, `beforeLaunch`, `recommend`, `system` |
| `recap` | `recapData()` (lo mismo que `recap:data`) |
| `security` | `scanTarget`, `lastResult`, `quarantine`, `restore`, `discard`, `removeFile`, `beforeLaunch`, `effectiveFindings` |
| `serverlist` | `ping`, `pickInstance`, `join`, `saved`, `addSaved`, `updateSaved`, `removeSaved`, `featured`, `parseAddress` |
| `serverx` | `gamerulesState`, `setGamerules`, `propertiesState`, `playerLists`, `playerAction` |
| `share` | `buildManifest`, `applyManifest`, `diff`, `compare`, `preview`, `createFromManifest`, `normalizeManifest`, `encodeManifest` |
| `smartsearch` | `interpret`, `plan`, `run`, `cancel` |
| `snapshots` | `create(instanceId, { reason, worlds })`, `list(instanceId?)` (sin argumentos: todas las instancias), `compare`, `restore`, `remove`, `prune`, `usage`, `getSettings` |
| `statsplus` | `crashReason`, `buildReport`, `buildPlaces`, `worldDetail`, `queryIngame` |
| `storage` | `scan`, `runDedupe`, `clean` |
| `svcstatus` | `check({ ids?, connectivity?, failed? })`, `classify({ source, code?, text? })` (los mismos de los canales) |
| `worlds` | `list`, `get`, `recent`, `timeline`, `screenshots`, `clips`, `isOpen` |
| `nowplaying` | `getState()` → `{ title, artist, album, art, playing, position, duration (ms), source, appName, appId, status, positionAt, canSeek }` o null, `events` (`'update'`) |
| `overlay` | `push(evento)` → bool (nunca lanza), `status()` |
| `rewards` | `verifyMinecraft()` |

Usan `game.addBeforeLaunch`: performance (memoria automática y Java elegido a mano), analysis (seguridad y mixins, solo con su caché), snapshots (instantánea automática antes de jugar, espera como máximo 8 s), share (bloquea mientras se sincroniza esa instancia) y crash (bloquea la instancia durante la búsqueda del culpable).

### 6.5 Rutas de la interfaz (enlaces directos)

| Ruta | Abre |
|---|---|
| `#/home` | Inicio |
| `#/assistant[/<conversación>]` | Asistente IA |
| `#/versions` · `#/versions/new[/<loader>/<versión>]` | Mis instancias · Instalar nueva |
| `#/instance/<id>[/<pestaña>[/<extra>]]` | Instancia. Pestañas: `overview`, `content`, `mods`, `resourcepacks`, `shaderpacks`, `datapacks[/<mundo>]`, `worlds`, `screenshots`, `logs[/files]`, `settings` (`saves` y `console` son alias) |
| `#/worlds` · `#/worlds/media` · `#/worlds/<instanceId>/<carpeta>` | Mundos · Capturas y clips · Ficha de un mundo |
| `#/venus[/<inicio, fondos, ia o preguntas>]` | Venus: la web de Venus dentro del launcher (cuenta regresiva del lanzamiento, novedades, accesos, galería de fondos que se aplican con un clic, planes de Venus IA y preguntas frecuentes). Menú Jugar, después de Inicio; cambiar de pestaña actualiza la ruta sin volver a dibujar la página |
| `#/skins` | Skins: vista previa 3D, biblioteca de PNG propios y skin y capa de la cuenta de Microsoft (menú Jugar, después de Mundos) |
| `#/clips` | Clips y capturas: capturas, clips y grabaciones de todas las instancias, visor, editor y compartir (menú Jugar, después de Mundos) |
| `#/music` | Música: lo que suena, controles, volumen de la app y ajustes (menú Jugar, después de Skins) |
| `#/rewards[/<achievements, shop, invite, history o premium>]` | Venus Points: premio diario, invitaciones, logros, tienda, historial y Venus Premium (menú Jugar, después de Música) |
| `#/modrinth` · `#/modrinth/<instanceId o ->/<tipo>[/<serverId>]` | Catálogo; filtrado para una instancia o servidor. Tipos: `mod`, `modpack`, `shader`, `resourcepack`, `datapack`, `plugin` |
| `#/modrinth/project/<id-o-slug>` · `#/modrinth/curseforge/<id>` | Detalle de un proyecto |
| `#/smartsearch[/<consulta>]` | Buscador inteligente (con consulta, la busca sola) |
| `#/multiplayer[/<featured, saved, friends o search>[/<dirección>]]` | Multijugador |
| `#/servers` · `#/server/<id>[/<pestaña>]` | Servidores locales. Pestañas: `console`, `players`, `properties`, `rules`, `world`, `addons`, `network`, `settings` (proxies: `console`, `proxy`, `addons`, `network`, `settings`) |
| `#/voice[/<rooms, audio o game>]` · `#/voice/join/<código>` | Voice Chat · Entrar a una sala (pide la contraseña si hace falta) |
| `#/messages[/<userId>]` | Mensajes (chat con ese amigo) |
| `#/stats[/<launcher, ingame, places o achievements>]` · `#/stats/world/<instanceId>/<carpeta>` | Estadísticas · Detalle de un mundo |
| `#/performance` | Rendimiento |
| `#/achievements` | Logros, misiones y logros de Minecraft |
| `#/pass` | Venus Pass: temporada, niveles, pistas y ediciones ([venus-pass.md](venus-pass.md)) |
| `#/communities` | Comunidades (canales, roles, permisos, GIFs, bienvenida); la página y la pestaña de Administración reemplazan a `#/clans` |
| `#/admin` | Panel de administración. Solo existe para los administradores: la registra `features/admin.js` después de `admin:me` (para el resto no hay ítem de menú ni ruta). Guía: [admin.md](admin.md) |
| `#/settings[/<sección>[/<ancla>]]` | Ajustes (abajo) |
| `#/welcome` | Bienvenida (obligatoria hasta terminarla) |

Ajustes: secciones `general`, `appearance`, `ingame` (En el juego: overlay, grabación y música), `a11y`, `cloud`, `privacy`, `ai`, `plan`, `java`, `storage`, `data`, `about` (una desconocida abre `general`). Alias: `account`, `accounts`, `venus`, `nube`, `cuenta` → `cloud`; `language`, `idioma` → `general`; `accessibility`, `accesibilidad` → `a11y`; `theme`, `apariencia` → `appearance`; `claude`, `ia`, `assistant`, `mcp` → `ai`; `plans`, `planes`, `billing`, `subscription`, `suscripcion` → `plan`; `discord`, `privacidad`, `notify`, `avisos` → `privacy`; `overlay`, `juego`, `game`, `music`, `musica`, `spotify`, `capture`, `clips`, `capturas` → `ingame`; `themes`, `temas` → `appearance`; `premium` → `plan`; `downloads`, `descargas` → `storage`; `cache`, `datos`, `folder` → `data`; `updates` → `about`. Anclas (llevan a la tarjeta y enfocan su campo): `general/language`, `general/play`, `cloud/accounts`, `cloud/venus`, `privacy/activity`, `privacy/discord`, `ai/status`, `ai/mcp`, `ai/mcpservers`, `ai/privacy`, `plan/plans`, `plan/premium`, `ingame/overlay`, `ingame/capture`, `ingame/music`, `appearance/themes`, `privacy/notify`, `java/venus`, `java/system`, `java/versions`, `storage/downloads`, `storage/schedule` (Descargas programadas), `storage/services` (Estado de los servicios), `storage/disk`, `data/folder`, `data/cache`, `data/portable`. Para mandar a resolver algo: `settings/cloud` (sin sesión de Venus), `settings/plan` u `openPlans()` de `features/plans.js` (sin plan, cuota agotada o para cambiar de plan), `settings/ai` (IA desactivada). Ajustes no tiene campos para claves, proyectos de Supabase ni servidores: Discord, TURN y bore usan lo que trae el launcher (`core/app-config.js`); CurseForge también admite la configuración central, restringida al panel de Administración.

**Rutas de 4.5.0 y 4.6:** `#/communities`. `#/compete`, `#/clans`, `#/seeds`, `#/extensions` y `#/tools` ya no existen. Las nuevas herramientas de instancias, servidores, Rendimiento, Clips y Ajustes se integran en sus páginas existentes. `#/achievements/minecraft` (y cualquier pestaña que no exista) abre `#/achievements/list`. La PWA vive en `/app/` del sitio web y no es una ruta del router de Electron.

### 6.6 Señales entre amigos (`social.sendSignal` / `social.onSignal`)

Viajan por el buzón privado `inbox:<userId>` con la RPC `social_send_signal`: solo entre amigos aceptados, el servidor pone el remitente, el tipo cumple `^[A-Za-z_][A-Za-z0-9_.:-]{0,39}$` y el `payload` es un objeto de hasta 4 KB. Los tipos que empiezan con `_` son internos de social (por ejemplo `_typing`).

| Tipo | Payload | Manda · Recibe |
|---|---|---|
| `voice-invite` | `{ room, name }` | `voice.inviteFriend` · `voice.js` (emite `'invite'` y `app.js` muestra el aviso) |
| `pack-invite` | `{ code, name, group, mcVersion, loader }` | Diálogo Compartir · `share.startup()` |
| `join-world` | `{ address, kind: 'world' o 'server', name, mcVersion, loader, from, fromMc }` | `openWorldToFriends` y `serverNetPanel` · `netplay.startup()` (social no la muestra por su cuenta) |
| `party-invite` · `party-accept` · `party-decline` · `party-leave` · `party-kick` · `party-ready` · `party-state` · `party-play` · `party-end` | `{ v: 1, party, ... }` (forma de cada una en [grupos.md](grupos.md); las valida `features/party/logic.js` → `parseSignal`) | Líder ↔ miembros e invitados · `party.startup()` |
| `media-share` | `{ url, kind: 'screenshot' o 'clip', name }` (solo links https firmados del Storage del proyecto) | Visor de Clips → **A un amigo** · `capture.startup()` (aviso con **Ver**) |

**Señales nuevas:** el soundboard usa el canal de voz existente; sus mensajes y topes están en [Mensajes y voz](implementacion/mensajes-voz.md). 0035 conserva la señal `media-share` y además registra los clips recibidos para la PWA. Los avisos `compete-update` y `clan-update` se retiraron.

### 6.7 Reglas transversales

- **Errores entre procesos.** Un handler lanza `Error` con el mensaje ya traducido. Si además tiene `err.code` (texto o número estable), `ipc.js` lo manda como `{ ok: false, error, code }` y el preload lo vuelve a poner en el `Error` que lanza `api.invoke` (y los atajos como `api.instances.launch`). Comparar siempre por `err.code`, nunca por el texto (cambia con el idioma). Ejemplos: `'blocked'` (un chequeo previo impidió jugar), los códigos de la IA (abajo) y los de `VoiceError`.
- **IA: códigos de error.** `modules/ai.js` lanza errores con `err.code`: `unavailable` (IA desactivada, sin nube o sin sesión), `session` (sesión vencida), `noplan` (la cuenta no tiene un plan pago), `plan` (el plan no incluye ese modelo o ese esfuerzo: elegir otro), `quota` (preguntas o presupuesto del plan agotados), `ratelimit` (demasiados pedidos o servicio saturado), `backend` (el servicio de IA no responde bien; el detalle va a la consola), `refused` (la IA rechazó el pedido), `network` y `error`. Ya no existe `key` (no hay API key propia). Una respuesta cortada o un JSON inválido en `ai.text`/`ai.json` llegan sin código (tratalos como `error`), y cancelar con `signal` lanza el `AbortError` de siempre. Con `unavailable` o `session`, ofrecé ir a `settings/cloud` o `settings/ai`; con `noplan` o `quota`, mostrá los planes (`openPlans()` de `features/plans.js` o `settings/plan`; la cuota llega también con el evento `ai:quota`).
- **IA: regla del `turnId`.** Todas las llamadas que salen de **una sola acción del usuario** tienen que usar el mismo `turnId` (un id único por acción, por ejemplo armado con `uid()` de `core/util`): el backend cuenta una sola consulta por `turn_id` (hasta `max_calls_per_turn` llamadas del plan). Llamadas sin `turnId` cuentan como consultas separadas. Hoy lo cumplen el asistente (un `turnId` por pregunta) y la traducción de mods (uno por ejecución); el Buscador inteligente todavía pide el plan y las explicaciones sin `turnId`, así que una búsqueda con IA cuenta como dos consultas. Siempre `ai.available()` antes y un camino sin IA.
- **Partidas silenciosas.** `game.start(id, { ..., quiet: true })` es para lanzamientos que no son partidas del jugador, como las pruebas de la búsqueda del culpable de un crash (hoy `modules/crash/runner.js` todavía las lanza solo con `skipChecks: true`, sin `quiet`): no se registran en estadísticas ni suman tiempo jugado ni partidas, y los eventos `state`, `session` y `activity` llevan `quiet: true` (al cerrar, `activity` llega como `(id, null, { quiet: true })`; `game.status()` también marca `quiet`). Con esa marca, `app.js` no muestra los avisos de juego iniciado o cerrado ni el diálogo de crash, y `main.js` no minimiza, no oculta ni vuelve a mostrar la ventana. Los módulos que escuchan `activity` o `session` (estadísticas, mundos, Discord, amigos) pueden usar esa marca para no contar esas pruebas.
- **Memoria de cada partida.** Un chequeo de `addBeforeLaunch` puede devolver `{ memory: { min, max } }` (MB) para elegir la memoria de esa partida. Se usa solo si la instancia no tiene memoria propia (`instance.memory.override`); si varios chequeos devuelven memoria, gana el último, y si `min` falta o no sirve se usa como mucho 1024. Así trabaja la memoria automática de performance (`memoryMode: 'auto'`). Los chequeos reciben una copia de los ajustes, así que un `settings.memory = ...` viejo tampoco se guarda.
- **Tareas y botón Jugar.** Una tarea con `meta.instanceId` hace que `store.taskFor(instanceId)` la devuelva: Inicio, Versiones y la instancia la muestran como "preparando" y deshabilitan Jugar. Una tarea en segundo plano que no impide jugar puede asociarse igual a la instancia con `meta: { instanceId, background: true }` (o `blocksPlay: false`): se ve en el panel de tareas y `taskFor` la ignora. Para servidores, `meta.serverId`. Algunas tareas de fondo usan su propio meta sin `instanceId` (análisis: `{ kind: 'analysis:*', analysisTarget }`; mapas: `{ mapviewer: { ... } }`; traducciones: `{ kind: 'modtranslate', modtranslateInstance }`; importación del launcher oficial: `{ kind: 'mcimport' }`).
- **Enlaces duros: reemplazar siempre de forma atómica.** storage puede unificar archivos repetidos con enlaces duros (`<datos>/store/<aa>/<sha1>`) y snapshots enlaza `.jar`/`.zip` en su almacén. Un mismo archivo puede estar en varias instancias: **nunca** escribir sobre una ruta existente de `mods/`, `resourcepacks/`, `shaderpacks/`, `plugins/` o `config/` con `copyFile` o `writeFile`, porque cambiaría en todas. Usá los ayudantes de `modules/packs/safety.js`: `writeFileAtomic(dest, datos)`, `copyFileAtomic(src, dest)`, `moveFile(src, dest)` y `replaceFile(tmp, dest)` escriben un temporal en la misma carpeta y lo renombran encima. En Windows un `.jar` compartido con una instancia abierta no se puede borrar ni reemplazar: `isLockError(err)` e `isSharedFile(ruta)` detectan ese caso para mostrar un mensaje que pida cerrar el juego.
- **Carpeta interna `.venus/` de cada instancia** (7.4): es de Venus, no del juego. Exportar, compartir o sincronizar en la nube una instancia nunca incluye `.venus/` ni `venus-instance.json`, e importar un pack nunca puede escribir ahí (`safety.safeRelPath` y `safety.resolveInside` lo rechazan). Duplicar una instancia sí copia `.venus/`, salvo el arranque rápido, el Deshacer del asistente y las carpetas temporales. Un módulo nuevo que guarde datos por instancia usa `.venus/<modulo>...` y respeta esta regla.
- **Destructivo = papelera.** Borrar mundos, mods o capturas va a la papelera (`shell.trashItem`) después de `confirmDialog` (en `instances.deleteFile`, si la papelera falla, un mod se borra igual pero un mundo o una captura no). Excepciones a propósito: la limpieza de storage (contenido que se vuelve a descargar) y los sobrantes al restaurar una instantánea (quedan en la instantánea automática "Antes de restaurar").
- **Metadatos de la instancia** (`venus-instance.json`): `memory { override, min, max }`, `java { path, args, preset }`, `window { override, ... }`, `modrinth { projects, pack }` (archivos instalados desde Modrinth y modpack de origen; también se lee `pack`), `curseforge { projects, pack }`, `share { packId, code, name, revision, role, isGroup, auto, owner, ownerName, syncedAt, opts }` y `mcimport { from: 'official', dir, profile, profileName, at }` (instancias creadas al importar del launcher oficial: carpeta de origen y clave del perfil; da la marca «Ya importado»). Se cambian con `instances.update` (o `api.instances.update`), que escribe en serie. Desde la 3.1 se suman `cover`, `coverAt`, `tags`, `favorite` y `notes` (carátula, etiquetas, favorito y notas), que `core/instances.update` valida con `modules/instancemeta/meta.js`: campos y reglas en 7.5.

**Venus Pass** (`features/pass.js`, `pages/pass.js`, `pages/pass/logic.js`, sin módulo propio en el principal)

- Todo va por RPC de `0026_venus_pass.sql` con el backend de Venus Points (`pages/rewards/backend.js`): `pass_me()`, `pass_playtime(p_minutes)` (1 a 30 por llamada; el launcher reporta cada 5 minutos de juego con `game:state`), `pass_claim(p_level, p_track)` y `pass_claim_all()`. Administración: `admin_pass_seasons`, `admin_pass_season_save`, `admin_pass_rewards`, `admin_pass_reward_set`, `admin_pass_grant`.
- La compra usa `billing:checkout({ plan: 'pass_<edición>', provider })` y el evento `billing:changed` llega con `kind: 'pass'`. `billing:catalog` trae `pass` (temporada activa y precios por edición).
- Estado compartido: `getPass()`, `onPass(fn)`, `loadPass({ force })`; el punto del menú (`setNavBadge('pass')`) aparece con premios sin reclamar. Capturas: `VENUS_REWARDS_FAKE` (`pages/pass/fake.js`).

**updater** (`modules/updater.js`, `updater/controller.js`)

- `updater:status`, `updater:check`, `updater:install` y el evento `updater:state`. Estados: `idle`, `checking`, `current`, `available`, `downloading`, `ready`, `installing`, `error`, `disabled`. La instalada usa electron-updater. La portable no se puede reemplazar sola: lee `latest.yml` de la última release, pasa a `available` y `features/update-notice.js` avisa una vez por versión (`settings.updater.noticed`), con `downloadUrl` para bajarla. Las dos buscan solas solo con `privacy.autoUpdates`.

**wallpapers** (`modules/wallpapers.js`)

- Los fondos animados no van en el paquete (`!src/renderer/assets/wallpapers/*.mp4`). `wallpapers:status()` → `{ [id]: { size, path } }`; `wallpapers:ensure(id)` → `{ path }`, con el evento `wallpapers:progress { id, percent }`. Los baja a `cache/wallpapers` desde la página de fondos, con GitHub de respaldo, y comprueba el SHA-256 de `wallpapers/videos.json`. Si se cambia un video: `node scripts/gen-wallpaper-videos.js --verify`, después de subirlo a la página.

**Permisos y operaciones de 4.5.0.** `core/permissions.js` valida las páginas locales autorizadas con `isAppPage(url, file)` e `isPermissionRequester(wc, details, file)`. Los handlers directos de `main.js` y `capture/host.js` exigen la página solicitante esperada, rechazan subframes y solo usan `wc.getURL()` como alternativa cuando `details.isMainFrame === true`. La captura de pantalla comprueba también identidad y URL del marco solicitante. `extensions.js` ya no envuelve esos handlers mediante `denyPermissions` / `session-created`.

El inicio remoto se serializa por servidor y puede cancelarse antes de terminar; la sesión/token se vuelve a comprobar después de esperas antes de ejecutar una orden o entregar estado. Importar una transferencia calcula espacio sobre las entradas seleccionadas y validadas del archivo, incluyendo metadatos y ajustes. El código histórico de Extensiones fijaba una caducidad de 15 minutos para paquetes inspeccionados; ese módulo ya no se carga. Las regresiones locales benignas no certifican aislamiento completo ni reemplazan pruebas de integración reales.

El registro de `venus://` se mantiene también en portable por decisión del dueño. Al desinstalar, `build/installer.nsh` compara `shell/open/command` con el ejecutable de esa copia antes de quitar la clave; no la borra al actualizar ni si apunta a otra instalación o portable. El cambio está en código: compilación y prueba NSIS pendientes. La explicación de conexiones incluye wiki; Discord y sincronización conservan sus controles propios. La retirada de Extensiones desactiva las consultas de catálogo y blocklist, aunque sus preferencias anteriores sigan guardadas. [Alcance de la retirada](retirada-funciones.md).

### 6.8 Buscador inteligente y CurseForge (4.6)

Vocabulario ampliado (datos, no código):

El intérprete local (`modules/smartsearch/interpreter.js`) ahora carga un **vocabulario ampliado como datos** en `modules/smartsearch/vocab/`; `lexicon.js` lo aplica al final sin pisar nada de lo que ya tenía. **Para entrenarlo con palabras nuevas se edita un archivo de esa carpeta**, no el código:

| Archivo | Qué agrega |
|---|---|
| `types.js` | sinónimos de tipos (modpack, resource pack, shader, data pack, plugin, mod), negaciones ("ni", "evitar", "no necesito"…), cantidades con letras ("cinco mods") |
| `loaders.js` | alias de cargadores, motores de shaders, software de servidor y "sin mods" |
| `modes.js` | modo de juego (servidor propio, con amigos, "mis amigos y yo", solo, sin conexión) y hardware (PC de papa, 4 GB de RAM, PC potente) |
| `themes.js` | sinónimos de 20 temas existentes y **27 temas nuevos**: mapas de aventura, pixel art, low poly, minimalista, futurista, steampunk, retro, gótico, neón, acuarela, moderno, recetas (JEI), encantamientos, aldeanos, progresión/habilidades, supervivencia (sed, temperatura), minerales, flora, agua, cielo, iluminación, fuentes, idioma, accesibilidad, emotes, cosméticos, modelos 3D |
| `words.js` | traducciones es/pt a inglés de 278 sustantivos sueltos |
| `typos.js` | 251 errores de escritura frecuentes y corrección difusa (Damerau-Levenshtein) contra el vocabulario propio |
| `similar.js` | "como X": 58 proyectos y juegos conocidos (Sodium, OptiFine, Create, Botania, Terralith, Hypixel, Terraria, Skyrim, RLCraft…) con los temas que representan |
| `versions.js` | rangos ("1.18 a 1.20", "1.19 o superior", "hasta la 1.16", "1.20.x", "1.19+") y apodos de actualizaciones ("nether update", "caves and cliffs") |

Idiomas: español, inglés y portugués, que son los que ya tenían diccionario. Los otros idiomas del launcher no tenían y no se agregaron.

Cambios en el intérprete (`interpreter.js`): corrige errores de escritura y resuelve apodos de versión antes de leer; elige una versión concreta dentro de un rango (`versionNote` avisa de dónde salió); cantidades con letras; "como X" (se detecta antes que los cargadores: "como sodium" no es el motor de shaders); y **las negaciones ya no pasan por encima de otro tipo** ("sin shaders, solo mods" excluye los shaders, no los mods; "que no explote con shaders" pide shaders).

### Medición (antes y después)

Corpus de 509 frases (49 tipos, 30 cargadores, 36 versiones, 107 géneros, 26 hardware, 51 estilos, 42 mecánicas, 41 "como X", 60 con errores de escritura, 31 oraciones completas, 16 que no deben despertar ningún tema y 20 que ya se entendían); `test/corpus.js`. Se mide con `node src/main/modules/smartsearch/test/score.js [carpeta-del-interprete-anterior] [--heldout] [--fails]`.

| Conjunto | Antes (commit anterior) | Después |
|---|---|---|
| Corpus de 509 frases | **44,2 %** (225/509); 56,7 % de los campos | **100 %** (509/509) |
| Frases "a ciegas" (89, escritas con el vocabulario ya congelado) | **66,3 %** (59/89) | **91,0 %** (81/89) en la primera pasada; 100 % después de entrenar con lo que falló |
| Frases que ya se entendían (20) | 90 % | 100 % (se arregló una negación mal leída) |

El 91,0 % a ciegas es la cifra honesta de generalización; el 100 % del corpus incluye lo que se entrenó viéndolo. Las 8 frases que fallaron en la primera pasada se agregaron como vocabulario ("muestre las recetas", "compras y ventas", "streamers", "mis amigos y yo", "alternativa liviana a", "para arriba", modpacks conocidos, "no" suelto que niega solo lo que tiene al lado).

Pruebas: `node --test src/main/modules/smartsearch/test/interpreter.test.js` (19: corpus y piso, vocabulario válido —todas las expresiones compilan, categorías de Modrinth reales, temas existentes, sin palabras demasiado genéricas—, errores de escritura, versiones, negaciones, cantidades, "como X" y planes completos).

#### La IA solo de pago, con una sola fuente

Interruptor **"Usar IA para entender la búsqueda"** en los filtros de la página (y el cartel del encabezado, ahora "IA activada · Venus IA" o "Buscador normal").

Reglas (`modules/smartsearch/ai-source.js`, lógica pura):

1. **Solo con plan de pago de Venus IA.** Sin plan, sin sesión, con la IA apagada en Ajustes o si no se pudo comprobar el plan, el interruptor se ve apagado y deshabilitado con la explicación y el botón que corresponde (**Ver planes**, **Iniciar sesión**, **Comprobar de nuevo**, **Abrir ajustes de IA**). El buscador normal sigue funcionando igual.
2. **Una sola fuente a la vez.** Con plan hay hasta dos: **Venus IA** (el backend, gasta la cuota del plan) y **Claude Code o Codex de esta PC** (la IA propia de la persona, no gasta la cuota de Venus IA; se ofrece con plan **Go o superior**, la app instalada y con sesión iniciada: el mismo control que los motores del Asistente). Si hay las dos, se muestra un grupo de opciones y se elige una; nunca las dos. Con una sola, no hay nada que elegir.
3. **Aviso de privacidad** antes de mandar lo que escribe a un proveedor, una vez por fuente (qué se envía —lo que escribe hasta 400 caracteres, versión, loader y los títulos y descripciones públicos de los resultados—, qué no —cuenta de Minecraft, mundos, archivos, nombres de instancias— y el destino). Se guarda con la hora. Cambiar de fuente con la IA prendida pide el aviso de la otra; sin aceptarlo queda apagada.
4. **Sin plan o sin conexión cae al buscador normal**, con un aviso en el resultado (`aiNoPlan`, `aiSignedOut`, `aiPlanUnknown`, `aiDisabled`, `aiNeedsConsent`, `aiOffline`, `aiFailed`). Lo comprueba el proceso principal en cada búsqueda: la interfaz sola no alcanza.
5. La IA es opt-in: por defecto apagada. Quien tenía `useAi: true` de versiones anteriores (se guardaba sin avisar) queda apagada hasta aceptar el aviso.

IA local (`modules/smartsearch/local-ai.js`): lanza el `claude` o el `codex` tal cual lo instaló la persona, **sin herramientas** (Claude Code con `--tools ""`, `--setting-sources ""`, `--strict-mcp-config` sin servidores, un solo turno; Codex con caja de arena de solo lectura y sin shell), sin tocar sus credenciales, y devuelve solo un objeto JSON. **No se probó con el Claude Code ni el Codex reales**, solo con un CLI falso que imita su salida (`test/fixtures/fake-search-cli.js`); las banderas son las mismas que ya usan los motores del Asistente.

### Archivos, canales y ajustes

- Proceso principal: `modules/smartsearch.js` (`aiView`, `runnerFor`, canales), `smartsearch/ai-source.js`, `smartsearch/local-ai.js`, `smartsearch/ai-plan.js` (acepta quién responde), `smartsearch/fake.js` (modo falso para capturas).
- Canales IPC nuevos: `smartsearch:ai({ refresh? })` (estado de la IA) y `smartsearch:aiSet({ useAi?, source?: 'venus' | 'local', consent?: true })` (prender, elegir fuente, aceptar el aviso; el proceso principal vuelve a comprobar el plan). Cambian: `smartsearch:context` devuelve `ai` como objeto (`plan`, `planName`, `sources`, `choose`, `source`, `consent`, `wants`, `active`, `needsConsent`) y `smartsearch:savePrefs` ya no guarda la IA.
- Ajustes: `settings.smartsearch.prefs.{ useAi, aiSource, aiConsent: { venus, local } }` (por defecto apagada, sin aviso aceptado).
- Modo falso para capturas (solo con `VENUS_DEVSHOT`, nunca empaquetado): `VENUS_SMARTSEARCH_AI_FAKE=paid|both|basic|none|signedOut|unknown|disabled`.
- Pruebas: `node --test src/main/modules/smartsearch/test/ai.test.js` (22: planes, solo de pago, aviso, una sola fuente, plan Go para la local, motor preferido, IA local con CLI falso —argumentos sin herramientas, errores, tiempo, cancelación—, y el proceso principal completo con dobles: sin plan no se llama a la IA, sin aviso no se manda nada, con plan y aviso se usa Venus IA, sin conexión cae al buscador normal, con la fuente local no se toca Venus IA).

#### Límites

- La causa exacta del 403 del 5 de noviembre depende de lo que conteste CurseForge; hasta desplegar la función nueva no hay forma de saber si fue la clave o un bloqueo (arriba).
- La línea de CurseForge del panel de estado de servicios solo prueba que el servidor de Venus responde, no que la clave sirva (no se tocó `svcstatus`).
- "Como X" solo entiende proyectos de la lista de `similar.js`; "como un modpack que no conozco" no lo trata como referencia (se agrega una línea).
- La fuente local (Claude Code/Codex) solo se probó con un CLI falso.

El arreglo de CurseForge (clasificación `badkey` / `blocked` / `denied` en la función `curseforge`, estados `on` / `off` / `unknown` en `modules/curseforge/cloud.js`) está en [curseforge.md](curseforge.md).

### 6.9 Soporte (4.6)

Servidor: `0045_soporte_mejoras.sql` (aplicada), que parte de las funciones desplegadas (0016 + 0017), conserva firmas y mensajes en español (los launchers viejos siguen andando) y suma campos al JSON y un `hint` legible por máquina. `support_create_ticket` sigue cerrada como la dejó la 0017 y Soporte nunca activa un plan.

| Parte | Archivos |
|---|---|
| Páginas | `pages/support.js`, `pages/support-staff.js`, `pages/admin/support.js` (usa `ticketDesk({ admin: true })`) |
| Fachada | `features/support.js` (conserva `S`, `supportCall`, `CATEGORIES`, `isPendingTicket`, `ticketStatus`, `ticketDesk`), `features/support-staff.js` (acceso del equipo; también arranca el aviso) |
| Interfaz | `features/support/`: `logic.js` (lógica pura), `common.js`, `form.js`, `thread.js`, `desk.js`, `staffbar.js`, `media.js`, `diagnostic.js`, `faq.js`, `notify.js`; estilos `styles/pages/support.css` (prefijo `sp-`) |
| Proceso principal | `modules/support.js` y `modules/support/`: `client.js`, `rules.js`, `redact.js`, `diagnostics.js`, `images.js`, `fake.js` |
| Servidor | `0045`, `supabase/tests/soporte-local.sql` (156 comprobaciones en `BEGIN … ROLLBACK`) y `scripts/run-support-local.ps1` |

- **Tablas y bucket.** Columnas nuevas de `support_tickets` (prioridad, asignación, detalles, diagnóstico, marcas de último mensaje, vista, valoración y reaperturas) y los temas `game` y `suggestion`; `support_attachments` (legible por la dueña y el equipo con RLS), `support_notes` y `support_macros` (RLS sin ninguna política: solo se tocan por las funciones); bucket privado `support-attachments` (4 MiB; PNG, JPEG y WebP; ruta `<quien sube>/<consulta>/<uuid>.<ext>`, sin UPDATE ni DELETE). El tamaño y el tipo de una captura salen de lo que Storage guardó, no de lo que dice el cliente.
- **Límites que pone el servidor.** 3 consultas abiertas por persona y 5 nuevas por día; mensajes: 10 por minuto, 150 por día (el equipo no tiene el diario) y 500 por consulta; asunto de 3 a 120, mensaje de 1 a 4000, nota de 2000 y diagnóstico de 12000 caracteres; capturas: 3 por envío, 12 por consulta, 15 por día y 60 archivos por persona (15 por consulta); reabrir dentro de 14 días del cierre y hasta 3 veces (el equipo no tiene esos topes); diagnóstico agregado después, uno cada 30 s; 40 respuestas guardadas por integrante y 100 notas por consulta (20 por minuto); la cola da 100 filas por página con filtros validados contra listas. Con baneo de Auth no se usa ninguna función de Soporte; con baneo solo de moderación se puede leer y responder en una consulta ya abierta, pero no abrir, reabrir, valorar ni adjuntar. El silencio del chat no afecta a Soporte. Cuando quien atiende es también la dueña de la consulta, sus mensajes se guardan como de la persona.
- **Datos locales.** Solo `localStorage`: `venus.support.draft.<usuario>`, `venus.support.reply.<usuario>.<consulta>`, `venus.support.notify` (aviso de respuestas, `1` o `0`) y `venus.support.queue` (estado y orden de la cola del equipo). El aviso consulta `support_unread_summary` cada 3 minutos con la ventana visible.
- **Decisiones.** El formulario detecta un número de tarjeta (Luhn) en asunto, mensaje y campos y no deja enviarlo (el servidor no lo comprueba). El diagnóstico lo arma el proceso principal y lo vuelve a pasar por el anonimizador antes de enviarlo (reutiliza el del asistente y suma rutas de cualquier disco, chat y nombres del registro). No se hizo: adjuntar capturas desde el panel de administración, borrar capturas ya enviadas, avisar al equipo de consultas nuevas ni borrar archivos huérfanos de Storage.
- **Pruebas y capturas.** `node --test "src/main/modules/support/test/*.test.js"` (48) y `node --test "src/renderer/js/features/support/test/*.test.js"` (25). Modo falso solo con `VENUS_DEVSHOT`: `VENUS_SUPPORT_FAKE=customer|staff|empty`.
- **Orden de despliegue.** Aplicar la 0045 y publicar el launcher; sin ella, las consultas de los temas de siempre siguen yendo por `support_open_ticket` y lo demás avisa que el servidor no tiene activada esa parte.

## 7. Dueños, ajustes y archivos de datos

### 7.1 Dueños de archivos

| Módulo | Archivos propios | Textos (ns) | Migración |
|---|---|---|---|
| onboarding | `pages/welcome.js`, `styles/pages/welcome.css`, `core/accounts.js` | welcome · main: accounts | — |
| home | `pages/home.js` (+ `pages/home/logic.js`, `pages/home/layout.js` para el Inicio armable con pruebas en `pages/home/test/`), `styles/pages/home.css` | home | — |
| stats | `pages/stats.js` (+ `pages/stats/`), `styles/pages/stats.css`, `core/stats.js`, `modules/statsplus.js` (+ `modules/statsplus/`) | stats · main: stats | — |
| performance | `pages/performance.js`, `features/perf.js`, css, `modules/perf.js` (+ `modules/perf/`), `modules/catalog.js`, `core/launch.js`, `core/java.js` | performance, perf · main: perf, catalog, java | — |
| versions | `pages/versions.js` (+ `pages/versions/`), `pages/instance.js` (+ `pages/instance/`), css, `core/minecraft.js`, `core/instances.js`, `core/loaders/*` | versions, instance · main: instances, minecraft, loaders | — |
| modrinth | `pages/modrinth.js` (+ `pages/modrinth/`), `features/install.js`, `features/searchfilters.js` (compartido con smartsearch), css, `core/modrinth.js`, `core/search-filters.js`, `modules/curseforge.js` (+ `modules/curseforge/`) | modrinth, install, searchfilters · main: modrinth, curseforge | — |
| smartsearch | `pages/smartsearch.js`, css, `modules/smartsearch.js` (+ `modules/smartsearch/`) | smartsearch (+ searchfilters) · main: smartsearch | — |
| compat | `features/compat.js`, css, `modules/compat.js` (+ `modules/compat/`) | compat · main: compat | — |
| servers | `pages/servers.js`, `pages/server.js` (+ `pages/servers/`), css, `core/servers.js`, `core/server-properties.js`, `modules/serverx.js` (+ `modules/serverx/`) | servers, server · main: servers | — |
| netplay | `features/netplay.js`, css, `modules/netplay.js` (+ `modules/netplay/`) | netplay · main: netplay | — |
| multiplayer | `pages/multiplayer.js`, `features/serverlist.js`, css, `modules/serverlist.js` (+ `modules/serverlist/`, con `featured.json`) | multiplayer · main: serverlist | 0006 |
| social | `js/social.js` (+ `js/social/`), `pages/messages.js`, css | messages, social | 0002 |
| voice | `js/voice.js` (+ `js/voice/`), `pages/voice.js`, css | voice | 0003 |
| crash | `features/crash.js`, css, `modules/crash.js` (+ `modules/crash/`, pruebas en `crash/test/`) | crash · main: crash | — |
| snapshots | `features/snapshots.js`, `features/packs.js`, css, `modules/snapshots.js` (+ `modules/snapshots/`), `modules/packs.js` (+ `modules/packs/`) | snapshots, packs · main: snapshots, packs | — |
| share | `features/share.js`, `features/cloudsync.js`, css, `modules/share.js` (+ `modules/share/`), `modules/cloudsync.js` (+ `modules/cloudsync/`) | share, cloudsync · main: share, cloudsync | 0004 |
| storage | `features/storage.js`, css, `core/http.js`, `modules/storage.js` (+ `modules/storage/`) | storage · main: storage | — |
| analysis | `features/analysis.js`, css, `modules/security.js`, `modules/mixins.js`, `modules/jarscan/` | analysis · main: analysis | — |
| worlds | `pages/worlds.js` (+ `pages/worlds/`), css, `modules/worlds.js` (+ `modules/worlds/`) | worlds · main: worlds | 0005 |
| mapviewer | `features/worldmap.js`, css, `modules/mapviewer.js` (+ `modules/mapviewer/`) | worldmap · main: mapviewer | — |
| discord | `features/discord.js`, `modules/discord.js` (+ `modules/discord/`) | discord · main: discord | — |
| modtranslate | `features/modtranslate.js`, css, `modules/modtranslate.js` (+ `modules/modtranslate/`) | modtranslate · main: modtranslate | — |
| a11y | `js/a11y.js` (+ `js/a11y/`), `js/appearance.js`, `styles/a11y.css` | a11y, appearance | — |
| settings | `pages/settings.js` (+ `pages/settings/`), `styles/pages/settings.css` | settings | — |
| achievements | `pages/achievements.js` (+ `pages/achievements/`: `catalog.js`, `names.js`; sin pestaña Minecraft), `features/achievements.js`, `features/missions.js`, css, `modules/achievements.js` | achievements | — |
| assistant | `pages/assistant.js`, `features/assistant.js`, `features/mcpservers.js` (+ `styles/features/mcpservers.css`), css, `modules/assistant.js` (+ `modules/assistant/`, con `mcp-servers.js`), `docs/asistente-ia.md` | assistant · main: assistant | — |
| assistant-backend | `supabase/functions/ai-assistant/`, `supabase/functions/README.md`, `docs/backend-ia.md` | — | 0007, 0008, 0011 |
| billing | `features/plans.js`, `styles/features/plans.css`, `modules/billing.js` (+ `modules/billing/`: `client.js`, `fake.js` para capturas, pruebas en `billing/test/`), `supabase/functions/billing/`, `supabase/functions/stripe-webhook/`, `docs/pagos.md` | plans · main: billing | 0009 |
| admin | `features/admin.js`, `pages/admin.js` (+ `pages/admin/`), `styles/pages/admin.css`, `modules/admin.js` (+ `modules/admin/`, pruebas en `admin/test/`), `supabase/functions/admin/`, `docs/admin.md` | admin · main: admin | 0012 |
| mcp | `features/mcp.js`, `styles/features/mcp.css`, `modules/mcp.js` (+ `modules/mcp/`, con el cliente MCP `client.js` que usa el asistente; pruebas en `mcp/test/`), `docs/mcp.md` | mcp · main: mcp | — |
| recap | `features/recap.js` (+ `features/recap/card.js`), `styles/features/recap.css`, `modules/recap.js` (+ `modules/recap/`: `aggregate.js`, `collection.js`, `image.js`; pruebas en `recap/test/`) | recap · main: recap | — |
| skins | `pages/skins.js` (+ `pages/skins/`: `model.js`, `texture.js`, `viewer.js`, `parts.js`), `styles/pages/skins.css`, `modules/skins.js` (+ `modules/skins/`: `png.js`, `api.js`, `library.js`, `service.js`, `fake.js` para capturas; pruebas en `skins/test/`) | skins · main: skins | — |
| mcimport | `features/mcimport.js`, `styles/features/mcimport.css`, `modules/mcimport.js` (+ `modules/mcimport/`: `profiles.js`, `versions.js`, `scan.js`, `plan.js`, `runner.js`, `running.js`; pruebas en `mcimport/test/`) | mcimport · main: mcimport | — |
| svcstatus | `features/svcstatus.js`, `styles/features/svcstatus.css`, `modules/svcstatus.js` (+ `modules/svcstatus/`: `services.js` con el catálogo, `probe.js`, `checker.js`, `verdict.js`, `classify.js`, `fake.js` para capturas; pruebas en `svcstatus/test/`) | svcstatus | — |
| ingame | `modules/ingame.js` (+ `modules/ingame/`: `pack.js`, `window.js`, `badge.js`, `badgemod.js`, `mods/*.jar` compilados; pruebas en `ingame/test/`), `mod/venus-badge/`, `scripts/build-badge-mod.js`, `scripts/make-badge-icon.py`, `scripts/make-ingame-assets.py`, `supabase/functions/badge/`, `docs/insignia.md` | ingame · main: ingame | 0019 |
| nowplaying | `pages/music.js`, `features/nowplaying.js`, `styles/pages/music.css`, `styles/features/nowplaying.css`, `modules/nowplaying.js` (+ `modules/nowplaying/`, pruebas en `nowplaying/test/`), `docs/musica.md` | nowplaying · main: nowplaying | — |
| overlay | `modules/overlay.js` (+ `modules/overlay/`, pruebas en `overlay/test/`), `renderer/overlay.html`, `js/overlay/`, `styles/overlay.css`, `features/overlay.js`, `styles/features/overlay.css`, `docs/overlay.md` | overlay · main: overlay | — |
| capture | `modules/capture.js` (+ `modules/capture/`, pruebas en `capture/test/`), `renderer/recorder.html`, `js/recorder/`, `pages/clips.js` (+ `pages/clips/`), `features/capture.js`, `styles/pages/clips.css`, `styles/features/capture.css`, `docs/clips.md` | clips, capture · main: capture | 0005 (y `profile-media` de 0020 por el editor de perfil) |
| perfiles | `social/profile-style.js`, `social/profile-ui.js` (con social), `features/profile-editor.js` (+ `features/profile-editor/`, pruebas en `profile-editor/test/`), `styles/features/profile-style.css`, `styles/features/profile-editor.css`, `docs/perfiles.md`; desde la 3.1, `features/profile-editor/audio.js`, `social/{logic,gifpicker,song,guestbook,gifts,report}.js` (pruebas en `social/test/`), `pages/admin/reports.js`, `styles/features/profile-social.css` | profile (+ claves nuevas de `messages`, `voice` y `rewards`) | 0020, 0027 |
| rewards | `pages/rewards.js` (+ `pages/rewards/`), `features/rewards.js`, `features/premium.js`, `styles/pages/rewards.css`, `styles/features/premium.css`, `modules/rewards.js` (+ `modules/rewards/`, pruebas en `rewards/test/`), `supabase/functions/mcverify/`, `docs/venus-points.md` | rewards, premium · main: rewards | 0020, 0021 |
| party | `features/party.js` (+ `features/party/`, pruebas en `party/test/`), `features/notify.js`, `styles/features/party.css`, `styles/features/notify.css`, `docs/grupos.md` | party, notify | — |
| themes | `features/themes.js` (+ `features/themes/`, pruebas en `themes/test/`), `styles/features/themes.css`, `docs/temas.md` | themes | 0022 |
| skineditor | `pages/skins/editor.js` (+ `pages/skins/editor/`, pruebas en `editor/test/`), `styles/pages/skin-editor.css` | skineditor | — |
| whatsnew | `features/whatsnew.js`, `styles/features/whatsnew.css` | whatsnew | — |
| decor | `features/decor.js` (+ `features/decor/`: `settings.js`, `packs.js`, `cursors.js`, `particles.js`, `sounds.js`, `splash.js`, `panel.js`; pruebas en `decor/test/`), `styles/features/decor.css` | decor | — |
| navcustom | `features/navcustom.js` (+ `features/navcustom/`: `logic.js`, `packs.js`, `icons.js`, `editor.js`, `mini.js`; pruebas en `navcustom/test/`), `styles/features/navcustom.css`, `modules/miniwindow.js`; en `app.js` solo el menú (`navEntries()`, `buildNav` con orden, fijados, ocultos, pack y engranaje, `html[data-mini]`) | navcustom (+ claves nuevas de `nav`) | — |
| instancemeta | `modules/instancemeta.js` (+ `instancemeta/meta.js`, pruebas en `instancemeta/test/`), `modules/shortcuts.js` (+ `shortcuts/args.js`, pruebas en `shortcuts/test/`), `pages/versions/{meta,compare,compare-diff,catalog}.js` (pruebas en `pages/versions/test/`), `pages/instance/{notes,presentation}.js` (con versions) | versions, instance (claves nuevas) | — |
| playcare | `features/playcare.js` (+ `features/playcare/`: `mcnews.js`, `breaks.js`, `breaks-logic.js`, `recap.js`, `schedule.js`; pruebas en `playcare/test/`), `styles/features/playcare.css`, `modules/mcnews.js` (+ `mcnews/`, pruebas en `mcnews/test/`), `modules/downloadschedule.js` (+ `downloadschedule/`, pruebas en `downloadschedule/test/`), `modules/overlay/perf.js` (con overlay) | playcare (+ claves nuevas de `overlay` y `settings`) | — |
| pass | `features/pass.js`, `pages/pass.js` (+ `pages/pass/`: `logic.js`, `fake.js`; pruebas en `pass/test/`), `pages/admin/pass.js`, `docs/venus-pass.md` | pass | 0026 |
| núcleo (compartido) | archivos `[compartido]` de la sección 1, `core/*` sin dueño en esta tabla (entre ellos `core/cloud-defaults.js` y `core/app-config.js`, que completa el dueño antes de compilar), `modules/ai.js`, `0001_base.sql` | common, nav · main: core, ai | 0001, 0010 |

(Rutas relativas a `src/renderer/js/`, `src/renderer/styles/` o `src/main/` según corresponda. "css" = los archivos de `styles/pages/` o `styles/features/` con el nombre de la página o feature. Cada módulo puede crear subcarpetas auxiliares con su nombre.)

**Dueños de 4.5.0:** instancias (`sharedoptions`, `modsets`, `deeplink`, `modchangelog`), datos (`perfhistory`, `family`, `portability` y features de datatools), overlay (`recipes` y paneles), servidores (`serverremote`, `serverdiscord`), social (stickers, traducción, soundboard y efectos), competir/comunidades, clips (`clipstudio`, `clipupload`, `obs`), capas (mod y skins) y PWA (`web/app`, `push-notify`). Las rutas exactas por frente y sus pruebas figuran en [implementacion/](implementacion/README.md). La validación de permisos de navegador pertenece a core/main/capture, no a extensiones.

### 7.2 Claves de ajustes (`data/settings.json`)

Cada módulo lee su clave con sus propios valores por defecto (no hace falta tocar `core/settings.js`). Desde la interfaz: `store.setSettings(patch)`; desde el proceso principal: `settings.set(patch)` (merge profundo). Las claves de versiones viejas (`github`, `autoUpdate`, `peer`, `cloud`, `ai.model`, `ai.provider`, `ai.upgradeUrl`, `netplay.boreHost`, `discord.clientId`, `voice.turn`) se conservan en el archivo pero ya no se usan: el proyecto de Supabase sale de `core/cloud-defaults.js` y las claves y servidores externos de `core/app-config.js`. Lo mismo vale para `music` y `data/music.json`, de la sección Música que se sacó: quedan en disco y nada los lee.

| Clave | Dueño | Contenido |
|---|---|---|
| `language`, `onboarded`, `selectedInstance` | onboarding, settings, home | Código de idioma (o `null` hasta elegirlo), si terminó la bienvenida, instancia elegida |
| `memoryMode`, `memory`, `perf.manualMax` | performance | `'auto'` o `'manual'`; `{ min, max }` en MB (valor manual global); último valor del deslizador manual |
| `jvmPreset`, `jvmArgs`, `priority`, `window`, `afterLaunch`, `openConsoleOnLaunch` | performance, settings | `'auto'`, `'aikar'`, `'zgc'`, `'g1'` o `'none'`; argumentos extra; `'low'`, `'normal'`, `'above'` o `'high'`; `{ width, height, fullscreen }`; `'keep'`, `'minimize'` o `'hide'`; abrir la consola al jugar |
| `ai` | settings, assistant | `{ enabled (true), assistantModel, assistantEffort, engine ('venus'), engineChoice: { claude: { model, effort }, chatgpt: { model, effort } } }` (IA activada; última elección de modelo y esfuerzo del selector del Asistente; motor de las conversaciones nuevas y la elección de modelo y esfuerzo de cada motor externo) |
| `mcp` | mcp | `{ enabled (false), port (18765), clients: { claudeDesktop, claudeCode }, offer: { answered ('connect' o 'later'), app, at } }` (servidor MCP local; `offer` es la respuesta al aviso único de la tarjeta del Asistente; `clients` solo informa qué se registró y cuándo) |
| `assistantMcp` | assistant | `{ servers: [{ id, key (identificador en los nombres mcp__<key>__<herramienta>), name, type ('http' o 'stdio'), url, hasToken, command, args, envKeys, enabled, source ('manual' o 'claudeDesktop'), alwaysAllow (herramientas con "Permitir siempre"), createdAt }] }` (servidores MCP del asistente; los valores del token y de las variables van cifrados) |
| `home.hidden`, `home.layout` | home | Bloques ocultos del Inicio (clave de la 2.x: `quick`, `worlds`, `server`, `friends`, `featured`, `stats`, `screenshots`, `news`, `tips`; se lee solo si no hay `layout`, para no perder lo elegido); `layout = { order: [ids], hidden: [ids], wide: [ids] }` del Inicio armable (3.1): `order` es el orden global, `wide` los bloques a lo ancho (`quick` siempre lo es), los ids desconocidos se descartan y los que faltan en `order` van al final en su orden por defecto. Se guarda con 300 ms de retraso y no toca `home.hidden` |
| `branding` | a11y (lo lee home) | `{ name, subtitle, logo (PNG en data:), logoName, logoPixel, server ('host[:puerto]' de "Tu servidor") }` |
| `appearance` | a11y | `{ accent ('venus', 'mars', 'neptune', 'jupiter', 'earth', 'saturn' o 'custom'), customColor, tint, background ('stars' o 'image'), bgFile, bgDim, bgBlur, music { enabled, file, volume, pauseInGame } }`. Desde la 3.1, además: `palette { bg, surface, text, border, accent }` (cada uno hex o `null` = el de Venus según el tema; se guarda el color elegido y se aplica el corregido si el contraste no llega a 4.5), `scheme ('dark', 'light' o 'auto')`, `autoLightFrom`, `autoLightTo` (horas del automático, hora local), `seasonal (false)`, `seasonalBackup` (`{ season, accent, customColor, background, wallpaperId }` o `null`: lo previo a un tema de temporada, para restaurarlo al salir), `rotation { enabled, ids: [], everyMin (30), onLaunch (true) }`, `playButton { color ('accent' o '#hex'), label ('', hasta 16), animation ('none', 'pulse' o 'shine'), sound ('none', 'click', 'whoosh' o 'bell') }`. Todo lo normaliza `normalizeAppearance` con valores por defecto |
| `looks` | a11y | `[{ id, name, appearance, branding, createdAt }]` (Mis looks, hasta 20): `appearance` lleva todo lo de Apariencia menos `lite`, `liteOverlay` y `seasonalBackup`; `branding` lleva nombre, subtítulo, logo (data:, hasta 200 KB; si pesa más se descarta) y servidor. Un look con logo pesa hasta ~270 KB en `settings.json` |
| `decor` | decor | `{ particles ('none', 'snow', 'rain', 'leaves', 'embers' o 'stars'), density ('low' o 'normal'), seasonalParticles (false), sounds { enabled (false), pack ('soft', 'pixel' o 'space'), volume (60) }, splash { enabled (false), style ('logo', 'text' o 'minimal'), text ('', hasta 24) }, cursor ('default', 'pixel', 'sword', 'pickaxe' o 'diamond') }` (`normalizeDecor` completa lo que falte y vuelve al valor por defecto ante un valor desconocido; la temporada vigente no se guarda) |
| `nav` | navcustom | `{ order: [ids], hidden: [ids], pinned: [ids], iconPack ('outline', 'pixel' o 'filled') }` (menú lateral a gusto: `home` nunca se oculta, `settings` no está en NAV y siempre queda accesible; los ids desconocidos se descartan con `normalizeNav`; se guarda con 300 ms de retraso y `app.js` rearma el menú al cambiar) |
| `window.mini`, `window.miniRestore` | navcustom | `true`/`false` (modo mini: la ventana arranca en 420×640) y `{ width, height, maximized }` (tamaño de antes de entrar; lo escribe solo la interfaz). Las otras claves de `window` (`width`, `height`, `fullscreen`) siguen siendo las de la ventana del juego y no se ven afectadas |
| `a11y` | a11y | `{ colorblind, cvdStrength, statusShapes, highContrast, focusRings, scale (90 a 130), reduceMotion ('auto', 'on' u 'off'), gamepad, gamepadHints, couchMode }` |
| `social` | social, settings | `{ shareActivity, status ('online', 'away', 'busy' o 'invisible'), autoAway, notifications, profileSongs (true) }` (`profileSongs: false` = "No reproducir canciones de perfil", 3.1) |
| `voice` | voice | `{ inputDevice, outputDevice, echoCancellation, noiseSuppression, autoGainControl, inputVolume, muteShortcut, pushToTalk, pttKey, pttReleaseDelay, vadAuto, vadThreshold, notifySounds, soundboardEnabled, soundboardVolume, relayOnly (solo si el launcher trae TURN), userVolumes }` |
| `versions` | versions | `{ view ('grid', 'list' o 'library'), sort ('recent', 'name', 'version' o 'playtime'), group, allLoaderVersions }` (los filtros **Solo favoritas** y la etiqueta elegida no se guardan: duran la sesión) |
| `worlds` | worlds | `{ sort, instance, mode, mediaKind, mediaInstance, order }` (filtros de la página) |
| `multiplayer` | multiplayer | `{ tab, lang, sort, savedInstance }` |
| `modrinth` | modrinth | `{ pageSize: { modrinth (10, 20, 50 o 100), curseforge (10, 20 o 50) } }` (resultados por página del catálogo; por defecto 20). Los filtros de "Más filtros" no se guardan: duran lo que dura la sesión |
| `smartsearch` | smartsearch | `{ history (últimas 20), prefs: { perType (3, 5, 8 o 12; 1 a 12 en el módulo), compatibleOnly, useAi } }` |
| `compat` | compat | `{ includeBeta }` |
| `snapshots` | snapshots | `{ autoBeforePlay (true), keepAuto (10), keepDays (30; 0 = nunca), autoIntervalHours (6) }` |
| `analysis` | analysis | `{ launchSecurity (true), launchMixins (true) }` |
| `modtranslate` | modtranslate | `{ locale }` (último idioma de destino) |
| `ingame` | ingame | `{ pack (true), window (true), badge (false), badgeEnrolled }`: paquete de recursos de Venus en el juego (pantalla de carga, texto debajo del logo y frases del menú), ícono y título de Venus en la ventana del juego y la insignia de Venus (mod en instancias Fabric/Quilt 1.20.1, 1.21 y 1.21.1, NeoForge 1.21 y 1.21.1 y Forge 1.20.1; `badgeEnrolled` = hay cuentas anotadas en el servidor para borrar al apagarla) (Ajustes → General → Al jugar) |
| `nowplaying` | nowplaying | `{ source ('auto', 'system' o id de app), overlay (true), shortcuts: { enabled (false), playPause, next, prev, volumeUp, volumeDown } }` (la clave vieja `music` no se usa) |
| `overlay` | overlay | `{ enabled, shortcut ('Alt+Shift+O'; '' = sin atajo), widgets: { voice, messages, alerts, captures, music, perf } }`; cada widget `{ enabled, anchor ('tl'…'br' o 'free'), x, y, scale, opacity, theme }` más lo suyo (`voice.show`, `messages.hideContent`, `duration`, `alerts.filter`, `music.show`, `perf.show { ram, cpu, ping, session }`; `perf` ancla en `'bl'` por defecto, 3.1) |
| `capture` | capture | `{ replay (false), quality ('1080p'), fps (30), audio (true), notify (true), copyTo (''), shortcuts: { replay ('Alt+Shift+F8'), record ('Alt+Shift+F9'), screenshot ('Alt+Shift+F12') } }` |
| `rewards` | rewards | `{ claimed: { <userId>: [ids] }, pending: [ids], lastGiftSeen }` (logros de la PC ya reclamados, para no repetir pedidos; `lastGiftSeen`: hasta dónde se vio la bandeja de regalos de `social/gifts.js`, 3.1) |
| `notify` | party | `{ friendServers (true), friendWorlds (true), serverOnline (true), serverFull (false), serverEmpty (false), profileServers (false), quietWhilePlaying (true), overlay (true), muted: [ids], watch: [{ address, name }] (hasta 20) }` |
| `whatsnew`, `skineditor` | whatsnew, skineditor | `{ seen: '2.0.0', seenAt }`; `{ recent: ['#rrggbb'] (hasta 10), grid, template, mirror }` |
| `mapviewer` | mapviewer | `{ grid (false), markers (true) }` |
| `downloads`, `storage` | storage (y tools: `schedule`) | `{ maxKBps (0 = sin límite), concurrency (0 = automático), offline, schedule { enabled (false), from ('02:00'), to ('08:00') } }` (`schedule`: descargas programadas, hora local, de `modules/downloadschedule.js`), `{ autoDedupe (false) }` |
| `play` | tools | `{ breaks: { enabled (false), everyMin (60: 30, 45, 60, 90 o 120), dailyLimitMin (0 = sin tope; de 1 a 8 h) }, today: { day ('AAAA-MM-DD', día local), minutes }, sessionRecap (true) }` (recordatorio de descansos y tope de horas; minutos jugados hoy, que se guardan cada 5 minutos jugados y al cerrar el juego; resumen al cerrar el juego. Ajustes → General → Descansos y resumen) |
| `news` | tools | `{ newVersions (true), seenVersions }` (aviso de versión nueva de Minecraft y las versiones ya vistas, release y snapshot; consulta solo con la conexión opcional `privacy.news`) |
| `discord` | discord | `{ enabled, showIdle, showInstance, showWorld, showServer, buttons (hasta 2 { label, url }) }` (el Application ID es el del launcher, `core/app-config.js`) |
| `recap` | recap | `{ period ('week', 'month' o 'all'; por defecto 'all'), format ('landscape' o 'portrait'; por defecto 'landscape'), showName (false) }` (última elección del diálogo Tu resumen de Venus; se guarda al cerrarlo y solo si el usuario cambió algo: mostrar "Desde siempre" porque el período guardado no tiene partidas no cuenta) |

Secretos (`core/secure`, en `data/secure.json` cifrado): `assistant.mcpToken.<id>` y `assistant.mcpEnv.<id>` (token y variables de entorno de cada servidor MCP del asistente), `mcp.secret` (secreto del servidor MCP local y del puente), `mcp.entitlement` (último plan verificado para MCP, para no cortar sin conexión) y, desde la interfaz (prefijo `ui:`), la sesión de Supabase (`ui:sb.venus-auth*`) y la cola de mensajes sin enviar `ui:social.outbox.<userId>`. Los secretos de versiones anteriores (`ai.apiKey`, `curseforge.apiKey`, `netplay.boreSecret`, `ui:voice.turnCredential`) ya no se leen. En `localStorage` solo hay comodidades de cada usuario: `sv-history-<serverId>` (historial de la consola de servidores) y `venus.a11y.palette.recent` (comandos recientes).

**Ajustes de 4.5.0 (no confundir preferencias locales con permisos de nube):**

| Clave | Valor inicial y uso |
|---|---|
| `backups.schedule` | `enabled: false`; frecuencia por horas/día/semana, cada 6 horas, conservar 5; selección de instancias y opción al cerrar juego. |
| `perfhistory.enabled` | Activo salvo `false`; apaga el muestreo periódico desde Rendimiento → Historial. |
| `settingsSync` | `enabled: false`; lista admitida de apariencia/looks/menú/Inicio, marcas por clave y cuenta. No sincroniza permisos ni rutas. |
| `privacy.wiki` | `false`; consentimiento para abrir Minecraft Wiki. |
| `overlay.panelShortcuts` | Atajos de paneles; contadores y FPS se integran con los widgets del overlay. |
| `socialplus` | `translateConsent` y `translateChats`; consentimiento antes de enviar mensajes a IA. |
| `voice.voiceEffect` | `'none'`; procesamiento local de voz. |
| `profileMusic` | `enabled: false`. Es el único interruptor de la música de perfil: apagado, no sale ningún pedido a Openverse, Jamendo ni Wikimedia. Caché de resultados y contador de pedidos en `data/profilemusic.json`. |
| `smartsearch.prefs` | `useAi` (apagada por defecto), `aiSource` (`venus` o `local`) y `aiConsent { venus, local }` (aviso aceptado por fuente, con su hora). Quien tenía `useAi: true` de versiones anteriores queda apagada hasta aceptar el aviso. |
| `overlay` | Sin claves nuevas en la 4.6; los `panelShortcuts` repetidos con `shortcut` se normalizan al leer. |
| Claves de lo retirado (históricas) | `compete.*`, `clans.seen`, `extensions.catalog`, `extensions.blocklist`, `obs.*`, `privacy.streamer` y `ingame.capes` ya no se leen: quedan como datos inertes en un `settings.json` viejo. En disco pueden quedar `data/compete.json`, la carpeta `extensions/` y el secreto cifrado `obs.password`. |
| `discordNotify` del servidor | Habilitación y eventos en `venus-server.json`; webhook cifrado por separado. |

PIN familiar, tokens OAuth y suscripciones push no van en ajustes sincronizables. Formas completas y límites: [Datos](implementacion/datos.md), [Overlay](implementacion/overlay.md), [Social](implementacion/mensajes-voz.md) y [Clips](implementacion/clips.md).

### 7.3 Carpeta de datos

La raíz es `%APPDATA%\.venuslauncher` (Windows), `VENUS_DATA_DIR` si está definida, `VenusData` junto al `.exe` en la versión portable o la carpeta elegida en **Ajustes → Datos** (se guarda en `venus-location.json` dentro de la carpeta de Electron).

```
<datos>/
  versions/ libraries/ assets/ runtime/ natives/ logs/   Juego y Java (núcleo)
  instances/<id>/                  Instancias: venus-instance.json + archivos del juego + .venus/ (7.4)
  servers/<id>/                    Servidores locales: venus-server.json, backups/ (copias de mundo)
  cache/                           Se puede borrar entera (Ajustes > Datos)
    maps/<instancia>/<mundo>/<dimensión>/r.X.Z.png      mapviewer
    compat/hashes.json, compat/meta.json                compat
    stats/game-<versión>.json                           stats (datos leídos del .jar)
    worlds-sizes.json, worlds-thumbs/                   worlds
    crash/mods-index.json                               crash
    perf-modrinth.json                                  performance
    serverlist-featured.json, serverlist-protocols.json multiplayer
    modpacks/, installers/, java/, optifine/, buildtools/, *.json   descargas y listas del núcleo
  data/                            Estado de los módulos (tabla)
  store/<aa>/<sha1>                Almacén de enlaces duros (storage)
  snapshots/objects/<aa>/<sha1>, snapshots/<instancia>/<id>.json    Instantáneas (snapshots)
  backups/worlds/<instancia>/<mundo>-<fecha>.zip                    Copias de mundos (worlds)
  mcimport/                        Temporales de Importar desde el launcher oficial (mcimport): staging-<fecha>-<azar>/,
                                   se borran al terminar, fallar o cancelar, y al abrir el launcher
  mcp/                             Servidor MCP (mcp): bridge.json, tools.json, venus-mcp-bridge.js (puente stdio),
                                   activity.json (Actividad MCP), bin/cloudflared (túnel opcional). Carpeta privada
```

| Archivo en `data/` | Dueño | Qué guarda |
|---|---|---|
| `settings.json` | núcleo | Ajustes (7.2) |
| `secure.json` | núcleo | Secretos cifrados |
| `accounts.json` | onboarding | Cuentas de Minecraft (tokens cifrados) |
| `stats.json` | stats | Sesiones (formato v2), sesiones archivadas, hitos y contadores |
| `stats-activity.json`, `stats-activity-archive.json` | stats | Tiempo por mundo y por servidor (líneas numeradas que solo se agregan; se compactan) |
| `worlds-timeline.json`, `worlds-shared.json` | worlds | Partidas registradas por mundo; links compartidos de capturas y clips |
| `perf.json` | performance | Equipo detectado y resultado de la prueba de CPU |
| `netplay.json` | netplay | Preferencias por servidor y mapeos UPnP activos (se limpian si el launcher se cerró de golpe) |
| `serverlist.json` | multiplayer | Historial de servidores e instancia preferida por servidor |
| `security-cache.json`, `mixins-cache.json` | analysis | Resultados por SHA-1 de cada `.jar` |
| `modtranslate-cache.json` | modtranslate | Traducciones reutilizables entre instancias |
| `storage.json`, `storage-hashes.json`, `storage-usage.json` | storage | Estado de la unificación, caché de hashes y del uso de disco |
| `cloudsync.json` | share | `{ deviceId }` de esta PC |
| `assistant/` | assistant | `conversations/<id>.json` (+ `index.json`), `defs/<hash>.json` (prompt y herramientas congelados por conversación), `undo.json`, `engines/<motor>/` (carpeta de trabajo vacía del Claude Code o el Codex del usuario; `AGENTS.md` con el prompt de sistema para Codex; los archivos de cada turno se borran al terminar) |
| `skins/` | skins | Biblioteca de skins: `index.json` ({ version: 1, items: [{ id, name, variant, width, height, size, sha1, pixelHash, addedAt, updatedAt, source ('file', 'account' o 'catalog') }] }, escritura atómica) y `<id>.png` (copia de cada PNG de 64×64 o 64×32, hasta 64 KB; hasta 100 skins). Borrar manda el PNG a la papelera |
| `skin-favorites.json` | skins | Skins favoritas del catálogo: `{ version: 1, ids: [...] }` (escritura atómica y en serie; también lee el `{ ids }` de la 1.0.11) |
| `capture-ai.json` | capture | Descripciones de capturas hechas con IA (solo cuando el usuario lo pide), para buscarlas por lo que muestran |

**Archivos agregados para 4.5.0 (relativos a la carpeta de datos):**

| Ruta / almacén | Contenido y retención |
|---|---|
| `data/sharedoptions.json` | Grupos compartidos y teclas separadas por formato moderno/antiguo. |
| `data/perfhistory/AAAA-MM.json` | Mediciones locales: cada 10 s, hasta 240 puntos por partida, 90 días; topes de 2 MB por mes y 8 MB en total. |
| `data/family.json` | Hash de PIN, reglas y consumo local; fuera de exportación y sincronización. No es una barrera de seguridad del sistema operativo. |
| `data/settings-before-import-<fecha>.json` | Respaldo de ajustes antes de importar una transferencia. |
| `soundboard/` | Índice y sonidos propios; máximo ocho de 5 s / 200 KB. |
| `secure` | Webhooks, caché de traducción y secretos de integración según módulo; `clipupload.youtube`, `clipupload.tiktok`. |
| IndexedDB de la PWA | Sesión de ese dispositivo y preferencias de avisos. Si falla, la sesión usa memoria; al salir se limpia la copia local. |

Una transferencia excluye cuentas, secretos reconocibles y rutas del equipo, pero el filtrado de configuraciones no puede garantizar eliminar todos los secretos de archivos arbitrarios. Los tamaños, formato ZIP64 y límites por entrada están en [Datos](implementacion/datos.md).

### 7.4 Carpeta interna `.venus/` de cada instancia

| Ruta | Dueño | Qué es |
|---|---|---|
| `.venus/prepared.json` | versions | Marca del arranque rápido (versión verificada; se revisa todo como mínimo cada 7 días) |
| `.venus/mod-history/<lote>/` (+ `index.json`) | compat | `.jar` reemplazados por actualizaciones, para volver atrás mod por mod |
| `.venus/compat-staging/` | compat | Descargas temporales de actualizaciones |
| `.venus/pack-index.json`, `.venus/pack-files.json` | snapshots | Índice del modpack instalado (qué archivos son del pack) |
| `.venus/pack-staging/` | snapshots | Descargas temporales al actualizar un modpack |
| `.venus/bisect-state.json` | crash | Estado de la búsqueda del culpable (para dejar todo como estaba si el launcher se cierra de golpe) |
| `.venus/crash-backups/<fecha>/` | crash | Copias de configs antes de restablecerlas |
| `.venus/quarantine/` (+ `index.json`) | analysis | Archivos en cuarentena |
| `.venus/modtranslate/<locale>.json` | modtranslate | Traducciones de la instancia (origen y marca de revisado) |
| `.venus/share-state.json`, `.venus/share-hashes.json` | share | Última revisión aplicada del modpack compartido y caché de sha1 |
| `.venus/share-incoming-*/` | share | Descargas temporales al aplicar una revisión |
| `.venus/cloudsync.json`, `.venus/cloudsync-backup/` | share | Estado de la nube de la instancia y copias antes de bajar |
| `.venus/cloudsync-incoming-*/`, `.venus/cloudsync-old-*/` | share | Temporales al bajar un mundo de la nube. Si una bajada se cortó, la primera operación de la nube en esa instancia devuelve el mundo apartado a `saves/` (o lo manda a la papelera si ya hay uno) y borra los temporales de más de un día |
| `.venus/assistant-undo/<id>/` | assistant | Copias para el botón Deshacer del asistente |

Además, `modtranslate` genera el paquete `resourcepacks/venus-auto-translations` (y lo activa en `options.txt`), `ingame` genera `resourcepacks/venus-launcher` antes de cada partida (1.13 en adelante; lo activa en `options.txt` después de los paquetes integrados y antes de los del jugador, lo reescribe solo si cambió su contenido —archivo `.venus-pack`— y lo saca de `options.txt` y lo borra si se apaga `ingame.pack`), performance guarda `options.txt.venus.bak` antes de mezclar opciones y la cuarentena, el historial y las copias nunca se exportan ni se comparten (6.7).

**Agregados de 4.5.0:** `.venus/modsets.json` conserva sets y el puntero `lastApply`; al duplicar se borra este último porque la instantánea pertenece a la original. `.venus/sharedoptions-backup.txt` guarda el respaldo de ajustes compartidos y `.venus/timelapse.json` su configuración por instancia. Los cuadros de timelapse van en `<instancia>/timelapse/`, fuera de packs e instantáneas; el vídeo terminado, en `clips/`.

Fuera de `.venus/`: `<mundo>/venus-markers.json` almacena hasta 1000 marcadores; `<carpeta del juego>/venus/perf.json` recibe FPS del mod cada 2 s, se considera vencido a los 10 s y no es una medición del launcher. No prometer FPS si ese archivo no existe o está vencido.

### 7.5 Campos de la 3.1 en `venus-instance.json`

Los campos de siempre están en 6.7 (**Metadatos de la instancia**). Desde la 3.1 se suman estos, que `core/instances.update` normaliza y valida con `modules/instancemeta/meta.js`, venga el parche de donde venga (interfaz, asistente o MCP):

| Campo | Valor | Reglas |
|---|---|---|
| `cover` | `'cover.png'` o `null` | Solo `cover.<png,webp,jpg>` (nada de rutas). `null` = carátula generada (color del loader y letra, con el ícono del modpack si tiene). |
| `coverAt` | fecha (ms) o `null` | Cambia con cada carátula nueva: la interfaz la usa como `?v=` para no mostrar la imagen vieja de la caché. |
| `tags` | `['Survival', 'Amigos']` | Hasta 10, de 1 a 24 caracteres (se cuentan puntos de código), sin repetidas sin distinguir mayúsculas, sin caracteres de control. Lo inválido se descarta. |
| `favorite` | `true` / `false` | Solo `true` cuenta como favorita. |
| `notes` | `{ text, tasks: [{ id, text, done }] }` o `null` | `text` hasta 20 000 caracteres; hasta 100 tareas de hasta 200 caracteres con `id` único (`[a-z0-9]{4,32}`; si falta o se repite, se genera). |

`create` inicializa `cover: null, coverAt: null, tags: [], favorite: false, notes: { text: '', tasks: [] }`. `duplicate` copia `cover` (el `cover.png` viaja con la carpeta), `tags` y `notes`; el favorito no. Archivo nuevo dentro de la carpeta de la instancia: `cover.png` (640×360, lo genera `modules/instancemeta.js` y se borra del todo al quitarlo o reemplazarlo, sin papelera). Como el resto de `venus-instance.json`, nada de esto se exporta ni se comparte (6.7).

**Campos de 4.5.0:** `look: { color?, background?, music? } | null` y `sharedOptions: boolean`, validados en `instancemeta/meta.js`. Las rutas de imagen/vídeo/audio son locales y absolutas; no rutas de red. [Instancias](implementacion/instancias.md) conserva las formas exactas y las restricciones de copia/exportación.

## 8. Reglas generales

- **Sin dependencias nuevas** de npm: Node 24 trae `fetch`, `WebSocket`, `zlib`, `crypto`, `net`, `dgram`, `worker_threads`. Disponibles: `adm-zip`, `tar`, `pidusage`, `@supabase/supabase-js`, `@anthropic-ai/sdk`.
- CSP de la interfaz: scripts solo desde la app; `connect-src` permite `https:`, `wss:` y `http://127.0.0.1:*`/`localhost`; imágenes `file:`, `data:`, `blob:`, `https:`.
- Seguridad: nunca ejecutar código descargado sin que el usuario lo pida; validar rutas con `safePath`; secretos solo en `core/secure`; nada de `innerHTML` con datos externos (usar `h()` o `safeHtml`). Las rutas que llegan de afuera (packs, manifiestos, zips, extensiones) pasan por `safety.safeRelPath`/`safety.resolveInside` (`modules/packs/safety.js`): rechazan rutas absolutas, `..`, nombres reservados de Windows y, dentro de una instancia, `.venus/` y `venus-instance.json`. Un `.mrpack` solo baja por https de `cdn.modrinth.com`, `github.com`, `raw.githubusercontent.com` y `gitlab.com` (`safety.allowedPackUrls`).
- Archivos de datos de un módulo: `paths.data('<modulo>.json')` o `path.join(paths.root(), '<modulo>')`, y anotarlos en 7.3.
- Comentarios breves en español, como el código existente. Sin `console.log` de depuración en lo entregado (sí `console.warn/error` con prefijo `[modulo]`).
- Cambios destructivos (borrar mundos, pisar mods): confirmar con `confirmDialog` y mandar a la papelera (`shell.trashItem`) cuando se pueda. Reemplazar archivos de contenido siempre de forma atómica (6.7).
- Caracteres especiales en el código (por ejemplo U+2028 dentro de una expresión regular): armarlos con `String.fromCharCode` y pasar `node scripts/check.js`, porque un carácter literal de esos rompe toda la interfaz.

## 9. Cómo verificar

```bash
node scripts/check.js                       # sintaxis de todo (0 errores)
node scripts/contracts-check.js             # canales que usa la interfaz sin handler (tiene que dar 0)
node scripts/i18n-check.js --summary        # traducciones contra el español
node scripts/check-package.js               # después de compilar: lo que entró al app.asar (nada de más de 2 MiB sin aprobar)
node scripts/smoke-packaged.js              # después de compilar: fuses y abrir el .exe de verdad (--tamper: integridad del asar)
VENUS_DEVSHOT=<carpeta> VENUS_DATA_DIR=<carpeta-temporal-propia> VENUS_SKIP_ONBOARDING=1 \
  VENUS_DEVSHOT_ROUTES="home,versions" ./node_modules/.bin/electron .
```

- Fuses de Electron (`build.electronFuses` en `package.json`): `NODE_OPTIONS` e `--inspect` apagados, integridad del asar y `OnlyLoadAppFromAsar` prendidos. `RunAsNode` queda prendido a propósito: el puente MCP corre con `ELECTRON_RUN_AS_NODE` (`modules/mcp.js`); apagarlo rompe Venus desde Claude y ChatGPT. Si se cambia algo de esto, correr `smoke-packaged.js --tamper`.
- `devshot` recorre las rutas, guarda `NN-<ruta>.png` y `console.log`. Se puede ejecutar JS en una ruta: `VENUS_DEVSHOT_ROUTES="versions|document.querySelector('.btn').click()"`. Las rutas se separan con comas, salvo que la lista tenga `;;`: en ese caso se separan con `;;` (usalo siempre que el JS tenga comas, aunque sea una sola ruta). Otras variables: `VENUS_DEVSHOT_FIRST` (espera inicial, 3000 ms), `VENUS_DEVSHOT_WAIT` (espera por ruta, 2500 ms), `VENUS_DEVSHOT_SIZE` (tamaño de la ventana, por ejemplo `1040x680`; por defecto 1300×820) y `VENUS_DEVSHOT_KEEP` (no cerrar al terminar). Si el JS de una ruta devuelve algo que no se puede clonar (una promesa, un elemento), terminalo con `;0`.
- Modos falsos para capturas (solo con `VENUS_DEVSHOT`; los de pagos, administración, MCP, skins y estado de los servicios, además, nunca en la app empaquetada; no hablan con ningún servidor): `VENUS_ASSISTANT_FAKE=1` (IA de demostración con plan Ultra) o `=noplan` (cuenta sin plan), `VENUS_BILLING_FAKE=1` con `VENUS_BILLING_FAKE_STATE` = un id de plan (`pro` por defecto), `none`, `grace`, `canceling`, `manual` o `signedOut` (el pago de prueba nunca abre el navegador y confirma el plan a los 2,5 s), `VENUS_ADMIN_FAKE=1` (panel de administración con datos de ejemplo), `VENUS_MCP_FAKE_PLAN=<plan>` o `none`, `VENUS_SKINS_FAKE=1` con `VENUS_SKINS_FAKE_DIR=<carpeta con skin.png y cape-<nombre>.png>` (cuenta de Microsoft y API de Minecraft Services de ejemplo; `VENUS_SKINS_FAKE_ERROR=<código>` hace fallar el perfil con ese código y `VENUS_SKINS_FAKE_VARIANT=slim` usa el modelo Slim) y `VENUS_SVCSTATUS_FAKE=<escenario>`: `ok`, `cloudflare` (la prueba de conexión no contesta pero los servicios sí), `internet`, `dns`, `tls`, `microsoft`, `mojang`, `modrinth`, `venus`, `slow` o `blocked`. Con ese modo se registra además `svcstatus:devFailTask` (una tarea que falla por la red, para ver el botón del panel de tareas; `{ kind: 'http' }` la hace fallar con un 503), y CurseForge comprueba el catálogo central cuando no hay `VENUS_CURSEFORGE_API_KEY`. Las claves de `core/app-config.js` y el proyecto de `core/cloud-defaults.js` se pisan con sus variables de desarrollo (sección 2).
- Modos de capturas de la 2.0 (solo con `VENUS_DEVSHOT` y sin empaquetar): `VENUS_REWARDS_FAKE=demo|premium|new|signedOut|unavailable` (+ `VENUS_REWARDS_FAKE_VERIFY_ERROR=<código>`), `openProfileEditor({ demo: 'premium' | 'free' })` y `openShareProfile({ demo: true })`, y `VENUS_OVERLAY_FAKE_PID=<pid>` (trata esa ventana como si fuera el juego). Con `VENUS_NP_LIVE=1` las pruebas de nowplaying usan el ayudante real de Windows.
- Más ayudas para capturas, solo sin empaquetar: con `VENUS_DEVSHOT`, **Copiar imagen** de Tu resumen de Venus no toca el portapapeles y **Guardar PNG** guarda en la carpeta de las capturas, sin diálogo. `VENUS_MC_DIR=<carpeta>` (también sin `VENUS_DEVSHOT`) usa esa carpeta como la del launcher oficial en Importar desde el launcher oficial, para probar con una `.minecraft` falsa sin tocar la real.
- Cada ejecución usa su propio perfil temporal (`%TEMP%\venus-devshot-<pid>`) y la ventana se muestra sin robar el foco: se pueden correr varias a la vez. Usar siempre un `VENUS_DATA_DIR` propio (nunca la carpeta real del usuario).
- Sin `VENUS_SKIP_ONBOARDING=1` aparece la bienvenida obligatoria.
- Con el launcher abierto, **Ctrl+Shift+R** recarga la interfaz (vuelve a cargar los módulos ES sin reiniciar el proceso principal).
- Revisar las capturas (que se vea bien a 1300×820) y que `console.log` no tenga errores de tu módulo.
- La lógica que no depende de Electron se prueba con Node puro (por ejemplo `src/main/modules/crash/test/run-tests.js`, `node src/main/modules/assistant/selftest.js`, `node --test "src/main/modules/billing/test/*.test.js"`, lo mismo con `admin/test`, `mcp/test`, `recap/test`, `skins/test`, `mcimport/test` y `svcstatus/test`, o las pruebas de `supabase/functions/ai-assistant/tests/`). Las de la 2.0: `node --test "src/main/modules/nowplaying/test/" "src/main/modules/overlay/test/" "src/main/modules/capture/test/" "src/main/modules/rewards/test/" "src/main/modules/ingame/test/*.test.js" "src/renderer/js/features/party/test/*.test.js" "src/renderer/js/features/profile-editor/test/" "src/renderer/js/features/themes/test/*.test.js" "src/renderer/js/pages/skins/editor/test/*.test.js"` y en `mod/venus-badge` `./gradlew test`. Las de recap, skins, mcimport y svcstatus también corren pasando solo la carpeta (`node --test "src/main/modules/skins/test/"`), porque cada una trae un `test/index.js`.
- Las de la 3.1: `node --test "src/renderer/js/a11y/test/*.test.js" "src/renderer/js/features/themes/test/*.test.js" "src/renderer/js/features/decor/test/*.test.js" "src/renderer/js/features/navcustom/test/*.test.js" "src/renderer/js/pages/home/test/*.test.js" "src/renderer/js/pages/versions/test/*.test.js" "src/renderer/js/pages/tools/test/" "src/renderer/js/pages/pass/test/*.test.js" "src/renderer/js/features/profile-editor/test/" "src/renderer/js/social/test/" "src/main/modules/instancemeta/test/" "src/main/modules/shortcuts/test/" "src/main/modules/mcnews/test/" "src/main/modules/downloadschedule/test/" "src/main/modules/overlay/test/"`. Ayudas para capturas: `VENUS_MCNEWS_FAKE=<versión>` (el aviso de versión nueva a los 3 s, sin consultar nada), `VENUS_REWARDS_FAKE` también para `#/pass`, y desde la consola de la interfaz `window.dispatchEvent(new CustomEvent('venus:season', { detail: { id: 'halloween' } }))`, `window.dispatchEvent(new CustomEvent('venus:ui-sound', { detail: { id: 'whoosh' } }))`, `(await import('./js/features/tools/recap.js')).previewRecap()` y `import('./js/features/navcustom.js').then((m) => m.setMini(true))`. Para ver Mis instancias sin instalar nada: un `VENUS_DATA_DIR` temporal con `instances/<id>/venus-instance.json` (la lista solo lee ese archivo).

### Evidencia de integración de 4.5.0

El [estado consolidado](estado-4.5.0.md) atribuye las corridas a sus ejecutores: 1538 pruebas Node (1537 pass, 0 fail, 1 skip opt-in de medios Windows), Gradle con 29 tareas y cuatro JAR, 20 rutas más 12 adicionales por idioma ES/EN con consola vacía, PWA con worker/caché sin red, codificación y reproducción WebM reales con medios propios, y overlay con recetas sintéticas/asistente falso. Las 1282 comprobaciones SQL se ejecutaron en PostgreSQL 17.11 temporal con rollback y fixtures parciales de Supabase; el [informe completo](implementacion/revision-sql-0028-0036.md) conserva comandos y límites. Este cierre documental no repitió esas pruebas. Paquete, NSIS y servicios/dispositivos reales siguen pendientes.
