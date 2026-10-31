// Piezas compartidas por las paginas de Versiones e Instancia: datos visuales de loaders (incluye Babric),
// menu emergente, acciones de instancia, funciones de otros modulos (features), importacion y arrastrar y soltar.
import { h, icon, mount, toast, ok, fail, confirmDialog, promptDialog, registerIcons, LOADERS, loaderVersionLabel } from '../../ui.js';
import { store, api } from '../../store.js';
import { t, loadNs } from '../../i18n.js';
import { navigate, launchInstance } from '../../app.js';
import { INSTANCE_SORTS, instanceLoaderKind } from './catalog.js';

registerIcons({
  vsDashboard: '<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>',
  vsPlayCircle: '<circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8" fill="currentColor"/>',
  vsServerCopy: '<rect width="20" height="8" x="2" y="2" rx="2"/><path d="M6 6h.01"/><path d="M2 14h7"/><path d="M6 18h.01"/><rect width="9" height="8" x="13" y="13" rx="2"/>',
});

// ---------- Loaders ----------

export const LOADER_KINDS = ['vanilla', 'fabric', 'quilt', 'forge', 'neoforge', 'optifine', 'iris', 'legacyfabric', 'babric'];
const EXTRA_LOADERS = { babric: { name: 'Babric', color: '#4fb3a9', letter: 'B' } };
export const MOD_LOADERS = ['fabric', 'quilt', 'forge', 'neoforge', 'legacyfabric', 'babric'];

export function loaderMeta(kind) {
  const base = LOADERS[kind] || EXTRA_LOADERS[kind];
  if (!base) return { name: kind || '?', color: 'var(--muted)', letter: String(kind || '?').charAt(0).toUpperCase(), desc: '' };
  return {
    name: base.name,
    color: base.color,
    letter: base.letter,
    get desc() {
      return LOADERS[kind] ? LOADERS[kind].desc : t(`versions.loaderDesc_${kind}`);
    },
  };
}

export function loaderBadgeFor(kind, version) {
  const meta = loaderMeta(kind);
  return h(
    'span',
    { class: 'badge loader-badge', style: { '--c': meta.color } },
    h('span', { class: 'ld' }),
    meta.name,
    version ? h('span', { class: 'muted ld-ver ellipsis', title: version }, version) : null,
  );
}

export function instanceBadge(inst) {
  return loaderBadgeFor(instanceLoaderKind(inst), loaderVersionLabel(inst));
}

export function supportsMods(inst) {
  return MOD_LOADERS.includes(inst?.loader);
}

export function supportsShaders(inst) {
  return inst?.loader === 'optifine' || inst?.preset === 'iris' || Boolean(inst?.modrinth?.projects?.YL57xq9U);
}

// Icono de la instancia (imagen del modpack o letra con el color del loader).
export function instIcon(inst, cls = '') {
  if (inst?.icon && /^https?:\/\//.test(inst.icon)) {
    const img = h('img', { src: inst.icon, alt: '', loading: 'lazy' });
    const box = h('div', { class: `inst-icon ${cls}` }, img);
    img.addEventListener('error', () => mount(box, (inst.name || '?').trim().charAt(0).toUpperCase()), { once: true });
    return box;
  }
  const meta = loaderMeta(instanceLoaderKind(inst));
  return h(
    'div',
    { class: `inst-icon ${cls}`, 'aria-hidden': 'true', style: { background: `linear-gradient(135deg, ${meta.color}, color-mix(in srgb, ${meta.color} 45%, var(--surface)))` } },
    (inst?.name || meta.letter).trim().charAt(0).toUpperCase() || meta.letter,
  );
}

