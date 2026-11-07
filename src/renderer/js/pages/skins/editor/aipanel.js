// Creador de skins con IA (se abre desde el editor de skins). El jugador suma hasta 3 imagenes de referencia
// (elegidas, arrastradas o pegadas con Ctrl+V) y/o escribe que quiere; la IA de Venus devuelve una skin de 64x64.
// Nada sale de la PC hasta tocar "Generar": las imagenes se achican a <= 640 px y se reencodean como JPEG (se pierden
// los metadatos) antes de mandarse, y la IA de Venus las usa solo para esta consulta.
// Contrato: openAiPanel({ variant, hasContent, getCurrent() -> Uint8ClampedArray(16384), onApply({ px, variant }) }).
// Canales: skinai:status, skinai:generate, skinai:cancel (modules/skinai.js).
import { h, icon, mount, modal, toast, setBusy } from '../../../ui.js';
import { api } from '../../../store.js';
import { t } from '../../../i18n.js';
import { navigate } from '../../../app.js';
import { drawFlat } from '../texture.js';
import { dominantColors, fitSize, base64Bytes, errorKey } from './aiprep.js';

const MAX_REFS = 3;
const MAX_FILE = 20 * 1024 * 1024;
const REF_LIMIT = 105 * 1024; // base64 por imagen (3 caben en el pedido)
const TEXT_MAX = 600;

// Achica y reencodea una imagen elegida por el jugador. Devuelve { dataUrl, colors }.
async function prepareImage(file) {
  if (!file || !String(file.type).startsWith('image/') || file.size > MAX_FILE) throw Object.assign(new Error('badImage'), { code: 'skinai:badImage' });
  let bmp;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    throw Object.assign(new Error('badImage'), { code: 'skinai:badImage' });
  }
  try {
    let max = 640;
    let quality = 0.85;
    let dataUrl = '';
    for (let i = 0; i < 6; i++) {
      const { w, h: hh } = fitSize(bmp.width, bmp.height, max);
      const c = document.createElement('canvas');
      c.width = w;
      c.height = hh;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, hh);
      ctx.drawImage(bmp, 0, 0, w, hh);
      dataUrl = c.toDataURL('image/jpeg', quality);
      if (base64Bytes(dataUrl) <= REF_LIMIT) break;
      max = Math.round(max * 0.8);
      quality = Math.max(0.6, quality - 0.07);
    }
    if (base64Bytes(dataUrl) > REF_LIMIT) throw Object.assign(new Error('bigImage'), { code: 'skinai:bigImage' });
    const { w, h: hh } = fitSize(bmp.width, bmp.height, 96);
    const s = document.createElement('canvas');
    s.width = w;
    s.height = hh;
    const sctx = s.getContext('2d', { willReadFrequently: true });
    sctx.drawImage(bmp, 0, 0, w, hh);
    return { dataUrl, colors: dominantColors(sctx.getImageData(0, 0, w, hh).data, 6) };
  } finally {
    bmp.close?.();
  }
}

// La skin actual agrandada 8 veces (PNG) para que la IA la vea al retocarla
function enlarge(px) {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(px), 64, 64), 0, 0);
  const big = document.createElement('canvas');
  big.width = 512;
  big.height = 512;
  const ctx = big.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#c8c8c8';
  ctx.fillRect(0, 0, 512, 512);
  ctx.drawImage(c, 0, 0, 512, 512);
  return big.toDataURL('image/png');
}

function canvasOf(px) {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(px), 64, 64), 0, 0);
  return c;
}

