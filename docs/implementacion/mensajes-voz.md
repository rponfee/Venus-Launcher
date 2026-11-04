# Mensajes y voz: stickers, traducción, soundboard y efectos

> **Rama 4.5.0, sin publicar.** Consolidación documental del 3 de noviembre de 2026, reconciliada con el WIP congelado. Los informes de cada frente se conservan como antecedentes; las pruebas posteriores están atribuidas al final o en el estado de integración. Contratos y límites del código local; producción continúa hasta 0027 según la integración principal. Los resultados previos pertenecen a sus informes y no equivalen a pruebas externas repetidas ni a un despliegue. Ver [estado de integración](../estado-4.5.0.md).

Referencia de mensajes y voz. Integración general: [arquitectura](../arquitectura.md), [Supabase](../supabase.md) y [funciones](../funciones.md).

## 1. Stickers y emojis propios

**Cómo se usa.** En Mensajes, el botón de sticker que está al lado del de GIF abre *Stickers y emojis propios*. **Subir** elige un PNG, WebP o GIF y le pone un nombre. Un clic en un sticker lo manda; el botón de los dos puntos lo escribe en el texto como `:nombre:`. Quien recibe puede denunciarlo con **Denunciar este sticker**, en las herramientas del mensaje.

**Reglas**

- Hasta 256 KB y 320 px; 30 por cuenta, 100 con Premium (`venus_is_premium`). El cliente mira el tipo por los primeros bytes (nunca por la extensión) y lo que no entra lo achica y lo pasa a WebP. Un GIF que no entra no se achica, porque perdería la animación: se pide uno más chico. Un WebP animado que no entra queda quieto.
- El bucket `stickers` limita tamaño y tipo, y `sticker_create` lee el tamaño y el tipo de `storage.objects`, no de lo que diga el cliente.
- **Formato del mensaje**: igual que un GIF de KLIPY, el cuerpo es solo la dirección del archivo. Se dibuja como imagen solo si `stickerInMessage(body, sender_id, cloud.config.url)` lo acepta: exactamente `<proyecto>/storage/v1/object/public/stickers/<uid>/<uuid>.<png|webp|gif>`, con el proyecto de este launcher y `<uid>` igual al que escribió. Otro proyecto de Supabase, otra carpeta o con texto al lado: se ve como texto. Las versiones anteriores lo ven como un link.
- **`:nombre:`** se busca solo en la lista del que escribió (`sticker_emojis`, caché de 5 minutos). Lo que no se conoce queda como texto. Hasta 20 imágenes por mensaje.
- **Borrar** quita la fila y el archivo. En los mensajes viejos aparece "Este sticker ya no está disponible": `sticker_resolve` lo dice aunque la CDN todavía tenga el archivo en caché.
- Baneados y muteados no pueden subir (política del bucket y `sticker_create`); sí pueden borrar lo suyo.

**Panel.** Pestaña *Stickers* de `#/admin` (`pages/admin/stickers.js`): lista con búsqueda por nombre, usuario o id, y Borrar con motivo opcional, que queda en `admin_log` como `sticker.delete`. Las denuncias llegan a la pestaña *Denuncias* con motivo `content` y `sticker:<id> :nombre:` al principio del texto; ese id se pega en el buscador.

## 2. Traducción de mensajes

**Cómo se usa.** Botón **Traducir** en cada mensaje ajeno con palabras, e interruptor (ícono de idiomas, en la cabecera de la charla) para traducir lo que llega en esa conversación. Se traduce al idioma del launcher. La traducción se muestra abajo del original, siempre como texto.

