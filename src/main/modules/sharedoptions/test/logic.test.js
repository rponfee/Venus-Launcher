'use strict';
// Mezcla de options.txt por versión y formatos de las teclas. node --test "src/main/modules/sharedoptions/test/"
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const logic = require('../logic');

const MODERN_FILE = ['version:3465', 'autoJump:false', 'fov:0.25', 'mouseSensitivity:0.75', 'invertYMouse:false', 'renderDistance:16', 'lang:es_ar', 'soundCategory_master:0.5', 'key_key.forward:key.keyboard.w', 'key_key.attack:key.mouse.left', 'key_key.modded:scancode.65', 'resourcePacks:["vanilla"]', ''].join('\n');
const LEGACY_FILE = ['version:1343', 'fov:0.0', 'mouseSensitivity:0.5', 'lang:es_ar', 'key_key.forward:17', 'key_key.attack:-100', 'key_key.modded:33:SHIFT', ''].join('\n');

const doc = (text) => logic.parse(text);
const lines = (d) => d.entries.map((e) => e.raw);
const valueOf = (d, k) => d.entries.find((e) => e.key === k)?.value;

function profileFrom(text, mcVersion, extra = {}) {
  return { ...logic.saveFrom(logic.emptyProfile(), logic.extract(doc(text), { mcVersion }), { now: 5 }), ...extra };
}

test('keyFormat: desde la 1.13 son nombres y antes números', () => {
  for (const v of ['1.13', '1.13.2', '1.20.1', '1.21.4', '26.1', '26.1.2', '18w01a', '24w10a', '17w43a', '1.14_combat-212', '1.20.5-pre1']) assert.equal(logic.keyFormat(v), 'modern', v);
  for (const v of ['1.12.2', '1.8.9', '1.7.10', '1.0', '17w42a', '16w20a', 'b1.7.3', 'a1.2.6', 'c0.30', 'rd-132211', 'inf-20100618']) assert.equal(logic.keyFormat(v), 'legacy', v);
  for (const v of ['', null, undefined, 'combat3']) assert.equal(logic.keyFormat(v), null, String(v));
});

test('fileFormat y effectiveFormat miran el archivo además de la versión', () => {
  assert.equal(logic.fileFormat(doc(MODERN_FILE)), 'modern');
  assert.equal(logic.fileFormat(doc(LEGACY_FILE)), 'legacy');
  assert.equal(logic.fileFormat(doc('fov:0.0\n')), null);
  assert.equal(logic.fileFormat(doc('key_a:17\nkey_b:key.keyboard.w\n')), 'mixed');
  assert.equal(logic.effectiveFormat('1.20.1', doc(MODERN_FILE)), 'modern');
  // una instancia que pasó de 1.12 a 1.20 y todavía no se abrió: el archivo sigue en números
  assert.equal(logic.effectiveFormat('1.20.1', doc(LEGACY_FILE)), null);
  assert.equal(logic.effectiveFormat('1.12.2', doc(MODERN_FILE)), null);
  assert.equal(logic.effectiveFormat('combat3', doc(LEGACY_FILE)), 'legacy');
  assert.equal(logic.effectiveFormat('1.20.1', doc('key_a:17\nkey_b:key.keyboard.w\n')), null);
});

test('extract separa lo común de las teclas y deja afuera lo que depende de la versión', () => {
  const data = logic.extract(doc(MODERN_FILE), { mcVersion: '1.20.1' });
  assert.equal(data.format, 'modern');
  assert.equal(data.dataVersion, '3465');
  assert.deepEqual(data.common, { autoJump: 'false', fov: '0.25', mouseSensitivity: '0.75', invertYMouse: 'false', renderDistance: '16', soundCategory_master: '0.5' });
  assert.deepEqual(data.bindings, { 'key_key.forward': 'key.keyboard.w', 'key_key.attack': 'key.mouse.left', 'key_key.modded': 'scancode.65' });
  assert.equal(data.common.lang, undefined);
  // un valor con un formato inesperado se descarta
  assert.deepEqual(logic.extract(doc('fov:ancho\ninvertYMouse:1\nsoundCategory_master:mucho\n'), { mcVersion: '1.20.1' }).common, {});
  // con el archivo y la versión en desacuerdo, ninguna tecla
  assert.deepEqual(logic.extract(doc(LEGACY_FILE), { mcVersion: '1.20.1' }).bindings, {});
});

