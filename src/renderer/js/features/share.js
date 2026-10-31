// Compartir instancias con un código corto ("Pasame tu setup"), modpacks en grupo que se sincronizan solos
// al abrir el launcher, invitaciones a amigos e importación por código. Supabase se usa desde acá
// (cloud.client: códigos, grupos y revisiones); los archivos los maneja el proceso principal (share:*).
//
// Contrato (docs/arquitectura.md §6):
//   startup()                   al abrir: sincroniza los grupos, escucha invitaciones y Ctrl+V de códigos
//   openShareDialog(instanceId) crear código o grupo, publicar revisiones, miembros e invitaciones
//   openImportCode(code?)       vista previa de un código -> instancia nueva idéntica o vincular una existente
//   groupBadge(instance)        "Grupo: <nombre> · al día / actualizando" (o null si no está en un grupo)
import {
  h,
  icon,
  mount,
  modal,
  toast,
  ok,
  fail,
  confirmDialog,
  promptDialog,
  ensureCss,
  fmtBytes,
  fmtAgo,
  copyText,
  loaderBadge,
  instanceIcon,
  instanceLoaderKey,
  loaderVersionLabel,
  emptyState,
  switchEl,
  avatarImg,
  setBusy,
  registerIcons,
  LOADERS,
} from '../ui.js';
import { store, api } from '../store.js';
import { t, loadNs, has } from '../i18n.js';
import { cloud } from '../cloud.js';
import { social } from '../social.js';
import { navigate } from '../app.js';

registerIcons({ shrUp: '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>' });

// fmtAgo en medio de una frase: 'Subido hace un momento' (no 'Subido Hace un momento').
const agoText = (ts) => {
  const s = fmtAgo(ts);
  return s ? s.charAt(0).toLocaleLowerCase() + s.slice(1) : s;
};

const CODE_RE = /^PACK-[A-HJ-NP-Z2-9]{6}$/;
const RESYNC_MS = 15 * 60 * 1000;
const PACK_COLS = 'id, code, name, revision, is_group, owner, created_at, updated_at';
const OPTION_FILES = ['options.txt', 'optionsof.txt', 'optionsshaders.txt'];
const TYPE_ICON = { mods: 'puzzle', resourcepacks: 'palette', shaderpacks: 'sun' };
const RPC_ERRORS = new Set([
  'auth',
  'bad_code',
  'throttled',
  'not_found',
  'not_group',
  'group_full',
  'too_many_groups',
  'too_many_packs',
  'bad_name',
  'bad_manifest',
  'too_large',
  'not_owner',
  'not_member',
]);

const syncState = new Map(); // instanceId -> { state, remoteRevision, error }
const stateListeners = new Set();
const badges = new Set();
let started = false;
let syncing = null;
let syncAgain = false;
let lastUser = null;
let uidSeq = 0;

async function ready() {
  ensureCss('features/share');
  try {
    await loadNs('share');
  } catch {
    /* sin textos se ven las claves, pero no se rompe nada */
  }
}

// "pack-ab12cd", " ab12cd " -> "PACK-AB12CD"
export function normalizeCode(raw) {
  const s = String(raw || '')
    .toUpperCase()
    .replace(/[\s_]/g, '');
  const m = s.match(/^(?:PACK-?)?([A-Z0-9]{6})$/);
  return m ? `PACK-${m[1]}` : s;
}

function cleanStr(v, max) {
  return typeof v === 'string' ? v.replace(/[\x00-\x1f]/g, ' ').trim().slice(0, max) : '';
}

// ---------- Errores de Supabase ----------

function sbError(error) {
  const code = String(error?.code || '');
  const msg = String(error?.message || error || '');
  if (['PGRST202', 'PGRST205', '42P01', '42883'].includes(code) || /schema cache|does not exist|Could not find the (function|table)/i.test(msg)) {
    // Falta la migracion 0004_share.sql en el servidor: el detalle queda en el log
    console.warn('[share] falta el esquema de compartir (0004_share.sql):', code, msg);
    return t('share.errSchema');
  }
  if (/Failed to fetch|NetworkError|fetch failed|network/i.test(msg)) return t('share.errNetwork');
  if (code === '42501' || /row-level security|permission denied/i.test(msg)) return t('share.errDenied');
  if (/JWT|token/i.test(msg)) return t('share.errSession');
  return msg || t('share.errUnknown');
}

async function rpc(fn, args) {
  const { data, error } = await cloud.client.rpc(fn, args);
  if (error) throw new Error(sbError(error));
  if (data && typeof data === 'object' && data.error) {
    const e = new Error(RPC_ERRORS.has(data.error) ? t(`share.rpc_${data.error}`) : t('share.errUnknown'));
    e.code = data.error;
    throw e;
  }
  return data;
}

function gate() {
  if (!cloud.isConfigured()) return 'noCloud';
  if (!cloud.isSignedIn()) return 'signedOut';
  return null;
}

function myId() {
  return cloud.user?.id || null;
}

// ---------- Piezas comunes ----------

function dialog(title, { size = 'wide', icon: iconName } = {}) {
  const body = h('div', { class: 'shr-dialog' });
  const foot = h('div', { class: 'shr-foot' });
  const ctl = { alive: true };
  const m = modal({
    title,
    icon: iconName,
    body,
    footer: [foot],
    size: `${size} shr-modal`,
    onClose: () => {
      ctl.alive = false;
      ctl.onClose?.();
    },
  });
  return Object.assign(ctl, {
    el: m.el,
    body,
    close: () => m.close(),
    show: (...nodes) => mount(body, ...nodes),
    footer: (...nodes) => mount(foot, ...nodes),
    setTitle(text) {
      const e = m.el.querySelector('.modal-head h3');
      if (e) e.textContent = text;
    },
  });
}

const closeBtn = (d, label = t('share.close')) => h('button', { class: 'btn ghost', type: 'button', onclick: () => d.close() }, label);

// Botón ocupado: spinner en lugar del ícono (setBusy de ui.js) y el texto de la acción en curso.
async function busyBtn(btn, label, fn) {
  const old = [...btn.childNodes];
  const firstIcon = old.find((n) => n instanceof SVGElement);
  mount(btn, firstIcon ? firstIcon.cloneNode(true) : null, label);
  const done = setBusy(btn);
  try {
    return await fn();
  } finally {
    if (btn.isConnected) mount(btn, ...old);
    done();
  }
}

// Esqueleto de carga: un solo anuncio para el lector de pantalla y formas que anticipan el contenido.
const bone = (cls, style) => h('span', { class: `skeleton ${cls}`, style });
const boneRow = () => h('div', { class: 'skeleton-row' }, bone('skeleton-icon'), h('div', { class: 'skeleton-lines' }, bone('skeleton-line'), bone('skeleton-line')));
function skel(label, ...shapes) {
  return h(
    'div',
    { class: 'skeleton-group', role: 'status', 'aria-live': 'polite', 'aria-busy': 'true' },
    h('span', { class: 'sr-only' }, label),
    h('div', { class: 'skeleton-shapes shr-skel', 'aria-hidden': 'true' }, shapes),
  );
}
const skelRows = (label, rows = 3) => skel(label, h('div', { class: 'skeleton-list' }, Array.from({ length: rows }, boneRow)));

// Vista "cargando" de los diálogos de anfitrión y de miembro: tarjeta del código + lista de miembros.
function packSkeleton(label) {
  return skel(
    label,
    h(
      'div',
      { class: 'shr-split' },
      h('div', { class: 'shr-col' }, h('div', { class: 'shr-skel-card' }, bone('skeleton-line title'), bone('skeleton-block', { height: '56px' }), h('div', { class: 'skeleton-lines' }, bone('skeleton-line'), bone('skeleton-line')))),
      h('div', { class: 'shr-col' }, bone('skeleton-line', { width: '30%' }), h('div', { class: 'skeleton-list' }, Array.from({ length: 3 }, boneRow))),
    ),
  );
}

function gateView(kind, d) {
  const isCfg = kind === 'noCloud';
  return h(
    'div',
    { class: 'shr-gate' },
    emptyState(
      isCfg ? 'cloud' : 'logIn',
      t(`share.gate_${kind}`),
      t(`share.gate_${kind}Text`),
      isCfg ? null : h(
        'button',
        {
          class: 'btn primary',
          type: 'button',
          onclick: () => {
            d.close();
            navigate('settings/cloud/venus');
          },
        },
        icon('logIn'),
        t(`share.gate_${kind}Btn`),
      ),
    ),
  );
}

function errorBox(message, retry) {
  return h(
    'div',
    { class: 'notice bad shr-error', role: 'alert' },
    icon('alert'),
    h('div', { class: 'spacer' }, message),
    retry ? h('button', { class: 'btn sm', type: 'button', onclick: retry }, icon('refresh'), t('share.retry')) : null,
  );
}

function thumb(src, fallback) {
  const box = h('div', { class: 'shr-thumb' });
  if (typeof src === 'string' && /^https:\/\//i.test(src)) {
    const img = h('img', { src, alt: '', loading: 'lazy' });
    img.addEventListener('error', () => mount(box, icon(fallback)), { once: true });
    box.append(img);
  } else box.append(icon(fallback));
  return box;
}

function versionBadges(mcVersion, loader, loaderVersion, preset) {
  const key = preset === 'iris' ? 'iris' : loader;
  const fake = { mcVersion, loader, loaderVersion };
  return [h('span', { class: 'badge' }, icon('box'), mcVersion), LOADERS[key] ? loaderBadge(key, loaderVersionLabel(fake)) : h('span', { class: 'badge' }, loader)];
}

