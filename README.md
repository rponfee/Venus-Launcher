# Venus Launcher

Launcher de **Minecraft: Java Edition** para Windows hecho con Electron. Instala cualquier versión (de pre-classic a las snapshots más nuevas) con Vanilla, Fabric, Quilt, Forge, NeoForge, OptiFine, Iris, Legacy Fabric o Babric; trae el catálogo completo de Modrinth (y CurseForge opcional), servidores locales, juego con amigos sin abrir puertos, amigos, mensajes y Voice Chat, nube de mundos, un asistente de IA y muchas herramientas para que los mods no se rompan. Toda la interfaz está en español rioplatense y se traduce a 14 idiomas.

![Logo](src/renderer/assets/logo-256.png)

- Guía para usuarios, función por función: [docs/funciones.md](docs/funciones.md)
- Documentación para desarrolladores (índice): [docs/README.md](docs/README.md)
- [Code signing policy](#code-signing-policy) · [Privacy policy](#privacy-policy) · Licencia [MIT](LICENSE)

## Funciones

Agrupadas como en el menú del launcher.

### Jugar

- **Inicio**: la instancia elegida con el botón **JUGAR** (pasa a DETENER mientras jugás, con el tiempo y dónde estás), accesos rápidos, "Continuar donde quedaste" (entra directo al mundo con Quick Play), servidores destacados con ping en vivo, tus capturas, novedades de Minecraft, "Tu servidor", amigos en línea, tu actividad de la semana y consejos. Cada bloque se puede ocultar con **Personalizar inicio**.
- **Asistente IA**: chat con Claude que responde dudas y hace cambios en tus instancias con herramientas controladas (más abajo).
- **Versiones e instancias**: todas las versiones del manifiesto de Mojang (releases, snapshots, bromas del 1 de abril, beta, alpha, infdev, indev, classic) y 9 loaders con su lista completa de versiones. Instancias en cuadrícula o lista, con búsqueda, orden y grupos; importación de `.mrpack` y de otros launchers (CurseForge, MultiMC, Prism); arranque rápido sin red si nada cambió. La página de cada instancia tiene resumen, contenido (mods, resource packs, shaders y data packs por mundo), mundos, capturas, registros y ajustes, más estas **herramientas**:
  - Instantáneas (guardar y restaurar el estado, automáticas antes de jugar), exportar como `.mrpack` o `.zip` de Prism/MultiMC y actualizar el modpack viendo qué cambia.
  - Compartir con un código `PACK-XXXXXX` o en grupo (se actualiza solo para todos), nube de mundos y configuraciones, y "Mundo con amigos" para abrir tu mundo por internet.
  - Servidor espejo (un servidor local con el mismo loader y mods), buscar actualizaciones de mods con changelog e historial para volver atrás, análisis de seguridad contra malware (Fractureiser y otros), informe de mixins (conflictos entre mods), traducción de mods con IA, Optimizar (memoria y mods de rendimiento), diagnóstico de crashes y reparar.
- **Mundos**: todos los mundos de todas las instancias con línea de tiempo de partidas y logros, estadísticas, copias de seguridad (restaurar o recuperar mundos borrados), copiar a otra instancia o a un servidor local, mapa del mundo y la pestaña **Capturas y clips** con opción de compartir por link.

### Contenido

- **Modrinth**: mods, modpacks, shaders, resource packs, data packs y plugins con carga infinita, filtros (categorías, loader, versión, entorno, licencia, "Compatible con" una instancia o servidor), detalle con galería y versiones, y comparador de shaders y resource packs. Antes de instalar revisa la compatibilidad (versión, loader, dependencias, incompatibilidades y duplicados). **CurseForge** viene incluido si el build trae su API key (`src/main/core/app-config.js`).
- **Buscador inteligente**: pedí en lenguaje natural ("mods de tecnología para jugar con amigos en la 1.20.1") y arma un kit compatible agrupado por tipo, listo para instalar en una instancia o crear una nueva. Funciona sin IA y mejora con IA.

### En línea

- **Multijugador**: destacados, tus servidores (lee y escribe `servers.dat` de cada instancia), amigos jugando y búsqueda por dirección, con MOTD, latencia y jugadores. "Unirme" elige una instancia compatible o la crea, y **Armar instancia desde un servidor** detecta la versión, el loader y los mods.
- **Servidores locales**: 13 tipos (Vanilla, Paper, Purpur, Folia, Spigot, Fabric, Quilt, Forge, NeoForge, Mohist, Youer, Velocity y Waterfall) con consola, jugadores, propiedades, reglas del juego, mundo y copias, plugins o mods, red (UPnP, túnel para jugar sin abrir puertos), automatización (reinicios y copias programadas) y "Jugar en este servidor".
- **Voice Chat**: salas con código, contraseña opcional y hasta 8 personas, pulsar para hablar, volumen por persona, pantalla compartida, soundboard, chat de la sala, moderación y la instalación de **Simple Voice Chat** para voz de proximidad dentro del juego.
- **Mensajes**: amigos por código `VENUS-XXXXXX` o nombre de usuario, presencia y actividad ("Jugando 1.21.1 Fabric · mc.ejemplo.net"), chat 1:1 en tiempo real con respuestas, reacciones, edición, avisos de lectura, y botones para unirte al juego de un amigo o invitarlo a voz.

### Herramientas

- **Estadísticas**: tiempo jugado, rachas, calendario, horarios, versiones y loaders, estadísticas del juego por mundo (bloques, criaturas, logros), tiempo por mundo y servidor, hitos y exportación a CSV o JSON.
- **Rendimiento**: memoria automática según tu PC y cada modpack (o manual con un solo deslizador), recolector de Java explicado, prueba de rendimiento de la CPU, monitor en vivo y "Optimizar una instancia" con mods de rendimiento y packs de contenido verificados.
- **Modo desarrollador**: para crear plugins de Paper/Purpur/Folia: compila con Gradle o Maven, levanta un servidor de prueba, despliega y recarga el plugin, y abre el juego conectado.
- **Soporte**: consultas con el equipo de Venus desde el launcher (tickets con conversación).

### Asistente IA

Abrilo desde el menú, con el botón **Asistente** de la barra de título o con **Ctrl+J**. Responde dudas y, cuando hace falta, lee información y hace cambios **solo** con herramientas controladas (crear instancias, instalar o actualizar mods, cambiar la RAM o la versión de Java, leer un crash...). Los cambios se pueden **Deshacer** con un clic y borrar un mod (va a la papelera) pide confirmación. Funciona con la cuenta de Venus y un plan de Venus IA (Basic, Go, Pro o Max: pagos únicos con Mercado Pago en pesos o PayPal en dólares, el saldo no vence): el usuario elige el modelo y el esfuerzo que permite su plan. La IA también explica crashes, mejora el Buscador inteligente y traduce mods, y con un plan pago se puede usar Venus desde Claude o ChatGPT por MCP ([docs/mcp.md](docs/mcp.md)) o, al revés, que **tu propio Claude Code o Codex** respondan el asistente desde Venus con tu cuenta y tus límites ([docs/asistente-ia.md](docs/asistente-ia.md), sección 11).

### Ajustes

General (idioma y qué hace el launcher al jugar), Apariencia (temas planetarios, color propio, fondo, música y marca propia), Accesibilidad (daltonismo, alto contraste, escala, movimiento reducido, control), Cuenta y nube (cuentas de Minecraft y cuenta de Venus), Privacidad (con Discord Rich Presence), Inteligencia artificial (con Claude y ChatGPT por MCP, y tu Claude Code o tu Codex como motor del Asistente), Plan (planes, compra y saldo de Venus IA), Java, Descargas y almacenamiento (límite de velocidad, modo sin conexión, uso del disco, unificar archivos repetidos y limpieza), Datos (carpeta, caché y modo portable) y Acerca de.

### En todo el launcher

Bienvenida guiada la primera vez (idioma, cuentas, primera instancia, contenido y rendimiento), diagnóstico automático cuando el juego crashea (con arreglos en un clic y búsqueda del mod culpable), avisos antes de jugar (malware, conflictos de mixins, Java incompatible), paleta de comandos con **Ctrl+K**, navegación completa con control (Xbox, PlayStation, Switch) y modo sofá, descargas que se retoman si se cortan e instantánea automática antes de jugar.

## Requisitos

- **Para jugar**: Windows 10 u 11 e internet para descargar el juego y el contenido. Java **no** hace falta: el launcher descarga el Java oficial de Mojang que pide cada versión (8, 16, 17, 21 o 25), con Adoptium de respaldo.
- **Para desarrollar**: Node.js **22.12 o superior** (el proyecto se usa con Node 24) y npm. `package.json` también trae la configuración de electron-builder para Linux (AppImage) y macOS (dmg), que se compilan en esos sistemas.
- **Para compilar (el dueño)**: el proyecto de Supabase en `src/main/core/cloud-defaults.js` y, en `src/main/core/app-config.js`, la API key de CurseForge, el Application ID de Discord (Rich Presence) y, si hacen falta, el servidor TURN del Voice Chat y el servidor de túneles bore. Los usuarios no cargan claves.

## Comandos

```bash
npm install          # dependencias
npm start            # abre el launcher (electron .)
npm run dev          # igual que start (pasa --dev, que hoy no cambia nada)
npm run check        # sintaxis de todo el proyecto (node scripts/check.js)
npm run dist         # instalador y versión portable en dist/
npm run dist:dir     # solo la carpeta sin empaquetar (dist/win-unpacked)
```

`npm run dist` genera en `dist/`:

- `VenusLauncher-Setup-<versión>.exe`: instalador (NSIS) que deja elegir la carpeta y crea accesos directos.
- `VenusLauncher-Portable-<versión>.exe`: versión portable, sin instalar. Guarda sus datos en `VenusData`, al lado del `.exe`.

## Scripts de desarrollo

| Script | Para qué |
|---|---|
| `node scripts/check.js [carpeta-o-archivo]` | Chequeo de sintaxis sin abrir Electron (proceso principal como CommonJS e interfaz como módulos ES). Tiene que dar 0 errores. |
| `node scripts/i18n-check.js [idioma...]` · `--summary` | Compara cada idioma contra el español: archivos y claves faltantes, claves sobrantes y `{variables}` distintas. |
| `node scripts/contracts-check.js` | Cruza los canales que usa la interfaz con los que registra el proceso principal: tiene que dar 0 "sin handler". También lista los canales que nadie usa y los registrados dos veces. |
| `scripts/devshot.js` | Capturas automáticas de las páginas y su consola, con una carpeta de datos temporal (ejemplo abajo; detalles en [docs/arquitectura.md](docs/arquitectura.md#9-cómo-verificar)). La ventana se abre sin robar el foco. |

Ejemplo de `devshot` en PowerShell (las capturas y `console.log` quedan en la carpeta de `VENUS_DEVSHOT`):

```powershell
$env:VENUS_DEVSHOT = "$env:TEMP\venus-shots"; $env:VENUS_DATA_DIR = "$env:TEMP\venus-datos-prueba"
$env:VENUS_SKIP_ONBOARDING = "1"; $env:VENUS_DEVSHOT_ROUTES = "home,versions"
npx electron .
```

Usá siempre una carpeta de datos de prueba (`VENUS_DATA_DIR`), nunca la real. Las variables quedan puestas en esa ventana de PowerShell: cerrala antes de volver a usar `npm start`.

## Dónde se guardan los datos

- Por defecto en `%APPDATA%\.venuslauncher` (instancias, versiones, Java, servidores, ajustes y estado de cada módulo).
- Se puede mover desde **Ajustes → Datos** (el launcher se reinicia y recuerda la ubicación).
- La versión portable usa `VenusData` junto al `.exe`.
- La variable de entorno `VENUS_DATA_DIR` usa otra carpeta solo para esa ejecución (ideal para probar sin tocar tus datos).

Los tokens de sesión y los secretos se guardan cifrados con el almacén seguro del sistema. Qué hay en cada carpeta: [docs/arquitectura.md, sección 7](docs/arquitectura.md#7-dueños-ajustes-y-archivos-de-datos).

## Nube (Supabase) y backend de la IA

Las funciones en línea (cuenta de Venus, amigos, mensajes, Voice Chat, compartir modpacks, nube de mundos, capturas compartidas y servidores destacados) usan un proyecto de Supabase. Para conectarlo, aplicá las migraciones de `supabase/migrations/` y poné la URL y la anon key en `src/main/core/cloud-defaults.js` antes de compilar (no se configura desde la interfaz). Paso a paso: [docs/supabase.md](docs/supabase.md).

La IA usa la Edge Function `supabase/functions/ai-assistant` (planes, cuotas y las claves de Anthropic y OpenAI del lado del servidor; no hay API key propia): [docs/backend-ia.md](docs/backend-ia.md) y [supabase/functions/README.md](supabase/functions/README.md). Los pagos de los planes van por Mercado Pago y PayPal con la función `payments` ([docs/pagos.md](docs/pagos.md)) y el panel de administración por la función `admin` ([docs/admin.md](docs/admin.md)). Las migraciones que dan permisos de administrador usan `admin@example.com` como email del dueño: reemplazalo por el tuyo antes de aplicarlas en tu proyecto.

## Idiomas

Español (rioplatense, el idioma base), inglés, portugués (Brasil), francés, alemán, italiano, neerlandés, polaco, ruso, ucraniano, turco, japonés, coreano y chino simplificado. Cada módulo escribe sus textos en español y en inglés (`src/renderer/i18n/<idioma>/` y `src/main/i18n/<idioma>/`), y los otros idiomas se generan a partir de esos dos. El idioma se cambia al instante en **Ajustes → General**.

## Actualizaciones

El launcher instalado se actualiza solo desde las [releases de GitHub](https://github.com/rponfee/Venus-Launcher/releases) (electron-updater, repositorio en `venusUpdates.githubRepository` de `package.json`). Para publicar una versión: subí la versión en `package.json`, compilá con `npm run dist` y creá la release `v<versión>` con el `VenusLauncher-Setup-<versión>.exe`, su `.blockmap` y `latest.yml`. También se puede con `npm run release` o con el workflow `.github/workflows/release.yml` al subir un tag `v*`. La versión portable no se actualiza sola.

## Cómo está armado

Electron 44 con JavaScript sin frameworks ni build: proceso principal en CommonJS (`src/main/`, con un núcleo en `core/` y un archivo por función en `modules/` que se carga solo) e interfaz en módulos ES (`src/renderer/`, una página por ruta y diálogos reutilizables en `features/`). La arquitectura, los canales entre procesos, los contratos entre módulos y las reglas para programar están en [docs/arquitectura.md](docs/arquitectura.md).

## Notas

- **Cuentas**: el inicio de sesión de Microsoft usa el flujo de Xbox Live y verifica que la cuenta tenga Minecraft: Java Edition (compra o Game Pass). Las cuentas sin conexión, como en el launcher oficial, solo se pueden agregar y usar si en el launcher hay una cuenta de Microsoft con el juego; sirven para jugar solo, en LAN o en servidores con `online-mode=false`.
- **OptiFine** se descarga desde optifine.net. Si lo usás, considerá apoyar a su autor.
- **Servidores**: crear un servidor requiere aceptar el [EULA de Minecraft](https://aka.ms/MinecraftEULA).

## Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org)

Team roles:

- Authors: [rponfee](https://github.com/rponfee)
- Reviewers: [rponfee](https://github.com/rponfee)
- Approvers: [rponfee](https://github.com/rponfee)

Only the installer and portable executables built from this repository by the [Build workflow](.github/workflows/build.yml) on GitHub-hosted runners are signed, and every signing request is approved manually.

## Privacy policy

This program will not transfer any information to other networked systems unless specifically requested by the user or the person installing or operating it.

Venus Launcher does not include telemetry or analytics. Features that would contact a service on their own (checking for updates, Minecraft news, featured servers, player heads and Discord Rich Presence) are off until the user turns them on, when the launcher first asks or in **Settings → Privacy**. Everything else connects only when the user uses that feature:

| When you… | The launcher contacts |
|---|---|
| Sign in with Microsoft or play | Microsoft / Xbox Live and Mojang (sign-in, ownership check, game files, Java runtime) |
| Browse or install content | Modrinth, CurseForge, the loader sites (Fabric, Quilt, Forge, NeoForge, Legacy Fabric, Babric), OptiFine, PaperMC, Purpur, Mohist and Adoptium |
| Use your Venus account (friends, messages, Voice Chat, cloud, shared modpacks, AI features, support) | The Venus Launcher server (Supabase); AI features send your question and the related launcher context (instance, mods, logs) to the AI provider through that server (Anthropic; OpenAI only if enabled there as a fallback) |
| Use your own Claude Code or Codex in the assistant, or connect an MCP client | Anthropic or OpenAI through your own CLI and account; the MCP client you connect |
| Check or join a server | That server, and GitHub (public Minecraft protocol list) |
| Buy a Venus AI plan | Mercado Pago or PayPal, in your browser |
| Play with friends over the internet | The tunnel service you choose (bore, playit.gg or e4mc) or your router (UPnP / NAT-PMP) |
| Turn on an optional connection | GitHub (updates), Mojang (news), the Venus server and each featured server (status), mc-heads.net (player heads), Discord (Rich Presence) |

Each of those services has its own privacy policy.

## Licencia

[MIT](LICENSE). Venus Launcher no está afiliado a Mojang Studios ni a Microsoft. Minecraft es una marca de Mojang Synergies AB.
