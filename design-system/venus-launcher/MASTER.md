# Venus Launcher · Sistema de diseño (MASTER)

Fuente de verdad visual del launcher. Las páginas siguen estas reglas; si una página necesita algo distinto, se documenta en `pages/<pagina>.md` y esa excepción manda solo para esa página.

**Origen de las decisiones:** la identidad (paleta cálida espacial y fuente pixel) es la existente del producto, verificada en `src/renderer/styles/main.css` y el logo. La búsqueda de estilos de *UI/UX Pro Max* coincide con **Pixel Art** (gaming, retro, pixelado, contraste ≥ 4.5:1, teclado, foco visible y movimiento reducido). La paleta sugerida por la base (violeta neón) **no** encaja con la marca y no se usa. Las reglas de UX vienen de su guía (accesibilidad, interacción, rendimiento, layout, tipografía, movimiento, formularios, navegación y gráficos) adaptadas a una app de escritorio con Electron.

## 1. Identidad

- **Producto:** launcher de Minecraft de escritorio (Windows primero), para jugadores de 12 a 30 años, uso en tiempo libre, sesiones cortas antes de jugar y largas al administrar mods/servidores.
- **Tono visual:** espacio profundo cálido, naranja/oro de Venus, acentos pixel. Inmersivo pero legible: el contenido (instancias, mods, mundos) es el protagonista; el decorado nunca tapa información.
- **Voz:** español rioplatense con voseo, directo y amable ("Elegí", "Jugá"). Frases cortas. Los errores dicen qué pasó y cómo seguir.

## 2. Tokens

Definidos en el **primer** `:root` de `main.css`. **Nunca** usar colores sueltos en componentes: usar tokens (el tema de Apariencia los reemplaza en vivo).

**Cómo los usa el motor de temas** (`js/a11y/engine.js`): lee los colores literales de ese `:root` y les da un rol por el nombre: `*-text` → texto, `*-line` → borde, `*-wash` / `*-bg` / `surface*` → fondo. Con eso aplica el color de acento, los modos de daltonismo y el alto contraste. Por eso los tokens de color nuevos van **con valor literal en ese `:root`** y con un nombre que indique su rol. El amarillo de aviso se reconoce por valor exacto (`#fab219`, `#ffd36b`, `#ffd98a`, `#ffe2a3`, `#c98f12`): no inventar otros amarillos. Los derivados con `color-mix()` de tokens siguen al tema solos, pero el alto contraste no les sube el borde: para bordes de estado usar `--*-line`.

### Color

| Token | Valor | Uso |
|---|---|---|
| `--bg-0` / `--bg-1` | #0c0705 / #120b08 | fondo de la app, consola, tooltips |
| `--surface` → `--surface-4` | #1b130e, #231912, #2c2017, #382a1e | tarjetas, campos, superficies elevadas |
| `--surface-raised` | #261b13 | toasts, tareas, modales (arriba del degradado) |
| `--card-bg` / `--card-bg-flat` | degradado 82% / 70% | fondo de `.card` / `.card.flat` |
| `--field-bg` | negro cálido 60% | campos de texto, `code` |
| `--well-bg` | negro cálido 50% | rieles de `.tabs`/`.segmented`, filas hundidas |
| `--hover-bg` | naranja 6% | hover de ítems, ghost, tabs, chips |
| `--scrim` | negro 66% | fondo detrás de los modales |
| `--border` / `-2` / `-3` | naranja 9% / 18% / 32% | bordes en reposo / hover / foco y énfasis |
| `--text` | #fff3e3 | texto principal (≥ 12:1 en superficies y `-wash`) |
| `--text-2` | #d4bfa8 | texto secundario (≥ 7.4:1) |
| `--muted` | **#ad9781** | metadatos, ayudas (≥ 4.9:1 en todas las superficies, ≥ 4.7:1 en los `-wash`) |
| `--faint` | **#9b8773** | rótulos menores, marcas de ejes, placeholders (≥ 4.6:1 hasta `--surface-3`). Nunca sobre `--surface-4` ni sobre fondos `-wash` |
| `--accent` / `-hi` / `-lo` / `-deep` | #f29a2e / #ffc562 / #d9761c / #9b4512 | marca, CTA, selección |
| `--accent-wash` / `--accent-line` / `--accent-glow` | 12% / 38% / 35% | fondo, borde y brillo de lo seleccionado |
| `--accent-ink` | #2b1405 | texto sobre botón primario (≥ 5.4:1 en todo el degradado) |
| `--cream` | #ffe6b0 | títulos pixel, texto activo |
| `--good` / `--warn` / `--bad` / `--info` | #36c25a / #fab219 / #e5544b / #5aa7f0 | estados: íconos, fondos sólidos, puntos |
| `--*-wash` | 12-13% | fondo suave de estado (`--info-wash` incluido) |
| `--*-line` | 38-45% | borde de estado (badges, pills, avisos, toasts) |
| `--good-text` / `--warn-text` / `--info-text` | #8ee6a5 / #ffd36b / #a9d0f7 | texto de estado sobre su `-wash` o superficies (≥ 7:1) |
| `--bad-text` | **#f07a70** | texto de error (≥ 5:1 en todas las superficies, 5.4:1 sobre `--bad-wash`); `--bad` queda para fondos e íconos |
| `--modrinth` / `--modrinth-wash` | #1bd96a | marca de Modrinth (no cambia con el tema) |

