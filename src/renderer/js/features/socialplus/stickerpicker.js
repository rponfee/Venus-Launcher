// Selector de stickers de Mensajes (3.3), junto al de GIF: tus stickers, subir uno nuevo y borrar. Un clic manda el sticker;
// el boton ":" lo escribe como emoji en el texto. La logica y el servidor estan en social/stickers.js.
//   openStickerPicker(anchor, { onSend(item), onInsert(item) }) -> { close } | null
//   openStickerReport({ userId, name, sticker }): denuncia con profile_report (motivo content)
import { h, icon, mount, modal, ok, fail, toast, skeleton, setBusy, confirmDialog, registerIcons } from '../../ui.js';
import { t } from '../../i18n.js';
import { cloud } from '../../cloud.js';
import { listMine, prepareImage, createSticker, deleteSticker, cleanStickerName, isStickerName, stickerError, STICKER_LIMITS } from '../../social/stickers.js';

const S = (k, vars) => t(`socialplus.${k}`, vars);

export const STICKER_ICONS = {
  spxSticker: '<path d="M15.5 3H5a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h14a2 2 0 0 0 2-2V8.5L15.5 3Z"/><path d="M14 3v4a2 2 0 0 0 2 2h4"/><path d="M8 13h.01"/><path d="M16 13h.01"/><path d="M10 16s.8 1 2 1c1.3 0 2-1 2-1"/>',
  spxLanguages: '<path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/>',
  spxFlag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" x2="4" y1="22" y2="15"/>',
  spxColon: '<circle cx="12" cy="8" r="1.6"/><circle cx="12" cy="16" r="1.6"/>',
};
registerIcons(STICKER_ICONS);

// Texto para el usuario de un error (el detalle tecnico queda en la consola)
export function stickerErrorText(err) {
  const e = stickerError(err);
  if (e.code === 'network' || e.code === 'unavailable' || e.code === 'denied') console.warn('[stickers]', e.code, e.message);
  return S(`err_${e.code}`, { max: STICKER_LIMITS.premium, kb: Math.round(STICKER_LIMITS.bytes / 1024), px: STICKER_LIMITS.px });
}

let open = null;

export function closeStickerPicker() {
  open?.close();
}

