# Perfiles de Venus

> Guía de la personalización del perfil (Venus 2.0): qué puede cambiar cada jugador, cómo se dibuja y cómo lo usan otras partes del launcher. Servidor: `supabase/migrations/0020_perfiles.sql` (perfil, Premium y bucket `profile-media`), la parte de cosméticos de `0021_puntos.sql` (tienda) y, para lo de la 3.1 (temas, burbujas, entrada en voz, estado con vencimiento, libro de visitas, regalos, canción y denuncias), `0027_perfil_social.sql`. Arquitectura general: [arquitectura.md](arquitectura.md).

## Para el jugador

**Mi perfil** (botón *Mi perfil* de Mensajes, tocar tu cabeza arriba de la lista de amigos o *Editar perfil* en tu propia tarjeta) abre el editor con una **vista previa en vivo** a la izquierda: la tarjeta tal como la ven tus amigos y cómo se ve tu nombre en su lista. Nada se guarda hasta tocar **Guardar**; al pie se avisa si hay *Cambios sin guardar*.

| Pestaña | Qué tiene |
|---|---|
| **Perfil** | Nombre visible, pronombres (hasta 24 caracteres), descripción (hasta 200), nombre de Minecraft (con *Usar mi cuenta*), estado y texto de estado, privacidad (compartir actividad, ausente automático, avisos) y tu código de amigo |
| **Estilo** | **Fade del perfil** (dos colores y un ángulo que pintan el fondo de la tarjeta, con 8 combinaciones sugeridas), **tipografía del nombre** (Venus, Pixel, Outfit, Serif, Mono, Redondeada, Condensada), **efecto** (sin efecto, resplandor, degradado con los colores del fade, destello, arcoíris y fuego), **color** del nombre y **brillo** (0 a 100) |
| **Banner** | 8 **diseños** pixelados (noche estrellada, atardecer, nebulosa, bosque, océano, Nether, End y aurora), una **imagen** propia (se recorta a 4:1, como mucho 1200 × 300, y se comprime en la PC con un control de *Encuadre*), un **GIF animado** (Premium, hasta 4 MB, se sube tal cual) o el **color clásico** de siempre |
| **Vitrina** | Hasta 5 **servidores favoritos** (con sugerencias de tus servidores guardados; en tu tarjeta tienen el botón *Unirme*), **Publicar mis estadísticas** (opcional: horas, partidas, versión y loader más usados y desde cuándo jugás, calculadas en tu PC y actualizadas cada vez que guardás) y hasta 3 **capturas destacadas** con título |
| **Cosméticos** | Lo que tenés de la tienda de Venus Points o viene con Premium: **marco** (Pixel, Neón, Oro, Venus), **título** (Explorador, Constructor, Redstoner, Leyenda, Colaborador), **estilo de la insignia** (Nebulosa, Hielo, Oro) y el **efecto del nombre comprado** |

- Lo que es de **Premium** se ve con una corona y un candado; tocarlo abre los planes. Lo que se compra en la tienda muestra el precio en Venus Points y lleva a la tienda.
- Los efectos animados se quedan quietos con *Reducir movimiento*, en las listas y con alto contraste (ahí el nombre se ve liso). El color del nombre se aclara solo si no se leería bien sobre el fondo de la tarjeta.
- **Compartir mi perfil** arma una imagen PNG de 1200 × 630 de tu tarjeta (banner, fade, cabeza con el marco, nombre con su estilo, título, insignia, descripción, estadísticas y servidores) para **Copiar imagen** o **Guardar PNG**. Se arma en tu PC con lo que ya es público en tu perfil.
- La **tarjeta de perfil** (ver el perfil de un amigo desde Mensajes) muestra todo lo anterior más lo que está jugando con *Unirme*, desde cuándo son amigos, el nombre de Minecraft, desde cuándo está en Venus y el código de amigo.

### Novedades de la 3.0

