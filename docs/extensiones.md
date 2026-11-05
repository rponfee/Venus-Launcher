# Escribir una extensión de Venus Launcher

> **Referencia histórica de una función retirada del launcher.** Ya no hay menú, carga automática, tarjetas, catálogo ni administración de extensiones. Se conservan este contrato, los ejemplos y los datos existentes; estas instrucciones no describen una función disponible. [Alcance de la retirada](retirada-funciones.md).

Una extensión es una página web chica que corre adentro del launcher, en un marco aislado. Puede mostrar lo que quiera dentro de su rectángulo y pedirle al launcher unas pocas cosas por un puente de mensajes. No tiene internet, no tiene Node y no ve nada del launcher que el puente no le dé.

Hay un ejemplo completo en [`extensiones-ejemplo/`](extensiones-ejemplo/): una extensión de notas que usa todos los permisos y una tarjeta en Inicio.

## 1. El paquete

Un archivo `.venusext` es un zip con `manifest.json` en la raíz y tus archivos.

```
mi-extension.venusext
├─ manifest.json
├─ index.html
├─ app.js
├─ style.css
├─ venus-bridge.js      (copialo de extensiones-ejemplo/)
├─ card.html            (opcional: tarjeta en Inicio)
└─ img/logo.png
```

Para armarlo, con el repositorio a mano:

```bash
node scripts/pack-extension.js mi-carpeta mi-extension.venusext
```

Eso comprime y valida con el mismo lector del launcher, así que te dice en el momento si algo se va a rechazar. Sin el repositorio, comprimí **el contenido** de la carpeta (no la carpeta) en un zip y cambiale la extensión a `.venusext`.

**Topes**

| Qué | Tope |
|---|---|
| Paquete comprimido | 5 MB |
| Todo descomprimido | 20 MB |
| Un archivo | 8 MB |
| Cantidad de archivos | 200 |
| Ruta de un archivo | 180 caracteres, hasta 8 carpetas |

