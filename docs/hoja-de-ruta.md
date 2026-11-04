# Hoja de ruta: de la 3.0.10 en adelante

Lo que viene después de la 3.0.10, decidido el 3 de noviembre de 2026. Son 73 funciones, originalmente repartidas en cuatro grupos; los grupos históricos 3.2–3.4 se reúnen ahora en la rama 4.5.0. Su implementación no implica publicación ni validación externa completa. Quedaron afuera a propósito: tipografía propia (`.ttf`), CSS propio, generación con IA de skins y de imágenes (tienen costo por uso), servidores 24/7 pagos y modpacks con ingresos para creadores.

Estado: ☐ pendiente · ☑ implementada. En el grupo histórico 3.1 indica entrega publicada; en los grupos 3.2–3.4 indica implementación en la rama 4.5.0, todavía sin publicar.

**Actualización del 3 de noviembre de 2026:** el dueño eligió 4.5.0 para reunir los grupos originalmente llamados 3.2, 3.3 y 3.4. Las 35 funciones están escritas en esa rama, todavía sin publicar. Las 35 filas se marcan ☑ **IMPLEMENTADAS en rama 4.5.0, sin publicar**. Esa marca no certifica servicios reales, migraciones aplicadas ni pruebas externas. Ver [estado de integración](estado-4.5.0.md) y [documentación permanente](implementacion/README.md).

## 3.1 — Venus Pass y personalización

### Venus Pass (prioridad)

Pase de temporada, aparte de la tienda de cosméticos: se compra con Mercado Pago o PayPal, como los planes de IA. Venus Premium no lo incluye, pero da +20 % de XP.

| Edición | Precio | Qué da |
|---|---|---|
| Go | US$ 1,99 | Los premios de la pista premium. |
| Pro | US$ 4,99 | Lo de Go, 10 niveles al instante y el título **Pro**. |
| Max | US$ 6,99 | Lo de Go, 25 niveles al instante, +25 % de XP toda la temporada y el marco animado **Max**. |

- Temporada de 8 semanas, 50 niveles, 150 XP por nivel (7500 XP). Pasar a una edición mejor cuesta la diferencia.
- XP: los Venus Points que ganás en la temporada (premio diario, misiones, logros e invitaciones) valen 1 XP cada uno; jugar da 1 XP por minuto, hasta 120 por día. Nada se calcula en la PC: el servidor cuenta.
- Dos pistas: gratis (puntos y dos cosméticos) y premium (más puntos y seis cosméticos exclusivos de la temporada, que no se venden en la tienda).
- Una devolución quita el pase y los premios premium ya reclamados.
- Administración → Temporadas: fechas, precios, activar y ver ventas.

### Funciones de la 3.1

| # | Función | Estado |
|---|---|---|
| 30 | Venus Pass | ☑ |
| 1 | Inicio armable: mover, ocultar y agrandar bloques | ☑ |
| 2 | Menú lateral a tu gusto: ordenar, ocultar y fijar | ☑ |
| 3 | Looks guardados | ☑ |
| 4 | Editor visual de temas | ☑ |
| 5 | Tema claro, con cambio automático por hora | ☑ |
| 6 | Temas de temporada automáticos | ☑ |
| 8 | Fondos rotativos | ☑ |
| 9 | Partículas sobre el fondo | ☑ |
| 10 | Sonidos de la interfaz | ☑ |
| 11 | Pantalla de inicio propia | ☑ |
| 12 | Cursores personalizados | ☑ |
| 13 | Packs de íconos | ☑ |
| 14 | Botón Jugar personalizable | ☑ |
| 16 | Carátulas de instancia | ☑ |
| 17 | Vista biblioteca | ☑ |
| 18 | Modo mini | ☑ |
| 20 | Canción de perfil (30 s, solo para amigos, con denuncia) | ☑ |
| 21 | Temas de perfil completos | ☑ |
| 22 | Marcos de avatar animados y de temporada | ☑ |
| 23 | Poses y fondos para la skin 3D del perfil | ☑ |
| 24 | Insignias por logros raros | ☑ |
| 25 | Burbujas de chat personalizadas | ☑ |
| 26 | Efecto de entrada en salas de voz | ☑ |
| 27 | Estado con emoji y vencimiento | ☑ |
| 28 | Libro de visitas | ☑ |
| 29 | Regalar cosméticos o puntos | ☑ |
| 34 | Comparar dos instancias | ☑ |
| 35 | Notas y tareas por instancia | ☑ |
| 36 | Etiquetas y favoritos | ☑ |
| 37 | Accesos directos en el escritorio | ☑ |
| 39 | Aviso de versión nueva de Minecraft | ☑ |
| 42 | Descargas programadas | ☑ |
| 43 | Recordatorio de descansos y tope de horas | ☑ |
| 47 | Widget de FPS, ping y RAM en el overlay | ☑ |
| 49 | Caja de herramientas | ☑ |
| 53 | Resumen al cerrar el juego | ☑ |
| 54 | GIFs de KLIPY en Mensajes | ☑ |

