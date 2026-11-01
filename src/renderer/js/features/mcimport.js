// Importar desde el launcher oficial de Minecraft: dialogo con la carpeta detectada (o elegida), los perfiles con
// su version y loader, el contenido de cada carpeta de juego (mundos, mods, paquetes de recursos, shaders,
// configuracion, opciones y servidores) con cantidades y tamanios, a donde va el contenido compartido y el total.
// La copia corre como tarea en el proceso principal (modules/mcimport.js), con progreso y cancelar: solo copia,
// nunca toca la carpeta del launcher oficial, y no importa cuentas.
//   openOfficialImport({ dir?, from?: 'welcome', onImported? })  abre el dialogo
//   welcomeSuggestion(slot, { onImported })                      tarjeta "¿Venís del launcher oficial?" (bienvenida)
//   detectOfficial()                                             deteccion rapida, sin red (se guarda en memoria)
import { h, icon, mount, modal, ensureCss, registerIcons, fmtBytes, fmtAgo, emptyState, skeleton, setBusy, LOADERS, reducedMotion, toast } from '../ui.js';
import { store, api } from '../store.js';
import { t, has, loadNs } from '../i18n.js';
import { navigate } from '../app.js';

registerIcons({
  mciBlock: '<path d="M12 2 3 7v10l9 5 9-5V7z"/><path d="m3 7 9 5 9-5"/><path d="M12 12v10"/><path d="m7.5 4.5 9 5"/>',
});

const CATS = [
  { id: 'worlds', icon: 'globe' },
  { id: 'mods', icon: 'puzzle' },
  { id: 'resourcepacks', icon: 'palette' },
  { id: 'shaderpacks', icon: 'sun' },
  { id: 'config', icon: 'sliders' },
  { id: 'options', icon: 'settings' },
  { id: 'servers', icon: 'server' },
];
const MODDED_ONLY = new Set(['mods', 'config']);
const WORLDS_SHOWN = 60;

const isMissing = (err) => /No handler registered/i.test(String(err?.message || err));
const errText = (err) => err?.message || String(err);

let readyPromise = null;
function ready() {
  ensureCss('features/mcimport');
  if (!readyPromise) readyPromise = loadNs('mcimport').catch(() => {});
  return readyPromise;
}

// ---------- Deteccion (bienvenida) ----------

let detected = null; // { at, value }
let detecting = null;
export function detectOfficial({ force = false } = {}) {
  if (!force && detected) return Promise.resolve(detected.value);
  if (!detecting) {
    const call = api.invoke('mcimport:detect');
    detecting = call
      .then((r) => (r && r.found ? { found: true, dir: String(r.dir || ''), profiles: Number(r.profiles) || 0, worlds: Number(r.worlds) || 0 } : { found: false }))
      .catch(() => ({ found: false }))
      .then((value) => {
        detected = { at: Date.now(), value };
        detecting = null;
        return value;
      });
  }
  return detecting;
}

// ---------- Importacion en curso (sobrevive al dialogo: se puede cerrar y sigue en segundo plano) ----------

let running = null; // { promise, dialogs: Set }
const listeners = new Set(); // dialogos abiertos que quieren el resultado

// Aviso de que termino, con boton para ver las instancias (cuando el dialogo ya no esta a la vista).
function actionToast(title, msg, label, onAction) {
  const host = document.getElementById('toasts');
  if (!host) return;
  const btn = h('button', { type: 'button', class: 'btn sm tonal mci-toast-btn' }, icon('arrowRight'), label);
  const el = h('div', { class: 'toast good mci-toast', role: 'status' }, icon('check'), h('div', {}, h('div', { class: 't-title' }, title), msg ? h('div', { class: 't-msg' }, msg) : null, btn));
  let timer = null;
  const leave = () => {
    if (!el.isConnected || el.classList.contains('leaving')) return;
    if (reducedMotion()) return el.remove();
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 180);
  };
  btn.addEventListener('click', () => {
    leave();
    onAction();
  });
  el.addEventListener('mouseenter', () => clearTimeout(timer));
  el.addEventListener('mouseleave', () => {
    clearTimeout(timer);
    timer = setTimeout(leave, 2500);
  });
  el.addEventListener('focusin', () => clearTimeout(timer));
  host.append(el);
  timer = setTimeout(leave, 9000);
}

function startImport(selection) {
  const promise = api.invoke('mcimport:import', selection);
  running = { promise };
  promise
    .then(async (r) => {
      // Si ningun dialogo lo esta mostrando (se mira antes de esperar: el dialogo se desuscribe al recibirlo),
      // el aviso lleva a Versiones.
      const shown = listeners.size > 0;
      await store.refreshInstances().catch(() => {});
      const list = Array.isArray(r?.instances) ? r.instances : [];
      if (!shown && list.length) {
        const title = t('mcimport.toastTitle', { count: list.length });
        const msg = list.map((x) => x.name).slice(0, 3).join(' · ');
        // Durante la bienvenida (obligatoria) no se puede ir a Versiones: el aviso va sin boton.
        if (document.body.classList.contains('onboarding')) toast('good', title, msg, 7000);
        else actionToast(title, msg, t('mcimport.toastAction'), () => navigate('versions'));
      }
    })
    .catch(() => store.refreshInstances().catch(() => {}))
    .finally(() => {
      if (running?.promise === promise) running = null;
    });
  return promise;
}

// ---------- Ayudantes de la vista ----------