Colores literales permitidos: marcas (Modrinth, CurseForge, Microsoft, Discord), colores de cada loader (`LOADERS` de `ui.js`), códigos de formato de Minecraft, botones del control (Xbox/PlayStation), el rojo de cerrar de Windows en la barra de título, sombras negras y brillos blancos.

Pares obligatorios: texto normal ≥ 4.5:1, texto ≥ 18.5px o negrita ≥ 14px ≥ 3:1, íconos con significado y bordes de controles ≥ 3:1. El estado nunca se comunica solo con color: siempre ícono o texto. Texto blanco sobre `--bad` no llega a 4.5:1: para rellenos rojos con texto usar `color-mix(in srgb, var(--bad) 78%, var(--bg-0))` (lo hace `.btn.danger:hover`).

### Tipografía

- **Pixelify Sans** (`--pixel`): solo títulos de página, títulos de sección, cifras grandes (KPI, RAM) y el botón JUGAR. Nunca en párrafos ni en etiquetas pequeñas (excepción: rótulos de grupo del menú y de la paleta, 12px/600 en mayúsculas).
- **Outfit** (`--font`): todo lo demás. Mono (`--mono`): consolas, código, IPs, hashes, `.kbd`.
- Escala: `--fs-xs` **12** (meta, badges, ayudas) · `--fs-sm` **13** (etiquetas, tablas densas, `.small`) · `--fs-md` **14** (cuerpo, botones, base) · 15 (títulos de tarjeta) · `--fs-lg` **16** (títulos de estado vacío) · `--fs-xl` **18** (sección, título de modal) · `--fs-2xl` **20** · `--fs-title` **30** (título de página) · 40+ (héroe). **Mínimo absoluto: 12px** (`.tiny` = 12, `.small` = 13).
- Pesos: 400 cuerpo · 500 etiquetas e ítems del menú · 600 títulos de tarjeta, botones e ítem activo · 700 títulos. Interlineado 1.45-1.6 en cuerpo; 1.1-1.3 en títulos.
- Números que cambian (RAM, ping, contadores, timers, porcentajes): `font-variant-numeric: tabular-nums` o la clase `.num`. Ya lo traen `.badge`, `.pill`, `.tab .count`, `.nav-badge`, `.kpi-value`, `.table td`, `.chart .tick`, `.legend`, `.ram-marks`, `.gauge-row .g-val` y el porcentaje de las tareas.
- Párrafos largos: máximo ~75 caracteres por línea (`max-width: 68ch`). Títulos con `text-wrap: balance`.
- Texto largo en una línea: `.ellipsis` + `title` con el texto completo. Rutas, URLs e IDs: `.wrap-anywhere`.

### Espaciado, radios, elevación, capas

- Espaciado en múltiplos de 4: `--sp-1`…`--sp-8` = **4 · 8 · 12 · 16 · 20 · 24 · 32 · 48**. Separación entre tarjetas 16; padding de tarjeta 20; entre secciones 28-32; página 28 arriba, 32 a los lados, 40 abajo.
- Alturas de controles: `--control-h` **38** (botón, campo, select) · `--control-h-sm` **30** (botón chico, chip, botón de ícono chico) · `--control-h-lg` **46**. Botón de ícono normal 36.
- Radios: `--radius-xs` 6 (badges, `.kbd`) · `--radius-s` 8 (chips internos, botones chicos, tabs) · 10 (botones, campos, ítems del menú) · `--radius` 12 (ítems de lista, avisos, toasts) · `--radius-l` 18 (tarjetas, modales) · `--radius-xl` 24 (héroe) · `--radius-full` (chips, pills, interruptores).
- Elevación: plano (borde) → `--shadow-s` (menús, toasts, tareas, tooltips) → `--shadow` (modales). Nada de sombras inventadas por página.
- Capas (`--z-*`): fondo 0 · `--z-base` 1 (contenido) · `--z-sticky` 10 · `--z-dock` 90 (tareas) · `--z-panel` 95 (paneles laterales) · `--z-modal` 100 · `--z-toast` 200 · `--z-tooltip` 300 · `--z-palette` 400 (paleta de comandos; la barra de ayudas del control va en `calc(var(--z-palette) + 50)`) · `--z-system` 600 (salto al contenido). Nunca números sueltos.

