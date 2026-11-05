// Comunidades: galería de la comunidad (GIFs, fotos y fondos). El dueño y los moderadores suben GIF (hasta 2 MB y 1024 px) o fotos
// PNG, WebP y JPEG (hasta 4 MB y 2560 px) y suman GIFs de KLIPY; cada uno nace pendiente y solo lo ven quien lo subió, el dueño y
// los administradores de Venus hasta que uno lo aprueba. Los miembros solo ven y usan los aprobados. Cuántos entran lo decide el
// plan de la comunidad ("12 de 50"); lo que el plan ya no alcanza se marca como oculto y vuelve al renovar. El dueño ve el estado
// de cada archivo y el motivo si se rechazó. Con pick la galería sirve para elegir un GIF (chat o bienvenida y despedida).
import { h, icon, mount, modal, ok, fail, setBusy, skeleton, emptyState, confirmDialog, promptDialog, fmtAgo } from '../../ui.js';
import { t } from '../../i18n.js';
import { errText } from '../../features/communities/backend.js';
import { openGroupReport } from '../../features/communities/report.js';
import { HEAD_BYTES, MEDIA_ACCEPT, MEDIA_LIMITS, itemAnimated, itemHidden, itemMedia, klipyAddArgs, mediaPath, newMediaId, registerArgs, safeStatus, suggestMediaName, validateMediaFile } from '../../features/communities/media.js';
import { normalizePlanState } from '../../features/communities/plan.js';
import { isKlipyUrl } from '../../features/profile-editor/model.js';
import { openGifPicker } from '../../social/gifpicker.js';
import { isStaff } from './logic.js';
import { mediaImage } from './media-view.js';

const C = (key, vars) => t(`communities.${key}`, vars);
const P = (key, vars) => t(`communityplans.${key}`, vars);

/** Sube un archivo: lo revisa, lo pasa a Storage y lo registra (nace pendiente). Si el registro falla, borra lo subido. */
export async function uploadCommunityMedia(b, community, file) {
  const head = new Uint8Array(await file.slice(0, HEAD_BYTES).arrayBuffer());
  const check = validateMediaFile(file, head);
  if (!check.ok) throw Object.assign(new Error(check.error), { code: check.error });
  const name = await promptDialog(C('mediaNameTitle'), C('mediaNameLabel'), { value: suggestMediaName(file.name), okText: C('mediaUpload'), hint: C('mediaNameHint') });
  if (!name) return null;
  const id = newMediaId();
  const path = mediaPath(community.id, id, check.value.ext);
  await b.uploadMedia(path, file);
  try {
    return await b.rpc('community_media_register', registerArgs(community.id, id, name, check.value));
  } catch (err) {
    await b.removeMedia(path);
    throw err;
  }
}

/**
 * pick: función que recibe el GIF elegido (la galería se cierra). includePending: en modo pick, ofrece también los pendientes
 * (la bienvenida los acepta, pero el mensaje sale sin el GIF hasta que se aprueben). onChange: se avisa cuando algo se sube o borra.
 */