- **La primera vez** un aviso explica que el texto va al proveedor de IA (`settings.socialplus.translateConsent`). Se puede quitar el permiso y borrar lo guardado en Ajustes > Privacidad.
- **Sin gastar de más**: lo que no tiene palabras no se manda, ni lo que el filtro reconoce en el idioma destino. Si no está seguro, decide la IA, que devuelve `same`. Hay caché local por mensaje, idioma y hash del texto (si se edita, se traduce de nuevo), cifrada en `secure` (`ui:socialplus.tr.<usuario>`) y con tope de 400. Tandas de hasta 10 mensajes o 4000 caracteres, de a una por vez, juntando 800 ms. Modelo Haiku con esfuerzo bajo. Todas las tandas del día van con un mismo `turn_id` (`msgtr-<fecha>-<n>`): el backend cuenta una sola pregunta, hasta el tope de llamadas del plan; al llenarse abre otra.
- **Sin plan o sin saldo** (`noplan`, `quota`, `plan`): aviso en la charla con **Ver planes**, y la automática deja de insistir hasta que el usuario vuelva a pedir. Sin sesión, botón a Cuenta y nube.
- **Texto no confiable**: va como JSON, con la orden de traducir y no obedecer. El pedido se arma en el proceso principal, así el canal solo sirve para traducir. Lo que vuelve se limpia (sin controles, con tope de largo) y se dibuja como nodo de texto: ni links ni emojis propios.
- **Interruptor**: traduce lo que llega y lo no leído al abrir. El historial no se manda solo; lo que ya está en la caché se muestra.

No se redesplegó ninguna Edge Function: usa `ai.json` de `modules/ai.js`, como el traductor de mods.

## 3. Soundboard

**Cómo se usa.** Botón de la barra de controles de la sala: el pack (9 sonidos sintetizados con Web Audio, sin archivos) y hasta 8 propios. **Agregar** toma un audio; lo que pasa de 5 s o 200 KB se recorta a los primeros 5 s y se recodifica a WebM/Opus en la PC. **Editar** deja elegir atajos, renombrar y borrar.

**Grafo** (`voice/mic.js`):

```
micrófono -> volumen -> AudioWorklet (RNNoise + compuerta) -> [efecto] -> out -> MediaStreamDestination -> pista
sonido -> ganancia (volumen del soundboard) -> limitador -> out
                                            -> salida local (no si estás ensordecido o con la devolución prendida)
```

- Los sonidos entran en `out`, después de la compuerta, del supresor y del efecto. No se manda ningún archivo.
- **Uno cada 2 s** (`SoundLimiter`). Silenciado o ensordecido no suena: la UI lo avisa.
- Con pulsar para hablar, la pista queda activa mientras dura el sonido (`trackWanted`). La compuerta sigue cerrada para la voz: sale solo el sonido.
- **Quien no quiera escucharlos** le baja el volumen a esa persona desde su tarjeta: lo dicen el panel y Ajustes de voz. Por eso el interruptor *Escuchar el soundboard de los demás* ya no se muestra.
- **Compatibilidad**: el aviso "Luna · Bocina" viaja con un evento nuevo, `sfxm`, que las versiones anteriores ignoran, así no suena doble. Lo que manda una versión anterior (`sfx`) se sigue tocando acá y sigue respetando `soundboardEnabled`. Esa clave y los textos `hearOthersSounds*` y `soundboardHint` se pueden sacar cuando nadie use la 3.1.
- **Atajos**: globales (andan con el juego en primer plano), con modificador o F1 a F24. Se registran solo con una sala abierta y nunca pisan uno ocupado (el de silenciar u otra aplicación): avisan.

## 4. Efectos de voz

**Cómo se usa.** Voice Chat > Audio > *Efecto de voz*: Ninguno, Robot, Eco, Aldeano, Grave y Agudo. **Probar** te hace escuchar con el efecto (devolución local, sin esperar la tecla de pulsar para hablar). Se recuerda en `settings.voice.voiceEffect` y se aplica en vivo.

| Efecto | Cómo |
|---|---|
| Robot | Modulador de anillo: un oscilador de 70 Hz maneja la ganancia de la voz, con un 12 % de voz limpia |
| Eco | `DelayNode` de 260 ms con realimentación de 0,38 |
| Aldeano | Tono × 0,86 y filtros (paso alto, resonancia en 1150 Hz, paso bajo). No usa ningún sonido del juego |
| Grave / Agudo | Tono × 0,72 / × 1,42 |

