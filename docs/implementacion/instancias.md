# Instancias: aspecto, ajustes compartidos, sets, enlaces y changelog

> **Rama 4.5.0, sin publicar.** Consolidación documental del 3 de noviembre de 2026, reconciliada con el WIP congelado. Los informes de cada frente se conservan como antecedentes; las pruebas posteriores están atribuidas al final o en el estado de integración. Contratos y límites del código local; producción continúa hasta 0027 según la integración principal. Los resultados previos pertenecen a sus informes y no equivalen a pruebas externas repetidas ni a un despliegue. Ver [estado de integración](../estado-4.5.0.md).

Referencia de uso y contratos de las herramientas de instancia. Se complementa con [arquitectura](../arquitectura.md) y [funciones](../funciones.md).

## Cómo se usa

- **Aspecto por instancia.** Instancia → Resumen → Presentación → **Personalizar**. Se elige color (planeta o propio), fondo (galería o imagen o video propio) y música (sin música o un archivo), o se parte de un look guardado. Cada parte puede quedar "Como el launcher". Mientras el diálogo está abierto se ve como vista previa; solo **Guardar** lo escribe. Se aplica cuando esa instancia está seleccionada o corriendo y al salir vuelve el aspecto global.
- **Ajustes compartidos.** Instancia → Ajustes → **Ajustes compartidos**. "Guardar desde esta instancia" arma el perfil maestro con su `options.txt`; el interruptor "Usar el perfil en esta instancia" hace que se escriba antes de cada partida. Los grupos (Controles, Campo de visión, Sensibilidad, Sonido, Video, Chat, Accesibilidad) y "Al cerrar el juego, actualizar el perfil" son globales del perfil. Por defecto están prendidos los tres primeros.
- **Sets de mods.** Instancia → Contenido → Mods → **Sets de mods**. Se crea un set con lo activo ahora o desde las plantillas PvP, Shaders y Liviano (marcan los mods de ese estilo ya instalados y el usuario completa), se aplica con un clic y se puede deshacer. Si el set deja apagada una dependencia, avisa y ofrece activarla.
- **Links `venus://`.** Abrir un link desde afuera trae el launcher al frente y muestra un diálogo con qué va a pasar y de dónde viene. **Copiar link** está en Presentación y en el menú de la instancia: si se conoce el modpack de origen copia el link del pack (sirve en cualquier PC); si no, el de la instancia (solo sirve en esa PC).
- **¿Qué cambia?** Ícono de documento en cada fila de Contenido con origen conocido (mods, resource packs, shaders) y tarjeta **Actualizaciones de mods** en la página Actualizaciones y en Ajustes → Actualizaciones. Muestra el texto original de cada versión y, a pedido, **Explicar con IA**.

## Formatos de los links

```
venus://modpack/modrinth/<slug-o-id>[?version=<id>]
venus://modpack/curseforge/<id>
venus://server/<host[:puerto]>[?name=<nombre>]
venus://instance/<id>
```

Reglas (`modules/deeplink/parse.js`): hasta 512 caracteres, solo `A-Za-z0-9-._~%/?=&:[]+` después del esquema, sin porcentajes en la ruta, parámetros repetidos invalidan el link y los desconocidos se ignoran. Modrinth: slug de hasta 64 caracteres sin `..`, versión alfanumérica de 4 a 16. CurseForge: entero positivo de 32 bits. Servidor: dominio con al menos un punto y etiquetas LDH (sin `localhost`, `*.localhost`, nombres de una palabra ni números disfrazados), IPv4 sin ceros a la izquierda o IPv6 entre corchetes; se rechazan loopback, `0.x`, enlace local y multicast; una red privada o `.local`/`.lan` pasa con un aviso (`lan: true`). `name` es solo para mostrar: sin controles, marcas de dirección, códigos `§` ni `<>"`, hasta 40 caracteres; si está mal, el link sigue sin nombre. Instancia: un segmento seguro sin nombres de dispositivo. Hasta confirmar el diálogo no se conecta a nada.

