'use strict';
// Paneles del overlay: lo que se le acepta a la pagina, lo que se le manda, cuando se abren y el ayudante que trae el foco.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const panels = require('../panels');
const config = require('../config');
const geometry = require('../geometry');
const { track, SCRIPT } = require('../tracker');
const { esm } = require('./helpers');

test('pedidos de la pagina: lista cerrada de acciones, tipos y largos', () => {
  for (const bad of [null, undefined, 'x', 3, [], {}, { action: 3 }, { action: 'otra' }, { action: 'overlay:push' }, { action: 'assistant:send', text: 'x' }, { action: '__proto__' }, { action: 'constructor' }]) assert.equal(panels.cleanRequest(bad), null, JSON.stringify(bad));
  assert.deepEqual(panels.cleanRequest({ action: 'recipes.info', basura: 1 }), { action: 'recipes.info' });
  assert.deepEqual(panels.cleanRequest({ action: 'recipes.search', query: 'palo', extra: true }), { action: 'recipes.search', query: 'palo' });
  assert.equal(panels.cleanRequest({ action: 'recipes.search', query: 'x'.repeat(500) }).query.length, panels.MAX_QUERY);
  assert.equal(panels.cleanRequest({ action: 'recipes.search', query: 3 }), null);
  assert.deepEqual(panels.cleanRequest({ action: 'recipes.item', id: 'minecraft:oak_planks' }), { action: 'recipes.item', id: 'minecraft:oak_planks' });
  for (const id of ['', 'sin_espacio', '../x:y', 'a:../../b', 'A:b', 'a:b c', 'https://malo.com/x', null, 3]) {
    assert.equal(panels.cleanRequest({ action: 'recipes.item', id }), null, String(id));
    assert.equal(panels.cleanRequest({ action: 'recipes.wiki', id, url: 'https://malo.com' }), null, String(id));
  }
  // La wiki nunca recibe una direccion de la pagina
  assert.deepEqual(panels.cleanRequest({ action: 'recipes.wiki', id: 'minecraft:stick', url: 'https://malo.com' }), { action: 'recipes.wiki', id: 'minecraft:stick' });
  assert.deepEqual(panels.cleanRequest({ action: 'assistant.send', text: '  hola  ', instanceId: 'otra', model: 'x', engine: 'y' }), { action: 'assistant.send', text: 'hola' });
  for (const text of ['', '   ', null, 3, 'x'.repeat(panels.MAX_TEXT + 1)]) assert.equal(panels.cleanRequest({ action: 'assistant.send', text }), null);
  assert.deepEqual(panels.cleanRequest({ action: 'assistant.confirm', requestId: 'rabc123', approved: true, always: true }), { action: 'assistant.confirm', requestId: 'rabc123', approved: true }, 'sin "Permitir siempre"');
  for (const bad of [{ requestId: 'rabc123', approved: 'si' }, { requestId: 'x', approved: true }, { requestId: 12, approved: true }, { requestId: 'r' + 'a'.repeat(100), approved: true }]) assert.equal(panels.cleanRequest({ action: 'assistant.confirm', ...bad }), null);
  assert.deepEqual(panels.cleanRequest({ action: 'launcher.open', route: 'settings/plan' }), { action: 'launcher.open', route: 'settings/plan' });
  for (const route of ['admin', 'settings/plan/../admin', 'javascript:alert(1)', null]) assert.equal(panels.cleanRequest({ action: 'launcher.open', route }), null, String(route));
  assert.deepEqual(panels.cleanRequest({ action: 'panel.switch', id: 'assistant' }), { action: 'panel.switch', id: 'assistant' });
  assert.equal(panels.cleanRequest({ action: 'panel.switch', id: 'otro' }), null);
});

test('cuando se puede abrir un panel', () => {
  assert.equal(panels.canOpen({ usable: true, fullscreen: false, fsBlocked: false }), 'ok');
  assert.equal(panels.canOpen({ usable: false, fullscreen: false, fsBlocked: false }), 'nogame');
  assert.equal(panels.canOpen({ usable: true, fullscreen: true, fsBlocked: false }), 'ok', 'puede ser ventana sin bordes: se prueba');
  assert.equal(panels.canOpen({ usable: true, fullscreen: true, fsBlocked: true }), 'fullscreen', 'ya se minimizo una vez');
  assert.equal(panels.canOpen({ usable: true, fullscreen: false, fsBlocked: true }), 'ok', 'paso a ventana');
});

