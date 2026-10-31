// Pruebas de openai.ts: traducción Anthropic -> OpenAI (Responses API) y vuelta, esquemas estrictos, uso y
// errores (node --test, ver supabase/functions/README.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapUpstreamError } from '../errors.ts';
import {
  anthropicUsage,
  buildOpenAIRequest,
  fromOpenAIResponse,
  JSON_FORMAT_NAME,
  openaiStatusFailure,
  openaiUsageLines,
  restoreNulls,
  strictSchema,
  toOpenAIInput,
  toOpenAITools,
  UpstreamResponseError,
} from '../openai.ts';
import type { OpenAICallInput, OpenAIRequest } from '../openai.ts';
import { buildSystem, serverPolicy } from '../policy.ts';
import { validateRequest } from '../validate.ts';

type Json = Record<string, any>;

function call(extra: Partial<OpenAICallInput> = {}): OpenAICallInput {
  return {
    task: 'text',
    system: buildSystem('text', 'Respondé corto.'),
    messages: [{ role: 'user', content: 'Hola' }],
    tools: null,
    schema: null,
    maxTokens: 2000,
    effort: 'low',
    ...extra,
  };
}

const EMPTY: OpenAIRequest = { body: {}, restore: { tools: new Map(), format: null } };

function response(output: unknown[], extra: Json = {}): Json {
  return {
    id: 'resp_1',
    object: 'response',
    status: 'completed',
    model: 'gpt-6.1-sol',
    output,
    usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens: 10, output_tokens_details: { reasoning_tokens: 4 } },
    ...extra,
  };
}

const message = (text: string, phase = 'final_answer') => ({ id: 'msg', type: 'message', role: 'assistant', status: 'completed', phase, content: [{ type: 'output_text', text, annotations: [] }] });
const fnCall = (callId: unknown, name: unknown, args: unknown) => ({ id: `fc_${String(callId)}`, type: 'function_call', call_id: callId, name, arguments: args, status: 'completed' });

// ---------- Ida ----------

test('pedido básico: instructions = política + system del launcher, store false, sin parámetros de muestreo', () => {
  const { body } = buildOpenAIRequest(call(), { model: 'gpt-6-luna', effort: 'low' });
  assert.deepEqual(body, {
    model: 'gpt-6-luna',
    instructions: `${serverPolicy('text')}\n\n## Instrucciones del launcher\n\nRespondé corto.`,
    input: [{ role: 'user', content: 'Hola' }],
    max_output_tokens: 2000,
    store: false,
    reasoning: { effort: 'low' },
  });
  for (const key of ['temperature', 'top_p', 'tool_choice', 'tools', 'text', 'previous_response_id', 'stream', 'include']) assert.ok(!(key in body), key);
});

test('esfuerzo: se manda el del mapeo; null = sin reasoning; max_output_tokens nunca menos de 16', () => {
  assert.deepEqual(buildOpenAIRequest(call({ effort: 'high' }), { model: 'gpt-6-astra', effort: 'xhigh' }).body.reasoning, { effort: 'xhigh' });
  const none = buildOpenAIRequest(call({ maxTokens: 1 }), { model: 'gpt-4.1', effort: null }).body;
  assert.ok(!('reasoning' in none));
  assert.equal(none.max_output_tokens, 16);
  assert.equal(buildOpenAIRequest(call({ maxTokens: 16000 }), { model: 'gpt-6-luna', effort: 'medium' }).body.max_output_tokens, 16000);
});

