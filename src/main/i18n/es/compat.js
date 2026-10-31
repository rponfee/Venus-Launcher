// Textos del proceso principal del módulo de compatibilidad (revisión antes de instalar, actualizaciones e historial).
module.exports = {
  // Errores generales
  errNetwork: 'No se pudo conectar con Modrinth. Revisá tu conexión a internet.',
  errRateLimit: 'Modrinth recibió demasiados pedidos seguidos. Esperá un minuto y probá de nuevo.',
  errModrinthDown: 'Modrinth no está respondiendo (error {status}). Probá de nuevo en un rato.',
  errModrinth: 'Modrinth respondió con un error ({status}). {detail}',
  errTarget: 'No se indicó dónde instalar.',
  errNoServer: 'El servidor no existe o fue eliminado.',
  errNoInstance: 'La instancia no existe o fue eliminada.',
  errNoItems: 'No hay nada para revisar.',
  errGameRunning: 'Cerrá el juego antes de cambiar los mods de esta instancia.',
  errServerRunning: 'Detené el servidor antes de cambiar sus mods o plugins.',
  errServerInstall: 'Este servidor no permite instalar contenido desde acá.',
  errBadPath: 'Ruta no permitida.',
  errFileLocked: 'No se pudo mover {file}: está en uso. Cerrá el juego e intentá de nuevo.',
  errFileShared: 'No se pudo mover {file}: está compartido con una instancia abierta (Venus guarda una sola copia de los archivos repetidos). Cerrala y probá de nuevo.',
  errEntryNotFound: 'No se encontró ese cambio en el historial.',
  errAlreadyRolledBack: 'Ese cambio ya se revirtió.',
  errBackupMissing: 'La copia guardada de ese mod ya no está en el historial.',
  errNothingToRollback: 'No hay nada para revertir: el archivo ya no está.',
  errNothingSelected: 'No elegiste ninguna actualización.',
  errFileGone: 'El archivo ya no está en la instancia.',
  errVersionGone: 'La versión nueva ya no está disponible en Modrinth.',

  // Tareas
  taskUpdate: 'Actualizando mods de {name}',
  taskPrepare: 'Preparando la instalación en {name}',
  snapshotReason: 'Actualización de mods',
  stepSnapshot: 'Guardando una instantánea...',
  stepResolve: 'Revisando versiones...',
  stepDownload: 'Descargando',
  stepReplace: 'Reemplazando archivos...',

  // El destino no acepta este tipo de contenido
  serverVanilla: 'Los servidores Vanilla no cargan mods ni plugins: {title} no va a funcionar ahí.',
  modOnPluginServer: '{title} es un mod y tu servidor {type} solo carga plugins.',
  optifineNoMods: 'Las instancias de OptiFine solo no cargan mods: {title} necesita una instancia con Fabric, Forge, NeoForge o Quilt.',
  vanillaNoMods: 'Esta instancia es Vanilla y no carga mods: {title} necesita una instancia con Fabric, Forge, NeoForge o Quilt.',
  pluginOnClient: '{title} es un plugin para servidores (Paper, Spigot…) y no funciona dentro del juego.',
  pluginOnModServer: '{title} es un plugin y tu servidor {type} solo carga mods.',
  shaderOnServer: '{title} es un shader: se usa en el juego, no en un servidor.',
  resourcepackOnServer: '{title} es un resource pack: en un servidor no se instala así, se configura en server.properties (resource-pack).',

  // Sin versión compatible
  noVersionLoader: '{title} no existe para {loader}: solo está para {loaders}.',
  noVersionMc: '{title} no tiene versión para Minecraft {mc}. Las más nuevas que soporta: {versions}.',
  noVersionMcAny: '{title} no tiene versión para Minecraft {mc}.',
  noVersionCombo: '{title} no tiene una versión para Minecraft {mc} con {loader}.',
  projectNotFound: 'No se encontró el proyecto «{id}» en Modrinth.',
  modpackNoCheck: '{title} es un modpack: se instala como una instancia nueva, así que no hace falta revisarlo.',
  versionNotFound: 'No se encontró la versión elegida de {title}.',
  versionMismatch: 'La versión {version} de {title} es para Minecraft {versions} con {loaders}; acá se necesita Minecraft {mc} con {loader}.',
  packNotForVersion: '{title} no declara compatibilidad con Minecraft {mc} (es para {versions}). Puede funcionar, pero quizás se vea mal.',
  packNotForVersionAny: '{title} no declara compatibilidad con Minecraft {mc}. Puede funcionar, pero quizás se vea mal.',
  alphaVersion: 'La versión elegida de {title} ({version}) es alfa: puede tener errores serios.',
  betaVersion: 'La versión elegida de {title} ({version}) es beta: puede tener algunos errores.',

  // Ya instalado
  alreadyInstalled: '{title} {version} ya está instalado.',
  alreadyInstalledDisabled: '{title} {version} ya está instalado, pero desactivado.',
  installedManually: 'Ya tenés {title} agregado a mano ({file}, versión {old}). Si no lo sacás, van a quedar dos copias y el juego no arranca.',
  replacesVersion: 'Se reemplaza {title} {old} por la {version}.',
  duplicateModId: 'Ya tenés {file}, que es el mismo mod que {title} (id «{modId}»). Con los dos instalados el juego no arranca.',
  duplicatePlugin: 'Ya tenés {file}, que es el mismo plugin que {title}. Con los dos el servidor da error.',
  alreadyProvided: '{other} ya incluye lo que hace {title}: no hace falta instalarlo.',
  providesInstalled: '{title} ya incluye lo que hace {other} ({file}): podés sacarlo si querés.',
  betterVersion: 'La versión {version} de {title} no tiene estos problemas.',
  betterVersionPre: 'La versión {version} de {title} (de prueba) no tiene estos problemas.',

  // Dependencias
  willAddDependency: 'Se agrega {dep} {version} porque {title} lo necesita.',
  optionalSuggestion: '{title} funciona mejor con {dep} (opcional).',
  dependencyDisabled: '{title} necesita {dep}, que está instalado pero desactivado ({file}).',
  pinnedDependency: '{title} pide {dep} {wanted} y tenés la {installed}. Puede funcionar igual; si falla, instalá esa versión.',
  dependencyUnavailable: '{title} necesita un proyecto que ya no está disponible en Modrinth ({dep}).',
  dependencyNoVersion: '{title} necesita {dep}, pero {dep} no tiene versión para Minecraft {mc} con {loader}.',
  externalDependency: '{title} necesita un archivo que no está en Modrinth ({file}): vas a tener que conseguirlo aparte.',

  // Incompatibilidades declaradas en Modrinth
  incompatibleWithInstalled: '{title} es incompatible con {other}, que ya tenés instalado.',
  incompatibleBetweenNew: '{title} y {other} son incompatibles entre sí.',
  installedIncompatibleWithNew: '{other}, que ya tenés instalado, es incompatible con {title}.',

  // Incompatibilidades declaradas en los archivos de los mods
  jarBreaksInstalled: '{a}, que ya tenés instalado, declara que no funciona con {b}.',
  jarBreaksNew: '{a} declara que no funciona con {b}, que ya tenés instalado.',
  jarBreaksPlanned: '{a} declara que no funciona con {b}.',
  jarBreaksMaybeInstalled: '{a}, que ya tenés instalado, declara problemas con algunas versiones de {b} ({range}).',
  jarBreaksMaybeNew: '{a} declara problemas con algunas versiones de {b} ({range}), que ya tenés instalado.',
  jarBreaksMaybePlanned: '{a} declara problemas con algunas versiones de {b} ({range}).',
  jarConflictsInstalled: '{a}, que ya tenés instalado, avisa que puede tener problemas con {b}.',
  jarConflictsNew: '{a} avisa que puede tener problemas con {b}, que ya tenés instalado.',
  jarConflictsPlanned: '{a} avisa que puede tener problemas con {b}.',
  jarNeedsInstalled: '{a}, que ya tenés instalado, necesita {b} {range}, y se va a instalar la {version}.',
  jarNeedsNew: '{a} necesita {b} {range}, y tenés instalada la {version}.',
  jarNeedsPlanned: '{a} necesita {b} {range}, y se va a instalar la {version}.',
  jarMinecraft: 'El archivo de {title} pide Minecraft {range} y acá se usa la {mc}.',
  detailRange: 'Versiones afectadas: {range}',

  // Cliente / servidor
  clientOnlyOnServer: '{title} es solo para el juego (cliente): en un servidor no hace nada y puede impedir que arranque.',
  clientOnlyOnServerIgnored: '{title} es solo para el juego (cliente): el servidor lo va a ignorar.',
  serverOnlyOnClient: '{title} es solo para servidores: en tu juego no va a hacer nada.',

  // Shaders y packs
  shaderVanilla: 'Para usar {title} necesitás Iris u OptiFine, y esta instancia ({loader}) no puede tenerlos. Creá una instancia Iris u OptiFine.',
  shaderNoLoader: 'Para usar {title} necesitás un cargador de shaders. Podés agregar {fix} ahora.',
  shaderNoLoaderNoFix: 'Para usar {title} necesitás Iris u OptiFine, y no hay una versión para {loader} {mc}.',
  shaderLoaderMismatch: '{title} está hecho para {loaders}; con {current} puede no verse bien.',
  packFormat: '{title} usa el formato {format} y Minecraft {mc} espera el {expected}: el juego lo va a marcar como incompatible y puede verse mal.',
};
