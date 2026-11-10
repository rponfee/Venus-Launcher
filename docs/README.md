# Documentación de Venus Launcher

La **4.6.0 está publicada** (tag `v4.6.0`) e incluye lo preparado para la 4.5.0. En producción están aplicadas las migraciones hasta la **0047** (menos la 0044, que prepara otra sesión); la **0048**, de limpieza, está escrita y sin aplicar. Empezá por [funciones.md](funciones.md) para el uso, [arquitectura.md](arquitectura.md) para los contratos y [supabase.md](supabase.md) para el estado de la base. Los [documentos permanentes de implementación](implementacion/README.md) conservan los contratos y antecedentes de los frentes de la 4.5.0; el estado y la activación de esa versión están en el [estado](estado-4.5.0.md) y el [registro de activación](activacion-backend-4.5.0.md).

| Documento | Para quién | De qué trata |
|---|---|---|
| [../README.md](../README.md) | Dueño y colaboradores | Qué es Venus Launcher, lista de funciones, requisitos, comandos (`npm start`, `npm run dist`, `npm run check`), scripts, dónde se guardan los datos e idiomas. |
| [funciones.md](funciones.md) | Usuarios | Guía de cada función del launcher: cómo se usa y qué necesita (cuenta de Venus, IA, Discord...). |
| [retirada-funciones.md](retirada-funciones.md) | Dueño y desarrolladores | Retiros de la 4.5.0, la 4.6 y la 6.1 (Clanes, modo streamer y OBS, Extensiones, visor de semillas, Competir, Herramientas, capas y Comunidades) y datos conservados. |
| [venus-pass.md](venus-pass.md) | Dueño y desarrolladores | Venus Pass permanente por tiempo jugado: 380 niveles, premios, servidor y administración. |
| [login-microsoft.md](login-microsoft.md) | Dueño | Cómo pasar el inicio de sesión de Microsoft a una app propia de Azure, con la aprobación de Mojang. |
| [macos.md](macos.md) | Dueño y desarrolladores | Versión de macOS (6.1): qué se adaptó (Java y nativos de Apple Silicon con Rosetta, menú, Cmd, micrófono, Discord, links), qué no está, cómo se compila y se prueba en GitHub Actions, firma ad hoc y límites conocidos. |
| [arquitectura.md](arquitectura.md) | Desarrolladores | Documento vivo con la arquitectura y las reglas para programar: módulos, canales IPC, contratos entre módulos, rutas, ajustes, archivos de datos y cómo verificar. |
| [../design-system/venus-launcher/MASTER.md](../design-system/venus-launcher/MASTER.md) | Desarrolladores y diseño | Sistema de diseño: identidad, tokens (color, tipografía, espaciado, movimiento), componentes, layout de página, accesibilidad y checklist antes de entregar una pantalla. |
| [supabase.md](supabase.md) | Dueño (quien administra la nube) | Qué crea cada migración (0001–0047 aplicadas en producción y la 0048 sin aplicar), Auth, Realtime, Storage y configuración pendiente de servicios. |
| [backend-ia.md](backend-ia.md) | Dueño y desarrolladores | Edge Function `ai-assistant`: protocolo, errores, seguridad, despliegue, cómo se cuenta la cuota, planes, costos, respaldo en OpenAI y privacidad. |
| [pagos.md](pagos.md) | Dueño y desarrolladores | Pagos de Venus IA con Stripe: Checkout, portal, webhook, modo de prueba, impuestos, pagos fallidos y los canales `billing:*` para la interfaz. |
| [admin.md](admin.md) | Dueño (administradores) | Panel de administración (`#/admin`): quién tiene acceso, usuarios, moderación, cupones, planes, registro y la Edge Function `admin`. |
| [asistente-ia.md](asistente-ia.md) | Desarrolladores | Cómo funciona el Asistente IA por dentro: bucle de herramientas, permisos, restricciones, Deshacer, configuración y privacidad. |
| [../supabase/functions/README.md](../supabase/functions/README.md) | Dueño y desarrolladores | Desplegar y probar las Edge Functions (secretos, `curl` y pruebas automáticas). |
| [insignia.md](insignia.md) | Dueño y desarrolladores | Insignia de Venus en el juego: el mod (Fabric, NeoForge y Forge), cómo se verifica la cuenta con Mojang sin mandar el token, la consulta del mod, el despliegue y cómo probarla. |
| [musica.md](musica.md) | Desarrolladores | Música: el ayudante de los controles multimedia de Windows, volumen por app, atajos, canales y errores. |
| [overlay.md](overlay.md) | Desarrolladores | Overlay en el juego: la ventana sobre el juego, el seguimiento de su rectángulo, los eventos que acepta, los widgets, los ajustes y la auditoría de la 4.6. |
| [clips.md](clips.md) | Desarrolladores | Clips y capturas: grabación y repetición instantánea en WebM, dónde se guarda todo, editor, compartir y la descripción con IA. |
| [perfiles.md](perfiles.md) | Desarrolladores | Perfiles: `profile_customize`, `profile_public`, `profile-style.js`, el editor, `profile-media`, lo premium y lo que cambió en la 4.6 (avatar circular, banners, marcos y música de Openverse). |
| [venus-points.md](venus-points.md) | Dueño y desarrolladores | Venus Points: reglas de los puntos, invitaciones a prueba de cuentas falsas, logros (solo de Venus desde la 4.6), tienda y Venus Premium. |
| [grupos.md](grupos.md) | Desarrolladores | Grupos para jugar (señales `party-*`) y avisos de amigos y servidores favoritos. |
| [temas.md](temas.md) | Desarrolladores | Temas compartibles (código y galería de la comunidad) y editor de skins. |

| Documento de integración | Para quién | Contenido |
|---|---|---|
| [estado-4.5.0.md](estado-4.5.0.md) | Dueño e integración | Decisiones, evidencia local y de producción, credenciales y comprobaciones externas pendientes. |
| [activacion-backend-4.5.0.md](activacion-backend-4.5.0.md) | Dueño y backend | Activación del 4 de noviembre: nueve versiones aplicadas, Edge Functions desplegadas, lecturas SQL/HTTP y límites. |
| [implementacion/README.md](implementacion/README.md) | Desarrolladores | Especificaciones permanentes, con tablas, canales, RPC, datos y límites. |
| [Revisión SQL 0028–0036](implementacion/revision-sql-0028-0036.md) | Dueño y backend | Correcciones, guardas y ensayo local ejecutado el 3 de noviembre: 1282 comprobaciones (1225 estructurales y 57 escenarios), con rollback. |
| [hoja-de-ruta.md](hoja-de-ruta.md) | Dueño y colaboradores | Grupos históricos, lo hecho en la 4.6 y lo que sigue. |
| [Web y PWA](../web/LEEME.md) | Dueño | Hosting, ruta `/app/`, cabeceras y validación pendiente en celulares. |