test('conversación con herramientas: llamadas en paralelo, resultados, imágenes; thinking y fallback se omiten', () => {
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Mirá esta captura', cache_control: { type: 'ephemeral' } },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
      ],
    },
    {
      role: 'assistant',
      content: [
        { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-5' } },
        { type: 'thinking', thinking: '', signature: 'EqQBCgIYAhIM' },
        { type: 'text', text: 'Reviso dos cosas.', citations: null },
        { type: 'tool_use', id: 'toolu_A', name: 'list_mods', input: { instance_id: 'i1' }, caller: { type: 'direct' } },
        { type: 'tool_use', id: 'toolu_B', name: 'get_system_specs', input: {} },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_A', content: [{ type: 'text', text: '{"ok":true}' }] },
        { type: 'tool_result', tool_use_id: 'toolu_B', is_error: true, content: 'sin permisos' },
        { type: 'text', text: '<launcher_context>notas</launcher_context>' },
      ],
    },
    { role: 'assistant', content: [{ type: 'redacted_thinking', data: 'xyz' }, { type: 'text', text: 'Listo, tenés 2 mods.' }] },
    { role: 'user', content: 'Gracias' },
  ];
  assert.deepEqual(toOpenAIInput(messages), [
    {
      role: 'user',
      content: [
        { type: 'input_text', text: 'Mirá esta captura' },
        { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgo=', detail: 'auto' },
      ],
    },
    { role: 'assistant', content: 'Reviso dos cosas.', phase: 'commentary' },
    { type: 'function_call', call_id: 'toolu_A', name: 'list_mods', arguments: '{"instance_id":"i1"}' },
    { type: 'function_call', call_id: 'toolu_B', name: 'get_system_specs', arguments: '{}' },
    { type: 'function_call_output', call_id: 'toolu_A', output: '{"ok":true}' },
    { type: 'function_call_output', call_id: 'toolu_B', output: 'Error: sin permisos' },
    { role: 'user', content: [{ type: 'input_text', text: '<launcher_context>notas</launcher_context>' }] },
    { role: 'assistant', content: 'Listo, tenés 2 mods.', phase: 'final_answer' },
    { role: 'user', content: 'Gracias' },
  ]);
});

test('resultados de herramientas: con imágenes van como lista; vacíos, como texto vacío', () => {
  const items = toOpenAIInput([
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'captura:' }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: '/9j/' } }] },
        { type: 'tool_result', tool_use_id: 'toolu_2' },
        { type: 'tool_result', tool_use_id: 'toolu_3', is_error: true, content: [{ type: 'image', source: { type: 'base64', media_type: 'image/webp', data: 'UklG' } }] },
      ],
    },
  ]);
  assert.deepEqual(items, [
    {
      type: 'function_call_output',
      call_id: 'toolu_1',
      output: [{ type: 'input_text', text: 'captura:' }, { type: 'input_image', image_url: 'data:image/jpeg;base64,/9j/', detail: 'auto' }],
    },
    { type: 'function_call_output', call_id: 'toolu_2', output: '' },
    {
      type: 'function_call_output',
      call_id: 'toolu_3',
      output: [{ type: 'input_text', text: 'Error:' }, { type: 'input_image', image_url: 'data:image/webp;base64,UklG', detail: 'auto' }],
    },
  ]);
  // Mensajes de la IA que solo tenían razonamiento no dejan nada.
  assert.deepEqual(toOpenAIInput([{ role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 's' }] }, { role: 'assistant', content: '  ' }]), []);
});

test('herramientas: strict del launcher -> strict de OpenAI con las opcionales nullable; el resto sin strict', () => {
  const tools = [
    {
      name: 'install_mod',
      description: 'Instala',
      strict: true,
      cache_control: { type: 'ephemeral' },
      type: 'custom',
      input_schema: {
        type: 'object',
        properties: {
          instance_id: { type: 'string', description: 'Id' },
          version_id: { type: 'string' },
          accept: { type: 'boolean' },
          kind: { type: 'string', enum: ['mods', 'shaders'] },
        },
        required: ['instance_id'],
        additionalProperties: false,
      },
    },
    { name: 'list_mods', input_schema: { type: 'object', properties: { offset: { type: 'integer' } }, additionalProperties: false } },
    // strict pero con algo que el modo estricto de OpenAI no acepta: va sin strict, con el esquema tal cual.
    { name: 'set_option', strict: true, input_schema: { type: 'object', properties: { value: { anyOf: [{ type: 'string' }, { type: 'number' }] } }, required: ['value'] } },
  ];
  const { tools: out, trees } = toOpenAITools(tools);
  assert.deepEqual(out[0], {
    type: 'function',
    name: 'install_mod',
    description: 'Instala',
    parameters: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'Id' },
        version_id: { type: ['string', 'null'] },
        accept: { type: ['boolean', 'null'] },
        kind: { type: ['string', 'null'], enum: ['mods', 'shaders', null] },
      },
      required: ['instance_id', 'version_id', 'accept', 'kind'],
      additionalProperties: false,
    },
    strict: true,
  });
  assert.deepEqual(out[1], { type: 'function', name: 'list_mods', parameters: tools[1].input_schema, strict: false });
  assert.deepEqual(out[2], { type: 'function', name: 'set_option', parameters: tools[2].input_schema, strict: false });
  assert.deepEqual(trees.get('install_mod'), { added: ['version_id', 'accept', 'kind'] });
  assert.equal(trees.size, 1);
  // El esquema original no se toca.
  assert.deepEqual(tools[0].input_schema.required, ['instance_id']);
});

