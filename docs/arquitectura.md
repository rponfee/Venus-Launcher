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
| `core/accounts` | `list` (con `needsLogin`), `select`, `remove`, `addOffline`, `loginMicrosoft`, `getLaunchAccount(id?)` (incluye `xuid`), `refreshAccount` |
| `core/cloud-defaults` | Proyecto de Supabase del launcher, fijo al compilar: `config()` → `{ url, anonKey, configured }` (lo que usan todos los módulos y la interfaz por `cloud:config`). Un proyecto guardado en los ajustes por versiones anteriores (`settings.cloud`) se ignora. Solo en desarrollo (sin empaquetar): `VENUS_SUPABASE_URL` + `VENUS_SUPABASE_ANON_KEY` |
| `core/app-config` | Claves y servidores de servicios externos que **completa el dueño antes de compilar** (los usuarios no ven ni cargan claves): `get()` → `{ curseforgeApiKey, discordClientId, turn: { urls, username, credential }, bore: { host, secret } }` normalizado; un valor vacío apaga esa función (CurseForge, Discord Rich Presence, TURN) o usa bore.pub. Solo en desarrollo (`devEnv()`: sin empaquetar) se pisan con `VENUS_CURSEFORGE_API_KEY`, `VENUS_DISCORD_CLIENT_ID`, `VENUS_TURN_URLS` (separadas por coma), `VENUS_TURN_USERNAME`, `VENUS_TURN_CREDENTIAL`, `VENUS_BORE_HOST` y `VENUS_BORE_SECRET`. Todo lo de acá se puede extraer del instalador: nunca claves secretas de servidores (Stripe, `service_role`, Anthropic, OpenAI), que viven en las Edge Functions |
| `modules/ai` | IA (Claude) siempre por el backend del launcher: Edge Function `ai-assistant`, con la cuenta de Venus y un plan pago (sin plan no hay IA; respaldo en OpenAI). `available()`, `provider()` (`'backend'` o `null`), `status()`, `cachedQuota()`, `text({ system, prompt, model?, effort? })`, `json({ system, prompt, schema, model?, effort? })`, `messages({ system, messages, tools, turnId, model?, effort? })`. `model`: `'haiku'`, `'sonnet'` u `'opus'` (sin `model`, `text`/`json` usan Haiku); `effort`: `'low'`, `'medium'` o `'high'` (si el plan no lo permite, las tareas internas se reintentan con el más parecido). Errores con `err.code` y regla del `turnId`: 6.7. Ver `docs/backend-ia.md`. Siempre tener un camino sin IA |

**Actividad del jugador** (`game.activity(id)` / evento `activity`): `{ type: 'menu' }`, `{ type: 'singleplayer', world: '<carpeta>' }`, `{ type: 'server', address: 'host[:puerto]' }` o `null` cuando el juego se cierra. En la interfaz llega como `api.on('game:activity', (id, act) => ...)`.

