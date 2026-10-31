// Fondos incluidos en el launcher. Vacío a propósito: solo se pueden sumar imágenes con licencia libre (CC0,
// CC-BY con atribución o propias), porque todo lo que se distribuye tiene que poder publicarse con el código.
// El usuario igual puede poner su propia imagen o video de fondo (Ajustes > Apariencia).
export const WALLPAPERS = [];

const WALLPAPERS_BY_ID = new Map(WALLPAPERS.map(wallpaper => [wallpaper.id, wallpaper]));

export function getWallpaper(id) {
  return WALLPAPERS_BY_ID.get(id) || null;
}
