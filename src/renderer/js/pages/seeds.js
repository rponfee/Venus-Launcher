// Visor de semillas (#/seeds[/<semilla>]): biomas y estructuras de un mundo antes de crearlo. Todo se calcula en la PC, sin
// red: el generador es un port de cubiomes (pages/seeds/gen/, con pruebas en pages/seeds/test/) y corre en Workers.
import { h, icon, mount, modal, copyText, selectEl, switchEl } from '../ui.js';
import { store } from '../store.js';
import { t, locale } from '../i18n.js';
import { navigate } from '../app.js';
import { SeedMap } from './seeds/map.js';
import { STRUCT_STYLE } from './seeds/icons.js';
import { parseSeed, randomSeed } from './seeds/gen/rng.js';
import { VERSIONS, versionByKey, versionForGame } from './seeds/gen/versions.js';
import { BIOME_KEYS, BIOME_CSS } from './seeds/gen/biomes.js';
import { typesFor } from './seeds/gen/structures.js';

const T = (key, vars) => t(`seeds.${key}`, vars);
const DIMS = [
  { id: 0, key: 'dim_overworld', icon: 'sun' },
  { id: -1, key: 'dim_nether', icon: 'flame' },
  { id: 1, key: 'dim_end', icon: 'moon' },
];
// Alturas en celdas 1:4: las mismas con las que se comparo contra cubiomes
const HEIGHTS = [
  { y: 79, key: 'y_surface' },
  { y: 15, key: 'y_sea' },
  { y: 0, key: 'y_caves' },
  { y: -12, key: 'y_deep' },
];

const fmtInt = (n) => Math.round(n).toLocaleString(locale());
const biomeName = (id) => {
  const key = BIOME_KEYS.get(id);
  return key ? T(`b_${key}`) : T('unknownBiome');
};

// Lo ultimo que se miro, para volver a la pagina sin perderlo. Las camaras de desafio arrancan apagadas: hay muchisimas
const session = { text: null, version: null, dim: 0, y: 79, off: new Set(['trial_chambers']), slime: false, doubt: true };

function initialVersion() {
  if (session.version) return session.version;
  const inst = store.selectedInstance?.();
  return versionForGame(inst?.mcVersion)?.key || VERSIONS[0].key;
}

function markerName(m) {
  if (m.kind === 'spawn') return T('spawnApprox');
  return T(`s_${m.type}`);
}

function tpCommand(m) {
  return `/tp @s ${m.x} ~ ${m.z}`;
}

