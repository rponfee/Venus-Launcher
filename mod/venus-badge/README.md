# Venus Badge

Mod de cliente que dibuja el planeta de Venus Launcher antes del nombre de los jugadores que activaron la insignia en el launcher (sobre la cabeza y en la lista de jugadores, Tab). También le informa los FPS al launcher. Sale un `.jar` por compilación:

| Subproyecto | Loaders | Minecraft | Java | Nombres | Plugin de Gradle |
|---|---|---|---|---|---|
| `fabric-1.21.1` | Fabric, Quilt | 1.21, 1.21.1 | 21 | Yarn | Loom |
| `fabric-1.20.1` | Fabric, Quilt | 1.20.1 | 17 | Yarn | Loom |
| `neoforge-1.21.1` | NeoForge | 1.21, 1.21.1 | 21 | Mojang | ModDevGradle |
| `forge-1.20.1` | Forge | 1.20.1 | 17 | Mojang (SRG al jugar) | ModDevGradle (`legacyforge`) |

Venus Launcher lo instala y lo quita solo (Ajustes → General → Venus en el juego). Cómo funciona, qué manda al servidor y cómo se despliega: [docs/insignia.md](../../docs/insignia.md). Las capas de Venus se retiraron en la 1.3.0 (ver [docs/insignia.md](../../docs/insignia.md), sección 6): el mod ya no dibuja capas ni consulta `badge_capes`.

```bash
./gradlew build   # build/libs/venus-badge-<versión>+mc<minecraft>-<loader>.jar, con las pruebas de la lógica común
./gradlew :forge-1.20.1:runClient   # Minecraft de desarrollo con el mod (en cualquier subproyecto)
```

Gradle corre con Java 25 o más nuevo (lo exige Loom). El Java 17 y 21 de cada compilación los usa si están instalados y, si no, los baja solo.

Desde la raíz del repositorio, `npm run mod:badge` compila y copia los `.jar` a `src/main/modules/ingame/mods`.

## Dónde está cada cosa

- `src/`: lo común a todos los loaders, sin una sola clase de Minecraft (`BadgeCache`, `BadgeClient`, `BadgeCore`, `PerfReporter`), las pruebas y los recursos (fuente e íconos).
- `shared-yarn/`: lo común a las compilaciones de Fabric (`VenusBadge`, el mixin de Tab).
- `shared-mojmap/`: lo común a NeoForge y Forge (`BadgeText`, `BadgeGame`, el mixin de Tab).
- `<subproyecto>/`: lo que cambia en cada una: el punto de entrada o el mixin del nombre, los metadatos (`fabric.mod.json`, `neoforge.mods.toml`, `mods.toml`) y las versiones (`gradle.properties`).
- `gradle/*.gradle`: la configuración compartida entre subproyectos.

Por qué está armado así: [docs/insignia.md](../../docs/insignia.md#4-cómo-está-armado-el-mod).
