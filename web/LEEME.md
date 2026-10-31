# Página web de Venus Launcher

Esta carpeta es la página lista para subir a cualquier hosting estático: `index.html`, `assets/` (logo y capturas del launcher) y los dos ejecutables del launcher.

## Qué muestra

- **Hasta el domingo 8 de noviembre de 2026 a las 00:00 (hora de Argentina):** solo la cuenta regresiva, con el logo y el link al Discord.
- **Desde esa hora:** el sitio completo (funciones, Venus IA, planes, descarga, privacidad y preguntas). Aparece solo, sin subir nada: la página compara la hora del servidor con la fecha. Si alguien la tiene abierta en ese momento, cambia cuando la cuenta llega a cero.
- **Para ver el sitio completo antes de la fecha:** abrí la página con `#previa` al final, por ejemplo `https://tu-sitio/#previa` o, en tu PC, `index.html#previa`.
- El contenido viaja dentro de `index.html`: quien abra el código fuente lo puede leer antes de la fecha. La cuenta regresiva es para los visitantes, no un secreto.

## El instalador va adentro de la carpeta

- `VenusLauncher-Setup-1.0.13.exe` y `VenusLauncher-Portable-1.0.13.exe` están acá mismo: los botones de descarga los bajan directo desde tu sitio, sin pasar por GitHub.
- Si GitHub tiene una release **más nueva** que la de la carpeta, la página usa la de GitHub sola (compara los números de versión).
- Si los `.exe` no están en el hosting, la página se da cuenta y usa la última release de GitHub. Si tampoco puede consultar GitHub, los botones llevan a la página de releases.
- **Tamaño:** cada `.exe` pesa unos 115 MB. Cloudflare Pages no acepta archivos de más de 25 MB y GitHub Pages de más de 100 MB: ahí dejá los `.exe` afuera y la página descarga desde GitHub. En Netlify probá subir la carpeta completa; si rechaza los `.exe`, pasa lo mismo.
- Los `.exe` no van al repositorio de GitHub (`.gitignore`): el código se publica en las releases.

### Versión nueva

1. Compilá el launcher (`npm run dist`) y copiá `VenusLauncher-Setup-<versión>.exe` y `VenusLauncher-Portable-<versión>.exe` a esta carpeta (borrá los viejos).
2. En `index.html`, buscá `LOCAL` y poné la versión y los nombres nuevos. Cambiá también el "1.0.13" que aparece dos veces en el HTML (el chip "Versión 1.0.13" y el título de la caja de descarga) y en los tres links `href="VenusLauncher-…"`.
3. Volvé a subir la carpeta.

## Lo que se actualiza solo (con la página en un hosting)

- **Versión y descargas:** lee la última release de `rponfee/Venus-Launcher` en GitHub y la compara con la de la carpeta.
- **Precios en pesos:** los pide al servidor de Venus (`payments_catalog`): salen de la cotización y los impuestos que cargaste en Administración → Pagos, como precio final con el IVA incluido y el precio sin impuestos. Con Mercado Pago apagado muestra "al cambio del día". Los precios en dólares también se toman de ahí.
- En la vista previa de claude.ai esas consultas están bloqueadas y no hay `.exe`: ahí los botones llevan a la página de releases.

## Cambiar la fecha

En `index.html`, buscá `LANZAMIENTO`: `Date.UTC(2026, 10, 8, 3, 0, 0)` es el 8 de noviembre de 2026 a las 00:00 de Argentina (el mes empieza en 0, así que 10 es noviembre; las 3 UTC son las 0 en Argentina). Cambiá también los textos "Llega el 8 de noviembre" y "Domingo 8 de noviembre de 2026".

## Publicar gratis

- **Netlify Drop:** entrá a https://app.netlify.com/drop y arrastrá esta carpeta.
- **Cloudflare Pages:** subí la carpeta como sitio estático (sin los `.exe`).
- Después, poné la dirección en la descripción del repositorio de GitHub y en el Discord.
