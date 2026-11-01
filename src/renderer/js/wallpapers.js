// Desde la 1.0.15 el launcher no trae fondos de terceros: están en la página de fondos (web/fondos.html), cada usuario
// baja el que quiere y lo elige con "Imagen o video". La galería (y los fondos animados) siguen soportados si se vuelven a
// listar acá fondos con licencia libre: { id, name, src, thumb, video? }.
export const WALLPAPERS = [];

const WALLPAPERS_BY_ID = new Map(WALLPAPERS.map(wallpaper => [wallpaper.id, wallpaper]));

export function getWallpaper(id) {
  return WALLPAPERS_BY_ID.get(id) || null;
}
