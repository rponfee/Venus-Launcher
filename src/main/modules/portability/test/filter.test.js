'use strict';
// Que entra y que no en un .venusbackup.
const test = require('node:test');
const assert = require('node:assert/strict');
const filter = require('../filter');

test('secretos, cuentas y programas no viajan, se llamen como se llamen', () => {
  for (const rel of ['config/discord/token.json', 'config/x/api_key.txt', 'config/secrets.toml', 'accounts.json', 'launcher_accounts.json', 'launcher_msa_credentials.bin', 'config/my.key', 'plugins/x/keystore.jks', 'forwarding.secret', 'config/OAuth.cfg', 'mods/.env', 'usercache.json', 'command_history.txt', 'mods/malo.exe', 'config/instalar.bat', 'config/x.ps1', 'mods/nativo.dll', 'run.sh', 'atajo.lnk', 'logs/latest.log', 'x.log.gz', 'hs_err_pid123.log', 'descarga.part', 'Thumbs.db']) {
    assert.equal(filter.neverCarry(rel), true, rel);
  }
  for (const rel of ['mods/sodium.jar', 'mods/secret-rooms-1.0.jar', 'mods/auth-me-2.jar', 'resourcepacks/token-pack.zip', 'config/sodium.json', 'options.txt', 'servers.dat', 'resourcepacks/x.zip', 'config/tokenizer-mod.toml', 'config/authme-config.yml', 'kubejs/server_scripts/recetas.js']) {
    assert.equal(filter.neverCarry(rel), false, rel);
  }
});

test('instancia: ni mundos ni medios (van aparte), ni carpetas internas, ni registros', () => {
  for (const rel of ['venus-instance.json', 'options.txt.venus.bak', 'clip.mp4']) assert.equal(filter.keepInstanceFile(rel), false, rel);
  for (const dir of ['saves', '.venus', 'logs', 'crash-reports', 'natives', 'cache', 'screenshots', 'replay_videos', '.fabric', 'essential', 'webcache2']) assert.equal(filter.keepInstanceFile(dir, true), false, dir);
  for (const rel of ['saves/m/level.dat', '.venus/prepared.json', 'logs/latest.log', 'screenshots/a.png']) assert.equal(filter.keepInstanceFile(rel), false, rel);
  for (const rel of ['mods/a.jar', 'config/a.json', 'options.txt', 'cover.png', 'servers.dat', 'resourcepacks/p.zip', 'shaderpacks/s.zip']) assert.equal(filter.keepInstanceFile(rel), true, rel);
  assert.equal(filter.keepInstanceFile('config', true), true);
});

test('mundo: entero salvo session.lock', () => {
  assert.equal(filter.keepWorldFile('session.lock'), false);
  assert.equal(filter.keepWorldFile('level.dat'), true);
  assert.equal(filter.keepWorldFile('region/r.0.0.mca'), true);
  assert.equal(filter.keepWorldFile('datapacks/x.zip'), true);
  assert.equal(filter.keepWorldFile('region', true), true);
});

test('medios: solo imágenes y videos, en sus carpetas', () => {
  for (const rel of ['screenshots/a.png', 'screenshots/a.jpg', 'replay_videos/c.mp4', 'clips/c.webm', 'clip.mp4']) assert.equal(filter.keepMediaFile(rel), true, rel);
  for (const rel of ['mods/x.png', 'config/x.mp4', 'a.png', 'screenshots/malo.exe', 'screenshots/nota.txt', 'screenshots/token.json']) assert.equal(filter.keepMediaFile(rel), false, rel);
});

test('servidor: sin .jar de la raíz, copias, registros ni librerías; con plugins y mods', () => {
  for (const rel of ['server.jar', 'paper.jar', 'venus-server.json', 'forwarding.secret', 'logs/latest.log', 'backups/a.zip', 'libraries/x.jar', 'versions/1.21/x.jar', 'cache/x', 'usercache.json']) assert.equal(filter.keepServerFile(rel), false, rel);
  for (const rel of ['server.properties', 'world/level.dat', 'plugins/x.jar', 'mods/y.jar', 'ops.json', 'whitelist.json', 'eula.txt']) assert.equal(filter.keepServerFile(rel), true, rel);
});