**Archivos permitidos:** `.html`, `.css`, `.js`, `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, y `manifest.json` en la raíz. Cualquier otra cosa rechaza el paquete entero, también SVG (es un documento que puede correr código), fuentes, JSON, WebAssembly y por supuesto ejecutables.

También se rechaza un paquete si una imagen no es de verdad esa imagen, si un archivo de texto no es UTF-8 válido, si el HTML tiene `<iframe>`, `<frame>`, `<object>` o `<embed>`, si una ruta empieza con punto, o si el zip está cifrado o tiene rutas raras, enlaces simbólicos o entradas solapadas.

## 2. El manifiesto

```json
{
  "manifestVersion": 1,
  "id": "notas-de-partida",
  "name": "Notas de partida",
  "version": "1.0.0",
  "author": "Tu nombre",
  "description": "Qué hace, en una o dos oraciones.",
  "minLauncherVersion": "3.1.0",
  "permissions": ["storage", "notify"],
  "entry": "index.html",
  "homeCard": "card.html"
}
```

| Campo | Regla |
|---|---|
| `manifestVersion` | `1` |
| `id` | De 3 a 40 letras minúsculas, números y guiones. Es tuyo para siempre en el catálogo. |
| `name` | Hasta 40 caracteres, sin controles ni `<` `>`. |
| `author` | Hasta 60 caracteres, con las mismas reglas. |
| `version` | `mayor.menor.parche`, con un sufijo opcional (`1.2.0-beta.1`). |
| `description` | Opcional, hasta 300 caracteres. |
| `minLauncherVersion` | La versión del launcher más vieja en la que funciona. |
| `permissions` | Lista con los permisos que usás. Vacía si no necesitás ninguno. |
| `entry` | Tu página, un `.html` dentro del paquete. |
| `homeCard` | Opcional: la página de la tarjeta en Inicio. |

Cualquier otra clave rechaza el paquete. El nombre, el autor y el id no pueden contener `venus`, `oficial`, `official`, `mojang` ni `microsoft`: una extensión no se presenta como parte del launcher ni de quienes hacen el juego.

## 3. Qué podés y qué no

Tu página corre en un `<iframe sandbox="allow-scripts">` con origen opaco y esta política:

```
default-src 'none'; script-src <tu extensión>; style-src <tu extensión>; img-src <tu extensión>; connect-src 'none'; ...
```

En la práctica:

- **Scripts y estilos en archivos propios.** Nada de `<script>` ni `<style>` en línea, ni atributos `onclick` o `style="..."`. Cambiar estilos desde JS (`el.style.color = ...`) sí funciona.
- **Solo scripts comunes.** `<script type="module">` no funciona. Se cargan desde el HTML: tampoco se pueden agregar scripts desde JS.
- **Nada de `innerHTML`.** Trusted Types está activado: usá `textContent` y `createElement`. Tampoco `eval`, `new Function` ni `setTimeout` con texto.
- **Sin red.** `fetch`, `XMLHttpRequest`, `WebSocket`, imágenes o fuentes de afuera: todo bloqueado. No existe WebRTC.
- **Sin almacenamiento del navegador.** `localStorage`, `sessionStorage`, `indexedDB` y las cookies tiran error. Para guardar, el permiso `storage`.
- **Sin diálogos ni ventanas.** `alert`, `confirm`, `prompt`, `window.open`, formularios y pantalla completa no hacen nada.
- **Una sola página.** No podés navegar a otra: la URL de tu página es de un solo uso y, si el marco vuelve a cargar, el launcher lo detiene. Si querés varias pantallas, mostralas y ocultalas con JS.
- **Sin marcos adentro.** `createElement('iframe')` tira error.
- **Sin sonido ni voz.** No existen `AudioContext` ni `speechSynthesis`. Tampoco `document.execCommand`.

El launcher dibuja arriba de tu página una franja con el nombre y "Extensión de la comunidad". No la podés tapar ni sacar, y no podés dibujar fuera de tu rectángulo.

Si tu fondo es transparente se ve un fondo oscuro fijo. Ponele fondo propio a `body`.

## 4. El puente

Copiá [`venus-bridge.js`](extensiones-ejemplo/venus-bridge.js) a tu extensión y cargalo antes que tu código:

```html
<script src="venus-bridge.js"></script>
<script src="app.js"></script>
```

```js
const hello = await venusBridge.ready; // { extension: { id, name, version }, permissions, surface: 'page' | 'card', locale }
await venusBridge.call('storage.set', { key: 'notas', value: 'Probar la granja' });
```

`call` devuelve una promesa. Si algo falla, rechaza con un `Error` cuyo `.code` dice por qué.

Si preferís escribirlo a mano, el protocolo es: `parent.postMessage({ venus: 1, id, method, params }, '*')`, y la respuesta llega como mensaje con `{ venus: 1, id, ok: true, result }` o `{ venus: 1, id, ok: false, error }`. `id` es un entero o un texto de hasta 40 caracteres. Al cargar, llega un mensaje `{ venus: 1, type: 'hello', ... }`.

### Métodos

| Método | Permiso | Parámetros | Devuelve |
|---|---|---|---|
| `storage.get` | `storage` | `{ key }` | El valor guardado o `null` |
| `storage.set` | `storage` | `{ key, value }` | `true` |
| `storage.remove` | `storage` | `{ key }` | `true` si existía |
| `storage.keys` | `storage` | — | Lista de claves |
| `notify.show` | `notify` | `{ title, text? }` | `true` |
| `instances.list` | `read.instances` | — | `[{ id, name, version, loader }]` |
| `game.state` | `read.gameState` | — | `{ running, instances: [id] }` |
| `launcher.openPage` | `action.openPage` | `{ route }` | `true` |
| `launcher.launchInstance` | `action.launchInstance` | `{ instanceId }` | `{ launched }` |

- **`storage`**: 1 MB por extensión, hasta 500 claves. Una clave tiene letras, números, `.`, `_` y `-`, hasta 64 caracteres. Un valor es JSON, hasta 256 KB y 16 niveles. Se borra al desinstalar.
- **`notify`**: hasta 5 por minuto. Título de hasta 60 caracteres y texto de hasta 200. El launcher lo muestra como texto y le agrega el nombre de la extensión.
- **`instances.list`**: nunca rutas ni archivos.
- **`game.state`**: si hay un juego abierto y de qué instancia. No dice el mundo ni el servidor.
- **`launcher.openPage`**: hasta 5 por minuto y solo mientras la persona está usando tu extensión (el foco está adentro: si no, `not_allowed`). Rutas: `home`, `versions`, `worlds`, `modrinth`, `stats`, `performance`, `skins`, `seeds`, `music`, `clips`, `achievements`, `rewards`, `multiplayer`, `servers`, `updates`.
- **`launcher.launchInstance`**: el launcher siempre pregunta. Si la persona dice que no, rechaza con `declined`; después de 3 negativas ya no pregunta más hasta recargar. Hasta 3 por minuto.

### Errores

| `.code` | Qué pasó |
|---|---|
| `permission_denied` | No pediste ese permiso en el manifiesto. |
| `unknown_method` | Ese método no existe. |
| `bad_request` | Parámetros mal: falta uno, sobra uno o el tipo no es. |
| `too_large` | El valor se pasa de tamaño o no es JSON. |
| `quota_exceeded` | Se llenó tu espacio de datos. |
| `rate_limited` | Superaste el tope por minuto. |
| `not_allowed` | La ruta no está en la lista, o la persona no está usando la extensión. |
| `not_found` | Esa instancia no existe. |
| `declined` | La persona dijo que no. |
| `busy` | Ya hay un pedido igual esperando, o demasiados en curso. |
| `internal` | Falló algo del lado del launcher. |

**Frecuencia:** hasta 40 mensajes cada 10 segundos. De ahí en más se descartan sin respuesta, y si seguís insistiendo (400 cada 10 segundos) o mandás mensajes enormes, el launcher detiene tu extensión.

## 5. La tarjeta en Inicio

Si ponés `homeCard` en el manifiesto, al instalar la persona elige si la quiere. Mide 340 × 180 píxeles, siempre, y va al final de Inicio con la misma franja. Es una página aparte, con el mismo puente: guardá en `storage` desde tu página y leé desde la tarjeta. El launcher muestra hasta 3 tarjetas.

## 6. Probar

1. Armá el paquete con `scripts/pack-extension.js`.
2. En **Extensiones**, **Instalar desde un archivo**. Va a avisar que no está revisada: es lo que corresponde.
3. Prendela en la lista. Aparece en el menú.

Con el repositorio a mano, lo que tu extensión manda a la consola (y lo que la política bloquea) queda en el `console.log` de la carpeta de `VENUS_DEVSHOT` (ver [arquitectura.md](arquitectura.md), sección 9).

## 7. Publicar en el catálogo

1. Iniciá sesión en Venus y activá el catálogo en **Extensiones → Catálogo**.
2. **Elegir paquete** en "Mandá tu extensión". Se valida, se sube y queda **En revisión**.
3. Una persona del equipo mira el contenido y la aprueba o la rechaza con un motivo, que ves en "Mis envíos".

Reglas:

- Hasta 5 envíos por día y 20 extensiones por cuenta. Las cuentas baneadas o silenciadas no pueden enviar.
- El `id` queda a tu nombre con el primer envío.
- Una versión subida no se puede reemplazar ni volver a mandar: subí el número en el manifiesto. Si la subida falló antes de terminar, sí se puede reintentar.
- Una versión nueva con más permisos que la anterior obliga a cada persona a aceptarlos otra vez antes de actualizar. No hay actualizaciones automáticas: el launcher avisa y la persona aprieta.

El equipo puede bloquear una versión o una extensión entera. Una extensión bloqueada se apaga en los launchers que consultan el catálogo y no se puede volver a prender.
