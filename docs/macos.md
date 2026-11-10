# Venus Launcher para macOS

Desde la 6.1 hay una versión para Mac: **la misma interfaz y los mismos 14 idiomas que en Windows**, en un solo archivo
universal que anda en Macs con Apple Silicon (M1 en adelante) y con Intel, desde macOS 12 Monterey. Este documento
cuenta qué se adaptó, qué no está, cómo se compila, cómo se prueba y los límites conocidos. Para instalarla:
[README, sección macOS](../README.md#macos).

## Qué se adaptó

| Parte | Qué hace en macOS | Dónde |
|---|---|---|
| Plataforma | Un solo lugar dice qué funciones existen en cada sistema: `supports('overlay')`, `capabilities()`. La interfaz lo recibe en `app:info.capabilities` (`src/renderer/js/platform.js` → `supports()`). | `src/main/core/platform.js` |
| Arranque | `app.setAppUserModelId` solo en Windows (en macOS no existe y cortaba el arranque). Carpeta de datos: `~/Library/Application Support/.venuslauncher` (`app.getPath('appData')`). | `src/main/main.js` |
| Ventana | La misma ventana sin marco con los botones propios del launcher. Clic en el ícono del Dock: vuelve a mostrarla (también si se ocultó al abrir el juego). Cerrar la ventana cierra el launcher, igual que en Windows. | `main.js` (`activate`, `window-all-closed`) |
| Menú | Menú mínimo de la aplicación (Venus Launcher, Edición, Ventana) para que anden Cmd+C/V/X/A/Z en los campos de texto y Cmd+Q. Sin menú Ver (Cmd+R) y "Minimizar" sin Cmd+M, para no quitarle atajos al launcher. Textos en el idioma elegido (`src/main/i18n/<idioma>/macos.js`). | `src/main/core/app-menu.js` |
| Atajos | Ctrl+K, Ctrl+J y Ctrl+M andan con Cmd o con Ctrl. Los textos con atajos se muestran como en Mac ("⌘K", "⇧⌘R", "⌘ + Enter"); "Ctrl izquierdo" o "Ctrl+Alt" (teclas físicas) quedan igual. | `src/renderer/js/platform.js` (`modKey`, `keyLabel`), `i18n.js`, `a11y/palette.js` |
| Java | Runtimes de Mojang `mac-os` (Intel) y `mac-os-arm64` con la estructura `jre.bundle/Contents/Home/bin/java`, permisos de ejecución y enlaces al instalar. Adoptium de respaldo en `tar.gz` para mac. También encuentra los Java de `/Library/Java/JavaVirtualMachines` y `~/Library/Java/JavaVirtualMachines`. | `src/main/core/java.js` |
| Apple Silicon y versiones viejas | Antes de la 1.19 Minecraft no trae nativos de LWJGL para arm64. Esas versiones se lanzan con el **Java x64 de Mojang a través de Rosetta 2** (como el launcher oficial), en una carpeta aparte (`runtime/<componente>-x64`). Si Rosetta no está instalado, avisa antes de bajar nada: "abrí Terminal y escribí `softwareupdate --install-rosetta --agree-to-license`". | `core/platform.js` (`gameArch`, `rosettaInstalled`), `core/instances.js` (`resolveJava`), `core/java.js` |
| Lanzar Minecraft | Reglas `osx` y `arch` de los JSON de versión, nativos `natives-osx` / `natives-macos` (se extraen) y `natives-macos-arm64` (van en el classpath), separador `:` del classpath. En los JSON viejos (1.12.2 y anteriores, LWJGL 2) **no** se agrega `-XstartOnFirstThread` (con LWJGL 2 la ventana se cuelga); sí con LWJGL 3. `-Xdock:name=Minecraft` para el nombre en el Dock. | `core/launch.js`, `core/minecraft.js`, `core/rules.js` |
| Cerrar el juego | Sin `taskkill`: SIGTERM al grupo de procesos del juego (se lanza con `detached`) y SIGKILL a los 4 s si sigue abierto. El control parental usa solo SIGTERM (`game.stop(id, { force: false })`): queda marcado como cerrado por el launcher, así la salida 143 de Java no cuenta como crash. Los servidores locales ya usaban señales. | `core/platform.js` (`stopProcess`), `core/game.js`, `modules/family.js` |
| Inicio de sesión de Microsoft | En macOS la ventana no es modal: una modal con padre sería una hoja sin botón de cerrar. Va como ventana hija con su botón rojo y Cmd+W; cerrarla cancela el inicio de sesión, como la X en Windows. | `main.js` (`openLoginWindow`), `core/platform.js` (`loginWindowModal`, `isCloseWindowShortcut`) |
| Voice Chat | Micrófono con permiso de macOS: `NSMicrophoneUsageDescription` en el Info.plist y `systemPreferences.askForMediaAccess` la primera vez. Compartir pantalla usa el selector del sistema (pide "Grabación de pantalla") y no depende del permiso del micrófono; el sonido del equipo al compartir es solo de Windows. | `main.js`, `package.json` (`build.mac.extendInfo`) |
| Discord Rich Presence | Socket Unix en `$TMPDIR/discord-ipc-N` (ya estaba; ahora con prueba). | `modules/discord/ipc.js` |
| Links `venus://` | `open-url` de macOS y `CFBundleURLTypes` en el Info.plist (`build.mac.protocols`). Con un link válido la ventana vuelve al frente aunque esté minimizada u oculta (en Windows lo hace `second-instance`). | `modules/deeplink.js`, `package.json` |
| Almacén seguro | `safeStorage` usa el Llavero de macOS. | `core/cipher.js` |
| Actualizaciones | Sin firma de Apple, `electron-updater` no puede instalar. Como la portable: lee `latest-mac.yml` de la última release, avisa y abre la descarga de `VenusLauncher-mac.dmg` (estado `edition: 'mac'`). Si la última release todavía no tiene `latest-mac.yml` (el job de Mac sube después, o falló), el 404 cuenta como "al día" y no como error. | `modules/updater/controller.js`, `features/update-notice.js`, `pages/settings/updates.js` |
| Música | El módulo no arranca el ayudante; la página Música dice "Disponible solo en Windows". | `modules/nowplaying.js` |

Lo demás (bienvenida, cuentas de Microsoft —salvo la ventana de inicio de sesión, ver arriba— y sin conexión, instancias de todos los loaders, Modrinth y CurseForge,
mundos, skins, servidores locales, túneles con bore —en JavaScript, sin binarios— e idioma del sistema) no depende del
sistema y es el mismo código que en Windows.

## Qué no está en macOS

Dependen de una API de Windows (`WINDOWS_ONLY` en `core/platform.js`); en macOS el módulo no arranca o no hace nada y la
interfaz no lo muestra o lo marca como no disponible:

- **Overlay del juego**: sigue la ventana del juego con Win32 (`overlay/tracker.js`). Ajustes dice que es solo para Windows y la bienvenida no muestra su paso.
- **Música** (controles multimedia de Windows 10 y 11).
- **Clips y capturas del juego**: la ventana del juego se busca con Win32 (`capture/window-find.js`). Se podría hacer con el permiso de "Grabación de pantalla" buscando la ventana por nombre en `desktopCapturer`, pero no se pudo probar en una Mac con un juego abierto: queda como no disponible.
- **Ícono y título de Venus en la ventana del juego** (PowerShell). El interruptor no aparece en Ajustes.
- **Accesos directos de instancias en el escritorio** (`.lnk`) y **accesos de Windows** (escritorio y menú Inicio).
- **Instalar actualizaciones solo** (ver arriba) y el **sonido del equipo** al compartir pantalla en el Voice Chat.

## Cómo se compila

Solo en una Mac (no se puede compilar ni firmar para macOS desde Windows):

```bash
npm ci
npm run dist:mac   # electron-builder --mac --universal --publish never
```

Deja en `dist/` `VenusLauncher-mac.dmg`, `VenusLauncher-mac.zip`, `latest-mac.yml` y la app en
`dist/mac-universal/Venus Launcher.app`. Configuración en `package.json` → `build.mac`:

- `target`: DMG y zip con `arch: universal` (Intel + Apple Silicon en un archivo). Nombre fijo `VenusLauncher-mac.${ext}` para los links `releases/latest/download/…`.
- `identity: "-"`: **firma ad hoc**. Sin cuenta de desarrollador de Apple no hay Developer ID ni notarización (`notarize: false`), pero en Apple Silicon una app sin ninguna firma no arranca. `hardenedRuntime: false`: con firma ad hoc y runtime endurecido haría falta `disable-library-validation` para cargar Electron Framework.
- `minimumSystemVersion: 12.0` (lo que pide Electron 44), `category: public.app-category.games`, `extendInfo` con `NSMicrophoneUsageDescription` y `protocols` con `venus`.
- Ícono: `build/icon-mac.png` (1024×1024, el planeta de `src/renderer/assets/logo.png` centrado con el margen que usan los íconos de macOS); electron-builder arma el `.icns`.
- `electronFuses` y la integridad del asar son los mismos que en Windows: en macOS el hash del `app.asar` va en `ElectronAsarIntegrity` del Info.plist y la app universal tiene dos copias del cable de fuses (una por arquitectura). `venus.ico` (`extraResources`) y `nsis` son de Windows y no molestan.

## Cómo se prueba (GitHub Actions)

El job `mac` de `.github/workflows/build.yml` corre en `macos-latest` (Apple Silicon) después del de Windows:

1. Baja el mod de la insignia (va dentro del paquete, igual que en Windows), `npm ci`, `node scripts/check.js`, `node scripts/contracts-check.js` y las pruebas que dependen de la plataforma (`src/main/core/test`, updater, discord, deeplink, ingame, shortcuts y `src/renderer/js/platform/test`), ahora en una Mac de verdad: ahí corre además la instalación de un runtime con `jre.bundle`, permisos y enlaces (`core/test/java-platform.test.js`), que en Windows se salta.
2. Compila el DMG universal, revisa el paquete (`scripts/check-package.js`), muestra la firma (`codesign -dv`) y comprueba que el mod esté dentro del `app.asar`.
3. `node scripts/smoke-packaged.js`: los dos cables de fuses, que sea universal (`lipo`), el Info.plist (micrófono, `venus://`, integridad, categoría), `codesign --verify` y la firma ad hoc; abre la app empaquetada con una carpeta de datos temporal y revisa que cargue la interfaz sin errores, que `app:info` diga macOS con overlay, música y clips apagados y que las actualizaciones sean a mano con el `.dmg`.
4. Si el runner tiene Rosetta 2, abre también la parte Intel (`smoke-packaged.js --x64`).
5. Capturas con `VENUS_DEVSHOT` (Inicio, Mis instancias, Música y Ajustes) desde el código sin empaquetar, porque `scripts/devshot.js` no va en el paquete.
6. Sube el artefacto `VenusLauncher-mac` (DMG, zip, `latest-mac.yml` y las capturas). Con un tag `v*` suma esos archivos a la release que creó el job de Windows (nunca la crea: si el de Mac falla, la de Windows ya salió).

**Probar sin publicar**: subí una rama `mac-*` (por ejemplo `mac-6.1`). `.github/workflows/mac-test.yml` llama a
`build.yml` con `solo_mac: true`: mod, chequeos y el job de Mac, sin Windows ni release. El DMG queda en el artefacto
de la corrida (pestaña Actions → la corrida → Artifacts).

## Límites conocidos

- **Sin firma de Apple**: la primera vez hay que abrirla con clic derecho → Abrir (macOS 12 a 14) o desde Ajustes del Sistema → Privacidad y seguridad → **Abrir igualmente** (macOS 15+), o con `xattr -dr com.apple.quarantine "/Applications/Venus Launcher.app"`. Cada versión nueva tiene otra firma ad hoc: el Llavero puede volver a preguntar si Venus puede usar su clave guardada ("Permitir siempre").
- **Lo que solo se verifica en una Mac real** (el CI abre el launcher pero no juega): bajar el Java de Mojang y abrir Minecraft (1.21 nativo en Apple Silicon y 1.16.5 o 1.8.9 con Rosetta), el cierre del juego con señales, el permiso del micrófono y el Voice Chat, Discord Rich Presence con Discord abierto, los links `venus://` desde el navegador, el inicio de sesión de Microsoft, el aviso de actualización contra una release real y el aspecto de la ventana sin marco en macOS.
- Un **Java elegido a mano** (o el que propone el análisis de crashes) no pasa por la elección de arquitectura: en Apple Silicon, un Java arm64 no abre versiones anteriores a la 1.19.
- El cierre "amable" del control parental en macOS es SIGTERM: Minecraft se cierra, pero no siempre guarda el mundo como con el botón de cerrar de la ventana.
- `NSMicrophoneUsageDescription` va en inglés y español en un mismo texto (electron-builder no arma `InfoPlist.strings` por idioma).
