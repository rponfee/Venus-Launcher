'use strict';
// Script del launcher que corre primero en cada página de una extensión (lo agrega el protocolo como primer elemento).
// Existe por un solo agujero: connect-src no alcanza a WebRTC y este Chromium no entiende la directiva webrtc de la CSP.
// Saca WebRTC del ámbito de la página; y como un marco anidado traería un ámbito nuevo con WebRTC intacto, tampoco deja
// crear marcos. Trusted Types (CSP) cierra innerHTML y demás, y package.js rechaza las etiquetas de marcos en el HTML.
// No es el límite de seguridad principal: el aislamiento lo dan el sandbox y la CSP. Si alguien encontrara cómo sacarle
// la vuelta, lo único que ganaría es hablar por WebRTC con lo que la extensión ya tiene (sus datos y lo que el puente le da).
const BOOT_PATH = '.venus/boot.js';

const BOOT_SCRIPT = `(function () {
  'use strict';
  var apply = Reflect.apply;
  var defineProperty = Object.defineProperty;
  var create = Document.prototype.createElement;
  var createNS = Document.prototype.createElementNS;
  var names = Object.getOwnPropertyNames(window);
  var drop = function (host, name) {
    try {
      delete host[name];
    } catch (e) {
      /* no se puede borrar */
    }
  };
  for (var i = 0; i < names.length; i++) {
    if (/^(webkit)?RTC/.test(names[i])) drop(window, names[i]);
  }
  ['HTMLIFrameElement', 'HTMLFrameElement', 'HTMLFrameSetElement', 'HTMLObjectElement', 'HTMLEmbedElement', 'HTMLPortalElement', 'HTMLFencedFrameElement', 'XSLTProcessor'].forEach(function (name) {
    drop(window, name);
  });
  drop(DOMImplementation.prototype, 'createDocument');
  var lower = Object.create(null);
  var upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  var small = 'abcdefghijklmnopqrstuvwxyz';
  for (var j = 0; j < 26; j++) lower[upper[j]] = small[j];
  var blocked = Object.create(null);
  ['iframe', 'frame', 'frameset', 'object', 'embed', 'portal', 'fencedframe'].forEach(function (name) {
    blocked[name] = true;
  });
  // Sin métodos de String ni de Array: la extensión los puede reemplazar después de este script.
  var refused = function (text) {
    var name = '';
    for (var k = 0; k < text.length; k++) {
      var c = text[k];
      if (c === ':') name = '';
      else name += lower[c] || c;
    }
    return blocked[name] === true;
  };
  var guarded = function (real, position) {
    return function () {
      var args = [];
      for (var n = 0; n < arguments.length; n++) args[n] = arguments[n];
      args[position] = '' + args[position];
      if (refused(args[position])) throw new DOMException('Marcos no permitidos en una extensión', 'NotSupportedError');
      return apply(real, this, args);
    };
  };
  defineProperty(Document.prototype, 'createElement', { value: guarded(create, 0), writable: false, configurable: false });
  defineProperty(Document.prototype, 'createElementNS', { value: guarded(createNS, 1), writable: false, configurable: false });
})();
`;

// Primer elemento del documento, sin importar qué traiga. Solo se respeta un doctype simple y exacto: dentro de uno con
// comillas, o después de cualquier otra cosa, el script podría quedar como texto y no correr. Lo demás abre en modo quirks.
function injectBoot(html, id) {
  const tag = `<script src="venus-ext://${id}/${BOOT_PATH}"></script>`;
  const text = html.toString('utf8');
  const m = /^<!doctype html>/i.exec(text);
  return Buffer.from(m ? `${m[0]}${tag}${text.slice(m[0].length)}` : `${tag}${text}`, 'utf8');
}

module.exports = { BOOT_PATH, BOOT_SCRIPT, injectBoot };
