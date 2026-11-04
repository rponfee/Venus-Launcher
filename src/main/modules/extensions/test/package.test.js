// Lector del paquete: zip-slip, bombas y archivos prohibidos. node --test "src/main/modules/extensions/test/*.test.js"
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { readPackage, writePackage, LIMITS } = require('../package');
const { ExtensionError } = require('../manifest');
const { makeZip, manifest, goodFiles, PNG } = require('./helpers');

const rejects = (buf, code) => {
  assert.throws(
    () => readPackage(buf),
    (err) => {
      assert.ok(err instanceof ExtensionError, err.message);
      assert.equal(err.code, code, err.message);
      return true;
    },
  );
};

test('un paquete correcto se lee entero', () => {
  const pkg = readPackage(makeZip([...goodFiles(), { name: 'img/logo.png', data: PNG }, { name: 'style.css', data: 'body{color:red}' }]));
  assert.equal(pkg.manifest.id, 'mi-extension');
  assert.deepEqual(pkg.files.map((f) => f.path).sort(), ['app.js', 'img/logo.png', 'index.html', 'style.css']);
  assert.match(pkg.sha256, /^[0-9a-f]{64}$/);
});

test('zip-slip y rutas raras', () => {
  const bad = ['../evil.js', '..\\evil.js', 'a/../../evil.js', '/evil.js', 'C:/evil.js', 'C:\\evil.js', '\\\\server\\share\\x.js', 'con.js', 'a/nul.js', 'x.js ', 'x.js.', 'ok/./x.js', 'a//x.js', 'x:y.js', 'a\u0000b.js'];
  for (const name of bad) rejects(makeZip([...goodFiles(), { name, data: '1' }]), 'bad_path');
});

test('la barra invertida de Windows cuenta como separador, no como escape', () => {
  const pkg = readPackage(makeZip([...goodFiles(), { name: 'css\\main.css', data: 'a{}' }]));
  assert.ok(pkg.files.some((f) => f.path === 'css/main.css'));
  rejects(makeZip([...goodFiles(), { name: 'APP\\..\\..\\x.js', data: 'x' }]), 'bad_path');
  rejects(makeZip([...goodFiles(), { name: 'css/main.css', data: 'a{}' }, { name: 'css\\main.css', data: 'b{}' }]), 'bad_path');
});

test('rutas repetidas aunque cambie la mayúscula', () => {
  rejects(makeZip([...goodFiles(), { name: 'APP.JS', data: '2' }]), 'bad_path');
  rejects(makeZip([...goodFiles(), { name: 'app.js', data: '2' }]), 'bad_path');
});

test('enlaces simbólicos', () => {
  const link = { name: 'link.js', data: 'C:/Windows/win.ini', madeBy: 3, attrs: (0o120777 << 16) >>> 0 };
  rejects(makeZip([...goodFiles(), link]), 'bad_path');
});

test('extensiones prohibidas', () => {
  for (const name of ['virus.exe', 'lib.dll', 'x.bat', 'x.cmd', 'x.ps1', 'x.sh', 'x.jar', 'x.node', 'x.wasm', 'x.svg', 'x.json', 'x.mjs', 'x.zip', 'x.hta', 'sin-extension', 'x.html.exe', 'x.js.lnk', 'preload.asar']) {
    rejects(makeZip([...goodFiles(), { name, data: '1' }]), 'bad_file_type');
  }
});

test('el contenido tiene que coincidir con la extensión', () => {
  rejects(makeZip([...goodFiles(), { name: 'x.png', data: 'MZ esto no es una imagen' }]), 'bad_file_content');
  rejects(makeZip([...goodFiles(), { name: 'x.js', data: Buffer.from([0x4d, 0x5a, 0x00, 0x01]) }]), 'bad_file_content');
  rejects(makeZip([...goodFiles(), { name: 'x.css', data: Buffer.from([0xc3, 0x28]) }]), 'bad_file_content');
});

test('el HTML no trae marcos anidados, y lo oculto es del launcher', () => {
  for (const tag of ['<iframe src=x>', '<IFRAME>', '<iframe' + String.fromCharCode(10) + '>', '<frame/>', '<frameset>', '<object data=x>', '<embed src=x>', '<fencedframe>', '<svg><foreignObject><iframe></iframe></foreignObject></svg>']) {
    rejects(makeZip([goodFiles()[0], { name: 'index.html', data: `<!doctype html>${tag}` }]), 'bad_file_content');
  }
  const ok = readPackage(makeZip([goodFiles()[0], { name: 'index.html', data: '<!doctype html><p>un iframe, object o embed como texto</p>' }]));
  assert.equal(ok.files.length, 1);
  for (const name of ['.venus/boot.js', '.oculto.js', 'a/.b/c.js']) rejects(makeZip([...goodFiles(), { name, data: '1' }]), 'bad_path');
});

