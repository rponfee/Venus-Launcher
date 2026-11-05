# Buscador inteligente y CurseForge (4.6)

Trabajo del agente L. Dos partes: el arreglo de CurseForge y el Buscador inteligente (más vocabulario y la IA solo de pago). **No se desplegó ni se aplicó nada en producción**: todo lo de producción fue lectura (registros de la función `curseforge`, registro de acciones de Administración, un chequeo de la cuenta de prueba y la comparación del código desplegado). La clave de CurseForge no se leyó, no se mostró y no se tocó.

## 1. CurseForge: el bug de "no carga"

### Qué pasaba (evidencia)

Registros de la función `curseforge` en producción, últimas 24 horas (solo lectura, una única cuenta usa la función):

| Momento (UTC) | Qué se vio |
|---|---|
| 4 de noviembre, 17:09 a 17:58 | 29 respuestas 403 en búsquedas con la clave de CurseForge Profile; las categorías respondían 200. |
| 4 de noviembre, 17:59:12 | Se reemplaza la clave desde Administración (queda en el registro de acciones, 12 cambios ese día). Desde ahí **~110 búsquedas con 200** hasta las 22:57. |
| 5 de noviembre, 16:14 a 16:31 | **6 búsquedas del catálogo con 403**, las mismas formas de pedido que antes daban 200. A las 16:15:40 se vuelve a guardar la clave desde Administración y el siguiente pedido (16:15:45) y otro a las 16:31 siguen en 403. |

Lo que se pudo descartar:

- **No es la cuenta ni la sesión.** El 403 del servidor para una cuenta bloqueada es otro código (`forbidden`), y la cuenta cumple todas las condiciones de `curseforge_proxy_access` (existe, no está baneada, no es anónima, sin bloqueo social). Además esa RPC dejó su fila de cuota a las 16:31:39: el pedido **pasó** el control de acceso y llegó a CurseForge.
- **No es el código desplegado.** `get_edge_function` devuelve el mismo `handler.ts` e `index.ts` que el repo (v1, `verify_jwt = true`).
- **No son los parámetros de la búsqueda.** Los pedidos del 5 de noviembre tienen el mismo contrato y los mismos parámetros que los que respondieron 200 el 4.
- **No es el estado.** `curseforge_status` y la cuenta responden bien; falló la búsqueda, no el "configurado".

Entonces el 403 viene de `api.curseforge.com`. Una prueba mía con una clave inventada (no la real) mostró cómo contesta CurseForge: con una clave inválida, `403 text/plain "Forbidden: API Key missing or invalid"` (de su aplicación); sin la cabecera de clave, `403` vacío de CloudFront. **Y el proxy tiraba esa respuesta y devolvía siempre `badkey`**: desde afuera, y desde los registros, era imposible distinguir una clave mala de un corte del borde de CurseForge o de un archivo cuyo autor no permite la descarga. Eso es lo que impedía diagnosticar y lo que hacía que el launcher dijera "la clave fue rechazada" para todo.

> Con la información disponible **no se puede afirmar** si CurseForge rechazó la clave el 5 de noviembre o si bloqueó el pedido del servidor: esa respuesta nunca se guardó. La corrección de abajo hace que quede registrada (sin el texto remoto) y que la prueba de Administración lo diga.

### Causas encontradas en el código y qué se cambió

1. **El proxy colapsaba todo en `badkey` y descartaba la respuesta** (`supabase/functions/curseforge/handler.ts`). Ahora lee como mucho 4 KB del rechazo y lo clasifica **sin devolver ni registrar su texto**:
   - `badkey`: CurseForge dijo que la clave falta o no sirve.
   - `blocked`: el pedido no llegó a su aplicación (página HTML del borde, o 403 vacío de CloudFront).
   - `denied`: CurseForge entendió el pedido pero ese archivo/descarga no se puede pedir (autor sin distribución).
   El servidor deja una línea de diagnóstico en los registros de la función (`curseforge.rejected`, `curseforge.limited`, `curseforge.upstream`, `curseforge.network`) con estado, clasificación, tipo de contenido y el valor del encabezado `server`; nunca la clave, la sesión ni el cuerpo.
