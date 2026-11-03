# Guía de Venus Launcher

Todo lo que podés hacer con Venus Launcher, función por función: cómo se usa y qué necesita. Después de los primeros pasos, las funciones siguen el orden del menú de la izquierda (**Jugar**, **Contenido**, **En línea** y **Herramientas**); al final están el **Asistente IA**, las herramientas de cada instancia, los **Ajustes** (el engranaje de abajo a la izquierda) y los atajos.

**Qué necesita cada cosa.** La mayoría de las funciones andan solas. Algunas piden algo más, y lo vas a ver indicado así:

- **Cuenta de Minecraft**: para jugar. Puede ser de Microsoft (con Minecraft: Java Edition) o una cuenta sin conexión (para jugar solo, en LAN o en servidores con `online-mode=false`).
- **Cuenta de Venus**: amigos, mensajes, Voice Chat, compartir modpacks y la nube. Es gratis y se crea en **Ajustes → Cuenta y nube**. No hay nada que configurar: si el servicio no responde, el launcher te avisa y podés probar más tarde.
- **IA**: el Asistente y las funciones con inteligencia artificial. Funciona con tu cuenta de Venus y un plan de **Venus IA** (desde Go, US$ 3,50 por mes), que elegís y pagás en **Ajustes → Plan**.
- **Otras apps**: la app de escritorio de Discord (Rich Presence).

Java no hace falta: Venus descarga solo el Java que pide cada versión de Minecraft.

## Primeros pasos

### Bienvenida