**Chequeos antes de jugar**: `game.addBeforeLaunch(async ({ id, instance, resolved, settings, quiet }) => ({ warnings: ['...'] }))`. Devolver `{ block: true, message }` solo si jugar sería dañino (por ejemplo, un mod con malware confirmado; el error llega con `err.code = 'blocked'`) y `{ memory: { min, max } }` para elegir la memoria de esa partida (detalle en 6.7). `settings` es una copia para esa partida: cambiarla no toca los ajustes guardados. Los chequeos tienen que ser rápidos: nada de red ni análisis largos (usá cachés).

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
- `app.js` exporta: `navigate(ruta)`, `launchInstance(id, { quickPlay: { world: '<carpeta>' } | { server: 'host', port: 25565 } })` (Quick Play en 1.20+, `--server/--port` en versiones viejas), `openAccounts()`, `playtimeLabel(inst)`, `setNavBadge(ruta, valor, 'badge'|'dot')`, `finishOnboarding()`, `registerPage(id, loader, navItem)` (`navItem = { label, icon, cls }`; `label` puede ser una función que se vuelve a evaluar al cambiar el idioma; registrar el mismo id reemplaza la página), `unregisterPage(id)` (solo páginas registradas, no las propias del launcher) y `setNavHidden(id, hidden)`.
- `store`: `settings`, `instances`, `accounts`, `running`, `servers`, `info`, `tasks`; `on/emit`; `refreshInstances()`, `refreshSettings()`, `setSettings(patch)`, `selectedAccount()`, `selectedInstance()`, `taskFor(id)` (tarea que impide jugar esa instancia; ver 6.7).
- `ui.js`: `h`, `mount`, `clear`, `icon`, `registerIcons`, `toast`/`ok`/`fail`, `modal({ title, subtitle?, icon?, body, footer, size: 'sm' | '' | 'wide' | 'xwide', onClose, closable })` (con `icon` o `subtitle` la cabecera lleva el ícono en un recuadro de acento y una línea de contexto debajo del título), `confirmDialog`, `promptDialog`, `loading`, `skeleton(forma, opciones)` (carga de más de 300 ms: `3` líneas, `'line'`, `'title'`, `'circle'`, `'block'`, `'list'`, `'card'`, `'grid'`; se anuncia una sola vez como "Cargando..."), `setBusy(botón)` (acción asíncrona: spinner en lugar del primer ícono, `disabled` y `aria-busy`; devuelve la función que lo libera y le devuelve el foco), `reducedMotion()`, `emptyState`, `switchEl`, `selectEl`, `sectionTitle`, `safeHtml`, `copyText`, `ensureCss`, formatos `fmtBytes`, `fmtMb`, `fmtDuration`, `fmtNumber`, `fmtAgo`, `fmtDate`, `fmtTime`, `debounce`, `LOADERS`, `loaderBadge`, `instanceIcon`, `avatarImg`, `showTip`/`hideTip`.
- Módulos que arrancan solos al abrir el launcher (cada uno exporta un `startup()` que se puede llamar más de una vez): `appearance.js` y `a11y.js` arrancan antes de dibujar la primera página (`EARLY_STARTUP`, se esperan como mucho 1,5 s para que no se vea el tema por defecto); después, la lista `STARTUP` de `app.js` arranca `features/share.js`, `features/cloudsync.js`, `features/assistant.js`, `features/netplay.js`, `features/crash.js`, `pages/devmode.js`, `features/admin.js` (agrega `#/admin` al menú solo para los administradores) y `features/mcp.js` (confirmaciones y avisos con Deshacer de lo que piden Claude o ChatGPT por MCP).

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
- Perfiles (0001): `profiles(id, username, display_name, friend_code 'VENUS-XXXXXX', mc_name, mc_uuid, bio, banner, badges, status, status_text, last_seen)`.
- Realtime con canales privados (políticas sobre `realtime.messages`): el buzón personal `inbox:<userId>` lo maneja **solo** `social.js`; otros módulos mandan y reciben señales con `social.sendSignal(userId, tipo, datos)` y `social.onSignal(tipo, fn)` (tipos en 6.6). Las salas de voz usan `voice:<código>` y las maneja solo `voice.js`.
- Archivos grandes: Supabase Storage con buckets privados y rutas `<userId>/...`: `world-saves` (0004, mundos en partes de 45 MB), `screenshots` y `clips` (0005, se comparten con links firmados).

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
| `../appearance.js` | `startup()`, `appearancePanel() → Element` | `PRESETS`, `APPEARANCE_DEFAULTS`, `BRANDING_DEFAULTS`, `appearanceSettings()`, `accentColor()`, `brandingView()`, `fileUrl(path)`, `validServer(addr)`, `musicPlaying()`, `toggleMusicPause()`, `openAppearanceModal()` | a11y |
| `../a11y.js` | `startup()`, `accessibilityPanel() → Element` | `registerCommands(provider)` y `openCommandPalette(query?)` (paleta Ctrl+K; un comando es `{ id, title, run, group?, icon?, sub?, keywords?, hint? }`), `openControlifyInstaller()`, `openAccessibilityModal()`, `setA11y(patch)`, `a11ySettings()`, `A11Y_DEFAULTS`, `motionReduced()`, `scaleInfo()` | a11y |
| `../social.js` | `social` (6.2) | `MAX_MESSAGE` | social |
| `../voice.js` | `voice` (6.2) | `normalizeCode`, `VOICE_DEFAULTS`, `MAX_MEMBERS`, `SVC_PROJECT`, `SOUNDS`, `VoiceError` (con `.code`), `VoiceEngine` | voice |
| `pages/devmode.js` | página `#/devmode` | `startup()` (escucha `devmode:autoLaunch` para abrir el cliente cuando el servidor de prueba queda listo) | devmode |

Ayudantes de social reutilizables en `js/social/profile-ui.js`: `openProfile(userId)`, `openMyProfile()`, `joinFriend(friend)`, `inviteToVoice(friend)`, `presenceDot`, `headImg`, `headWithDot`, `badgeChips`, `profileCard`, `activityBlock`, `statusMenu`, `popMenu` (cargan solos su CSS y sus textos).

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
- `curseforge:status` → { configured (el launcher trae la API key de `core/app-config.js`), classIds, maxResults }; sin key la pestaña CurseForge muestra "no disponible" y vuelve a Modrinth. `curseforge:search`, `curseforge:project`, `curseforge:files`, `curseforge:install`, `curseforge:fingerprints`, `curseforge:categories`, `curseforge:changelog`.

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

**devmode** (`modules/devmode.js`)