2. **Una consulta de estado caída contaba como "CurseForge no está configurado"** (`modules/curseforge/cloud.js`, `api.js`). Cualquier falla de red, timeout o 5xx de `curseforge_status` devolvía `false`, el catálogo mostraba la tarjeta "no disponible" y **no volvía a preguntar mientras la página seguía abierta**. Ahora el estado es `on`, `off` o `unknown`; si no se pudo preguntar se sigue con lo último que se supo (10 minutos) o se intenta igual (el servidor contesta con precisión), y la tarjeta "no disponible" aparece solo cuando el servidor dice que no hay clave. Además la tarjeta tiene **Revisar de nuevo** y se vuelve a revisar al iniciar sesión.
3. **Un 401 con un token que parecía vigente decía "iniciá sesión"** (reloj de la PC atrasado o sesión revocada). Ahora se pide una renovación a la interfaz una sola vez, se espera un token distinto y se reintenta; recién si no hay, se pide iniciar sesión.
4. **Sin sesión de Venus no había explicación**: ahora hay una tarjeta "Iniciá sesión para usar CurseForge" con el botón que lleva al inicio de sesión, en el catálogo y en el detalle de un proyecto.
5. **Los builds con clave propia no tenían respaldo**: si el catálogo central falla (clave rechazada, bloqueo, red o servidor) y el build trae su clave, el pedido se repite con esa clave. No se tapan la sesión vencida, la cuenta bloqueada ni un archivo inexistente.
6. **Errores con mensaje propio**: clave rechazada, cortado antes de revisar la clave, cuenta sin permiso, sin sesión, sin clave en el servidor, límite de consultas, servidor caído, red; en el catálogo los de servidor ofrecen **Volver a Modrinth**. `download-url` con `denied` sigue devolviendo "descarga manual".
7. **Administración → Probar búsqueda** explica `blocked`, `not_configured`, `unavailable` y `upstream` además de lo que ya explicaba.

### Qué hay que desplegar (y qué no)

Solo **la función `curseforge`**: `supabase functions deploy curseforge` (con `verify_jwt = true`, como está). Archivos que cambian: `supabase/functions/curseforge/handler.ts`; `index.ts` no cambia. **No hay migración, ni cambios en `admin`, `ai-assistant` ni `billing`.** El launcher funciona con la función vieja (cae al mensaje de clave rechazada como hasta ahora) y mejora con la nueva.

### Qué tiene que probar el dueño con su sesión real

1. Desplegar `curseforge` y, en Administración → Integraciones → CurseForge, **Probar búsqueda**. El mensaje dice cuál de estos casos es: funciona, **CurseForge rechazó la clave** (`badkey`: reemplazarla por la clave aprobada para el launcher), **CurseForge cortó la consulta antes de revisar la clave** (`blocked`: la clave puede estar bien; es un bloqueo del borde, probar de nuevo en unos minutos) o error propio de CurseForge.
2. En los registros de la función (Supabase → Edge Functions → `curseforge` → Logs) aparece la línea `curseforge.rejected` con `kind` y `server`.
3. Con la sesión de Venus iniciada, abrir Contenidos → CurseForge: tiene que listar mods; con la sesión cerrada tiene que mostrar la tarjeta de iniciar sesión.

**No se probó:** el recorrido completo con una sesión real y la clave real (no se las usó a propósito), el proveedor CurseForge, ni un despliegue.

### Pruebas

