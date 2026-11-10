# Referencias de implementación de 4.5.0

Documentación permanente de los doce frentes. Conserva sus tablas de archivos, canales, RPC, formatos, límites y evidencia atribuida. Estado de publicación y pendientes compartidos: [estado de integración](../estado-4.5.0.md).

| Referencia | Alcance |
|---|---|
| [Instancias: aspecto, ajustes compartidos, sets, enlaces y changelog](instancias.md) | Contratos, uso, datos y límites |
| [Datos y PC: copias, rendimiento, familia, portabilidad y sincronización](datos.md) | Contratos, uso, datos y límites |
| [Overlay y mapa: recetas, contadores, marcadores y asistente](overlay.md) | Contratos, uso, datos y límites |
| [Servidores: control remoto, Discord y reseñas](servidores.md) | Contratos, uso, datos y límites |
| [Mensajes y voz: stickers, traducción, soundboard y efectos](mensajes-voz.md) | Contratos, uso, datos y límites |
| [Estudio de clips: montaje, timelapse, subida y galería](clips.md) | Contratos, uso, datos y límites |
| [Clanes y comunidades](clanes-comunidades.md) | Comunidades (con la ampliación de la 4.6: roles, permisos por canal, GIFs con aprobación, bienvenida y despedida). Clanes se retiró en la 4.6 y Comunidades en la 6.1: queda como antecedente |
| [Insignia y FPS del mod](../insignia.md) | Las capas de Venus se retiraron en el mod 1.3.0; la insignia y los FPS se conservan |
| [App para celular: PWA, mensajes, clips y avisos](app-celular.md) | Contratos, uso, datos y límites |
| [Venus IA con dos motores: planes de Claude y de ChatGPT](ia-dos-motores.md) | Contrato de la 6.1: planes, saldos por motor, cambio automático y orden para publicar |

Los doce borradores de funciones y el informe SQL se reconciliaron con estas referencias el 3 de noviembre de 2026. Después de revisar los cambios se retiró `docs/wip/`, con un respaldo temporal indicado en el estado de integración. Las guías de usuario y los comentarios de fuentes apuntan a estas rutas permanentes.

## Revisión transversal de la base

[Revisión SQL 0028–0036](revision-sql-0028-0036.md) conserva completo el informe final: PostgreSQL 17.11 temporal, 0001–0027 completas y 0028–0036 en BEGIN/ROLLBACK; **1282 comprobaciones (1225 estructurales y 57 escenarios)**, con esquema/ACL, filas y secuencias restaurados. Incluye los comandos del runner y del generador y sus guardas. Usa fixtures mínimos de Auth/Storage/Realtime, sin pg_net ni servicios Supabase reales. No hubo despliegue ni pruebas con usuarios de producción.

## Mapa de documentos de origen

Los nombres de origen son antecedentes de los grupos 3.2–3.4; el destino documenta la rama 4.5.0. Los borradores originales ya fueron retirados de `docs/wip/`.

| Nombre de origen | Referencia permanente |
|---|---|
| `app-celular-34.md` | [app-celular.md](app-celular.md) |
| `capas-34.md` | Retirada en la 4.6 ([insignia.md](../insignia.md)) |
| `clanes-comunidades-34.md` | [clanes-comunidades.md](clanes-comunidades.md) |
| `clips-33.md` | [clips.md](clips.md) |
| `datos-32.md` | [datos.md](datos.md) |
| `instancias-32.md` | [instancias.md](instancias.md) |
| `mensajes-voz-33.md` | [mensajes-voz.md](mensajes-voz.md) |
| `overlay-32.md` | [overlay.md](overlay.md) |
| `revision-sql-0028-0036.md` | [revision-sql-0028-0036.md](revision-sql-0028-0036.md) |
| `servidores-32.md` | [servidores.md](servidores.md) |
