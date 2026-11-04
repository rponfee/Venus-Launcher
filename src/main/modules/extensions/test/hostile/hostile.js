// Extensión hostil de prueba: intenta todo lo que una extensión maliciosa querría hacer y anota qué pasó.
// La corre run.js en la ventana real de Electron. Cada intento se guarda con el permiso storage, que sí tiene.
(function () {
  var cfg = window.__CFG;
  var results = [];
  var seq = 1000;
  var replies = new Map();
  var sent = 0;

  window.addEventListener('message', function (e) {
    if (e.source !== window.parent) return;
    var m = e.data;
    if (m && m.venus === 1 && m.id !== undefined && replies.has(m.id)) {
      var r = replies.get(m.id);
      replies.delete(m.id);
      r(m);
    }
  });

  function ask(method, params, timeout) {
    return new Promise(function (resolve) {
      var id = ++seq;
      replies.set(id, resolve);
      window.parent.postMessage({ venus: 1, id: id, method: method, params: params }, '*');
      setTimeout(function () {
        if (replies.delete(id)) resolve({ timeout: true });
      }, timeout || 1500);
    });
  }
  var sleep = function (ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  };
  var save = function () {
    return ask('storage.set', { key: 'results' + cfg.stage, value: results }, 3000);
  };

  // fn devuelve true si quedó bloqueado, false si la extensión lo logró; lanzar también es quedar bloqueado.
  async function attempt(name, fn) {
    var blocked = true;
    var detail = '';
    try {
      var out = await fn();
      if (typeof out === 'object' && out) {
        blocked = Boolean(out.blocked);
        detail = String(out.detail || '');
      } else blocked = Boolean(out);
    } catch (err) {
      blocked = true;
      detail = String(err && err.name) + ': ' + String(err && err.message).slice(0, 110);
    }
    results.push({ name: name, blocked: blocked, detail: detail });
  }

  var net = function (path) {
    return 'http://127.0.0.1:' + cfg.http + '/' + path;
  };

  async function escapes() {
    await attempt('api del launcher: window.venus y api', function () {
      return typeof window.venus === 'undefined' && typeof window.api === 'undefined';
    });
    await attempt('Node: require, process, module, Buffer', function () {
      return typeof window.require === 'undefined' && typeof window.process === 'undefined' && typeof window.module === 'undefined' && typeof window.Buffer === 'undefined';
    });
    await attempt('parent.venus', function () {
      return { blocked: false, detail: String(window.parent.venus) };
    });
    await attempt('top.venus', function () {
      return { blocked: false, detail: String(window.top.venus) };
    });
    await attempt('parent.document', function () {
      return { blocked: false, detail: String(window.parent.document) };
    });
    await attempt('top.document', function () {
      return { blocked: false, detail: String(window.top.document) };
    });
    await attempt('parent.location.href (leer)', function () {
      return { blocked: false, detail: String(window.parent.location.href) };
    });
    await attempt('parent.localStorage', function () {
      return { blocked: false, detail: String(window.parent.localStorage) };
    });
    await attempt('escribir parent.__pwned', function () {
      window.parent.__pwned = 1;
      return { blocked: false, detail: 'sin error' };
    });
    await attempt('parent.eval', function () {
      window.parent.eval('window.__pwned=2');
      return { blocked: false, detail: 'corrió' };
    });
    await attempt('parent.Function por constructor', function () {
      var F = window.parent.constructor.constructor;
      F('window.__pwned=3')();
      return { blocked: false, detail: 'corrió' };
    });
    await attempt('window.frameElement', function () {
      return window.frameElement === null;
    });
    await attempt('document.referrer vacío', function () {
      return document.referrer === '';
    });
  }

  async function storageApis() {
    await attempt('document.cookie (leer)', function () {
      return { blocked: false, detail: JSON.stringify(document.cookie) };
    });
    await attempt('document.cookie (escribir)', function () {
      document.cookie = 'a=1';
      return { blocked: false, detail: document.cookie };
    });
    await attempt('localStorage', function () {
      return { blocked: false, detail: String(window.localStorage.length) };
    });
    await attempt('sessionStorage', function () {
      return { blocked: false, detail: String(window.sessionStorage.length) };
    });
    await attempt('indexedDB', function () {
      return new Promise(function (resolve, reject) {
        var r = window.indexedDB.open('x');
        r.onerror = function () {
          reject(r.error);
        };
        r.onsuccess = function () {
          resolve({ blocked: false, detail: 'abrió' });
        };
      });
    });
    await attempt('Cache Storage', function () {
      if (!window.caches) return { blocked: true, detail: 'no existe' };
      return window.caches.open('x').then(function () {
        return { blocked: false, detail: 'abrió' };
      });
    });
    await attempt('Service Worker', function () {
      if (!navigator.serviceWorker) return { blocked: true, detail: 'no existe' };
      return navigator.serviceWorker.register('app.js').then(function () {
        return { blocked: false, detail: 'registró' };
      });
    });
    await attempt('document.domain', function () {
      document.domain = 'localhost';
      return { blocked: false, detail: 'sin error' };
    });
    await attempt('BroadcastChannel con el launcher', function () {
      var bc = new BroadcastChannel('venus');
      bc.postMessage('hola');
      bc.close();
      return { blocked: true, detail: 'origen opaco: solo se oye a sí mismo' };
    });
  }

  async function network() {
    var refused = function (p) {
      return p.then(
        function (v) {
          return { blocked: false, detail: String(v && v.status) };
        },
        function (e) {
          return { blocked: true, detail: String(e && e.message).slice(0, 110) };
        },
      );
    };
    await attempt('fetch a internet', function () {
      return refused(fetch('https://example.com/'));
    });
    await attempt('fetch a la PC (detector local)', function () {
      return refused(fetch(net('fetch')));
    });
    await attempt('fetch de un archivo (file:)', function () {
      return refused(fetch('file:///C:/Windows/win.ini'));
    });
    await attempt('fetch de otra extensión', function () {
      return refused(fetch('venus-ext://hostile-victim/secret.js'));
    });
    await attempt('fetch de un archivo propio', function () {
      return refused(fetch('app.js'));
    });
    await attempt('XMLHttpRequest', function () {
      return new Promise(function (resolve) {
        var x = new XMLHttpRequest();
        x.onload = function () {
          resolve({ blocked: false, detail: String(x.status) });
        };
        x.onerror = function () {
          resolve({ blocked: true, detail: 'error de red' });
        };
        x.open('GET', net('xhr'));
        x.send();
      });
    });
    await attempt('WebSocket', function () {
      return new Promise(function (resolve) {
        var ws = new WebSocket('ws://127.0.0.1:' + cfg.http + '/ws');
        ws.onopen = function () {
          resolve({ blocked: false, detail: 'abrió' });
        };
        ws.onerror = function () {
          resolve({ blocked: true, detail: 'error' });
        };
        setTimeout(function () {
          resolve({ blocked: true, detail: 'sin conexión' });
        }, 800);
      });
    });
    await attempt('EventSource', function () {
      return new Promise(function (resolve) {
        var es = new EventSource(net('sse'));
        es.onopen = function () {
          resolve({ blocked: false, detail: 'abrió' });
        };
        es.onerror = function () {
          es.close();
          resolve({ blocked: true, detail: 'error' });
        };
        setTimeout(function () {
          resolve({ blocked: true, detail: 'sin conexión' });
        }, 800);
      });
    });
    await attempt('sendBeacon', function () {
      return !navigator.sendBeacon(net('beacon'), 'secreto') || { blocked: true, detail: 'aceptó el pedido; lo define el detector local' };
    });
    await attempt('WebTransport', function () {
      if (!window.WebTransport) return { blocked: true, detail: 'no existe' };
      var wt = new WebTransport('https://127.0.0.1:' + cfg.http + '/wt');
      return wt.ready.then(
        function () {
          return { blocked: false, detail: 'abrió' };
        },
        function (e) {
          return { blocked: true, detail: String(e && e.message).slice(0, 80) };
        },
      );
    });
    var tag = function (name, attrs, parent) {
      var el = document.createElement(name);
      Object.keys(attrs).forEach(function (k) {
        try {
          el.setAttribute(k, attrs[k]);
        } catch (e) {
          results.push({ name: '<' + name + ' ' + k + '> por setAttribute', blocked: true, detail: String(e.message).slice(0, 80) });
        }
      });
      (parent || document.body).append(el);
      return el;
    };
    tag('img', { src: net('img') });
    tag('img', { srcset: net('srcset') + ' 2x' });
    tag('script', { src: net('script.js') });
    tag('link', { rel: 'stylesheet', href: net('style.css') });
    tag('link', { rel: 'preload', as: 'image', href: net('preload') });
    tag('link', { rel: 'prefetch', href: net('prefetch') });
    tag('link', { rel: 'modulepreload', href: net('modulepreload.js') });
    tag('link', { rel: 'preconnect', href: 'http://127.0.0.1:' + cfg.tcp + '/' });
    tag('link', { rel: 'dns-prefetch', href: 'http://hostile-dns.invalid/' });
    tag('link', { rel: 'icon', href: net('icon') });
    tag('audio', { src: net('audio'), autoplay: '' });
    tag('video', { src: net('video'), poster: net('poster'), autoplay: '' });
    var box = tag('div', {});
    box.style.backgroundImage = 'url(' + net('css-bg') + ')';
    box.style.width = '10px';
    box.style.height = '10px';
    var ping = tag('a', { href: '#', ping: net('ping') });
    ping.click();
    var inStyle = tag('style', {});
    inStyle.textContent = '@import url(' + net('import.css') + ');@font-face{font-family:x;src:url(' + net('font') + ')}body{font-family:x}';
    await attempt('import() de un módulo externo', function () {
      return refused(import(net('mod.js')));
    });
    await attempt('Worker desde la red', function () {
      new Worker(net('worker.js'));
      return { blocked: false, detail: 'creó' };
    });
    await attempt('Worker desde blob', function () {
      new Worker(URL.createObjectURL(new Blob(['1'], { type: 'text/javascript' })));
      return { blocked: false, detail: 'creó' };
    });
    await attempt('SharedWorker', function () {
      new SharedWorker('app.js');
      return { blocked: false, detail: 'creó' };
    });
    await attempt('WebRTC: RTCPeerConnection', function () {
      var C = window.RTCPeerConnection || window.webkitRTCPeerConnection;
      if (!C) return { blocked: true, detail: 'no existe' };
      var pc = new C({ iceServers: [{ urls: 'stun:127.0.0.1:' + cfg.udp }] });
      pc.createDataChannel('x');
      return pc.createOffer().then(function (o) {
        return pc.setLocalDescription(o).then(function () {
          return { blocked: false, detail: 'armó la oferta' };
        });
      });
    });
    await sleep(600);
    // Marcos anidados: el ámbito nuevo traería WebRTC intacto
    await attempt('marco anidado: createElement', function () {
      document.body.append(document.createElement('iframe'));
      return { blocked: window.length === 0, detail: 'marcos: ' + window.length };
    });
    await attempt('marco anidado: createElementNS con prefijo', function () {
      document.body.append(document.createElementNS('http://www.w3.org/1999/xhtml', 'x:iFrAmE'));
      return { blocked: window.length === 0, detail: 'marcos: ' + window.length };
    });
    await attempt('marco anidado: innerHTML', function () {
      var d = document.createElement('div');
      document.body.append(d);
      d.innerHTML = '<iframe></iframe>';
      return { blocked: window.length === 0, detail: 'marcos: ' + window.length };
    });
    await attempt('marco anidado: insertAdjacentHTML', function () {
      document.body.insertAdjacentHTML('beforeend', '<iframe></iframe>');
      return { blocked: window.length === 0, detail: 'marcos: ' + window.length };
    });
    await attempt('marco anidado: document.write', function () {
      document.write('<iframe></iframe>');
      return { blocked: window.length === 0, detail: 'marcos: ' + window.length };
    });
    await attempt('marco anidado: DOMParser', function () {
      var doc = new DOMParser().parseFromString('<iframe></iframe>', 'text/html');
      document.body.append(doc.body.firstChild);
      return { blocked: window.length === 0, detail: 'marcos: ' + window.length };
    });
    await attempt('marco anidado: createContextualFragment', function () {
      document.body.append(document.createRange().createContextualFragment('<iframe></iframe>'));
      return { blocked: window.length === 0, detail: 'marcos: ' + window.length };
    });
    await attempt('marco anidado: setHTMLUnsafe', function () {
      if (!document.body.setHTMLUnsafe) return { blocked: true, detail: 'no existe' };
      var d = document.createElement('div');
      document.body.append(d);
      d.setHTMLUnsafe('<iframe></iframe>');
      return { blocked: window.length === 0, detail: 'marcos: ' + window.length };
    });
    await attempt('marco anidado: execCommand insertHTML', function () {
      if (!document.execCommand) return { blocked: true, detail: 'no existe' };
      var d = document.createElement('div');
      d.setAttribute('contenteditable', 'true');
      document.body.append(d);
      d.focus();
      document.execCommand('insertHTML', false, '<iframe></iframe>');
      return { blocked: window.length === 0, detail: 'marcos: ' + window.length };
    });
    await attempt('marco anidado: createDocument con raíz iframe', function () {
      var doc = document.implementation.createDocument('http://www.w3.org/1999/xhtml', 'iframe', null);
      document.body.append(doc.documentElement);
      return { blocked: window.length === 0, detail: 'marcos: ' + window.length };
    });
    await attempt('marco anidado: XSLT', function () {
      if (!window.XSLTProcessor) return { blocked: true, detail: 'no existe' };
      return { blocked: false, detail: 'XSLTProcessor disponible' };
    });
    await attempt('marco anidado: elemento personalizado', function () {
      if (!window.HTMLIFrameElement) return { blocked: true, detail: 'no existe HTMLIFrameElement' };
      var C = class extends window.HTMLIFrameElement {};
      customElements.define('x-frame', C, { extends: 'iframe' });
      document.body.append(new C());
      return { blocked: window.length === 0, detail: 'marcos: ' + window.length };
    });
    await attempt('marco anidado: envenenar String y Function.call', function () {
      var realSplit = String.prototype.split;
      var realCall = Function.prototype.call;
      var leaked = null;
      Function.prototype.call = function () {
        leaked = this;
        return Reflect.apply(this, arguments[0], Array.prototype.slice.call(arguments, 1));
      };
      String.prototype.split = function () {
        return ['div'];
      };
      try {
        document.body.append(document.createElement('iframe'));
      } catch (e) {
        /* sigue */
      }
      Function.prototype.call = realCall;
      String.prototype.split = realSplit;
      if (leaked) document.body.append(leaked.apply(document, ['iframe']));
      return { blocked: window.length === 0, detail: 'marcos: ' + window.length };
    });
    await attempt('recursos de otra extensión', function () {
      return new Promise(function (resolve) {
        var i = document.createElement('img');
        i.src = 'venus-ext://hostile-victim/s.css';
        i.onload = function () {
          resolve({ blocked: false, detail: 'cargó' });
        };
        i.onerror = function () {
          resolve({ blocked: true, detail: 'bloqueado' });
        };
        document.body.append(i);
      });
    });
    await sleep(800);
  }

  async function code() {
    await attempt('eval', function () {
      return { blocked: false, detail: String(eval('1+1')) };
    });
    await attempt('new Function', function () {
      return { blocked: false, detail: String(new Function('return 1')()) };
    });
    await attempt('setTimeout con texto', function () {
      window.__tick = 0;
      setTimeout('window.__tick=1', 0);
      return sleep(100).then(function () {
        return window.__tick === 0;
      });
    });
    await attempt('script en línea', function () {
      window.__inline = 0;
      var s = document.createElement('script');
      s.text = 'window.__inline=1';
      document.body.append(s);
      return window.__inline === 0;
    });
    await attempt('atributo onclick en línea', function () {
      window.__attr = 0;
      var b = document.createElement('button');
      b.setAttribute('onclick', 'window.__attr=1');
      document.body.append(b);
      b.click();
      return window.__attr === 0;
    });
    await attempt('WebAssembly', function () {
      return WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])).then(function () {
        return { blocked: false, detail: 'compiló' };
      });
    });
  }

  async function ui() {
    await attempt('alert', function () {
      var t = Date.now();
      window.alert('falso diálogo del launcher');
      return { blocked: Date.now() - t < 200, detail: 'volvió sin mostrar nada' };
    });
    await attempt('confirm', function () {
      return window.confirm('falso') === false;
    });
    await attempt('prompt', function () {
      return window.prompt('Tu contraseña') === null;
    });
    await attempt('print', function () {
      window.print();
      return { blocked: true, detail: 'sin diálogo (lo confirma la captura)' };
    });
    await attempt('window.open', function () {
      var w = window.open('https://example.com/', '_blank');
      return { blocked: !w, detail: String(w) };
    });
    await attempt('window.open a la PC', function () {
      var w = window.open(net('popup'));
      return { blocked: !w, detail: String(w) };
    });
    await attempt('enlace target=_blank', function () {
      var a = document.createElement('a');
      a.href = net('blank');
      a.target = '_blank';
      document.body.append(a);
      a.click();
      return true;
    });
    await attempt('formulario a la PC', function () {
      var f = document.createElement('form');
      f.action = net('form');
      f.method = 'POST';
      document.body.append(f);
      f.submit();
      return sleep(200).then(function () {
        return true;
      });
    });
    await attempt('moveTo y resizeTo', function () {
      window.moveTo(0, 0);
      window.resizeTo(10, 10);
      return true;
    });
    await attempt('pantalla completa', function () {
      return document.documentElement.requestFullscreen().then(function () {
        return { blocked: false, detail: 'entró' };
      });
    });
    await attempt('Notification', function () {
      if (!window.Notification) return { blocked: true, detail: 'no existe' };
      return Promise.resolve(Notification.requestPermission()).then(function (p) {
        var shown = false;
        try {
          var n = new Notification('Venus Launcher', { body: 'Falso aviso del launcher' });
          n.onshow = function () {
            shown = true;
          };
          n.close();
        } catch (e) {
          /* sigue */
        }
        return sleep(300).then(function () {
          return { blocked: p !== 'granted' && !shown && Notification.permission !== 'granted', detail: p + ', Notification.permission=' + Notification.permission + ', mostrada=' + shown };
        });
      });
    });
    await attempt('micrófono y cámara', function () {
      if (!navigator.mediaDevices) return { blocked: true, detail: 'no existe' };
      return navigator.mediaDevices.getUserMedia({ audio: true }).then(function () {
        return { blocked: false, detail: 'concedido' };
      });
    });
    await attempt('compartir pantalla', function () {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) return { blocked: true, detail: 'no existe' };
      return navigator.mediaDevices.getDisplayMedia().then(function () {
        return { blocked: false, detail: 'concedido' };
      });
    });
    await attempt('portapapeles: navigator.clipboard', function () {
      if (!navigator.clipboard) return { blocked: true, detail: 'no existe' };
      return navigator.clipboard.readText().then(function (t) {
        return { blocked: false, detail: t };
      });
    });
    await attempt('portapapeles: execCommand copy', function () {
      if (!document.execCommand) return { blocked: true, detail: 'no existe' };
      return document.execCommand('copy') === false;
    });
    await attempt('sonido sin permiso: AudioContext', function () {
      if (!window.AudioContext) return { blocked: true, detail: 'no existe' };
      var ctx = new AudioContext();
      return sleep(150).then(function () {
        var state = ctx.state;
        ctx.close();
        return { blocked: state !== 'running', detail: 'estado: ' + state };
      });
    });
    await attempt('voz: speechSynthesis', function () {
      return window.speechSynthesis === undefined;
    });
    await attempt('geolocalización', function () {
      return new Promise(function (resolve) {
        if (!navigator.geolocation) return resolve({ blocked: true, detail: 'no existe' });
        navigator.geolocation.getCurrentPosition(
          function () {
            resolve({ blocked: false, detail: 'concedido' });
          },
          function (e) {
            resolve({ blocked: true, detail: e.message });
          },
        );
        setTimeout(function () {
          resolve({ blocked: true, detail: 'sin respuesta' });
        }, 500);
        return undefined;
      });
    });
    await attempt('foco: window.focus sin clic', function () {
      window.focus();
      return { blocked: !document.hasFocus(), detail: 'hasFocus=' + document.hasFocus() };
    });
    await attempt('foco: autofocus', function () {
      var i = document.createElement('input');
      i.autofocus = true;
      document.body.append(i);
      i.focus();
      return { blocked: !document.hasFocus(), detail: 'hasFocus=' + document.hasFocus() };
    });
  }

  async function navigation() {
    await attempt('top.location = internet', function () {
      window.top.location = 'https://example.com/';
      return { blocked: false, detail: 'sin error' };
    });
    await attempt('parent.location = la PC', function () {
      window.parent.location = net('top');
      return { blocked: false, detail: 'sin error' };
    });
    await attempt('top.location.hash a Ajustes', function () {
      window.top.location.hash = '#/settings';
      return { blocked: false, detail: 'sin error' };
    });
    await attempt('parent.location.replace', function () {
      window.parent.location.replace('#/settings');
      return { blocked: false, detail: 'sin error' };
    });
    await attempt('enlace target=_top', function () {
      var a = document.createElement('a');
      a.href = net('a-top');
      a.target = '_top';
      document.body.append(a);
      a.click();
      return true;
    });
    await attempt('enlace target=_parent', function () {
      var a = document.createElement('a');
      a.href = net('a-parent');
      a.target = '_parent';
      document.body.append(a);
      a.click();
      return true;
    });
    await attempt('cerrar la ventana: top.close', function () {
      window.top.close();
      return true;
    });
    await attempt('sacarle el foco: parent.blur', function () {
      window.parent.blur();
      return true;
    });
    await attempt('marco hermano: parent.frames[1].location', function () {
      if (window.parent.length < 2) return { blocked: true, detail: 'no hay otro marco' };
      window.parent.frames[1].location = net('sibling');
      return { blocked: false, detail: 'sin error' };
    });
  }

  async function baseHref() {
    await attempt('base href ajeno', function () {
      var b = document.createElement('base');
      b.href = net('base/');
      document.head.append(b);
      return document.baseURI.indexOf('127.0.0.1') < 0 || { blocked: true, detail: 'CSP base-uri: el documento no la aplica' };
    });
  }

  async function bridge() {
    // Mensajes malformados: el launcher no tiene que contestar ni romperse
    var junk = ['texto', 7, null, undefined, [], true, { venus: 2, id: 1 }, { venus: 1 }, { venus: 1, id: {} }, { venus: '1', id: 1, method: 'game.state' }, { type: 'hello' }, { source: 'venus', type: 'install', id: 'x' }, { venus: 1, id: 1, method: 'admin.ban', params: { user: 'x' } }];
    junk.forEach(function (j) {
      window.parent.postMessage(j, '*');
      window.top.postMessage(j, '*');
    });
    await sleep(10500); // que esta ráfaga no gaste el tope de lo que sigue
    var code = async function (name, method, params, want) {
      var r = await ask(method, params);
      results.push({ name: 'puente: ' + name, blocked: r.error === want, detail: JSON.stringify(r).slice(0, 110) });
    };
    await code('sin permiso read.instances', 'instances.list', {}, 'permission_denied');
    await code('sin permiso read.gameState', 'game.state', {}, 'permission_denied');
    await code('sin permiso action.openPage', 'launcher.openPage', { route: 'home' }, 'permission_denied');
    await code('sin permiso action.launchInstance', 'launcher.launchInstance', { instanceId: 'mi-instancia' }, 'permission_denied');
    await code('método que no existe', 'accounts.list', {}, 'unknown_method');
    await code('método que no existe: secure', 'secure.get', { key: 'ui:sb.venus-auth' }, 'unknown_method');
    await code('método __proto__', '__proto__', {}, 'unknown_method');
    await code('datos de otra extensión', 'storage.get', { key: 'k', extensionId: 'hostile-victim' }, 'bad_request');
    await code('ruta en la clave', 'storage.get', { key: '../hostile-victim/storage' }, 'bad_request');
    await code('clave __proto__', 'storage.set', { key: '__proto__', value: 1 }, 'bad_request');
    await code('valor enorme', 'storage.set', { key: 'g', value: new Array(300000).join('x') }, 'too_large');
    await code('valor con tipo raro', 'storage.set', { key: 'g', value: new Date() }, 'too_large');
    await code('valor con __proto__', 'storage.set', { key: 'g', value: JSON.parse('{"__proto__":{"admin":true}}') }, 'too_large');
    await code('título con otro tipo', 'notify.show', { title: { toString: 1 } }, 'bad_request');
    await sleep(10500);
    // Cupo de 1 MB
    var cuota = 'x'.repeat(200000);
    var last = null;
    for (var i = 0; i < 8; i++) last = await ask('storage.set', { key: 'cupo' + i, value: cuota });
    results.push({ name: 'puente: cupo de 1 MB', blocked: last.error === 'quota_exceeded', detail: JSON.stringify(last) });
    for (var j = 0; j < 8; j++) await ask('storage.remove', { key: 'cupo' + j });
    await sleep(10500);
    // Aviso con HTML y tope por minuto
    await ask('notify.show', { title: '<img src=x onerror="parent.__pwned=4">Falso aviso', text: '<b>Venus Launcher: </b>ingresá tu contraseña<script>parent.__pwned=5</script>' });
    var notifyStop = null;
    for (var n = 0; n < 8 && !notifyStop; n++) {
      var res = await ask('notify.show', { title: 'Aviso ' + n });
      if (!res.ok) notifyStop = res.error;
    }
    results.push({ name: 'puente: tope de avisos por minuto', blocked: notifyStop === 'rate_limited', detail: String(notifyStop) });
    // Desde un puerto transferido: no abre otra vía
    var ch = new MessageChannel();
    window.parent.postMessage({ venus: 1, id: 77, method: 'game.state' }, '*', [ch.port1]);
    await sleep(100);
  }

  async function run() {
    await escapes();
    await storageApis();
    await network();
    await code();
    await save();
    await ui();
    await navigation();
    await save();
    await baseHref();
    await bridge();
    await save();
    results.push({ name: 'FIN', blocked: true, detail: 'la página llegó viva al final' });
    await save();
    await ask('storage.set', { key: 'done' + cfg.stage, value: true }, 3000);
  }

  // Etapas que terminan matando la página: se corren de a una, recargando el marco entre medio. Un esquema inventado en
  // lugar de venus:// o mailto: para no abrir nada en la PC donde corre la prueba.
  var finishers = {
    1: 'venus-ext://hostile-victim/index.html',
    2: 'venus-ext://hostile/index.html',
    3: 'about:blank',
    4: 'about:srcdoc',
    6: 'https://example.com/',
    7: net('self'),
    8: 'data:text/html,<script>parent.postMessage(1,"*")<\/script>',
    9: 'file:///C:/Windows/win.ini',
    10: 'venus-hostile-test://x',
    11: 'javascript:window.__js=1',
  };

  async function finisher(stage) {
    var meta = stage === 12;
    results.push({ name: meta ? 'meta refresh a la PC' : 'navegar el marco a ' + finishers[stage], blocked: false, detail: 'intentando' });
    await save();
    await ask('storage.set', { key: 'done' + stage, value: true }, 3000);
    if (meta) {
      var m = document.createElement('meta');
      m.httpEquiv = 'refresh';
      m.content = '0;url=' + net('meta');
      document.head.append(m);
    } else window.location.href = finishers[stage];
    await sleep(1200);
    results[0].detail = 'la página sigue viva';
    results[0].blocked = window.__js !== 1;
    await save();
  }

  var boot = function () {
    if (cfg.stage === 0) run();
    else if (cfg.stage === 5) {
      // history.back: no tiene que mover al launcher
      results.push({ name: 'history.back y history.go', blocked: true, detail: 'lo define la prueba desde afuera' });
      save().then(function () {
        window.history.back();
        window.history.go(-2);
        return ask('storage.set', { key: 'done5', value: true }, 3000);
      });
    } else finisher(cfg.stage);
    sent += 1;
  };

  // El launcher manda hello al cargar; la etapa la deja run.js en el almacenamiento propio.
  window.addEventListener('message', function once(e) {
    if (e.source !== window.parent || !e.data || e.data.type !== 'hello') return;
    window.removeEventListener('message', once);
    ask('storage.get', { key: 'stage' }, 3000).then(function (r) {
      cfg.stage = Number(r.result) || 0;
      boot();
    });
  });
})();