- `node --test supabase/functions/curseforge/tests/handler.test.ts` (66 pruebas; 11 nuevas: clasificación `badkey`/`blocked`/`denied`, HTML enorme, descarga con autor sin permiso, el registro no contiene claves ni texto remoto, 429/5xx/red).
- `node --test src/main/modules/curseforge/test/cloud.test.js` (23; 12 nuevas: estado `on`/`off`/`unknown`, falla pasajera del estado, un caso por cada falla con su código, búsqueda vacía, parámetros de búsqueda, renovación en 401, respaldo con clave compilada y lo que no tapa, clasificación del 403 directo, `getDownloadUrl`).
- `node --test src/renderer/js/pages/modrinth/test/curseforge-gate.test.js` (4, nuevas) y `node --test src/renderer/js/pages/admin/test/integrations.test.js` (28; 7 nuevas).
- Ventana de desarrollo con un servidor falso de Supabase (nunca producción): catálogo con resultados, clave rechazada, cortado por el borde, cuenta sin permiso, 429, 503, vacío, sesión vencida, sin sesión, sin clave en el servidor y consulta de estado caída (el catálogo igual carga), en español e inglés, con `console.log` vacío.

## 2. Buscador inteligente: más vocabulario

El intérprete local (`modules/smartsearch/interpreter.js`) ahora carga un **vocabulario ampliado como datos** en `modules/smartsearch/vocab/`; `lexicon.js` lo aplica al final sin pisar nada de lo que ya tenía. **Para entrenarlo con palabras nuevas se edita un archivo de esa carpeta**, no el código:

| Archivo | Qué agrega |
|---|---|
| `types.js` | sinónimos de tipos (modpack, resource pack, shader, data pack, plugin, mod), negaciones ("ni", "evitar", "no necesito"…), cantidades con letras ("cinco mods") |
| `loaders.js` | alias de cargadores, motores de shaders, software de servidor y "sin mods" |
| `modes.js` | modo de juego (servidor propio, con amigos, "mis amigos y yo", solo, sin conexión) y hardware (PC de papa, 4 GB de RAM, PC potente) |
| `themes.js` | sinónimos de 20 temas existentes y **27 temas nuevos**: mapas de aventura, pixel art, low poly, minimalista, futurista, steampunk, retro, gótico, neón, acuarela, moderno, recetas (JEI), encantamientos, aldeanos, progresión/habilidades, supervivencia (sed, temperatura), minerales, flora, agua, cielo, iluminación, fuentes, idioma, accesibilidad, emotes, cosméticos, modelos 3D |
| `words.js` | traducciones es/pt a inglés de 278 sustantivos sueltos |
| `typos.js` | 251 errores de escritura frecuentes y corrección difusa (Damerau-Levenshtein) contra el vocabulario propio |
| `similar.js` | "como X": 58 proyectos y juegos conocidos (Sodium, OptiFine, Create, Botania, Terralith, Hypixel, Terraria, Skyrim, RLCraft…) con los temas que representan |
| `versions.js` | rangos ("1.18 a 1.20", "1.19 o superior", "hasta la 1.16", "1.20.x", "1.19+") y apodos de actualizaciones ("nether update", "caves and cliffs") |

Idiomas: español, inglés y portugués, que son los que ya tenían diccionario. Los otros idiomas del launcher no tenían y no se agregaron.

Cambios en el intérprete (`interpreter.js`): corrige errores de escritura y resuelve apodos de versión antes de leer; elige una versión concreta dentro de un rango (`versionNote` avisa de dónde salió); cantidades con letras; "como X" (se detecta antes que los cargadores: "como sodium" no es el motor de shaders); y **las negaciones ya no pasan por encima de otro tipo** ("sin shaders, solo mods" excluye los shaders, no los mods; "que no explote con shaders" pide shaders).

### Medición (antes y después)

Corpus de 509 frases (49 tipos, 30 cargadores, 36 versiones, 107 géneros, 26 hardware, 51 estilos, 42 mecánicas, 41 "como X", 60 con errores de escritura, 31 oraciones completas, 16 que no deben despertar ningún tema y 20 que ya se entendían); `test/corpus.js`. Se mide con `node src/main/modules/smartsearch/test/score.js [carpeta-del-interprete-anterior] [--heldout] [--fails]`.

