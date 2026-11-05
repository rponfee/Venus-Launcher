'use strict';
// CLI falso para las pruebas de smartsearch/local-ai.js: imita la salida de `claude -p --output-format stream-json`
// y de `codex exec --json` segun VENUS_FAKE_SEARCH (escenario). Lee el prompt por stdin y guarda los argumentos y el
// prompt recibidos en VENUS_FAKE_SEARCH_FILE (JSON) para que la prueba compruebe que no lleva herramientas.
const fs = require('fs');

const scenario = process.env.VENUS_FAKE_SEARCH || 'claude-ok';
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const PLAN = { types: ['mod', 'shader'], mcVersion: '1.20.1', loader: 'fabric', mode: 'singleplayer', themes: ['zombie apocalypse'], hardware: 'normal', searches: [{ type: 'mod', query: 'zombie', categories: ['mobs'], weight: 1 }], summary: 'Kit de zombis' };

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (stdin += d));
process.stdin.on('end', () => run());
setTimeout(() => {
  if (!stdin && scenario !== 'hang') run();
}, 1500).unref();

let ran = false;
function run() {
  if (ran) return;
  ran = true;
  if (process.env.VENUS_FAKE_SEARCH_FILE) fs.writeFileSync(process.env.VENUS_FAKE_SEARCH_FILE, JSON.stringify({ args: process.argv.slice(2), prompt: stdin, cwd: process.cwd() }));
  const text = JSON.stringify(PLAN);
  switch (scenario) {
    case 'claude-ok':
      out({ type: 'system', subtype: 'init', session_id: 's1', model: 'claude-fake', tools: [], mcp_servers: [] });
      out({ type: 'assistant', message: { model: 'claude-fake', content: [{ type: 'text', text: 'Listo:\n```json\n' + text + '\n```' }] }, session_id: 's1' });
      out({ type: 'result', subtype: 'success', is_error: false, result: 'Listo:\n```json\n' + text + '\n```', session_id: 's1', total_cost_usd: 0 });
      break;
    case 'codex-ok':
      out({ type: 'thread.started', thread_id: 't1' });
      out({ type: 'item.completed', item: { id: 'i0', type: 'agent_message', text } });
      out({ type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 5 } });
      break;
    case 'claude-login':
      process.stderr.write('Not logged in · Please run /login\n');
      out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Not logged in · Please run /login', session_id: 's1', total_cost_usd: 0 });
      process.exitCode = 1;
      break;
    case 'claude-limit':
      out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Claude usage limit reached', session_id: 's1', total_cost_usd: 0 });
      process.exitCode = 1;
      break;
    case 'bad-json':
      out({ type: 'assistant', message: { content: [{ type: 'text', text: 'No pude armar un plan, perdón.' }] } });
      out({ type: 'result', subtype: 'success', is_error: false, result: 'No pude armar un plan, perdón.', session_id: 's1' });
      break;
    case 'hang':
      setInterval(() => {}, 1000);
      break;
    default:
      process.exitCode = 2;
  }
}
