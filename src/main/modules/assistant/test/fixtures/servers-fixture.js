'use strict';
// Servidor local de prueba para las pruebas del asistente (selftest.js) y del MCP: carpeta temporal, sin Java ni red.
// setupServer() arma la carpeta de un servidor Paper "instalado"; patchServers() reemplaza arrancar, apagar y la
// consola de core/servers.js por versiones falsas (nunca se lanza un proceso).
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

function pluginJar(dir, file, name) {
  const zip = new AdmZip();
  zip.addFile('plugin.yml', Buffer.from(`name: ${name}\nversion: 1.0\nmain: x.Main\n`));
  zip.writeZip(path.join(dir, file));
}

function setupServer(paths, { id = 'test-srv', type = 'paper', onlineMode = false } = {}) {
  const dir = paths.server(id);
  fs.mkdirSync(path.join(dir, 'plugins'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'world'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'world', 'level.dat'), 'x');
  fs.writeFileSync(path.join(dir, 'world', 'region.mca'), 'chunk-data');
  fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true\n');
  fs.writeFileSync(
    path.join(dir, 'server.properties'),
    ['motd=Servidor de prueba', 'max-players=10', `online-mode=${onlineMode}`, 'white-list=false', 'difficulty=normal', 'gamemode=survival', 'view-distance=10', 'enable-rcon=false', 'rcon.password=secret123', 'level-name=world', 'server-port=25565', ''].join('\n'),
  );
  fs.writeFileSync(path.join(dir, 'ops.json'), '[]');
  fs.writeFileSync(path.join(dir, 'whitelist.json'), '[]');
  pluginJar(path.join(dir, 'plugins'), 'ess-old.jar', 'EssentialsX');
  pluginJar(path.join(dir, 'plugins'), 'luckperms-1.0.jar', 'LuckPerms');
  pluginJar(path.join(dir, 'plugins'), 'spare-1.0.jar.disabled', 'Spare');
  fs.writeFileSync(
    path.join(dir, 'venus-server.json'),
    JSON.stringify({
      name: 'Servidor de prueba',
      type,
      mcVersion: '1.21.1',
      loaderVersion: 'latest',
      port: 25565,
      memory: { min: 1024, max: 2048 },
      flags: 'aikar',
      java: { path: '', args: '' },
      automation: { autoRestart: false, autostart: false, restart: { mode: 'off', hours: 6, time: '05:00' }, backup: { mode: 'off', hours: 6, time: '04:00', keep: 5 } },
      created: Date.now() - 86400000,
      installed: true,
      launch: { args: ['-jar', 'server.jar', 'nogui'] },
      modrinth: { projects: { essentialsx: { title: 'EssentialsX', type: 'plugin', versionId: 'v-old', versionNumber: '1.0-old', file: 'ess-old.jar', folder: 'plugins' } } },
    }),
  );
  return { id, dir };
}

// Reemplaza lo que lanzaria Java. Devuelve { running, calls } para las comprobaciones.
function patchServers(servers) {
  const running = new Map(); // id -> { players: [] }
  const calls = [];
  const realGet = servers.get;
  servers.get = async (id) => {
    const s = await realGet(id);
    const r = running.get(s.id);
    return r ? { ...s, state: 'online', players: r.players } : s;
  };
  servers.isRunning = (id) => running.has(id);
  servers.runtimeState = (id) => (running.has(id) ? 'online' : 'offline');
  servers.start = async (id) => {
    calls.push(['start', id]);
    running.set(id, { players: [] });
  };
  servers.stop = (id) => {
    calls.push(['stop', id]);
    running.delete(id);
    return true;
  };
  servers.waitOffline = async () => true;
  servers.restart = async (id) => {
    calls.push(['restart', id]);
    running.set(id, { players: [] });
  };
  servers.command = (id, cmd) => {
    calls.push(['command', id, cmd]);
    servers.venusLog(id, `[INFO]: ran /${cmd}`, 'INFO');
    return true;
  };
  servers.versions = async () => ['1.21.1', '1.20.4'];
  return { running, calls };
}

module.exports = { setupServer, patchServers, pluginJar };