test('looksLikePath reconoce rutas de cualquier sistema y no se confunde con textos comunes', () => {
  for (const v of ['C:\\Users\\ana\\x.png', 'c:/juegos/a', '\\\\servidor\\x', '/home/ana/x', '/Users/ana', 'file:///C:/a', '~/x', '%APPDATA%\\x', 'mirá C:\\Users\\ana\\y']) assert.equal(filter.looksLikePath(v), true, v);
  for (const v of ['', 'venus', '#ff0000', '/tp', 'https://a.com/x', 'data:image/png;base64,AAA', '1.21.1', 'Mi mundo: 2', null, 3]) assert.equal(filter.looksLikePath(v), false, String(v));
});

test('instanceMeta: nunca java, nada de esta PC y sin campos desconocidos', () => {
  const m = filter.instanceMeta({
    id: 'x',
    dir: 'C:\\Users\\ana\\instancia',
    name: 'Mía',
    mcVersion: '1.21.1',
    loader: 'fabric',
    java: { path: 'C:\\malo.exe', args: '-javaagent:malo.jar' },
    share: { packId: 'p', owner: 'u' },
    mcimport: { dir: 'C:\\Users\\ana\\.minecraft' },
    jvmArgs: '-x',
    memory: { override: true, min: 1024, max: 4096, extra: 'x' },
    window: { override: false, width: 800, height: 600, fullscreen: false },
    modrinth: { projects: { AANobbMI: { file: 'mods/sodium.jar', versionId: 'v' }, malo: { file: '../../afuera.jar' } }, pack: null },
    cover: 'cover.png',
    tags: ['Amigos', 3],
    notes: { text: 'hola', tasks: [] },
    favorite: true,
    nuevo: 'lo que sea',
  });
  const text = JSON.stringify(m);
  for (const bad of ['java', 'javaagent', 'C:\\', 'malo', 'share', 'mcimport', '"dir"', '"id"', 'nuevo', 'extra']) assert.ok(!text.includes(bad), bad);
  assert.equal(m.name, 'Mía');
  assert.equal(m.memory.max, 4096);
  assert.deepEqual(Object.keys(m.modrinth.projects), ['AANobbMI']);
  assert.deepEqual(m.tags, ['Amigos']);
  assert.equal(filter.instanceMeta({ cover: '../../x.png' }).cover, null);
  assert.equal(filter.instanceMeta({ icon: 'file:///C:/x.png' }).icon, null);
  assert.equal(filter.instanceMeta({ name: 'C:\\Users\\ana' }).name, '');
});

test('serverMeta: sin Java, flags, automatizaciones ni el comando de arranque', () => {
  const m = filter.serverMeta({ id: 'x', dir: 'C:\\x', name: 'S', type: 'paper', mcVersion: '1.21', port: 25570, java: { path: 'C:\\malo.exe', args: '-x' }, flags: 'aikar', automation: { autostart: true }, launch: { args: ['-javaagent:malo.jar'] }, installed: true, mirror: 'https://malo', memory: { min: 1024, max: 2048 } });
  const text = JSON.stringify(m);
  for (const bad of ['java', 'malo', 'automation', 'launch', 'installed', 'mirror', 'flags']) assert.ok(!text.includes(bad), bad);
  assert.equal(m.port, 25570);
  assert.equal(filter.serverMeta({ port: 99999 }).port, 25565);
  assert.equal(filter.serverMeta({ type: '../x' }).type, '');
});

