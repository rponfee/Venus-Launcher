# Visor de semillas (función 50 de la hoja de ruta)

Página `#/seeds[/<semilla>]`, menú Herramientas. Muestra los biomas y las estructuras de un mundo antes de crearlo. Se calcula todo en la PC, sin red.

## Cómo se usa

- **Semilla**: un número de 64 bits o un texto. Se lee igual que en el juego (`WorldOptions.parseSeed`): se recortan los espacios, se prueba `Long.parseLong` y, si no es un número de 64 bits con signo, se usa `String.hashCode()` del texto. Debajo del campo siempre se ve la semilla numérica resultante. **Al azar** da una de 64 bits; **Copiar** copia la numérica.
- **Versión**, **Dimensión** (Overworld, Nether, End) y **Altura** (solo Overworld: superficie, y 60, y 0, y -48; las cuevas y el Abismo dependen de la altura).
- **Mapa**: arrastrar para moverse, rueda o botones para el zoom (de 1 bloque = 4 píxeles a 1 píxel = 256 bloques), también con las flechas y `+` / `-`. Abajo se ve el bioma exacto bajo el cursor y sus coordenadas; un clic en esa barra las copia.
- **Estructuras**: filtros por tipo. Un clic en el ícono (o en la lista **Cerca del centro**, que además sirve para usarlo con teclado) abre su panel: coordenadas, `/tp @s x ~ z` y aclaración de qué tan segura es. Las **dudosas** se ven apagadas y se pueden ocultar.
- **Slime chunks** opcionales (se ven desde 1 píxel = 8 bloques) y **punto de aparición aproximado**.
- **Crear instancia o mundo con esta semilla**: el launcher no puede crear un mundo de un jugador con semilla, así que el botón explica cómo hacerlo, copia la semilla y lleva a crear la instancia (`#/versions/new/vanilla/<versión>`) o a Servidores. El asistente de servidores tiene un campo Semilla, pero `openCreateWizard` no recibe una semilla de entrada: con un parámetro `seed` en `pages/servers/create.js` (archivo de otro módulo) se podría abrir ya cargado.

## De dónde sale el algoritmo

