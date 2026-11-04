// Puente entre una extensión y el launcher: la lógica, sin DOM (se prueba con Node). Lo que llega desde el iframe es
// hostil: esquema cerrado, tipos y tamaños validados, permiso comprobado en cada pedido y topes de frecuencia. Lo que
// sale son copias planas. El marco (frame.js) le pasa solo los mensajes del iframe correcto.
export const BRIDGE_VERSION = 1;

// Las únicas páginas del launcher que una extensión puede abrir. Nada de Ajustes, cuentas, mensajes ni administración.
export const ROUTES = Object.freeze(['home', 'versions', 'worlds', 'modrinth', 'stats', 'performance', 'skins', 'seeds', 'music', 'clips', 'achievements', 'rewards', 'multiplayer', 'servers', 'updates']);

export const LIMITS = Object.freeze({
  burst: 40, // mensajes por ventana: de ahí en más se descartan
  flood: 400, // mensajes por ventana: de ahí en más se corta la extensión
  windowMs: 10 * 1000,
  inFlight: 8,
  keyChars: 64,
  valueChars: 256 * 1024,
  valueNodes: 20000,
  valueDepth: 16,
  idChars: 40,
  notifyTitle: 60,
  notifyText: 200,
  routeChars: 32,
  instanceIdChars: 128,
  notifyPerMinute: 5,
  openPagePerMinute: 5,
  launchPerMinute: 3,
  instances: 200,
});

// Errores que puede ver una extensión. Cualquier otro sale como 'internal': un error interno no se le cuenta.
export const ERROR_CODES = Object.freeze(['bad_request', 'unknown_method', 'permission_denied', 'too_large', 'rate_limited', 'quota_exceeded', 'not_allowed', 'not_found', 'declined', 'busy', 'internal']);

const METHODS = Object.freeze({
  'storage.get': { perm: 'storage', params: { key: 'key' } },
  'storage.set': { perm: 'storage', params: { key: 'key', value: 'json' } },
  'storage.remove': { perm: 'storage', params: { key: 'key' } },
  'storage.keys': { perm: 'storage', params: {} },
  'notify.show': { perm: 'notify', params: { title: 'title', text: 'text?' } },
  'instances.list': { perm: 'read.instances', params: {} },
  'game.state': { perm: 'read.gameState', params: {} },
  'launcher.openPage': { perm: 'action.openPage', params: { route: 'route' } },
  'launcher.launchInstance': { perm: 'action.launchInstance', params: { instanceId: 'instanceId' } },
});
export const METHOD_NAMES = Object.freeze(Object.keys(METHODS));

const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const KEY_RE = /^[A-Za-z0-9._-]{1,64}$/;
const INSTANCE_RE = /^[^/\\\0]{1,128}$/;
const span = (a, b) => `${String.fromCharCode(a)}-${String.fromCharCode(b)}`;
// Controles, invisibles y marcas de dirección: los textos de una extensión no se pueden disfrazar.
const INVISIBLE = new RegExp(`[${[span(0, 0x1f), span(0x7f, 0x9f), span(0xad, 0xad), span(0x200b, 0x200f), span(0x2028, 0x202e), span(0x2060, 0x206f), span(0xfeff, 0xfeff)].join('')}]`, 'g');

export function cleanText(value, max) {
  return String(value ?? '')
    .replace(INVISIBLE, ' ')
    .replace(/ {2,}/g, ' ')
    .trim()
    .slice(0, max);
}

export function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// ¿Es JSON de verdad y entra en el presupuesto? Corta apenas se pasa: un mensaje gigante no se recorre entero.
export function checkJson(value, budget = { nodes: LIMITS.valueNodes, chars: LIMITS.valueChars }, depth = 0) {
  if (depth > LIMITS.valueDepth) return false;
  budget.nodes -= 1;
  if (budget.nodes < 0) return false;
  if (value === null) return true;
  switch (typeof value) {
    case 'boolean':
      return true;
    case 'number':
      return Number.isFinite(value);
    case 'string':
      budget.chars -= value.length;
      return budget.chars >= 0;
    case 'object':
      break;
    default:
      return false;
  }
  if (Array.isArray(value)) {
    if (value.length > budget.nodes) return false;
    for (let i = 0; i < value.length; i++) if (!checkJson(value[i], budget, depth + 1)) return false;
    return true;
  }
  if (!isPlainObject(value)) return false;
  for (const key of Object.keys(value)) {
    if (BAD_KEYS.has(key)) return false;
    budget.chars -= key.length;
    if (budget.chars < 0 || !checkJson(value[key], budget, depth + 1)) return false;
  }
  return true;
}

function checkParam(kind, value) {
  switch (kind) {
    case 'key':
      return typeof value === 'string' && KEY_RE.test(value) && !BAD_KEYS.has(value);
    case 'json':
      return checkJson(value);
    case 'title':
      return typeof value === 'string' && value.length > 0 && value.length <= LIMITS.notifyTitle * 4;
    case 'text?':
      return value === undefined || (typeof value === 'string' && value.length <= LIMITS.notifyText * 4);
    case 'route':
      return typeof value === 'string' && value.length <= LIMITS.routeChars;
    case 'instanceId':
      return typeof value === 'string' && INSTANCE_RE.test(value);
    default:
      return false;
  }
}