test('herramientas MCP del usuario: pasan a OpenAI con el mismo nombre, sin strict y con el esquema tal cual', () => {
  const schema = { type: 'object', properties: { title: { type: 'string' }, labels: { type: 'array', items: { type: 'string' } }, meta: { type: 'object' } }, required: ['title'] };
  const { tools: out, trees } = toOpenAITools([{ name: 'mcp__github__create_issue', description: '[MCP server "GitHub"] Create an issue', input_schema: schema }]);
  assert.deepEqual(out, [{ type: 'function', name: 'mcp__github__create_issue', description: '[MCP server "GitHub"] Create an issue', parameters: schema, strict: false }]);
  assert.equal(trees.size, 0);
  // La llamada vuelve con el mismo nombre (el launcher la busca por nombre)
  const back = fromOpenAIResponse({ id: 'resp_1', status: 'completed', output: [{ type: 'function_call', call_id: 'call_9', name: 'mcp__github__create_issue', arguments: '{"title":"x"}' }], usage: { input_tokens: 10, output_tokens: 5 } }, { body: {}, restore: { tools: new Map(), format: null } }, 'assistant', 'gpt-6.1-sol');
  assert.equal(back.content.find((b) => b.type === 'tool_use')?.name, 'mcp__github__create_issue');
});

test('strictSchema: objetos anidados, listas, anotaciones y lo que no se puede', () => {
  const nested = strictSchema({
    type: 'object',
    title: 'Plan',
    properties: {
      searches: {
        type: 'array',
        items: { type: 'object', properties: { query: { type: 'string' }, weight: { type: 'number' } }, required: ['query'] },
      },
      note: { type: ['string', 'null'] },
      mode: { enum: ['a', 'b'] },
      fixed: { const: 'x' },
    },
    required: ['searches'],
  });
  assert.deepEqual(nested?.schema, {
    type: 'object',
    properties: {
      searches: {
        type: 'array',
        items: { type: 'object', properties: { query: { type: 'string' }, weight: { type: ['number', 'null'] } }, required: ['query', 'weight'], additionalProperties: false },
      },
      note: { type: ['string', 'null'] },
      mode: { enum: ['a', 'b', null] },
      fixed: { enum: ['x', null] },
    },
    required: ['searches', 'note', 'mode', 'fixed'],
    additionalProperties: false,
  });
  // note ya aceptaba null: no se marca (un null ahí es un valor válido).
  assert.deepEqual(nested?.tree, { added: ['mode', 'fixed'], props: { searches: { items: { added: ['weight'] } } } });
  // Sin cambios: todo obligatorio y additionalProperties false (como los esquemas del launcher).
  const plain = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
  assert.deepEqual(strictSchema(plain), { schema: plain, tree: null });
  assert.deepEqual(strictSchema({ type: 'object', properties: {} })?.schema, { type: 'object', properties: {}, required: [], additionalProperties: false });
  for (const bad of [
    { type: 'object', properties: { x: { type: 'string' } }, additionalProperties: true },
    { type: 'object', properties: { x: { $ref: '#/$defs/x' } } },
    { type: 'object', properties: { x: { type: 'string', format: 'uri' } } },
    { type: 'object', properties: { x: {} } },
    { type: 'object', properties: { x: { type: 'array' } } },
    { type: 'object', properties: { x: { type: 'tuple' } } },
    { type: 'object', properties: { x: { type: 'string', minLength: 2 } } },
    { type: 'array', items: { type: 'string' } },
    null,
  ]) {
    assert.equal(strictSchema(bad), null, JSON.stringify(bad));
  }
  let deep: Json = { type: 'string' };
  for (let i = 0; i < 11; i++) deep = { type: 'object', properties: { x: deep }, required: ['x'] };
  assert.equal(strictSchema(deep), null, 'más de 10 niveles');
});