### Movimiento

- Duraciones: `--dur-fast` 120ms (hover, presión), `--dur` 180ms (estados, chips, toasts, salidas), `--dur-slow` 260ms (modales, paneles, cambio de página). La salida dura ~70% de la entrada.
- Curvas: `--ease-out` cubic-bezier(.2,.8,.2,1) al entrar, `--ease-in` cubic-bezier(.4,0,1,1) al salir. Rotaciones y barras indeterminadas: `linear`/`ease-in-out`.
- Solo `transform` y `opacity` en animaciones (los cambios de color/borde en hover pueden transicionar; nunca `width`, `height`, `top` o `left` salvo el relleno de `.progress`). Máximo 1-2 elementos animados por vista. Listas: stagger de 30-40ms y solo en la primera carga.
- **Movimiento reducido** (`prefers-reduced-motion` o `body.reduce-motion`): `main.css` apaga animaciones y transiciones de todo el launcher (el estado final se aplica al instante). Siguen girando los `.spinner` y el spinner de `.btn.loading` (más lento) y la barra indeterminada va lenta; el brillo de `.skeleton` se apaga. Para excepciones puntuales: clase `.ax-keep-motion`. En JS, `reducedMotion()` de `ui.js`.

## 3. Componentes

Todos en `main.css` (clases globales, sin prefijo). Las páginas los usan tal cual y ajustan solo lo propio con su prefijo.

