# Perfil 4.6: avatar siempre circular y banners sin diseños ni GIF propios

El dueño pidió: *el avatar del perfil es siempre circular y no se puede cambiar*, *sacar los presets de banners* (dejando el color clásico) y *sacar la subida de GIF propios al banner*. Este documento cuenta qué se hizo, cómo se usa y qué queda por saber. Servidor: `supabase/migrations/0039_perfil_circular_banners.sql` (sin aplicar). La guía general sigue siendo [perfiles.md](../perfiles.md); las partes de ese documento que esta versión deja viejas están al final.

## Cómo se usa

- **Avatar.** La cabeza de un perfil de Venus es un círculo en todas partes: tarjeta de perfil, editor y su vista previa, lista de amigos y Mensajes (lista, encabezado del chat, avatar de cada mensaje y de la conversación vacía), salas de voz (avatar y anillo de quien habla), Comunidades, libro de visitas, regalos, Compartir mi perfil (la imagen PNG), el punto de presencia y los marcos. En **Mi perfil → Estilo** ya no está *Forma de la cabeza*. **Disposición** (clásica o centrada) se conserva.
- **Banner.** En **Mi perfil → Banner** hay tres tipos, y arriba una tira con el banner tal como se ve (4:1):
  1. **Color clásico** (el de por defecto): el degradado o color de siempre, el de la columna `profiles.banner`. No se sube nada.
  2. **GIF de KLIPY**: el buscador de siempre (sin cambios).
  3. **Imagen**: PNG, JPG o WebP **quietos**. Se recorta a 4:1 (como mucho 1200 × 300) y se comprime en la PC antes de subirla, con el control de *Encuadre*. **GIF, APNG y WebP animado se rechazan** con un aviso (`errMedia_animated`); para un banner en movimiento está KLIPY.
  Ya no hay *Diseños* (los 16 banners pixelados) ni *Animado* (el GIF propio de Premium). Quien tenía uno de esos pasa al color clásico.
- **Editor.** La pestaña Estilo está en tres secciones con un atajo arriba (**Tarjeta**: fade, dibujo, tema, disposición y acento; **Nombre**: tipografía, efecto, color y brillo; **Chat y voz**: burbujas y entrada). Al cambiar de pestaña vuelve arriba. Lo que no es de este tema (selector de *Marco*, canción) quedó como estaba.

## Avatar siempre circular

| Qué | Cómo |
|---|---|
| Dibujo | `.sc-head` (la clase que `headImg()` de `social/profile-ui.js` le pone a cada cabeza de perfil) y las cabezas de amigos de otras pantallas llevan `border-radius: 50% !important`. La regla está **al final de `styles/main.css`** (hoja global, siempre cargada) porque cada pantalla le ponía su propio radio y las de otros agentes siguen cambiando. |
| Pantallas cubiertas | `.sc-head` (tarjeta, editor, Mensajes, Comunidades, grupo, libro de visitas, regalos…), `.vc-avatar` y `.vc-ring` (voz), `.hm-av-img` (inicio), `.np-friend-av img` y `.np-invite-av` (jugar en red), `.shr-avatar` y `.shr-invite-avatar` (compartir), `.cl-avatar` (compartir clips), `.cs-gl-av` (autor de un clip), `.nc-mini-fav-img` (mini barra), `.mpa-avatar` (multijugador), `.srv-item .avatar` (reseñas de servidores) y `.cfg-v-avatar` (la cuenta de Venus en Ajustes). |
| Siguen cuadradas, a propósito | La cuenta de **Minecraft** de la barra lateral y de Ajustes, los jugadores de un servidor, las skins, el mapa del mundo y la verificación de Venus Points: no son el avatar de un perfil de Venus. Si el dueño las quiere redondas también, es agregar su selector a esa regla. |
| Marcos | Los marcos actuales siguen andando, ahora como **anillos** (`--pf-frame-r: 50%`; el marco *pixel* dejó de ser un escalón cuadrado y es un anillo a cuadros). El agente de marcos los reemplaza en la segunda tanda. |
| Punto de presencia | Va sobre el borde del círculo, a las cuatro y media (`right/bottom: -1px`; 1 px en la tarjeta grande). |
| Imagen para compartir | `features/profile-editor/share.js` dibuja la cabeza con `roundRect(..., HS / 2)` y los marcos como círculos. |
| Dato | `normalizeProfile` devuelve siempre `cardStyle.avatar = 'round'` aunque el perfil traiga `square`, `hex` o nada. `AVATAR_SHAPES = ['round']`. El estilo canónico **no manda** `avatar` (el servidor lo fija), así que no hay un patch de más. |