test('por que el asistente no contesta: igual que la pagina', () => {
  const okStatus = { enabled: true, provider: 'venus', needsPlan: false, modelOptions: [{ id: 'haiku', blocked: null }, { id: 'opus', blocked: 'daily' }] };
  assert.equal(panels.assistantBlock(okStatus), null);
  assert.equal(panels.assistantBlock(null), 'unavailable');
  assert.equal(panels.assistantBlock({ ...okStatus, enabled: false }), 'disabled');
  assert.equal(panels.assistantBlock({ ...okStatus, provider: null }), 'unavailable');
  assert.equal(panels.assistantBlock({ ...okStatus, needsPlan: true }), 'plan');
  assert.equal(panels.assistantBlock(okStatus, { online: false }), 'offline');
  const out = { ...okStatus, modelOptions: [{ blocked: 'daily' }, { blocked: 'weekly' }] };
  assert.equal(panels.assistantBlock(out), 'quota');
  assert.equal(panels.assistantBlock({ ...out, engines: { current: 'claude', entitled: true, claude: { usable: true } } }), null, 'con su Claude Code no se gasta la cuota');
  assert.equal(panels.assistantBlock({ ...out, engines: { current: 'claude', entitled: false, claude: { usable: true } } }), 'quota');
});

test('eventos del asistente: solo lo que se dibuja y con los textos acotados', () => {
  assert.equal(panels.cleanEvent(null), null);
  assert.equal(panels.cleanEvent({ type: 3 }), null);
  const ev = panels.cleanEvent({ type: 'tool-result', seq: 7, turnId: 't1', toolUseId: 'u1', name: 'list_mods', ok: true, summary: 'x'.repeat(1000), undoId: 'u123', input: { secreto: 'no viaja' }, warnings: ['a'], mcp: { tool: 'herramienta', serverId: 'no viaja' }, otro: 'no viaja' });
  assert.equal(ev.summary.length, 400);
  assert.equal(ev.undoable, true);
  assert.equal(ev.mcpTool, 'herramienta');
  for (const k of ['input', 'undoId', 'mcp', 'otro']) assert.equal(ev[k], undefined, k);
  const conv = panels.cleanConversation({ id: 'c1', title: 'Hola', running: true, seq: 200, events: Array.from({ length: 150 }, (_, i) => ({ type: 'text', seq: i, text: 't' })), pendingConfirms: ['r1'], undoStates: { a: 1 }, model: 'x' });
  assert.equal(conv.events.length, 120, 'los ultimos alcanzan');
  assert.equal(conv.events[0].seq, 30);
  assert.deepEqual(conv.pending, ['r1']);
  assert.equal(conv.undoStates, undefined);
  assert.equal(panels.cleanConversation(null), null);
});

test('que conversacion retoma el panel', () => {
  const now = 10 * 3600 * 1000;
  assert.equal(panels.pickConversation([], now), null);
  assert.equal(panels.pickConversation(null, now), null);
  assert.equal(panels.pickConversation([{ id: 'a', updatedAt: now - 1000 }], now), 'a');
  assert.equal(panels.pickConversation([{ id: 'a', updatedAt: now - 7 * 3600 * 1000 }], now), null, 'mas de 6 horas: una nueva');
  assert.equal(panels.pickConversation([{ id: 'a', updatedAt: now - 1000 }, { id: 'b', updatedAt: 0, running: true }], now), 'b', 'la que esta corriendo primero');
});

