// Caja de herramientas (3.1, #/tools): conversor Nether <-> Overworld, stacks y cofres, orden de encantamientos en
// el yunque, ticks <-> segundos <-> hora del dia, vista previa de codigos de color § y bloque <-> chunk <-> region.
// Todo es local, sin red; las cuentas viven en pages/tools/calc.js (con pruebas en pages/tools/test/).
import { h, icon, mount, switchEl, copyText } from '../ui.js';
import { t, locale } from '../i18n.js';
import * as calc from './tools/calc.js';

const T = (key, vars) => t(`tools.${key}`, vars);
const n = (v) => {
  const x = Number(String(v ?? '').replace(',', '.'));
  return Number.isFinite(x) ? x : 0;
};
const fmt = (v, digits = 2) => {
  try {
    return new Intl.NumberFormat(locale(), { maximumFractionDigits: digits }).format(v);
  } catch {
    return String(v);
  }
};

// ---------- Piezas ----------
function card(iconName, title, sub, ...children) {
  return h('section', { class: 'card tools-card' }, h('h2', { class: 'card-title' }, icon(iconName), h('span', {}, title)), h('p', { class: 'card-sub' }, sub), ...children);
}

function field(label, input, cls) {
  return h('label', { class: ['tools-field', cls] }, h('span', { class: 'tools-label' }, label), input);
}

function numInput(value, onInput, { step = 1, min, max, placeholder = '0', label } = {}) {
  const el = h('input', { type: 'number', class: 'input tools-num', value: String(value), step, min, max, placeholder, inputmode: 'decimal', 'aria-label': label });
  el.addEventListener('input', () => onInput(el));
  return el;
}

function select(options, value, onChange, label) {
  const el = h('select', { class: 'select', 'aria-label': label }, options.map(([v, text]) => h('option', { value: v, selected: String(v) === String(value) }, text)));
  el.addEventListener('change', () => onChange(el.value));
  return el;
}

function segmented(options, value, onChange, label) {
  const buttons = options.map(([v, text]) => h('button', { type: 'button', dataset: { value: v }, 'aria-pressed': String(v === value), class: v === value ? 'active' : '', onclick: () => pick(v) }, text));
  const el = h('div', { class: 'segmented', role: 'group', 'aria-label': label }, buttons);
  function pick(v) {
    for (const b of buttons) {
      const on = b.dataset.value === v;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    }
    onChange(v);
  }
  return el;
}

const resultBox = () => h('div', { class: 'tools-result', role: 'status', 'aria-live': 'polite' });
const line = (...parts) => h('div', { class: 'tools-line' }, ...parts);
const big = (text) => h('div', { class: 'tools-big' }, text);

// ---------- Nether <-> Overworld ----------
function netherCard() {
  const ow = { x: 1000, y: 64, z: -250 };
  const nt = calc.toNether(ow).block;
  const inputs = {};
  const exact = { ow: h('div', { class: 'small muted tools-exact' }), nt: h('div', { class: 'small muted tools-exact' }) };
  const mk = (dim, axis) => numInput(dim === 'ow' ? ow[axis] : nt[axis], () => recalc(dim), { label: `${dim === 'ow' ? T('dimOverworld') : T('dimNether')} ${T(`coord${axis.toUpperCase()}`)}` });
  for (const axis of ['x', 'y', 'z']) {
    inputs[`ow${axis}`] = mk('ow', axis);
    inputs[`nt${axis}`] = mk('nt', axis);
  }
  function recalc(from) {
    const src = { x: n(inputs[`${from}x`].value), y: n(inputs[`${from}y`].value), z: n(inputs[`${from}z`].value) };
    const to = from === 'ow' ? 'nt' : 'ow';
    const r = from === 'ow' ? calc.toNether(src) : calc.toOverworld(src);
    for (const axis of ['x', 'y', 'z']) inputs[`${to}${axis}`].value = String(r.block[axis]);
    exact[to].textContent = Number.isInteger(r.exact.x) && Number.isInteger(r.exact.z) ? '' : T('netherExact', { x: fmt(r.exact.x), z: fmt(r.exact.z) });
    exact[from].textContent = '';
  }
  const col = (dim) =>
    h(
      'div',
      { class: 'tools-dim' },
      h('div', { class: 'tools-dim-title' }, icon(dim === 'ow' ? 'sun' : 'flame'), T(dim === 'ow' ? 'dimOverworld' : 'dimNether')),
      h('div', { class: 'tools-xyz' }, ['x', 'y', 'z'].map((axis) => field(T(`coord${axis.toUpperCase()}`), inputs[`${dim}${axis}`]))),
      exact[dim],
    );
  return card('flame', T('netherTitle'), T('netherSub'), h('div', { class: 'tools-dims' }, col('ow'), h('div', { class: 'tools-arrows', 'aria-hidden': 'true' }, '⇄'), col('nt')), h('div', { class: 'tools-tip' }, icon('info'), h('span', {}, T('netherTip'))));
}