// Redibuja una zona que se actualiza sola (progreso, juego en curso) sin perder el foco del teclado:
// los controles que pueden tener el foco llevan data-fk con una clave estable.
export function keepFocus(box, render) {
  const active = document.activeElement;
  const key = active && box.contains(active) ? active.dataset?.fk : null;
  render();
  if (key) box.querySelector(`[data-fk="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
}

// Skeleton de bloques sueltos (capturas, mosaicos): cls da la forma de la grilla y de cada bloque.
// Se anuncia una sola vez como "Cargando..." y respeta el movimiento reducido (clases de main.css).
export function skeletonBlocks(count, { cls = '', label } = {}) {
  return h(
    'div',
    { class: 'skeleton-group', role: 'status', 'aria-live': 'polite', 'aria-busy': 'true' },
    h('span', { class: 'sr-only' }, label || t('common.loading')),
    h('div', { class: `skeleton-shapes ${cls}`, 'aria-hidden': 'true' }, Array.from({ length: count }, () => h('span', { class: 'skeleton' }))),
  );
}

export function kindLabel(kind) {
  return t(`versions.kind_${kind}`);
}

// ---------- Utilidades ----------

export function iconButton(name, label, onclick, cls = '') {
  return h('button', { class: `icon-btn sm ${cls}`, title: label, 'aria-label': label, type: 'button', onclick }, icon(name));
}

// Ruta local -> URL file:/// (para imagenes de mundos y capturas).
export function fileUrl(p, version) {
  const parts = String(p || '').replace(/\\/g, '/').split('/');
  const enc = parts.map((s, i) => (i === 0 && /^[a-zA-Z]:$/.test(s) ? s : encodeURIComponent(s))).join('/');
  return `file:///${enc.replace(/^\/+/, '')}${version ? `?v=${encodeURIComponent(version)}` : ''}`;
}

export function isRunning(id) {
  return store.running[id]?.state === 'running';
}

export function isBusy(id) {
  return Boolean(store.running[id] || store.taskFor(id));
}

// Preferencias de la vista de instancias (clave propia en los ajustes: settings.versions).
// Los cambios se guardan tambien en memoria para que dos cambios seguidos no se pisen.
let pendingPrefs = {};
export function viewPrefs() {
  const p = { ...(store.settings?.versions || {}), ...pendingPrefs };
  return {
    view: p.view === 'list' ? 'list' : 'grid',
    sort: INSTANCE_SORTS.includes(p.sort) ? p.sort : 'recent',
    group: Boolean(p.group),
    allLoaderVersions: Boolean(p.allLoaderVersions),
  };
}

export function saveViewPrefs(patch) {
  pendingPrefs = { ...pendingPrefs, ...patch };
  return store.setSettings({ versions: viewPrefs() }).catch((err) => console.warn('[versions] ajustes', err));
}

// ---------- Menu emergente ----------

let openMenu = null;

export function closeMenu() {
  if (!openMenu) return;
  const m = openMenu;
  openMenu = null;
  m.cleanup();
}

// items: [{ icon, label, run, danger?, disabled? } | '-']
export function popMenu(anchor, items) {
  if (openMenu?.anchor === anchor) return closeMenu();
  closeMenu();
  const list = items.filter(Boolean);
  const el = h(
    'div',
    { class: 'vs-menu', role: 'menu' },
    list.map((it) =>
      it === '-'
        ? h('div', { class: 'vs-menu-sep', role: 'separator' })
        : h(
            'button',
            {
              class: ['vs-menu-item', it.danger && 'danger'],
              role: 'menuitem',
              type: 'button',
              disabled: it.disabled,
              onclick: (e) => {
                e.stopPropagation();
                closeMenu();
                it.run();
              },
            },
            icon(it.icon),
            h('span', {}, it.label),
          ),
    ),
  );
  document.body.append(el);
  const r = anchor.getBoundingClientRect();
  const mr = el.getBoundingClientRect();
  const left = Math.max(8, Math.min(r.right - mr.width, window.innerWidth - mr.width - 8));
  let top = r.bottom + 6;
  if (top + mr.height > window.innerHeight - 8) top = r.top - mr.height - 6;
  top = Math.max(8, Math.min(top, window.innerHeight - mr.height - 8));
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  const buttons = [...el.querySelectorAll('.vs-menu-item:not(:disabled)')];
  buttons[0]?.focus();
  anchor.setAttribute('aria-expanded', 'true');
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeMenu();
      anchor.focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const i = buttons.indexOf(document.activeElement);
      const n = e.key === 'ArrowDown' ? (i + 1) % buttons.length : (i - 1 + buttons.length) % buttons.length;
      buttons[n]?.focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      buttons[e.key === 'Home' ? 0 : buttons.length - 1]?.focus();
    } else if (e.key === 'Tab') closeMenu();
  };
  const onDown = (e) => {
    if (!el.contains(e.target) && !anchor.contains(e.target)) closeMenu();
  };
  const onScroll = (e) => {
    if (!el.contains(e.target)) closeMenu();
  };
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('mousedown', onDown, true);
  window.addEventListener('resize', closeMenu);
  window.addEventListener('blur', closeMenu);
  document.addEventListener('scroll', onScroll, true);
  openMenu = {
    anchor,
    cleanup: () => {
      el.remove();
      anchor.removeAttribute('aria-expanded');
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('resize', closeMenu);
      window.removeEventListener('blur', closeMenu);
      document.removeEventListener('scroll', onScroll, true);
    },
  };
  return undefined;
}

// ---------- Funciones de otros modulos (features) ----------

const FEATURE_NS = {
  crash: ['crash'],
  snapshots: ['snapshots'],
  packs: ['packs'],
  share: ['share'],
  cloudsync: ['cloudsync'],
  compat: ['compat'],
  netplay: ['netplay'],
  analysis: ['analysis'],
  perf: ['perf', 'performance'],
  worldmap: ['worldmap'],
  modtranslate: ['modtranslate'],
};

