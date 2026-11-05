# Hoja de ruta: de la 3.0.10 en adelante

> **Alcance actualizado (4.6.0, publicada):** se retiraron del launcher Clanes, modo streamer con OBS, Extensiones, el visor de semillas, Competir (rankings, desafíos y calendario), la página Herramientas y las capas de Venus; [detalle y datos preservados](retirada-funciones.md). Sus implementaciones y filas de esta hoja se conservan como antecedentes. Lo que se hizo en la 4.6 está en la sección "4.6" al final; lo pendiente, en "Lo que sigue".

Lo que viene después de la 3.0.10, decidido el 3 de noviembre de 2026. Son 73 funciones, originalmente repartidas en cuatro grupos; los grupos históricos 3.2–3.4 se reúnen ahora en la rama 4.5.0. Su implementación no implica publicación ni validación externa completa. Quedaron afuera a propósito: tipografía propia (`.ttf`), CSS propio, generación con IA de skins y de imágenes (tienen costo por uso), servidores 24/7 pagos y modpacks con ingresos para creadores.

Estado: ☐ pendiente · ☑ implementada. En el grupo histórico 3.1 indica entrega publicada; en los grupos 3.2–3.4 indica implementación en la rama 4.5.0, todavía sin publicar. Las filas marcadas "Retirada en la 4.6" ya no existen en el launcher.

**Actualización del 3 de noviembre de 2026:** el dueño eligió 4.5.0 para reunir los grupos originalmente llamados 3.2, 3.3 y 3.4. Las 35 funciones están escritas en esa rama, todavía sin publicar. Las 35 filas se marcan ☑ **IMPLEMENTADAS en rama 4.5.0, sin publicar**. Esa marca no certifica servicios reales, migraciones aplicadas ni pruebas externas. Ver [estado de integración](estado-4.5.0.md) y [documentación permanente](implementacion/README.md).

## 3.1 — Venus Pass y personalización

### Venus Pass (prioridad)

Esto describe el pase por temporadas de la 3.1. En la 4.6 se **reemplazó** por una progresión permanente de 380 niveles por tiempo jugado, sin compra ni ediciones (ver [venus-pass.md](venus-pass.md)).

### Funciones de la 3.1

| # | Función | Estado |
|---|---|---|
| 30 | Venus Pass | ☑ (3.1); en la 4.6 pasó a ser permanente, por tiempo jugado |
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
| 20 | Canción de perfil (30 s, solo para amigos, con denuncia) | ☑ (3.1); en la 4.6 se elige de música libre de Openverse en vez de subirla |
| 21 | Temas de perfil completos | ☑ |
| 22 | Marcos de avatar animados y de temporada | ☑ (3.1); en la 4.6 se reemplazaron por 36 marcos nuevos dibujados con código |
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
| 49 | Caja de herramientas | Retirada en la 4.6 (la página); descansos, resumen y aviso de versión se conservan |
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
| 59 | Rankings entre amigos | Retirada en la 4.6 |
| 60 | Desafíos entre amigos | Retirada en la 4.6 |
| 63 | Calendario de eventos y torneos | Retirada en la 4.6 |
| 64 | Montaje de la semana | ☑ Implementada · 4.5.0 sin publicar |
| 65 | Timelapse de tu mundo | ☑ Implementada · 4.5.0 sin publicar |
| 66 | Subir clips a YouTube o TikTok | ☑ Implementada · 4.5.0 sin publicar |
| 67 | Integración con OBS | Retirada en la 4.6 |
| 69 | Asistente en el overlay | ☑ Implementada · 4.5.0 sin publicar |
| 75 | Reseñas y votos de servidores destacados | ☑ Implementada · 4.5.0 sin publicar |

## 3.4 — Las grandes

| # | Función | Estado |
|---|---|---|
| 31 | Capas de Venus visibles en el juego | Retirada en la 4.6 (mod 1.3.0) |
| 50 | Visor de semillas | Retirada del launcher por decisión del dueño |
| 61 | Clanes | Retirada del launcher por decisión del dueño; Comunidades se mantiene |
| 62 | Comunidades estilo Discord | ☑ Publicada en la 4.6.0 (con roles, permisos por canal, GIFs y bienvenida) |
| 68 | Galería pública de clips | ☑ Implementada · 4.5.0 sin publicar |
| 77 | App para celular | ☑ Implementada · 4.5.0 sin publicar |
| 78 | Extensiones de la comunidad | Retirada del launcher por decisión del dueño |

## Aparte, propuestas como tareas propias

Importar instancias de Prism, Modrinth App y SKLauncher; reporte de errores y telemetría opcional; Electron 45.

## 4.6

Publicada como **4.6.0** (tag `v4.6.0`). Lo que el dueño pidió y quedó hecho:

- **Retiros:** Herramientas (la página), modo streamer y OBS, Extensiones, visor de semillas, Competir, capas que solo ve uno mismo, los marcos y presets de banners anteriores, los GIF propios del banner y la pestaña Minecraft de Logros.
- **Cambios:** Soporte con formularios y cola; voz con respaldo por MQTT, siempre activo; Comunidades (anuncios, reglas, bienvenida y despedida con GIFs de KLIPY y subidos con aprobación, permisos por canal); avatares siempre circulares; música de perfil con Openverse; 36 marcos nuevos; overlay auditado (31 bugs corregidos); logros solo de Venus (189); buscador inteligente con más vocabulario y una IA solo de pago, de a una fuente; Venus Pass por tiempo jugado con 380 niveles; CurseForge que vuelve a cargar con errores claros. La clave de CurseForge no se tocó.
- **Base de datos:** migraciones 0038 a 0043, 0045 y 0047 aplicadas; ver [supabase.md](supabase.md).

## Lo que sigue

- Aplicar la migración **0048** (limpieza de lo retirado) después de publicar la 4.6.0 y borrar desde Storage los buckets `extension-packages` y `profile-audio`.
- Planes de clan (Go, Pro, Max y Ultra) y la limpieza de pagos del Venus Pass (migración 0044): en curso en otra sesión.
- Traducir a los otros 12 idiomas las claves nuevas y limpiar las viejas de los namespaces nuevos o cambiados (`profile`, `pass`, `achievements`, `overlay`, `whatsnew`, Comunidades, Soporte y los demás).
- Sin probar en condiciones reales: el mod 1.3.0 dentro de Minecraft, el overlay sobre el juego con monitores de distinta escala, una llamada de voz por el respaldo entre dos PC con NAT y el permiso "hablar" de Comunidades con audio real.
