// Modrinth (y CurseForge opcional): catalogo completo de mods, modpacks, shaders, resource packs,
// data packs y plugins, detalle de proyecto, comparacion e instalacion en un clic.
// Rutas:
//   #/modrinth                                  catalogo (recuerda la ultima busqueda)
//   #/modrinth/<instancia|->/<tipo>/<servidor?>  catalogo filtrado para una instancia o servidor
//   #/modrinth/project/<id-o-slug>              detalle de un proyecto de Modrinth
//   #/modrinth/curseforge/<id>                  detalle de un proyecto de CurseForge
import { store } from '../store.js';
import { TYPE_IDS } from './modrinth/shared.js';
import { renderBrowser } from './modrinth/browser.js';
import { renderDetail } from './modrinth/detail.js';
import { renderCurseForgeDetail } from './modrinth/curseforge.js';

// Una instancia podria llamarse "project": si el segundo parametro es un tipo, es el catalogo.
function isInstanceRoute(params) {
  return TYPE_IDS.includes(params[1]) && store.instances.some((i) => i.id === params[0]);
}

export default {
  ns: ['modrinth', 'install', 'searchfilters'],
  css: ['pages/modrinth', 'features/install', 'features/searchfilters'],
  render(root, params) {
    const [a, b, c] = params;
    if (a === 'project' && b && !isInstanceRoute(params)) return renderDetail(root, b);
    if (a === 'curseforge' && /^\d+$/.test(b || '') && !isInstanceRoute(params)) return renderCurseForgeDetail(root, b);
    return renderBrowser(root, { instanceId: a && a !== '-' ? a : null, type: b || null, serverId: c || null });
  },
};