export function openStickerPicker(anchor, { onSend, onInsert } = {}) {
  if (open) {
    const same = open.anchor === anchor;
    open.close();
    if (same) return null;
  }
  if (!cloud.client || !cloud.isSignedIn()) {
    toast('info', S('stickersUnavailable'), S('stickersSignIn'));
    return null;
  }
  const st = { items: [], max: STICKER_LIMITS.free, premium: false, blocked: null, loading: true, error: null, upload: null };
  const head = h('div', { class: 'spx-pick-head' });
  const body = h('div', { class: 'spx-pick-body' });
  const pop = h('div', { class: 'msg-gif-pop spx-pick', role: 'dialog', 'aria-label': S('stickers') }, head, body);
  const fileInput = h('input', { type: 'file', accept: 'image/png,image/webp,image/gif', hidden: true });
  pop.append(fileInput);

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    st.upload = { busy: true, error: null, name: cleanStickerName(file.name) };
    draw();
    try {
      const prepared = await prepareImage(file);
      if (!open || open.pop !== pop) return;
      st.upload = { ...st.upload, busy: false, prepared, preview: URL.createObjectURL(prepared.blob) };
    } catch (err) {
      st.upload = { ...st.upload, busy: false, error: stickerErrorText(err) };
    }
    draw();
  });

  async function load() {
    st.loading = true;
    st.error = null;
    draw();
    try {
      Object.assign(st, await listMine());
    } catch (err) {
      st.error = stickerErrorText(err);
    } finally {
      st.loading = false;
      draw();
    }
  }

  function closeUpload() {
    if (st.upload?.preview) URL.revokeObjectURL(st.upload.preview);
    st.upload = null;
  }

  function uploadView() {
    const u = st.upload;
    if (u.busy && !u.prepared) return h('div', { class: 'spx-pick-empty' }, skeleton('line', { width: 140, label: S('stickerPreparing') }));
    if (!u.prepared)
      return h(
        'div',
        { class: 'spx-pick-empty', role: 'alert' },
        icon('alert'),
        h('span', {}, u.error),
        h('button', { class: 'btn sm', type: 'button', onclick: () => (closeUpload(), draw()) }, S('back')),
      );
    const id = 'spx-sticker-name';
    const input = h('input', { class: 'input', id, value: u.name, maxlength: STICKER_LIMITS.nameMax, spellcheck: 'false', autocomplete: 'off', 'aria-describedby': `${id}-hint` });
    const save = h('button', { class: 'btn primary sm', type: 'submit' }, icon('upload'), S('stickerSave'));
    const message = h('div', { class: 'field-error', role: 'alert', hidden: !u.error }, u.error || '');
    const form = h(
      'form',
      {
        class: 'spx-upload',
        onsubmit: async (ev) => {
          ev.preventDefault();
          const name = cleanStickerName(input.value);
          u.name = input.value;
          if (!isStickerName(name)) {
            message.hidden = false;
            message.textContent = S('err_bad_name');
            input.focus();
            return;
          }
          const release = setBusy(save);
          try {
            const item = await createSticker(u.prepared, name);
            closeUpload();
            if (item) st.items.unshift(item);
            ok(S('stickerSaved'), `:${name}:`);
            draw();
          } catch (err) {
            release();
            message.hidden = false;
            message.textContent = stickerErrorText(err);
          }
        },
      },
      h('img', { class: 'spx-upload-preview', src: u.preview, alt: '' }),
      h(
        'div',
        { class: 'spx-upload-main' },
        h('label', { for: id, class: 'label' }, S('stickerName')),
        input,
        h('div', { class: 'field-help', id: `${id}-hint` }, S('stickerNameHint')),
        message,
        h('div', { class: 'row wrap' }, h('button', { class: 'btn ghost sm', type: 'button', onclick: () => (closeUpload(), draw()) }, S('cancel')), save),
      ),
    );
    setTimeout(() => input.focus(), 20);
    return form;
  }

  function tile(item) {
    const del = h('button', { class: 'spx-tile-tool', type: 'button', title: S('stickerDelete'), 'aria-label': S('stickerDeleteNamed', { name: item.name }) }, icon('x'));
    del.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      if (!(await confirmDialog(S('stickerDelete'), S('stickerDeleteText', { name: item.name }), { okText: S('stickerDelete'), danger: true }))) return;
      try {
        await deleteSticker(item);
        st.items = st.items.filter((x) => x.id !== item.id);
        draw();
      } catch (err) {
        fail(S('stickerDeleteFailed'), stickerErrorText(err));
      }
    });
    const ins = h('button', { class: 'spx-tile-tool', type: 'button', title: S('stickerInsert', { name: item.name }), 'aria-label': S('stickerInsert', { name: item.name }) }, icon('spxColon'));
    ins.addEventListener('click', (ev) => {
      ev.stopPropagation();
      close();
      onInsert?.(item);
    });
    return h(
      'div',
      { class: 'spx-tile' },
      h(
        'button',
        {
          class: 'spx-tile-send',
          type: 'button',
          title: S('stickerSendNamed', { name: item.name }),
          'aria-label': S('stickerSendNamed', { name: item.name }),
          onclick: () => {
            close();
            onSend?.(item);
          },
        },
        h('img', { src: item.url, alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer', draggable: 'false' }),
        h('span', { class: 'spx-tile-name ellipsis' }, `:${item.name}:`),
      ),
      h('div', { class: 'spx-tile-tools' }, ins, del),
    );
  }

  function draw() {
    const full = st.items.length >= st.max;
    const blocked = Boolean(st.blocked);
    const add = h('button', { class: 'btn tonal sm', type: 'button', disabled: full || blocked || st.loading || Boolean(st.error), onclick: () => fileInput.click() }, icon('upload'), S('stickerUpload'));
    mount(head, h('span', { class: 'spx-pick-title' }, icon('spxSticker'), S('stickers')), st.loading || st.error ? null : h('span', { class: 'badge', title: S('stickerCountHint') }, `${st.items.length}/${st.max}`), h('span', { class: 'spacer' }), add);
    if (st.upload) return mount(body, uploadView());
    if (st.loading) return mount(body, skeleton('grid', { items: 6, min: 80, label: S('stickersLoading') }));
    if (st.error) return mount(body, h('div', { class: 'spx-pick-empty', role: 'alert' }, icon('alert'), h('span', {}, st.error), h('button', { class: 'btn sm', type: 'button', onclick: load }, icon('refresh'), S('retry'))));
    const notes = [];
    if (blocked) notes.push(h('div', { class: 'spx-pick-note', role: 'status' }, icon('ban'), h('span', {}, S(`err_${st.blocked}`))));
    else if (full)
      notes.push(
        h(
          'div',
          { class: 'spx-pick-note', role: 'status' },
          icon('crown'),
          h('span', {}, S(st.premium ? 'stickerFullPremium' : 'stickerFull', { max: st.max, premium: STICKER_LIMITS.premium })),
          st.premium ? null : h('button', { class: 'msg-linkbtn', type: 'button', onclick: () => (close(), import('../plans.js').then((m) => m.openPlans()).catch(() => {})) }, S('seePlans')),
        ),
      );
    if (!st.items.length) return mount(body, notes, h('div', { class: 'spx-pick-empty' }, h('strong', {}, S('stickersEmpty')), h('span', {}, S('stickersEmptyText', { kb: Math.round(STICKER_LIMITS.bytes / 1024), px: STICKER_LIMITS.px }))));
    mount(body, notes, h('div', { class: 'spx-grid' }, st.items.map(tile)), h('div', { class: 'spx-pick-foot' }, S('stickersFoot')));
  }

  document.body.append(pop);
  const place = () => {
    const r = anchor.getBoundingClientRect();
    const pr = pop.getBoundingClientRect();
    const left = Math.max(8, Math.min(window.innerWidth - pr.width - 8, r.left));
    const above = r.top - pr.height - 8;
    pop.style.left = `${left}px`;
    pop.style.top = `${above >= 8 ? above : Math.max(8, Math.min(window.innerHeight - pr.height - 8, r.bottom + 8))}px`;
  };
  const onDown = (e) => {
    if (!pop.contains(e.target) && !anchor.contains(e.target) && !e.target.closest?.('.modal-backdrop')) close();
  };
  const onKey = (e) => {
    if (e.key === 'Escape' && !document.querySelector('.modal-backdrop')) {
      e.stopPropagation();
      close();
      anchor.focus?.();
    }
  };
  // El alto cambia al cargar o al subir: que siga pegado al boton
  const sizer = new ResizeObserver(place);
  function close() {
    sizer.disconnect();
    closeUpload();
    pop.remove();
    document.removeEventListener('mousedown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', close);
    if (open?.pop === pop) open = null;
  }
  setTimeout(() => {
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('resize', close);
  }, 0);
  document.addEventListener('keydown', onKey, true);
  open = { pop, anchor, close };
  sizer.observe(pop);
  load();
  return open;
}

