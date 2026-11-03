// Comparar dos instancias: diferencias de listas de mods y campos. node --test "src/renderer/js/pages/versions/test/"
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeName, entryKey, diffLists, compareFields, diffCount, diffText } from '../compare-diff.js';

const mod = (name, version, extra = {}) => ({ name, version, file: `${name.toLowerCase()}-${version || 'x'}.jar`, enabled: true, ...extra });

test('normalizeName y entryKey: proyecto antes que nombre, sin .disabled ni extension', () => {
  assert.equal(normalizeName('Sodium-0.5.jar.disabled'), 'sodium-0.5');
  assert.equal(normalizeName('pack.ZIP'), 'pack');
  assert.equal(entryKey({ projectId: 'AANobbMI', name: 'Sodium' }), 'p:aanobbmi');
  assert.equal(entryKey({ modId: '394468', name: 'Lithium' }), 'c:394468');
  assert.equal(entryKey({ name: 'Iris Shaders' }), 'n:iris shaders');
  assert.equal(entryKey({ file: 'X.jar' }), 'n:x');
});

test('diffLists: agregados, quitados, distintos e iguales', () => {
  const a = [mod('Sodium', '0.5.8', { projectId: 'AANobbMI' }), mod('Lithium', '0.12'), mod('Iris', '1.7'), mod('Solo A', '1')];
  const b = [mod('Sodium', '0.6.0', { projectId: 'AANobbMI' }), mod('lithium', '0.12'), mod('Iris', '1.7', { enabled: false }), mod('Solo B', '2')];
  const d = diffLists(a, b);
  assert.deepEqual(d.same.map((x) => x.a.name), ['Lithium']);
  assert.deepEqual(d.changed.map((x) => [x.a.name, x.a.version, x.b.version]), [
    ['Iris', '1.7', '1.7'],
    ['Sodium', '0.5.8', '0.6.0'],
  ]);
  assert.deepEqual(d.removed.map((x) => x.name), ['Solo A']);
  assert.deepEqual(d.added.map((x) => x.name), ['Solo B']);
  assert.equal(diffCount(d), 4);
  assert.deepEqual(diffLists([], []), { same: [], changed: [], removed: [], added: [] });
  assert.equal(diffCount(diffLists(undefined, undefined)), 0);
});

test('diffLists: sin version conocida compara el nombre del archivo y no repite claves', () => {
  const a = [{ name: 'Mod', file: 'mod-1.0.jar' }, { name: 'Mod', file: 'mod-1.0.jar' }];
  const b = [{ name: 'Mod', file: 'mod-1.1.jar' }];
  const d = diffLists(a, b);
  assert.equal(d.changed.length, 1);
  assert.equal(d.same.length, 0);
  assert.equal(diffLists([{ name: 'Mod', file: 'mod-1.0.jar' }], [{ name: 'mod', file: 'MOD-1.0.jar' }]).same.length, 1);
});

test('compareFields marca iguales sin distinguir espacios ni mayusculas', () => {
  const rows = compareFields([
    { key: 'mc', label: 'Minecraft', a: '1.21', b: '1.21 ' },
    { key: 'loader', label: 'Loader', a: 'Fabric', b: 'forge' },
    { key: 'java', label: 'Java', a: '', b: null },
  ]);
  assert.deepEqual(rows.map((r) => r.same), [true, false, true]);
});

test('diffText: solo lo distinto, con secciones y textos propios', () => {
  const fields = compareFields([
    { key: 'mc', label: 'Minecraft', a: '1.21', b: '1.21' },
    { key: 'loader', label: 'Loader', a: 'Fabric', b: 'Forge' },
  ]);
  const mods = diffLists([mod('Sodium', '1'), mod('Solo A', '1')], [mod('Sodium', '2'), mod('Solo B', '3', { enabled: false })]);
  const text = diffText({ names: ['Uno', 'Dos'], fields, sections: [{ title: 'Mods', diff: mods }, { title: 'Shaders', diff: diffLists([], []) }], texts: { onlyIn: 'Solo en {name}', changed: 'Distintos', same: '{count} iguales', none: 'Nada' } });
  assert.equal(
    text,
    ['Uno  |  Dos', '', 'Loader: Fabric  |  Forge', '', '== Mods ==', 'Solo en Uno', '  - Solo A 1', 'Solo en Dos', '  + Solo B 3 (off)', 'Distintos', '  ~ Sodium 1  ->  Sodium 2'].join('\n'),
  );
  assert.equal(diffText({ names: ['A', 'B'], fields: compareFields([{ label: 'x', a: 1, b: 1 }]), texts: { none: 'Sin diferencias' } }), 'A  |  B\n\nSin diferencias');
  // same y onlyIn como funciones (textos con plural de t())
  const fn = diffText({ names: ['Uno', 'Dos'], sections: [{ title: 'Mods', diff: diffLists([mod('A', '1'), mod('B', '1')], [mod('A', '1'), mod('C', '1')]) }], texts: { onlyIn: (n) => `Nada mas en ${n}`, same: (c) => (c === 1 ? '1 igual' : `${c} iguales`) } });
  assert.equal(fn, ['Uno  |  Dos', '', '== Mods ==', 'Nada mas en Uno', '  - B 1', 'Nada mas en Dos', '  + C 1', '1 igual'].join('\n'));
});