test('restoreNulls: quita solo los null agregados para el modo estricto', () => {
  const tree = { added: ['version_id'], props: { list: { items: { added: ['weight'] } } } };
  assert.deepEqual(
    restoreNulls({ instance_id: 'i1', version_id: null, note: null, list: [{ q: 'a', weight: null }, { q: 'b', weight: 2 }] }, tree),
    { instance_id: 'i1', note: null, list: [{ q: 'a' }, { q: 'b', weight: 2 }] },
  );
  assert.deepEqual(restoreNulls({ a: null }, null), { a: null });
  assert.equal(restoreNulls('x', tree), 'x');
});

test('json: text.format json_schema estricto (o sin strict si el esquema no lo permite)', () => {
  const schema = { type: 'object', properties: { ok: { type: 'boolean' }, nota: { type: 'string' } }, required: ['ok'], additionalProperties: false };
  const req = buildOpenAIRequest(call({ task: 'json', schema, system: buildSystem('json', null) }), { model: 'gpt-6-luna', effort: 'low' });
  assert.deepEqual(req.body.text, {
    format: {
      type: 'json_schema',
      name: JSON_FORMAT_NAME,
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, nota: { type: ['string', 'null'] } }, required: ['ok', 'nota'], additionalProperties: false },
      strict: true,
    },
  });
  assert.match(JSON_FORMAT_NAME, /^[A-Za-z0-9_-]{1,64}$/);
  assert.equal(req.body.instructions, serverPolicy('json'));
  const loose = { type: 'object', properties: { x: { anyOf: [{ type: 'string' }, { type: 'number' }] } } };
  assert.deepEqual(buildOpenAIRequest(call({ task: 'json', schema: loose }), { model: 'gpt-6-luna', effort: null }).body.text, {
    format: { type: 'json_schema', name: JSON_FORMAT_NAME, schema: loose, strict: false },
  });
  // Las tareas text no mandan formato aunque haya schema (el validador ya lo impide).
  assert.ok(!('text' in buildOpenAIRequest(call({ schema }), { model: 'gpt-6-luna', effort: null }).body));
});

// ---------- Vuelta ----------

