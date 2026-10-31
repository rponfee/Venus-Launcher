'use strict';
module.exports = {
  errNoInstance: 'Elegí una instancia para optimizar.',
  errNoVersion: 'Falta la versión de Minecraft.',
  errRunning: 'Cerrá {name} antes de cambiar sus mods u opciones.',
  errModrinth: 'No se pudo consultar Modrinth: {error}',
  errCancelled: 'Cancelado por el usuario',

  taskOptimize: 'Optimizando {name}',
  taskScanning: 'Revisando los mods que ya tiene...',
  taskInstalling: 'Instalando {title} ({current} de {total})...',
  taskOptions: 'Ajustando las opciones de video...',
  taskPartial_one: 'Listo, pero {count} proyecto no se pudo instalar.',
  taskPartial_other: 'Listo, pero {count} proyectos no se pudieron instalar.',

  tier_low: 'gama baja',
  tier_mid: 'gama media',
  tier_high: 'gama alta',
  tier_ultra: 'gama muy alta',

  reasonMods_one: 'Tu PC es de {tier}: le damos {mem} a esta instancia y le sumamos {count} mod de rendimiento.',
  reasonMods_other: 'Tu PC es de {tier}: le damos {mem} a esta instancia y le sumamos {count} mods de rendimiento.',
  reasonAllInstalled: 'Tu PC es de {tier}: le damos {mem} a esta instancia, que ya tiene todos los mods de rendimiento.',
  reasonNoMods: 'Tu PC es de {tier}: le damos {mem} a esta instancia y ajustamos el video para que vaya más fluido.',
  reasonOffline: 'Tu PC es de {tier}: le damos {mem} a esta instancia. Sin conexión con Modrinth no podemos sugerir mods ahora.',
  reasonLowEnd: 'Modo PC de bajos recursos: le damos {mem}, bajamos los gráficos y sumamos mods livianos que ahorran memoria y CPU.',

  noteVanilla: 'Las instancias vanilla no pueden usar mods. Para sumar Sodium y compañía, creá una instancia Fabric de la misma versión.',
  noteOptifineLoader: 'OptiFine no es compatible con los mods de rendimiento modernos. Para más FPS te conviene una instancia Fabric (con Iris si querés shaders).',
  noteOptifine: 'Esta instancia tiene OptiFine, que choca con Sodium: no lo sumamos. Si sacás OptiFine, podés usar Sodium + Iris.',
  noteLimited: 'Esta instancia pediría {need}, pero tu PC no da para más de {max}. Cerrá otros programas mientras jugás.',

  warnLowFreeRam: 'Tenés poca RAM libre ({free}) y esta instancia necesita unos {need}. Cerrá otros programas para que no se trabe.',

  mod_sodium: 'Reemplaza el motor de gráficos: muchos más FPS y menos tirones.',
  mod_embeddium: 'El Sodium de Forge: muchos más FPS y menos tirones.',
  mod_lithium: 'Optimiza la física, los mobs y el mundo: menos uso de CPU.',
  'mod_ferrite-core': 'Reduce mucho la RAM que usa el juego.',
  mod_modernfix: 'Arranque más rápido y menos RAM, sobre todo con muchos mods.',
  mod_immediatelyfast: 'Dibuja más rápido la interfaz, los textos, los mapas y las entidades.',
  mod_entityculling: 'No dibuja mobs ni cofres que están detrás de las paredes.',
  'mod_dynamic-fps': 'Baja los FPS cuando el juego está en segundo plano: ahorra batería y CPU.',
  mod_moreculling: 'Oculta caras de bloques que no se ven (hojas, vidrios): más FPS.',
  mod_badoptimizations: 'Pequeñas optimizaciones que suman FPS en PCs modestas.',
  mod_memoryleakfix: 'Corrige pérdidas de memoria de Minecraft y de otros mods.',
};