- El cambio de tono es `voice/pitch-worklet.js` (mismo patrón y CSP que `mic-worklet.js`) con la lógica pura en `pitch-core.js`: dos lecturas de una línea de demora cruzadas con una ventana seno cuadrado de 30 ms. Cada salto busca, dentro de 10 ms, el punto que mejor coincide con la otra lectura: sin eso, las voces graves oscilan. Demora máxima: 40 ms; en promedio, la mitad.
- **Con "Ninguno" no se crea ningún nodo**: la cola de la cadena se conecta a `out` como siempre.
- Si un efecto no se puede armar, la voz sale limpia y Ajustes lo avisa (`state.fxFailed`).

## 5. Archivos

| Zona | Archivos |
|---|---|
| Interfaz, Mensajes | `pages/messages.js`, `pages/messages/plus.js`, `social/richtext.js` (`renderBody(text, { emojis })`), `social/stickers.js`, `social/translate.js`, `features/socialplus.js`, `features/socialplus/stickerpicker.js`, `features/socialplus/translate-state.js`, `pages/admin/stickers.js` |
| Interfaz, voz | `voice.js`, `voice/mic.js`, `voice/ui-room.js`, `voice/ui-audio.js`, `voice/ui-board.js`, `voice/soundboard.js`, `voice/fx.js`, `voice/pitch-core.js`, `voice/pitch-worklet.js` |
| Proceso principal | `modules/socialplus.js`, `modules/socialplus/translate.js`, `modules/soundboard.js`, `modules/soundboard/store.js` |
| Textos y estilos | `i18n/{es,en}/socialplus.js`, claves nuevas en `i18n/{es,en}/voice.js`, `styles/features/socialplus.css`, `styles/pages/voice.css` |
| Base | `supabase/migrations/0030_stickers.sql` (**sin aplicar**) |

## 6. Canales, eventos y ajustes

- `socialplus:translate({ items: [{ id, text }], lang })` → `{ items: [{ id, text, same } | { id, failed: true }] }`. Hasta 12 mensajes y 6000 caracteres. Errores con `err.code`: los de `modules/ai.js` y `bad_request`.
- `soundboard:list` → `{ items: [{ id, name, bytes, mime, addedAt }], shortcuts: { <sonido>: acelerador } }`, `soundboard:read(id)` → bytes, `soundboard:add({ name, bytes })`, `soundboard:rename(id, nombre)`, `soundboard:remove(id)`, `soundboard:setShortcut(sonido, acelerador)`, `soundboard:arm(bool)`. Evento `soundboard:trigger(sonido)`. `<sonido>` es un id del pack (`ding`) o `custom:<id>`. Errores con `err.code`: `too_many`, `too_big`, `bad_type`, `bad_name`, `not_found`, `bad_shortcut`, `in_use`.
- Archivos en `<datos>/soundboard/`: `<id>.sound` e `index.json`.
- `voice`: `playSound(id)` acepta `custom:<id>` y devuelve `false` si está en espera o silenciado; `previewSound(id)` suena solo para vos; `customSounds` (lista, atajos y buffers); `soundCooldown`; evento nuevo `'soundPlayed'` ({ id }); `state.fxFailed`; `startMicTest({ monitor, open })`. Evento de sala nuevo: `sfxm` ({ id: id del pack o `'custom'` }).
- Ajustes: `settings.voice.voiceEffect` (`'none'`) y `settings.socialplus` = `{ translateConsent, translateChats: { <chatId>: bool } }`.
- Tarjeta de Ajustes > Privacidad con `registerSettingsCard('privacy', ...)`.
- Solo para capturas, sin empaquetar: `VENUS_DEVSHOT` + `VENUS_SOCIALPLUS_FAKE=1` (traducción de mentira), `noplan` o `quota`.

