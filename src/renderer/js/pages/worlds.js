// Mundos: todos los mundos de todas las instancias con su linea de tiempo (partidas, capturas, clips y
// logros por dia), estadisticas, copias de seguridad y una galeria de capturas y clips.
// Rutas: #/worlds · #/worlds/media (capturas y clips) · #/worlds/<instancia>/<carpeta> (ficha del mundo)
import { renderList } from './worlds/list.js';
import { renderDetail } from './worlds/detail.js';

export default {
  ns: ['worlds'],
  css: ['pages/worlds'],
  render(root, params = []) {
    if (params.length >= 2 && params[0] && params[1]) return renderDetail(root, params[0], params[1]);
    const tab = params[0] === 'media' ? 'media' : 'worlds';
    // Cambiar de pestana actualiza la ruta sin volver a dibujar la pagina (asi "Volver" recuerda la pestana)
    return renderList(root, { tab, onTab: (id) => history.replaceState(null, '', id === 'media' ? '#/worlds/media' : '#/worlds') });
  },
};
