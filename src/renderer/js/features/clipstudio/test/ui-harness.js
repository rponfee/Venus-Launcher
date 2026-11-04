'use strict';
// DOM minimo para ejecutar los controladores reales con IPC y WebCodecs ficticios, sin Electron.
const fs = require('fs');
const vm = require('vm');

class Element {
  constructor(tag, props = {}) {
    this.tag = tag; this.children = []; this.parent = null; this.attached = false;
    this.style = {}; this.listeners = {}; this.attrs = {}; this.disabled = false;
    this.className = (Array.isArray(props.class) ? props.class.filter(Boolean).join(' ') : props.class) || '';
    this.classList = { add: value => { this.className += ' ' + value; } };
    Object.assign(this, props);
    Object.assign(this.attrs, props);
  }
  get isConnected() { return this.attached || Boolean(this.parent?.isConnected); }
  get firstChild() { return this.children[0]; }
  get textContent() { return this.text ?? this.children.map(x => x instanceof Element ? x.textContent : String(x)).join(''); }
  set textContent(value) { this.text = String(value); }
  append(...items) {
    for (const item of items.flat(Infinity)) {
      if (item == null || item === false) continue;
      if (item instanceof Element) item.parent = this;
      this.children.push(item);
    }
  }
  replaceWith(next) {
    const parent = this.parent;
    if (!parent) return;
    parent.children[parent.children.indexOf(this)] = next;
    next.parent = parent; this.parent = null;
  }
  setAttribute(key, value) { this.attrs[key] = value; }
  addEventListener(key, fn) { this.listeners[key] = fn; }
  focus() {} select() {}
  click() { if (!this.disabled) return (this.listeners.click || this.onclick)?.({ currentTarget: this }); }
  matches(selector) { return selector.startsWith('.') ? this.className.split(/\s+/).includes(selector.slice(1)) : this.tag === selector; }
  querySelectorAll(selector) {
    const result = [];
    const walk = el => { for (const child of el.children) if (child instanceof Element) { if (selector.split(',').some(s => child.matches(s.trim()))) result.push(child); walk(child); } };
    walk(this); return result;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
function ui() {
  const dialogs = []; const failures = [];
  const h = (tag, props, ...items) => { const el = new Element(tag, props); el.append(...items); return el; };
  const mount = (el, ...items) => { for (const child of el.children) if (child instanceof Element) child.parent = null; el.children = []; el.append(...items); return el; };
  const deps = {
    h, mount, t: x => x, icon: x => h('i', {}, x), ok() {}, toast() {}, fail: (...args) => failures.push(args),
    emptyState: (...args) => h('div', {}, ...args), skeleton: () => h('div'), loading: () => h('div'),
    fmtDate: String, fmtAgo: String, fmtBytes: String, clock: String, avatarImg: () => h('img'), reasonBadge: () => null,
    modal: opts => {
      const el = h('div', {}, opts.body, opts.footer); el.attached = true;
      const dialog = { el, close() { el.attached = false; opts.onClose?.(); } }; dialogs.push(dialog); return dialog;
    },
    selectEl: (options, value, change) => h('select', { value, change }),
    switchEl: (value, change) => h('input', { value, change }),
    setBusy: el => { const was = el.disabled; el.disabled = true; return () => { el.disabled = was; }; },
    confirmDialog: async () => true, ensureCss() {}, loadNs: async () => {},
  };
  return { deps, dialogs, failures, Element };
}
function loadRenderer(file, names, deps) {
  const source = fs.readFileSync(file, 'utf8').replace(/^import .*;\r?$/gm, '').replace(/^export /gm, '');
  return vm.runInNewContext(source + '\n;({' + names.join(',') + '});', { console, URL, Blob, setTimeout, clearTimeout, ...deps }, { filename: file });
}
const turn = () => new Promise(r => setImmediate(r));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
module.exports = { ui, loadRenderer, turn, deferred };
