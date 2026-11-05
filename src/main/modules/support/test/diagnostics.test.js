'use strict';
// Diagnóstico: qué partes existen, cuáles arrancan tildadas, que lo que se ve es lo que se manda y que no se escapa nada personal.
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSections, assemble, defaultIds, finalize, collectRaw, pickLines, createSupportRedactor } = require('../diagnostics');

const redactor = createSupportRedactor({ homedir: 'C:\\Users\\Mateo', username: 'Mateo', hostname: 'DESKTOP-MATEO1', players: ['MateoBuilds'], dataDir: 'C:\\Users\\Mateo\\AppData\\Roaming\\.venuslauncher' });

const RAW = {
  app: { version: '4.6.0', electron: '44.0.0', packaged: true, portable: false, osName: 'Windows 11 (10.0.26200)', arch: 'x64', language: 'es' },
  system: { totalMemMb: 16384, freeMemMb: 7212, cpu: 'AMD Ryzen 5 5600', cores: 12, gpu: 'NVIDIA GeForce RTX 3060' },
  java: { requiredMajor: 21, selectedPath: 'C:\\Users\\Mateo\\.jdks\\jdk-21\\bin\\javaw.exe', selected: { version: '21.0.4', vendor: 'Eclipse Adoptium' }, installed: [17, 21], jvmArgs: '-Xmx4G -Djava.library.path=C:\\Users\\Mateo\\AppData\\Roaming\\.venuslauncher\\natives' },
  instance: { mcVersion: '1.21.1', loader: 'fabric', loaderVersion: '0.16.5', memoryMb: 4096, mods: { total: 3, enabled: 2 }, modFiles: ['a.jar', 'b.jar', 'c.jar.disabled'] },
  log: { lines: ['[main/INFO]: Setting user: MateoBuilds', '[main/ERROR]: fallo en D:\\Juegos\\MC\\mods\\a.jar', '[CHAT] <x> hola'] },
};

test('partes: están todas las que hay datos y solo las tres primeras arrancan tildadas', () => {
  const sections = buildSections(RAW, redactor);
  assert.deepEqual(sections.map((s) => s.id), ['app', 'java', 'instance', 'mods', 'log']);
  assert.deepEqual(defaultIds(sections), ['app', 'java', 'instance']);
  assert.ok(sections.every((s) => !s.on || ['app', 'java', 'instance'].includes(s.id)));
});

test('sin instancia no hay partes de instancia, de mods ni de registro', () => {
  const sections = buildSections({ ...RAW, instance: null, log: null }, redactor);
  assert.deepEqual(sections.map((s) => s.id), ['app', 'java']);
});

test('el texto es el que se manda: nada de nombres, discos ni cuentas en ninguna parte', () => {
  const sections = buildSections(RAW, redactor);
  const all = assemble(sections, sections.map((s) => s.id));
  assert.doesNotMatch(all.text, /Mateo|MATEO|Juegos|\.jdks|C:\\|D:\\|<x>/);
  assert.match(all.text, /launcher: 4\.6\.0/);
  assert.match(all.text, /os: Windows 11 \(10\.0\.26200\) x64/);
  assert.match(all.text, /ram: 16 GB \(free 7\.0 GB\)/);
  assert.match(all.text, /java\.selected: 21\.0\.4 \(Eclipse Adoptium\)/);
  assert.match(all.text, /java\.path: <ruta>\/bin\/javaw\.exe/);
  assert.match(all.text, /\[CHAT\] <oculto>/);
  assert.match(all.text, /<ruta>\/mods\/a\.jar/);
  assert.ok(all.redactions.total >= 5);
  assert.equal(all.truncated, false);
});

test('solo se arma lo que se tilda y el orden es el de siempre', () => {
  const sections = buildSections(RAW, redactor);
  const some = assemble(sections, ['log', 'app']);
  assert.match(some.text, /^\[app\]\n/);
  assert.match(some.text, /\n\n\[log\]\n/);
  assert.doesNotMatch(some.text, /\[java\]|\[instance\]|\[mods\]/);
  assert.equal(assemble(sections, []).text, '');
  assert.equal(assemble(sections, ['inventada']).text, '');
});

