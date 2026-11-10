// Sincronizar ajustes: lista blanca, fusión por clave y dos PCs de mentira contra una nube de mentira.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SYNC_KEYS, MAX_DOC_BYTES, extract, pausedKeys, syncLooks, validRemote, readDoc, detectChanges, mergeRemote, mergeLooks, toPatch, buildDoc, fitDoc, needsDecision, hashValue, createSyncEngine } from '../sync-logic.js';

test('lista blanca: rutas, tokens y datos de la PC no salen nunca', () => {
  const settings = {
    language: 'es',
    jvmArgs: '-x',
    memory: { max: 8000 },
    selectedInstance: 'x',
    privacy: { news: true },
    mcp: { port: 1 },
    assistantMcp: { servers: [{ command: 'x.exe' }] },
    settingsSync: { enabled: true, keys: {} },
    appearance: { accent: 'mars', bgFile: 'C:\\Users\\ana\\fondo.png', background: 'image', music: { file: 'C:\\Users\\ana\\m.mp3', enabled: true }, lite: true, liteOverlay: true, seasonalBackup: null, uiFont: 'mono' },
    branding: { name: 'Ana', logo: 'data:image/png;base64,AA', server: 'mi.server' },
    decor: { particles: 'snow', sounds: { enabled: true, pack: 'soft', volume: 20 }, cursor: 'pixel' },
    nav: { order: ['home'], iconPack: 'pixel', hidden: [], pinned: [] },
    home: { layout: { order: ['quick'], hidden: [], wide: [] }, hidden: ['news'] },
    capture: { copyTo: 'D:\\clips' },
  };
  const out = extract(settings);
  const text = JSON.stringify(out);
  for (const bad of ['C:\\', 'D:\\', 'jvmArgs', '-x', 'selectedInstance', 'x.exe', 'token', 'logo', 'bgFile', 'music', 'lite', 'mi.server', 'clips']) assert.ok(!text.includes(bad), bad);
  assert.equal(out['appearance.accent'], 'mars');
  assert.equal(out['appearance.uiFont'], 'mono');
  assert.equal(out['decor.particles'], 'snow');
  assert.deepEqual(out['decor.sounds'], { enabled: true, pack: 'soft', volume: 20 });
  assert.deepEqual(out['nav.order'], ['home']);
  assert.deepEqual(out['home.layout'].order, ['quick']);
  for (const key of Object.keys(out)) assert.ok(SYNC_KEYS.includes(key), key);
  assert.ok(!('appearance.background' in out), 'la imagen propia es de esta PC');
});

test('un valor con una ruta no se sube, aunque esté en una clave permitida', () => {
  const out = extract({ decor: { splash: { enabled: true, text: 'C:\\Users\\ana' }, cursor: '/home/ana/x' }, nav: { order: ['C:\\x'] } });
  assert.deepEqual(out, {});
});

test('temporada y fondos rotativos: lo que cambia solo no viaja', () => {
  const season = { appearance: { seasonal: true, seasonalBackup: { accent: 'mars' }, accent: 'custom', customColor: '#ff7a1a', background: 'wallpaper', wallpaperId: 'w28', uiFont: 'mono' } };
  const a = extract(season);
  for (const k of ['appearance.accent', 'appearance.customColor', 'appearance.background', 'appearance.wallpaperId']) assert.ok(!(k in a), k);
  assert.equal(a['appearance.uiFont'], 'mono');
  assert.equal(a['appearance.seasonal'], true);
  assert.ok(pausedKeys({ appearance: { rotation: { enabled: true } } }).has('appearance.wallpaperId'));
  assert.equal(pausedKeys({ appearance: { seasonal: true, seasonalBackup: null } }).size, 0);
  assert.equal(pausedKeys(null).size, 0);
});

