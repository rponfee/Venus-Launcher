'use strict';
// Chequeo del equipo: rastros de la etapa 2 de Fractureiser y de SkyRage (solo lectura).
// Rutas tomadas de la investigación pública (docs/users.md y docs/tech.md de fractureiser-investigation).
//  Windows: %LOCALAPPDATA%\Microsoft Edge (con espacio; la carpeta legítima es Microsoft\Edge),
//           archivos en la carpeta Inicio, clave Run del registro, tarea MicrosoftEdgeUpdateTaskMachineVM y
//           %AppData%\..\LocalLow\Microsoft\Internet Explorer\DOMStore\microsoft-vm-core
//  Linux:   ~/.config/.data/lib.jar, systemd-utility.service, /bin/vmd-gnu y vmd-gnu.service
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const STAGE2_FILES = ['libWebGL64.jar', 'lib.jar', '.ref', 'client.jar', 'lib.dll', 'run.bat'];

async function statSafe(p) {
  try {
    return await fsp.stat(p);
  } catch {
    return null;
  }
}

function run(cmd, args, timeout = 4000) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout, windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024 }, (err, stdout) => {
        resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(stdout || '') });
      });
    } catch {
      resolve({ code: 1, out: '' });
    }
  });
}

/**
 * check({ platform, home, env, registry }) -> { checked, platform, findings: [{ rule, severity, confirmed, evidence }] }
 * registry: false evita consultar el registro y el programador de tareas (pruebas).
 */
async function check(opts = {}) {
  // Desarrollo/pruebas: VENUS_ANALYSIS_FAKE_HOME apunta a una carpeta falsa y evita registro y tareas.
  const fake = process.env.VENUS_ANALYSIS_FAKE_HOME;
  if (fake && !opts.home) {
    opts = { ...opts, home: fake, env: { LOCALAPPDATA: path.join(fake, 'AppData', 'Local'), APPDATA: path.join(fake, 'AppData', 'Roaming') }, registry: false, root: fake };
  }
  const platform = opts.platform || process.platform;
  const home = opts.home || os.homedir();
  const env = opts.env || process.env;
  const findings = [];
  const add = (rule, confirmed, where, value) => {
    let f = findings.find((x) => x.rule === rule);
    if (!f) {
      f = { rule, severity: 'critical', confirmed: false, evidence: [] };
      findings.push(f);
    }
    if (confirmed) f.confirmed = true;
    if (f.evidence.length < 6) f.evidence.push({ where, value });
  };

  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const roaming = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const edge = path.join(local, 'Microsoft Edge');
    const st = await statSafe(edge);
    if (st?.isDirectory()) {
      const inside = await fsp.readdir(edge).catch(() => []);
      const hits = inside.filter((n) => STAGE2_FILES.some((f) => f.toLowerCase() === n.toLowerCase()));
      add('system-fractureiser', hits.length > 0, edge, hits.length ? hits.join(', ') : 'Microsoft Edge');
    }
    const startup = path.join(roaming, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
    for (const name of await fsp.readdir(startup).catch(() => [])) {
      const lower = name.toLowerCase();
      if (['libwebgl64.jar', 'client.jar', 'lib.dll', '.ref'].includes(lower)) add('system-fractureiser', true, startup, name);
      else if (lower === 'run.bat') {
        const text = await fsp.readFile(path.join(startup, name), 'utf8').catch(() => '');
        if (/libwebgl64|microsoft edge/i.test(text)) add('system-fractureiser', true, startup, name);
      }
    }
    const domstore = path.join(roaming, '..', 'LocalLow', 'Microsoft', 'Internet Explorer', 'DOMStore', 'microsoft-vm-core');
    if (await statSafe(domstore)) add('system-skyrage', true, path.normalize(domstore), 'microsoft-vm-core');
    if (opts.registry !== false) {
      const reg = await run('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run']);
      for (const line of reg.out.split(/\r?\n/)) {
        if (/libwebgl64|\\microsoft edge\\.*\.jar/i.test(line)) add('system-fractureiser', true, 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', line.trim().slice(0, 200));
      }
      const task = await run('schtasks', ['/query', '/tn', 'MicrosoftEdgeUpdateTaskMachineVM']);
      if (task.code === 0 && /MicrosoftEdgeUpdateTaskMachineVM/i.test(task.out)) add('system-skyrage', true, 'schtasks', 'MicrosoftEdgeUpdateTaskMachineVM');
    }
  } else if (platform === 'linux') {
    const sys = (p) => (opts.root ? path.join(opts.root, p) : p); // raiz falsa para pruebas
    const checks = [
      ['system-fractureiser', path.join(home, '.config', '.data', 'lib.jar')],
      ['system-fractureiser', path.join(home, '.config', 'systemd', 'user', 'systemd-utility.service')],
      ['system-fractureiser', sys('/etc/systemd/system/systemd-utility.service')],
      ['system-skyrage', sys('/bin/vmd-gnu')],
      ['system-skyrage', sys('/etc/systemd/system/vmd-gnu.service')],
    ];
    for (const [rule, p] of checks) if (await statSafe(p)) add(rule, true, p, path.basename(p));
  }
  return { checked: true, platform, at: Date.now(), findings };
}

module.exports = { check };
