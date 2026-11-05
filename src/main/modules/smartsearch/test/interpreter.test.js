'use strict';
// Interprete local del Buscador inteligente: corpus de frases, validez del vocabulario y piezas sueltas.
// Corre con:  node --test src/main/modules/smartsearch/test/interpreter.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../lexicon');
const I = require('../interpreter');
const vocab = require('../vocab');
const { CORPUS, GROUPS, RELEASES, LATEST } = require('./corpus');
const heldout = require('./corpus-heldout');
const { score, report } = require('./score');

const ctx = { releases: new Set(RELEASES), latestRelease: LATEST, uiLang: 'es' };

// ---------- Corpus ----------

test(`corpus: ${CORPUS.length} frases, todas bien entendidas`, () => {
  const result = score(I);
  assert.ok(result.total >= 450, `el corpus tiene que tener cientos de frases (${result.total})`);
  const detail = result.failures.map((f) => `[${f.group}] ${f.text} -> falla ${f.failed.join(',')}`).join('\n');
  assert.equal(result.failures.length, 0, `${report(result, 'corpus')}\n${detail}`);
});

test('corpus: cada grupo tiene frases y ninguno baja del 100 %', () => {
  const result = score(I);
  for (const group of Object.keys(GROUPS)) {
    const g = result.byGroup[group];
    assert.ok(g && g.total >= 10, `el grupo ${group} tiene que tener al menos 10 frases`);
    assert.equal(g.passed, g.total, `grupo ${group}`);
  }
});

test('frases a ciegas (escritas despues de congelar el vocabulario): se entiende todo lo entrenado', () => {
  const result = score(I, { corpus: heldout.CORPUS });
  const detail = result.failures.map((f) => `${f.text} -> falla ${f.failed.join(',')}`).join('\n');
  assert.equal(result.failures.length, 0, detail);
  assert.ok(result.total >= 80);
});

test('el interprete nuevo entiende mucho mas que el anterior en las mismas frases (sin ruido)', () => {
  // El 41,8 % del commit anterior queda registrado en docs/arquitectura.md (6.8); aca se fija un piso.
  const result = score(I);
  assert.ok(result.passed / result.total > 0.95);
});

// ---------- Vocabulario ----------

const allThemes = () => L.THEMES;

test('vocab: todas las expresiones compilan y no hay temas repetidos', () => {
  const ids = new Set();
  for (const th of allThemes()) {
    assert.ok(!ids.has(th.id), `tema repetido ${th.id}`);
    ids.add(th.id);
    assert.ok(Array.isArray(th.p) && th.p.length, `${th.id} sin patrones`);
    for (const a of th.p) assert.doesNotThrow(() => new RegExp(a), `${th.id}: ${a}`);
  }
  const groups = [L.TYPE_PATTERNS, L.LOADER_PATTERNS, L.SHADER_LOADER_PATTERNS, L.SERVER_SOFTWARE_PATTERNS, L.MODE_PATTERNS];
  for (const entries of groups) for (const [key, alts] of entries) for (const a of alts) assert.doesNotThrow(() => new RegExp(a), `${key}: ${a}`);
  for (const list of [L.VANILLA_PATTERNS, L.LOWEND_PATTERNS, L.HIGHEND_PATTERNS, L.LATEST_PATTERNS, L.MORE_PATTERNS]) for (const a of list) assert.doesNotThrow(() => new RegExp(a), a);
  for (const a of L.SIMILAR.markers) assert.doesNotThrow(() => new RegExp(a), a);
  for (const pr of L.SIMILAR.projects) for (const a of pr.p) assert.doesNotThrow(() => new RegExp(a), `${pr.id}: ${a}`);
  for (const [a] of L.versions.ALIASES) assert.doesNotThrow(() => new RegExp(a), a);
});

test('vocab: consultas, categorias y tipos de cada tema son validos para Modrinth', () => {
  for (const th of allThemes()) {
    for (const type of Object.keys(th.q || {})) assert.ok(L.TYPES.includes(type), `${th.id}: tipo ${type} en q`);
    for (const [type, lists] of Object.entries(th.cat || {})) {
      assert.ok(L.TYPES.includes(type), `${th.id}: tipo ${type} en cat`);
      for (const cats of lists) for (const c of cats) assert.ok(L.CATEGORIES[type].includes(c), `${th.id}: categoria ${c} no existe para ${type}`);
    }
    for (const [type, cats] of Object.entries(th.boost || {})) {
      assert.ok(L.TYPES.includes(type), `${th.id}: tipo ${type} en boost`);
      for (const c of cats) assert.ok(L.CATEGORIES[type].includes(c), `${th.id}: boost ${c} no existe para ${type}`);
    }
    for (const type of th.types || []) assert.ok(L.TYPES.includes(type), `${th.id}: tipo ${type} en types`);
    for (const rel of [...(th.rel || []), ...(th.suppress || [])]) assert.ok(allThemes().some((x) => x.id === rel), `${th.id}: tema relacionado ${rel} no existe`);
  }
});