- `devmode:state`, `devmode:project`, `devmode:addProject`, `devmode:removeProject`, `devmode:select`, `devmode:update`, `devmode:detect`, `devmode:jdks`, `devmode:build`, `devmode:cancelBuild`, `devmode:buildLog`, `devmode:deploy`, `devmode:events`, `devmode:clearEvents`, `devmode:serverOptions`, `devmode:linkableServers`, `devmode:createServer`, `devmode:linkServer`, `devmode:unlinkServer`, `devmode:startServer`, `devmode:stopServer`, `devmode:restartServer`, `devmode:killServer`, `devmode:command`, `devmode:serverLogs`, `devmode:setOnlineMode`, `devmode:plugman`, `devmode:installPlugman`, `devmode:startSession`, `devmode:open`, `devmode:clientLaunched` (detalle en la cabecera de `src/main/modules/devmode.js`).
- Eventos: `devmode:changed` (projectId o null), `devmode:status`, `devmode:buildLog`, `devmode:event`, `devmode:autoLaunch` (projectId, { instanceId, port }).

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

### 6.4 Exports del proceso principal para otros módulos

| `require('./...')` | Funciones |
|---|---|
| `admin` | `me(opts)`, `call(action, payload)` |
| `ai` | `available`, `provider`, `status`, `request`, `messages`, `text`, `json`, `textOf`, `cachedQuota`, `modelAlias`, `modelId`, `modelLabel`, `normalizeEffort`, `bestEffort`, `MODELS`, `MODEL_ALIASES`, `EFFORTS` |
| `assistant` | `status`, `send(conversationId, text, opts)` |
| `billing` | `state(opts)`, `catalog()`, `checkout(planId)`, `portal()`, `PLANS` (lista fija de respaldo: id, nombre y precio) |
| `catalog` | `packs`, `installPacks`, `PACKS` |
| `cloudsync` | `status`, `upload`, `download`, `autoSync`, `isBusy` |
| `compat` | `check(input)`, `listUpdates(instanceId, opts)`, `history(instanceId)` |
| `crash` | `analyzeInstance(instanceId)`, `bisectStatus`, `isBisecting(instanceId)`, `assertNotBisecting(instanceId)` (error con `code: 'bisect'`: mientras se busca el mod culpable, nadie más toca la carpeta mods; lo usan compat, share, packs, snapshots e `instances:*File`) |
| `curseforge` | `available`, `search`, `getMod`, `getMods`, `getModFiles`, `getFiles`, `getDownloadUrl`, `fingerprintMatches`, `computeFingerprint(buffer)`, `fingerprintFile(ruta)`, `installToInstance`, `installModpack`, `normalizeMod`, `normalizeFile`, `CLASS_IDS` |
| `devmode` | `suggestVersion` |
| `mapviewer` | `info`, `tile`, `renderAll`, `discoverDimensions`, `flushIndexes`, `getPool`, `configure`, `RENDER_VERSION` |
| `mcp` | `status()` (el mismo estado de `mcp:status`), `planState({ refresh?, wait? })` (el control de plan del MCP: lo usan los servidores MCP del asistente y los motores externos), `localEndpoint()` (URL local con el secreto para los motores externos del asistente; arranca el servidor solo para eso si el interruptor está apagado; `err.code 'plan'`), `activitySince(desde)` (entradas de la Actividad MCP desde ese momento), `INSTRUCTIONS` (instrucciones para el modelo de Claude o ChatGPT) |
| `mixins` | `analyze`, `lastReport`, `beforeLaunch` |
| `netplay` | `addresses`, `openPort`, `closePort`, `startTunnel`, `stopTunnel`, `testAddress`, `e4mcStatus`, `worldSnapshot`, `shutdown` |
| `packs` | `recordInstall(instanceId, rutaMrpack, { projectId, versionId })`, `diff`, `update`, `inspect`, `importPack`, `exportPreview` |
| `packs/safety` (ayudante, no se autocarga) | Rutas que vienen de afuera: `safeRelPath`, `resolveInside`, `validSegment`, `isReservedTop`; URLs de un `.mrpack`: `isAllowedPackUrl`, `allowedPackUrls`, `firstHost`, `packHashes`, `PACK_HOSTS`; escrituras sin romper enlaces duros: `writeFileAtomic`, `copyFileAtomic`, `moveFile`, `replaceFile`, `tempPathFor`; archivos bloqueados: `isLockError`, `isSharedFile`. Lo usan el núcleo y varios módulos |
| `perf` | `memoryPlan`, `applyRecommended`, `beforeLaunch`, `recommend`, `system` |
| `security` | `scanTarget`, `lastResult`, `quarantine`, `restore`, `discard`, `removeFile`, `beforeLaunch`, `effectiveFindings` |
| `serverlist` | `ping`, `pickInstance`, `join`, `saved`, `addSaved`, `updateSaved`, `removeSaved`, `featured`, `parseAddress` |
| `serverx` | `gamerulesState`, `setGamerules`, `propertiesState`, `playerLists`, `playerAction` |
| `share` | `buildManifest`, `applyManifest`, `diff`, `compare`, `preview`, `createFromManifest`, `normalizeManifest`, `encodeManifest` |
| `smartsearch` | `interpret`, `plan`, `run`, `cancel` |
| `snapshots` | `create(instanceId, { reason, worlds })`, `list(instanceId?)` (sin argumentos: todas las instancias), `compare`, `restore`, `remove`, `prune`, `usage`, `getSettings` |
| `statsplus` | `crashReason`, `buildReport`, `buildPlaces`, `worldDetail`, `queryIngame` |
| `storage` | `scan`, `runDedupe`, `clean` |
| `worlds` | `list`, `get`, `recent`, `timeline`, `screenshots`, `clips`, `isOpen` |

