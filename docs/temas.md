# Temas compartibles y editor de skins (Venus 2.0)

> Guía de desarrollo de dos funciones de la 2.0: los **temas del launcher** que se comparten con un código o con la comunidad, y el **editor de skins** de la página Skins. Arquitectura general: [arquitectura.md](arquitectura.md) · Guía para usuarios: [funciones.md](funciones.md).

## 1. Temas del launcher

### Qué es un tema

Un tema es **solo apariencia**: el color de acento, el tinte, el fondo (estrellas o un fondo de la galería de Venus) y cuánto se oscurece y desenfoca el fondo. Nunca lleva rutas de la PC, imágenes propias, música ni la marca propia (logo y nombre). La forma es la de `supabase/migrations/0022_temas.sql`:

| Clave | Valor | En `settings.appearance` |
|---|---|---|
| `accent` | `'venus'`, `'mars'`, `'neptune'`, `'jupiter'`, `'earth'`, `'saturn'` o `'custom'` | `accent` |
| `customColor` | `#rrggbb` | `customColor` |
| `tint` | número de 0 a 100 | `tint` (booleano: `tint > 0`; al exportar, `true` = 100 y `false` = 0) |
| `background` | `'stars'` o `'wallpaper'` | `background` (`'image'` se exporta como `'stars'`) |
| `wallpaper` | id de la galería (`^[A-Za-z0-9._-]{1,80}$`, por ejemplo `live-08`) | `wallpaperId` |
| `bgDim` | 0 a 100 | `bgDim` (el launcher usa 0 a 90: al aplicar se recorta) |
| `bgBlur` | 0 a 100 | `bgBlur` (el launcher usa 0 a 24 px: al aplicar se recorta) |

Todas las claves son opcionales; cualquier otra clave hace que el tema sea inválido (igual que `private.theme_valid()` del servidor). El JSON tiene que medir menos de 2048 bytes.

### Código para compartir

`VENUS-THEME:` + base64 del JSON con solo las claves permitidas, en un orden fijo (el mismo tema da siempre el mismo código). Al leer un código se aceptan espacios y saltos de línea, el prefijo en minúsculas y base64 para URL con o sin relleno; un código de más de 4096 caracteres se rechaza sin decodificar. Errores de lectura (`decodeTheme`): `empty`, `notTheme`, `damaged` (base64 o JSON roto) e `invalid` (claves o valores que el servidor rechazaría).

**Fondo propio:** si el jugador usa una imagen o un video de su PC (`background: 'image'`), el código y lo que se publica usan las **estrellas** y la interfaz lo avisa (aviso fijo en "Tu tema", aviso al copiar y nota en el diálogo de publicar). El archivo nunca sale de la PC. Lo mismo pasa con un fondo de la galería que no existe en esta versión.

### Aplicar sin reiniciar

`applyTheme(theme)` escribe en `settings.appearance` solo las claves del tema (`accent`, `customColor`, `tint`, `background`, `wallpaperId`, `bgDim`, `bgBlur`) con `store.setSettings`. `appearance.js` escucha los ajustes y redibuja color, tinte y fondo al instante. La imagen propia (`bgFile`), la música y la marca no se tocan, así que **Volver al anterior** restaura exactamente lo que había (también un fondo propio). Si el tema trae un fondo de la galería que esta versión no tiene, se usan las estrellas y se avisa.

### Looks (`VENUS-LOOK:`) y el estilo de la interfaz (6.1)