// ---------- Stacks y cofres ----------
function stacksCard() {
  let size = 64;
  const out = resultBox();
  const outRev = resultBox();
  const items = numInput(1000, () => draw(), { min: 0, label: T('items') });
  const stacks = numInput(15, () => drawRev(), { min: 0, label: T('stacks') });
  const rest = numInput(40, () => drawRev(), { min: 0, label: T('rest') });
  const sizeSel = select([[64, T('stack64')], [16, T('stack16')], [1, T('stack1')]], size, (v) => {
    size = Number(v);
    draw();
    drawRev();
  }, T('stackSize'));
  function draw() {
    const r = calc.stacksOf(n(items.value), size);
    mount(
      out,
      big(T('stacksResult', { stacks: fmt(r.stacks, 0), rest: fmt(r.rest, 0) })),
      line(h('span', { class: 'chip' }, T('stacksSlots', { count: r.slots })), h('span', { class: 'chip' }, T('chestsSingle', { count: r.singleChests })), h('span', { class: 'chip' }, T('chestsDouble', { count: r.doubleChests })), h('span', { class: 'chip' }, T('shulkers', { count: r.shulkers }))),
    );
  }
  function drawRev() {
    mount(outRev, big(T('itemsResult', { count: calc.itemsOf(n(stacks.value), n(rest.value), size) })));
  }
  draw();
  drawRev();
  return card(
    'box',
    T('stacksTitle'),
    T('stacksSub'),
    h('div', { class: 'tools-row' }, field(T('items'), items), field(T('stackSize'), sizeSel, 'grow')),
    out,
    h('div', { class: 'tools-sub-title' }, T('reverseTitle')),
    h('div', { class: 'tools-row' }, field(T('stacks'), stacks), field(T('rest'), rest)),
    outRev,
  );
}

