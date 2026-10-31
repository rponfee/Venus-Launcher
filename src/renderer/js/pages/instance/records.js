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
