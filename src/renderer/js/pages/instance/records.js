// Datos de los archivos de contenido que no vienen del proceso principal (logica pura, sin DOM).

// Archivos instalados desde CurseForge en una carpeta: nombre (sin ".disabled") -> registro.
// inst.curseforge.projects tiene la misma forma que modrinth.projects (title, icon, file, folder,
// versionNumber) y la clave es el id del proyecto; la carpeta puede venir con "\" (Windows).
export function curseforgeRecords(inst, folder) {
  const out = {};
  const want = String(folder || '').replace(/\\/g, '/');
  if (!want) return out;
  for (const [modId, rec] of Object.entries(inst?.curseforge?.projects || {})) {
    if (!rec || typeof rec !== 'object' || typeof rec.file !== 'string' || !rec.file) continue;
    const recFolder = String(rec.folder || 'mods').replace(/\\/g, '/');
    if (recFolder !== want) continue;
    out[rec.file] = { ...rec, modId: String(modId) };
  }
  return out;
}

// Pagina del proyecto en CurseForge (redirige al nombre del proyecto).
export function curseforgeUrl(modId) {
  const id = String(modId ?? '').trim();
  return /^\d+$/.test(id) ? `https://www.curseforge.com/projects/${id}` : null;
}

// Nombre y version para mostrar de un archivo de contenido (misma regla que la lista de la instancia):
// el titulo del proyecto (Modrinth en f.title, CurseForge en cf, identificacion por hash en id) o el nombre
// del archivo sin extension. Lo usa Comparar instancias.
export function entryLabel(f, cf = null, id = null) {
  const fileName = String(f?.file || '').replace(/\.disabled$/i, '');
  const known = f?.title || cf?.title || id?.title || null;
  const name = known || (f?.isDir ? fileName : fileName.replace(/\.(jar|zip|litemod)$/i, ''));
  return {
    name,
    version: f?.versionNumber || cf?.versionNumber || id?.versionNumber || null,
    file: fileName,
    projectId: f?.projectId || id?.projectId || null,
    modId: cf?.modId || null,
    enabled: f?.enabled !== false,
  };
}
