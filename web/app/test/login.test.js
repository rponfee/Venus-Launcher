'use strict';
// Formulario real con nodos mínimos y el cliente falso: sin navegador ni cuentas reales.
const { test } = require('node:test');
const assert = require('node:assert/strict');

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.listeners = {}; this.value = ''; this.classList = { add() {} }; }
  setAttribute(key, value) { this.attrs[key] = value; }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  append(node) { this.children.push(node); }
  replaceChildren() { this.children = []; }
  get textContent() { return this.text ?? this.children.map((child) => child.textContent).join(''); }
}
const find = (root, predicate) => predicate(root) ? root : root.children.map((child) => find(child, predicate)).find(Boolean);
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('recuperar permite reintentar el guardado sin volver a consumir el código', async (t) => {
  const [{ renderLogin }, { createFakeClient }] = await Promise.all([import('../js/screens/login.js'), import('../dev/fake.js')]);
  const oldDocument = globalThis.document, oldNode = globalThis.Node;
  globalThis.Node = Element;
  globalThis.document = { createElement: (tag) => new Element(tag), createElementNS: (_ns, tag) => new Element(tag), createTextNode: (text) => Object.assign(new Element('#text'), { text }) };
  t.after(() => { globalThis.document = oldDocument; globalThis.Node = oldNode; });
  const root = new Element('root');
  const client = createFakeClient({ signedIn: false });
  const events = [];
  client.auth.onAuthStateChange((event) => events.push(event));
  let verified = 0;
  const originalVerify = client.auth.verifyOtp;
  client.auth.verifyOtp = (...args) => { verified++; return originalVerify(...args); };
  renderLogin(root, { client, tr: (key) => key });
  find(root, (el) => el.tag === 'button' && el.textContent === 'login_forgot').listeners.click();
  find(root, (el) => el.attrs.id === 'l-email').value = 'prueba@example.invalid';
  find(root, (el) => el.tag === 'form').listeners.submit({ preventDefault() {} });
  await tick();
  find(root, (el) => el.attrs.id === 'l-code').value = '123456';
  find(root, (el) => el.attrs.id === 'l-pass').value = 'clave-de-prueba';
  client.__fake.db.fail = { updateUser: { code: 'same_password', message: 'same_password' } };
  find(root, (el) => el.tag === 'form').listeners.submit({ preventDefault() {} });
  await tick();
  assert.deepEqual(events, ['PASSWORD_RECOVERY']);
  assert.ok(root.textContent.includes('auth_same_password'));
  assert.equal(find(root, (el) => el.attrs.id === 'l-code'), undefined);
  assert.ok(root.textContent.includes('reset_save'));
  client.__fake.db.fail = null;
  find(root, (el) => el.attrs.id === 'l-pass').value = 'otra-clave-de-prueba';
  find(root, (el) => el.tag === 'form').listeners.submit({ preventDefault() {} });
  await tick();
  assert.equal(verified, 1);
  assert.deepEqual(events, ['PASSWORD_RECOVERY', 'USER_UPDATED']);
});