| Conjunto | Antes (commit anterior) | Después |
|---|---|---|
| Corpus de 509 frases | **44,2 %** (225/509); 56,7 % de los campos | **100 %** (509/509) |
| Frases "a ciegas" (89, escritas con el vocabulario ya congelado) | **66,3 %** (59/89) | **91,0 %** (81/89) en la primera pasada; 100 % después de entrenar con lo que falló |
| Frases que ya se entendían (20) | 90 % | 100 % (se arregló una negación mal leída) |

El 91,0 % a ciegas es la cifra honesta de generalización; el 100 % del corpus incluye lo que se entrenó viéndolo. Las 8 frases que fallaron en la primera pasada se agregaron como vocabulario ("muestre las recetas", "compras y ventas", "streamers", "mis amigos y yo", "alternativa liviana a", "para arriba", modpacks conocidos, "no" suelto que niega solo lo que tiene al lado).

Pruebas: `node --test src/main/modules/smartsearch/test/interpreter.test.js` (19: corpus y piso, vocabulario válido —todas las expresiones compilan, categorías de Modrinth reales, temas existentes, sin palabras demasiado genéricas—, errores de escritura, versiones, negaciones, cantidades, "como X" y planes completos).

## 3. Buscador inteligente: la IA solo de pago, con una sola fuente

Interruptor **"Usar IA para entender la búsqueda"** en los filtros de la página (y el cartel del encabezado, ahora "IA activada · Venus IA" o "Buscador normal").

Reglas (`modules/smartsearch/ai-source.js`, lógica pura):

1. **Solo con plan de pago de Venus IA.** Sin plan, sin sesión, con la IA apagada en Ajustes o si no se pudo comprobar el plan, el interruptor se ve apagado y deshabilitado con la explicación y el botón que corresponde (**Ver planes**, **Iniciar sesión**, **Comprobar de nuevo**, **Abrir ajustes de IA**). El buscador normal sigue funcionando igual.
2. **Una sola fuente a la vez.** Con plan hay hasta dos: **Venus IA** (el backend, gasta la cuota del plan) y **Claude Code o Codex de esta PC** (la IA propia de la persona, no gasta la cuota de Venus IA; se ofrece con plan **Go o superior**, la app instalada y con sesión iniciada: el mismo control que los motores del Asistente). Si hay las dos, se muestra un grupo de opciones y se elige una; nunca las dos. Con una sola, no hay nada que elegir.
3. **Aviso de privacidad** antes de mandar lo que escribe a un proveedor, una vez por fuente (qué se envía —lo que escribe hasta 400 caracteres, versión, loader y los títulos y descripciones públicos de los resultados—, qué no —cuenta de Minecraft, mundos, archivos, nombres de instancias— y el destino). Se guarda con la hora. Cambiar de fuente con la IA prendida pide el aviso de la otra; sin aceptarlo queda apagada.
4. **Sin plan o sin conexión cae al buscador normal**, con un aviso en el resultado (`aiNoPlan`, `aiSignedOut`, `aiPlanUnknown`, `aiDisabled`, `aiNeedsConsent`, `aiOffline`, `aiFailed`). Lo comprueba el proceso principal en cada búsqueda: la interfaz sola no alcanza.
5. La IA es opt-in: por defecto apagada. Quien tenía `useAi: true` de versiones anteriores (se guardaba sin avisar) queda apagada hasta aceptar el aviso.

IA local (`modules/smartsearch/local-ai.js`): lanza el `claude` o el `codex` tal cual lo instaló la persona, **sin herramientas** (Claude Code con `--tools ""`, `--setting-sources ""`, `--strict-mcp-config` sin servidores, un solo turno; Codex con caja de arena de solo lectura y sin shell), sin tocar sus credenciales, y devuelve solo un objeto JSON. **No se probó con el Claude Code ni el Codex reales**, solo con un CLI falso que imita su salida (`test/fixtures/fake-search-cli.js`); las banderas son las mismas que ya usan los motores del Asistente.

### Archivos, canales y ajustes

