// Temas del launcher compartibles (Ajustes → Apariencia): exportar el tema propio como código, importar un
// código, galería de la comunidad (populares y nuevos) con vista previa, Usar, Publicar el mío y borrar los
// míos. Un tema es solo apariencia (acento, tinte, estrellas o un fondo de la galería de Venus, oscurecer y
// desenfoque): nunca rutas de la PC. Se aplica sin reiniciar escribiendo settings.appearance (appearance.js
// escucha los ajustes y redibuja todo).
// Contrato: themesPanel() -> Element (con .destroy()). Exports extra: currentTheme(), applyTheme(theme).
// Servidor: RPC theme_list, theme_publish, theme_use y theme_delete (supabase/migrations/0022_temas.sql).
// Lógica pura (validación, código, mapeo con los ajustes) en features/themes/codec.js. Guía: docs/temas.md.
import { h, icon, mount, ensureCss, toast, ok, fail, setBusy, skeleton, emptyState, confirmDialog, modal, copyText, fmtNumber, fmtAgo } from '../ui.js';
import { store } from '../store.js';
import { t, loadNs } from '../i18n.js';
import { cloud } from '../cloud.js';
import { navigate } from '../app.js';
import { PRESETS, appearanceSettings, onAppearanceChange } from '../appearance.js';
import { legibleAccent } from '../a11y/engine.js';
import { getWallpaper } from '../wallpapers.js';
import * as codec from './themes/codec.js';

const NS = 'themes';
const PAGE = 24;
const KEYS = ['accent', 'customColor', 'tint', 'background', 'wallpaperId', 'bgDim', 'bgBlur'];
let readyPromise = null;
let seq = 0;

function prepare() {
  ensureCss('features/themes');
  if (!readyPromise) readyPromise = loadNs(NS).catch((err) => console.warn('[themes] textos', err));
  return readyPromise;
}

const isWallpaper = (id) => Boolean(getWallpaper(id));

// ---------- Tema actual y aplicar ----------
export function currentTheme() {
  return codec.themeFromAppearance(appearanceSettings().appearance, { isWallpaper });
}

// Guarda en settings.appearance solo lo del tema (la imagen propia y la música no se tocan). Devuelve
// { previous, missingWallpaper } para poder volver al tema anterior.
export async function applyTheme(theme) {
  if (!codec.validTheme(theme)) throw new Error(t('themes.errInvalid'));
  const { patch, missingWallpaper } = codec.appearanceFromTheme(theme, { isWallpaper });
  const now = appearanceSettings().appearance;
  const previous = Object.fromEntries(KEYS.map((k) => [k, now[k]]));
  await store.setSettings({ appearance: patch });
  return { previous, missingWallpaper };
}

// ---------- Colores de la vista previa (sin hojas de estilo: el motor de temas no los reescribe) ----------
function hexRgb(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex || '');
  return m ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) : [242, 154, 46];
}
function mix(a, b, k) {
  const [x, y] = [hexRgb(a), hexRgb(b)];
  return `#${x.map((v, i) => Math.round(v + (y[i] - v) * k).toString(16).padStart(2, '0')).join('')}`;
}