test('aplicar: solo cambian las claves compartidas y el resto del archivo queda igual', () => {
  const profile = profileFrom(MODERN_FILE, '1.20.1');
  const target = doc(['version:3700', 'lang:en_us', 'fov:0.0', 'key_key.forward:key.keyboard.z', 'resourcePacks:["vanilla","file/x.zip"]', ''].join('\n'));
  const res = logic.applyTo(target, profile, { mcVersion: '1.21', loader: 'fabric' });
  assert.equal(res.blocked, null);
  assert.equal(valueOf(res.doc, 'fov'), '0.25');
  assert.equal(valueOf(res.doc, 'key_key.forward'), 'key.keyboard.w');
  assert.equal(valueOf(res.doc, 'key_key.attack'), 'key.mouse.left', 'una tecla que faltaba se agrega');
  assert.equal(valueOf(res.doc, 'lang'), 'en_us');
  assert.equal(valueOf(res.doc, 'resourcePacks'), '["vanilla","file/x.zip"]');
  assert.equal(valueOf(res.doc, 'version'), '3700', 'la versión del archivo no se toca');
  assert.equal(valueOf(res.doc, 'renderDistance'), undefined, 'el grupo de video está apagado por defecto');
  assert.equal(valueOf(res.doc, 'soundCategory_master'), undefined, 'el grupo de audio está apagado por defecto');
  assert.equal(res.doc.entries[0].key, 'version');
  assert.equal(valueOf(target, 'fov'), '0.0', 'el documento original no se modifica');
});

test('aplicar: no mezcla formatos', () => {
  const both = logic.saveFrom(profileFrom(MODERN_FILE, '1.20.1'), logic.extract(doc(LEGACY_FILE), { mcVersion: '1.12.2' }), { now: 6 });
  assert.deepEqual(Object.keys(both.bindings.modern).length, 3);
  assert.deepEqual(Object.keys(both.bindings.legacy).length, 3);

  const toLegacy = logic.applyTo(doc('version:1343\nkey_key.forward:30\n'), both, { mcVersion: '1.12.2', loader: 'forge' });
  assert.equal(valueOf(toLegacy.doc, 'key_key.forward'), '17');
  assert.equal(toLegacy.doc.entries.some((e) => /^key_/.test(e.key) && /keyboard/.test(e.value)), false);

  const toModern = logic.applyTo(doc('version:3465\nkey_key.forward:key.keyboard.z\n'), both, { mcVersion: '1.20.1', loader: 'fabric' });
  assert.equal(valueOf(toModern.doc, 'key_key.forward'), 'key.keyboard.w');
  assert.equal(toModern.doc.entries.some((e) => /^key_/.test(e.key) && /^-?\d+$/.test(e.value)), false);

  // lo común sí viaja entre los dos
  assert.equal(valueOf(toLegacy.doc, 'fov'), '0.0');
  assert.equal(valueOf(toModern.doc, 'fov'), '0.0');
});

test('aplicar: sin teclas de ese formato, lo común se escribe igual', () => {
  const onlyModern = profileFrom(MODERN_FILE, '1.20.1');
  const res = logic.applyTo(doc('version:1343\nkey_key.forward:30\nfov:0.0\n'), onlyModern, { mcVersion: '1.12.2' });
  assert.equal(res.blocked, 'emptyFormat');
  assert.equal(valueOf(res.doc, 'key_key.forward'), '30');
  assert.equal(valueOf(res.doc, 'fov'), '0.25');
});

test('aplicar: una instancia que cambió de versión y no se abrió no recibe teclas', () => {
  const profile = profileFrom(MODERN_FILE, '1.20.1');
  const stale = logic.applyTo(doc(LEGACY_FILE), profile, { mcVersion: '1.20.1' });
  assert.equal(stale.blocked, 'formatMismatch');
  assert.equal(valueOf(stale.doc, 'key_key.forward'), '17');
  const old = logic.applyTo(doc('version:1343\nfov:0.0\n'), profile, { mcVersion: '1.20.1' });
  assert.equal(old.blocked, 'formatMismatch', 'el archivo dice que es de antes de la 1.13');
  assert.equal(old.doc.entries.some((e) => e.key.startsWith('key_')), false);
});