La primera vez que abrís el launcher te guía en 8 pasos: idioma, cuenta de Minecraft, cuenta de Venus (opcional), tu primera instancia (combinaciones recomendadas o a tu gusto), contenido extra (rendimiento, shaders, minimapa y más), rendimiento (memoria automática o manual y modo para PC de pocos recursos), preferencias y un resumen. Con **Enter** avanzás y con **Escape** volvés. Al terminar, la instancia se instala en segundo plano y ya podés usar el launcher. Si en la PC está el launcher oficial de Minecraft con perfiles que agregaste o usaste, o con mundos, el paso de la primera instancia te muestra **¿Venís del launcher oficial? Traé tus mundos y perfiles**: con **Importar** traés tus perfiles, mundos y mods (se copian, no se mueven; ver [Importar desde el launcher oficial](#importar-desde-el-launcher-oficial)) y después elegís con cuál empezar.

### Cuentas de Minecraft

Tocá tu cuenta abajo a la izquierda (o andá a **Ajustes → Cuenta y nube**). **Iniciar sesión con Microsoft** abre la ventana de Microsoft y comprueba que la cuenta tenga Minecraft: Java Edition. Para una cuenta sin conexión, escribí un nombre y tocá **Agregar**. Podés tener varias y elegir con cuál jugar. Si la sesión de una cuenta de Microsoft vence, la cuenta aparece marcada para que vuelvas a iniciar sesión. Si no podés iniciar sesión, debajo del botón Venus te dice si es tu conexión o un servicio caído (ver [Estado de los servicios](#estado-de-los-servicios)).

### Cuenta de Venus

En **Ajustes → Cuenta y nube → Cuenta de Venus** creá tu cuenta con un nombre de usuario, email y contraseña. Si el servidor pide confirmar el email, te llega un código: escribilo en el launcher. Ahí mismo ves tu **código de amigo** (`VENUS-XXXXXX`), cambiás tu nombre visible o la contraseña, y si te olvidaste la contraseña tocá **¿Olvidaste tu contraseña?** para recibir un código.

## Jugar

### Inicio

Tu instancia elegida con el botón **JUGAR**. Mientras jugás se convierte en **DETENER** y muestra el tiempo de juego y dónde estás (mundo o servidor); mientras se prepara, muestra el progreso. Con el selector de arriba cambiás de instancia.

Debajo hay accesos rápidos y bloques que se ocultan solos si no tienen datos: **Continuar donde quedaste** (entra directo a tus últimos mundos), servidores destacados con su ping, tus capturas, novedades de Minecraft, **Tu servidor** (el que configures en Apariencia), amigos en línea con botón para unirte, tu actividad de la semana y consejos. Con **Personalizar inicio** elegís qué bloques ver.

- Necesita: cuenta de Minecraft para jugar. Los amigos en línea necesitan cuenta de Venus.

### Venus

La web de Venus dentro del launcher, en el menú después de Inicio. Tiene cuatro pestañas:

- **Inicio**: la cuenta regresiva hasta el lanzamiento oficial (domingo 8 de noviembre de 2026, 00:00 de Argentina), los botones del Discord, el sitio web y GitHub, accesos a cada función del launcher y las novedades de cada versión.
- **Fondos**: los 99 fondos de Venus (16 animados) con filtros y búsqueda. Tocás uno, lo ves en grande y con **Usar de fondo** queda como fondo del launcher. **Descargar** abre ese fondo en la galería web.
- **Venus IA**: qué hace el asistente y los planes, con el mismo panel de compra de Ajustes → Plan.
- **Preguntas**: las preguntas frecuentes y los accesos a Soporte y al Discord.

- Necesita: nada. Los fondos vienen con el launcher; los botones abren el navegador.

### Venus en el juego

Cada vez que abrís una instancia de la 1.13 en adelante, el launcher activa el resource pack **Venus Launcher**: la pantalla de carga muestra el logo de Venus en lugar del de Mojang Studios, debajo del logo de Minecraft dice "Venus Launcher" (donde decía "Java Edition") y aparecen frases de Venus en el menú, mezcladas con las del juego y en el idioma del launcher. Va con la prioridad más baja: si activás otro resource pack que cambia lo mismo, gana el tuyo.

Con el juego abierto, la ventana lleva el ícono de Venus y "· Venus Launcher" al final del título.

- Se apaga en **Ajustes → General → Al jugar → Venus en el juego** (las dos cosas por separado); el cambio se aplica la próxima vez que abrís el juego.
- Las imágenes salen de `scripts/make-ingame-assets.py`.

#### Insignia de Venus

Con **Ajustes → General → Venus en el juego → Insignia de Venus junto a tu nombre** (apagada por defecto), los jugadores que también usan Venus ven el planeta de Venus antes de tu nombre, sobre la cabeza y en la lista de jugadores (Tab), y vos lo ves junto al de ellos. Sirve en cualquier servidor premium, sin plugins.

- Antes de jugar, el launcher instala el mod **Venus Badge** en las instancias **Fabric o Quilt de Minecraft 1.20.1, 1.21 y 1.21.1, NeoForge 1.21 y 1.21.1 y Forge 1.20.1**. En vanilla, OptiFine y otras versiones no se instala nada y la insignia no se ve. Si cambiás el loader o la versión de la instancia, el launcher pone el mod que corresponde o lo quita solo.
- Pide tu **cuenta de Venus** y una **cuenta de Microsoft**: al prenderla (y al jugar, si todavía no estaba) el launcher verifica con Mojang que la cuenta de Minecraft es tuya y la anota en el servidor de Venus. Las cuentas sin conexión no pueden tener insignia. Hasta 5 cuentas de Minecraft por cuenta de Venus.
- Debajo del interruptor se ve el estado: verificando, listo con el nombre de la cuenta o qué falta (iniciar sesión, cuenta sin multijugador, sin conexión…).
- Al apagarla se borran tus cuentas del servidor y el mod sale de las instancias la próxima vez que jugás. Si lo desactivás a mano en la lista de mods de una instancia, el launcher lo respeta.
- **Estilos de la insignia**: con Venus Premium se ve **dorada**; en la tienda de Venus Points se compran **Nebulosa** y **Hielo** (se equipan en Venus Points o en Mi perfil).
- El mod no se exporta en los modpacks. Cómo funciona por dentro, qué se manda y cómo se despliega: [insignia.md](insignia.md).

### Overlay en el juego

Mientras jugás, Venus muestra encima del juego quién habla en el Voice Chat y quién está silenciado, los mensajes que te llegan, avisos (del launcher, de amigos, de tus servidores, logros y Venus Points), capturas, clips y grabación, y la canción que suena.

- En **Ajustes → En el juego** activás cada widget, elegís su lugar en una grilla de 3×3 o lo arrastrás a donde quieras (en la vista previa o con **Editar posiciones en el juego**), y cambiás su tamaño, opacidad y tema (oscuro, claro o acento). Podés ocultar el texto de los mensajes (solo se ve quién escribió) y elegir qué avisos ver.
- **Alt+Shift+O** (se puede cambiar) lo muestra u oculta mientras jugás. **Probar overlay** manda avisos de ejemplo.
- Anda con cualquier versión y loader. En pantalla completa exclusiva puede no verse: jugá en ventana maximizada o sin bordes. Detalles: [overlay.md](overlay.md).

### Versiones e instancias

Una **instancia** es una instalación independiente de Minecraft, con su versión, su loader y sus propios mods, mundos y ajustes.

- **Instalar nueva**: elegí cualquier versión (releases, snapshots, bromas del 1 de abril, beta, alpha y versiones antiguas hasta la pre-classic) y un loader: Vanilla, Fabric, Quilt, Forge, NeoForge, OptiFine, Iris (Fabric + Iris + Sodium), Legacy Fabric o Babric. La instalación sigue en segundo plano y la ves en el panel de tareas.
- **Mis instancias**: en cuadrícula o lista, con búsqueda, orden (jugadas hace poco, nombre, versión o tiempo jugado) y agrupadas por loader. Desde el menú de cada una podés renombrarla, duplicarla, repararla o eliminarla (va a la papelera).
- **Importar**: modpacks de Modrinth (`.mrpack`), modpacks de otros launchers (CurseForge, MultiMC, Prism), **Usar código** para un modpack que te compartieron (`PACK-XXXXXX`) o **Del launcher oficial de Minecraft** (ver [Importar desde el launcher oficial](#importar-desde-el-launcher-oficial)). También podés arrastrar el archivo a la ventana.

La página de cada instancia tiene las pestañas **Resumen** (tiempo jugado, espacio en disco y las herramientas de la instancia), **Contenido** (mods, resource packs, shaders y data packs de cada mundo, con interruptores para activarlos y botón para agregar más), **Mundos** (jugar directo o ver el mapa), **Capturas**, **Registros** (la consola en vivo y los archivos de registro) y **Ajustes** (memoria, Java, ventana y **Optimizar**). Las herramientas del Resumen se explican en [Herramientas de cada instancia](#herramientas-de-cada-instancia).

Si la instancia ya se verificó hace poco y no cambió nada, arranca rápido sin revisar todo por internet. **Reparar** revisa todos los archivos.

### Importar desde el launcher oficial

En **Versiones → Importar → Del launcher oficial de Minecraft** (o desde la bienvenida) traés a Venus lo que tenías en el launcher oficial. Venus lee tu carpeta `.minecraft`, con los perfiles del launcher oficial y los del launcher de la Microsoft Store o la app de Xbox (marcados **Microsoft Store**); si la carpeta está en otro lado, tocá **Elegir otra carpeta**. Te muestra:

- **Perfiles**: cada uno con su versión, su loader (Vanilla, Fabric, Quilt, Forge, NeoForge, OptiFine, Legacy Fabric o Babric) y cuándo lo usaste. Cada perfil que marcás se convierte en una instancia nueva (si ya tenés una con ese nombre, queda «Nombre (2)»). **Última versión** usa la más nueva entre la lista de versiones de Mojang y las que ya instaló el launcher oficial. Los que no se pueden traer dicen por qué (LiteLoader, LabyMod, Lunar Client y otros clientes, o una versión desconocida, como la copia renombrada de una versión) y los que ya importaste aparecen como **Ya importado**.
- **Contenido** de cada carpeta: mundos (todos, o algunos con **Elegir mundos**), mods, paquetes de recursos, shaders, configuración de mods, opciones del juego y la lista de servidores, con cantidades y tamaños. Si varios perfiles comparten la carpeta (lo normal en el launcher oficial), su contenido se copia una sola vez, a la instancia que elijas en **Va a**: por defecto, la del perfil que usaste hace menos tiempo o, si la carpeta tiene mods, la del más reciente con mods. Los mods y su configuración solo van a perfiles con Fabric, Quilt, Forge, NeoForge, Legacy Fabric o Babric. Un perfil con carpeta propia trae lo suyo; si esa carpeta ya no existe o no se puede usar (está en la red, es del sistema o está dentro de Venus), te lo avisa y se importa sin su contenido.

La copia sigue en segundo plano, con progreso y **Cancelar importación**. Antes revisa que haya lugar en el disco y que Minecraft no esté abierto desde esa carpeta (un mundo abierto aparece como **Abierto**: cerralo antes de importar). Si algo falla o cancelás, no queda ninguna instancia a medias. El launcher oficial queda como estaba: no se importan cuentas, contraseñas ni argumentos de Java, y los accesos directos (enlaces y uniones) se saltean y se avisan. Minecraft y el loader se descargan la primera vez que jugás cada instancia.

- Necesita: nada. No usa internet, salvo para bajar la lista de versiones de Mojang si ni Venus ni el launcher oficial la tienen guardada.

### Mundos

Todos los mundos de todas tus instancias en una grilla, con filtros. La ficha de cada mundo trae **Jugar** (entra directo al mundo en 1.20 o más nuevo), **Mapa**, **Respaldar**, **Copiar a…** (otra instancia o un servidor local), **Instantánea**, **Nube**, **Renombrar**, **Carpeta** y **Borrar** (a la papelera), y las pestañas:

- **Historia**: tus partidas día por día con los logros que conseguiste y las capturas de cada partida. Lo jugado antes de usar Venus aparece como "partida estimada".
- **Capturas y clips**, **Estadísticas** (bloques, criaturas, logros) y **Datos y copias** (semilla, modo, dificultad y copias de seguridad para restaurar).

La pestaña **Capturas y clips** de la página junta todas tus capturas y clips, con un visor a pantalla completa. Podés **compartir** una captura o un clip con un link que dura un año (y dejar de compartirlo cuando quieras).

- Necesita: compartir capturas y clips necesita cuenta de Venus. Renombrar, borrar o restaurar un mundo no se puede mientras está abierto en el juego.

### Mapa del mundo

Desde **Mapa** (en Mundos o en la pestaña Mundos de una instancia) ves el mapa desde arriba: arrastrá para moverte, usá la rueda para acercar, elegí la dimensión (Superficie, Nether, End o las de mods y data packs), mirá las coordenadas del bloque bajo el cursor (clic para copiarlas), la aparición y los jugadores. **Renderizar todo** dibuja el mundo completo y podés **exportar la vista como PNG**. Funciona con mundos de la 1.2 en adelante; los más viejos se indican como no compatibles.

### Skins

En **Skins** (menú Jugar) mirás tu skin en 3D, explorás el catálogo, guardás las tuyas en una biblioteca y cambiás la skin y la capa de tu cuenta de Minecraft con la API oficial de Mojang.

**Catálogo de skins.** La pestaña **Catálogo** trae las 4.311 skins incluidas con el launcher (Estéticas, Kawaii y Lindas) y funciona sin conexión. Podés buscar por nombre, estilo o color (sin importar tildes ni mayúsculas), filtrar por categoría, por modelo (Clásico o Slim) y por tus favoritas, y cargar de a 48. Al elegir una la ves en 3D de frente y de espalda, y podés usarla en tu cuenta de Microsoft (con la misma confirmación y copia de seguridad que las de tu biblioteca), guardarla en Mi biblioteca, exportarla como PNG o marcarla con la estrella. Si los brazos se ven raros, probá el otro modelo antes de usarla. La pestaña, los filtros y la skin elegida se recuerdan mientras el launcher está abierto.

- **Vista previa en 3D**: arrastrá para girar al personaje o usá las flechas del teclado (**Inicio**: de frente, **Fin**: de espalda); también están los botones **Frente**, **Espalda** y para girar. Se ve como en el juego: brazos clásicos o finos, las skins viejas de 64×32 convertidas como lo hace Minecraft y la capa que tenés puesta (la podés ocultar en la vista previa). Con movimiento reducido no se anima; si no, un botón pausa la animación.
- **Mi biblioteca**: con **Agregar skin** (o soltando archivos PNG en la página) se guarda una copia de tus skins: PNG de 64×64 o 64×32 de hasta 64 KB, hasta 20 por vez y 100 en total. Las repetidas no se agregan dos veces. El modelo (**Clásico** o **Slim**) se adivina por los brazos y se puede cambiar. Cada skin se puede renombrar, exportar como PNG o borrar (va a la papelera).
- **Usar en mi cuenta**: sube la skin elegida a tu cuenta de Microsoft. **Volver a la skin por defecto** deja una de las skins por defecto de Minecraft. En los dos casos, si tu skin actual no está en la biblioteca, antes te ofrece guardar una copia. **Guardar en mi biblioteca** guarda la que tenés puesta.
- **Capa**: elegí cuál de las capas de tu cuenta se ve, o **Sin capa**.
- Para cambiar la skin o la capa, primero tiene que cargarse tu perfil de Minecraft; si no carga, tocá **Reintentar**. Los cambios se ven en el juego la próxima vez que entres a un mundo o a un servidor.
- Necesita: nada para la vista previa y la biblioteca, que funcionan sin internet (también con una cuenta sin conexión o sin cuenta). Para cambiar la skin o la capa, una cuenta de Microsoft con Minecraft: Java Edition; si la sesión venció, la página te ofrece volver a iniciar sesión. Con el modo sin conexión activado (**Ajustes → Descargas y almacenamiento**) no se conecta a nada.

### Editor de skins

En **Skins → Editor de skins** creás una skin de 64×64 (clásica o slim) desde cero o desde una de tu biblioteca: lápiz, goma, balde, cuentagotas, espejo izquierda/derecha, capa base y capa exterior, paleta y selector de color, zoom, deshacer y rehacer (Ctrl+Z / Ctrl+Y), plantilla con las zonas marcadas y vista 3D en vivo. Al guardarla queda en tu biblioteca, lista para usar en tu cuenta. Ver [temas.md](temas.md).

### Clips y capturas

**Clips y capturas** (menú Jugar) junta las capturas, clips y grabaciones de todas tus instancias, con filtros por instancia y fecha, búsqueda y un visor que se maneja con el teclado (borrar va a la papelera).

- Con el juego abierto: **Alt+Shift+F12** saca una captura de la ventana del juego, **Alt+Shift+F9** empieza y termina una grabación y, si prendés la **repetición instantánea** en **Ajustes → En el juego**, **Alt+Shift+F8** guarda los últimos 60 segundos (5 minutos con Venus Premium), que mientras jugás ocupan lugar en el disco y no memoria. Los atajos, la calidad (720p, 1080p o nativa), los cuadros por segundo y el audio se cambian ahí.
- **Clips automáticos** (apagados por defecto, en el mismo lugar): con la repetición prendida, el clip se guarda solo al morir, al conseguir un logro o al derrotar al Ender Dragon, solo lo que le pasa a tu cuenta y con una espera entre clips y un máximo por partida para no llenar el disco. La página **Clips** los muestra con su etiqueta (Muerte, Logro, Jefe) y los filtra. Se detectan leyendo los mensajes del juego en cualquier idioma; de los jefes, sin mods solo se reconoce el Ender Dragon la primera vez en cada mundo (detalle en [clips.md](clips.md#clips-automáticos)).
- **Editor**: recortá el inicio y el final y exportá en horizontal o en vertical 9:16 para TikTok y Shorts.
- **Compartir**: link para compartir, **A un amigo** (le llega un aviso con **Ver**) o **Destacar en mi perfil** (hasta 3 capturas).
- **Describir con IA** (opcional, con tu plan de Venus y con confirmación): describe hasta 20 capturas por vez para encontrarlas por lo que muestran.
- Se guardan dentro de cada instancia, en `screenshots/`, `clips/` y `recordings/`, así que también aparecen en Mundos. La repetición instantánea viene apagada (usa CPU y memoria) y solo corre con el juego abierto. Detalles: [clips.md](clips.md).

### Música

En **Música** (menú Jugar) ves lo que suena en Spotify (gratis o Premium), YouTube Music, Apple Music, el navegador o cualquier reproductor que use los controles multimedia de Windows: portada, canción, artista y progreso.

- Pausar, pasar de tema, volver, adelantar o retroceder 10 segundos y cambiar el volumen de esa app en el mezclador de Windows sin tocar el del juego. **Abrir Spotify** lo trae al frente.
- El **mini reproductor** de la barra lateral te deja pausar o pasar de tema desde cualquier página, y con el overlay activo la canción aparece sobre el juego cuando cambia.
- **Atajos dentro del juego** (apagados por defecto, en **Ajustes → En el juego**): Ctrl+Alt+Espacio para pausar y Ctrl+Alt+flechas para cambiar de tema y de volumen; se pueden cambiar.
- Por defecto se controla Spotify si está sonando; podés elegir otro reproductor. Solo Windows 10 (1809 o posterior) y 11; no pide cuenta de Spotify ni conexión. Detalles: [musica.md](musica.md).

### Venus Points y Premium

**Venus Points** (menú Jugar) son los puntos de tu cuenta de Venus. Tu saldo se ve abajo en la barra lateral.

- **Premio diario**: 10 puntos por día y 5 más por cada día seguido (hasta 35). Se reclama con un botón.
- **Logros**: tienen su propia sección (ver [Logros y misiones](#logros-y-misiones)). Los de tu PC se reclaman solos.
- **Invitaciones**: compartí tu código `VP-XXXXXX`. Cuando un amigo nuevo lo canjea (en sus primeros 14 días) y verifica su cuenta de Minecraft, vos ganás 500 y tu amigo 200. Sin verificar con Mojang no paga: así no se puede hacer trampa con cuentas falsas.
- **Tienda**: marcos para tu perfil, efectos para tu nombre, estilos de la insignia en el juego y títulos. Se equipan al instante.
- **Venus Premium** (cualquier plan de Venus): puntos x2 en el premio diario y los logros, insignia dorada en el juego, banners animados, efectos de nombre premium, Marco Venus y título Supporter, repetición instantánea de 5 minutos y todo lo del plan (IA). Se ve en **Venus Points → Premium** y en **Ajustes → Plan**.
- Necesita: cuenta de Venus. Reglas completas: [venus-points.md](venus-points.md).

## Contenido

### Modrinth (y CurseForge)

El catálogo completo de mods, modpacks, shaders, resource packs, data packs y plugins, con carga infinita y la cantidad de resultados. Filtrá por categoría, loader, versión de Minecraft, entorno (cliente o servidor), licencia o **Compatible con** una instancia o servidor tuyo. El detalle de cada proyecto trae descripción, galería, versiones con su changelog, dependencias y archivos. Los shaders y resource packs se pueden **Comparar** de a 2 a 4.

Al instalar, el launcher te muestra en qué instancias o servidores es compatible, elige la mejor versión y **revisa la compatibilidad** antes de bajar nada: dependencias que faltan, incompatibilidades conocidas, mods repetidos o desactivados, shaders sin Iris u OptiFine y más. Si está todo bien, te avisa "Compatibilidad verificada"; si no, te muestra qué pasa y te deja usar una versión sugerida, elegir otra, omitir algo o instalar igual. Los modpacks se instalan como instancias nuevas.

- **Por página**: elegí cuántos resultados se piden cada vez (Modrinth: 10, 20, 50 o 100; CurseForge: 10, 20 o 50). Se recuerda para la próxima vez.
- **Más filtros**: frase exacta (las palabras juntas y en ese orden), palabras a excluir, autor, descargas mínimas, actualizado en los últimos N días, solo código abierto, entorno (cliente o servidor) y licencia. Muestra cuántos filtros hay activos, cada uno se quita con su ✕ y **Limpiar filtros** los saca todos; se recuerdan mientras el launcher está abierto y se manejan con el teclado (Tab, Enter, flechas y Escape para cerrar el panel). Modrinth filtra por autor (nombre de usuario exacto), descargas, fecha, código abierto y entorno; la frase y las palabras excluidas (que no las filtra ni Modrinth ni CurseForge) las filtra el launcher revisando los resultados de a tandas hasta llenar la página, así que el total se va completando ("20+ resultados").
- **CurseForge**: con el selector Modrinth | CurseForge buscás e instalás también desde CurseForge, incluidos sus modpacks. Todos los filtros de **Más filtros** los aplica el launcher sobre lo que CurseForge devuelve (sin entorno ni licencia; "solo código abierto" pide que el proyecto enlace su código fuente).
- Necesita: nada. CurseForge viene incluido en el launcher; si tu versión no lo trae, la pestaña te lo avisa y seguís con Modrinth.

### Buscador inteligente

Contá qué querés jugar ("mods de tecnología para jugar con amigos en la 1.20.1", "shaders livianos para una PC lenta") y el buscador arma un kit agrupado por tipo, con el motivo de cada elección, si es compatible y sus dependencias. Elegí la instancia destino, la versión y el loader (o dejalos en automático), y después instalá todo junto en tu instancia (**Instalar todo**), uno por uno o con **Crear instancia nueva con este kit**. Los plugins se instalan en un servidor Paper o Purpur tuyo y los modpacks crean una instancia nueva. Guarda tus últimas búsquedas. **Resultados por tipo** (3, 5, 8 o 12) define cuántas opciones arma el kit de cada tipo y se recuerda para la próxima vez; **Más filtros** suma los mismos criterios del catálogo (frase exacta, palabras a excluir, autor, descargas mínimas, actualizado hace poco, solo código abierto y entorno) y la tarjeta "Entendí" muestra cuáles se aplicaron.

- Necesita: nada. Con IA entiende mejor pedidos complicados y explica cada elección.

## En línea

### Multijugador

- **Destacados**: servidores elegidos (en español y en otros idiomas) con su estado, jugadores y ping en vivo.
- **Mis servidores**: los servidores guardados en cada instancia (la misma lista que ves dentro del juego). Podés agregar, editar y borrar.
- **Amigos jugando**: a qué servidor está conectado cada amigo, para entrar con él.
- **Buscar por IP**: escribí una dirección para ver su MOTD, versión, jugadores y mods.

**Unirme** elige una instancia compatible con el servidor (o te pregunta si hay varias, o te ofrece crear una) y entra directo. **Armar instancia desde un servidor** detecta la versión, el loader y los mods de un servidor con mods (los servidores Forge publican su lista; los de Fabric, Quilt o plugins no) e instala lo que encuentra en Modrinth; lo que falta queda listado con enlaces para buscarlo.

- Necesita: **Amigos jugando** necesita cuenta de Venus.

### Servidores locales

Creá servidores de Minecraft en tu PC: Vanilla, Paper, Purpur, Folia, Spigot, Fabric, Quilt, Forge, NeoForge, Mohist, Youer, Velocity o Waterfall. El asistente de **Crear servidor** tiene tres pasos: el tipo; la versión, el puerto y la memoria; y el mundo y los jugadores (modo de juego, dificultad, semilla...). Al final hay que aceptar el EULA de Minecraft. Cada servidor tiene las pestañas **Consola** (comandos con historial y autocompletado), **Jugadores** (operadores, lista blanca, baneos), **Propiedades** (todas las de `server.properties` explicadas, con editor del MOTD), **Reglas** (gamerules), **Mundo** (importar desde una instancia, copias de seguridad, regenerar, data packs), **Mods y plugins**, **Red** y **Ajustes** (memoria, Java, iniciar con el launcher, reinicio si se cae, reinicios y copias programadas). Los proxies (Velocity y Waterfall) tienen una pestaña **Proxy** que explica cómo conectarlos.

**Jugar en este servidor** abre tu instancia y entra directo. Con **Servidor espejo** (en esta página o en las herramientas de una instancia) creás un servidor con el mismo loader y los mismos mods que una instancia (sin los que son solo de cliente).

- Necesita: aceptar el EULA. La automatización funciona mientras Venus está abierto.

### Jugar con amigos sin abrir puertos

- **Tu mundo de un jugador** (herramienta **Mundo con amigos** de la instancia): con **e4mc** (recomendado, para Fabric, Quilt, Forge o NeoForge desde la 1.17) instalás el mod con un clic y, al abrir el mundo en LAN, recibís un dominio para pasarle a tus amigos. En Vanilla, OptiFine o versiones viejas se usa el **Túnel de Venus**: abrí el mundo en LAN y el launcher crea una dirección pública que lleva a tu partida. Tus amigos entran desde **Multijugador → Agregar servidor** del juego.
- **Tus servidores locales** (pestaña **Red**): túnel público, apertura automática de puertos con UPnP (si tu router lo permite), tus direcciones (LAN, VPN e IP pública, con aviso si tu proveedor usa CGNAT) y una guía para usar playit.gg.
- **Enviar a un amigo** le manda la dirección a un amigo de Venus, que la recibe con un botón **Unirme**.
- Necesita: el túnel usa el servidor de túneles del launcher (bore.pub, salvo que tu versión traiga otro; solo TCP: para la voz de Simple Voice Chat hace falta abrir su puerto UDP con UPnP). Enviar la dirección necesita cuenta de Venus. La primera vez, Windows puede pedir permiso para Java en el firewall.

### Voice Chat

- **Salas**: **Crear sala** te da un código de 6 caracteres; elegí nombre, cupo (de 2 a 8), contraseña opcional y si la ven tus amigos. Para entrar a otra, usá **Unirse con código**. También ves las salas de tus amigos, las tuyas y las recientes.
- **En la sala**: silenciarte o ensordecerte, volumen de cada persona (hasta 200 %), quién está hablando, **pantalla compartida**, un soundboard, chat de la sala y, si sos el anfitrión, moderación (pedir que alguien se silencie, sacar, bloquear o cerrar la sala). Las barritas de cada persona muestran la calidad de la conexión; si con alguien se corta, aparece **Conexión inestable** en el encabezado y Venus baja la calidad y reconecta solo.
- **Audio**: micrófono y salida, filtro de eco, volumen de entrada, detección de voz o **pulsar para hablar** (tecla V por defecto, o los botones laterales del mouse) y atajo global para silenciarte mientras jugás (**Ctrl+Shift+M** por defecto). Si tu versión del launcher trae servidor de voz propio, **Red y privacidad** te deja **Ocultar mi IP** (toda tu voz pasa por el servidor de Venus).
  - **Supresión de ruido**: **Avanzada** usa RNNoise, una red neuronal que corre en tu PC y borra ventiladores, teclado y ruido de fondo (suma unos 30 ms de demora); **Básica** es la del navegador; también se puede apagar. Si la avanzada no carga, se usa la básica sin cortar nada y lo dice en los ajustes.
  - **Umbral de voz**: lo que queda por debajo de la marca no se transmite. Lo ajusta solo o lo elegís vos, mirando el medidor al lado del control.
  - **Prueba de micrófono**: medidor, **Escucharme** y **Grabar y escuchar**, que graba 5 segundos y te los reproduce tal como te escuchan los demás (fuera de una sala).
  - **Nivelar voces**: compensa a quien habla muy bajo o muy fuerte y evita que se sature cuando hablan varios. Se suma al volumen de cada persona y se puede apagar.
  - **Calidad de voz**: Ahorro (40 kbps), Normal (80 kbps) o Alta (128 kbps) por persona. En salas de más de 5 personas el tope baja para no saturar tu subida, y baja solo si la conexión pierde paquetes.
- **Cortes y compatibilidad**: la voz usa Opus en mono con corrección de errores (FEC) y sin mandar datos en silencio (DTX). Se puede entrar a la misma sala con clientes 2.x.
- **En el juego**: instala **Simple Voice Chat** en tus instancias o servidores para tener voz de proximidad dentro de Minecraft.
- Invitá a un amigo desde Mensajes con **Invitar a voz**: si no estás en una sala, se crea una privada.
- Necesita: cuenta de Venus y micrófono. Pulsar para hablar funciona con el launcher en primer plano; dentro del juego usá el atajo global.

### Mensajes y amigos

- **Agregar amigo** con su código `VENUS-XXXXXX` o su nombre de usuario. Las solicitudes llegan a la pestaña **Solicitudes** y el menú te avisa.
- La lista muestra quién está conectado y a qué juega ("Jugando 1.21.1 Fabric · mc.ejemplo.net").
- El chat es en tiempo real: respuestas, reacciones, editar y borrar tus mensajes, emojis, "escribiendo..." y avisos de lectura. Si no hay conexión, los mensajes quedan en cola y se mandan solos.
- Desde el chat: **Unirse** al servidor de tu amigo (con una instancia compatible), **Invitar a voz** y **Ver perfil**.
- **Mi perfil**: banner, estado (en línea, ausente, ocupado o invisible), mensaje de estado, nombre de Minecraft y privacidad. Podés bloquear a alguien y dejar de compartir tu actividad en **Ajustes → Privacidad**.
- Si tu cuenta está silenciada o suspendida por moderación, Mensajes te lo avisa (con la fecha hasta la que dura) y no te deja escribir.
- Necesita: cuenta de Venus.

### Perfiles

**Mi perfil** (en Mensajes, tocando tu cabeza, o **Ajustes → Cuenta y nube → Editar perfil**) abre un editor con vista previa en vivo de tu tarjeta y de cómo se ve tu nombre en la lista de un amigo:

- **Perfil**: pronombres y descripción.
- **Estilo**: degradado de dos colores con ángulo, tipografía del nombre (7), efecto (brillo, degradado, destello, arcoíris o fuego), color y brillo del nombre.
- **Banner**: 8 diseños pixel, tu propia imagen (se recorta y comprime en tu PC), un GIF animado con Premium o el color clásico.
- **Vitrina**: hasta 5 servidores favoritos (tus amigos los ven con **Unirme**), tus estadísticas (si las querés publicar) y hasta 3 capturas destacadas.
- **Cosméticos**: marco, título y estilo de la insignia de la tienda o de Premium. Lo premium que no tenés se ve con un candado que lleva a los planes.
- **Compartir mi perfil** arma una imagen PNG de tu tarjeta para copiar o guardar. Ver [perfiles.md](perfiles.md).

### Grupos para jugar

Tocá **Grupo** en la barra de título (o la tarjeta en **Multijugador → Amigos jugando**), creá un grupo e invitá a tus amigos conectados (hasta 8 personas contándote).

- Como líder elegís una de tus instancias (si está compartida, tus amigos la importan o actualizan con el código) y dónde jugar: un servidor guardado, uno de los favoritos de tu perfil, una dirección o tu propio mundo abierto a amigos.
- Ves quién está listo, podés crear una sala de voz para todos y, con **Jugar todos**, cada uno entra con su instancia (si le falta, el launcher le ofrece importarla o crear una compatible).
- Si el líder se desconecta, el grupo se disuelve con un aviso. Necesita: cuenta de Venus. Ver [grupos.md](grupos.md).

### Avisos

En **Ajustes → Privacidad → Avisos** elegís qué te avisa el launcher:

- Un amigo entra a un servidor (con **Unirme**) o a un mundo: como mucho una vez cada 10 minutos por amigo, y podés silenciar a quien quieras.
- Un servidor favorito vuelve a estar en línea, se llena o se vacía: se revisan cada 5 minutos solo con el launcher abierto. Los favoritos del perfil vienen apagados; los marcás con la campana o los prendés en el panel.
- Mientras jugás, los avisos solo aparecen en el overlay del juego (se puede cambiar).

## Herramientas

### Logros y misiones

Sección **Logros** del menú, con tres pestañas:

- **Logros**: más de 400, agrupados por categoría (tiempo, minería, combate, exploración, vida, colección, capturas, social, Venus y especiales). Cada uno tiene niveles de bronce a netherita con su barra de progreso y sus puntos; se reclaman solos. Con suficientes jugadores se ve también qué tan raro es cada uno. Los que se cumplen a partir de esta PC se reclaman de a 40 por día como mucho: si ya venías jugando, los que falten entran los días siguientes.
- **Misiones**: 3 por día y 3 por semana, distintas para cada cuenta (jugar un rato, sacar capturas, entrar a servidores...). Se reclaman con un botón, y completar las tres da un bono. Cambian a medianoche UTC y los lunes.
- **Minecraft**: los logros (advancements) de cada mundo, por instancia, que antes estaban en Estadísticas.

Podés destacar hasta 6 logros en tu perfil desde **Mi perfil → Vitrina**.

### Estadísticas

Tres pestañas: **Launcher** (tiempo jugado, rachas, calendario, horarios, instancias, versiones y loaders, crashes), **En el juego** (bloques minados, criaturas, distancias y más, por instancia y por mundo), **Mundos y servidores** (dónde jugaste más, con **Jugar** o **Entrar** directo) y **Logros** (hitos del launcher y logros del juego con su progreso). Podés exportar tus sesiones en CSV o todo en JSON. Se actualiza solo mientras jugás.

### Tu resumen de Venus

Una imagen lista para compartir con tus estadísticas: tiempo jugado y partidas, racha, tu instancia favorita (versión, loader y mods), el mundo o servidor donde más jugaste y tu colección (mods, mundos e instancias). Se abre con **Compartir mi resumen**, arriba a la derecha en **Estadísticas** o en la tarjeta **Tu actividad** del Inicio.

- **Período**: **Esta semana** (últimos 7 días), **Este mes** (últimos 30 días) o **Desde siempre**; cada opción muestra cuánto jugaste. Si en ese período no jugaste, te lo avisa y te ofrece ver todo tu historial.
- **Formato**: **Horizontal** (1600 × 900, para Discord y X) o **Vertical** (1080 × 1920, para TikTok e historias).
- **Mostrar mi nombre** suma el nombre de tu cuenta de Minecraft (solo el texto, sin la skin). Viene apagado.
- **Copiar imagen** la deja en el portapapeles para pegarla con **Ctrl+V**; **Guardar PNG** la guarda (por defecto en Imágenes) y te ofrece mostrarla en la carpeta. Recuerda el último período, formato y si mostrar tu nombre.
- Se arma en tu PC con tus estadísticas y los colores de tu tema: no usa internet ni sube nada. Solo aparecen servidores con un dominio público: los que son una IP, de tu red, de túneles (bore, e4mc, playit.gg) o con DNS dinámico no se muestran.

### Rendimiento

La memoria de Minecraft en una sola tarjeta:

- **Automático** (recomendado): Venus decide cuánta RAM darle a cada partida según tu PC, la memoria libre y el tamaño del modpack, y te explica por qué.
- **Manual**: un deslizador con zonas (poco, ideal, demasiado) y la marca de lo recomendado.

En **Opciones avanzadas** están el recolector de Java (explicado en criollo), argumentos extra, prioridad del proceso, tamaño de ventana y qué hace el launcher al iniciar el juego. A la derecha ves **Tu PC** (con una prueba de rendimiento de la CPU) y un monitor en vivo de la RAM y la CPU del juego. **Optimizar una instancia** abre la herramienta Optimizar.

### Estado de los servicios

Cuando no podés iniciar sesión o algo no descarga, Venus te dice si el problema es tu conexión o un servicio caído (Microsoft y Xbox Live, Mojang, Modrinth, CurseForge o el servidor de Venus).

- **Después de un error al iniciar sesión** (en la bienvenida y en el diálogo de cuentas) aparece abajo un aviso corto con un enlace al panel, por ejemplo "Microsoft no responde: esperá unos minutos y probá de nuevo" o "Tu internet no responde: revisá el wifi o el cable". Consulta solo los servicios de inicio de sesión (y, si ninguno contesta, prueba tu conexión). Si el error es de la cuenta (cancelaste, no tiene Minecraft, falta el perfil, Xbox la restringió), no consulta nada; si el error ya muestra que Microsoft falló de su lado (por ejemplo, un error 503), lo dice sin consultar nada.
- **En el panel de tareas**, una descarga o instalación que falló por la red muestra el botón **Ver estado de los servicios**, que abre el panel con el grupo relacionado marcado.
- **El panel completo** está en **Ajustes → Descargas y almacenamiento → Estado de los servicios → Comprobar** y en la paleta de comandos (**Ctrl+K**). Muestra cada servicio con su estado (**Responde**, **Lento** o **No responde**), cuánto tardó y qué hacer. También detecta si falla solo el DNS de tu red, si un antivirus, un proxy o la hora de Windows rompen las conexiones seguras y si tu red bloquea todos los servicios del juego. Si Cloudflare (la prueba neutral de tu conexión) no contesta pero los servicios sí, no culpa a tu conexión. El resultado se reusa 20 segundos y después podés **Volver a comprobar**.
- Con el **modo sin conexión** activado no consulta nada y te ofrece ir a desactivarlo.
- Privacidad: nunca consulta en segundo plano, solo cuando abrís el panel o justo después de un error al iniciar sesión. Hace un pedido corto a cada servicio, sin datos tuyos.

## Asistente IA

Abrilo desde el menú, con el botón **Asistente** de la barra de título o con **Ctrl+J** (se abre como panel lateral). Preguntale lo que quieras sobre Minecraft o tus instancias: "¿por qué crashea mi modpack?", "instalame Sodium y Iris en mi 1.21.1", "dale más RAM a esta instancia".

- Puede leer tus instancias, mods, specs de la PC y crashes, buscar mods, shaders y resource packs, y hacer cambios: crear instancias, instalar, actualizar, activar o quitar mods, cambiar la RAM, opciones del juego, la versión de Java o de Minecraft.
- Cada cambio aparece como una tarjeta, y los que se pueden revertir traen **Deshacer**. Quitar un mod (va a la papelera), instalar muchos de una vez o bajar de versión una instancia con mundos te piden confirmación antes. **Detener** corta la respuesta.
- No puede tocar tu cuenta ni tus contraseñas, borrar mundos, ejecutar comandos ni descargar de sitios que no sean Modrinth o CurseForge. El panel **Qué puede hacer / Qué no puede hacer** lo explica.
- Las conversaciones quedan guardadas y podés elegir la instancia sobre la que habla.
- Abajo del chat elegís el **modelo** (Haiku, Sonnet u Opus, según tu plan) y el **esfuerzo**, y ves cuántas preguntas te quedan hoy y en la semana con ese modelo y el presupuesto del mes. Si alguna vez responde el servicio de respaldo, la respuesta lo indica ("Respondió el respaldo (OpenAI)").

Otras funciones con IA: **Explicar con IA** en el diagnóstico de crashes, el **Buscador inteligente** y **Traducir mods**.

**Claude y ChatGPT (MCP)**: con un plan pago podés usar las herramientas del asistente desde Claude Desktop, Claude Code, ChatGPT o claude.ai, con la IA de tu propia cuenta (no gasta tu cuota de Venus IA). Se activa en **Ajustes → Inteligencia artificial → Claude y ChatGPT**; guía completa: [mcp.md](mcp.md).

**Tu Claude y tu ChatGPT en el Asistente** (al revés: tu app presta la IA): si tenés **Claude Code** o **Codex** instalados con tu cuenta, el asistente puede responder con ellos desde la ventana de Venus. Gastan los límites de tu plan de Claude o de ChatGPT (no tu cuota de Venus IA) y usan las mismas herramientas y protecciones; con Claude Code ves junto al modelo cuánto llevás usado de la ventana de 5 h y de la semana. Elegilo con el selector **Responde** antes de la primera pregunta de un chat, o por defecto en **Ajustes → Inteligencia artificial → Tu Claude y tu ChatGPT en el Asistente**. No hay que configurar nada en Claude ni en Codex. Desde el plan Go.

**Servidores MCP del asistente** (al revés: el Asistente usando otros servicios): en **Ajustes → Inteligencia artificial → Servidores MCP del asistente** podés agregar servidores MCP remotos (una URL `https://` y, si hace falta, un token) o locales (un programa de tu PC: comando, argumentos y variables), o importar los que ya usás en Claude Desktop. Sus herramientas aparecen en el chat con el nombre del servidor; cada una te pide permiso antes de usarse, salvo las de solo lectura o las que marques **Permitir siempre**. Funciona con cualquier modelo de tu plan (desde Go). Los servidores locales ejecutan programas en tu PC: agregá solo los que conocés.

- Necesita: IA (cuenta de Venus y un plan). Los planes **Go, Pro, Super, Ultra, Max y Supreme** (de US$ 3,50 a 42,50 por mes) cambian los modelos, las preguntas por día y por semana y el presupuesto; los comparás y pagás en **Ajustes → Plan** (el pago se hace en Stripe, en tu navegador).

## Herramientas de cada instancia

Están en la pestaña **Resumen** de cada instancia, en **Herramientas**. Algunas aparecen solo si la instancia tiene mods o viene de un modpack.

### Instantáneas

Guardan el estado de la instancia (mods, configuraciones, opciones y, si querés, mundos) para volver atrás si algo se rompe. Ocupan poco: solo se guarda lo que cambió. **Restaurar** te muestra antes qué va a cambiar y guarda una instantánea "Antes de restaurar" para deshacerlo. Podés fijar, renombrar y borrar instantáneas. Por defecto se hace una automática antes de jugar (solo mods y configuraciones, y solo si algo cambió). De las automáticas quedan las últimas 10 y se borran las de más de 30 días (siempre quedan al menos las 2 más nuevas); las manuales y las fijadas nunca se borran solas. Todo eso se cambia en el mismo diálogo.

### Exportar y actualizar modpacks

- **Exportar modpack**: como `.mrpack` (Modrinth) o `.zip` de Prism/MultiMC, eligiendo qué incluir (mods, configuraciones, resource packs, shaders, opciones y mundos).
- **Actualizar modpack** (instancias de un modpack de Modrinth): elegí la versión nueva y mirá antes qué mods se agregan, se quitan o se actualizan, con avisos de riesgo (cambio de versión de Minecraft, mods de contenido quitados, changelogs que piden respaldar el mundo). Antes de actualizar se hace una instantánea, y se respetan los mods que agregaste a mano y tus configuraciones.

### Compartir

"Pasame tu setup": **Compartir** crea un código `PACK-XXXXXX` para que un amigo arme una instancia idéntica. Solo viaja la lista de mods (se bajan de Modrinth o CurseForge) y las configuraciones de texto chicas, nunca tus archivos; lo que no está en esas páginas queda listado para conseguirlo a mano. Como **grupo**, cada vez que publicás una revisión los miembros la reciben solos (al abrir el launcher, cada 15 minutos y al cerrar el juego), respetando los mods propios de cada uno. Tu amigo lo importa con **Versiones → Importar → Usar código**, pegando el código con **Ctrl+V** en cualquier parte del launcher o desde la invitación que le mandás.

- Necesita: cuenta de Venus (los dos).

### Sincronizar en la nube

Copias de tus mundos y configuraciones en tu cuenta de Venus, para seguir jugando en otra PC. Con la sincronización automática, el mundo se sube al cerrar el juego y lo que cambió en otra PC se baja al abrir el launcher. Si hay cambios en los dos lados, te pregunta qué copia conservar; el mundo anterior va a la papelera.

- Necesita: cuenta de Venus. Hay 2 GB por usuario y cada mundo puede pesar hasta 3,5 GB.

### Mundo con amigos

Abre tu mundo de un jugador por internet: ver [Jugar con amigos sin abrir puertos](#jugar-con-amigos-sin-abrir-puertos).

### Crear servidor espejo

Crea un servidor local con el mismo loader y los mismos mods que la instancia (sin los que son solo de cliente) y, si querés, uno de sus mundos.

### Buscar actualizaciones

Lista las actualizaciones de mods, resource packs y shaders con el changelog resumido, el tamaño y avisos de riesgo (versión mayor, beta, "mundo nuevo", cambios grandes). Elegí cuáles aplicar: se descargan, se verifican y el `.jar` viejo queda en el **Historial**, desde donde podés volver atrás mod por mod. Con **Incluir versiones de prueba** también ves betas y alfas.

### Análisis de seguridad

Revisa cada mod en busca de malware conocido (como Fractureiser) y de comportamientos peligrosos (robo de cuentas o tokens, descargas de código, webhooks de Discord), comprueba si el archivo es el oficial de Modrinth (o de CurseForge, si tu versión del launcher lo incluye) y busca rastros de malware en la PC. Lo sospechoso se puede mandar a **cuarentena** y restaurar después. Antes de jugar, el launcher te avisa de los riesgos altos y solo frena el juego si hay malware confirmado. También funciona con los servidores locales.

### Informe de mixins

Busca choques entre mods que modifican el mismo código del juego (por ejemplo, dos mods que reemplazan el mismo método) y explica cada uno en lenguaje simple. Antes de jugar te avisa de los choques graves.

### Traducir mods

Traduce al idioma que elijas los textos de los mods que no vienen traducidos. Primero reutiliza traducciones oficiales parecidas (por ejemplo, la de México para el español de Argentina) y las que ya tradujo antes; lo que falta lo traduce la IA, cuidando los códigos de formato. El resultado es un resource pack (`venus-auto-translations`) que se activa solo. En **Revisar y corregir** podés editar cada texto, y en **Compartir** exportar o importar traducciones. Si el juego está abierto, reinicialo o recargá los recursos con **F3 + T**.

- Necesita: IA para traducir textos nuevos (sin IA solo se reutilizan las traducciones que ya existen).

### Optimizar

Mira tu PC y la instancia, y te propone: memoria, recolector de Java, mods de rendimiento verificados (con el motivo de cada uno) y opciones de video (actuales y nuevas). Tildá lo que quieras aplicar. Tiene un **modo PC de pocos recursos** y una pestaña **Packs de contenido** (rendimiento, shaders, minimapa, calidad de vida, PvP, control, chat de voz y multijugador).

### Diagnóstico de crashes

Cuando el juego se cierra con un error, aparece solo un diálogo que explica en lenguaje simple qué pasó ("Falta Fabric API", "Hace falta Java 21", "Subile la RAM a 3 GB"...) con botones que lo arreglan: instalar la dependencia, desactivar un mod, cambiar la memoria o el Java, restablecer una configuración (con copia), actualizar el loader, abrir las instantáneas y más. **Explicar con IA** da una explicación más detallada (necesita IA).

Si no se sabe qué mod lo causa, **Buscar el culpable** prueba activando y desactivando mods por mitades (respetando las dependencias) hasta encontrarlo. En modo automático el launcher abre y cierra el juego solo (sirve para crashes al arrancar); en modo manual vos contestás si el problema sigue. Se puede cancelar cuando quieras y al final todo queda como estaba. También se abre desde la herramienta **Diagnóstico de crashes**.

## Ajustes

El engranaje de abajo a la izquierda. Cada sección tiene su enlace directo (por ejemplo, desde otros lugares del launcher te lleva directo a "Cuenta y nube" o a "Inteligencia artificial").

- **General**: idioma (14, se cambia al instante), qué hace el launcher al empezar a jugar (seguir abierto, minimizarse u ocultarse) y abrir la consola al jugar.
- **Apariencia**: temas planetarios (Venus, Marte, Neptuno, Júpiter, Tierra y Saturno) o tu propio color, fondo de la galería (99 fondos, 16 animados), de tu propia imagen o video (con oscurecer y desenfocar) o estrellas, con un botón a la página de fondos, música de fondo que se pausa al jugar o en Voice Chat, y tu marca: logo, nombre y **Tu servidor** (el que aparece en el Inicio), con prueba de conexión. **Temas**: copiá el código de tu tema (`VENUS-THEME:…`, solo colores y fondo; si tu fondo es una imagen de tu PC, el código usa las estrellas), pegá el de otro jugador y probalo antes de usarlo, o elegí uno de la galería de la comunidad (Populares y Nuevos) con tu cuenta de Venus; también podés publicar el tuyo (hasta 10). Se aplica al instante y podés volver al anterior.
- **En el juego**: el overlay (widgets, posiciones, tamaño, opacidad, tema y atajo), la grabación y la repetición instantánea (atajos, calidad, fps y audio) y la música (reproductor elegido, mostrarla en el overlay y atajos).
- **Accesibilidad**: modos para daltonismo con intensidad regulable, alto contraste, tamaño de la interfaz (90 a 130 %), movimiento reducido, foco siempre visible, símbolos en los estados y navegación con control (ver [Atajos y control](#atajos-y-control)). También instala **Controlify** para jugar Minecraft con control.
- **Cuenta y nube**: tus cuentas de Minecraft y tu cuenta de Venus (crearla, iniciar sesión, código de amigo, nombre visible y contraseña) y **Editar perfil**.
- **Privacidad**: compartir o no tu actividad con tus amigos, qué datos quedan en tu PC y cuáles en la nube, **Avisos** de amigos y servidores favoritos, y **Discord Rich Presence**: muestra en tu perfil de Discord si estás en el launcher o jugando (instancia, versión, mundo o servidor, tiempo y hasta 2 botones), sin mostrar nunca direcciones IP. Solo hace falta dejar abierta la app de escritorio de Discord (la web no sirve); **Probar** muestra una actividad de prueba.
- **Modo streamer** (Privacidad, también en **Ctrl+K**): para transmitir o grabar sin mostrar datos de más. Mientras está activado, el launcher difumina tu código de amigo, los códigos de pack y de salas de voz, las IPs y direcciones de servidores y túneles, los nombres de tus amigos y el contenido de los mensajes (en Mensajes, Inicio, Multijugador, Voice Chat y los avisos); el overlay del juego muestra "Un amigo" y "Amigo 1, 2…" en lugar de nombres y tapa los mensajes; y Discord no muestra el mundo ni el servidor. Queda activado hasta que lo apagues y se ve un indicador en la barra de título. No cambia lo que ven tus amigos ni toca el chat de Minecraft.
- **Inteligencia artificial**: estado de la IA, tu plan con las preguntas que te quedan por modelo y el presupuesto del mes, activar o desactivar la IA, **Probar la IA**, la conexión con **Claude y ChatGPT (MCP)**, los **servidores MCP del asistente** y qué se envía.
- **Plan**: tu plan de Venus IA (con aviso si un pago falló o si la suscripción se cancela), las tarjetas de los 6 planes con su precio, modelos y preguntas, **Mejorar plan** (abre el pago de Stripe en tu navegador) y **Administrar suscripción** (cambiar la tarjeta, ver facturas o cancelar), y los beneficios de **Venus Premium**.
- **Java**: el Java que descargó Venus, el que encuentra en tu PC, probar un ejecutable y qué Java usa cada versión de Minecraft.
- **Descargas y almacenamiento**: medidor de descargas en vivo, pausa, límite de velocidad, descargas simultáneas y **modo sin conexión**; **estado de los servicios** (¿es tu conexión o un servicio caído?); uso del disco por categoría; **unificar archivos repetidos** (los mods y packs iguales de varias instancias pasan a ocupar lugar una sola vez, también en automático) y limpieza con vista previa (caché, versiones y Java que no usa nadie, descargas incompletas). La limpieza borra para siempre lo que se puede volver a descargar, y pide confirmación.
- **Datos**: dónde se guarda todo (podés moverlo a otra carpeta o disco, con reinicio), cuánto ocupa cada cosa, vaciar la caché y el modo portable.
- **Acerca de**: versión, información para copiar, **Novedades de Venus 2.0** (el recorrido de lo nuevo, también con Ctrl+K) y créditos. Venus no se actualiza solo por ahora: las versiones nuevas se instalan a mano.

## Atajos y control

| Atajo | Qué hace |
|---|---|
| **Ctrl+K** | Paleta de comandos: escribí para saltar a cualquier página, instancia, servidor u opción, o hacer una acción. |
| **Ctrl+J** | Abre el Asistente IA. |
| **Ctrl+V** | Con un código `PACK-XXXXXX` copiado (y sin un campo de texto activo), abre la importación del modpack compartido. |
| **Ctrl+Shift+M** | Silenciarte en Voice Chat, aunque estés jugando (se cambia en Voice Chat → Audio). |
| **V** | Pulsar para hablar, si lo activaste (se cambia en Voice Chat → Audio). |
| **Enter** / **Escape** | Confirmar o volver en los asistentes y diálogos. |

**Navegación con control** (activala en **Ajustes → Accesibilidad**): la cruceta o el stick izquierdo mueven el foco, **A** elige, **B** vuelve o cierra, **LB/RB** cambian de página del menú, **LT/RT** de pestaña, **Y** abre la paleta de comandos, **Start** va al Inicio con el foco en Jugar, **View** alterna entre el menú y el contenido, **X** abre el menú contextual y el stick derecho desplaza. Hay ayudas en pantalla con los botones de Xbox, PlayStation o Switch y un **modo sofá** para la tele o la Steam Deck. Solo actúa con la ventana del launcher enfocada, así que no molesta mientras jugás.
