// "¿Qué cambia?": los changelogs entre la versión instalada de un mod y la nueva, tal cual los escribió su autor (como
// texto, nunca como HTML), con "Explicar con IA" a pedido. Sin plan o sin conexión se ve solo el texto original, con un
// aviso. Antes de mandar nada a la IA se pregunta. Lo usan la pestaña de contenido de la instancia y la página de
// Actualizaciones. Contrato: openModChangelog(instanceId, { folder?, file, title? }), modUpdatesPanel() -> Element.
import { h, icon, mount, modal, fail, confirmDialog, skeleton, emptyState, setBusy, selectEl, fmtDate, ensureCss } from '../../ui.js';
import { store, api } from '../../store.js';
import { t, loadNs, has } from '../../i18n.js';
import { navigate } from '../../app.js';

const TYPE_PILL = { beta: 'warn', alpha: 'bad' };

function errorText(err) {
  const key = `instancetools.changelogErr_${err?.code}`;
  return err?.code && has(key) ? t(key) : err?.message || String(err);
}

async function prepare() {
  ensureCss('features/instancetools');
  await loadNs('instancetools').catch((err) => console.warn('[instancelook] textos', err));
}

function versionBlock(v) {
  return h(
    'details',
    { class: 'it-cl-version', open: true },
    h(
      'summary',
      {},
      h('strong', { class: 'ellipsis', title: v.number }, v.number),
      TYPE_PILL[v.type] ? h('span', { class: `pill ${TYPE_PILL[v.type]}` }, v.type) : null,
      v.date ? h('span', { class: 'small muted' }, fmtDate(v.date)) : null,
    ),
    // Texto tal cual: nada de HTML de afuera.
    v.body ? h('div', { class: 'it-cl-body' }, v.body) : h('div', { class: 'small muted' }, t('instancetools.changelogEmpty')),
    v.truncated ? h('div', { class: 'small muted' }, t('instancetools.changelogTruncated')) : null,
  );
}

function answerView(a) {
  const list = (title, items, cls) => (items?.length ? h('div', { class: `it-cl-list ${cls}` }, h('div', { class: 'label' }, title), h('ul', {}, items.map((x) => h('li', {}, x)))) : null);
  return h(
    'div',
    { class: 'it-cl-answer' },
    a.summary ? h('p', {}, a.summary) : null,
    list(t('instancetools.changelogNews'), a.news, 'news'),
    a.risks?.length ? list(t('instancetools.changelogRisks'), a.risks, 'risks') : h('div', { class: 'small muted' }, t('instancetools.changelogNoRisks')),
    h('div', { class: 'small muted it-cl-disclaimer' }, t('instancetools.changelogAiNote')),
  );
}

// Sección de IA: el botón con su aviso, o por qué no se puede.
function aiSection(token) {
  const box = h('div', { class: 'it-cl-ai' });

  function unavailable(reason) {
    const action = {
      noPlan: h('button', { class: 'btn sm', type: 'button', onclick: async () => (await import('../plans.js')).openPlans({ reason: 'needsPlan' }) }, icon('sparkles'), t('instancetools.changelogSeePlans')),
      signedOut: h('button', { class: 'btn sm', type: 'button', onclick: () => navigate('settings/cloud') }, icon('user'), t('instancetools.changelogSignIn')),
      disabled: h('button', { class: 'btn sm', type: 'button', onclick: () => navigate('settings/ai') }, icon('sliders'), t('instancetools.changelogAiSettings')),
    }[reason];
    mount(box, h('div', { class: 'notice info' }, icon('info'), h('div', { class: 'spacer' }, t(`instancetools.changelogNoAi_${reason}`)), action || null));
  }

  async function explain(btn) {
    const yes = await confirmDialog(t('instancetools.changelogAskTitle'), t('instancetools.changelogAskText'), { okText: t('instancetools.changelogAskOk') });
    if (!yes) return;
    const release = setBusy(btn);
    try {
      mount(box, answerView(await api.invoke('modchangelog:explain', token)));
    } catch (err) {
      release();
      if (err?.code === 'noplan') return unavailable('noPlan');
      if (err?.code === 'unavailable' || err?.code === 'session') return unavailable('signedOut');
      if (err?.code === 'offline' || err?.code === 'network') return unavailable('offline');
      mount(box, h('div', { class: 'notice bad', role: 'alert' }, icon('alert'), h('div', { class: 'spacer' }, errorText(err))), explainButton());
    }
    return undefined;
  }

  function explainButton() {
    const btn = h('button', { class: 'btn tonal sm', type: 'button', onclick: () => explain(btn) }, icon('sparkles'), t('instancetools.changelogExplain'));
    return h('div', { class: 'row wrap' }, btn, h('span', { class: 'small muted spacer' }, t('instancetools.changelogExplainHint')));
  }

  mount(box, skeleton('line'));
  api
    .invoke('modchangelog:aiStatus')
    .then((s) => (s.available ? mount(box, explainButton()) : unavailable(s.reason)))
    .catch(() => mount(box, explainButton()));
  return box;
}