test('respuesta de texto: el razonamiento se omite; end_turn; uso con la forma de Anthropic', () => {
  const raw = response(
    [{ id: 'rs_1', type: 'reasoning', summary: [], encrypted_content: 'gAAA' }, message('Hola.')],
    { usage: { input_tokens: 12000, input_tokens_details: { cached_tokens: 4000, cache_write_tokens: 7000 }, output_tokens: 300, output_tokens_details: { reasoning_tokens: 200 } } },
  );
  assert.deepEqual(fromOpenAIResponse(raw, EMPTY, 'text', 'gpt-6.1-sol'), {
    content: [{ type: 'text', text: 'Hola.' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1000, output_tokens: 300, cache_read_input_tokens: 4000, cache_creation_input_tokens: 7000 },
    model: 'gpt-6.1-sol',
    parsed: null,
  });
});

test('llamadas en paralelo: tool_use en orden, con el call_id como id y los null opcionales quitados', () => {
  const { restore } = buildOpenAIRequest(
    call({
      task: 'assistant',
      tools: [
        {
          name: 'install_mod',
          strict: true,
          input_schema: { type: 'object', properties: { instance_id: { type: 'string' }, version_id: { type: 'string' } }, required: ['instance_id'], additionalProperties: false },
        },
      ],
    }),
    { model: 'gpt-6.1-sol', effort: 'medium' },
  );
  const raw = response([
    message('Instalo los dos.', 'commentary'),
    fnCall('call_1', 'install_mod', '{"instance_id":"i1","version_id":null}'),
    fnCall('call_2', 'install_mod', '{"instance_id":"i1","version_id":"v9"}'),
  ]);
  const result = fromOpenAIResponse(raw, { body: {}, restore }, 'assistant', 'gpt-6.1-sol');
  assert.equal(result.stop_reason, 'tool_use');
  assert.deepEqual(result.content, [
    { type: 'text', text: 'Instalo los dos.' },
    { type: 'tool_use', id: 'call_1', name: 'install_mod', input: { instance_id: 'i1' } },
    { type: 'tool_use', id: 'call_2', name: 'install_mod', input: { instance_id: 'i1', version_id: 'v9' } },
  ]);
});

test('ida y vuelta: el launcher reenvía los tool_use de OpenAI y los ids siguen iguales (con OpenAI o con Anthropic)', () => {
  const first = fromOpenAIResponse(
    response([fnCall('call_AbC123', 'list_mods', '{"instance_id":"i1"}'), fnCall('call_DeF456', 'get_system_specs', '{}')]),
    EMPTY,
    'assistant',
    'gpt-6.1-sol',
  );
  // Lo que arma el launcher para la llamada siguiente de la misma pregunta.
  const messages = [
    { role: 'user', content: '¿Qué mods tengo?' },
    { role: 'assistant', content: first.content },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call_AbC123', content: '{"mods":[]}' },
        { type: 'tool_result', tool_use_id: 'call_DeF456', content: '{"ram":16}' },
      ],
    },
  ];
  // Lo acepta el validador del backend (y por lo tanto la llamada puede ir a Anthropic con los mensajes intactos).
  const valid = validateRequest({ task: 'assistant', messages, tools: [{ name: 'list_mods', input_schema: { type: 'object' } }, { name: 'get_system_specs', input_schema: { type: 'object' } }], client: { app: 'venus-launcher', protocol: 2 } });
  assert.equal(valid.ok, true, valid.ok ? '' : valid.message);
  // Y si va de nuevo a OpenAI, cada salida lleva el call_id de su llamada.
  const input = toOpenAIInput(messages);
  assert.deepEqual(input.slice(1), [
    { type: 'function_call', call_id: 'call_AbC123', name: 'list_mods', arguments: '{"instance_id":"i1"}' },
    { type: 'function_call', call_id: 'call_DeF456', name: 'get_system_specs', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call_AbC123', output: '{"mods":[]}' },
    { type: 'function_call_output', call_id: 'call_DeF456', output: '{"ram":16}' },
  ]);
});

test('ids y nombres raros se limpian (el launcher solo acepta [A-Za-z0-9_-]); ids repetidos se separan', () => {
  const result = fromOpenAIResponse(
    response([fnCall('call 1/x', 'list mods', '{}'), fnCall('dup', 'list_mods', '{}'), fnCall('dup', 'list_mods', '{}'), fnCall(undefined, 'x', '[1]')]),
    EMPTY,
    'assistant',
    'gpt-6.1-sol',
  );
  const uses = result.content as Json[];
  assert.deepEqual(uses.map((u) => [u.id, u.name]), [
    ['call_0_call1x', 'list_mods'],
    ['dup', 'list_mods'],
    ['dup_2', 'list_mods'],
    ['call_3_', 'x'],
  ]);
  for (const use of uses) {
    assert.match(use.id, /^[A-Za-z0-9_-]{1,200}$/);
    assert.deepEqual(use.input, {}, 'argumentos que no son un objeto: {}');
  }
});