- **Encabezado de página** `.page-head` > `.ph-text` (`h1.page-title` pixel 30px `--cream` + `p.page-sub` `--muted` 14px, una o dos líneas) + `.page-actions` a la derecha (máximo 1 primaria). Detalles: `.back-link` arriba del título.
- **Títulos de sección:** `sectionTitle(texto, extra)` → `.section-title` pixel 18px con línea; el texto es encabezado de nivel 2 para el lector de pantalla.
- **Botones** `.btn`: 38px, padding 16, 14px/600. Variantes: `primary` (degradado de acento, **uno por vista**), `tonal` (fondo `--accent-wash`, borde `--accent-line`, texto `--accent-hi`; para acciones secundarias que se repiten o que tienen que destacarse sin competir con el primario: "Mejorar plan" en cada tarjeta de plan, Jugar un mundo, Unirme a un servidor), por defecto (superficie), `ghost` (secundario sin borde), `danger` (texto `--bad-text`, hover rojo oscuro; separado del primario), `good` (iniciar), `modrinth` (marca) y `modrinth soft` (el verde de marca en versión secundaria, sin sombra de tecla: "Volver a Modrinth" y acciones de Modrinth que no son la principal de la vista). Tamaños: `sm` 30px/13px, `lg` 46px/15px, `block` ancho completo. Hover = más luz de borde/fondo; presión = `scale(.98)` (el primario baja 2px como tecla); deshabilitado = opacidad .45 + `cursor: not-allowed` + atributo `disabled`. **Acción asíncrona:** `const done = setBusy(btn)` → `.loading` (spinner en lugar del primer ícono), `disabled` y `aria-busy`; `done()` lo libera y le devuelve el foco.
- **JUGAR** `.play-btn` (pixel 26px, 64px) y `.play-btn.stop`: solo en Inicio y ficha de instancia.
- **Botones de ícono** `.icon-btn`: 36px (`sm` 30px), siempre `title` y `aria-label`. `.active` (seleccionado), `.danger` (hover rojo) y `.loading` (con `setBusy`: el ícono gira mientras dura la acción, por ejemplo Actualizar; más lento con movimiento reducido).
- **Campos:** `.field` > `label` (13px/600, visible arriba, nunca solo placeholder) + `.input` / `.select` / `.textarea` (38px, fondo `--field-bg`, foco = borde de acento + `--focus-glow`) + `.field-help` (ayuda persistente 12px `--muted`; `.hint` es el nombre viejo) + `.field-error` (12px `--bad-text` con ícono `alert` de 14px, `id` enlazado con `aria-describedby`). Inválido: `.invalid` o `aria-invalid="true"` (borde `--bad`). `readonly` = borde punteado sin fondo; `disabled` = opacidad .55. Validar al salir del campo, no en cada tecla. Buscador: `.input-icon` con ícono `search`. Grilla de formulario: `.form-grid` (`.full` ocupa las dos columnas). Interruptor: `switchEl()` dentro de `.toggle-row` (`.tr-title` + `.tr-sub`).
- **Tarjetas** `.card` (radio 18, padding 20, `position: relative`): `.card-head` (título a la izquierda, acción a la derecha) con `.card-title` (15px/600 con ícono de 18px en `--accent-hi`) y `.card-sub` (`--muted` 13px). Una idea por tarjeta. `.card.flat` para tarjetas dentro de tarjetas.
- **Tabs** `.tabs` > `.tab` (riel `--well-bg`, activa = fondo `--surface-3` + borde + texto `--cream` + ícono de acento). **Contador** `.count` dentro de `.tab`, `.chip` o un botón de `.segmented`: pastilla redonda de 20px (12px/700, números tabulares, `--muted` sobre un velo de `--text`); en el elemento activo pasa a `--accent-hi` sobre `--accent-wash`; vacía no se ve (se puede dejar el `<span>` y llenarlo cuando llega el número). **Segmented** `.segmented > button` (activo = `--accent-wash` + `--accent-line`). Máximo 6 visibles.
- **Chips** `.chips > .chip` (30px, redondos; `.active` de acento) para filtros. **Badges** `.badge` (22px, 12px/600) con `accent`, `good`, `warn`, `bad`, `info`, `modrinth`; `loaderBadge()` para loaders. **Pills** `.pill` (estados redondos) con `good`, `warn`, `bad`, `info`. Atajos: `.kbd`.
- **Avisos** `.notice` (aviso amarillo por defecto) con `info` (azul), `good`, `bad`: ícono de 18px como primer hijo + texto. Para errores de una vista con acción: `.notice.bad` + botón Reintentar.
- **Listas** `.list` > `.list-item` (`.li-icon` 40px, `.li-main` > `.li-title` + `.li-sub`, acciones a la derecha; `.disabled` atenúa). Más de 100 ítems: paginar o virtualizar.
- **Modales** `modal({ title, subtitle, icon, body, footer, size, onClose, closable })`: con `icon` la cabecera lleva el ícono en un recuadro de acento a la izquierda del título, y `subtitle` agrega una línea de contexto `--muted` 13px debajo (una sola línea, con `…` y el texto completo en `title`); usalos en diálogos de una función (planes, compartir, Mejorar plan), no en confirmaciones. Título claro, botón cerrar, Escape cierra solo el de arriba, foco inicial en el primer campo útil y vuelve al disparador al cerrar. Tamaños: `sm` 440 (confirmaciones; lo usan `confirmDialog` y `promptDialog`), normal 560, `wide` 860, `xwide` 1040 (siempre dentro de un margen de 32px). Cabecera 20px, cuerpo con scroll, pie con acciones a la derecha (primaria a la derecha) sobre fondo más oscuro. Entrada `--dur-slow` (sube 8px y escala de .97); salida `--dur` con `--ease-in`: el diálogo queda inerte con `.closing` y se saca solo.
- **Toasts** `toast(tipo, título, mensaje, ms)` / `ok()` / `fail()`: arriba a la derecha, 4.5 s (errores 7 s), `role="status"` o `alert`, nunca roban foco; pasar el mouse por encima pausa el cierre.
- **Tareas** (`.tasks-dock`, abajo a la derecha): título, porcentaje tabular, barra y detalle; los errores se leen completos en `--bad-text`.
- **Tooltips de gráficos:** `showTip()`/`hideTip()` (`.tooltip`, 13px, `--z-tooltip`).
- **Estados obligatorios en toda vista de datos:**
  - Cargando: `skeleton()` si tarda > 300 ms (`skeleton(3)` líneas, `'list'`, `'card'`, `'grid'`, `'block'`, `'title'`, `'circle'`; se anuncia como "Cargando..."); `loading()` (spinner + texto) solo para esperas cortas o acciones.
  - Vacío: `emptyState(ícono, título, texto, acción)` → ícono en un recuadro de acento + qué es (16px/700) + explicación (`--muted`, máx. 52ch) + acción principal.
  - Error: qué pasó + cómo seguir + Reintentar (`.notice.bad` o `emptyState('alert', ...)` con botón).
  - Sin conexión/sin cuenta/sin plan: explicación + botón a Ajustes (`settings/cloud`, `settings/plan`, `settings/ai`...).
  - Servicio caído o incompleto: "no está disponible en este momento" + Reintentar, sin términos técnicos (nada de Supabase, migraciones, claves o IDs); el detalle va a la consola con `console.warn('[modulo] ...')`.