function instHead(inst, extra) {
  return h(
    'div',
    { class: 'shr-head' },
    instanceIcon(inst, 'shr-head-icon'),
    h(
      'div',
      { class: 'shr-head-text' },
      h('div', { class: 'shr-head-name', title: inst.name }, inst.name),
      h('div', { class: 'row wrap shr-head-meta' }, h('span', { class: 'badge' }, icon('box'), inst.mcVersion), loaderBadge(instanceLoaderKey(inst), loaderVersionLabel(inst)), extra || null),
    ),
  );
}

function toggleRow(title, sub, checked, onChange) {
  return h('div', { class: 'toggle-row shr-toggle' }, h('div', { class: 'tr-text' }, h('div', { class: 'tr-title' }, title), sub ? h('div', { class: 'tr-sub' }, sub) : null), switchEl(checked, onChange, title));
}

function codeBox(code, { big = true } = {}) {
  return h(
    'div',
    { class: ['shr-code', big && 'big'] },
    h('span', { class: 'shr-code-text selectable', 'aria-label': t('share.codeAria', { code }) }, code),
    h('button', { class: 'btn sm', type: 'button', title: t('share.copyCode'), 'aria-label': t('share.copyCode'), onclick: () => copyText(code, t('share.codeCopied')) }, icon('copy'), t('share.copy')),
  );
}

function changeChips(s) {
  const chips = [];
  if (s.added) chips.push(h('span', { class: 'shr-chg add', title: t('share.chgAdded', { count: s.added }) }, `+${s.added}`));
  if (s.removed) chips.push(h('span', { class: 'shr-chg del', title: t('share.chgRemoved', { count: s.removed }) }, `−${s.removed}`));
  if (s.updated) chips.push(h('span', { class: 'shr-chg upd', title: t('share.chgUpdated', { count: s.updated }) }, icon('shrUp'), String(s.updated)));
  if (s.toggled) chips.push(h('span', { class: 'shr-chg tog', title: t('share.chgToggled', { count: s.toggled }) }, icon('power'), String(s.toggled)));
  if (s.configs) chips.push(h('span', { class: 'shr-chg cfg', title: t('share.chgConfigs', { count: s.configs }) }, icon('fileText'), String(s.configs)));
  if (s.version) chips.push(h('span', { class: 'shr-chg ver', title: t('share.chgVersion') }, icon('layers')));
  return h('span', { class: 'shr-chgs', role: 'img', 'aria-label': t('share.changesAria', { added: s.added || 0, removed: s.removed || 0, updated: s.updated || 0 }) }, chips);
}

function summaryText(r) {
  if (!r?.added && !r?.removed && !r?.updated && !r?.toggled && !r?.configs && !r?.version && !r?.options) return t('share.syncedNothing');
  const parts = [t('share.syncedChanges', { added: r.added || 0, removed: r.removed || 0, updated: r.updated || 0 })];
  if (r.configs) parts.push(t('share.syncedConfigs', { count: r.configs }));
  if (r.version?.to?.mcVersion) parts.push(t('share.syncedVersion', { version: r.version.to.mcVersion }));
  return parts.join(' · ');
}

async function snapshot(instanceId, reason) {
  try {
    const m = await import('./snapshots.js');
    if (typeof m.snapshotBefore === 'function') return await m.snapshotBefore(instanceId, reason);
  } catch (err) {
    console.warn('[share] instantánea:', err?.message || err);
  }
  return null;
}

function friendsList() {
  let raw = [];
  try {
    raw = Array.isArray(social?.friends) ? social.friends : [];
  } catch {
    raw = [];
  }
  return raw
    .filter((f) => f && f.id)
    .map((f) => ({ id: f.id, name: f.name || f.profile?.display_name || f.profile?.username || '?', mc: f.profile?.mc_name || null, online: Boolean(f.presence && f.presence !== 'offline') }))
    .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
}

// ---------- Estado de sincronización y la insignia de grupo ----------

function setState(id, patch) {
  syncState.set(id, { ...(syncState.get(id) || {}), ...patch });
  repaintBadges();
  for (const fn of stateListeners) {
    try {
      fn(id);
    } catch (err) {
      console.error(err);
    }
  }
}

const BADGE = {
  ok: { cls: 'good', icon: 'users' },
  updating: { cls: 'accent', spin: true },
  pending: { cls: 'warn', icon: 'clock' },
  available: { cls: 'warn', icon: 'download' },
  error: { cls: 'bad', icon: 'alert' },
  missing: { cls: 'bad', icon: 'alert' },
  offline: { cls: '', icon: 'users' },
  host: { cls: 'accent', icon: 'crown' },
};

function badgeState(id, share) {
  if (share.role === 'owner') return 'host';
  if (!cloud.isSignedIn()) return 'offline';
  const s = syncState.get(id)?.state;
  return !s || s === 'offline' ? 'ok' : s;
}

function paintBadge(b) {
  const fresh = store.instances.find((i) => i.id === b.id)?.share;
  if (fresh?.packId === b.share.packId) b.share = fresh;
  const st = badgeState(b.id, b.share);
  const meta = BADGE[st] || BADGE.ok;
  const name = b.share.name || b.share.code;
  const label = t(`share.badge_${st}`, { name });
  b.el.className = ['badge', 'shr-badge', meta.cls, `is-${st}`].filter(Boolean).join(' ');
  b.el.title = t(`share.badgeTip_${st}`, { name, revision: b.share.revision ?? 0 });
  b.el.setAttribute('aria-label', label);
  mount(b.el, meta.spin ? h('span', { class: 'spinner shr-badge-spin', 'aria-hidden': 'true' }) : icon(meta.icon), h('span', { class: 'shr-badge-text' }, label));
}

function repaintBadges() {
  const now = Date.now();
  for (const b of [...badges]) {
    if (!b.el.isConnected) {
      if (now - b.at > 5000) badges.delete(b);
      continue;
    }
    paintBadge(b);
  }
}

export function groupBadge(instance) {
  const s = instance?.share;
  if (!s || !s.packId || !s.isGroup || !['member', 'owner'].includes(s.role)) return null;
  ensureCss('features/share');
  const el = h('span', {
    role: 'button',
    tabindex: 0,
    onclick: (e) => {
      e.stopPropagation();
      e.preventDefault();
      openShareDialog(instance.id);
    },
    onkeydown: (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        openShareDialog(instance.id);
      }
    },
  });
  const b = { el, id: instance.id, share: s, at: Date.now() };
  for (const old of badges) if (!old.el.isConnected && b.at - old.at > 5000) badges.delete(old);
  badges.add(b);
  paintBadge(b);
  if (!has('share.badge_ok')) loadNs('share').then(() => paintBadge(b)).catch(() => {});
  return el;
}

// ---------- Sincronización de grupos (al abrir el launcher) ----------

async function syncInstance(inst, row, { manual = false } = {}) {
  setState(inst.id, { state: 'updating', remoteRevision: row.revision, error: null });
  try {
    const { data, error } = await cloud.client.from('shared_packs').select('id, manifest, revision, name').eq('id', row.id).single();
    if (error) throw new Error(sbError(error));
    const diff = await api.invoke('share:diff', inst.id, data.manifest);
    const s = diff.summary;
    const changes = s.added + s.removed + s.updated + s.toggled + s.configs + (s.version ? 1 : 0);
    let result = null;
    if (changes > 0) {
      await snapshot(inst.id, t('share.snapshotReason', { name: data.name, revision: data.revision }));
      result = await api.invoke('share:applyManifest', inst.id, data.manifest, { removeMissing: false, applyOptions: false, revision: data.revision });
    }
    await api.instances.update(inst.id, { share: { ...inst.share, name: data.name, revision: data.revision, syncedAt: Date.now() } });
    await rpc('mark_pack_synced', { p_pack_id: row.id, p_revision: data.revision }).catch((err) => console.warn('[share] mark_pack_synced:', err.message));
    await store.refreshInstances();
    setState(inst.id, { state: 'ok', remoteRevision: data.revision });
    if (result) {
      toast('good', t('share.syncedTitle', { name: data.name }), summaryText(result), 8000);
      if (result.warnings?.length) toast('info', t('share.syncWarnings', { name: data.name }), result.warnings.slice(0, 3).join(' · '), 10000);
    } else if (manual) toast('good', t('share.upToDateTitle'), t('share.upToDateText', { name: data.name }));
    return result || { added: 0, removed: 0, updated: 0 };
  } catch (err) {
    setState(inst.id, { state: 'error', error: err.message, remoteRevision: row.revision });
    toast('bad', t('share.syncFailed', { name: inst.name }), err.message, 9000);
    return null;
  }
}

