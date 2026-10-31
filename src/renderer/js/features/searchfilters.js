// Filtros extra de busqueda ("Mas filtros"): frase exacta, palabras a excluir, autor, descargas minimas,
// actualizado en los ultimos N dias, solo codigo abierto y entorno (cliente o servidor).
// Lo comparten el catalogo de Modrinth / CurseForge (pages/modrinth/browser.js) y el Buscador inteligente
// (pages/smartsearch.js). El panel solo dibuja y avisa los cambios: el estado es un objeto de la pagina (con las
// claves de emptyMore()) y el filtrado de verdad lo hace el proceso principal (core/search-filters.js).
//
//   const m = emptyMore();                                             // estado: vive en la sesion de la pagina
//   const caps = () => ({ environment: true, authorMode: 'username', openSourceMode: 'license' });
//   const form = createMoreFilters({ state: m, caps, idPrefix: 'mx', onChange: () => buscar(), extra: () => [campo] });
//   mount(panel, form.el);   form.refresh();                           // refresh() si el estado cambio desde afuera
//   morePayload(m, caps())   -> parametros para modrinth:search / curseforge:search / smartsearch:run
//   morePills(m, caps())     -> [{ id, label, clear(m) }] para mostrar los filtros activos y poder quitarlos
//
// caps: { environment: false | true | 'locked' (entorno cliente/servidor; 'locked' = lo define el destino),
//         authorMode: 'username' (Modrinth: usuario exacto) | 'name' (CurseForge: nombre visible),
//         openSourceMode: 'license' (Modrinth) | 'source' (CurseForge: tiene enlace al codigo fuente), envNote: texto }
import { h, icon, switchEl, debounce } from '../ui.js';
import { t, locale } from '../i18n.js';

export const DOWNLOAD_PRESETS = [1000, 10000, 100000, 1000000];
export const DAYS_PRESETS = [7, 30, 90, 365];
const AUTHOR_RE = /^[\w.-]{1,40}$/; // mismo criterio que core/search-filters.js
const TYPING_MS = 650; // los campos de texto se aplican cuando se deja de escribir (o con Enter / al salir del campo)

export const emptyMore = () => ({ phrase: '', exclude: '', author: '', minDownloads: 0, updatedDays: 0, openSource: false, environment: '' });

// ---------- Texto ----------

// Palabras o frases entre comillas separadas por coma, espacio, punto y coma o barra vertical
// (mismo criterio que splitTerms de core/search-filters.js; aca sirve para mostrar y quitar de a una).
export function splitTerms(text) {
  const out = [];
  const seen = new Set();
  for (const m of String(text ?? '').matchAll(/"([^"]*)"|[^\s,;|"]+/g)) {
    const term = (m[1] ?? m[0]).replace(/\s+/g, ' ').trim().slice(0, 60);
    const key = term.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    if (key.length < 2 || seen.has(key)) continue;
    seen.add(key);
    out.push(term);
    if (out.length >= 12) break;
  }
  return out;
}

export const joinTerms = (terms) => terms.map((x) => (/\s/.test(x) ? `"${x}"` : x)).join(', ');

export function compactNumber(n) {
  try {
    return new Intl.NumberFormat(locale(), { notation: 'compact', maximumFractionDigits: 1 }).format(n);
  } catch {
    return String(n);
  }
}

// Autor que se manda a la busqueda: en Modrinth tiene que ser un usuario valido (sin espacios ni simbolos).
export function activeAuthor(m, caps = {}) {
  const a = String(m.author || '').trim().replace(/^@/, '');
  if (!a) return '';
  return caps.authorMode === 'name' || AUTHOR_RE.test(a) ? a.slice(0, 60) : '';
}

// ---------- Estado ----------