Un tema no es un look. El look (Ajustes → Apariencia → Mis looks, `features/themes/looks.js`) guarda toda la `settings.appearance` normalizada más la marca. El código es `VENUS-LOOK:` + base64 de `{ v: 1, name, appearance, branding }`. Desde la 6.1 `appearance` también trae el estilo de la interfaz: `uiFont` (`outfit`, `pixel`, `system`, `rounded` o `mono`), `uiText` (`normal`, `small` o `large`), `uiCards` (`glass`, `solid` u `outline`), `uiSide` (`left` o `right`), además de `uiRadius`, `uiDensity`, `uiSidebar` y `uiGlass`, que ya estaban. No viajan `lite`, `liteOverlay`, `seasonalBackup`, `startPage` ni `titlebar` (`SKIP_KEYS`): son del equipo o costumbres, no aspecto. Un look o un código de antes de la 6.1 no trae los campos nuevos, así que se aplican los de fábrica. Un valor desconocido también vuelve al de fábrica (`normalizeAppearance` de `a11y/appearance-logic.js`). Pruebas: `features/themes/test/style.test.js`.

### Comunidad (servidor)

RPC de `0022_temas.sql` (solo con sesión de Venus):

| RPC | Uso | Respuesta |
|---|---|---|
| `theme_list(p_sort 'popular' o 'new', p_limit, p_offset)` | Galería, de a 24 con "Ver más temas" | `[{ id, name, data, uses, createdAt, owner: { id, username, displayName }, mine }]` (cada `data` se vuelve a validar en la interfaz; uno inválido no se muestra) |
| `theme_publish(p_name, p_data)` | Publicar el tema propio | uuid. Errores: `bad_name`, `bad_theme`, `too_many_themes` (máximo 10 por cuenta), `user_banned`, `user_muted` |
| `theme_use(p_id)` | Contar un uso al tocar **Usar** (una vez por cuenta; si falla, el tema igual se aplica) | usos actuales |
| `theme_delete(p_id)` | Borrar uno propio (con confirmación) | booleano |

Estados de la galería: sin sesión → "Iniciá sesión para ver la comunidad" con botón a `settings/cloud` (el código funciona sin cuenta); servicio caído, sin nube o sin la migración → "La comunidad no está disponible en este momento" con **Reintentar** y el detalle en la consola (`[themes] ...`); vacía → invitación a publicar. El nombre se valida antes de mandar (2 a 40 caracteres, sin caracteres de control ni `<` `>`) y los errores del servidor se muestran traducidos debajo del campo.

### Archivos

- `src/renderer/js/features/themes.js`: `themesPanel() → Element` (con `.destroy()`; va en Ajustes → Apariencia) y además `currentTheme()` → `{ theme, usedStars }`, `applyTheme(theme)` → `{ previous, missingWallpaper }`, `themePreview(theme, { compact })` y `accentOf(theme)`.
- `src/renderer/js/features/themes/codec.js`: lógica pura (validación igual al servidor, código, mapeo con los ajustes, nombres y errores del servidor). Pruebas: `node --test "src/renderer/js/features/themes/test/*.test.js"`.
- `src/renderer/styles/features/themes.css` (prefijo `.th-`). Las vistas previas reciben los colores del tema por variables en línea (`--th-accent`, `--th-bg`, `--th-surface`, `--th-text`), así muestran el tema y no el que está usando el jugador.
- Textos: namespace `themes` (es y en).

## 2. Editor de skins

Se abre con el botón **Editor de skins** del encabezado de la página Skins (`openSkinEditor` de `pages/skins/editor.js`). Si hay una skin de la biblioteca elegida, empieza desde esa; si no, desde una en blanco.

### Funciones