async function syncOnce() {
  await Promise.resolve(cloud.ready()).catch(() => {});
  const linked = (store.instances || []).filter((i) => i.share?.packId && i.share.role === 'member' && i.share.isGroup);
  if (!linked.length) return;
  if (!cloud.isSignedIn()) {
    linked.forEach((i) => setState(i.id, { state: 'offline' }));
    return;
  }
  const ids = [...new Set(linked.map((i) => i.share.packId))];
  const { data, error } = await cloud.client.from('shared_packs').select(PACK_COLS).in('id', ids);
  if (error) {
    const message = sbError(error);
    linked.forEach((i) => setState(i.id, { state: 'error', error: message }));
    console.warn('[share] grupos:', message);
    return;
  }
  const byId = new Map((data || []).map((r) => [r.id, r]));
  for (const inst of linked) {
    const row = byId.get(inst.share.packId);
    if (!row || !row.is_group) {
      setState(inst.id, { state: 'missing' });
      continue;
    }
    if (row.revision <= (inst.share.revision || 0)) {
      setState(inst.id, { state: 'ok', remoteRevision: row.revision });
      continue;
    }
    if (store.running[inst.id]) {
      setState(inst.id, { state: 'pending', remoteRevision: row.revision });
      continue;
    }
    if (inst.share.auto === false) {
      if (syncState.get(inst.id)?.state !== 'available') toast('info', t('share.availableTitle', { name: row.name }), t('share.availableText', { name: inst.name }), 9000);
      setState(inst.id, { state: 'available', remoteRevision: row.revision });
      continue;
    }
    await syncInstance(inst, row);
  }
}

function syncGroups() {
  if (syncing) {
    syncAgain = true;
    return syncing;
  }
  syncing = (async () => {
    do {
      syncAgain = false;
      try {
        await syncOnce();
      } catch (err) {
        console.warn('[share] sincronización:', err?.message || err);
      }
    } while (syncAgain);
  })().finally(() => {
    syncing = null;
  });
  return syncing;
}

// ---------- Invitaciones y códigos pegados ----------

// Invitaciones que llegan por señal: el mismo código del mismo amigo se ignora durante 30 s y cada amigo abre como
// mucho 3 avisos por minuto, de a uno (igual que las invitaciones a mundos de netplay.js)
const INVITE_REPEAT_MS = 30000;
const INVITE_WINDOW_MS = 60000;
const INVITE_MAX = 3;
const inviteLog = new Map(); // remitente -> [{ at, code }]
const inviteOpen = new Map(); // remitente -> diálogo abierto

function inviteAllowed(sender, code) {
  const now = Date.now();
  const recent = (inviteLog.get(sender) || []).filter((x) => now - x.at < INVITE_WINDOW_MS);
  const allowed = recent.length < INVITE_MAX && !recent.some((x) => x.code === code && now - x.at < INVITE_REPEAT_MS);
  if (allowed) recent.push({ at: now, code });
  inviteLog.set(sender, recent);
  return allowed;
}

function showInvite(evt) {
  const p = evt?.payload || {};
  const code = normalizeCode(p.code);
  if (!CODE_RE.test(code)) return;
  const sender = typeof evt?.fromId === 'string' ? evt.fromId : '?';
  if (!inviteAllowed(sender, code)) return;
  const from = cleanStr(evt.from, 40) || t('share.someone');
  const pack = cleanStr(p.name, 60) || code;
  if (store.instances.some((i) => i.share?.code === code && i.share.role !== 'owner')) {
    toast('info', t('share.inviteTitle'), t('share.inviteAlready', { name: from, pack }), 6000);
    return;
  }
  const mc = cleanStr(p.mcVersion, 20);
  const loader = LOADERS[p.loader] ? p.loader : null;
  // Un solo aviso abierto por amigo: el nuevo reemplaza al anterior
  inviteOpen.get(sender)?.close();
  const m = modal({
    title: t('share.inviteTitle'),
    size: 'shr-invite-modal',
    onClose: () => {
      if (inviteOpen.get(sender) === m) inviteOpen.delete(sender);
    },
    body: h(
      'div',
      { class: 'shr-invite' },
      avatarImg(evt.profile?.mc_name || from, 64, 'shr-invite-avatar'),
      h(
        'div',
        { class: 'shr-invite-body' },
        h('div', { class: 'shr-invite-text' }, t(p.group ? 'share.inviteTextGroup' : 'share.inviteText', { name: from, pack })),
        h('div', { class: 'row wrap shr-invite-meta' }, h('span', { class: 'kbd' }, code), mc ? h('span', { class: 'badge' }, icon('box'), mc) : null, loader ? loaderBadge(loader) : null),
      ),
    ),
    footer: [
      h('button', { class: 'btn ghost', type: 'button', onclick: () => m.close() }, t('share.notNow')),
      h(
        'button',
        {
          class: 'btn primary',
          type: 'button',
          onclick: () => {
            m.close();
            openImportCode(code);
          },
        },
        icon('eye'),
        t('share.viewPack'),
      ),
    ],
  });
  inviteOpen.set(sender, m);
}

