# Documentación de Venus Launcher

| Documento | Para quién | De qué trata |
|---|---|---|
| [../README.md](../README.md) | Dueño y colaboradores | Qué es Venus Launcher, lista de funciones, requisitos, comandos (`npm start`, `npm run dist`, `npm run check`), scripts, dónde se guardan los datos e idiomas. |
| [funciones.md](funciones.md) | Usuarios | Guía de cada función del launcher: cómo se usa y qué necesita (cuenta de Venus, IA, Discord...). |
| [arquitectura.md](arquitectura.md) | Desarrolladores | Documento vivo con la arquitectura y las reglas para programar: módulos, canales IPC, contratos entre módulos, rutas, ajustes, archivos de datos y cómo verificar. |
| [../design-system/venus-launcher/MASTER.md](../design-system/venus-launcher/MASTER.md) | Desarrolladores y diseño | Sistema de diseño: identidad, tokens (color, tipografía, espaciado, movimiento), componentes, layout de página, accesibilidad y checklist antes de entregar una pantalla. |
| [supabase.md](supabase.md) | Dueño (quien administra la nube) | Cómo conectar Supabase: qué crea cada migración (0001 a 0012), emails con código, Realtime, Storage, backend de la IA y servidores destacados. |
| [backend-ia.md](backend-ia.md) | Dueño y desarrolladores | Edge Function `ai-assistant`: protocolo, errores, seguridad, despliegue, cómo se cuenta la cuota, planes, costos, respaldo en OpenAI y privacidad. |
| [pagos.md](pagos.md) | Dueño y desarrolladores | Pagos de Venus IA con Stripe: Checkout, portal, webhook, modo de prueba, impuestos, pagos fallidos y los canales `billing:*` para la interfaz. |
| [admin.md](admin.md) | Dueño (administradores) | Panel de administración (`#/admin`): quién tiene acceso, usuarios, moderación, cupones, planes, registro y la Edge Function `admin`. |
| [mcp.md](mcp.md) | Usuarios y desarrolladores | Usar Venus desde Claude Desktop, Claude Code, ChatGPT y claude.ai (MCP): conexión, seguridad, túnel, actividad y el protocolo. |
| [asistente-ia.md](asistente-ia.md) | Desarrolladores | Cómo funciona el Asistente IA por dentro: bucle de herramientas, permisos, restricciones, Deshacer, configuración y privacidad. |
| [extension-ejemplo/README.md](extension-ejemplo/README.md) | Creadores de extensiones | Cómo hacer una extensión (`manifest.json`, permisos y API) con un ejemplo que funciona tal cual. |
| [../supabase/functions/README.md](../supabase/functions/README.md) | Dueño y desarrolladores | Desplegar y probar las Edge Functions (secretos, `curl` y pruebas automáticas). |