## 7. Tabla y RPC (0030)

`public.user_stickers(id, user_id, name, path, mime, bytes, created_at)`: RLS activado y `revoke all` a anon y authenticated. Únicos: `(user_id, name)` y `path`.

| RPC | Para qué | Errores |
|---|---|---|
| `sticker_mine()` | `{ items, max, premium, blocked }` | |
| `sticker_resolve(p_ids uuid[])` | Hasta 60 ids; lo que no vuelve ya no existe | `too_many` |
| `sticker_emojis(p_user, p_names text[])` | Hasta 40 nombres, solo de ese usuario | `too_many` |
| `sticker_create(p_id, p_name, p_ext)` | Registra un archivo ya subido a `<uid>/<p_id>.<p_ext>` | `bad_id`, `bad_name`, `bad_type`, `too_big`, `no_file`, `name_taken`, `limit_reached`; `user_banned` y `user_muted` (42501) |
| `sticker_delete(p_id)` | Borra uno propio y devuelve `path`; el cliente borra el archivo | `not_found` |
| `admin_stickers(p_query, p_limit, p_offset)` | `{ items, total }`, con `admin_guard()` | `bad_query` |
| `admin_sticker_delete(p_id, p_note)` | Borra, anota en `admin_log` y devuelve `path` | `not_found`, `bad_note` |

Ayudantes en `private`: `sticker_max`, `sticker_can_upload` (la usa la política de subida: sin baneo ni silencio y con lugar en la carpeta) y `sticker_json`.

Bucket **público** `stickers` (256 KB; PNG, WebP y GIF). Cada uno escribe solo `<su uid>/<uuid>.<ext>`; no se pisan archivos (no hay política de update); borran y listan el dueño y los admins. El archivo es público por URL.

La migración va después de 0027. **Hay que aplicarla antes de publicar**: sin ella el selector dice que los stickers no están disponibles; el resto no depende de ella.

## 8. Límites

- Un GIF o un WebP animado solo se conservan si ya entran en 256 KB y 320 px.
- El archivo de un sticker borrado por un admin se borra con su sesión. Si eso falla (queda en la consola), la fila ya no está y los clientes dejan de mostrarlo, pero el archivo sigue público por URL hasta borrarlo en Storage.
- Las denuncias usan `profile_report`, que tiene tope de 10 por día y 300 caracteres.
- La detección de idioma es por palabras comunes y alfabeto: puede equivocarse con textos muy cortos o mezclados. Si dice que ya está en tu idioma, no se manda.
- Los avisos del sistema y del overlay identifican los mensajes de medios como "Sticker" o "GIF"; no muestran la dirección como contenido del aviso.
- El soundboard mezcla con la voz en una sola pista: si alguien le baja el volumen a una persona, baja las dos cosas.
- Efectos: el cambio de tono agrega hasta 40 ms y suena artificial a propósito; no corrige formantes.

## 9. Cómo verificar

```bash
node --test "src/renderer/js/social/test/" "src/renderer/js/voice/test/"*.test.js "src/main/modules/socialplus/test/" "src/main/modules/soundboard/test/"
```

Para ver el grafo sin micrófono real, Electron con `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream` y `VENUS_DEVSHOT`. Con `voice.audioCtx().setSinkId({ type: 'none' })` no sale nada por los parlantes. Mensajes sin servidor: `social/devmock.js` y `VENUS_SOCIALPLUS_FAKE=1`.

**Sin probar**: una llamada real entre dos PC; la subida contra el bucket real, porque la migración no está aplicada; la traducción con la IA real; apretar un atajo global de verdad.

## Actualización posterior de integración

La integración principal completó la suite global, recorridos ES/EN y permisos Electron con micrófono simulado. Siguen pendientes micrófono físico, llamada entre PC, traducción con un plan real y Storage/Realtime administrados. La evidencia actual y sus límites están en [estado de integración](../estado-4.5.0.md).