- **Rango** (`profiles.rank`: owner, admin, mod, helper): se ve en la tarjeta y en las listas. Lo cambia un admin desde su ficha en el panel (`admin_set_rank`, queda en el registro); `owner` se carga a mano y no se toca desde el panel. No da permisos: el acceso al panel sigue siendo `app_admins`.
- **Estilo**: 35 tipografías (28 fuentes libres en `assets/fonts/names`, tabla en `features/profile-editor/fonts.js`, CSS generado por `scripts/import-name-fonts.js`), fade con color del medio, mayúsculas, cursiva y contorno. **Tarjeta** (`card_style`): dibujo de fondo, forma de la cabeza, disposición y color de acento.
- **Banner**: 8 diseños más y **GIF de KLIPY**, para todos (`features/profile-editor/klipy.js`). Las condiciones de KLIPY piden que los pedidos salgan de la app y que las direcciones no se toquen ni se copien los archivos, así que el servidor no hace de intermediario: guarda la clave en el Vault (Administración → Integraciones) y el launcher la pide con `klipy_key`. Se muestra "Search KLIPY" en el buscador (obligatorio) y "Powered by KLIPY". Los filtros de contenido se ajustan en partner.klipy.com; el launcher pide `content_filter=high`.
- **Vitrina** (`showcase`): hasta 6 logros (solo desbloqueados), hasta 2 clips (solo compartidos por esa cuenta; `profile_public` no devuelve los vencidos), skin en 3D (se pide a Mojang recién cuando alguien toca el botón, `skins:publicSkin`), hasta 6 capturas, redes de sitios conocidos (`links`, `private.profile_link_ok`) y más estadísticas.
- **Cosméticos**: 9 marcos, 9 efectos y 12 títulos en `shop_items` (0023).

### Novedades de la 3.1