test('atajos de los paneles en los ajustes', () => {
  const c = config.normalize(undefined);
  assert.deepEqual(c.panelShortcuts, config.PANEL_SHORTCUTS);
  assert.deepEqual(config.normalize({ panelShortcuts: { recipes: '', assistant: 'Ctrl+F9', otro: 'Ctrl+F1' } }).panelShortcuts, { recipes: '', assistant: 'Ctrl+F9' });
  assert.deepEqual(config.normalize({ panelShortcuts: { recipes: 'cualquier cosa', assistant: 3 } }).panelShortcuts, config.PANEL_SHORTCUTS);
  assert.deepEqual(config.normalize({ panelShortcuts: 'x' }).panelShortcuts, config.PANEL_SHORTCUTS);
  assert.ok(!Object.values(config.PANEL_SHORTCUTS).includes(config.DEFAULT_SHORTCUT), 'no pisan el de mostrar y ocultar');
});

test('con un panel abierto la ventana se ve (aunque este oculta), solo si el juego se puede cubrir', () => {
  const target = { info: { found: true, minimized: false, visible: true, rect: { width: 800, height: 600 }, foreground: 'otra', hwnd: 'juego' } };
  assert.deepEqual(geometry.decide({ enabled: true, userHidden: true, target, panel: true }), { show: true, mode: 'game' });
  assert.deepEqual(geometry.decide({ enabled: true, userHidden: false, target, panel: false }), { show: false, mode: 'game' }, 'sin panel, la regla de siempre');
  const minimized = { info: { ...target.info, minimized: true } };
  assert.deepEqual(geometry.decide({ enabled: true, target: minimized, panel: true }).show, false);
  assert.deepEqual(geometry.decide({ enabled: false, target, panel: true }).show, false);
  assert.equal(geometry.usableInfo(target.info), true);
  assert.equal(geometry.usableInfo(minimized.info), false);
  assert.equal(geometry.usableInfo(null), false);
});

test('el ayudante recibe la orden de traer una ventana y no otra cosa', () => {
  const written = [];
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stdin = new EventEmitter();
  child.stdin.write = (s) => {
    written.push(s);
    return true;
  };
  child.kill = () => {};
  let opts = null;
  const t = track({
    pid: 10,
    platform: 'win32',
    spawnFn: (f, a, o) => {
      opts = o;
      return child;
    },
  });
  assert.deepEqual(opts.stdio, ['pipe', 'pipe', 'ignore']);
  assert.equal(t.front('123456'), true);
  assert.equal(t.front(-5), true);
  assert.deepEqual(written, ['front 123456\n', 'front -5\n']);
  for (const bad of ['', 'x', '1; rm -rf', '12\nfront 3', null, undefined]) assert.equal(t.front(bad), false, String(bad));
  assert.equal(written.length, 2);
  child.emit('exit');
  assert.equal(t.front('1'), false, 'el ayudante ya termino');
  for (const s of ['SetForegroundWindow', 'AttachThreadInput', 'ReadOrders', 'IsBackground', 'StartsWith("front ")']) assert.ok(SCRIPT.includes(s), s);
});

test('el puente de la pagina no expone nada generico', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  const invokes = [...src.matchAll(/ipcRenderer\.(invoke|send|sendSync|on)\(([^,)]+)/g)].map((m) => `${m[1]} ${m[2]}`);
  assert.deepEqual(invokes.sort(), ["invoke 'overlay:panel'", "on channel", "send 'overlay:page'"].sort());
  assert.ok(!src.includes('sendSync'));
  assert.ok(/listen\('overlay:panelMsg'\)/.test(src));
  // La ventana sigue sin permisos ni navegacion
  const win = fs.readFileSync(path.join(__dirname, '..', 'window.js'), 'utf8');
  for (const s of ['sandbox: true', 'contextIsolation: true', 'nodeIntegration: false', "partition: 'venus-overlay'", 'setPermissionRequestHandler', "action: 'deny'", 'will-navigate']) assert.ok(win.includes(s), s);
  // Y la pagina sigue sin red ni nada en linea
  const html = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'renderer', 'overlay.html'), 'utf8');
  for (const s of ["connect-src 'none'", "script-src 'self'", "frame-src 'none'", "form-action 'none'"]) assert.ok(html.includes(s), s);
});

