# CurseForge en Venus Launcher

La clave se carga desde **Administración → Integraciones → CurseForge** y se conserva cifrada en Vault. El launcher usa su sesión de Venus para consultar la función `curseforge`; nunca recibe la clave central. Las instalaciones siguen los permisos de distribución de cada autor.

## Comprobar la clave

1. Pegá la clave API de la solicitud aprobada para el launcher y elegí **Guardar clave** o **Reemplazar clave**.
2. Elegí **Probar búsqueda**. Consulta `/v1/mods/search?gameId=432&classId=6&pageSize=1` por el mismo servicio que usa el catálogo.
3. Un resultado correcto confirma una búsqueda de Minecraft. Guardar una clave solo confirma que se guardó. Cargar las categorías tampoco demuestra acceso a búsquedas.

Si CurseForge rechaza la clave, el panel lo explica y permite reemplazarla. La anterior se conserva hasta guardar otra o quitarla. El catálogo distingue ese error de una cuenta sin permisos, una sesión vencida y un límite de consultas. Los errores no muestran cuerpos remotos ni claves.

## Diagnóstico del 4 de noviembre de 2026

- La primera clave guardada era de CurseForge Profile, no la clave aprobada para el launcher. Las categorías respondían HTTP 200, pero las búsquedas de mods recibían HTTP 403.
- Después de reemplazarla por la clave del launcher, una búsqueda mínima y la consulta con filtros que usa el catálogo respondieron **HTTP 200** desde el servidor; la segunda devolvió un resultado. La clave no salió del servidor.
- La prueba directa confirma acceso de esa clave al endpoint de búsqueda. Las pruebas de código cubren el proxy y la interfaz, pero todavía falta comprobar el recorrido completo con una sesión real dentro de la app.

Referencia del contrato: [documentación oficial de CurseForge](https://docs.curseforge.com/rest-api/).
