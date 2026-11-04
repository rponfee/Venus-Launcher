// Panel de administración: revisión de extensiones de la comunidad (0036). render(root) lista las versiones por estado,
// baja el paquete, lo valida en el proceso principal con el mismo lector que usa el launcher y muestra el contenido como
// texto: nada se ejecuta. Aprobar se ofrece solo después de ver el contenido con el sha-256 correcto.
// Lo enchufa pages/admin.js. Todo queda en admin_actions (lo anotan las RPC).
import { h, icon, mount, modal, ok, fail, setBusy, skeleton, emptyState, promptDialog, confirmDialog, fmtAgo, fmtBytes, ensureCss } from '../../ui.js';
import { api } from '../../store.js';
import { t, loadNs } from '../../i18n.js';
import { cloud } from '../../cloud.js';
import { permTitle } from '../../features/extensions/perms.js';

const BUCKET = 'extension-packages';
const STATES = ['pending', 'approved', 'rejected', 'blocked'];
const PILL = { pending: 'warn', approved: 'good', rejected: 'bad', blocked: 'bad' };
const SERVER_ERRORS = new Set(['not_uploaded', 'not_pending', 'not_found', 'bad_action', 'note_required']);

const nameOf = (u) => u?.displayName || u?.username || '—';

function rpcError(err) {
  const code = String(err?.message || '');
  if (SERVER_ERRORS.has(code)) return new Error(t(`extensions.adminErr_${code}`));
  console.warn('[admin] extensiones:', code);
  return new Error(t('extensions.serviceDown'));
}

async function review(versionId, action, note) {
  const { error } = await cloud.client.rpc('admin_extension_review', { p_version: versionId, p_action: action, p_note: note ?? null });
  if (error) throw rpcError(error);
}

async function loadContent(row) {
  const { data, error } = await cloud.client.storage.from(BUCKET).download(row.path);
  if (error) throw new Error(t('extensions.downloadFailed'));
  const bytes = new Uint8Array(await data.arrayBuffer());
  return api.invoke('extensions:review', bytes, { sha256: row.sha256 });
}

function contentView(content) {
  const viewer = h('div', {});
  const buttons = [];
  const show = (file, btn) => {
    for (const b of buttons) b.classList.toggle('active', b === btn);
    if (file.text !== null) {
      mount(viewer, file.truncated ? h('div', { class: 'small muted' }, t('extensions.adminFileTruncated')) : null, h('pre', { class: 'xt-rev-code' }, file.text));
    } else if (file.image) {
      mount(viewer, h('img', { class: 'xt-rev-img', alt: file.path, src: `data:${file.type};base64,${file.image}` }));
    } else mount(viewer, h('div', { class: 'small muted' }, t('extensions.adminFileBinary')));
  };
  const items = content.files.map((f) => {
    const btn = h('button', { class: 'xt-rev-file', type: 'button' }, h('span', { class: 'ellipsis' }, f.path), h('span', { class: 'muted' }, fmtBytes(f.size)));
    btn.addEventListener('click', () => show(f, btn));
    buttons.push(btn);
    return btn;
  });
  if (content.files[0]) show(content.files[0], buttons[0]);
  return h(
    'div',
    { class: 'xt-rev' },
    h('div', { class: 'notice good' }, icon('shieldCheck'), h('div', { class: 'small selectable' }, t('extensions.adminHashOk'), ` ${content.sha256}`)),
    h('div', { class: 'label' }, t('extensions.adminManifest')),
    h('pre', { class: 'xt-rev-code' }, JSON.stringify(content.manifest, null, 2)),
    h('div', { class: 'label' }, t('extensions.adminFiles')),
    h('div', { class: 'xt-rev-files' }, items),
    viewer,
  );
}

async function openReview(row, onChange) {
  let content;
  try {
    content = await loadContent(row);
  } catch (err) {
    // Un paquete que el lector rechaza o cuyo hash no coincide no se muestra: solo se puede rechazar o bloquear.
    fail(t(err?.code === 'hash_mismatch' ? 'extensions.adminHashBad' : 'extensions.packageRejected'), err);
    return;
  }
  const approve = h('button', { class: 'btn primary', type: 'button' }, icon('check'), t('extensions.adminApprove'));
  const m = modal({
    title: t('extensions.adminReviewTitle', { name: row.name, version: row.version }),
    subtitle: t('extensions.communityTag'),
    icon: 'puzzle',
    size: 'xwide',
    body: contentView(content),
    footer: [h('button', { class: 'btn ghost', type: 'button', onclick: () => m.close() }, t('extensions.close')), row.status === 'pending' || row.status === 'rejected' ? approve : null],
  });
  approve.addEventListener('click', async () => {
    if (!(await confirmDialog(t('extensions.adminApprove'), t('extensions.adminApproveConfirm', { name: row.name, version: row.version }), { okText: t('extensions.adminApprove'), cancelText: t('extensions.cancel') }))) return;
    const release = setBusy(approve);
    try {
      await review(row.versionId, 'approve');
      ok(t('extensions.adminDone'));
      m.close();
      onChange();
    } catch (err) {
      fail(t('extensions.adminActionFailed'), err);
      release();
    }
  });
}