- **Íconos:** set Lucide de `ui.js` (trazo 2px; nuevos con `registerIcons`). Tamaños: 14 (inline en texto chico, badges con 12), 16 (botones, campos), 18 (menú, títulos de tarjeta, avisos, toasts), 20-24 (acciones grandes), 26 dentro del recuadro del estado vacío. Nada de emojis como íconos. Decorativos con `aria-hidden` (lo pone `icon()`).
- **Gráficos:** SVG con leyenda visible cerca, tooltip al hover y foco, números con formato del idioma, estado vacío explicado (`.chart-empty`), colores que no dependen solo de rojo/verde. Líneas de grilla con `--border`, ejes con `--border-2`.
- **Utilidades:** `.stack` (columna, 12), `.row` (fila, 8; `.wrap`, `.between`), `.grid` (`cols-2/3/4`, `auto`), `.spacer`, `.divider`, `.muted`, `.text-2`, `.small`, `.tiny`, `.mono`, `.num`, `.ellipsis`, `.wrap-anywhere`, `.selectable`, `.sr-only`, `.hidden` / atributo `hidden` (siempre gana).

## 4. Layout de página

- Encabezado `.page-head`: título pixel 30px + subtítulo `--muted` + acciones a la derecha (máximo 1 primaria).
- Ancho de contenido: completo hasta ~1464px de área; más ancho, el contenido se centra en 1400px (lo hace el padding de `.page`).
- Debe verse bien en **1040×680** (mínimo de la ventana), **1300×820** (por defecto) y **1920×1080**. Sin scroll horizontal. Grillas con `minmax()` y `auto-fill`.
- Jerarquía por tamaño, peso y espacio, no solo por color: título de página > título de sección > título de tarjeta > meta.
- Navegación: barra lateral fija con grupos (rótulo pixel 12px `--muted`); el ítem activo se marca con fondo + borde + color + barra de acento a la izquierda; las etiquetas largas se cortan con `…` (el `title` tiene el texto completo). Las páginas de detalle tienen "Volver" y enlace profundo (`#/ruta/param`).
- Elementos con `position: absolute` dentro de la página: siempre con un ancestro posicionado dentro de la zona con scroll (las tarjetas ya lo son); si no, agrandan `.app` y la ventana entera se desplaza.

## 5. Accesibilidad e interacción (escritorio)

- Foco visible siempre (`:focus-visible` = `--focus-ring` 2px `--accent-hi`, offset `--focus-offset` 2px; en campos, borde de acento + `--focus-glow`), orden de tabulación = orden visual, todo operable con teclado (Enter/Espacio activan, Escape cierra, flechas en grillas y listas).
- `cursor: pointer` en todo lo clicable (ya lo tienen `button`, `[role=button]`, `summary`, `label[for]`); feedback visual en < 100 ms.
- Arrastrar y soltar siempre con alternativa por botón.
- Objetivos clicables ≥ 24×24 px (WCAG 2.2) y 8px entre ellos; en modo sofá/joystick ≥ 44px.
- Confirmar acciones destructivas (`confirmDialog(..., { danger: true })`) y ofrecer deshacer cuando se pueda.
- Al cambiar de página, el foco va al contenido y se anuncia el título.
- Modos de `a11y.css`: alto contraste (`html.ax-hc`: bordes y textos más fuertes, sin desenfoques), símbolos de estado (`html.ax-shapes`: ✓ ! ✕ i en badges y pills, borde grueso en errores), foco siempre visible (`html.ax-focus`), escala (`html.ax-zoomed`) y control (`body.gamepad-mode`). Los componentes nuevos se prueban en esos modos.

## 6. Checklist antes de entregar una pantalla

- [ ] Sin textos < 12px ni texto con contraste < 4.5:1 (`--faint` solo sobre fondos oscuros; errores en `--bad-text`).
- [ ] Sin colores sueltos: todo con tokens (salvo las marcas de la sección 2). Capas con `--z-*`, duraciones con `--dur-*`, espacios de a 4.
- [ ] Un solo botón primario visible; destructivos separados; acciones asíncronas con `setBusy`.
- [ ] Estados de carga (skeleton), vacío, error y sin cuenta/conexión diseñados.
- [ ] Foco visible y navegación con teclado probada; íconos con `aria-label`.
- [ ] Movimiento reducido respetado (y alto contraste y daltonismo revisados).
- [ ] Probada a 1040×680 y 1300×820 sin scroll horizontal ni textos cortados sin `title`.
- [ ] Textos traducidos (es + en) sin frases armadas por partes.