function profileTitle(p) {
  if (p.name) return p.name;
  if (p.synthetic) return t('mcimport.profileSynthetic');
  if (p.type === 'latest-release') return t('mcimport.profileLatestRelease');
  if (p.type === 'latest-snapshot') return t('mcimport.profileLatestSnapshot');
  return p.suggestedName || t('mcimport.profileUnnamed');
}

function loaderOf(p) {
  return p.version?.ok ? p.version.loader : null;
}

// Primera letra (o emoji entero: charAt partiria un par sustituto y se veria un simbolo roto).
function initial(name) {
  const first = Array.from(String(name || '').trim())[0];
  return (first || 'M').toUpperCase();
}

function loaderName(key) {
  return LOADERS[key]?.name || key || '';
}

function reasonText(p) {
  const v = p.version || {};
  if (v.reason === 'unsupportedLoader') return v.loaderName ? t('mcimport.reasonLoaderNamed', { loader: v.loaderName }) : t('mcimport.reasonLoader');
  if (v.reason === 'latestUnknown') return t('mcimport.reasonLatest');
  if (v.reason === 'noVersion') return t('mcimport.reasonNoVersion');
  return t('mcimport.reasonUnknown', { version: p.versionId || '?' });
}

function profileIcon(p) {
  const key = loaderOf(p) || 'vanilla';
  const color = LOADERS[key]?.color || 'var(--muted)';
  if (p.icon?.kind === 'image' && /^data:image\/(png|jpeg|webp|gif);base64,/.test(p.icon.data)) {
    return h('span', { class: 'mci-prof-icon is-img', 'aria-hidden': 'true' }, h('img', { src: p.icon.data, alt: '' }));
  }
  const letter = initial(profileTitle(p));
  return h('span', { class: 'mci-prof-icon', 'aria-hidden': 'true', style: { '--c': color } }, letter);
}

function loaderChip(key, version) {
  const meta = LOADERS[key] || { name: key, color: 'var(--muted)' };
  return h('span', { class: 'badge loader-badge mci-loader', style: { '--c': meta.color } }, h('span', { class: 'ld' }), meta.name, version ? h('span', { class: 'muted ld-ver ellipsis', title: version }, version) : null);
}

// Version corta y legible del loader (47.3.0, HD U I6).
function loaderVersionText(v) {
  if (!v?.ok || !v.loaderVersion || v.loader === 'vanilla') return null;
  return v.loader === 'optifine' ? v.loaderVersion.replace(/_/g, ' ') : v.loaderVersion;
}

// Titulo de seccion del dialogo: el texto es el encabezado; la ayuda y la accion quedan al lado (fuera del encabezado).
function sectionTitle(ic, text, hint, action) {
  return h('div', { class: 'mci-section' }, h('div', { class: 'mci-section-title', role: 'heading', 'aria-level': '4' }, icon(ic), h('span', {}, text)), hint ? h('span', { class: 'mci-section-hint' }, hint) : null, action || null);
}

function check(checked, disabled, onChange, attrs = {}) {
  const input = h('input', { type: 'checkbox', checked, disabled, ...attrs });
  input.addEventListener('change', () => onChange(input.checked));
  return input;
}

// Destino del contenido de una carpeta (igual que modules/mcimport/plan.js): los perfiles elegidos que la usan
// (o todos los elegidos si ningun perfil la usa), el usado mas reciente primero; con mods, el que tenga mods.
function candidatesFor(group, chosen) {
  const using = chosen.filter((p) => group.profileIds.includes(p.id));
  const list = group.profileIds.length ? using : chosen;
  return [...list].sort((a, b) => b.lastUsed - a.lastUsed || a.suggestedName.localeCompare(b.suggestedName));
}

function defaultTarget(group, candidates) {
  if (!candidates.length) return null;
  if (group.content?.mods?.count > 0) {
    const modded = candidates.find((p) => p.modded);
    if (modded) return modded;
  }
  return candidates[0];
}

function catAllowed(cat, target) {
  return Boolean(target) && (!MODDED_ONLY.has(cat) || target.modded);
}

// ---------- Dialogo ----------

