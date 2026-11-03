# Inicio de sesión de Microsoft: pasar a una app propia

Hoy Venus inicia sesión con el `client_id` del launcher oficial (`00000000402b5328`). Funciona, pero depende de otro: si Microsoft lo restringe a su propio launcher, nadie puede iniciar sesión hasta que haya un cliente propio. El código ya está listo para pasar a una app propia de Azure. Lo único que falta se hace con tu cuenta, porque es un registro y una aprobación a tu nombre.

## Qué hay que hacer

1. **Registrar la app en Azure** ([portal.azure.com](https://portal.azure.com) → Microsoft Entra ID → App registrations → New registration):
   - Nombre: Venus Launcher.
   - Tipos de cuenta: *Personal Microsoft accounts only*.
   - Redirect URI: plataforma *Mobile and desktop applications*, valor `https://login.microsoftonline.com/common/oauth2/nativeclient`.
   - En *Authentication*, activá *Allow public client flows*.
   - Copiá el *Application (client) ID*. No es secreto: va en el código.
2. **Pedir permiso a Mojang**: las apps nuevas no pueden usar la API de Minecraft hasta que las aprueban. Formulario: [aka.ms/mce-reviewappid](https://aka.ms/mce-reviewappid). Mientras no esté aprobada, `login_with_xbox` responde 403.
3. **Cargar el ID**: cuando te aprueben, poné el ID en `msClientId` de `src/main/core/app-config.js` y publicá una versión. Para probarlo antes sin empaquetar: `VENUS_MS_CLIENT_ID=<id> npm start`.

## Qué pasa con los usuarios

- Sin `msClientId` todo sigue como hasta ahora.
- Con `msClientId`, las cuentas **nuevas** usan la app propia (con PKCE).
- Cada cuenta recuerda con qué cliente entró (`msClient` en `accounts.json`), porque un token de renovación solo vale con el cliente que lo emitió. Las que ya estaban siguen con el cliente de siempre y nadie tiene que volver a iniciar sesión.
- Si algún día Microsoft cierra el cliente de siempre, esas cuentas piden iniciar sesión de nuevo y pasan solas a la app propia.

## Dónde está

`LEGACY_CLIENT`, `azureClient` y `authRequest` en `src/main/core/accounts.js`. Pruebas: `node --test "src/main/core/test/*.test.js"`. La parte de Azure se probó solo contra servicios simulados: falta un inicio de sesión real con la app aprobada.
