// MCP de solo lectura para el asistente de soporte. Se llama desde OpenAI con
// la clave pública del proyecto; nunca recibe el JWT del usuario ni claves privadas.

const anon = Deno.env.get('SUPABASE_ANON_KEY') || '';
const HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
const TOPICS: Record<string, string> = {
  instances: 'Instances have their own Minecraft files and mods. Instance Groups share the saved server list and keybind configuration by default. Changes made in the launcher propagate to idle instances; in-game keybind changes propagate when that game session ends.',
  servers: 'Use the Servers section to save and manage Minecraft server addresses. A saved server is copied to every instance in the default Instance Group. A server may still require the matching Minecraft version, mod loader, mods and an account allowed by that server.',
  skins: 'Use Skins to select, edit or create a skin. Venus AI skin creation requires an active Venus AI plan and counts against that plan’s API usage allowance. Do not promise that a generated skin will match a prompt exactly.',
  ai: 'Venus IA uses OpenAI through the Venus backend. The API key is configured by an administrator in Administration > Integrations and is kept in server-side Vault. Basic, Go, Pro and Max use the same GPT-6 Luna model with different reasoning and response token limits. The monthly USD allowance of each plan still applies.',
  account: 'The launcher account and the Microsoft/Minecraft account serve different purposes. For sign-in issues, ask which account and which screen shows the error. Never request passwords, API keys, payment card numbers or full authentication tokens.',
  billing: 'Venus IA plans and payment history are available from Plans and Support. Payment activation depends on the configured payment provider. The assistant cannot verify an individual payment; ask the user to open a human support ticket with a payment reference, never full card details.',
  worlds: 'Worlds lists local Minecraft worlds. Captures and clips have their own separate section and no longer appear inside a world detail. Make a backup before modifying a world or changing its Minecraft version.',
  troubleshoot: 'When troubleshooting, ask for the launcher version, Windows version, Minecraft version, instance name, mod loader, exact error text and whether the issue reproduces in a clean instance. Never ask the user to share secrets or private tokens.',
};
const TOOLS = [{ name: 'venus_help', description: 'Read verified Venus Launcher support facts for one topic before answering a user. Returns English facts that may be translated into the user’s language.', inputSchema: { type: 'object', properties: { topic: { type: 'string', enum: Object.keys(TOPICS) } }, required: ['topic'], additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false } }];

function json(status: number, body: unknown) { return new Response(JSON.stringify(body), { status, headers: HEADERS }); }
function result(id: unknown, value: unknown) { return json(200, { jsonrpc: '2.0', id, result: value }); }
function error(id: unknown, code: number, message: string) { return json(200, { jsonrpc: '2.0', id, error: { code, message } }); }

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'method' });
  if (!anon) return json(503, { error: 'unavailable' });
  const token = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') || '')?.[1];
  if (token !== anon) return json(401, { error: 'auth' });
  const raw = await req.text();
  if (raw.length > 4096) return json(413, { error: 'size' });
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw); } catch { return json(400, { error: 'input' }); }
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string') return json(400, { error: 'input' });
  const id = body.id;
  if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
  if (id === undefined || id === null) return error(null, -32600, 'Invalid request');
  if (body.method === 'initialize') {
    const params = body.params && typeof body.params === 'object' ? body.params as Record<string, unknown> : {};
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
    const version = ['2025-03-26', '2025-06-18', '2025-11-25'].includes(requested) ? requested : '2025-11-25';
    return result(id, { protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'venus-launcher-support', version: '1.0.0' } });
  }
  if (body.method === 'ping') return result(id, {});
  if (body.method === 'tools/list') return result(id, { tools: TOOLS });
  if (body.method === 'tools/call') {
    const params = body.params && typeof body.params === 'object' ? body.params as Record<string, unknown> : {};
    const args = params.arguments && typeof params.arguments === 'object' ? params.arguments as Record<string, unknown> : {};
    if (params.name !== 'venus_help' || typeof args.topic !== 'string' || !Object.hasOwn(TOPICS, args.topic)) return error(id, -32602, 'Invalid tool arguments');
    return result(id, { content: [{ type: 'text', text: TOPICS[args.topic] }] });
  }
  return error(id, -32601, 'Method not found');
});