test('cleanSettings: lista blanca y sin rutas', () => {
  const raw = {
    onboarded: true,
    language: 'es',
    jvmArgs: '-javaagent:malo.jar',
    memory: { max: 8192 },
    privacy: { autoUpdates: true, decided: true },
    analysis: { launchSecurity: false },
    assistantMcp: { servers: [{ command: 'malo.exe' }] },
    mcp: { port: 1234 },
    ai: { enabled: true },
    voice: { inputDevice: 'x' },
    discord: { enabled: true },
    selectedInstance: 'x',
    appearance: { accent: 'mars', background: 'image', bgFile: 'C:\\Users\\ana\\fondo.png', lite: true, seasonalBackup: { accent: 'x' }, music: { enabled: true, file: 'C:\\Users\\ana\\tema.mp3', volume: 30 } },
    looks: [{ id: 'l', name: 'L', appearance: { bgFile: 'C:\\Users\\ana\\y.png', background: 'image', accent: 'venus' }, branding: { logo: 'data:image/png;base64,AA' } }],
    capture: { copyTo: 'D:\\clips', fps: 30 },
    decor: { particles: 'snow', cursor: 'pixel' },
    nav: { order: ['home'], iconPack: 'pixel' },
    backups: { schedule: { enabled: true, instances: ['a'], keep: 3 } },
    ingame: { pack: true, window: false, badge: true, badgeEnrolled: true },
  };
  const c = filter.cleanSettings(raw);
  const text = JSON.stringify(c);
  for (const bad of ['javaagent', 'privacy', 'analysis', 'assistantMcp', 'malo', 'selectedInstance', 'onboarded', 'discord', 'inputDevice', 'C:\\', 'D:\\', 'seasonalBackup', 'lite', 'badge']) assert.ok(!text.includes(bad), bad);
  assert.equal(c.appearance.accent, 'mars');
  assert.equal(c.appearance.background, 'stars');
  assert.equal(c.appearance.music.enabled, false);
  assert.equal(c.looks[0].appearance.background, 'stars');
  assert.equal(c.looks[0].branding.logo, 'data:image/png;base64,AA');
  assert.equal(c.capture.fps, 30);
  assert.equal(c.backups.schedule.instances, 'all');
  assert.deepEqual(filter.cleanSettings(null), {});
});

test('redactSecrets: contraseñas y tokens se van, el resto queda igual', () => {
  const props = Buffer.from('rcon.password=hola123\nmotd=Mi server\nenable-rcon=false\nmax-players=10\n');
  const out = filter.redactSecrets('server.properties', props).toString();
  assert.ok(!out.includes('hola123'));
  assert.ok(out.includes('motd=Mi server'));
  assert.ok(out.includes('rcon.password='));
  const yml = Buffer.from('velocity:\n  enabled: true\n  secret: abc123\nBotToken: "tkn"\nmax-tokens: 5\nallow-token: true\n');
  const y = filter.redactSecrets('config/paper-global.yml', yml).toString();
  assert.ok(!y.includes('abc123') && !y.includes('tkn'));
  assert.ok(y.includes('max-tokens: 5') && y.includes('allow-token: true'));
  const json = filter.redactSecrets('config/x.json', Buffer.from('{ "apiKey": "k1", "token" : "k2", "name": "ok" }')).toString();
  assert.ok(!json.includes('k1') && !json.includes('k2') && json.includes('"name": "ok"'));
  JSON.parse(json);
  const plain = Buffer.from('nada para ver');
  assert.equal(filter.redactSecrets('config/x.toml', plain), plain, 'sin cambios devuelve el mismo buffer');
  const bin = Buffer.from('password: x');
  assert.equal(filter.redactSecrets('mods/a.jar', bin), bin, 'solo texto de configuración');
});

test('scrubText: las rutas de esta PC se van de las configuraciones', () => {
  const roots = ['C:\\Users\\ana\\AppData\\Roaming\\.venuslauncher', 'C:\\Users\\ana'];
  const out = filter.scrubText('config/a.json', Buffer.from('{"p":"C:\\\\Users\\\\ana\\\\x.png","q":"C:/Users/ana/AppData/Roaming/.venuslauncher/y"}'), roots).toString();
  assert.ok(!/ana/.test(out), out);
  const same = Buffer.from('sin rutas');
  assert.equal(filter.scrubText('config/a.json', same, roots), same);
  const bin = Buffer.from('C:\\Users\\ana');
  assert.equal(filter.scrubText('mods/a.jar', bin, roots), bin);
});