- **Estado con emoji y vencimiento** (`profiles.status_until`): en la pestaña Perfil, un botón de emoji (grilla de 60, `STATUS_EMOJIS`, con `openEmojiPicker` de `richtext.js`), el texto (hasta 70) y **Dura** (30 min, 1 h, 4 h, hasta mañana o siempre). Se guarda con `profile_set_status(p_emoji, p_text, p_until)` (valida el emoji y el largo) y, como siempre, `status_text` por la tabla. `profile_public` manda `statusText` vacío si venció; el listado de amigos pide `status_until` (con respaldo si la columna no existe) y lo blanquea en `social/backend.js: liveStatus`.
- **Temas de perfil** (`card_style.theme { id: none/nether/end/ocean/cherry/space/aurora, particles }`): selector con vista previa en Estilo (`themeGroup`); la tarjeta lleva las clases `pf-themed pf-theme-<id>` y `pf-particles` (`cardStyleAttrs` de `profile-style.js`). Las partículas piden Premium (o el ítem `extra_particles`, que hoy no se vende); con movimiento reducido o `data-ui-lite` quedan quietas o no se ponen.
- **Marcos animados y de temporada**: `frame_pulse` (1800), `frame_orbit` (2400), `frame_halloween` (1200) y `frame_xmas` (1200) en `shop_items` (0027), todo el año; CSS en `profile-style.css`, copia en `SHOP_CATALOG`, nombres en `rewards.item_frame_*` y `profile.frame_*`.
- **Cosméticos del Venus Pass** (solo el dibujo; los ítems los carga la migración del pase, 0026): marcos `season1` (anillo dorado y violeta que gira despacio), `season1legend` (el mismo con brillo y partículas), `season1free` (línea doble dorada, quieta) y `max` (negro con borde dorado y rojo animado); efecto de nombre `season1` (aurora que se desplaza); títulos `season1` "Pionero de Venus", `traveler` "Viajero" y `pro` "Pro" (`FRAMES`, `EFFECTS`, `PASS_EFFECTS` y `TITLES` de `model.js`). El servidor acepta `season1` en `private.profile_effects()` y lo exige comprado (`private.profile_effects_pass()`). Ver [venus-pass.md](venus-pass.md).
- **Pose y fondo de la skin 3D** (`showcase.skinPose`: stand/wave/sit/walk; `showcase.skinBg`: none/sunset/cave/end/snow): en la vitrina del editor, junto al interruptor de la skin. La tarjeta envuelve el visor de `pages/skins/viewer.js` en `.pf-skin-stage.pf-skin-pose-<pose>.pf-skinbg-<bg>`; las poses son CSS sobre `[data-part] > .sk-pose` (animaciones para saludar y caminar; quietas con movimiento reducido).
- **Insignias por logros raros** (`showcase.rareBadges`, hasta 3): se eligen entre los desbloqueados con rareza `epic` o `legendary` (`rarityOf` de `pages/achievements/catalog.js`, con `achievements_me.rarity` y `totalUsers`); la tarjeta los muestra como chips `.pf-rare-chip` con el ícono del logro. El servidor exige que el logro esté en `user_achievements`.
- **Burbujas de chat** (`card_style.bubble { style: default/round/pixel/sharp, color }`): en Estilo, con muestra. Mensajes aplica `bubbleAttrs(profile)` (clases `msg-bub-*` y variables `--msg-bub-*`) a los mensajes propios y a los del amigo; el texto se elige oscuro o claro y, si ninguno llega a 4.5:1, se corre el fondo hasta que se lea.
- **Efecto de entrada en voz** (`card_style.entry`: none/spark/nether/ender/snow): `voice/ui-room.js` detecta quién entra (`joinedMembers` de `social/logic.js`), pide su estilo (`fetchStyle`) y pone 1,5 s `vc-entry vc-entry-<fx>` más la etiqueta "entró" (`voice.entryJoined`); nada con movimiento reducido.
- **Libro de visitas** (tabla `profile_guestbook` + `card_style.guestbook`): interruptor en la vitrina del editor; la sección `social/guestbook.js` de la tarjeta muestra las últimas 10 con **Ver más**, deja escribir si son amigos (5 por día, hasta 200 caracteres) y borrar al autor o al dueño. RPC `guestbook_list`, `guestbook_post` (sin bloqueados ni baneados), `guestbook_delete`, `guestbook_set`.
- **Regalar** (`gift_send(p_to, 'points' | 'item', p_value)`): botón **Regalar** en la tarjeta de un amigo (`social/gifts.js`: pestañas Puntos / Cosmético, confirmación y errores traducidos). Puntos de 10 a 500 y hasta 1000 por día (`gift_out` / `gift_in` en `points_ledger`); ítems al precio normal, no premium ni repetidos. Bandeja: `startGiftWatch()` (lo arranca `app.js` y también Mensajes y las tarjetas) escucha `onSummary` de `features/rewards.js` y, con un `gift_in` nuevo, pide `gifts_received(p_since)` y avisa con un toast; `settings.rewards.lastGiftSeen` guarda hasta dónde se vio. El historial de Venus Points muestra `hist_gift_in` / `hist_gift_out`.
- **Canción de perfil** (`card_style.song { url, title }`): en Estilo, un archivo mp3/ogg/wav/m4a/webm de hasta 20 MB se decodifica (`AudioContext.decodeAudioData`), se eligen 30 s con un control de rango y se recodifica con `MediaRecorder` (`audio/webm;codecs=opus`, 96 kbps) en `profile-editor/audio.js`; al guardar sube `<uid>/song.webm` al bucket público `profile-audio` (1 MB, solo ese nombre). `profile_public` la devuelve solo a los amigos y al dueño; la tarjeta muestra `social/song.js` (play/pausa, volumen, silenciar, "No reproducir canciones de perfil" → `settings.social.profileSongs`).
- **Denunciar** (`social/report.js`, RPC `profile_report`, 10 por día): la canción o el contenido de un perfil. El panel de administración tiene la pestaña **Denuncias** (`pages/admin/reports.js`, `admin_profile_reports` y `admin_profile_report_close(p_id, p_remove_song)`).
- **GIF de KLIPY en Mensajes**: botón GIF del cuadro de escribir (`social/gifpicker.js`, reusa `klipy.js` con "Search KLIPY", grilla propia, "Powered by KLIPY" y `reportShare` al mandar). El mensaje es solo la URL (`isKlipyUrl`) y se dibuja como `<img>`; cualquier otra URL sigue como texto. Sin clave (`no_key`) el botón avisa que no está disponible.

## Datos y reglas del servidor