export async function render(root) {
  ensureCss('pages/extensions');
  await loadNs('extensions');
  let status = 'pending';
  const list = h('div', { class: 'stack' });
  const filter = h('div', { class: 'chips xt-adm-filter', role: 'group', 'aria-label': t('extensions.adminFilterLabel') });
  const reload = h('button', { class: 'btn sm', type: 'button' }, icon('refresh'), t('extensions.adminReload'));

  function drawFilter() {
    mount(
      filter,
      STATES.map((s) => {
        const btn = h('button', { type: 'button', class: ['chip', s === status && 'active'], 'aria-pressed': String(s === status) }, t(`extensions.status_${s}`));
        btn.addEventListener('click', () => {
          status = s;
          drawFilter();
          load();
        });
        return btn;
      }),
    );
  }

  const askNote = () => promptDialog(t('extensions.adminNoteLabel'), t('extensions.adminNoteLabel'), { placeholder: t('extensions.adminNotePlaceholder') });

  function row(r) {
    const act = (btn, fn) => async () => {
      const release = setBusy(btn);
      try {
        const done = await fn();
        if (done !== false) {
          ok(t('extensions.adminDone'));
          load();
        }
      } catch (err) {
        fail(t('extensions.adminActionFailed'), err);
      } finally {
        release();
      }
    };
    const view = h('button', { class: 'btn sm tonal', type: 'button', disabled: !r.uploaded }, icon('search'), t('extensions.adminViewContent'));
    view.addEventListener('click', async () => {
      const release = setBusy(view);
      await openReview(r, load);
      release();
    });
    const reject = h('button', { class: 'btn sm', type: 'button' }, icon('x'), t('extensions.adminReject'));
    reject.addEventListener(
      'click',
      act(reject, async () => {
        const note = await askNote();
        if (!note) return false;
        await review(r.versionId, 'reject', note);
        return true;
      }),
    );
    const block = h('button', { class: 'btn sm danger', type: 'button' }, icon('ban'), t('extensions.adminBlock'));
    block.addEventListener(
      'click',
      act(block, async () => {
        const note = await askNote();
        if (!note) return false;
        await review(r.versionId, 'block', note);
        return true;
      }),
    );
    const blocked = r.extensionStatus === 'blocked';
    const blockAll = h('button', { class: ['btn', 'sm', !blocked && 'danger'], type: 'button' }, icon(blocked ? 'check' : 'ban'), t(blocked ? 'extensions.adminUnblockExt' : 'extensions.adminBlockExt'));
    blockAll.addEventListener(
      'click',
      act(blockAll, async () => {
        let reason = null;
        if (!blocked) {
          if (!(await confirmDialog(t('extensions.adminBlockExt'), t('extensions.adminBlockConfirm', { name: r.name }), { okText: t('extensions.adminBlockExt'), cancelText: t('extensions.cancel'), danger: true }))) return false;
          reason = await askNote();
          if (!reason) return false;
        }
        const { error } = await cloud.client.rpc('admin_extension_block', { p_id: r.id, p_blocked: !blocked, p_reason: reason });
        if (error) throw rpcError(error);
        return true;
      }),
    );
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
          h('div', { class: 'xt-item-name' }, h('strong', { class: 'ellipsis selectable', title: r.name }, r.name), h('span', { class: 'badge' }, `v${r.version}`), h('span', { class: ['pill', PILL[r.status]] }, t(`extensions.status_${r.status}`)), blocked ? h('span', { class: 'pill bad' }, t('extensions.adminExtBlocked')) : null),
          h('div', { class: 'small muted selectable' }, `${r.id} · ${t('extensions.byAuthor', { author: r.author })} · ${fmtBytes(r.sizeBytes)}`),
          r.description ? h('div', { class: 'small text-2 selectable xt-item-desc' }, r.description) : null,
          h('div', { class: 'small muted' }, t('extensions.adminBy', { name: nameOf(r.submitter), when: fmtAgo(Date.parse(r.at)) })),
          h('div', { class: 'small muted selectable xt-sha' }, `SHA-256 ${r.sha256}`),
          r.note ? h('div', { class: 'small selectable' }, r.note) : null,
          r.blockReason ? h('div', { class: 'small selectable' }, r.blockReason) : null,
        ),
      ),
      h('div', { class: 'xt-item-perms' }, (r.permissions || []).length ? r.permissions.map((p) => h('span', { class: 'chip xt-chip' }, permTitle(p))) : h('span', { class: 'small muted' }, t('extensions.permsNoneShort'))),
      !r.uploaded ? h('div', { class: 'notice info' }, icon('info'), t('extensions.adminNotUploaded')) : null,
      h('div', { class: 'xt-adm-actions' }, view, r.status === 'pending' ? reject : null, r.status !== 'blocked' ? block : null, blockAll),
    );
  }

  async function load() {
    mount(list, skeleton('list', { rows: 3, label: t('extensions.adminLoading') }));
    try {
      const { data, error } = await cloud.client.rpc('admin_extensions', { p_status: status });
      if (error) throw error;
      const rows = Array.isArray(data) ? data : [];
      if (!rows.length) return mount(list, emptyState('puzzle', t('extensions.adminEmpty'), ''));
      mount(list, rows.map(row));
    } catch (err) {
      console.warn('[admin] extensiones:', err?.message || err);
      mount(list, emptyState('alert', t('extensions.adminFailed'), ''));
    }
    return undefined;
  }

  reload.addEventListener('click', load);
  drawFilter();
  mount(root, h('div', { class: 'page-head' }, h('div', { class: 'ph-text' }, h('h2', { class: 'page-title' }, t('extensions.adminTitle')), h('p', { class: 'page-sub' }, t('extensions.adminSub'))), h('div', { class: 'page-actions' }, reload)), filter, list);
  load();
}