// Carga un feature (se importa al usarlo: si otro modulo falla, esta pagina sigue andando).
export async function feature(name) {
  const mod = await import(`../../features/${name}.js`);
  await loadNs(...(FEATURE_NS[name] || [name])).catch(() => {});
  return mod;
}

export async function runFeature(name, fn, ...args) {
  try {
    const mod = await feature(name);
    if (typeof mod[fn] !== 'function') throw new Error(t('instance.toolMissing'));
    return await mod[fn](...args);
  } catch (err) {
    console.error(`[versions] ${name}.${fn}`, err);
    fail(t('instance.toolFailed'), err);
    return undefined;
  }
}

// ---------- Acciones de instancia ----------

export async function renameInstance(inst) {
  const name = await promptDialog(t('instance.renameTitle'), t('instance.nameLabel'), { value: inst.name, okText: t('instance.save') });
  const clean = (name || '').replace(/\s+/g, ' ').trim();
  if (!clean || clean === inst.name) return null;
  try {
    const updated = await api.instances.update(inst.id, { name: clean });
    await store.refreshInstances();
    ok(t('instance.renamed'), updated.name);
    return updated;
  } catch (err) {
    fail(t('instance.renameFailed'), err);
    return null;
  }
}

export async function duplicateInstance(inst) {
  toast('info', t('instance.duplicating'), inst.name, 2500);
  try {
    const copy = await api.instances.duplicate(inst.id);
    await store.refreshInstances();
    ok(t('instance.duplicated'), copy.name);
    return copy;
  } catch (err) {
    fail(t('instance.duplicateFailed'), err);
    return null;
  }
}

export async function deleteInstance(inst) {
  if (store.running[inst.id]) {
    fail(t('instance.deleteTitle'), t('instance.deleteRunning'));
    return false;
  }
  const yes = await confirmDialog(t('instance.deleteTitle'), t('instance.deleteText', { name: inst.name }), { okText: t('instance.delete'), danger: true });
  if (!yes) return false;
  try {
    await api.instances.remove(inst.id);
    await store.refreshInstances();
    ok(t('instance.deleted'), inst.name);
    return true;
  } catch (err) {
    fail(t('instance.deleteFailed'), err);
    return false;
  }
}

export function repairInstance(inst) {
  return api.instances
    .repair(inst.id)
    .then(() => ok(t('instance.repaired'), inst.name))
    .catch((err) => fail(t('instance.repairFailed'), err));
}

export function openFolder(inst, sub) {
  return api.instances.openFolder(inst.id, sub).catch((err) => fail(t('instance.openFolderFailed'), err));
}

export async function playInstance(inst, opts) {
  return launchInstance(inst.id, opts);
}

// "Crear servidor espejo": servidor local con la misma version, loader y mods (lo crea el modulo de servidores).
export async function mirrorServer(inst) {
  try {
    const res = await api.invoke('servers:createFromInstance', inst.id);
    const sid = typeof res === 'string' ? res : res?.id;
    ok(t('instance.mirrorCreated'), inst.name);
    if (sid) navigate(`server/${encodeURIComponent(sid)}`);
  } catch (err) {
    if (/No handler registered/i.test(err.message)) toast('info', t('instance.mirrorUnavailable'), t('instance.mirrorUnavailableText'), 6000);
    else fail(t('instance.mirrorFailed'), err);
  }
}

export function instanceMenuItems(inst, { onDeleted, manage = true } = {}) {
  return [
    manage ? { icon: 'vsDashboard', label: t('instance.manage'), run: () => navigate(`instance/${encodeURIComponent(inst.id)}`) } : null,
    { icon: 'folder', label: t('instance.openFolder'), run: () => openFolder(inst) },
    { icon: 'edit', label: t('instance.rename'), run: () => renameInstance(inst) },
    { icon: 'copy', label: t('instance.duplicate'), run: () => duplicateInstance(inst) },
    { icon: 'wrench', label: t('instance.repair'), run: () => repairInstance(inst), disabled: isBusy(inst.id) },
    '-',
    {
      icon: 'trash',
      label: t('instance.delete'),
      danger: true,
      run: async () => {
        if ((await deleteInstance(inst)) && onDeleted) onDeleted();
      },
    },
  ];
}

// ---------- Importar modpacks ----------

export async function importMrpack(file) {
  toast('info', t('versions.importing'), t('versions.importingText'));
  try {
    const inst = await api.modrinth.installModpack({ file });
    await store.refreshInstances();
    ok(t('versions.imported'), inst?.name);
    return inst;
  } catch (err) {
    fail(t('versions.importFailed'), err);
    return null;
  }
}