## Banners

| Tipo | Antes | Ahora |
|---|---|---|
| `none` (color clásico, `banner_style = {}`) | una opción más | el de por defecto |
| `preset` (16 diseños pixelados) | sí | **no**: el servidor lo rechaza (`bad_banner`) y el cliente lo dibuja como color clásico |
| `animated` (GIF propio, Premium) | sí | **no**, ni con Premium (`bad_banner`) |
| `image` | webp, jpg, png y gif (con Premium) | solo `banner[-id].webp\|jpg\|jpeg\|png` en la carpeta propia; la imagen tiene que estar quieta |
| `klipy` | sí | igual |

### Imagen propia: cómo se rechaza lo animado

- **Cliente** (`features/profile-editor/model.js`: `inspectImage`, `bannerSourceError`; `media.js`: `readImageFile(file, { still: true })`). Mira los **bytes** del archivo, no la extensión ni el `type`: GIF (siempre, tenga uno o varios cuadros), PNG con un chunk `acTL` antes del primer `IDAT` (APNG) y WebP con el bit de animación del chunk `VP8X` (o chunks `ANIM` / `ANMF`). Lo que no es PNG, JPG ni WebP da `type`. `uploadMedia` vuelve a mirar el blob antes de subir un banner. Como la imagen se redibuja en un `<canvas>`, lo que se sube nunca se mueve.
- **Servidor** (0039): `profile_customize` acepta una imagen solo si `private.banner_image_url(me, url)` cumple la ruta `https://<proyecto>.supabase.co/storage/v1/object/public/profile-media/<mi uid>/banner[-<id>].(webp|jpg|jpeg|png)`. El bucket `profile-media` deja de aceptar `image/gif` y sus políticas de subir y de renombrar piden extensión `webp`, `jpg`, `jpeg` o `png` (**para todos**, Premium incluido). `profile_public` muestra como color clásico cualquier banner `preset`, `animated` o con una imagen que no cumpla la ruta.
- **Límite que hay que decir:** la ruta y el tipo MIME no prueban que un `.webp` o un `.png` esté quieto; el servidor no abre el archivo. Quien se salte el launcher y suba un WebP animado con extensión `.webp` podría tener un banner que se mueve. Cerrarlo del todo pide una función de borde que mire el archivo al subirlo (no se hizo).

## Servidor: 0039

Idempotente. Se aplica después de 0027 (y de 0037; no depende de 0038). Las funciones de producción se leyeron con `pg_proc` y son idénticas a las de 0027 (mismo md5 del cuerpo), así que la migración parte de ellas y cambia solo esto:

- **Nuevo** `private.banner_image_url(uuid, jsonb)` (cerrada a `public`, `anon` y `authenticated`).
- **`profile_customize`**: el banner acepta `none`, `image` (con la regla de arriba) y `klipy`; `preset`, `animated` o cualquier otro `kind` dan `bad_banner`, y `premium_required:banner` ya no existe. `cardStyle.avatar` solo acepta el texto `round` (`square`, `hex`, `null`, números… dan `bad_cardStyle`) y **siempre se guarda `avatar: 'round'`**, lo mande o no el launcher. Todo lo demás es idéntico a 0027 (incluida `private.card_song_ok` y la validación de `equipped`).
- **`profile_public`**: `cardStyle.avatar` sale siempre `round`; el banner viejo sale `{}`. La canción sigue saliendo solo para amigos y dueño, y `cardStyle` sigue sin traer `song`.
- **Datos**: los `banner_style` con `preset`, `animated` o una imagen que no cumple la ruta pasan a `{}`; a todos los perfiles se les pone `card_style.avatar = 'round'` (para que los launchers viejos, que leen la tabla, también lo dibujen redondo; la guarda `pg_column_size < 1900` evita pasarse del tope de 2 KB). La columna `profiles.banner` (el color clásico) no se toca.
- **Almacenamiento**: `profile-media` sin `image/gif`; políticas `profile_media_insert_own` y `profile_media_update_own` con la extensión permitida. `select` y `delete` quedan como estaban.

**Quien redefina `profile_customize` o `profile_public` después (marcos 0040, canción 0042) tiene que partir de esta versión**, no de la de 0027: si no, vuelven los diseños y el avatar cuadrado. En concreto: conservar la línea de `cardStyle.avatar` (validación `<> 'round'`) y el `|| jsonb_build_object('avatar', 'round')` del `update`, y el `case` del banner en `profile_public`.

### Cómo se probó (solo lectura, todo en `begin … rollback`)

Con `execute_sql` sobre producción: se sembraron las formas viejas en 6 de las 9 cuentas, se corrió la migración dentro de la misma transacción y se probaron **122 comprobaciones, todas bien**, y después el bloque de datos y políticas corrido 3 veces seguidas (idempotente). Cubre: conversión de datos (preset, animated, imagen `.gif`, hex, square, sin avatar; lo que no debe cambiar queda igual), `profile_customize` con 11 nombres de archivo rechazados y 6 aceptados, URLs de otra carpeta, otro esquema o dominio, `none`/`klipy`, cuentas con y sin Premium, avatar (`hex`, `square`, `Round`, `null`, número, arreglo, objeto), el avatar guardado siempre, la canción propia que sigue pasando por `card_song_ok`, la ajena rechazada, `profile_public` (banners, avatar, canción solo para amigos y dueño), subidas a `storage.objects` como usuario (webp, png, jpg, jpeg permitidos; gif, GIF, apng, svg, sin extensión y la carpeta de otro rechazados; renombrar a `.gif` rechazado), permisos de ejecución y que el cuerpo de las tres funciones sea byte a byte el del archivo (md5). Después se comprobó que producción quedó igual (mismas funciones, 1 `preset`, ningún avatar, `image/gif` en el bucket). No se aplicó nada.

## Cosas que se tocan en archivos compartidos o de otros

- `src/renderer/styles/main.css`: **una regla nueva al final** (el avatar circular; arriba).
- `src/renderer/styles/pages/messages.css`: se sacaron los radios cuadrados de `.sc-head` (base, `.msg-start`, `.msg-gutter`, `.sc-card-head`, `.msg-empty-head`) y se movió el punto de presencia.
- `src/renderer/styles/features/profile-social.css`: libro de visitas y regalos (radio de `.sc-head`).
- **Qué ve el resto**: los archivos de otros agentes (voz, comunidades, clanes, compartir) **no se tocaron**; el círculo les llega por la regla global.

## Para otros agentes

