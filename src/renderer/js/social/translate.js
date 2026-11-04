// Traduccion de mensajes (3.3): filtro (que vale la pena mandar), caché local por mensaje y tandas. Es logica pura: el
// envio entra por parametro (socialplus:translate del proceso principal, que arma el pedido a la IA) y la interfaz esta en
// pages/messages/plus.js. El texto de un mensaje no es confiable: se traduce, no se obedece, y se muestra como texto.
export const TR_LIMITS = { batchItems: 10, batchChars: 4000, textMax: 2000, cacheMax: 400, delayMs: 800 };

const URL_RE = /\bhttps?:\/\/\S+/gi;
const EMOJI_CODE_RE = /:[a-z0-9_]{2,24}:/g;
const MENTION_RE = /(^|\s)@[\p{L}\p{N}_]+/gu;
const LETTER_RE = /\p{L}/gu;

// Palabras muy comunes de cada idioma con alfabeto latino. Una palabra que esta en varios idiomas vale menos.
const STOPWORDS = {
  es: 'hola gracias que el la los las una uno por para con pero como esta estas esto eso muy si tengo tiene hay vamos dale bueno bien todo nada donde cuando quien porque sos vos tenes queres estoy soy mas ahora despues hoy manana aca alla ya no de en y lo le se mi me te yo tu server mundo jugar jugamos'.split(' '),
  en: 'the and you are is was were have has had with for this that what when where who how why not but can will would should there here they them your my we our just get got do does did going want know hello hi thanks thank please yes no ok of to in on it be at'.split(' '),
  pt: 'ola obrigado obrigada voce voces nao sim com para por uma um os as que como esta estou tenho tem muito agora depois hoje amanha aqui ali isso isto onde quando quem porque vamos tudo bem mais mas de em e o a no na do da'.split(' '),
  fr: 'bonjour salut merci oui non avec pour une un les des que comment est suis tu vous nous ils elle mais pas je ca cette ce dans sur tres bien maintenant apres aujourdhui demain ici la ou quand qui pourquoi allons tout rien de et le'.split(' '),
  de: 'hallo danke bitte ja nein mit fur eine einer ein und der die das ist bin du wir ihr sie aber nicht ich wie geht es dir was wann wo wer warum gut jetzt heute morgen hier dort alles nichts auch noch auf zu von'.split(' '),
  it: 'ciao grazie si no con per una uno gli che come sta sto sono tu noi voi loro ma non io questo quello molto bene adesso dopo oggi domani qui dove quando chi perche andiamo tutto niente di e il la'.split(' '),
  nl: 'hallo dank ja nee met voor een het de en is ben jij wij zij maar niet ik hoe gaat wat wanneer waar wie waarom goed nu vandaag morgen hier daar alles niets ook nog op van'.split(' '),
  pl: 'czesc dzieki dziekuje tak nie jest jestem ty my wy oni ale ja jak co kiedy gdzie kto dlaczego dobrze teraz dzisiaj jutro tutaj tam wszystko nic czy sie to na'.split(' '),
  tr: 'merhaba selam tesekkurler evet hayir bir ve bu su ben sen biz siz ama degil nasil ne zaman nerede kim neden iyi simdi bugun yarin burada orada her sey hic'.split(' '),
};
const WORD_LANGS = new Map();
for (const [lang, words] of Object.entries(STOPWORDS)) {
  for (const w of words) WORD_LANGS.set(w, [...(WORD_LANGS.get(w) || []), lang]);
}
// Letras que casi solo aparecen en un idioma (se miran antes de sacar los acentos)
const LETTER_HINTS = [
  [/[ñ¿¡]/, 'es'],
  [/[ãõ]/, 'pt'],
  [/[ß]/, 'de'],
  [/[łąęśżźćń]/, 'pl'],
  [/[ğşı]/, 'tr'],
  [/[œ]/, 'fr'],
];

const plain = (s) =>
  s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();

// Lo que queda para traducir: sin direcciones, emojis propios, menciones, numeros ni simbolos
function lettersOf(text) {
  const s = String(text ?? '').replace(URL_RE, ' ').replace(EMOJI_CODE_RE, ' ').replace(MENTION_RE, ' ');
  return s.match(LETTER_RE) || [];
}

// Idioma probable o null si no hay seguridad (entonces decide la IA, que devuelve "same" si no hacia falta)
export function guessLanguage(text) {
  const s = String(text ?? '').replace(URL_RE, ' ').replace(EMOJI_CODE_RE, ' ').replace(MENTION_RE, ' ');
  const letters = s.match(LETTER_RE);
  if (!letters) return null;
  const count = (re) => (s.match(re) || []).length;
  const total = letters.length;
  if (count(/\p{Script=Hangul}/gu) / total > 0.3) return 'ko';
  if (count(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu) / total > 0.1) return 'ja';
  if (count(/\p{Script=Han}/gu) / total > 0.5) return 'zh';
  if (count(/\p{Script=Cyrillic}/gu) / total > 0.5) return /[іїєґ]/i.test(s) ? 'uk' : 'ru';
  if (count(/\p{Script=Latin}/gu) / total < 0.5) return 'other';
  const scores = {};
  const low = s.toLowerCase();
  for (const [re, lang] of LETTER_HINTS) if (re.test(low)) scores[lang] = (scores[lang] || 0) + 1.5;
  const words = plain(s).match(/\p{L}+/gu) || [];
  for (const w of words) {
    const langs = WORD_LANGS.get(w);
    if (langs) for (const lang of langs) scores[lang] = (scores[lang] || 0) + 1 / langs.length;
  }
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return null;
  const [best, second] = ranked;
  if (best[1] < 1) return null;
  if (second && best[1] - second[1] < 0.5) return null;
  return best[0];
}