- Columnas nuevas de `profiles` (0020): `pronouns`, `theme { from, to, angle }`, `name_style { font, effect, color, glow }`, `banner_style { kind: 'preset' | 'image' | 'animated', preset? | url? }`, `favorite_servers [{ address, name? }]`, `public_stats` (null o `{ hours, sessions, topVersion, topLoader, since, updatedAt }`), `featured [{ url, title? }]`, `equipped { frame?, nameEffect?, badgeStyle?, title? }` (ids de `shop_items`) y `customized_at`. El banner viejo (`profiles.banner`, texto: preset o colores) sigue siendo el **color clásico** y se ve cuando `banner_style` está vacío.
- Se escriben **solo** con `profile_customize(p_patch)` (lo que no cambió no se manda). Errores (`errcode 22023`): `bad_<campo>`, `bad_field:<clave>`, `bad_request`, `premium_required:nameStyle` (destello, arcoíris y fuego sin Premium ni el efecto comprado), `premium_required:banner` (GIF sin Premium), `not_owned:<item>`; `user_banned` / `user_muted` (`42501`). El editor valida lo mismo antes de mandar (`model.js`) y traduce cada error.
- Nombre visible, nombre de Minecraft, texto de estado y el color clásico se guardan como siempre en la tabla (`social.updateProfile` o `cloud.updateProfile`); el estado y la privacidad con `social.setPrefs`.
- Se lee con `profile_public(p_user)` (camelCase, con `premium`). Las filas que carga `social.js` no traen el estilo: `profile-style.js` pide `id,name_style,theme,equipped,banner_style` de todos los que falten en un solo pedido y lo guarda 5 minutos.
- Imágenes en el bucket público `profile-media`, carpeta `<userId>/` (`banner-<id>.webp|jpg|gif`, `featured-<id>.webp|jpg`): hasta 12 archivos de 4 MB, GIF solo con Premium. Antes de subir se borran los archivos propios que ya no usa nada si no hay lugar; después de guardar se borran el banner y las destacadas reemplazados. `profile_customize` solo acepta URLs públicas de la carpeta del propio usuario.
- Premium: `isPremium({ force: true })` de `features/premium.js` si existe; si no, el `premium` de `profile_public`.
- Cosméticos: `shop_items` (si no responde, la copia `SHOP_CATALOG` de `model.js`) y `user_items` (lo comprado). Lo `premium_only` viene incluido con Premium.
- Sin sesión: diálogo con *Ir a Cuenta y nube*. Sin la migración 0020 (o el servicio caído) el editor deja cambiar los datos de siempre (la descripción va por la tabla) y avisa que el resto no está disponible; las tarjetas se dibujan con lo que haya.
- 0027 (3.1, idempotente; se aplica después de 0025 y 0026): `profiles.status_until timestamptz` (grant update a authenticated) y el tope de `card_style` / `showcase` sube a 2 KB (`profiles_custom3_size`). `profile_customize` reemplazada (copia de 0023 más `cardStyle.theme/bubble/entry/song/guestbook` y `showcase.skinPose/skinBg/rareBadges`) y `profile_public` reemplazada (agrega `statusText`, `statusUntil`, `song` solo para amigos y dueño, `showcase.rareBadges/skinPose/skinBg`; saca `song` de `cardStyle`). Ayudantes nuevos en `private`: `profile_effects_pass`, `card_themes`, `card_bubbles`, `card_entries`, `skin_poses`, `skin_bgs`, `profile_audio_url`, `card_theme_ok`, `card_bubble_ok`, `card_song_ok`, `guestbook_entry`. Error nuevo de `profile_customize`: `premium_required:cardStyle` (partículas del tema sin Premium ni `extra_particles`).
- Tablas nuevas con RLS y sin acceso directo (todo por RPC `security definer`): `profile_guestbook`, `profile_gifts`, `profile_reports`. RPC nuevas (`revoke` de public/anon, `grant execute` a authenticated): `profile_set_status`, `guestbook_list`, `guestbook_post`, `guestbook_delete`, `guestbook_set`, `gift_send`, `gifts_received`, `profile_report`, `admin_profile_reports` y `admin_profile_report_close` (las dos con `admin_guard()`). `points_ledger.reason` admite `gift_in` y `gift_out`.
- Bucket **público** `profile-audio` (1 MB, solo `audio/webm`) con políticas como las de `profile-media`: cada usuario escribe solo `<uid>/song.webm`. El archivo queda público por URL (la tarjeta solo lo ofrece a los amigos): si se cierra una denuncia con "Quitar la canción", el perfil deja de apuntarlo pero el archivo sigue hasta que el dueño suba otro; para borrarlo del todo, Storage → profile-audio → carpeta del usuario.
- Las partículas del tema piden Premium o el ítem `extra_particles`, que hoy no existe en `shop_items` (se puede dar a mano con `user_items`). La clave de KLIPY sigue siendo la de 0023 (Administración → Integraciones): sin ella, el botón GIF de Mensajes avisa que no está disponible.

## Para otras partes del launcher

**`src/renderer/js/social/profile-style.js`** (contrato 5 de la 2.0). Acepta el perfil en camelCase (`profile_public`) o la fila de `profiles` (snake_case).

