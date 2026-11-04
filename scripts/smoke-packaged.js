'use strict';
// Prueba de humo de la app empaquetada: comprueba los fuses y abre el .exe de verdad, con una carpeta de datos temporal
// (no toca los datos ni el launcher instalado). Lo corre el workflow Build en windows-latest después de compilar.
//   node scripts/smoke-packaged.js [ruta al .exe] [--tamper]
// Con --tamper, además copia la app, le cambia un byte al app.asar y comprueba que se niegue a arrancar. Sirve para probar
// la validación de integridad.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const TAMPER = args.includes('--tamper');
const EXE = path.resolve(args.find((a) => !a.startsWith('--')) || path.join(__dirname, '..', 'dist', 'win-unpacked', 'Venus Launcher.exe'));
const START_TIMEOUT = 90000;
const SETTLE_MS = 6000;
const LOAD_ERROR = /SyntaxError|ReferenceError|Failed to fetch dynamically imported module|Failed to load module|Cannot find module|ERR_FILE_NOT_FOUND/i;

const problems = [];
const check = (ok, text) => {
  console.log(`${ok ? 'ok ' : 'MAL'} ${text}`);
  if (!ok) problems.push(text);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

function killTree(pid) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* ya terminó */
    }
  }
}

async function checkFuses() {
  const { getCurrentFuseWire, FuseV1Options } = require('@electron/fuses');
  const wire = await getCurrentFuseWire(EXE);
  const on = (fuse) => wire[fuse] === 49; // FuseState.ENABLE ('1')
  // RunAsNode sigue prendido a propósito: el puente MCP corre con ELECTRON_RUN_AS_NODE (modules/mcp.js).
  check(on(FuseV1Options.RunAsNode), 'fuse RunAsNode prendido (lo usa el puente MCP)');
  check(!on(FuseV1Options.EnableNodeOptionsEnvironmentVariable), 'fuse NODE_OPTIONS apagado');
  check(!on(FuseV1Options.EnableNodeCliInspectArguments), 'fuse --inspect apagado');
  check(on(FuseV1Options.EnableEmbeddedAsarIntegrityValidation), 'fuse de integridad del asar prendido');
  check(on(FuseV1Options.OnlyLoadAppFromAsar), 'fuse OnlyLoadAppFromAsar prendido');
}

function checkRunAsNode() {
  const r = spawnSync(EXE, ['-e', 'process.stdout.write(process.versions.electron)'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 30000 });
  check(/^\d+\.\d+\.\d+/.test(r.stdout || ''), `ELECTRON_RUN_AS_NODE responde (Electron ${(r.stdout || '?').trim()})`);
}

// Espera la página de la app y evalúa lo básico por el protocolo de depuración.
async function checkApp(exe, tmp) {
  const port = await freePort();
  const child = spawn(exe, [`--remote-debugging-port=${port}`, `--user-data-dir=${path.join(tmp, 'user-data')}`], {
    env: { ...process.env, VENUS_DATA_DIR: path.join(tmp, 'venus-data'), VENUS_SMOKE_TEST: '1' },
    stdio: 'ignore',
    windowsHide: true,
  });
  let exited = null;
  child.once('exit', (code) => (exited = code ?? -1));
  try {
    const deadline = Date.now() + START_TIMEOUT;
    let page = null;
    while (!page && Date.now() < deadline && exited === null) {
      await wait(500);
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
      } catch {
        /* todavía no escucha */
      }
    }
    check(exited === null, 'la app sigue abierta después de arrancar');
    check(Boolean(page), 'cargó index.html');
    if (!page) return;

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });
    let id = 0;
    const pending = new Map();
    const errors = [];
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id && pending.has(d.id)) {
        pending.get(d.id)(d);
        pending.delete(d.id);
      } else if (d.method === 'Runtime.exceptionThrown') {
        errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
      } else if (d.method === 'Log.entryAdded' && d.params.entry.level === 'error' && /^file:/.test(d.params.entry.url || '')) {
        errors.push(`${d.params.entry.text} ${d.params.entry.url}`);
      }
    };
    const send = (method, params = {}) =>
      new Promise((resolve) => {
        const n = ++id;
        pending.set(n, resolve);
        ws.send(JSON.stringify({ id: n, method, params }));
      });
    const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
    await send('Runtime.enable');
    await send('Log.enable');
    await send('Page.enable');
    await send('Page.reload');
    // Un runner de GitHub puede tardar bastante más que una PC: se espera a que aparezca la interfaz.
    const uiDeadline = Date.now() + START_TIMEOUT;
    let rendered = 0;
    while (rendered <= 20 && Date.now() < uiDeadline) {
      await wait(1000);
      rendered = (await evaluate(`document.body ? document.body.innerText.trim().length : 0`)) || 0;
    }
    await wait(SETTLE_MS);

    check((await evaluate(`Boolean(document.querySelector('.sidebar') && document.querySelector('.brand'))`)) === true, 'se ve la interfaz');
    check(rendered > 20, `la página tiene contenido (${rendered} caracteres)`);
    const version = await evaluate(`window.venus.invoke('updater:status').then((s) => s.currentVersion)`);
    const expected = require(path.join(__dirname, '..', 'package.json')).version;
    check(version === expected, `el proceso principal responde (versión ${version})`);
    const videos = await evaluate(`window.venus.invoke('wallpapers:status').then((s) => Object.values(s).filter((v) => !v.path).length + '/' + Object.keys(s).length)`);
    check(videos === '16/16', `los fondos animados no vienen en el paquete (${videos} sin bajar)`);
    // Un archivo o módulo que no carga es un paquete roto. Lo demás puede depender de la máquina (sin audio, por ejemplo): se avisa.
    const broken = errors.filter((e) => LOAD_ERROR.test(e));
    check(broken.length === 0, `sin errores de carga${broken.length ? `: ${broken.slice(0, 3).join(' | ').slice(0, 600)}` : ''}`);
    for (const e of errors.filter((x) => !LOAD_ERROR.test(x)).slice(0, 5)) {
      console.log(`${process.env.GITHUB_ACTIONS ? '::warning title=Prueba de la app empaquetada::' : 'aviso: '}${String(e).slice(0, 300).replace(/\s+/g, ' ')}`);
    }
    ws.close();
  } finally {
    if (exited === null) killTree(child.pid);
  }
}