function isEditable(el) {
  return Boolean(el?.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"]'));
}

function onPaste(e) {
  if (isEditable(e.target) || document.querySelector('.modal-backdrop') || document.body.classList.contains('onboarding')) return;
  const text = (e.clipboardData?.getData('text') || '').trim();
  if (text.length > 20) return;
  const code = normalizeCode(text);
  if (!CODE_RE.test(code) || !/PACK/i.test(text)) return;
  e.preventDefault();
  openImportCode(code);
}

// ---------- Arranque ----------

export async function startup() {
  if (started) return;
  started = true;
  await ready();
  document.addEventListener('paste', onPaste);
  try {
    social?.onSignal?.('pack-invite', (evt) => {
      ready().then(() => showInvite(evt));
    });
  } catch (err) {
    console.warn('[share] invitaciones:', err?.message || err);
  }
  // La nube de mundos arranca junto con esto (auto-sync al cerrar el juego y al abrir el launcher).
  import('./cloudsync.js')
    .then((m) => m.startup?.())
    .catch((err) => console.warn('[share] nube:', err?.message || err));
  await Promise.resolve(cloud.ready()).catch(() => {});
  lastUser = myId();
  cloud.on('auth', () => {
    const id = myId();
    if (id && id !== lastUser) {
      lastUser = id;
      syncGroups();
    } else if (!id) lastUser = null;
    repaintBadges();
  });
  // Al cerrar el juego se aplican las revisiones que quedaron pendientes.
  store.on('running', () => {
    const pending = [...syncState.entries()].some(([id, s]) => s.state === 'pending' && !store.running[id]);
    if (pending) syncGroups();
  });
  store.on('instances', () => repaintBadges());
  setInterval(() => syncGroups(), RESYNC_MS);
  await syncGroups();
}

// ---------- Diálogo: compartir ----------

export async function openShareDialog(instanceId) {
  await ready();
  await Promise.resolve(cloud.ready()).catch(() => {});
  let inst;
  try {
    inst = await api.instances.get(instanceId);
  } catch (err) {
    fail(t('share.errInstance'), err);
    return;
  }
  const d = dialog(t('share.shareTitle'), { icon: 'share' });
  const ctx = { d, inst };
  route(ctx);
}

function route(ctx) {
  const g = gate();
  if (g) {
    ctx.d.show(instHead(ctx.inst), gateView(g, ctx.d));
    ctx.d.footer(closeBtn(ctx.d));
    return;
  }
  const s = ctx.inst.share;
  if (s?.packId && s.role === 'member') memberView(ctx);
  else if (s?.packId && s.role === 'owner') ownerView(ctx);
  else createView(ctx);
}

function manifestSummary(m) {
  const by = (folder) => m.files.filter((e) => e.path.startsWith(`${folder}/`));
  const configs = m.configs.filter((c) => !OPTION_FILES.includes(c.path));
  const options = m.configs.filter((c) => OPTION_FILES.includes(c.path));
  const manual = m.manual || [];
  const bytes = m.files.reduce((a, e) => a + (e.size || 0), 0);
  const stat = (ic, count, label) => h('div', { class: ['shr-stat', !count && 'zero'] }, icon(ic), h('span', { class: 'shr-stat-num' }, String(count)), h('span', { class: 'shr-stat-label' }, label));
  return h(
    'div',
    { class: 'shr-summary' },
    h(
      'div',
      { class: 'shr-stats' },
      stat('puzzle', by('mods').length, t('share.statMods', { count: by('mods').length })),
      stat('palette', by('resourcepacks').length, t('share.statPacks', { count: by('resourcepacks').length })),
      stat('sun', by('shaderpacks').length, t('share.statShaders', { count: by('shaderpacks').length })),
      stat('fileText', configs.length, t('share.statConfigs', { count: configs.length })),
    ),
    m.files.length
      ? h(
          'div',
          { class: 'shr-list', role: 'list', 'aria-label': t('share.contentList') },
          m.files.map((e) =>
            h(
              'div',
              { class: ['shr-file', e.enabled === false && 'off'], role: 'listitem' },
              thumb(e.icon, TYPE_ICON[e.path.split('/')[0]] || 'puzzle'),
              h('div', { class: 'shr-file-main' }, h('div', { class: 'shr-file-title', title: e.title }, e.title), h('div', { class: 'shr-file-sub', title: e.path }, e.versionNumber || e.path.split('/')[1])),
              e.source === 'curseforge' ? h('span', { class: 'badge shr-cf' }, 'CurseForge') : null,
              e.enabled === false ? h('span', { class: 'badge' }, t('share.disabledBadge')) : null,
            ),
          ),
        )
      : h('div', { class: 'shr-list-empty small muted' }, t('share.noContent')),
    h(
      'div',
      { class: 'shr-foot-notes' },
      bytes ? h('span', { class: 'small muted' }, icon('download'), t('share.downloadSize', { size: fmtBytes(bytes) })) : null,
      options.length ? h('span', { class: 'small muted' }, icon('keyboard'), t('share.optionsIncluded')) : null,
      m.skipped?.secret ? h('span', { class: 'small muted' }, icon('lock'), t('share.secretSkipped', { count: m.skipped.secret })) : null,
      m.skipped?.large || m.skipped?.limit ? h('span', { class: 'small muted' }, icon('info'), t('share.largeSkipped', { count: (m.skipped.large || 0) + (m.skipped.limit || 0) })) : null,
    ),
    manual.length
      ? h(
          'div',
          { class: 'notice shr-manual' },
          icon('alert'),
          h(
            'div',
            { class: 'shr-manual-body' },
            h('strong', {}, t('share.manualTitle', { count: manual.length })),
            h('div', { class: 'small' }, t('share.manualText')),
            h('div', { class: 'shr-manual-list' }, manual.slice(0, 12).map((e) => h('span', { class: 'shr-manual-item', title: e.path }, e.title || e.path.split('/')[1])), manual.length > 12 ? h('span', { class: 'shr-manual-item more' }, t('share.andMore', { count: manual.length - 12 })) : null),
          ),
        )
      : null,
  );
}

function createView(ctx) {
  const { d } = ctx;
  const inst = ctx.inst;
  const opts = { mode: 'group', includeConfigs: true, includeOptions: false };
  let manifest = null;
  let token = 0;
  d.setTitle(t('share.shareTitle'));
  const nameInput = h('input', { class: 'input', value: inst.name, maxlength: 60, id: 'shr-name', autocomplete: 'off' });
  const modeBox = h('div', { class: 'shr-modes', role: 'radiogroup', 'aria-label': t('share.modeLabel') });
  const preview = h('div', { class: 'shr-preview card flat' });
  const createBtn = h('button', { class: 'btn primary', type: 'button', disabled: true });
  const setCreateLabel = () => mount(createBtn, icon(opts.mode === 'group' ? 'users' : 'share'), t(opts.mode === 'group' ? 'share.createGroup' : 'share.createCode'));
  const MODES = ['group', 'code'];
  const pickMode = (mode, focus) => {
    opts.mode = mode;
    drawModes();
    setCreateLabel();
    if (focus) modeBox.querySelector(`[data-mode="${mode}"]`)?.focus();
  };
  const drawModes = () =>
    mount(
      modeBox,
      MODES.map((mode) =>
        h(
          'button',
          {
            class: ['shr-mode', opts.mode === mode && 'active'],
            type: 'button',
            role: 'radio',
            'aria-checked': String(opts.mode === mode),
            tabindex: opts.mode === mode ? '0' : '-1',
            dataset: { mode },
            onclick: () => pickMode(mode),
          },
          h('span', { class: 'shr-mode-icon' }, icon(mode === 'group' ? 'users' : 'hash')),
          h('span', { class: 'shr-mode-text' }, h('span', { class: 'shr-mode-title' }, t(`share.mode_${mode}`)), h('span', { class: 'shr-mode-sub' }, t(`share.mode_${mode}Sub`))),
          h('span', { class: 'shr-mode-check', 'aria-hidden': 'true' }, icon('check')),
        ),
      ),
    );
  // Grupo de radios: las flechas cambian la opción elegida (y el foco va con ella).
  modeBox.addEventListener('keydown', (e) => {
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const i = MODES.indexOf(opts.mode);
    pickMode(MODES[(i + step + MODES.length) % MODES.length], true);
  });

  const rebuild = async () => {
    const my = ++token;
    createBtn.disabled = true;
    mount(
      preview,
      skel(
        t('share.analyzing'),
        h('div', { class: 'shr-skel-stats' }, bone(''), bone(''), bone(''), bone('')),
        h('div', { class: 'skeleton-list' }, Array.from({ length: 3 }, boneRow)),
      ),
      h('div', { class: 'shr-skel-note', 'aria-hidden': 'true' }, h('span', { class: 'spinner' }), t('share.analyzing')),
    );
    try {
      const m = await api.invoke('share:buildManifest', inst.id, { includeConfigs: opts.includeConfigs, includeOptions: opts.includeOptions });
      if (my !== token || !d.alive) return;
      manifest = m;
      mount(preview, manifestSummary(m));
      createBtn.disabled = false;
    } catch (err) {
      if (my !== token || !d.alive) return;
      manifest = null;
      mount(preview, errorBox(t('share.analyzeFailed', { error: err.message }), rebuild));
    }
  };

  createBtn.addEventListener('click', () => {
    if (!manifest) return;
    busyBtn(createBtn, t('share.creating'), async () => {
      const name = nameInput.value.replace(/\s+/g, ' ').trim().slice(0, 60) || inst.name;
      try {
        const { manifest: encoded } = await api.invoke('share:encode', manifest);
        const data = await rpc('create_shared_pack', { p_name: name, p_manifest: encoded, p_is_group: opts.mode === 'group' });
        const pack = data.pack;
        ctx.inst = await api.instances.update(inst.id, {
          share: { packId: pack.id, code: pack.code, name: pack.name, revision: pack.revision, role: 'owner', isGroup: pack.is_group, auto: true, opts: { includeConfigs: opts.includeConfigs, includeOptions: opts.includeOptions }, syncedAt: Date.now() },
        });
        await store.refreshInstances();
        ok(t(pack.is_group ? 'share.groupCreated' : 'share.codeCreated'), pack.code);
        ctx.justCreated = true;
        if (d.alive) ownerView(ctx);
      } catch (err) {
        fail(t('share.createFailed'), err);
      }
    });
  });

  drawModes();
  setCreateLabel();
  d.show(
    instHead(inst, inst.share?.role === 'copy' ? h('span', { class: 'badge', title: inst.share.code }, icon('download'), t('share.importedFrom', { code: inst.share.code })) : null),
    h('p', { class: 'shr-intro' }, t('share.intro')),
    h(
      'div',
      { class: 'shr-split' },
      h(
        'div',
        { class: 'shr-col' },
        modeBox,
        h('div', { class: 'field' }, h('label', { for: 'shr-name' }, t('share.nameLabel')), nameInput),
        h(
          'div',
          { class: 'shr-toggles' },
          toggleRow(t('share.includeConfigs'), t('share.includeConfigsSub'), opts.includeConfigs, (v) => {
            opts.includeConfigs = v;
            rebuild();
          }),
          toggleRow(t('share.includeOptions'), t('share.includeOptionsSub'), opts.includeOptions, (v) => {
            opts.includeOptions = v;
            rebuild();
          }),
        ),
      ),
      h('div', { class: 'shr-col' }, h('div', { class: 'shr-label', role: 'heading', 'aria-level': '4' }, icon('package'), t('share.whatIsShared')), preview),
    ),
  );
  d.footer(
    h(
      'button',
      {
        class: 'btn ghost shr-foot-left',
        type: 'button',
        onclick: () => {
          d.close();
          openImportCode();
        },
      },
      icon('download'),
      t('share.haveCode'),
    ),
    closeBtn(d, t('share.cancel')),
    createBtn,
  );
  rebuild();
}

async function loadPackRow(packId, withManifest) {
  const cols = `${PACK_COLS}${withManifest ? ', manifest' : ''}, owner_profile:profiles(username, display_name, mc_name)`;
  const { data, error } = await cloud.client.from('shared_packs').select(cols).eq('id', packId).maybeSingle();
  if (error) throw new Error(sbError(error));
  return data;
}

async function loadMembers(packId) {
  const { data, error } = await cloud.client
    .from('shared_pack_members')
    .select('user_id, revision_synced, last_sync, joined_at, profile:profiles(id, username, display_name, mc_name)')
    .eq('pack_id', packId)
    .order('joined_at', { ascending: true });
  if (error) throw new Error(sbError(error));
  return data || [];
}

function profileName(p) {
  return cleanStr(p?.display_name, 40) || cleanStr(p?.username, 40) || t('share.someone');
}

function membersView(box, row, { canKick, onChange }) {
  const draw = async () => {
    mount(box, skelRows(t('share.loadingMembers'), 3));
    let list;
    try {
      list = await loadMembers(row.id);
    } catch (err) {
      mount(box, errorBox(err.message, draw));
      return;
    }
    if (!list.length) {
      mount(box, h('div', { class: 'shr-empty-line' }, icon('userPlus'), h('span', {}, t('share.noMembers'))));
      return;
    }
    const me = myId();
    mount(
      box,
      h(
        'div',
        { class: 'shr-members', role: 'list' },
        list.map((m) => {
          const name = profileName(m.profile);
          const upToDate = m.revision_synced >= row.revision;
          const pill = upToDate
            ? h('span', { class: 'pill good' }, icon('check'), t('share.memberUpToDate'))
            : m.revision_synced > 0
              ? h('span', { class: 'pill warn' }, icon('clock'), t('share.memberBehind', { revision: m.revision_synced, latest: row.revision }))
              : h('span', { class: 'pill' }, t('share.memberNever'));
          return h(
            'div',
            { class: 'shr-member', role: 'listitem' },
            avatarImg(m.profile?.mc_name || m.profile?.username || name, 64, 'shr-avatar'),
            h(
              'div',
              { class: 'shr-member-main' },
              h('div', { class: 'shr-member-name', title: name }, m.user_id === me ? t('share.youName', { name }) : name),
              (() => {
                const sub = m.last_sync ? t('share.lastSync', { ago: agoText(Date.parse(m.last_sync)) }) : t('share.joinedAgo', { ago: agoText(Date.parse(m.joined_at)) });
                return h('div', { class: 'shr-member-sub', title: sub }, sub);
              })(),
            ),
            pill,
            canKick && m.user_id !== me
              ? h(
                  'button',
                  {
                    class: 'icon-btn sm danger',
                    type: 'button',
                    title: t('share.kick', { name }),
                    'aria-label': t('share.kick', { name }),
                    onclick: async () => {
                      if (!(await confirmDialog(t('share.kickTitle'), t('share.kickConfirm', { name }), { okText: t('share.kickOk'), danger: true }))) return;
                      const { error } = await cloud.client.from('shared_pack_members').delete().eq('pack_id', row.id).eq('user_id', m.user_id);
                      if (error) fail(t('share.kickFailed'), sbError(error));
                      else {
                        ok(t('share.kicked', { name }));
                        draw();
                        onChange?.();
                      }
                    },
                  },
                  icon('x'),
                )
              : null,
          );
        }),
      ),
    );
  };
  draw();
  return draw;
}

function inviteView(row, d) {
  const friends = friendsList();
  if (typeof social?.sendSignal !== 'function') return h('div', { class: 'shr-empty-line' }, icon('users'), h('span', {}, t('share.inviteUnavailable')));
  if (!friends.length)
    return h(
      'div',
      { class: 'shr-empty-line' },
      icon('userPlus'),
      h('span', { class: 'spacer' }, t('share.noFriends')),
      h(
        'button',
        {
          class: 'btn sm',
          type: 'button',
          onclick: () => {
            d.close();
            navigate('messages');
          },
        },
        icon('message'),
        t('share.goFriends'),
      ),
    );
  const payload = { code: row.code, name: row.name, group: Boolean(row.is_group), mcVersion: row.manifest?.mcVersion || null, loader: row.manifest?.loader || null };
  return h(
    'div',
    { class: 'shr-friends', role: 'list' },
    friends.map((f) => {
      const btn = h('button', { class: 'btn sm', type: 'button', 'aria-label': t('share.inviteTo', { name: f.name }) }, icon('send'), t('share.invite'));
      btn.addEventListener('click', async () => {
        if (btn.getAttribute('aria-disabled') === 'true') return;
        mount(btn, icon('send'), t('share.inviting'));
        const done = setBusy(btn);
        try {
          await social.sendSignal(f.id, 'pack-invite', payload);
          done();
          mount(btn, icon('check'), t('share.invited'));
          btn.classList.add('good');
          // Queda marcado como enviado pero enfocable (deshabilitarlo mandaría el foco del teclado al principio)
          btn.setAttribute('aria-disabled', 'true');
        } catch (err) {
          done();
          mount(btn, icon('send'), t('share.invite'));
          fail(t('share.inviteFailed', { name: f.name }), err);
        }
      });
      return h(
        'div',
        { class: 'shr-friend', role: 'listitem' },
        h('span', { class: 'shr-friend-av' }, avatarImg(f.mc || f.name, 64, 'shr-avatar'), h('span', { class: ['shr-dot', f.online && 'on'], 'aria-hidden': 'true' })),
        h('div', { class: 'shr-friend-main' }, h('div', { class: 'shr-member-name', title: f.name }, f.name), h('div', { class: 'shr-member-sub' }, t(f.online ? 'share.online' : 'share.offline'))),
        btn,
      );
    }),
  );
}

async function ownerView(ctx) {
  const { d } = ctx;
  const inst = ctx.inst;
  const s = inst.share;
  d.setTitle(t('share.shareTitle'));
  d.show(instHead(inst), packSkeleton(t('share.loadingPack')));
  d.footer(closeBtn(d));
  let row;
  try {
    row = await loadPackRow(s.packId, true);
  } catch (err) {
    if (d.alive) d.show(instHead(inst), errorBox(err.message, () => ownerView(ctx)));
    return;
  }
  if (!d.alive) return;
  if (!row) {
    d.show(instHead(inst), h('div', { class: 'notice shr-gone' }, icon('alert'), h('div', {}, h('strong', {}, t('share.packGoneTitle')), h('div', { class: 'small' }, t('share.packGoneText')))));
    d.footer(
      closeBtn(d),
      h(
        'button',
        {
          class: 'btn primary',
          type: 'button',
          onclick: async () => {
            ctx.inst = await api.instances.update(inst.id, { share: null });
            await store.refreshInstances();
            createView(ctx);
          },
        },
        icon('share'),
        t('share.shareAgain'),
      ),
    );
    return;
  }
  if (row.revision !== s.revision || row.name !== s.name || row.is_group !== s.isGroup) {
    ctx.inst = await api.instances.update(inst.id, { share: { ...s, revision: row.revision, name: row.name, isGroup: row.is_group } }).catch(() => inst);
    store.refreshInstances();
  }

  const changes = h('div', { class: 'shr-changes' });
  const checkChanges = async () => {
    mount(
      changes,
      skel(t('share.checkingChanges'), h('div', { class: 'shr-skel-card' }, bone('skeleton-line title'), h('div', { class: 'skeleton-lines' }, bone('skeleton-line'), bone('skeleton-line'), bone('skeleton-line')))),
    );
    try {
      const current = await api.invoke('share:buildManifest', inst.id, s.opts || {});
      const cmp = await api.invoke('share:compare', row.manifest, current);
      if (!d.alive) return;
      if (!cmp.changed) {
        mount(changes, h('div', { class: 'notice good shr-published' }, icon('check'), h('div', {}, h('strong', {}, t('share.allPublished')), h('div', { class: 'small' }, t(row.is_group ? 'share.allPublishedGroup' : 'share.allPublishedCode')))));
        return;
      }
      const publishBtn = h('button', { class: 'btn primary', type: 'button' }, icon('upload'), t('share.publish', { revision: row.revision + 1 }));
      publishBtn.addEventListener('click', () =>
        busyBtn(publishBtn, t('share.publishing'), async () => {
          try {
            const { manifest: encoded } = await api.invoke('share:encode', current);
            const data = await rpc('publish_revision', { p_pack_id: row.id, p_manifest: encoded, p_name: null });
            ctx.inst = await api.instances.update(inst.id, { share: { ...ctx.inst.share, revision: data.pack.revision, syncedAt: Date.now() } });
            await store.refreshInstances();
            ok(t('share.published', { revision: data.pack.revision }), t(row.is_group ? 'share.publishedGroup' : 'share.publishedCode'));
            if (d.alive) ownerView(ctx);
          } catch (err) {
            fail(t('share.publishFailed'), err);
          }
        }),
      );
      const names = (list, max = 6) => list.slice(0, max).map((e) => e.title || e.path).join(', ') + (list.length > max ? ` ${t('share.andMore', { count: list.length - max })}` : '');
      mount(
        changes,
        h(
          'div',
          { class: 'shr-unpublished' },
          h('div', { class: 'shr-unpub-head' }, h('div', { class: 'shr-unpub-title' }, icon('diff'), t('share.unpublishedTitle')), changeChips(cmp.summary)),
          h('div', { class: 'small text-2' }, t('share.unpublishedText')),
          h(
            'ul',
            { class: 'shr-unpub-list' },
            cmp.added.length ? h('li', {}, h('span', { class: 'shr-chg add' }, `+${cmp.added.length}`), names(cmp.added)) : null,
            cmp.updated.length ? h('li', {}, h('span', { class: 'shr-chg upd' }, icon('shrUp'), String(cmp.updated.length)), names(cmp.updated)) : null,
            cmp.removed.length ? h('li', {}, h('span', { class: 'shr-chg del' }, `−${cmp.removed.length}`), names(cmp.removed)) : null,
            cmp.manualAdded.length ? h('li', {}, h('span', { class: 'shr-chg add' }, `+${cmp.manualAdded.length}`), t('share.manualAddedNote', { names: names(cmp.manualAdded) })) : null,
            cmp.summary.configs ? h('li', {}, h('span', { class: 'shr-chg cfg' }, icon('fileText'), String(cmp.summary.configs)), t('share.configsChanged', { count: cmp.summary.configs })) : null,
            cmp.version ? h('li', {}, h('span', { class: 'shr-chg ver' }, icon('layers')), t('share.versionChanged', { from: cmp.version.from.mcVersion, to: cmp.version.to.mcVersion })) : null,
          ),
          h('div', { class: 'shr-unpub-actions' }, publishBtn),
        ),
      );
    } catch (err) {
      if (d.alive) mount(changes, errorBox(t('share.analyzeFailed', { error: err.message }), checkChanges));
    }
  };

  const rename = async () => {
    const name = await promptDialog(t('share.renameTitle'), t('share.nameLabel'), { value: row.name, okText: t('share.save') });
    const clean = (name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!clean || clean === row.name) return;
    const { error } = await cloud.client.from('shared_packs').update({ name: clean }).eq('id', row.id);
    if (error) return fail(t('share.renameFailed'), sbError(error));
    ctx.inst = await api.instances.update(inst.id, { share: { ...ctx.inst.share, name: clean } });
    await store.refreshInstances();
    if (d.alive) ownerView(ctx);
  };

  const membersBox = h('div', { class: 'shr-members-box' });
  const codeCard = h(
    'div',
    { class: ['card', 'flat', 'shr-codecard', ctx.justCreated && 'fresh'] },
    h(
      'div',
      { class: 'shr-codecard-head' },
      h('div', { class: 'shr-codecard-title' }, icon(row.is_group ? 'users' : 'hash'), h('span', { class: 'ellipsis', title: row.name }, row.name)),
      h('button', { class: 'icon-btn sm', type: 'button', title: t('share.rename'), 'aria-label': t('share.rename'), onclick: rename }, icon('edit')),
      h('span', { class: ['badge', row.is_group ? 'accent' : ''] }, t(row.is_group ? 'share.typeGroup' : 'share.typeCode')),
    ),
    codeBox(row.code),
    h('div', { class: 'small text-2 shr-codecard-help' }, t(row.is_group ? 'share.codeHelpGroup' : 'share.codeHelpCode')),
    h(
      'div',
      { class: 'row wrap shr-codecard-meta' },
      h('span', { class: 'pill' }, icon('history'), t('share.revision', { revision: row.revision })),
      h('span', { class: 'small muted' }, t('share.updatedAgo', { ago: agoText(Date.parse(row.updated_at)) })),
    ),
  );
  ctx.justCreated = false;

  d.show(
    instHead(inst),
    h(
      'div',
      { class: 'shr-split' },
      h(
        'div',
        { class: 'shr-col' },
        codeCard,
        row.is_group
          ? null
          : h(
              'div',
              { class: 'shr-upgrade' },
              h('div', { class: 'spacer' }, h('div', { class: 'shr-upgrade-title' }, icon('users'), t('share.upgradeTitle')), h('div', { class: 'small muted' }, t('share.upgradeText'))),
              h(
                'button',
                {
                  class: 'btn sm',
                  type: 'button',
                  onclick: async (e) => {
                    await busyBtn(e.currentTarget, t('share.converting'), async () => {
                      const { error } = await cloud.client.from('shared_packs').update({ is_group: true }).eq('id', row.id);
                      if (error) return fail(t('share.convertFailed'), sbError(error));
                      ctx.inst = await api.instances.update(inst.id, { share: { ...ctx.inst.share, isGroup: true } });
                      await store.refreshInstances();
                      ok(t('share.converted'));
                      if (d.alive) ownerView(ctx);
                      return null;
                    });
                  },
                },
                t('share.upgrade'),
              ),
            ),
        changes,
      ),
      h(
        'div',
        { class: 'shr-col' },
        row.is_group ? h('div', { class: 'shr-label', role: 'heading', 'aria-level': '4' }, icon('users'), t('share.membersTitle')) : null,
        row.is_group ? membersBox : null,
        h('div', { class: 'shr-label', role: 'heading', 'aria-level': '4' }, icon('send'), t('share.inviteTitleList')),
        inviteView(row, d),
      ),
    ),
  );
  d.footer(
    h(
      'button',
      {
        class: 'btn ghost shr-danger shr-foot-left',
        type: 'button',
        onclick: async () => {
          const okDel = await confirmDialog(t('share.stopTitle'), t(row.is_group ? 'share.stopConfirmGroup' : 'share.stopConfirmCode', { code: row.code }), { okText: t('share.stopOk'), danger: true });
          if (!okDel) return;
          const { error } = await cloud.client.from('shared_packs').delete().eq('id', row.id);
          if (error) return fail(t('share.stopFailed'), sbError(error));
          ctx.inst = await api.instances.update(inst.id, { share: null });
          await store.refreshInstances();
          ok(t('share.stopped'), row.code);
          if (d.alive) createView(ctx);
          return null;
        },
      },
      icon('trash'),
      t('share.stop'),
    ),
    closeBtn(d),
  );
  if (row.is_group) membersView(membersBox, row, { canKick: true });
  checkChanges();
}

async function memberView(ctx) {
  const { d } = ctx;
  const inst = ctx.inst;
  const s = inst.share;
  d.setTitle(t('share.groupTitle'));
  d.show(instHead(inst), packSkeleton(t('share.loadingPack')));
  d.footer(closeBtn(d));
  let row;
  try {
    row = await loadPackRow(s.packId, false);
  } catch (err) {
    if (d.alive) d.show(instHead(inst), errorBox(err.message, () => memberView(ctx)));
    return;
  }
  if (!d.alive) return;

  const unlink = async () => {
    await api.invoke('share:forget', inst.id).catch(() => {});
    ctx.inst = await api.instances.update(inst.id, { share: null });
    syncState.delete(inst.id);
    await store.refreshInstances();
  };

  if (!row || !row.is_group) {
    d.show(instHead(inst), h('div', { class: 'notice shr-gone' }, icon('alert'), h('div', {}, h('strong', {}, t('share.groupGoneTitle')), h('div', { class: 'small' }, t('share.groupGoneText', { name: s.name || s.code })))));
    d.footer(
      closeBtn(d),
      h(
        'button',
        {
          class: 'btn primary',
          type: 'button',
          onclick: async () => {
            await unlink();
            ok(t('share.unlinked'), inst.name);
            d.close();
          },
        },
        icon('link'),
        t('share.unlink'),
      ),
    );
    return;
  }

  const ownerName = profileName(row.owner_profile);
  const statusBox = h('div', { class: 'shr-status' });
  const drawStatus = () => {
    const cur = store.instances.find((i) => i.id === inst.id)?.share || ctx.inst.share;
    const st = syncState.get(inst.id) || {};
    const local = cur.revision || 0;
    if (st.state === 'updating') {
      mount(statusBox, h('div', { class: 'notice info shr-status-line' }, h('span', { class: 'spinner shr-spin' }), h('div', {}, h('strong', {}, t('share.updatingNow')), h('div', { class: 'small' }, t('share.updatingNowText')))));
      return;
    }
    const updateBtn = h('button', { class: 'btn primary sm', type: 'button' }, icon('download'), t('share.updateNow'));
    const checkBtn = h('button', { class: 'btn sm', type: 'button', title: t('share.repairTip') }, icon('refresh'), t('share.repair'));
    const runSync = (btn) =>
      busyBtn(btn, t('share.updating'), async () => {
        if (store.running[inst.id]) return toast('info', t('share.closeGameFirst'), inst.name);
        const fresh = store.instances.find((i) => i.id === inst.id) || ctx.inst;
        await syncInstance(fresh, row, { manual: true });
        ctx.inst = store.instances.find((i) => i.id === inst.id) || ctx.inst;
        if (d.alive) drawStatus();
        return null;
      });
    updateBtn.addEventListener('click', () => runSync(updateBtn));
    checkBtn.addEventListener('click', () => runSync(checkBtn));
    if (row.revision > local) {
      mount(statusBox, h('div', { class: 'notice shr-status-line' }, icon('download'), h('div', { class: 'spacer' }, h('strong', {}, t('share.newRevision', { revision: row.revision })), h('div', { class: 'small' }, t('share.newRevisionText', { name: ownerName, local }))), updateBtn));
    } else if (st.state === 'error') {
      mount(statusBox, h('div', { class: 'notice bad shr-status-line' }, icon('alert'), h('div', { class: 'spacer' }, h('strong', {}, t('share.lastSyncFailed')), h('div', { class: 'small' }, st.error || '')), checkBtn));
    } else {
      mount(
        statusBox,
        h(
          'div',
          { class: 'notice good shr-status-line' },
          icon('check'),
          h('div', { class: 'spacer' }, h('strong', {}, t('share.upToDateRevision', { revision: local })), h('div', { class: 'small' }, cur.syncedAt ? t('share.lastSync', { ago: agoText(cur.syncedAt) }) : t('share.neverSynced'))),
          checkBtn,
        ),
      );
    }
  };
  const off = () => stateListeners.delete(listener);
  const listener = (id) => {
    if (!d.alive) return off();
    if (id === inst.id) drawStatus();
  };
  stateListeners.add(listener);
  d.onClose = off;
  drawStatus();

  const membersBox = h('div', { class: 'shr-members-box' });
  d.show(
    instHead(inst),
    h(
      'div',
      { class: 'shr-split' },
      h(
        'div',
        { class: 'shr-col' },
        h(
          'div',
          { class: 'card flat shr-codecard' },
          h('div', { class: 'shr-codecard-head' }, h('div', { class: 'shr-codecard-title' }, icon('users'), h('span', { class: 'ellipsis', title: row.name }, row.name)), h('span', { class: 'badge accent' }, t('share.typeGroup'))),
          h(
            'div',
            { class: 'shr-owner' },
            avatarImg(row.owner_profile?.mc_name || ownerName, 64, 'shr-avatar'),
            h('div', { class: 'shr-owner-text' }, h('div', { class: 'tiny muted' }, t('share.hostLabel')), h('div', { class: 'shr-member-name', title: ownerName }, ownerName)),
          ),
          codeBox(row.code, { big: false }),
          h('div', { class: 'small text-2 shr-codecard-help' }, t('share.memberHelp')),
        ),
        statusBox,
        h(
          'div',
          { class: 'shr-toggles' },
          toggleRow(t('share.autoUpdate'), t('share.autoUpdateSub'), ctx.inst.share.auto !== false, async (v) => {
            ctx.inst = await api.instances.update(inst.id, { share: { ...ctx.inst.share, auto: v } });
            await store.refreshInstances();
          }),
        ),
      ),
      h('div', { class: 'shr-col' }, h('div', { class: 'shr-label', role: 'heading', 'aria-level': '4' }, icon('users'), t('share.membersTitle')), membersBox),
    ),
  );
  d.footer(
    h(
      'button',
      {
        class: 'btn ghost shr-danger shr-foot-left',
        type: 'button',
        onclick: async () => {
          if (!(await confirmDialog(t('share.leaveTitle'), t('share.leaveConfirm', { name: row.name }), { okText: t('share.leaveOk'), danger: true }))) return;
          const me = myId();
          const { error } = await cloud.client.from('shared_pack_members').delete().eq('pack_id', row.id).eq('user_id', me);
          if (error) return fail(t('share.leaveFailed'), sbError(error));
          await unlink();
          ok(t('share.left', { name: row.name }), t('share.leftText'));
          d.close();
          return null;
        },
      },
      icon('logout'),
      t('share.leave'),
    ),
    closeBtn(d),
  );
  membersView(membersBox, row, { canKick: false });
}

// ---------- Diálogo: importar con un código ----------

export async function openImportCode(code) {
  await ready();
  await Promise.resolve(cloud.ready()).catch(() => {});
  const d = dialog(t('share.importTitle'), { icon: 'download' });
  const g = gate();
  if (g) {
    d.show(gateView(g, d));
    d.footer(closeBtn(d));
    return;
  }
  codeStep(d, code);
}

function codeStep(d, initial) {
  d.setTitle(t('share.importTitle'));
  const errId = `shr-code-error-${++uidSeq}`;
  const input = h('input', {
    class: 'input code-input shr-code-input',
    value: initial ? normalizeCode(initial) : '',
    placeholder: t('share.codePlaceholder'),
    maxlength: 16,
    spellcheck: 'false',
    autocomplete: 'off',
    'aria-label': t('share.codeLabel'),
    'aria-describedby': errId,
  });
  const err = h('div', { class: 'field-error shr-code-error', id: errId, role: 'alert' });
  const showError = (text) => {
    mount(err, text ? [icon('alert'), h('span', {}, text)] : null);
    input.setAttribute('aria-invalid', text ? 'true' : 'false');
  };
  const findBtn = h('button', { class: 'btn primary', type: 'button' }, icon('search'), t('share.find'));
  const go = () =>
    busyBtn(findBtn, t('share.finding'), async () => {
      const c = normalizeCode(input.value);
      if (!CODE_RE.test(c)) {
        showError(t('share.badCodeFormat'));
        input.focus();
        return;
      }
      showError(null);
      try {
        const data = await rpc('get_shared_pack', { p_code: c });
        const pv = await api.invoke('share:preview', data.pack.manifest);
        if (d.alive) previewStep(d, data.pack, pv);
      } catch (e) {
        if (!d.alive) return;
        showError(e.message);
        input.focus();
      }
    });
  findBtn.addEventListener('click', go);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !findBtn.disabled) go();
  });
  input.addEventListener('input', () => showError(null));
  d.show(
    h(
      'div',
      { class: 'shr-codestep' },
      h('div', { class: 'shr-codestep-icon', 'aria-hidden': 'true' }, icon('package')),
      h('div', { class: 'shr-codestep-title' }, t('share.importHeading')),
      h('p', { class: 'shr-intro center' }, t('share.importIntro')),
      h('div', { class: 'shr-code-row' }, input, findBtn),
      err,
      h(
        'div',
        { class: 'shr-steps' },
        h('div', { class: 'shr-stepi' }, h('span', { class: 'shr-stepi-n' }, '1'), h('span', {}, t('share.howStep1'))),
        h('div', { class: 'shr-stepi' }, h('span', { class: 'shr-stepi-n' }, '2'), h('span', {}, t('share.howStep2'))),
        h('div', { class: 'shr-stepi' }, h('span', { class: 'shr-stepi-n' }, '3'), h('span', {}, t('share.howStep3'))),
      ),
    ),
  );
  d.footer(closeBtn(d, t('share.cancel')));
  setTimeout(() => input.focus(), 40);
  if (initial && CODE_RE.test(normalizeCode(initial))) go();
}

