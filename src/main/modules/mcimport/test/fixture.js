'use strict';
// Arma una carpeta .minecraft falsa en una carpeta temporal (para las pruebas de mcimport). No es una prueba.
const fs = require('fs');
const os = require('os');
const path = require('path');
const nbt = require('../../../core/nbt');

const { T } = nbt;
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);

// Las carpetas temporales de las pruebas se borran al terminar el proceso (no quedan en %TEMP%). Las uniones de
// adentro se borran como enlaces (rm no las sigue) y sus destinos son otras carpetas temporales de esta lista.
const created = [];
function tmpDir(prefix = 'mci-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}
process.on('exit', () => {
  for (const dir of created) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2 });
    } catch {
      /* se sigue con la siguiente */
    }
  }
});

function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
}

function levelDat(name, lastPlayed) {
  return nbt.write({ name: '', value: { Data: T.compound({ LevelName: T.string(name), LastPlayed: T.long(lastPlayed), version: T.int(19133) }) } }, { gzip: true });
}

function world(dir, folder, name, lastPlayed, extraBytes = 1000) {
  const w = path.join(dir, 'saves', folder);
  write(path.join(w, 'level.dat'), levelDat(name, lastPlayed));
  write(path.join(w, 'region', 'r.0.0.mca'), Buffer.alloc(extraBytes, 1));
  write(path.join(w, 'session.lock'), Buffer.from([0xe2, 0x98, 0x83]));
  return w;
}

const iso = (ms) => new Date(ms).toISOString();

// Carpeta realista: perfil "ultima version" (vanilla), Fabric en la carpeta compartida, Forge con carpeta propia,
// snapshot sin usar y un perfil de la Microsoft Store.
function buildMinecraft(root = path.join(tmpDir(), '.minecraft')) {
  const forgeDir = path.join(root, 'profiles', 'forge');
  const profiles = {
    profiles: {
      aaaa1111: { name: '', type: 'latest-release', lastVersionId: 'latest-release', icon: 'Grass', lastUsed: iso(NOW - 3 * DAY), created: iso(NOW - 300 * DAY) },
      bbbb2222: { name: 'Fabric 1.21.1', type: 'custom', lastVersionId: 'fabric-loader-0.16.5-1.21.1', icon: 'Furnace', lastUsed: iso(NOW - 1 * DAY), created: iso(NOW - 100 * DAY), javaArgs: '-Xmx4G -javaagent:evil.jar' },
      cccc3333: { name: 'Forge con mods', type: 'custom', lastVersionId: '1.20.1-forge-47.3.0', gameDir: forgeDir, lastUsed: iso(NOW - 10 * DAY), created: iso(NOW - 90 * DAY) },
      dddd4444: { name: '', type: 'latest-snapshot', lastVersionId: 'latest-snapshot', lastUsed: '1970-01-01T00:00:00.000Z' },
    },
    selectedProfile: 'bbbb2222',
    settings: { enableSnapshots: false },
    version: 3,
  };
  write(path.join(root, 'launcher_profiles.json'), JSON.stringify(profiles, null, 2));
  write(
    path.join(root, 'launcher_profiles_microsoft_store.json'),
    JSON.stringify({ profiles: { eeee5555: { name: 'Store 1.20.4', type: 'custom', lastVersionId: '1.20.4', lastUsed: iso(NOW - 20 * DAY) } } }),
  );
  write(path.join(root, 'versions', '1.21.1', '1.21.1.json'), JSON.stringify({ id: '1.21.1', type: 'release', releaseTime: '2024-08-08T12:24:45+00:00', mainClass: 'net.minecraft.client.main.Main', downloads: { client: { url: 'x' } } }));
  write(
    path.join(root, 'versions', 'fabric-loader-0.16.5-1.21.1', 'fabric-loader-0.16.5-1.21.1.json'),
    JSON.stringify({ id: 'fabric-loader-0.16.5-1.21.1', inheritsFrom: '1.21.1', mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient', libraries: [{ name: 'net.fabricmc:fabric-loader:0.16.5' }, { name: 'net.fabricmc:intermediary:1.21.1' }] }),
  );
  world(root, 'World A', 'Mi mundo', NOW - 2 * DAY, 4000);
  world(root, 'World B', 'Creativo', NOW - 30 * DAY, 2000);
  fs.mkdirSync(path.join(root, 'saves', 'not a world'), { recursive: true });
  write(path.join(root, 'mods', 'sodium.jar'), Buffer.alloc(300, 2));
  write(path.join(root, 'mods', 'lithium.jar.disabled'), Buffer.alloc(200, 2));
  write(path.join(root, 'resourcepacks', 'Faithful.zip'), Buffer.alloc(500, 3));
  write(path.join(root, 'options.txt'), 'lang:es_ar\nfov:0.5\n');
  write(path.join(root, 'servers.dat'), Buffer.alloc(40, 4));
  write(path.join(root, 'logs', 'latest.log'), 'log');
  // Carpeta propia del perfil Forge
  world(forgeDir, 'Forge World', 'Mundo con mods', NOW - 10 * DAY, 1500);
  write(path.join(forgeDir, 'mods', 'jei.jar'), Buffer.alloc(700, 5));
  write(path.join(forgeDir, 'config', 'jei-client.toml'), 'a = 1\n');
  write(path.join(forgeDir, 'options.txt'), 'lang:en_us\n');
  return { root, forgeDir };
}

const MANIFEST = {
  latest: { release: '1.21.1', snapshot: '24w14a' },
  versions: ['1.21.1', '1.21', '1.20.4', '1.20.1', '1.12.2', '1.7.10', '1.8.9', '24w14a', 'b1.7.3', '1.20.1'].map((id) => ({ id })),
};

module.exports = { tmpDir, write, levelDat, world, buildMinecraft, MANIFEST, NOW, DAY };