test('bomba: la proporción de compresión delata', () => {
  const big = Buffer.alloc(LIMITS.MAX_FILE, 0x20);
  rejects(makeZip([...goodFiles(), { name: 'bomba.js', data: big }]), 'zip_bomb');
});

test('bomba: el tamaño declarado miente', () => {
  const real = Buffer.alloc(1024 * 1024, 0x20);
  // Declara 100 bytes y se infla 1 MB: maxOutputLength corta
  rejects(makeZip([...goodFiles(), { name: 'mentira.js', data: real, declaredSize: 100 }]), 'zip_bomb');
  // Declara más de lo que hay
  rejects(makeZip([...goodFiles(), { name: 'mentira2.js', data: 'x', declaredSize: 1000 }]), 'zip_bomb');
});

test('bomba: archivo o total declarado por encima del tope', () => {
  rejects(makeZip([...goodFiles(), { name: 'g.js', data: 'x', declaredSize: LIMITS.MAX_FILE + 1 }]), 'file_too_large');
  const many = Array.from({ length: 4 }, (_, i) => ({ name: `g${i}.js`, data: Buffer.alloc(100, 0x61), declaredSize: LIMITS.MAX_FILE }));
  const zipped = makeZip([...goodFiles(), ...many]);
  assert.throws(() => readPackage(zipped), (err) => ['package_too_large', 'zip_bomb'].includes(err.code));
});

test('bomba: entradas solapadas', () => {
  const data = Buffer.alloc(200 * 1024, 0x61);
  const packed = zlib.deflateRawSync(data);
  // Dos entradas del directorio central que apuntan al mismo contenido
  const files = [...goodFiles(), { name: 'a.js', data }, { name: 'b.js', data, localName: 'a.js', offset: 0 }];
  assert.ok(packed.length < data.length);
  const buf = makeZip(files);
  assert.throws(() => readPackage(buf), ExtensionError);
});

test('el nombre del encabezado local tiene que coincidir con el central', () => {
  rejects(makeZip([...goodFiles(), { name: 'bueno.js', localName: '../malo.js', data: 'x' }]), 'bad_zip');
});

test('demasiados archivos', () => {
  const many = Array.from({ length: LIMITS.MAX_FILES + 1 }, (_, i) => ({ name: `f${i}.js`, data: '1', stored: true }));
  rejects(makeZip([...goodFiles(), ...many]), 'too_many_files');
});

test('paquete demasiado grande', () => {
  rejects(Buffer.alloc(LIMITS.MAX_PACKAGE + 1), 'package_too_large');
});

test('zips rotos o cifrados', () => {
  rejects(Buffer.from('esto no es un zip, pero es bastante largo como para buscarle el final'), 'bad_zip');
  rejects(Buffer.alloc(5), 'bad_zip');
  rejects(makeZip([...goodFiles(), { name: 'x.js', data: 'x', flags: 0x0801 }]), 'bad_zip');
  rejects(makeZip([...goodFiles(), { name: 'x.js', data: 'x', method: 12 }]), 'bad_zip');
  rejects(makeZip([...goodFiles(), { name: 'x.js', data: 'x', crc: 1234 }]), 'bad_zip');
});

test('manifiesto: falta, roto o apunta a páginas que no están', () => {
  rejects(makeZip([{ name: 'index.html', data: 'x' }]), 'bad_manifest');
  rejects(makeZip([{ name: 'manifest.json', data: '{' }, { name: 'index.html', data: 'x' }]), 'bad_manifest');
  rejects(makeZip([{ name: 'manifest.json', data: JSON.stringify(manifest()) }]), 'bad_manifest');
  rejects(makeZip([...goodFiles({ homeCard: 'card.html' })]), 'bad_manifest');
});

test('writePackage deja la carpeta completa y reemplaza la anterior', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venus-ext-'));
  const dest = path.join(dir, 'package');
  try {
    await writePackage(readPackage(makeZip(goodFiles())), dest);
    assert.ok(fs.existsSync(path.join(dest, 'index.html')));
    assert.ok(fs.existsSync(path.join(dest, 'manifest.json')));
    await writePackage(readPackage(makeZip([goodFiles()[0], { name: 'index.html', data: 'nuevo' }])), dest);
    assert.equal(fs.readFileSync(path.join(dest, 'index.html'), 'utf8'), 'nuevo');
    assert.equal(fs.existsSync(path.join(dest, 'app.js')), false);
    assert.deepEqual(fs.readdirSync(dir), ['package']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
