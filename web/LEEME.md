# Página web de Venus Launcher

Esta carpeta es la página lista para subir a cualquier hosting estático: `index.html` y `assets/` (logo y capturas).

## Las descargas
Los botones bajan los instaladores del bucket público `descargas` de Supabase (migración `supabase/migrations/0015_descargas.sql`):
- https://dzchklzaxyygbvfpagvx.supabase.co/storage/v1/object/public/descargas/VenusLauncher-Setup-1.0.0.exe
- https://dzchklzaxyygbvfpagvx.supabase.co/storage/v1/object/public/descargas/VenusLauncher-Portable-1.0.0.exe

**Para que funcionen, subí los dos `.exe` una sola vez:**
1. En el panel de Supabase, andá a **Storage** y elegí el bucket **descargas**.
2. Tocá **Upload files** y elegí `VenusLauncher-Setup-1.0.0.exe` y `VenusLauncher-Portable-1.0.0.exe`, que están en `E:\Venus Launcher\dist-final\`.
3. Si te dice que el archivo es muy grande:
   - andá a **Storage → Settings**;
   - subí el **Upload file size limit** a 300 MB;
   - volvé a intentar.

Cada descarga pesa unos 113 MB. El plan Pro de Supabase incluye 250 GB de tráfico por mes, alrededor de 2.000 descargas; después se cobra aparte.

## Versiones nuevas
1. Subí los `.exe` nuevos al bucket.
2. En `index.html` cambiá:
   - los 3 links de descarga (llevan el número de versión);
   - la versión que aparece arriba y en la sección "Descargá Venus Launcher";
   - el tamaño, en esa misma sección.

## Publicar la página gratis
- **Netlify Drop**: entrá a https://app.netlify.com/drop y arrastrá esta carpeta.
- **Cloudflare Pages** o **GitHub Pages**: subí la carpeta como sitio estático.
