# Venus Badge

Mod de cliente para Fabric (Minecraft 1.21 y 1.21.1, sin Fabric API) que dibuja el planeta de Venus Launcher antes del nombre de los jugadores que activaron la insignia en el launcher: sobre la cabeza y en la lista de jugadores (Tab).

Venus Launcher lo instala y lo quita solo (Ajustes → General → Venus en el juego). Cómo funciona, qué manda al servidor y cómo se despliega: [docs/insignia.md](../../docs/insignia.md).

```bash
./gradlew build   # build/libs/venus-badge-<versión>+mc1.21.1.jar, con las pruebas de BadgeCache
```

Desde la raíz del repositorio, `npm run mod:badge` compila y copia el `.jar` a `src/main/modules/ingame/mods`.
