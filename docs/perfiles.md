# Perfiles de Venus

> Guía de la personalización del perfil (Venus 2.0): qué puede cambiar cada jugador, cómo se dibuja y cómo lo usan otras partes del launcher. Servidor: `supabase/migrations/0020_perfiles.sql` (perfil, Premium y bucket `profile-media`) y la parte de cosméticos de `0021_puntos.sql` (tienda). Arquitectura general: [arquitectura.md](arquitectura.md).

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

## Datos y reglas del servidor

- Columnas nuevas de `profiles` (0020): `pronouns`, `theme { from, to, angle }`, `name_style { font, effect, color, glow }`, `banner_style { kind: 'preset' | 'image' | 'animated', preset? | url? }`, `favorite_servers [{ address, name? }]`, `public_stats` (null o `{ hours, sessions, topVersion, topLoader, since, updatedAt }`), `featured [{ url, title? }]`, `equipped { frame?, nameEffect?, badgeStyle?, title? }` (ids de `shop_items`) y `customized_at`. El banner viejo (`profiles.banner`, texto: preset o colores) sigue siendo el **color clásico** y se ve cuando `banner_style` está vacío.
- Se escriben **solo** con `profile_customize(p_patch)` (lo que no cambió no se manda). Errores (`errcode 22023`): `bad_<campo>`, `bad_field:<clave>`, `bad_request`, `premium_required:nameStyle` (destello, arcoíris y fuego sin Premium ni el efecto comprado), `premium_required:banner` (GIF sin Premium), `not_owned:<item>`; `user_banned` / `user_muted` (`42501`). El editor valida lo mismo antes de mandar (`model.js`) y traduce cada error.
- Nombre visible, nombre de Minecraft, texto de estado y el color clásico se guardan como siempre en la tabla (`social.updateProfile` o `cloud.updateProfile`); el estado y la privacidad con `social.setPrefs`.
- Se lee con `profile_public(p_user)` (camelCase, con `premium`). Las filas que carga `social.js` no traen el estilo: `profile-style.js` pide `id,name_style,theme,equipped,banner_style` de todos los que falten en un solo pedido y lo guarda 5 minutos.
- Imágenes en el bucket público `profile-media`, carpeta `<userId>/` (`banner-<id>.webp|jpg|gif`, `featured-<id>.webp|jpg`): hasta 12 archivos de 4 MB, GIF solo con Premium. Antes de subir se borran los archivos propios que ya no usa nada si no hay lugar; después de guardar se borran el banner y las destacadas reemplazados. `profile_customize` solo acepta URLs públicas de la carpeta del propio usuario.
- Premium: `isPremium({ force: true })` de `features/premium.js` si existe; si no, el `premium` de `profile_public`.
- Cosméticos: `shop_items` (si no responde, la copia `SHOP_CATALOG` de `model.js`) y `user_items` (lo comprado). Lo `premium_only` viene incluido con Premium.
- Sin sesión: diálogo con *Ir a Cuenta y nube*. Sin la migración 0020 (o el servicio caído) el editor deja cambiar los datos de siempre (la descripción va por la tabla) y avisa que el resto no está disponible; las tarjetas se dibujan con lo que haya.

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
| Extras | `premiumChip(profile)`, `normalize(profile)`, `nameColor(profile)`, `bannerBackgroundCss(profile)`, `primeStyles(ids)`, `setStyleCache(id, profile)`, `FONT_STACKS` |

**`src/renderer/js/social/profile-ui.js`**: además de lo de siempre, `profileCard(profile, { full?, preview?, presence?, statusText?, friend?, compact? })`, `openProfile(userId, { profile? })` (abre con lo que haya y se completa con `profile_public`), `previewProfile(profile, { title?, presence? })` (tarjeta completa de un perfil que ya tenés, por ejemplo para mostrar un cosmético), `fetchPublicProfile(userId, { force? })` y `openMyProfile()` (abre el editor).

**`src/renderer/js/features/profile-editor.js`**: `openProfileEditor({ tab?: 'identity' | 'style' | 'banner' | 'showcase' | 'items' })`, `openShareProfile({ profile? })` y `featureCapture({ src, title? }) → Promise<boolean>` para **Capturas y clips** ("Destacar en mi perfil"): `src` es una URL `file:`, `data:` o `blob:` (o un `Blob`); achica la captura a 1600 × 900, la sube y la agrega a las destacadas (si ya hay 3, pregunta si reemplaza la primera).

**Lógica pura** en `features/profile-editor/model.js` (sin DOM ni imports): `normalizeProfile`, `mergeProfiles`, `validateField`, `validatePatch`, `customOf`, `canonical`, `buildPatch`, `parseCustomizeError`, `publicStatsFromReport`, `gradientCss`, `presetCss`/`presetLayers` (los banners salen de la misma descripción en CSS y en el lienzo), `readableColor`, `fadeSurface`, `glowFilter`, `cropRect`, `fitSize`, `mediaFileName`, `orphanMedia`, catálogos (`FONTS`, `EFFECTS`, `BANNER_PRESETS`, `FRAMES`, `TITLES`, `BADGE_STYLES`, `SHOP_CATALOG`, `LIMITS`).

## Cómo verificar

```bash
node --test "src/renderer/js/features/profile-editor/test/"
```

Capturas sin servidor (solo con `VENUS_DEVSHOT`; datos de `features/profile-editor/demo.js`):

```bash
VENUS_DEVSHOT=<carpeta> VENUS_DATA_DIR=<carpeta-temporal> VENUS_SKIP_ONBOARDING=1 \
VENUS_DEVSHOT_ROUTES="messages|import('./js/features/profile-editor.js').then((m) => m.openProfileEditor({ demo: 'premium', tab: 'style' }));0;;messages|import('./js/features/profile-editor/demo.js').then((d) => d.openDemoCard('free'));0;;messages|import('./js/features/profile-editor.js').then((m) => m.openShareProfile({ demo: true }));0" \
  ./node_modules/.bin/electron .
```

`demo: 'premium'` o `'free'` (cuenta sin Premium, con candados). En modo capturas, *Guardar* no habla con el servidor y *Copiar imagen* / *Guardar PNG* no tocan el portapapeles ni abren el diálogo.
