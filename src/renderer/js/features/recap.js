// Tu resumen de Venus: dialogo con la vista previa de la tarjeta para compartir (recap/card.js), el periodo,
// el formato y el nombre, y los botones para copiar la imagen o guardarla como PNG.
// Los datos salen del proceso principal (recap:data, todo local) y la imagen se arma en un <canvas> con el
// logo y las fuentes del launcher: nunca se dibujan imagenes de la red y no se sube nada a ningun lado.
// Uso: import('../features/recap.js').then((m) => m.openRecap())
import { h, icon, mount, modal, ok, fail, ensureCss, switchEl, setBusy, skeleton, emptyState, LOADERS } from '../ui.js';
import { api, store } from '../store.js';
import { t, loadNs, locale } from '../i18n.js';
import { navigate } from '../app.js';
import { drawCard, FORMATS } from './recap/card.js';

const NS = 'recap';
const PERIODS = ['week', 'month', 'all'];
const FORMAT_IDS = ['landscape', 'portrait'];
const SITE = 'venus-launcher.netlify.app';
const FIG_ICONS = { daysPlayed: 'calendar', streak: 'flame', bestStreak: 'flame', longest: 'zap', worlds: 'globe', servers: 'server', milestones: 'trophy', totalDays: 'calendar', avg: 'clock' };
// Paleta de respaldo (los valores de :root de main.css) por si un token no se puede leer
const TOKENS = {
  bg0: ['--bg-0', '#0c0705'],
  bg1: ['--bg-1', '#120b08'],
  text: ['--text', '#fff3e3'],
  text2: ['--text-2', '#d4bfa8'],
  muted: ['--muted', '#ad9781'],
  accent: ['--accent', '#f29a2e'],
  accentHi: ['--accent-hi', '#ffc562'],
  accentLo: ['--accent-lo', '#d9761c'],
  accentDeep: ['--accent-deep', '#9b4512'],
  cream: ['--cream', '#ffe6b0'],
};

let ready = null;
function ensureUi() {
  ensureCss('features/recap');
  if (!ready) ready = loadNs(NS).catch((err) => console.warn('[recap] textos', err));
  return ready;
}

// ---------- Recursos de la imagen (locales) ----------

function loadImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

let assets = null;
function loadAssets() {
  if (!assets) {
    assets = (async () => {
      const specs = ['700 64px "Pixelify Sans"', '600 32px "Pixelify Sans"', '500 24px "Pixelify Sans"', '500 20px Outfit', '600 20px Outfit', '700 20px Outfit'];
      const fonts = document.fonts
        ? Promise.all(specs.map((f) => document.fonts.load(f).catch(() => null))).then(() => document.fonts.ready)
        : Promise.resolve();
      const [planet, logo] = await Promise.all([loadImage('assets/logo.png'), loadImage('assets/logo-256.png'), Promise.race([fonts, new Promise((r) => setTimeout(r, 4000))])]);
      return { planet, logo };
    })();
  }
  return assets;
}

// Colores de los tokens de :root como { r, g, b } (el canvas no entiende var() ni color-mix())
function hexRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function resolvePalette() {
  const c = document.createElement('canvas');
  c.width = 1;
  c.height = 1;
  const g = c.getContext('2d', { willReadFrequently: true });
  const out = {};
  for (const [key, [token, fallback]] of Object.entries(TOKENS)) {
    let rgb = null;
    // Un elemento nuevo por token y sin transiciones. Con movimiento reducido (Ajustes o Windows) main.css le
    // pone a todo una transicion de 0,01 ms: si se reusara el mismo elemento, getComputedStyle devolveria el
    // color del token anterior y la imagen saldria toda del color del fondo.
    const probe = h('span', { 'aria-hidden': 'true', style: { position: 'absolute', visibility: 'hidden', pointerEvents: 'none' } });
    probe.style.setProperty('transition', 'none', 'important');
    probe.style.setProperty('color', `var(${token})`);
    try {
      document.body.append(probe);
      const css = getComputedStyle(probe).color;
      g.clearRect(0, 0, 1, 1);
      g.fillStyle = fallback;
      g.fillStyle = css;
      g.fillRect(0, 0, 1, 1);
      const d = g.getImageData(0, 0, 1, 1).data;
      if (d[3] > 200) rgb = { r: d[0], g: d[1], b: d[2] };
    } catch {
      rgb = null;
    } finally {
      probe.remove();
    }
    out[key] = rgb || hexRgb(fallback);
  }
  // Red de seguridad: si el texto queda casi del color del fondo, mejor la paleta de Venus que una imagen ilegible
  if (contrast(out.text, out.bg0) < 3 || contrast(out.cream, out.bg0) < 3) {
    console.warn('[recap] paleta sin contraste: se usan los colores de Venus');
    return Object.fromEntries(Object.entries(TOKENS).map(([key, [, fallback]]) => [key, hexRgb(fallback)]));
  }
  return out;
}