- Skins de **64×64**, modelo **clásico o slim** (brazos de 3 pixeles). Las skins viejas de 64×32 se convierten al abrirlas (como el juego).
- Herramientas: **lápiz** (B o P), **goma** (E), **balde** (G: rellena los pixeles vecinos del mismo color sin salirse de la cara donde empieza) y **cuentagotas** (I; también Alt+clic sin cambiar de herramienta). Clic derecho borra.
- **Espejo izquierda/derecha** (M): lo que se pinta en un lado se copia en el punto equivalente del otro (brazo derecho ↔ izquierdo, pierna derecha ↔ izquierda, lado derecho ↔ izquierdo de cada caja; cabeza y torso se reflejan sobre sí mismos), en la misma capa.
- **Capas**: base (piel, cara y ropa) y exterior (sombrero, campera, accesorios). Cada una se puede mostrar u ocultar, y se elige cuál se edita: la otra queda atenuada en el lienzo y no se puede pintar por accidente.
- **Plantilla** con las zonas marcadas (contorno con el color de cada parte; la capa exterior con línea punteada) y la zona y el color del pixel bajo el puntero en la barra de estado. **Cuadrícula** opcional.
- **Color**: paleta de 28 colores, selector del sistema, código hex y los 10 últimos usados.
- **Zoom** (+, −, 0 para ajustar; Ctrl+rueda) y **deshacer/rehacer** (Ctrl+Z, Ctrl+Y o Ctrl+Mayús+Z; hasta 100 pasos). Ctrl+S guarda.
- **Vista 3D en vivo** con el mismo visor de la página (`viewer.js`), con la capa base opaca como en el juego (un pixel borrado ahí se ve negro).
- **Empezar desde…**: en blanco (clásico o slim) o cualquier skin de la biblioteca; si hay cambios sin guardar, pide confirmación.
- Teclado: el lienzo es enfocable; flechas para moverse (Mayús salta 8), Espacio o Enter para usar la herramienta, Supr para borrar, y se anuncia la posición, la zona y el color. Escape cierra (pregunta si hay cambios sin guardar).

### Guardar

**Guardar en la biblioteca** arma el PNG de 64×64 en la interfaz (las zonas que el modelo no usa quedan transparentes) y usa los canales que ya existen del módulo skins:

1. `skins:addData([{ name: '<nombre>.png', bytes }])` (los mismos controles que un PNG soltado: firma, tamaño, 64 KB, límite de la biblioteca, duplicados).
2. `skins:setVariant(id, 'classic' | 'slim')` si el modelo que adivinó la biblioteca no es el elegido.
3. `skins:rename(id, nombre)` si el nombre del archivo cambió al limpiarlo (por ejemplo, guiones bajos).

Cada guardado crea una skin nueva (o avisa que ya estaba, si es idéntica). Desde la página Skins, la nueva queda elegida en la biblioteca. Al guardar se avisa el logro de la PC `skin_created` (`venus:achievement`, contrato 3; rewards lo reclama una sola vez por cuenta). La copia queda con `source: 'file'`: no existe un origen propio para el editor (ver Pendientes).

### Archivos

- `src/renderer/js/pages/skins/editor.js`: `openSkinEditor({ libraryId?, start?: { image: 'data:image/png;base64,…', variant, name }, onSaved?(resultado de skins:addData) }) → Promise` (un editor por vez; si ya está abierto le pasa el foco).
- `src/renderer/js/pages/skins/editor/logic.js`: lógica pura sobre un arreglo RGBA de 64×64: zonas del mapa UV (`zones`, `zoneAt`, a partir de la geometría de `pages/skins/model.js`), `mirrorPoint`, `paint`, `floodFill`, `line`, `withLayers`, `opaqueBase`, `cleanUnused`, `blankSkin`, colores y `createHistory`. Pruebas: `node --test "src/renderer/js/pages/skins/editor/test/*.test.js"`.
- `src/renderer/js/pages/skins/editor/canvas.js`: dibujo del lienzo 2D (damero, textura, capa atenuada, plantilla, cuadrícula y cursor) con los tokens del tema.
- `src/renderer/styles/pages/skin-editor.css` (prefijo `.se-`) y textos en el namespace `skineditor`.
- Ajustes: `settings.skineditor = { recent: ['#rrggbb', …] (hasta 10), grid (true), template (true), mirror (false) }`, se guardan al cerrar si cambiaron.

### Pendientes

- Un origen `'editor'` para las skins creadas con el editor necesitaría que `skins:addData` acepte `source` por ítem (hoy guarda `'file'`). No hace falta para que funcione.