test('aplicar: en un archivo sin "version" se agrega la del perfil, primero', () => {
  const profile = profileFrom(MODERN_FILE, '1.20.1');
  const fresh = logic.applyTo({ eol: '\n', entries: [] }, profile, { mcVersion: '1.20.1', loader: 'fabric' });
  assert.equal(fresh.doc.entries[0].raw, 'version:3465');
  assert.equal(valueOf(fresh.doc, 'key_key.forward'), 'key.keyboard.w');
  // otro módulo (el paquete de Venus) ya creó el archivo con solo una línea
  const partial = logic.applyTo(doc('resourcePacks:["vanilla"]\n'), profile, { mcVersion: '1.20.1', loader: 'fabric' });
  assert.equal(partial.doc.entries[0].raw, 'version:3465');
  assert.equal(valueOf(partial.doc, 'resourcePacks'), '["vanilla"]');
  // sin saber la versión de datos no se arriesga: Minecraft descartaría todas las opciones
  const noVersion = { ...profile, dataVersion: { modern: null, legacy: null } };
  const blocked = logic.applyTo({ eol: '\n', entries: [] }, noVersion, { mcVersion: '1.20.1' });
  assert.equal(blocked.blocked, 'noDataVersion');
  assert.equal(blocked.doc.entries.some((e) => e.key.startsWith('key_')), false);
  assert.equal(valueOf(blocked.doc, 'fov'), '0.25');
});

test('aplicar: el modificador de Forge solo va a Forge y NeoForge', () => {
  assert.equal(logic.adaptBinding('key.keyboard.g:SHIFT', 'forge'), 'key.keyboard.g:SHIFT');
  assert.equal(logic.adaptBinding('key.keyboard.g:SHIFT', 'neoforge'), 'key.keyboard.g:SHIFT');
  assert.equal(logic.adaptBinding('key.keyboard.g:SHIFT', 'fabric'), 'key.keyboard.g');
  assert.equal(logic.adaptBinding('key.keyboard.g', 'fabric'), 'key.keyboard.g');
  const profile = profileFrom('version:3465\nkey_key.x:key.keyboard.g:SHIFT\n', '1.20.1');
  assert.equal(valueOf(logic.applyTo(doc('version:3465\n'), profile, { mcVersion: '1.20.1', loader: 'fabric' }).doc, 'key_key.x'), 'key.keyboard.g');
  assert.equal(valueOf(logic.applyTo(doc('version:3465\n'), profile, { mcVersion: '1.20.1', loader: 'forge' }).doc, 'key_key.x'), 'key.keyboard.g:SHIFT');
});

test('aplicar: una opción que esa versión no tiene no se agrega, pero se conserva si ya estaba', () => {
  const profile = profileFrom('version:3465\nsimulationDistance:12\nautoJump:true\nfov:0.5\n', '1.20.1');
  profile.groups.video = true;
  const old = logic.applyTo(doc('version:1343\nfov:0.0\n'), profile, { mcVersion: '1.12.2' });
  assert.equal(valueOf(old.doc, 'simulationDistance'), undefined);
  assert.equal(valueOf(old.doc, 'autoJump'), 'true', 'autoJump existe desde la 1.11');
  const older = logic.applyTo(doc('fov:0.0\n'), profile, { mcVersion: '1.8.9' });
  assert.equal(valueOf(older.doc, 'autoJump'), undefined);
  const kept = logic.applyTo(doc('fov:0.0\nautoJump:false\n'), profile, { mcVersion: '1.8.9' });
  assert.equal(valueOf(kept.doc, 'autoJump'), 'true', 'si el archivo ya la tiene, se actualiza');
  const snapshot = logic.applyTo(doc('version:3465\n'), profile, { mcVersion: '24w10a' });
  assert.equal(valueOf(snapshot.doc, 'simulationDistance'), '12', 'una snapshot no se bloquea');
});

test('aplicar: solo los grupos prendidos y sin cambios no hay nada que escribir', () => {
  const profile = profileFrom(MODERN_FILE, '1.20.1');
  profile.groups = { ...profile.groups, controls: false, mouse: false };
  const res = logic.applyTo(doc('version:3465\nkey_key.forward:key.keyboard.z\nmouseSensitivity:0.1\n'), profile, { mcVersion: '1.20.1' });
  assert.equal(valueOf(res.doc, 'key_key.forward'), 'key.keyboard.z');
  assert.equal(valueOf(res.doc, 'mouseSensitivity'), '0.1');
  assert.equal(valueOf(res.doc, 'fov'), '0.25');

  const same = logic.applyTo(res.doc, profile, { mcVersion: '1.20.1' });
  assert.deepEqual(same.changed, []);
});

