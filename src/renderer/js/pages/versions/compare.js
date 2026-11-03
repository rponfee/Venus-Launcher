// Comparar dos instancias lado a lado: version, loader y su version, memoria, Java, mods, shaders y resource
// packs (el mismo listado que usa la pagina de la instancia), con lo distinto resaltado y "Copiar diferencias".
// La logica del diff esta en ./compare-diff.js (pura, con pruebas).
import { h, icon, mount, modal, copyText, selectEl, skeleton, fmtMb, loaderVersionLabel } from '../../ui.js';
import { store, api } from '../../store.js';
import { t, locale } from '../../i18n.js';
import { instanceLoaderKind, sortInstances } from './catalog.js';
import { loaderMeta, instanceBadge, instIcon } from './common.js';
import { curseforgeRecords, entryLabel } from '../instance/records.js';
import { diffLists, compareFields, diffCount, diffText } from './compare-diff.js';

const SECTIONS = ['mods', 'shaderpacks', 'resourcepacks'];
const GC_KEYS = { '': 'gcGlobal', auto: 'gcAuto', aikar: 'gcAikar', zgc: 'gcZgc', g1: 'gcG1', none: 'gcNone' };
const contentCache = new Map(); // "<id>|<carpeta>" -> Promise<[entradas]>

// Lista de contenido de una carpeta como { name, version, file, projectId, modId, enabled } (sin pedir identificacion por hash: es lenta).
function contentEntries(inst, folder) {
  const key = `${inst.id}|${folder}`;
  if (!contentCache.has(key)) {
    const p = api.instances
      .content(inst.id, folder)
      .then((files) => {
        const cf = curseforgeRecords(inst, folder);
        return files.map((f) => entryLabel(f, cf[String(f.file || '').replace(/\.disabled$/, '')] || null));
      })
      .catch((err) => {
        contentCache.delete(key);
        throw err;
      });
    contentCache.set(key, p);
  }
  return contentCache.get(key);
}

function memoryText(inst) {
  const m = inst.memory || {};
  if (m.override) return t('versions.compareMemory', { min: fmtMb(m.min || 0), max: fmtMb(m.max || 0) });
  return t('versions.compareGlobalMemory', { size: fmtMb(store.settings?.memory?.max || 4096) });
}

function fieldsFor(a, b) {
  const field = (key, fn) => ({ key, label: t(`versions.compareField_${key}`), a: fn(a), b: fn(b) });
  const dash = t('versions.compareNone');
  return compareFields([
    field('mc', (i) => i.mcVersion),
    field('loader', (i) => loaderMeta(instanceLoaderKind(i)).name),
    field('loaderVersion', (i) => (i.loader === 'vanilla' ? dash : loaderVersionLabel(i) || i.loaderVersion || dash)),
    field('memory', memoryText),
    field('java', (i) => i.java?.path || t('instance.javaAuto')),
    field('gc', (i) => t(`instance.${GC_KEYS[i.java?.preset || ''] || 'gcGlobal'}`)),
    field('jvm', (i) => i.java?.args || dash),
  ]);
}

function entryCell(item, { kind } = {}) {
  if (!item) return h('td', { class: 'vs-cmp-cell vs-cmp-missing' }, h('span', { class: 'muted' }, t('versions.compareNone')));
  return h(
    'td',
    { class: ['vs-cmp-cell', kind] },
    h('span', { class: 'vs-cmp-name ellipsis', title: item.file }, item.name),
    item.version ? h('span', { class: 'vs-cmp-ver num', title: item.version }, item.version) : null,
    item.enabled === false ? h('span', { class: 'badge vs-cmp-off' }, t('versions.compareDisabled')) : null,
  );
}

