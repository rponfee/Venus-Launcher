// Doble mínimo del SDK oficial de OpenAI ("openai" 7.x) con lo único que usa index.ts: el constructor,
// responses.create(body, { signal, timeout, maxRetries }) y las clases de error. Lo usa index.e2e.test.ts
// cuando el paquete "openai" no está en node_modules (el repo del launcher no lo instala). Hace el mismo
// pedido HTTP que el SDK real (POST {baseURL}/responses, la clave en Authorization, JSON) contra el fetch
// global (en la prueba, uno falso) y lanza los errores con los mismos campos (status, error, code, param,
// type, requestID). Para probar con el SDK real: VENUS_OPENAI_SDK=<ruta a node_modules/openai/index.mjs>.

export class OpenAIError extends Error {}

// (Después del primer export: "node --check" toma como CommonJS un .ts que empieza con un type suelto.)
type Json = Record<string, unknown>;

export class APIError extends OpenAIError {
  status: number | undefined;
  headers: Headers | undefined;
  error: Json | undefined;
  code: unknown;
  param: unknown;
  type: unknown;
  requestID: string | null | undefined;

  constructor(status: number | undefined, error: Json | undefined, message: string | undefined, headers: Headers | undefined) {
    super(typeof error?.message === 'string' ? `${status} ${error.message}` : message ?? `${status} status code`);
    this.status = status;
    this.headers = headers;
    this.error = error;
    this.code = error?.code;
    this.param = error?.param;
    this.type = error?.type;
    this.requestID = headers?.get('x-request-id');
  }
}

export class APIUserAbortError extends APIError {
  constructor() {
    super(undefined, undefined, 'Request was aborted.', undefined);
  }
}

export class APIConnectionError extends APIError {
  constructor(message = 'Connection error.') {
    super(undefined, undefined, message, undefined);
  }
}

export class APIConnectionTimeoutError extends APIConnectionError {
  constructor() {
    super('Request timed out.');
  }
}

interface Options {
  apiKey: string;
  maxRetries?: number;
  timeout?: number;
  logLevel?: string;
}

export default class OpenAI {
  static OpenAIError = OpenAIError;
  static APIError = APIError;
  static APIUserAbortError = APIUserAbortError;
  static APIConnectionError = APIConnectionError;
  static APIConnectionTimeoutError = APIConnectionTimeoutError;

  options: Options;
  baseURL: string;
  responses: { create(body: Json, options?: { signal?: AbortSignal; timeout?: number; maxRetries?: number }): Promise<unknown> };

  constructor(options: Options) {
    this.options = options;
    this.baseURL = 'https://api.openai.com/v1';
    this.responses = { create: (body, requestOptions) => this.post('/responses', body, requestOptions?.signal) };
  }

  async post(path: string, body: Json, signal?: AbortSignal): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`${this.baseURL}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.options.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch {
      if (signal?.aborted) throw new APIUserAbortError();
      throw new APIConnectionError();
    }
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw new APIError(res.status, data?.error, undefined, res.headers);
    return data;
  }
}
