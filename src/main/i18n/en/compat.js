// Main-process strings for the compatibility module (pre-install check, updates and history).
module.exports = {
  // General errors
  errNetwork: "Couldn't connect to Modrinth. Check your internet connection.",
  errRateLimit: 'Modrinth received too many requests in a row. Wait a minute and try again.',
  errModrinthDown: "Modrinth isn't responding (error {status}). Try again in a while.",
  errModrinth: 'Modrinth returned an error ({status}). {detail}',
  errTarget: 'No install destination was given.',
  errNoServer: "The server doesn't exist or was deleted.",
  errNoInstance: "The instance doesn't exist or was deleted.",
  errNoItems: 'There is nothing to check.',
  errGameRunning: "Close the game before changing this instance's mods.",
  errServerRunning: 'Stop the server before changing its mods or plugins.',
  errServerInstall: "This server doesn't allow installing content from here.",
  errBadPath: 'Path not allowed.',
  errFileLocked: "Couldn't move {file}: it's in use. Close the game and try again.",
  errFileShared: "Couldn't move {file}: it's shared with an instance that is running (Venus keeps a single copy of duplicate files). Close it and try again.",
  errEntryNotFound: "That change wasn't found in the history.",
  errAlreadyRolledBack: 'That change was already reverted.',
  errBackupMissing: "The saved copy of that mod is no longer in the history.",
  errNothingToRollback: 'Nothing to revert: the file is gone.',
  errNothingSelected: "You didn't pick any update.",
  errFileGone: 'The file is no longer in the instance.',
  errVersionGone: 'The new version is no longer available on Modrinth.',

  // Tasks
  taskUpdate: 'Updating mods of {name}',
  taskPrepare: 'Preparing the install in {name}',
  snapshotReason: 'Mod update',
  stepSnapshot: 'Saving a snapshot...',
  stepResolve: 'Checking versions...',
  stepDownload: 'Downloading',
  stepReplace: 'Replacing files...',

  // The destination doesn't accept this kind of content
  serverVanilla: "Vanilla servers don't load mods or plugins: {title} won't work there.",
  modOnPluginServer: '{title} is a mod and your {type} server only loads plugins.',
  optifineNoMods: "Standalone OptiFine instances don't load mods: {title} needs an instance with Fabric, Forge, NeoForge or Quilt.",
  vanillaNoMods: "This instance is Vanilla and doesn't load mods: {title} needs an instance with Fabric, Forge, NeoForge or Quilt.",
  pluginOnClient: "{title} is a server plugin (Paper, Spigot…) and doesn't work inside the game.",
  pluginOnModServer: '{title} is a plugin and your {type} server only loads mods.',
  shaderOnServer: "{title} is a shader: it's used in the game, not on a server.",
  resourcepackOnServer: "{title} is a resource pack: servers don't install it like this, it's set in server.properties (resource-pack).",

  // No compatible version
  noVersionLoader: "{title} doesn't exist for {loader}: it's only available for {loaders}.",
  noVersionMc: "{title} has no version for Minecraft {mc}. The newest it supports: {versions}.",
  noVersionMcAny: '{title} has no version for Minecraft {mc}.',
  noVersionCombo: "{title} doesn't have a version for Minecraft {mc} with {loader}.",
  projectNotFound: 'The project “{id}” was not found on Modrinth.',
  modpackNoCheck: "{title} is a modpack: it's installed as a new instance, so it doesn't need checking.",
  versionNotFound: "The selected version of {title} wasn't found.",
  versionMismatch: 'Version {version} of {title} is for Minecraft {versions} with {loaders}; this needs Minecraft {mc} with {loader}.',
  packNotForVersion: "{title} doesn't declare support for Minecraft {mc} (it's for {versions}). It may work, but it might look wrong.",
  packNotForVersionAny: "{title} doesn't declare support for Minecraft {mc}. It may work, but it might look wrong.",
  alphaVersion: 'The selected version of {title} ({version}) is an alpha: it may have serious bugs.',
  betaVersion: 'The selected version of {title} ({version}) is a beta: it may have some bugs.',

  // Already installed
  alreadyInstalled: '{title} {version} is already installed.',
  alreadyInstalledDisabled: '{title} {version} is already installed, but disabled.',
  installedManually: "You already added {title} by hand ({file}, version {old}). If you don't remove it, there will be two copies and the game won't start.",
  replacesVersion: '{title} {old} will be replaced with {version}.',
  duplicateModId: "You already have {file}, which is the same mod as {title} (id “{modId}”). With both installed the game won't start.",
  duplicatePlugin: 'You already have {file}, which is the same plugin as {title}. With both, the server will fail.',
  alreadyProvided: "{other} already includes what {title} does: there's no need to install it.",
  providesInstalled: '{title} already includes what {other} does ({file}): you can remove it if you want.',
  betterVersion: "Version {version} of {title} doesn't have these problems.",
  betterVersionPre: "Version {version} of {title} (pre-release) doesn't have these problems.",

  // Dependencies
  willAddDependency: '{dep} {version} will be added because {title} needs it.',
  optionalSuggestion: '{title} works better with {dep} (optional).',
  dependencyDisabled: '{title} needs {dep}, which is installed but disabled ({file}).',
  pinnedDependency: '{title} asks for {dep} {wanted} and you have {installed}. It may still work; if it fails, install that version.',
  dependencyUnavailable: '{title} needs a project that is no longer available on Modrinth ({dep}).',
  dependencyNoVersion: '{title} needs {dep}, but {dep} has no version for Minecraft {mc} with {loader}.',
  externalDependency: "{title} needs a file that isn't on Modrinth ({file}): you'll have to get it separately.",

  // Incompatibilities declared on Modrinth
  incompatibleWithInstalled: '{title} is incompatible with {other}, which you already have installed.',
  incompatibleBetweenNew: '{title} and {other} are incompatible with each other.',
  installedIncompatibleWithNew: '{other}, which you already have installed, is incompatible with {title}.',

  // Incompatibilities declared inside the mod files
  jarBreaksInstalled: "{a}, which you already have installed, declares it doesn't work with {b}.",
  jarBreaksNew: "{a} declares it doesn't work with {b}, which you already have installed.",
  jarBreaksPlanned: "{a} declares it doesn't work with {b}.",
  jarBreaksMaybeInstalled: '{a}, which you already have installed, declares problems with some versions of {b} ({range}).',
  jarBreaksMaybeNew: '{a} declares problems with some versions of {b} ({range}), which you already have installed.',
  jarBreaksMaybePlanned: '{a} declares problems with some versions of {b} ({range}).',
  jarConflictsInstalled: '{a}, which you already have installed, warns it may have problems with {b}.',
  jarConflictsNew: '{a} warns it may have problems with {b}, which you already have installed.',
  jarConflictsPlanned: '{a} warns it may have problems with {b}.',
  jarNeedsInstalled: '{a}, which you already have installed, needs {b} {range}, and {version} will be installed.',
  jarNeedsNew: '{a} needs {b} {range}, and you have {version} installed.',
  jarNeedsPlanned: '{a} needs {b} {range}, and {version} will be installed.',
  jarMinecraft: "{title}'s file asks for Minecraft {range} and this uses {mc}.",
  detailRange: 'Affected versions: {range}',

  // Client / server
  clientOnlyOnServer: "{title} is client-only: on a server it does nothing and may stop it from starting.",
  clientOnlyOnServerIgnored: '{title} is client-only: the server will ignore it.',
  serverOnlyOnClient: "{title} is server-only: it won't do anything in your game.",

  // Shaders and packs
  shaderVanilla: "To use {title} you need Iris or OptiFine, and this instance ({loader}) can't have them. Create an Iris or OptiFine instance.",
  shaderNoLoader: 'To use {title} you need a shader loader. You can add {fix} now.',
  shaderNoLoaderNoFix: "To use {title} you need Iris or OptiFine, and there's no version for {loader} {mc}.",
  shaderLoaderMismatch: "{title} is made for {loaders}; with {current} it may not look right.",
  packFormat: '{title} uses pack format {format} and Minecraft {mc} expects {expected}: the game will flag it as incompatible and it may look wrong.',
};
