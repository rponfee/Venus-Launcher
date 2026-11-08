'use strict';
// El chequeo antes de jugar y la lectura al cerrar, con instancias reales en una carpeta temporal.
// node --test "src/main/modules/sharedoptions/test/"
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('antes de jugar se escribe y al cerrar vuelve al perfil', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'venus-sharedoptions-hook-'));
  const paths = require('../../../core/paths');
  paths.setRoot(root);
  const instances = require('../../../core/instances');
  const game = require('../../../core/game');
  const shared = require('../../sharedoptions');
  const serversdat = require('../../serverlist/serversdat');
  const originalStatus = game.status;
  const read = (inst) => fs.readFileSync(path.join(inst.dir, 'options.txt'), 'utf8');
  const write = (inst, lines) => fs.writeFileSync(path.join(inst.dir, 'options.txt'), `${lines.join('\n')}\n`);
  const launch = async (inst, extra = {}) => shared.beforeLaunch({ id: inst.id, instance: await instances.get(inst.id), quiet: false, ...extra });
  try {
    const source = await instances.update((await instances.create({ name: 'Origen', mcVersion: '1.20.1', loader: 'fabric' })).id, { sharedOptions: true });
    const target = await instances.update((await instances.create({ name: 'Destino', mcVersion: '1.21', loader: 'fabric' })).id, { sharedOptions: true });
    const old = await instances.update((await instances.create({ name: 'Vieja', mcVersion: '1.12.2', loader: 'forge' })).id, { sharedOptions: true });
    const off = await instances.update((await instances.create({ name: 'Apagada', mcVersion: '1.21', loader: 'fabric' })).id, { sharedOptions: false });

    await assert.rejects(() => shared.saveFromInstance(source.id), (e) => e.code === 'noOptions', 'sin options.txt no hay qué guardar');

    write(source, ['version:3465', 'fov:0.5', 'mouseSensitivity:0.9', 'lang:es_ar', 'key_key.forward:key.keyboard.w']);
    write(target, ['version:3700', 'fov:0.0', 'lang:en_us', 'key_key.forward:key.keyboard.z']);
    write(old, ['version:1343', 'fov:0.0', 'key_key.forward:17']);
    write(off, ['version:3700', 'fov:0.0']);

    await serversdat.add(path.join(source.dir, 'servers.dat'), { name: 'Uno', ip: 'uno.example' });
    await serversdat.add(path.join(target.dir, 'servers.dat'), { name: 'Dos', ip: 'dos.example' });
    await shared.initializeServers();
    assert.deepEqual((await serversdat.list(path.join(source.dir, 'servers.dat'))).map((s) => s.ip).sort(), ['dos.example', 'uno.example']);
    assert.deepEqual((await serversdat.list(path.join(target.dir, 'servers.dat'))).map((s) => s.ip).sort(), ['dos.example', 'uno.example']);
    await serversdat.remove(path.join(target.dir, 'servers.dat'), 'uno.example');
    await shared.syncServersFrom(target.id);
    assert.deepEqual((await serversdat.list(path.join(source.dir, 'servers.dat'))).map((s) => s.ip), ['dos.example']);

    // Sin perfil guardado no se toca nada
    await launch(target);
    assert.match(read(target), /fov:0\.0/);

    const summary = await shared.saveFromInstance(source.id);
    assert.equal(summary.saved, true);
    assert.equal(summary.source.name, 'Origen');

    await launch(target);
    assert.match(read(target), /^version:3700\nfov:0\.5\nlang:en_us\nkey_key\.forward:key\.keyboard\.w\nmouseSensitivity:0\.9\n$/);
    assert.equal(fs.existsSync(path.join(target.dir, '.venus', 'sharedoptions-backup.txt')), true);

    // Otra instancia con otra época: lo común sí, las teclas no
    await launch(old);
    assert.match(read(old), /fov:0\.5/);
    assert.match(read(old), /key_key\.forward:17/);

    // Apagada, partida silenciosa o con el juego corriendo: el archivo no se toca
    await launch(off);
    assert.match(read(off), /fov:0\.0/);
    write(target, ['version:3700', 'fov:0.1']);
    await launch(target, { quiet: true });
    assert.match(read(target), /fov:0\.1/);
    game.status = () => ({ [target.id]: { state: 'running', pid: 1 } });
    await launch(target);
    assert.match(read(target), /fov:0\.1/, 'con el juego corriendo no se escribe');
    game.status = originalStatus;

    // Al cerrar: con el interruptor activado por defecto, el cambio vuelve al perfil
    write(target, ['version:3700', 'fov:0.8', 'key_key.forward:key.keyboard.up']);
    await shared.afterSession({ instanceId: target.id });
    assert.equal((await shared.readProfile()).common.fov, '0.8');

    await shared.setPrefs({ syncBack: true });
    // Crash, partida silenciosa o instancia sin el perfil: tampoco
    await shared.afterSession({ instanceId: target.id, crashed: true });
    await shared.afterSession({ instanceId: target.id, quiet: true });
    write(off, ['version:3700', 'fov:0.33']);
    await shared.afterSession({ instanceId: off.id });
    assert.equal((await shared.readProfile()).common.fov, '0.8');

    await shared.afterSession({ instanceId: target.id });
    const after = await shared.readProfile();
    assert.equal(after.common.fov, '0.8');
    assert.equal(after.bindings.modern['key_key.forward'], 'key.keyboard.up');
    assert.equal(after.dataVersion.modern, '3700');

    // El cambio llega a la otra instancia la próxima vez que se juegue
    await launch(source);
    assert.match(read(source), /fov:0\.8/);
    assert.match(read(source), /key_key\.forward:key\.keyboard\.up/);

    // Los grupos apagados no viajan
    await shared.setPrefs({ groups: { fov: false } });
    write(source, ['version:3465', 'fov:0.2', 'key_key.forward:key.keyboard.w']);
    await launch(source);
    assert.match(read(source), /fov:0\.2/);
    assert.match(read(source), /key_key\.forward:key\.keyboard\.up/);

    const st = await shared.status(source.id);
    assert.equal(st.instance.enabled, true);
    assert.equal(st.instance.format, 'modern');
    assert.equal(st.instance.hasOptions, true);
    assert.equal((await shared.status()).instance, null);
  } finally {
    game.status = originalStatus;
    await new Promise((r) => setTimeout(r, 50));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
