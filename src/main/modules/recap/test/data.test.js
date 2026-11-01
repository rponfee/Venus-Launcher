'use strict';
// recap:data de punta a punta con una carpeta de datos temporal (sin Electron): archivos rotos o editados a
// mano no lo hacen fallar y a la interfaz solo le llega texto.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const write = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
};

test('recap:data con datos de disco rotos no falla', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'venus-recap-data-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  require('../../../core/paths').setRoot(root);

  const now = Date.now();
  const start = now - 3 * 3600000;
  // Instancia con el nombre, la version y el loader rotos (venus-instance.json editado a mano)
  write(path.join(root, 'instances', 'rota', 'venus-instance.json'), { id: 'rota', name: 12345, mcVersion: 7, loader: { x: 1 }, created: now - 86400000 });
  write(path.join(root, 'instances', 'rota', 'mods', 'a.jar'), 'PK');
  write(path.join(root, 'instances', 'rota', 'saves', 'Mundo', 'level.dat'), 'esto no es NBT');
  write(path.join(root, 'data', 'stats.json'), {
    version: 2,
    sessions: [{ instanceId: 'rota', name: 'Mi survival', mcVersion: '1.21.1', loader: 'fabric', start, end: start + 2 * 3600000 }, { start: 'x' }],
    archived: 'basura',
    milestones: { time1: now },
  });
  write(
    path.join(root, 'data', 'stats-activity.json'),
    [
      JSON.stringify({ seq: 1, instanceId: 'rota', kind: 'world', start: start + 60000, end: start + 3600000, instanceName: 'Mi survival', world: 'Mundo' }),
      '{"seq": 2, "cortada',
      JSON.stringify({ seq: 3, instanceId: 'rota', kind: 'server', start: start + 3600000, end: start + 7000000, address: '10.1.5:25565' }),
    ].join('\n'),
  );

  const recap = require('../../recap');
  const handlers = new Map();
  recap.register({
    handle: (channel, fn) => handlers.set(channel, fn),
    send() {},
    getWindow: () => null,
    safePath: (p) => {
      const full = path.resolve(p);
      if (!full.startsWith(path.resolve(root) + path.sep)) throw new Error('fuera de la carpeta de datos');
      return full;
    },
    onQuit() {},
  });
  const d = await handlers.get('recap:data')();
  assert.equal(d.hasPlaytime, true);
  assert.equal(d.periods.week.ms, 2 * 3600000);
  assert.equal(d.periods.week.sessions, 1);
  // El mundo se muestra con la carpeta (level.dat roto) y el nombre de instancia que guardo la actividad
  assert.deepEqual(d.periods.week.top, { kind: 'world', name: 'Mundo', instanceName: 'Mi survival', ms: 3540000 });
  // La favorita existe pero su nombre no es texto: se usa el de la partida
  assert.equal(d.periods.week.favorite.name, 'Mi survival');
  assert.equal(d.periods.week.favorite.mcVersion, '1.21.1');
  assert.equal(d.periods.week.favorite.loader, 'vanilla');
  assert.equal(d.periods.week.favorite.mods, 1);
  // La IP corta del servidor cuenta como servidor visitado pero no se muestra
  assert.equal(d.periods.week.serversVisited, 1);
  assert.deepEqual(d.collection, { instances: 1, mods: 1, worlds: 1 });
  // A la interfaz no le llega ninguna ruta ni nada de la instancia aparte de lo que se dibuja
  assert.ok(!JSON.stringify(d).includes(root.replace(/\\/g, '\\\\')));
});