test('tope de 12000: se recorta el principio del registro y nunca el resto', () => {
  const lines = Array.from({ length: 400 }, (_, i) => `[main/INFO]: línea ${i} ${'x'.repeat(60)}`);
  const sections = buildSections({ ...RAW, log: { lines } }, redactor);
  const out = assemble(sections, ['app', 'log']);
  assert.ok(out.text.length <= 12000);
  assert.equal(out.truncated, true);
  assert.match(out.text, /\[app\]\nlauncher: 4\.6\.0/);
  assert.match(out.text, /línea 399/);
  assert.doesNotMatch(out.text, /línea 0 /);
});

test('cada línea del registro se acota', () => {
  const sections = buildSections({ ...RAW, log: { lines: ['y'.repeat(5000)] } }, redactor);
  assert.ok(sections.find((s) => s.id === 'log').text.length <= 300);
});

test('lista de mods: hasta 150 nombres y aviso de los que sobran', () => {
  const modFiles = Array.from({ length: 200 }, (_, i) => `mod-${String(i).padStart(3, '0')}.jar`);
  const sections = buildSections({ ...RAW, instance: { ...RAW.instance, modFiles } }, redactor);
  const text = sections.find((s) => s.id === 'mods').text;
  assert.equal(text.split('\n').length, 151);
  assert.match(text, /… \+50$/);
});

test('finalize: segunda pasada que tapa lo que se haya escapado y recorta', () => {
  assert.equal(finalize('  launcher: 4.6.0  ', redactor), 'launcher: 4.6.0');
  assert.doesNotMatch(finalize('mail mateo@example.com en C:\\Users\\Mateo\\x', redactor), /example|Mateo/);
  const once = finalize('D:\\Juegos\\mods\\a.jar y DESKTOP-MATEO1', redactor);
  assert.equal(finalize(once, redactor), once);
  assert.ok(finalize('z'.repeat(20000), redactor).length <= 12000);
});

test('cantidad de líneas: solo 50, 100 o 200', () => {
  assert.equal(pickLines(50), 50);
  assert.equal(pickLines('200'), 200);
  assert.equal(pickLines(7), 100);
  assert.equal(pickLines(undefined), 100);
});

test('recolección: todo lo que falla se omite y el registro respeta la cantidad pedida', async () => {
  const log = Array.from({ length: 300 }, (_, i) => `l${i}`).join('\n');
  const files = new Map([['latest.log', log]]);
  const deps = {
    app: { version: '4.6.0', electron: '44.0.0', packaged: true, portable: false, language: 'en' },
    os: { release: () => '10.0.26200', cpus: () => [{ model: 'Cpu (R) X' }], totalmem: () => 8 * 1073741824, freemem: () => 2 * 1073741824 },
    path: require('path'),
    fsp: {
      readdir: async () => ['a.jar', 'b.jar.disabled', 'leeme.txt'],
      open: async (file) => {
        const buf = Buffer.from(files.get(require('path').basename(file)) || '');
        return { stat: async () => ({ size: buf.length }), read: async (target, off, len, pos) => { buf.copy(target, off, pos, pos + len); }, close: async () => {} };
      },
    },
    instances: { get: async () => ({ id: 'x', dir: 'C:\\x', mcVersion: '1.21.1', loader: 'fabric', loaderVersion: '0.16.5', memory: {} }), dir: () => 'C:\\x' },
    settings: { get: async () => ({ memory: { max: 3072 }, jvmArgs: '-Xmx3G' }) },
    java: { majorForMinecraft: () => 21, getJavaVersion: async () => { throw new Error('no'); }, listInstalledRuntimes: async () => [{ major: 21 }, { major: 17 }, { major: 21 }] },
    gpu: async () => { throw new Error('sin gpu'); },
  };
  const raw = await collectRaw(deps, { instanceId: 'x', logLines: 50 });
  assert.equal(raw.instance.mods.total, 2);
  assert.equal(raw.instance.mods.enabled, 1);
  assert.equal(raw.instance.memoryMb, 3072);
  assert.equal(raw.system.gpu, '');
  assert.deepEqual(raw.java.installed, [17, 21]);
  assert.equal(raw.log.lines.length, 50);
  assert.equal(raw.log.lines.at(-1), 'l299');
  // sin instancia: solo launcher y sistema
  const bare = await collectRaw({ ...deps, instances: { get: async () => { throw new Error('no existe'); } } }, { instanceId: 'x' });
  assert.equal(bare.instance, null);
  assert.equal(bare.log, null);
});