function sectionRows(title, diff, names) {
  const rows = [];
  const n = diffCount(diff);
  rows.push(
    h(
      'tr',
      { class: 'vs-cmp-section' },
      h('th', { scope: 'rowgroup', colspan: 3 }, h('div', { class: 'vs-cmp-section-in' }, h('span', { class: 'vs-cmp-section-title' }, title), h('span', { class: ['badge', n ? 'warn' : 'good'] }, n ? t('versions.compareDiffCount', { count: n }) : t('versions.compareSame')))),
    ),
  );
  for (const a of diff.removed) rows.push(h('tr', { class: 'vs-cmp-row diff' }, h('th', { scope: 'row', class: 'vs-cmp-label' }, t('versions.compareOnlyIn', { name: names[0] })), entryCell(a, { kind: 'removed' }), entryCell(null)));
  for (const b of diff.added) rows.push(h('tr', { class: 'vs-cmp-row diff' }, h('th', { scope: 'row', class: 'vs-cmp-label' }, t('versions.compareOnlyIn', { name: names[1] })), entryCell(null), entryCell(b, { kind: 'added' })));
  for (const { a, b } of diff.changed) rows.push(h('tr', { class: 'vs-cmp-row diff' }, h('th', { scope: 'row', class: 'vs-cmp-label' }, t('versions.compareChanged')), entryCell(a, { kind: 'changed' }), entryCell(b, { kind: 'changed' })));
  if (diff.same.length) {
    const body = h('tbody', { class: 'vs-cmp-same hidden' }, diff.same.map(({ a, b }) => h('tr', { class: 'vs-cmp-row same' }, h('th', { scope: 'row', class: 'vs-cmp-label' }), entryCell(a), entryCell(b))));
    const toggle = h(
      'button',
      {
        type: 'button',
        class: 'btn sm ghost vs-cmp-toggle',
        'aria-expanded': 'false',
        onclick: () => {
          const open = body.classList.toggle('hidden');
          toggle.setAttribute('aria-expanded', String(!open));
          mount(toggle, icon(open ? 'chevronDown' : 'chevronRight'), t('versions.compareSameCount', { count: diff.same.length }));
        },
      },
      icon('chevronDown'),
      t('versions.compareSameCount', { count: diff.same.length }),
    );
    rows.push(h('tr', { class: 'vs-cmp-row vs-cmp-samehead' }, h('td', { colspan: 3 }, toggle)));
    rows.push(body);
  } else if (!n) {
    rows.push(h('tr', { class: 'vs-cmp-row' }, h('td', { colspan: 3, class: 'small muted vs-cmp-empty' }, t('versions.compareEmptyList'))));
  }
  return rows;
}

function headCell(inst) {
  return h('th', { scope: 'col', class: 'vs-cmp-head' }, h('div', { class: 'vs-cmp-headbox' }, instIcon(inst, 'vs-cmp-icon'), h('div', { class: 'vs-cmp-headtext' }, h('div', { class: 'vs-cmp-headname ellipsis', title: inst.name }, inst.name), h('div', { class: 'row wrap' }, instanceBadge(inst), h('span', { class: 'badge' }, t('versions.minecraftVersion', { version: inst.mcVersion }))))));
}