test('stop_reason: incompleta = max_tokens (argumentos cortados = {}); rechazo o filtro = refusal', () => {
  const cut = fromOpenAIResponse(
    response([fnCall('call_1', 'install_mod', '{"instance_id":"i')], { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }),
    EMPTY,
    'assistant',
    'gpt-6.1-sol',
  );
  assert.equal(cut.stop_reason, 'max_tokens');
  assert.deepEqual((cut.content as Json[])[0].input, {});
  const empty = fromOpenAIResponse(response([], { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }), EMPTY, 'text', 'gpt-6-luna');
  assert.deepEqual([empty.stop_reason, empty.content], ['max_tokens', []]);
  const refusal = fromOpenAIResponse(
    response([{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'refusal', refusal: 'No puedo ayudar con eso.' }] }]),
    EMPTY,
    'text',
    'gpt-6-luna',
  );
  assert.deepEqual([refusal.stop_reason, refusal.content], ['refusal', []]);
  const filtered = fromOpenAIResponse(response([message('Parcial')], { status: 'incomplete', incomplete_details: { reason: 'content_filter' } }), EMPTY, 'text', 'gpt-6-luna');
  assert.equal(filtered.stop_reason, 'refusal');
  // Rechazos de seguridad que llegan como respuesta fallida: también son un rechazo (nunca pasan al otro proveedor).
  for (const code of ['bio_policy', 'misalignment_policy_violation', 'image_content_policy_violation', 'invalid_prompt']) {
    const declined = fromOpenAIResponse(response([], { status: 'failed', error: { code, message: 'x' } }), EMPTY, 'text', 'gpt-6-luna');
    assert.equal(declined.stop_reason, 'refusal', code);
    assert.equal(declined.usage.output_tokens, 10, 'el uso se informa igual');
  }
});

test('respuestas fallidas: error del proveedor (se puede pasar al otro) o pedido inválido', () => {
  const cases: [string, string][] = [
    ['server_error', 'upstream_unavailable'],
    ['rate_limit_exceeded', 'upstream_rate_limited'],
    ['vector_store_timeout', 'upstream_timeout'],
    ['data_residency_mismatch', 'upstream_permission'],
    ['invalid_image', 'upstream_invalid_request'],
    ['', 'upstream_unavailable'],
  ];
  for (const [code, expected] of cases) {
    let thrown: unknown = null;
    try {
      fromOpenAIResponse(response([], { status: 'failed', error: code ? { code, message: 'detalle' } : null }), EMPTY, 'text', 'gpt-6-luna');
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof UpstreamResponseError, code);
    assert.equal(mapUpstreamError((thrown as UpstreamResponseError).failure).body.code, expected, code);
  }
  for (const odd of [null, 'x', response([], { status: 'in_progress' }), response([], { status: 'cancelled' })]) {
    assert.throws(() => fromOpenAIResponse(odd, EMPTY, 'text', 'gpt-6-luna'), UpstreamResponseError);
  }
});

test('modelo: el de la respuesta si es un id de OpenAI (también un snapshot); si no, el pedido', () => {
  assert.equal(fromOpenAIResponse(response([], { model: 'gpt-6.1-sol-2026-09-30' }), EMPTY, 'text', 'gpt-6.1-sol').model, 'gpt-6.1-sol-2026-09-30');
  assert.equal(fromOpenAIResponse(response([], { model: 'claude; drop' }), EMPTY, 'text', 'gpt-6.1-sol').model, 'gpt-6.1-sol');
  assert.equal(fromOpenAIResponse({ output: [message('ok')] }, EMPTY, 'text', 'gpt-6-luna').stop_reason, 'end_turn', 'sin status: completa');
});

test('json: parsed con los null opcionales quitados; texto inválido o respuesta cortada = null', () => {
  const schema = { type: 'object', properties: { ok: { type: 'boolean' }, nota: { type: 'string' } }, required: ['ok'], additionalProperties: false };
  const req = buildOpenAIRequest(call({ task: 'json', schema }), { model: 'gpt-6-luna', effort: 'low' });
  assert.deepEqual(fromOpenAIResponse(response([message('{"ok":true,"nota":null}')]), req, 'json', 'gpt-6-luna').parsed, { ok: true });
  assert.deepEqual(fromOpenAIResponse(response([message('{"ok":false,'), message('"nota":"x"}')]), req, 'json', 'gpt-6-luna').parsed, { ok: false, nota: 'x' });
  assert.equal(fromOpenAIResponse(response([message('{"ok":')]), req, 'json', 'gpt-6-luna').parsed, null);
  assert.equal(fromOpenAIResponse(response([message('[1]')]), req, 'json', 'gpt-6-luna').parsed, null);
  assert.equal(
    fromOpenAIResponse(response([message('{"ok":true}')], { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }), req, 'json', 'gpt-6-luna').parsed,
    null,
  );
  assert.equal(fromOpenAIResponse(response([message('{"ok":true}')]), req, 'text', 'gpt-6-luna').parsed, null, 'solo con task json');
});