// Contraste WCAG entre dos colores { r, g, b }
function luminance({ r, g, b }) {
  const lin = (v) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function contrast(a, b) {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

// ---------- Formatos ----------

let numFmt = null;
function fmtInt(n) {
  const loc = locale();
  if (!numFmt || numFmt.loc !== loc) numFmt = { loc, f: new Intl.NumberFormat(loc, { maximumFractionDigits: 0 }) };
  return numFmt.f.format(Math.round(Number(n) || 0));
}

// Duracion para la tarjeta: "45 min", "12 h 30 min" y, desde 100 horas, solo las horas ("1.234 h")
function fmtTime(ms) {
  const totalMin = Math.floor((Number(ms) || 0) / 60000);
  if (totalMin < 1) return t('common.durLessMin');
  const hrs = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  if (!hrs) return t('common.durMin', { m: totalMin });
  if (hrs >= 100 || !min) return t('common.durHour', { h: fmtInt(hrs) });
  return t('common.durHourMin', { h: hrs, m: min });
}

function rangeText(p) {
  if (!p?.from) return '';
  const from = new Date(p.from);
  const to = new Date(p.to);
  try {
    const opts = p.id === 'all' ? { month: 'short', year: 'numeric' } : { day: 'numeric', month: 'short', year: 'numeric' };
    const f = new Intl.DateTimeFormat(locale(), opts);
    if (p.id === 'all' && from.getFullYear() === to.getFullYear() && from.getMonth() === to.getMonth()) return f.format(to);
    return typeof f.formatRange === 'function' ? f.formatRange(from, to) : `${f.format(from)} – ${f.format(to)}`;
  } catch {
    return '';
  }
}

function isoDate(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const firstLetter = (s) => {
  const str = String(s || '').trim();
  const seg = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(locale(), { granularity: 'grapheme' }).segment(str)[Symbol.iterator]().next().value?.segment : str.charAt(0);
  return (seg || '?').toLocaleUpperCase(locale());
};

function figureValue(f) {
  if (f.id === 'daysPlayed' || f.id === 'milestones') return t('recap.ofTotal', { value: fmtInt(f.value), total: fmtInt(f.total) });
  if (f.id === 'streak' || f.id === 'bestStreak') return t('recap.days', { count: f.value, value: fmtInt(f.value) });
  if (f.id === 'longest' || f.id === 'avg') return fmtTime(f.value);
  return fmtInt(f.value);
}

// Rotulos en mayusculas con las reglas del idioma de la interfaz (en turco, "Favori" -> "FAVORİ")
const upper = (s) => String(s ?? '').toLocaleUpperCase(locale());

// Lo que dibuja la tarjeta, ya traducido y con los numeros en el formato del idioma
function buildView(data, period, format, name) {
  const p = data.periods[period];
  const per = t(`recap.period_${period}`);
  const range = rangeText(p);
  const fav = p.favorite;
  const loader = fav ? LOADERS[fav.loader] : null;
  const c = data.collection || {};
  const chips = [];
  if (c.mods > 0) chips.push({ icon: 'puzzle', text: t('recap.mods', { count: c.mods, value: fmtInt(c.mods) }) });
  if (c.worlds > 0) chips.push({ icon: 'globe', text: t('recap.worlds', { count: c.worlds, value: fmtInt(c.worlds) }) });
  if (c.instances > 0) chips.push({ icon: 'layers', text: t('recap.instances', { count: c.instances, value: fmtInt(c.instances) }) });
  return {
    eyebrow: upper(range ? t('recap.eyebrow', { period: per, range }) : per),
    title: t(`recap.cardTitle_${period}`),
    name: name || null,
    hero: fmtTime(p.ms),
    caption: t('recap.heroCaption', { count: p.sessions, value: fmtInt(p.sessions) }),
    tiles: (p.figures || []).slice(0, format === 'portrait' ? 4 : 3).map((f) => ({ icon: FIG_ICONS[f.id] || 'clock', value: figureValue(f), label: t(`recap.fig_${f.id}`) })),
    favorite: fav
      ? {
          label: upper(t('recap.favoriteLabel')),
          name: fav.name,
          meta: [fav.mcVersion, loader?.name, fav.mods > 0 ? t('recap.mods', { count: fav.mods, value: fmtInt(fav.mods) }) : null].filter(Boolean).join(' · '),
          value: fmtTime(fav.ms),
          color: hexRgb(loader?.color),
          letter: firstLetter(fav.name),
        }
      : null,
    top: p.top
      ? {
          label: upper(t(p.top.kind === 'server' ? 'recap.topServer' : 'recap.topWorld')),
          icon: p.top.kind === 'server' ? 'server' : 'globe',
          name: p.top.name,
          meta: p.top.instanceName || null,
          value: fmtTime(p.top.ms),
        }
      : null,
    collection: chips.length ? { label: upper(t('recap.collectionLabel')), chips } : null,
    site: SITE,
  };
}

// Flechas, Inicio y Fin dentro de un grupo de radios (el foco sigue a la opcion elegida: ver remount)
function radioKeys(e) {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return;
  const radios = [...e.currentTarget.querySelectorAll('[role="radio"]:not(:disabled)')];
  const i = radios.indexOf(document.activeElement);
  if (i < 0) return;
  e.preventDefault();
  const back = e.key === 'ArrowLeft' || e.key === 'ArrowUp';
  const n = e.key === 'Home' ? 0 : e.key === 'End' ? radios.length - 1 : (i + (back ? -1 : 1) + radios.length) % radios.length;
  radios[n].focus();
  radios[n].click();
}

// Vuelve a dibujar un grupo de radios sin perder el foco: si estaba adentro, pasa a la opcion elegida
function remount(group, nodes) {
  const had = group.contains(document.activeElement);
  mount(group, nodes);
  if (had) group.querySelector('[aria-checked="true"]')?.focus({ preventScroll: true });
}

// ---------- Dialogo ----------

let current = null;
let opening = null;

// Abre el dialogo (si ya esta abierto, le pasa el foco). Dos clics seguidos no abren dos dialogos. La promesa
// termina apenas se abre: los datos se cargan despues (cerrarlo mientras carga y volver a abrirlo anda enseguida).
export function openRecap() {
  if (current) {
    current.focus();
    return Promise.resolve();
  }
  if (!opening) opening = showDialog().finally(() => (opening = null));
  return opening;
}

async function showDialog() {
  await ensureUi();
  const saved = store.settings?.recap || {};
  const state = {
    data: null,
    period: PERIODS.includes(saved.period) ? saved.period : 'all',
    format: FORMAT_IDS.includes(saved.format) ? saved.format : 'landscape',
    showName: saved.showName === true,
    status: 'loading', // loading | ready | error | empty
    error: null,
    palette: null,
    images: null,
  };
  const initial = { period: state.period, format: state.format, showName: state.showName };
  // Lo que elige el usuario (se guarda al cerrar). Si el periodo guardado no tiene partidas se muestra
  // "Desde siempre", pero eso no cambia su eleccion.
  const chosen = { ...initial };
  let alive = true;
  let drawn = false;
  let busy = false; // copiando o guardando: los dos botones quedan deshabilitados hasta que termine

  const account = store.selectedAccount?.() || null;
  const accountName = typeof account?.name === 'string' && account.name.trim() ? account.name.trim().slice(0, 40) : null;

  const canvas = h('canvas', { class: 'rcp-canvas', role: 'img', width: 1600, height: 900, hidden: true });
  const ghost = h('div', { class: 'rcp-ghost' });
  const stageMsg = h('div', { class: 'rcp-stage-msg' });
  const stage = h('div', { class: 'rcp-stage' }, canvas, ghost, stageMsg);

  const periodGroup = h('div', { class: 'rcp-periods', role: 'radiogroup', 'aria-labelledby': 'rcp-period-label', onkeydown: radioKeys });
  const formatGroup = h('div', { class: 'rcp-formats', role: 'radiogroup', 'aria-labelledby': 'rcp-format-label', onkeydown: radioKeys });
  const nameRow = h('div', { class: 'toggle-row rcp-name' });
  const side = h(
    'div',
    { class: 'rcp-side' },
    h('div', { class: 'rcp-group' }, h('div', { class: 'rcp-label', id: 'rcp-period-label' }, t('recap.periodLabel')), periodGroup),
    h('div', { class: 'rcp-group' }, h('div', { class: 'rcp-label', id: 'rcp-format-label' }, t('recap.formatLabel')), formatGroup),
    nameRow,
    h('p', { class: 'rcp-note' }, icon('lock'), h('span', {}, t('recap.privacyNote'))),
  );
  const body = h('div', { class: 'rcp-body' }, stage, side);

  const status = h('div', { class: 'rcp-status', role: 'status', 'aria-live': 'polite' });
  const saveBtn = h('button', { class: 'btn tonal', type: 'button', disabled: true }, icon('download'), t('recap.save'));
  const copyBtn = h('button', { class: 'btn primary', type: 'button', disabled: true }, icon('copy'), t('recap.copy'));
  const foot = h('div', { class: 'rcp-foot' }, status, saveBtn, copyBtn);
  let ro = null;

  const m = modal({
    title: t('recap.dialogTitle'),
    subtitle: t('recap.dialogSub'),
    icon: 'share',
    size: 'xwide rcp-modal',
    body,
    footer: [foot],
    onClose: () => {
      alive = false;
      current = null;
      ro?.disconnect();
      if (state.status === 'ready' && (chosen.period !== initial.period || chosen.format !== initial.format || chosen.showName !== initial.showName)) {
        store.setSettings({ recap: { ...chosen } }).catch((err) => console.warn('[recap] ajustes', err));
      }
    },
  });
  current = { focus: () => m.el.focus(), close: m.close };

  // Vista previa escalada para entrar en el escenario (la imagen real queda a tamaño completo)
  const fit = () => {
    const { width, height } = FORMATS[state.format];
    const cs = getComputedStyle(stage);
    const availW = stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const availH = stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    if (!(availW > 0 && availH > 0)) return;
    const scale = Math.min(availW / width, availH / height);
    const w = `${Math.max(40, Math.floor(width * scale))}px`;
    const hh = `${Math.max(40, Math.floor(height * scale))}px`;
    for (const el of [canvas, ghost]) {
      el.style.width = w;
      el.style.height = hh;
    }
  };
  ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => fit()) : null;
  ro?.observe(stage);

  const periodHasTime = (id) => (state.data?.periods?.[id]?.ms || 0) > 0;
  const canShare = () => state.status === 'ready' && drawn && periodHasTime(state.period);

  function drawPeriods() {
    remount(
      periodGroup,
      PERIODS.map((id) => {
        const active = id === state.period;
        const p = state.data?.periods?.[id];
        const value = state.status === 'loading' ? h('span', { class: 'skeleton rcp-sk-value', 'aria-hidden': 'true' }) : h('span', { class: ['rcp-period-value', !(p?.ms > 0) && 'zero'] }, p?.ms > 0 ? fmtTime(p.ms) : '—');
        return h(
          'button',
          {
            type: 'button',
            role: 'radio',
            class: ['rcp-period', active && 'active'],
            'aria-checked': String(active),
            tabindex: active ? '0' : '-1',
            disabled: state.status !== 'ready',
            dataset: { period: id },
            onclick: () => {
              if (state.period === id) return;
              state.period = id;
              chosen.period = id;
              drawPeriods();
              render();
            },
          },
          h('span', { class: 'rcp-dot', 'aria-hidden': 'true' }),
          h('span', { class: 'rcp-period-text' }, h('span', { class: 'rcp-period-title' }, t(`recap.period_${id}`)), h('span', { class: 'rcp-period-hint' }, t(`recap.periodHint_${id}`))),
          value,
        );
      }),
    );
  }

  function drawFormats() {
    remount(
      formatGroup,
      FORMAT_IDS.map((id) => {
        const active = id === state.format;
        const size = FORMATS[id];
        return h(
          'button',
          {
            type: 'button',
            role: 'radio',
            class: ['rcp-format', active && 'active'],
            'aria-checked': String(active),
            tabindex: active ? '0' : '-1',
            disabled: state.status !== 'ready',
            // Nombre completo (por si se corta) y el tamaño de la imagen
            title: `${t(`recap.format_${id}`)} · ${t('recap.formatSize', { width: size.width, height: size.height })}`,
            onclick: () => {
              if (state.format === id) return;
              state.format = id;
              chosen.format = id;
              drawFormats();
              fit();
              render();
            },
          },
          h(
            'span',
            { class: 'rcp-format-text' },
            h('span', { class: `rcp-shape ${id}`, 'aria-hidden': 'true' }),
            h('span', { class: 'rcp-format-title' }, t(`recap.format_${id}`)),
            h('span', { class: 'rcp-format-hint' }, t(`recap.formatHint_${id}`)),
          ),
        );
      }),
    );
  }

  function drawNameRow() {
    const sw = switchEl(state.showName && Boolean(accountName), (on) => {
      state.showName = on;
      chosen.showName = on;
      render();
    }, t('recap.showName'));
    const input = sw.querySelector('input');
    if (!accountName || state.status !== 'ready') input.disabled = true;
    mount(
      nameRow,
      h('div', { class: 'tr-text' }, h('div', { class: 'tr-title' }, t('recap.showName')), h('div', { class: 'tr-sub' }, accountName ? t('recap.showNameHint', { name: accountName }) : t('recap.showNameNoAccount'))),
      sw,
    );
  }

  function setButtons() {
    const on = canShare() && !busy;
    copyBtn.disabled = !on;
    saveBtn.disabled = !on;
  }

  function showStageMessage(node) {
    canvas.hidden = true;
    ghost.hidden = true;
    mount(stageMsg, node);
    stageMsg.hidden = !node;
  }

  // Dibuja la tarjeta con el periodo, el formato y el nombre elegidos
  function render() {
    if (!alive) return;
    setButtons();
    if (state.status === 'loading') {
      canvas.hidden = true;
      stageMsg.hidden = true;
      ghost.hidden = false;
      mount(ghost, skeleton('block', { height: '100%', label: t('recap.loading') }));
      return;
    }
    if (state.status === 'error') {
      // Sin detalles tecnicos (el error crudo ya fue a la consola en load)
      showStageMessage(
        h(
          'div',
          { class: 'notice bad rcp-error', role: 'alert' },
          icon('alert'),
          h('div', { class: 'rcp-error-text' }, h('strong', {}, t('recap.loadFailed')), h('div', { class: 'small' }, t('recap.loadFailedText'))),
          h('button', { class: 'btn sm', type: 'button', onclick: () => load() }, icon('refresh'), t('recap.retry')),
        ),
      );
      return;
    }
    if (state.status !== 'ready') return;
    const p = state.data.periods[state.period];
    if (!periodHasTime(state.period)) {
      drawn = false;
      setButtons();
      showStageMessage(
        emptyState(
          'calendar',
          t(`recap.periodEmpty_${state.period}`),
          t('recap.periodEmptyText'),
          h(
            'button',
            {
              class: 'btn tonal',
              type: 'button',
              onclick: () => {
                state.period = 'all';
                chosen.period = 'all';
                drawPeriods();
                render();
                periodGroup.querySelector('[aria-checked="true"]')?.focus();
              },
            },
            icon('history'),
            t('recap.periodEmptyAction'),
          ),
        ),
      );
      return;
    }
    try {
      const view = buildView(state.data, state.period, state.format, state.showName ? accountName : null);
      drawCard(canvas, view, { format: state.format, palette: state.palette, images: state.images });
      canvas.setAttribute('aria-label', t('recap.previewAlt', { count: p.sessions, period: t(`recap.period_${state.period}`), time: fmtTime(p.ms), value: fmtInt(p.sessions) }));
      stageMsg.hidden = true;
      ghost.hidden = true;
      canvas.hidden = false;
      drawn = true;
      fit();
    } catch (err) {
      console.error('[recap] dibujo:', err);
      drawn = false;
      showStageMessage(h('div', { class: 'notice bad rcp-error', role: 'alert' }, icon('alert'), h('div', {}, t('recap.drawFailed'))));
    }
    setButtons();
  }

  function showEmpty() {
    const go = h(
      'button',
      {
        class: 'btn primary',
        type: 'button',
        onclick: () => {
          m.close();
          navigate('home');
        },
      },
      icon('play'),
      t('recap.emptyAction'),
    );
    mount(body, h('div', { class: 'rcp-empty' }, emptyState('gamepad', t('recap.emptyTitle'), t('recap.emptyText'), go)));
    (foot.closest('.modal-foot') || foot).hidden = true;
    body.classList.add('is-empty');
    // El foco pasa a la unica accion (si seguia en el dialogo)
    if (document.activeElement === m.el || !m.el.contains(document.activeElement)) go.focus({ preventScroll: true });
  }

  async function load() {
    state.status = 'loading';
    state.error = null;
    drawn = false;
    drawPeriods();
    drawFormats();
    drawNameRow();
    render();
    try {
      const [data, images] = await Promise.all([api.invoke('recap:data'), loadAssets()]);
      if (!alive) return;
      if (!data || typeof data !== 'object' || !data.periods) throw new Error(t('recap.loadFailedText'));
      state.data = data;
      state.images = images;
      state.palette = resolvePalette();
      if (!data.hasPlaytime) {
        state.status = 'empty';
        showEmpty();
        return;
      }
      if (!periodHasTime(state.period)) state.period = 'all';
      state.status = 'ready';
    } catch (err) {
      if (!alive) return;
      console.warn('[recap] datos:', err?.message || err);
      state.status = 'error';
      state.error = err;
    }
    drawPeriods();
    drawFormats();
    drawNameRow();
    render();
    // El foco inicial queda en el dialogo mientras carga; despues pasa al periodo elegido
    if (state.status === 'ready' && (document.activeElement === m.el || !m.el.contains(document.activeElement))) periodGroup.querySelector('[aria-checked="true"]')?.focus({ preventScroll: true });
  }

  // La imagen exacta que se ve en la vista previa, como PNG en data URL
  function exportPng() {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error(t('recap.drawFailed')));
          return;
        }
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error || new Error(t('recap.drawFailed')));
        reader.readAsDataURL(blob);
      }, 'image/png');
    });
  }

  function showSaved(path) {
    mount(
      status,
      icon('check'),
      h('span', { class: 'rcp-status-text', title: path }, t('recap.savedAt', { path })),
      h(
        'button',
        {
          class: 'btn ghost sm',
          type: 'button',
          onclick: () => api.invoke('recap:reveal', path).catch((err) => fail(t('recap.saveFailed'), err)),
        },
        icon('folderOpen'),
        t('recap.showInFolder'),
      ),
    );
  }

  // Copiar o guardar: mientras dura, los dos botones quedan deshabilitados aunque se cambie el periodo,
  // el formato o el nombre (si no, un segundo clic armaria otra copia en paralelo)
  async function exportWith(btn, action) {
    if (!canShare() || busy) return;
    busy = true;
    const done = setBusy(btn);
    setButtons();
    try {
      await action(await exportPng());
    } finally {
      busy = false;
      done();
      setButtons();
    }
  }
  copyBtn.addEventListener('click', () =>
    exportWith(copyBtn, async (png) => {
      try {
        await api.invoke('recap:copy', png);
        ok(t('recap.copied'), t('recap.copiedText'));
      } catch (err) {
        fail(t('recap.copyFailed'), err);
      }
    }).catch((err) => fail(t('recap.copyFailed'), err)),
  );
  saveBtn.addEventListener('click', () =>
    exportWith(saveBtn, async (png) => {
      try {
        const res = await api.invoke('recap:save', png, t('recap.fileName', { date: isoDate() }));
        if (res?.path) {
          ok(t('recap.saved'), res.path);
          if (alive) showSaved(res.path);
        }
      } catch (err) {
        fail(t('recap.saveFailed'), err);
      }
    }).catch((err) => fail(t('recap.saveFailed'), err)),
  );

  // Sin esperar: openRecap() termina apenas se abre el dialogo y los datos llegan despues
  load().catch((err) => console.error('[recap] carga:', err));
}
