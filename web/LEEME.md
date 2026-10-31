# Página web de Venus Launcher

Esta carpeta es la página lista para subir a cualquier hosting estático: `index.html` y `assets/` (logo y capturas del launcher). Pesa menos de 1 MB: entra en cualquier hosting gratis.

## Qué muestra

- **Hasta el domingo 8 de noviembre de 2026 a las 00:00 (hora de Argentina):** solo la cuenta regresiva, con el logo y el link al Discord.
- **Desde esa hora:** el sitio completo (funciones, Venus IA, planes, descarga, privacidad y preguntas). Aparece solo, sin subir nada: la página compara la hora del servidor con la fecha. Si alguien la tiene abierta en ese momento, cambia cuando la cuenta llega a cero.
- **Para ver el sitio completo antes de la fecha:** abrí la página con `#previa` al final, por ejemplo `https://tu-sitio/#previa` o, en tu PC, `index.html#previa`.
- El contenido viaja dentro de `index.html`: quien abra el código fuente lo puede leer antes de la fecha. La cuenta regresiva es para los visitantes, no un secreto.

## Las descargas: siempre la versión más nueva, desde GitHub

Los botones usan los links fijos de GitHub que bajan la última release:

- Instalador: https://github.com/rponfee/Venus-Launcher/releases/latest/download/VenusLauncher-Setup.exe
- Portable: https://github.com/rponfee/Venus-Launcher/releases/latest/download/VenusLauncher-Portable.exe

Funcionan porque, desde la 1.0.13, los archivos de cada release se llaman siempre igual (sin el número de versión). Cuando publicás una release nueva, los mismos links bajan la nueva: no hay que tocar la página.

Además, la página consulta la API de GitHub para mostrar la versión, el tamaño y la fecha de la última release. Si una release tuviera los archivos con otro nombre, ajusta los links sola.

**Para publicar una versión:** compilá con `npm run dist` y creá la release `v<versión>` en GitHub con los cuatro archivos de `dist\`: `VenusLauncher-Setup.exe`, `VenusLauncher-Portable.exe`, `VenusLauncher-Setup.exe.blockmap` y `latest.yml`. Hasta que exista la release `v1.0.13`, los links fijos devuelven "not found", porque la 1.0.11 tiene los archivos con el nombre viejo; mientras tanto la página, con la API, apunta a los archivos de la 1.0.11.

## Lo que se actualiza solo (con la página en un hosting)

- **Versión y descargas:** de la última release de GitHub.
- **Precios en pesos:** los pide al servidor de Venus (`payments_catalog`): salen de la cotización y los impuestos que cargaste en Administración → Pagos, como precio final con el IVA incluido y el precio sin impuestos. Con Mercado Pago apagado muestra "al cambio del día". Los precios en dólares también se toman de ahí.
- En la vista previa de claude.ai esas consultas están bloqueadas: ahí se ve el texto fijo y los botones usan los links fijos.

## Cambiar la fecha

En `index.html`, buscá `LANZAMIENTO`: `Date.UTC(2026, 10, 8, 3, 0, 0)` es el 8 de noviembre de 2026 a las 00:00 de Argentina (el mes empieza en 0, así que 10 es noviembre; las 3 UTC son las 0 en Argentina). Cambiá también los textos "Llega el 8 de noviembre" y "Domingo 8 de noviembre de 2026".

## Publicar gratis

- **Netlify Drop:** entrá a https://app.netlify.com/drop y arrastrá esta carpeta.
- **Cloudflare Pages** o **GitHub Pages:** subí la carpeta como sitio estático.
- Después, poné la dirección en la descripción del repositorio de GitHub y en el Discord.