export function accentOf(theme) {
  if (theme?.accent === 'custom' && /^#[0-9a-f]{6}$/i.test(theme.customColor || '')) return theme.customColor.toLowerCase();
  return PRESETS.find((p) => p.id === theme?.accent)?.color || PRESETS[0].color;
}

function accentName(theme) {
  return theme?.accent === 'custom' ? t('themes.accentCustom', { color: accentOf(theme) }) : t(`themes.accent_${theme?.accent || 'venus'}`);
}

function backgroundName(theme) {
  const wp = theme?.background === 'wallpaper' ? getWallpaper(theme.wallpaper) : null;
  return wp ? t('themes.bgWallpaper', { name: wp.name }) : t('themes.bgStars');
}

// Miniatura del launcher con los colores y el fondo del tema.
export function themePreview(theme, { compact = false } = {}) {
  const accent = legibleAccent(accentOf(theme));
  const tinted = theme?.tint === undefined || theme.tint > 0;
  const wp = theme?.background === 'wallpaper' ? getWallpaper(theme.wallpaper) : null;
  const dim = Math.min(90, Math.max(0, Math.round(theme?.bgDim ?? 45))) / 100;
  const blur = Math.min(24, Math.max(0, Math.round(theme?.bgBlur ?? 0)));
  // Fondos y textos: los cálidos de Venus o teñidos con el acento (como hace el motor de temas)
  const bg = tinted ? mix('#0c0a09', accent, 0.07) : '#0c0705';
  const surface = tinted ? mix('#1a1714', accent, 0.12) : '#1b130e';
  const text = tinted ? mix('#fff6ec', accent, 0.18) : '#fff3e3';
  return h(
    'div',
    {
      class: ['th-preview', compact && 'th-preview-compact', wp && 'th-has-wp'],
      role: 'img',
      'aria-label': t('themes.previewLabel', { accent: accentName(theme), background: backgroundName(theme) }),
      style: { '--th-accent': accent, '--th-bg': bg, '--th-surface': surface, '--th-text': text, '--th-dim': String(wp ? dim : 0), '--th-blur': `${Math.round(blur / 3)}px` },
    },
    wp ? h('img', { class: 'th-pv-img', src: wp.thumb, alt: '', loading: 'lazy', decoding: 'async' }) : h('div', { class: 'th-pv-stars' }),
    h('div', { class: 'th-pv-dim' }),
    h(
      'div',
      { class: 'th-pv-ui', 'aria-hidden': 'true' },
      h('div', { class: 'th-pv-side' }, h('i', { class: 'th-pv-logo' }), h('i', { class: 'th-pv-nav on' }), h('i', { class: 'th-pv-nav' }), h('i', { class: 'th-pv-nav' })),
      h(
        'div',
        { class: 'th-pv-main' },
        h('i', { class: 'th-pv-title' }),
        h('div', { class: 'th-pv-card' }, h('i', { class: 'th-pv-line' }), h('i', { class: 'th-pv-line short' }), h('div', { class: 'th-pv-row' }, h('i', { class: 'th-pv-btn' }), h('i', { class: 'th-pv-chip' }))),
        h('i', { class: 'th-pv-bar' }),
      ),
    ),
  );
}

// ---------- Servidor ----------
class ThemeError extends Error {
  constructor(kind, message, detail) {
    super(message || kind);
    this.kind = kind; // 'signedOut' | 'unavailable' | 'server'
    this.detail = detail || null; // clave del servidor: bad_name, too_many_themes, user_muted...
  }
}

async function rpc(fn, args) {
  await cloud.ready();
  if (!cloud.isConfigured()) throw new ThemeError('unavailable');
  if (!cloud.isSignedIn()) throw new ThemeError('signedOut');
  let res;
  try {
    res = await cloud.client.rpc(fn, args);
  } catch (err) {
    console.warn(`[themes] ${fn}:`, err?.message || err);
    throw new ThemeError('unavailable');
  }
  if (res.error) {
    const key = codec.serverErrorKey(res.error);
    if (key === 'not_authenticated') throw new ThemeError('signedOut');
    if (key) throw new ThemeError('server', t(`themes.srv_${key}`), key);
    console.warn(`[themes] ${fn}:`, codec.isMissingSchema(res.error) ? 'falta la migración 0022' : '', res.error.code || '', res.error.message || res.error);
    throw new ThemeError('unavailable');
  }
  return res.data;
}

// Filas de theme_list con datos revisados otra vez (un tema raro no se muestra).
function cleanRows(data) {
  if (!Array.isArray(data)) return [];
  return data
    .filter((r) => r && typeof r.id === 'string' && typeof r.name === 'string' && codec.validTheme(r.data))
    .map((r) => ({
      id: r.id,
      name: r.name.slice(0, 40),
      theme: codec.pickTheme(r.data),
      uses: Number.isFinite(Number(r.uses)) ? Number(r.uses) : 0,
      createdAt: Date.parse(r.createdAt) || null,
      author: String(r.owner?.displayName || r.owner?.username || '').slice(0, 40),
      mine: r.mine === true,
    }));
}

// ---------- Panel ----------
/**
 * Panel completo de temas. Se limpia con el.destroy() (Ajustes lo llama al salir) o solo cuando sale del documento.
 */
export function themesPanel() {
  const root = h('section', { class: 'card th-panel', 'aria-busy': 'true', 'aria-labelledby': `th-title-${++seq}` }, skeleton('card', { lines: 4 }));
  const offs = [];
  let disposed = false;
  let seen = false;
  const born = Date.now();
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearInterval(watch);
    offs.splice(0).forEach((off) => {
      try {
        off();
      } catch {
        /* nada */
      }
    });
  };
  const watch = setInterval(() => {
    if (root.isConnected) seen = true;
    else if (seen || Date.now() - born > 60000) dispose();
  }, 2000);
  root.destroy = dispose;
  const titleId = root.getAttribute('aria-labelledby');
  prepare()
    .then(() => {
      if (!disposed) build(root, { titleId, offs, alive: () => !disposed });
    })
    .catch((err) => {
      if (disposed) return;
      console.error('[themes]', err);
      mount(root, h('div', { class: 'notice bad' }, icon('alert'), h('span', {}, t('themes.loadFailed'))));
    })
    .finally(() => {
      if (!disposed) root.removeAttribute('aria-busy');
    });
  return root;
}

