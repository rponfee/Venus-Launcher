# Extensiones de la comunidad (3.4)

Guía para quien escribe extensiones: [../extensiones.md](../extensiones.md), con un ejemplo en [../extensiones-ejemplo/](../extensiones-ejemplo/). Este documento explica cómo se usa y cómo funciona por dentro.

## Cómo se usa

**Extensiones** está en el menú, en Herramientas. Tiene dos pestañas.

**Instaladas.** Cada extensión muestra nombre, versión, autor, permisos en lenguaje claro, un interruptor para prenderla y apagarla, **Permisos y detalles**, y desinstalar (borra también sus datos). Las extensiones quedan apagadas al instalarlas. Una prendida suma una entrada al menú, siempre con la pieza de rompecabezas y una marca al costado. Si pidió una tarjeta en Inicio y se aceptó, va al final de Inicio.

**Instalar desde un archivo** abre un `.venusext`. Muestra un aviso fuerte, porque nadie lo revisó, y pide marcar una casilla antes de habilitar el botón.

**Modo seguro**, arriba de la lista: el launcher arranca sin extensiones (no se registran páginas, no se dibujan tarjetas y el protocolo no sirve nada). También se abre así con `--venus-safe-mode`.

**Catálogo.** Es una conexión opcional: hasta activarla no sale ningún pedido. Se activa ahí mismo o en Ajustes → Privacidad (`settings.extensions.catalog`). Con eso el launcher, unos segundos después de abrir, consulta la lista de bloqueadas y, con sesión, las actualizaciones de lo instalado desde el catálogo. El catálogo en sí y los envíos piden una cuenta de Venus.

Las actualizaciones nunca son automáticas: aparece un número en el menú y un botón **Actualizar a x.y.z**. Si la versión nueva pide más permisos, el resumen los marca como **Nuevo** y el proceso principal se niega a instalar sin aceptarlos.

**Panel de administración → Extensiones.** Lista por estado. **Ver contenido** baja el paquete, verifica el sha-256, lo valida con el mismo lector y muestra el manifiesto y los archivos como texto: nada se ejecuta. **Aprobar** solo aparece adentro de esa vista. **Rechazar** y **Bloquear** piden motivo. Todo queda en `admin_actions`.

## Modelo de seguridad

El código de una extensión es hostil por definición. No debe poder leer tokens, cuentas, archivos, ajustes u otras extensiones, ni ejecutar nada en la PC, ni hacerse pasar por el launcher.

| Capa | Dónde | Qué hace |
|---|---|---|
| Paquete | `modules/extensions/package.js`, `manifest.js` | Lector propio del zip con topes antes de inflar; allowlist de tipos; zip-slip, enlaces simbólicos, entradas solapadas y bombas; contenido que coincide con su tipo; manifiesto de esquema cerrado |
| Aislamiento | `<iframe sandbox="allow-scripts" allow="">` en `features/extensions/frame.js` | Origen opaco: sin acceso a `parent`/`top`, cookies ni `localStorage`; sin `allow-same-origin`, `allow-top-navigation`, `allow-popups`, `allow-forms` ni `allow-modals` |
| Procesos | Chromium | El marco corre en otro proceso: un bucle infinito no frena al launcher (medido, abajo) |
| Política | `modules/extensions/server.js` | CSP por respuesta del protocolo: `default-src 'none'`, solo archivos propios, `connect-src 'none'`, Trusted Types, y `sandbox allow-scripts` repetido en el encabezado |
| Un solo uso | `extensions:openSession` + `server.js` | Una página HTML exige una ficha de un solo uso que dura 30 s |
| Navegación | CSP de la ventana (`frame-src venus-ext:`), `will-frame-navigate` y `frame.js` | Un marco no sale de `venus-ext://`, sin ficha no carga otra página, y una segunda carga detiene la extensión |
| WebRTC y otros | `modules/extensions/boot.js` | Este Chromium (Electron 44) no entiende `webrtc 'block'` en la CSP. Un script del launcher corre primero en cada página, saca WebRTC y no deja crear marcos anidados, que traerían un ámbito limpio. También saca sonido, voz y `execCommand` |
| Puente | `features/extensions/bridge-core.js`, `frame.js` | Solo `event.source` igual al iframe; esquema cerrado; permiso en cada pedido; tamaños y frecuencia; copias planas; errores internos que no se cuentan |
| Marco visual | `frame.js`, `styles/pages/extensions.css` | Borde punteado y franja con el nombre y "Extensión de la comunidad", por fuera del iframe. Fondo opaco propio |
| Foco | `frame.js` | Si el iframe se lleva el foco sin clic ni Tab, se le saca. Se revisa cada 250 ms y al perder el foco la ventana, porque el launcher no recibe eventos del iframe |
| Permisos del navegador | `modules/extensions.js` (`denyPermissions`) | `main.js` concede notificaciones, micrófono y demás a toda la ventana. Sus manejadores se envuelven (evento `session-created`) para decir que no a lo que pide un marco `venus-ext:`, sin cambiar lo que deciden para el launcher |
| Textos | En toda la interfaz | Lo que viene de una extensión se dibuja como texto. Sin controles, invisibles ni marcas de dirección. El nombre no puede contener `venus`, `oficial`, `official`, `mojang` ni `microsoft` |

