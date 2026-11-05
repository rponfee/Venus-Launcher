// Comunidades: mensajes de bienvenida y de despedida (solo el dueño). Para cada uno: activarlo o no, el canal donde se publica, el
// texto con {usuario}, {comunidad} y {miembros}, un GIF opcional (de KLIPY o subido a la galería) y una vista previa con tus datos.
// Un GIF subido que todavía no aprobó un administrador de Venus se puede elegir, pero el mensaje sale sin él hasta entonces.
import { h, icon, mount, modal, ok, fail, setBusy, switchEl } from '../../ui.js';
import { t } from '../../i18n.js';
import { errText } from '../../features/communities/backend.js';
import { GREETING_KINDS, GREETING_LIMIT, GREETING_VARIABLES, emptyGreeting, greetingChannels, greetingPatch, klipyMedia, renderGreeting, validateGreeting } from '../../features/communities/greeting.js';
import { openGifPicker, closeGifPicker } from '../../social/gifpicker.js';
import { communityColor } from './logic.js';
import { mediaImage } from './media-view.js';
import { openMediaGallery, uploadCommunityMedia } from './gallery.js';

const C = (key, vars) => t(`communities.${key}`, vars);

export function openGreetingsDialog(b, community, { reload } = {}) {
  if (community.myRole !== 'owner') return null;
  const saved = Object.fromEntries(GREETING_KINDS.map((k) => [k, { ...emptyGreeting(), ...(community.greetings?.[k] || {}) }]));
  const draft = Object.fromEntries(GREETING_KINDS.map((k) => [k, { ...saved[k] }]));
  const channels = greetingChannels(community.channels);
  let kind = 'join';
  let pending = false;
  let closed = false;
  let library = null; // GIFs de la comunidad, para saber si un archivo subido sigue pendiente
  const tabs = h('div', { class: 'segmented cm-greeting-tabs', role: 'group', 'aria-label': C('greetingsTabs') });
  const panel = h('div', { class: 'stack cm-greeting-panel' });
  const error = h('div', { class: 'field-error', role: 'alert', hidden: true });
  const cancel = h('button', { class: 'btn ghost', type: 'button' }, C('cancel'));
  const submit = h('button', { class: 'btn primary cm-greeting-save', type: 'button' }, icon('save'), C('formSave'));
  const m = modal({ title: C('greetingsTitle'), subtitle: community.name, icon: 'logIn', size: 'lg', body: h('div', { class: 'stack' }, h('p', { class: 'card-sub' }, C('greetingsIntro')), tabs, panel, error), footer: [cancel, submit], onClose: () => { closed = true; closeGifPicker(); } });
  cancel.addEventListener('click', () => m.close());

  const mediaState = (media) => {
    if (media?.kind !== 'upload') return null;
    return library?.find((x) => x.id === media.id)?.status || saved[kind].mediaStatus || null;
  };

  async function loadLibrary() {
    try {
      library = await b.rpc('community_media_list', { p_community: community.id });
    } catch {
      library = [];
    }
    if (!closed) draw();
  }

  function draw() {
    if (closed) return;
    mount(tabs, GREETING_KINDS.map((k) => h('button', { type: 'button', class: k === kind ? 'active' : null, 'aria-pressed': String(k === kind), onclick: () => { kind = k; draw(); } },
      icon(k === 'join' ? 'logIn' : 'logout'), C(`greeting_${k}`))));
    const g = draft[kind];
    const enabled = switchEl(g.enabled, (on) => { g.enabled = on; drawPreview(); }, C('greetingEnable'));
    const channel = h('select', { class: 'input', id: 'cm-gr-channel', 'aria-label': C('greetingChannel') },
      [h('option', { value: '' }, C('greetingNoChannel')), ...channels.map((c) => h('option', { value: c.id, selected: c.id === g.channelId }, `# ${c.name}`))]);
    channel.value = g.channelId || '';
    channel.addEventListener('change', () => { g.channelId = channel.value || null; });
    // El servidor entiende usuario/user, comunidad/community y miembros/members: la interfaz muestra los del idioma.
    const token = (v) => `{${C(`greetingVarName_${v}`)}}`;
    const body = h('textarea', { class: 'textarea', id: 'cm-gr-body', rows: '4', maxlength: String(GREETING_LIMIT),
      placeholder: C(`greetingPlaceholder_${kind}`, { u: token('usuario'), c: token('comunidad'), m: token('miembros') }) }, g.body);
    const counter = h('span', { class: 'cl-muted small' }, `${[...g.body].length}/${GREETING_LIMIT}`);
    body.addEventListener('input', () => { g.body = body.value; counter.textContent = `${[...body.value].length}/${GREETING_LIMIT}`; drawPreview(); });
    const chips = h('div', { class: 'row wrap cm-greeting-vars', role: 'group', 'aria-label': C('greetingVars') }, GREETING_VARIABLES.map((v) =>
      h('button', { class: 'btn sm ghost', type: 'button', title: C(`greetingVar_${v}`), onclick: () => {
        const at = body.selectionStart ?? body.value.length;
        body.value = `${body.value.slice(0, at)}${token(v)}${body.value.slice(body.selectionEnd ?? at)}`.slice(0, GREETING_LIMIT);
        body.dispatchEvent(new Event('input'));
        body.focus();
      } }, token(v))));
    const mediaBox = h('div', { class: 'cm-greeting-media' });
    const preview = h('div', { class: 'cm-greeting-preview', 'aria-live': 'polite' });
    function drawMedia() {
      const state = mediaState(g.media);
      const pickKlipy = h('button', { class: 'btn sm', type: 'button', onclick: (e) => openGifPicker(e.currentTarget, (gif) => { g.media = klipyMedia(gif); drawMedia(); drawPreview(); }) }, icon('search'), C('greetingGifKlipy'));
      const pickGallery = h('button', { class: 'btn sm', type: 'button', onclick: () => openMediaGallery(b, community, { includePending: true, pick: (item) => { g.media = { kind: 'upload', id: item.id }; loadLibrary(); } }) }, icon('image'), C('greetingGifGallery'));
      const file = h('input', { type: 'file', accept: 'image/gif,image/webp,image/png', class: 'sr-only', tabindex: '-1', 'aria-hidden': 'true' });
      const upload = h('button', { class: 'btn sm', type: 'button', onclick: () => file.click() }, icon('upload'), C('greetingGifUpload'));
      file.addEventListener('change', async () => {
        const chosen = file.files?.[0];
        file.value = '';
        if (!chosen) return;
        const done = setBusy(upload);
        try {
          const item = await uploadCommunityMedia(b, community, chosen);
          if (item) { g.media = { kind: 'upload', id: item.id }; ok(C('mediaUploaded'), C('mediaUploadedText')); await loadLibrary(); }
        } catch (err) {
          fail(C('actionError'), errText(err));
        } finally {
          done();
          if (!closed) { drawMedia(); drawPreview(); }
        }
      });
      const clear = g.media ? h('button', { class: 'btn sm ghost', type: 'button', onclick: () => { g.media = null; drawMedia(); drawPreview(); } }, icon('x'), C('greetingGifClear')) : null;
      const picked = g.media ? h('div', { class: 'cm-greeting-picked' }, mediaImage(b, g.media.kind === 'upload' ? { ...g.media, path: library?.find((x) => x.id === g.media.id)?.path } : g.media, { size: 'sm', alt: C('greetingGif') }),
        state && state !== 'approved' ? h('span', { class: ['pill', state === 'pending' ? 'warn' : 'bad'] }, C(state === 'pending' ? 'greetingGifPending' : 'greetingGifUnavailable')) : null) : null;
      mount(mediaBox, h('label', { class: 'label' }, C('greetingGif')), picked, h('div', { class: 'row wrap' }, pickKlipy, pickGallery, upload, file, clear),
        state === 'pending' ? h('p', { class: 'field-help' }, C('greetingGifPendingHelp')) : h('p', { class: 'field-help' }, C('greetingGifHelp')));
    }
    function drawPreview() {
      const sample = { user: C('greetingSampleName'), community: community.name, members: Math.max(1, (community.memberCount || 1) + (kind === 'join' ? 1 : -1)) };
      const text = renderGreeting(g.body, sample);
      const state = mediaState(g.media);
      const showMedia = g.media && (g.media.kind === 'klipy' || state === 'approved');
      mount(preview,
        h('div', { class: 'cl-muted small' }, C('greetingPreview'), ' · ', g.enabled ? C('greetingOn') : C('greetingOff'), ' · ', g.channelId ? `# ${channels.find((c) => c.id === g.channelId)?.name || ''}` : C('greetingNoChannel')),
        h('article', { class: ['cm-system', `is-${kind}`], style: { '--cm-color': communityColor(community.color) } },
          h('div', { class: 'cm-system-line' }, icon(kind === 'join' ? 'logIn' : 'logout'), text ? h('span', { class: 'cm-text' }, text) : h('span', { class: 'cm-gone' }, C('greetingPreviewEmpty'))),
          showMedia ? mediaImage(b, g.media.kind === 'upload' ? { ...g.media, path: library?.find((x) => x.id === g.media.id)?.path } : g.media, { size: 'md', alt: C('greetingGif') }) : null));
    }
    mount(panel,
      h('div', { class: 'toggle-row' }, h('div', { class: 'tr-text' }, h('div', { class: 'tr-title' }, C(`greetingEnable_${kind}`)), h('div', { class: 'tr-sub' }, C(`greetingEnableHelp_${kind}`))), enabled),
      h('div', { class: 'field' }, h('label', { for: 'cm-gr-channel' }, C('greetingChannel')), channel, channels.length ? null : h('p', { class: 'field-help' }, C('greetingNoChannels'))),
      h('div', { class: 'field' }, h('div', { class: 'row', style: { justifyContent: 'space-between' } }, h('label', { for: 'cm-gr-body' }, C('greetingText')), counter), body, chips, h('p', { class: 'field-help' }, C('greetingTextHelp', { user: token('usuario'), community: token('comunidad'), members: token('miembros') }))),
      mediaBox, preview);
    drawMedia();
    drawPreview();
  }

  submit.addEventListener('click', async () => {
    if (pending || closed) return;
    error.hidden = true;
    const work = [];
    for (const k of GREETING_KINDS) {
      const check = validateGreeting(draft[k], community.channels);
      if (!check.ok) {
        kind = k;
        draw();
        error.textContent = C(`err_${check.error}`);
        error.hidden = false;
        return;
      }
      const patch = greetingPatch(saved[k], check.value);
      if (patch) work.push([k, patch]);
    }
    if (!work.length) { m.close(); return; }
    pending = true;
    const done = setBusy(submit);
    try {
      for (const [k, patch] of work) await b.rpc('community_greeting_save', { p_community: community.id, p_kind: k, p_patch: patch });
      ok(C('formSaved'));
      m.close();
      Promise.resolve(reload?.()).catch((err) => fail(C('actionError'), errText(err)));
    } catch (err) {
      if (!closed) { error.textContent = errText(err); error.hidden = false; }
      else fail(C('actionError'), errText(err));
    } finally {
      pending = false;
      done();
    }
  });
  draw();
  loadLibrary();
  return m;
}
