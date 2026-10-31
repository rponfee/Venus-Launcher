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

La primera vez que abrís el launcher te guía en 8 pasos: idioma, cuenta de Minecraft, cuenta de Venus (opcional), tu primera instancia (combinaciones recomendadas o a tu gusto), contenido extra (rendimiento, shaders, minimapa y más), rendimiento (memoria automática o manual y modo para PC de pocos recursos), preferencias y un resumen. Con **Enter** avanzás y con **Escape** volvés. Al terminar, la instancia se instala en segundo plano y ya podés usar el launcher.

### Cuentas de Minecraft

Tocá tu cuenta abajo a la izquierda (o andá a **Ajustes → Cuenta y nube**). **Iniciar sesión con Microsoft** abre la ventana de Microsoft y comprueba que la cuenta tenga Minecraft: Java Edition. Para una cuenta sin conexión, escribí un nombre y tocá **Agregar**. Podés tener varias y elegir con cuál jugar. Si la sesión de una cuenta de Microsoft vence, la cuenta aparece marcada para que vuelvas a iniciar sesión.

### Cuenta de Venus

En **Ajustes → Cuenta y nube → Cuenta de Venus** creá tu cuenta con un nombre de usuario, email y contraseña. Si el servidor pide confirmar el email, te llega un código: escribilo en el launcher. Ahí mismo ves tu **código de amigo** (`VENUS-XXXXXX`), cambiás tu nombre visible o la contraseña, y si te olvidaste la contraseña tocá **¿Olvidaste tu contraseña?** para recibir un código.

## Jugar

### Inicio

Tu instancia elegida con el botón **JUGAR**. Mientras jugás se convierte en **DETENER** y muestra el tiempo de juego y dónde estás (mundo o servidor); mientras se prepara, muestra el progreso. Con el selector de arriba cambiás de instancia.

Debajo hay accesos rápidos y bloques que se ocultan solos si no tienen datos: **Continuar donde quedaste** (entra directo a tus últimos mundos), servidores destacados con su ping, tus capturas, novedades de Minecraft, **Tu servidor** (el que configures en Apariencia), amigos en línea con botón para unirte, tu actividad de la semana y consejos. Con **Personalizar inicio** elegís qué bloques ver.

- Necesita: cuenta de Minecraft para jugar. Los amigos en línea necesitan cuenta de Venus.

### Versiones e instancias

Una **instancia** es una instalación independiente de Minecraft, con su versión, su loader y sus propios mods, mundos y ajustes.

- **Instalar nueva**: elegí cualquier versión (releases, snapshots, bromas del 1 de abril, beta, alpha y versiones antiguas hasta la pre-classic) y un loader: Vanilla, Fabric, Quilt, Forge, NeoForge, OptiFine, Iris (Fabric + Iris + Sodium), Legacy Fabric o Babric. La instalación sigue en segundo plano y la ves en el panel de tareas.
- **Mis instancias**: en cuadrícula o lista, con búsqueda, orden (jugadas hace poco, nombre, versión o tiempo jugado) y agrupadas por loader. Desde el menú de cada una podés renombrarla, duplicarla, repararla o eliminarla (va a la papelera).
- **Importar**: modpacks de Modrinth (`.mrpack`), modpacks de otros launchers (CurseForge, MultiMC, Prism) o **Usar código** para un modpack que te compartieron (`PACK-XXXXXX`). También podés arrastrar el archivo a la ventana.