### Por qué un protocolo propio y no `srcdoc` ni `blob:`

Un `srcdoc` o un `blob:` heredan la CSP de la ventana, que no permite scripts en línea ni `blob:`, y habría que abrirla para todo el launcher. Con `venus-ext://` cada respuesta lleva su propia CSP, y el único cambio en `index.html` es `frame-src 'none'` → `frame-src venus-ext:`. El esquema es `standard` pero no `secure`: el marco no es un contexto seguro, así que tiene menos API del navegador a mano (ni `navigator.clipboard`, ni `mediaDevices`, ni Service Workers).

### Lo que queda sin cerrar

- **`boot.js` no es un límite duro.** Corre en el mismo ámbito que la extensión. Se probaron los caminos conocidos para armar un marco anidado, pero si apareciera otro, la extensión tendría WebRTC, sonido y `execCommand`. Ganaría solo eso: sacar por WebRTC lo que ya tiene, que son sus datos y lo que el puente le da.
- **DNS:** `X-DNS-Prefetch-Control: off` pide no hacer resoluciones anticipadas. Los detectores locales prueban conexiones, no consultas de DNS: eso no quedó medido.
- **Mensajes enormes:** el contenido de un mensaje recién se conoce al leerlo. Un mensaje de cientos de MB puede frenar la interfaz una vez, unos segundos, y ahí la extensión se detiene.
- **Engaño adentro del marco:** dentro de su rectángulo una extensión dibuja lo que quiera, incluso algo parecido a un diálogo del launcher. La franja de afuera es la defensa.
- **Copiar con Ctrl+C adentro del marco:** si la persona copia estando en la extensión, la página puede cambiar lo que se copia con el evento `copy`. Solo pasa cuando ella copia ahí.
- **La lista de bloqueadas depende del interruptor del catálogo.** Con el catálogo apagado no se consulta: se cumple la última que se guardó.

## Por dentro

```
src/main/modules/extensions.js          IPC, protocolo, guardia de marcos, permisos, paquetes en espera
src/main/modules/extensions/manifest.js validateManifest, PERMISSIONS, addedPermissions
src/main/modules/extensions/package.js  readPackage, writePackage, topes
src/main/modules/extensions/server.js   parseUrl, respond, cspFor (sin Electron)
src/main/modules/extensions/boot.js     script que corre primero, injectBoot
src/main/modules/extensions/registry.js instaladas, almacenamiento, lista de bloqueadas
src/renderer/js/features/extensions.js  startup, páginas, tarjetas en Inicio, catálogo
src/renderer/js/features/extensions/    bridge-core (lógica), frame (marco), install-dialog, perms
src/renderer/js/pages/extensions.js     pestañas; pages/extensions/installed.js y catalog.js
src/renderer/js/pages/admin/extensions.js  revisión
supabase/migrations/0036_extensiones.sql
scripts/pack-extension.js               armar y validar un paquete
```

**Datos.** `<datos>/extensions/registry.json` (`{ v, items, blocklist, safeMode }`), `<datos>/extensions/<id>/package/` y `<datos>/extensions/<id>/storage.json`. Ajuste nuevo: `settings.extensions.catalog` (booleano, apagado por defecto).

**Canales.** `extensions:list`, `inspectFile(ruta?)`, `inspectBytes(bytes, { sha256, id, version })`, `install(stageId, { accepted, homeCard })`, `setEnabled`, `setHomeCard`, `uninstall`, `setSafeMode`, `applyBlocklist({ ids, hashes })`, `openSession(id, 'page'|'card')`, `storage(id, op, clave, valor)`, `readForSubmit(ruta?)`, `review(bytes, { sha256 })`. Evento `extensions:changed`. Errores con `err.code` y texto de `src/main/i18n/<idioma>/extensions.js`.

**Ciclo de un marco.** `extensionFrame(ext, superficie)` pide una URL con `extensions:openSession`, crea el iframe con el sandbox antes de conectarlo y lo anota en un mapa `WindowProxy → sesión`. Un solo escuchador de `message` busca `event.source` en ese mapa y, si no está, no lee nada. Por cada mensaje: `admit()` cuenta sin leer el contenido (40 cada 10 s; de 400 en adelante se detiene), recién ahí se lee `event.data` midiendo cuánto tarda (dos lecturas de más de 150 ms detienen la extensión: es lo que delata un mensaje enorme), y `handle()` valida y responde.

**Inicio.** `pages/home.js` no tiene un gancho para tarjetas, así que `features/extensions.js` observa `#main` y agrega su sección antes de `.hm-foot` cuando aparece la página de Inicio. Si Inicio cambia esa clase, las tarjetas dejan de aparecer sin romper nada.