Usan `game.addBeforeLaunch`: performance (memoria automática y Java elegido a mano), analysis (seguridad y mixins, solo con su caché), snapshots (instantánea automática antes de jugar, espera como máximo 8 s), share (bloquea mientras se sincroniza esa instancia) y crash (bloquea la instancia durante la búsqueda del culpable).

### 6.5 Rutas de la interfaz (enlaces directos)

| Ruta | Abre |
|---|---|
| `#/home` | Inicio |
| `#/assistant[/<conversación>]` | Asistente IA |
| `#/versions` · `#/versions/new[/<loader>/<versión>]` | Mis instancias · Instalar nueva |
| `#/instance/<id>[/<pestaña>[/<extra>]]` | Instancia. Pestañas: `overview`, `content`, `mods`, `resourcepacks`, `shaderpacks`, `datapacks[/<mundo>]`, `worlds`, `screenshots`, `logs[/files]`, `settings` (`saves` y `console` son alias) |
| `#/worlds` · `#/worlds/media` · `#/worlds/<instanceId>/<carpeta>` | Mundos · Capturas y clips · Ficha de un mundo |
| `#/modrinth` · `#/modrinth/<instanceId o ->/<tipo>[/<serverId>]` | Catálogo; filtrado para una instancia o servidor. Tipos: `mod`, `modpack`, `shader`, `resourcepack`, `datapack`, `plugin` |
| `#/modrinth/project/<id-o-slug>` · `#/modrinth/curseforge/<id>` | Detalle de un proyecto |
| `#/smartsearch[/<consulta>]` | Buscador inteligente (con consulta, la busca sola) |
| `#/multiplayer[/<featured, saved, friends o search>[/<dirección>]]` | Multijugador |
| `#/servers` · `#/server/<id>[/<pestaña>]` | Servidores locales. Pestañas: `console`, `players`, `properties`, `rules`, `world`, `addons`, `network`, `settings` (proxies: `console`, `proxy`, `addons`, `network`, `settings`) |
| `#/voice[/<rooms, audio o game>]` · `#/voice/join/<código>` | Voice Chat · Entrar a una sala (pide la contraseña si hace falta) |
| `#/messages[/<userId>]` | Mensajes (chat con ese amigo) |
| `#/stats[/<launcher, ingame, places o achievements>]` · `#/stats/world/<instanceId>/<carpeta>` | Estadísticas · Detalle de un mundo |
| `#/performance` · `#/devmode` | Rendimiento · Modo desarrollador |
| `#/admin` | Panel de administración. Solo existe para los administradores: la registra `features/admin.js` después de `admin:me` (para el resto no hay ítem de menú ni ruta). Guía: [admin.md](admin.md) |
| `#/settings[/<sección>[/<ancla>]]` | Ajustes (abajo) |
| `#/welcome` | Bienvenida (obligatoria hasta terminarla) |

Ajustes: secciones `general`, `appearance`, `a11y`, `cloud`, `privacy`, `ai`, `plan`, `java`, `storage`, `data`, `about` (una desconocida abre `general`). Alias: `account`, `accounts`, `venus`, `nube`, `cuenta` → `cloud`; `language`, `idioma` → `general`; `accessibility`, `accesibilidad` → `a11y`; `theme`, `apariencia` → `appearance`; `claude`, `ia`, `assistant`, `mcp` → `ai`; `plans`, `planes`, `billing`, `subscription`, `suscripcion` → `plan`; `discord`, `privacidad` → `privacy`; `downloads`, `descargas` → `storage`; `cache`, `datos`, `folder` → `data`; `updates` → `about`. Anclas (llevan a la tarjeta y enfocan su campo): `general/language`, `general/play`, `cloud/accounts`, `cloud/venus`, `privacy/activity`, `privacy/discord`, `ai/status`, `ai/mcp`, `ai/mcpservers`, `ai/privacy`, `plan/plans`, `java/venus`, `java/system`, `java/versions`, `storage/downloads`, `storage/disk`, `data/folder`, `data/cache`, `data/portable`. Para mandar a resolver algo: `settings/cloud` (sin sesión de Venus), `settings/plan` u `openPlans()` de `features/plans.js` (sin plan, cuota agotada o para cambiar de plan), `settings/ai` (IA desactivada). Ajustes no tiene campos para claves, proyectos de Supabase ni servidores: CurseForge, Discord, TURN y bore usan lo que trae el launcher (`core/app-config.js`).

