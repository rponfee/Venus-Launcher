# Venus Launcher 4.6.3 beta 1

Versión preliminar para Windows 10/11 x64. Incluye la migración de Venus IA a
OpenAI, el grupo de instancias predeterminado y la simplificación de la interfaz.

## Cambios

- Venus IA usa GPT-6 Luna en todos los planes. Basic, Go, Pro y Max tienen
  distintos niveles de razonamiento y límites de respuesta; se conservan los
  presupuestos mensuales en USD de la base de datos.
- La clave de OpenAI se configura desde Administración → Integraciones y queda
  en Supabase Vault. No se incluye en el instalador.
- Instance Groups comparte servidores guardados y configuración de teclas entre
  instancias por defecto. Los cambios de teclas en Minecraft se propagan al
  cerrar la sesión.
- Se retiraron de la interfaz la búsqueda inteligente de mods, Venus Points,
  Venus Pass y la galería de medios dentro de Mundos. Capturas y Clips continúa
  por separado; la personalización del perfil permanece.
- Se agregó soporte asistido por OpenAI con una herramienta MCP de ayuda y
  textos de soporte en los 14 idiomas. Se mejoró el prompt de skins con IA.

## Antes de usar Venus IA

Esta versión requiere activar en Supabase las migraciones 0049–0052, desplegar
`ai-assistant`, `support-mcp` y `support-ai`, y configurar una clave OpenAI. Ver
[migracion-openai-y-grupos.md](migracion-openai-y-grupos.md). La base de datos de
producción no se cambió al preparar esta beta, así que Venus IA y el soporte
nuevos no están listos en el servicio actual.

La traducción integral del panel de administración sigue pendiente en 12
idiomas; usa textos de respaldo. El soporte MCP todavía no se probó contra el
servicio desplegado. Esta beta no reemplaza la versión estable 4.6.2.