| Export | Qué hace |
|---|---|
| `ensureProfileStyle() → Promise` | Carga `styles/features/profile-style.css` y el namespace `profile` (esperalo antes de dibujar títulos) |
| `styledName(profile, { size?: 'sm' \| 'md' \| 'lg', title?: true, animate? }) → Element` | Nombre con tipografía, efecto, color y brillo (y el título equipado con `title`). `sm` hereda el tamaño de la fila, sigue el `…` del contenedor y no anima |
| `applyFrame(el, profile)` | Pone o saca el marco equipado (clases `pf-frame pf-frame-<estilo>`; ajustá `--pf-frame-w` y `--pf-frame-r`) |
| `bannerEl(profile, { cls? }) → Element` | Banner (`.pf-banner`): diseño, imagen, GIF (quieto con movimiento reducido) o el color clásico |
| `gradientCss(profile) → string` | `linear-gradient(<ángulo>deg, <desde>, <hasta>)` del fade o `''` |
| `titleLabel(titleId) → string` | Texto del título (`'title_legend'` o `'legend'`) |
| `cardStyleAttrs(profile)` | Tema de la tarjeta (3.1): clases `pf-themed pf-theme-<id>` y `pf-particles` para el contenedor de la tarjeta |
| `bubbleAttrs(profile)` | Burbujas de chat (3.1): clases `msg-bub-*` y variables `--msg-bub-*` para un mensaje de Mensajes, con texto legible sobre el color elegido |
| `entryEffectOf(profile)` · `fetchStyle(id)` | Efecto de entrada en voz del perfil (3.1) · estilo de un usuario (con la caché de 5 minutos) |
| Extras | `premiumChip(profile)`, `rankChip(profile)`, `normalize(profile)`, `nameColor(profile)`, `bannerBackgroundCss(profile)`, `primeStyles(ids)`, `setStyleCache(id, profile)`, `FONT_STACKS` |

**`src/renderer/js/social/profile-ui.js`**: además de lo de siempre, `profileCard(profile, { full?, preview?, presence?, statusText?, friend?, compact? })`, `openProfile(userId, { profile? })` (abre con lo que haya y se completa con `profile_public`), `previewProfile(profile, { title?, presence? })` (tarjeta completa de un perfil que ya tenés, por ejemplo para mostrar un cosmético), `fetchPublicProfile(userId, { force? })` y `openMyProfile()` (abre el editor).

**`src/renderer/js/features/profile-editor.js`**: `openProfileEditor({ tab?: 'identity' | 'style' | 'banner' | 'showcase' | 'items' })`, `openShareProfile({ profile? })` y `featureCapture({ src, title? }) → Promise<boolean>` para **Capturas y clips** ("Destacar en mi perfil"): `src` es una URL `file:`, `data:` o `blob:` (o un `Blob`); achica la captura a 1600 × 900, la sube y la agrega a las destacadas (si ya hay 3, pregunta si reemplaza la primera).

**Lógica pura** en `features/profile-editor/model.js` (sin DOM ni imports): `normalizeProfile`, `mergeProfiles`, `validateField`, `validatePatch`, `customOf`, `canonical`, `buildPatch`, `parseCustomizeError`, `publicStatsFromReport`, `gradientCss`, `presetCss`/`presetLayers` (los banners salen de la misma descripción en CSS y en el lienzo), `readableColor`, `fadeSurface`, `glowFilter`, `cropRect`, `fitSize`, `mediaFileName`, `orphanMedia`, catálogos (`FONTS`, `EFFECTS`, `BANNER_PRESETS`, `FRAMES`, `TITLES`, `BADGE_STYLES`, `SHOP_CATALOG`, `LIMITS`; desde la 3.1 también `PASS_EFFECTS` y `STATUS_EMOJIS`).

