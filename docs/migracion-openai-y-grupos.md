# Venus Launcher: migración a OpenAI y grupos de instancias

Esta compilación se basa en el código fuente de 4.6.2. El instalador no cambia
la base de datos ni despliega Edge Functions por sí solo. Para activar Venus IA,
el soporte MCP y la retirada de Points/Pass en producción, aplicar y desplegar
los componentes del servidor antes de distribuir el instalador.

## Orden de activación

1. Guardar un respaldo de la base de datos de Supabase.
2. Antes de cambiar el proveedor, asegurar una clave OpenAI en el servidor.
   Se puede aplicar `0050_openai_vault.sql` primero y guardarla desde la nueva
   aplicación, o establecer temporalmente el secreto Edge Function
   `OPENAI_API_KEY` si se usa `db push` en orden de archivo. No aplicar `0049`
   sin una de estas dos opciones: Venus IA quedaría sin proveedor.
3. Aplicar `0049_openai_primary.sql`, `0050_openai_vault.sql` si aún falta,
   `0051_support_ai.sql` y `0052_retire_points_pass.sql`.
4. Desplegar las Edge Functions `ai-assistant`, `support-mcp` y `support-ai`.
5. Entrar con una cuenta administradora en **Administración → Integraciones** y
   guardar la clave de OpenAI. La aplicación envía la clave una vez a la RPC;
   el backend la guarda en Supabase Vault y devuelve solo el estado y los últimos
   cuatro caracteres. También se puede usar el secreto de servidor
   `OPENAI_API_KEY` como alternativa.
6. Probar una consulta de Venus IA con cada plan y una consulta de soporte en dos
   idiomas. Verificar en la base el modelo real, el costo y el límite de USD.
7. Distribuir el instalador y la versión portable.

El backend de IA usa `gpt-6-luna` en los cuatro planes. `haiku` sigue como ID
interno de preguntas previas; las llamadas nuevas se envían a OpenAI. El límite
mensual en USD de cada plan se conserva. Un esfuerzo de razonamiento mayor y un
límite de respuesta mayor pueden gastar ese saldo más rápido.

Instance Groups viene activo para instancias nuevas o configuraciones sin valor
previo. El launcher une los servidores guardados de las instancias existentes;
los cambios de servidores hechos en el launcher se propagan a las instancias
inactivas. Los cambios de teclas realizados en Minecraft se propagan al cerrar
esa sesión. Se puede desactivar el grupo por instancia.

## Estado de verificación

- Compilación de Windows generada en local; no es una versión publicada ni firmada.
- Pruebas automatizadas de backend y sincronización ejecutadas con dobles de
  prueba. Falta probar las migraciones y las Edge Functions contra el proyecto de
  Supabase real y confirmar la conexión MCP remota.
- Los textos nuevos de soporte están en los 14 idiomas. La traducción integral
  del panel de administración todavía falta en 12 idiomas y requiere revisión
  humana; esos idiomas usan el texto de respaldo.
- No se modificaron saldos históricos, compras ni registros de Points/Pass; la
  migración desactiva nuevas operaciones y mantiene esos datos para auditoría.