// Sobre del mensaje. Sin un id válido no hay a quién contestarle: se ignora.
export function parseEnvelope(data) {
  if (!isPlainObject(data) || data.venus !== BRIDGE_VERSION) return null;
  const keys = Object.keys(data);
  const { id, method, params } = data;
  const okId = (typeof id === 'number' && Number.isSafeInteger(id)) || (typeof id === 'string' && id.length > 0 && id.length <= LIMITS.idChars);
  if (!okId) return null;
  if (keys.length > 4 || keys.some((k) => !['venus', 'id', 'method', 'params'].includes(k))) return { id, error: 'bad_request' };
  if (typeof method !== 'string' || method.length > 40) return { id, error: 'bad_request' };
  if (!Object.prototype.hasOwnProperty.call(METHODS, method)) return { id, error: 'unknown_method' };
  if (params !== undefined && !isPlainObject(params)) return { id, error: 'bad_request' };
  const spec = METHODS[method];
  const given = params || {};
  for (const key of Object.keys(given)) if (!Object.prototype.hasOwnProperty.call(spec.params, key)) return { id, error: 'bad_request' };
  for (const [key, kind] of Object.entries(spec.params)) {
    if (!checkParam(kind, given[key])) {
      const tooLarge = kind === 'json' && given[key] !== undefined;
      return { id, error: tooLarge ? 'too_large' : 'bad_request' };
    }
  }
  return { id, method, params: given, perm: spec.perm };
}

// Ventana deslizante simple: cuenta lo que entró en los últimos windowMs.
export function createLimiter(limit, windowMs, now = Date.now) {
  let start = now();
  let count = 0;
  return {
    take() {
      const t = now();
      if (t - start >= windowMs) {
        start = t;
        count = 0;
      }
      count += 1;
      return count <= limit;
    },
    count: () => count,
  };
}

// Vista de una instancia: id, nombre, versión y cargador. Sin rutas ni nada más de lo que trae la instancia.
export function instanceView(inst) {
  return { id: String(inst?.id ?? ''), name: String(inst?.name ?? ''), version: String(inst?.mcVersion ?? ''), loader: String(inst?.loader ?? '') };
}

export function gameStateView(running) {
  const ids = Object.entries(running && typeof running === 'object' ? running : {})
    .filter(([, st]) => st && st.state === 'running')
    .map(([id]) => String(id));
  return { running: ids.length > 0, instances: ids };
}

const plainCopy = (value) => (value === undefined ? null : JSON.parse(JSON.stringify(value)));

/**
 * Un puente por marco. permissions: los aceptados. handlers: { storage(op, key, value), notify(title, text),
 * instances(), gameState(), openPage(route), launchInstance(id) }; pueden lanzar un error con .code.
 * admit() se llama antes de leer el mensaje: 'ok', 'drop' o 'flood'. handle(data) -> respuesta o null.
 */
export function createBridge({ permissions, handlers, now = Date.now }) {
  const granted = new Set(permissions || []);
  const burst = createLimiter(LIMITS.burst, LIMITS.windowMs, now);
  const flood = createLimiter(LIMITS.flood, LIMITS.windowMs, now);
  const perMinute = {
    'notify.show': createLimiter(LIMITS.notifyPerMinute, 60000, now),
    'launcher.openPage': createLimiter(LIMITS.openPagePerMinute, 60000, now),
    'launcher.launchInstance': createLimiter(LIMITS.launchPerMinute, 60000, now),
  };
  let inFlight = 0;

  const fail = (id, error) => ({ venus: BRIDGE_VERSION, id, ok: false, error: ERROR_CODES.includes(error) ? error : 'internal' });
  const done = (id, result) => ({ venus: BRIDGE_VERSION, id, ok: true, result: plainCopy(result) });

  function run(method, params) {
    switch (method) {
      case 'storage.get':
        return handlers.storage('get', params.key);
      case 'storage.set':
        return handlers.storage('set', params.key, params.value);
      case 'storage.remove':
        return handlers.storage('remove', params.key);
      case 'storage.keys':
        return handlers.storage('keys');
      case 'notify.show': {
        const title = cleanText(params.title, LIMITS.notifyTitle);
        if (!title) throw Object.assign(new Error('title'), { code: 'bad_request' });
        return handlers.notify(title, cleanText(params.text, LIMITS.notifyText));
      }
      case 'instances.list':
        return Promise.resolve(handlers.instances()).then((list) => (Array.isArray(list) ? list : []).slice(0, LIMITS.instances).map(instanceView));
      case 'game.state':
        return handlers.gameState();
      case 'launcher.openPage':
        if (!ROUTES.includes(params.route)) throw Object.assign(new Error('route'), { code: 'not_allowed' });
        return handlers.openPage(params.route);
      case 'launcher.launchInstance':
        return handlers.launchInstance(params.instanceId);
      default:
        throw Object.assign(new Error('method'), { code: 'unknown_method' });
    }
  }

  return {
    // Se mira antes de tocar event.data: el contenido del mensaje recién se deserializa al leerlo.
    admit() {
      if (!flood.take()) return 'flood';
      return burst.take() ? 'ok' : 'drop';
    },
    async handle(data) {
      const msg = parseEnvelope(data);
      if (!msg) return null;
      if (msg.error) return fail(msg.id, msg.error);
      if (!granted.has(msg.perm)) return fail(msg.id, 'permission_denied');
      if (perMinute[msg.method] && !perMinute[msg.method].take()) return fail(msg.id, 'rate_limited');
      if (inFlight >= LIMITS.inFlight) return fail(msg.id, 'busy');
      inFlight += 1;
      try {
        return done(msg.id, await run(msg.method, msg.params));
      } catch (err) {
        return fail(msg.id, typeof err?.code === 'string' ? err.code : 'internal');
      } finally {
        inFlight -= 1;
      }
    },
  };
}