export async function openOfficialImport(opts = {}) {
  await ready();
  const fromWelcome = opts.from === 'welcome';
  const body = h('div', { class: 'mci' });
  const m = modal({
    title: t('mcimport.title'),
    subtitle: t('mcimport.subtitle'),
    icon: 'mciBlock',
    body,
    size: 'wide mci-modal',
    footer: [h('span', {})],
    onClose: () => {
      alive = false;
      listeners.delete(onResult);
      offTask();
    },
  });
  const foot = m.el.querySelector('.modal-foot');
  const bodyBox = m.el.querySelector('.modal-body');
  let alive = true;
  const state = { view: 'loading', dir: typeof opts.dir === 'string' && opts.dir ? opts.dir : null, scan: null, error: null, formError: null, selected: new Set(), groups: {}, result: null, token: 0 };

  function show(parts, footer, { keepScroll = false } = {}) {
    if (!alive) return;
    mount(body, ...parts);
    mount(foot, ...(footer || []).filter(Boolean));
    foot.classList.toggle('hidden', !footer || !footer.filter(Boolean).length);
    if (!keepScroll && bodyBox) bodyBox.scrollTop = 0;
    if (!m.el.contains(document.activeElement)) {
      const target = m.el.querySelector('.modal-body button:not(:disabled), .modal-body input:not(:disabled), .modal-body select:not(:disabled), .modal-foot .btn.primary:not(:disabled)') || m.el.querySelector('.modal-head button');
      target?.focus({ preventScroll: true });
    }
  }

  // Redibuja la vista sin perder el foco ni el scroll (los controles llevan data-fk con una clave estable).
  function refresh() {
    const active = document.activeElement;
    const fk = active && m.el.contains(active) ? active.dataset?.fk : null;
    const scroll = bodyBox?.scrollTop || 0;
    renderForm({ keepScroll: true });
    if (bodyBox) bodyBox.scrollTop = scroll;
    if (fk) m.el.querySelector(`[data-fk="${CSS.escape(fk)}"]`)?.focus({ preventScroll: true });
  }

  // ----- Progreso de la tarea -----
  let progress = null;
  let offTask = () => {};
  function followTask() {
    offTask();
    offTask = store.on('task', (task) => {
      if (task?.meta?.kind !== 'mcimport' || !progress) return;
      progress.update(task);
      // Abrio el dialogo mientras otra ventana importaba: al terminar se muestra un final simple.
      if (!state.ownRun && task.state === 'done') showDoneSimple(task.detail);
      else if (!state.ownRun && task.state === 'error') load();
    });
  }

  function progressView() {
    const bar = h('i', { style: { width: '0%' } });
    const barBox = h('div', { class: 'progress indeterminate', role: 'progressbar', 'aria-label': t('mcimport.progressTitle') }, bar);
    const detail = h('div', { class: 'mci-progress-detail', 'aria-live': 'polite' }, t('mcimport.progressStart'));
    const el = h('div', { class: 'mci-progress', role: 'status' }, h('div', { class: 'spinner lg', 'aria-hidden': 'true' }), h('div', { class: 'mci-progress-title' }, t('mcimport.progressTitle')), barBox, detail, h('p', { class: 'mci-progress-hint' }, t('mcimport.progressHint')));
    return {
      el,
      update(task) {
        if (task.detail) detail.textContent = task.detail;
        if (typeof task.progress === 'number') {
          const pct = Math.round(task.progress * 100);
          barBox.classList.remove('indeterminate');
          barBox.setAttribute('aria-valuenow', String(pct));
          bar.style.width = `${pct}%`;
        } else {
          barBox.classList.add('indeterminate');
          barBox.removeAttribute('aria-valuenow');
        }
      },
    };
  }

  function showProgress() {
    state.view = 'progress';
    progress = progressView();
    const cancelBtn = h('button', { type: 'button', class: 'btn danger', 'data-fk': 'cancel-run' }, icon('x'), t('mcimport.cancelImport'));
    cancelBtn.addEventListener('click', async () => {
      const done = setBusy(cancelBtn);
      try {
        await api.invoke('mcimport:cancel');
      } catch (err) {
        console.warn('[mcimport] cancelar', err);
        done();
      }
    });
    show([progress.el], [h('button', { type: 'button', class: 'btn ghost', onclick: () => m.close() }, t('mcimport.background')), cancelBtn]);
    followTask();
  }

  // ----- Cargar / escanear -----
  async function load() {
    const token = ++state.token;
    state.view = 'loading';
    state.formError = null;
    show(
      [
        h('div', { class: 'mci-loading' }, h('div', { class: 'mci-loading-title' }, t('mcimport.scanning')), h('div', { class: 'mci-loading-sub' }, t('mcimport.scanningText'))),
        skeleton('list', { rows: 3, label: t('mcimport.scanning') }),
        skeleton('grid', { items: 4, min: 180 }),
      ],
      [h('button', { type: 'button', class: 'btn ghost', onclick: () => m.close() }, t('mcimport.cancel'))],
    );
    try {
      const scan = await api.invoke('mcimport:scan', state.dir || undefined);
      if (!alive || token !== state.token) return;
      state.scan = scan;
      state.dir = scan.dir;
      if (!scan.found) return showEmpty();
      initSelection();
      renderForm();
    } catch (err) {
      if (!alive || token !== state.token) return;
      state.error = isMissing(err) ? t('mcimport.unavailable') : errText(err);
      showError();
    }
  }

  async function pickFolder(btn) {
    const done = setBusy(btn);
    try {
      const dir = await api.invoke('mcimport:pickFolder');
      done();
      if (dir) {
        state.dir = dir;
        load();
      }
    } catch (err) {
      done();
      state.error = isMissing(err) ? t('mcimport.unavailable') : errText(err);
      showError();
    }
  }

  const pickButton = (cls = 'btn', label = t('mcimport.pickOther')) => {
    const b = h('button', { type: 'button', class: cls, 'data-fk': 'pick' }, icon('folderOpen'), label);
    b.addEventListener('click', () => pickFolder(b));
    return b;
  };

  function showEmpty() {
    state.view = 'empty';
    const s = state.scan;
    const dir = s.dir || s.defaultDir || '';
    let title;
    let text;
    let ic = 'mciBlock';
    if (s.reason === 'notFound' && s.isDefault) {
      title = t('mcimport.emptyTitle');
      text = t('mcimport.emptyText', { dir });
    } else if (s.reason === 'notFound') {
      title = t('mcimport.missingTitle');
      text = t('mcimport.missingText', { dir });
    } else if (s.reason === 'empty') {
      ic = 'folder';
      title = t('mcimport.nothingTitle');
      text = t('mcimport.nothingText', { dir });
    } else if (['network', 'unsafe', 'venus'].includes(s.reason)) {
      ic = 'alert';
      title = t('mcimport.badFolderTitle');
      text = t(`mcimport.badFolder_${s.reason}`);
    } else {
      ic = 'folder';
      title = t('mcimport.notMinecraftTitle');
      text = t('mcimport.notMinecraftText', { dir });
    }
    show([h('div', { class: 'mci-empty' }, emptyState(ic, title, text, pickButton('btn primary', t('mcimport.pickFolder'))))], [h('button', { type: 'button', class: 'btn ghost', onclick: () => m.close() }, t('mcimport.close'))]);
  }

  function showError() {
    state.view = 'error';
    const retry = h('button', { type: 'button', class: 'btn primary', 'data-fk': 'retry', onclick: () => load() }, icon('refresh'), t('mcimport.retry'));
    show(
      [h('div', { class: 'notice bad', role: 'alert' }, icon('alert'), h('div', {}, h('strong', {}, t('mcimport.scanFailed')), h('div', {}, state.error)))],
      [h('button', { type: 'button', class: 'btn ghost', onclick: () => m.close() }, t('mcimport.close')), pickButton('btn'), retry],
    );
  }

  // ----- Seleccion -----
  const profiles = () => state.scan?.profiles || [];
  const importable = (p) => Boolean(p.version?.ok);
  const chosen = () => profiles().filter((p) => state.selected.has(p.id) && importable(p));
  const importableGroups = () => (state.scan?.groups || []).filter((g) => g.exists && !g.problem && g.hasContent);

  function initSelection() {
    state.selected = new Set();
    for (const p of profiles()) {
      if (!importable(p) || p.imported) continue;
      if (p.selected || p.lastUsed > 0 || p.type === 'custom' || p.synthetic) state.selected.add(p.id);
    }
    // Nada usado todavia (launcher recien instalado con mundos copiados a mano): el primero que se pueda. Si ya se
    // importo algo de esta carpeta no se marca nada solo: volver a abrir no ofrece copiar todo otra vez a un perfil
    // que nadie eligio (por ejemplo la snapshot sin usar).
    if (!state.selected.size && !profiles().some((p) => p.imported)) {
      const first = profiles().find((p) => importable(p));
      if (first) state.selected.add(first.id);
    }
    state.groups = {};
    for (const g of importableGroups()) state.groups[g.id] = { target: null, cats: {}, worlds: null, expanded: false };
    syncTargets();
  }

  // Categorias por defecto para el destino de una carpeta (igual que plan.js): lo que el usuario toco a mano se
  // respeta; los shaders no van a una instancia vanilla.
  function defaultCats(g, st, target) {
    for (const c of CATS) {
      if (st.touched?.[c.id] === true) continue;
      st.cats[c.id] = g.content?.[c.id]?.count > 0 && !(c.id === 'shaderpacks' && target?.version?.loader === 'vanilla');
    }
  }

  // Cada vez que cambian los perfiles elegidos: si el destino de una carpeta ya no sirve, vuelve al de por defecto.
  function syncTargets() {
    const sel = chosen();
    for (const g of importableGroups()) {
      const st = state.groups[g.id];
      const cands = candidatesFor(g, sel);
      if (!cands.some((p) => p.id === st.target)) {
        const def = defaultTarget(g, cands);
        st.target = def?.id || null;
        defaultCats(g, st, def);
      }
    }
  }

  const targetOf = (g) => profiles().find((p) => p.id === state.groups[g.id]?.target) || null;
  const catOn = (g, cat) => {
    const st = state.groups[g.id];
    return Boolean(st && st.cats[cat] && g.content?.[cat]?.count > 0 && catAllowed(cat, targetOf(g)));
  };
  const worldsChosen = (g) => {
    const items = g.content?.worlds?.items || [];
    const st = state.groups[g.id];
    return st?.worlds ? items.filter((w) => st.worlds.has(w.folder)) : items;
  };

  function totals() {
    let bytes = 0;
    let worlds = 0;
    for (const g of importableGroups()) {
      if (!targetOf(g)) continue;
      for (const c of CATS) {
        if (!catOn(g, c.id)) continue;
        if (c.id === 'worlds') {
          const list = worldsChosen(g);
          worlds += list.length;
          bytes += list.reduce((a, w) => a + (w.bytes || 0), 0);
        } else bytes += g.content[c.id].bytes || 0;
      }
    }
    return { profiles: chosen().length, bytes, worlds };
  }

  function selectionPayload() {
    const groups = {};
    for (const g of importableGroups()) {
      const st = state.groups[g.id];
      if (!st) continue;
      const categories = {};
      for (const c of CATS) categories[c.id] = catOn(g, c.id);
      if (categories.worlds && st.worlds) categories.worlds = worldsChosen(g).map((w) => w.folder);
      groups[g.id] = { target: st.target, categories };
    }
    return { dir: state.scan.dir, profiles: chosen().map((p) => p.id), groups };
  }

  // ----- Formulario -----
  function profileRow(p) {
    const ok = importable(p);
    const on = ok && state.selected.has(p.id);
    const v = p.version || {};
    const group = (state.scan.groups || []).find((g) => g.id === p.groupId);
    const meta = [];
    if (ok) {
      meta.push(h('span', { class: 'badge mci-ver' }, icon('box'), v.mcVersion));
      meta.push(loaderChip(v.loader, loaderVersionText(v)));
    } else if (p.versionId) meta.push(h('span', { class: 'badge mci-ver' }, icon('box'), h('span', { class: 'ellipsis', title: p.versionId }, p.versionId)));
    // Carpeta propia que ya no existe o que no se puede leer (red, sistema, adentro de Venus): la instancia se crea
    // igual, pero sin su contenido. Se dice en la fila (el texto largo queda en el title y lo lee el lector).
    const folderIssue = ok && group && !group.isRoot && (group.problem || !group.exists) ? (group.problem ? 'Refused' : 'Gone') : null;
    if (folderIssue) {
      const longText = t(`mcimport.folder${folderIssue}Long`, { dir: group.dir });
      meta.push(h('span', { class: 'mci-chip is-warn', title: longText }, icon('alert'), h('span', { class: 'ellipsis' }, t(`mcimport.folder${folderIssue}`)), h('span', { class: 'sr-only' }, `. ${longText}`)));
    } else if (group && !group.isRoot) meta.push(h('span', { class: 'mci-chip', title: group.dir }, icon('folder'), h('span', { class: 'ellipsis' }, t('mcimport.ownFolder'))));
    if (p.source === 'store') meta.push(h('span', { class: 'mci-chip' }, t('mcimport.fromStore')));
    meta.push(h('span', { class: 'mci-used' }, p.lastUsed ? t('mcimport.lastUsed', { when: fmtAgo(p.lastUsed) }) : t('mcimport.neverUsed')));
    let status = null;
    if (!ok) status = h('span', { class: 'pill warn mci-reason', title: reasonText(p) }, icon('alert'), h('span', { class: 'ellipsis' }, reasonText(p)));
    else if (p.imported) status = h('span', { class: 'badge good mci-imported', title: t('mcimport.importedTitle', { name: p.imported.name }) }, icon('check'), t('mcimport.imported'));
    const name = profileTitle(p);
    const whyId = `mci-why-${String(p.id).replace(/[^\w-]/g, '_')}`;
    return h(
      'label',
      { class: ['mci-prof', on && 'is-on', !ok && 'is-off'] },
      check(on, !ok, (val) => {
        if (val) state.selected.add(p.id);
        else state.selected.delete(p.id);
        syncTargets();
        refresh();
      }, { 'data-fk': `prof-${p.id}`, 'aria-describedby': status ? whyId : null }),
      profileIcon(p),
      h('span', { class: 'mci-prof-main' }, h('span', { class: 'mci-prof-name ellipsis', title: name }, name), h('span', { class: 'mci-prof-meta' }, meta)),
      status ? h('span', { class: 'mci-prof-status', id: whyId }, status) : null,
    );
  }

  function catTile(g, c) {
    const info = g.content?.[c.id] || { count: 0, bytes: 0 };
    const target = targetOf(g);
    const allowed = catAllowed(c.id, target);
    // "Solo con mods" es para un destino sin loader de mods; sin destino (ningun perfil elegido usa la carpeta) se
    // ve lo que hay y la ayuda de arriba pide elegir un perfil.
    const needsMods = Boolean(target) && !allowed;
    const empty = !info.count;
    const on = catOn(g, c.id);
    let sub;
    if (empty) sub = t('mcimport.catEmpty');
    else if (needsMods) sub = t('mcimport.catNeedsMods');
    else if (c.id === 'worlds' && state.groups[g.id]?.worlds) {
      const list = worldsChosen(g);
      sub = t('mcimport.worldsPicked', { count: info.count, picked: list.length, size: fmtBytes(list.reduce((a, w) => a + (w.bytes || 0), 0)) });
    } else sub = t(`mcimport.catSub_${c.id}`, { count: info.count, size: fmtBytes(info.bytes || 0) });
    return h(
      'label',
      { class: ['mci-cat', on && 'is-on', (empty || !allowed) && 'is-off'], title: needsMods && !empty ? t('mcimport.catNeedsModsLong') : null },
      check(on, empty || !allowed || !target, (val) => {
        const st = state.groups[g.id];
        st.cats[c.id] = val;
        st.touched = { ...(st.touched || {}), [c.id]: true };
        refresh();
      }, { 'data-fk': `cat-${g.id}-${c.id}` }),
      h('span', { class: 'mci-cat-icon', 'aria-hidden': 'true' }, icon(c.icon)),
      h('span', { class: 'mci-cat-text' }, h('span', { class: 'mci-cat-name' }, t(`mcimport.cat_${c.id}`)), h('span', { class: 'mci-cat-sub' }, sub)),
    );
  }

  function worldsPicker(g) {
    const st = state.groups[g.id];
    const items = g.content?.worlds?.items || [];
    const picked = new Set(worldsChosen(g).map((w) => w.folder));
    const setAll = (all) => {
      st.worlds = all ? null : new Set();
      refresh();
    };
    return h(
      'div',
      { class: 'mci-worlds', id: `mci-worlds-${g.id}` },
      h(
        'div',
        { class: 'mci-worlds-tools' },
        h('button', { type: 'button', class: 'btn ghost sm', 'data-fk': `wall-${g.id}`, onclick: () => setAll(true) }, t('mcimport.worldsAll')),
        h('button', { type: 'button', class: 'btn ghost sm', 'data-fk': `wnone-${g.id}`, onclick: () => setAll(false) }, t('mcimport.worldsNone')),
      ),
      h(
        'div',
        { class: 'mci-worlds-grid' },
        items.slice(0, WORLDS_SHOWN).map((w) =>
          h(
            'label',
            { class: ['mci-world', picked.has(w.folder) && 'is-on'] },
            check(picked.has(w.folder), false, (val) => {
              const next = new Set(picked);
              if (val) next.add(w.folder);
              else next.delete(w.folder);
              st.worlds = next.size === items.length ? null : next;
              refresh();
            }, { 'data-fk': `w-${g.id}-${w.folder}` }),
            icon('globe'),
            h('span', { class: 'mci-world-main' }, h('span', { class: 'mci-world-name ellipsis', title: w.name !== w.folder ? `${w.name} (${w.folder})` : w.name }, w.name), h('span', { class: 'mci-world-sub' }, w.lastPlayed ? t('mcimport.worldPlayed', { when: fmtAgo(w.lastPlayed) }) : w.folder)),
            w.locked ? h('span', { class: 'pill warn mci-world-open', title: t('mcimport.worldOpenLong') }, t('mcimport.worldOpen')) : null,
            h('span', { class: 'mci-world-size' }, fmtBytes(w.bytes || 0)),
          ),
        ),
        items.length > WORLDS_SHOWN ? h('div', { class: 'mci-worlds-more' }, t('mcimport.worldsMore', { count: items.length - WORLDS_SHOWN })) : null,
      ),
    );
  }

  function groupCard(g) {
    const st = state.groups[g.id];
    const sel = chosen();
    const cands = candidatesFor(g, sel);
    const target = targetOf(g);
    // Carpeta principal: "Carpeta .minecraft"; las demas por su nombre (la ruta completa queda en el title).
    const title = g.isRoot ? t('mcimport.groupMain', { name: g.label }) : String(g.label).split(/[\\/]/).filter(Boolean).pop() || g.label;
    let sub;
    if (g.shared) sub = t('mcimport.groupShared', { count: g.profileIds.length });
    else if (g.profileIds.length === 1) sub = t('mcimport.groupOwn', { name: profileTitle(profiles().find((p) => p.id === g.profileIds[0]) || {}) });
    else sub = t('mcimport.groupNoProfile');
    let targetEl = null;
    if (cands.length > 1) {
      const selEl = h(
        'select',
        { class: 'select mci-target-select', 'data-fk': `target-${g.id}`, 'aria-label': t('mcimport.goesToLabel', { folder: title }) },
        cands.map((p) => h('option', { value: p.id, selected: p.id === st.target }, profileTitle(p))),
      );
      selEl.addEventListener('change', () => {
        st.target = selEl.value;
        defaultCats(g, st, targetOf(g));
        refresh();
      });
      targetEl = h('label', { class: 'mci-target' }, h('span', { class: 'mci-target-label' }, t('mcimport.goesTo')), selEl);
    } else if (cands.length === 1) {
      targetEl = h('span', { class: 'mci-target' }, h('span', { class: 'mci-target-label' }, t('mcimport.goesTo')), h('span', { class: 'mci-target-one ellipsis', title: profileTitle(cands[0]) }, profileTitle(cands[0])));
    }
    const worldsCount = g.content?.worlds?.count || 0;
    const showPicker = st.expanded && catOn(g, 'worlds');
    const pickerBtn =
      worldsCount > 1 && target
        ? h(
            'button',
            { type: 'button', class: 'btn ghost sm mci-pick-worlds', 'data-fk': `wpick-${g.id}`, 'aria-expanded': String(showPicker), 'aria-controls': `mci-worlds-${g.id}`, disabled: !catOn(g, 'worlds'), onclick: () => ((st.expanded = !st.expanded), refresh()) },
            icon(showPicker ? 'chevronDown' : 'chevronRight'),
            t('mcimport.pickWorlds'),
          )
        : null;
    return h(
      'div',
      { class: ['mci-group', !target && 'is-off'] },
      h(
        'div',
        { class: 'mci-group-head' },
        h('span', { class: 'mci-group-icon', 'aria-hidden': 'true' }, icon('folder')),
        h('div', { class: 'mci-group-text' }, h('div', { class: 'mci-group-title ellipsis', title: g.dir }, title), h('div', { class: 'mci-group-sub ellipsis', title: g.dir }, sub)),
        targetEl,
      ),
      target ? null : h('p', { class: 'mci-group-hint' }, icon('info'), t('mcimport.groupPickProfile')),
      h('div', { class: 'mci-cats' }, CATS.map((c) => catTile(g, c))),
      pickerBtn,
      showPicker ? worldsPicker(g) : null,
    );
  }

  function renderForm({ keepScroll = false } = {}) {
    state.view = 'form';
    const s = state.scan;
    const list = profiles();
    const tot = totals();
    const notes = [];
    if (state.formError) notes.push(h('div', { class: 'notice bad', role: 'alert' }, icon('alert'), h('div', {}, state.formError)));
    const locked = importableGroups().flatMap((g) => (g.content?.worlds?.items || []).filter((w) => w.locked).map((w) => w.name));
    if (locked.length) notes.push(h('div', { class: 'notice' }, icon('alert'), h('div', {}, t('mcimport.lockedNote', { count: locked.length, name: locked[0] }))));
    for (const e of s.errors || []) notes.push(h('div', { class: 'notice' }, icon('alert'), h('div', {}, t('mcimport.fileError', { file: e.file }))));
    // Enlaces y uniones (por ejemplo saves/ o shaderpacks/ movidos a otro disco): se saltean y su contenido no cuenta
    if (s.links > 0) notes.push(h('div', { class: 'notice info' }, icon('info'), h('div', {}, t('mcimport.linksNote', { count: s.links }))));
    if (s.partial) notes.push(h('div', { class: 'notice info' }, icon('info'), h('div', {}, t('mcimport.partialNote'))));

    const importableCount = list.filter(importable).length;
    const allOn = importableCount > 0 && list.filter(importable).every((p) => state.selected.has(p.id));
    const toggleAll = h(
      'button',
      {
        type: 'button',
        class: 'btn ghost sm mci-all',
        'data-fk': 'all',
        disabled: !importableCount,
        onclick: () => {
          if (allOn) state.selected.clear();
          else list.filter(importable).forEach((p) => state.selected.add(p.id));
          syncTargets();
          refresh();
        },
      },
      allOn ? t('mcimport.selectNone') : t('mcimport.selectAll'),
    );
    const source = h(
      'div',
      { class: 'mci-source' },
      h('span', { class: 'mci-source-icon', 'aria-hidden': 'true' }, icon('folder')),
      h('div', { class: 'mci-source-text' }, h('div', { class: 'mci-source-label' }, s.isDefault ? t('mcimport.sourceDetected') : t('mcimport.sourcePicked')), h('div', { class: 'mci-source-path wrap-anywhere', title: s.dir }, s.dir)),
      pickButton('btn sm'),
    );
    const groups = importableGroups();
    const contentPart = groups.length
      ? [sectionTitle('layers', t('mcimport.contentTitle'), t('mcimport.contentHint')), h('div', { class: 'mci-groups' }, groups.map(groupCard))]
      : [sectionTitle('layers', t('mcimport.contentTitle')), h('div', { class: 'mci-empty-line' }, icon('info'), t('mcimport.noContent'))];
    const importBtn = h('button', { type: 'button', class: 'btn primary', 'data-fk': 'import', disabled: !tot.profiles }, icon('download'), tot.profiles ? t('mcimport.importBtn', { count: tot.profiles }) : t('mcimport.importNone'));
    importBtn.addEventListener('click', () => doImport(importBtn));
    const summary = h('div', { class: 'mci-foot-summary', 'aria-live': 'polite' }, icon('drive'), h('span', { class: 'ellipsis' }, tot.bytes ? t('mcimport.footSummary', { size: fmtBytes(tot.bytes) }) : t('mcimport.footNothing')));
    show(
      [
        source,
        ...notes,
        sectionTitle('user', t('mcimport.profilesTitle', { count: list.length }), t('mcimport.profilesHint'), toggleAll),
        h('div', { class: 'mci-profiles', role: 'group', 'aria-label': t('mcimport.profilesLabel') }, list.map(profileRow)),
        ...contentPart,
        h('p', { class: 'mci-privacy' }, icon('shieldCheck'), t('mcimport.privacyNote')),
      ],
      [summary, h('button', { type: 'button', class: 'btn ghost', onclick: () => m.close() }, t('mcimport.cancel')), importBtn],
      { keepScroll },
    );
  }

  // ----- Importar -----
  function onResult(r) {
    if (!alive) return;
    state.result = r;
    showDone();
  }

  async function doImport(btn) {
    if (running) return;
    const payload = selectionPayload();
    if (!payload.profiles.length) return;
    setBusy(btn);
    // El error de un intento anterior ya no vale (si este vuelve al formulario, muestra el suyo o ninguno)
    state.formError = null;
    state.ownRun = true;
    showProgress();
    listeners.add(onResult);
    try {
      const r = await startImport(payload);
      listeners.delete(onResult);
      await store.refreshInstances().catch(() => {});
      const ids = (r?.instances || []).map((x) => x.id);
      // Una falla de quien abrio el dialogo (por ejemplo la bienvenida ya cerrada) no convierte la importacion en error
      try {
        if (ids.length) opts.onImported?.(ids, r);
      } catch (err) {
        console.warn('[mcimport] onImported', err);
      }
      onResult(r);
    } catch (err) {
      listeners.delete(onResult);
      if (!alive) return;
      if (err?.code === 'cancelled') return showCancelled();
      // Vuelve al formulario (con la misma seleccion) y explica que paso.
      state.formError = isMissing(err) ? t('mcimport.unavailable') : errText(err);
      renderForm();
    } finally {
      state.ownRun = false;
      offTask();
    }
  }

  function showCancelled() {
    state.view = 'cancelled';
    const back = h('button', { type: 'button', class: 'btn primary', 'data-fk': 'back', onclick: () => renderForm() }, icon('arrowLeft'), t('mcimport.backToForm'));
    show([h('div', { class: 'mci-empty' }, emptyState('info', t('mcimport.cancelledTitle'), t('mcimport.cancelledText')))], [h('button', { type: 'button', class: 'btn ghost', onclick: () => m.close() }, t('mcimport.close')), back]);
  }

  function showDone() {
    state.view = 'done';
    const r = state.result || {};
    const list = Array.isArray(r.instances) ? r.instances : [];
    const stats = r.stats || {};
    const notes = [];
    if (stats.links) notes.push(h('div', { class: 'notice info mci-done-note' }, icon('info'), h('div', {}, t('mcimport.doneLinks', { count: stats.links }))));
    if (stats.skipped || stats.outside) notes.push(h('div', { class: 'notice mci-done-note' }, icon('alert'), h('div', {}, t('mcimport.doneSkipped', { count: (stats.skipped || 0) + (stats.outside || 0) }))));
    const rows = list.map((x) =>
      h(
        'li',
        { class: 'mci-done-item' },
        h('span', { class: 'mci-prof-icon', 'aria-hidden': 'true', style: { '--c': LOADERS[x.loader]?.color || 'var(--muted)' } }, initial(x.name)),
        h('span', { class: 'mci-done-main' }, h('span', { class: 'mci-done-name ellipsis', title: x.name }, x.name), h('span', { class: 'mci-done-sub' }, t('mcimport.doneItemSub', { version: x.mcVersion, loader: loaderName(x.loader) }))),
        fromWelcome
          ? null
          : h(
              'button',
              {
                type: 'button',
                class: 'btn sm',
                onclick: () => {
                  m.close();
                  navigate(`instance/${encodeURIComponent(x.id)}`);
                },
              },
              icon('arrowRight'),
              t('mcimport.openInstance'),
            ),
      ),
    );
    const primary = fromWelcome
      ? h('button', { type: 'button', class: 'btn primary', 'data-fk': 'done', onclick: () => m.close() }, icon('check'), t('mcimport.doneContinue'))
      : h(
          'button',
          {
            type: 'button',
            class: 'btn primary',
            'data-fk': 'done',
            onclick: () => {
              m.close();
              navigate('versions');
            },
          },
          icon('layers'),
          t('mcimport.seeInstances'),
        );
    show(
      [
        h(
          'div',
          { class: 'mci-done' },
          h('div', { class: 'mci-done-art', 'aria-hidden': 'true' }, icon('check')),
          h('div', { class: 'mci-done-title' }, t('mcimport.doneTitle', { count: list.length })),
          h('p', { class: 'mci-done-text' }, fromWelcome ? t('mcimport.doneTextWelcome') : t('mcimport.doneText')),
          h('ul', { class: 'mci-done-list' }, rows),
          ...notes,
        ),
      ],
      [fromWelcome ? null : h('button', { type: 'button', class: 'btn ghost', onclick: () => m.close() }, t('mcimport.close')), primary],
    );
    setTimeout(() => m.el.querySelector('[data-fk="done"]')?.focus({ preventScroll: true }), 30);
  }

  // Importacion que empezo otra ventana del dialogo (se reabrio mientras corria): final sin detalle.
  function showDoneSimple(detail) {
    state.view = 'done';
    show(
      [h('div', { class: 'mci-done' }, h('div', { class: 'mci-done-art', 'aria-hidden': 'true' }, icon('check')), h('div', { class: 'mci-done-title' }, t('mcimport.doneSimple')), detail ? h('p', { class: 'mci-done-text' }, detail) : null)],
      [h('button', { type: 'button', class: 'btn primary', 'data-fk': 'done', onclick: () => (m.close(), fromWelcome ? null : navigate('versions')) }, icon('layers'), fromWelcome ? t('mcimport.doneContinue') : t('mcimport.seeInstances'))],
    );
  }

  // Si ya hay una importacion corriendo (se cerro el dialogo y se volvio a abrir), se muestra su progreso.
  if (running) {
    state.ownRun = false;
    showProgress();
    listeners.add(onResult);
    running.promise.then(onResult, () => alive && load());
    return;
  }
  let status = null;
  try {
    status = await api.invoke('mcimport:status');
  } catch {
    status = null;
  }
  if (status?.running) {
    state.ownRun = false;
    showProgress();
    return;
  }
  load();
}