La página de cada instancia tiene las pestañas **Resumen** (tiempo jugado, espacio en disco y las herramientas de la instancia), **Contenido** (mods, resource packs, shaders y data packs de cada mundo, con interruptores para activarlos y botón para agregar más), **Mundos** (jugar directo o ver el mapa), **Capturas**, **Registros** (la consola en vivo y los archivos de registro) y **Ajustes** (memoria, Java, ventana y **Optimizar**). Las herramientas del Resumen se explican en [Herramientas de cada instancia](#herramientas-de-cada-instancia).

Si la instancia ya se verificó hace poco y no cambió nada, arranca rápido sin revisar todo por internet. **Reparar** revisa todos los archivos.

### Mundos

Todos los mundos de todas tus instancias en una grilla, con filtros. La ficha de cada mundo trae **Jugar** (entra directo al mundo en 1.20 o más nuevo), **Mapa**, **Respaldar**, **Copiar a…** (otra instancia o un servidor local), **Instantánea**, **Nube**, **Renombrar**, **Carpeta** y **Borrar** (a la papelera), y las pestañas:

- **Historia**: tus partidas día por día con los logros que conseguiste y las capturas de cada partida. Lo jugado antes de usar Venus aparece como "partida estimada".
- **Capturas y clips**, **Estadísticas** (bloques, criaturas, logros) y **Datos y copias** (semilla, modo, dificultad y copias de seguridad para restaurar).

La pestaña **Capturas y clips** de la página junta todas tus capturas y clips, con un visor a pantalla completa. Podés **compartir** una captura o un clip con un link que dura un año (y dejar de compartirlo cuando quieras).

- Necesita: compartir capturas y clips necesita cuenta de Venus. Renombrar, borrar o restaurar un mundo no se puede mientras está abierto en el juego.

### Mapa del mundo

Desde **Mapa** (en Mundos o en la pestaña Mundos de una instancia) ves el mapa desde arriba: arrastrá para moverte, usá la rueda para acercar, elegí la dimensión (Superficie, Nether, End o las de mods y data packs), mirá las coordenadas del bloque bajo el cursor (clic para copiarlas), la aparición y los jugadores. **Renderizar todo** dibuja el mundo completo y podés **exportar la vista como PNG**. Funciona con mundos de la 1.2 en adelante; los más viejos se indican como no compatibles.

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
- **En la sala**: silenciarte o ensordecerte, volumen de cada persona (hasta 200 %), quién está hablando, **pantalla compartida**, un soundboard, chat de la sala y, si sos el anfitrión, moderación (pedir que alguien se silencie, sacar, bloquear o cerrar la sala).
- **Audio**: micrófono y salida, filtros de ruido y eco, volumen de entrada, detección de voz o **pulsar para hablar** (tecla V por defecto, o los botones laterales del mouse), atajo global para silenciarte mientras jugás (**Ctrl+Shift+M** por defecto) y prueba de micrófono. Si tu versión del launcher trae servidor de voz propio, **Red y privacidad** te deja **Ocultar mi IP** (toda tu voz pasa por el servidor de Venus).
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

## Herramientas

### Estadísticas

Cuatro pestañas: **Launcher** (tiempo jugado, rachas, calendario, horarios, instancias, versiones y loaders, crashes), **En el juego** (bloques minados, criaturas, distancias y más, por instancia y por mundo), **Mundos y servidores** (dónde jugaste más, con **Jugar** o **Entrar** directo) y **Logros** (hitos del launcher y logros del juego con su progreso). Podés exportar tus sesiones en CSV o todo en JSON. Se actualiza solo mientras jugás.

### Rendimiento

La memoria de Minecraft en una sola tarjeta:

- **Automático** (recomendado): Venus decide cuánta RAM darle a cada partida según tu PC, la memoria libre y el tamaño del modpack, y te explica por qué.
- **Manual**: un deslizador con zonas (poco, ideal, demasiado) y la marca de lo recomendado.

En **Opciones avanzadas** están el recolector de Java (explicado en criollo), argumentos extra, prioridad del proceso, tamaño de ventana y qué hace el launcher al iniciar el juego. A la derecha ves **Tu PC** (con una prueba de rendimiento de la CPU) y un monitor en vivo de la RAM y la CPU del juego. **Optimizar una instancia** abre la herramienta Optimizar.

### Modo desarrollador

Para programar plugins de Paper: elegí la carpeta de tu proyecto (Gradle o Maven) y Venus detecta cómo compilarlo, qué Java necesita y qué jar genera. **Empezar a probar** compila, crea un servidor de prueba (Paper, Purpur o Folia, mundo plano y vos como operador), copia el plugin y abre Minecraft conectado. Después, **Compilar y recargar** aplica tus cambios con un reinicio, `/reload` o recarga en caliente con PlugManX. También puede compilar solo al guardar, mostrar los errores de compilación con pistas y activar la depuración para conectar IntelliJ.

- Necesita: un proyecto de plugin de Paper, un JDK instalado y cuenta de Minecraft para entrar a probar.

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
- **Apariencia**: temas planetarios (Venus, Marte, Neptuno, Júpiter, Tierra y Saturno) o tu propio color, fondo de imagen o video (con oscurecer y desenfocar) o estrellas, música de fondo que se pausa al jugar o en Voice Chat, y tu marca: logo, nombre y **Tu servidor** (el que aparece en el Inicio), con prueba de conexión.
- **Accesibilidad**: modos para daltonismo con intensidad regulable, alto contraste, tamaño de la interfaz (90 a 130 %), movimiento reducido, foco siempre visible, símbolos en los estados y navegación con control (ver [Atajos y control](#atajos-y-control)). También instala **Controlify** para jugar Minecraft con control.
- **Cuenta y nube**: tus cuentas de Minecraft y tu cuenta de Venus (crearla, iniciar sesión, código de amigo, nombre visible y contraseña).
- **Privacidad**: compartir o no tu actividad con tus amigos, qué datos quedan en tu PC y cuáles en la nube, y **Discord Rich Presence**: muestra en tu perfil de Discord si estás en el launcher o jugando (instancia, versión, mundo o servidor, tiempo y hasta 2 botones), sin mostrar nunca direcciones IP. Solo hace falta dejar abierta la app de escritorio de Discord (la web no sirve); **Probar** muestra una actividad de prueba.
- **Inteligencia artificial**: estado de la IA, tu plan con las preguntas que te quedan por modelo y el presupuesto del mes, activar o desactivar la IA, **Probar la IA**, la conexión con **Claude y ChatGPT (MCP)**, los **servidores MCP del asistente** y qué se envía.
- **Plan**: tu plan de Venus IA (con aviso si un pago falló o si la suscripción se cancela), las tarjetas de los 6 planes con su precio, modelos y preguntas, **Mejorar plan** (abre el pago de Stripe en tu navegador) y **Administrar suscripción** (cambiar la tarjeta, ver facturas o cancelar).
- **Java**: el Java que descargó Venus, el que encuentra en tu PC, probar un ejecutable y qué Java usa cada versión de Minecraft.
- **Descargas y almacenamiento**: medidor de descargas en vivo, pausa, límite de velocidad, descargas simultáneas y **modo sin conexión**; uso del disco por categoría; **unificar archivos repetidos** (los mods y packs iguales de varias instancias pasan a ocupar lugar una sola vez, también en automático) y limpieza con vista previa (caché, versiones y Java que no usa nadie, descargas incompletas). La limpieza borra para siempre lo que se puede volver a descargar, y pide confirmación.
- **Datos**: dónde se guarda todo (podés moverlo a otra carpeta o disco, con reinicio), cuánto ocupa cada cosa, vaciar la caché y el modo portable.
- **Acerca de**: versión, información para copiar y créditos. Venus no se actualiza solo por ahora: las versiones nuevas se instalan a mano.

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
