# Documentación de Venus Launcher

| Documento | Para quién | De qué trata |
|---|---|---|
| [../README.md](../README.md) | Dueño y colaboradores | Qué es Venus Launcher, lista de funciones, requisitos, comandos (`npm start`, `npm run dist`, `npm run check`), scripts, dónde se guardan los datos e idiomas. |
| [funciones.md](funciones.md) | Usuarios | Guía de cada función del launcher: cómo se usa y qué necesita (cuenta de Venus, IA, Discord...). |
| [login-microsoft.md](login-microsoft.md) | Dueño | Cómo pasar el inicio de sesión de Microsoft a una app propia de Azure, con la aprobación de Mojang. |
| [arquitectura.md](arquitectura.md) | Desarrolladores | Documento vivo con la arquitectura y las reglas para programar: módulos, canales IPC, contratos entre módulos, rutas, ajustes, archivos de datos y cómo verificar. |
| [../design-system/venus-launcher/MASTER.md](../design-system/venus-launcher/MASTER.md) | Desarrolladores y diseño | Sistema de diseño: identidad, tokens (color, tipografía, espaciado, movimiento), componentes, layout de página, accesibilidad y checklist antes de entregar una pantalla. |
| [supabase.md](supabase.md) | Dueño (quien administra la nube) | Cómo conectar Supabase: qué crea cada migración (0001 a 0022), emails con código, Realtime, Storage, backend de la IA y servidores destacados. |
| [backend-ia.md](backend-ia.md) | Dueño y desarrolladores | Edge Function `ai-assistant`: protocolo, errores, seguridad, despliegue, cómo se cuenta la cuota, planes, costos, respaldo en OpenAI y privacidad. |
| [pagos.md](pagos.md) | Dueño y desarrolladores | Pagos de Venus IA con Stripe: Checkout, portal, webhook, modo de prueba, impuestos, pagos fallidos y los canales `billing:*` para la interfaz. |
| [admin.md](admin.md) | Dueño (administradores) | Panel de administración (`#/admin`): quién tiene acceso, usuarios, moderación, cupones, planes, registro y la Edge Function `admin`. |
| [mcp.md](mcp.md) | Usuarios y desarrolladores | Usar Venus desde Claude Desktop, Claude Code, ChatGPT y claude.ai (MCP): conexión, seguridad, túnel, actividad y el protocolo. |
| [asistente-ia.md](asistente-ia.md) | Desarrolladores | Cómo funciona el Asistente IA por dentro: bucle de herramientas, permisos, restricciones, Deshacer, configuración y privacidad. |
| [extension-ejemplo/README.md](extension-ejemplo/README.md) | Creadores de extensiones | Cómo hacer una extensión (`manifest.json`, permisos y API) con un ejemplo que funciona tal cual. |
| [../supabase/functions/README.md](../supabase/functions/README.md) | Dueño y desarrolladores | Desplegar y probar las Edge Functions (secretos, `curl` y pruebas automáticas). |
| [insignia.md](insignia.md) | Dueño y desarrolladores | Insignia de Venus en el juego: el mod (Fabric, NeoForge y Forge), cómo se verifica la cuenta con Mojang sin mandar el token, la consulta del mod, el despliegue y cómo probarla. |
| [musica.md](musica.md) | Desarrolladores | Música: el ayudante de los controles multimedia de Windows, volumen por app, atajos, canales y errores. |
| [overlay.md](overlay.md) | Desarrolladores | Overlay en el juego: la ventana sobre el juego, el seguimiento de su rectángulo, los eventos que acepta, los widgets y los ajustes. |
| [clips.md](clips.md) | Desarrolladores | Clips y capturas: grabación y repetición instantánea en WebM, dónde se guarda todo, editor, compartir y la descripción con IA. |
| [perfiles.md](perfiles.md) | Desarrolladores | Perfiles 2.0: `profile_customize`, `profile_public`, `profile-style.js`, el editor, `profile-media` y lo premium. |
| [venus-points.md](venus-points.md) | Dueño y desarrolladores | Venus Points: reglas de los puntos, invitaciones a prueba de cuentas falsas, logros, tienda y Venus Premium. |
| [grupos.md](grupos.md) | Desarrolladores | Grupos para jugar (señales `party-*`) y avisos de amigos y servidores favoritos. |
| [temas.md](temas.md) | Desarrolladores | Temas compartibles (código y galería de la comunidad) y editor de skins. |