// ---------- Bienvenida: tarjeta "¿Venís del launcher oficial?" ----------

let welcomeImported = false;

function welcomeCard(info, onImported) {
  let text;
  if (info.profiles && info.worlds) text = t('mcimport.wlFoundBoth', { profiles: t('mcimport.nProfiles', { count: info.profiles }), worlds: t('mcimport.nWorlds', { count: info.worlds }) });
  else if (info.worlds) text = t('mcimport.wlFoundWorlds', { count: info.worlds });
  else text = t('mcimport.wlFoundProfiles', { count: info.profiles });
  const btn = h('button', { type: 'button', class: 'btn tonal sm mci-wl-btn', 'data-fk': 'mci-open' }, icon('download'), t('mcimport.wlButton'));
  btn.addEventListener('click', () => {
    openOfficialImport({
      from: 'welcome',
      onImported: (ids, r) => {
        welcomeImported = true;
        onImported?.(ids, r);
      },
    }).catch((err) => console.warn('[mcimport] dialogo', err));
  });
  return h(
    'div',
    { class: 'mci-wl', role: 'note' },
    h('span', { class: 'mci-wl-icon', 'aria-hidden': 'true' }, icon('mciBlock')),
    h('div', { class: 'mci-wl-text' }, h('div', { class: 'mci-wl-title' }, t('mcimport.wlTitle')), h('div', { class: 'mci-wl-sub' }, text, ' ', h('span', { class: 'mci-wl-safe' }, t('mcimport.wlSafe')))),
    btn,
  );
}

// slot: contenedor (oculto) que pone la bienvenida. Si hay algo para traer, se llena y se muestra; si la
// deteccion falla o no encuentra nada, queda oculto. Con la deteccion ya hecha se llena en el momento.
export function welcomeSuggestion(slot, { onImported } = {}) {
  if (!slot || welcomeImported) return;
  // Nunca rompe la bienvenida: cualquier falla deja la tarjeta oculta (la bienvenida la llama mientras dibuja).
  const fill = (info) => {
    try {
      if (!info?.found || welcomeImported) {
        slot.hidden = true;
        return;
      }
      mount(slot, welcomeCard(info, onImported));
      slot.hidden = false;
    } catch (err) {
      console.warn('[mcimport] tarjeta de la bienvenida', err);
      slot.hidden = true;
    }
  };
  if (detected && readyPromise && has('mcimport.wlTitle')) {
    ensureCss('features/mcimport');
    fill(detected.value);
    return;
  }
  ready()
    .then(() => detectOfficial())
    .then(fill)
    .catch(() => {
      slot.hidden = true;
    });
}