function packHead(pack, pv) {
  const iconEl = pv.icon ? h('div', { class: 'inst-icon shr-head-icon' }, h('img', { src: pv.icon, alt: '', loading: 'lazy' })) : instanceIcon({ name: pv.name, loader: pv.loader, preset: pv.preset }, 'shr-head-icon');
  return h(
    'div',
    { class: 'shr-head' },
    iconEl,
    h(
      'div',
      { class: 'shr-head-text' },
      h('div', { class: 'shr-head-name', title: pack.name }, pack.name),
      h('div', { class: 'small muted shr-head-by' }, t('share.byOwner', { name: cleanStr(pack.owner_name, 40) || t('share.someone') }), ' · ', t('share.updatedAgo', { ago: agoText(Date.parse(pack.updated_at)) })),
      h(
        'div',
        { class: 'row wrap shr-head-meta' },
        ...versionBadges(pv.mcVersion, pv.loader, pv.loaderVersion, pv.preset),
        h('span', { class: ['badge', pack.is_group ? 'accent' : ''] }, icon(pack.is_group ? 'users' : 'hash'), t(pack.is_group ? 'share.typeGroup' : 'share.typeCode')),
        h('span', { class: 'badge' }, icon('history'), t('share.revision', { revision: pack.revision })),
        pack.member_count ? h('span', { class: 'badge' }, icon('users'), t('share.memberCount', { count: pack.member_count })) : null,
      ),
    ),
  );
}