function build(root, { titleId, offs, alive }) {
  const uid = titleId.replace('th-title-', 'th');
  const S = { sort: 'popular', rows: null, offset: 0, more: false, loading: false, error: null, token: 0, undo: null, imported: null };

  // ---------- Deshacer el último tema aplicado ----------
  const undoText = h('span', {});
  const undoBtn = h('button', { class: 'btn sm ghost', type: 'button', onclick: () => undoApply() }, icon('undo'), t('themes.undo'));
  const undoBar = h('div', { class: 'notice good th-undo', role: 'status', hidden: true }, icon('check'), h('div', { class: 'th-undo-text' }, undoText), undoBtn);

  async function useTheme(theme, name, { id = null, btn = null } = {}) {
    const done = setBusy(btn);
    try {
      const { previous, missingWallpaper } = await applyTheme(theme);
      if (!alive()) return;
      S.undo = previous;
      undoText.textContent = name ? t('themes.appliedNamed', { name }) : t('themes.applied');
      undoBar.hidden = false;
      if (missingWallpaper) toast('info', t('themes.missingWallpaperTitle'), t('themes.missingWallpaperText'));
      // Cuenta un uso (una vez por cuenta); si falla no importa: el tema ya se aplicó
      if (id && cloud.isSignedIn()) {
        rpc('theme_use', { p_id: id })
          .then((uses) => {
            const row = (S.rows || []).find((r) => r.id === id);
            if (row && Number.isFinite(Number(uses))) {
              row.uses = Number(uses);
              if (alive()) drawGallery();
            }
          })
          .catch(() => {});
      }
    } catch (err) {
      if (alive()) fail(t('themes.applyFailed'), err);
    } finally {
      done();
    }
  }

  async function undoApply() {
    if (!S.undo) return;
    const done = setBusy(undoBtn);
    try {
      await store.setSettings({ appearance: S.undo });
      S.undo = null;
      undoBar.hidden = true;
      ok(t('themes.undone'));
    } catch (err) {
      fail(t('themes.applyFailed'), err);
    } finally {
      done();
    }
  }

  // ---------- Tu tema ----------
  const minePreview = h('div', { class: 'th-mine-preview' });
  const mineSummary = h('div', { class: 'th-mine-summary' });
  const codeId = `${uid}-code`;
  const codeInput = h('input', { class: 'input th-code', id: codeId, readonly: true, spellcheck: 'false', 'aria-describedby': `${uid}-code-help`, onfocus: (e) => e.currentTarget.select() });
  const starsNote = h('div', { class: 'notice th-stars-note', hidden: true }, icon('info'), h('span', {}, t('themes.imageBgNote')));
  const copyBtn = h('button', { class: 'btn tonal', type: 'button', onclick: () => copyMine() }, icon('copy'), t('themes.copyCode'));
  const publishBtn = h('button', { class: 'btn', type: 'button', onclick: () => openPublish() }, icon('upload'), t('themes.publish'));

  function drawMine() {
    const { theme, usedStars } = currentTheme();
    mount(minePreview, themePreview(theme));
    mount(mineSummary, h('div', { class: 'th-chip-row' }, h('span', { class: 'th-swatch', style: { '--th-sw': accentOf(theme) }, 'aria-hidden': 'true' }), h('span', {}, accentName(theme))), h('div', { class: 'th-meta' }, backgroundName(theme)));
    codeInput.value = codec.encodeTheme(theme);
    starsNote.hidden = !usedStars;
  }

  async function copyMine() {
    const { theme, usedStars } = currentTheme();
    await copyText(codec.encodeTheme(theme), t('themes.copied'));
    if (usedStars) toast('info', t('themes.imageBgTitle'), t('themes.imageBgNote'), 6500);
  }

  const mineSection = h(
    'div',
    { class: 'th-section th-mine' },
    h('h4', { class: 'th-h' }, icon('palette'), t('themes.mineTitle')),
    h(
      'div',
      { class: 'th-mine-grid' },
      minePreview,
      h(
        'div',
        { class: 'th-mine-side' },
        mineSummary,
        h('div', { class: 'field th-code-field' }, h('label', { for: codeId }, t('themes.codeLabel')), codeInput, h('div', { class: 'field-help', id: `${uid}-code-help` }, t('themes.codeHelp'))),
        starsNote,
        h('div', { class: 'row wrap' }, copyBtn, publishBtn),
      ),
    ),
  );

  // ---------- Usar un código ----------
  const importId = `${uid}-import`;
  const importErrId = `${uid}-import-err`;
  const importInput = h('input', { class: 'input th-code', id: importId, placeholder: t('themes.importPlaceholder'), spellcheck: 'false', autocomplete: 'off', 'aria-describedby': `${uid}-import-help` });
  const importError = h('div', { class: 'field-error', id: importErrId, role: 'alert', hidden: true }, icon('alert'), h('span', {}));
  const importBtn = h('button', { class: 'btn', type: 'button', onclick: () => readCode(true) }, icon('eye'), t('themes.importCheck'));
  const importResult = h('div', { class: 'th-import-result', hidden: true });

  function setImportError(code) {
    const bad = Boolean(code);
    importError.hidden = !bad;
    importError.lastChild.textContent = bad ? t(`themes.code_${code}`) : '';
    importInput.classList.toggle('invalid', bad);
    if (bad) {
      importInput.setAttribute('aria-invalid', 'true');
      importInput.setAttribute('aria-describedby', `${uid}-import-help ${importErrId}`);
    } else {
      importInput.removeAttribute('aria-invalid');
      importInput.setAttribute('aria-describedby', `${uid}-import-help`);
    }
  }

  // Lee el código; showError: al salir del campo o al tocar "Ver tema" (no en cada tecla)
  function readCode(showError) {
    const r = codec.decodeTheme(importInput.value);
    if (!r.ok) {
      S.imported = null;
      importResult.hidden = true;
      setImportError(showError ? r.code : null);
      return;
    }
    setImportError(null);
    S.imported = r.theme;
    const useBtn = h('button', { class: 'btn primary', type: 'button', onclick: (e) => useTheme(r.theme, null, { btn: e.currentTarget }) }, icon('check'), t('themes.useThis'));
    mount(
      importResult,
      themePreview(r.theme, { compact: true }),
      h('div', { class: 'th-import-side' }, h('div', { class: 'th-chip-row' }, h('span', { class: 'th-swatch', style: { '--th-sw': accentOf(r.theme) }, 'aria-hidden': 'true' }), h('span', {}, accentName(r.theme))), h('div', { class: 'th-meta' }, backgroundName(r.theme)), useBtn),
    );
    importResult.hidden = false;
  }

  importInput.addEventListener('input', () => {
    // pegar un código válido lo muestra enseguida; los errores se marcan al salir del campo
    const r = codec.decodeTheme(importInput.value);
    if (r.ok) readCode(false);
    else {
      importResult.hidden = true;
      if (!importError.hidden) setImportError(null);
    }
  });
  importInput.addEventListener('blur', () => {
    if (importInput.value.trim()) readCode(true);
  });
  importInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') readCode(true);
  });

  const importSection = h(
    'div',
    { class: 'th-section th-import' },
    h('h4', { class: 'th-h' }, icon('download'), t('themes.importTitle')),
    h('div', { class: 'field' }, h('label', { for: importId }, t('themes.importLabel')), h('div', { class: 'th-import-row' }, importInput, importBtn), h('div', { class: 'field-help', id: `${uid}-import-help` }, t('themes.importHelp')), importError),
    importResult,
  );

  // ---------- Comunidad ----------
  const sortBtns = ['popular', 'new'].map((id) =>
    h('button', { type: 'button', 'aria-pressed': String(id === S.sort), class: id === S.sort ? 'active' : null, dataset: { sort: id }, onclick: () => setSort(id) }, icon(id === 'popular' ? 'trending' : 'clock'), t(`themes.sort_${id}`)),
  );
  const refreshBtn = h('button', { class: 'icon-btn sm', type: 'button', title: t('themes.refresh'), 'aria-label': t('themes.refresh'), onclick: () => loadGallery({ reset: true }) }, icon('refresh'));
  const galleryHost = h('div', { class: 'th-gallery-host', 'aria-live': 'polite' });
  const moreBtn = h('button', { class: 'btn sm ghost', type: 'button', hidden: true, onclick: () => loadGallery() }, icon('chevronDown'), t('themes.loadMore'));
  const communitySection = h(
    'div',
    { class: 'th-section th-community' },
    h('div', { class: 'th-community-head' }, h('h4', { class: 'th-h' }, icon('users'), t('themes.communityTitle')), h('div', { class: 'segmented th-seg', role: 'group', 'aria-label': t('themes.sortLabel') }, sortBtns), refreshBtn),
    galleryHost,
    h('div', { class: 'th-more' }, moreBtn),
  );

  function setSort(id) {
    if (S.sort === id) return;
    S.sort = id;
    sortBtns.forEach((b) => {
      const on = b.dataset.sort === id;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    loadGallery({ reset: true });
  }

  async function loadGallery({ reset = false } = {}) {
    if (S.loading && !reset) return;
    const token = ++S.token;
    if (reset) {
      S.rows = null;
      S.offset = 0;
      S.error = null;
    }
    S.loading = true;
    if (!S.rows) mount(galleryHost, skeleton('grid', { items: 4, min: 200, label: t('themes.loadingGallery') }));
    const done = S.rows ? setBusy(moreBtn) : () => {};
    refreshBtn.classList.add('loading');
    try {
      const data = await rpc('theme_list', { p_sort: S.sort, p_limit: PAGE, p_offset: S.offset });
      if (token !== S.token || !alive()) return;
      const rows = cleanRows(data);
      S.rows = [...(S.rows || []), ...rows.filter((r) => !(S.rows || []).some((o) => o.id === r.id))];
      S.offset += Array.isArray(data) ? data.length : 0;
      S.more = Array.isArray(data) && data.length >= PAGE;
      S.error = null;
    } catch (err) {
      if (token !== S.token || !alive()) return;
      S.error = err instanceof ThemeError ? err.kind : 'unavailable';
      if (!(err instanceof ThemeError)) console.warn('[themes] galería:', err);
    } finally {
      if (token === S.token) {
        S.loading = false;
        refreshBtn.classList.remove('loading');
      }
      done();
    }
    if (alive() && token === S.token) drawGallery();
  }

  function drawGallery() {
    moreBtn.hidden = true;
    if (S.error === 'signedOut') {
      mount(galleryHost, emptyState('users', t('themes.signedOutTitle'), t('themes.signedOutText'), h('button', { class: 'btn', type: 'button', onclick: () => navigate('settings/cloud') }, icon('logIn'), t('themes.goToAccount'))));
      return;
    }
    if (S.error) {
      mount(galleryHost, emptyState('alert', t('themes.unavailableTitle'), t('themes.unavailableText'), h('button', { class: 'btn', type: 'button', onclick: () => loadGallery({ reset: true }) }, icon('refresh'), t('themes.retry'))));
      return;
    }
    if (!S.rows) return;
    if (!S.rows.length) {
      mount(galleryHost, emptyState('palette', t('themes.emptyTitle'), t('themes.emptyText'), h('button', { class: 'btn tonal', type: 'button', onclick: () => openPublish() }, icon('upload'), t('themes.publishFirst'))));
      return;
    }
    const mine = currentTheme().theme;
    mount(galleryHost, h('div', { class: 'th-grid', role: 'list', 'aria-label': t('themes.communityTitle') }, S.rows.map((r) => themeCard(r, codec.sameTheme(r.theme, mine)))));
    moreBtn.hidden = !S.more;
  }

  function themeCard(r, inUse) {
    const useBtn = h('button', { class: 'btn sm tonal', type: 'button', disabled: inUse, 'aria-label': t('themes.useNamed', { name: r.name }), onclick: (e) => useTheme(r.theme, r.name, { id: r.id, btn: e.currentTarget }) }, icon(inUse ? 'check' : 'sparkles'), inUse ? t('themes.inUse') : t('themes.use'));
    const delBtn = r.mine ? h('button', { class: 'icon-btn sm danger', type: 'button', title: t('themes.deleteNamed', { name: r.name }), 'aria-label': t('themes.deleteNamed', { name: r.name }), onclick: (e) => removeTheme(r, e.currentTarget) }, icon('trash')) : null;
    return h(
      'article',
      { class: ['th-card', inUse && 'th-card-active'], role: 'listitem', 'aria-label': r.name },
      themePreview(r.theme, { compact: true }),
      h(
        'div',
        { class: 'th-card-body' },
        h('div', { class: 'th-card-name ellipsis', title: r.name }, r.name),
        h(
          'div',
          { class: 'th-card-meta' },
          r.mine ? h('span', { class: 'badge accent' }, t('themes.mine')) : h('span', { class: 'ellipsis', title: r.author }, r.author ? t('themes.by', { name: r.author }) : t('themes.byUnknown')),
          h('span', { class: 'th-uses num', title: r.createdAt ? t('themes.publishedAgo', { ago: fmtAgo(r.createdAt) }) : null }, icon('heart'), t('themes.uses', { count: r.uses, n: fmtNumber(r.uses) })),
        ),
        h('div', { class: 'th-card-actions' }, useBtn, delBtn),
      ),
    );
  }

  async function removeTheme(r, btn) {
    if (!(await confirmDialog(t('themes.deleteTitle'), t('themes.deleteText', { name: r.name }), { okText: t('themes.deleteOk'), danger: true }))) return;
    const done = setBusy(btn);
    try {
      const deleted = await rpc('theme_delete', { p_id: r.id });
      if (!alive()) return;
      S.rows = (S.rows || []).filter((x) => x.id !== r.id);
      S.offset = Math.max(0, S.offset - 1);
      if (deleted) ok(t('themes.deleted'), r.name);
      else toast('info', t('themes.alreadyGone'));
      drawGallery();
    } catch (err) {
      if (!alive()) return;
      fail(t('themes.deleteFailed'), err instanceof ThemeError && err.kind === 'server' ? err.message : t('themes.unavailableText'));
    } finally {
      done();
    }
  }

  // ---------- Publicar ----------
  async function openPublish() {
    await cloud.ready();
    if (!cloud.isConfigured()) {
      toast('info', t('themes.unavailableTitle'), t('themes.unavailableText'));
      return;
    }
    if (!cloud.isSignedIn()) {
      toast('info', t('themes.signedOutTitle'), t('themes.publishNeedsAccount'));
      navigate('settings/cloud');
      return;
    }
    const { theme, usedStars } = currentTheme();
    const nameId = `${uid}-pub-name`;
    const errId = `${uid}-pub-err`;
    const input = h('input', { class: 'input', id: nameId, maxlength: codec.NAME_MAX, autocomplete: 'off', spellcheck: 'false', 'aria-describedby': `${uid}-pub-help`, 'data-autofocus': '' });
    const err = h('div', { class: 'field-error', id: errId, role: 'alert', hidden: true }, icon('alert'), h('span', {}));
    const count = h('span', { class: 'th-count num', 'aria-hidden': 'true' }, `0/${codec.NAME_MAX}`);
    const showErr = (text) => {
      err.hidden = !text;
      err.lastChild.textContent = text || '';
      input.classList.toggle('invalid', Boolean(text));
      if (text) {
        input.setAttribute('aria-invalid', 'true');
        input.setAttribute('aria-describedby', `${uid}-pub-help ${errId}`);
      } else {
        input.removeAttribute('aria-invalid');
        input.setAttribute('aria-describedby', `${uid}-pub-help`);
      }
    };
    input.addEventListener('input', () => {
      count.textContent = `${input.value.length}/${codec.NAME_MAX}`;
      if (!err.hidden && codec.cleanThemeName(input.value)) showErr(null);
    });
    input.addEventListener('blur', () => {
      if (input.value.trim() && !codec.cleanThemeName(input.value)) showErr(t('themes.nameInvalid'));
    });
    const okBtn = h('button', { class: 'btn primary', type: 'button', onclick: () => submit() }, icon('upload'), t('themes.publishOk'));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });
    const m = modal({
      title: t('themes.publishTitle'),
      subtitle: t('themes.publishSub'),
      icon: 'upload',
      body: h(
        'div',
        { class: 'th-publish' },
        themePreview(theme),
        h('div', { class: 'field' }, h('div', { class: 'th-label-row' }, h('label', { for: nameId }, t('themes.nameLabel')), count), input, h('div', { class: 'field-help', id: `${uid}-pub-help` }, t('themes.nameHelp')), err),
        usedStars ? h('div', { class: 'notice' }, icon('info'), h('span', {}, t('themes.imageBgPublish'))) : null,
        h('p', { class: 'th-fine' }, t('themes.publishFine')),
      ),
      footer: [h('button', { class: 'btn ghost', type: 'button', onclick: () => m.close() }, t('themes.cancel')), okBtn],
    });

    async function submit() {
      const name = codec.cleanThemeName(input.value);
      if (!name) {
        showErr(input.value.trim() ? t('themes.nameInvalid') : t('themes.nameRequired'));
        input.focus();
        return;
      }
      const done = setBusy(okBtn);
      try {
        await rpc('theme_publish', { p_name: name, p_data: theme });
        m.close();
        ok(t('themes.published'), name);
        if (alive()) {
          if (S.sort !== 'new') setSort('new');
          else loadGallery({ reset: true });
        }
      } catch (e) {
        if (e instanceof ThemeError && e.detail === 'bad_name') showErr(t('themes.nameInvalid'));
        else if (e instanceof ThemeError && e.kind === 'server') showErr(e.message);
        else if (e instanceof ThemeError && e.kind === 'signedOut') showErr(t('themes.publishNeedsAccount'));
        else showErr(t('themes.unavailableText'));
      } finally {
        done();
      }
    }
  }

  // ---------- Armar y escuchar ----------
  mount(
    root,
    h('div', { class: 'card-head th-head' }, h('div', {}, h('h3', { class: 'card-title', id: titleId }, icon('palette'), t('themes.title')), h('p', { class: 'card-sub' }, t('themes.subtitle')))),
    undoBar,
    mineSection,
    importSection,
    communitySection,
  );
  drawMine();
  loadGallery({ reset: true });

  offs.push(
    onAppearanceChange(() => {
      if (!alive()) return;
      drawMine();
      if (S.rows?.length) drawGallery();
    }),
  );
  let lastUser = cloud.user?.id || null;
  offs.push(
    cloud.on('auth', () => {
      const now = cloud.user?.id || null;
      if (now === lastUser || !alive()) return;
      lastUser = now;
      loadGallery({ reset: true });
    }),
  );
}
