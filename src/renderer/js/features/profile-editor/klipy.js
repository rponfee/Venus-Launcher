// KLIPY: buscador de GIF para el banner del perfil (Mi perfil > Banner). Sigue las condiciones de su integracion
// (docs.klipy.com/integration-requirements y /attribution):
//   - Los pedidos salen de la app del usuario, nunca de un servidor de Venus. El servidor solo guarda la clave de la
//     app (RPC klipy_key, 0023) para que no quede en el repositorio ni en el ejecutable.
//   - Las direcciones se usan tal como vienen y la imagen se carga directo de KLIPY: no se copia ni se guarda el archivo.
//   - Los resultados se muestran en su orden y solos en su propia grilla, con "Search KLIPY" en el buscador.
//   - customer_id es un hash estable de la cuenta: KLIPY no recibe datos personales.
import { cloud } from '../../cloud.js';
import { parseGifs } from './model.js';

const API = 'https://api.klipy.com/api/v1';
const PER_PAGE = 24;
// Pais aproximado segun el idioma del launcher (KLIPY usa ISO 3166 alfa-2 para ordenar por relevancia local)
const LOCALES = { es: 'ar', en: 'us', pt: 'br', fr: 'fr', de: 'de', it: 'it', nl: 'nl', pl: 'pl', ru: 'ru', uk: 'ua', tr: 'tr', ja: 'jp', ko: 'kr', zh: 'cn' };

export class KlipyError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'KlipyError';
    this.code = code; // 'no_key' | 'network' | 'server'
  }
}

let keyCache = null;
async function appKey() {
  if (keyCache) return keyCache;
  const { data, error } = await cloud.client.rpc('klipy_key');
  if (error) throw new KlipyError('server', error.message);
  if (!data) throw new KlipyError('no_key');
  keyCache = String(data);
  return keyCache;
}

let customerCache = null;
async function customerId() {
  if (customerCache?.user === cloud.user?.id) return customerCache.id;
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`venus:${cloud.user?.id || 'anon'}`));
  const id = [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
  customerCache = { user: cloud.user?.id, id };
  return id;
}

async function request(path, params, { method = 'GET', body } = {}) {
  const key = await appKey();
  const url = new URL(`${API}/${encodeURIComponent(key)}${path}`);
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  let res;
  try {
    res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined, referrerPolicy: 'no-referrer', credentials: 'omit' });
  } catch (err) {
    throw new KlipyError('network', err?.message);
  }
  if (res.status === 401 || res.status === 403) {
    keyCache = null;
    throw new KlipyError('no_key');
  }
  if (!res.ok) throw new KlipyError('server', `HTTP ${res.status}`);
  return res.json().catch(() => ({}));
}

// Tendencias si no hay texto. content_filter 'high': el banner lo ven todos, tiene que ser apto para cualquiera.
export async function searchGifs(query, { page = 1, lang = 'es' } = {}) {
  const q = String(query || '').trim().slice(0, 100);
  const params = {
    page,
    per_page: PER_PAGE,
    customer_id: await customerId(),
    locale: LOCALES[lang] || 'us',
    content_filter: 'high',
    format_filter: 'gif,webp,jpg',
  };
  if (q) params.q = q;
  return parseGifs(await request(q ? '/gifs/search' : '/gifs/trending', params));
}

// Avisa a KLIPY que el usuario eligio ese GIF (mejora sus resultados). Si falla no importa: no frena el guardado.
export async function reportShare(slug) {
  if (!slug) return;
  try {
    await request(`/gifs/share/${encodeURIComponent(slug)}`, null, { method: 'POST', body: { customer_id: await customerId() } });
  } catch (err) {
    console.warn('[klipy] share:', err?.code || err?.message || err);
  }
}