**Lo social de la 3.1** (`src/renderer/js/social/`, dueño perfiles; contratos en [arquitectura.md](arquitectura.md), 6.1): `gifts.js` (`openGiftDialog(friend)`, `startGiftWatch()`), `guestbook.js` (`guestbookSection(ownerId, { isMe?, isFriend?, preview? }) → Element`), `song.js` (`songPlayer(song, { name?, autoplay? }) → Element`, `songsAllowed()`, `setSongsAllowed(on)`, `stopSongs()`), `report.js` (`openReportDialog({ id, name?, hasSong? })`), `gifpicker.js` (`openGifPicker(anchor, onPick)`, `closeGifPicker()`) y `logic.js` (lógica pura: `joinedMembers`, `canPostGuestbook`, `mergeGuestbook`, `oldestGuestbookAt`, `newGifts`, `latestGiftAt`, `hasNewGiftIn`, `shouldAutoplaySong`, `volumeStep`, `ENTRY_EFFECT_MS`, `GUESTBOOK_PAGE`). La canción se prepara con `features/profile-editor/audio.js` (`audioSupported`, `decodeAudio`, `clipBuffer`, `encodeWebm`, `prepareSong(file, { start, onProgress, signal })`, `uploadSong(blob)`, `removeSong()`). Estilos en `styles/features/profile-social.css`; textos nuevos en `profile` (`cardTheme*`, `bubble*`, `entry*`, `song*`, `status*`, `skinPose*`, `skinBg*`, `rareBadge*`, `guestbook*`, `gift*`, `report*`, `adminReport*`), `messages` (`gif*`), `voice` (`entryJoined*`) y `rewards` (`hist_gift_*`, `item_frame_*`).

## Cómo verificar

```bash
node --test "src/renderer/js/features/profile-editor/test/"
node --test "src/renderer/js/social/test/"      # lógica pura de la 3.1 (libro, regalos, canción, entrada en voz)
```

Para ver lo de la 3.1 sin servidor: el editor en modo demo (`openProfileEditor({ demo: 'premium', tab: 'style' })`) y Mensajes con `import('./js/social/devmock.js').then((m) => m.install())` (Ringo y Tomás tienen burbujas personalizadas). Lo que habla con el servidor (guardar, libro, regalos, canción, denuncias, GIF) necesita la 0027 aplicada y una cuenta.

Capturas sin servidor (solo con `VENUS_DEVSHOT`; datos de `features/profile-editor/demo.js`):

```bash
VENUS_DEVSHOT=<carpeta> VENUS_DATA_DIR=<carpeta-temporal> VENUS_SKIP_ONBOARDING=1 \
VENUS_DEVSHOT_ROUTES="messages|import('./js/features/profile-editor.js').then((m) => m.openProfileEditor({ demo: 'premium', tab: 'style' }));0;;messages|import('./js/features/profile-editor/demo.js').then((d) => d.openDemoCard('free'));0;;messages|import('./js/features/profile-editor.js').then((m) => m.openShareProfile({ demo: true }));0" \
  ./node_modules/.bin/electron .
```

`demo: 'premium'` o `'free'` (cuenta sin Premium, con candados). En modo capturas, *Guardar* no habla con el servidor y *Copiar imagen* / *Guardar PNG* no tocan el portapapeles ni abren el diálogo.

## Integración social de 4.5.0

Implementada en la rama, sin publicar; producción continúa hasta 0027. Las tablas y RPC completas se conservan en [Clanes y comunidades](implementacion/clanes-comunidades.md), [Capas](implementacion/capas.md) y [Mensajes y voz](implementacion/mensajes-voz.md).

- **Tag del clan:** `features/clans/tag.js` se integra en la tarjeta social. No implica compartir estadísticas. El ranking público del clan requiere `clan_prefs.share_playtime` y `ranking_prefs.share`, ambos activos; el primero es un consentimiento separado, apagado por defecto. El total exige dos participantes y queda visible a cuentas con sesión, sin garantía de anonimato.
- **Consentimiento:** `clan_me()` devuelve `sharePlaytime` en la raíz, incluso sin clan; `clan_share_playtime(p_share)` devuelve el nuevo booleano. La preferencia pertenece a la cuenta, se conserva al cambiar de clan y afecta horas ya informadas de la semana.
- **Capas:** 0034 usa `user_capes`, `cape_equip`, `cape_mine` y `badge_capes`; no guarda la capa en `profiles.equipped` ni reemplaza `profile_customize`. Hay una capa por cuenta Venus para sus cuentas Minecraft verificadas. Las oficiales tienen prioridad; otros jugadores necesitan el mod Venus. La caché del mod puede demorar un cambio hasta 30 min.
- **Stickers:** 0030 guarda archivos públicos por URL. No convertir la privacidad de la conversación en una promesa de privacidad del archivo. El texto de avisos de sticker/GIF se genera por `social/preview.js`.
- **Dispositivos:** `cloud.signOut()` cierra solo la sesión local. La PWA conserva la suya y sus avisos hasta salir o revocar sus permisos allí.

Minecraft real, Realtime con dos cuentas, permisos efectivos de SQL nuevo y celulares siguen pendientes de la [validación final](estado-4.5.0.md).