test('los looks viajan sin rutas ni logo; un id raro se descarta en lugar de cambiar en cada lectura', () => {
  const looks = syncLooks([
    { id: 'look-1', name: 'Mío', createdAt: 5, appearance: { accent: 'mars', background: 'image', bgFile: 'C:\\Users\\ana\\x.png', music: { enabled: true, file: 'C:\\m.mp3' } }, branding: { name: 'V', logo: 'data:image/png;base64,AAAA', logoName: 'l.png' } },
    { id: '../malo', name: 'X', appearance: {} },
    { name: 'sin id', appearance: {} },
    null,
  ]);
  assert.equal(looks.length, 1);
  const text = JSON.stringify(looks);
  assert.ok(!text.includes('C:\\') && !text.includes('base64') && !text.includes('l.png'));
  assert.equal(looks[0].appearance.background, 'stars');
  assert.equal(looks[0].appearance.music.enabled, false);
  assert.equal(hashValue(syncLooks([{ id: 'a', name: 'A', createdAt: 1, appearance: {}, branding: {} }])), hashValue(syncLooks([{ id: 'a', name: 'A', createdAt: 1, appearance: {}, branding: {} }])), 'estable');
});

test('los looks que llegan conservan el logo y la imagen de los que ya están acá', () => {
  const local = [{ id: 'a', name: 'A', createdAt: 1, appearance: { accent: 'mars', bgFile: 'C:\\f.png', background: 'image' }, branding: { name: 'V', logo: 'data:x', logoName: 'l.png' } }];
  const same = mergeLooks(syncLooks(local), local);
  assert.equal(same[0], local[0], 'sin cambios queda el mismo objeto, con su imagen');
  const edited = syncLooks(local);
  edited[0].name = 'Otro nombre';
  const merged = mergeLooks(edited, local);
  assert.equal(merged[0].name, 'Otro nombre');
  assert.equal(merged[0].branding.logo, 'data:x');
  assert.deepEqual(syncLooks(merged).map((l) => l.name), ['Otro nombre']);
  assert.equal(mergeLooks([{ id: 'nuevo', name: 'N' }], local)[0].id, 'nuevo');
  assert.deepEqual(mergeLooks(null, local), []);
});

test('lo que llega de la nube pasa por la lista blanca y los tipos', () => {
  assert.equal(validRemote('appearance.accent', 'mars'), true);
  assert.equal(validRemote('jvmArgs', '-x'), false);
  assert.equal(validRemote('appearance.bgFile', 'x'), false);
  assert.equal(validRemote('appearance.accent', 3), false);
  assert.equal(validRemote('nav.order', 'home'), false);
  assert.equal(validRemote('nav.order', ['home']), true);
  assert.equal(validRemote('appearance.palette', ['x']), false);
  assert.equal(validRemote('decor.splash', { text: 'C:\\Users\\ana' }), false);
  assert.equal(validRemote('appearance.background', 'image'), false);
  assert.equal(validRemote('appearance.background', 'wallpaper'), true);
  const doc = readDoc({ keys: { 'appearance.accent': { v: 'mars', at: 10 }, jvmArgs: { v: '-x', at: 10 }, 'decor.cursor': { v: 'pixel', at: 9e15 }, 'nav.iconPack': 'pixel', 'decor.density': { v: 'low' } } }, 1000);
  assert.deepEqual(Object.keys(doc).sort(), ['appearance.accent', 'decor.cursor', 'decor.density']);
  assert.equal(doc['decor.cursor'].at, 1000, 'fecha en el futuro: vale como ahora');
  assert.equal(doc['decor.density'].at, 0);
  assert.deepEqual(readDoc(null, 1), {});
});

test('fusión: gana la más nueva clave por clave', () => {
  const local = { 'appearance.accent': 'venus', 'decor.cursor': 'pixel', 'nav.iconPack': 'filled' };
  const meta = { 'appearance.accent': { h: hashValue('venus'), at: 100 }, 'decor.cursor': { h: hashValue('pixel'), at: 300 }, 'nav.iconPack': { h: hashValue('filled'), at: 50 } };
  const remote = { 'appearance.accent': { v: 'mars', at: 200 }, 'decor.cursor': { v: 'sword', at: 200 }, 'nav.iconPack': { v: 'filled', at: 60 }, 'decor.density': { v: 'low', at: 10 } };
  const { apply, upload } = mergeRemote({ local, meta, remote });
  assert.deepEqual(Object.keys(apply).sort(), ['appearance.accent', 'decor.density'], 'la nube gana en el acento; lo nuevo entra');
  assert.equal(apply['appearance.accent'].v, 'mars');
  assert.equal(upload, true, 'el cursor de acá es más nuevo');
});