// ---------- Yunque ----------
function anvilCard() {
  let kind = 'sword';
  let work = 0;
  const chosen = new Map(); // id -> nivel
  const list = h('div', { class: 'tools-books' });
  const out = resultBox();
  const enchantName = (id) => T(`e_${id}`);
  const bookLabel = (enchants) => enchants.map((e) => `${enchantName(e.id)} ${calc.roman(e.level)}`).join(', ');
  const sideLabel = (side) => (side.label === 'item' ? `${T(`kind_${kind}`)}${side.enchants.length ? ` (${bookLabel(side.enchants)})` : ''}` : `${T('anvilBook')} (${bookLabel(side.enchants)})`);

  function drawList() {
    mount(
      list,
      calc.enchantsFor(kind).map((id) => {
        const info = calc.ENCHANTS[id];
        const on = chosen.has(id);
        const cb = h('input', { type: 'checkbox', checked: on, 'aria-label': enchantName(id) });
        const lvl = select(
          Array.from({ length: info.max }, (_, i) => [i + 1, calc.roman(i + 1)]),
          chosen.get(id) || info.max,
          (v) => {
            if (chosen.has(id)) chosen.set(id, Number(v));
            draw();
          },
          `${enchantName(id)}: ${T('anvilBook')}`,
        );
        lvl.classList.add('tools-level');
        lvl.disabled = !on;
        cb.addEventListener('change', () => {
          if (cb.checked) chosen.set(id, Number(lvl.value));
          else chosen.delete(id);
          lvl.disabled = !cb.checked;
          draw();
        });
        return h('label', { class: ['tools-book', on && 'on'] }, cb, h('span', { class: 'tools-book-name' }, enchantName(id)), lvl);
      }),
    );
  }

  function draw() {
    const books = [...chosen].map(([id, level]) => ({ id, level }));
    const r = calc.anvilPlan({ kind, work }, books);
    const nodes = [];
    for (const [a, b] of r.conflicts) nodes.push(h('div', { class: 'notice warn' }, icon('alert'), h('div', {}, T('anvilConflict', { a: enchantName(a), b: enchantName(b) }))));
    if (!r.ok) {
      nodes.push(h('div', { class: 'muted small' }, T('anvilEmpty')));
      mount(out, ...nodes);
      return;
    }
    nodes.push(
      h(
        'ol',
        { class: 'tools-steps' },
        r.steps.map((s, i) =>
          h(
            'li',
            { class: ['tools-step', s.cost > calc.ANVIL_MAX_COST && 'bad'] },
            h('span', { class: 'tools-step-n' }, T('anvilStep', { n: i + 1 })),
            h('span', { class: 'tools-step-text' }, h('strong', {}, sideLabel(s.left)), ' + ', h('strong', {}, sideLabel(s.right))),
            h('span', { class: 'chip' }, T('anvilCost', { count: s.cost })),
          ),
        ),
      ),
      big(T('anvilTotal', { total: r.total, max: r.maxStep })),
    );
    if (r.tooExpensive) nodes.push(h('div', { class: 'notice bad' }, icon('alert'), h('div', {}, T('anvilTooExpensive'))));
    mount(out, ...nodes);
  }

  const kindSel = select(calc.ITEM_KINDS.map((k) => [k, T(`kind_${k}`)]), kind, (v) => {
    kind = v;
    for (const id of [...chosen.keys()]) if (!calc.ENCHANTS[id].kinds.includes(kind)) chosen.delete(id);
    drawList();
    draw();
  }, T('itemKind'));
  const workIn = numInput(0, (el) => {
    work = Math.max(0, Math.min(10, Math.floor(n(el.value))));
    draw();
  }, { min: 0, max: 10, label: T('itemWork') });
  // Un par de libros marcados de entrada para que se vea como funciona.
  chosen.set('sharpness', 5);
  chosen.set('unbreaking', 3);
  drawList();
  draw();
  return card(
    'hammer',
    T('anvilTitle'),
    T('anvilSub'),
    h('div', { class: 'tools-row' }, field(T('itemKind'), kindSel), field(T('itemWork'), workIn, 'grow')),
    h('div', { class: 'tools-sub-title' }, T('books')),
    list,
    out,
    h('div', { class: 'tools-tip' }, icon('info'), h('span', {}, T('anvilPenaltyNote'))),
  );
}