### 6.6 Señales entre amigos (`social.sendSignal` / `social.onSignal`)

Viajan por el buzón privado `inbox:<userId>` con la RPC `social_send_signal`: solo entre amigos aceptados, el servidor pone el remitente, el tipo cumple `^[A-Za-z_][A-Za-z0-9_.:-]{0,39}$` y el `payload` es un objeto de hasta 4 KB. Los tipos que empiezan con `_` son internos de social (por ejemplo `_typing`).

| Tipo | Payload | Manda · Recibe |
|---|---|---|
| `voice-invite` | `{ room, name }` | `voice.inviteFriend` · `voice.js` (emite `'invite'` y `app.js` muestra el aviso) |
| `pack-invite` | `{ code, name, group, mcVersion, loader }` | Diálogo Compartir · `share.startup()` |
| `join-world` | `{ address, kind: 'world' o 'server', name, mcVersion, loader, from, fromMc }` | `openWorldToFriends` y `serverNetPanel` · `netplay.startup()` (social no la muestra por su cuenta) |

### 6.7 Reglas transversales

- **Errores entre procesos.** Un handler lanza `Error` con el mensaje ya traducido. Si además tiene `err.code` (texto o número estable), `ipc.js` lo manda como `{ ok: false, error, code }` y el preload lo vuelve a poner en el `Error` que lanza `api.invoke` (y los atajos como `api.instances.launch`). Comparar siempre por `err.code`, nunca por el texto (cambia con el idioma). Ejemplos: `'blocked'` (un chequeo previo impidió jugar), los códigos de la IA (abajo) y los de `VoiceError`.
- **IA: códigos de error.** `modules/ai.js` lanza errores con `err.code`: `unavailable` (IA desactivada, sin nube o sin sesión), `session` (sesión vencida), `noplan` (la cuenta no tiene un plan pago), `plan` (el plan no incluye ese modelo o ese esfuerzo: elegir otro), `quota` (preguntas o presupuesto del plan agotados), `ratelimit` (demasiados pedidos o servicio saturado), `backend` (el servicio de IA no responde bien; el detalle va a la consola), `refused` (la IA rechazó el pedido), `network` y `error`. Ya no existe `key` (no hay API key propia). Una respuesta cortada o un JSON inválido en `ai.text`/`ai.json` llegan sin código (tratalos como `error`), y cancelar con `signal` lanza el `AbortError` de siempre. Con `unavailable` o `session`, ofrecé ir a `settings/cloud` o `settings/ai`; con `noplan` o `quota`, mostrá los planes (`openPlans()` de `features/plans.js` o `settings/plan`; la cuota llega también con el evento `ai:quota`).
- **IA: regla del `turnId`.** Todas las llamadas que salen de **una sola acción del usuario** tienen que usar el mismo `turnId` (un id único por acción, por ejemplo armado con `uid()` de `core/util`): el backend cuenta una sola consulta por `turn_id` (hasta `max_calls_per_turn` llamadas del plan). Llamadas sin `turnId` cuentan como consultas separadas. Hoy lo cumplen el asistente (un `turnId` por pregunta) y la traducción de mods (uno por ejecución); el Buscador inteligente todavía pide el plan y las explicaciones sin `turnId`, así que una búsqueda con IA cuenta como dos consultas. Siempre `ai.available()` antes y un camino sin IA.
- **Partidas silenciosas.** `game.start(id, { ..., quiet: true })` es para lanzamientos que no son partidas del jugador, como las pruebas de la búsqueda del culpable de un crash (hoy `modules/crash/runner.js` todavía las lanza solo con `skipChecks: true`, sin `quiet`): no se registran en estadísticas ni suman tiempo jugado ni partidas, y los eventos `state`, `session` y `activity` llevan `quiet: true` (al cerrar, `activity` llega como `(id, null, { quiet: true })`; `game.status()` también marca `quiet`). Con esa marca, `app.js` no muestra los avisos de juego iniciado o cerrado ni el diálogo de crash, y `main.js` no minimiza, no oculta ni vuelve a mostrar la ventana. Los módulos que escuchan `activity` o `session` (estadísticas, mundos, Discord, amigos) pueden usar esa marca para no contar esas pruebas.
- **Memoria de cada partida.** Un chequeo de `addBeforeLaunch` puede devolver `{ memory: { min, max } }` (MB) para elegir la memoria de esa partida. Se usa solo si la instancia no tiene memoria propia (`instance.memory.override`); si varios chequeos devuelven memoria, gana el último, y si `min` falta o no sirve se usa como mucho 1024. Así trabaja la memoria automática de performance (`memoryMode: 'auto'`). Los chequeos reciben una copia de los ajustes, así que un `settings.memory = ...` viejo tampoco se guarda.
- **Tareas y botón Jugar.** Una tarea con `meta.instanceId` hace que `store.taskFor(instanceId)` la devuelva: Inicio, Versiones y la instancia la muestran como "preparando" y deshabilitan Jugar. Una tarea en segundo plano que no impide jugar puede asociarse igual a la instancia con `meta: { instanceId, background: true }` (o `blocksPlay: false`): se ve en el panel de tareas y `taskFor` la ignora. Para servidores, `meta.serverId`. Algunas tareas de fondo usan su propio meta sin `instanceId` (análisis: `{ kind: 'analysis:*', analysisTarget }`; mapas: `{ mapviewer: { ... } }`; traducciones: `{ kind: 'modtranslate', modtranslateInstance }`).
- **Enlaces duros: reemplazar siempre de forma atómica.** storage puede unificar archivos repetidos con enlaces duros (`<datos>/store/<aa>/<sha1>`) y snapshots enlaza `.jar`/`.zip` en su almacén. Un mismo archivo puede estar en varias instancias: **nunca** escribir sobre una ruta existente de `mods/`, `resourcepacks/`, `shaderpacks/`, `plugins/` o `config/` con `copyFile` o `writeFile`, porque cambiaría en todas. Usá los ayudantes de `modules/packs/safety.js`: `writeFileAtomic(dest, datos)`, `copyFileAtomic(src, dest)`, `moveFile(src, dest)` y `replaceFile(tmp, dest)` escriben un temporal en la misma carpeta y lo renombran encima. En Windows un `.jar` compartido con una instancia abierta no se puede borrar ni reemplazar: `isLockError(err)` e `isSharedFile(ruta)` detectan ese caso para mostrar un mensaje que pida cerrar el juego.
- **Carpeta interna `.venus/` de cada instancia** (7.4): es de Venus, no del juego. Exportar, compartir o sincronizar en la nube una instancia nunca incluye `.venus/` ni `venus-instance.json`, e importar un pack nunca puede escribir ahí (`safety.safeRelPath` y `safety.resolveInside` lo rechazan). Duplicar una instancia sí copia `.venus/`, salvo el arranque rápido, el Deshacer del asistente y las carpetas temporales. Un módulo nuevo que guarde datos por instancia usa `.venus/<modulo>...` y respeta esta regla.
- **Destructivo = papelera.** Borrar mundos, mods o capturas va a la papelera (`shell.trashItem`) después de `confirmDialog` (en `instances.deleteFile`, si la papelera falla, un mod se borra igual pero un mundo o una captura no). Excepciones a propósito: la limpieza de storage (contenido que se vuelve a descargar) y los sobrantes al restaurar una instantánea (quedan en la instantánea automática "Antes de restaurar").
- **Metadatos de la instancia** (`venus-instance.json`): `memory { override, min, max }`, `java { path, args, preset }`, `window { override, ... }`, `modrinth { projects, pack }` (archivos instalados desde Modrinth y modpack de origen; también se lee `pack`), `curseforge { projects, pack }` y `share { packId, code, name, revision, role, isGroup, auto, owner, ownerName, syncedAt, opts }`. Se cambian con `instances.update` (o `api.instances.update`), que escribe en serie.