export function openAiPanel({ variant = 'classic', hasContent = false, getCurrent, onApply }) {
  const S = { refs: [], variant, outer: true, mode: 'create', busy: false, result: null, available: null, closed: false };
  let nextId = 1;

  // ---------- Referencias ----------
  const file = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true, onchange: (e) => addFiles([...e.target.files]).finally(() => (e.target.value = '')) });
  const refList = h('div', { class: 'se-ai-refs' });
  const refErr = h('div', { class: 'field-error', role: 'alert', hidden: true }, icon('alert'), h('span', {}));
  const addBtn = h('button', { type: 'button', class: 'btn tonal sm', onclick: () => file.click() }, icon('image'), t('skineditor.aiAddImages'));
  const drop = h('div', { class: 'se-ai-drop', tabindex: '0', role: 'group', 'aria-label': t('skineditor.aiRefsLabel') }, refList, h('div', { class: 'se-ai-drop-hint muted' }, t('skineditor.aiRefsHint', { max: MAX_REFS })), addBtn);

  function showRefErr(text) {
    refErr.hidden = !text;
    refErr.querySelector('span').textContent = text || '';
  }

  async function addFiles(files) {
    showRefErr('');
    const images = files.filter((f) => String(f.type).startsWith('image/'));
    if (!images.length) return showRefErr(t('skineditor.aiErr_badImage'));
    for (const f of images) {
      if (S.refs.length >= MAX_REFS) {
        showRefErr(t('skineditor.aiRefsFull', { max: MAX_REFS }));
        break;
      }
      try {
        const r = await prepareImage(f);
        S.refs.push({ id: nextId++, ...r, name: String(f.name || '').slice(0, 60) });
      } catch (err) {
        showRefErr(t(errorKey(err) || 'skineditor.aiErr_badImage'));
      }
    }
    drawRefs();
    sync();
  }

  function drawRefs() {
    refList.replaceChildren(
      ...S.refs.map((r) =>
        h(
          'div',
          { class: 'se-ai-ref' },
          h('img', { src: r.dataUrl, alt: r.name || t('skineditor.aiRefAlt') }),
          h('div', { class: 'se-ai-swatches', 'aria-hidden': 'true' }, r.colors.slice(0, 5).map((c) => h('span', { style: { background: c } }))),
          h('button', { type: 'button', class: 'icon-btn sm se-ai-ref-x', title: t('skineditor.aiRemoveImage'), 'aria-label': t('skineditor.aiRemoveImage'), onclick: () => {
            S.refs = S.refs.filter((x) => x.id !== r.id);
            showRefErr('');
            drawRefs();
            sync();
          } }, icon('x')),
        ),
      ),
    );
  }

  drop.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types?.includes('Files')) {
      e.preventDefault();
      drop.classList.add('over');
    }
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    addFiles([...(e.dataTransfer?.files || [])]);
  });
  const onPaste = (e) => {
    const files = [...(e.clipboardData?.files || [])].filter((f) => String(f.type).startsWith('image/'));
    if (!files.length || S.busy) return;
    e.preventDefault();
    addFiles(files);
  };
  document.addEventListener('paste', onPaste);

  // ---------- Pedido ----------
  const textId = `se-ai-text-${Date.now().toString(36)}`;
  const text = h('textarea', { class: 'input se-ai-text', id: textId, rows: 4, maxlength: TEXT_MAX, placeholder: t('skineditor.aiPlaceholder'), oninput: () => sync() });
  const count = h('span', { class: 'muted num se-ai-count' });
  const variants = ['classic', 'slim'].map((v) =>
    h('button', { type: 'button', class: 'chip', role: 'radio', 'aria-checked': String(v === S.variant), dataset: { v }, onclick: () => {
      S.variant = v;
      sync();
    } }, t(`skineditor.aiVariant_${v}`)),
  );
  const modes = ['create', 'edit'].map((m) =>
    h('button', { type: 'button', class: 'chip', role: 'radio', 'aria-checked': String(m === S.mode), dataset: { m }, onclick: () => {
      S.mode = m;
      sync();
    } }, t(`skineditor.aiMode_${m}`)),
  );
  const outerBox = h('input', { type: 'checkbox', checked: true, onchange: () => {
    S.outer = outerBox.checked;
  } });
  const modeRow = h('div', { class: 'se-ai-row', hidden: !hasContent }, h('span', { class: 'se-h' }, t('skineditor.aiModeLabel')), h('div', { class: 'chips', role: 'radiogroup', 'aria-label': t('skineditor.aiModeLabel') }, modes));
  const variantRow = h('div', { class: 'se-ai-row' }, h('span', { class: 'se-h' }, t('skineditor.aiModelLabel')), h('div', { class: 'chips', role: 'radiogroup', 'aria-label': t('skineditor.aiModelLabel') }, variants));
  const outerRow = h('label', { class: 'se-ai-check' }, outerBox, h('span', {}, t('skineditor.aiOuter')));

  // ---------- Estado, resultado y errores ----------
  const notice = h('div', { class: 'notice info', hidden: true }, icon('info'), h('span', {}));
  const errBox = h('div', { class: 'notice bad', role: 'alert', hidden: true }, icon('alert'), h('span', {}));
  const result = h('div', { class: 'se-ai-result', hidden: true });
  const working = h('div', { class: 'se-ai-working', role: 'status', hidden: true }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('span', {}, t('skineditor.aiWorking')), h('button', { type: 'button', class: 'btn ghost sm', onclick: () => api.invoke('skinai:cancel').catch(() => {}) }, t('skineditor.aiCancelRun')));

  const body = h(
    'div',
    { class: 'se-ai' },
    notice,
    modeRow,
    h('h4', { class: 'se-h' }, t('skineditor.aiRefsTitle')),
    drop,
    refErr,
    file,
    h('label', { class: 'se-h', for: textId }, t('skineditor.aiTextLabel')),
    text,
    h('div', { class: 'se-ai-meta' }, h('span', { class: 'muted' }, t('skineditor.aiPrivacy')), count),
    variantRow,
    outerRow,
    errBox,
    working,
    result,
  );

  const generateBtn = h('button', { type: 'button', class: 'btn primary', onclick: () => generate() }, icon('sparkles'), t('skineditor.aiGenerate'));
  const applyBtn = h('button', { type: 'button', class: 'btn primary', hidden: true, onclick: () => apply() }, icon('check'), t('skineditor.aiApply'));
  const closeBtn = h('button', { type: 'button', class: 'btn ghost', onclick: () => close() }, t('skineditor.cancel'));
  const m = modal({ title: t('skineditor.aiTitle'), subtitle: t('skineditor.aiSubtitle'), icon: 'sparkles', size: 'wide', body, footer: [closeBtn, h('span', { class: 'spacer' }), applyBtn, generateBtn], onClose: () => cleanup() });

  function cleanup() {
    S.closed = true;
    document.removeEventListener('paste', onPaste);
    if (S.busy) api.invoke('skinai:cancel').catch(() => {});
  }
  function close() {
    m.close();
  }

  function showError(err) {
    const key = errorKey(err);
    const msg = key ? t(key) : String(err?.message || t('skineditor.aiErr_generic'));
    errBox.hidden = false;
    errBox.querySelector('span').textContent = msg;
  }

  function sync() {
    if (S.closed) return;
    variants.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.v === S.variant)));
    modes.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.m === S.mode)));
    count.textContent = `${text.value.length}/${TEXT_MAX}`;
    const editing = S.mode === 'edit' && hasContent;
    const filled = text.value.trim().length >= (editing ? 1 : 3) || (!editing && S.refs.length > 0);
    generateBtn.disabled = S.busy || S.available === false || !filled;
    generateBtn.lastChild.textContent = S.result ? t('skineditor.aiRetry') : t('skineditor.aiGenerate');
    addBtn.disabled = S.busy || S.refs.length >= MAX_REFS;
    text.disabled = S.busy;
    variantRow.hidden = editing;
    applyBtn.hidden = !S.result;
    working.hidden = !S.busy;
    if (S.available === false) {
      notice.hidden = false;
      notice.querySelector('span').textContent = t('skineditor.aiNeedsPlan');
    } else notice.hidden = true;
  }

  async function generate() {
    if (S.busy) return;
    errBox.hidden = true;
    const editing = S.mode === 'edit' && hasContent;
    const current = editing ? new Uint8Array(getCurrent()) : null;
    S.busy = true;
    const done = setBusy(generateBtn);
    sync();
    try {
      const hints = [];
      for (const r of S.refs) for (const c of r.colors) if (!hints.includes(c) && hints.length < 12) hints.push(c);
      const res = await api.invoke('skinai:generate', {
        images: editing ? [] : S.refs.map((r) => r.dataUrl),
        text: text.value,
        variant: editing ? variant : S.variant,
        outer: S.outer,
        mode: editing ? 'edit' : 'create',
        current: current || undefined,
        currentImage: current ? enlarge(current) : undefined,
        hints,
      });
      if (S.closed) return;
      S.result = { px: new Uint8ClampedArray(res.rgba), notes: String(res.notes || ''), variant: editing ? variant : S.variant };
      drawResult();
    } catch (err) {
      if (S.closed) return;
      if (err?.code !== 'skinai:cancelled') {
        showError(err);
        if (err?.code === 'noplan' || err?.code === 'quota') import('../../../features/plans.js').then((x) => x.openPlans?.({ reason: err.code === 'quota' ? 'quota' : 'needsPlan' })).catch(() => navigate('settings/plan'));
        else if (err?.code === 'unavailable' || err?.code === 'session') {
          S.available = false;
        }
      }
    } finally {
      S.busy = false;
      done();
      sync();
    }
  }

  function drawResult() {
    const skin = canvasOf(S.result.px);
    const front = h('canvas', { class: 'se-ai-view', 'aria-hidden': 'true' });
    const back = h('canvas', { class: 'se-ai-view', 'aria-hidden': 'true' });
    drawFlat(front, skin, S.result.variant, { side: 'front', scale: 6 });
    drawFlat(back, skin, S.result.variant, { side: 'back', scale: 6 });
    mount(result, h('h4', { class: 'se-h' }, t('skineditor.aiResultTitle')), h('div', { class: 'se-ai-views' }, front, back), S.result.notes ? h('p', { class: 'se-ai-notes' }, S.result.notes) : null, h('p', { class: 'muted' }, t('skineditor.aiResultHint')));
    result.hidden = false;
    result.scrollIntoView?.({ block: 'nearest' });
  }

  function apply() {
    if (!S.result) return;
    onApply({ px: S.result.px, variant: S.result.variant });
    toast('good', t('skineditor.aiApplied'), t('skineditor.aiAppliedText'));
    close();
  }

  // ¿Hay IA disponible? (sesion y IA activada; el plan lo valida el servidor al generar)
  api
    .invoke('skinai:status')
    .then((s) => {
      S.available = Boolean(s?.available);
    })
    .catch(() => {
      S.available = false;
    })
    .finally(sync);
  drawRefs();
  sync();
  return m;
}