## 3.2 — Instancias y juego

| # | Función | Estado |
|---|---|---|
| 7 | Fondo, color y música por instancia | ☑ Implementada · 4.5.0 sin publicar |
| 32 | Ajustes compartidos entre instancias | ☑ Implementada · 4.5.0 sin publicar |
| 33 | Sets de mods | ☑ Implementada · 4.5.0 sin publicar |
| 38 | Links `venus://` | ☑ Implementada · 4.5.0 sin publicar |
| 40 | Copias automáticas de mundos | ☑ Implementada · 4.5.0 sin publicar |
| 41 | Historial de rendimiento | ☑ Implementada · 4.5.0 sin publicar |
| 44 | Modo familia | ☑ Implementada · 4.5.0 sin publicar |
| 45 | Llevar todo a otra PC | ☑ Implementada · 4.5.0 sin publicar |
| 46 | Sincronizar ajustes y temas entre PCs | ☑ Implementada · 4.5.0 sin publicar |
| 48 | Recetas y wiki en el overlay | ☑ Implementada · 4.5.0 sin publicar |
| 51 | Marcadores en el Mapa del mundo | ☑ Implementada · 4.5.0 sin publicar |
| 52 | Contadores en pantalla | ☑ Implementada · 4.5.0 sin publicar |
| 56 | Traducción automática de mensajes (con el plan de IA del usuario) | ☑ Implementada · 4.5.0 sin publicar |
| 72 | Changelog explicado por IA (con el plan de IA del usuario) | ☑ Implementada · 4.5.0 sin publicar |
| 73 | Control remoto del servidor local desde el celular | ☑ Implementada · 4.5.0 sin publicar |
| 74 | Avisos del servidor por Discord | ☑ Implementada · 4.5.0 sin publicar |

## 3.3 — Social y clips

| # | Función | Estado |
|---|---|---|
| 55 | Stickers y emojis propios | ☑ Implementada · 4.5.0 sin publicar |
| 57 | Soundboard en Voice Chat | ☑ Implementada · 4.5.0 sin publicar |
| 58 | Efectos de voz | ☑ Implementada · 4.5.0 sin publicar |
| 59 | Rankings entre amigos | ☑ Implementada · 4.5.0 sin publicar |
| 60 | Desafíos entre amigos | ☑ Implementada · 4.5.0 sin publicar |
| 63 | Calendario de eventos y torneos | ☑ Implementada · 4.5.0 sin publicar |
| 64 | Montaje de la semana | ☑ Implementada · 4.5.0 sin publicar |
| 65 | Timelapse de tu mundo | ☑ Implementada · 4.5.0 sin publicar |
| 66 | Subir clips a YouTube o TikTok | ☑ Implementada · 4.5.0 sin publicar |
| 67 | Integración con OBS | ☑ Implementada · 4.5.0 sin publicar |
| 69 | Asistente en el overlay | ☑ Implementada · 4.5.0 sin publicar |
| 75 | Reseñas y votos de servidores destacados | ☑ Implementada · 4.5.0 sin publicar |

## 3.4 — Las grandes

| # | Función | Estado |
|---|---|---|
| 31 | Capas de Venus visibles en el juego | ☑ Implementada · 4.5.0 sin publicar |
| 50 | Visor de semillas | ☑ Implementada · 4.5.0 sin publicar |
| 61 | Clanes | ☑ Implementada · 4.5.0 sin publicar |
| 62 | Comunidades estilo Discord | ☑ Implementada · 4.5.0 sin publicar |
| 68 | Galería pública de clips | ☑ Implementada · 4.5.0 sin publicar |
| 77 | App para celular | ☑ Implementada · 4.5.0 sin publicar |
| 78 | Extensiones de la comunidad | ☑ Implementada · 4.5.0 sin publicar |

## Aparte, propuestas como tareas propias

Importar instancias de Prism, Modrinth App y SKLauncher; reporte de errores y telemetría opcional; Electron 45.