export function openMediaGallery(b, initial, { pick = null, includePending = false, onChange } = {}) {
  const community = initial;
  const staff = isStaff(community.myRole);
  let items = [];
  let planState = null; // community_plan_get: el cupo de la galería; sin él (servidor viejo) el servidor sigue poniendo el tope
  let closed = false;
  let busy = false;
  const grid = h('div', { class: 'cm-gallery-grid', 'aria-live': 'polite' }, skeleton('grid', { items: 3, min: 150, lines: 2 }));
  const file = h('input', { type: 'file', accept: MEDIA_ACCEPT, class: 'sr-only', tabindex: '-1', 'aria-hidden': 'true' });
  const upload = h('button', { class: 'btn primary', type: 'button' }, icon('upload'), C('mediaUpload'));
  const klipy = h('button', { class: 'btn', type: 'button', 'aria-haspopup': 'dialog' }, icon('plus'), P('galleryAddKlipy'));
  const hiddenNote = h('div', { class: 'notice warn', hidden: true }, icon('eyeOff'), h('div', {}));
  const counter = h('span', { class: 'cl-muted small' });
  const m = modal({
    title: C(pick ? 'galleryPickTitle' : 'galleryTitle'), subtitle: community.name, icon: 'image', size: 'lg', onClose: () => { closed = true; },
    body: h('div', { class: 'stack cm-gallery' },
      staff && !pick ? h('div', { class: 'cm-gallery-bar' }, upload, klipy, file, counter) : null,
      h('p', { class: 'cl-note' }, icon('shieldCheck'), h('span', {}, staff && !pick ? P('galleryRules', { gif: MEDIA_LIMITS.bytes / 1048576, photo: MEDIA_LIMITS.photoBytes / 1048576, gifPx: MEDIA_LIMITS.max, photoPx: MEDIA_LIMITS.photoMax }) : C('galleryMemberNote'))),
      hiddenNote,
      grid),
  });

  async function load() {
    try {
      items = await b.rpc('community_media_list', { p_community: community.id });
      if (!Array.isArray(items)) items = [];
      planState = normalizePlanState(await b.rpc('community_plan_get', { p_community: community.id }).catch(() => null));
    } catch (err) {
      if (!closed) mount(grid, emptyState('alert', errText(err), '', h('button', { class: 'btn', type: 'button', onclick: () => { mount(grid, skeleton('grid', { items: 3, min: 150, lines: 2 })); load(); } }, icon('refresh'), C('retry'))));
      return;
    }
    if (!closed) draw();
  }

  function card(item) {
    const status = safeStatus(item.status);
    const hidden = itemHidden(item);
    const usable = !hidden && (status === 'approved' || (includePending && status === 'pending'));
    const details = item.mine || community.myRole === 'owner';
    const actions = [];
    if (pick && usable) actions.push(h('button', { class: 'btn sm primary cm-gallery-use', type: 'button', onclick: () => { m.close(); pick(item); } }, icon('check'), C('galleryUse')));
    if (!pick && (item.mine || community.myRole === 'owner')) {
      actions.push(h('button', { class: 'icon-btn sm cm-gallery-delete', type: 'button', title: C('mediaDelete', { name: item.name }), 'aria-label': C('mediaDelete', { name: item.name }), onclick: () => remove(item) }, icon('trash')));
    }
    if (!pick && !item.mine && status === 'approved') {
      actions.push(h('button', { class: 'icon-btn sm', type: 'button', title: C('reportMedia'), 'aria-label': C('reportMedia'), onclick: () => openGroupReport({ kind: 'media', id: item.id, name: item.name }) }, icon('alert')));
    }
    const shown = !hidden && itemMedia(item);
    const sizeText = [item.width && item.height ? `${item.width}×${item.height}` : '', item.bytes ? `${Math.max(1, Math.round(item.bytes / 1024))} KB` : ''].filter(Boolean).join(' · ');
    return h('article', { class: ['cm-gallery-item', `is-${status}`, hidden && 'is-plan-hidden'], dataset: { id: item.id, status, hidden: String(hidden) } },
      shown ? mediaImage(b, shown, { size: 'sm', alt: item.name }) : h('div', { class: 'cm-media is-sm is-gone' }, icon(hidden ? 'eyeOff' : 'lock'), h('span', {}, hidden ? P('galleryHidden') : C('mediaHidden'))),
      h('div', { class: 'cm-gallery-meta' },
        h('strong', { class: 'ellipsis', title: item.name }, item.name),
        h('span', { class: ['pill', status === 'approved' ? 'good' : status === 'pending' ? 'warn' : 'bad'] }, C(`mediaStatus_${status}`)),
        hidden ? h('span', { class: 'pill warn', title: P('galleryHiddenHint') }, icon('eyeOff'), P('galleryHidden')) : null,
        itemAnimated(item) ? h('span', { class: 'pill' }, P('galleryAnimated')) : null,
        item.source === 'klipy' ? h('span', { class: 'pill' }, 'KLIPY') : null,
        status === 'pending' && details ? h('span', { class: 'cl-muted small' }, C('mediaPendingNote')) : null,
        (status === 'rejected' || status === 'removed') && details ? h('span', { class: 'cl-muted small selectable' }, item.rejectReason === 'report' ? C('mediaRemovedReport') : C('mediaReason', { reason: item.rejectReason || '—' })) : null,
        h('span', { class: 'cl-muted small' }, `${sizeText}${sizeText ? ' · ' : ''}${fmtAgo(Date.parse(item.createdAt))}`)),
      actions.length ? h('div', { class: 'row cm-gallery-actions' }, actions) : null);
  }

  function draw() {
    const shown = pick ? items.filter((it) => safeStatus(it.status) === 'approved' || (includePending && safeStatus(it.status) === 'pending')) : items;
    const active = items.filter((it) => ['pending', 'approved'].includes(safeStatus(it.status))).length;
    const max = planState?.plan.limits.media ?? null;
    const full = max !== null && active >= max;
    counter.textContent = max === null ? P('galleryCountOnly', { n: active }) : P('galleryUsage', { n: active, max });
    upload.disabled = klipy.disabled = busy || full;
    upload.title = klipy.title = full ? P('galleryFull') : '';
    const hiddenN = items.filter(itemHidden).length;
    hiddenNote.hidden = !hiddenN || Boolean(pick);
    hiddenNote.lastChild.textContent = P('galleryHiddenNote', { n: hiddenN, count: hiddenN });
    mount(grid, shown.length ? shown.map(card) : emptyState('image', C(pick ? 'galleryPickEmpty' : 'galleryEmpty'), C(staff && !pick ? 'galleryEmptyText' : 'galleryEmptyMember')));
  }

  async function remove(item) {
    if (!(await confirmDialog(C('mediaDeleteTitle'), C('mediaDeleteText', { name: item.name }), { okText: C('delete'), danger: true }))) return;
    try {
      const res = await b.rpc('community_media_delete', { p_id: item.id });
      if (res?.path) await b.removeMedia(res.path);
      ok(C('mediaDeleted'));
      onChange?.();
      if (!closed) await load();
    } catch (err) {
      fail(C('actionError'), errText(err));
    }
  }

  upload.addEventListener('click', () => file.click());
  // Un GIF de KLIPY también nace pendiente: nadie más lo ve hasta que un administrador de Venus lo aprueba.
  klipy.addEventListener('click', () => openGifPicker(klipy, async (gif) => {
    if (busy || closed) return;
    const args = klipyAddArgs(community.id, gif, isKlipyUrl, P('klipyDefaultName'));
    if (!args.ok) { fail(C('actionError'), errText({ code: args.error })); return; }
    busy = true;
    const done = setBusy(klipy);
    try {
      await b.rpc('community_media_add_klipy', args.value);
      ok(C('mediaUploaded'), C('mediaUploadedText'));
      onChange?.();
    } catch (err) {
      fail(C('actionError'), errText(err));
    } finally {
      busy = false;
      done();
      if (!closed) await load();
    }
  }));
  file.addEventListener('change', async () => {
    const chosen = file.files?.[0];
    file.value = '';
    if (!chosen || busy || closed) return;
    busy = true;
    const done = setBusy(upload);
    try {
      const saved = await uploadCommunityMedia(b, community, chosen);
      if (saved) {
        ok(C('mediaUploaded'), C('mediaUploadedText'));
        onChange?.();
      }
    } catch (err) {
      fail(C('actionError'), errText(err));
    } finally {
      busy = false;
      done();
      if (!closed) await load();
    }
  });
  load();
  return m;
}