// Denunciar un sticker o emoji de otro: va como denuncia de contenido, con el id para encontrarlo en el panel
export function openStickerReport({ userId, name = '', sticker = {} } = {}) {
  const text = h('textarea', { class: 'textarea', rows: 3, maxlength: 200, placeholder: S('reportText'), 'aria-label': S('reportText') });
  const send = h('button', { class: 'btn danger', type: 'button' }, icon('spxFlag'), S('reportSend'));
  const d = modal({
    title: S('reportTitle', { name: name || t('social.someone') }),
    icon: 'spxFlag',
    size: 'sm',
    body: h('div', { class: 'stack' }, h('p', { class: 'muted small' }, S('reportHint', { name: name || t('social.someone') })), h('div', { class: 'field' }, text)),
    footer: [h('span', { class: 'spacer' }), send],
  });
  send.addEventListener('click', async () => {
    const release = setBusy(send);
    try {
      const note = [`sticker:${sticker.id || '?'}`, sticker.name ? `:${sticker.name}:` : '', text.value.trim()].filter(Boolean).join(' ');
      const { error } = await cloud.client.rpc('profile_report', { p_user: userId, p_reason: 'content', p_text: note.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 300) });
      if (error) throw error;
      d.close();
      ok(S('reportSent'), S('reportSentText'));
    } catch (err) {
      fail(S('reportFailed'), /too_many_today/.test(String(err?.message || '')) ? S('reportTooMany') : S('err_network'));
    } finally {
      release();
    }
  });
  return d;
}