test('fusión: nada que hacer si son iguales, y una clave pausada no se toca', () => {
  const h = hashValue('mars');
  const same = mergeRemote({ local: { 'appearance.accent': 'mars' }, meta: { 'appearance.accent': { h, at: 5 } }, remote: { 'appearance.accent': { v: 'mars', at: 5 } } });
  assert.deepEqual(same, { apply: {}, upload: false });
  const paused = mergeRemote({ local: {}, meta: {}, remote: { 'appearance.wallpaperId': { v: 'w1', at: 5 } }, paused: new Set(['appearance.wallpaperId']) });
  assert.deepEqual(paused, { apply: {}, upload: false });
  const missing = mergeRemote({ local: { 'decor.cursor': 'x' }, meta: { 'decor.cursor': { h: hashValue('x'), at: 1 } }, remote: {} });
  assert.equal(missing.upload, true);
});

test('toPatch arma el parche anidado y fitDoc respeta el tope soltando los looks más viejos', () => {
  assert.deepEqual(toPatch({ 'appearance.accent': 'mars', 'appearance.palette': { bg: null }, 'home.layout': { order: [] }, 'nav.order': ['home'] }, {}), { appearance: { accent: 'mars', palette: { bg: null } }, home: { layout: { order: [] } }, nav: { order: ['home'] } });
  const looks = Array.from({ length: 80 }, (_, i) => ({ id: `l${i}`, createdAt: i, name: 'x'.repeat(1000) }));
  const doc = buildDoc({ looks, 'decor.cursor': 'pixel' }, { 'decor.cursor': { at: 7 } }, 99);
  assert.equal(doc.keys['decor.cursor'].at, 7);
  assert.equal(doc.keys.looks.at, 99);
  const fit = fitDoc(doc);
  assert.ok(fit.trimmed > 0);
  assert.ok(new TextEncoder().encode(JSON.stringify(fit.doc)).length <= MAX_DOC_BYTES);
  assert.equal(fit.doc.keys.looks.v.at(-1).id, 'l79', 'quedan los más nuevos');
  assert.equal(fit.doc.keys['decor.cursor'].v, 'pixel');
  const small = buildDoc({ 'decor.cursor': 'x' }, {}, 1);
  assert.deepEqual(fitDoc(small), { doc: small, trimmed: 0 });
});

test('la primera vez se pregunta solo si la nube ya tiene algo y con otra cuenta se vuelve a preguntar', () => {
  const remote = { version: 3, data: { keys: { 'decor.cursor': { v: 'x', at: 1 } } } };
  assert.equal(needsDecision({}, 'u1', remote), true);
  assert.equal(needsDecision({ decided: true, userId: 'u1' }, 'u1', remote), false);
  assert.equal(needsDecision({ decided: true, userId: 'u1' }, 'u2', remote), true);
  assert.equal(needsDecision({}, 'u1', { version: 0, data: null }), false);
});

// ---------- Dos PCs ----------
function cloud() {
  const row = { data: null, version: 0, gets: 0, saves: 0 };
  return {
    row,
    async rpc(name, args) {
      if (name === 'settings_sync_get') {
        row.gets++;
        return { data: row.data, version: row.version };
      }
      if (name === 'settings_sync_save') {
        row.saves++;
        if (args.p_version !== row.version) return { ok: false, conflict: true, data: row.data, version: row.version };
        row.data = structuredClone(args.p_data);
        row.version++;
        return { ok: true, version: row.version };
      }
      if (name === 'settings_sync_delete') {
        row.data = null;
        row.version = 0;
        return true;
      }
      throw new Error(name);
    },
  };
}