function previewStep(d, pack, pv) {
  d.setTitle(t('share.importTitle'));
  const instances = [...(store.instances || [])].sort((a, b) => {
    const ca = a.mcVersion === pv.mcVersion && a.loader === pv.loader ? 0 : 1;
    const cb = b.mcVersion === pv.mcVersion && b.loader === pv.loader ? 0 : 1;
    return ca - cb || (b.lastPlayed || 0) - (a.lastPlayed || 0);
  });
  const linked = instances.find((i) => i.share?.packId === pack.id && i.share.role === 'member');
  const sel = { mode: 'new', name: pack.name, applyOptions: true, instanceId: null, removeMissing: false, applyOptionsExisting: false, diff: null, token: 0 };
  const target = h('div', { class: 'shr-target' });
  const actionBtn = h('button', { class: 'btn primary', type: 'button' });
  const modeBar = h('div', { class: 'segmented shr-seg', role: 'radiogroup', 'aria-label': t('share.importModeLabel') });
  // Flechas: cambian entre "instancia nueva" y "usar una mía" (si hay instancias)
  modeBar.addEventListener('keydown', (e) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step || !instances.length) return;
    e.preventDefault();
    sel.mode = sel.mode === 'new' ? 'existing' : 'new';
    drawTarget();
    modeBar.querySelector('[aria-checked="true"]')?.focus();
  });

  const drawAction = () => {
    const disabled = sel.mode === 'existing' && (!sel.instanceId || !sel.diff);
    actionBtn.disabled = disabled;
    mount(actionBtn, icon(sel.mode === 'new' ? 'plus' : 'link'), t(sel.mode === 'new' ? 'share.createInstance' : pack.is_group ? 'share.linkAndSync' : 'share.applyToInstance'));
  };

  const drawDiff = (box) => {
    const df = sel.diff;
    if (!df) return;
    const s = df.summary;
    const inst = instances.find((i) => i.id === sel.instanceId);
    const names = (list) => list.slice(0, 5).map((e) => e.title || e.file || e.path).join(', ') + (list.length > 5 ? ` ${t('share.andMore', { count: list.length - 5 })}` : '');
    mount(
      box,
      h(
        'div',
        { class: 'shr-diff' },
        h('div', { class: 'shr-diff-head' }, h('strong', { class: 'spacer' }, s.added + s.updated + s.removed + s.configs + s.toggled ? t('share.diffTitle') : t('share.diffNone')), changeChips(s)),
        h(
          'ul',
          { class: 'shr-unpub-list' },
          df.added.length ? h('li', {}, h('span', { class: 'shr-chg add' }, `+${df.added.length}`), names(df.added)) : null,
          df.updated.length ? h('li', {}, h('span', { class: 'shr-chg upd' }, icon('shrUp'), String(df.updated.length)), names(df.updated)) : null,
          df.configs.write.length ? h('li', {}, h('span', { class: 'shr-chg cfg' }, icon('fileText'), String(df.configs.write.length)), t('share.configsToWrite', { count: df.configs.write.length })) : null,
        ),
        df.version?.changed
          ? h(
              'div',
              { class: 'notice shr-vchange' },
              icon('layers'),
              h('div', {}, t('share.versionWillChange', { from: `${LOADERS[df.version.from.loader]?.name || df.version.from.loader} ${df.version.from.mcVersion}`, to: `${LOADERS[df.version.to.loader]?.name || df.version.to.loader} ${df.version.to.mcVersion}` })),
            )
          : null,
        df.extra.length
          ? toggleRow(t('share.removeExtra', { count: df.extra.length }), names(df.extra), sel.removeMissing, (v) => {
              sel.removeMissing = v;
            })
          : null,
        df.options.present && df.options.differs
          ? toggleRow(t('share.applyOptionsExisting'), t('share.applyOptionsExistingSub'), sel.applyOptionsExisting, (v) => {
              sel.applyOptionsExisting = v;
            })
          : null,
        inst?.share?.role === 'owner' ? h('div', { class: 'notice shr-vchange' }, icon('alert'), h('div', {}, t('share.overwritesOwnShare', { code: inst.share.code }))) : null,
        store.running[sel.instanceId] ? h('div', { class: 'notice bad shr-vchange' }, icon('alert'), h('div', {}, t('share.closeGameFirst'))) : null,
      ),
    );
  };

  const drawTarget = () => {
    const isNew = sel.mode === 'new';
    mount(modeBar, [
      h('button', { type: 'button', role: 'radio', class: isNew ? 'active' : '', 'aria-checked': String(isNew), tabindex: isNew ? '0' : '-1', onclick: () => ((sel.mode = 'new'), drawTarget()) }, icon('plus'), t('share.modeNew')),
      h(
        'button',
        { type: 'button', role: 'radio', class: isNew ? '' : 'active', 'aria-checked': String(!isNew), tabindex: isNew ? '-1' : '0', disabled: !instances.length, onclick: () => ((sel.mode = 'existing'), drawTarget()) },
        icon('link'),
        t('share.modeExisting'),
      ),
    ]);
    if (sel.mode === 'new') {
      const nameInput = h('input', { class: 'input', value: sel.name, maxlength: 60, id: 'shr-new-name', autocomplete: 'off' });
      nameInput.addEventListener('input', () => {
        sel.name = nameInput.value;
      });
      mount(
        target,
        h('div', { class: 'field' }, h('label', { for: 'shr-new-name' }, t('share.newNameLabel')), nameInput),
        pv.options.length
          ? toggleRow(t('share.applyOptions'), t('share.applyOptionsSub'), sel.applyOptions, (v) => {
              sel.applyOptions = v;
            })
          : null,
      );
    } else {
      const diffBox = h('div', { class: 'shr-diffbox' });
      const select = h(
        'select',
        { class: 'select', id: 'shr-target-inst', 'aria-label': t('share.pickInstance') },
        h('option', { value: '' }, t('share.pickInstancePlaceholder')),
        instances.map((i) =>
          h(
            'option',
            { value: i.id, selected: i.id === sel.instanceId },
            t(i.mcVersion === pv.mcVersion && i.loader === pv.loader ? 'share.instanceOptionCompatible' : 'share.instanceOption', { name: i.name, version: i.mcVersion, loader: LOADERS[i.loader]?.name || i.loader }),
          ),
        ),
      );
      const loadDiff = async () => {
        const my = ++sel.token;
        sel.diff = null;
        drawAction();
        if (!sel.instanceId) {
          mount(diffBox, h('div', { class: 'small muted shr-diff-hint' }, t('share.pickInstanceHint')));
          return;
        }
        mount(diffBox, skel(t('share.comparing'), h('div', { class: 'shr-skel-card' }, bone('skeleton-line title'), h('div', { class: 'skeleton-lines' }, bone('skeleton-line'), bone('skeleton-line')))));
        try {
          const diff = await api.invoke('share:diff', sel.instanceId, pack.manifest, { fresh: true });
          if (my !== sel.token || !d.alive) return;
          sel.diff = diff;
          sel.removeMissing = false;
          drawDiff(diffBox);
        } catch (e) {
          if (my === sel.token && d.alive) mount(diffBox, errorBox(e.message, loadDiff));
        }
        drawAction();
      };
      select.addEventListener('change', () => {
        sel.instanceId = select.value || null;
        loadDiff();
      });
      mount(target, h('div', { class: 'field' }, h('label', { for: 'shr-target-inst' }, t('share.pickInstance')), select), diffBox);
      if (sel.diff && sel.instanceId) drawDiff(diffBox);
      else loadDiff();
    }
    drawAction();
  };

  const run = async () => {
    const name = (sel.name || '').replace(/\s+/g, ' ').trim().slice(0, 60) || pack.name;
    if (sel.mode === 'existing' && store.running[sel.instanceId]) {
      toast('info', t('share.closeGameFirst'), instances.find((i) => i.id === sel.instanceId)?.name || '');
      return;
    }
    let data = pack;
    try {
      if (pack.is_group) data = (await rpc('join_shared_pack', { p_code: pack.code })).pack;
    } catch (err) {
      fail(t('share.joinFailed'), err);
      return;
    }
    const meta = {
      packId: data.id,
      code: data.code,
      name: data.name,
      revision: data.revision,
      role: data.is_group ? 'member' : 'copy',
      isGroup: Boolean(data.is_group),
      auto: true,
      owner: data.owner,
      ownerName: data.owner_name,
    };
    d.close();
    try {
      let res;
      let instName;
      let instId;
      if (sel.mode === 'new') {
        toast('info', t('share.creatingTitle', { name }), t('share.creatingText'), 5000);
        res = await api.invoke('share:createFromManifest', data.manifest, { name, applyOptions: sel.applyOptions, revision: data.revision, share: meta });
        instName = res.instance.name;
        instId = res.instance.id;
      } else {
        const inst = instances.find((i) => i.id === sel.instanceId);
        instName = inst?.name || name;
        instId = sel.instanceId;
        await snapshot(instId, t('share.snapshotLinkReason', { name: data.name }));
        const summary = await api.invoke('share:applyManifest', instId, data.manifest, { removeMissing: sel.removeMissing, applyOptions: sel.applyOptionsExisting, fresh: true, revision: data.revision, share: meta });
        res = { summary };
      }
      await store.refreshInstances();
      if (data.is_group) await rpc('mark_pack_synced', { p_pack_id: data.id, p_revision: data.revision }).catch(() => {});
      setState(instId, { state: 'ok', remoteRevision: data.revision });
      ok(t(sel.mode === 'new' ? 'share.importedTitle' : 'share.linkedTitle', { name: instName }), summaryText(res.summary));
      if (res.summary?.manualMissing?.length) toast('info', t('share.manualTitle', { count: res.summary.manualMissing.length }), res.summary.manualMissing.slice(0, 6).map((e) => e.title).join(', '), 12000);
      if (res.summary?.warnings?.length) toast('info', t('share.syncWarnings', { name: instName }), res.summary.warnings.slice(0, 3).join(' · '), 12000);
      navigate(`instance/${encodeURIComponent(instId)}`);
    } catch (err) {
      fail(t('share.importFailed'), err);
    }
  };
  actionBtn.addEventListener('click', run);

  const fileList = h(
    'div',
    { class: 'shr-list tall', role: 'list', 'aria-label': t('share.contentList') },
    pv.files.length
      ? pv.files.map((e) =>
          h(
            'div',
            { class: ['shr-file', e.enabled === false && 'off'], role: 'listitem' },
            thumb(e.icon, TYPE_ICON[e.path.split('/')[0]] || 'puzzle'),
            h('div', { class: 'shr-file-main' }, h('div', { class: 'shr-file-title', title: e.title }, e.title), h('div', { class: 'shr-file-sub', title: e.path }, e.versionNumber || e.path.split('/')[1])),
            e.source === 'curseforge' ? h('span', { class: 'badge shr-cf' }, 'CurseForge') : null,
            e.enabled === false ? h('span', { class: 'badge' }, t('share.disabledBadge')) : null,
          ),
        )
      : h('div', { class: 'shr-list-empty small muted' }, t('share.noContent')),
  );
  const st = pv.stats;
  const stat = (ic, count, label) => h('div', { class: ['shr-stat', !count && 'zero'] }, icon(ic), h('span', { class: 'shr-stat-num' }, String(count)), h('span', { class: 'shr-stat-label' }, label));

  d.show(
    packHead(pack, pv),
    pack.is_owner ? h('div', { class: 'notice info shr-note' }, icon('info'), h('div', {}, t('share.ownPack'))) : null,
    linked ? h('div', { class: 'notice info shr-note' }, icon('info'), h('div', {}, t('share.alreadyLinked', { name: linked.name }))) : null,
    h(
      'div',
      { class: 'shr-split' },
      h(
        'div',
        { class: 'shr-col' },
        h(
          'div',
          { class: 'shr-stats' },
          stat('puzzle', st.mods, t('share.statMods', { count: st.mods })),
          stat('palette', st.resourcepacks, t('share.statPacks', { count: st.resourcepacks })),
          stat('sun', st.shaderpacks, t('share.statShaders', { count: st.shaderpacks })),
          stat('fileText', pv.configs.length, t('share.statConfigs', { count: pv.configs.length })),
        ),
        fileList,
        h('div', { class: 'shr-foot-notes' }, st.downloadBytes ? h('span', { class: 'small muted' }, icon('download'), t('share.downloadSize', { size: fmtBytes(st.downloadBytes) })) : null),
        pv.manual.length
          ? h(
              'div',
              { class: 'notice shr-manual' },
              icon('alert'),
              h(
                'div',
                { class: 'shr-manual-body' },
                h('strong', {}, t('share.manualTitle', { count: pv.manual.length })),
                h('div', { class: 'small' }, t('share.manualTextImport')),
                h('div', { class: 'shr-manual-list' }, pv.manual.slice(0, 12).map((e) => h('span', { class: 'shr-manual-item', title: e.path }, e.title || e.path.split('/')[1]))),
              ),
            )
          : null,
      ),
      h(
        'div',
        { class: 'shr-col' },
        h('div', { class: 'shr-label', role: 'heading', 'aria-level': '4' }, icon('download'), t('share.whereLabel')),
        modeBar,
        target,
        pack.is_group ? h('div', { class: 'notice info shr-note' }, icon('users'), h('div', {}, t('share.joinGroupNote', { name: cleanStr(pack.owner_name, 40) || t('share.someone') }))) : null,
      ),
    ),
  );
  d.footer(
    h('button', { class: 'btn ghost shr-foot-left', type: 'button', onclick: () => codeStep(d, pack.code) }, icon('chevronLeft'), t('share.back')),
    closeBtn(d, t('share.cancel')),
    actionBtn,
  );
  drawTarget();
}