// Abre un .exe un momento y dice si llegó a cargar la página de la app.
async function loads(exe, tmp, name) {
  const port = await freePort();
  const child = spawn(exe, [`--remote-debugging-port=${port}`, `--user-data-dir=${path.join(tmp, `user-data-${name}`)}`], {
    env: { ...process.env, VENUS_DATA_DIR: path.join(tmp, `venus-data-${name}`), VENUS_SMOKE_TEST: '1' },
    stdio: 'ignore',
    windowsHide: true,
  });
  let exited = null;
  child.once('exit', (code) => (exited = code ?? -1));
  let loaded = false;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && exited === null && !loaded) {
    await wait(500);
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      loaded = list.some((t) => t.type === 'page' && /index\.html/.test(t.url));
    } catch {
      /* no escucha */
    }
  }
  if (exited === null) killTree(child.pid);
  await wait(1500);
  return { loaded, exited };
}

// La copia sin tocar tiene que abrir (control) y, con un solo byte cambiado adentro de un comentario de main.js (el
// código sigue siendo válido: solo la validación de integridad lo puede notar), no.
async function checkTamper(tmp) {
  const asar = require('@electron/asar');
  const copy = path.join(tmp, 'tamper');
  fs.cpSync(path.dirname(EXE), copy, { recursive: true });
  const exe = path.join(copy, path.basename(EXE));
  const archive = path.join(copy, 'resources', 'app.asar');

  const control = await loads(exe, tmp, 'control');
  check(control.loaded, 'la copia sin modificar abre (control)');

  const inside = path.join('src', 'main', 'main.js');
  const source = asar.extractFile(archive, inside);
  const comment = source.indexOf('//');
  const stat = asar.statFile(archive, inside, false);
  const { headerSize } = asar.getRawHeader(archive);
  const at = 8 + headerSize + Number(stat.offset) + comment + 4;
  const fd = fs.openSync(archive, 'r+');
  const before = Buffer.alloc(1);
  fs.readSync(fd, before, 0, 1, at);
  if (before[0] !== source[comment + 4]) throw new Error('la posición calculada dentro del asar no coincide');
  fs.writeSync(fd, Buffer.from([before[0] === 0x61 ? 0x62 : 0x61]), 0, 1, at);
  fs.closeSync(fd);
  asar.uncache?.(archive);

  const tampered = await loads(exe, tmp, 'tamper');
  check(!tampered.loaded, `con un byte cambiado en el asar no abre${tampered.exited !== null ? ` (terminó con código ${tampered.exited})` : ''}`);
}

async function main() {
  if (!fs.existsSync(EXE)) {
    console.error(`No está ${EXE}: compilá primero (npm run dist:dir).`);
    process.exit(1);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'venus-smoke-'));
  try {
    await checkFuses();
    checkRunAsNode();
    await checkApp(EXE, tmp);
    if (TAMPER) await checkTamper(tmp);
  } finally {
    await wait(1500); // que suelte los archivos antes de borrar
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    } catch {
      /* es una carpeta temporal: no vale frenar la prueba por esto */
    }
  }
  if (problems.length) {
    for (const p of problems) if (process.env.GITHUB_ACTIONS) console.error(`::error title=Prueba de la app empaquetada::${p}`);
    console.error(`${problems.length} problemas.`);
    process.exit(1);
  }
  console.log('La app empaquetada arranca bien.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