function pc(net, settings, { normalize = (s) => s, ask = async () => 'pull', clock } = {}) {
  const me = { settings: structuredClone(settings), state: null, asks: 0, patches: 0 };
  const merge = (a, b) => {
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' ? merge(a[k], v) : v;
    return out;
  };
  me.engine = createSyncEngine({
    rpc: net.rpc,
    userId: () => me.user ?? 'u1',
    getSettings: () => me.settings,
    applyPatch: async (patch) => {
      me.patches++;
      me.settings = normalize(merge(me.settings, patch));
      return me.settings;
    },
    loadState: () => me.state,
    saveState: async (s) => {
      me.state = structuredClone(s);
    },
    ask: async (r) => {
      me.asks++;
      return ask(r);
    },
    now: clock,
  });
  me.set = (patch) => {
    me.settings = normalize(merge(me.settings, patch));
  };
  return me;
}

function ticking(start = 1000) {
  let t = start;
  return () => (t += 10);
}

test('dos PCs: la primera sube sin preguntar, la segunda pregunta y trae; después se fusionan', async () => {
  const net = cloud();
  const clock = ticking();
  const a = pc(net, { appearance: { accent: 'mars' }, decor: { cursor: 'pixel' } }, { clock });
  const b = pc(net, { appearance: { accent: 'venus' }, decor: { cursor: 'default' } }, { clock });

  assert.equal((await a.engine.sync()).status, 'pushed');
  assert.equal(a.asks, 0);
  assert.equal(net.row.version, 1);

  assert.equal((await b.engine.sync()).status, 'pulled');
  assert.equal(b.asks, 1);
  assert.equal(b.settings.appearance.accent, 'mars');
  assert.equal(b.settings.decor.cursor, 'pixel');

  // Cada una cambia una cosa distinta: quedan las dos
  a.set({ appearance: { accent: 'neptune' } });
  await a.engine.sync();
  b.set({ decor: { cursor: 'sword' } });
  await b.engine.sync();
  await a.engine.sync();
  assert.equal(a.settings.appearance.accent, 'neptune');
  assert.equal(a.settings.decor.cursor, 'sword');
  assert.equal(b.settings.appearance.accent, 'neptune');
  assert.equal(b.settings.decor.cursor, 'sword');

  // Misma clave en las dos: gana la más nueva
  b.set({ decor: { cursor: 'pickaxe' } });
  a.set({ decor: { cursor: 'diamond' } });
  await a.engine.sync(); // la de A es más nueva pero sube primero
  await b.engine.sync();
  await a.engine.sync();
  assert.equal(a.settings.decor.cursor, b.settings.decor.cursor);
});

test('aplicar lo que llega no se vuelve a subir: sin bucle', async () => {
  const net = cloud();
  const clock = ticking();
  const a = pc(net, { appearance: { accent: 'mars' } }, { clock });
  const b = pc(net, { appearance: { accent: 'venus' } }, { clock });
  await a.engine.sync();
  await b.engine.sync();
  const saves = net.row.saves;
  for (let i = 0; i < 5; i++) {
    await a.engine.sync();
    await b.engine.sync();
    assert.equal(a.engine.hasLocalChanges(), false);
    assert.equal(b.engine.hasLocalChanges(), false);
  }
  assert.equal(net.row.saves, saves, 'nadie vuelve a guardar');
  a.set({ appearance: { accent: 'neptune' } });
  assert.equal(a.engine.hasLocalChanges(), true);
  await a.engine.sync();
  assert.equal(net.row.saves, saves + 1);
  await b.engine.sync();
  assert.equal(b.engine.hasLocalChanges(), false, 'lo aplicado no cuenta como un cambio');
  assert.equal(net.row.saves, saves + 1);
});

