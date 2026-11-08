# Límite de consultas de Ayuda rápida con IA

La función `support-ai` usa GPT-6 Luna con razonamiento bajo y la clave OpenAI del servidor. La migración 0054 limita a cada cuenta autenticada a **3 preguntas por minuto**, además de los límites existentes de **10 preguntas por día por cuenta** y **2000 preguntas por día en total**. Al superar el límite, el servidor responde 429 antes de llamar al modelo, por lo que el intento rechazado no consume tokens de OpenAI.

La ventana de un minuto empieza con la primera pregunta admitida. Las cuentas anónimas o suspendidas siguen rechazadas. Los planes y presupuestos USD de Venus IA no cambian.

La revisión se hace en `private.support_ai_rate`; la función pública `support_ai_access` conserva su firma y continúa disponible solo para `service_role`. La versión 4.6.3 beta 3 ya llama a esa función, por lo que el límite entra en vigor sin instalar otra beta.
