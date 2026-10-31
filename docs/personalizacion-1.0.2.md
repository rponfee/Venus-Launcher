# Venus Launcher 1.0.2 — Personalización

- La bienvenida incluye **Tu estilo**, después del idioma: permite elegir un fondo y el color de la interfaz antes de agregar una cuenta.
- **Ajustes → Apariencia** permite cambiar esas mismas opciones después, con vista previa, color personalizado, oscurecimiento y desenfoque.
- Las preferencias se guardan automáticamente. Los fondos incluidos funcionan sin conexión y no dependen de la ubicación del ZIP.
- La comunidad de Discord está disponible desde la bienvenida, la barra lateral y **Ajustes → Acerca de**: https://discord.gg/8KuvU5Cswn.

La colección entregada contiene 49 fondos únicos válidos. Se omitieron dos duplicados y un PNG incompleto (`(36).png`). El inventario y los nombres originales están en `src/renderer/assets/wallpapers/manifest.json`.

Los ejecutables 1.0.1 y los datos existentes se conservan. El portable 1.0.2 utiliza la carpeta `VenusData` junto al ejecutable, igual que la versión anterior.

## Verificación

`npm run check` verifica la sintaxis. `scripts/personalization-smoke.js`, ejecutado con Electron, prueba la bienvenida, el guardado y la restauración, Ajustes, teclado, cambios de fondo y los tres accesos a Discord. Usa un perfil temporal y captura el destino de los enlaces sin abrir el navegador.

`VENUS_SMOKE_APP_ROOT` permite repetir la prueba contra el `resources/app.asar` de la aplicación empaquetada. Los resultados y las capturas se escriben en `build/personalization-qa` o en `VENUS_SMOKE_OUTPUT`.

Los archivos originales modificados se respaldaron en `backup/personalization-20261029`.