test('dos versiones que normalizan distinto no se pisan para siempre', async () => {
  const net = cloud();
  const clock = ticking();
  const a = pc(net, { appearance: { playButton: { color: 'accent' } } }, { clock });
  // B agrega un campo a lo que llega, como haría una versión más nueva
  const withField = (s) => (s.appearance?.playButton ? { ...s, appearance: { ...s.appearance, playButton: { ...s.appearance.playButton, sound: 'none' } } } : s);
  const b = pc(net, { appearance: { playButton: { color: 'accent' } } }, { clock, normalize: withField });
  await a.engine.sync();
  await b.engine.sync();
  const saves = net.row.saves;
  for (let i = 0; i < 4; i++) {
    await b.engine.sync();
    await a.engine.sync();
  }
  assert.equal(net.row.saves, saves);
  assert.deepEqual(b.settings.appearance.playButton, { color: 'accent', sound: 'none' });
});

// Las claves que la 6.1 sumó a los looks (uiText, uiCards, uiSide): con el valor de fábrica no viajan, así un look viaja
// igual que en 6.0 y el hash que guardó la 6.0 sigue valiendo
const NEW_LOOK_KEYS = ['uiText', 'uiCards', 'uiSide'];
const as60 = (looks) => looks.map((l) => ({ ...l, appearance: Object.fromEntries(Object.entries(l.appearance).filter(([k]) => !NEW_LOOK_KEYS.includes(k))) }));

test('un look sin estilo propio viaja sin las claves nuevas de la 6.1; con estilo propio, las lleva', () => {
  const [plain] = syncLooks([{ id: 'a', name: 'A', createdAt: 1, appearance: {}, branding: {} }]);
  for (const k of NEW_LOOK_KEYS) assert.equal(k in plain.appearance, false, k);
  const [styled] = syncLooks([{ id: 'b', name: 'B', createdAt: 1, appearance: { uiSide: 'right', uiText: 'large' }, branding: {} }]);
  assert.equal(styled.appearance.uiSide, 'right');
  assert.equal(styled.appearance.uiText, 'large');
  assert.equal('uiCards' in styled.appearance, false);
});

test('actualizar a la 6.1 no cuenta como un cambio de looks: la PC atrasada trae los looks nuevos en lugar de pisarlos', async () => {
  const net = cloud();
  const clock = ticking();
  const uno = { id: 'uno', name: 'Uno', createdAt: 1, appearance: { accent: 'mars' }, branding: {} };
  const a = pc(net, { looks: [uno] }, { clock });
  const b = pc(net, { looks: [uno] }, { clock });
  await a.engine.sync();
  await b.engine.sync();
  // B guardó su estado con la 6.0: el hash de los looks sin las claves nuevas
  b.state.keys.looks.h = hashValue(as60(syncLooks(b.settings.looks)));
  // A, ya en 6.1, guarda un look nuevo y lo sube
  a.set({ looks: [{ id: 'nuevo', name: 'Nuevo en A', createdAt: 2, appearance: { accent: 'venus' }, branding: {} }, uno] });
  await a.engine.sync();
  // B se abre ya actualizada: trae, no sube su lista vieja
  assert.equal((await b.engine.sync()).status, 'pulled');
  assert.deepEqual(b.settings.looks.map((l) => l.name), ['Nuevo en A', 'Uno']);
  await a.engine.sync();
  assert.deepEqual(a.settings.looks.map((l) => l.name), ['Nuevo en A', 'Uno']);
});

test('elegir "subir esto" manda sobre la nube, aunque tenga fechas más nuevas', async () => {
  const net = cloud();
  const clock = ticking();
  const a = pc(net, { decor: { cursor: 'pixel' } }, { clock });
  await a.engine.sync();
  const b = pc(net, { decor: { cursor: 'sword' } }, { clock, ask: async () => 'push' });
  assert.equal((await b.engine.sync()).status, 'pushed');
  assert.equal(b.settings.decor.cursor, 'sword');
  await a.engine.sync();
  assert.equal(a.settings.decor.cursor, 'sword');
});