## Archivos

Proceso principal (autocargados, con lógica sin Electron en su carpeta y pruebas en `test/`):

| Archivo | Qué hace |
|---|---|
| `src/main/modules/deeplink.js`, `deeplink/parse.js`, `deeplink/queue.js` | Protocolo, parser puro, cola hasta que la interfaz avisa |
| `src/main/modules/sharedoptions.js`, `sharedoptions/logic.js` | Perfil maestro, chequeo antes de jugar, lectura al cerrar |
| `src/main/modules/modsets.js`, `modsets/logic.js` | Sets, plan de renombrados, dependencias |
| `src/main/modules/modchangelog.js`, `modchangelog/logic.js` | Versiones entre la instalada y la nueva, HTML de CurseForge, pedido a la IA |
| `src/main/modules/instancemeta/meta.js` | Valida `look` y `sharedOptions` en `instances.update` |

Interfaz:

| Archivo | Qué hace |
|---|---|
| `src/renderer/js/features/instancelook.js` | Arranque, aplica el aspecto, tarjetas de Ajustes |
| `features/instancelook/logic.js` | Aspecto y link de una instancia, lógica pura |
| `features/instancelook/dialog.js` | Diálogo "Aspecto de la instancia" |
| `features/instancelook/links.js` | Diálogos de los links, `copyInstanceLink(inst)` |
| `features/instancelook/changelog.js` | `openModChangelog`, `modUpdatesPanel` |
| `pages/instance/modsets.js` | `openModSets(inst, { onChanged })` |
| `pages/instance/sharedoptions.js` | `sharedOptionsCard(ctx)` |
| `styles/features/instancetools.css` | Estilos con prefijo `.it-` |
| `i18n/{es,en}/instancetools.js` | Textos (claves nuevas `copyLink*` en `instance.js`) |

Toques en archivos existentes: `pages/instance.js` (namespace), `pages/instance/{content,presentation,settings}.js`, `pages/updates.js`, `pages/versions/common.js` (Copiar link en el menú), `appearance.js`.

### `appearance.js`

Nuevo export `setInstanceLook(parche | null)`. `ap` sigue siendo siempre lo que eligió el usuario (lo que se guarda, lo que muestra el panel y lo que lee cualquier otro módulo); una función interna `shown()` devuelve `ap` con el parche encima y solo la usan el dibujo del tema, del fondo y de la música. Por eso `currentWallpaperId()`, `appearanceSettings()`, los looks, las temporadas y los fondos rotativos no ven el aspecto de la instancia ni pueden guardarlo. Un color de la instancia también pisa el acento del editor de colores mientras dura.

## Canales

| Canal | Devuelve |
|---|---|
| `deeplink:ready()` | Cantidad de links que esperaban. Evento `deeplink:open` (acción de `parse.js`) |
| `sharedoptions:get(instanceId?)` | `{ profile, instance: { enabled, format, hasOptions, running } }` |
| `sharedoptions:saveFrom(instanceId)` | Resumen del perfil. Error `noOptions` |
| `sharedoptions:setPrefs({ groups?, syncBack? })` | Resumen del perfil |
| `modsets:list(id)` | `{ sets, lastApply, files, running }` |
| `modsets:template(id, templateId)` | Entradas iniciales |
| `modsets:save(id, set)` | `{ set, sets }`. Errores `badName`, `tooMany` |
| `modsets:remove(id, setId)` | `{ sets }` |
| `modsets:check(id, entries)` | `[{ file, title, dep, provider, providerTitle }]` |
| `modsets:apply(id, setId, { reason })` | `{ name, enabled, disabled, unknown, missing, conflicts, snapshotId }`. Errores `notFound`, `snapshotFailed`, `locked` (el `message` es el archivo), `alreadyRunning`, `instanceBusy`, `bisect` |
| `modsets:undo(id)` | Resultado de `snapshots.restore`. Error `noUndo` |
| `modchangelog:forFile(id, { folder?, file })` | `{ token, source, projectId, title, icon, slug, folder, file, from, to, upToDate, versions: [{ id, number, type, date, body, truncated }], moreVersions }`. Errores `offline`, `unknownOrigin`, `notInCatalog`, `curseforgeOff` |
| `modchangelog:list(id)` | `{ items: [{ source, projectId, folder, file, title, icon, from, to }], total }` |
| `modchangelog:aiStatus()` | `{ available, reason: null, 'offline', 'disabled', 'signedOut' o 'noPlan' }` |
| `modchangelog:explain(token)` | `{ summary, news, risks, at }`. Errores `badToken`, `offline` y los de la IA (6.7) |