test('vocab: los proyectos de "como X" apuntan a temas y tipos que existen', () => {
  const ids = new Set();
  for (const pr of L.SIMILAR.projects) {
    assert.ok(!ids.has(pr.id), `proyecto repetido ${pr.id}`);
    ids.add(pr.id);
    assert.ok(pr.name && pr.p.length, pr.id);
    for (const th of pr.themes) assert.ok(allThemes().some((x) => x.id === th), `${pr.id}: tema ${th}`);
    for (const type of pr.types || []) assert.ok(L.TYPES.includes(type), `${pr.id}: tipo ${type}`);
  }
});

test('vocab: ningun patron de tema es una palabra tan generica que active temas en pedidos comunes', () => {
  const generic = ['sol', 'sun', 'sea', 'mar', 'light', 'slow', 'lento', 'noche', 'night', 'levels?', 'stats', 'green', 'verde', 'clean', 'flat', 'classic', 'alpha', 'cpu', 'hub', 'proxy', 'reach', 'rounds'];
  for (const th of allThemes()) for (const g of generic) assert.ok(!th.p.includes(g), `${th.id} tiene el patron generico "${g}"`);
});

test('vocab: los errores de escritura corrigen a una palabra distinta y no pisan palabras del diccionario', () => {
  for (const [wrong, right] of Object.entries(vocab.typos.EXACT)) {
    assert.notEqual(wrong, right);
    assert.ok(!/[_A-Z]/.test(wrong), `clave rara ${wrong}`);
    assert.ok(right.length >= 3, `${wrong} -> ${right}`);
  }
  // palabras reales que NO se pueden tocar
  for (const word of ['servidor', 'mods', 'forge', 'quilt', 'quit', 'realista', 'minecraft', 'sodium', 'iris', 'create', 'thermal', 'botania', 'terralith', 'tecnologia']) {
    assert.equal(vocab.typos.fix(word), word);
  }
});

test('vocab: lo que ya existia en lexicon.js sigue (no se pisa nada)', () => {
  assert.ok(L.THEMES.find((th) => th.id === 'zombies').p.includes('zombi(?:e|s|es)?'));
  assert.ok(L.WORDS.vampiros === 'vampires');
  assert.ok(L.TYPE_PATTERNS.find(([t]) => t === 'modpack')[1].includes('modpacks?'));
  assert.ok(L.THEMES.length >= 80);
});

// ---------- Errores de escritura ----------

test('typos: correccion exacta, de dos palabras y difusa', () => {
  const fix = vocab.typos.fix;
  assert.equal(fix('shaderz para fabrik'), 'shaders para fabric');
  assert.equal(fix('mod pak de magia'), 'modpack de magia');
  assert.equal(fix('optimisacion y construcion'), 'optimizacion y construccion');
  // difusa: una letra de diferencia con una palabra del vocabulario, solo si es larga
  assert.equal(fix('supervivensia'), 'supervivencia');
  assert.equal(fix('minijuegoz'), 'minijuegos');
  assert.equal(fix('texturas'), 'texturas');
  assert.equal(fix('abc'), 'abc');
  assert.equal(fix(''), '');
});

test('typos: distancia de edicion con transposicion y tope', () => {
  const { distance } = vocab.typos;
  assert.equal(distance('shaders', 'shaders', 2), 0);
  assert.equal(distance('shaedrs', 'shaders', 2), 1);
  assert.equal(distance('shader', 'shaders', 2), 1);
  assert.equal(distance('abcdef', 'ghijkl', 2), 3);
});

// ---------- Versiones ----------

