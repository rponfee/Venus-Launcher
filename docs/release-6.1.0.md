# Venus Launcher 6.1.0

Versión estable para Windows 10 y 11 (64 bits) y primera versión para macOS 12 o posterior (Intel y Apple Silicon).

## Novedades

- **Venus IA con Claude o ChatGPT.** Hay cinco planes de cada una (Basic, Go, Pro, Max y Ultra) y cada plan tiene su propio saldo. Con un saldo de cada una, cuando uno se termina Venus pasa al otro y avisa. Los planes de Claude se habilitan cuando el equipo carga su clave en Administración → Integraciones.
- **Versión para macOS** (`VenusLauncher-mac.dmg`, universal): las mismas pantallas y los 14 idiomas. No incluye el overlay, la música, los clips ni la actualización automática, que dependen de Windows. La app no está firmada por Apple: la primera vez se abre desde Ajustes del Sistema → Privacidad y seguridad (o con clic derecho → Abrir).
- **Overlay opcional.** Viene apagado y se activa en la bienvenida o en Ajustes → En el juego. Suma diseños listos (Mínimo, Completo y Rendimiento) y el modo No molestar. Mientras está apagado no usa recursos.
- **Clips con más calidad:** la repetición instantánea guarda hasta 30 minutos para todos (ya no depende del plan), con 30, 45, 60, 80 o 120 FPS y 720p, 1080p, 1440p (2K) o 4K. Hay ajustes listos (Liviano, Equilibrado y Máximo), graba con la placa de video cuando puede y avisa cuánto espacio va a ocupar para no llenar el disco.
- **Más personalización:** tarjeta Estilo en Ajustes → Apariencia (letra, tamaño del texto, tarjetas, esquinas, densidad y menú) y la página en la que abre el launcher.
- **Administración:** pestaña Equipo para dar y quitar el acceso de administrador (solo el dueño) y el rol de soporte, uso de IA por motor en el Resumen y registro con filtros.
- **Se retiraron las Comunidades.** Amigos, mensajes, grupos y salas de voz siguen igual.

## Actualización

En Windows, la edición instalada comprueba actualizaciones al abrir y cada cuatro horas cuando Ajustes → Privacidad → Actualizaciones automáticas está activado. Descarga 6.1.0 y la instala al cerrar Venus; también se puede buscar desde Actualizaciones. La edición portable y la de macOS avisan y ofrecen la descarga manual.

Quien usaba el overlay sin haberlo configurado lo encuentra apagado después de actualizar: un aviso lleva a Ajustes → En el juego para volver a activarlo.

## Limitaciones

- La versión de macOS es la primera y se probó en los equipos de GitHub, no en todas las Mac: puede tener errores. Las versiones de Minecraft anteriores a la 1.19 en Apple Silicon necesitan Rosetta 2.
- Las Comunidades siguen funcionando para quien no actualice (por ejemplo, con la edición portable 6.0.0), pero el panel de Administración de la 6.1 ya no tiene su pestaña: mientras tanto se moderan con SQL (ver `docs/retirada-funciones.md`).
- Los topes de tokens por respuesta de los planes más altos son un máximo: una respuesta tarda como mucho 140 segundos, así que las muy largas pueden quedar cortadas antes de llegar al tope.
- La recuperación automática del ejecutable anterior tras una actualización del launcher que impida iniciarlo no está incluida. En ese caso, reinstalá la versión anterior desde GitHub Releases.
- Las traducciones agregadas siguen pendientes de revisión por hablantes nativos.