test('otra PC guarda en el medio: conflicto, fusión y reintento', async () => {
  const net = cloud();
  const clock = ticking();
  const a = pc(net, { decor: { cursor: 'pixel' } }, { clock });
  const b = pc(net, { decor: { cursor: 'pixel' } }, { clock });
  await a.engine.sync();
  await b.engine.sync();
  a.set({ decor: { cursor: 'sword' } });
  b.set({ decor: { density: 'low' } });
  // A guarda justo entre el get y el save de B
  const realGet = net.rpc;
  let once = true;
  b.engine = createSyncEngine({
    rpc: async (name, args) => {
      const out = await realGet(name, args);
      if (name === 'settings_sync_get' && once) {
        once = false;
        await a.engine.sync();
      }
      return out;
    },
    userId: () => 'u1',
    getSettings: () => b.settings,
    applyPatch: async (patch) => {
      b.set(patch);
      return b.settings;
    },
    loadState: () => b.state,
    saveState: async (s) => {
      b.state = structuredClone(s);
    },
    ask: async () => 'pull',
    now: clock,
  });
  await b.engine.sync();
  assert.equal(b.settings.decor.cursor, 'sword', 'lo de A llegó por el conflicto');
  await a.engine.sync();
  assert.equal(a.settings.decor.density, 'low', 'lo de B no se perdió');
});

test('un reloj adelantado en otra PC no gana para siempre', async () => {
  const net = cloud();
  const a = pc(net, { decor: { cursor: 'pixel' } }, { clock: () => 9e12 });
  await a.engine.sync();
  let t = 2000;
  const b = pc(net, { decor: { cursor: 'x' } }, { clock: () => (t += 10) });
  await b.engine.sync();
  assert.equal(b.settings.decor.cursor, 'pixel');
  b.set({ decor: { cursor: 'sword' } });
  await b.engine.sync();
  assert.ok(b.state.keys['decor.cursor'].at < 9e12);
});

test('sin sesión no hace nada, otra cuenta empieza de cero y borrar de la nube deja todo limpio', async () => {
  const net = cloud();
  const clock = ticking();
  const a = pc(net, { decor: { cursor: 'pixel' } }, { clock });
  a.user = '';
  assert.deepEqual(await a.engine.sync(), { status: 'signedOut' });
  assert.equal(net.row.gets, 0);
  a.user = 'u1';
  await a.engine.sync();
  a.user = 'u2'; // misma nube de mentira: cuenta que todavía no decidió
  await a.engine.sync();
  assert.equal(a.asks, 1);
  assert.equal(a.state.userId, 'u2');
  await a.engine.removeRemote();
  assert.equal(net.row.version, 0);
  assert.equal(a.state.version, 0);
});

test('si no responde "traer" o "subir", no toca ni sube nada', async () => {
  const net = cloud();
  const clock = ticking();
  const a = pc(net, { decor: { cursor: 'pixel' } }, { clock });
  await a.engine.sync();
  const saves = net.row.saves;
  const b = pc(net, { decor: { cursor: 'x' } }, { clock, ask: async () => null });
  assert.equal((await b.engine.sync()).status, 'waiting');
  assert.equal(b.settings.decor.cursor, 'x');
  assert.equal(net.row.saves, saves);
});

test('dos pedidos seguidos van uno detrás del otro', async () => {
  const net = cloud();
  const a = pc(net, { decor: { cursor: 'pixel' } }, { clock: ticking() });
  await Promise.all([a.engine.sync(), a.engine.sync(), a.engine.sync()]);
  assert.equal(net.row.saves, 1);
});

test('detectChanges solo marca lo que cambió de verdad, sin importar el orden de las claves', () => {
  const meta = detectChanges({ 'home.layout': { order: ['a'], wide: [] } }, {}, 5).meta;
  assert.equal(meta['home.layout'].at, 5);
  assert.deepEqual(detectChanges({ 'home.layout': { wide: [], order: ['a'] } }, meta, 9).changed, []);
  assert.deepEqual(detectChanges({ 'home.layout': { wide: [], order: ['b'] } }, meta, 9).changed, ['home.layout']);
});
