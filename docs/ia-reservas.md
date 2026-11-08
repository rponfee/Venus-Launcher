# Corrección de reservas de Venus IA

**Estado: aplicada en producción el 8 de noviembre de 2026 con autorización del propietario.**

La prueba real dejó tres reservas en estado `reserved` desde el 8 de noviembre de 2026 (00:30–00:32 UTC). Las tres respuestas quedaron contabilizadas en `ai_usage_model_daily` por 0,001670 USD, pero `ai_add_usage` y `ai_end_call` no cerraban las reservas. `ai_register_turn` veía tres llamadas en curso y devolvía el aviso de demasiados pedidos seguidos aunque hubiera pasado más de un minuto.

La migración 0053:

1. Conserva las firmas y permisos actuales de las tres funciones.
2. Cierra cada reserva cuando se registra el uso o termina una llamada sin uso.
3. Suma el coste real al período de pago, respetando el presupuesto USD existente.
4. Libera reservas de más de cinco minutos al admitir otra llamada, para evitar bloqueos permanentes después de una caída.
5. Reconcilia el gasto ya registrado del período afectado y cierra las tres reservas históricas. Deja `actual_usd` nulo en ellas porque no se conoce el coste individual; el coste agregado sí está en `ai_usage_model_daily`.

La migración no cambia el plan ni el presupuesto USD. Antes de aplicarla, confirmar que siguen siendo tres reservas antiguas y que las funciones aún tienen las definiciones revisadas. Después comprobar que hay cero reservas antiguas, que el gasto del período coincide con el uso registrado y que una petición real de Venus IA responde sin el aviso. No registrar preguntas ni claves en los logs.

El propietario autorizó expresamente aplicar solo 0053. Se verificó que las tres reservas quedaron cerradas y que el gasto del período coincide con el uso registrado (0,001670 USD de un presupuesto de 4,50 USD). La migración 0052 continúa sin aplicar.
