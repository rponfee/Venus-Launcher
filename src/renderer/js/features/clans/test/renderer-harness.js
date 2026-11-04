// DOM mínimo para regresiones de eventos y respuestas tardías. No reemplaza pruebas en Electron.
import fs from 'node:fs';
import vm from 'node:vm';

export const flush = () => new Promise((resolve) => setImmediate(resolve));
export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export function harness() {
  const nodes = [], intervals = new Map(), timeouts = new Map(), errors = [];
  let seq = 0;
  function h(tag, props = {}, ...children) {
    const listeners = new Map(), classes = new Set(String(props.class || '').split(' '));
    const node = {
      tag, value: '', disabled: false, hidden: false, style: {}, dataset: {}, children: [], parent: null,
      scrollHeight: 100, scrollTop: 0, clientHeight: 100, focuses: 0,
      ...props,
      classList: { add: (...items) => items.forEach((x) => classes.add(x)), remove: (...items) => items.forEach((x) => classes.delete(x)), toggle: (x, on) => on ? classes.add(x) : classes.delete(x) },
      hasClass: (x) => classes.has(x),
      addEventListener(type, fn) { listeners.set(type, [...(listeners.get(type) || []), fn]); },
      fire(type, props = {}) {
        const event = { currentTarget: node, key: '', preventDefault() {}, ...props };
        return Promise.all([...(listeners.get(type) || []), ...(typeof node[`on${type}`] === 'function' ? [node[`on${type}`]] : [])].map((fn) => fn(event)));
      },
      setAttribute(key, val) { this[key] = val; },
      focus() { this.focuses++; },
      get isConnected() { return this === root || !!this.parent?.isConnected; },
    };
    nodes.push(node);
    mount(node, ...children);
    return node;
  }
  function mount(node, ...children) {
    for (const child of node.children) if (typeof child === 'object') child.parent = null;
    node.children = children.flat(Infinity).filter((x) => x != null && x !== false);
    for (const child of node.children) if (typeof child === 'object') child.parent = node;
    return node;
  }
  const root = h('root');
  const deps = {
    h, mount, icon: (name) => h('i', { name }),
    t: (key) => key, locale: () => 'es',
    skeleton: () => h('skeleton'), emptyState: (...text) => h('empty', {}, ...text),
    setBusy: (button) => { const before = button.disabled; button.disabled = true; return () => { button.disabled = before; }; },
    fail: (...args) => errors.push(args), ok() {}, errText: (err) => err?.code || 'error',
    fmtTime: String, fmtDate: String, fmtAgo: String, loadNs: async () => {},
    renderBody: (body) => body, headImg: () => h('avatar'), openProfile() {},
    confirmDialog: async () => true, navigate() {},
    document: { visibilityState: 'visible' }, history: { replaceState() {} },
    setInterval: (fn) => { const id = ++seq; intervals.set(id, fn); return id; }, clearInterval: (id) => intervals.delete(id),
    setTimeout: (fn) => { const id = ++seq; timeouts.set(id, fn); return id; }, clearTimeout: (id) => timeouts.delete(id),
    console,
  };
  // Se ejecuta el módulo real con sus dependencias de UI sustituidas; la lógica pura se importa sin cambios en cada prueba.
  function load(url, injected = {}, names = []) {
    let source = fs.readFileSync(url, 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/export default /, 'const page = ').replace(/^export /gm, '');
    source = `(function() { ${source}\nreturn { ${names.join(',')} }; })()`;
    return vm.runInNewContext(source, { ...deps, ...injected }, { filename: url.pathname });
  }
  return { root, nodes, deps, errors, intervals, timeouts, load, find: (cls) => nodes.find((n) => n.hasClass(cls)) };
}