// ---------- Uso y costo ----------

test('uso: input_tokens de OpenAI incluye la caché; la salida incluye el razonamiento', () => {
  const usage = {
    input_tokens: 12000,
    input_tokens_details: { cached_tokens: 4000, cache_write_tokens: 7000, cache_write_tokens_details: { ttl_30m_tokens: 3000, ttl_12h_tokens: 4000 } },
    output_tokens: 500,
    output_tokens_details: { reasoning_tokens: 300 },
  };
  assert.deepEqual(anthropicUsage(usage), { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 4000, cache_creation_input_tokens: 7000 });
  // Para el costo, cada token escrito por 12 h cuenta como dos de 30 min (2,5x contra 1,25x de la entrada).
  assert.deepEqual(openaiUsageLines(usage, 'gpt-6.1-sol'), [{ model: 'gpt-6.1-sol', input: 1000, output: 500, cacheRead: 4000, cacheWrite: 11000 }]);
  assert.deepEqual(openaiUsageLines({ input_tokens: 50, output_tokens: 5 }, 'gpt-6-luna'), [{ model: 'gpt-6-luna', input: 50, output: 5, cacheRead: 0, cacheWrite: 0 }]);
  assert.deepEqual(openaiUsageLines({ input_tokens: 10, input_tokens_details: { cached_tokens: 30 }, output_tokens: -3 }, 'gpt-6-luna'), [
    { model: 'gpt-6-luna', input: 0, output: 0, cacheRead: 30, cacheWrite: 0 },
  ]);
  assert.deepEqual(openaiUsageLines(null, 'gpt-6-luna'), []);
  assert.deepEqual(anthropicUsage('x'), { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
});

// ---------- Errores del SDK ----------

test('errores HTTP de OpenAI -> códigos del protocolo (los mismos que con Anthropic)', () => {
  const cases: [Json, number, string][] = [
    [{ status: 429, type: 'insufficient_quota', code: 'insufficient_quota' }, 503, 'upstream_billing'],
    [{ status: 429, type: 'tokens', code: 'rate_limit_exceeded' }, 503, 'upstream_rate_limited'],
    [{ status: 401, type: 'invalid_request_error', code: 'invalid_api_key' }, 502, 'upstream_auth'],
    [{ status: 403, code: 'unsupported_country_region_territory' }, 502, 'upstream_permission'],
    [{ status: 404, code: 'model_not_found' }, 502, 'upstream_model'],
    [{ status: 400, code: 'model_not_found', param: 'model' }, 502, 'upstream_model'],
    [{ status: 500, type: 'server_error' }, 503, 'upstream_unavailable'],
    [{ status: 503, code: 'server_overloaded' }, 503, 'upstream_overloaded'],
    [{ status: 502 }, 503, 'upstream_unavailable'],
    [{ status: 504 }, 503, 'upstream_timeout'],
    [{ status: 400, code: 'unsupported_value', param: 'reasoning.effort' }, 502, 'upstream_config'],
    [{ status: 400, code: 'unsupported_parameter', param: 'model' }, 502, 'upstream_config'],
  ];
  for (const [info, status, code] of cases) {
    const mapped = mapUpstreamError(openaiStatusFailure({ ...info, message: 'detalle', requestId: 'req_x' }));
    assert.equal(mapped.status, status, JSON.stringify(info));
    assert.equal(mapped.body.code, code, JSON.stringify(info));
  }
  const invalid = mapUpstreamError(openaiStatusFailure({ status: 400, code: 'context_length_exceeded', param: 'input', message: 'Too long' }));
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.code, 'upstream_invalid_request');
  assert.match(invalid.body.message, /Too long/);
  const failure = openaiStatusFailure({ status: 429, code: 'insufficient_quota', requestId: 'req_1', message: 'x' });
  assert.equal(failure.requestId, 'req_1');
  assert.equal(failure.kind, 'status');
});