- **Marcos y tienda (D):** `applyFrame(el, profile)` ya no agrega `pf-avatar-*`. Un marco tiene que pensarse para un círculo (`--pf-frame-r: 50%`). La vista previa de la tienda tiene que dibujar la cabeza con `.sc-head` (o `headImg()`) para salir redonda.
- **Canción (G):** no toqué `private.card_song_ok` ni la canción del editor. Ojo con las pruebas de `features/profile-editor/test/venus31.test.js` (`cardStyle: tema…`, `cardStyle: se normaliza…`, `audio: …`): dependen de lo que ese agente cambie en `model.js`.
- **Logros (K):** `achievement_met('profile_complete')` pide `profiles.banner_style <> '{}'`. Con el color clásico como banner de por defecto, esa condición solo la cumple quien eligió una imagen o un GIF de KLIPY. Los logros ya desbloqueados no se pierden; para los nuevos conviene sacar esa condición o pedir otra cosa (por ejemplo, `profiles.banner` distinto del de Venus).

## Archivos

Nuevos: `supabase/migrations/0039_perfil_circular_banners.sql`, `src/renderer/js/social/test/avatar.test.js`, este documento.

Tocados: `src/renderer/js/features/profile-editor.js`, `profile-editor/model.js`, `media.js`, `share.js`, `demo.js`, `profile-editor/test/model.test.js`, `src/renderer/js/social/profile-style.js`, `src/renderer/styles/main.css`, `styles/features/profile-style.css`, `profile-editor.css`, `profile-social.css`, `styles/pages/messages.css`, `src/renderer/i18n/{es,en}/profile.js`.

Exports que desaparecen de `features/profile-editor/model.js`: `BANNER_PRESETS`, `presetCss`, `presetLayers`. De `media.js`: `gifBanner`. Nuevos en `model.js`: `isBannerImageUrl`, `inspectImage`, `bannerSourceError`. `profile-style.js` ya no importa `presetCss`; `bannerBackgroundCss` ahora siempre devuelve el color clásico.

## Textos

`profile` (solo es y en; los otros 12 idiomas quedan para el dueño).
- **Nuevas:** `bannerPreview`, `bannerStill`, `errMedia_animated`, `sec_nav`, `sec_card`, `sec_cardHint`, `sec_name`, `sec_nameHint`, `sec_chat`, `sec_chatHint`.
- **Cambiadas de texto:** `bannerKind_klipy`, `bannerImageHint`, `bannerColorHint`, `errMedia_type`, `errMedia_denied`.
- **Sacadas (27 por idioma):** `card_avatar`, `card_avatar_square`, `card_avatar_round`, `card_avatar_hex`, `bannerKind_preset`, `bannerKind_animated`, `bannerGifPick`, `bannerGifHint`, `bannerGifLocked`, `bannerGifLockedText`, `err_premium_banner` y los 16 `banner_<diseño>`.
- En los otros 12 idiomas quedan **viejas** esas mismas 27 claves, y tienen sin traducir las 10 nuevas y los 5 textos cambiados.

## Cómo verificar

```bash
node --test "src/renderer/js/features/profile-editor/test/"
node --test "src/renderer/js/social/test/"
```

Capturas del editor sin servidor (solo con `VENUS_DEVSHOT`): `openProfileEditor({ demo: 'premium', tab: 'style' })` y, para el banner, `tab: 'banner'`. El demo premium usa una imagen quieta dibujada en un `<canvas>` y el buscador de KLIPY muestra miniaturas de ejemplo (`demoKlipy()`), sin red.

## Partes de `docs/perfiles.md` que esta versión deja viejas

- La tabla de pestañas: **Estilo** ya no tiene la forma de la cabeza (sí *Tarjeta* con dibujo, disposición y acento) y **Banner** ya no tiene los 8 diseños ni el GIF animado de Premium.
- "Novedades de la 3.0": *Tarjeta (`card_style`): …forma de la cabeza…*, *Banner: 8 diseños más*.
- "Datos y reglas del servidor": `banner_style { kind: 'preset' | 'image' | 'animated' }`, `premium_required:banner` y *GIF solo con Premium* en `profile-media`; el contrato de `bannerEl` (*diseño, imagen, GIF*), `presetCss`/`presetLayers` en la lógica pura y `BANNER_PRESETS` en los catálogos.
