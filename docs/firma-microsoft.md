# Firma de Microsoft (Azure Artifact Signing)

Venus Launcher está preparado para firmar sus ejecutables con **Azure Artifact Signing** (el servicio de firma de
Microsoft, antes llamado "Trusted Signing"). Con la firma, Windows SmartScreen muestra el nombre del editor en vez
de "Editor desconocido" y la reputación se acumula sobre el certificado.

Mientras no se carguen las credenciales, todo sigue funcionando igual que antes (las releases salen sin firmar).

## Quién puede usarlo

Requisitos de Microsoft (Learn, "Quickstart: Set up Artifact Signing", octubre 2026):

- **Desarrollador individual**: tiene que vivir en **Estados Unidos o Canadá**, con una cuenta de facturación de
  Azure de tipo *Individual* cuyo nombre y dirección coincidan con un documento oficial (validación con AU10TIX y
  Microsoft Authenticator).
- **Organización**: Estados Unidos, Canadá, Unión Europea, Reino Unido, Australia, Nueva Zelanda, Japón,
  Corea del Sur, Singapur, Suiza, Noruega o Israel, con una entidad legal registrada.
- Hace falta una suscripción de Azure (con medio de pago) y aceptar los términos de Azure, que piden ser mayor de
  edad. El costo es mensual (plan Basic o Premium).

Desde Argentina, hoy no se puede validar una identidad propia: la cuenta tendría que ser de una persona u
organización de uno de esos países. SignPath Foundation (ya configurado en `build.yml`) sigue siendo la opción
gratuita.

## Pasos en Azure (una sola vez)

1. Portal de Azure → Suscripción → **Resource providers** → registrar `Microsoft.CodeSigning`.
2. Crear una **Artifact Signing Account** (región, por ejemplo East US → endpoint `https://eus.codesigning.azure.net/`).
3. **Identity validations** → nueva validación pública (Individual u Organización) y completarla.
4. **Certificate profiles** → crear un perfil **Public Trust** con esa validación.
5. **Microsoft Entra ID** → *App registrations* → registrar una app (por ejemplo `venus-launcher-ci`) y crearle un
   *client secret*.
6. En la cuenta de firma → **Access control (IAM)** → asignarle a esa app el rol
   **Artifact Signing Certificate Profile Signer**.

## Cargar en GitHub

Repositorio → Settings → Secrets and variables → Actions:

| Tipo     | Nombre                    | Valor                                                  |
|----------|---------------------------|--------------------------------------------------------|
| Secreto  | `AZURE_TENANT_ID`         | Directory (tenant) ID de Entra ID                      |
| Secreto  | `AZURE_CLIENT_ID`         | Application (client) ID de la app registrada           |
| Secreto  | `AZURE_CLIENT_SECRET`     | El client secret de la app                             |
| Variable | `AZURE_SIGNING_ENDPOINT`  | Endpoint de la región, por ejemplo `https://eus.codesigning.azure.net/` |
| Variable | `AZURE_SIGNING_ACCOUNT`   | Nombre de la cuenta de firma                           |
| Variable | `AZURE_SIGNING_PROFILE`   | Nombre del perfil de certificado                       |
| Variable | `AZURE_SIGNING_PUBLISHER` | Nombre del editor exacto del certificado (CN, el que muestra la vista previa del sujeto) |

Ojo con `AZURE_SIGNING_PUBLISHER`: queda guardado en las versiones firmadas, que después solo aceptan
actualizaciones firmadas con ese mismo nombre. Si cambia el certificado (otro titular), hay que publicar una versión
puente.

## Qué pasa después

- **Releases nuevas** (`build.yml`, al subir un tag `v*`): electron-builder firma el ejecutable de la app, el
  desinstalador, el instalador y la versión portable mientras compila, y arma `latest.yml` y el `.blockmap` con los
  archivos firmados (las actualizaciones diferenciales siguen andando). El workflow verifica las firmas antes de
  publicar. Con la firma de Microsoft cargada, el paso de SignPath no corre.
- **Releases ya publicadas** (`resign-releases.yml`, se corre a mano desde Actions → "Firmar releases publicadas",
  con una release o `todas`): baja los `.exe`, saltea los que ya tienen firma válida, firma el resto, actualiza
  `latest.yml`/`demo.yml` (`scripts/resign-yml.js`), los vuelve a subir y borra el `.blockmap` viejo. Solo firma el
  `.exe` de afuera: la app que va adentro de un instalador viejo queda sin firmar (para eso hay que recompilar esa
  versión).
- Compilar en la PC (`npm run dist`) no cambia: la configuración de firma se pasa solo en GitHub Actions.