export async function pickMrpack() {
  const files = await api.app.selectFiles({ title: t('versions.pickMrpack'), filters: [{ name: t('versions.mrpackFilter'), extensions: ['mrpack'] }] });
  if (files.length) importPackFile(files[0]);
}

// CurseForge / MultiMC / Prism: lo resuelve el modulo de modpacks (si le llega una ruta, la puede usar).
export function importOtherPack(file) {
  return runFeature('packs', 'openImportPack', file);
}

// Un modpack ya elegido (.mrpack o .zip): el importador del modulo de modpacks muestra la vista previa,
// revisa el contenido del archivo y crea la instancia. Si ese modulo no carga, los .mrpack se instalan directo.
export async function importPackFile(file) {
  let mod = null;
  try {
    mod = await feature('packs');
  } catch (err) {
    console.warn('[versions] modulo de modpacks', err);
  }
  if (typeof mod?.openImportPack === 'function') {
    try {
      return await mod.openImportPack(file);
    } catch (err) {
      console.error('[versions] packs.openImportPack', err);
      if (!/\.mrpack$/i.test(file)) {
        fail(t('instance.toolFailed'), err);
        return null;
      }
    }
  }
  if (/\.mrpack$/i.test(file)) return importMrpack(file);
  fail(t('instance.toolFailed'), t('instance.toolMissing'));
  return null;
}

// Codigo de un modpack compartido (PACK-XXXXXX): vista previa e importacion del modulo share.
export function importShareCode(code) {
  return runFeature('share', 'openImportCode', code);
}

// Opciones del menu "Importar" (cabecera de Versiones y estado vacio).
export function importMenuItems() {
  return [
    { icon: 'package', label: t('versions.importMrpack'), run: pickMrpack },
    { icon: 'hash', label: t('versions.useCodeLong'), run: () => importShareCode() },
    { icon: 'archive', label: t('versions.importOther'), run: () => importOtherPack() },
  ];
}

// Soltar archivos en Versiones: se importa un modpack por vez (el primero que se reconozca).
export function handlePackDrop(files) {
  const packs = files.filter((f) => /\.(mrpack|zip)$/i.test(f));
  if (!packs.length) {
    toast('info', t('versions.dropUnsupported'), t('versions.dropUnsupportedText'), 6000);
    return;
  }
  importPackFile(packs[0]);
  if (packs.length > 1) toast('info', t('versions.dropOneAtATime'), t('versions.dropOneAtATimeText', { count: packs.length - 1 }), 7000);
}

// ---------- Arrastrar y soltar ----------

function hasFiles(e) {
  return [...(e.dataTransfer?.types || [])].includes('Files');
}

// Evita que soltar un archivo fuera de una zona de arrastre haga navegar la ventana hacia ese archivo.
// Se registra antes que las zonas (dropZone), que despues marcan la copia como permitida.
export function guardDrops(el) {
  const onOver = (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'none';
  };
  const onDrop = (e) => {
    if (hasFiles(e)) e.preventDefault();
  };
  el.addEventListener('dragover', onOver);
  el.addEventListener('drop', onDrop);
  return () => {
    el.removeEventListener('dragover', onOver);
    el.removeEventListener('drop', onDrop);
  };
}

// Muestra una capa sobre el area principal mientras se arrastran archivos y llama a onFiles(rutas).
export function dropZone(target, { label, hint, onFiles, enabled = () => true }) {
  let depth = 0;
  const overlay = h('div', { class: 'vs-drop', 'aria-hidden': 'true' }, h('div', { class: 'vs-drop-box' }, icon('upload'), h('div', { class: 'vs-drop-title' }, label), hint ? h('div', { class: 'vs-drop-hint' }, hint) : null));
  const show = () => {
    const main = document.getElementById('main') || target;
    const r = main.getBoundingClientRect();
    Object.assign(overlay.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    if (!overlay.isConnected) document.body.append(overlay);
  };
  const hide = () => {
    depth = 0;
    overlay.remove();
  };
  const onEnter = (e) => {
    if (!hasFiles(e) || !enabled()) return;
    e.preventDefault();
    depth++;
    show();
  };
  const onOver = (e) => {
    if (!hasFiles(e) || !enabled()) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };
  const onLeave = (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) hide();
  };
  const onDrop = (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    hide();
    if (!enabled()) return;
    const files = [...(e.dataTransfer?.files || [])].map((f) => api.app.pathForFile(f)).filter(Boolean);
    if (files.length) onFiles(files);
  };
  target.addEventListener('dragenter', onEnter);
  target.addEventListener('dragover', onOver);
  target.addEventListener('dragleave', onLeave);
  target.addEventListener('drop', onDrop);
  return () => {
    hide();
    target.removeEventListener('dragenter', onEnter);
    target.removeEventListener('dragover', onOver);
    target.removeEventListener('dragleave', onLeave);
    target.removeEventListener('drop', onDrop);
  };
}