test('versiones: rangos, "o superior", "hasta" y series', () => {
  const v = L.versions;
  const pick = (text) => {
    const span = v.range(v.aliases(text));
    return span && v.pick(span, { releases: ctx.releases, latest: LATEST, patches: L.MODDED_PATCH });
  };
  assert.equal(pick('mods 1.18 a 1.20'), '1.20.1');
  assert.equal(pick('mods entre 1.19 y 1.16'), '1.19.2');
  assert.equal(pick('mods 1.12 o superior'), LATEST);
  assert.equal(pick('mods hasta la 1.16'), '1.16.5');
  assert.equal(pick('mods 1.20.1 o anterior'), '1.20.1');
  assert.equal(pick('mods from 1.19 onwards'), LATEST);
  assert.equal(pick('mods hasta 1.20.4'), '1.20.4');
  assert.equal(pick('mods para 1.20'), null);
  assert.equal(v.prepare('mods 1.18-1.20'), 'mods 1.18 hasta 1.20');
  assert.equal(v.prepare('mods 1.20.x'), 'mods 1.20');
  assert.equal(v.prepare('mods 1.19+'), 'mods 1.19 o superior');
  assert.equal(v.aliases('mods caves and cliffs'), 'mods 1.18');
  assert.equal(v.compare('1.20.4', '1.20'), 4);
  assert.ok(v.compare('1.9', '1.10') < 0);
  assert.equal(v.minorOf('1.20.4'), '1.20');
});

test('versiones: sin conexion (sin lista de releases) igual da una version razonable', () => {
  const r = I.interpret('mods de la 1.18 a la 1.20', { uiLang: 'es' });
  assert.equal(r.version.value, '1.20.1');
  assert.equal(r.version.mapped, true);
  assert.equal(r.version.range.kind, 'between');
  const low = I.interpret('mods hasta la 1.12', {});
  assert.equal(low.version.value, '1.12.2');
});

test('versiones: el plan avisa que la version viene de un rango', () => {
  const p = I.plan('mods de magia de la 1.18 a la 1.20', { releases: ctx.releases, latestRelease: LATEST, filters: {}, uiLang: 'es' });
  assert.equal(p.mcVersion, '1.20.1');
  assert.equal(p.versionSource, 'query');
  assert.deepEqual(p.versionNote.to, '1.20.1');
  assert.match(p.versionNote.from, /1\.18/);
});

// ---------- Negaciones y cantidades ----------

test('negaciones: no pasan por encima de otro tipo y "no" suelto solo niega lo que tiene al lado', () => {
  const t = (q) => I.interpret(q, ctx);
  assert.deepEqual(t('sin shaders, solo mods de magia').excluded, ['shader']);
  assert.deepEqual(t('sin shaders, solo mods de magia').types, ['mod']);
  assert.deepEqual(t('ni modpacks ni plugins, quiero mods').excluded.sort(), ['modpack', 'plugin']);
  assert.deepEqual(t('quiero que mi pc no explote con shaders').excluded, []);
  assert.deepEqual(t('no shaders').excluded, ['shader']);
  assert.deepEqual(t('no necesito plugins, quiero mods').types, ['mod']);
});

test('cantidades con letras (dos o mas; "un mod" no fija una cantidad)', () => {
  const t = (q) => I.interpret(q, ctx).counts;
  assert.deepEqual(t('cinco mods de magia'), { mod: 5 });
  assert.deepEqual(t('diez shaders'), { shader: 10 });
  assert.deepEqual(t('three resource packs'), { resourcepack: 3 });
  assert.deepEqual(t('um mod de terror'), {});
  assert.deepEqual(t('un mod de terror'), {});
});

// ---------- "Como X" ----------

test('"como X": suma los temas y el nombre como termino, y no confunde un cargador con una referencia', () => {
  const r = I.interpret('algo como sodium para mi pc de papa', ctx);
  assert.deepEqual(r.similar, ['sodium']);
  assert.ok(r.themes.some((th) => th.id === 'fps'));
  assert.ok(r.terms.includes('sodium'));
  assert.equal(r.shaderLoader, null, 'sodium como referencia no es el motor de shaders');
  assert.equal(r.flags.lowEnd, true);
  const plain = I.interpret('shaders con iris', ctx);
  assert.equal(plain.shaderLoader, 'iris');
  assert.deepEqual(plain.similar, []);
});

test('el plan completo con vocabulario nuevo arma busquedas validas por tipo', () => {
  for (const q of ['alternativa a optifine para pc de papa', 'mapas de aventura de terror', 'texturas pixel art con shaders neon', 'plugins como luckperms para mi server', 'mods de sed y temperatura para neoforge 1.21.1']) {
    const p = I.plan(q, { releases: ctx.releases, latestRelease: LATEST, filters: {}, uiLang: 'es' });
    assert.ok(p.types.length, q);
    assert.ok(p.searches.length, q);
    for (const s of p.searches) {
      assert.ok(p.types.includes(s.type), `${q}: busqueda de un tipo que no esta en el plan`);
      for (const c of s.categories) assert.ok(L.CATEGORIES[s.type].includes(c), `${q}: categoria ${c}`);
    }
  }
});