## 7. Dueños, ajustes y archivos de datos

### 7.1 Dueños de archivos

| Módulo | Archivos propios | Textos (ns) | Migración |
|---|---|---|---|
| onboarding | `pages/welcome.js`, `styles/pages/welcome.css`, `core/accounts.js` | welcome · main: accounts | — |
| home | `pages/home.js` (+ `pages/home/logic.js`), `styles/pages/home.css` | home | — |
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
| devmode | `pages/devmode.js` (+ `pages/devmode/`), css, `modules/devmode.js` (+ `modules/devmode/`) | devmode · main: devmode | — |
| assistant | `pages/assistant.js`, `features/assistant.js`, `features/mcpservers.js` (+ `styles/features/mcpservers.css`), css, `modules/assistant.js` (+ `modules/assistant/`, con `mcp-servers.js`), `docs/asistente-ia.md` | assistant · main: assistant | — |
| assistant-backend | `supabase/functions/ai-assistant/`, `supabase/functions/README.md`, `docs/backend-ia.md` | — | 0007, 0008, 0011 |
| billing | `features/plans.js`, `styles/features/plans.css`, `modules/billing.js` (+ `modules/billing/`: `client.js`, `fake.js` para capturas, pruebas en `billing/test/`), `supabase/functions/billing/`, `supabase/functions/stripe-webhook/`, `docs/pagos.md` | plans · main: billing | 0009 |
| admin | `features/admin.js`, `pages/admin.js` (+ `pages/admin/`), `styles/pages/admin.css`, `modules/admin.js` (+ `modules/admin/`, pruebas en `admin/test/`), `supabase/functions/admin/`, `docs/admin.md` | admin · main: admin | 0012 |
| mcp | `features/mcp.js`, `styles/features/mcp.css`, `modules/mcp.js` (+ `modules/mcp/`, con el cliente MCP `client.js` que usa el asistente; pruebas en `mcp/test/`), `docs/mcp.md` | mcp · main: mcp | — |
| núcleo (compartido) | archivos `[compartido]` de la sección 1, `core/*` sin dueño en esta tabla (entre ellos `core/cloud-defaults.js` y `core/app-config.js`, que completa el dueño antes de compilar), `modules/ai.js`, `0001_base.sql` | common, nav · main: core, ai | 0001, 0010 |