// Tiene palabras: lo demas (emojis, numeros, una direccion sola) no se traduce a ningun idioma
export function hasWords(text) {
  const letters = lettersOf(text);
  return letters.length >= 2 || letters.some((c) => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(c));
}

// Si vale la pena mandar este texto a la IA para traducirlo a lang
export function isTranslatable(text, lang) {
  return hasWords(text) && guessLanguage(text) !== lang;
}

// ---------- Caché ----------
// FNV-1a de 32 bits: alcanza para notar que un mensaje se edito, sin guardar el texto en la clave
export function hashText(text) {
  let h = 0x811c9dc5;
  const s = String(text ?? '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

export const cacheKey = (id, lang, text) => `${id}|${lang}|${hashText(text)}`;

// Traducciones por mensaje e idioma. Se olvida lo mas viejo cuando se llena.
export class TranslationCache {
  constructor({ max = TR_LIMITS.cacheMax, onChange = null } = {}) {
    this.max = max;
    this.onChange = onChange;
    this.map = new Map();
  }

  get size() {
    return this.map.size;
  }

  get(id, lang, text) {
    const key = cacheKey(id, lang, text);
    const hit = this.map.get(key);
    if (!hit) return null;
    this.map.delete(key);
    this.map.set(key, hit);
    return hit;
  }

  set(id, lang, text, value) {
    const key = cacheKey(id, lang, text);
    this.map.delete(key);
    this.map.set(key, { text: String(value?.text ?? ''), same: Boolean(value?.same) });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
    this.onChange?.();
  }

  clear() {
    this.map.clear();
    this.onChange?.();
  }

  dump() {
    return [...this.map.entries()];
  }

  load(entries) {
    this.map.clear();
    for (const e of Array.isArray(entries) ? entries : []) {
      if (Array.isArray(e) && typeof e[0] === 'string' && typeof e[1]?.text === 'string') this.map.set(e[0], { text: e[1].text, same: Boolean(e[1].same) });
    }
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }
}

// ---------- Tandas ----------
export function makeBatches(items, { maxItems = TR_LIMITS.batchItems, maxChars = TR_LIMITS.batchChars } = {}) {
  const out = [];
  let cur = [];
  let chars = 0;
  for (const it of items) {
    if (cur.length && (cur.length >= maxItems || chars + it.text.length > maxChars)) {
      out.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(it);
    chars += it.text.length;
  }
  if (cur.length) out.push(cur);
  return out;
}

// Errores que no se arreglan reintentando: se corta la cola y se avisa una sola vez
const FATAL = new Set(['noplan', 'quota', 'plan', 'unavailable', 'session', 'backend', 'refused']);
export const isFatalTranslateError = (err) => FATAL.has(err?.code);

// Cola de traducciones: lo que ya esta en la caché vuelve al instante; lo demas se junta unos instantes y sale en tandas,
// de a una por vez. send(items, lang) -> [{ id, text, same } | { id, failed }]
export class TranslateQueue {
  constructor({ send, cache, lang, delayMs = TR_LIMITS.delayMs, onResult, onError }) {
    this.send = send;
    this.cache = cache;
    this.lang = lang; // () => idioma destino
    this.delayMs = delayMs;
    this.onResult = onResult;
    this.onError = onError;
    this.pending = new Map(); // id -> { id, text, lang }
    this.waiting = new Set(); // ids en camino
    this.timer = null;
    this.running = null;
    this.closed = false;
  }

  // items: [{ id, text }]. Devuelve cuantos quedaron esperando a la IA.
  request(items) {
    const lang = this.lang();
    let queued = 0;
    for (const it of items) {
      const hit = this.cache.get(it.id, lang, it.text);
      if (hit) {
        this.onResult?.(it.id, hit);
        continue;
      }
      if (this.pending.has(it.id) || this.waiting.has(it.id)) continue;
      this.pending.set(it.id, { id: it.id, text: it.text.slice(0, TR_LIMITS.textMax), source: it.text, lang });
      queued++;
    }
    if (queued && !this.timer && !this.running) this.timer = setTimeout(() => this.flush(), this.delayMs);
    return queued;
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.running) this.running = this.run().finally(() => (this.running = null));
    return this.running;
  }

  async run() {
    while (this.pending.size && !this.closed) {
      const lang = this.pending.values().next().value.lang;
      const same = [...this.pending.values()].filter((p) => p.lang === lang);
      const [batch] = makeBatches(same);
      for (const p of batch) {
        this.pending.delete(p.id);
        this.waiting.add(p.id);
      }
      let results = null;
      let failure = null;
      try {
        results = await this.send(
          batch.map((p) => ({ id: p.id, text: p.text })),
          lang,
        );
      } catch (err) {
        failure = err;
      }
      for (const p of batch) this.waiting.delete(p.id);
      if (this.closed) return;
      if (failure) {
        const fatal = isFatalTranslateError(failure);
        const dropped = fatal ? [...batch, ...this.pending.values()] : batch;
        if (fatal) this.pending.clear();
        this.onError?.(failure, dropped);
        if (fatal) return;
        continue;
      }
      const byId = new Map((Array.isArray(results) ? results : []).map((r) => [r?.id, r]));
      for (const p of batch) {
        const r = byId.get(p.id);
        if (!r || r.failed || typeof r.text !== 'string') {
          this.onResult?.(p.id, { failed: true });
          continue;
        }
        const value = { text: r.text, same: Boolean(r.same) };
        this.cache.set(p.id, lang, p.source, value);
        this.onResult?.(p.id, value);
      }
    }
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.pending.clear();
  }
}