// ---------- Ticks, segundos y hora del dia ----------
function ticksCard() {
  const out = resultBox();
  const ticks = numInput(6000, () => fromTicks(), { min: 0, label: T('ticks') });
  const seconds = numInput(300, () => fromSeconds(), { min: 0, step: 'any', label: T('seconds') });
  const clock = h('input', { type: 'time', class: 'input tools-time', value: '12:00', 'aria-label': T('clock') });
  clock.addEventListener('input', () => {
    const tk = calc.clockToTicks(clock.value);
    if (tk === null) return;
    ticks.value = String(tk);
    seconds.value = String(calc.ticksToSeconds(tk));
    draw(tk);
  });
  function fromTicks() {
    const tk = Math.max(0, Math.floor(n(ticks.value)));
    seconds.value = String(calc.ticksToSeconds(tk));
    const c = calc.ticksToClock(tk);
    clock.value = c.clock;
    draw(tk);
  }
  function fromSeconds() {
    const tk = calc.secondsToTicks(Math.max(0, n(seconds.value)));
    ticks.value = String(tk);
    clock.value = calc.ticksToClock(tk).clock;
    draw(tk);
  }
  function draw(tk) {
    const c = calc.ticksToClock(tk);
    const cmd = `/time set ${c.inDay}`;
    mount(
      out,
      big(T('ticksEquals', { ticks: fmt(tk, 0), seconds: fmt(calc.ticksToSeconds(tk)), minutes: fmt(calc.ticksToSeconds(tk) / 60) })),
      line(h('span', {}, T('dayTime', { clock: c.clock, day: c.day + 1, phase: T(`phase_${calc.dayPhase(tk)}`) }))),
      line(h('span', { class: 'tools-label' }, T('command')), h('code', { class: 'kbd tools-cmd' }, cmd), h('button', { type: 'button', class: 'btn sm ghost', onclick: () => copyText(cmd, T('copied')) }, icon('copy'), T('copy'))),
    );
  }
  const presets = h(
    'div',
    { class: 'tools-presets' },
    calc.TIME_PRESETS.map(([id, tk]) =>
      h(
        'button',
        {
          type: 'button',
          class: 'btn sm',
          onclick: () => {
            ticks.value = String(tk);
            fromTicks();
          },
        },
        T(`preset_${id}`),
        h('span', { class: 'muted small' }, ` ${tk}`),
      ),
    ),
  );
  fromTicks();
  return card('clock', T('ticksTitle'), T('ticksSub'), h('div', { class: 'tools-row' }, field(T('ticks'), ticks), field(T('seconds'), seconds), field(T('clock'), clock)), out, h('div', { class: 'tools-sub-title' }, T('presets')), presets);
}

// ---------- Codigos de color ----------
function colorsCard() {
  let alt = true;
  const input = h('input', { type: 'text', class: 'input mono', value: T('colorsPlaceholder'), placeholder: T('colorsPlaceholder'), 'aria-label': T('colorsInput'), spellcheck: 'false', maxlength: 400 });
  const preview = h('div', { class: 'tools-mc', role: 'status', 'aria-live': 'polite' });
  const plain = h('div', { class: 'small muted' });
  function draw() {
    const parts = calc.parseColorCodes(input.value, { alt });
    mount(
      preview,
      parts.length
        ? parts.map((p) =>
            h(
              'span',
              {
                class: ['tools-mc-run', p.bold && 'b', p.italic && 'i', p.underline && 'u', p.strike && 's', p.obfuscated && 'k'],
                style: p.color ? { color: p.color, '--mc-shadow': `${p.color}55` } : null,
              },
              p.text,
            ),
          )
        : h('span', { class: 'tools-mc-run muted' }, ' '),
    );
    plain.textContent = T('colorsPlain', { text: calc.stripColorCodes(input.value, { alt }) });
  }
  input.addEventListener('input', draw);
  const insert = (code) => {
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    input.value = `${input.value.slice(0, start)}§${code}${input.value.slice(end)}`;
    input.focus();
    input.setSelectionRange(start + 2, start + 2);
    draw();
  };
  const palette = h(
    'div',
    { class: 'tools-palette', role: 'group', 'aria-label': T('colorsPalette') },
    Object.entries(calc.COLOR_CODES).map(([code, hex]) => h('button', { type: 'button', class: 'tools-swatch', style: { background: hex }, title: `§${code} ${hex}`, 'aria-label': T('colorInsert', { code }), onclick: () => insert(code) }, h('span', {}, code))),
  );
  const formats = h(
    'div',
    { class: 'tools-formats', role: 'group', 'aria-label': T('colorsFormats') },
    [...Object.keys(calc.FORMAT_CODES), 'r'].map((code) => h('button', { type: 'button', class: 'btn sm ghost', title: T('colorInsert', { code }), onclick: () => insert(code) }, h('code', { class: 'kbd' }, `§${code}`), ' ', T(`fmt_${code}`))),
  );
  const altSwitch = switchEl(alt, (v) => {
    alt = v;
    draw();
  }, T('colorsAlt'));
  draw();
  return card(
    'palette',
    T('colorsTitle'),
    T('colorsSub'),
    field(T('colorsInput'), input, 'grow'),
    h('div', { class: 'toggle-row tools-toggle' }, h('div', { class: 'tr-text' }, h('div', { class: 'tr-title' }, T('colorsAlt'))), altSwitch),
    h('div', { class: 'tools-label' }, T('colorsPreview')),
    preview,
    plain,
    h('div', { class: 'tools-label' }, T('colorsPalette')),
    palette,
    h('div', { class: 'tools-label' }, T('colorsFormats')),
    formats,
  );
}

