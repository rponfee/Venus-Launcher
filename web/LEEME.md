# Página web de Venus Launcher

Esta carpeta es la página lista para subir a cualquier hosting estático: `index.html` y `assets/` (logo y capturas del launcher).

## Qué muestra

- **Hasta el domingo 8 de noviembre de 2026 a las 00:00 (hora de Argentina):** solo la cuenta regresiva, con el logo y el link al Discord.
- **Desde esa hora:** el sitio completo (funciones, Venus IA, planes, descarga, privacidad y preguntas). Aparece solo, sin subir nada: la página compara la hora del servidor con la fecha. Si alguien la tiene abierta en ese momento, cambia cuando la cuenta llega a cero.
- **Para ver el sitio completo antes de la fecha:** abrí la página con `#previa` al final, por ejemplo `https://tu-sitio/#previa` o, en tu PC, `index.html#previa`.
- El contenido viaja dentro de `index.html`: quien abra el código fuente lo puede leer antes de la fecha. La cuenta regresiva es para los visitantes, no un secreto.

## Lo que se actualiza solo (con la página en un hosting)

- **Versión y descargas:** lee la última release de `rponfee/Venus-Launcher` en GitHub. Si la release trae `VenusLauncher-Setup-<versión>.exe` y `VenusLauncher-Portable-<versión>.exe`, los botones bajan esos archivos directo y muestran la versión, el tamaño y la fecha; si no, llevan a la página de releases.
- **Precios en pesos:** los pide al servidor de Venus (`payments_catalog`): salen de la cotización y los impuestos que cargaste en Administración → Pagos, como precio final con el IVA incluido y el precio sin impuestos. Con Mercado Pago apagado muestra "al cambio del día". Los precios en dólares también se toman de ahí.
- En la vista previa de claude.ai esas consultas están bloqueadas: ahí se ve el texto fijo.

## Cambiar la fecha

En `index.html`, buscá `LANZAMIENTO`: `Date.UTC(2026, 10, 8, 3, 0, 0)` es el 8 de noviembre de 2026 a las 00:00 de Argentina (el mes empieza en 0, así que 10 es noviembre; las 3 UTC son las 0 en Argentina). Cambiá también los textos "Llega el 8 de noviembre" y "Domingo 8 de noviembre de 2026".

## Publicar gratis

- **Netlify Drop:** entrá a https://app.netlify.com/drop y arrastrá esta carpeta.
- **Cloudflare Pages:** subí la carpeta como sitio estático.
- Después, poné la dirección en la descripción del repositorio de GitHub y en el Discord.