// Parametros de busqueda con solo lo que esta activo (para que la clave de la busqueda no cambie sin motivo).
export function morePayload(m, caps = {}) {
  const p = {};
  if ((m.phrase || '').trim()) p.phrase = m.phrase.trim();
  if (splitTerms(m.exclude).length) p.exclude = m.exclude.trim();
  const author = activeAuthor(m, caps);
  if (author) p.author = author;
  if (m.minDownloads > 0) p.minDownloads = m.minDownloads;
  if (m.updatedDays > 0) p.updatedDays = m.updatedDays;
  if (m.openSource) p.openSource = true;
  if (caps.environment === true && m.environment) p.environment = m.environment;
  return p;
}

// Filtros activos como etiquetas que se pueden quitar de a una: { id, label, clear(estado) }
export function morePills(m, caps = {}) {
  const pills = [];
  const phrase = (m.phrase || '').trim();
  if (phrase) pills.push({ id: 'phrase', label: t('searchfilters.pillPhrase', { text: phrase }), clear: (s) => (s.phrase = '') });
  const terms = splitTerms(m.exclude);
  for (const term of terms) pills.push({ id: `exclude-${term}`, label: t('searchfilters.pillExclude', { text: term }), clear: (s) => (s.exclude = joinTerms(splitTerms(s.exclude).filter((x) => x !== term))) });
  const author = activeAuthor(m, caps);
  if (author) pills.push({ id: 'author', label: t('searchfilters.pillAuthor', { name: author }), clear: (s) => (s.author = '') });
  if (m.minDownloads > 0) pills.push({ id: 'minDownloads', label: t('searchfilters.pillDownloads', { n: compactNumber(m.minDownloads), count: m.minDownloads }), clear: (s) => (s.minDownloads = 0) });
  if (m.updatedDays > 0) pills.push({ id: 'updatedDays', label: t('searchfilters.pillUpdated', { count: m.updatedDays }), clear: (s) => (s.updatedDays = 0) });
  if (m.openSource) pills.push({ id: 'openSource', label: t(caps.openSourceMode === 'source' ? 'searchfilters.pillSourceLink' : 'searchfilters.pillOpenSource'), clear: (s) => (s.openSource = false) });
  if (caps.environment === true && m.environment) pills.push({ id: 'environment', label: t('searchfilters.pillEnvironment', { env: t(`searchfilters.env_${m.environment}`) }), clear: (s) => (s.environment = '') });
  return pills;
}

export const moreCount = (m, caps = {}) => morePills(m, caps).length;

export function clearMore(m) {
  Object.assign(m, emptyMore());
}

// ---------- Teclado ----------

// Flechas, Inicio y Fin para moverse entre los botones de un role="radiogroup" (cada flecha elige el siguiente,
// como un grupo de radios). Pasalo como onkeydown del grupo; los botones llevan role="radio" y data-fk.
export function radioKeys(e) {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return;
  const group = e.currentTarget;
  const radios = [...group.querySelectorAll('[role="radio"]:not(:disabled)')];
  const i = radios.indexOf(document.activeElement);
  if (i < 0 || !radios.length) return;
  e.preventDefault();
  const back = e.key === 'ArrowLeft' || e.key === 'ArrowUp';
  const n = e.key === 'Home' ? 0 : e.key === 'End' ? radios.length - 1 : (i + (back ? -1 : 1) + radios.length) % radios.length;
  const fk = radios[n].dataset.fk;
  radios[n].click();
  // el clic pudo redibujar el grupo (o reemplazarlo entero): se enfoca el boton nuevo con la misma clave
  const live = group.isConnected ? group : document.activeElement?.closest?.('[role="radiogroup"]');
  const target = (fk && live && [...live.querySelectorAll('[role="radio"]')].find((x) => x.dataset.fk === fk)) || radios[n];
  if (target.isConnected) target.focus({ preventScroll: true });
}

// ---------- Panel ----------