// ---------- Bloque <-> chunk <-> region ----------
function chunksCard() {
  let mode = 'block';
  const out = resultBox();
  const x = numInput(100, () => draw(), { label: T('coordX') });
  const z = numInput(-1, () => draw(), { label: T('coordZ') });
  const labels = { block: T('blockLabel'), chunk: T('chunkLabel'), region: T('regionLabel') };
  const head = h('div', { class: 'tools-label' });
  const pair = (p) => `${fmt(p.x, 0)}, ${fmt(p.z, 0)}`;
  function draw() {
    head.textContent = labels[mode];
    const nodes = [];
    if (mode === 'region') {
      const r = calc.regionToBlocks(n(x.value), n(z.value));
      nodes.push(big(T('regionResult', { x: r.region.x, z: r.region.z, file: r.region.file })), line(T('chunksRange', { fx: r.chunks.from.x, fz: r.chunks.from.z, tx: r.chunks.to.x, tz: r.chunks.to.z })), line(T('blocksRange', { fx: fmt(r.blocks.from.x, 0), fz: fmt(r.blocks.from.z, 0), tx: fmt(r.blocks.to.x, 0), tz: fmt(r.blocks.to.z, 0) })));
    } else {
      const r = mode === 'block' ? calc.blockToChunk(n(x.value), n(z.value)) : calc.chunkToBlocks(n(x.value), n(z.value));
      nodes.push(big(T('chunkResult', { x: r.chunk.x, z: r.chunk.z })), line(T('blocksRange', { fx: fmt(r.chunk.from.x, 0), fz: fmt(r.chunk.from.z, 0), tx: fmt(r.chunk.to.x, 0), tz: fmt(r.chunk.to.z, 0) })));
      if (mode === 'block') nodes.push(line(T('localResult', { x: r.local.x, z: r.local.z })));
      nodes.push(line(h('span', {}, T('regionResult', { x: r.region.x, z: r.region.z, file: r.region.file })), h('span', { class: 'muted small' }, ` · ${T('blocksRange', { fx: fmt(r.region.from.x, 0), fz: fmt(r.region.from.z, 0), tx: fmt(r.region.to.x, 0), tz: fmt(r.region.to.z, 0) })}`)));
    }
    mount(out, ...nodes);
  }
  const modes = segmented([['block', T('modeBlock')], ['chunk', T('modeChunk')], ['region', T('modeRegion')]], mode, (v) => {
    mode = v;
    draw();
  }, T('chunksTitle'));
  draw();
  return card('grid', T('chunksTitle'), T('chunksSub'), modes, head, h('div', { class: 'tools-row' }, field(T('coordX'), x), field(T('coordZ'), z)), out, h('div', { class: 'small muted' }, `${labels.block}: ${pair({ x: 0, z: 0 })} → ${labels.chunk} 0, 0 → r.0.0.mca`));
}

export default {
  ns: ['tools'],
  css: ['pages/tools'],
  render(root) {
    mount(
      root,
      h(
        'div',
        { class: 'tools-page' },
        h('header', { class: 'page-head' }, h('div', { class: 'ph-text' }, h('h1', { class: 'page-title' }, T('title')), h('p', { class: 'page-sub' }, T('subtitle')))),
        h('div', { class: 'tools-grid' }, netherCard(), stacksCard(), anvilCard(), ticksCard(), colorsCard(), chunksCard()),
      ),
    );
    return () => {};
  },
};