## Datos

- `venus-instance.json`: `look` (`{ color?, background?, music? }` o `null`) y `sharedOptions` (`true`/`false`). Formas en `instancemeta/meta.js`. Las rutas de `look` tienen que ser locales y absolutas, con extensión de imagen, video o audio; nunca rutas de red.
- `<datos>/data/sharedoptions.json`: `{ version, groups, syncBack, common, bindings: { modern, legacy }, dataVersion: { modern, legacy }, source, updatedAt }`.
- `<instancia>/.venus/modsets.json`: `{ version, sets: [{ id, name, template, entries: [{ file, project, on }], createdAt, updatedAt }], lastApply }`. `project` (`modrinth:<id>` o `curseforge:<id>`) hace que el set reconozca un mod después de actualizarlo.
- `<instancia>/.venus/sharedoptions-backup.txt`: el `options.txt` de antes de la última escritura.
- Claves de `settings`: no suma ninguna.

## Decisiones y detalles

- **Teclas por formato.** Hasta la 1.12 son números y desde la 1.13 nombres; el perfil las guarda en dos cajones. Importante: Minecraft convierte las teclas según la clave `version` del archivo (`OptionsKeyLwjgl3Fix`) y, si encuentra un nombre donde espera un número, descarta **todas** las opciones. Por eso, además de la versión de la instancia, se mira el archivo: si no coinciden (la instancia cambió de versión y no se abrió) no se escriben teclas, y a un archivo sin `version` se le agrega la del perfil como primera línea. El modificador de Forge (`key.keyboard.g:SHIFT`) solo va a Forge y NeoForge.
- **Lo que queda afuera del perfil a propósito**: `lang`, `ao`, `graphicsMode`, `renderClouds` y demás opciones con formato distinto según la versión.
- **Sets**: un mod que el set no conoce queda como está (se avisa). Si conviven `x.jar` y `x.jar.disabled`, no se elige uno. Sin instantánea no se aplica. Las dependencias salen de los metadatos de cada `.jar` (`compat/inventory`, sin red): solo se avisa de un mod que está en la carpeta y queda apagado; lo que no está pudo venir adentro de otro `.jar`. Los módulos `fabric-*` cuentan como Fabric API.
- **Deshacer un set** restaura la instantánea entera (mods, configuración y opciones, no mundos), y el diálogo lo dice. Si la retención ya la borró, el error es el de snapshots.
- **Conexiones**: nada de esto se conecta solo. Los links no consultan nada hasta confirmar y "¿Qué cambia?" corre porque el usuario lo pide, así que no suma conexiones opcionales de `features/netprefs.js`; respeta el modo sin conexión de Descargas (`offline`). Elegir como aspecto un fondo animado que no está en la PC lo baja, igual que en Apariencia.
- **Changelog**: se muestra como texto plano (`pre-wrap`), sin interpretar markdown ni HTML; el de CurseForge pasa por `htmlToText`. A la IA va el texto que ya se mostró (el proceso principal lo guarda con un `token`, la interfaz no puede mandar otro), entre marcas con un número al azar y con la instrucción de tratarlo como dato. Es una sola consulta (`turnId`), con Haiku y esfuerzo bajo, y la respuesta queda en memoria para no gastar otra. Antes de mandar se pregunta siempre.
- **Actualizar**: `pages/updates.js` es la página de actualizaciones del launcher; las de mods viven en `features/compat.js`, que no se tocó. Por eso "¿Qué cambia?" está en la pestaña de contenido y en una tarjeta nueva de esa página, y el diálogo lleva a **Ir a actualizar** (`openModUpdates`) en los mods de Modrinth.

