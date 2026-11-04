# Venus Launcher

Launcher de **Minecraft: Java Edition** para Windows hecho con Electron. Instala cualquier versión (de pre-classic a las snapshots más nuevas) con Vanilla, Fabric, Quilt, Forge, NeoForge, OptiFine, Iris, Legacy Fabric o Babric; trae el catálogo completo de Modrinth (y el de CurseForge, configurado por el administrador), servidores locales, juego con amigos sin abrir puertos, amigos, mensajes y Voice Chat, nube de mundos, un asistente de IA y muchas herramientas para que los mods no se rompan. Toda la interfaz está en español rioplatense y se traduce a 14 idiomas.

![Logo](src/renderer/assets/logo-256.png)

- [Descargar](#descargar) · Guía para usuarios, función por función: [docs/funciones.md](docs/funciones.md)
- Documentación para desarrolladores (índice): [docs/README.md](docs/README.md)
- [Code signing policy](#code-signing-policy) · [Privacy policy](#privacy-policy) · Licencia [MIT](LICENSE)

## Descargar

Para Windows 10 y 11 (64 bits). Los links bajan siempre la última versión:

- **Instalador:** [VenusLauncher-Setup.exe](https://github.com/rponfee/Venus-Launcher/releases/latest/download/VenusLauncher-Setup.exe). Se actualiza solo si activás las actualizaciones automáticas.
- **Portable** (sin instalar, guarda los datos junto al ejecutable): [VenusLauncher-Portable.exe](https://github.com/rponfee/Venus-Launcher/releases/latest/download/VenusLauncher-Portable.exe)
- Todas las versiones y sus notas: [Releases](https://github.com/rponfee/Venus-Launcher/releases)
- Fondos de pantalla para el launcher: [venus-launcher-fondos.netlify.app](https://venus-launcher-fondos.netlify.app/)

**Code signing:** the Windows builds are compiled from this repository with GitHub Actions and signed through the SignPath Foundation program. Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org). See the [Code signing policy](#code-signing-policy). Mientras SignPath no apruebe el proyecto, los instaladores van sin firma y Windows SmartScreen puede mostrar un aviso: tocá "Más información" y "Ejecutar de todas formas".

## Funciones

Agrupadas como en el menú del launcher.

### En preparación: 4.5.0

Las 35 funciones de los antiguos grupos 3.2–3.4 están implementadas en la rama de trabajo para **4.5.0, todavía sin publicar**: herramientas de instancias y datos, nuevos paneles del overlay, control LAN y Discord, stickers/traducción/voz, Competir, clanes y comunidades, capas, semillas, estudio de clips, PWA y extensiones.

La producción verificada llega a la migración **0027**; 0028–0036, funciones nuevas y publicación web siguen pendientes. La suite integrada (1537 aprobadas, 0 fallos, 1 omitida), los cuatro JAR del mod, los recorridos ES/EN corregidos, los vídeos locales y el SQL con rollback tienen evidencia. No reemplazan Minecraft, celulares ni proveedores reales; paquete e instalador NSIS siguen pendientes. [Estado de integración](docs/estado-4.5.0.md), [guía de uso](docs/funciones.md) y [contratos, tablas y límites](docs/implementacion/README.md).

### Novedades de la 3.1

- **Venus Pass y personalización**: pase de temporada de 8 semanas y 50 niveles con pista gratis y premium, ediciones Go, Pro y Max ([docs/venus-pass.md](docs/venus-pass.md)); **Mis looks** (combinaciones completas de apariencia para guardar y compartir con un código), editor de colores, tema claro (fijo o automático por horario), temas de temporada, fondos rotativos, botón Jugar a gusto, decoración (partículas, sonidos de la interfaz, pantalla de inicio y cursores pixel), Inicio armable (ordenar, ocultar y ensanchar bloques), menú lateral a gusto con packs de íconos y **modo mini** (Ctrl+M: una ventana chica con Jugar, amigos y música).
- **Perfil, instancias y herramientas**: temas de la tarjeta, marcos animados y de temporada, poses de la skin, insignias raras, burbujas de chat, efecto de entrada en voz, estado con emoji y vencimiento, libro de visitas, regalos de puntos o cosméticos, canción de perfil y GIF de KLIPY en Mensajes ([docs/perfiles.md](docs/perfiles.md)); carátulas, vista biblioteca, comparar instancias, notas y tareas, etiquetas, favoritos y accesos directos en el escritorio; caja de herramientas (Nether, stacks, yunque, ticks, códigos de color y chunks), aviso de versión nueva de Minecraft, descargas programadas, recordatorio de descansos, widget de rendimiento en el overlay y resumen al cerrar el juego.

### Novedades de la 3.0

- **Perfiles**: rangos (owner, admin, mod, helper), 35 tipografías, fade de tres colores, nombre en mayúsculas, cursiva o con contorno, dibujos para la tarjeta, forma de la cabeza, redes y 30 cosméticos nuevos ([docs/perfiles.md](docs/perfiles.md)).
- **Banners con GIF**: buscá un GIF con KLIPY y ponelo de banner, sin necesidad de Premium.
- **Vitrina**: logros y clips destacados, skin en 3D, hasta 6 capturas y más estadísticas.
- **Logros y misiones**: más de 400 logros con niveles de bronce a netherita en su propia sección, y 3 misiones por día y 3 por semana ([docs/venus-points.md](docs/venus-points.md)).
- **Audio del Voice Chat**: mejor supresión de ruido, umbral de voz, volumen parejo, prueba de micrófono y recuperación automática si la conexión falla.
- **Clips**: 60 s gratis y 5 minutos con Premium, y clips automáticos al morir, conseguir un logro o derrotar al Ender Dragon ([docs/clips.md](docs/clips.md)).
- **Interfaz a gusto**: bordes, densidad, letra, menú lateral solo con iconos y opacidad de las tarjetas.
- **Insignia en más loaders**: también en Forge y NeoForge ([docs/insignia.md](docs/insignia.md)).

### Novedades de la 2.0

- **Música**: lo que suena en Spotify (gratis o Premium) o cualquier reproductor de Windows, con controles, volumen de esa app, mini reproductor y atajos dentro del juego ([docs/musica.md](docs/musica.md)).
- **Overlay en el juego**: Voice Chat, mensajes, avisos, capturas y la canción que suena encima del juego, con cada widget movible y personalizable ([docs/overlay.md](docs/overlay.md)).
- **Clips y capturas**: sección propia, grabación, repetición instantánea de 60 s (5 minutos con Venus Premium) guardada en disco, clips automáticos al morir, conseguir un logro o derrotar al Ender Dragon, editor (recortar y exportar en vertical 9:16) y compartir ([docs/clips.md](docs/clips.md)).
- **Perfiles a fondo**: degradado, banners (animados con Premium), tipografías y efectos del nombre, pronombres, servidores favoritos, estadísticas, capturas destacadas, marcos y títulos ([docs/perfiles.md](docs/perfiles.md)).
- **Venus Points y Venus Premium**: premio diario, logros, invitaciones con código (se pagan solo si el invitado verifica una cuenta de Minecraft real), tienda de cosméticos, insignia dorada en el juego y puntos x2 con Premium ([docs/venus-points.md](docs/venus-points.md)).
- **Grupos y avisos**: armar un grupo con amigos y entrar todos juntos, y avisos cuando un amigo entra a un servidor o un favorito vuelve a estar en línea ([docs/grupos.md](docs/grupos.md)).
- **Temas, editor de skins y novedades**: temas compartibles con galería de la comunidad, editor de skins 64×64 con vista 3D y un recorrido de lo nuevo al abrir la 2.0 ([docs/temas.md](docs/temas.md)).

### Jugar

- **Inicio**: la instancia elegida con el botón **JUGAR** (pasa a DETENER mientras jugás, con el tiempo y dónde estás), accesos rápidos, "Continuar donde quedaste" (entra directo al mundo con Quick Play), servidores destacados con ping en vivo, tus capturas, novedades de Minecraft, "Tu servidor", amigos en línea, tu actividad de la semana y consejos. Cada bloque se puede ocultar con **Personalizar inicio**.
- **Venus**: la web de Venus dentro del launcher, con la cuenta regresiva del lanzamiento, las novedades de cada versión, accesos a cada función, la galería de fondos (se aplican con un clic), los planes de Venus IA y las preguntas frecuentes.
- **Venus en el juego**: al jugar (1.13 en adelante), un resource pack de Venus pone el logo en la pantalla de carga, "Venus Launcher" debajo del logo de Minecraft y frases de Venus en el menú, y la ventana del juego lleva el ícono de Venus y "· Venus Launcher" en el título. Los resource packs del jugador tienen prioridad y las dos cosas se apagan en Ajustes → General. Opcional (apagada por defecto): la **insignia de Venus**, el planeta de Venus junto al nombre (sobre la cabeza y en la lista de Tab) entre jugadores que usan Venus, con el mod "Venus Badge" en instancias Fabric o Quilt 1.20.1, 1.21 y 1.21.1, NeoForge 1.21 y 1.21.1 y Forge 1.20.1 ([docs/insignia.md](docs/insignia.md)).
- **Asistente IA**: chat con Claude que responde dudas y hace cambios en tus instancias con herramientas controladas (más abajo).
- **Versiones e instancias**: todas las versiones del manifiesto de Mojang (releases, snapshots, bromas del 1 de abril, beta, alpha, infdev, indev, classic) y 9 loaders con su lista completa de versiones. Instancias en cuadrícula o lista, con búsqueda, orden y grupos; importación de `.mrpack`, de otros launchers (CurseForge, MultiMC, Prism) y del launcher oficial de Minecraft (perfiles, mundos, mods y opciones; solo copia); arranque rápido sin red si nada cambió. La página de cada instancia tiene resumen, contenido (mods, resource packs, shaders y data packs por mundo), mundos, capturas, registros y ajustes, más estas **herramientas**:
  - Instantáneas (guardar y restaurar el estado, automáticas antes de jugar), exportar como `.mrpack` o `.zip` de Prism/MultiMC y actualizar el modpack viendo qué cambia.
  - Compartir con un código `PACK-XXXXXX` o en grupo (se actualiza solo para todos), nube de mundos y configuraciones, y "Mundo con amigos" para abrir tu mundo por internet.
  - Servidor espejo (un servidor local con el mismo loader y mods), buscar actualizaciones de mods con changelog e historial para volver atrás, análisis de seguridad contra malware (Fractureiser y otros), informe de mixins (conflictos entre mods), traducción de mods con IA, Optimizar (memoria y mods de rendimiento), diagnóstico de crashes y reparar.
- **Mundos**: todos los mundos de todas las instancias con línea de tiempo de partidas y logros, estadísticas, copias de seguridad (restaurar o recuperar mundos borrados), copiar a otra instancia o a un servidor local, mapa del mundo y la pestaña **Capturas y clips** con opción de compartir por link.
- **Skins**: tu skin en 3D, un catálogo de 4.311 skins (Estéticas, Kawaii y Lindas) con búsqueda y favoritas, una biblioteca con tus propios PNG y el cambio de skin y capa de tu cuenta de Microsoft con la API oficial.

### Contenido

- **Modrinth**: mods, modpacks, shaders, resource packs, data packs y plugins con carga infinita, filtros (categorías, loader, versión, entorno, licencia, "Compatible con" una instancia o servidor), detalle con galería y versiones, y comparador de shaders y resource packs. Antes de instalar revisa la compatibilidad (versión, loader, dependencias, incompatibilidades y duplicados). **CurseForge** se configura en Administración → Integraciones; la clave central queda en el servidor y el catálogo se usa con la sesión de Venus. Se conserva el respaldo de claves incluidas en builds anteriores.
- **Buscador inteligente**: pedí en lenguaje natural ("mods de tecnología para jugar con amigos en la 1.20.1") y arma un kit compatible agrupado por tipo, listo para instalar en una instancia o crear una nueva. Funciona sin IA y mejora con IA.

### En línea

- **Multijugador**: destacados, tus servidores (lee y escribe `servers.dat` de cada instancia), amigos jugando y búsqueda por dirección, con MOTD, latencia y jugadores. "Unirme" elige una instancia compatible o la crea, y **Armar instancia desde un servidor** detecta la versión, el loader y los mods.
- **Servidores locales**: 13 tipos (Vanilla, Paper, Purpur, Folia, Spigot, Fabric, Quilt, Forge, NeoForge, Mohist, Youer, Velocity y Waterfall) con consola, jugadores, propiedades, reglas del juego, mundo y copias, plugins o mods, red (UPnP, túnel para jugar sin abrir puertos), automatización (reinicios y copias programadas) y "Jugar en este servidor".
- **Voice Chat**: salas con código, contraseña opcional y hasta 8 personas, pulsar para hablar, volumen por persona, pantalla compartida, soundboard, chat de la sala, moderación y la instalación de **Simple Voice Chat** para voz de proximidad dentro del juego.
- **Mensajes**: amigos por código `VENUS-XXXXXX` o nombre de usuario, presencia y actividad ("Jugando 1.21.1 Fabric · mc.ejemplo.net"), chat 1:1 en tiempo real con respuestas, reacciones, edición, avisos de lectura, y botones para unirte al juego de un amigo o invitarlo a voz.

### Herramientas

- **Estadísticas**: tiempo jugado, rachas, calendario, horarios, versiones y loaders, estadísticas del juego por mundo (bloques, criaturas, logros), tiempo por mundo y servidor, hitos, exportación a CSV o JSON y **Tu resumen de Venus**, una imagen para compartir (copiar o guardar como PNG) que se arma en tu PC.
- **Rendimiento**: memoria automática según tu PC y cada modpack (o manual con un solo deslizador), recolector de Java explicado, prueba de rendimiento de la CPU, monitor en vivo y "Optimizar una instancia" con mods de rendimiento y packs de contenido verificados.
- **Soporte**: consultas con el equipo de Venus desde el launcher (tickets con conversación).

### Asistente IA

Abrilo desde el menú, con el botón **Asistente** de la barra de título o con **Ctrl+J**. Responde dudas y, cuando hace falta, lee información y hace cambios **solo** con herramientas controladas (crear instancias, instalar o actualizar mods, cambiar la RAM o la versión de Java, leer un crash...). Los cambios se pueden **Deshacer** con un clic y borrar un mod (va a la papelera) pide confirmación. Funciona con la cuenta de Venus y un plan de Venus IA (Basic, Go, Pro o Max: pagos únicos con Mercado Pago en pesos o PayPal en dólares, el saldo no vence): el usuario elige el modelo y el esfuerzo que permite su plan. La IA también explica crashes, mejora el Buscador inteligente y traduce mods, y con un plan pago se puede usar Venus desde Claude o ChatGPT por MCP ([docs/mcp.md](docs/mcp.md)) o, al revés, que **tu propio Claude Code o Codex** respondan el asistente desde Venus con tu cuenta y tus límites ([docs/asistente-ia.md](docs/asistente-ia.md), sección 11).

### Ajustes

General (idioma y qué hace el launcher al jugar), Apariencia (temas planetarios, color propio, galería de 99 fondos con 16 animados, tu propia imagen o video, la página de fondos para bajarlos, música y marca propia), Accesibilidad (daltonismo, alto contraste, escala, movimiento reducido, control), Cuenta y nube (cuentas de Minecraft y cuenta de Venus), Privacidad (con Discord Rich Presence y el **modo streamer**, que difumina códigos, direcciones, nombres de amigos y mensajes mientras transmitís), Inteligencia artificial (con Claude y ChatGPT por MCP, y tu Claude Code o tu Codex como motor del Asistente), Plan (planes, compra y saldo de Venus IA), Java, Descargas y almacenamiento (límite de velocidad, modo sin conexión, uso del disco, unificar archivos repetidos y limpieza), Datos (carpeta, caché y modo portable) y Acerca de.

### En todo el launcher

Bienvenida guiada la primera vez (idioma, cuentas, primera instancia, contenido y rendimiento), diagnóstico automático cuando el juego crashea (con arreglos en un clic y búsqueda del mod culpable), avisos antes de jugar (malware, conflictos de mixins, Java incompatible), **Estado de los servicios** (si no podés iniciar sesión o algo no descarga, te dice si es tu conexión o un servicio caído), paleta de comandos con **Ctrl+K**, navegación completa con control (Xbox, PlayStation, Switch) y modo sofá, descargas que se retoman si se cortan e instantánea automática antes de jugar.

## Requisitos

- **Para jugar**: Windows 10 u 11 e internet para descargar el juego y el contenido. Java **no** hace falta: el launcher descarga el Java oficial de Mojang que pide cada versión (8, 16, 17, 21 o 25), con Adoptium de respaldo.
- **Para desarrollar**: Node.js **22.12 o superior** (el proyecto se usa con Node 24) y npm. `package.json` también trae la configuración de electron-builder para Linux (AppImage) y macOS (dmg), que se compilan en esos sistemas.
- **Para compilar (el dueño)**: CurseForge en Administración → Integraciones ([configuración y requisitos](docs/admin.md#curseforge-desde-integraciones-450)); `VENUS_CURSEFORGE_API_KEY` de GitHub Actions queda como respaldo opcional de builds anteriores, el proyecto de Supabase en `src/main/core/cloud-defaults.js` y, en `src/main/core/app-config.js`, el cliente propio de Microsoft cuando esté aprobado ([docs/login-microsoft.md](docs/login-microsoft.md)), el Application ID de Discord (Rich Presence) y, si hacen falta, el servidor TURN del Voice Chat y el servidor de túneles bore. Los usuarios no cargan claves.

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

- `VenusLauncher-Setup.exe`: instalador (NSIS) que deja elegir la carpeta y crea accesos directos.
- `VenusLauncher-Portable.exe`: versión portable, sin instalar. Guarda sus datos en `VenusData`, al lado del `.exe`. No se actualiza sola: avisa cuando hay una versión nueva y da el link.

## Scripts de desarrollo

| Script | Para qué |
|---|---|
| `node scripts/check.js [carpeta-o-archivo]` | Chequeo de sintaxis sin abrir Electron (proceso principal como CommonJS e interfaz como módulos ES). Tiene que dar 0 errores. |
| `node scripts/i18n-check.js [idioma...]` · `--summary` | Compara cada idioma contra el español: archivos y claves faltantes, claves sobrantes y `{variables}` distintas. |
| `node scripts/contracts-check.js` | Cruza los canales que usa la interfaz con los que registra el proceso principal: tiene que dar 0 "sin handler". También lista los canales que nadie usa y los registrados dos veces. |
| `python scripts/import-wallpapers.py <carpeta o .zip>` | Agrega imágenes y videos a la galería de fondos (los originales en `web/fondos/`, fuera del repositorio, y una copia en `src/renderer/assets/wallpapers/` para el launcher) sin repetir los que ya están (compara un hash perceptual). Convierte las imágenes a WebP y los videos a MP4 1080p sin audio (con el ffmpeg de `imageio-ffmpeg` o del PATH) y rearma `web/fondos/lista.js`, que lee `web/fondos.html`. |
| `node scripts/build-badge-mod.js` · `npm run mod:badge` | Compila el mod de la insignia para cada loader (`mod/venus-badge`, necesita Java 25 o más nuevo para correr Gradle; el Java 17 y 21 de cada compilación los baja Gradle si faltan) y copia los `.jar` a `src/main/modules/ingame/mods`, donde lo busca el launcher. En las releases lo hace `.github/workflows/mod.yml`. Ver [docs/insignia.md](docs/insignia.md). |
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

El launcher instalado se actualiza solo desde las [releases de GitHub](https://github.com/rponfee/Venus-Launcher/releases) (electron-updater, repositorio en `venusUpdates.githubRepository` de `package.json`). Para publicar una versión: subí la versión en `package.json`, compilá con `npm run dist` y creá la release `v<versión>` con `VenusLauncher-Setup.exe`, `VenusLauncher-Portable.exe`, `VenusLauncher-Setup.exe.blockmap` y `latest.yml`. Los nombres son fijos a propósito: el link `releases/latest/download/VenusLauncher-Setup.exe` baja siempre la última versión. También se puede con `npm run release` o con el workflow `.github/workflows/release.yml` al subir un tag `v*`. La versión portable no se actualiza sola: lee `latest.yml` de la última release y avisa con el link para bajarla (solo si está activada la búsqueda automática o al tocar **Buscar actualizaciones**).

## Cómo está armado

Electron 44 con JavaScript sin frameworks ni build: proceso principal en CommonJS (`src/main/`, con un núcleo en `core/` y un archivo por función en `modules/` que se carga solo) e interfaz en módulos ES (`src/renderer/`, una página por ruta y diálogos reutilizables en `features/`). La arquitectura, los canales entre procesos, los contratos entre módulos y las reglas para programar están en [docs/arquitectura.md](docs/arquitectura.md).

## Notas

- **Cuentas**: el inicio de sesión de Microsoft usa el flujo de Xbox Live y verifica que la cuenta tenga Minecraft: Java Edition (compra o Game Pass). También se pueden usar cuentas sin conexión, sin cuenta de Microsoft: solo piden un nombre de jugador y sirven para jugar solo, en LAN o en servidores con `online-mode=false`.
- **Voice Chat**: las llamadas van directo entre los jugadores (WebRTC). Cuando la red no lo permite, o con "Ocultar mi IP", el audio pasa por el servidor TURN de Venus con claves temporales que entrega la Edge Function `voice-turn`: [docs/voice-turn.md](docs/voice-turn.md).
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

Venus Launcher does not include telemetry or analytics. Features that would contact a service on their own (checking for updates, Minecraft news, featured servers, player heads and Discord Rich Presence) are off until the user turns them on, when the launcher first asks or in **Settings → Privacy**. The 4.5.0 branch adds separate, default-off choices for settings sync, extension catalog and blocklist downloads, wiki access, and sharing clan playtime. Discord webhooks and push have their own controls. The descriptions below include that unpublished branch; they do not announce that its services have been deployed. Other connections occur when the corresponding feature is used:

| When you… | The launcher contacts |
|---|---|
| Sign in with Microsoft or play | Microsoft / Xbox Live and Mojang (sign-in, ownership check, game files, Java runtime) |
| Open **Skins** with a Microsoft account, or change your skin or cape | Minecraft Services (`api.minecraftservices.com`) with your Microsoft account, to read your profile and change your skin or cape, and `textures.minecraft.net` for the skin and cape images (plus Microsoft / Xbox Live if your sign-in needs renewing, as when you play). Your skin library stays on your PC |
| Use an animated wallpaper for the first time | `venus-launcher-fondos.netlify.app` (with GitHub as a backup), to download that video once. Animated wallpapers are not in the installer. Nothing about you is sent |
| Browse or install content | Modrinth, CurseForge, the loader sites (Fabric, Quilt, Forge, NeoForge, Legacy Fabric, Babric), OptiFine, PaperMC, Purpur, Mohist and Adoptium |
| Use your Venus account (friends, messages, Voice Chat, cloud, shared modpacks, AI features, support) | The Venus Launcher server (Supabase); AI features send your question and the related launcher context (instance, mods, logs) to the AI provider through that server (Anthropic; OpenAI only if enabled there as a fallback) |
| Use your own Claude Code or Codex in the assistant, or connect an MCP client | Anthropic or OpenAI through your own CLI and account; the MCP client you connect |
| Check or join a server | That server, and GitHub (public Minecraft protocol list) |
| Talk in Voice Chat | The other people in the room, directly (peer-to-peer), and Google's public STUN servers to find a route. When a direct connection is not possible, or if you turn on “Hide my IP”, the encrypted audio is relayed through the Venus voice (TURN) server, which cannot listen to it |
| Buy a Venus AI plan | Mercado Pago or PayPal, in your browser |
| Play with friends over the internet | The tunnel service you choose (bore, playit.gg or e4mc) or your router (UPnP / NAT-PMP) |
| Open **Service status** (Settings, Ctrl+K, or its button on a failed task or sign-in), or right after a Microsoft sign-in fails | One small request to each service, with nothing about you. After a failed sign-in: `login.live.com`, `user.auth.xboxlive.com` and `api.minecraftservices.com`, plus `www.cloudflare.com` and `1.1.1.1` (a neutral connection check) only if none of them answered; nothing when the error is about your account or already shows Microsoft failed on their side. When you open the panel: those five plus `piston-meta.mojang.com`, `libraries.minecraft.net`, `resources.download.minecraft.net`, `api.modrinth.com`, `api.curseforge.com` (only if the build includes CurseForge) and the Venus server (health check). Nothing in offline mode |
| Turn on an optional connection | GitHub (updates), Mojang (news, and the alert when a new Minecraft version is out: it reads Mojang's version list when the launcher opens and every 6 hours), the Venus server and each featured server (status), mc-heads.net (player heads), Discord (Rich Presence) |
| Use **Music** | Nothing over the network: it reads and controls the players on your PC through Windows' media controls (Spotify, YouTube Music, Apple Music, browsers…) and the Windows volume mixer. **Open Spotify** only opens the app |
| Use the **in-game overlay**, **recording** or **instant replay** | Recordings, replays and screenshots stay on your PC (inside each instance). Optional AI and wiki panels use the connections described separately below. Instant replay is off by default and only keeps the last seconds in a temporary folder on your disk while the game is open. Automatic clips are also off by default: they read the game's own log on your PC. The overlay's **Performance** widget reads the game's RAM and CPU on your PC and, only while you are on a server, pings that server every 10 seconds (the same Server List Ping as Multiplayer) |
| **Share** a clip or screenshot, send it **to a friend** or **feature it on your profile** | The Venus server (Supabase Storage): a shared clip or screenshot gets a signed link that expires; a featured screenshot or a profile banner goes to the public `profile-media` folder of your account, so anyone with its link can see it |
| **Describe screenshots with AI** (Clips, only when you press the button and confirm) | Those screenshots (up to 20 at a time) go to the AI provider through the Venus server, like any AI feature |
| Search a **GIF for your banner** or **send a GIF in Messages** (KLIPY), or view a profile or a message that uses one | KLIPY (`api.klipy.com`, `static.klipy.com`) directly from your PC: your search text, your language's country and an anonymous hash of your account; never your name or email. A GIF message is only its KLIPY link, which goes to your friend through the Venus server like any message and is then loaded from KLIPY by their launcher |
| View someone's **3D skin** on their profile (only when you press the button) | Mojang (`api.mojang.com`, `sessionserver.mojang.com`, `textures.minecraft.net`) with that player's Minecraft name |
| Customize your **profile** | The Venus server: pronouns, description, colors, name style, banner, card theme, chat bubble, voice entry effect, skin pose, rare badges, status (with its emoji and expiry), favorite servers, featured screenshots and equipped cosmetics are visible to other signed-in Venus users. Your play stats are published only if you turn on **Publish my stats** |
| Add a **profile song**, or open the card of a friend who has one | The Venus server (Supabase Storage): the 30-second clip you prepare on your PC (re-encoded, at most 1 MB; the original file never leaves your PC) goes to the public `profile-audio` folder of your account, so anyone with its link can play it, although the launcher only offers it to your friends and you. Playing a friend's song downloads it from there; **Do not play profile songs** turns it off |
| Write in a **guestbook**, send a **gift** or **report** a profile | The Venus server, with your account: the message (visible to anyone who opens that card), the gift (Venus Points or a shop cosmetic, between friends only) or the report |
| Use the **Toolbox**, **scheduled downloads**, **break reminders** or the **session recap** | Nothing over the network: everything is computed on your PC (scheduled downloads only pause and resume the launcher's own downloads) |
| Use **Venus Points** (daily reward, achievements, missions, referral code, shop) | The Venus server. To get paid for a referral, **Verify my Minecraft account** uses Mojang's session server with your Minecraft token, like the Venus badge, so the Venus server can confirm the account is yours without receiving that token. Achievements from your PC only send which achievement you unlocked |
| Use **parties** or **alerts** | Parties: the Venus server, only to the friends you invite (who is in the group, the instance and the server you chose). Alerts: your friends' activity comes from the Venus server as before; if you turn on alerts for favorite servers, the launcher pings those servers every 5 minutes while it is open (off by default for your profile's favorites) |
| Browse or publish **community themes** | The Venus server (only colors and the id of a Venus wallpaper; never files or paths from your PC) |
| Turn on the **Venus badge** (Settings → General, off by default) | To register: the Venus server with your Venus session (it stores only your Minecraft UUID linked to your Venus account) and Mojang's session server (`sessionserver.mojang.com`) with your Minecraft token, the same request the game makes when joining an online-mode server, so the Venus server can confirm the account is yours without ever receiving that token. While you play on an instance the mod supports (Fabric or Quilt 1.20.1, 1.21 and 1.21.1, NeoForge 1.21 and 1.21.1, Forge 1.20.1), the "Venus Badge" mod sends the Venus server the UUIDs of the players you see, in batches and at most once every few seconds, and gets back which of them have the badge and its style (golden for Venus Premium or the one bought with Venus Points; no names, servers, IPs of other players or account data). Turning it off removes your UUIDs from the server and the mod from your instances |

Connections prepared in the unpublished 4.5.0 branch:

| When you… | The launcher contacts |
|---|---|
| Enable **remote control of a local server** | Your phone connects to an HTTP service bound to the PC's private LAN address. Status, players, console output and commands travel over that local connection without TLS. The access link grants control while enabled; it expires and can be rotated or revoked. No Internet tunnel is opened automatically |
| Enable **Discord server notifications** | The configured Discord webhook receives selected events and server/player names. It does not receive console output, local paths or IP addresses. The webhook is stored encrypted on the PC; this switch is separate from Discord Rich Presence |
| Enable **settings and theme sync** | The Venus server receives only allowed appearance fields, saved looks, menu and Home layout, with per-key timestamps. Sync is off by default and excludes accounts, tokens, paths, family PIN and privacy permissions |
| Open a recipe's **wiki** link | Minecraft Wiki in your browser, after separate consent, off by default. Recipes themselves are read from local game/mod files |
| Translate messages or ask AI to explain a mod changelog | The selected text goes to the AI provider through the Venus AI service using your plan. Message translation requires prior consent, can be enabled per conversation and keeps an encrypted local cache that can be cleared |
| Upload or view **stickers** | The Venus server and its public `stickers` bucket. Uploaded files are limited to 256 KB; anyone with a sticker URL can access it even though the conversation is private |
| Use **soundboard or voice effects** | Audio is generated/processed locally and sent through the existing Voice Chat connection. A local effect preview is not sent to the room |
| Share **rankings**, enter **challenges** or sign up for **events** | The Venus server with your account, local play statistics and participation. Friends rankings require opt-in, off by default; locally reported statistics are not independently verified gameplay |
| Join **clans or communities**, or share clan hours | The Venus server with membership, channel messages and roles. Clan playtime needs a separate default-off permission as well as friends-stat sharing. Its aggregate is visible to signed-in users, includes hours already reported that week and needs at least two contributors; that threshold does not guarantee anonymity |
| Review, vote for or report a **featured server** | The Venus server receives your account-linked rating, review, vote or report. Public summaries and reviews can be read by other users; reports are for moderation |
| Upload a clip to **YouTube or TikTok** | The chosen provider receives OAuth authorization, the selected video and upload metadata. TikTok token exchange goes through the Venus server. YouTube defaults to private; TikTok sends a draft. Direct upload requires an approved working provider flow; only public client identifiers are bundled, never OAuth client secrets |
| Enable **OBS integration** | The OBS WebSocket on this PC or a private LAN host, with the password if configured. Connection and scene/recording controls are optional; the password is stored encrypted locally |
| Publish, like or report a clip in the **gallery** | The Venus server with the clip reference, title, account, like or report. Gallery viewing requires sign-in. Removing a publication does not revoke an already issued signed link or by itself delete the Storage object |
| Browse, submit or update **extensions** through the optional catalog | The Venus server and its package storage with catalog searches, submitted packages or catalog IDs requested for update checks. The catalog is off by default and distinct from the blocklist setting |
| Allow **extension blocklist updates** | The Venus server's general blocklist, shortly after startup and every four hours while allowed, plus reconnection checks. No installed-extension inventory is sent. Consent is separate and off by default; the cached list still applies offline but cannot reveal newer blocks |
| Use the **mobile web app** | The Venus server for your own session, friends, messages and received clips; linked images/media use their existing sources. The session is stored on that device in IndexedDB, with an in-memory fallback. Signing out of the launcher affects only that device and leaves the mobile session open |
| Enable **mobile push notifications** | The Venus server stores the subscription endpoint; the browser's push provider (FCM, Mozilla, Apple or Windows) handles delivery. Web Push carries an empty payload; the service worker then fetches the inbox using the device's session and preview preference. This is optional, not message end-to-end encryption |
| Equip or display **Venus capes** | The Venus server stores the account's cape choice and the mod queries verified Minecraft UUIDs, in batches, for cape IDs. Textures are bundled with the mod; no arbitrary texture URL is supplied by another player. An official Minecraft cape takes priority |

The stats recap image (**Share my recap**) and importing from the official Minecraft launcher work on your PC and upload nothing; the import only downloads Mojang's version list (`piston-meta.mojang.com`) if neither Venus nor the official launcher has saved it yet.

Seed previews, family controls, shared game options, performance history, local backups, montage and timelapse run locally. Cloud sync, sharing, AI or provider upload use the separate connections described above. Portable builds also register the `venus://` protocol in Windows, as explicitly retained for 4.5.0.

Google’s [desktop OAuth documentation](https://developers.google.com/identity/protocols/oauth2/native-app), consulted on November 3, 2026, marks `client_secret` as optional. Venus still bundles only public client identifiers; real OAuth and uploads remain unverified.

Each of those services has its own privacy policy.

## Licencia

[MIT](LICENSE). Venus Launcher no está afiliado a Mojang Studios ni a Microsoft. Minecraft es una marca de Mojang Synergies AB.

Los fondos de la galería (`src/renderer/assets/wallpapers/` y la página `web/fondos/`) y las skins del catálogo (`src/renderer/assets/skins/`) son de sus autores y de los dueños de cada personaje o marca: no están cubiertos por la licencia MIT. El origen de cada uno está en `web/fondos/manifest.json`.
