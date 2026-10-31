'use strict';
// CLI falso para las pruebas de assistant/engines.js: imita la salida de `claude -p --output-format stream-json` o de
// `codex exec --json` segun VENUS_FAKE_CLI (escenario). Lee el prompt por stdin y lo devuelve en el texto para que la
// prueba compruebe que llego. Guarda los argumentos recibidos en VENUS_FAKE_CLI_ARGS_FILE (JSON) si esta definido.
const fs = require('fs');

const scenario = process.env.VENUS_FAKE_CLI || 'claude-ok';
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (stdin += d));
process.stdin.on('end', () => run());
// Si nadie escribe en stdin, arranca igual
setTimeout(() => {
  if (!stdin && scenario !== 'hang') run();
}, 1500).unref();

let ran = false;
function run() {
  if (ran) return;
  ran = true;
  if (process.env.VENUS_FAKE_CLI_ARGS_FILE) fs.writeFileSync(process.env.VENUS_FAKE_CLI_ARGS_FILE, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), stdin, env: { MCP_TOOL_TIMEOUT: process.env.MCP_TOOL_TIMEOUT || null, CLAUDECODE: process.env.CLAUDECODE || null } }));
  const sid = '11111111-2222-4333-8444-555555555555';
  switch (scenario) {
    case 'claude-ok':
      out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-fake', tools: [], mcp_servers: [{ name: 'venus-launcher', status: 'connected' }] });
      out({ type: 'assistant', message: { model: 'claude-fake', content: [{ type: 'tool_use', id: 'toolu_1', name: 'mcp__venus-launcher__list_instances', input: {} }] }, session_id: sid });
      out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: JSON.stringify({ ok: true, instances: [{ id: 'test-pack' }] }) }] }] }, session_id: sid });
      out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.08, resetsAt: 1793210400 }, seven_day: { utilization: 0.85, resetsAt: 1793455200 } } } });
      out({ type: 'assistant', message: { model: 'claude-fake', content: [{ type: 'text', text: `Tenés 1 instancia. [prompt:${stdin.length}]` }] }, session_id: sid });
      // La linea final de resultado no siempre trae "type" primero
      out({ duration_api_ms: 10, stop_reason: 'end_turn', type: 'result', subtype: 'success', is_error: false, result: 'Tenés 1 instancia.', session_id: sid, total_cost_usd: 0.001, num_turns: 2, usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5 } });
      break;
    case 'claude-login':
      process.stderr.write('Not logged in · Please run /login\n');
      out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Not logged in · Please run /login', session_id: sid, total_cost_usd: 0, usage: null });
      process.exitCode = 1;
      break;
    case 'claude-mcp-down':
      out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-fake', tools: [], mcp_servers: [{ name: 'venus-launcher', status: 'failed' }] });
      out({ type: 'assistant', message: { model: 'claude-fake', content: [{ type: 'text', text: 'Sin herramientas.' }] }, session_id: sid });
      out({ type: 'result', subtype: 'success', is_error: false, result: 'Sin herramientas.', session_id: sid, total_cost_usd: 0.001, usage: { input_tokens: 1, output_tokens: 1 } });
      break;
    case 'codex-ok':
      process.stderr.write('Reading additional input from stdin...\n');
      out({ type: 'thread.started', thread_id: 'thread-abc' });
      out({ type: 'turn.started' });
      out({ type: 'item.started', item: { id: 'item_0', type: 'mcp_tool_call', server: 'venus-launcher', tool: 'list_instances', arguments: {}, status: 'in_progress' } });
      out({ type: 'item.completed', item: { id: 'item_0', type: 'mcp_tool_call', server: 'venus-launcher', tool: 'list_instances', arguments: {}, status: 'completed', result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, instances: [] }) }] } } });
      out({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: `OK [prompt:${stdin.length}]` } });
      out({ type: 'turn.completed', usage: { input_tokens: 500, cached_input_tokens: 100, output_tokens: 7 } });
      break;
    case 'codex-fail':
      out({ type: 'thread.started', thread_id: 'thread-x' });
      out({ type: 'turn.started' });
      out({ type: 'error', message: 'You have hit your usage limit. Try again in 2 hours.' });
      out({ type: 'turn.failed', error: { message: 'usage limit' } });
      process.exitCode = 1;
      break;
    case 'hang':
      setTimeout(() => process.exit(0), 20000);
      return;
    default:
      process.stderr.write(`escenario desconocido: ${scenario}\n`);
      process.exitCode = 2;
  }
}
