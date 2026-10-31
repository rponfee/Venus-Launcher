'use strict';
// Textos del proceso principal del modo desarrollador de plugins (modules/devmode).
module.exports = {
  // Tareas
  taskBuild: 'Compilando {name}',
  taskStartServer: 'Iniciando {name}',
  taskRestart: 'Reiniciando {name} con la versión nueva',
  taskInstallServer: 'Instalando el servidor de desarrollo {name}',
  taskPlugman: 'Instalando PlugManX',

  // Build
  buildCancelled: 'Build cancelado',
  buildFailed: 'El build falló: {error}',
  buildFailedCode: 'el proceso terminó con el código {code}',
  logJdk: 'JAVA_HOME = {home} (Java {major})',
  logNoJdk: 'No se encontró un JDK: se usa el Java que haya en el sistema (si hay alguno).',

  // Servidor de desarrollo
  serverName: 'Dev · {name}',
  motd: 'Servidor de desarrollo de {name} · Venus Launcher',

  // Tipos de jar que no son plugins
  kind_velocity: 'un plugin de Velocity',
  kind_bungee: 'un plugin de BungeeCord',
  kind_fabric: 'un mod de Fabric',
  kind_quilt: 'un mod de Quilt',
  kind_forge: 'un mod de Forge',
  kind_neoforge: 'un mod de NeoForge',

  // Errores
  errNotFound: 'No se encontró el proyecto.',
  errNotDir: 'La carpeta del proyecto no existe o no se puede leer.',
  errNoTool: 'No se encontró Gradle ni Maven en el proyecto. Elegí el jar a mano o agregá un build.gradle o pom.xml.',
  errNoGradle: 'El proyecto no tiene gradlew y Gradle no está instalado en el sistema. Agregá el wrapper (gradle wrapper) o instalá Gradle.',
  errNoMaven: 'El proyecto no tiene mvnw y Maven no está instalado en el sistema. Agregá el wrapper o instalá Maven.',
  errBuilding: 'Ya hay un build en curso para este proyecto.',
  errBadArgs: 'Argumento no permitido: "{value}". Usá solo letras, números y - _ . : = , / + @',
  errBadTask: 'Tarea inválida: usá nombres como shadowJar, build o :plugin:jar separados por espacios.',
  errNoJar: 'Todavía no hay un jar compilado. Compilá el proyecto o elegí el jar a mano.',
  errNotPlugin: '{file} no es un plugin de Paper o Bukkit (no tiene plugin.yml ni paper-plugin.yml).',
  errJarKind: '{file} es {kind}, no un plugin de Paper o Bukkit.',
  errNoServer: 'Este proyecto todavía no tiene un servidor de desarrollo.',
  errServerMissing: 'El servidor vinculado ya no existe. Creá uno nuevo o elegí otro.',
  errServerType: 'Ese servidor no admite plugins: elegí uno Paper, Purpur, Folia o Spigot.',
  errEula: 'Para crear el servidor tenés que aceptar el EULA de Minecraft.',
  errType: 'Tipo de servidor no válido.',
  errVersion: 'Versión de Minecraft no válida.',
  errVersions: 'No se pudo obtener la lista de versiones: {error}',
  errPort: 'El puerto tiene que ser un número entre 1024 y 65535.',
  errServerBusy: 'El servidor está ocupado. Esperá a que termine de iniciar o apagarse.',
  errServerStopped: 'El servidor se apagó mientras se recargaba el plugin.',
  errStopTimeout: 'El servidor no se apagó a tiempo.',
  errStopServerFirst: 'Apagá el servidor antes de borrarlo.',
  errDebounce: 'La espera tiene que estar entre 300 y 10000 ms.',
  errJdk: 'Esa carpeta no es un JDK válido (falta bin/javac).',
  errJarPick: 'Elegí un archivo .jar que exista.',
  errReload: 'Modo de recarga no válido.',
  errPlugmanNone: 'No hay una versión de PlugManX para {type} {version}.',
  errOpen: 'No se puede abrir eso.',
  errDebugPort: 'El puerto de depuración {port} está ocupado. Cambialo en los ajustes del proyecto o cerrá lo que lo esté usando.',
  errLocked: 'No se pudo reemplazar {file}: el servidor lo tiene abierto.',
  errBadPath: 'La ruta del proyecto tiene caracteres que la consola de Windows no admite (" o %). Movelo a otra carpeta.',
};