test('textos: los que usan los paneles y los marcadores existen en espanol e ingles', async () => {
  const root = path.join(__dirname, '..', '..', '..', '..', 'renderer');
  const dict = async (lang, ns) => (await import(`data:text/javascript;base64,${fs.readFileSync(path.join(root, 'i18n', lang, `${ns}.js`)).toString('base64')}`)).default;
  const used = new Set();
  const files = ['js/overlay/panels.js', 'js/overlay/panel-recipes.js', 'js/overlay/panel-assistant.js', 'js/features/overlaytools/markers-ui.js', 'js/features/overlaytools.js'];
  for (const f of files) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    for (const m of src.matchAll(/['`](?:overlaytools\.)?((?:rc|as|pn|mk|wiki)_[A-Za-z_]+)['`]/g)) if (m[1] !== 'mk_pin') used.add(m[1]); // mk_pin es un icono
  }
  assert.ok(used.size > 50, `claves: ${used.size}`);
  for (const lang of ['es', 'en']) {
    const d = await dict(lang, 'overlaytools');
    for (const k of used) assert.ok(k in d || `${k}_one` in d, `${lang}: falta ${k}`);
    const markers = require('../../mapviewer/markers');
    for (const c of markers.COLORS) assert.ok(`mk_color_${c.slice(1)}` in d, c);
    for (const i of markers.ICONS) assert.ok(`mk_icon_${i}` in d, i);
    for (const code of ['badCode', 'tooLong', 'limit', 'badMarker']) assert.ok(`mk_err_${code}` in d, code);
    for (const notice of ['pn_fullscreen', 'pn_noFocus', 'as_alertDone', 'as_alertConfirm']) assert.ok(`${notice}Body` in d, notice);
    const own = await dict(lang, 'overlay');
    for (const k of ['w_counters', 'perfFps', 'counter_deaths', 'counter_mined', 'counter_session', 'countersHint', 'countersHintMp', 'perfShowFps', 'countersShowDeaths', 'countersShowMined', 'countersShowSession', 'panelsTitle', 'panelName_recipes', 'panelName_assistant']) assert.ok(k in own, `${lang}: ${k}`);
  }
  // La interfaz ofrece los mismos colores e iconos que acepta el proceso principal
  const ui = fs.readFileSync(path.join(root, 'js', 'features', 'overlaytools', 'markers-ui.js'), 'utf8');
  const list = (name) => JSON.parse(new RegExp(`${name} = (\\[[^\\]]+\\])`).exec(ui)[1].replace(/'/g, '"'));
  const markers = require('../../mapviewer/markers');
  assert.deepEqual(list('MARKER_COLORS'), markers.COLORS);
  assert.deepEqual(list('MARKER_ICONS'), markers.ICONS);
});

test('markdown de las respuestas: solo partes de texto, nunca HTML', async () => {
  const md = await esm('minimd.js');
  assert.deepEqual(md.inlineParts('hola **mundo** y `code` *x* [web](https://a.b/c)'), [
    { t: 'text', v: 'hola ' },
    { t: 'b', v: 'mundo' },
    { t: 'text', v: ' y ' },
    { t: 'code', v: 'code' },
    { t: 'text', v: ' ' },
    { t: 'i', v: 'x' },
    { t: 'text', v: ' ' },
    { t: 'a', v: 'web', href: 'https://a.b/c' },
  ]);
  assert.deepEqual(md.inlineParts('<img src=x onerror=alert(1)>'), [{ t: 'text', v: '<img src=x onerror=alert(1)>' }]);
  const blocks = md.mdBlocks('# Titulo\n\nUn parrafo\nen dos lineas\n\n- uno\n- dos\n\n1. a\n2. b\n\n> cita\n\n```js\nconst x = 1;\n```\nfin');
  assert.deepEqual(blocks.map((b) => b.t), ['h', 'p', 'ul', 'ol', 'quote', 'code', 'p']);
  assert.equal(blocks[1].text, 'Un parrafo en dos lineas');
  assert.deepEqual(blocks[2].items, ['uno', 'dos']);
  assert.equal(blocks[5].text, 'const x = 1;');
  assert.deepEqual(md.mdBlocks(null), []);
  assert.deepEqual(md.mdBlocks('```\nsin cerrar').map((b) => b.t), ['code']);
});