export function openCompare(list, { a: firstId, b: secondId } = {}) {
  const all = sortInstances(list?.length ? list : store.instances, 'recent', { locale: locale() });
  if (all.length < 2) return null;
  // Cada vez que se abre se vuelve a leer el contenido (pudo cambiar); dentro del dialogo se reusa
  clearCompareCache();
  let a = all.find((i) => i.id === firstId) || all[0];
  let b = all.find((i) => i.id === secondId && i.id !== a.id) || all.find((i) => i.id !== a.id);
  let seq = 0;
  let lastText = '';
  const table = h('div', { class: 'vs-cmp-wrap' });
  const summary = h('div', { class: 'vs-cmp-summary small muted', 'aria-live': 'polite' });
  const copyBtn = h('button', { class: 'btn primary', type: 'button', disabled: true, onclick: () => copyText(lastText, t('versions.compareCopied')) }, icon('copy'), t('versions.compareCopy'));

  const options = () => all.map((i) => ({ value: i.id, label: i.name }));
  const selA = selectEl(options(), a.id, (v) => {
    a = all.find((i) => i.id === v) || a;
    draw();
  });
  const selB = selectEl(options(), b.id, (v) => {
    b = all.find((i) => i.id === v) || b;
    draw();
  });
  selA.setAttribute('aria-label', t('versions.compareA'));
  selB.setAttribute('aria-label', t('versions.compareB'));
  const swapBtn = h(
    'button',
    {
      class: 'icon-btn sm',
      type: 'button',
      title: t('versions.compareSwap'),
      'aria-label': t('versions.compareSwap'),
      onclick: () => {
        [a, b] = [b, a];
        selA.value = a.id;
        selB.value = b.id;
        draw();
      },
    },
    icon('refresh'),
  );

  async function draw() {
    const my = ++seq;
    copyBtn.disabled = true;
    lastText = '';
    if (a.id === b.id) {
      mount(summary, t('versions.compareSameInstance'));
      mount(table, h('div', { class: 'notice info' }, icon('info'), h('div', {}, t('versions.compareSameInstance'))));
      return;
    }
    mount(summary, t('versions.compareLoading'));
    mount(table, skeleton('list', { rows: 6, label: t('versions.compareLoading') }));
    const names = [a.name, b.name];
    const fields = fieldsFor(a, b);
    const sections = [];
    const errors = [];
    for (const kind of SECTIONS) {
      const [la, lb] = await Promise.all([contentEntries(a, kind).catch(() => (errors.push(a.name), [])), contentEntries(b, kind).catch(() => (errors.push(b.name), []))]);
      sections.push({ kind, title: t(`versions.compareSection_${kind}`), diff: diffLists(la, lb) });
    }
    if (my !== seq) return;
    const total = fields.filter((f) => !f.same).length + sections.reduce((n, s) => n + diffCount(s.diff), 0);
    mount(summary, total ? t('versions.compareDiffCount', { count: total }) : t('versions.compareSame'), errors.length ? h('span', { class: 'vs-cmp-err' }, ' · ', t('versions.compareLoadFailed', { name: [...new Set(errors)].join(', ') })) : null);
    lastText = diffText({
      names,
      fields,
      sections,
      texts: { onlyIn: (name) => t('versions.compareOnlyIn', { name }), changed: t('versions.compareChanged'), same: (count) => t('versions.compareSameCount', { count }), none: t('versions.compareSame') },
    });
    copyBtn.disabled = false;
    mount(
      table,
      h(
        'table',
        { class: 'vs-cmp' },
        h('thead', {}, h('tr', {}, h('th', { scope: 'col', class: 'vs-cmp-label' }), headCell(a), headCell(b))),
        h(
          'tbody',
          {},
          fields.map((f) =>
            h(
              'tr',
              { class: ['vs-cmp-row', !f.same && 'diff'] },
              h('th', { scope: 'row', class: 'vs-cmp-label' }, f.label),
              h('td', { class: 'vs-cmp-cell vs-cmp-field', title: f.a }, h('span', { class: 'vs-cmp-value' }, f.a || t('versions.compareNone'))),
              h('td', { class: 'vs-cmp-cell vs-cmp-field', title: f.b }, h('span', { class: 'vs-cmp-value' }, f.b || t('versions.compareNone'))),
            ),
          ),
        ),
        sections.map((s) => h('tbody', {}, sectionRows(s.title, s.diff, names))),
      ),
    );
  }

  const m = modal({
    title: t('versions.compareTitle'),
    icon: 'vsCompare',
    size: 'xwide',
    body: h('div', { class: 'stack vs-cmp-body' }, h('div', { class: 'vs-cmp-pick' }, h('div', { class: 'field' }, h('label', {}, t('versions.compareA')), selA), swapBtn, h('div', { class: 'field' }, h('label', {}, t('versions.compareB')), selB)), summary, table),
    footer: [h('button', { class: 'btn ghost', type: 'button', onclick: () => m.close() }, t('common.close')), copyBtn],
    onClose: () => {
      seq++;
    },
  });
  draw();
  return m;
}

export function clearCompareCache(id) {
  for (const key of [...contentCache.keys()]) if (!id || key.startsWith(`${id}|`)) contentCache.delete(key);
}