## Edición portable y desinstalar

- **Instalada**: registra `venus://` en `HKCU\Software\Classes\venus` en cada arranque.
- **Portable**: registra el `.exe` portable (`PORTABLE_EXECUTABLE_FILE`, no la copia temporal), y solo si ningún otro programa tiene el protocolo: no le saca los links a una instalada. Si se mueve el `.exe`, el link falla hasta volver a abrirlo. Esto escribe en el registro, algo que la portable no hacía.
- **Desinstalar:** `build/installer.nsh`, incluido por NSIS, elimina `HKCU\Software\Classes\venus` solo al desinstalar, no al actualizar, y únicamente si el comando `shell\open\command` coincide con el ejecutable de esa copia instalada y su argumento `%1`. Una asociación posterior a otra instalación o portable se conserva. Cambio de código revisado; compilación y prueba del instalador real pendientes de la integración principal.
- **Capturas** (`VENUS_DEVSHOT`): nunca registran el protocolo. Desarrollo sin capturas (`electron .`): registra Electron con la carpeta del proyecto y pisa lo de la instalada hasta que esta vuelva a abrirse.

## Límites

- `sharedOptions` y `look` no pasan a una copia de la instancia en la lista fija de campos de `core/instances.duplicate`. Los sets sí se copian, pero `lastApply` se limpia: la copia no ofrece Deshacer contra una instantánea de la original.
- Con Video prendido en el perfil, cada partida pisa lo que hayan elegido Optimizar o el asistente en esa instancia, y lo mismo con las demás claves compartidas; el aviso está en la descripción del grupo.
- El perfil es uno solo. Las teclas de mods viajan a todas las instancias; las de mods que no están las descarta Minecraft al guardar, sin consecuencias.
- La lista de **Actualizaciones de mods** usa `compat.listUpdates` (por hash en Modrinth) y los registros de CurseForge (hasta 60 mods). Un mod de otra fuente no aparece.
- Otra instancia corriendo no impide aplicar un set en esta, salvo que compartan un `.jar` por enlace duro y Windows lo tenga bloqueado (`locked`, sin cambios).

## Probar

```bash
node --test "src/main/modules/deeplink/test/" "src/main/modules/sharedoptions/test/" "src/main/modules/modsets/test/" "src/main/modules/modchangelog/test/" "src/main/modules/instancemeta/test/" "src/renderer/js/features/instancelook/test/*.test.js"
```

Capturas: `VENUS_CHANGELOG_FAKE=1` (con `VENUS_DEVSHOT` y sin empaquetar) usa una respuesta de IA de ejemplo. Un link se prueba pasándolo como argumento: `electron . "venus://server/play.example.com:25570?name=Mi%20Server"`.

## Integración defensiva de 4.5.0

El parser normaliza IPv6 antes de clasificar redes privadas, loopback y direcciones reservadas, conservando el host mostrado. El registro automático `venus://` también en portable fue confirmado por el dueño; no cambia por esta revisión.

## Actualización posterior de integración

La integración principal completó la suite global y recorridos ES/EN con datos temporales. El ajuste NSIS que preserva asociaciones de otra copia está en código, todavía sin compilar/probar el instalador; tampoco se validaron los ajustes compartidos con Minecraft real. La evidencia actual y sus límites están en [estado de integración](../estado-4.5.0.md).