// opts: { state, caps (funcion que devuelve las capacidades), idPrefix, onChange(clave, valor), extra (funcion que devuelve
// campos propios de la pagina, por ejemplo la licencia de Modrinth) }
export function createMoreFilters({ state, caps = () => ({}), idPrefix = 'sf', onChange = () => {}, extra = null }) {
  const root = h('div', { class: 'sf-form' });
  const uid = (name) => `${idPrefix}-${name}`;

  function commit(key, value) {
    if (state[key] === value) return;
    state[key] = value;
    onChange(key, value);
  }

  // Campo de texto: se aplica al dejar de escribir, con Enter o al salir del campo
  function textField(key, { label, placeholder, help, maxlength, validate, errorText }) {
    const id = uid(key);
    const input = h('input', { class: 'input', type: 'text', id, value: state[key] || '', placeholder, maxlength, autocomplete: 'off', spellcheck: 'false', 'aria-describedby': `${id}-help`, dataset: { fk: key } });
    const error = validate ? h('div', { class: 'field-error', id: `${id}-error`, role: 'alert', hidden: true }, icon('alert'), errorText) : null;
    const check = () => {
      const bad = Boolean(validate) && !validate(input.value.trim());
      if (bad) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
      if (error) error.hidden = !bad;
      if (error && bad) input.setAttribute('aria-describedby', `${id}-help ${id}-error`);
      else input.setAttribute('aria-describedby', `${id}-help`);
    };
    const apply = () => commit(key, input.value.trim());
    const soon = debounce(apply, TYPING_MS);
    input.addEventListener('input', soon);
    input.addEventListener('change', () => {
      apply();
      check();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      apply();
      check();
    });
    if (validate && state[key]) check();
    return h('div', { class: 'sf-field' }, h('label', { class: 'sf-label', for: id }, label), input, error, h('div', { class: 'field-help', id: `${id}-help` }, help));
  }

  // Campo numerico con valores rapidos
  function numberField(key, { label, help, placeholder, max, step, presets, presetLabel, suffix }) {
    const id = uid(key);
    const input = h('input', { class: 'input sf-num', type: 'number', id, min: 0, max, step, inputmode: 'numeric', value: state[key] || '', placeholder, 'aria-describedby': `${id}-help`, dataset: { fk: key } });
    const read = () => {
      const n = Math.floor(Number(input.value));
      return Number.isFinite(n) && n > 0 ? Math.min(n, max) : 0;
    };
    const apply = () => commit(key, read());
    const soon = debounce(apply, TYPING_MS);
    input.addEventListener('input', soon);
    input.addEventListener('change', apply);
    input.addEventListener('keydown', (e) => e.key === 'Enter' && apply());
    const quick = h(
      'div',
      { class: 'chips sf-presets', role: 'group', 'aria-label': t('searchfilters.quickValues') },
      presets.map((n) =>
        h(
          'button',
          {
            type: 'button',
            class: ['chip', state[key] === n && 'active'],
            'aria-pressed': state[key] === n ? 'true' : 'false',
            dataset: { fk: `${key}-${n}` },
            onclick: () => {
              commit(key, state[key] === n ? 0 : n);
              render();
            },
          },
          presetLabel(n),
        ),
      ),
    );
    return h('div', { class: 'sf-field' }, h('label', { class: 'sf-label', for: id }, label), h('div', { class: 'sf-numrow' }, h('div', { class: 'sf-numbox' }, input, suffix ? h('span', { class: 'sf-suffix', 'aria-hidden': 'true' }, suffix) : null), quick), h('div', { class: 'field-help', id: `${id}-help` }, help));
  }

  function environmentField(c) {
    const labelId = uid('environment-label');
    const body =
      c.environment === 'locked'
        ? h('div', { class: 'sf-locked' }, icon('lock'), t('searchfilters.locked'))
        : h(
            'div',
            { class: 'segmented sf-seg', role: 'radiogroup', 'aria-labelledby': labelId, onkeydown: radioKeys },
            ['', 'client', 'server'].map((e) => {
              const on = (state.environment || '') === e;
              return h(
                'button',
                {
                  type: 'button',
                  role: 'radio',
                  'aria-checked': on ? 'true' : 'false',
                  tabindex: on ? 0 : -1,
                  class: [on && 'active'],
                  dataset: { fk: `env-${e || 'any'}` },
                  onclick: () => {
                    if (on) return;
                    commit('environment', e);
                    render();
                  },
                },
                icon(e === 'client' ? 'monitor' : e === 'server' ? 'server' : 'globe'),
                t(`searchfilters.env_${e || 'any'}`),
              );
            }),
          );
    return h('div', { class: 'sf-field' }, h('span', { class: 'sf-label', id: labelId }, t('searchfilters.environment')), body, h('div', { class: 'field-help' }, c.envNote || t('searchfilters.envHelp')));
  }

  function openSourceField(c) {
    const source = c.openSourceMode === 'source';
    const label = t(source ? 'searchfilters.openSourceCf' : 'searchfilters.openSource');
    const sw = switchEl(Boolean(state.openSource), (on) => {
      commit('openSource', on);
      render();
    }, label);
    const box = sw.querySelector('input');
    box.dataset.fk = 'openSource';
    return h('div', { class: 'sf-field sf-switchfield' }, h('div', { class: 'sf-switch' }, sw, h('div', { class: 'sf-switch-body' }, h('span', { class: 'sf-switch-text', onclick: () => box.click() }, label), h('span', { class: 'field-help' }, t(source ? 'searchfilters.openSourceCfHelp' : 'searchfilters.openSourceHelp')))));
  }

  function render() {
    // al redibujar, el foco vuelve al mismo control (chips, segmentos, interruptor) y no se pierde lo que se estaba escribiendo
    const a = document.activeElement;
    const inside = Boolean(a && a !== document.body && root.contains(a));
    const fk = inside ? a.dataset?.fk : null;
    const typed = inside && a.tagName === 'INPUT' && (a.type === 'text' || a.type === 'number') ? { value: a.value, start: a.selectionStart, end: a.selectionEnd } : null;
    const c = caps() || {};
    const nameMode = c.authorMode === 'name';
    const fields = [
      textField('phrase', { label: t('searchfilters.phrase'), placeholder: t('searchfilters.phrasePlaceholder'), help: t('searchfilters.phraseHelp'), maxlength: 120 }),
      textField('exclude', { label: t('searchfilters.exclude'), placeholder: t('searchfilters.excludePlaceholder'), help: t('searchfilters.excludeHelp'), maxlength: 200 }),
      textField('author', {
        label: t('searchfilters.author'),
        placeholder: t('searchfilters.authorPlaceholder'),
        help: t(nameMode ? 'searchfilters.authorHelpName' : 'searchfilters.authorHelpUser'),
        maxlength: 60,
        validate: nameMode ? null : (v) => !v || AUTHOR_RE.test(v.replace(/^@/, '')),
        errorText: t('searchfilters.authorInvalid'),
      }),
      numberField('minDownloads', { label: t('searchfilters.minDownloads'), placeholder: t('searchfilters.noMinimum'), help: t('searchfilters.minDownloadsHelp'), max: 2000000000, step: 100, presets: DOWNLOAD_PRESETS, presetLabel: compactNumber }),
      numberField('updatedDays', { label: t('searchfilters.updated'), placeholder: t('searchfilters.noLimit'), help: t('searchfilters.updatedHelp'), max: 3650, step: 1, presets: DAYS_PRESETS, presetLabel: (n) => t('searchfilters.days', { count: n }), suffix: t('searchfilters.daysUnit') }),
      c.environment ? environmentField(c) : null,
      openSourceField(c),
      ...((extra && extra()) || []),
    ];
    root.replaceChildren(h('div', { class: 'sf-grid' }, fields));
    if (fk) {
      const el = [...root.querySelectorAll('[data-fk]')].find((x) => x.dataset.fk === fk);
      if (el && !el.disabled && el.isConnected) {
        if (typed && el.tagName === 'INPUT' && el.value !== typed.value) el.value = typed.value;
        el.focus({ preventScroll: true });
        if (typed && typed.start !== null) {
          try {
            el.setSelectionRange(typed.start, typed.end);
          } catch {
            /* los campos numericos no tienen cursor */
          }
        }
      }
    }
  }

  render();
  return { el: root, refresh: render };
}
