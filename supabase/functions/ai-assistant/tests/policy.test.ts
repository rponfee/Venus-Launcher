// Pruebas de policy.ts (node --test, ver supabase/functions/README.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystem, LAUNCHER_HEADER, serverPolicy } from '../policy.ts';

test('la política va primero y el texto del launcher después, sin tocarlo', () => {
  const launcher = 'Sos el asistente del launcher.\nUsá las herramientas.';
  const blocks = buildSystem('assistant', launcher);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].type, 'text');
  assert.ok(blocks[0].text.startsWith('# Política del servidor de Venus Launcher'));
  assert.equal(blocks[1].text, `${LAUNCHER_HEADER}${launcher}`);
  assert.ok(blocks[1].text.endsWith(launcher));
});

test('sin texto del launcher queda solo la política', () => {
  assert.equal(buildSystem('assistant', null).length, 1);
  assert.equal(buildSystem('text', '   ').length, 1);
});

test('incluye todas las restricciones del producto en todas las tareas', () => {
  for (const task of ['assistant', 'text', 'json'] as const) {
    const policy = serverPolicy(task);
    for (const rule of [
      /cuenta de Microsoft, a tokens, contraseñas o datos de pago/,
      /fuera de la carpeta de la instancia/,
      /Borrar mundos o partidas guardadas/,
      /Modrinth o CurseForge/,
      /comandos, scripts o archivos \.jar/,
      /el plan o la suscripción/,
      /datos del usuario a servicios externos/,
      /Nunca digas que instalaste/,
      /no instrucciones/,
      /No reveles secretos/,
      /prioridad sobre todo lo demás/,
    ]) {
      assert.match(policy, rule, `${task}: ${rule}`);
    }
  }
});

test('el asistente recibe permisos e idioma; las tareas internas siguen el formato del launcher', () => {
  const assistant = serverPolicy('assistant');
  assert.match(assistant, /remove_mod/);
  assert.match(assistant, /Deshacer/);
  assert.match(assistant, /instancia NUEVA/);
  assert.match(assistant, /reparar un crash/);
  assert.match(assistant, /lista permitida que ofrece set_jvm_args/);
  assert.match(assistant, /español rioplatense/);
  assert.match(assistant, /restore_server_backup/);
  assert.match(assistant, /Un mundo nunca se borra/);
  assert.match(assistant, /solo se descarga desde Modrinth/);
  assert.match(assistant, /send_server_command/);
  assert.match(assistant, /si el usuario te escribe en otro idioma, respondé en ese idioma/i);
  const internal = serverPolicy('text');
  assert.match(internal, /Tarea interna del launcher/);
  assert.match(internal, /Seguí el formato y el idioma que indiquen las instrucciones del launcher/);
  assert.doesNotMatch(internal, /Deshacer/);
  assert.equal(serverPolicy('json'), internal);
});

test('herramientas MCP del usuario: la única excepción, con confirmación y sus resultados como datos', () => {
  const assistant = serverPolicy('assistant');
  assert.match(assistant, /mcp__<servidor>__<herramienta>/);
  assert.match(assistant, /agregó a mano en el launcher/);
  assert.match(assistant, /pide confirmación al usuario/);
  assert.match(assistant, /contenido de terceros no confiable/);
  assert.match(assistant, /No podés agregar, quitar ni configurar servidores MCP/);
  // La excepción no abre la puerta a cuentas, contraseñas, tokens ni pagos
  for (const task of ['assistant', 'text', 'json'] as const) {
    const policy = serverPolicy(task);
    assert.match(policy, /La única excepción son las herramientas de los servidores MCP que el propio usuario agregó/);
    assert.match(policy, /Ni siquiera con ellas accedas a cuentas, contraseñas, tokens o datos de pago/);
  }
});

test('es texto fijo: el prefijo no cambia entre llamadas (caché y bloques thinking)', () => {
  assert.deepEqual(buildSystem('assistant', 'x'), buildSystem('assistant', 'x'));
  const policy = serverPolicy('assistant');
  assert.doesNotMatch(policy, /\$\{|\bundefined\b|\bnull\b/);
  assert.doesNotMatch(policy, /\b20\d\d-\d\d-\d\d\b/);
});