- Proceso principal: `modules/smartsearch.js` (`aiView`, `runnerFor`, canales), `smartsearch/ai-source.js`, `smartsearch/local-ai.js`, `smartsearch/ai-plan.js` (acepta quién responde), `smartsearch/fake.js` (modo falso para capturas).
- Canales IPC nuevos: `smartsearch:ai({ refresh? })` (estado de la IA) y `smartsearch:aiSet({ useAi?, source?: 'venus' | 'local', consent?: true })` (prender, elegir fuente, aceptar el aviso; el proceso principal vuelve a comprobar el plan). Cambian: `smartsearch:context` devuelve `ai` como objeto (`plan`, `planName`, `sources`, `choose`, `source`, `consent`, `wants`, `active`, `needsConsent`) y `smartsearch:savePrefs` ya no guarda la IA.
- Ajustes: `settings.smartsearch.prefs.{ useAi, aiSource, aiConsent: { venus, local } }` (por defecto apagada, sin aviso aceptado).
- Modo falso para capturas (solo con `VENUS_DEVSHOT`, nunca empaquetado): `VENUS_SMARTSEARCH_AI_FAKE=paid|both|basic|none|signedOut|unknown|disabled`.
- Pruebas: `node --test src/main/modules/smartsearch/test/ai.test.js` (22: planes, solo de pago, aviso, una sola fuente, plan Go para la local, motor preferido, IA local con CLI falso —argumentos sin herramientas, errores, tiempo, cancelación—, y el proceso principal completo con dobles: sin plan no se llama a la IA, sin aviso no se manda nada, con plan y aviso se usa Venus IA, sin conexión cae al buscador normal, con la fuente local no se toca Venus IA).

## 4. Textos (solo español e inglés)

- `src/main/i18n/{es,en}/curseforge.js`: `errBlocked`, `errDenied`. `src/main/i18n/{es,en}/smartsearch.js`: `errAi_noplan`, `errAi_consent`, `errAi_sourceUnavailable`, `errAi_badSource`.
- Namespace nuevo `src/renderer/i18n/{es,en}/curseforge.js` (cargado por la página de Contenidos): `offText`, `signInTitle`, `signInText`, `signIn`, `errorTitle`, `errorText`, `checkAgain`, `testBlocked`, `testNotConfigured`, `testUnavailable`, `testUpstream`.
- `src/renderer/i18n/{es,en}/smartsearch.js`: `aiSwitch`, `aiSwitchHintOn`, `aiSwitchHintOff`, `aiTitle_*`, `aiPillOn_*`, `aiPillOff`, `aiPillOffTitle`, `aiNoPlanText`, `aiSeePlans`, `aiSignedOutText`, `aiSignIn`, `aiUnknownText`, `aiRetry`, `aiDisabledText`, `aiOpenSettings`, `aiSource*`, `aiLocalHint_*`, `aiPrivacy_*`, `aiConsent*`, `aiNowOn`, `aiNowOff`, `aiSetFailed`, `warn_aiOffline`, `warn_aiNoPlan`, `warn_aiSignedOut`, `warn_aiPlanUnknown`, `warn_aiDisabled`, `warn_aiNeedsConsent`.
- **Claves viejas en los otros 12 idiomas que quedan sin uso:** `smartsearch.useAi`, `smartsearch.aiOff`, `smartsearch.aiOffHint` y `smartsearch.useAiHint` (las usaba el interruptor y el cartel viejos; `aiOn` y `aiConfigure` siguen en el archivo pero ya no se usan). Los 12 idiomas restantes verán en inglés los textos nuevos hasta que se traduzcan.

## 5. Límites y cosas que quedaron

- La causa exacta del 403 del 5 de noviembre depende de lo que conteste CurseForge; hasta desplegar la función nueva no hay forma de saber si fue la clave o un bloqueo (arriba).
- La línea de CurseForge del panel de estado de servicios solo prueba que el servidor de Venus responde, no que la clave sirva (no se tocó `svcstatus`).
- "Como X" solo entiende proyectos de la lista de `similar.js`; "como un modpack que no conozco" no lo trata como referencia (se agrega una línea).
- La fuente local (Claude Code/Codex) solo se probó con un CLI falso.
