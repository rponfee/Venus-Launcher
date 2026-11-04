// Pestaña Catálogo: extensiones aprobadas de la comunidad, instalar y mandar una nueva. Consultar el catálogo es una
// conexión opcional (settings.extensions.catalog): hasta que la persona la active no sale ningún pedido a internet.
// Servidor: RPC extension_catalog, extension_submit y extension_my_submissions, bucket extension-packages (0036).
import { h, icon, mount, ok, fail, setBusy, skeleton, emptyState, debounce, fmtBytes, fmtAgo, confirmDialog } from '../../ui.js';
import { api } from '../../store.js';
import { t } from '../../i18n.js';
import { cloud } from '../../cloud.js';
import { navigate } from '../../app.js';
import { catalogAllowed, setCatalogAllowed, checkCatalog, extensionsState, refreshExtensions, onExtensions } from '../../features/extensions.js';
import { openInstallDialog } from '../../features/extensions/install-dialog.js';
import { permTitle } from '../../features/extensions/perms.js';
import { isNewer } from '../../features/extensions/version.js';

export const BUCKET = 'extension-packages';
const SERVER_ERRORS = new Set(['user_banned', 'user_muted', 'not_owner', 'extension_blocked', 'version_exists', 'too_many_today', 'too_many_extensions', 'bad_manifest', 'bad_name', 'bad_sha256', 'bad_size', 'not_authenticated']);

// Código del servidor o null (raise exception 'codigo').
function serverCode(err) {
  const msg = String(err?.message || '');
  return SERVER_ERRORS.has(msg) ? msg : null;
}

// Baja un paquete aprobado, verifica su sha-256 en el proceso principal y abre el resumen de instalación.
export async function downloadAndInstall(row) {
  // La lista de bloqueadas, recién traída: el proceso principal rechaza lo que esté ahí aunque ya se haya bajado.
  const blocklist = await cloud.client.rpc('extension_blocklist');
  if (blocklist.error) console.warn('[extensions] lista de bloqueadas:', blocklist.error.message);
  else await api.invoke('extensions:applyBlocklist', blocklist.data || {});
  const { data, error } = await cloud.client.storage.from(BUCKET).download(row.path);
  if (error) throw new Error(t('extensions.downloadFailed'));
  const bytes = new Uint8Array(await data.arrayBuffer());
  const sum = await api.invoke('extensions:inspectBytes', bytes, { sha256: row.sha256, id: row.id, version: row.version });
  return openInstallDialog(sum);
}

function catalogRow(row) {
  const mine = extensionsState().items.find((x) => x.id === row.id);
  const same = mine && !isNewer(row.version, mine.version);
  const btn = h('button', { class: ['btn', 'sm', !mine && 'primary'], type: 'button', disabled: same }, icon(same ? 'check' : 'download'), same ? t('extensions.installedTag') : mine ? t('extensions.updateTo', { version: row.version }) : t('extensions.installAction'));
  btn.addEventListener('click', async () => {
    const release = setBusy(btn);
    try {
      await downloadAndInstall(row);
      await refreshExtensions();
    } catch (err) {
      fail(t('extensions.installFailed'), err);
    } finally {
      release();
    }
  });
  return h(
    'div',
    { class: 'card xt-item' },
    h(
      'div',
      { class: 'xt-item-top' },
      h('span', { class: 'xt-item-icon', 'aria-hidden': 'true' }, icon('puzzle')),
      h(
        'div',
        { class: 'xt-item-main' },
        h('div', { class: 'xt-item-name' }, h('strong', { class: 'ellipsis', title: row.name }, row.name), h('span', { class: 'badge' }, `v${row.version}`)),
        h('div', { class: 'small muted ellipsis', title: row.author }, t('extensions.byAuthor', { author: row.author })),
        row.description ? h('div', { class: 'small text-2 xt-item-desc' }, row.description) : null,
      ),
      btn,
    ),
    h(
      'div',
      { class: 'xt-item-perms' },
      (row.permissions || []).length ? row.permissions.map((p) => h('span', { class: 'chip xt-chip' }, permTitle(p))) : h('span', { class: 'small muted' }, t('extensions.permsNoneShort')),
      h('span', { class: 'small muted' }, fmtBytes(row.sizeBytes)),
    ),
  );
}

// ---------- Mandar una extensión ----------
// file: la ruta del paquete; sin ella abre el selector.
export async function submitPackage(btn, onDone, file) {
  const release = setBusy(btn);
  try {
    const pkg = await api.invoke('extensions:readForSubmit', file);
    if (!pkg) return;
    const m = pkg.manifest;
    if (!(await confirmDialog(t('extensions.submitTitle'), t('extensions.submitText', { name: m.name, version: m.version }), { okText: t('extensions.submitOk'), cancelText: t('extensions.cancel') }))) return;
    const { data, error } = await cloud.client.rpc('extension_submit', { p_id: m.id, p_version: m.version, p_manifest: m, p_sha256: pkg.sha256, p_size: pkg.size });
    if (error) {
      const code = serverCode(error);
      if (!code) console.warn('[extensions] envío:', error.message);
      throw new Error(code ? t(`extensions.submitErr_${code}`) : t('extensions.serviceDown'));
    }
    const blob = new Blob([pkg.bytes], { type: 'application/zip' });
    const up = await cloud.client.storage.from(BUCKET).upload(data.path, blob, { contentType: 'application/zip', upsert: false });
    if (up.error) {
      console.warn('[extensions] subida:', up.error.message);
      throw new Error(t('extensions.uploadFailed'));
    }
    ok(t('extensions.submittedOk'), t('extensions.submittedOkText'));
    onDone?.();
  } catch (err) {
    fail(t('extensions.submitFailed'), err);
  } finally {
    release();
  }
}