**Catálogo (0036).** `community_extensions` y `community_extension_versions`, sin acceso directo. RPC: `extension_catalog(p_search, p_ids, p_limit, p_offset)`, `extension_blocklist()` (también sin sesión), `extension_submit(p_id, p_version, p_manifest, p_sha256, p_size)`, `extension_my_submissions()`, `admin_extensions(p_status)`, `admin_extension_review(p_version, p_action, p_note)` y `admin_extension_block(p_id, p_blocked, p_reason)`. Bucket privado `extension-packages`, solo con políticas de `select` e `insert`: lo subido no se reemplaza ni se borra. Lo público sale del manifiesto de la última versión aprobada, nunca de lo que está en revisión.

El sha-256 no lo verifica el servidor (la base no ve el contenido). Lo verifican el launcher al instalar y el panel al revisar. Lo que sí verifica el servidor al aprobar es que el archivo exista y mida lo declarado.

## Pendientes para integrar

- Aplicar `0036_extensiones.sql` (se probó entera en una transacción con vuelta atrás; no está aplicada).
- `docs/arquitectura.md`: sumar canales, `settings.extensions` y los datos de `<datos>/extensions/` a las secciones 6.3, 7.2 y 7.3, y `frame-src venus-ext:` a la regla de la CSP de la sección 8. La línea que dice "esquema `venus-ext`" ya es correcta. `docs/supabase.md`: sumar 0036.
- `main.js`: los manejadores de permisos podrían mirar el pedido por su cuenta (`details.requestingUrl` que empiece con `venus-ext:`). Mientras tanto lo hace `denyPermissions`. Si alguien cambia esos manejadores, la prueba hostil lo detecta: `Notification` tiene que dar `denied`.
- Los 12 idiomas restantes del namespace `extensions` (interfaz y proceso principal).

## Cómo probar

```bash
node --test "src/main/modules/extensions/test/*.test.js" "src/renderer/js/features/extensions/test/*.test.js"
node src/main/modules/extensions/test/hostile/run.js <carpeta temporal>   # extensiones hostiles en la ventana real
node src/main/modules/extensions/test/hostile/ui.js <carpeta temporal>    # flujos de la interfaz con un cliente de Supabase falso
```

`run.js` levanta detectores locales de HTTP, TCP y UDP y deja `resultados.json` y las capturas en la carpeta. Usa `VENUS_DATA_DIR` y `VENUS_DEVSHOT`: nunca toca los datos reales.

## Resultados de la última prueba

**Extensiones hostiles en la ventana real** (`run.js`): 117 filas bloqueadas, ninguna lograda, y 0 pedidos en los detectores locales de HTTP, TCP y UDP. Lo que fue encontrando la prueba y se corrigió:

| Hallazgo | Corrección |
|---|---|
| `Notification.requestPermission()` daba `granted`: `main.js` concede ese permiso a toda la ventana, y una extensión podía mandar avisos del sistema a nombre del launcher | `denyPermissions` en `modules/extensions.js`. Ahora da `denied` |
| Este Chromium no entiende `webrtc 'block'` y sin eso WebRTC queda fuera de `connect-src` | `boot.js`, Trusted Types y rechazar etiquetas de marcos en el HTML |
| `document.activeElement` quedaba en el iframe después de un `focus()` desde adentro, sin ningún evento en el launcher | Revisión cada 250 ms y al perder el foco la ventana |
| `AudioContext` en estado `running`, sin pedir nada | `boot.js` saca sonido, voz y `execCommand` |
| Mensajes de 200 MB: hasta 3 s de interfaz frenada, con dos lecturas lentas antes de cortar | Una lectura de más de 1 s corta enseguida |

Medido en esa corrida: bucle infinito, 7 ms de demora máxima en el launcher; 6000 mensajes seguidos, 7 ms y la extensión detenida; tarjeta en Inicio de 340 × 180 aunque la página pida 5000 px.

**Migración** (en una transacción con vuelta atrás, aplicada dos veces para comprobar que es idempotente): 108 comprobaciones bien, de las cuales 2 son de relleno (no prueban nada). Después se verificó que en producción no quedó ni la tabla, ni el bucket, ni las políticas, ni los usuarios de prueba.

**Interfaz** (`ui.js`, con un cliente de Supabase falso): catálogo apagado sin pedidos, instalar, sha-256 e id que no coinciden, permisos nuevos al actualizar, lista de bloqueadas, envío, tope diario y revisión del admin.

**Sin probar:** la app empaquetada; el catálogo y Storage contra un servidor real (la migración no está aplicada); clics y teclas reales (las capturas ignoran el mouse y la ventana no tiene el foco del sistema, así que el robo de foco se probó por `document.activeElement`); consultas de DNS; `venus://` y `mailto:` de verdad, para no abrir nada en la PC (se usó un esquema inventado); macOS y Linux.