Es un port a JavaScript de [cubiomes](https://github.com/Cubitect/cubiomes) (MIT), commit `e61f90580cbdd883214a8054670dacae655e59c0` del 10 de noviembre de 2024. Aviso de licencia en `src/renderer/js/pages/seeds/gen/LICENSE-cubiomes.txt`.

| Archivo en `pages/seeds/gen/` | Sale de |
|---|---|
| `rng.js` | `rng.h`: Random de Java (48 bits en dos mitades de 24) y Xoroshiro128++ (pares de enteros de 32 bits) |
| `noise.js` | `noise.c`: Perlin, octavas, ruido doble y simplex 2D |
| `tree.js` | `biomenoise.c`: búsqueda del bioma más cercano en la tabla |
| `overworld.js` | `biomenoise.c`: parámetros climáticos y curva de profundidad, con las mismas operaciones en `float` |
| `nether.js`, `end.js` | `biomenoise.c`: Nether y End |
| `structures.js` | `finders.c` y `finders.h`: posiciones, validación, fortalezas, aparición y slime chunks |
| `biomes.js` | `biomes.c` y colores de `util.c` |
| `tables/btree*.js` | `tables/btree*.h`, generadas con `test/reference/gen-tables.js` |

Lo único que no sale de cubiomes es `doubtful()` en `structures.js` (ver abajo). El resto de la carpeta `pages/seeds/`: `worker.js` y `service.js` (el hilo de cálculo), `pool.js` (hilos y reparto de trabajos), `map.js` (canvas) e `icons.js` (dibujos propios del launcher).

No se copió nada de Mojang: ni datos, ni texturas, ni código. Las tablas son las de cubiomes y los nombres de biomas son traducciones propias.

## Versiones cubiertas

| En el selector | Fila de cubiomes | Tabla | Diferencia con la anterior |
|---|---|---|---|
| 1.21.4+ | `MC_1_21_WD` | `btree21wd` | Jardín pálido |
| 1.21.2 – 1.21.3 | `MC_1_21_3` | `btree20` | Otra fórmula para el punto de aparición |
| 1.21 – 1.21.1 | `MC_1_21_1` | `btree20` | Cámaras de desafío |
| 1.20 – 1.20.6 | `MC_1_20_6` | `btree20` | Cerezal y ruinas de sendero |
| 1.19.3 – 1.19.4 | `MC_1_19_4` | `btree19` | Otra forma de calcular fortalezas |
| 1.19 – 1.19.2 | `MC_1_19_2` | `btree192` | Abismo, manglares y ciudades antiguas |
| 1.18 – 1.18.2 | `MC_1_18_2` | `btree18` | |

- Cada fila calcula la última revisión de esa rama. cubiomes aclara que se enfoca en esa revisión y que las intermedias son experimentales; acá no se probaron por separado.
- Nada anterior a 1.18: usa otro generador (capas), que no se portó.
- **Posteriores a 1.21.4 (1.21.5 a 1.21.11 y 26.x)**: cubiomes no las conoce por nombre. Se calculan con la fila 1.21.4 y la página lo dice. Hay evidencia a favor en las estructuras (ver abajo), pero los biomas de esas versiones no se comprobaron.

## Qué tan exacto es

| Qué | Estado | Detalle |
|---|---|---|
| Biomas del Overworld a 1:4 | Exacto respecto de cubiomes | Comparado celda por celda. Ver "Empates" abajo |
| Biomas al alejar el mapa | Exacto por muestra | Cada píxel es el bioma exacto de una sola celda 1:4, la del centro. cubiomes, a esas escalas, usa un atajo sin desplazamiento; acá no |
| Biomas del Nether | Exacto respecto de cubiomes | |
| Biomas del End hasta 1:16 | Exacto respecto de cubiomes | |
| Biomas del End más lejos | Aproximado, como cubiomes | `genEndScaled` con radio chico: coincide con cubiomes, pero no es el bioma exacto |
| Posición de una estructura | Exacta | Coincide con cubiomes y con listas públicas |
| Si una estructura aparece | **Estimación** | Biomas en un punto y altura del terreno estimada; puede sobrar o faltar alguna |
| Fortalezas (stronghold) | Exacto respecto de cubiomes | Incluye la dependencia del orden de MC-241546 |
| Punto de aparición | **Aproximado** | Es la estimación de `getSpawn`. La página lo dice |
| Slime chunks | Exacto | Misma fórmula del juego |

- **Empates (MC-241546)**: el juego arranca la búsqueda del bioma desde el resultado anterior de ese hilo, y en un empate el resultado depende del orden de generación. El mapa busca sin esa pista, como `genBiomes` de cubiomes a 1:4. Medido en 8 semillas: la pista cambia 153 de 524.288 celdas (0,03 %). En celdas como esas no se puede saber qué va a dar el juego.
- **Dudosas**: si la validación descarta una estructura solo por el terreno, o una ciudad antigua cuyo punto de control queda una celda arriba del Abismo, se muestra apagada en lugar de esconderla. Motivo: las listas públicas mostraron estructuras reales que la validación de cubiomes descarta (ver abajo). Esa regla es propia, no está comparada contra nada y no se sabe cuántas dudosas existen de verdad.
- **Sin tener en cuenta**: Biomas grandes, mundos Amplificados, datapacks y mods. Ciudades del End: no se portaron (hace falta el ruido de terreno del End); en el End solo se ven los biomas. Tampoco se muestran naufragios, portales en ruinas ni ruinas oceánicas, que no estaban pedidos.

## Cómo se verificó

Hay tres niveles, y ninguno es el juego abierto: no se levantó un servidor para no aceptar la EULA de Mojang en nombre del dueño.

### 1. Hashes publicados por cubiomes

`tests.c` de cubiomes publica `b6_hashes` para `testGeneration`: un hash de 4096 semillas con un punto de bioma cada una, por versión. El port da esos cuatro valores (1.18, 1.19.2, 1.19.4 y 1.20), igual que el binario de referencia (esa es la prueba de que se compiló bien). También pasa el ejemplo del README de cubiomes (semilla 262, Campos de hongos en el origen). En `pages/seeds/test/reference.test.js`.

### 2. cubiomes compilado en C, sobre muchas semillas

Compilación: la PC no tiene gcc, clang ni cl en el PATH y Visual Studio no tiene instaladas las herramientas de C. Se usó el Emscripten del módulo WebGL de Unity (3.1.39, clang 17), ya instalado en la PC, que compila a WebAssembly con enteros de 64 bits reales y `double` y `float` IEEE. cubiomes se compiló sin cambios, con `harness.c` al lado. Comandos en `pages/seeds/test/reference/build.txt`.

Comparación completa (`compare.js`), una sola vez, sobre las 7 versiones:

| Qué | Cantidad | Diferencias |
|---|---|---|
| Semillas | 240 (16 especiales: 0, -1, 2^48, los extremos de 64 bits y otras; 224 al azar) | |
| Celdas de bioma (Overworld en 4 alturas, Nether, End a 1:4, 1:16 y lejos, puntos lejanos y con paso) | 119.562.240 | 0 |
| Regiones de estructuras (11 tipos del Overworld, fortaleza del Nether y bastión) | 2.161.920 | 0 |
| Intentos comparados en posición, biomas y terreno | 1.939.145 | 0 |
| Estructuras válidas entre esos intentos | 379.467 | 0 |
| Fortalezas (las 128 en 16 semillas, las 3 primeras en las demás) | 19.040 | 0 |
| Puntos de aparición (estimado y final) | 1.680 | 0 |
| Slime chunks | 1.228.800 | 0 |

Las áreas se comparan por un hash encadenado celda por celda (el de `tests.c`), así que una sola celda distinta cambia el resultado. Las estructuras, una por una. Después de esta corrida solo se agregó `doubtful()`, que no toca nada de lo comparado, y el resumen de abajo se vuelve a comprobar en cada prueba.

Hubo una sola diferencia durante el trabajo y era del script de comparación, no del port: trataba la escala 1:4 de `genBiomes` como un paso de 4 celdas.

Lo que queda en el repo es un resumen: `reference/golden.json` (4 semillas, 1.260 casos: 1.992.704 celdas, 608 ventanas de estructuras y 334 fortalezas), que corre con las pruebas de siempre.

### 3. Coordenadas publicadas

Es lo más cerca del juego que se pudo llegar. Se buscaron listas públicas de semillas con coordenadas, consultadas el 3 de noviembre de 2026. Estos sitios no son una fuente firme: ninguno se pudo confirmar en el juego, y no se sabe cuántos usan herramientas basadas en el mismo cubiomes. Aun así, que coincidan a nivel de chunk en semillas elegidas por otros es una señal fuerte.

| Lista | Versión que declara | Coordenadas | Posición coincide | Además pasa la validación | Sin coincidir |
|---|---|---|---|---|---|
| [minecraft-guides.com, mansiones](https://www.minecraft-guides.com/seeds/1-21/mansion/) | 1.21 | 61 | 61 (exacta, a nivel de chunk) | 60 | 0 |
| [reishosting.com.br](https://reishosting.com.br/en/blog/the-35-best-seeds-for-minecraft-1-21) | 1.21 | 50 | 45 (a menos de 96 bloques) | 43 | 5 |
| [sparkedhost](https://blog.sparkedhost.com/minecraft/best-1dot21dot11-minecraft-seeds), [xgamingserver](https://xgamingserver.com/blog/best-minecraft-seeds/) y [craftmc](https://craftmc.net/minecraft-seeds) | 1.21.11 a 26.3 | 20 | 18 (a menos de 96 bloques) | 17 | 2 |

- La primera lista queda como prueba en `pages/seeds/test/published-seeds.test.js`.
- Las coordenadas de las otras dos listas están escritas a mano (un cofre, la entrada, un punto de la estructura). Las cinco y las dos que no coinciden están a entre 102 y 269 bloques del candidato más cercano. No se descarta que sean errores nuestros, pero en esas listas el resto coincide con ese margen.
- Las listas 1.21.11 a 26.3 se probaron con la fila 1.21.4. Es la evidencia a favor de esa fila, solo para estructuras.
- **Lo que mostraron**: la validación tiene falsos negativos. De las estructuras cuya posición coincidió, 2 de 12 ciudades antiguas y 2 de 16 mansiones están en las listas, pero la validación de cubiomes las descarta. Por eso existen las dudosas y por eso la página dice "estimación".
- **Punto de aparición**: tres semillas de xgamingserver publican su aparición. El port queda a 8, 10 y 192 bloques. Sirve de orientación, no como dato exacto.

### Qué no se verificó

- Nada contra el juego abierto.
- Biomas contra el juego, salvo lo que implica que las estructuras (que dependen de biomas) coincidan.
- Biomas de versiones posteriores a 1.21.4.
- Las revisiones intermedias de cada rama (por ejemplo 1.20.1 o 1.21.2).
- Si las estructuras dudosas existen o no, y cuántas de las que se muestran como válidas no están en el juego (falsos positivos).
- Los dígitos no ASCII que acepta `Long.parseLong` (por ejemplo arábigo-índicos) se tratan como texto; el juego los leería como número.

## Pruebas

```bash
node --test "src/renderer/js/pages/seeds/test/"
```

29 pruebas. Son lentas por los hashes publicados (4096 semillas por versión): tardaron 54 s en la última corrida y hasta 6 minutos con la CPU saturada por otros procesos. Para regenerar la referencia: `pages/seeds/test/reference/build.txt`. Nada de `test/` entra al paquete (`!src/**/test/**`).

## Rendimiento

Medido en un Ryzen 7 5700G (16 hilos lógicos):

Mientras se medía había otros agentes trabajando en la misma PC, con la CPU al 100 % buena parte del tiempo. Por eso hay valores con la PC libre y con la PC saturada, y conviene leerlos como órdenes de magnitud.

| Qué | Tiempo |
|---|---|
| Un pedazo de 128 × 128 en el Overworld, PC libre (Node) | 66 a 79 ms, unos 4,5 µs por muestra |
| El mismo pedazo en un Worker de la app, PC saturada | mediana de 168 a 279 ms |
| Un pedazo del Nether | 5 ms |
| Un pedazo del End | 1 a 11 ms hasta 1:16; unos 63 ms más lejos |
| Preparar una semilla | 0,46 ms Overworld, 0,14 ms Nether, 0,2 ms End |
| Decodificar una tabla de biomas | 0,6 ms |
| Una región de estructura | de 1 a 26 µs; monumento, 115 µs |
| Las 128 fortalezas | unos 3 s, de a 6 por vez, sin frenar el mapa |
| Punto de aparición | 3 ms |
| Vista completa en la app a 1300 × 820, 1 píxel = 8 bloques, PC saturada | 2,2 a 2,3 s con 4 Workers |
| Primera vista gruesa en la app | unos 0,2 a 0,3 s (dos mediciones válidas; las otras no servían porque el color de fondo no coincidía con el de la prueba) |
| Arrastrar el mapa mientras calcula, PC saturada | mediana de 7 ms por cuadro, p95 de 15 a 18 ms, peor cuadro de 42 a 104 ms |

No se midió en una PC lenta.

Por qué rinde así: lo caliente no usa BigInt (solo preparar la semilla). En el ruido, cambiar el `switch` de gradientes por una tabla dejó el clima en un tercio (de 6,8 a 2,4 µs), porque los índices son al azar y el procesador falla casi todos los saltos. En la búsqueda del bioma, la distancia va sin saltos y corta antes de tiempo.

Cómo reparte el trabajo: hasta 4 Workers (núcleos menos 2). Primero una vista gruesa dos niveles más arriba, para ver algo enseguida, y después el detalle del centro hacia afuera. Cada hilo pide un trabajo por vez al mapa, así que lo que dejó de verse simplemente no se pide. Hay un caché de 900 pedazos. Si el Worker no arranca, sigue en el hilo de la interfaz de a un pedazo (probado quitando `Worker`: tarda más, sin trabarla).

## Tamaño

Tablas: unos 476 KB en total (entre 90 y 98 KB cada una, en base64). Cada una se carga solo si se elige esa versión. Ocupan unos 110 KB de memoria por tabla una vez armadas. `reference/golden.json` y el resto de `test/` no se empaquetan.

## Textos

Namespace nuevo `seeds` en `src/renderer/i18n/{es,en}/seeds.js`. Solo español e inglés; faltan los otros 12 idiomas. Mientras tanto se ve el texto de respaldo.

## Para más adelante

- Abrir el asistente de servidores con la semilla cargada (`openCreateWizard({ seed })`, en `pages/servers/create.js`).
- Comprobar contra el juego abierto, si el dueño acepta la EULA en una carpeta de pruebas: `/locate` en unas semillas y comparar. Es lo que falta para sacar de "estimación" la validación de estructuras o medir los falsos positivos.
- Actualizar a la versión de cubiomes que cubra lo posterior a 1.21.4, cuando exista.
- Ciudades del End, si se pide (necesita el ruido de terreno del End de `finders.c`).