(Rutas relativas a `src/renderer/js/`, `src/renderer/styles/` o `src/main/` según corresponda. "css" = los archivos de `styles/pages/` o `styles/features/` con el nombre de la página o feature. Cada módulo puede crear subcarpetas auxiliares con su nombre.)

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
| `home.hidden` | home | Bloques ocultos del Inicio: `quick`, `worlds`, `server`, `friends`, `featured`, `stats`, `screenshots`, `news`, `tips` |
| `branding` | a11y (lo lee home) | `{ name, subtitle, logo (PNG en data:), logoName, logoPixel, server ('host[:puerto]' de "Tu servidor") }` |
| `appearance` | a11y | `{ accent ('venus', 'mars', 'neptune', 'jupiter', 'earth', 'saturn' o 'custom'), customColor, tint, background ('stars' o 'image'), bgFile, bgDim, bgBlur, music { enabled, file, volume, pauseInGame } }` |
| `a11y` | a11y | `{ colorblind, cvdStrength, statusShapes, highContrast, focusRings, scale (90 a 130), reduceMotion ('auto', 'on' u 'off'), gamepad, gamepadHints, couchMode }` |
| `social` | social, settings | `{ shareActivity, status ('online', 'away', 'busy' o 'invisible'), autoAway, notifications }` |
| `voice` | voice | `{ inputDevice, outputDevice, echoCancellation, noiseSuppression, autoGainControl, inputVolume, muteShortcut, pushToTalk, pttKey, pttReleaseDelay, vadAuto, vadThreshold, notifySounds, soundboardEnabled, soundboardVolume, relayOnly (solo si el launcher trae TURN), userVolumes }` |
| `versions` | versions | `{ view ('grid' o 'list'), sort ('recent', 'name', 'version' o 'playtime'), group, allLoaderVersions }` |
| `worlds` | worlds | `{ sort, instance, mode, mediaKind, mediaInstance, order }` (filtros de la página) |
| `multiplayer` | multiplayer | `{ tab, lang, sort, savedInstance }` |
| `modrinth` | modrinth | `{ pageSize: { modrinth (10, 20, 50 o 100), curseforge (10, 20 o 50) } }` (resultados por página del catálogo; por defecto 20). Los filtros de "Más filtros" no se guardan: duran lo que dura la sesión |
| `smartsearch` | smartsearch | `{ history (últimas 20), prefs: { perType (3, 5, 8 o 12; 1 a 12 en el módulo), compatibleOnly, useAi } }` |
| `compat` | compat | `{ includeBeta }` |
| `snapshots` | snapshots | `{ autoBeforePlay (true), keepAuto (10), keepDays (30; 0 = nunca), autoIntervalHours (6) }` |
| `analysis` | analysis | `{ launchSecurity (true), launchMixins (true) }` |
| `modtranslate` | modtranslate | `{ locale }` (último idioma de destino) |
| `mapviewer` | mapviewer | `{ grid (false), markers (true) }` |
| `downloads`, `storage` | storage | `{ maxKBps (0 = sin límite), concurrency (0 = automático), offline }`, `{ autoDedupe (false) }` |
| `discord` | discord | `{ enabled, showIdle, showInstance, showWorld, showServer, buttons (hasta 2 { label, url }) }` (el Application ID es el del launcher, `core/app-config.js`) |

