# Venus Launcher: migración a OpenAI y grupos de instancias

Esta compilación se basa en el código fuente de 4.6.2. El instalador no cambia
la base de datos ni despliega Edge Functions por sí solo. La beta 3 está
publicada, pero el cambio de proveedor y el soporte MCP aún requieren activar
los componentes del servidor.

## Orden de activación

1. Guardar un respaldo de la base de datos de Supabase.
2. Aplicar `0050_openai_vault.sql` y guardar la clave de OpenAI desde
   **Administración → Integraciones**. La aplicación la envía una vez a la RPC;
   Vault la cifra y la respuesta muestra solo su estado y los últimos cuatro
   caracteres. No pasar la clave por el chat ni incluirla en el instalador.
3. Desplegar la nueva Edge Function `ai-assistant`, que aún respeta la
   configuración actual de Anthropic. Confirmar que responde antes del cambio.
4. Aplicar `0049_openai_primary.sql`, que activa OpenAI y mantiene los
   presupuestos mensuales en USD. Verificar una consulta de Venus IA.
5. Aplicar `0051_support_ai.sql` y desplegar `support-mcp` y `support-ai`.
   El MCP usa solo la clave pública del proyecto y devuelve datos estáticos de
   ayuda; el JWT de sesión del usuario no se envía a OpenAI.
6. Probar una consulta de Venus IA con cada plan y una consulta de soporte en dos
   idiomas. Verificar en la base el modelo real, el costo y el límite de USD.
7. Aplicar `0052_retire_points_pass.sql` cuando la versión nueva reemplace a la
   estable 4.6.2. Esa migración desactiva Points/Pass y rompería sus controles
   aún visibles en la app estable.

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

- Beta 3 publicada en GitHub y compilada por CI; el instalador aún no está firmado.
- En Supabase producción se aplicó solo 0050 y la clave OpenAI figura guardada.
  Anthropic sigue como proveedor primario; 0049, 0051, 0052 y las nuevas Edge
  Functions aún no se desplegaron.
- Pruebas automatizadas de backend y sincronización ejecutadas con dobles de
  prueba. Falta probar las migraciones y las Edge Functions contra el proyecto de
  Supabase real y confirmar la conexión MCP remota.
- Los textos nuevos de soporte están en los 14 idiomas. La traducción integral
  del panel de administración todavía falta en 12 idiomas y requiere revisión
  humana; esos idiomas usan el texto de respaldo.
- No se modificaron saldos históricos, compras ni registros de Points/Pass; la
  migración desactiva nuevas operaciones y mantiene esos datos para auditoría.