function submissionsBlock() {
  const list = h('div', { class: 'stack xt-subs' });
  async function load() {
    mount(list, skeleton('list', { rows: 2 }));
    try {
      const { data, error } = await cloud.client.rpc('extension_my_submissions');
      if (error) throw error;
      const rows = Array.isArray(data) ? data : [];
      if (!rows.length) return mount(list, h('div', { class: 'small muted' }, t('extensions.subsEmpty')));
      mount(
        list,
        rows.map((r) =>
          h(
            'div',
            { class: 'xt-sub' },
            h('strong', { class: 'ellipsis', title: r.name }, r.name),
            h('span', { class: 'badge' }, `v${r.version}`),
            h('span', { class: ['pill', r.status === 'approved' ? 'good' : r.status === 'pending' ? 'warn' : 'bad'] }, t(`extensions.status_${r.status}`)),
            r.note ? h('span', { class: 'small muted selectable' }, r.note) : null,
            h('span', { class: 'spacer' }),
            h('span', { class: 'small muted' }, fmtAgo(Date.parse(r.at))),
          ),
        ),
      );
    } catch (err) {
      console.warn('[extensions] mis envíos:', err?.message || err);
      mount(list, h('div', { class: 'small muted' }, t('extensions.serviceDown')));
    }
    return undefined;
  }
  const btn = h('button', { class: 'btn sm', type: 'button' }, icon('upload'), t('extensions.submitAction'));
  btn.addEventListener('click', () => submitPackage(btn, load));
  load();
  return h(
    'div',
    { class: 'card xt-submit' },
    h('div', { class: 'card-head' }, h('div', {}, h('h3', { class: 'card-title' }, icon('upload'), t('extensions.submitHead')), h('p', { class: 'card-sub' }, t('extensions.submitSub'))), btn),
    list,
  );
}

export function catalogTab() {
  const list = h('div', { class: 'stack xt-list' });
  const el = h('div', { class: 'stack' });
  let query = '';
  let alive = true;

  const search = h('input', { class: 'input', type: 'search', placeholder: t('extensions.searchPlaceholder'), 'aria-label': t('extensions.searchPlaceholder'), maxlength: 60 });
  search.addEventListener('input', debounce(() => {
    query = search.value.trim();
    load();
  }, 350));

  async function load() {
    mount(list, skeleton('list', { rows: 3 }));
    try {
      const { data, error } = await cloud.client.rpc('extension_catalog', { p_search: query || null });
      if (error) throw error;
      if (!alive) return;
      const rows = Array.isArray(data) ? data : [];
      if (!rows.length) return mount(list, emptyState('puzzle', t('extensions.catalogEmpty'), query ? t('extensions.catalogEmptySearch') : t('extensions.catalogEmptyText')));
      mount(list, rows.map(catalogRow));
    } catch (err) {
      console.warn('[extensions] catálogo:', err?.message || err);
      if (alive) mount(list, emptyState('alert', t('extensions.serviceDownTitle'), t('extensions.serviceDown'), h('button', { class: 'btn', type: 'button', onclick: load }, icon('refresh'), t('extensions.retry'))));
    }
    return undefined;
  }

  function draw() {
    if (!catalogAllowed()) {
      const btn = h('button', { class: 'btn primary', type: 'button' }, icon('wifi'), t('extensions.catalogEnable'));
      btn.addEventListener('click', async () => {
        try {
          await setCatalogAllowed(true);
          draw();
          checkCatalog();
        } catch (err) {
          fail(t('extensions.saveFailed'), err);
        }
      });
      mount(el, h('div', { class: 'card' }, emptyState('wifi', t('extensions.catalogOptTitle'), t('extensions.catalogOptText'), btn)));
      return;
    }
    if (!cloud.isConfigured() || !cloud.isSignedIn()) {
      mount(el, h('div', { class: 'card' }, emptyState('logIn', t('extensions.signInTitle'), t('extensions.signInText'), h('button', { class: 'btn primary', type: 'button', onclick: () => navigate('settings/cloud') }, icon('logIn'), t('extensions.signIn')))));
      return;
    }
    mount(el, h('div', { class: 'notice info' }, icon('shieldCheck'), h('div', { class: 'small' }, t('extensions.catalogNote'))), h('div', { class: 'row' }, search), list, submissionsBlock());
    load();
  }

  const offAuth = cloud.on?.('auth', () => alive && draw());
  const offList = onExtensions(() => {
    if (alive && catalogAllowed() && cloud.isSignedIn() && !list.querySelector('.skeleton')) load();
  });
  draw();
  return {
    el,
    destroy() {
      alive = false;
      offAuth?.();
      offList?.();
    },
  };
}
