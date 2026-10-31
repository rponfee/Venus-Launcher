'use strict';
module.exports = {
  errNoInstance: 'Choose an instance to optimize.',
  errNoVersion: 'The Minecraft version is missing.',
  errRunning: 'Close {name} before changing its mods or options.',
  errModrinth: 'Could not reach Modrinth: {error}',
  errCancelled: 'Cancelled by the user',

  taskOptimize: 'Optimizing {name}',
  taskScanning: 'Checking the mods it already has...',
  taskInstalling: 'Installing {title} ({current} of {total})...',
  taskOptions: 'Adjusting video options...',
  taskPartial_one: 'Done, but {count} project could not be installed.',
  taskPartial_other: 'Done, but {count} projects could not be installed.',

  tier_low: 'low-end',
  tier_mid: 'mid-range',
  tier_high: 'high-end',
  tier_ultra: 'very high-end',

  reasonMods_one: 'Your PC is {tier}: we give this instance {mem} and add {count} performance mod.',
  reasonMods_other: 'Your PC is {tier}: we give this instance {mem} and add {count} performance mods.',
  reasonAllInstalled: 'Your PC is {tier}: we give this instance {mem}, and it already has every performance mod.',
  reasonNoMods: 'Your PC is {tier}: we give this instance {mem} and tune the video settings so it runs smoother.',
  reasonOffline: "Your PC is {tier}: we give this instance {mem}. Without a connection to Modrinth we can't suggest mods right now.",
  reasonLowEnd: 'Low-end PC mode: we give it {mem}, lower the graphics and add lightweight mods that save memory and CPU.',

  noteVanilla: 'Vanilla instances cannot use mods. To add Sodium and friends, create a Fabric instance of the same version.',
  noteOptifineLoader: 'OptiFine is not compatible with modern performance mods. For more FPS, use a Fabric instance (with Iris if you want shaders).',
  noteOptifine: 'This instance has OptiFine, which clashes with Sodium, so we leave Sodium out. If you remove OptiFine you can use Sodium + Iris.',
  noteLimited: 'This instance would want {need}, but your PC cannot spare more than {max}. Close other programs while you play.',

  warnLowFreeRam: 'You have little free RAM ({free}) and this instance needs about {need}. Close other programs so it does not stutter.',

  mod_sodium: 'Replaces the rendering engine: much higher FPS and less stutter.',
  mod_embeddium: 'Sodium for Forge: much higher FPS and less stutter.',
  mod_lithium: 'Optimizes physics, mobs and the world: less CPU usage.',
  'mod_ferrite-core': 'Greatly reduces the RAM the game uses.',
  mod_modernfix: 'Faster startup and less RAM, especially with many mods.',
  mod_immediatelyfast: 'Draws the HUD, text, maps and entities faster.',
  mod_entityculling: 'Skips drawing mobs and chests hidden behind walls.',
  'mod_dynamic-fps': 'Lowers FPS while the game is in the background: saves battery and CPU.',
  mod_moreculling: 'Hides block faces you cannot see (leaves, glass): more FPS.',
  mod_badoptimizations: 'Small optimizations that add up to more FPS on modest PCs.',
  mod_memoryleakfix: 'Fixes memory leaks in Minecraft and other mods.',
};
