'use strict';
// Main-process strings for the plugin developer mode (modules/devmode).
module.exports = {
  // Tasks
  taskBuild: 'Building {name}',
  taskStartServer: 'Starting {name}',
  taskRestart: 'Restarting {name} with the new version',
  taskInstallServer: 'Installing the dev server {name}',
  taskPlugman: 'Installing PlugManX',

  // Build
  buildCancelled: 'Build cancelled',
  buildFailed: 'The build failed: {error}',
  buildFailedCode: 'the process exited with code {code}',
  logJdk: 'JAVA_HOME = {home} (Java {major})',
  logNoJdk: 'No JDK found: using whatever Java the system has (if any).',

  // Dev server
  serverName: 'Dev · {name}',
  motd: '{name} dev server · Venus Launcher',

  // Jars that are not plugins
  kind_velocity: 'a Velocity plugin',
  kind_bungee: 'a BungeeCord plugin',
  kind_fabric: 'a Fabric mod',
  kind_quilt: 'a Quilt mod',
  kind_forge: 'a Forge mod',
  kind_neoforge: 'a NeoForge mod',

  // Errors
  errNotFound: 'Project not found.',
  errNotDir: 'The project folder does not exist or cannot be read.',
  errNoTool: 'Neither Gradle nor Maven was found in the project. Pick the jar manually or add a build.gradle or pom.xml.',
  errNoGradle: 'The project has no gradlew and Gradle is not installed on the system. Add the wrapper (gradle wrapper) or install Gradle.',
  errNoMaven: 'The project has no mvnw and Maven is not installed on the system. Add the wrapper or install Maven.',
  errBuilding: 'A build is already running for this project.',
  errBadArgs: 'Argument not allowed: "{value}". Use only letters, numbers and - _ . : = , / + @',
  errBadTask: 'Invalid task: use names like shadowJar, build or :plugin:jar separated by spaces.',
  errNoJar: 'There is no built jar yet. Build the project or pick the jar manually.',
  errNotPlugin: '{file} is not a Paper or Bukkit plugin (it has no plugin.yml or paper-plugin.yml).',
  errJarKind: '{file} is {kind}, not a Paper or Bukkit plugin.',
  errNoServer: 'This project does not have a dev server yet.',
  errServerMissing: 'The linked server no longer exists. Create a new one or pick another.',
  errServerType: 'That server does not support plugins: pick a Paper, Purpur, Folia or Spigot one.',
  errEula: 'You have to accept the Minecraft EULA to create the server.',
  errType: 'Invalid server type.',
  errVersion: 'Invalid Minecraft version.',
  errVersions: 'Could not get the version list: {error}',
  errPort: 'The port must be a number between 1024 and 65535.',
  errServerBusy: 'The server is busy. Wait until it finishes starting or stopping.',
  errServerStopped: 'The server stopped while the plugin was being reloaded.',
  errStopTimeout: 'The server did not stop in time.',
  errStopServerFirst: 'Stop the server before deleting it.',
  errDebounce: 'The delay must be between 300 and 10000 ms.',
  errJdk: 'That folder is not a valid JDK (bin/javac is missing).',
  errJarPick: 'Pick a .jar file that exists.',
  errReload: 'Invalid reload mode.',
  errPlugmanNone: 'There is no PlugManX version for {type} {version}.',
  errOpen: 'That cannot be opened.',
  errDebugPort: 'Debug port {port} is in use. Change it in the project settings or close whatever is using it.',
  errLocked: 'Could not replace {file}: the server has it open.',
  errBadPath: 'The project path has characters the Windows console does not support (" or %). Move it to another folder.',
};