export async function openModChangelog(instanceId, { folder = 'mods', file, title } = {}) {
  await prepare();
  const body = h('div', { class: 'stack it-cl' });
  const toUpdates = h('button', { class: 'btn', type: 'button', hidden: true, onclick: () => (m.close(), import('../compat.js').then((mod) => mod.openModUpdates(instanceId))) }, icon('refresh'), t('instancetools.changelogGoUpdate'));
  const m = modal({
    title: t('instancetools.changelogTitle', { name: title || file }),
    icon: 'fileText',
    size: 'wide',
    body,
    footer: [h('span', { class: 'spacer' }), toUpdates, h('button', { class: 'btn ghost', type: 'button', onclick: () => m.close() }, t('common.close'))],
  });

  async function load() {
    mount(body, skeleton('list', { rows: 3 }));
    try {
      const r = await api.invoke('modchangelog:forFile', instanceId, { folder, file });
      const head = m.el?.querySelector?.('.modal-head h3');
      if (head && r.title) head.textContent = t('instancetools.changelogTitle', { name: r.title });
      if (r.upToDate) {
        mount(body, emptyState('check', t('instancetools.changelogUpToDate'), t('instancetools.changelogUpToDateText', { version: r.from || '?' })));
        return;
      }
      toUpdates.hidden = r.source !== 'modrinth';
      mount(
        body,
        h(
          'div',
          { class: 'it-cl-range' },
          h('span', { class: 'badge' }, r.source === 'curseforge' ? 'CurseForge' : 'Modrinth'),
          h('span', { class: 'small' }, t('instancetools.changelogRange', { from: r.from || '?', to: r.to || '?' })),
          h('span', { class: 'spacer' }),
          r.slug ? h('button', { class: 'btn ghost sm', type: 'button', onclick: () => api.app.openExternal(`https://modrinth.com/project/${encodeURIComponent(r.slug)}/changelog`) }, icon('external'), t('instancetools.changelogOpen')) : null,
        ),
        aiSection(r.token),
        h('div', { class: 'small muted' }, t('instancetools.changelogOriginal')),
        h('div', { class: 'it-cl-versions' }, r.versions.map(versionBlock)),
        r.moreVersions ? h('div', { class: 'small muted' }, t('instancetools.changelogMore', { count: r.moreVersions })) : null,
      );
    } catch (err) {
      mount(body, h('div', { class: 'notice bad', role: 'alert' }, icon('alert'), h('div', { class: 'spacer' }, h('strong', {}, t('instancetools.changelogFailed')), h('div', { class: 'small' }, errorText(err))), h('button', { class: 'btn sm', type: 'button', onclick: load }, icon('refresh'), t('common.retry'))));
    }
  }
  load();
  return m;
}

// Tarjeta de la página de Actualizaciones: qué mods de una instancia tienen versión nueva y qué cambia en cada uno.
export function modUpdatesPanel() {
  ensureCss('features/instancetools');
  const instances = store.instances.filter((i) => !['vanilla', 'optifine'].includes(i.loader));
  const selected = store.selectedInstance();
  let current = instances.some((i) => i.id === selected?.id) ? selected.id : instances[0]?.id || '';
  const results = h('div', { class: 'it-updates-results' });
  const root = h('section', { class: 'card cfg-card it-updates' });

  function row(item) {
    const img = item.icon ? h('img', { src: item.icon, alt: '', loading: 'lazy' }) : icon('puzzle');
    if (item.icon) img.addEventListener('error', () => img.replaceWith(icon('puzzle')), { once: true });
    return h(
      'div',
      { class: 'list-item it-updates-row' },
      h('div', { class: 'li-icon' }, img),
      h('div', { class: 'li-main' }, h('div', { class: 'li-title', title: item.file }, item.title), h('div', { class: 'li-sub num' }, t('instancetools.changelogRange', { from: item.from || '?', to: item.to || '?' }))),
      h('span', { class: 'badge' }, item.source === 'curseforge' ? 'CurseForge' : 'Modrinth'),
      h('button', { class: 'btn sm', type: 'button', onclick: () => openModChangelog(current, { folder: item.folder, file: item.file, title: item.title }) }, icon('fileText'), t('instancetools.whatChanges')),
    );
  }

  async function search(btn) {
    const release = setBusy(btn);
    mount(results, skeleton('list', { rows: 3 }));
    try {
      const r = await api.invoke('modchangelog:list', current);
      mount(results, r.items.length ? h('div', { class: 'list' }, r.items.map(row)) : emptyState('check', t('instancetools.updatesNone'), t('instancetools.updatesNoneText')));
    } catch (err) {
      mount(results, h('div', { class: 'notice bad', role: 'alert' }, icon('alert'), h('div', {}, errorText(err))));
    } finally {
      release();
    }
  }

  async function draw() {
    await prepare();
    if (!instances.length) {
      mount(root, h('div', { class: 'cfg-card-head' }, h('h3', { class: 'card-title' }, icon('puzzle'), h('span', {}, t('instancetools.updatesTitle')))), emptyState('layers', t('instancetools.updatesNoInstances'), t('instancetools.updatesNoInstancesText')));
      return;
    }
    const sel = selectEl(instances.map((i) => ({ value: i.id, label: i.name })), current, (v) => {
      current = v;
      mount(results);
    });
    sel.setAttribute('aria-label', t('instancetools.updatesInstance'));
    const btn = h('button', { class: 'btn', type: 'button', onclick: () => search(btn) }, icon('search'), t('instancetools.updatesSearch'));
    mount(
      root,
      h('div', { class: 'cfg-card-head' }, h('h3', { class: 'card-title' }, icon('puzzle'), h('span', {}, t('instancetools.updatesTitle')))),
      h('p', { class: 'card-sub cfg-card-sub' }, t('instancetools.updatesSub')),
      h('div', { class: 'row wrap it-updates-bar' }, sel, btn),
      results,
    );
  }
  draw();
  return root;
}