test('mergeBack: solo los grupos prendidos llegan al perfil y nunca se borra nada', () => {
  const profile = profileFrom(MODERN_FILE, '1.20.1');
  const changedInGame = logic.extract(doc('version:3700\nfov:0.9\nrenderDistance:4\nkey_key.forward:key.keyboard.up\n'), { mcVersion: '1.21' });
  const { profile: next, changed } = logic.mergeBack(profile, changedInGame, { now: 99 });
  assert.equal(next.common.fov, '0.9');
  assert.equal(next.common.renderDistance, '16', 'el grupo de video está apagado');
  assert.equal(next.bindings.modern['key_key.forward'], 'key.keyboard.up');
  assert.equal(next.bindings.modern['key_key.attack'], 'key.mouse.left', 'una tecla que no vino no se borra');
  assert.equal(next.dataVersion.modern, '3700');
  assert.equal(next.updatedAt, 99);
  assert.deepEqual(changed.sort(), ['fov', 'key_key.forward']);

  const none = logic.mergeBack(next, changedInGame, { now: 100 });
  assert.deepEqual(none.changed, []);
  assert.equal(none.profile.updatedAt, 99);

  // el juego viejo no toca el cajón nuevo
  const fromLegacy = logic.mergeBack(next, logic.extract(doc(LEGACY_FILE), { mcVersion: '1.12.2' }), { now: 101 });
  assert.equal(fromLegacy.profile.bindings.modern['key_key.forward'], 'key.keyboard.up');
  assert.equal(fromLegacy.profile.bindings.legacy['key_key.forward'], '17');
});

test('normalizeProfile descarta lo que no sirve', () => {
  const p = logic.normalizeProfile({
    groups: { controls: false, inventado: true, fov: 'si' },
    syncBack: 'true',
    common: { fov: '0.5', lang: 'es_ar', mouseSensitivity: 'mucho', fovEffectScale: 1 },
    bindings: { modern: { 'key_key.a': 'key.keyboard.a', 'key_key.b': '17', 'otra.cosa': 'key.keyboard.c' }, legacy: { 'key_key.a': '17', 'key_key.b': 'key.keyboard.b' } },
    dataVersion: { modern: 'x', legacy: '1343' },
  });
  assert.equal(p.groups.controls, false);
  assert.equal(p.groups.fov, true);
  assert.equal(p.groups.inventado, undefined);
  assert.equal(p.syncBack, false);
  assert.deepEqual(p.common, { fov: '0.5' });
  assert.deepEqual(p.bindings.modern, { 'key_key.a': 'key.keyboard.a' });
  assert.deepEqual(p.bindings.legacy, { 'key_key.a': '17' });
  assert.deepEqual(p.dataVersion, { modern: null, legacy: '1343' });
  assert.deepEqual(logic.normalizeProfile('roto'), logic.emptyProfile());
});

test('summarize cuenta por grupo', () => {
  const s = logic.summarize(profileFrom(MODERN_FILE, '1.20.1'));
  assert.equal(s.saved, true);
  assert.equal(s.modern, 3);
  assert.equal(s.legacy, 0);
  assert.equal(s.counts.controls, 4);
  assert.equal(s.counts.fov, 1);
  assert.equal(s.counts.mouse, 2);
  assert.equal(s.counts.audio, 1);
  assert.equal(s.counts.video, 1);
  assert.equal(logic.summarize(null).saved, false);
});

test('escribe el archivo de verdad: conserva los saltos de línea y guarda una copia', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venus-sharedoptions-'));
  try {
    const { applyToDir } = require('../../sharedoptions');
    const file = path.join(dir, 'options.txt');
    const profile = profileFrom(MODERN_FILE, '1.20.1');
    fs.writeFileSync(file, 'version:3465\r\nfov:0.0\r\nlang:es_ar\r\n');
    const first = await applyToDir(dir, profile, { mcVersion: '1.20.1', loader: 'fabric' });
    assert.equal(first.written, true);
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /^version:3465\r\nfov:0\.25\r\nlang:es_ar\r\n/);
    assert.ok(text.endsWith('\r\n'));
    assert.equal(text.includes('\n') && !/[^\r]\n/.test(text), true, 'todas las líneas con CRLF');
    assert.equal(fs.readFileSync(path.join(dir, '.venus', 'sharedoptions-backup.txt'), 'utf8'), 'version:3465\r\nfov:0.0\r\nlang:es_ar\r\n');
    const before = fs.statSync(file).mtimeMs;
    const second = await applyToDir(dir, profile, { mcVersion: '1.20.1', loader: 'fabric' });
    assert.equal(second.written, false, 'sin cambios no se toca el archivo');
    assert.equal(fs.statSync(file).mtimeMs, before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
