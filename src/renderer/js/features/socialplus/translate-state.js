// Traduccion de mensajes: lo que se recuerda. El permiso (la primera vez hay que avisar que el texto va al proveedor de IA)
// y el interruptor de cada conversacion van en settings.socialplus; las traducciones, en el almacen cifrado de la PC,
// separadas por cuenta, porque son mensajes privados (igual que la cola de mensajes de social.js).
import { h, icon, modal, ok, fail, confirmDialog, setBusy } from '../../ui.js';
import { store, api } from '../../store.js';
import { t } from '../../i18n.js';
import { cloud } from '../../cloud.js';
import { TranslationCache } from '../../social/translate.js';

const S = (k, vars) => t(`socialplus.${k}`, vars);
const SAVE_MS = 1500;

const prefs = () => store.settings?.socialplus || {};
const storeKey = () => `socialplus.tr.${cloud.user?.id || 'local'}`;

let cache = null;
let cacheKey = null;
let loading = null;
let saveTimer = null;

function saveSoon() {
  clearTimeout(saveTimer);
  const key = cacheKey;
  saveTimer = setTimeout(() => {
    if (key === cacheKey) api.invoke('secure:set', key, cache.size ? JSON.stringify(cache.dump()) : null).catch((err) => console.warn('[socialplus] traducciones:', err?.message || err));
  }, SAVE_MS);
}

// La caché de la cuenta actual, leida una sola vez
export function translationCache() {
  const key = storeKey();
  if (cache && cacheKey === key) return Promise.resolve(cache);
  if (loading?.key === key) return loading.promise;
  const promise = (async () => {
    const next = new TranslationCache({ onChange: saveSoon });
    try {
      const raw = await api.invoke('secure:get', key);
      if (raw) next.load(JSON.parse(raw));
    } catch (err) {
      console.warn('[socialplus] traducciones guardadas:', err?.message || err);
    }
    if (storeKey() === key) {
      cache = next;
      cacheKey = key;
    }
    loading = null;
    return next;
  })();
  loading = { key, promise };
  return promise;
}

export async function clearTranslations() {
  const c = await translationCache();
  c.clear();
}

export const chatAutoOn = (chatId) => prefs().translateChats?.[chatId] === true;
export const setChatAuto = (chatId, on) => store.setSettings({ socialplus: { translateChats: { [chatId]: Boolean(on) } } });
export const hasTranslateConsent = () => prefs().translateConsent === true;

// Primera vez: avisa con claridad a donde va el texto. Devuelve si acepto.
export function askTranslateConsent() {
  if (hasTranslateConsent()) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      d.close();
      resolve(v);
    };
    const accept = h('button', { class: 'btn primary', type: 'button' }, icon('check'), S('trConsentOk'));
    const d = modal({
      title: S('trConsentTitle'),
      icon: 'sparkles',
      size: 'sm',
      body: h('div', { class: 'stack' }, h('p', {}, S('trConsentText')), h('ul', { class: 'spx-tr-points' }, h('li', {}, S('trConsentPoint1')), h('li', {}, S('trConsentPoint2')), h('li', {}, S('trConsentPoint3')))),
      footer: [h('button', { class: 'btn ghost', type: 'button', onclick: () => finish(false) }, S('trConsentCancel')), accept],
      onClose: () => finish(false),
    });
    accept.addEventListener('click', async () => {
      const release = setBusy(accept);
      try {
        await store.setSettings({ socialplus: { translateConsent: true } });
        finish(true);
      } catch (err) {
        fail(S('saveFailed'), err);
      } finally {
        release();
      }
    });
  });
}

// Tarjeta de Ajustes > Privacidad: quitar el permiso y borrar lo guardado
export function translatePrivacyCard() {
  const state = h('p', { class: 'card-sub' });
  const draw = () => (state.textContent = S(hasTranslateConsent() ? 'trPrivacyOn' : 'trPrivacyOff'));
  const revoke = h('button', { class: 'btn sm', type: 'button' }, icon('x'), S('trPrivacyRevoke'));
  const clear = h('button', { class: 'btn sm', type: 'button' }, icon('trash'), S('trPrivacyClear'));
  revoke.addEventListener('click', async () => {
    try {
      const off = Object.fromEntries(Object.keys(prefs().translateChats || {}).map((id) => [id, false]));
      await store.setSettings({ socialplus: { translateConsent: false, translateChats: off } });
      draw();
      ok(S('trPrivacyRevoked'));
    } catch (err) {
      fail(S('saveFailed'), err);
    }
  });
  clear.addEventListener('click', async () => {
    if (!(await confirmDialog(S('trPrivacyClear'), S('trPrivacyClearText'), { okText: S('trPrivacyClear'), danger: true }))) return;
    await clearTranslations();
    ok(S('trPrivacyCleared'));
  });
  draw();
  return h('section', { class: 'card', id: 'privacy-translate' }, h('h2', { class: 'card-title' }, S('trPrivacyTitle')), h('p', { class: 'card-sub' }, S('trPrivacyText')), state, h('div', { class: 'row wrap' }, revoke, clear));
}