export default {
  ns: ['seeds'],
  css: ['pages/seeds'],
  render(root, params) {
    const st = {
      text: params[0] ?? session.text ?? String(randomSeed()),
      parsed: null,
      version: initialVersion(),
      dim: session.dim,
      y: session.y,
      off: session.off,
      slime: session.slime,
      doubt: session.doubt,
    };

    const seedInput = h('input', { class: 'input mono sd-seed', id: 'sd-seed', type: 'text', value: st.text, spellcheck: 'false', autocomplete: 'off', placeholder: T('seedPlaceholder'), 'aria-describedby': 'sd-seed-info', maxlength: 400 });
    const seedInfo = h('div', { class: 'field-help sd-seed-info', id: 'sd-seed-info' });

    const map = new SeedMap({
      onHover: (cell) => drawHover(cell),
      onSelect: (marker) => drawPop(marker),
      onView: (view) => drawSummary(view),
    });

    // ---------- Semilla ----------
    let seedTimer = 0;
    function readSeed() {
      clearTimeout(seedTimer);
      st.text = seedInput.value;
      session.text = st.text;
      const parsed = parseSeed(st.text);
      seedInput.setAttribute('aria-invalid', parsed ? 'false' : 'true');
      if (!parsed) {
        st.parsed = null;
        seedInfo.textContent = T('seedEmpty');
        return;
      }
      seedInfo.textContent = parsed.fromText ? T('seedFromText', { seed: String(parsed.seed) }) : T('seedNumeric', { seed: String(parsed.seed) });
      if (st.parsed === parsed.seed) return;
      st.parsed = parsed.seed;
      applyWorld();
    }
    seedInput.addEventListener('input', () => {
      clearTimeout(seedTimer);
      seedTimer = setTimeout(readSeed, 450);
    });
    seedInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      clearTimeout(seedTimer);
      readSeed();
    });
    const randomBtn = h(
      'button',
      {
        class: 'btn',
        type: 'button',
        onclick: () => {
          seedInput.value = String(randomSeed());
          readSeed();
        },
      },
      icon('sparkles'),
      T('random'),
    );
    const copyBtn = h(
      'button',
      {
        class: 'btn ghost',
        type: 'button',
        onclick: () => {
          readSeed();
          if (st.parsed !== null) copyText(String(st.parsed), T('seedCopied'));
        },
      },
      icon('copy'),
      T('copy'),
    );

    // ---------- Version, dimension y altura ----------
    const versionSel = selectEl(VERSIONS.map((v) => ({ value: v.key, label: v.label })), st.version, (value) => {
      st.version = value;
      session.version = value;
      drawNotes();
      drawFilters();
      applyWorld();
    });
    versionSel.id = 'sd-version';

    const heightSel = selectEl(HEIGHTS.map((o) => ({ value: o.y, label: T(o.key) })), st.y, (value) => {
      st.y = Number(value);
      session.y = st.y;
      map.setY(st.y);
    });
    heightSel.id = 'sd-height';
    const heightField = h('div', { class: 'field sd-field-height' }, h('label', { for: 'sd-height' }, T('height')), heightSel);

    const dimButtons = DIMS.map((d) =>
      h(
        'button',
        {
          type: 'button',
          class: d.id === st.dim ? 'active' : '',
          'aria-pressed': String(d.id === st.dim),
          dataset: { dim: String(d.id) },
          onclick: () => setDim(d.id),
        },
        icon(d.icon),
        T(d.key),
      ),
    );
    function setDim(id) {
      if (id === st.dim) return;
      // Entre el Overworld y el Nether las coordenadas cambian por 8; el End no tiene relacion
      if (st.dim === 0 && id === -1) map.rescale(1 / 8);
      else if (st.dim === -1 && id === 0) map.rescale(8);
      st.dim = id;
      session.dim = id;
      for (const b of dimButtons) {
        const on = Number(b.dataset.dim) === id;
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', String(on));
      }
      heightField.hidden = id !== 0;
      drawFilters();
      applyWorld();
    }
    heightField.hidden = st.dim !== 0;

    // ---------- Capas ----------
    const filtersEl = h('div', { class: 'sd-filters' });
    const slimeRow = h('div', { class: 'toggle-row sd-slime-row' }, h('div', { class: 'tr-text' }, h('div', { class: 'tr-title' }, T('slime')), h('div', { class: 'tr-sub' }, T('slimeHint'))), switchEl(st.slime, (on) => {
      st.slime = on;
      session.slime = on;
      map.setSlime(on);
    }, T('slime')));
    const doubtRow = h('div', { class: 'toggle-row sd-slime-row' }, h('div', { class: 'tr-text' }, h('div', { class: 'tr-title' }, T('doubtful')), h('div', { class: 'tr-sub' }, T('doubtfulHint'))), switchEl(st.doubt, (on) => {
      st.doubt = on;
      session.doubt = on;
      map.setDoubtful(on);
    }, T('doubtful')));
    const filterChecks = new Map();
    const countEls = new Map();
    const currentTypes = () => [...typesFor(st.dim, versionByKey(st.version).mc), ...(st.dim === 0 ? ['stronghold'] : [])];
    const applyFilters = () => map.setFilters(currentTypes().filter((type) => !st.off.has(type)));

    function drawFilters() {
      filterChecks.clear();
      countEls.clear();
      const types = currentTypes();
      if (!types.length) {
        mount(filtersEl, h('div', { class: 'muted small' }, T('endNoStructures')));
      } else {
        mount(
          filtersEl,
          types.map((type) => {
            const cb = h('input', { type: 'checkbox', checked: !st.off.has(type), 'aria-label': T(`s_${type}`) });
            cb.addEventListener('change', () => {
              if (cb.checked) st.off.delete(type);
              else st.off.add(type);
              applyFilters();
            });
            filterChecks.set(type, cb);
            const count = h('span', { class: 'sd-filter-count' });
            countEls.set(type, count);
            return h('label', { class: 'sd-filter' }, cb, h('span', { class: 'sd-chip', style: { '--sd-c': STRUCT_STYLE[type].color }, 'aria-hidden': 'true' }, icon(`sd-${type}`)), h('span', { class: 'sd-filter-name' }, T(`s_${type}`)), count);
          }),
        );
      }
      slimeRow.hidden = st.dim !== 0;
      doubtRow.hidden = st.dim !== 0;
      allBtn.hidden = !types.length;
      noneBtn.hidden = !types.length;
      applyFilters();
    }
    const setAll = (off) => {
      for (const type of currentTypes()) {
        if (off) st.off.add(type);
        else st.off.delete(type);
        const cb = filterChecks.get(type);
        if (cb) cb.checked = !off;
      }
      applyFilters();
    };
    const allBtn = h('button', { class: 'btn sm ghost', type: 'button', onclick: () => setAll(false) }, T('all'));
    const noneBtn = h('button', { class: 'btn sm ghost', type: 'button', onclick: () => setAll(true) }, T('none'));
    const hiddenNote = h('div', { class: 'small muted sd-hidden-note', hidden: true });

    // ---------- Resumen de la vista ----------
    const legendEl = h('div', { class: 'sd-legend' }, h('div', { class: 'muted small' }, T('legendEmpty')));
    const nearEl = h('div', { class: 'sd-near' });
    let lastLegend = '';
    let lastNear = '';
    function drawSummary(view) {
      const legendKey = view.biomes.join(',');
      if (legendKey !== lastLegend) {
        lastLegend = legendKey;
        mount(legendEl, view.biomes.length ? view.biomes.map((id) => h('div', { class: 'sd-legend-row' }, h('span', { class: 'sd-swatch', style: { background: BIOME_CSS.get(id) || 'transparent' }, 'aria-hidden': 'true' }), h('span', { class: 'ellipsis' }, biomeName(id)))) : h('div', { class: 'muted small' }, T('legendEmpty')));
      }
      for (const [type, el] of countEls) el.textContent = view.counts[type] ? String(view.counts[type]) : '';
      const notes = [];
      if (view.hidden.length) notes.push(T('tooFar', { list: view.hidden.map((type) => T(`s_${type}`)).join(', ') }));
      if (view.strongLoading && !st.off.has('stronghold')) notes.push(T('strongLoading'));
      if (view.slimeTooFar) notes.push(T('slimeTooFar'));
      hiddenNote.hidden = !notes.length;
      hiddenNote.textContent = notes.join(' ');
      const nearKey = view.near.map((m) => m.id).join(',');
      if (nearKey !== lastNear) {
        lastNear = nearKey;
        mount(
          nearEl,
          view.near.length
            ? view.near.map((m) =>
                h(
                  'button',
                  {
                    class: ['sd-near-row', m.doubt && 'doubt'],
                    type: 'button',
                    onclick: () => {
                      map.centerOn(m.x, m.z);
                      map.select(m);
                    },
                  },
                  h('span', { class: 'sd-chip', style: { '--sd-c': STRUCT_STYLE[m.type].color }, 'aria-hidden': 'true' }, icon(`sd-${m.type}`)),
                  h('span', { class: 'sd-near-name ellipsis' }, m.doubt ? T('nameDoubtful', { name: markerName(m) }) : markerName(m)),
                  h('span', { class: 'sd-near-pos' }, `${fmtInt(m.x)}, ${fmtInt(m.z)}`),
                ),
              )
            : h('div', { class: 'muted small' }, T('nearEmpty')),
        );
      }
    }

    // ---------- Bioma bajo el cursor ----------
    const hoverMain = h('span', { class: 'sd-hover-main' });
    const hoverSub = h('span', { class: 'sd-hover-sub' });
    const hoverEl = h('button', { class: 'sd-hover', type: 'button', title: T('copyCoords'), onclick: () => hoverCell && copyText(`${hoverCell.x} ${hoverCell.z}`, T('coordsCopied')) }, hoverMain, hoverSub);
    let hoverCell = null;
    function drawHover(cell) {
      if (cell) hoverCell = cell;
      if (!hoverCell) {
        hoverMain.textContent = T('hoverIdle');
        hoverSub.textContent = '';
        return;
      }
      hoverMain.textContent = T('coords', { x: fmtInt(hoverCell.x), z: fmtInt(hoverCell.z) });
      hoverSub.textContent = hoverCell.biome >= 0 ? biomeName(hoverCell.biome) : T('computingShort');
    }
    drawHover(null);

    // ---------- Panel de una estructura ----------
    function drawPop(m) {
      if (!m) {
        mount(map.pop);
        return;
      }
      const note = m.kind === 'spawn' ? T('noteSpawn') : m.kind === 'stronghold' ? T('noteStronghold') : m.doubt ? T('noteDoubt') : T('noteStruct');
      const sub = m.kind === 'stronghold' ? T('strongholdIndex', { index: m.index }) : m.biome !== undefined ? T('villageOf', { biome: biomeName(m.biome) }) : null;
      mount(
        map.pop,
        h(
          'div',
          { class: 'sd-pop', role: 'dialog', 'aria-label': markerName(m) },
          h(
            'div',
            { class: 'sd-pop-head' },
            h('span', { class: 'sd-chip lg', style: { '--sd-c': STRUCT_STYLE[m.type].color }, 'aria-hidden': 'true' }, icon(`sd-${m.type}`)),
            h('div', { class: 'sd-pop-text' }, h('div', { class: 'sd-pop-title' }, m.doubt ? T('nameDoubtful', { name: markerName(m) }) : markerName(m)), sub ? h('div', { class: 'small muted' }, sub) : null),
            h('button', { class: 'icon-btn sm', type: 'button', title: t('common.close'), 'aria-label': t('common.close'), onclick: () => map.select(null) }, icon('x')),
          ),
          h('div', { class: 'sd-pop-pos' }, T('coords', { x: fmtInt(m.x), z: fmtInt(m.z) })),
          h('code', { class: 'kbd sd-pop-cmd' }, tpCommand(m)),
          h('div', { class: 'sd-pop-actions' }, h('button', { class: 'btn sm tonal', type: 'button', onclick: () => copyText(tpCommand(m), T('tpCopied')) }, icon('copy'), T('copyTp')), h('button', { class: 'btn sm ghost', type: 'button', onclick: () => copyText(`${m.x} ${m.z}`, T('coordsCopied')) }, T('copyCoordsShort'))),
          h('div', { class: 'small muted sd-pop-note' }, note),
        ),
      );
      map.positionPop();
    }

    // ---------- Crear un mundo con esta semilla ----------
    // El launcher no puede crear un mundo de un jugador con semilla: se pega en el juego. El asistente de servidores tiene su
    // propio campo, pero no se puede abrir con la semilla ya puesta.
    function openUseSeed() {
      readSeed();
      if (st.parsed === null) return;
      const v = versionByKey(st.version);
      const seed = String(st.parsed);
      const m = modal({
        title: T('useTitle'),
        subtitle: seed,
        icon: 'globe',
        size: 'sm',
        body: h(
          'div',
          { class: 'sd-use' },
          h('p', { class: 'muted small' }, T('useIntro')),
          h('div', { class: 'sd-use-title' }, T('useSingle')),
          h('ol', { class: 'sd-use-steps' }, h('li', {}, T('useStep1', { version: v.install })), h('li', {}, T('useStep2')), h('li', {}, T('useStep3'))),
          h('div', { class: 'sd-use-title' }, T('useServer')),
          h('p', { class: 'muted small' }, T('useServerText')),
        ),
        footer: [
          h(
            'button',
            {
              class: 'btn ghost',
              type: 'button',
              onclick: () => {
                copyText(seed, T('seedCopied'));
                m.close();
                navigate('servers');
              },
            },
            icon('server'),
            T('useGoServers'),
          ),
          h(
            'button',
            {
              class: 'btn',
              type: 'button',
              onclick: () => {
                copyText(seed, T('seedCopied'));
                m.close();
                navigate(`versions/new/vanilla/${encodeURIComponent(v.install)}`);
              },
            },
            icon('plus'),
            T('useGoInstance', { version: v.install }),
          ),
          h('button', { class: 'btn primary', type: 'button', onclick: () => copyText(seed, T('seedCopied')) }, icon('copy'), T('copySeed')),
        ],
      });
    }

    // ---------- Notas de exactitud ----------
    const versionNote = h('div', { class: 'field-help sd-version-note' });
    function drawNotes() {
      const newest = st.version === VERSIONS[0].key;
      versionNote.textContent = newest ? T('versionNoteNewest') : T('versionNote');
    }
    drawNotes();

    const accuracy = h(
      'details',
      { class: 'sd-accuracy' },
      h('summary', {}, icon('shieldCheck'), T('accTitle')),
      h('ul', {}, ['acc_biomes', 'acc_structs', 'acc_stronghold', 'acc_spawn', 'acc_slime', 'acc_nether', 'acc_end', 'acc_versions', 'acc_limits', 'acc_source'].map((key) => h('li', {}, T(key)))),
    );

    // ---------- Armado ----------
    function applyWorld() {
      if (st.parsed === null) return;
      map.setWorld({ seed: st.parsed, version: st.version, dim: st.dim, y: st.y });
    }

    const useBtn = h('button', { class: 'btn primary', type: 'button', onclick: openUseSeed }, icon('globe'), T('useButton'));
    mount(
      root,
      h(
        'div',
        { class: 'sd-page' },
        h('header', { class: 'page-head' }, h('div', { class: 'ph-text' }, h('h1', { class: 'page-title' }, T('title')), h('p', { class: 'page-sub' }, T('subtitle'))), useBtn),
        h(
          'section',
          { class: 'card sd-controls' },
          h(
            'div',
            { class: 'field sd-field-seed' },
            h('label', { for: 'sd-seed' }, T('seed')),
            h('div', { class: 'sd-seed-row' }, seedInput, randomBtn, copyBtn),
            seedInfo,
          ),
          h('div', { class: 'field sd-field-version' }, h('label', { for: 'sd-version' }, T('version')), versionSel),
          h('div', { class: 'field sd-field-dim' }, h('span', { class: 'label', id: 'sd-dim-label' }, T('dimension')), h('div', { class: 'segmented sd-dims', role: 'group', 'aria-labelledby': 'sd-dim-label' }, dimButtons)),
          heightField,
          versionNote,
        ),
        h(
          'div',
          { class: 'sd-body' },
          h('div', { class: 'sd-main' }, map.el, hoverEl),
          h(
            'aside',
            { class: 'sd-side' },
            h('section', { class: 'card sd-card' }, h('div', { class: 'sd-card-head' }, h('h2', { class: 'card-title' }, icon('filter'), T('filters')), h('div', { class: 'sd-card-actions' }, allBtn, noneBtn)), filtersEl, hiddenNote, doubtRow, slimeRow),
            h('section', { class: 'card sd-card' }, h('h2', { class: 'card-title' }, icon('target'), T('near')), nearEl),
            h('section', { class: 'card sd-card' }, h('h2', { class: 'card-title' }, icon('map'), T('legend')), legendEl),
            h('section', { class: 'card sd-card' }, accuracy),
          ),
        ),
      ),
    );

    map.setSlime(st.slime);
    map.setDoubtful(st.doubt);
    drawFilters();
    map.resize();
    readSeed();

    return () => {
      clearTimeout(seedTimer);
      map.destroy();
    };
  },
};
