'use strict';
// Pruebas de las herramientas de servidores locales y extras de instancias (parte de selftest.js).
// Servidor de prueba en una carpeta temporal: no se lanza Java (core/servers.js tiene start/stop/consola falsos).
// Se carga desde selftest.js (que ya cambio la carpeta de datos a una temporal): no se corre solo.
module.exports = function registerServerTests(h) {
  const { test, assert, agent, tools, undo, ask, steps, toolsStep, textStep, toolUse, evs, lastToolResults, setConfirm, setScript, TMP, TRASH, INST, IDIR, fs, path, exists, remoteVersions, fakeVersion, setBadHost, downloads } = h;
  const paths = require('../../core/paths');
  const servers = require('../../core/servers');
  const modrinth = require('../../core/modrinth');
  const config = require('./config');
  const toolDefs = require('./tool-defs');
  const fixture = require('./test/fixtures/servers-fixture');
  const AdmZip = require('adm-zip');

  const SID = 'test-srv';
  const SDIR = paths.server(SID);
  const ctl = fixture.patchServers(servers);
  const installed = [];
  let searchCalls = [];
  let snapshotsOn = false;
  tools.configure({ installServer: (id) => installed.push(id), startWaitMs: 0, stopWaitMs: 50, commandWaitMs: 5, optional: (n) => (n === 'snapshots' && snapshotsOn ? require('../snapshots') : null) });
  modrinth.search = async (p) => {
    searchCalls.push(p);
    return { hits: [{ project_id: 'essentialsx', slug: 'essentialsx', title: 'EssentialsX', description: 'Commands', downloads: 99, categories: ['utility'] }] };
  };
  fixture.setupServer(paths, { id: SID });

  // Una pregunta con una sola herramienta. confirm: true | false | undefined (undefined = no se esperaba confirmacion)
  async function run1(name, input, confirm) {
    const asked = [];
    setConfirm((ev) => {
      asked.push(ev);
      return confirm === true;
    });
    setScript(steps(toolsStep(toolUse(name, input)), textStep('Listo.')));
    const r = await ask(null, `prueba ${name}`, { instanceId: INST });
    const conv = await agent.getConv(r.conversationId);
    const res = lastToolResults(conv)[0];
    const ev = evs(r.conversationId, 'tool-result').at(-1);
    return { res, data: res.data, ok: !res.is_error, ev, asked, convId: r.conversationId };
  }
  const prop = (k) => (fs.readFileSync(path.join(SDIR, 'server.properties'), 'utf8').match(new RegExp(`^${k.replace('.', '\\.')}=(.*)$`, 'm')) || [])[1];
  const meta = () => JSON.parse(fs.readFileSync(path.join(SDIR, 'venus-server.json'), 'utf8'));
  const plugins = () => fs.readdirSync(path.join(SDIR, 'plugins')).sort();

  test('servidores: lectura (list_servers, get_server_info, get_server_properties sin secretos)', async () => {
    const a = await run1('list_servers', {});
    assert.ok(a.ok);
    assert.strictEqual(a.data.servers[0].id, SID);
    assert.strictEqual(a.data.servers[0].type, 'paper');
    assert.strictEqual(a.data.servers[0].state, 'offline');
    const b = await run1('get_server_info', { server_id: SID });
    assert.deepStrictEqual([b.data.type, b.data.mc_version, b.data.state, b.data.port, b.data.ram.max_mb, b.data.address], ['paper', '1.21.1', 'offline', 25565, 2048, 'localhost:25565']);
    assert.strictEqual(b.data.players.max, 10);
    assert.strictEqual(b.data.world_exists, true);
    assert.deepStrictEqual(b.data.addon_folders, ['plugins']);
    const c = await run1('get_server_properties', { server_id: SID });
    assert.strictEqual(c.data.properties['max-players'], '10');
    assert.ok(!('rcon.password' in c.data.properties) && !('enable-rcon' in c.data.properties) && !('level-name' in c.data.properties), 'acceso remoto, secretos y rutas no se muestran');
    assert.ok(!JSON.stringify(c.data).includes('secret123'));
    assert.ok(a.asked.length + b.asked.length + c.asked.length === 0, 'las lecturas no piden confirmacion');
  });

  test('servidores: solo ids exactos y archivos pelados (nada fuera de la carpeta del servidor)', async () => {
    for (const id of ['TEST-SRV', '../instances/test-pack', 'test-srv/..', '..', '']) {
      const r = await run1('get_server_info', { server_id: id });
      assert.ok(!r.ok, `id rechazado: ${id}`);
    }
    for (const file of ['../venus-server.json', '..\\x.jar', 'C:\\x.jar', 'sub/x.jar', '/etc/x.jar']) {
      const r = await run1('toggle_server_plugin', { server_id: SID, file, enabled: false });
      assert.ok(!r.ok, `archivo rechazado: ${file}`);
    }
    const notJar = await run1('toggle_server_plugin', { server_id: SID, file: 'server.properties', enabled: false });
    assert.ok(!notJar.ok && /jar/i.test(notJar.res.data.error));
    assert.ok(exists(path.join(SDIR, 'server.properties')));
  });

  test('servidores: la consola sale anonimizada y marcada como contenido no confiable', async () => {
    servers.venusLog(SID, 'Steve[/192.168.1.55:5555] logged in; mail steve@example.com token=abcdefghijkl1234', 'INFO');
    servers.venusLog(SID, '[Server thread/ERROR]: Could not load plugin', 'ERROR');
    const r = await run1('read_server_console', { server_id: SID, lines: 50 });
    assert.ok(r.ok);
    const text = r.data.lines.join('\n');
    assert.ok(text.includes('logged in') && !text.includes('192.168.1.55') && !text.includes('steve@example.com') && !text.includes('abcdefghijkl1234'), text);
    assert.strictEqual(r.data.untrusted_content, true);
    const errs = await run1('read_server_console', { server_id: SID, errors_only: true });
    assert.ok(errs.data.lines.length >= 1 && errs.data.lines.every((l) => /ERROR|WARN/.test(l)));
  });

  test('servidores: iniciar, apagar y reiniciar usan el mecanismo del launcher (sin lanzar Java)', async () => {
    const s = await run1('start_server', { server_id: SID });
    assert.ok(s.ok && s.asked.length === 0);
    assert.ok(ctl.running.has(SID));
    assert.deepStrictEqual(ctl.calls.find((c) => c[0] === 'start'), ['start', SID]);
    const again = await run1('start_server', { server_id: SID });
    assert.strictEqual(again.data.changed, false, 'ya estaba encendido');
    // Con jugadores conectados, apagar y reiniciar piden confirmacion
    ctl.running.get(SID).players = ['Alex', 'Steve'];
    const denied = await run1('stop_server', { server_id: SID }, false);
    assert.ok(!denied.ok && denied.res.data.user_declined);
    assert.strictEqual(denied.asked.length, 1);
    assert.deepStrictEqual(denied.asked[0].items, ['Alex', 'Steve']);
    assert.ok(ctl.running.has(SID), 'cancelado: sigue encendido');
    const rs = await run1('restart_server', { server_id: SID }, true);
    assert.ok(rs.ok && rs.asked.length === 1);
    assert.ok(ctl.calls.some((c) => c[0] === 'restart'));
    ctl.running.get(SID).players = [];
    const stop = await run1('stop_server', { server_id: SID });
    assert.ok(stop.ok && stop.asked.length === 0, 'sin jugadores no pide confirmacion');
    assert.ok(!ctl.running.has(SID));
    assert.strictEqual((await run1('stop_server', { server_id: SID })).data.changed, false);
  });

  test('servidores: comandos de la consola de Minecraft (list/tps/help/seed directos; el resto confirma; op con aviso)', async () => {
    const off = await run1('send_server_command', { server_id: SID, command: 'list' });
    assert.ok(!off.ok, 'con el servidor apagado no hay consola');
    await run1('start_server', { server_id: SID });
    for (const cmd of ['list', 'tps', 'seed', 'help', 'help gamemode', '/list']) {
      const r = await run1('send_server_command', { server_id: SID, command: cmd });
      assert.ok(r.ok && r.asked.length === 0, `directo: ${cmd}`);
    }
    assert.ok(ctl.calls.some((c) => c[0] === 'command' && c[2] === 'list'));
    // Todo lo demas pide confirmacion; si se rechaza no se envia nada
    const before = ctl.calls.length;
    const no = await run1('send_server_command', { server_id: SID, command: 'say hola' }, false);
    assert.ok(!no.ok && no.asked.length === 1 && no.asked[0].danger === false);
    assert.strictEqual(ctl.calls.length, before);
    const yes = await run1('send_server_command', { server_id: SID, command: 'say hola' }, true);
    assert.ok(yes.ok && ctl.calls.at(-1)[2] === 'say hola');
    assert.ok(yes.data.output.some((l) => l.includes('ran /say hola')), 'devuelve lo que escribio la consola');
    // Avisos especiales
    for (const cmd of ['op Steve', 'deop Steve', 'ban Steve', 'pardon Steve', 'whitelist off', 'stop', 'minecraft:op Steve', 'execute as @a run op Steve', 'ban-ip 1.2.3.4']) {
      const r = await run1('send_server_command', { server_id: SID, command: cmd }, false);
      assert.strictEqual(r.asked.length, 1, `confirma: ${cmd}`);
      assert.strictEqual(r.asked[0].danger, true, `aviso especial: ${cmd}`);
    }
    const normal = await run1('send_server_command', { server_id: SID, command: 'time set day' }, false);
    assert.strictEqual(normal.asked[0].danger, false);
    // Un comando "de solo lectura" con algo pegado ya no lo es
    const sneaky = await run1('send_server_command', { server_id: SID, command: 'list; op Steve' }, false);
    assert.strictEqual(sneaky.asked.length, 1);
    // Entradas no validas: varias lineas, caracteres de control, muy largo
    for (const cmd of ['say a\nop Steve', 'say \x00', 'x'.repeat(201), '']) {
      const r = await run1('send_server_command', { server_id: SID, command: cmd }, true);
      assert.ok(!r.ok && r.asked.length === 0, `rechazado: ${JSON.stringify(cmd).slice(0, 30)}`);
    }
    await run1('stop_server', { server_id: SID });
  });

  test('servidores: set_server_property validada + Deshacer; secretos, rutas y acceso remoto bloqueados; las de seguridad confirman', async () => {
    const r = await run1('set_server_property', { server_id: SID, key: 'max-players', value: '25' });
    assert.ok(r.ok && r.ev.undoId && prop('max-players') === '25');
    assert.strictEqual(r.data.before, '10');
    assert.ok(exists(path.join(SDIR, '.venus', 'assistant-undo', r.ev.undoId, 'snapshot.json')), 'instantanea del servidor');
    await agent.undoAction(r.ev.undoId);
    assert.strictEqual(prop('max-players'), '10');
    // Enum sin importar las mayusculas, bool, rangos
    const d = await run1('set_server_property', { server_id: SID, key: 'difficulty', value: 'HARD' });
    assert.ok(d.ok && prop('difficulty') === 'hard');
    assert.ok(!(await run1('set_server_property', { server_id: SID, key: 'difficulty', value: 'imposible' })).ok);
    assert.ok(!(await run1('set_server_property', { server_id: SID, key: 'max-players', value: 'muchos' })).ok);
    assert.ok(!(await run1('set_server_property', { server_id: SID, key: 'spawn-protection', value: '-5' })).ok);
    assert.ok(!(await run1('set_server_property', { server_id: SID, key: 'hardcore', value: 'quizas' })).ok);
    assert.ok(!(await run1('set_server_property', { server_id: SID, key: 'motd', value: 'a\nb' })).ok);
    assert.strictEqual((await run1('set_server_property', { server_id: SID, key: 'difficulty', value: 'hard' })).data.changed, false);
    // Bloqueadas: acceso remoto, secretos, rutas, descargas externas y claves que no existen
    const before = fs.readFileSync(path.join(SDIR, 'server.properties'), 'utf8');
    for (const key of ['enable-rcon', 'rcon.password', 'rcon.port', 'level-name', 'server-ip', 'resource-pack', 'resource-pack-sha1', 'management-server-secret', 'inventada', '../x', 'motd\nop=x']) {
      const x = await run1('set_server_property', { server_id: SID, key, value: 'true' });
      assert.ok(!x.ok, `bloqueada: ${key}`);
    }
    assert.strictEqual(fs.readFileSync(path.join(SDIR, 'server.properties'), 'utf8'), before, 'ningun archivo cambio');
    // Seguridad: confirma (online-mode, white-list...). Si se rechaza no cambia
    const no = await run1('set_server_property', { server_id: SID, key: 'online-mode', value: 'true' }, false);
    assert.ok(!no.ok && no.asked.length === 1 && no.asked[0].danger === true && prop('online-mode') === 'false');
    const yes = await run1('set_server_property', { server_id: SID, key: 'white-list', value: 'true' }, true);
    assert.ok(yes.ok && prop('white-list') === 'true' && yes.ev.undoId);
    await agent.undoAction(yes.ev.undoId);
    assert.strictEqual(prop('white-list'), 'false');
    // Con el servidor encendido avisa que hay que reiniciar
    await run1('start_server', { server_id: SID });
    const live = await run1('set_server_property', { server_id: SID, key: 'motd', value: 'Hola mundo' });
    assert.ok(live.ok && live.data.restart_required === true && live.ev.warnings.length === 1);
    await run1('stop_server', { server_id: SID });
    await agent.undoAction(live.ev.undoId);
    assert.strictEqual(prop('motd'), 'Servidor de prueba');
    // Puerto de otro servidor
    assert.ok(!(await run1('set_server_property', { server_id: SID, key: 'server-port', value: '80' })).ok, 'puertos bajos no');
  });

  test('servidores: set_server_ram dentro del limite, con Deshacer y aviso de reinicio', async () => {
    const os = require('os');
    const limit = Math.floor((Math.floor(os.totalmem() / 1048576) * 0.75) / 128) * 128;
    assert.ok(!(await run1('set_server_ram', { server_id: SID, max_mb: limit + 1024 })).ok, 'por encima del 75% no');
    assert.ok(!(await run1('set_server_ram', { server_id: SID, max_mb: 100 })).ok);
    assert.ok(!(await run1('set_server_ram', { server_id: SID, max_mb: 2048, min_mb: 4096 })).ok, 'la inicial no puede superar la maxima');
    const r = await run1('set_server_ram', { server_id: SID, max_mb: 1536, min_mb: 512 });
    assert.ok(r.ok && r.ev.undoId);
    assert.deepStrictEqual(meta().memory, { min: 512, max: 1536 });
    await agent.undoAction(r.ev.undoId);
    assert.deepStrictEqual(meta().memory, { min: 1024, max: 2048 });
    await run1('start_server', { server_id: SID });
    const live = await run1('set_server_ram', { server_id: SID, max_mb: 1536 });
    assert.strictEqual(live.data.restart_required, true);
    await run1('stop_server', { server_id: SID });
    await agent.undoAction(live.ev.undoId);
  });

  test('servidores: plugins — listar, buscar con tipo y version del servidor, instalar con Deshacer, host y fuente bloqueados', async () => {
    const l = await run1('list_server_plugins', { server_id: SID });
    const files = l.data.folders[0].files;
    assert.deepStrictEqual(files.map((f) => f.file).sort(), ['ess-old.jar', 'luckperms-1.0.jar', 'spare-1.0.jar.disabled']);
    assert.strictEqual(files.find((f) => f.file === 'ess-old.jar').title, 'EssentialsX');
    assert.strictEqual(files.find((f) => f.file === 'spare-1.0.jar.disabled').enabled, false);
    searchCalls = [];
    const s = await run1('search_server_plugins', { server_id: SID, query: 'essentials' });
    assert.strictEqual(s.data.results[0].project_id, 'essentialsx');
    assert.strictEqual(searchCalls[0].type, 'plugin');
    assert.strictEqual(searchCalls[0].gameVersion, '1.21.1');
    assert.deepStrictEqual(searchCalls[0].loaders, ['paper', 'spigot', 'bukkit']);
    // Instalar (Modrinth): archivo en plugins/, registro y Deshacer
    const inst = await run1('install_server_plugin', { server_id: SID, project_id: 'worldedit' });
    assert.ok(inst.ok && inst.ev.undoId, JSON.stringify(inst.res.data));
    assert.ok(plugins().includes('worldedit-1.0.jar'));
    assert.ok(meta().modrinth.projects.worldedit);
    assert.strictEqual(inst.data.restart_required, true);
    // Ya instalado: nada que hacer
    assert.strictEqual((await run1('install_server_plugin', { server_id: SID, project_id: 'worldedit' })).data.changed, false);
    await agent.undoAction(inst.ev.undoId);
    assert.ok(!plugins().includes('worldedit-1.0.jar'), 'Deshacer quita lo que se instalo');
    assert.ok(!meta().modrinth.projects.worldedit);
    assert.ok(fs.readdirSync(TRASH).some((f) => f.startsWith('worldedit-1.0.jar')), 'a la papelera');
    // Host que no es Modrinth: no se baja nada y no queda ningun archivo
    const dl = downloads.length;
    setBadHost('evilplugin');
    const bad = await run1('install_server_plugin', { server_id: SID, project_id: 'evilplugin' });
    setBadHost(null);
    assert.ok(!bad.ok && /Modrinth/.test(bad.res.data.error), bad.res.data.error);
    assert.strictEqual(downloads.length, dl);
    assert.ok(!plugins().some((f) => /evil/.test(f)));
    // CurseForge no se instala en servidores
    const cf = await run1('install_server_plugin', { server_id: SID, project_id: 'cf:12345' });
    assert.ok(!cf.ok && /Modrinth/.test(cf.res.data.error));
    // Busqueda vacia
    assert.ok(!(await run1('search_server_plugins', { server_id: SID, query: ' ' })).ok);
  });

  test('servidores: actualizar, reemplazar y activar/desactivar plugins con Deshacer; encendido se rechaza; quitar confirma y va a la papelera', async () => {
    remoteVersions.set('v-ess-2', { ...fakeVersion('essentialsx'), id: 'v-ess-2', version_number: '2.0', loaders: ['paper'], files: [{ primary: true, filename: 'essentialsx-2.0.jar', url: 'https://cdn.modrinth.com/data/essentialsx/versions/2/essentialsx-2.0.jar', hashes: { sha1: require('crypto').createHash('sha1').update('https://cdn.modrinth.com/data/essentialsx/versions/2/essentialsx-2.0.jar').digest('hex') }, size: 10 }] });
    // Actualizar: el jar anterior queda guardado para Deshacer
    const up = await run1('update_server_plugin', { server_id: SID, file: 'ess-old.jar', version_id: 'v-ess-2' });
    assert.ok(up.ok && up.ev.undoId, JSON.stringify(up.res.data));
    assert.ok(plugins().includes('essentialsx-2.0.jar') && !plugins().includes('ess-old.jar'));
    assert.strictEqual(meta().modrinth.projects.essentialsx.versionNumber, '2.0');
    const kept = fs.readdirSync(path.join(SDIR, '.venus', 'assistant-undo', up.ev.undoId, 'files'));
    assert.ok(kept.some((f) => f.endsWith('ess-old.jar')), 'copia del jar anterior');
    await agent.undoAction(up.ev.undoId);
    assert.ok(plugins().includes('ess-old.jar') && !plugins().includes('essentialsx-2.0.jar'));
    assert.strictEqual(meta().modrinth.projects.essentialsx.versionNumber, '1.0-old');
    // Reemplazar por otro proyecto: el viejo a la papelera + copia para Deshacer
    const rp = await run1('replace_server_plugin', { server_id: SID, file: 'ess-old.jar', project_id: 'cmi' });
    assert.ok(rp.ok && rp.ev.undoId, JSON.stringify(rp.res.data));
    assert.ok(plugins().includes('cmi-1.0.jar') && !plugins().includes('ess-old.jar'));
    assert.ok(!meta().modrinth.projects.essentialsx && meta().modrinth.projects.cmi);
    assert.ok(fs.readdirSync(TRASH).some((f) => f.startsWith('ess-old.jar')), 'el original en la papelera');
    await agent.undoAction(rp.ev.undoId);
    assert.ok(plugins().includes('ess-old.jar') && !plugins().includes('cmi-1.0.jar'));
    assert.ok(meta().modrinth.projects.essentialsx && !meta().modrinth.projects.cmi);
    // Mismo proyecto: usar update
    assert.ok(!(await run1('replace_server_plugin', { server_id: SID, file: 'ess-old.jar', project_id: 'essentialsx' })).ok);
    // Activar / desactivar
    const off = await run1('toggle_server_plugin', { server_id: SID, file: 'luckperms-1.0.jar', enabled: false });
    assert.ok(off.ok && off.ev.undoId && plugins().includes('luckperms-1.0.jar.disabled'));
    await agent.undoAction(off.ev.undoId);
    assert.ok(plugins().includes('luckperms-1.0.jar') && !plugins().includes('luckperms-1.0.jar.disabled'));
    assert.strictEqual((await run1('toggle_server_plugin', { server_id: SID, file: 'luckperms-1.0.jar', enabled: true })).data.changed, false);
    const on = await run1('toggle_server_plugin', { server_id: SID, file: 'spare-1.0.jar', enabled: true });
    assert.ok(on.ok && plugins().includes('spare-1.0.jar'));
    await agent.undoAction(on.ev.undoId);
    // Con el servidor encendido los jar no se tocan
    await run1('start_server', { server_id: SID });
    for (const [name, input] of [['toggle_server_plugin', { file: 'luckperms-1.0.jar', enabled: false }], ['update_server_plugin', { file: 'ess-old.jar' }], ['replace_server_plugin', { file: 'ess-old.jar', project_id: 'cmi' }], ['remove_server_plugin', { file: 'luckperms-1.0.jar' }]]) {
      const r = await run1(name, { server_id: SID, ...input }, true);
      assert.ok(!r.ok && /stop_server|Apag|Stop/i.test(r.res.data.error), `${name} con el servidor encendido`);
      assert.strictEqual(r.asked.length, 0);
    }
    await run1('stop_server', { server_id: SID });
    // Quitar: destructiva, confirma y va a la papelera
    const no = await run1('remove_server_plugin', { server_id: SID, file: 'luckperms-1.0.jar' }, false);
    assert.ok(!no.ok && no.asked.length === 1 && plugins().includes('luckperms-1.0.jar'));
    const yes = await run1('remove_server_plugin', { server_id: SID, file: 'luckperms-1.0.jar' }, true);
    assert.ok(yes.ok && !plugins().includes('luckperms-1.0.jar') && yes.ev.undoId === null);
    assert.ok(fs.readdirSync(TRASH).some((f) => f.startsWith('luckperms-1.0.jar')));
  });

  test('servidores: copia del mundo (+Deshacer) y restaurar (destructiva): el mundo actual va a la papelera con una copia previa y nunca se borra', async () => {
    const empty = await run1('list_server_backups', { server_id: SID });
    assert.strictEqual(empty.data.count, 0);
    const b = await run1('backup_server_world', { server_id: SID });
    assert.ok(b.ok && b.ev.undoId, JSON.stringify(b.res.data));
    const name = b.data.backup;
    assert.ok(exists(path.join(SDIR, 'backups', name)));
    const zipNames = new AdmZip(path.join(SDIR, 'backups', name)).getEntries().map((e) => e.entryName);
    assert.ok(zipNames.some((n) => n.endsWith('level.dat')) && !zipNames.some((n) => n.includes('.venus')));
    assert.strictEqual((await run1('list_server_backups', { server_id: SID })).data.backups[0].name, name);
    // Deshacer: el zip va a la papelera
    await agent.undoAction(b.ev.undoId);
    assert.ok(!exists(path.join(SDIR, 'backups', name)));
    assert.ok(fs.readdirSync(TRASH).some((f) => f.startsWith(name)));
    // Restaurar una copia: mundo cambiado, copia previa y mundo actual en la papelera
    const b2 = await run1('backup_server_world', { server_id: SID });
    const keep = b2.data.backup;
    fs.writeFileSync(path.join(SDIR, 'world', 'region.mca'), 'chunk-data-NUEVO');
    const no = await run1('restore_server_backup', { server_id: SID, name: keep }, false);
    assert.ok(!no.ok && no.asked.length === 1 && no.asked[0].danger === true);
    assert.strictEqual(fs.readFileSync(path.join(SDIR, 'world', 'region.mca'), 'utf8'), 'chunk-data-NUEVO', 'rechazado: nada cambia');
    const yes = await run1('restore_server_backup', { server_id: SID, name: keep }, true);
    assert.ok(yes.ok, JSON.stringify(yes.res.data));
    assert.strictEqual(fs.readFileSync(path.join(SDIR, 'world', 'region.mca'), 'utf8'), 'chunk-data');
    assert.ok(yes.data.safety_backup && exists(path.join(SDIR, 'backups', yes.data.safety_backup)), 'copia previa del mundo actual');
    const safety = new AdmZip(path.join(SDIR, 'backups', yes.data.safety_backup));
    assert.strictEqual(safety.readAsText(safety.getEntries().find((e) => e.entryName.endsWith('region.mca')).entryName), 'chunk-data-NUEVO', 'la copia previa tiene el mundo que se reemplazo');
    assert.ok(fs.readdirSync(TRASH).some((f) => f.startsWith('world')), 'el mundo actual en la papelera');
    assert.strictEqual(yes.ev.undoId, null);
    // Encendido: no se restaura. Nombres raros y zips que no son de un mundo: no
    await run1('start_server', { server_id: SID });
    assert.ok(!(await run1('restore_server_backup', { server_id: SID, name: keep }, true)).ok);
    await run1('stop_server', { server_id: SID });
    for (const n of ['../venus-server.json', 'x.txt', 'noexiste.zip', '..\\a.zip']) assert.ok(!(await run1('restore_server_backup', { server_id: SID, name: n }, true)).ok, n);
    const evil = new AdmZip();
    evil.addFile('plugins/evil.jar', Buffer.from('x'));
    evil.writeZip(path.join(SDIR, 'backups', 'evil.zip'));
    const e = await run1('restore_server_backup', { server_id: SID, name: 'evil.zip' }, true);
    assert.ok(!e.ok && e.asked.length === 0 && !plugins().includes('evil.jar'));
    assert.ok(exists(path.join(SDIR, 'plugins')), 'la carpeta de plugins sigue ahi');
  });

  test('servidores: lista blanca y operadores piden confirmacion (apagado edita los JSON; encendido usa la consola)', async () => {
    const no = await run1('whitelist_add', { server_id: SID, player: 'Steve' }, false);
    assert.ok(!no.ok && no.asked.length === 1 && no.asked[0].items[0] === 'Steve');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(SDIR, 'whitelist.json'), 'utf8')), []);
    const add = await run1('whitelist_add', { server_id: SID, player: 'Steve' }, true);
    assert.ok(add.ok, JSON.stringify(add.res.data));
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(SDIR, 'whitelist.json'), 'utf8'))[0].name, 'Steve');
    assert.strictEqual(add.data.whitelist_enabled, false);
    assert.strictEqual(add.ev.warnings.length, 1, 'avisa que la lista blanca esta apagada');
    const op = await run1('op_player', { server_id: SID, player: 'Alex', level: 2 }, true);
    assert.ok(op.ok);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(SDIR, 'ops.json'), 'utf8')).map((o) => [o.name, o.level]), [['Alex', 2]]);
    const rem = await run1('whitelist_remove', { server_id: SID, player: 'Steve' }, true);
    assert.ok(rem.ok && JSON.parse(fs.readFileSync(path.join(SDIR, 'whitelist.json'), 'utf8')).length === 0);
    for (const player of ['', 'Nombre con espacios', 'a'.repeat(17), 'x;op'])
      assert.ok(!(await run1('op_player', { server_id: SID, player }, true)).ok, `jugador no valido: ${player}`);
    // Encendido: va por la consola de Minecraft
    await run1('start_server', { server_id: SID });
    const before = ctl.calls.length;
    const live = await run1('whitelist_add', { server_id: SID, player: 'Notch' }, true);
    assert.ok(live.ok && live.data.applied_live === true);
    assert.deepStrictEqual(ctl.calls.slice(before).find((c) => c[0] === 'command').slice(2), ['whitelist add Notch']);
    await run1('stop_server', { server_id: SID });
  });

  test('servidores: crear (acepta el EULA solo con confirmacion) + Deshacer; tipos, versiones y puertos invalidos', async () => {
    const before = fs.readdirSync(paths.servers()).length;
    const no = await run1('create_server', { name: 'Nuevo', type: 'paper', mc_version: '1.21.1' }, false);
    assert.ok(!no.ok && no.asked.length === 1 && /EULA/.test(no.asked[0].message));
    assert.strictEqual(fs.readdirSync(paths.servers()).length, before, 'sin confirmacion no se crea nada');
    const yes = await run1('create_server', { name: 'Nuevo', type: 'paper', mc_version: '1.21.1', max_mb: 1024 }, true);
    assert.ok(yes.ok && yes.ev.undoId, JSON.stringify(yes.res.data));
    const id = yes.data.server_id;
    assert.deepStrictEqual(installed, [id], 'el software se instala en segundo plano con el mecanismo del launcher');
    assert.ok(yes.data.port !== 25565, 'puerto libre distinto');
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(paths.server(id), 'venus-server.json'), 'utf8')).memory.max, 1024);
    assert.ok(!ctl.running.has(id), 'no se enciende solo');
    // Deshacer: sin mundo se manda a la papelera
    await agent.undoAction(yes.ev.undoId);
    assert.ok(!exists(paths.server(id)));
    assert.ok(fs.readdirSync(TRASH).some((f) => f.startsWith(id)));
    // Si ya tiene mundo, Deshacer se niega
    const again = await run1('create_server', { name: 'Con mundo', type: 'vanilla', mc_version: '1.21.1' }, true);
    fs.mkdirSync(path.join(paths.server(again.data.server_id), 'world'), { recursive: true });
    fs.writeFileSync(path.join(paths.server(again.data.server_id), 'world', 'level.dat'), 'x');
    await assert.rejects(() => agent.undoAction(again.ev.undoId), /mundo|world/i);
    assert.ok(exists(paths.server(again.data.server_id)));
    // Invalidos
    assert.ok(!(await run1('create_server', { name: 'x', type: 'minecraft; calc.exe', mc_version: '1.21.1' }, true)).ok);
    assert.ok(!(await run1('create_server', { name: 'x', type: 'paper', mc_version: '9.9.9' }, true)).ok);
    assert.ok(!(await run1('create_server', { name: 'x', type: 'paper', mc_version: '1.21.1', port: 25565 }, true)).ok, 'puerto de otro servidor');
    assert.ok(!(await run1('create_server', { name: 'x', type: 'paper', mc_version: '1.21.1', max_mb: 99999999 }, true)).ok);
  });

  test('recommend_ram: instancia (mods y shaders) y servidor, solo lectura', async () => {
    const a = await run1('recommend_ram', { instance_id: INST });
    assert.ok(a.ok && a.asked.length === 0 && a.ev.undoId === null);
    assert.strictEqual(a.data.target, 'instance');
    assert.ok(a.data.recommended.max_mb >= 2048 && a.data.recommended.max_mb <= a.data.machine.max_allowed_mb);
    assert.ok(a.data.recommended.min_mb <= a.data.recommended.max_mb && a.data.content.mods >= 1);
    assert.match(a.data.apply_with, /set_ram/);
    const s = await run1('recommend_ram', { server_id: SID });
    assert.ok(s.ok && s.data.target === 'server' && s.data.recommended.max_mb >= 512);
    assert.match(s.data.apply_with, /set_server_ram/);
    assert.ok(!(await run1('recommend_ram', {})).ok, 'hace falta uno');
    assert.ok(!(await run1('recommend_ram', { instance_id: INST, server_id: SID })).ok, 'no los dos');
  });

  test('duplicate_instance y rename_instance: reversibles', async () => {
    const dup = await run1('duplicate_instance', { instance_id: INST, name: 'Copia de prueba' });
    assert.ok(dup.ok && dup.ev.undoId, JSON.stringify(dup.res.data));
    const id = dup.data.instance_id;
    assert.notStrictEqual(id, INST);
    const copyDir = path.join(TMP, 'instances', id);
    assert.ok(exists(path.join(copyDir, 'mods')) && !exists(path.join(copyDir, 'saves', 'World1')), 'sin mundos por defecto');
    assert.ok(exists(path.join(IDIR, 'saves', 'World1', 'level.dat')), 'el original intacto');
    const ren = await run1('rename_instance', { instance_id: id, name: '  Otro   nombre ' });
    assert.ok(ren.ok && ren.ev.undoId);
    const nameOf = () => JSON.parse(fs.readFileSync(path.join(copyDir, 'venus-instance.json'), 'utf8')).name;
    assert.strictEqual(nameOf(), 'Otro nombre');
    await agent.undoAction(ren.ev.undoId);
    assert.strictEqual(nameOf(), 'Copia de prueba');
    assert.strictEqual((await run1('rename_instance', { instance_id: id, name: 'Copia de prueba' })).data.changed, false);
    assert.ok(!(await run1('rename_instance', { instance_id: id, name: '   ' })).ok);
    await agent.undoAction(dup.ev.undoId);
    assert.ok(!exists(copyDir), 'Deshacer quita la copia');
    // Con mundos: la copia los trae y Deshacer ya no la quita
    const withWorlds = await run1('duplicate_instance', { instance_id: INST, name: 'Con mundos', include_worlds: true });
    assert.ok(withWorlds.ok && withWorlds.data.worlds_copied === 1 && withWorlds.ev.warnings.length === 1);
    await assert.rejects(() => agent.undoAction(withWorlds.ev.undoId), /mundo|world/i);
  });

  test('instantaneas (list/create/restore) y mundos de una instancia (list_worlds/backup_world)', async () => {
    snapshotsOn = true;
    const snaps = require('../snapshots');
    fs.writeFileSync(path.join(IDIR, 'options.txt'), 'version:3955\nrenderDistance:12\n');
    const none = await run1('list_snapshots', { instance_id: INST });
    assert.ok(none.ok);
    const created = await run1('create_snapshot', { instance_id: INST, label: 'antes de probar' });
    assert.ok(created.ok && created.ev.undoId, JSON.stringify(created.res.data));
    const id = created.data.snapshot_id;
    assert.ok((await run1('list_snapshots', { instance_id: INST })).data.snapshots.some((x) => x.id === id && x.label === 'antes de probar'));
    // Cambiar algo y restaurar: confirma, vuelve el contenido y no toca los mundos
    fs.writeFileSync(path.join(IDIR, 'options.txt'), 'version:3955\nrenderDistance:3\n');
    fs.writeFileSync(path.join(IDIR, 'saves', 'World1', 'level.dat'), 'mundo-modificado');
    const no = await run1('restore_snapshot', { instance_id: INST, snapshot_id: id }, false);
    assert.ok(!no.ok && no.asked.length === 1 && no.asked[0].danger === true);
    assert.match(fs.readFileSync(path.join(IDIR, 'options.txt'), 'utf8'), /renderDistance:3/);
    const yes = await run1('restore_snapshot', { instance_id: INST, snapshot_id: id }, true);
    assert.ok(yes.ok, JSON.stringify(yes.res.data));
    assert.match(fs.readFileSync(path.join(IDIR, 'options.txt'), 'utf8'), /renderDistance:12/);
    assert.strictEqual(fs.readFileSync(path.join(IDIR, 'saves', 'World1', 'level.dat'), 'utf8'), 'mundo-modificado', 'los mundos no se tocan');
    assert.ok(yes.data.safety_snapshot_id, 'antes se guardo el estado actual');
    for (const bad of ['nope', '../x', '']) assert.ok(!(await run1('restore_snapshot', { instance_id: INST, snapshot_id: bad }, true)).ok, `id: ${bad}`);
    // Deshacer de create_snapshot borra esa instantanea
    await agent.undoAction(created.ev.undoId);
    assert.ok(!(await snaps.list(INST)).some((x) => x.id === id));
    snapshotsOn = false;
    assert.ok(!(await run1('list_snapshots', { instance_id: INST })).ok, 'sin el modulo, error claro');
    // Mundos
    const w = await run1('list_worlds', { instance_id: INST });
    assert.ok(w.ok && w.data.worlds.some((x) => x.folder === 'World1'));
    const bw = await run1('backup_world', { instance_id: INST, folder: 'World1' });
    assert.ok(bw.ok && bw.ev.undoId, JSON.stringify(bw.res.data));
    const zipPath = path.join(TMP, 'backups', 'worlds', INST, bw.data.backup);
    assert.ok(exists(zipPath) && exists(path.join(IDIR, 'saves', 'World1', 'level.dat')), 'copia creada y mundo intacto');
    await agent.undoAction(bw.ev.undoId);
    assert.ok(!exists(zipPath) && exists(path.join(IDIR, 'saves', 'World1', 'level.dat')), 'Deshacer manda solo el zip a la papelera');
    for (const folder of ['../instances', 'NoExiste', 'World1/..', '']) assert.ok(!(await run1('backup_world', { instance_id: INST, folder })).ok, `carpeta: ${folder}`);
  });

  test('niveles de permiso y definiciones: cada herramienta nueva tiene nivel, definicion y ejecutor; sin rutas, URLs ni comandos libres', async () => {
    const READ = ['list_servers', 'get_server_info', 'read_server_console', 'get_server_properties', 'list_server_plugins', 'search_server_plugins', 'list_server_backups', 'recommend_ram', 'list_snapshots', 'list_worlds'];
    const DESTRUCTIVE = ['remove_server_plugin', 'restore_server_backup', 'restore_snapshot', 'whitelist_add', 'whitelist_remove', 'op_player'];
    const REVERSIBLE = ['create_server', 'start_server', 'stop_server', 'restart_server', 'send_server_command', 'set_server_property', 'set_server_ram', 'install_server_plugin', 'update_server_plugin', 'replace_server_plugin', 'toggle_server_plugin', 'backup_server_world', 'duplicate_instance', 'rename_instance', 'create_snapshot', 'backup_world'];
    const defs = toolDefs.build();
    for (const [level, names] of [['read', READ], ['destructive', DESTRUCTIVE], ['reversible', REVERSIBLE]]) {
      for (const n of names) {
        assert.ok(defs.some((d) => d.name === n), `definicion de ${n}`);
        assert.ok(tools.REGISTRY[n], `ejecutor de ${n}`);
        assert.strictEqual(config.effectiveLevel(n, tools.REGISTRY[n].minLevel), level, `nivel de ${n}`);
        assert.strictEqual(tools.REGISTRY[n].minLevel, level, `nivel minimo propio de ${n}`);
      }
    }
    const strict = defs.filter((d) => d.strict).length;
    assert.ok(strict <= 20, 'la API admite 20 herramientas strict');
    const free = /^(path|dir|folder_path|cwd|url|uri|exe|script|shell|args|jvm_args|java_args|env|file_path)$/i;
    for (const n of [...READ, ...DESTRUCTIVE, ...REVERSIBLE]) {
      const d = defs.find((x) => x.name === n);
      for (const k of Object.keys(d.input_schema.properties)) assert.ok(!free.test(k), `${n}.${k}: sin rutas, URLs ni comandos libres`);
      assert.strictEqual(d.input_schema.additionalProperties, false);
    }
    // Servidores: ningun parametro acepta mas que ids, nombres y valores validados
    const sc = defs.find((d) => d.name === 'send_server_command');
    assert.match(sc.description, /Minecraft console command/);
    assert.match(sc.description, /never an operating-system command/);
  });
};