Secretos (`core/secure`, en `data/secure.json` cifrado): `assistant.mcpToken.<id>` y `assistant.mcpEnv.<id>` (token y variables de entorno de cada servidor MCP del asistente), `mcp.secret` (secreto del servidor MCP local y del puente), `mcp.entitlement` (último plan verificado para MCP, para no cortar sin conexión) y, desde la interfaz (prefijo `ui:`), la sesión de Supabase (`ui:sb.venus-auth*`) y la cola de mensajes sin enviar `ui:social.outbox.<userId>`. Los secretos de versiones anteriores (`ai.apiKey`, `curseforge.apiKey`, `netplay.boreSecret`, `ui:voice.turnCredential`) ya no se leen. En `localStorage` solo hay comodidades de cada usuario: `sv-history-<serverId>` (historial de la consola de servidores) y `venus.a11y.palette.recent` (comandos recientes).

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
| `devmode.json`, `devmode-events.json` | devmode | Proyectos de plugins y registro de eventos |
| `security-cache.json`, `mixins-cache.json` | analysis | Resultados por SHA-1 de cada `.jar` |
| `modtranslate-cache.json` | modtranslate | Traducciones reutilizables entre instancias |
| `storage.json`, `storage-hashes.json`, `storage-usage.json` | storage | Estado de la unificación, caché de hashes y del uso de disco |
| `cloudsync.json` | share | `{ deviceId }` de esta PC |
| `assistant/` | assistant | `conversations/<id>.json` (+ `index.json`), `defs/<hash>.json` (prompt y herramientas congelados por conversación), `undo.json`, `engines/<motor>/` (carpeta de trabajo vacía del Claude Code o el Codex del usuario; `AGENTS.md` con el prompt de sistema para Codex; los archivos de cada turno se borran al terminar) |

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

Además, `modtranslate` genera el paquete `resourcepacks/venus-auto-translations` (y lo activa en `options.txt`), performance guarda `options.txt.venus.bak` antes de mezclar opciones y la cuarentena, el historial y las copias nunca se exportan ni se comparten (6.7).

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
VENUS_DEVSHOT=<carpeta> VENUS_DATA_DIR=<carpeta-temporal-propia> VENUS_SKIP_ONBOARDING=1 \
  VENUS_DEVSHOT_ROUTES="home,versions" ./node_modules/.bin/electron .
```

- `devshot` recorre las rutas, guarda `NN-<ruta>.png` y `console.log`. Se puede ejecutar JS en una ruta: `VENUS_DEVSHOT_ROUTES="versions|document.querySelector('.btn').click()"`. Las rutas se separan con comas, salvo que la lista tenga `;;`: en ese caso se separan con `;;` (usalo siempre que el JS tenga comas, aunque sea una sola ruta). Otras variables: `VENUS_DEVSHOT_FIRST` (espera inicial, 3000 ms), `VENUS_DEVSHOT_WAIT` (espera por ruta, 2500 ms), `VENUS_DEVSHOT_SIZE` (tamaño de la ventana, por ejemplo `1040x680`; por defecto 1300×820) y `VENUS_DEVSHOT_KEEP` (no cerrar al terminar). Si el JS de una ruta devuelve algo que no se puede clonar (una promesa, un elemento), terminalo con `;0`.
- Modos falsos para capturas (solo con `VENUS_DEVSHOT`; los de pagos, administración y MCP, además, nunca en la app empaquetada; no hablan con ningún servidor): `VENUS_ASSISTANT_FAKE=1` (IA de demostración con plan Ultra) o `=noplan` (cuenta sin plan), `VENUS_BILLING_FAKE=1` con `VENUS_BILLING_FAKE_STATE` = un id de plan (`pro` por defecto), `none`, `grace`, `canceling`, `manual` o `signedOut` (el pago de prueba nunca abre el navegador y confirma el plan a los 2,5 s), `VENUS_ADMIN_FAKE=1` (panel de administración con datos de ejemplo) y `VENUS_MCP_FAKE_PLAN=<plan>` o `none`. Las claves de `core/app-config.js` y el proyecto de `core/cloud-defaults.js` se pisan con sus variables de desarrollo (sección 2).
- Cada ejecución usa su propio perfil temporal (`%TEMP%\venus-devshot-<pid>`) y la ventana se muestra sin robar el foco: se pueden correr varias a la vez. Usar siempre un `VENUS_DATA_DIR` propio (nunca la carpeta real del usuario).
- Sin `VENUS_SKIP_ONBOARDING=1` aparece la bienvenida obligatoria.
- Con el launcher abierto, **Ctrl+Shift+R** recarga la interfaz (vuelve a cargar los módulos ES sin reiniciar el proceso principal).
- Revisar las capturas (que se vea bien a 1300×820) y que `console.log` no tenga errores de tu módulo.
- La lógica que no depende de Electron se prueba con Node puro (por ejemplo `src/main/modules/crash/test/run-tests.js`, `node src/main/modules/assistant/selftest.js`, `node --test "src/main/modules/billing/test/*.test.js"`, lo mismo con `admin/test` y `mcp/test`, o las pruebas de `supabase/functions/ai-assistant/tests/`).
