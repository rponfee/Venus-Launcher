'use strict';
// Comando del ayudante (sin abrir nada) y coherencia entre el script y el protocolo.
// Prueba con el ayudante real (solo Windows, solo lee): VENUS_NP_LIVE=1 node --test ".../test/script.test.js"
const test = require('node:test');
const assert = require('node:assert/strict');
const { command, powershellPath, SCRIPT, CSHARP, ART_MAX_CHARS } = require('../script');
const { COMMANDS, MAX_ART_CHARS, parseLine, createLineSplitter } = require('../protocol');

test('command: PowerShell oculto, sin perfil, con el script y el C# en el entorno', () => {
  const cmd = command({ parentPid: 1234, env: { PATH: 'x', SystemRoot: 'C:\\Windows' }, exists: () => true });
  assert.equal(cmd.file, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.deepEqual(cmd.args.slice(0, -1), ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command']);
  assert.equal(cmd.args[cmd.args.length - 1], SCRIPT);
  assert.equal(cmd.env.PATH, 'x');
  assert.equal(cmd.env.VENUS_PARENT_PID, '1234');
  assert.equal(cmd.env.VENUS_NP_CS, CSHARP);
  assert.equal(cmd.env.VENUS_NP_ART_MAX, String(ART_MAX_CHARS));
  assert.ok(!cmd.args.includes('-ExecutionPolicy'), 'no hace falta para -Command');
});

test('powershellPath: ruta completa de System32 y, si no está, el del PATH', () => {
  assert.equal(powershellPath({ windir: 'D:\\Win' }, () => true), 'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.equal(powershellPath({ SystemRoot: 'C:\\Windows' }, () => false), 'powershell.exe');
  assert.equal(powershellPath({}, () => true), 'powershell.exe');
});

test('el script entra holgado en la línea de comandos y no tiene secuencias problemáticas', () => {
  assert.ok(SCRIPT.length < 24000, `largo ${SCRIPT.length}`);
  assert.ok(CSHARP.length < 30000, 'una variable de entorno admite hasta 32767 caracteres');
  assert.ok(!SCRIPT.includes('\\"'), 'sin barra invertida seguida de comillas');
  assert.ok(!SCRIPT.includes('Write-Host'), 'Write-Host ensuciaría stdout');
  assert.ok(!SCRIPT.includes('Invoke-Expression') && !/\biex\b/i.test(SCRIPT), 'sin iex');
});

test('el script entiende todos los comandos del protocolo y respeta el límite de la portada', () => {
  for (const cmd of COMMANDS) assert.ok(SCRIPT.includes(`'${cmd}'`), cmd);
  for (const t of ['ready', 'sessions', 'art', 'audio', 'result', 'log']) assert.ok(SCRIPT.includes(`t = '${t}'`), t);
  assert.equal(ART_MAX_CHARS, MAX_ART_CHARS);
});

test('ayudante real: arranca, lee las sesiones y se cierra (solo lectura)', { skip: process.platform !== 'win32' || !process.env.VENUS_NP_LIVE, timeout: 30000 }, async () => {
  const { spawn } = require('child_process');
  const cmd = command();
  const child = spawn(cmd.file, cmd.args, { env: cmd.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const split = createLineSplitter();
  const msgs = [];
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('sin respuesta del ayudante')), 25000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      for (const line of split(chunk)) {
        const m = parseLine(line);
        if (!m) continue;
        msgs.push(m);
        if (m.t === 'ready' && !m.smtc) {
          clearTimeout(timer);
          resolve();
        }
        if (m.t === 'sessions') {
          clearTimeout(timer);
          resolve();
        }
      }
    });
    child.on('error', reject);
  });
  child.stdin.write('{"cmd":"quit"}\n');
  const code = await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(msgs[0].t, 'ready');
  assert.equal(code === 0 || code === 3, true, `salida ${code}`);
});
